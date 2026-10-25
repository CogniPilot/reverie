/** Kit AUTH-ROUTE1/REG1: the ACTUAL WebServer composition. Real OfficeAuthService accounts (owner and limited), real owner
 * policy, the real createGoalServerAssembly in owner-only mode (Goal automation OFF), CompanyService.goals carrying the ONE
 * configured registry, the service grant routes and setup page on that facade and boundary, and the service decision on
 * the same store. Synthetic fixtures only. */
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerOwnerPolicy, OWNER_COOKIE, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { registerOfficeRoutes } from '../src/web/routes/office-routes.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import type { ChatroomService } from '../src/chatroom-service.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { createGoalServerAssembly } from '../src/goal-server-assembly.js';
import { EMPLOYEE_GOAL_ACTIONS, goalRouteAction } from '../src/goal-route-policy.js';
import { loadServiceAuthConfig } from '../src/service-auth-config.js';
import {
  createServiceDecisions,
  registerServiceGrantRoutes,
  registerServiceGrantSetupPage,
  type ServiceDecisions,
} from '../src/service-decision.js';
import { signServiceAssertion } from '../src/service-grant-auth.js';

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
  fs.writeFileSync(
    join(root, 'service-auth.json'),
    JSON.stringify({
      version: 1,
      serviceUid: process.geteuid!(),
      purposes: { OPS_WEBSITE_RESTART: { scope: 'employees+resources', action: 'reverie.ops.website.restart' } },
      principals: [{ principal: 'ops', epoch: 'e1', key: join(root, 'ops.key') }],
      setupGrants: [
        {
          purpose: 'OPS_WEBSITE_RESTART',
          principal: 'ops',
          employees: ['bev'],
          resources: ['website'],
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
        id: 'bev',
        sessionId: SESSION,
        name: 'Bev',
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
  goalBoundary.register(app);
  const rooms = new ChatroomStore(),
    room = rooms.create('fixture room', undefined);
  registerOwnerPolicy(app, {
    goalRequest: goalBoundary.authorizeRequest,
    service: auth,
    ctx: { sessions: new Map() } as unknown as SessionPort,
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
  } as CompanyServiceDeps);
  goalBoundary.attach(company, { getSession: () => undefined }, { isRetired: () => false });
  registerServiceGrantRoutes(app, company.goals);
  registerServiceGrantSetupPage(app, { loaded, company, owner: goalBoundary.authentication });
  decisions = createServiceDecisions(loaded, { company, custody: goalBoundary.authentication, nonce });
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
  fs.rmSync(root, { recursive: true, force: true });
});

const body = () => ({
  purpose: 'OPS_WEBSITE_RESTART',
  principal: 'ops',
  epoch: 'e1',
  employeeIds: ['bev'],
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
  expect(setup.body).toContain('Bev (bev)');
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
    employees: [{ employeeId: 'bev', sessionId: SESSION }],
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
  const ask = { action: 'reverie.ops.website.restart', employeeId: 'bev', resourceId: 'website' };
  expect(await decisions.decide(assertion(), ask)).toMatchObject({ decision: 'allowed' });
  expect(await decisions.decide(assertion(), { ...ask, resourceId: 'other' })).toMatchObject({ decision: 'denied' });
  expect((await call('POST', `/api/service-grants/${grant.id}/revoke`, limited, {})).statusCode).toBe(403);
  expect((await call('POST', `/api/service-grants/unknown/revoke`, owner, {})).statusCode).toBe(403);
  expect((await call('POST', `/api/service-grants/${grant.id}/revoke`, owner, {})).statusCode).toBe(200);
  expect(await decisions.decide(assertion(), ask)).toBeNull();
});
