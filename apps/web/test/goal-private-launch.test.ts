/** Ordinary launcher -> private bootstrap -> actual WebServer/canonical adapter/disk nonce.
 * Web listener, engine inspection, packaged executable metadata and missing trusted
 * original-program observer are explicitly synthetic edges. The
 * closed broker protocol, custody checks and restricted Broker.office refusal run in
 * an owned Python fixture. No host endpoint, provider, real key or live mount.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { goalFixtureRepository } from './goal-source-fixture.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { EmployeeSchema } from '../src/company-types.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import { startConfiguredWebServer } from '../src/goal-web-launch.js';
import { loadGoalPrivateBootstrap } from '../src/goal-private-bootstrap.js';
import { buildWebArgs } from '../src/daemon-control.js';
import type { CompanyService } from '../src/company-service.js';

const edge = vi.hoisted(() => ({ executable: '', helper: '', projections: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: ((file, options) => {
      const result = actual.statSync(file, options as any);
      // This rootless build environment owns its Nix store. The operator contract
      // under test pins a ROOT-owned immutable packaged helper; only that kernel
      // metadata edge is synthetic. All private-path stats and custody stay real.
      if (file === edge.executable) return Object.assign(result, { uid: typeof result.uid === 'bigint' ? 0n : 0 });
      return result;
    }) as typeof actual.statSync,
  };
});
vi.mock('../src/goal-custody-channel.js', async (original) => {
  const actual = await original<typeof import('../src/goal-custody-channel.js')>();
  return {
    GoalCustodyChannel: class extends actual.GoalCustodyChannel {
      // Only the packaged executable is substituted with an owned source wrapper.
      constructor(_packaged: string, socket: string) {
        super(edge.helper, socket);
      }
      project() {
        edge.projections++;
        return super.project();
      }
    },
  };
});
vi.mock('../src/web/server.js', async (original) => {
  const actual = await original<typeof import('../src/web/server.js')>();
  return {
    ...actual,
    startWebServer: async (...args: ConstructorParameters<typeof actual.WebServer>) => {
      const server = new actual.WebServer(...args);
      const internal = server as unknown as { setupRoutes(): Promise<void>; app: FastifyInstance };
      await internal.setupRoutes();
      await internal.app.ready();
      return server;
    },
  };
});

const nativeProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const repository = goalFixtureRepository(import.meta.dirname);
const sid = '11111111-2222-3333-4444-555555555555',
  storeId = '11111111-2222-4333-8444-555555555555';
const serverId = 'a'.repeat(64),
  laptopId = 'b'.repeat(64);
const credentials = { username: 'SYNTHETIC_BOOTSTRAP_OWNER', password: 'synthetic-Owner!31-bootstrap' };
type Internal = { app: FastifyInstance; companyService: CompanyService; sessions: Map<string, Session> };
type Forward = {
  method: 'GET' | 'POST';
  target: string;
  body: string;
  headers: Record<string, string>;
  refused?: number;
};
const old = { data: process.env.REVERIE_DATA_DIR, socket: process.env.REVERIE_WORKER_SOCKET };

describe('normal private Goal launcher', () => {
  let root: string, data: string, configFile: string, keyFile: string, nonce: string, cookie: string;
  let server: WebServer, internal: Internal, app: FastifyInstance, company: CompanyService;
  let inventory: Array<Record<string, any>>;
  let host: ChildProcessWithoutNullStreams;
  const write = (file: string, value: unknown) => {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  const bridge = (operation: string, extra = {}) => {
    const result = nativeProcess.spawnSync('python3', ['-m', 'tests.goal_private_fixture'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 32768,
      env: { PATH: process.env.PATH, PYTHONPATH: join(repository, 'python'), PYTHONDONTWRITEBYTECODE: '1' },
      input: JSON.stringify({ operation, root, peerPid: process.pid, ...extra }),
    });
    if (result.status !== 0) throw Error('Owned bridge refused: ' + result.stderr.slice(-2000));
    return result.stdout;
  };
  const forward = (method: 'GET' | 'POST', target: string, payload?: unknown): Forward =>
    JSON.parse(
      bridge('forward', { sessionId: sid, method, target, body: payload === undefined ? '' : JSON.stringify(payload) })
    );
  const owner = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload, headers: { host: 'localhost', origin: 'http://localhost', cookie } });
  beforeAll(async () => {
    root = fs.mkdtempSync(join(tmpdir(), 'goal-private-launch-'));
    fs.chmodSync(root, 0o700);
    data = join(root, 'private');
    fs.mkdirSync(data, { mode: 0o700 });
    fs.mkdirSync(join(data, 'console'), { mode: 0o700 });
    fs.writeFileSync(join(data, 'console', '.env'), 'REVERIE_PASSWORD=SYNTHETIC_UNUSED_SHARED_AUTH\n', { mode: 0o600 });
    const publicRoot = join(root, 'public');
    fs.mkdirSync(publicRoot, { mode: 0o700 });
    process.env.REVERIE_DATA_DIR = data;
    fs.mkdirSync(join(root, 'control'), { mode: 0o700 });
    process.env.REVERIE_WORKER_SOCKET = join(root, 'control', 'broker.sock');
    const store = new CompanyStore(join(data, 'company.json'));
    await store.init();
    await store.update((state) => {
      state.employees.push(
        EmployeeSchema.parse({
          id: 'worker:1',
          sessionId: sid,
          sessionGeneration: 7,
          name: 'Owned worker',
          icon: 'G',
          position: 'CTO',
          expertise: ['synthetic'],
          createdAt: 1,
        })
      );
    });
    const nonceRoot = join(data, 'nonce');
    fs.mkdirSync(nonceRoot, { mode: 0o700 });
    nonce = join(nonceRoot, 'ledger.json');
    write(nonce, { version: 1, storeId, capacity: 128, revision: 0, clockFloor: 0, entries: [] });
    fs.writeFileSync(nonce + '.lock', '', { mode: 0o600 });
    const authority = join(data, 'authority');
    fs.mkdirSync(authority, { mode: 0o700 });
    keyFile = join(data, 'key');
    fs.writeFileSync(keyFile, Buffer.alloc(32, 83), { mode: 0o600 });
    configFile = join(data, 'goals.json');
    const flock = fs.realpathSync(
      (process.env.PATH ?? '')
        .split(':')
        .map((p) => join(p, 'flock'))
        .find(fs.existsSync)!
    );
    write(configFile, {
      version: 1,
      mode: 'owner-only',
      issuer: 'synthetic-broker',
      epoch: 'synthetic-epoch',
      serverContainerId: serverId,
      paths: Object.fromEntries(
        Object.entries({ config: configFile, key: keyFile, canonical: store.file, nonce, authority }).map(
          ([name, value]) => [name, { host: value, server: value }]
        )
      ),
      nonce: { storeId, capacity: 128, flockExecutable: flock },
      server: { brokerSocket: process.env.REVERIE_WORKER_SOCKET, custodyClient: process.execPath },
    });
    const runtime = join(root, 'workers', sid);
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.mkdirSync(join(runtime, 'home'), { mode: 0o700 });
    write(join(runtime, 'runtime.json'), {
      exit: 'synthetic.exit',
      goalBinding: { version: 1, containerId: laptopId, employeeId: 'worker:1', sessionId: sid, sessionGeneration: 7 },
    });
    const uid = process.getuid!(),
      gid = process.getgid!();
    write(join(root, 'worker.json'), {
      goalPrivateConfig: configFile,
      companyFile: store.file,
      stateRoot: join(root, 'workers'),
      socket: process.env.REVERIE_WORKER_SOCKET,
      mounts: [{ source: publicRoot, destination: '/workspace', readOnly: false }],
      uid,
      gid,
      maxWorkers: 4,
      deployment: 'synthetic',
      serverContainer: 'synthetic-console',
      apiSocketRoot: join(root, 'office'),
      companyRoot: data,
    });
    inventory = [
      {
        Id: serverId,
        Name: '/synthetic-console',
        State: { Running: true, Pid: process.pid },
        Config: { User: `${uid}:${gid}` },
        HostConfig: { Runtime: 'runc', Privileged: false },
        Mounts: [{ Type: 'bind', Source: root, Destination: root, RW: true }],
      },
      {
        Id: laptopId,
        State: { Running: true, Pid: 99999 },
        Config: { Labels: { 'reverie.worker': 'synthetic', 'reverie.session': sid } },
        HostConfig: { Runtime: 'runc', Privileged: false },
        Mounts: [{ Type: 'bind', Source: publicRoot, Destination: '/workspace', RW: true }],
      },
    ];
    write(join(root, 'inventory.json'), inventory);
    const python = nativeProcess.spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    });
    expect(python.status).toBe(0);
    edge.helper = join(root, 'owned-packaged-helper');
    fs.writeFileSync(
      edge.helper,
      `#!${python.stdout.trim()}
import runpy, sys
sys.path.insert(0, ${JSON.stringify(join(repository, 'python'))})
sys.argv = ['reverie.worker', 'client', *sys.argv[1:]]
runpy.run_module('reverie.worker', run_name='__main__')
`,
      { mode: 0o700 }
    );
    host = nativeProcess.spawn('python3', ['-m', 'tests.goal_private_fixture', '--owned-socket', root], {
      cwd: repository,
      env: { PATH: process.env.PATH, PYTHONPATH: join(repository, 'python'), PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((done, reject) => {
      const deadline = setTimeout(() => reject(Error('Owned broker readiness bound')), 3000);
      host.once('error', reject);
      host.stdout.once('data', (bytes) => {
        clearTimeout(deadline);
        if (bytes.toString().trim() === 'READY') done();
        else reject(Error('Owned broker refused'));
      });
    });
    edge.executable = fs.realpathSync(process.execPath);
    const owners = new OwnerAuthService({
      store: new OwnerAuthStore(join(data, 'owner-auth.json')),
      auditFile: join(data, 'owned-audit.jsonl'),
      setupEnabled: true,
    });
    await owners.setup(credentials.username, credentials.password, credentials.password, '127.0.0.1');
    server = await startConfiguredWebServer({
      port: 0,
      https: false,
      host: '127.0.0.1',
      goalPrivateConfig: configFile,
    });
    internal = server as unknown as Internal;
    app = internal.app;
    company = internal.companyService;
    internal.sessions.set(sid, new Session({ id: sid, workingDir: root, mode: 'shell', useMux: false }));
    const login = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: credentials,
      headers: { host: 'localhost', origin: 'http://localhost' },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = 'reverie_owner=' + login.cookies.find((item) => item.name === 'reverie_owner')!.value;
  }, 30000);
  afterAll(async () => {
    internal?.sessions.delete(sid);
    await server?.stop();
    host?.stdin.end();
    if (host && host.exitCode === null && host.signalCode === null)
      await new Promise<void>((done) => {
        host.once('exit', () => done());
        host.kill();
      });
    for (const [key, value] of [
      ['REVERIE_DATA_DIR', old.data],
      ['REVERIE_WORKER_SOCKET', old.socket],
    ])
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    if (root?.startsWith(join(tmpdir(), 'goal-private-launch-'))) fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('forwards explicit private config through daemon/service argv, with no default discovery', () => {
    expect(buildWebArgs({ host: '127.0.0.1', port: 3000, https: false, goalPrivateConfig: configFile })).toEqual([
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '3000',
      '--goal-private-config',
      configFile,
    ]);
    expect(loadGoalPrivateBootstrap(undefined, join(data, 'company.json'))).toBeUndefined();
    expect(() => loadGoalPrivateBootstrap(join(data, 'missing.json'), join(data, 'company.json'))).toThrow(
      /unavailable/
    );
    expect(app.server.listening).toBe(false);
  });
  it('restricted Broker.office refuses employee Goal transport while genuine owner reaches the durable core', async () => {
    const payload = {
      createId: 'ordinary-create',
      employeeId: 'worker:1',
      sessionId: sid,
      sessionGeneration: 7,
      objective: 'PRIVATE_ORDINARY_OBJECTIVE',
      nextAction: 'PRIVATE_ORDINARY_ACTION',
    };
    const nonceBefore = fs.readFileSync(nonce, 'utf8');
    expect(forward('POST', '/api/goals', payload).refused).toBe(403);
    const beforeCreate = edge.projections;
    const created = await owner('POST', '/api/goals', payload);
    expect(created.statusCode, created.body).toBe(200);
    expect(edge.projections).toBeGreaterThan(beforeCreate);
    const replay = await owner('POST', '/api/goals', payload);
    expect(replay.statusCode, replay.body).toBe(200); // canonical idempotency, not an employee nonce claim
    expect(fs.readFileSync(nonce, 'utf8')).toBe(nonceBefore);
    const list = await owner('GET', '/api/goals');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).toContain('PRIVATE_ORDINARY_OBJECTIVE');
    expect(forward('GET', '/api/goals').refused).toBe(403);
    const metadata = await owner('GET', '/api/goal-metadata/worker:1');
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.body).not.toMatch(/PRIVATE_|objective|nextAction|key|configDigest/);
    const id = company.store.snapshot().goals[0]!.id;
    const full = await owner('GET', '/api/goals/' + id);
    expect(full.statusCode, full.body).toBe(200);
    expect(full.body).toContain('PRIVATE_ORDINARY_OBJECTIVE');
    for (const headers of [
      { authorization: 'Basic c3ludGhldGlj' },
      { 'x-reverie-parent-session': sid },
      { 'x-reverie-service-token': 'synthetic' },
    ])
      expect((await app.inject({ method: 'GET', url: '/api/goals', headers })).statusCode).toBe(403);
  }, 60000);
  it('current generation still fences owner actions and restricted office recovery never adopts a signer', async () => {
    const runtime = join(root, 'workers', sid, 'runtime.json');
    const runtimeBefore = fs.readFileSync(runtime, 'utf8');
    await company.store.update((state) => {
      state.employees[0]!.sessionGeneration = 8;
    });
    expect(
      (
        await owner('POST', '/api/goals', {
          createId: 'stale-owner',
          employeeId: 'worker:1',
          sessionId: sid,
          sessionGeneration: 7,
          objective: 'PRIVATE_STALE_OBJECTIVE',
          nextAction: 'PRIVATE_STALE_ACTION',
        })
      ).statusCode
    ).toBe(403);
    expect(forward('GET', '/api/goals').refused).toBe(403);
    await company.store.update((state) => {
      state.employees[0]!.sessionGeneration = 7;
      state.employees[0]!.owner = 'other-owner';
    });
    expect(forward('GET', '/api/goals').refused).toBe(403);
    expect(fs.readFileSync(runtime, 'utf8')).toBe(runtimeBefore);
    await company.store.update((state) => {
      delete state.employees[0]!.owner;
    });
  }, 30000);
  const readOnlyExposure = async () => {
    expect(forward('GET', '/api/goals').refused).toBe(403);
    expect((await owner('GET', '/api/goals')).statusCode).toBe(200);
    inventory[1]!.Mounts.push({ Type: 'bind', Source: data, Destination: '/stolen', RW: false });
    write(join(root, 'inventory.json'), inventory);
    expect(forward('GET', '/api/goals').refused).toBe(403);
    const realOwner = await owner('GET', '/api/goals');
    expect(realOwner.statusCode).toBe(403);
    expect(realOwner.body).not.toMatch(/PRIVATE_|synthetic-epoch|configDigest/);
    inventory[1]!.Mounts.pop();
    write(join(root, 'inventory.json'), inventory);
  };
  it('canonical generation revoked after actual temporary-file sync refuses commit and leaves no new Goal receipt', async () => {
    const before = company.store.snapshot().goals.length;
    const payload = {
      createId: 'after-sync-create',
      employeeId: 'worker:1',
      sessionId: sid,
      sessionGeneration: 7,
      objective: 'PRIVATE_AFTER_SYNC_OBJECTIVE',
      nextAction: 'PRIVATE_AFTER_SYNC_ACTION',
    };
    const open = fs.promises.open.bind(fs.promises);
    let revoked = false;
    const hook = vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (typeof args[0] === 'string' && args[0].startsWith(company.store.file + '.') && args[0].endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          if (!revoked) {
            revoked = true;
            const canonical = JSON.parse(fs.readFileSync(company.store.file, 'utf8'));
            canonical.employees[0].sessionGeneration = 8;
            write(company.store.file, canonical); // external canonical revocation in this OWNED fixture only
          }
        };
      }
      return handle;
    }) as typeof open);
    try {
      const response = await owner('POST', '/api/goals', payload);
      expect(revoked).toBe(true);
      expect(response.statusCode, response.body).toBe(403);
      expect(company.store.snapshot().goals.length).toBe(before);
      expect(response.body).not.toMatch(/PRIVATE_|configDigest/);
    } finally {
      hook.mockRestore();
    }
    await company.store.update((state) => {
      state.employees[0]!.sessionGeneration = 7;
    });
  }, 30000);
  // A failed trusted helper closes the transport; recovery requires explicit restart.
  it(
    'read-only exposure keeps employee denied and revokes genuine owner custody without private disclosure',
    readOnlyExposure,
    30000
  );
  it('inode/key mode/alias and helper failure never become a successful issuer or custody assertion', () => {
    const loaded = loadGoalPrivateBootstrap(configFile, join(data, 'company.json'))!;
    fs.chmodSync(keyFile, 0o644);
    expect(loaded.issuer('synthetic-broker')).toBeUndefined();
    expect(() => loaded.custody.assertPrivateCustody(join(data, 'company.json'))).toThrow();
    loaded.close?.();
    fs.chmodSync(keyFile, 0o600);
    // Recreate loader after explicit fixture repair, as an operator restart must do.
    const fresh = loadGoalPrivateBootstrap(configFile, join(data, 'company.json'))!;
    fs.renameSync(keyFile, keyFile + '.saved');
    fs.symlinkSync(keyFile + '.saved', keyFile);
    expect(() => fresh.custody.assertPrivateCustody(join(data, 'company.json'))).toThrow();
    fresh.close?.();
    fs.unlinkSync(keyFile);
    fs.renameSync(keyFile + '.saved', keyFile);
    const last = loadGoalPrivateBootstrap(configFile, join(data, 'company.json'))!;
    host.kill();
    expect(last.issuer('synthetic-broker')).toBeUndefined();
    expect(() => last.custody.assertPrivateCustody(join(data, 'company.json'))).toThrow();
    last.close?.();
  }, 30000);
});
