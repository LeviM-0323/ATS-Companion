import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';

export const TELEMETRY_PIPE = '\\\\.\\pipe\\ats-companion-telemetry-v1';
export const TELEMETRY_SOCKET_ENV = 'ATS_COMPANION_TELEMETRY_SOCKET';
const METERS_PER_SECOND_TO_MILES_PER_HOUR = 2.2369362920544;
const LITERS_TO_GALLONS = 0.26417205235815;
const KILOMETERS_TO_MILES = 0.62137119223733;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTelemetryFrame(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.schemaVersion === 1 &&
    value.game !== null &&
    typeof value.game === 'object' &&
    typeof value.game.connected === 'boolean' &&
    typeof value.game.paused === 'boolean' &&
    value.truck !== null &&
    typeof value.truck === 'object' &&
    typeof value.truck.make === 'string' &&
    typeof value.truck.model === 'string' &&
    isFiniteNumber(value.truck.speedMps) &&
    Number.isInteger(value.truck.gear) &&
    isFiniteNumber(value.truck.fuelLiters) &&
    isFiniteNumber(value.truck.fuelCapacityLiters) &&
    isFiniteNumber(value.truck.engineRpm) &&
    isFiniteNumber(value.truck.odometerKm) &&
    (value.job === null ||
      (typeof value.job === 'object' &&
        typeof value.job.cargo === 'string' &&
        typeof value.job.origin === 'string' &&
        typeof value.job.destination === 'string' &&
        isFiniteNumber(value.job.remainingMeters) &&
        isFiniteNumber(value.job.estimatedTimeSeconds)))
  );
}

function rounded(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeFrame(frame, capturedAt) {
  return {
    mode: 'live',
    capturedAt,
    game: frame.game,
    truck: {
      make: frame.truck.make,
      model: frame.truck.model,
      speedMph: rounded(frame.truck.speedMps * METERS_PER_SECOND_TO_MILES_PER_HOUR),
      gear: frame.truck.gear < 0 ? `R${Math.abs(frame.truck.gear)}` : frame.truck.gear === 0 ? 'N' : `${frame.truck.gear}`,
      fuelGallons: rounded(frame.truck.fuelLiters * LITERS_TO_GALLONS),
      fuelCapacityGallons: rounded(frame.truck.fuelCapacityLiters * LITERS_TO_GALLONS),
      engineRpm: Math.round(frame.truck.engineRpm),
      odometerMiles: rounded(frame.truck.odometerKm * KILOMETERS_TO_MILES),
    },
    job: frame.job
      ? {
          cargo: frame.job.cargo,
          origin: frame.job.origin,
          destination: frame.job.destination,
          remainingMiles: rounded(frame.job.remainingMeters * 0.00062137119223733),
          estimatedTimeMinutes: Math.round(frame.job.estimatedTimeSeconds / 60),
        }
      : null,
  };
}

export function getTelemetrySocketPath() {
  const configuredPath = process.env[TELEMETRY_SOCKET_ENV];
  if (configuredPath) return configuredPath;

  return join('/tmp', `ats-companion-${process.getuid()}`, 'telemetry.sock');
}

async function prepareTelemetrySocket(socketPath) {
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) >= 108) {
    throw new Error('ATS telemetry socket path must be absolute and shorter than 108 bytes.');
  }
  const socketDirectory = dirname(socketPath);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(socketDirectory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    directoryStats.uid !== process.getuid()
  ) {
    throw new Error(`ATS telemetry socket directory is not a private directory owned by this user: ${socketDirectory}`);
  }
  await chmod(socketDirectory, 0o700);

  try {
    const socketStats = await lstat(socketPath);
    if (!socketStats.isSocket() || socketStats.uid !== process.getuid()) {
      throw new Error(`Refusing to replace an unexpected file at the ATS telemetry socket path: ${socketPath}`);
    }

    await new Promise((resolve, reject) => {
      const connection = createConnection(socketPath);
      connection.once('connect', () => {
        connection.destroy();
        reject(new Error(`An ATS telemetry receiver is already listening at ${socketPath}`));
      });
      connection.once('error', (error) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve();
        else reject(error);
      });
    });
    await unlink(socketPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

export function createTelemetryReceiver({ staleAfterMs = 3000, now = Date.now } = {}) {
  let latestFrame = null;

  const server = createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (buffered.length > 64 * 1024) {
        socket.destroy(new Error('Telemetry frame exceeded the maximum size.'));
        return;
      }

      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;

        try {
          const frame = JSON.parse(line);
          if (!isTelemetryFrame(frame)) {
            throw new Error('Telemetry frame does not match schema version 1.');
          }
          latestFrame = { frame, receivedAt: now() };
        } catch (error) {
          console.error('Rejected telemetry pipe frame:', error);
          socket.destroy();
          return;
        }
      }
    });
    socket.on('error', (error) => {
      if (!socket.destroyed) console.error('Telemetry pipe connection failed:', error);
    });
  });

  return {
    listen(...args) {
      return server.listen(...args);
    },
    onError(handler) {
      server.on('error', handler);
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    snapshotProvider() {
      if (!latestFrame || now() - latestFrame.receivedAt > staleAfterMs) return null;
      return normalizeFrame(latestFrame.frame, new Date(latestFrame.receivedAt).toISOString());
    },
  };
}

export async function listenTelemetryReceiver(receiver, socketPath = getTelemetrySocketPath()) {
  await prepareTelemetrySocket(socketPath);
  const server = receiver.listen(socketPath);
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    await receiver.close();
    throw error;
  }
  return socketPath;
}
