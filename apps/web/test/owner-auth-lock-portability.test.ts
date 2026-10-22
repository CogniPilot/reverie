import { accessSync, constants } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { expect, it, vi } from 'vitest';
import { bootstrap } from '../src/owner-auth/admin.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';

it('bootstraps and updates the owner using flock from the runtime PATH', async () => {
  const actualFlock = (process.env.PATH || '').split(delimiter).map((dir) => join(dir, 'flock')).find((file) => {
    try { accessSync(file, constants.X_OK); return true; } catch { return false; }
  });
  expect(actualFlock, 'the runtime must provide util-linux flock').toBeTruthy();
  const directory = await mkdtemp(join(tmpdir(), 'owner-flock-portability-'));
  const bin = join(directory, 'bin');
  const capture = join(directory, 'flock-calls.jsonl');
  await mkdir(bin);
  const wrapper = join(bin, 'flock');
  await writeFile(wrapper, [
    '#!' + process.execPath,
    "const { appendFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'appendFileSync(' + JSON.stringify(capture) + ', JSON.stringify(process.argv.slice(2)) + "\\n");',
    'const child = spawnSync(' + JSON.stringify(actualFlock) + ', process.argv.slice(2), { stdio: ["ignore", "inherit", "inherit", 3] });',
    'process.exit(child.status ?? 1);',
  ].join('\n'), { mode: 0o700 });
  vi.stubEnv('PATH', bin);
  vi.stubEnv('REVERIE_FLOCK_BIN', '');
  try {
    const store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
    await bootstrap(store, 'portable-owner');
    await store.update((account) => { account.keepers = ['explicit-employee']; });
    expect(store.read()?.username).toBe('portable-owner');
    expect(store.read()?.keepers).toEqual(['explicit-employee']);
    const calls = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      expect(args[0]).toBe('--exclusive');
      expect(args.at(-1)).toBe('3');
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
