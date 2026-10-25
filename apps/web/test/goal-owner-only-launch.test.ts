/** Owner-only ordinary launcher -> private bootstrap -> actual WebServer/canonical adapter/disk nonce.
 * Web listener, engine inspection, packaged executable metadata and missing trusted
 * original-program observer are explicitly synthetic edges. The
 * closed broker protocol, custody checks and restricted Broker.office refusal run in
 * an owned Python fixture. No host endpoint, provider, real key or live mount.
 */
import * as fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
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
import type { CompanyService } from '../src/company-service.js';

const edge = vi.hoisted(() => ({ executable: '', helper: '', projections: 0, key: '', keyReads: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readSync: ((fd: number, ...args: any[]) => {
      if (actual.realpathSync('/proc/self/fd/' + fd) === edge.key) edge.keyReads++;
      return (actual.readSync as any)(fd, ...args);
    }) as typeof actual.readSync,
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
const old = { data: process.env.REVERIE_DATA_DIR, socket: process.env.REVERIE_WORKER_SOCKET };

describe('owner-only private Goal launcher', () => {
  let root: string, data: string, configFile: string, keyFile: string, nonce: string, cookie: string;
  let server: WebServer, internal: Internal, app: FastifyInstance, company: CompanyService;
  let inventory: Array<Record<string, any>>;
  let host: ChildProcessWithoutNullStreams;
  const write = (file: string, value: unknown) => {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  const owner = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload, headers: { host: 'localhost', origin: 'http://localhost', cookie } });
  beforeAll(async () => {
    root = fs.mkdtempSync(join(tmpdir(), 'goal-owner-only-launch-'));
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
    edge.key = keyFile;
    edge.keyReads = 0;
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
    expect(internal.sessions.has(sid)).toBe(false); // no real worker observer or synthetic live worker
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
    if (root?.startsWith(join(tmpdir(), 'goal-owner-only-launch-'))) fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const command = (createId: string) => ({
    createId,
    employeeId: 'worker:1',
    sessionId: sid,
    sessionGeneration: 7,
    objective: 'PRIVATE_OWNER_OBJECTIVE',
    nextAction: 'PRIVATE_OWNER_ACTION',
  });
  const current = () => company.store.snapshot().goals[0]!;
  const change = (transitionId: string, to: string) => {
    const goal = current();
    return {
      transitionId,
      generation: goal.generation,
      expectedState: goal.state,
      expectedSequence: goal.transitionSequence,
      sessionId: goal.sessionId,
      sessionGeneration: goal.sessionGeneration,
      to,
      nextAction: 'PRIVATE_OWNER_NEXT',
    };
  };
  let nonceBefore: string;
  it('real cookie owner creates, reads, transitions and reads metadata through the actual singleton', async () => {
    nonceBefore = fs.readFileSync(nonce, 'utf8');
    const response = await owner('POST', '/api/goals', command('owner-create'));
    expect(response.statusCode, response.body).toBe(200);
    expect(current().employeeId).toBe('worker:1');
    expect((await owner('GET', '/api/goals')).body).toContain('PRIVATE_OWNER_OBJECTIVE');
    expect((await owner('GET', '/api/goals/' + current().id)).statusCode).toBe(200);
    for (const to of ['ASSIGNED', 'ACTIVE']) {
      const result = await owner('POST', '/api/goals/' + current().id + '/transitions', change('owner-' + to, to));
      expect(result.statusCode, result.body).toBe(200);
    }
    const metadata = await owner('GET', '/api/goal-metadata/worker:1');
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.body).not.toMatch(/PRIVATE_|objective|nextAction|configDigest/);
    expect(edge.projections).toBeGreaterThan(1);
    expect(edge.keyReads).toBe(0);
    expect(fs.readFileSync(nonce, 'utf8')).toBe(nonceBefore);
  }, 30000);
  it('owner-only grants and revocations are durable canonical operations without employee proof use', async () => {
    const grant = await owner('POST', '/api/goal-grants', {
      kind: 'METADATA_READ',
      employeeId: 'worker:1',
      targetEmployeeId: 'worker:1',
      expiresAt: Date.now() + 60000,
    });
    expect(grant.statusCode, grant.body).toBe(200);
    expect((await owner('POST', '/api/goal-grants/' + grant.json().data.id + '/revoke', {})).statusCode).toBe(200);
    expect(company.store.snapshot().goalGrants).toHaveLength(1);
    expect(company.store.snapshot().goalGrantRevocations).toHaveLength(1);
    expect(edge.keyReads).toBe(0);
    expect(fs.readFileSync(nonce, 'utf8')).toBe(nonceBefore);
  }, 30000);
  it('refuses stale CAS and altered create replay without a canonical write', async () => {
    const before = fs.readFileSync(company.store.file, 'utf8');
    const replay = await owner('POST', '/api/goals', command('owner-create'));
    expect(replay.statusCode, replay.body).toBe(200);
    const conflict = await owner('POST', '/api/goals', { ...command('owner-create'), objective: 'different' });
    expect(conflict.statusCode).toBe(409);
    const bad = await owner('POST', '/api/goals/' + current().id + '/transitions', {
      ...change('stale-cas', 'REVIEW'),
      expectedSequence: 0,
    });
    expect(bad.statusCode).toBe(409);
    expect(fs.readFileSync(company.store.file, 'utf8')).toBe(before);
  }, 30000);
  it('refuses absent, service, agent, Basic, invalid and even valid employee proofs without owner fallback', async () => {
    const fields = [
      1,
      'goal-request',
      'synthetic-broker',
      'synthetic-epoch',
      sid,
      7,
      'GET',
      '/api/goals',
      createHash('sha256').update('').digest('hex'),
      Date.now(),
      Date.now() + 9000,
      'a'.repeat(32),
    ];
    const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
    const proof =
      encoded +
      '.' +
      createHmac('sha256', Buffer.alloc(32, 83))
        .update('reverie-goal-request-v1\n' + encoded)
        .digest('hex');
    const before = fs.readFileSync(company.store.file, 'utf8');
    for (const credential of [undefined, cookie, 'reverie_owner=invalid']) {
      for (const extra of [
        { 'x-reverie-service-token': 'invalid' },
        { 'x-reverie-parent-session': sid },
        { authorization: 'Basic c3ludGhldGlj' },
        { 'x-reverie-goal-assertion': 'invalid' },
        { 'x-reverie-goal-assertion': proof },
        { 'x-reverie-goal-other': 'invalid' },
      ]) {
        const result = await app.inject({
          method: 'GET',
          url: '/api/goals',
          headers: { host: 'localhost', ...(credential ? { cookie: credential } : {}), ...extra },
        });
        expect(result.statusCode, JSON.stringify(extra) + result.body).toBe(403);
      }
    }
    expect((await app.inject({ method: 'GET', url: '/api/goals' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/goals',
          payload: command('cross-origin'),
          headers: { host: 'localhost', origin: 'https://untrusted.invalid', cookie },
        })
      ).statusCode
    ).toBe(403);
    expect(fs.readFileSync(company.store.file, 'utf8')).toBe(before);
    expect(edge.keyReads).toBe(0);
    expect(fs.readFileSync(nonce, 'utf8')).toBe(nonceBefore);
  }, 30000);
  it.each(['generation', 'owner-cookie'] as const)(
    'rechecks %s after actual fsync before the owner-only commit',
    async (mode) => {
      const before = current().transitionSequence;
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
              if (mode === 'generation') {
                const canonical = JSON.parse(fs.readFileSync(company.store.file, 'utf8'));
                canonical.employees[0].sessionGeneration = 8;
                write(company.store.file, canonical);
              } else {
                const auth = new OwnerAuthService({
                  store: new OwnerAuthStore(join(data, 'owner-auth.json')),
                  auditFile: join(data, 'owned-audit.jsonl'),
                });
                await auth.logoutEverywhere('127.0.0.1');
              }
            }
          };
        }
        return handle;
      }) as typeof open);
      try {
        const result = await owner(
          'POST',
          '/api/goals/' + current().id + '/transitions',
          change('fence-' + mode, 'REVIEW')
        );
        expect(revoked).toBe(true);
        expect(result.statusCode, result.body).toBe(403);
        expect(company.store.snapshot().goals[0]!.transitionSequence).toBe(before);
      } finally {
        hook.mockRestore();
      }
      await company.store.update((state) => {
        state.employees[0]!.sessionGeneration = 7;
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/owner/login',
        payload: credentials,
        headers: { host: 'localhost', origin: 'http://localhost' },
      });
      expect(login.statusCode, login.body).toBe(200);
      cookie = 'reverie_owner=' + login.cookies.find((item) => item.name === 'reverie_owner')!.value;
    },
    30000
  );
  it('retains custody revocation fences after temporary-file fsync', async () => {
    const before = current().transitionSequence;
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
            inventory[1]!.Mounts.push({ Type: 'bind', Source: data, Destination: '/stolen', RW: false });
            write(join(root, 'inventory.json'), inventory);
          }
        };
      }
      return handle;
    }) as typeof open);
    try {
      const response = await owner(
        'POST',
        '/api/goals/' + current().id + '/transitions',
        change('custody-fsync', 'REVIEW')
      );
      expect(revoked).toBe(true);
      expect(response.statusCode, response.body).toBe(403);
      expect(company.store.snapshot().goals[0]!.transitionSequence).toBe(before);
    } finally {
      hook.mockRestore();
      inventory[1]!.Mounts.pop();
      write(join(root, 'inventory.json'), inventory);
    }
  }, 30000);
  it('restarts on the same canonical data, with adapters OFF preserving every Goal and generation field', async () => {
    const before = company.store.snapshot();
    await server.stop();
    // A schema-capable OFF source is necessary; old live0b3 image is explicitly NOT a safe rollback.
    server = new WebServer(0, false, true, '127.0.0.1');
    internal = server as unknown as Internal;
    await (server as unknown as { setupRoutes(): Promise<void> }).setupRoutes();
    app = internal.app;
    await app.ready();
    company = internal.companyService;
    const login = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: credentials,
      headers: { host: 'localhost', origin: 'http://localhost' },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = 'reverie_owner=' + login.cookies.find((item) => item.name === 'reverie_owner')!.value;
    expect((await owner('GET', '/api/goals')).statusCode).toBe(403);
    await company.store.update((state) => {
      state.employees[0]!.name = 'Synthetic rollback compatibility';
    });
    const after = company.store.snapshot();
    for (const field of [
      'goals',
      'goalGrants',
      'goalGrantRevocations',
      'goalUnblockProofs',
      'goalProofRevocations',
    ] as const)
      expect(after[field]).toEqual(before[field]);
    expect(after.employees[0]!.sessionGeneration).toBe(7);
    expect(fs.readFileSync(nonce, 'utf8')).toBe(nonceBefore);
    await server.stop();
    server = await startConfiguredWebServer({
      port: 0,
      https: false,
      host: '127.0.0.1',
      goalPrivateConfig: configFile,
    });
    internal = server as unknown as Internal;
    app = internal.app;
    company = internal.companyService;
    const again = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: credentials,
      headers: { host: 'localhost', origin: 'http://localhost' },
    });
    expect(again.statusCode, again.body).toBe(200);
    cookie = 'reverie_owner=' + again.cookies.find((item) => item.name === 'reverie_owner')!.value;
    const read = await owner('GET', '/api/goals/' + current().id);
    expect(read.statusCode, read.body).toBe(200);
    expect(current()).toEqual(before.goals[0]);
    expect(edge.keyReads).toBe(0);
  }, 30000);
  it('real owner logout revokes the cookie; no fallback or employee signing appears', async () => {
    expect((await owner('GET', '/api/goals')).statusCode).toBe(200);
    expect((await owner('POST', '/api/owner/logout', {})).statusCode).toBe(200);
    expect((await owner('GET', '/api/goals')).statusCode).toBe(403);
    expect(edge.keyReads).toBe(0);
    expect(fs.readFileSync(nonce, 'utf8')).toBe(nonceBefore);
  }, 30000);
  it('owner-only loader keeps all nonce, lock and key metadata requirements and never issues a key', () => {
    const loaded = loadGoalPrivateBootstrap(configFile, company.store.file)!;
    expect(loaded.mode).toBe('owner-only');
    expect(loaded.issuer('synthetic-broker')).toBeUndefined();
    loaded.close?.();
    for (const file of [keyFile, nonce, nonce + '.lock']) {
      const fresh = loadGoalPrivateBootstrap(configFile, company.store.file)!;
      try {
        fs.chmodSync(file, 0o644);
        expect(() => fresh.custody.assertPrivateCustody(company.store.file)).toThrow();
        expect(edge.keyReads).toBe(0);
      } finally {
        fs.chmodSync(file, 0o600);
        fresh.close?.();
      }
    }
  }, 30000);
});
