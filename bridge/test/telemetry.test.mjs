import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createConnection } from 'node:net';
import { createBridgeServer } from '../src/server.mjs';
import { createTelemetryReceiver, getTelemetrySocketPath } from '../src/telemetry.mjs';

const token = 'test-device-token';
let receiver;
let server;
let baseUrl;
let telemetryAddress;
let telemetryServer;

before(async () => {
  receiver = createTelemetryReceiver({ staleAfterMs: 2000 });
  telemetryServer = receiver.listen(0, '127.0.0.1');
  await new Promise((resolve) => telemetryServer.once('listening', resolve));
  const pipeAddress = telemetryServer.address();
  assert(pipeAddress && typeof pipeAddress === 'object');
  telemetryAddress = pipeAddress;

  server = createBridgeServer({ token, snapshotProvider: receiver.snapshotProvider });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await Promise.all([
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
    receiver.close(),
  ]);
});

test('Linux telemetry uses a shared socket path when XDG_RUNTIME_DIR is isolated', {
  skip: process.platform !== 'linux',
}, () => {
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = '/run/user/1000';

  try {
    assert.equal(
      getTelemetrySocketPath(),
      `/tmp/ats-companion-${process.getuid()}/telemetry.sock`,
    );
  } finally {
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
  }
});

test('snapshot reports unavailable until valid telemetry arrives', async () => {
  const response = await fetch(`${baseUrl}/api/v1/snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'telemetry_unavailable');
});

test('telemetry pipe normalizes SDK values into the mobile snapshot units', async () => {
  const pipe = createConnection(telemetryAddress.port, telemetryAddress.address);
  await new Promise((resolve, reject) => {
    pipe.once('connect', resolve);
    pipe.once('error', reject);
  });
  pipe.write(
    `${JSON.stringify({
      schemaVersion: 1,
      game: { connected: true, paused: false },
      truck: {
        make: 'Peterbilt',
        model: '579',
        speedMps: 27.7778,
        gear: 12,
        fuelLiters: 100,
        fuelCapacityLiters: 500,
        engineRpm: 1420,
        odometerKm: 1000,
      },
      job: {
        cargo: 'Produce',
        origin: 'Bakersfield',
        destination: 'Reno',
        remainingMeters: 160934.4,
        estimatedTimeSeconds: 3600,
      },
    })}\n`,
  );

  try {
    let response;
    const deadline = Date.now() + 1000;
    do {
      response = await fetch(`${baseUrl}/api/v1/snapshot`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);

    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.mode, 'live');
    assert.equal(snapshot.truck.speedMph, 62.14);
    assert.equal(snapshot.truck.fuelGallons, 26.42);
    assert.equal(snapshot.truck.fuelCapacityGallons, 132.09);
    assert.equal(snapshot.truck.odometerMiles, 621.37);
    assert.equal(snapshot.job.remainingMiles, 100);
    assert.equal(snapshot.job.estimatedTimeMinutes, 60);
  } finally {
    pipe.destroy();
  }
});

test('telemetry receiver rejects unknown protocol versions', async () => {
  const pipe = createConnection(telemetryAddress.port, telemetryAddress.address);
  await new Promise((resolve, reject) => {
    pipe.once('connect', resolve);
    pipe.once('error', reject);
  });
  pipe.write('{"schemaVersion":9}\n');
  const closed = await new Promise((resolve) => pipe.once('close', resolve));
  assert.equal(closed, false);
  pipe.destroy();
});
