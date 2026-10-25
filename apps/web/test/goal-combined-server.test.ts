/** Supported CLI -> explicit SYNTHETIC proof component -> HMAC -> durable owned ledger -> WebServer singleton.
 * REAL canonical binding/action assembly and disk nonce; owned synthetic trust/custody and unstarted Session objects.
 * Current restricted Broker.office never signs; this is verifier-component coverage.
 * No listener, actual worker launch, real credential or production bootstrap. */
import * as nativeFs from 'node:fs';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { goalFixtureRepository } from './goal-source-fixture.js';
import { Command } from 'commander';
import type { FastifyInstance } from 'fastify';
import rawInject from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import type { CompanyService } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { issueServiceToken, setPolicy } from '../src/owner-auth/admin.js';
import { GoalCanonicalAuthority } from '../src/goal-canonical-authority.js';
import { Session } from '../src/session.js';
import { GoalNonceStore, type GoalNonceStoreOptions } from '../src/goal-nonce-store.js';
import type { GoalServerProvisioning } from '../src/goal-server-assembly.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';
import { registerGoalCommands } from '../src/cli-goal.js';
import { goalClientTarget } from '../src/goal-client-target.js';

const repository = goalFixtureRepository(import.meta.dirname);
const worker = 'w:._-'.padEnd(100, 'w'),
  verifier = 'v:._-'.padEnd(100, 'v'),
  longGoal = 'g:._-'.padEnd(100, 'g'),
  longGrant = 'm:._-'.padEnd(100, 'm');
const workerSession = '11111111-2222-3333-4444-555555555555';
const verifierSession = '66666666-7777-4888-8999-000000000000';
const storeId = '11111111-2222-4333-8444-555555555555';
const key = Buffer.from('not-a-deployment-key-synthetic-01!');
const credentials = { username: 'SYNTHETIC_COMBINED_OWNER', password: 'synthetic-Owner!81-combined' };
type Internal = {
  app: FastifyInstance;
  companyService: CompanyService;
  sessions: Map<string, Session>;
  chatroomService: { retired: { sessionId: string }[] };
  setupRoutes(): Promise<void>;
};
type Forwarded = {
  method: 'GET' | 'POST';
  target: string;
  body: string;
  headers: Record<string, string>;
  refused?: number;
};

describe('combined actual Goal server with synthetic proof transport, durable ledger and supported CLI', () => {
  let root: string,
    ledgerFile: string,
    cookie: string,
    server: WebServer,
    app: FastifyInstance,
    company: CompanyService;
  let nonceOptions: GoalNonceStoreOptions, ownerService: OwnerAuthService, actual: Internal;
  let nonceSequence = 0,
    commandSequence = 0,
    custody = true,
    issuerCurrent = true;
  const oldData = process.env.REVERIE_DATA_DIR;
  const bindingCalls = vi.spyOn(GoalCanonicalAuthority.prototype, 'binding');
  const actionCalls = vi.spyOn(GoalCanonicalAuthority.prototype, 'assertAction');
  const owner = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload, headers: { host: 'localhost', origin: 'http://localhost', cookie } });
  function forward(sessionId: string, options: RequestOptions, headers: Record<string, string> = {}): Forwarded {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) query.set(name, String(value));
    const result = spawnSync('python3', ['-m', 'tests.goal_broker_fixture', '--component-proof'], {
      cwd: repository,
      env: { PATH: process.env.PATH, PYTHONPATH: join(repository, 'python'), PYTHONDONTWRITEBYTECODE: '1' },
      input: JSON.stringify({
        sessionId,
        generation: 1,
        now: 100_000,
        nonce: (++nonceSequence).toString(16).padStart(32, '0'),
        method: options.method,
        target: goalClientTarget(options) ?? options.path + (query.size ? '?' + query : ''),
        body: options.body === undefined ? '' : JSON.stringify(options.body),
        headers,
      }),
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 128 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Forwarded;
  }
  const inject = (proof: Forwarded, extra: Record<string, string> = {}, body = proof.body) => {
    expect(proof.refused).toBeUndefined();
    // light-my-request otherwise WHATWG-normalizes dot-only IDs before Fastify sees them.
    // Restore the exact broker-signed incoming target at the network edge, as Node HTTP does;
    // actual Fastify routing, request provenance, HMAC, custody and action gates remain unchanged.
    return rawInject(
      (request, response) => {
        request.url = proof.target;
        app.routing(request, response);
      },
      {
        method: proof.method,
        url: proof.target,
        headers: { ...proof.headers, ...extra },
        ...(body ? { payload: body } : {}),
      }
    );
  };
  async function cli(sessionId: string, args: string[], input?: Record<string, unknown>) {
    const out: string[] = [],
      errors: string[] = [];
    let code = -1,
      calls = 0;
    const deps: AgentDeps = {
      ctx: { apiUrl: 'http://synthetic-office.invalid', selfId: sessionId },
      json: true,
      request: async (_context, options) => {
        calls++;
        // The supported client adds no Goal credential. The explicit synthetic proof fixture supplies purpose proof.
        expect(options.headers).toBeUndefined();
        const response = await inject(forward(sessionId, options));
        return { status: response.statusCode, text: response.body, json: response.json() };
      },
      io: { out: (line) => out.push(line), err: (line) => errors.push(line) },
    };
    const command = new Command('agent');
    registerGoalCommands(command, async (json, verb) => {
      code = await verb({ ...deps, json });
    });
    if (input) {
      const file = join(root, 'command-' + ++commandSequence + '.json');
      await fs.writeFile(file, JSON.stringify(input), { mode: 0o600 });
      args = [...args, '--input', file];
    }
    await command.parseAsync(['goal', ...args, '--json'], { from: 'user' });
    return { code, calls, out: out.join('\n'), errors, data: JSON.parse(out[0]) as Record<string, unknown> };
  }
  const create = (createId: string) => ({
    createId,
    employeeId: worker,
    sessionId: workerSession,
    sessionGeneration: 1,
    objective: 'PRIVATE_COMBINED_OBJECTIVE',
    nextAction: 'PRIVATE_COMBINED_CREATION',
  });
  const current = () => company.store.snapshot().goals.find((goal) => goal.id === longGoal)!;
  const transition = (to: string, transitionId: string, grant?: string) => {
    const goal = current();
    return {
      transitionId,
      generation: goal.generation,
      expectedState: goal.state,
      expectedSequence: goal.transitionSequence,
      sessionId: goal.sessionId,
      sessionGeneration: goal.sessionGeneration,
      to,
      nextAction: 'PRIVATE_COMBINED_HISTORY',
      ...(grant ? { verifierGrantId: grant } : {}),
    };
  };
  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'goal-combined-fixture-'));
    await fs.chmod(root, 0o700);
    process.env.REVERIE_DATA_DIR = root;
    const nonceRoot = join(root, 'nonce-authority');
    await fs.mkdir(nonceRoot, { mode: 0o700 });
    ledgerFile = join(nonceRoot, 'synthetic-nonces.json');
    await fs.writeFile(
      ledgerFile,
      JSON.stringify({ version: 1, storeId, capacity: 128, revision: 0, clockFloor: 100_000, entries: [] }),
      { mode: 0o600 }
    );
    await fs.writeFile(ledgerFile + '.lock', '', { mode: 0o600 });
    const flock = nativeFs.realpathSync(
      (process.env.PATH ?? '')
        .split(':')
        .map((path) => join(path, 'flock'))
        .find((path) => nativeFs.existsSync(path))!
    );
    nonceOptions = {
      file: ledgerFile,
      storeId,
      capacity: 128,
      flockExecutable: flock,
      authorityNamespace: join(nonceRoot, 'authority'),
      now: () => 100_000,
      assertPrivateCustody: (scope) => {
        expect(scope).toEqual({
          root: nonceRoot,
          parent: dirname(nonceRoot),
          file: ledgerFile,
          lock: ledgerFile + '.lock',
          temporary: ledgerFile + '.pending',
          authorityNamespace: join(nonceRoot, 'authority'),
        });
        if (!custody) throw Error('synthetic whole-scope custody revoked');
      },
    };
    const provisioning: GoalServerProvisioning = {
      kind: 'canonical-goal-provisioning',
      mode: 'owner-and-employee',
      issuer: (id) => (id === 'test-broker' && issuerCurrent ? { epoch: 'test-epoch', key } : undefined),
      now: () => 100_000,
      nonce: nonceOptions,
      custody: {
        assertPrivateCustody: (file) => {
          if (!custody || file !== join(root, 'company.json')) throw Error('synthetic canonical custody revoked');
        },
      },
    };
    ownerService = new OwnerAuthService({
      store: new OwnerAuthStore(join(root, 'owner-auth.json')),
      auditFile: join(root, 'synthetic-owner-audit.jsonl'),
      setupEnabled: true,
    });
    await ownerService.setup(credentials.username, credentials.password, credentials.password, '127.0.0.1');
    server = new WebServer(0, false, true, '127.0.0.1', undefined, false, '', provisioning);
    actual = server as unknown as Internal;
    await actual.setupRoutes();
    await actual.app.ready();
    app = actual.app;
    company = actual.companyService;
    // Real Session objects in the actual registry, never start()/PTY/process/tool calls or fake binding/action callbacks.
    actual.sessions.set(
      workerSession,
      new Session({ id: workerSession, workingDir: root, mode: 'shell', useMux: false })
    );
    actual.sessions.set(
      verifierSession,
      new Session({ id: verifierSession, workingDir: root, mode: 'shell', useMux: false })
    );
    expect(company.store.file).toBe(join(root, 'company.json'));
    const login = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: credentials,
      headers: { host: 'localhost', origin: 'http://localhost' },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = 'reverie_owner=' + login.cookies.find((item) => item.name === 'reverie_owner')!.value;
    await company.store.update((state) => {
      for (const [id, sessionId] of [
        [worker, workerSession],
        [verifier, verifierSession],
      ])
        state.employees.push(
          EmployeeSchema.parse({
            id,
            sessionId,
            name: id,
            icon: 'G',
            position: 'CTO',
            expertise: ['synthetic'],
            createdAt: 1,
          })
        );
    });
  }, 30000);
  afterAll(async () => {
    // Remove only these unstarted fixture objects before normal server persistence/teardown.
    actual?.sessions.delete(workerSession);
    actual?.sessions.delete(verifierSession);
    await server?.stop();
    vi.restoreAllMocks();
    if (oldData === undefined) delete process.env.REVERIE_DATA_DIR;
    else process.env.REVERIE_DATA_DIR = oldData;
    if (root?.startsWith(join(tmpdir(), 'goal-combined-fixture-'))) await fs.rm(root, { recursive: true, force: true });
  });

  it('uses one actual facade and registered supported CLI through synthetic proof component/real HMAC/durable ledger', async () => {
    expect(app.server.listening).toBe(false);
    const spy = vi.spyOn(company.goals, 'create');
    const result = await cli(workerSession, ['create'], create('combined-create'));
    expect(result.code, result.out).toBe(0);
    expect(result.calls).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(bindingCalls).toHaveBeenCalled();
    expect(actionCalls).toHaveBeenCalled();
    spy.mockRestore();
    expect(result.out).not.toMatch(/PRIVATE_|objective|nextAction|requestDigest|creation/);
    // Only synthetic canonical seed changes the generated ID to exercise the full supported100-character contract.
    await company.store.update((state) => {
      state.goals[0].id = longGoal;
    });
    const read = await cli(workerSession, ['read', longGoal]);
    expect(read.code, read.out).toBe(0);
    expect(read.out).not.toContain('PRIVATE_');
    const full = await cli(workerSession, ['read', longGoal, '--full']);
    expect(full.code, full.out).toBe(0);
    expect(full.out).toContain('PRIVATE_COMBINED_OBJECTIVE');
    for (const id of ['.', '..']) {
      await company.store.update((state) => {
        state.goals[0].id = id;
      });
      expect((await cli(workerSession, ['read', id])).code).toBe(0);
    }
    await company.store.update((state) => {
      state.goals[0].id = longGoal;
    });
    expect((await cli(workerSession, ['list'])).code).toBe(0);
    const persisted = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    expect(persisted.entries.length).toBeGreaterThanOrEqual(4);
    expect(persisted.revision).toBe(persisted.entries.length);
    expect(persisted.entries.every((entry: { key: string }) => /^[a-f0-9]{64}$/.test(entry.key))).toBe(true);
  }, 30000);
  it('retains closed verifier results/replay, metadata grants and worker REVIEW freeze across every real layer', async () => {
    for (const to of ['ASSIGNED', 'ACTIVE', 'REVIEW'])
      expect((await cli(workerSession, ['transition', longGoal], transition(to, 'cli-' + to))).code).toBe(0);
    expect((await cli(workerSession, ['transition', longGoal], transition('DONE', 'worker-self'))).code).toBe(4);
    const grant = await owner('POST', '/api/goal-grants', {
      kind: 'VERIFY',
      employeeId: verifier,
      targetEmployeeId: worker,
      goalId: longGoal,
      generation: current().generation,
      expectedSequence: current().transitionSequence,
      expiresAt: Date.now() + 60000,
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const command = transition('DONE', 'verified-done', grant.json().data.id);
    const done = await cli(verifierSession, ['transition', longGoal], command);
    expect(done.code, done.out).toBe(0);
    expect(done.data.visibility).toBe('verification');
    expect(done.out).not.toMatch(/PRIVATE_|objective|nextAction|evidence|requestDigest|creation|"after"/);
    const replay = await cli(verifierSession, ['transition', longGoal], command);
    expect(replay.code, replay.out).toBe(0);
    expect(replay.data).toEqual(done.data);
    expect((await cli(verifierSession, ['read', longGoal, '--full'])).code).toBe(4);
    const metadata = await owner('POST', '/api/goal-grants', {
      kind: 'METADATA_READ',
      employeeId: verifier,
      targetEmployeeId: worker,
      expiresAt: Date.now() + 60000,
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    await company.store.update((state) => {
      state.goalGrants.find((item) => item.id === metadata.json().data.id)!.id = longGrant;
    });
    const projection = await cli(verifierSession, ['metadata', worker, '--grant', longGrant]);
    expect(projection.code, projection.out).toBe(0);
    expect(projection.out).toContain(longGoal);
    expect(projection.out).not.toMatch(/PRIVATE_|objective|nextAction|creation/);
    expect((await cli(verifierSession, ['metadata', worker])).code).toBe(4);
    const deniedGrant = await inject(
      forward(workerSession, {
        method: 'POST',
        path: '/api/goal-grants',
        body: {
          kind: 'VERIFY',
          employeeId: worker,
          targetEmployeeId: worker,
          goalId: longGoal,
          generation: 1,
          expectedSequence: current().transitionSequence,
          expiresAt: Date.now() + 60000,
        },
      })
    );
    expect(deniedGrant.statusCode).toBe(403);
    expect((await owner('POST', '/api/goal-grants/' + longGrant + '/revoke', {})).statusCode).toBe(200);
    expect((await cli(verifierSession, ['metadata', worker, '--grant', longGrant])).code).toBe(4);
  }, 30000);
  it('actual owner health route uses the same store without active binding, content clone or nonce effects', async () => {
    const canonical = await fs.readFile(company.store.file, 'utf8');
    const nonces = await fs.readFile(ledgerFile, 'utf8');
    const calls = bindingCalls.mock.calls.length;
    const actions = actionCalls.mock.calls.length;
    const snapshot = vi.spyOn(company.store, 'snapshot').mockImplementation(() => {
      throw Error('FULL_PRIVATE_SNAPSHOT');
    });
    const raw = (company.store as unknown as { state: { memories: unknown; employees: object[]; goals: object[] } })
      .state;
    const poisoned: [object, string, PropertyDescriptor | undefined][] = [];
    for (const [object, key] of [
      [raw, 'memories'],
      [raw.employees[0]!, 'name'],
      [raw.goals[0]!, 'objective'],
      [raw.goals[0]!, 'nextAction'],
    ] as [object, string][]) {
      poisoned.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
      Object.defineProperty(object, key, {
        configurable: true,
        get() {
          throw Error('PRIVATE_CONTENT');
        },
      });
    }
    try {
      const result = await owner('GET', `/api/session-health/${workerSession}/metadata`);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().data).toMatchObject({
        employeeId: worker,
        sessionGeneration: 1,
        process: 'UNKNOWN',
        classification: 'AMBIGUOUS',
        automaticAction: 'NONE',
      });
      expect(result.body).not.toMatch(/PRIVATE_|objective|nextAction|memories|owner/);
      expect(snapshot).not.toHaveBeenCalled();
      expect(bindingCalls.mock.calls.length).toBe(calls);
      expect(actionCalls.mock.calls.length).toBe(actions);
      expect(await fs.readFile(company.store.file, 'utf8')).toBe(canonical);
      expect(await fs.readFile(ledgerFile, 'utf8')).toBe(nonces);
    } finally {
      snapshot.mockRestore();
      for (const [object, key, descriptor] of poisoned) {
        if (descriptor) Object.defineProperty(object, key, descriptor);
        else Reflect.deleteProperty(object, key);
      }
    }
  });
  it('actual health route denies worker/service/mixed proof, foreign registry and revoked custody', async () => {
    const url = `/api/session-health/${verifierSession}/metadata`;
    const workerRead = await app.inject({ method: 'GET', url, headers: { 'x-reverie-parent-session': workerSession } });
    expect(workerRead.statusCode, workerRead.body).toBe(403);
    const unknownService = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-reverie-service-token': 'synthetic-not-owner' },
    });
    expect(unknownService.statusCode, unknownService.body).toBe(401);
    // Only this owned synthetic owner store: exercise a genuinely recognized service in all policies.
    const ownerStore = new OwnerAuthStore(join(root, 'owner-auth.json'));
    const policy = ownerStore.read()!.policy;
    const serviceToken = await issueServiceToken(ownerStore, 'synthetic-health-test');
    try {
      for (const next of ['off', 'log', 'enforce'] as const) {
        await setPolicy(ownerStore, next, { forceLockoutRisk: true });
        for (const headers of [
          { 'x-reverie-parent-session': workerSession },
          { 'x-reverie-service-token': serviceToken },
        ]) {
          const denied = await app.inject({ method: 'GET', url, headers });
          expect(denied.statusCode, next + ': ' + denied.body).toBe(403);
        }
      }
    } finally {
      await setPolicy(ownerStore, policy, { forceLockoutRisk: true });
    }
    const proof = forward(workerSession, { method: 'GET', path: '/api/goals' });
    expect((await app.inject({ method: 'GET', url, headers: { ...proof.headers, cookie } })).statusCode).toBe(403);
    const session = actual.sessions.get(verifierSession)!;
    const previous = session.owner;
    session.owner = 'foreign';
    try {
      expect((await owner('GET', url)).statusCode).toBe(403);
    } finally {
      session.owner = previous;
    }
    // Seed the actual retirement service's owned fixture state; no plan-switch/session action.
    actual.chatroomService.retired.push({ sessionId: verifierSession });
    try {
      expect((await owner('GET', url)).statusCode).toBe(503);
    } finally {
      actual.chatroomService.retired.pop();
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    custody = false;
    try {
      expect((await owner('GET', url)).statusCode).toBe(503);
    } finally {
      custody = true;
    }
  });
  it('rejects assertion tamper/replay/restart and mixed credentials; worker headers cannot choose a broker identity', async () => {
    const proof = forward(workerSession, { method: 'GET', path: '/api/goals' });
    expect((await inject(proof)).statusCode).toBe(200);
    expect((await inject(proof)).statusCode).toBe(403);
    const assertion = Object.entries(proof.headers).find(
      ([name]) => name.toLowerCase() === 'x-reverie-goal-assertion'
    )![1];
    const fields = JSON.parse(Buffer.from(assertion.split('.')[0]!, 'base64url').toString('utf8'));
    expect(
      await new GoalNonceStore(nonceOptions).claim({
        issuer: fields[2],
        epoch: fields[3],
        nonce: fields[11],
        expiresAt: fields[10],
      })
    ).toBeUndefined();
    expect((await inject(proof)).statusCode).toBe(403);
    const fresh = forward(workerSession, { method: 'GET', path: '/api/goals' });
    expect((await inject(fresh, { cookie, origin: 'http://localhost' })).statusCode).toBe(403);
    expect(
      (
        await inject(forward(workerSession, { method: 'GET', path: '/api/goals' }), {
          'x-reverie-service-token': 'synthetic',
        })
      ).statusCode
    ).toBe(403);
    const changed = forward(workerSession, { method: 'POST', path: '/api/goals', body: create('tamper') });
    const before = company.store.snapshot().goals.length;
    expect((await inject(changed, {}, changed.body.replace('tamper', 'alter!'))).statusCode).toBe(403);
    expect(company.store.snapshot().goals).toHaveLength(before);
    const sanitized = forward(
      workerSession,
      { method: 'GET', path: '/api/goals' },
      {
        'X-Reverie-Goal-Assertion': 'forged',
        Cookie: cookie,
        'X-Reverie-Service-Token': 'synthetic',
        'X-Reverie-Parent-Session': verifierSession,
      }
    );
    expect(sanitized.headers['X-Reverie-Parent-Session']).toBe(workerSession);
    expect((await inject(sanitized)).statusCode).toBe(200);
    const beforeInvalid = await fs.readFile(ledgerFile, 'utf8');
    for (const path of ['/api/goals/' + 'x'.repeat(101), '/api/goals/%67', '/api/goals/a/b'])
      expect(forward(workerSession, { method: 'GET', path }).refused).toBe(403);
    expect(await fs.readFile(ledgerFile, 'utf8')).toBe(beforeInvalid);
    for (const headers of [
      { authorization: 'Basic synthetic' },
      { 'x-reverie-parent-session': workerSession },
      { 'x-reverie-service-token': 'synthetic' },
      { cookie, 'x-reverie-goal-assertion': 'invalid' },
    ])
      expect(
        (await app.inject({ method: 'GET', url: '/api/goals', headers: { host: 'localhost', ...headers } })).statusCode
      ).toBe(403);
  }, 30000);
  it('rechecks canonical binding and durable exact nonce claim after canonical temp sync before commit', async () => {
    for (const mode of ['binding', 'nonce'] as const) {
      const session = actual.sessions.get(workerSession)!;
      const before = await fs.readFile(company.store.file, 'utf8'),
        open = fs.open.bind(fs);
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).startsWith(company.store.file + '.') && String(args[0]).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            if (mode === 'binding') actual.sessions.delete(workerSession);
            else {
              const state = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
              state.entries = [];
              await fs.writeFile(ledgerFile, JSON.stringify(state));
            }
          };
        }
        return handle;
      });
      try {
        const response = await cli(workerSession, ['create'], create('commit-revoked-' + mode));
        expect(response.code, response.out).toBe(4);
        expect(await fs.readFile(company.store.file, 'utf8')).toBe(before);
      } finally {
        spy.mockRestore();
        actual.sessions.set(workerSession, session);
      }
    }
    expect((await cli(workerSession, ['read', longGoal])).code).toBe(0);
  }, 30000);
  it('keeps true owner custody/action and revoked issuer/binding controls live with no default bootstrap', async () => {
    custody = false;
    try {
      expect((await owner('GET', '/api/goals')).statusCode).toBe(403);
      expect((await cli(workerSession, ['list'])).code).toBe(4);
    } finally {
      custody = true;
    }
    // No artificial action-bit callback: actual grant revocation is exercised above and current owner revocation below.
    issuerCurrent = false;
    try {
      expect((await cli(workerSession, ['list'])).code).toBe(4);
    } finally {
      issuerCurrent = true;
    }
    await company.store.update((state) => {
      state.employees.find((item) => item.id === worker)!.bindingMigration = {
        id: 'synthetic-interrupted',
        from: workerSession,
        to: verifierSession,
      };
    });
    try {
      expect((await cli(workerSession, ['create'], create('migration-denied'))).code).toBe(4);
      expect(company.store.snapshot().employees.find((item) => item.id === worker)!.bindingMigration).toBeDefined();
    } finally {
      await company.store.update((state) => {
        delete state.employees.find((item) => item.id === worker)!.bindingMigration;
      });
    }
    await ownerService.logoutEverywhere('127.0.0.1');
    expect((await owner('GET', '/api/goals')).statusCode).toBe(403);
    expect((await owner('GET', `/api/session-health/${workerSession}/metadata`)).statusCode).toBe(401);
    expect((await cli(workerSession, ['read', longGoal])).code).toBe(0);
  }, 30000);
});
