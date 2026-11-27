import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DOCKER_PROVIDER_VIEW_PROGRAM, dockerProviderTmuxMayRun } from '../src/docker-employee-provider-view-native.js';

/** A /proc as the probe inside a laptop reads it: each process with its owner and its short name. */
function proc(rows: Record<string, { uid: number; comm?: string; gone?: boolean; denied?: boolean }>) {
  const fail = (code: string) => {
    throw Object.assign(new Error(code), { code });
  };
  return {
    readdirSync: () => [...Object.keys(rows), 'self', 'meminfo', 'sys'],
    statSync: (path: string) => {
      const row = rows[path.split('/')[2]!];
      if (!row || row.gone) return fail('ENOENT');
      return { uid: row.uid };
    },
    readFileSync: (path: string) => {
      const row = rows[path.split('/')[2]!];
      if (!row || row.gone) return fail('ENOENT');
      if (row.denied) return fail('EACCES');
      return (row.comm ?? 'node') + '\n';
    },
  };
}
const USER = 1000;
const SELF = 4242;

describe('saying that no agent runs in a laptop whose tmux socket file is missing', () => {
  it('is a finding about processes: no tmux process of the laptop user exists', () => {
    const fresh = proc({
      1: { uid: USER, comm: 'reverie-worker-' },
      [SELF]: { uid: USER, comm: 'node' },
      77: { uid: USER, comm: 'sleep' },
    });
    expect(dockerProviderTmuxMayRun(fresh, USER, SELF)).toBe(false);
  });

  it('is not made while a tmux server or client of that user is alive: the socket file was only removed', () => {
    for (const comm of ['tmux: server', 'tmux: client', 'tmux'])
      expect([comm, dockerProviderTmuxMayRun(proc({ 1: { uid: USER }, 90: { uid: USER, comm } }), USER, SELF)]).toEqual(
        [comm, true]
      );
  });

  it('leaves out the probe itself, other users’ processes and processes that ended while they were read', () => {
    const rows = proc({
      [SELF]: { uid: USER, comm: 'tmux' },
      5: { uid: 0, comm: 'tmux: server' },
      6: { uid: USER, comm: 'tmux: server', gone: true },
    });
    expect(dockerProviderTmuxMayRun(rows, USER, SELF)).toBe(false);
  });

  it('is not made on a process table it cannot read', () => {
    expect(dockerProviderTmuxMayRun(proc({ 9: { uid: USER, denied: true } }), USER, SELF)).toBe(true);
    const unreadable = {
      ...proc({}),
      readdirSync: () => {
        throw new Error('EIO');
      },
    };
    expect(dockerProviderTmuxMayRun(unreadable, USER, SELF)).toBe(true);
  });

  /** The probe itself, run as inside a laptop whose socket file is missing, over the given process table. */
  function presence(table: Record<string, string>) {
    const SID = '22222222-2222-4222-8222-222222222222',
      OPERATION = '33333333-3333-4333-8333-333333333333';
    let stdout = '';
    const spawned: string[][] = [];
    const stopped = new Error('exit');
    const directory = (uid: number) => ({ uid, mode: 0o40700, isDirectory: () => true, isFile: () => false });
    const files = {
      lstatSync(path: string) {
        if (path === '/opt/reverie-worker-tools/bin/tmux') return { uid: 0, mode: 0o100555, isFile: () => true };
        // The directory tmux keeps its sockets in was cleared, or the socket file in it was.
        if (path.startsWith('/tmp/tmux-1000')) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return directory(0);
      },
      statfsSync: () => ({ type: 0x9fa0 }),
      statSync: () => ({ uid: USER }),
      readdirSync: () => Object.keys(table),
      readFileSync: (path: string) =>
        path === '/proc/self/status'
          ? 'NoNewPrivs: 1\nCapInh: 0\nCapPrm: 0\nCapEff: 0\nCapAmb: 0\n'
          : (table[path.split('/')[2]!] ?? 'node') + '\n',
    };
    const run = () => {
      try {
        runInNewContext(
          DOCKER_PROVIDER_VIEW_PROGRAM,
          {
            require: (name: string) =>
              name === 'node:fs'
                ? files
                : { spawnSync: (_program: string, argv: string[]) => (spawned.push(argv), { status: 0, stdout: '' }) },
            process: {
              argv: ['node', 'presence', SID, OPERATION, 'none'],
              pid: SELF,
              getuid: () => USER,
              env: {},
              stdout: { write: (text: string) => void (stdout += text) },
              exit: () => {
                throw stopped;
              },
            },
          },
          { timeout: 1000 }
        );
      } catch (error) {
        if (error !== stopped) throw error;
      }
      return stdout;
    };
    return { run, spawned };
  }

  it('answers ABSENT for a missing socket file only when no tmux process runs, and asks tmux nothing for it', () => {
    const empty = presence({ 1: 'reverie-worker-', [SELF]: 'node' });
    expect(empty.run()).toBe('ABSENT\n');
    expect(empty.spawned).toEqual([]);
  });

  it('refuses, and so reads as unknown, when the file is missing under a tmux server that still runs', () => {
    const alive = presence({ 1: 'reverie-worker-', 61: 'tmux: server', 70: 'claude', [SELF]: 'node' });
    expect(() => alive.run()).toThrow('Existing Docker provider view unavailable');
    expect(DOCKER_PROVIDER_VIEW_PROGRAM).toContain(dockerProviderTmuxMayRun.toString());
  });
});
