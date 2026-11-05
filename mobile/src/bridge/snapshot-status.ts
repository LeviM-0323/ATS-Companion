export type SnapshotFailure = {
  connection: 'waiting' | 'error';
  message: string;
};

export function classifySnapshotError(status: number, body: unknown): SnapshotFailure {
  const error =
    body && typeof body === 'object' && 'error' in body
      ? body.error
      : undefined;
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const message =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : `Bridge returned HTTP ${status}.`;

  if (status === 503 && code === 'telemetry_unavailable') {
    return {
      connection: 'waiting',
      message: `${message} If you installed the telemetry plugin while ATS was running, restart ATS to load it.`,
    };
  }

  return { connection: 'error', message };
}
