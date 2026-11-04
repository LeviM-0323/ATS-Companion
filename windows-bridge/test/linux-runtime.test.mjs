import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isLinux = process.platform === 'linux';

test('Linux bridge pairs devices and reports live telemetry unavailable', { skip: !isLinux }, async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'ats-companion-linux-'));
  const portServer = createServer();
  await new Promise((resolve, reject) => {
    portServer.once('error', reject);
    portServer.listen(0, '127.0.0.1', resolve);
  });
  const address = portServer.address();
  assert(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolve, reject) => {
    portServer.close((error) => (error ? reject(error) : resolve()));
  });

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HOME: homeDirectory,
      HOST: '127.0.0.1',
      PORT: `${port}`,
      BRIDGE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(homeDirectory, { recursive: true, force: true });
  });

  let output = '';
  const startup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Bridge did not start. Output: ${output}`)), 5000);
    const handleOutput = (chunk) => {
      output += chunk;
      if (
        output.includes('ATS live telemetry is not verified on Linux') &&
        output.includes(`ATS Companion bridge listening on 127.0.0.1:${port}`)
      ) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Bridge exited with code ${code}. Output: ${output}`));
    });
  });
  await startup;

  const pairingResponse = await fetch(`http://127.0.0.1:${port}/api/v1/pairing/code`);
  assert.equal(pairingResponse.status, 200);
  const pairing = await pairingResponse.json();
  const pairResponse = await fetch(`http://127.0.0.1:${port}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, name: 'Linux test phone' }),
  });
  assert.equal(pairResponse.status, 201);
  const device = await pairResponse.json();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`);
  assert.equal(unauthorized.status, 401);

  const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`, {
    headers: { Authorization: `Bearer ${device.token}` },
  });
  assert.equal(snapshotResponse.status, 503);
  assert.equal((await snapshotResponse.json()).error.code, 'telemetry_unavailable');
});
