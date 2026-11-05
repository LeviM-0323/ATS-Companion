import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySnapshotError } from '../src/bridge/snapshot-status.ts';

test('a telemetry-unavailable response means the bridge is reachable but waiting for data', () => {
  assert.deepEqual(
    classifySnapshotError(503, {
      error: {
        code: 'telemetry_unavailable',
        message: 'Waiting for a fresh ATS telemetry snapshot.',
      },
    }),
    {
      connection: 'waiting',
      message:
        'Waiting for a fresh ATS telemetry snapshot. If you installed the telemetry plugin while ATS was running, restart ATS to load it.',
    },
  );
});

test('other snapshot failures remain bridge errors', () => {
  assert.deepEqual(
    classifySnapshotError(401, {
      error: {
        code: 'unauthorized',
        message: 'Device authorization is required.',
      },
    }),
    {
      connection: 'error',
      message: 'Device authorization is required.',
    },
  );
});
