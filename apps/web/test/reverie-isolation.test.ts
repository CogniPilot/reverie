import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';

it('starts with separate Reverie state without relocating a historical installation', () => {
  const home = mkdtempSync(join(tmpdir(), 'reverie-isolation-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  try {
    for (const name of ['.claudeman', 'claudeman-cases']) {
      mkdirSync(join(home, name));
      writeFileSync(join(home, name, 'sentinel'), name);
    }
    const store = new StateStore();
    store.setSessionOrder([]);
    store.saveNow();
    expect(existsSync(join(home, '.reverie', 'state.json'))).toBe(true);
    for (const name of ['.claudeman', 'claudeman-cases'])
      expect(readFileSync(join(home, name, 'sentinel'), 'utf8')).toBe(name);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
