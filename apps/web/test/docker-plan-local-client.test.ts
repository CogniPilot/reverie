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
    cp.execFileSync('tmux', ['-f', '/dev/null', '-L', socket, ...args], { encoding: 'utf8', timeout: 2000, env });
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
  const socketPath = tm(['display-message', '-p', '#{socket_path}']).trim(),
    unattachedSocket = fs.lstatSync(socketPath, { bigint: true });
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
    socketPath,
    unattachedSocket,
    pane,
    tm,
    exited,
    replace: () => {
      active = { ...record };
    },
  };
}
describe.runIf(process.platform === 'linux')('actual exact website-owned tmux client detach', () => {
  it('observes exact live client membership and private server correlation without any client effect', async () => {
    const f = await fixture(),
      calls = vi.spyOn(cp, 'execFileSync');
    const scopes: unknown[] = [];
    f.capture.requireAttached(
      f.first,
      f.mux,
      f.record,
      () => {},
      (scope) => {
        expect(Object.isFrozen(scope)).toBe(true);
        expect(scope.serverPid).toBe(f.server);
        expect(scope.serverBirth).toBe(f.serverBirth);
        expect(scope.socketPath).toBe(f.socketPath);
        scopes.push(scope);
      }
    );
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toEqual(scopes[1]);
    expect(f.exited.size).toBe(0);
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
    expect(calls.mock.calls.every(([, args]) => (args as string[]).includes('list-clients'))).toBe(true);
  });
  it('refuses a missing original client after a genuine server-side detach without detaching its sibling', async () => {
    const f = await fixture();
    f.tm(['detach-client', '-t', String(Reflect.get(f.first, 'ptsName'))]);
    await until(() => f.exited.has(f.first));
    expect(() =>
      f.capture.requireAttached(
        null,
        f.mux,
        f.record,
        () => {},
        () => {}
      )
    ).toThrow('unconfirmed');
    expect(f.census()).toEqual([f.second.pid]);
  });
  it('cannot promote foreign or readable client DATA and preserves a denied join without any effect', async () => {
    const f = await fixture(),
      calls = vi.spyOn(cp, 'execFileSync');
    expect(() =>
      f.capture.requireAttached(
        f.second,
        f.mux,
        f.record,
        () => {},
        () => {}
      )
    ).toThrow('unconfirmed');
    expect(() =>
      DockerPlanLocalClient.prototype.requireAttached.call(
        {} as never,
        f.first,
        f.mux,
        f.record,
        () => {},
        () => {}
      )
    ).toThrow();
    expect(() =>
      f.capture.requireAttached(
        f.first,
        f.mux,
        f.record,
        () => {},
        () => {
          throw Error('Different original server');
        }
      )
    ).toThrow('Different original server');
    expect(f.exited.size).toBe(0);
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
    expect(calls.mock.calls.every(([, args]) => (args as string[]).includes('list-clients'))).toBe(true);
  });
  it.each(['live', 'already-exited'] as const)(
    'joins the last captured %s client across the real socket attachment signal',
    async (state) => {
      const f = await fixture(),
        attached = fs.lstatSync(f.socketPath, { bigint: true }),
        capture = DockerPlanLocalClient.capture(f.first, f.mux, f.record);
      expect(attached.ino).toBe(f.unattachedSocket.ino);
      expect(attached.dev).toBe(f.unattachedSocket.dev);
      expect(f.unattachedSocket.mode & 0o111n).toBe(0n);
      expect(attached.mode).toBe(f.unattachedSocket.mode | ((f.unattachedSocket.mode & 0o444n) >> 2n));
      f.tm(['detach-client', '-t', String(Reflect.get(f.second, 'ptsName'))]);
      await until(() => f.exited.has(f.second));
      if (state === 'already-exited') {
        f.tm(['detach-client', '-t', String(Reflect.get(f.first, 'ptsName'))]);
        await until(() => f.exited.has(f.first));
      }
      const calls = vi.spyOn(cp, 'execFileSync');
      try {
        await capture.detach(state === 'already-exited' ? null : f.first, f.mux, f.record, () => {});
      } finally {
        const final = fs.lstatSync(f.socketPath, { bigint: true });
        console.info(
          '[owned-socket-transition]',
          JSON.stringify({
            dev: String(final.dev),
            ino: String(final.ino),
            uid: String(final.uid),
            unattached: String(f.unattachedSocket.mode & 0o777n),
            attached: String(attached.mode & 0o777n),
            final: String(final.mode & 0o777n),
            sameServerBirth: birth(f.server) === f.serverBirth,
          })
        );
      }
      expect(f.exited.has(f.first)).toBe(true);
      expect(birth(f.first.pid)).toBeUndefined();
      expect(f.census()).toEqual([]);
      const final = fs.lstatSync(f.socketPath, { bigint: true });
      expect(final.ino).toBe(attached.ino);
      expect(final.dev).toBe(attached.dev);
      expect(final.uid).toBe(attached.uid);
      expect(final.mode).toBe(f.unattachedSocket.mode);
      expect(birth(f.server)).toBe(f.serverBirth);
      expect(calls.mock.calls.filter(([, args]) => (args as string[]).includes('detach-client'))).toHaveLength(
        state === 'live' ? 1 : 0
      );
    }
  );
  it.each(['C', 'C.UTF-8'])('preserves exact portable tmux client readback under locale %s', async (locale) => {
    vi.stubEnv('LC_ALL', locale);
    const f = await fixture();
    await f.capture.detach(f.first, f.mux, f.record, () => {});
    expect(f.exited.has(f.first)).toBe(true);
    expect(f.census()).toEqual([f.second.pid]);
    expect(f.exited.has(f.second)).toBe(false);
    expect(birth(f.server)).toBe(f.serverBirth);
  });
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
    expect(mutations[0]).toEqual([
      '-N',
      '-f',
      '/dev/null',
      '-L',
      f.socket,
      'detach-client',
      '-t',
      Reflect.get(f.first, 'ptsName'),
    ]);
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
  it.each([
    'dev',
    'ino',
    'rdev',
    'uid',
    'gid',
    'type',
    'read',
    'write',
    'special',
    'partial-execute',
    'extra-execute',
  ] as const)('refuses changed socket %s without detaching either client', async (kind) => {
    const f = await fixture(),
      original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options: unknown) => {
      const actual = Reflect.apply(original, fs, [file, options]);
      if (file !== f.socketPath) return actual;
      const changed = Object.assign(Object.create(Object.getPrototypeOf(actual)), actual);
      if (kind === 'dev' || kind === 'ino' || kind === 'rdev' || kind === 'uid' || kind === 'gid') changed[kind] += 1n;
      else if (kind === 'type') changed.mode = (changed.mode & ~0o170000n) | 0o100000n;
      else {
        const bit = {
          read: 0o040n,
          write: 0o200n,
          special: 0o4000n,
          'partial-execute': 0o010n,
          'extra-execute': 0o001n,
        }[kind];
        changed.mode ^= bit;
      }
      return changed;
    }) as typeof fs.lstatSync);
    const calls = vi.spyOn(cp, 'execFileSync');
    await expect(f.capture.detach(f.first, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
    expect(calls.mock.calls.some(([, args]) => (args as string[]).includes('detach-client'))).toBe(false);
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
  it('rejects a partial socket execute signal at capture instead of normalizing arbitrary permissions', async () => {
    const f = await fixture(),
      original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options: unknown) => {
      const actual = Reflect.apply(original, fs, [file, options]);
      if (file !== f.socketPath) return actual;
      return Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, {
        mode: (actual.mode & ~0o111n) | 0o100n | 0o040n,
      });
    }) as typeof fs.lstatSync);
    const calls = vi.spyOn(cp, 'execFileSync');
    expect(() => DockerPlanLocalClient.capture(f.first, f.mux, f.record)).toThrow('unconfirmed');
    expect(calls.mock.calls.some(([, args]) => (args as string[]).includes('detach-client'))).toBe(false);
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
  it('keeps the captured TTY mode strict when the socket attachment signal is normalized', async () => {
    const f = await fixture(),
      original = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options: unknown) => {
      const actual = Reflect.apply(original, fs, [fd, options]);
      if (fs.readlinkSync('/proc/self/fd/' + fd) !== Reflect.get(f.first, 'ptsName')) return actual;
      return Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { mode: actual.mode ^ 0o100n });
    }) as typeof fs.fstatSync);
    const calls = vi.spyOn(cp, 'execFileSync');
    await expect(f.capture.detach(f.first, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
    expect(calls.mock.calls.some(([, args]) => (args as string[]).includes('detach-client'))).toBe(false);
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
  it.each(['server-extra', 'server-tab', 'client-extra'] as const)(
    'refuses malformed %s readback without detaching either client',
    async (kind) => {
      const f = await fixture(),
        original = cp.execFileSync;
      const calls = vi.spyOn(cp, 'execFileSync').mockImplementation(((
        file: string,
        args: readonly string[],
        options: unknown
      ) => {
        const out = Reflect.apply(original, cp, [file, args, options]);
        if (kind.startsWith('server') && args.includes('display-message'))
          return kind === 'server-tab' ? String(out).replace('|', '\t') : String(out).replace('|', '||');
        if (kind === 'client-extra' && args.some((arg) => arg.includes('#{client_tty}')))
          return String(out).replace('|', '||');
        return out;
      }) as typeof cp.execFileSync);
      if (kind.startsWith('server'))
        expect(() => DockerPlanLocalClient.capture(f.first, f.mux, f.record)).toThrow('unconfirmed');
      else await expect(f.capture.detach(f.first, f.mux, f.record, () => {})).rejects.toThrow('unconfirmed');
      expect(calls.mock.calls.some(([, args]) => (args as string[]).includes('detach-client'))).toBe(false);
      expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
    }
  );
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
            const fields = line.split('|');
            if (fields[0] === String(f.first.pid)) {
              fields[1] = String(Reflect.get(f.second, 'ptsName'));
              fields[2] = fields[1]!;
            }
            return fields.join('|');
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

describe.runIf(process.platform === 'linux')('no-autostart observations and self namespace', () => {
  it('refuses an absent server after currency without starting a replacement or reading personal config', async () => {
    const f = await fixture(),
      socketPath = f.tm(['display-message', '-p', '#{socket_path}']).trim(),
      original = cp.execFileSync,
      socketIdentity = fs.lstatSync(socketPath, { bigint: true });
    let closed = false;
    const calls = vi.spyOn(cp, 'execFileSync').mockImplementation(((
      file: string,
      args: readonly string[],
      options: unknown
    ) => {
      if (!closed && args.includes('display-message')) {
        closed = true;
        f.tm(['kill-server']);
      }
      return Reflect.apply(original, cp, [file, args, options]);
    }) as typeof cp.execFileSync);
    expect(() => DockerPlanLocalClient.capture(f.first, f.mux, f.record)).toThrow();
    expect(closed).toBe(true);
    const observation = calls.mock.calls.find(([, args]) => (args as string[]).includes('display-message'));
    expect(observation?.[1]?.slice(0, 5)).toEqual(['-N', '-f', '/dev/null', '-L', f.socket]);
    await until(() => f.exited.has(f.first) && f.exited.has(f.second));
    expect(birth(f.server)).toBeUndefined();
    // A dead tmux server can leave its old socket pathname. Its inode must not
    // be replaced by a newly started server, and a no-autostart probe must fail.
    if (fs.existsSync(socketPath)) {
      const remaining = fs.lstatSync(socketPath, { bigint: true });
      expect([remaining.dev, remaining.ino]).toEqual([socketIdentity.dev, socketIdentity.ino]);
    }
    const absent = cp.spawnSync('tmux', ['-N', '-f', '/dev/null', '-L', f.socket, 'display-message', '-p', '#{pid}'], {
      encoding: 'utf8',
      timeout: 1000,
      env: process.env,
    });
    expect(absent.status).not.toBe(0);
    expect(absent.stdout).toBe('');
    expect(
      calls.mock.calls.some(([, args]) =>
        (args as string[]).some((a) => ['new-session', 'start-server', 'detach-client'].includes(a))
      )
    ).toBe(false);
  });
  it('refuses a foreign proc self namespace before any tmux observation or detach', async () => {
    const f = await fixture(),
      original = fs.readFileSync,
      calls = vi.spyOn(cp, 'execFileSync');
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const out = Reflect.apply(original, fs, [p, ...args]);
      return p === '/proc/self/stat' && typeof out === 'string' ? out.replace(/^\d+/, String(process.pid + 1)) : out;
    }) as typeof fs.readFileSync);
    expect(() => DockerPlanLocalClient.capture(f.first, f.mux, f.record)).toThrow('unconfirmed');
    expect(calls).not.toHaveBeenCalled();
    expect(f.census().sort()).toEqual([f.first.pid, f.second.pid].sort());
  });
});
