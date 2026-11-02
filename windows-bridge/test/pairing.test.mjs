import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeServer } from '../src/server.mjs';
import { DeviceRegistry } from '../src/device-registry.mjs';

let server;
let registry;
let baseUrl;
let dataDirectory;

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'ats-companion-pairing-'));
  registry = new DeviceRegistry({ storagePath: join(dataDirectory, 'devices.json') });
  await registry.load();
  server = createBridgeServer({
    deviceRegistry: registry,
    bridgeUrl: 'http://192.168.1.25:3210',
    snapshotProvider: () => ({ mode: 'live', capturedAt: new Date().toISOString() }),
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
  await rm(dataDirectory, { recursive: true, force: true });
});

async function issueCode() {
  const response = await fetch(`${baseUrl}/api/v1/pairing/code`);
  assert.equal(response.status, 200);
  return response.json();
}

async function pair(code, name = 'Test phone') {
  return fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
}

test('local setup page displays a scannable pairing QR without exposing a permanent token', async () => {
  const response = await fetch(`${baseUrl}/setup`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /ATS Companion Bridge/);
  assert.match(html, /pairing\/code/);
  assert.match(html, /data:image\/png;base64,/);
  assert.doesNotMatch(html, /Authorization: Bearer/);
});

test('pairing code is single-use, grants a device credential, and credential survives restart', async () => {
  const { code, bridgeUrl, expiresAt } = await issueCode();
  assert.equal(bridgeUrl, 'http://192.168.1.25:3210');
  assert.ok(Date.parse(expiresAt) > Date.now());

  const response = await pair(code);
  assert.equal(response.status, 201);
  const credential = await response.json();
  assert.match(credential.deviceId, /^[0-9a-f-]{36}$/i);
  assert.match(credential.token, /^[0-9a-f]{64}$/);

  const reusedCode = await pair(code, 'Second phone');
  assert.equal(reusedCode.status, 400);

  const snapshot = await fetch(`${baseUrl}/api/v1/snapshot`, {
    headers: { Authorization: `Bearer ${credential.token}` },
  });
  assert.equal(snapshot.status, 200);

  const restartedRegistry = new DeviceRegistry({
    storagePath: join(dataDirectory, 'devices.json'),
  });
  await restartedRegistry.load();
  const restoredServer = createBridgeServer({
    deviceRegistry: restartedRegistry,
    snapshotProvider: () => ({ mode: 'live', capturedAt: new Date().toISOString() }),
  });
  await new Promise((resolve) => restoredServer.listen(0, '127.0.0.1', resolve));
  const address = restoredServer.address();
  assert(address && typeof address === 'object');
  try {
    const restoredSnapshot = await fetch(`http://127.0.0.1:${address.port}/api/v1/snapshot`, {
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    assert.equal(restoredSnapshot.status, 200);
  } finally {
    await new Promise((resolve, reject) => {
      restoredServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('a paired device can revoke only its own credential', async () => {
  const firstPairing = await pair((await issueCode()).code, 'First phone');
  const first = await firstPairing.json();
  const secondPairing = await pair((await issueCode()).code, 'Second phone');
  const second = await secondPairing.json();

  const revoked = await fetch(`${baseUrl}/api/v1/pairing`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${first.token}` },
  });
  assert.equal(revoked.status, 204);

  const firstSnapshot = await fetch(`${baseUrl}/api/v1/snapshot`, {
    headers: { Authorization: `Bearer ${first.token}` },
  });
  assert.equal(firstSnapshot.status, 401);

  const secondSnapshot = await fetch(`${baseUrl}/api/v1/snapshot`, {
    headers: { Authorization: `Bearer ${second.token}` },
  });
  assert.equal(secondSnapshot.status, 200);
});

test('bridge PC can refresh the one-time pairing QR and code', async () => {
  const codeResponse = await fetch(`${baseUrl}/api/v1/pairing/code`);
  assert.equal(codeResponse.status, 200);
  const pairing = await codeResponse.json();
  assert.match(pairing.code, /^[23456789A-HJ-NP-Z]{8}$/);
  assert.match(pairing.qr, /^data:image\/png;base64,/);
});
