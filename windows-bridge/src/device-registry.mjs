import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LIFETIME_MS = 5 * 60 * 1000;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashesMatch(candidate, expected) {
  const candidateHash = Buffer.from(hash(candidate), 'hex');
  const expectedHash = Buffer.from(expected, 'hex');
  return timingSafeEqual(candidateHash, expectedHash);
}

function parseBearer(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  return /^[a-f0-9]{64}$/i.test(token) ? token : null;
}

function makePairingCode() {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

export class DeviceRegistry {
  #devices = new Map();
  #activeCode = null;
  #now;
  #storagePath;

  constructor({ storagePath, now = Date.now }) {
    if (!storagePath) throw new Error('A device registry storage path is required.');
    this.#storagePath = storagePath;
    this.#now = now;
  }

  async load() {
    try {
      const serialized = await readFile(this.#storagePath, 'utf8');
      const data = JSON.parse(serialized);
      if (data.version !== 1 || !Array.isArray(data.devices)) {
        throw new Error('The saved device registry has an unsupported format.');
      }

      for (const device of data.devices) {
        if (
          typeof device.deviceId !== 'string' ||
          typeof device.tokenHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(device.tokenHash) ||
          typeof device.createdAt !== 'string' ||
          typeof device.name !== 'string'
        ) {
          throw new Error('The saved device registry contains an invalid entry.');
        }
        this.#devices.set(device.deviceId, device);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }

  issueCode() {
    const code = makePairingCode();
    const expiresAt = this.#now() + CODE_LIFETIME_MS;
    this.#activeCode = { hash: hash(code), expiresAt };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async pair(code, name = 'Mobile device') {
    if (typeof code !== 'string' || !this.#activeCode) return null;
    const activeCode = this.#activeCode;
    if (this.#now() >= activeCode.expiresAt || !hashesMatch(code.toUpperCase(), activeCode.hash)) {
      return null;
    }
    this.#activeCode = null;

    const device = {
      deviceId: randomUUID(),
      token: randomBytes(32).toString('hex'),
      createdAt: new Date(this.#now()).toISOString(),
      name: typeof name === 'string' ? name.trim().slice(0, 40) || 'Mobile device' : 'Mobile device',
    };
    this.#devices.set(device.deviceId, {
      deviceId: device.deviceId,
      tokenHash: hash(device.token),
      createdAt: device.createdAt,
      name: device.name,
    });
    await this.#save();
    return { deviceId: device.deviceId, token: device.token };
  }

  authenticate(authorization) {
    const token = parseBearer(authorization);
    if (!token) return null;
    for (const device of this.#devices.values()) {
      if (hashesMatch(token, device.tokenHash)) return { deviceId: device.deviceId };
    }
    return null;
  }

  async revoke(authorization) {
    const device = this.authenticate(authorization);
    if (!device) return false;
    this.#devices.delete(device.deviceId);
    await this.#save();
    return true;
  }

  async #save() {
    const directory = dirname(this.#storagePath);
    const temporaryPath = `${this.#storagePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 1, devices: [...this.#devices.values()] }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );
      if (process.platform !== 'win32') {
        const { chmod } = await import('node:fs/promises');
        await chmod(temporaryPath, 0o600);
      }
      await rename(temporaryPath, this.#storagePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
