/** Existing CompanyService/CompanyStore authority, app.inject only, synthetic runtime/proof/custody dependencies. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { GoalCanonicalAuthority, type GoalCanonicalAuthorityOptions } from '../src/goal-canonical-authority.js';
import { createGoalServerBoundary } from '../src/goal-server-integration.js';
import { GoalAccessError, type GoalPrincipal } from '../src/goal-access.js';
import { registerGoalServiceRoutes } from '../src/web/routes/goal-routes.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import type { Session } from '../src/session.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const workerSession = '11111111-2222-4333-8444-555555555555',
  verifierSession = '66666666-7777-4888-8999-000000000000';
const worker = 'w'.repeat(100),
  verifier = 'v'.repeat(100);
const credentials = { username: 'SYNTHETIC_CANONICAL_OWNER', password: 'synthetic-Owner!91-canonical' };
const principals = new Map<string, GoalPrincipal>([
  ['worker', { kind: 'employee', employeeId: worker, sessionId: workerSession, sessionGeneration: 1 }],
  ['verifier', { kind: 'employee', employeeId: verifier, sessionId: verifierSession, sessionGeneration: 1 }],
]);

describe('real canonical Goal binding and scoped current-action adapters', () => {
  let root: string,
    app: FastifyInstance,
    company: CompanyService,
    store: CompanyStore,
    authority: GoalCanonicalAuthority,
    ownerService: OwnerAuthService,
    cookieValue: string;
  let options: GoalCanonicalAuthorityOptions;
  let custody = true,
    unrelatedEffects = 0;
  const runtime = new Map<string, { id: string; owner?: string; running: boolean; name: string }>();
  const retired = new Set<string>();
  const proofs = new WeakMap<object, GoalPrincipal>();
  const input = (createId: string) => ({
    createId,
    employeeId: worker,
    sessionId: workerSession,
    sessionGeneration: 1,
    objective: 'PRIVATE_CANONICAL_OBJECTIVE',
    nextAction: 'PRIVATE_CANONICAL_CREATION',
  });
  const actor = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload, headers: { host: 'localhost', 'x-synthetic-purpose': who } });
  const owner = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: 'localhost', origin: 'http://localhost', cookie: cookieValue },
    });
  const snapshot = () => fs.readFile(store.file, 'utf8');
  const currentGoal = () => store.snapshot().goals[0]!;
  const transition = (to: string, id: string, grantId?: string) => {
    const goal = currentGoal();
    return {
      transitionId: id,
      generation: goal.generation,
      expectedState: goal.state,
      expectedSequence: goal.transitionSequence,
      sessionId: goal.sessionId,
      sessionGeneration: goal.sessionGeneration,
      to,
      nextAction: 'PRIVATE_CANONICAL_HISTORY',
      ...(grantId ? { verifierGrantId: grantId } : {}),
    };
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'goal-canonical-fixture-'));
    custody = true;
    unrelatedEffects = 0;
    retired.clear();
    runtime.clear();
    for (const [id, name] of [
      [workerSession, 'worker'],
      [verifierSession, 'verifier'],
    ])
      runtime.set(id, { id, name, running: true });
    store = new CompanyStore(join(root, 'company.json'));
    await store.init();
    await store.update((state) => {
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
    ownerService = new OwnerAuthService({
      store: new OwnerAuthStore(join(root, 'owner-auth.json')),
      auditFile: join(root, 'synthetic-owner-audit.jsonl'),
      setupEnabled: true,
    });
    await ownerService.setup(credentials.username, credentials.password, credentials.password, '127.0.0.1');
    const login = await ownerService.login(credentials.username, credentials.password, '127.0.0.1');
    expect(login.next).toBe('done');
    expect(login.session).toBeTruthy();
    cookieValue = 'reverie_owner=' + login.session;
    const custodyPort = {
      assertPrivateCustody: (file: string) => {
        if (!custody || file !== store.file) throw new GoalAccessError('synthetic custody absent');
      },
    };
    const employee = {
      authenticate: async (context: unknown) => proofs.get(context as object),
      assertCurrent: (principal: GoalPrincipal, context: unknown) => {
        if (proofs.get(context as object) !== principal) throw new GoalAccessError('synthetic proof absent');
      },
      ...custodyPort,
    };
    app = Fastify();
    await app.register(cookie);
    const boundary = createGoalServerBoundary(ownerService, store.file, {
      employee,
      registerEmployeeBoundary: (target) => {
        target.addHook('preValidation', async (request) => {
          const who = request.headers['x-synthetic-purpose'];
          if (typeof who === 'string' && principals.has(who)) proofs.set(request, principals.get(who)!);
        });
      },
      assertAction: (action, principal, request) => authority.assertAction(action, principal, request),
    });
    boundary.register(app);
    registerOwnerPolicy(app, {
      service: ownerService,
      goalRequest: (request, action) => boundary.authorizeRequest(request, action),
      ctx: { sessions: runtime } as unknown as SessionPort,
      isCapabilityRequest: () => false,
      relations: {
        known: () => false,
        related: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    company = new CompanyService(store, {
      goalAuthentication: boundary.authentication,
      getSession: (id) => runtime.get(id),
      chatrooms: {
        rooms: () => [],
        room: () => undefined,
        addMember: () => {
          throw Error('not used');
        },
        setStatus: () => {
          throw Error('not used');
        },
      },
      research: {
        inspect: async () => undefined,
        start: async () => {
          throw Error('no research effect');
        },
        stop: async () => {
          throw Error('no research effect');
        },
      },
    } as CompanyServiceDeps);
    options = {
      company,
      sessions: {
        getSession: (id) => {
          const state = runtime.get(id);
          return state ? ({ ...state, isRunning: () => state.running } as Session) : undefined;
        },
      },
      retirement: { isRetired: (id) => retired.has(id) },
      owner: ownerService,
      custody: custodyPort,
    };
    authority = new GoalCanonicalAuthority(options);
    registerGoalServiceRoutes(app, company.goals);
    app.post('/api/sessions', () => {
      unrelatedEffects++;
      return { success: true };
    });
    await app.ready();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    if (root?.startsWith(join(tmpdir(), 'goal-canonical-fixture-')))
      await fs.rm(root, { recursive: true, force: true });
  });

  it('reads exact canonical generation, not a broker maintenance counter, and cannot allocate/adopt or write', async () => {
    const before = await snapshot();
    expect(authority.binding(workerSession)).toEqual({
      owner: undefined,
      employeeId: worker,
      sessionId: workerSession,
      sessionGeneration: 1,
    });
    expect(Object.isFrozen(authority.binding(workerSession))).toBe(true);
    expect(new GoalCanonicalAuthority().binding(workerSession)).toBeUndefined();
    expect(authority.binding('not-a-UUID')).toBeUndefined();
    expect(await snapshot()).toBe(before);
    await store.update((state) => {
      state.employees[0]!.sessionGeneration = 7;
    });
    expect(authority.binding(workerSession)?.sessionGeneration).toBe(7);
    expect((await actor('worker', 'POST', '/api/goals', input('stale'))).statusCode).toBe(403);
    expect(store.snapshot().goals).toEqual([]);
  });
  it.each([
    'missing-runtime',
    'stopped-runtime',
    'wrong-owner',
    'retired-runtime',
    'vacation',
    'off',
    'migration',
    'retired-employee',
  ] as const)('refuses %s from actual canonical/runtime sources', async (mode) => {
    if (mode === 'missing-runtime') runtime.delete(workerSession);
    if (mode === 'stopped-runtime') runtime.get(workerSession)!.running = false;
    if (mode === 'wrong-owner') runtime.get(workerSession)!.owner = 'different-owner';
    if (mode === 'retired-runtime') retired.add(workerSession);
    if (['vacation', 'off', 'migration', 'retired-employee'].includes(mode))
      await store.update((state) => {
        const employee = state.employees[0]!;
        if (mode === 'vacation') employee.onVacation = true;
        if (mode === 'off') employee.desiredRunning = false;
        if (mode === 'migration')
          employee.bindingMigration = { id: 'interrupted', from: workerSession, to: verifierSession };
        if (mode === 'retired-employee') state.employees.shift();
      });
    const before = await snapshot();
    expect(authority.binding(workerSession)).toBeUndefined();
    expect((await actor('worker', 'POST', '/api/goals', input(mode))).statusCode).toBe(403);
    expect(await snapshot()).toBe(before);
  });
  it('refuses duplicate canonical session binding instead of electing one owner/employee', async () => {
    await store.update((state) => {
      state.employees[1]!.sessionId = workerSession;
    });
    expect(authority.binding(workerSession)).toBeUndefined();
  });
  it('replaces mock action admission with canonical own/create/read scopes and independent exact VERIFY grants', async () => {
    const created = await actor('worker', 'POST', '/api/goals', input('scoped'));
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().data.id;
    expect((await actor('verifier', 'GET', '/api/goals/' + id)).statusCode).toBe(403);
    expect((await actor('verifier', 'POST', '/api/goals', input('cross-create'))).statusCode).toBe(403);
    for (const to of ['ASSIGNED', 'ACTIVE', 'REVIEW'])
      expect(
        (await actor('worker', 'POST', '/api/goals/' + id + '/transitions', transition(to, 'move-' + to))).statusCode
      ).toBe(200);
    expect(
      (await actor('worker', 'POST', '/api/goals/' + id + '/transitions', transition('DONE', 'self-close'))).statusCode
    ).toBe(403);
    const granted = await owner('POST', '/api/goal-grants', {
      kind: 'VERIFY',
      employeeId: verifier,
      targetEmployeeId: worker,
      goalId: id,
      generation: 1,
      expectedSequence: 3,
      expiresAt: Date.now() + 60000,
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const command = transition('DONE', 'verify-done', granted.json().data.id);
    const done = await actor('verifier', 'POST', '/api/goals/' + id + '/transitions', command);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data.visibility).toBe('verification');
    expect(done.body).not.toMatch(/PRIVATE_|objective|nextAction|creation|requestDigest|"after"/);
    expect((await actor('verifier', 'POST', '/api/goals/' + id + '/transitions', command)).json().data).toEqual(
      done.json().data
    );
    expect((await actor('verifier', 'GET', '/api/goals/' + id)).statusCode).toBe(403);
    expect((await owner('POST', '/api/goal-grants/' + granted.json().data.id + '/revoke', {})).statusCode).toBe(200);
    expect((await actor('verifier', 'POST', '/api/goals/' + id + '/transitions', command)).statusCode).toBe(403);
  });
  it('uses only current canonical metadata grants and does not infer team rights from CTO/plan permissions', async () => {
    await actor('worker', 'POST', '/api/goals', input('metadata'));
    await store.update((state) => {
      state.employees[1]!.permissions = { managePlans: true, moveOwnPlan: true, recoverEmployees: true };
    });
    expect((await actor('verifier', 'GET', '/api/goal-metadata/' + worker)).statusCode).toBe(403);
    const granted = await owner('POST', '/api/goal-grants', {
      kind: 'METADATA_READ',
      employeeId: verifier,
      targetEmployeeId: worker,
      expiresAt: Date.now() + 60000,
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const path = '/api/goal-metadata/' + worker + '?grantId=' + granted.json().data.id;
    const projection = await actor('verifier', 'GET', path);
    expect(projection.statusCode).toBe(200);
    expect(projection.body).not.toMatch(/PRIVATE_|objective|nextAction|creation/);
    await store.update((state) => {
      state.employees[0]!.sessionGeneration++;
    });
    expect((await actor('verifier', 'GET', path)).statusCode).toBe(403);
    expect(
      (
        await actor('verifier', 'POST', '/api/goal-grants', {
          kind: 'METADATA_READ',
          employeeId: verifier,
          targetEmployeeId: worker,
          expiresAt: Date.now() + 60000,
        })
      ).statusCode
    ).toBe(403);
  });
  it('refuses expired/revoked or differently scoped VERIFY authority from canonical records', async () => {
    await actor('worker', 'POST', '/api/goals', input('grant-scope'));
    const id = currentGoal().id;
    for (const to of ['ASSIGNED', 'ACTIVE', 'REVIEW'])
      expect(
        (await actor('worker', 'POST', '/api/goals/' + id + '/transitions', transition(to, 'grant-' + to))).statusCode
      ).toBe(200);
    const granted = await owner('POST', '/api/goal-grants', {
      kind: 'VERIFY',
      employeeId: verifier,
      targetEmployeeId: worker,
      goalId: id,
      generation: 1,
      expectedSequence: 3,
      expiresAt: Date.now() + 60000,
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const original = structuredClone(store.snapshot().goalGrants[0]!);
    for (const reason of [
      'expired',
      'revoked',
      'verifier-generation',
      'target-generation',
      'wrong-goal',
      'wrong-sequence',
      'wrong-owner',
    ]) {
      await store.update((state) => {
        state.goalGrants[0] = structuredClone(original);
        state.goalGrantRevocations = [];
        const grant = state.goalGrants[0]!;
        if (reason === 'expired') grant.expiresAt = Date.now() - 1;
        if (reason === 'revoked')
          state.goalGrantRevocations.push({ grantId: grant.id, owner: grant.owner, at: Date.now() });
        if (reason === 'verifier-generation') grant.sessionGeneration++;
        if (reason === 'target-generation') grant.targetSessionGeneration++;
        if (reason === 'wrong-goal') grant.goalId = 'another-goal';
        if (reason === 'wrong-sequence') grant.goalSequence = 2;
        if (reason === 'wrong-owner') grant.owner = 'other-owner';
      });
      const before = await snapshot();
      expect(
        (await actor('verifier', 'POST', '/api/goals/' + id + '/transitions', transition('DONE', reason, original.id)))
          .statusCode
      ).toBe(403);
      expect(await snapshot()).toBe(before);
    }
  });
  it('preserves scoped metadata and real-owner planning/revocation when a target runtime is stopped', async () => {
    await actor('worker', 'POST', '/api/goals', input('offline-target'));
    const granted = await owner('POST', '/api/goal-grants', {
      kind: 'METADATA_READ',
      employeeId: verifier,
      targetEmployeeId: worker,
      expiresAt: Date.now() + 60000,
    });
    expect(granted.statusCode, granted.body).toBe(200);
    runtime.get(workerSession)!.running = false;
    expect(authority.binding(workerSession)).toBeUndefined();
    expect((await actor('worker', 'GET', '/api/goals')).statusCode).toBe(403);
    expect(
      (await actor('verifier', 'GET', '/api/goal-metadata/' + worker + '?grantId=' + granted.json().data.id)).statusCode
    ).toBe(200);
    expect((await owner('GET', '/api/goals/' + currentGoal().id)).statusCode).toBe(200);
    expect((await owner('POST', '/api/goals', input('owner-plan-current-offline-target'))).statusCode).toBe(200);
    expect((await owner('POST', '/api/goal-grants/' + granted.json().data.id + '/revoke', {})).statusCode).toBe(200);
    expect(
      (await actor('verifier', 'GET', '/api/goal-metadata/' + worker + '?grantId=' + granted.json().data.id)).statusCode
    ).toBe(403);
  });
  it.each(['runtime', 'generation', 'migration', 'owner-cookie', 'custody'] as const)(
    'rechecks %s after awaited temp sync before canonical effect',
    async (mode) => {
      const before = await snapshot(),
        open = fs.open.bind(fs);
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).startsWith(store.file + '.') && String(args[0]).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            if (mode === 'runtime') runtime.get(workerSession)!.running = false;
            if (mode === 'custody') custody = false;
            if (mode === 'owner-cookie') await ownerService.logoutEverywhere('127.0.0.1');
            if (mode === 'generation' || mode === 'migration') {
              // Direct owned fixture edit simulates a changed authoritative source; production writes use the held store lock.
              const state = JSON.parse(await fs.readFile(store.file, 'utf8'));
              if (mode === 'generation') state.employees[0].sessionGeneration++;
              else
                state.employees[0].bindingMigration = {
                  id: 'interrupted-at-sync',
                  from: workerSession,
                  to: verifierSession,
                };
              await fs.writeFile(store.file, JSON.stringify(state));
            }
          };
        }
        return handle;
      });
      try {
        const response =
          mode === 'owner-cookie'
            ? await owner('POST', '/api/goals', input('commit-' + mode))
            : await actor('worker', 'POST', '/api/goals', input('commit-' + mode));
        expect(response.statusCode, response.body).toBe(403);
        const after = store.snapshot();
        expect(after.goals).toEqual([]);
        if (mode === 'generation') expect(after.employees[0]!.sessionGeneration).toBe(2);
        else if (mode === 'migration') expect(after.employees[0]!.bindingMigration?.id).toBe('interrupted-at-sync');
        else expect(await snapshot()).toBe(before);
      } finally {
        spy.mockRestore();
        custody = true;
      }
    }
  );
  it('requires real current owner cookie, exact routes and custody; unavailable adapters never grant owner rights', async () => {
    expect((await owner('GET', '/api/goals')).statusCode).toBe(200);
    custody = false;
    expect((await owner('GET', '/api/goals')).statusCode).toBe(403);
    expect(authority.binding(workerSession)).toBeUndefined();
    custody = true;
    authority = new GoalCanonicalAuthority();
    expect((await owner('GET', '/api/goals')).statusCode).toBe(403);
    authority = new GoalCanonicalAuthority(options);
    await ownerService.logoutEverywhere('127.0.0.1');
    expect((await owner('GET', '/api/goals')).statusCode).toBe(403);
    for (const headers of [
      { authorization: 'Basic synthetic' },
      { 'x-reverie-parent-session': workerSession },
      { 'x-reverie-service-token': 'synthetic' },
    ])
      expect((await app.inject({ method: 'GET', url: '/api/goals', headers })).statusCode).toBe(403);
    expect([401, 403]).toContain(
      (
        await app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { 'x-synthetic-purpose': 'worker' },
          payload: {},
        })
      ).statusCode
    );
    expect(unrelatedEffects).toBe(0);
  });
});
