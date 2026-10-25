/** Actual WebServer route setup, app.inject only. Every auth/company file is below an explicit owned mkdtemp root.
 * Does not call WebServer.start/listen, provision real credentials, inspect private state or launch runtimes. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { CompanyService } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { getDataDir } from '../src/config/instance.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { GoalAccessError, type GoalAuthentication, type GoalPrincipal } from '../src/goal-access.js';
import type { GoalAction } from '../src/goal-route-policy.js';
import type { GoalServerPorts } from '../src/goal-server-integration.js';

type Internal = { app: FastifyInstance; companyService: CompanyService; setupRoutes(): Promise<void> };
const workerSession = '00000000-0000-4000-8000-000000000001';
const verifierSession = '00000000-0000-4000-8000-000000000002';
const credentials = { username: 'SYNTHETIC_ONLY_OWNER', password: 'synthetic-Orbit!81-custody-test' };
const principals = new Map<string, GoalPrincipal>([
  ['worker', { kind: 'employee', employeeId: 'worker', sessionId: workerSession, sessionGeneration: 1 }],
  ['verifier', { kind: 'employee', employeeId: 'verifier', sessionId: verifierSession, sessionGeneration: 1 }],
]);
const proof = (who: string) => ({ 'x-synthetic-reviewed-purpose-proof': who });
const input = (createId: string) => ({
  createId,
  employeeId: 'worker',
  sessionId: workerSession,
  sessionGeneration: 1,
  objective: 'PRIVATE_WORKER_OBJECTIVE',
  nextAction: 'PRIVATE_CREATION_TEXT',
});

describe('actual WebServer single Goal facade and mandatory integration boundary', () => {
  let fixtureDir: string, server: WebServer, app: FastifyInstance, company: CompanyService, service: OwnerAuthService;
  let cookie: string;
  const previousDataDir = process.env.REVERIE_DATA_DIR;
  const custody = { available: true };
  const denied = new Set<GoalAction>(),
    revoked = new Set<string>();
  const requests = new WeakMap<object, { token: string; principal: GoalPrincipal }>();
  const observedActions: GoalAction[] = [];
  let boundaryRegistrations = 0;
  const employee: GoalAuthentication = {
    authenticate: async (context) => requests.get(context as object)?.principal,
    assertCurrent: (principal, context) => {
      const record = requests.get(context as object);
      if (!record || revoked.has(record.token) || JSON.stringify(record.principal) !== JSON.stringify(principal))
        throw new GoalAccessError('Synthetic purpose credential refused');
    },
    assertPrivateCustody: (file) => {
      if (!custody.available || file !== join(fixtureDir, 'company.json'))
        throw new GoalAccessError('Synthetic custody refused');
    },
  };
  const ports: GoalServerPorts = {
    employee,
    registerEmployeeBoundary: (target) => {
      boundaryRegistrations++;
      target.addHook('preValidation', async (request) => {
        const token = request.headers['x-synthetic-reviewed-purpose-proof'];
        const principal = typeof token === 'string' && !revoked.has(token) ? principals.get(token) : undefined;
        if (principal) requests.set(request, { token: token as string, principal: structuredClone(principal) });
      });
    },
    assertAction: (action) => {
      observedActions.push(action);
      if (denied.has(action)) throw new GoalAccessError('Synthetic action permission revoked');
    },
  };
  const owner = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { host: 'localhost', origin: 'http://localhost', cookie }, payload });
  const actor = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, extra = {}) =>
    app.inject({ method, url, headers: { host: 'localhost', ...proof(who), ...extra }, payload });
  const login = async (target: FastifyInstance) => {
    const result = await target.inject({
      method: 'POST',
      url: '/api/owner/login',
      headers: { host: 'localhost', origin: 'http://localhost' },
      payload: credentials,
    });
    expect(result.statusCode, result.body).toBe(200);
    return 'reverie_owner=' + result.cookies.find((item) => item.name === 'reverie_owner')!.value;
  };
  beforeAll(async () => {
    fixtureDir = await fs.mkdtemp(join(tmpdir(), 'goal-server-fixture-'));
    await fs.chmod(fixtureDir, 0o700);
    // This is the only test-local configuration: exact newly created owned synthetic directory, never a live path.
    process.env.REVERIE_DATA_DIR = fixtureDir;
    expect(getDataDir()).toBe(fixtureDir);
    service = new OwnerAuthService({
      store: new OwnerAuthStore(join(fixtureDir, 'owner-auth.json')),
      auditFile: join(fixtureDir, 'synthetic-owner-audit.jsonl'),
      setupEnabled: true,
    });
    await service.setup(credentials.username, credentials.password, credentials.password, '127.0.0.1');
    server = new WebServer(0, false, true, '127.0.0.1', undefined, false, '', ports);
    const actual = server as unknown as Internal;
    await actual.setupRoutes();
    await actual.app.ready();
    app = actual.app;
    company = actual.companyService;
    expect(company.store.file).toBe(join(fixtureDir, 'company.json'));
    cookie = await login(app);
    await company.store.update((state) => {
      for (const [id, sessionId] of [
        ['worker', workerSession],
        ['verifier', verifierSession],
      ])
        state.employees.push(
          EmployeeSchema.parse({
            id,
            sessionId,
            name: id,
            icon: 'W',
            position: 'CTO',
            expertise: ['synthetic'],
            createdAt: 1,
          })
        );
    });
  }, 30000);
  afterAll(async () => {
    await server?.stop();
    vi.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.REVERIE_DATA_DIR;
    else process.env.REVERIE_DATA_DIR = previousDataDir;
    if (fixtureDir?.startsWith(join(tmpdir(), 'goal-server-fixture-')))
      await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('registers the purpose boundary once without starting a listener or runtime', () => {
    expect(boundaryRegistrations).toBe(1);
    expect(app.server.listening).toBe(false);
  });
  it('routes current-worker commands through the single CompanyService facade after private provenance verification', async () => {
    const create = vi.spyOn(company.goals, 'create');
    const result = await actor('worker', 'POST', '/api/goals', input('single-instance'));
    expect(result.statusCode, result.body).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    const id = result.json().data.id;
    expect(company.store.snapshot().goals.some((goal) => goal.id === id)).toBe(true);
    expect((await actor('worker', 'GET', '/api/goals/' + id)).json().data.objective).toBe('PRIVATE_WORKER_OBJECTIVE');
    expect((await owner('GET', '/api/goals/' + id)).json().data.id).toBe(id);
    expect(observedActions.filter((action) => action === 'CREATE').length).toBeGreaterThan(3);
    create.mockRestore();
  });
  it('refuses Basic/service/parent/title/body assertions, mixed identities and unrelated route authority', async () => {
    const before = company.store.snapshot().goals.length;
    for (const headers of [
      {},
      { authorization: 'Basic synthetic' },
      { 'x-reverie-parent-session': workerSession },
      { 'x-reverie-service-token': 'synthetic' },
      { 'x-reverie-goal-assertion': 'forged' },
      { ...proof('worker'), 'x-reverie-service-token': 'synthetic' },
      { cookie, ...proof('worker'), 'x-reverie-goal-assertion': 'forged' },
      { cookie, 'x-reverie-goal-assertion': 'invalid' },
      { cookie, 'x-reverie-parent-session': workerSession },
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/goals',
        headers: { host: 'localhost', origin: 'http://localhost', ...headers },
        payload: { ...input('forged'), actor: { kind: 'owner' }, title: 'CTO' },
      });
      expect([401, 403]).toContain(result.statusCode);
    }
    expect(company.store.snapshot().goals).toHaveLength(before);
    expect([401, 403]).toContain((await actor('worker', 'POST', '/api/sessions', {})).statusCode);
    expect(
      (
        await actor('worker', 'POST', '/api/goal-grants', {
          kind: 'METADATA_READ',
          employeeId: 'worker',
          targetEmployeeId: 'verifier',
          expiresAt: Date.now() + 1000,
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await actor('worker', 'POST', '/api/goals', { ...input('actor-body'), actor: { kind: 'owner' } })).statusCode
    ).toBe(400);
  });
  it('requires custody and explicit current action permission even for a genuine owner cookie', async () => {
    custody.available = false;
    try {
      expect((await owner('POST', '/api/goals', input('no-custody'))).statusCode).toBe(403);
    } finally {
      custody.available = true;
    }
    denied.add('CREATE');
    try {
      expect((await owner('POST', '/api/goals', input('no-action'))).statusCode).toBe(403);
    } finally {
      denied.delete('CREATE');
    }
    expect((await owner('POST', '/api/goals', input('real-owner'))).statusCode).toBe(200);
  });
  it('enforces REVIEW freeze and closed verifier mutation/replay responses on actual registered routes', async () => {
    let goal = (await actor('worker', 'POST', '/api/goals', input('verification'))).json().data;
    const transition = (to: string, grant?: string) => ({
      transitionId: 'http-' + to,
      generation: goal.generation,
      expectedState: goal.state,
      expectedSequence: goal.transitionSequence,
      sessionId: goal.sessionId,
      sessionGeneration: goal.sessionGeneration,
      to,
      nextAction: 'PRIVATE_WORKER_HISTORY',
      ...(grant ? { verifierGrantId: grant } : {}),
    });
    for (const to of ['ASSIGNED', 'ACTIVE', 'REVIEW']) {
      const reply = await actor('worker', 'POST', `/api/goals/${goal.id}/transitions`, transition(to));
      expect(reply.statusCode, reply.body).toBe(200);
      goal = reply.json().data.goal;
    }
    expect((await actor('worker', 'POST', `/api/goals/${goal.id}/transitions`, transition('DONE'))).statusCode).toBe(
      403
    );
    const granted = await owner('POST', '/api/goal-grants', {
      kind: 'VERIFY',
      employeeId: 'verifier',
      targetEmployeeId: 'worker',
      goalId: goal.id,
      generation: goal.generation,
      expectedSequence: goal.transitionSequence,
      expiresAt: Date.now() + 30000,
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const request = transition('DONE', granted.json().data.id);
    const response = await actor('verifier', 'POST', `/api/goals/${goal.id}/transitions`, request);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.visibility).toBe('verification');
    expect(response.body).not.toMatch(/PRIVATE_|objective|creation|nextAction|evidence|requestDigest|"after"/);
    expect((await actor('verifier', 'POST', `/api/goals/${goal.id}/transitions`, request)).json().data).toEqual(
      response.json().data
    );
    expect((await actor('verifier', 'GET', `/api/goals/${goal.id}`)).statusCode).toBe(403);
    expect((await owner('GET', `/api/goals/${goal.id}`)).json().data.state).toBe('DONE');
  });
  it('retains migration fencing and refuses before canonical rename if action permission is revoked', async () => {
    await company.store.update((state) => {
      state.employees[0].bindingMigration = { id: 'pending', from: workerSession, to: 'other' };
    });
    try {
      expect((await actor('worker', 'POST', '/api/goals', input('during-migration'))).statusCode).toBe(403);
    } finally {
      await company.store.update((state) => {
        delete state.employees[0].bindingMigration;
      });
    }
    const before = await fs.readFile(company.store.file, 'utf8'),
      open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(company.store.file + '.') && String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          denied.add('CREATE');
        };
      }
      return handle;
    });
    try {
      expect((await actor('worker', 'POST', '/api/goals', input('revoked-before-commit'))).statusCode).toBe(403);
      expect(await fs.readFile(company.store.file, 'utf8')).toBe(before);
    } finally {
      spy.mockRestore();
      denied.delete('CREATE');
    }
  });
  it.each(['owner-cookie', 'owner-action', 'custody'] as const)(
    'rechecks %s authority after sync before an owner commit',
    async (mode) => {
      const before = await fs.readFile(company.store.file, 'utf8'),
        open = fs.open.bind(fs);
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).startsWith(company.store.file + '.') && String(args[0]).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            if (mode === 'owner-cookie') await service.logoutEverywhere('127.0.0.1');
            if (mode === 'owner-action') denied.add('CREATE');
            if (mode === 'custody') custody.available = false;
          };
        }
        return handle;
      });
      try {
        expect((await owner('POST', '/api/goals', input('revoked-' + mode))).statusCode).toBe(403);
        expect(await fs.readFile(company.store.file, 'utf8')).toBe(before);
      } finally {
        spy.mockRestore();
        custody.available = true;
        denied.delete('CREATE');
        if (mode === 'owner-cookie') cookie = await login(app);
      }
    }
  );
  it('refuses revoked employee proof and revoked owner cookies without fallback', async () => {
    revoked.add('worker');
    try {
      expect((await actor('worker', 'GET', '/api/goals')).statusCode).toBe(403);
    } finally {
      revoked.delete('worker');
    }
    await service.logoutEverywhere('127.0.0.1');
    expect([401, 403]).toContain((await owner('GET', '/api/goals')).statusCode);
    expect(
      (await actor('worker', 'GET', '/api/goals', undefined, { cookie, 'x-reverie-goal-assertion': 'invalid' }))
        .statusCode
    ).toBe(403);
    cookie = await login(app);
    expect((await owner('GET', '/api/goals')).statusCode).toBe(200);
  });
});
