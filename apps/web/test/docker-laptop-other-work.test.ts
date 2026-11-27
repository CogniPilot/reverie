import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_PROVIDER_VIEW_PROGRAM,
  dockerProviderSocketLabel,
} from '../src/docker-employee-provider-view-native.js';

const sid = '11111111-1111-4111-8111-111111111111',
  oid = '22222222-2222-4222-8222-222222222222';

/** One process of a laptop: who its parent is, whose it is, and what it runs. */
interface Row {
  parent: number;
  name: string;
  uid?: number;
  state?: string;
  born?: string;
  program?: string;
}
/** What every laptop runs: its init, the provider's tmux server, the agent in its pane with what it started, and
 * this read, which an Engine exec started from outside (parent 0). */
const laptop = (extra: Record<number, Row> = {}): Record<number, Row> => ({
  1: { parent: 0, name: 'reverie-worker-' },
  20: { parent: 1, name: 'tmux: server' },
  30: { parent: 20, name: 'sh' },
  31: { parent: 30, name: 'claude' },
  32: { parent: 31, name: 'node' },
  33: { parent: 30, name: 'reverie-model-r', program: '/bin/reverie-model-relay' },
  90: { parent: 0, name: 'node' },
  91: { parent: 90, name: 'tmux: client' },
  ...extra,
});

/** Execute the actual fixed in-laptop program over a controlled process table. `tables` are what /proc shows at
 * each look; the last one repeats. */
function work(
  tables: Record<number, Row>[],
  options: { server?: boolean; session?: boolean; paneDead?: boolean; cpu?: string | null; uid?: number } = {}
) {
  const label = dockerProviderSocketLabel(sid, 'session-v1'),
    calls: string[][] = [],
    uid = options.uid ?? 1000;
  let stdout = '',
    exit: number | undefined,
    looks = 0,
    table = tables[0]!;
  const stopped = new Error('bounded native exit');
  const directory = (owner: number) => ({ uid: owner, mode: 0o40700, isDirectory: () => true, isFile: () => false });
  const gone = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const row = (path: string) => table[Number(path.split('/')[2])];
  const fsPort = {
    lstatSync(path: string) {
      if (path === '/opt/reverie-worker-tools/bin/tmux') return { uid: 0, mode: 0o100555, isFile: () => true };
      return directory(0);
    },
    statfsSync: () => ({ type: 0x9fa0 }),
    readdirSync(path: string) {
      expect(path).toBe('/proc');
      table = tables[Math.min(looks++, tables.length - 1)]!;
      return ['self', 'sys', 'cpuinfo', ...Object.keys(table)];
    },
    statSync(path: string) {
      const found = row(path);
      if (!found) throw gone();
      return { uid: found.uid ?? uid };
    },
    readlinkSync(path: string) {
      const found = row(path);
      if (!found) throw gone();
      return found.program ?? '/nix/store/some/bin/' + found.name;
    },
    readFileSync(path: string) {
      if (path === '/proc/self/status') return 'NoNewPrivs: 1\nCapInh: 0\nCapPrm: 0\nCapEff: 0\nCapAmb: 0\n';
      if (path === '/sys/fs/cgroup/cpu.stat') {
        if (options.cpu === null) throw gone();
        return `usage_usec ${options.cpu ?? '5250000'}\nuser_usec 1\nsystem_usec 2\n`;
      }
      const found = row(path);
      if (!found) throw gone();
      // The name may hold spaces and brackets: the fields are counted from the last one.
      const fields = [
        found.state ?? 'S',
        found.parent,
        ...Array(17).fill('0'),
        found.born ?? '1000' + path.split('/')[2],
      ];
      return `${path.split('/')[2]} (${found.name}) ${fields.join(' ')} 0 0\n`;
    },
  };
  const child = {
    spawnSync(_program: string, argv: string[]) {
      calls.push(argv);
      expect(argv[argv.indexOf('-L') + 1]).toBe(label);
      if (!argv.includes('display-message')) throw Error('The read only asks tmux what it shows');
      if (options.server === false) return { status: 1, stdout: '', stderr: 'no server running' };
      if (!argv.includes('-t')) return { status: 0, stdout: '20\n', stderr: '' };
      if (options.session === false) return { status: 1, stdout: '', stderr: "can't find session" };
      return { status: 0, stdout: `30 ${options.paneDead ? 1 : 0}\n`, stderr: '' };
    },
  };
  const processPort = {
    argv: ['node', '--runtime-namespace=session-v1', 'work', sid, oid, 'none'],
    getuid: () => uid,
    env: {},
    stdout: { write: (text: string) => void (stdout += text) },
    exit: (code: number) => {
      exit = code;
      throw stopped;
    },
  };
  try {
    runInNewContext(
      DOCKER_PROVIDER_VIEW_PROGRAM,
      { require: (name: string) => (name === 'node:fs' ? fsPort : child), process: processPort },
      { timeout: 5000 }
    );
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return { exit, calls, looks, seen: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : undefined };
}

describe('the in-laptop read of work that is not the agent', () => {
  it('finds none in a laptop that runs its init, its tmux server, the agent and the office’s own reads', () => {
    const result = work([laptop()]);
    expect(result.exit).toBe(0);
    expect(result.seen).toEqual({
      version: 1,
      purpose: 'reverie-laptop-other-work-v1',
      agent: true,
      others: 0,
      names: [],
      cpuUsec: '5250000',
    });
    // Two looks at the process table, and nothing but questions to tmux.
    expect(result.looks).toBe(2);
    expect(result.calls.every((argv) => argv.includes('display-message'))).toBe(true);
  });

  it.each([
    [
      'a job that left its shell and was given to the init',
      { 50: { parent: 1, name: 'cargo' }, 51: { parent: 50, name: 'rustc' } },
      2,
      ['cargo', 'rustc'],
    ],
    [
      'a tmux server of the employee’s own, with what runs in it',
      { 60: { parent: 1, name: 'tmux: server' }, 61: { parent: 60, name: 'bash' }, 62: { parent: 61, name: 'make' } },
      3,
      ['tmux??server', 'bash', 'make'],
    ],
    [
      'another window on the provider’s own server',
      { 70: { parent: 20, name: 'bash' }, 71: { parent: 70, name: 'pytest' } },
      2,
      ['bash', 'pytest'],
    ],
  ] as const)('reports %s', (_name, extra, others, names) => {
    const result = work([laptop(extra)]);
    expect(result.seen).toMatchObject({ agent: true, others, names });
  });

  it('counts nothing that is the agent’s own, however deep, nor anything an exec started from outside', () => {
    const result = work([
      laptop({
        40: { parent: 32, name: 'bash' },
        41: { parent: 40, name: 'cargo' },
        42: { parent: 41, name: 'rustc' },
        95: { parent: 0, name: 'reverie' },
        96: { parent: 95, name: 'sleep' },
      }),
    ]);
    expect(result.seen).toMatchObject({ others: 0, names: [] });
  });

  it('counts neither the dead, nor what belongs to another user, nor what was gone at the second look', () => {
    const steady = laptop({
      50: { parent: 1, name: 'defunct', state: 'Z' },
      51: { parent: 1, name: 'rootd', uid: 0 },
    });
    expect(work([steady]).seen).toMatchObject({ others: 0 });
    // A short job between the looks, and a PID that was used again by something else: neither stayed.
    const first = laptop({ 52: { parent: 1, name: 'true' }, 53: { parent: 1, name: 'old', born: '77' } });
    const second = laptop({ 53: { parent: 1, name: 'new', born: '78' } });
    expect(work([first, second]).seen).toMatchObject({ others: 0 });
    // One that stayed is counted once.
    const stays = { 54: { parent: 1, name: 'long build (x)' } };
    expect(work([laptop(stays), laptop(stays)]).seen).toMatchObject({ others: 1, names: ['long?build??x?'] });
  });

  it('names at most five, and still counts all', () => {
    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [100 + index, { parent: 1, name: 'job' + index }])
    );
    const result = work([laptop(many)]);
    expect(result.seen).toMatchObject({ others: 9 });
    expect(result.seen!.names).toHaveLength(5);
  });

  it('still counts what runs when there is no agent: no server, no session, or a pane that has ended', () => {
    const job = { 50: { parent: 1, name: 'rsync' } };
    const bare: Record<number, Row> = {
      1: { parent: 0, name: 'reverie-worker-' },
      90: { parent: 0, name: 'node' },
      ...job,
    };
    expect(work([bare], { server: false }).seen).toMatchObject({ agent: false, others: 1, names: ['rsync'] });
    expect(work([laptop(job)], { session: false }).seen).toMatchObject({ agent: false });
    // The pane's process ended: what it had started and left behind is no agent's any more.
    const ended = work([laptop(job)], { paneDead: true }).seen!;
    expect(ended.agent).toBe(false);
    expect(ended.others).toBeGreaterThanOrEqual(1);
  });

  it('says nothing of the CPU where the laptop cannot read its own cgroup', () => {
    expect(work([laptop()], { cpu: null }).seen).toMatchObject({ cpuUsec: null, others: 0 });
  });

  it('refuses a process table it cannot read, and reports nothing then', () => {
    const odd = laptop({ 50: { parent: 1, name: 'job', born: 'x' } });
    expect(() => work([odd])).toThrow('Existing Docker provider view unavailable');
  });
});
