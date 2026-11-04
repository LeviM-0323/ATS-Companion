import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isLinux = process.platform === 'linux';

test('Linux installer help does not require an initialized home directory', { skip: !isLinux }, () => {
  const output = execFileSync(
    'bash',
    [new URL('../../linux-bridge/install.sh', import.meta.url).pathname, '--help'],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
  );
  assert.match(output, /Usage: install\.sh/);
  assert.match(output, /Linux live telemetry has not been verified/);
});

test('Linux installer prepares the bridge for an explicitly selected ATS installation', { skip: !isLinux }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ats-companion-install-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const gameDirectory = join(temporaryDirectory, 'American Truck Simulator');
  await mkdir(join(gameDirectory, 'bin', 'win_x64'), { recursive: true });

  const fakeBin = join(temporaryDirectory, 'bin');
  await mkdir(fakeBin);
  const npmLog = join(temporaryDirectory, 'npm.log');
  const fakeNpm = join(fakeBin, 'npm');
  await writeFile(fakeNpm, '#!/bin/sh\nprintf "%s\\n" "$*" > "$NPM_LOG"\n', { mode: 0o755 });
  await chmod(fakeNpm, 0o755);

  const installPrefix = join(temporaryDirectory, 'installed bridge');
  const output = execFileSync(
    'bash',
    [
      new URL('../../linux-bridge/install.sh', import.meta.url).pathname,
      '--game-dir',
      gameDirectory,
      '--prefix',
      installPrefix,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        NPM_LOG: npmLog,
      },
    },
  );

  assert.match(output, /ATS live telemetry is not verified on Linux/);
  assert.match(await readFile(npmLog, 'utf8'), /ci --omit=dev/);
  assert.ok((await readFile(join(installPrefix, 'src', 'server.mjs'), 'utf8')).length > 0);
  assert.equal((await stat(join(installPrefix, 'bin', 'ats-companion-bridge'))).mode & 0o111, 0o111);
});

test('Linux installer rejects an explicitly selected directory without ATS binaries', { skip: !isLinux }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ats-companion-invalid-game-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const gameDirectory = join(temporaryDirectory, 'not ATS');
  await mkdir(gameDirectory);
  const script = new URL('../../linux-bridge/install.sh', import.meta.url).pathname;

  assert.throws(
    () =>
      execFileSync('bash', [script, '--game-dir', gameDirectory, '--prefix', join(temporaryDirectory, 'install')], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /ATS game binaries were not found/);
      return true;
    },
  );
});

test('Linux installer never replaces an ATS installation selected as its prefix', { skip: !isLinux }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ats-companion-prefix-safety-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const gameDirectory = join(temporaryDirectory, 'American Truck Simulator');
  const gameBinary = join(gameDirectory, 'bin', 'win_x64', 'amtrucks.exe');
  await mkdir(join(gameDirectory, 'bin', 'win_x64'), { recursive: true });
  await writeFile(gameBinary, 'ATS install sentinel');

  const fakeBin = join(temporaryDirectory, 'bin');
  await mkdir(fakeBin);
  const fakeNpm = join(fakeBin, 'npm');
  await writeFile(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(fakeNpm, 0o755);

  assert.throws(
    () =>
      execFileSync(
        'bash',
        [
          new URL('../../linux-bridge/install.sh', import.meta.url).pathname,
          '--game-dir',
          gameDirectory,
          '--prefix',
          gameDirectory,
        ],
        {
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        },
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /install prefix cannot overlap the ATS directory/i);
      return true;
    },
  );
  assert.equal(await readFile(gameBinary, 'utf8'), 'ATS install sentinel');
});

test('Linux installer preserves an existing directory it does not own', { skip: !isLinux }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ats-companion-prefix-owned-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const gameDirectory = join(temporaryDirectory, 'American Truck Simulator');
  await mkdir(join(gameDirectory, 'bin', 'win_x64'), { recursive: true });
  const installPrefix = join(temporaryDirectory, 'existing-data');
  await mkdir(installPrefix);
  const userFile = join(installPrefix, 'keep.txt');
  await writeFile(userFile, 'User data must stay in place.');

  assert.throws(
    () =>
      execFileSync(
        'bash',
        [
          new URL('../../linux-bridge/install.sh', import.meta.url).pathname,
          '--game-dir',
          gameDirectory,
          '--prefix',
          installPrefix,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /not a managed ATS Companion installation/);
      return true;
    },
  );
  assert.equal(await readFile(userFile, 'utf8'), 'User data must stay in place.');
});

test('Linux installer detects ATS in a common Steam library', { skip: !isLinux }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ats-companion-steam-detect-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const homeDirectory = join(temporaryDirectory, 'home');
  const gameDirectory = join(
    homeDirectory,
    '.local',
    'share',
    'Steam',
    'steamapps',
    'common',
    'American Truck Simulator',
  );
  await mkdir(join(gameDirectory, 'bin', 'linux_x64'), { recursive: true });

  const fakeBin = join(temporaryDirectory, 'bin');
  await mkdir(fakeBin);
  const fakeNpm = join(fakeBin, 'npm');
  await writeFile(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(fakeNpm, 0o755);

  const output = execFileSync(
    'bash',
    [
      new URL('../../linux-bridge/install.sh', import.meta.url).pathname,
      '--prefix',
      join(temporaryDirectory, 'installed'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDirectory,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  assert.ok(output.includes(`Detected ATS installation: ${gameDirectory}`));
});
