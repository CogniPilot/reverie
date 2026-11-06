/** AUTH-ROUTE1/REG1: the ACTUAL WebServer composition. Real OfficeAuthService accounts (owner and limited), real owner
 * policy, the real createGoalServerAssembly in owner-only mode (Goal automation OFF), CompanyService.goals carrying the ONE
 * configured registry, the service grant routes and setup page on that facade and boundary, and the service decision on
 * the same store. Synthetic fixtures only. */
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { callerOf, registerOwnerPolicy, OWNER_COOKIE, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { createServiceAuthorization } from '../src/service-authorization.js';
import { MemoryScopePublisher } from '../src/memory-scope-publisher.js';
import { registerMemoryScopeRoutes } from '../src/web/routes/memory-scope-routes.js';
import { registerOfficeRoutes } from '../src/web/routes/office-routes.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import type { ChatroomService } from '../src/chatroom-service.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { createGoalServerAssembly } from '../src/goal-server-assembly.js';
import { EMPLOYEE_GOAL_ACTIONS, goalRouteAction } from '../src/goal-route-policy.js';
import { loadServiceAuthConfig } from '../src/service-auth-config.js';
import {
  ServiceDecisions,
  registerServiceGrantRoutes,
  registerServiceGrantSetupPage,
} from '../src/service-decision.js';
import { signServiceAssertion } from '../src/service-grant-auth.js';
import type { MemoryInstallationData } from '../src/memory-scope-config.js';
import { InstalledMemoryBridge } from '../src/installed-memory-bridge.js';
import { installedMemoryAccess } from '../src/installed-memory-access.js';
import { createMemoryTools } from '../src/mcp-memory-tools.js';
import {
  InstalledMemoryNamespace,
  NAMESPACE_SETTINGS,
  NAMESPACE_HISTORY,
} from './support/memory-installed-namespace.js';

const FLOCK = fs.realpathSync(
  (process.env.PATH ?? '')
    .split(':')
    .map((item) => join(item, 'flock'))
    .find((item) => fs.existsSync(item))!
);
const SESSION = '11111111-2222-4333-8444-555555555555';
const STORE_ID = '22222222-3333-4444-8555-666666666666';
const password = 'Synthetic-correct-harbor-42!';
let root: string, app: FastifyInstance, auth: OfficeAuthService, store: CompanyStore, company: CompanyService;
let owner: string, limited: string, key: Buffer, decisions: ServiceDecisions;
let n = 0;
const sessions = new Map();
const ctx = { sessions } as unknown as SessionPort;
const agentPassword = 'Synthetic-memory-API-credential-42!';
let authState: ReturnType<typeof registerAuthMiddleware>;
let memoryInstallation: MemoryInstallationData;

async function call(
  method: 'GET' | 'POST',
  url: string,
  token?: string,
  payload?: object,
  extra: Record<string, string> = {}
) {
  return app.inject({
    method,
    url,
    headers: {
      host: 'localhost',
      origin: 'http://localhost',
      ...(token ? { cookie: OWNER_COOKIE + '=' + token } : {}),
      ...extra,
    },
    ...(payload ? { payload } : {}),
  });
}
function cookieOf(response: Awaited<ReturnType<typeof call>>) {
  expect(response.statusCode, response.body).toBe(200);
  return response.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
}
async function signIn(username: string, temporary: string) {
  const initial = cookieOf(await call('POST', '/api/owner/login', undefined, { username, password: temporary }));
  return cookieOf(await call('POST', '/api/owner/password', initial, { current: temporary, next: password }));
}

beforeEach(async () => {
  vi.stubEnv('REVERIE_PASSWORD', agentPassword);
  vi.stubEnv('REVERIE_USERNAME', 'synthetic-api');
  sessions.clear();
  sessions.set(SESSION, { id: SESSION, pid: process.pid, name: 'Synthetic employee', mode: 'shell', status: 'idle' });
  root = fs.mkdtempSync(join(tmpdir(), 'service-grant-server-'));
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(join(root, 'nonces'), { mode: 0o700 });
  fs.writeFileSync(
    join(root, 'nonces/ledger.json'),
    JSON.stringify({
      version: 1,
      storeId: STORE_ID,
      capacity: 16,
      revision: 0,
      clockFloor: Date.now() - 60_000,
      entries: [],
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(join(root, 'nonces/ledger.json.lock'), '', { mode: 0o600 });
  key = randomBytes(32);
  fs.writeFileSync(join(root, 'ops.key'), key, { mode: 0o400 });
  fs.writeFileSync(join(root, 'memory.key'), randomBytes(32), { mode: 0o400 });
  fs.writeFileSync(
    join(root, 'service-auth.json'),
    JSON.stringify({
      version: 1,
      serviceUid: process.geteuid!(),
      purposes: {
        OPS_WEBSITE_RESTART: { scope: 'employees+resources', action: 'reverie.ops.website.restart' },
        MEMORY_READ: { scope: 'employees+resources', action: 'reverie.memory.read' },
      },
      principals: [
        { principal: 'ops', epoch: 'e1', key: join(root, 'ops.key') },
        { principal: 'memory-publisher', epoch: 'memory-e1', key: join(root, 'memory.key') },
      ],
      memoryScopes: {
        principal: 'memory-publisher',
        instances: [
          {
            instanceRef: 'existing-a',
            instanceId: 'default',
            guestConfigPathCodepoints: Array.from('/owned/guest-a/instance.json', (character) =>
              character.codePointAt(0)
            ),
            resources: [
              { resourceId: 'memory-private-a', scope: { kind: 'private' } },
              { resourceId: 'memory-project-a', scope: { kind: 'project', project: 'project-a' } },
            ],
          },
          {
            instanceRef: 'existing-b',
            instanceId: 'default',
            guestConfigPathCodepoints: Array.from('/owned/guest-b/instance.json', (character) =>
              character.codePointAt(0)
            ),
            resources: [{ resourceId: 'memory-private-b', scope: { kind: 'private' } }],
          },
        ],
      },
      setupGrants: [
        {
          purpose: 'OPS_WEBSITE_RESTART',
          principal: 'ops',
          employees: ['sam'],
          resources: ['website'],
          expiresInHours: 24,
        },
        {
          purpose: 'MEMORY_READ',
          principal: 'memory-publisher',
          employees: ['sam'],
          resources: ['memory-private-a'],
          expiresInHours: 24,
        },
      ],
    }),
    { mode: 0o600 }
  );
  store = new CompanyStore(join(root, 'company.json'));
  await store.init();
  await store.update((state) => {
    state.employees.push(
      EmployeeSchema.parse({
        id: 'sam',
        sessionId: SESSION,
        name: 'Sam',
        icon: 'B',
        position: 'QA',
        expertise: ['x'],
        createdAt: 1,
      })
    );
  });
  const ownerStore = new OwnerAuthStore(join(root, 'owner-auth.json'));
  const first = await bootstrap(ownerStore, 'fixture-owner', { enforce: true });
  auth = new OfficeAuthService({ store: ownerStore, auditFile: join(root, 'audit.jsonl') });
  const loaded = loadServiceAuthConfig(join(root, 'service-auth.json'));
  memoryInstallation = loaded.memoryScopes!.installation('existing-a')!;
  const custody = {
    assertPrivateCustody: (file: string) => {
      if (file !== store.file) throw new Error('custody');
    },
  };
  const nonce = {
    file: join(root, 'nonces/ledger.json'),
    storeId: STORE_ID,
    capacity: 16,
    flockExecutable: FLOCK,
    authorityNamespace: join(root, 'nonces/authority'),
    assertPrivateCustody: () => undefined,
  };
  // The actual assembly the WebServer builds, owner-only: Goal employee automation stays OFF.
  const goalBoundary = createGoalServerAssembly(auth, store.file, {
    kind: 'canonical-goal-provisioning',
    mode: 'owner-only',
    issuer: () => undefined,
    custody,
    nonce,
  });
  app = Fastify();
  await app.register(cookie);
  authState = registerAuthMiddleware(app, false, '', auth);
  goalBoundary.register(app);
  const rooms = new ChatroomStore(),
    room = rooms.create('fixture room', undefined);
  registerOwnerPolicy(app, {
    goalRequest: goalBoundary.authorizeRequest,
    service: auth,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: () => false,
      related: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  registerOwnerRoutes(app, auth, false);
  registerOfficeRoutes(app, auth, {
    rooms: () => rooms.list(),
    room: (id: string) => rooms.get(id),
    nameOf: () => 'Fixture',
    post: () => undefined,
  } as unknown as ChatroomService);
  company = new CompanyService(store, {
    goalAuthentication: goalBoundary.authentication,
    servicePurposes: loaded.purposes,
    memoryScopes: loaded.memoryScopes,
    getSession: (id) => sessions.get(id),
  } as CompanyServiceDeps);
  goalBoundary.attach(company, { getSession: (id) => sessions.get(id) }, { isRetired: () => false });
  registerServiceGrantRoutes(app, company.goals);
  registerServiceGrantSetupPage(app, { loaded, company, owner: goalBoundary.authentication });
  const shared = createServiceAuthorization(loaded, { company, custody: goalBoundary.authentication, nonce });
  decisions = new ServiceDecisions({ loaded, auth: shared.auth, binding: shared.source.binding });
  registerMemoryScopeRoutes(
    app,
    ctx,
    {
      company: (owner) => company.view(owner),
      agentSession: (request) => {
        const caller = callerOf(request, { service: auth, ctx });
        return caller.kind === 'agent' ? caller.session : undefined;
      },
    },
    new MemoryScopePublisher(shared)
  );
  await app.ready();
  owner = await signIn('fixture-owner', first.oneTimePassword);
  const invite = await call('POST', '/api/office/accounts', owner, {
    username: 'fixture-limited',
    name: 'Fixture Limited',
    role: 'limited',
    rooms: [room.id],
  });
  limited = await signIn('fixture-limited', invite.json().data.oneTimePassword);
});
afterEach(async () => {
  await app?.close();
  for (const disposable of Object.values(authState ?? {})) disposable?.dispose();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const body = () => ({
  purpose: 'OPS_WEBSITE_RESTART',
  principal: 'ops',
  epoch: 'e1',
  employeeIds: ['sam'],
  resources: ['website'],
  expiresAt: Date.now() + 60_000,
});

it('service grant routes are exact owner-only actions on the Goal boundary, never employee actions', () => {
  for (const [method, url, action] of [
    ['POST', '/api/service-grants', 'ISSUE_SERVICE_GRANT'],
    ['POST', '/api/service-grants/:id/revoke', 'REVOKE_SERVICE_GRANT'],
    ['GET', '/api/service-grants/setup', 'SERVICE_GRANT_SETUP'],
  ] as const) {
    expect(goalRouteAction({ method, routeOptions: { url } } as never)).toBe(action);
    expect(EMPLOYEE_GOAL_ACTIONS.has(action)).toBe(false);
  }
});

it('actual assembly with Goal automation OFF: setup, issue, decision and revoke work for the owner only', async () => {
  const setup = await call('GET', '/api/service-grants/setup', owner);
  expect(setup.statusCode, setup.body).toBe(200);
  expect(setup.body).toContain('Sam (sam)');
  for (const token of [undefined, limited])
    expect((await call('GET', '/api/service-grants/setup', token)).statusCode).toBeGreaterThanOrEqual(401);
  // Refused callers: no cookie, limited login, cross-origin owner, owner cookie plus Basic, service header, unknown purpose.
  expect((await call('POST', '/api/service-grants', undefined, body())).statusCode).toBeGreaterThanOrEqual(401);
  expect((await call('POST', '/api/service-grants', limited, body())).statusCode).toBe(403);
  expect(
    (await call('POST', '/api/service-grants', owner, body(), { origin: 'https://evil.example' })).statusCode
  ).toBe(403);
  expect((await call('POST', '/api/service-grants', owner, body(), { authorization: 'Basic eDp5' })).statusCode).toBe(
    403
  );
  expect(
    (await call('POST', '/api/service-grants', owner, body(), { [SERVICE_HEADER]: 'x' })).statusCode
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await call('POST', '/api/service-grants', owner, { ...body(), purpose: 'OPS_UNCONFIGURED' })).statusCode
  ).toBe(400);
  expect(store.snapshot().serviceGrants).toEqual([]);
  const issued = await call('POST', '/api/service-grants', owner, body());
  expect(issued.statusCode, issued.body).toBe(200);
  const grant = issued.json().data;
  expect(grant).toMatchObject({
    purpose: 'OPS_WEBSITE_RESTART',
    employees: [{ employeeId: 'sam', sessionId: SESSION }],
    resources: ['website'],
  });
  const assertion = () =>
    signServiceAssertion(key, {
      purpose: 'OPS_WEBSITE_RESTART',
      principal: 'ops',
      epoch: 'e1',
      ownerId: grant.owner ?? '',
      grantId: grant.id,
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 5000,
      nonce: (++n).toString(16).padStart(32, '0'),
    });
  const ask = { action: 'reverie.ops.website.restart', employeeId: 'sam', resourceId: 'website' };
  expect(await decisions.decide(assertion(), ask)).toMatchObject({ decision: 'allowed' });
  expect(await decisions.decide(assertion(), { ...ask, resourceId: 'other' })).toMatchObject({ decision: 'denied' });
  expect((await call('POST', `/api/service-grants/${grant.id}/revoke`, limited, {})).statusCode).toBe(403);
  expect((await call('POST', `/api/service-grants/unknown/revoke`, owner, {})).statusCode).toBe(403);
  expect((await call('POST', `/api/service-grants/${grant.id}/revoke`, owner, {})).statusCode).toBe(200);
  expect(await decisions.decide(assertion(), ask)).toBeNull();
});

const memoryGrant = () => ({
  purpose: 'MEMORY_READ',
  principal: 'memory-publisher',
  epoch: 'memory-e1',
  employeeIds: ['sam'],
  resources: ['memory-private-a'],
  expiresAt: Date.now() + 60_000,
});
const scopeRequest = () => ({
  instanceRef: 'existing-a',
  resourceId: 'memory-private-a',
  binding: { employeeId: 'sam', sessionId: SESSION, sessionGeneration: 1, ownerCodepoints: null },
});
const askScope = (payload: object, extra: Record<string, string> = {}) =>
  call('POST', '/api/agent/memory-scope', undefined, payload, {
    authorization: 'Basic ' + Buffer.from(`synthetic-api:${agentPassword}`).toString('base64'),
    'x-reverie-parent-session': SESSION,
    ...extra,
  });

it('real owner setup and canonical grant authorize only the live employee; revocation rejects the pinned subsequent use', async () => {
  const setup = await call('GET', '/api/service-grants/setup', owner);
  expect(setup.statusCode, setup.body).toBe(200);
  expect(setup.body).toContain('MEMORY_READ');
  expect((await askScope(scopeRequest())).statusCode).toBe(403); // installed DATA alone grants nothing
  expect((await call('POST', '/api/service-grants', limited, memoryGrant())).statusCode).toBe(403);
  const issued = await call('POST', '/api/service-grants', owner, memoryGrant());
  expect(issued.statusCode, issued.body).toBe(200);
  const first = await askScope(scopeRequest());
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().data).toMatchObject({
    instanceRef: 'existing-a',
    instanceId: 'default',
    resourceId: 'memory-private-a',
    scope: { kind: 'private' },
  });
  expect(JSON.stringify(first.json())).not.toMatch(/configPath|executable|\.key|\/run\//);
  const pinned = { ...scopeRequest(), expectedGrantRef: first.json().data.grantRef };
  expect((await askScope(pinned)).statusCode).toBe(200);
  expect((await call('POST', `/api/service-grants/${issued.json().data.id}/revoke`, owner, {})).statusCode).toBe(200);
  expect((await askScope(pinned)).statusCode).toBe(403);
});

it('memory issuance rejects Cartesian employee/instance ambiguity, unknown resources and stale publisher without writes', async () => {
  const before = store.snapshot().serviceGrants;
  for (const changed of [
    { employeeIds: ['sam', 'sam'] },
    { resources: ['memory-private-a', 'memory-private-b'] },
    { resources: ['unknown'] },
    { principal: 'ops' },
    { epoch: 'old-epoch' },
  ]) {
    const result = await call('POST', '/api/service-grants', owner, { ...memoryGrant(), ...changed });
    expect(result.statusCode, result.body).toBe(400);
    expect(store.snapshot().serviceGrants).toEqual(before);
  }
  // Existing instance IDs are not globally unique; distinct configured references preserve both, without renaming data.
  const a = await call('POST', '/api/service-grants', owner, memoryGrant());
  const b = await call('POST', '/api/service-grants', owner, { ...memoryGrant(), resources: ['memory-private-b'] });
  expect(a.statusCode, a.body).toBe(200);
  expect(b.statusCode, b.body).toBe(200);
  expect((await askScope(scopeRequest())).json().data.instanceId).toBe('default');
  const second = await askScope({ ...scopeRequest(), instanceRef: 'existing-b', resourceId: 'memory-private-b' });
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json().data.instanceId).toBe('default');
});

it('the actual API refuses foreign or stale context data, arbitrary selectors, missing credentials and unavailable issuer', async () => {
  expect((await call('POST', '/api/service-grants', owner, memoryGrant())).statusCode).toBe(200);
  for (const payload of [
    { ...scopeRequest(), instanceRef: 'other' },
    { ...scopeRequest(), binding: { ...scopeRequest().binding, employeeId: 'other' } },
    { ...scopeRequest(), binding: { ...scopeRequest().binding, sessionGeneration: 2 } },
  ])
    expect((await askScope(payload)).statusCode).toBe(403);
  for (const key of ['path', 'program', 'env', 'allow', 'ready'])
    expect((await askScope({ ...scopeRequest(), [key]: true })).statusCode).toBe(400);
  expect(
    (await askScope(scopeRequest(), { authorization: 'Basic ' + Buffer.from('wrong:credential').toString('base64') }))
      .statusCode
  ).toBe(401);
  expect((await call('POST', '/api/agent/memory-scope', owner, scopeRequest())).statusCode).toBe(403);
  fs.chmodSync(join(root, 'memory.key'), 0o640);
  expect((await askScope(scopeRequest())).statusCode).toBe(403);
  fs.chmodSync(join(root, 'memory.key'), 0o400);
  await store.update((state) => {
    state.employees[0]!.sessionGeneration = 2;
  });
  expect((await askScope(scopeRequest())).statusCode).toBe(403);
});

it.runIf(Boolean(process.env.NIX_REVERIE_TEST_MEMORY_CLI))(
  'actual scoped native read accepts opaque Company identity independent of legacy metadata and leaves data unchanged',
  async () => {
    const program = process.env.NIX_REVERIE_TEST_MEMORY_CLI!;
    const native = InstalledMemoryBridge.capture(program, NAMESPACE_SETTINGS);
    const namespace = await InstalledMemoryNamespace.prepare(root, program, memoryInstallation, scopeRequest().binding);
    try {
      namespace.seedExistingHistory();
      const before = await namespace.snapshot();
      expect(JSON.parse(before[2]!.toString()).employee_id).toBe('33333333-3333-4333-8333-333333333333');
      expect(namespace.context.employee.employeeId).toBe('sam');
      expect((await call('POST', '/api/service-grants', owner, memoryGrant())).statusCode).toBe(200);
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      const access = installedMemoryAccess(namespace.context, {
        apiUrl: url,
        selfId: SESSION,
        auth: { username: 'synthetic-api', password: agentPassword },
      });
      let checks = 0;
      const tools = createMemoryTools(
        { native, installed: namespace.context },
        namespace.run,
        undefined,
        async (...args) => {
          checks++;
          return access(...args);
        }
      );
      const result = await tools.run('memory_recall', { query: 'Synthetic namespace' });
      expect(result.isError, result.text).not.toBe(true);
      expect(JSON.parse(result.text).some((row: { text: string }) => row.text === NAMESPACE_HISTORY)).toBe(true);
      expect(checks).toBe(2);
      expect(namespace.invocationCount()).toBe(1);
      expect(await namespace.snapshot()).toEqual(before);
    } finally {
      await namespace.close();
    }
  },
  30_000
);

it.runIf(Boolean(process.env.NIX_REVERIE_TEST_MEMORY_CLI))(
  'matching legacy metadata grants nothing: actual API rejects wrong actor/path/grant and withholds a revoked native result',
  async () => {
    const program = process.env.NIX_REVERIE_TEST_MEMORY_CLI!;
    const native = InstalledMemoryBridge.capture(program, NAMESPACE_SETTINGS);
    const namespace = await InstalledMemoryNamespace.prepare(root, program, memoryInstallation, scopeRequest().binding);
    try {
      namespace.seedExistingHistory();
      const before = await namespace.snapshot();
      const legacyId = JSON.parse(before[2]!.toString()).employee_id;
      expect(
        (await askScope({ ...scopeRequest(), binding: { ...scopeRequest().binding, employeeId: legacyId } })).statusCode
      ).toBe(403);
      expect(
        (await askScope({ ...scopeRequest(), path: '/another/instance.json', employee_id: legacyId })).statusCode
      ).toBe(400);
      expect((await askScope(scopeRequest())).statusCode).toBe(403);
      expect(namespace.invocationCount()).toBe(0);
      const issued = await call('POST', '/api/service-grants', owner, memoryGrant());
      expect(issued.statusCode, issued.body).toBe(200);
      const otherSession = '44444444-4444-4444-8444-444444444444';
      sessions.set(otherSession, {
        id: otherSession,
        pid: process.pid,
        name: 'Matching metadata only',
        mode: 'shell',
        status: 'idle',
      });
      await store.update((state) => {
        state.employees.push(
          EmployeeSchema.parse({
            id: legacyId,
            sessionId: otherSession,
            sessionGeneration: 1,
            name: 'Matching metadata only',
            icon: 'X',
            position: 'Engineer',
            expertise: ['Synthetic'],
            createdAt: 1,
            desiredRunning: true,
          })
        );
      });
      const matchingMetadata = {
        ...scopeRequest(),
        binding: { ...scopeRequest().binding, employeeId: legacyId, sessionId: otherSession },
      };
      expect((await askScope(matchingMetadata, { 'x-reverie-parent-session': otherSession })).statusCode).toBe(403);
      expect(namespace.invocationCount()).toBe(0);
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      const access = installedMemoryAccess(namespace.context, {
        apiUrl: url,
        selfId: SESSION,
        auth: { username: 'synthetic-api', password: agentPassword },
      });
      const tools = createMemoryTools(
        { native, installed: namespace.context },
        async (...args) => {
          const actual = await namespace.run(...args);
          expect(actual.code, actual.stderr).toBe(0);
          expect(actual.stdout).toContain(NAMESPACE_HISTORY);
          const revoked = await call('POST', `/api/service-grants/${issued.json().data.id}/revoke`, owner, {});
          expect(revoked.statusCode, revoked.body).toBe(200);
          return actual;
        },
        undefined,
        access
      );
      await expect(tools.run('memory_recall', { query: 'Synthetic namespace' })).rejects.toThrow(
        'Memory scope unavailable'
      );
      expect(namespace.invocationCount()).toBe(1);
      expect(await namespace.snapshot()).toEqual(before);
    } finally {
      await namespace.close();
    }
  },
  30_000
);
