import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DeviceRegistry } from './device-registry.mjs';
import { createBridgeServer } from './http-server.mjs';
import {
  createTelemetryReceiver,
  getTelemetrySocketPath,
  listenTelemetryReceiver,
  TELEMETRY_PIPE,
} from './telemetry.mjs';

export { createBridgeServer };

const demoSnapshot = {
  mode: 'demo',
  capturedAt: '2026-01-01T12:00:00.000Z',
  game: { connected: true, paused: false },
  truck: {
    make: 'Peterbilt',
    model: '579',
    speedMph: 62,
    gear: '12',
    fuelGallons: 118.4,
    fuelCapacityGallons: 150,
    engineRpm: 1420,
    odometerMiles: 184203,
  },
  job: {
    cargo: 'Refrigerated Produce',
    origin: 'Bakersfield, CA',
    destination: 'Reno, NV',
    remainingMiles: 287,
    estimatedTimeMinutes: 312,
  },
};

function getLocalIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function validateBridgeUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'http:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('BRIDGE_URL must be an HTTP origin without credentials or a path.');
  }
  return parsed.origin;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function openSetupPage(url) {
  if (process.platform !== 'win32') return;
  const child = execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
  child.on('error', (error) => console.warn(`Could not open the setup page automatically: ${error.message}`));
}

async function start() {
  const demoMode = process.argv.includes('--demo');
  const port = parsePort(process.env.PORT ?? '3210');
  const host = process.env.HOST ?? '0.0.0.0';
  const storageDirectory =
    process.env.LOCALAPPDATA ??
    (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME);
  if (!storageDirectory) throw new Error('Cannot determine a private directory for paired devices.');

  const registry = new DeviceRegistry({
    storagePath: `${storageDirectory}/ATS Companion/devices.json`,
  });
  await registry.load();
  let telemetryReceiver = null;
  let telemetryAddress = null;
  if (process.platform === 'win32') {
    telemetryReceiver = createTelemetryReceiver();
    telemetryReceiver.listen(TELEMETRY_PIPE);
    telemetryAddress = TELEMETRY_PIPE;
    telemetryReceiver.onError((error) => console.error('Telemetry pipe failed:', error));
  } else if (process.platform === 'linux' && !demoMode) {
    telemetryReceiver = createTelemetryReceiver();
    telemetryReceiver.onError((error) => console.error('ATS telemetry socket failed:', error));
    telemetryAddress = await listenTelemetryReceiver(telemetryReceiver, getTelemetrySocketPath());
    console.log(`ATS telemetry receiver listening on ${telemetryAddress}`);
  }
  const localAddress = validateBridgeUrl(
    process.env.BRIDGE_URL ?? `http://${getLocalIpv4Addresses()[0] ?? '127.0.0.1'}:${port}`,
  );
  const server = createBridgeServer({
    deviceRegistry: registry,
    bridgeUrl: localAddress,
    snapshotProvider: demoMode
      ? () => ({ ...demoSnapshot, capturedAt: new Date().toISOString() })
      : telemetryReceiver?.snapshotProvider,
  });

  server.on('error', (error) => {
    console.error('Could not start the ATS Companion bridge:', error);
    process.exitCode = 1;
    telemetryReceiver?.close().catch((closeError) => console.error('Could not close the telemetry pipe:', closeError));
  });
  server.listen(port, host, () => {
    console.log(`ATS Companion bridge listening on ${host}:${port}`);
    console.log(`Open http://localhost:${port}/setup on this PC to pair a phone.`);
    console.log(`Phone bridge address: ${localAddress}`);
    console.log(
      demoMode
        ? 'DEMO MODE: sample readings only; no ATS game data is being read.'
        : telemetryReceiver
          ? `Waiting for the ATS plugin on ${telemetryAddress}`
          : process.platform === 'linux'
            ? 'Live ATS telemetry is unavailable on Linux.'
            : 'No live ATS telemetry source is configured for this platform.',
    );
    console.log('Use only on a trusted private network; do not forward this port to the internet.');
    openSetupPage(`http://localhost:${port}/setup`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error('Could not start the ATS Companion bridge:', error);
    process.exitCode = 1;
  });
}
