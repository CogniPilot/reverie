import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Real isolated tmux/native PTYs only. No Docker, worker, provider or personal data. */
import fs from 'node:fs';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as pty from 'node-pty';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DockerPlanLocalClient } from '../src/docker-plan-local-client.js';
import type { TerminalMultiplexer, MuxSession } from '../src/mux-interface.js';
import { Session } from '../src/session.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function until(check: () => boolean) {
  const end = performance.now() + 5000;
  while (!check()) {
    if (performance.now() >= end) throw Error('Owned native fixture did not settle');
    await delay(10);
  }
}
function birth(pid: number): string | undefined {
  try {
    const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return text
      .slice(text.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
async function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'rdc-'));
  fs.chmodSync(root, 0o700);
  vi.stubEnv('TMUX_TMPDIR', root);
  const socket = 'd' + randomUUID().replaceAll('-', '').slice(0, 8),
    name = 'reverie-' + randomUUID(),
    env = { ...process.env, TMUX: undefined, TMUX_TMPDIR: root, TERM: 'xterm-256color' };
  const tm = (args: string[]) =>
    cp.execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 2000, env });
  const clients: pty.IPty[] = [];
  const exited = new Set<pty.IPty>();
  const owned: { pid?: number; birth?: string } = {};
  const rootIdentity = fs.statSync(root, { bigint: true });
  fs.writeFileSync(
    root + '/owner.json',
    JSON.stringify({
      socket,
      name,
      root,
      uid: process.getuid?.(),
      dev: String(rootIdentity.dev),
      ino: String(rootIdentity.ino),
    }),
    { mode: 0o600 }
  );
  console.info('[owned-client-fixture]', JSON.stringify({ root, socket, name }));
  cleanup.push(async () => {
    const server = owned.pid,
      serverBirth = owned.birth;
    vi.restoreAllMocks();
    const now = fs.lstatSync(root, { bigint: true });
    if (
      now.dev !== rootIdentity.dev ||
      now.ino !== rootIdentity.ino ||
      now.uid !== rootIdentity.uid ||
      !now.isDirectory()
    )
      throw Error('Fixture root changed; retained');
    if (server === undefined) {
      const dir = root + '/tmux-' + process.getuid?.();
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((name) => fs.lstatSync(dir + '/' + name).isSocket()))
        throw Error('Unknown fixture CREATE outcome; socket retained');
    }
    if (server !== undefined && birth(server) !== undefined && birth(server) !== serverBirth)
      throw Error('Fixture server incarnation changed; retained');
    if (server !== undefined && birth(server) === serverBirth) tm(['kill-server']);
    await until(() => clients.every((c) => exited.has(c)));
    if (server !== undefined && birth(server) === serverBirth) await until(() => birth(server!) !== serverBirth);
    fs.rmSync(root, { recursive: true, force: true });
  });
  tm(['new-session', '-d', '-s', name, process.execPath, '-e', 'setTimeout(()=>process.exit(0),1200)']);
  const server = Number(tm(['display-message', '-p', '#{pid}']).trim()),
    serverBirth = birth(server);
  owned.pid = server;
  owned.birth = serverBirth;
  tm(['set-option', '-w', '-t', '=' + name + ':0', 'remain-on-exit', 'on']);
  const docker = {
    hostId: 'boxed-runtime',
    label: 'Synthetic',
    hostWorkspacePath: '/tmp',
    containerWorkdir: '/workspace',
    network: 'none' as const,
    mountCredentials: false,
    hooksEnabled: true,
    resumeOnStart: true,
    owned: false,
    containerName: 'a'.repeat(64),
    image: 'sha256:' + 'b'.repeat(64),
    engine: 'docker' as const,
    continuation: {
      employeeId: randomUUID(),
      operationId: randomUUID(),
      sessionGeneration: 1,
      clientManifestDigest: 'c'.repeat(64),
      apiUrl: 'http://synthetic.invalid:3000',
    },
  };
  const record: MuxSession = {
    sessionId: randomUUID(),
    muxName: name,
    pid: 123,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'claude',
    attached: true,
    owner: undefined,
    docker,
  };
  let active: MuxSession | undefined = record;
  const mux = {
    muxSocket: socket,
    getAttachCommand: () => 'tmux',
    getAttachArgs: (n: string) => ['-L', socket, 'attach-session', '-t', n],
    getSession: () => active,
  } as unknown as TerminalMultiplexer;
  function attach() {
    const client = pty.spawn('tmux', mux.getAttachArgs(name), {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: root,
      env,
    });
    clients.push(client);
    client.onData(() => {});
    client.onExit(() => exited.add(client));
    return client;
  }
  const first = attach(),
    capture = DockerPlanLocalClient.capture(first, mux, record),
    second = attach();
  const census = () => tm(['list-clients', '-F', '#{client_pid}']).trim().split('\n').filter(Boolean).map(Number);
  await until(() => census().includes(first.pid) && census().includes(second.pid));
  await until(() => tm(['list-panes', '-t', '=' + name + ':0', '-F', '#{pane_dead}']).trim() === '1');
  const pane = tm(['list-panes', '-t', '=' + name + ':0', '-F', '#{pane_id}:#{pane_pid}:#{pane_dead}']).trim();
  return {
    root,
    socket,
    name,
    first,
    second,
    capture,
    mux,
    record,
    census,
    server,
    serverBirth,
    pane,
    tm,
    exited,
    replace: () => {
      active = { ...record };
    },
  };
}
describe.runIf(process.platform === 'linux')('actual exact website-owned tmux client detach', () => {
  it('detaches only the captured attach client after pane exit and joins its real exit plus absence', async () => {
    const f = await fixture(),
      calls = vi.spyOn(cp, 'execFileSync');
    let checks = 0;
    await f.capture.detach(f.first, f.mux, f.record, () => {
      checks++;
    });
    expect(checks).toBeGreaterThan(4);
    expect(f.exited.has(f.first)).toBe(true);
    expect(birth(f.first.pid)).toBeUndefined();
    expect(f.census()).toEqual([f.second.pid]);
    expect(f.tm(['list-panes', '-t', '=' + f.name + ':0', '-F', '#{pane_id}:#{pane_pid}:#{pane_dead}']).trim()).toBe(
      f.pane
    );
    expect(birth(f.server)).toBe(f.serverBirth);
    expect(f.exited.has(f.second)).toBe(false);
    const mutations = calls.mock.calls.map(([, args]) => args as string[]).filter((a) => a.includes('detach-client'));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual(['-L', f.socket, 'detach-client', '-t', Reflect.get(f.first, 'ptsName')]);
    expect(
      calls.mock.calls.some(([, args]) =>
        (args as string[]).some((a) =>
          ['kill-pane', 'kill-session', 'kill-server', 'send-keys', 'respawn-pane', '-P', '-a', '-s', '-E'].includes(a)
        )
      )
    ).toBe(false);
  });
  it.each(['foreign-pty', 'different-mux', 'replacement-record', 'owner', 'docker', 'stale-map'] as const)(
    'refuses changed %s without detaching either client',
    async (kind) => {
      const f = await fixture();
      let child = f.first,
        mux = f.mux,
        record = f.record;
      if (kind === 'foreign-pty') child = f.second;
      if (kind === 'different-mux') mux = { ...f.mux } as TerminalMultiplexer;
      if (kind === 'replacement-record') record = { ...f.record };
      if (kind === 'owner') f.record.owner = 'foreign';
      if (kind === 'docker') f.record.docker = { ...f.record.docker!, containerName: 'd'.repeat(64) };
      if (kind === 'stale-map') f.replace();
      await expect(f.capture.detach(child, mux, record, () => {})).rejects.toThrow('unconfirmed');
      expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
      expect(f.exited.size).toBe(0);
    }
  );
  it('refuses a reused PID birth reading while the actual original and foreign clients remain untouched', async () => {
    const f = await fixture(),
      original = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(original, fs, [p, ...args]);
      if (p === '/proc/' + f.first.pid + '/stat' && typeof value === 'string') {
        const at = value.lastIndexOf(')'),
          fields = value
            .slice(at + 2)
            .trim()
            .split(/\s+/);
        fields[19] = '1';
        return value.slice(0, at + 2) + fields.join(' ');
      }
      return value;
    }) as typeof fs.readFileSync);
    await expect(f.capture.detach(f.first, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
  it('rechecks revoked current authority before the sole client effect', async () => {
    const f = await fixture();
    let n = 0;
    await expect(
      f.capture.detach(f.first, f.mux, f.record, () => {
        if (++n >= 3) throw Error('retirement revoked');
      })
    ).rejects.toThrow('retirement revoked');
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
  it('retains unknown detach outcome without falling back to any signal or session kill', async () => {
    const f = await fixture(),
      original = cp.execFileSync;
    let attempted = 0;
    vi.spyOn(cp, 'execFileSync').mockImplementation(((file: string, args: readonly string[], options: unknown) => {
      if (args.includes('detach-client')) {
        attempted++;
        throw Error('unknown command outcome');
      }
      return Reflect.apply(original, cp, [file, args, options]);
    }) as typeof cp.execFileSync);
    await expect(f.capture.detach(f.first, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
    expect(attempted).toBe(1);
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
});
describe('genuine native proof remains distinct from local-client custody', () => {
  it('refuses serialized source retirement DATA before any local detach effect', async () => {
    const s = new Session({ workingDir: '/tmp', mode: 'claude' });
    await expect(s.detachDockerPlanSourceClient({ oldSession: s.id })).rejects.toThrow('proof');
  });
});

describe.runIf(process.platform === 'linux')('client metadata and checked-close uncertainty', () => {
  it('rejects a changed native client TTY tuple without any detach command', async () => {
    const f = await fixture(),
      original = cp.execFileSync;
    const calls = vi.spyOn(cp, 'execFileSync').mockImplementation(((
      file: string,
      args: readonly string[],
      options: unknown
    ) => {
      const out = Reflect.apply(original, cp, [file, args, options]);
      if (args.some((a) => a.includes('#{client_tty}'))) {
        return String(out)
          .split('\n')
          .map((line) => {
            const fields = line.split('\t');
            if (fields[0] === String(f.first.pid)) {
              fields[1] = String(Reflect.get(f.second, 'ptsName'));
              fields[2] = fields[1]!;
            }
            return fields.join('\t');
          })
          .join('\n');
      }
      return out;
    }) as typeof cp.execFileSync);
    await expect(f.capture.detach(f.first, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
    expect(calls.mock.calls.some(([, args]) => (args as string[]).includes('detach-client'))).toBe(false);
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
  it('retains a consuming-close error after actual client exit instead of granting later success', async () => {
    const f = await fixture(),
      original = fs.closeSync;
    let injected = false;
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      let target = false;
      try {
        target = fs.readlinkSync('/proc/self/fd/' + fd) === Reflect.get(f.first, 'ptsName');
      } catch {
        /* another already-closed descriptor is not ours */
      }
      original(fd);
      if (!injected && target) {
        injected = true;
        throw Object.assign(Error('synthetic close failure'), { code: 'EIO' });
      }
    });
    await expect(f.capture.detach(f.first, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
    expect(injected).toBe(true);
    expect(f.exited.has(f.first)).toBe(true);
    expect(birth(f.first.pid)).toBeUndefined();
    expect(f.census()).toEqual([f.second.pid]);
    await expect(f.capture.detach(null, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
  });
});
