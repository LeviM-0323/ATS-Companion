#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#else
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

#include <atomic>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

#include "scssdk_telemetry.h"
#include "amtrucks/scssdk_ats.h"
#include "amtrucks/scssdk_telemetry_ats.h"

namespace {

#if defined(_WIN32)
constexpr wchar_t kPipeName[] = L"\\\\.\\pipe\\ats-companion-telemetry-v1";
#else
std::string telemetrySocketPath() {
    const char* configuredPath = std::getenv("ATS_COMPANION_TELEMETRY_SOCKET");
    if (configuredPath && configuredPath[0] != '\0') return configuredPath;

    const char* runtimeDirectory = std::getenv("XDG_RUNTIME_DIR");
    if (runtimeDirectory && runtimeDirectory[0] != '\0') {
        return std::string(runtimeDirectory) + "/ats-companion/telemetry.sock";
    }
    const char* temporaryDirectory = std::getenv("TMPDIR");
    const std::string temporaryRoot =
        temporaryDirectory && temporaryDirectory[0] != '\0' ? temporaryDirectory : "/tmp";
    return temporaryRoot + "/ats-companion-" + std::to_string(getuid()) + "/telemetry.sock";
}
#endif

struct TelemetryState {
    bool connected = true;
    bool paused = true;
    bool hasJob = false;
    float speedMps = 0.0f;
    int gear = 0;
    float fuelLiters = 0.0f;
    float fuelCapacityLiters = 0.0f;
    float engineRpm = 0.0f;
    float odometerKm = 0.0f;
    float remainingMeters = 0.0f;
    float estimatedTimeSeconds = 0.0f;
    std::string make = "Unknown";
    std::string model = "Unknown";
    std::string cargo;
    std::string origin;
    std::string destination;
};

std::mutex g_stateMutex;
TelemetryState g_state;
std::atomic<bool> g_stopping{ false };
std::thread g_pipeThread;
#if defined(_WIN32)
HANDLE g_stopEvent = nullptr;
#endif
scs_log_t g_gameLog = nullptr;

std::string jsonEscape(const std::string& value) {
    std::ostringstream result;
    for (const unsigned char character : value) {
        switch (character) {
        case '"': result << "\\\""; break;
        case '\\': result << "\\\\"; break;
        case '\b': result << "\\b"; break;
        case '\f': result << "\\f"; break;
        case '\n': result << "\\n"; break;
        case '\r': result << "\\r"; break;
        case '\t': result << "\\t"; break;
        default:
            if (character < 0x20) {
                result << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                    << static_cast<unsigned int>(character) << std::dec;
            }
            else {
                result << static_cast<char>(character);
            }
        }
    }
    return result.str();
}

std::string makeFrame(const TelemetryState& state) {
    std::ostringstream frame;
    frame << std::setprecision(7)
        << "{\"schemaVersion\":1,\"game\":{\"connected\":"
        << (state.connected ? "true" : "false")
        << ",\"paused\":" << (state.paused ? "true" : "false")
        << "},\"truck\":{\"make\":\"" << jsonEscape(state.make)
        << "\",\"model\":\"" << jsonEscape(state.model)
        << "\",\"speedMps\":" << state.speedMps
        << ",\"gear\":" << state.gear
        << ",\"fuelLiters\":" << state.fuelLiters
        << ",\"fuelCapacityLiters\":" << state.fuelCapacityLiters
        << ",\"engineRpm\":" << state.engineRpm
        << ",\"odometerKm\":" << state.odometerKm << "},\"job\":";
    if (state.hasJob) {
        frame << "{\"cargo\":\"" << jsonEscape(state.cargo)
            << "\",\"origin\":\"" << jsonEscape(state.origin)
            << "\",\"destination\":\"" << jsonEscape(state.destination)
            << "\",\"remainingMeters\":" << state.remainingMeters
            << ",\"estimatedTimeSeconds\":" << state.estimatedTimeSeconds << '}';
    }
    else {
        frame << "null";
    }
    frame << "}\n";
    return frame.str();
}

#if defined(_WIN32)
void pipeWorker() {
    while (!g_stopping.load()) {
        if (!WaitNamedPipeW(kPipeName, 500)) {
            WaitForSingleObject(g_stopEvent, 250);
            continue;
        }

        HANDLE pipe = CreateFileW(
            kPipeName,
            GENERIC_WRITE,
            0,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr);
        if (pipe == INVALID_HANDLE_VALUE) {
            WaitForSingleObject(g_stopEvent, 250);
            continue;
        }

        while (!g_stopping.load()) {
            TelemetryState state;
            {
                std::lock_guard<std::mutex> lock(g_stateMutex);
                state = g_state;
            }

            const std::string frame = makeFrame(state);
            size_t offset = 0;
            bool writeSucceeded = true;
            while (offset < frame.size()) {
                DWORD written = 0;
                const DWORD remaining = static_cast<DWORD>(frame.size() - offset);
                if (!WriteFile(pipe, frame.data() + offset, remaining, &written, nullptr) || written == 0) {
                    writeSucceeded = false;
                    break;
                }
                offset += written;
            }

            if (!writeSucceeded || WaitForSingleObject(g_stopEvent, 250) == WAIT_OBJECT_0) {
                break;
            }
        }

        CloseHandle(pipe);
    }
}
#else
int connectTelemetrySocket() {
    const std::string path = telemetrySocketPath();
    sockaddr_un address{};
    if (path.size() >= sizeof(address.sun_path)) return -1;

    const int socketHandle = socket(AF_UNIX, SOCK_STREAM, 0);
    if (socketHandle == -1) return -1;

    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
    if (connect(socketHandle, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == -1) {
        close(socketHandle);
        return -1;
    }
    return socketHandle;
}

void socketWorker() {
    while (!g_stopping.load()) {
        const int socketHandle = connectTelemetrySocket();
        if (socketHandle == -1) {
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
            continue;
        }

        while (!g_stopping.load()) {
            TelemetryState state;
            {
                std::lock_guard<std::mutex> lock(g_stateMutex);
                state = g_state;
            }

            const std::string frame = makeFrame(state);
            size_t offset = 0;
            while (offset < frame.size()) {
                const ssize_t written = send(
                    socketHandle,
                    frame.data() + offset,
                    frame.size() - offset,
                    MSG_NOSIGNAL);
                if (written == -1 && errno == EINTR) continue;
                if (written <= 0) break;
                offset += static_cast<size_t>(written);
            }
            if (offset != frame.size()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
        }

        close(socketHandle);
    }
}
#endif

SCSAPI_VOID storeFloat(
    const scs_string_t,
    const scs_u32_t,
    const scs_value_t* const value,
    const scs_context_t context) {
    if (!value || !context || value->type != SCS_VALUE_TYPE_float) return;
    std::lock_guard<std::mutex> lock(g_stateMutex);
    *static_cast<float*>(context) = value->value_float.value;
}

SCSAPI_VOID storeGear(
    const scs_string_t,
    const scs_u32_t,
    const scs_value_t* const value,
    const scs_context_t context) {
    if (!value || !context || value->type != SCS_VALUE_TYPE_s32) return;
    std::lock_guard<std::mutex> lock(g_stateMutex);
    *static_cast<int*>(context) = value->value_s32.value;
}

SCSAPI_VOID onPause(const scs_event_t event, const void*, const scs_context_t) {
    std::lock_guard<std::mutex> lock(g_stateMutex);
    g_state.paused = event == SCS_TELEMETRY_EVENT_paused;
}

const scs_named_value_t* findAttribute(
    const scs_telemetry_configuration_t& configuration,
    const char* name) {
    for (const scs_named_value_t* attribute = configuration.attributes;
         attribute && attribute->name;
         ++attribute) {
        if (attribute->index == SCS_U32_NIL && std::string(attribute->name) == name) {
            return attribute;
        }
    }
    return nullptr;
}

std::string stringAttribute(const scs_telemetry_configuration_t& configuration, const char* name) {
    const scs_named_value_t* attribute = findAttribute(configuration, name);
    if (!attribute || attribute->value.type != SCS_VALUE_TYPE_string || !attribute->value.value_string.value) {
        return {};
    }
    return attribute->value.value_string.value;
}

float numberAttribute(const scs_telemetry_configuration_t& configuration, const char* name) {
    const scs_named_value_t* attribute = findAttribute(configuration, name);
    if (!attribute) return 0.0f;
    if (attribute->value.type == SCS_VALUE_TYPE_float) return attribute->value.value_float.value;
    if (attribute->value.type == SCS_VALUE_TYPE_double) {
        return static_cast<float>(attribute->value.value_double.value);
    }
    return 0.0f;
}

SCSAPI_VOID onConfiguration(const scs_event_t, const void* eventInfo, const scs_context_t) {
    if (!eventInfo) return;
    const auto* configuration = static_cast<const scs_telemetry_configuration_t*>(eventInfo);
    if (!configuration->id || !configuration->attributes) return;

    std::lock_guard<std::mutex> lock(g_stateMutex);
    if (std::string(configuration->id) == SCS_TELEMETRY_CONFIG_truck) {
        const std::string make = stringAttribute(*configuration, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand);
        const std::string model = stringAttribute(*configuration, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name);
        if (!make.empty()) g_state.make = make;
        if (!model.empty()) g_state.model = model;
        g_state.fuelCapacityLiters =
            numberAttribute(*configuration, SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity);
    }
    else if (std::string(configuration->id) == SCS_TELEMETRY_CONFIG_job) {
        g_state.hasJob = configuration->attributes->name != nullptr;
        g_state.cargo = stringAttribute(*configuration, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo);
        g_state.origin = stringAttribute(*configuration, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city);
        g_state.destination = stringAttribute(*configuration, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city);
    }
}

bool registerFloatChannel(
    scs_telemetry_register_for_channel_t registerChannel,
    const char* name,
    float* destination) {
    return registerChannel(
        name,
        SCS_U32_NIL,
        SCS_VALUE_TYPE_float,
        SCS_TELEMETRY_CHANNEL_FLAG_none,
        storeFloat,
        destination) == SCS_RESULT_ok;
}

} // namespace

SCSAPI_RESULT scs_telemetry_init(
    const scs_u32_t version,
    const scs_telemetry_init_params_t* const params) {
    if (version != SCS_TELEMETRY_VERSION_1_01 || !params) return SCS_RESULT_unsupported;

    const auto* versionParams = static_cast<const scs_telemetry_init_params_v101_t*>(params);
    if (!versionParams->common.game_id || std::string(versionParams->common.game_id) != SCS_GAME_ID_ATS) {
        return SCS_RESULT_unsupported;
    }
    g_gameLog = versionParams->common.log;
    {
        std::lock_guard<std::mutex> lock(g_stateMutex);
        g_state = TelemetryState{};
    }

    const bool eventsRegistered =
        versionParams->register_for_event(SCS_TELEMETRY_EVENT_paused, onPause, nullptr) == SCS_RESULT_ok &&
        versionParams->register_for_event(SCS_TELEMETRY_EVENT_started, onPause, nullptr) == SCS_RESULT_ok &&
        versionParams->register_for_event(SCS_TELEMETRY_EVENT_configuration, onConfiguration, nullptr) == SCS_RESULT_ok;
    if (!eventsRegistered) {
        if (g_gameLog) g_gameLog(SCS_LOG_TYPE_error, "ATS Companion could not register telemetry events.");
        return SCS_RESULT_generic_error;
    }

    const bool coreChannelsRegistered =
        registerFloatChannel(versionParams->register_for_channel, SCS_TELEMETRY_TRUCK_CHANNEL_speed, &g_state.speedMps) &&
        registerFloatChannel(versionParams->register_for_channel, SCS_TELEMETRY_TRUCK_CHANNEL_engine_rpm, &g_state.engineRpm) &&
        versionParams->register_for_channel(
            SCS_TELEMETRY_TRUCK_CHANNEL_engine_gear,
            SCS_U32_NIL,
            SCS_VALUE_TYPE_s32,
            SCS_TELEMETRY_CHANNEL_FLAG_none,
            storeGear,
            &g_state.gear) == SCS_RESULT_ok;
    if (!coreChannelsRegistered) {
        if (g_gameLog) g_gameLog(SCS_LOG_TYPE_error, "ATS Companion could not register required truck telemetry.");
        return SCS_RESULT_generic_error;
    }

    registerFloatChannel(versionParams->register_for_channel, SCS_TELEMETRY_TRUCK_CHANNEL_fuel, &g_state.fuelLiters);
    registerFloatChannel(versionParams->register_for_channel, SCS_TELEMETRY_TRUCK_CHANNEL_odometer, &g_state.odometerKm);
    registerFloatChannel(versionParams->register_for_channel, SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance, &g_state.remainingMeters);
    registerFloatChannel(versionParams->register_for_channel, SCS_TELEMETRY_TRUCK_CHANNEL_navigation_time, &g_state.estimatedTimeSeconds);

    g_stopping.store(false);
#if defined(_WIN32)
    g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_stopEvent) {
        if (g_gameLog) g_gameLog(SCS_LOG_TYPE_error, "ATS Companion could not start its telemetry worker.");
        return SCS_RESULT_generic_error;
    }
    g_pipeThread = std::thread(pipeWorker);
#else
    g_pipeThread = std::thread(socketWorker);
#endif
    if (g_gameLog) g_gameLog(SCS_LOG_TYPE_message, "ATS Companion telemetry initialized.");
    return SCS_RESULT_ok;
}

SCSAPI_VOID scs_telemetry_shutdown(void) {
    g_stopping.store(true);
#if defined(_WIN32)
    if (g_stopEvent) SetEvent(g_stopEvent);
#endif
    if (g_pipeThread.joinable()) g_pipeThread.join();
#if defined(_WIN32)
    if (g_stopEvent) {
        CloseHandle(g_stopEvent);
        g_stopEvent = nullptr;
    }
#endif
    std::lock_guard<std::mutex> lock(g_stateMutex);
    g_state.connected = false;
}
