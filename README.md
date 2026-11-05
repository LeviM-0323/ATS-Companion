# ATS Companion

A React Native companion for American Truck Simulator, with a mobile dashboard and Windows/Linux bridges.

## Current slice

- The mobile app has Drive, Job, Truck, and Bridge screens that adapt to narrow phones and wider tablets.
- The Windows bridge reads live ATS telemetry from the SCS telemetry plugin through a local named pipe and exposes a read-only snapshot API.
- The Linux bridge can provide pairing and the authenticated API, but Linux live telemetry is not verified or currently supported.
- Pair a phone by scanning the one-time QR code on the Windows setup page, or enter its short code. Device credentials are stored in the phone's secure storage.
- The mobile app retains the last snapshot and marks it stale when the bridge stops responding.
- Run the bridge with `--demo` to preview a clearly labeled sample dashboard.

## Run the mobile app

```powershell
cd mobile
npm install
npm start
```

## Run the Windows bridge

On the Windows PC, install dependencies and start the bridge:

```powershell
cd bridge
npm install
npm start
```

The bridge requires Node.js 20 or newer.

The bridge opens its setup page on the PC. In the mobile app's Bridge tab, scan the displayed QR code or enter its bridge address and short code. The phone and PC must be on the same trusted Wi-Fi network. Allow Node.js through Windows Firewall for private networks if prompted.

To install the latest prebuilt telemetry plugin without C++ build tools, run:

```powershell
npm run setup:plugin
```

The installer downloads the plugin from the [latest GitHub Release](https://github.com/LeviM-0323/ATS-Companion/releases/latest), detects ATS in Steam libraries, and lets you choose another game folder if needed. If detection fails, it prompts for the folder. Restart ATS after installation and keep the bridge running.

For manual installation, download `ATSCompanionTelemetry.dll` from the [latest GitHub Release](https://github.com/LeviM-0323/ATS-Companion/releases/latest) and copy it to `<ATS game folder>\bin\win_x64\plugins\ATSCompanionTelemetry.dll` (create the `plugins` folder if needed), then restart ATS.

To build the plugin from source instead, install Visual Studio C++ Build Tools with the Desktop development with C++ workload, then run `npm run setup:plugin -- -BuildFromSource`. The build script downloads and verifies the official SCS Telemetry SDK before compiling the x64 DLL.

Use `npm start -- --demo` to preview sample readings without ATS.

The bridge defaults to port `3210`; set `PORT` to change it. Set `HOST` to `127.0.0.1` to restrict the server to the PC, or leave its default `0.0.0.0` to accept connections on network interfaces. Do not forward the bridge port to the internet.

Run bridge tests with:

```powershell
cd bridge
npm test
```

## Run the Linux bridge

On Linux, install Node.js 20 or newer and npm, then run the installer from a checkout:

```sh
./bridge/linux-install.sh --game-dir "/path/to/American Truck Simulator"
```

The installer checks common Steam library locations for ATS. Use `--game-dir` when automatic detection is unavailable or you want to select a different installation. It installs the bridge under `${XDG_DATA_HOME:-$HOME/.local/share}/ats-companion/bridge` by default.

For a native x86_64 Linux ATS installation, the installer also builds the SCS SDK plugin and installs `ATSCompanionTelemetry.so` under `bin/linux_x64/plugins`. The build needs `g++`, `curl`, `sha256sum`, and `unzip`; it downloads and verifies the official SCS Telemetry SDK 1.16. Restart ATS after installation so the game loads the plugin. The installer does not overwrite an existing plugin it does not own.

For a Windows ATS installation launched through Proton, the Linux `.so` is not used. Install and run the Windows bridge and Windows telemetry plugin instead.

Start the Linux bridge with:

```sh
${XDG_DATA_HOME:-$HOME/.local/share}/ats-companion/bridge/bin/ats-companion-bridge
```

The native plugin and Linux bridge use `/tmp/ats-companion-<uid>/telemetry.sock` by default. This shared path is visible to the game when Steam Linux Runtime isolates `$XDG_RUNTIME_DIR` from host processes. Set `ATS_COMPANION_TELEMETRY_SOCKET` in both the game and bridge environments to use another socket path.

The Linux bridge keeps pairing and the authenticated read-only snapshot API. Native live telemetry is experimental until a real game session is confirmed to load the plugin and deliver a fresh snapshot; otherwise snapshot requests return `503 telemetry_unavailable`.
