/**
 * Per-instance isolation (src/config/instance.ts): the data dir + tmux socket
 * derive from REVERIE_INSTANCE, defaulting to the production layout so the
 * feature branch is safe to merge to master.
 *
 * instance.ts reads env at module load, so each case re-imports it via
 * vi.resetModules() under a controlled env. node:fs mkdirSync is mocked so
 * getDataDir() never creates real directories on the test machine.
 *
 * Port: N/A (no server).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn() };
});

const ENV_KEYS = ['REVERIE_INSTANCE', 'REVERIE_DATA_DIR', 'REVERIE_TMUX_SOCKET'] as const;
const ORIG: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../../src/config/instance.js');
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.resetModules();
});

describe('config/instance', () => {
  it('defaults to the production layout when REVERIE_INSTANCE is unset', async () => {
    const m = await load({ REVERIE_INSTANCE: undefined, REVERIE_DATA_DIR: undefined });
    expect(m.REVERIE_INSTANCE).toBe('');
    expect(m.DEFAULT_TMUX_SOCKET).toBe('reverie');
    expect(m.getDataDir()).toBe(join(homedir(), '.reverie'));
    expect(m.dataPath('state.json')).toBe(join(homedir(), '.reverie', 'state.json'));
  });

  it('treats an explicitly-empty REVERIE_INSTANCE as the production layout', async () => {
    const m = await load({ REVERIE_INSTANCE: '', REVERIE_DATA_DIR: undefined });
    expect(m.REVERIE_INSTANCE).toBe('');
    expect(m.DEFAULT_TMUX_SOCKET).toBe('reverie');
    expect(m.getDataDir()).toBe(join(homedir(), '.reverie'));
  });

  it('scopes BOTH the data dir and the tmux socket for a named instance', async () => {
    const m = await load({ REVERIE_INSTANCE: 'beta', REVERIE_DATA_DIR: undefined });
    expect(m.REVERIE_INSTANCE).toBe('beta');
    expect(m.DEFAULT_TMUX_SOCKET).toBe('reverie-beta');
    expect(m.getDataDir()).toBe(join(homedir(), '.reverie-beta'));
    expect(m.dataPath('mux-sessions.json')).toBe(join(homedir(), '.reverie-beta', 'mux-sessions.json'));
  });

  it('supports an arbitrary instance name', async () => {
    const m = await load({ REVERIE_INSTANCE: 'foo', REVERIE_DATA_DIR: undefined });
    expect(m.DEFAULT_TMUX_SOCKET).toBe('reverie-foo');
    expect(m.getDataDir()).toBe(join(homedir(), '.reverie-foo'));
  });

  it('REVERIE_DATA_DIR overrides the derived data dir (socket still instance-scoped)', async () => {
    const m = await load({ REVERIE_INSTANCE: 'beta', REVERIE_DATA_DIR: '/tmp/reverie-test-xyz' });
    expect(m.getDataDir()).toBe('/tmp/reverie-test-xyz');
    expect(m.dataPath('a', 'b')).toBe(join('/tmp/reverie-test-xyz', 'a', 'b'));
    // Socket is derived from the instance name, not the data dir override.
    expect(m.DEFAULT_TMUX_SOCKET).toBe('reverie-beta');
  });
});

describe('Reverie environment configuration', () => {
  it('uses explicit Reverie configuration', async () => {
    const m = await load({
      REVERIE_INSTANCE: 'company',
      REVERIE_DATA_DIR: '/owned/reverie',
      REVERIE_TMUX_SOCKET: 'reverie-owned',
    });
    expect(m.getDataDir()).toBe('/owned/reverie');
    expect(m.REVERIE_INSTANCE).toBe('company');
    expect(m.resolveTmuxSocketName()).toBe('reverie-owned');
  });
  it('cannot escape the derived home directory through an instance name', async () => {
    const m = await load({ REVERIE_INSTANCE: '../../other' });
    expect(m.getDataDir()).toBe(join(homedir(), '.reverie-other'));
  });
});

describe('resolveTmuxSocketName', () => {
  it('is the instance socket when no override is set', async () => {
    const m = await load({ REVERIE_INSTANCE: 'beta', REVERIE_TMUX_SOCKET: undefined });
    expect(m.resolveTmuxSocketName()).toBe('reverie-beta');
  });

  it('honours a safe REVERIE_TMUX_SOCKET override', async () => {
    const m = await load({ REVERIE_INSTANCE: undefined, REVERIE_TMUX_SOCKET: 'reverie-test.1' });
    expect(m.resolveTmuxSocketName()).toBe('reverie-test.1');
  });

  it('ignores an override that could not be passed to `tmux -L` safely', async () => {
    // A socket name reaches a command line, so anything outside the pattern
    // falls back to the instance default rather than being escaped.
    const m = await load({ REVERIE_INSTANCE: undefined, REVERIE_TMUX_SOCKET: 'bad; rm -rf /' });
    expect(m.resolveTmuxSocketName()).toBe('reverie');
  });
});
