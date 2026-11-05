export type Snapshot = {
  mode: 'demo' | 'live';
  capturedAt: string;
  game: {
    connected: boolean;
    paused: boolean;
  };
  truck: {
    make: string;
    model: string;
    speedMph: number;
    gear: string;
    fuelGallons: number;
    fuelCapacityGallons: number;
    engineRpm: number;
    odometerMiles: number;
  };
  job: {
    cargo: string;
    origin: string;
    destination: string;
    remainingMiles: number;
    estimatedTimeMinutes: number;
  } | null;
};

export type PairingPayload = { version: 1; bridgeUrl: string; code: string };

export function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Snapshot>;
  return (
    (candidate.mode === 'demo' || candidate.mode === 'live') &&
    typeof candidate.capturedAt === 'string' &&
    typeof candidate.game?.connected === 'boolean' &&
    typeof candidate.game?.paused === 'boolean' &&
    typeof candidate.truck?.make === 'string' &&
    typeof candidate.truck?.model === 'string' &&
    typeof candidate.truck?.speedMph === 'number' &&
    typeof candidate.truck?.gear === 'string' &&
    typeof candidate.truck?.fuelGallons === 'number' &&
    typeof candidate.truck?.fuelCapacityGallons === 'number' &&
    typeof candidate.truck?.engineRpm === 'number' &&
    typeof candidate.truck?.odometerMiles === 'number' &&
    (candidate.job === null ||
      (typeof candidate.job?.cargo === 'string' &&
        typeof candidate.job?.origin === 'string' &&
        typeof candidate.job?.destination === 'string' &&
        typeof candidate.job?.remainingMiles === 'number' &&
        typeof candidate.job?.estimatedTimeMinutes === 'number'))
  );
}

export function parsePairingPayload(data: string): PairingPayload {
  const parsed: unknown = JSON.parse(data);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('bridgeUrl' in parsed) ||
    typeof parsed.bridgeUrl !== 'string' ||
    !('code' in parsed) ||
    typeof parsed.code !== 'string'
  ) {
    throw new Error('This QR code is not an ATS Companion pairing code.');
  }
  return parsed as PairingPayload;
}
