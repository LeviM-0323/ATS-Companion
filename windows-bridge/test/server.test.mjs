import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createBridgeServer } from '../src/server.mjs';

const token = 'test-pairing-token';
let server;
let baseUrl;

before(async () => {
  server = createBridgeServer({
    token,
    snapshotProvider: () => ({
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
      job: null,
    }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('health endpoint is available without exposing telemetry', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('snapshot endpoint requires the pairing token', async () => {
  const response = await fetch(`${baseUrl}/api/v1/snapshot`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'unauthorized');
});

test('snapshot endpoint returns the provider reading for a paired app', async () => {
  const response = await fetch(`${baseUrl}/api/v1/snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.mode, 'demo');
  assert.equal(snapshot.truck.make, 'Peterbilt');
});

test('snapshot endpoint reports a missing live telemetry source explicitly', async () => {
  const unavailableServer = createBridgeServer({ token });
  await new Promise((resolve) => unavailableServer.listen(0, '127.0.0.1', resolve));
  const address = unavailableServer.address();
  assert(address && typeof address === 'object');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'telemetry_unavailable');
  } finally {
    await new Promise((resolve, reject) => {
      unavailableServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('bridge rejects unsupported methods and routes', async () => {
  const methodResponse = await fetch(`${baseUrl}/api/v1/snapshot`, { method: 'POST' });
  assert.equal(methodResponse.status, 405);
  const routeResponse = await fetch(`${baseUrl}/missing`);
  assert.equal(routeResponse.status, 404);
});
