/** Real user authentication, enforce policy, parent resolution and canonical Store;
 * runtime effects are owned in-memory witnesses only. No live credentials or providers.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken } from '../src/owner-auth/admin.js';
import { registerOwnerPolicy, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { createUser } from '../src/user-store.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerCompanyRoutes } from '../src/web/routes/company-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema, EmployeePermissionsSchema } from '../src/company-types.js';
import { CompanyWake, type CompanyWakeReport } from '../src/company-wake.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const ACTOR_SID = 'aaaaaaaa-1111-4111-8111-111111111111';
const TARGET_SID = 'bbbbbbbb-2222-4222-8222-222222222222';
const FOREIGN_SID = 'cccccccc-3333-4333-8333-333333333333';
const PASSWORD = 'Synthetic-only-office-auth-42';
const sessions = new Map<string, {id: string; owner: string; name: string}>();
const ctx = {sessions} as unknown as SessionPort;
let app: ReturnType<typeof Fastify>, directory: string, store: CompanyStore, company: CompanyService;
let auth: ReturnType<typeof registerAuthMiddleware>, serviceToken: string;
const stopped: string[] = [], launched: string[] = [];
const refreshHealth = vi.fn(async () => {});
const wake = vi.fn(async (id: string, options?: {explicitStart?: boolean; stillCurrent?: () => boolean}): Promise<CompanyWakeReport> => {
  if (options?.stillCurrent && !options.stillCurrent())
    return {awakened: [], skipped: [{employeeId: id, reason: 'changed-or-stopping'}]};
  launched.push(id);
  return {awakened: [id], skipped: []};
});

beforeAll(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '1');
  await createUser({username: 'office-review-alice', role: 'user', password: PASSWORD});
  await createUser({username: 'office-review-bob', role: 'user', password: PASSWORD});
  directory = await mkdtemp(join(tmpdir(), 'office-enforced-'));
  const ownerStore = new OwnerAuthStore(join(directory, 'owner.json'));
  await bootstrap(ownerStore, 'synthetic-owner', {enforce: true});
  const ownerAuth = new OwnerAuthService({store: ownerStore, auditFile: join(directory, 'audit.jsonl')});
  serviceToken = await issueServiceToken(ownerStore, 'synthetic-service');
  store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  company = new CompanyService(store, {
    getSession: id => sessions.get(id),
    stopSession: async id => { stopped.push(id); sessions.delete(id); },
    chatrooms: {rooms: () => []} as unknown as CompanyServiceDeps['chatrooms'],
    research: {start: async () => { throw new Error('No research producer in this fixture'); }, inspect: async () => undefined, stop: async () => {}},
  });
  app = Fastify(); await app.register(cookie);
  auth = registerAuthMiddleware(app, false, '', ownerAuth);
  registerOwnerPolicy(app, {
    service: ownerAuth, ctx, isCapabilityRequest: () => false,
    relations: {known: id => sessions.has(id), related: (a, b) => a === b, upward: () => false, keeper: () => false, admin: () => false},
  });
  registerCompanyRoutes(app, ctx, company, undefined, undefined, wake, {
    verifiedOwner: ownerVerifier({service: ownerAuth, ctx}),
    refreshHealth,
  });
  installRouteErrorHandler(app); await app.ready();
});

beforeEach(async () => {
  vi.restoreAllMocks(); wake.mockClear(); refreshHealth.mockClear(); stopped.length = launched.length = 0;
  sessions.clear();
  for (const [id, owner] of [[ACTOR_SID, 'office-review-alice'], [FOREIGN_SID, 'office-review-bob']])
    sessions.set(id, {id, owner, name: 'Synthetic session'});
  await store.update(state => {
    state.retired = [];
    state.employees = [
      {id: ACTOR, sessionId: ACTOR_SID, owner: 'office-review-alice', name: 'Coordinator', permissions: {manageOffice: true, recoverEmployees: true}},
      {id: TARGET, sessionId: TARGET_SID, owner: 'office-review-alice', name: 'Worker', permissions: {}},
      {id: FOREIGN, sessionId: FOREIGN_SID, owner: 'office-review-bob', name: 'Foreign coordinator', permissions: {manageOffice: true}},
    ].map(employee => EmployeeSchema.parse({...employee, position: 'Coordinator', icon: 'X', expertise: ['synthetic'], createdAt: 1,
      sessionGeneration: 2, desiredRunning: employee.id !== TARGET, runtimeRecipe: {mode: 'codex', workingDir: '/workspace'}}));
  });
});

afterAll(async () => {
  await app?.close(); for (const value of Object.values(auth ?? {})) value?.dispose();
  vi.unstubAllEnvs(); await rm(directory, {recursive: true, force: true});
});
const headers = (parent = ACTOR_SID, username = 'office-review-alice') => ({
  host: 'localhost', origin: 'http://localhost', authorization: 'Basic ' + Buffer.from(username + ':' + PASSWORD).toString('base64'),
  'x-reverie-parent-session': parent,
});
const office = (enabled: boolean, extra: Record<string, string> = {}, id = TARGET) => app.inject({
  method: 'POST', url: `/api/company/employees/${id}/vacation`, headers: {...headers(), ...extra}, payload: {enabled},
});

it('a genuine same-owner granted coordinator explicitly enters an OFF employee', async () => {
  const response = await office(false);
  expect(response.statusCode, response.body).toBe(200);
  const employee = store.snapshot().employees.find(row => row.id === TARGET)!;
  expect(employee.desiredRunning).toBe(true); expect(employee.onVacation).toBe(false);
  expect(launched).toEqual([TARGET]);
});

it('a coordinator title without manageOffice cannot change office intent', async () => {
  await store.update(state => { state.employees.find(row => row.id === ACTOR)!.permissions = EmployeePermissionsSchema.parse({recoverEmployees: true, moveOwnPlan: true, managePlans: true}); });
  const before = store.snapshot(); const response = await office(false);
  expect(response.statusCode).toBe(403); expect(store.snapshot()).toEqual(before);
  expect(launched).toEqual([]); expect(stopped).toEqual([]);
});

it('actual enforce auth rejects anonymous, foreign and stale principals without touching targets', async () => {
  for (const supplied of [
    {'x-reverie-parent-session': ACTOR_SID},
    headers(FOREIGN_SID),
    headers('dddddddd-4444-4444-8444-444444444444'),
    {...headers(), [SERVICE_HEADER]: serviceToken},
  ]) {
    const response = await app.inject({method: 'POST', url: `/api/company/employees/${TARGET}/vacation`, headers: supplied, payload: {enabled: false}});
    expect([401, 403]).toContain(response.statusCode);
  }
  expect(launched).toEqual([]); expect(stopped).toEqual([]);
  expect(store.snapshot().employees.find(row => row.id === TARGET)!.desiredRunning).toBe(false);
});

it('a granted foreign coordinator cannot operate another owner’s target', async () => {
  const response = await app.inject({method: 'POST', url: `/api/company/employees/${TARGET}/vacation`, headers: headers(FOREIGN_SID, 'office-review-bob'), payload: {enabled: false}});
  expect([403, 404]).toContain(response.statusCode); expect(launched).toEqual([]); expect(stopped).toEqual([]);
});

it('an explicit leave persists OFF through the ordinary stop path', async () => {
  sessions.set(TARGET_SID, {id: TARGET_SID, owner: 'office-review-alice', name: 'Worker'});
  await store.update(state => { state.employees.find(row => row.id === TARGET)!.desiredRunning = true; });
  const response = await office(true); expect(response.statusCode, response.body).toBe(200);
  const employee = store.snapshot().employees.find(row => row.id === TARGET)!;
  expect(employee.desiredRunning).toBe(false); expect(employee.onVacation).toBe(true);
  expect(stopped).toEqual([TARGET_SID]); expect(launched).toEqual([]);
});

/** Pause the actual canonical transaction after setVacation captures its before-binding. */
async function duringIntentCommit(change: () => Promise<unknown>) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const update = store.update.bind(store);
  const spy = vi.spyOn(store, 'update').mockImplementationOnce(async (...args) => {
    enter(); await gate;
    return update(...args);
  });
  const pending = office(false).then(response => response);
  try {
    await entered;
    await change();
    release();
    return await pending;
  } finally {
    release(); await pending; spy.mockRestore();
  }
}

it('revoking the real actor grant while canonical mutation waits prevents launch and intent change', async () => {
  const response = await duringIntentCommit(() => store.update(state => {
    state.employees.find(row => row.id === ACTOR)!.permissions = EmployeePermissionsSchema.parse({recoverEmployees: true});
  }));
  expect([403, 409]).toContain(response.statusCode);
  expect(store.snapshot().employees.find(row => row.id === TARGET)!.desiredRunning).toBe(false);
  expect(launched).toEqual([]); expect(stopped).toEqual([]);
});

it.each(['sessionId', 'sessionGeneration'] as const)('changed actor %s invalidates the grant even while the old session stays live', async field => {
  const response = await duringIntentCommit(() => store.update(state => {
    const employee = state.employees.find(row => row.id === ACTOR)!;
    if (field === 'sessionId') employee.sessionId = 'dddddddd-4444-4444-8444-444444444444';
    else employee.sessionGeneration++;
  }));
  expect([403, 409]).toContain(response.statusCode);
  expect(launched).toEqual([]); expect(stopped).toEqual([]);
  expect(store.snapshot().employees.find(row => row.id === TARGET)!.desiredRunning).toBe(false);
});

it.each(['sessionId', 'sessionGeneration'] as const)('target %s changes cannot redirect the pending operation', async field => {
  const response = await duringIntentCommit(() => store.update(state => {
    const employee = state.employees.find(row => row.id === TARGET)!;
    if (field === 'sessionId') employee.sessionId = 'eeeeeeee-5555-4555-8555-555555555555';
    else employee.sessionGeneration++;
  }));
  expect([404, 409]).toContain(response.statusCode);
  expect(launched).toEqual([]); expect(stopped).toEqual([]);
  expect(store.snapshot().employees.find(row => row.id === TARGET)!.desiredRunning).toBe(false);
});

it('revocation during awaited health refresh prevents native dispatch after the intent commit', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  refreshHealth.mockImplementationOnce(async () => { enter(); await gate; });
  const pending = office(false).then(response => response);
  try {
    await entered;
    await store.update(state => { state.employees.find(row => row.id === ACTOR)!.permissions = EmployeePermissionsSchema.parse({recoverEmployees: true}); });
    release();
    const response = await pending; expect(response.statusCode).toBe(409);
    expect(launched).toEqual([]); expect(stopped).toEqual([]);
    // Intent was committed while authorized; revocation blocks the later effect, not a false rollback claim.
    expect(store.snapshot().employees.find(row => row.id === TARGET)!.desiredRunning).toBe(true);
  } finally { release(); await pending; }
});

it('a later deliberate stop wins while the earlier explicit enter is waiting to commit', async () => {
  await store.update(state => { state.employees.find(row => row.id === TARGET)!.desiredRunning = true; });
  const response = await duringIntentCommit(() => store.update(state => {
    state.employees.find(row => row.id === TARGET)!.desiredRunning = false;
  }));
  expect(response.statusCode).toBe(409); expect(launched).toEqual([]);
  expect(store.snapshot().employees.find(row => row.id === TARGET)!.desiredRunning).toBe(false);
});

it('vacation blocks ordinary wake, while a separately authorized explicit return can enter', async () => {
  await store.update(state => { state.employees.find(row => row.id === TARGET)!.onVacation = true; });
  const oldWake = await app.inject({method: 'POST', url: `/api/company/employees/${TARGET}/wake`, headers: headers(), payload: {}});
  expect(oldWake.statusCode).toBe(409); expect(wake).not.toHaveBeenCalled();
  const enter = await office(false); expect(enter.statusCode, enter.body).toBe(200);
  expect(store.snapshot().employees.find(row => row.id === TARGET)!.onVacation).toBe(false);
  expect(launched).toEqual([TARGET]);
});

it('the existing recovery wake still respects deliberate OFF intent', async () => {
  const oldWake = new CompanyWake({
    company: () => store.snapshot(), saved: () => undefined, live: () => false, closing: () => false,
    noteRunning: async () => {}, begin: () => undefined, claim: async () => false,
    wake: async () => { throw new Error('OFF must never reach a runtime producer'); },
  });
  wake.mockImplementationOnce(id => oldWake.wakeOne(id));
  const response = await app.inject({method: 'POST', url: `/api/company/employees/${TARGET}/wake`, headers: headers(), payload: {}});
  expect(response.statusCode).toBe(200);
  expect(response.json().data.recovery).toEqual({awakened: [], skipped: [{employeeId: TARGET, reason: 'not-desired'}]});
  expect(launched).toEqual([]); expect(stopped).toEqual([]);
  expect(store.snapshot().employees.find(row => row.id === TARGET)!.desiredRunning).toBe(false);
});

it('retired employees remain excluded instead of being silently restored', async () => {
  await store.update(state => {
    const employee = state.employees.find(row => row.id === TARGET)!;
    state.retired.push({...employee, retiredAt: 1});
    state.employees = state.employees.filter(row => row.id !== TARGET);
  });
  const response = await office(false); expect([403, 404]).toContain(response.statusCode);
  expect(launched).toEqual([]); expect(stopped).toEqual([]);
  expect(store.snapshot().retired.some(row => row.id === TARGET)).toBe(true);
});

it('the grant is durable employee data, defaults false and cannot be self-granted over HTTP', async () => {
  const reloaded = new CompanyStore(store.file); await reloaded.init();
  expect(reloaded.snapshot().employees.find(row => row.id === ACTOR)!.permissions).toMatchObject({manageOffice: true});
  expect(reloaded.snapshot().employees.find(row => row.id === TARGET)!.permissions).toMatchObject({manageOffice: false});
  const response = await app.inject({method: 'PUT', url: `/api/company/employees/${ACTOR}`, headers: headers(), payload: {permissions: {manageOffice: true}}});
  expect(response.statusCode).toBe(403); expect(launched).toEqual([]); expect(stopped).toEqual([]);
});
