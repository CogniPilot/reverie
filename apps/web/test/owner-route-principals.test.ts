import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import {
  registerOwnerPolicy,
  SERVICE_HEADER,
  OWNER_COOKIE,
  callerOf,
  classify,
  allowed,
} from '../src/owner-auth/policy.js';
import { ownerVerifier, serviceVerifier } from '../src/owner-auth/marks.js';
import * as admin from '../src/owner-auth/admin.js';
import { registerCompanyRoutes } from '../src/web/routes/company-routes.js';
import { registerPlansRoutes } from '../src/web/routes/plans-routes.js';
import { registerBoardRoutes } from '../src/web/routes/board-routes.js';
import { BoardStore } from '../src/board-store.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import * as subscriptions from '../src/subscription-profiles.js';
import { registerSubscriptionProfileRoutes } from '../src/web/routes/subscription-profile-routes.js';
import { registerExpertRoutes } from '../src/web/routes/expert-routes.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { createMockRouteContext } from './mocks/index.js';
import { Session } from '../src/session.js';
import { registerLaptopPowerRoutes } from '../src/web/routes/laptop-power-routes.js';
vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: vi.fn(async () => {}) }));
let boardRef: BoardStore;
let storeRef: OwnerAuthStore;
let dir: string, app: any, service: OwnerAuthService, token: string, ownerToken: string, restricted: string;
let wakeCalls = 0,
  rebindCalls = 0,
  powerCalls = 0,
  placementCalls = 0;
let routineCalls = 0;
const observations: any[] = [];
const ctx = createMockRouteContext();
ctx.sessions.clear();
const expertLoad = vi.fn(async () => {});
const headers = () => ({ [SERVICE_HEADER]: token });
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owner-principal-synthetic-'));
  const store = new OwnerAuthStore(join(dir, 'owner.json'));
  storeRef = store;
  const boot = await admin.bootstrap(store, 'synthetic-owner', { enforce: true });
  token = await admin.issueServiceToken(store, 'synthetic-service');
  service = new OwnerAuthService({ store, auditFile: join(dir, 'owner-audit.jsonl') });
  restricted = (await service.login('synthetic-owner', boot.oneTimePassword, '127.0.0.1')).session!;
  ownerToken = await service.changePassword(
    restricted,
    { current: boot.oneTimePassword, next: 'synthetic-correct-horse-42' },
    '127.0.0.1'
  );
  app = Fastify();
  await app.register(cookie);
  registerOwnerPolicy(app, {
    service,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: () => false,
      related: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    } as any,
  });
  registerCompanyRoutes(
    app,
    ctx,
    {
      view: () => ({ employees: [{ id: 'employee', name: 'Synthetic', onVacation: false }], settings: {} }),
      rebind: async () => {
        rebindCalls++;
        return { id: 'employee' };
      },
    } as any,
    undefined,
    undefined,
    async () => {
      wakeCalls++;
      return { ready: true };
    },
    { verifiedOwner: ownerVerifier({ service, ctx }), serviceRebind: serviceVerifier({ service, ctx }, 'watcher') }
  );
  registerPlansRoutes(
    app,
    {
      plans: async () => ({ accounts: [{ id: 'synthetic-other-account', sessions: [] }], gpu: { synthetic: true } }),
    } as any,
    undefined,
    undefined,
    ownerVerifier({ service, ctx })
  );
  const board = new BoardStore(join(dir, 'board.json'));
  boardRef = board;
  await board.init();
  registerBoardRoutes(app, ctx, {
    verifiedOwner: ownerVerifier({ service, ctx }),
    store: board,
    company: () => ({ employees: [], settings: { timeZone: 'UTC', ownerName: 'Synthetic' } }),
    rooms: () => [],
    audit: async () => {},
  });
  const room = {
    id: 'room',
    name: 'Private room sentinel',
    members: [{ sessionId: 'synthetic-member', goal: 'Private goal sentinel' }],
    messages: [{ text: 'Private message sentinel' }],
    owner: undefined,
  };
  registerChatroomRoutes(
    app,
    ctx,
    {
      room: () => room,
      rooms: () => [room],
      deliveryStatus: () => ({ pending: 3 }),
      placeRoom: () => {
        placementCalls++;
        return room;
      },
      view: (r: any) => r,
    } as any,
    {} as any,
    ownerVerifier({ service, ctx }),
    undefined,
    undefined,
    { pendingStatus: serviceVerifier({ service, ctx }, 'stall-watch') }
  );
  registerSubscriptionProfileRoutes(
    app,
    { read: async () => ({}) } as any,
    async () => [],
    ownerVerifier({ service, ctx }),
    (req) => ['plan-usage', 'routines'].some((name) => serviceVerifier({ service, ctx }, name)(req))
  );
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic/broker.sock');
  registerLaptopPowerRoutes(app, {
    verifiedOwner: ownerVerifier({ service, ctx }),
    stopIntent: async () => {
      throw Error('must not stop live laptops');
    },
    power: async (action) => {
      powerCalls++;
      return { synthetic: true, action };
    },
  });
  registerSessionRoutes(app, ctx, { verifiedOwner: ownerVerifier({ service, ctx }) });
  registerExpertRoutes(app, {
    verifiedOwner: ownerVerifier({ service, ctx }),
    store: { load: expertLoad, snapshot: () => ({ templates: [], hires: [], settings: { hireDelegates: [] } }) },
    callerSession: () => undefined,
    budgetCheckEveryMs: 0,
    sessionExists: () => false,
  } as any);
  const verify = ownerVerifier({ service, ctx });
  app.get('/api/chatrooms/_verify-owner', async (req: any, reply: any) =>
    verify(req) ? { owner: true } : reply.code(403).send({ owner: false })
  );
  app.post('/api/cron/jobs', async () => {
    routineCalls++;
    return { success: true };
  });
  await app.ready();
}, 30000);
afterAll(async () => {
  await writeFile(join(dir, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
  await app?.close();
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it('refuses headerless service reaching company owner capability and wake branch', async () => {
  const view = await app.inject({ url: '/api/company', headers: headers() });
  expect(view.statusCode).toBe(200);
  expect(view.json().data.canManage).toBe(false);
  const r = await app.inject({
    method: 'POST',
    url: '/api/company/employees/employee/wake',
    headers: headers(),
    payload: {},
  });
  expect(r.statusCode, r.body).toBe(403);
  expect(wakeCalls).toBe(0);
  observations.push({
    route: 'POST /api/company/employees/:id/wake',
    status: r.statusCode,
    stubCalls: wakeCalls,
    canManage: view.json().data.canManage,
  });
});
it('refuses headerless service reaching rebind as owner (service route needs explicit separate intent)', async () => {
  const r = await app.inject({
    method: 'PUT',
    url: '/api/company/employees/employee/session',
    headers: headers(),
    payload: { sessionId: 'synthetic' },
  });
  expect(r.statusCode, r.body).toBe(403);
  expect(rebindCalls).toBe(0);
  observations.push({ route: 'PUT /api/company/employees/:id/session', status: r.statusCode, stubCalls: rebindCalls });
});
it('refuses headerless service seeing all plan accounts and GPU', async () => {
  const r = await app.inject({ url: '/api/plans', headers: headers() });
  expect(r.statusCode, r.body).toBe(403);
  expect(r.body).not.toContain('synthetic-other-account');
  expect(r.body).not.toContain('gpu');
  observations.push({ route: 'GET /api/plans', status: r.statusCode, unscopedAccounts: true, gpu: true });
});
it('refuses service filing planned board work as owner, not member triage', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/board/issues',
    headers: headers(),
    payload: { title: 'Synthetic finding fixture', status: 'doing' },
  });
  expect(r.statusCode, r.body).toBe(403);
  expect(r.body).not.toContain('Synthetic finding fixture');
  observations.push({ route: 'POST /api/board/issues', status: r.statusCode, refused: true });
});
it('refuses headerless service reaching owner-only room placement', async () => {
  const r = await app.inject({
    method: 'PUT',
    url: '/api/chatrooms/room/placement',
    headers: headers(),
    payload: { workspace: 'Synthetic', category: 'Fixture' },
  });
  expect(r.statusCode, r.body).toBe(403);
  expect(placementCalls).toBe(0);
  observations.push({ route: 'PUT /api/chatrooms/:id/placement', status: r.statusCode, stubCalls: placementCalls });
});
it('refuses headerless service reaching restart-website with no maintenance-session identity', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/system/restart-website',
    headers: headers(),
    payload: { confirmed: true },
  });
  expect(r.statusCode, r.body).toBe(403);
  expect(powerCalls).toBe(0);
  observations.push({
    route: 'POST /api/system/restart-website',
    status: r.statusCode,
    stubCalls: powerCalls,
    note: 'broker permission not tested; power stub only',
  });
});
it('ownerVerifier already refuses service and missing auth and accepts full owner', async () => {
  expect(callerOf({ headers: headers(), cookies: {} } as any, { service, ctx }).kind).toBe('service');
  for (const h of [headers(), {}, { [SERVICE_HEADER]: 'synthetic-invalid' }])
    expect((await app.inject({ url: '/api/chatrooms/_verify-owner', headers: h })).statusCode).toBe(
      h[SERVICE_HEADER] === token ? 403 : 401
    );
  const r = await app.inject({ url: '/api/chatrooms/_verify-owner', cookies: { [OWNER_COOKIE]: ownerToken } });
  expect(r.statusCode, r.body).toBe(200);
  observations.push({ helper: 'ownerVerifier', service: false, anonymous: false, invalid: false, fullOwner: true });
});
it('separates middleware-contained idioms from reachable service paths', () => {
  for (const [method, route] of [
    ['PUT', '/api/company/employees/:id'],
    ['PUT', '/api/workspace-icons/image'],
    ['PUT', '/api/chat-bots/:id'],
    ['GET', '/api/agents/:id/profile'],
    ['POST', '/api/system/shutdown'],
  ])
    expect(allowed(classify(method, route, route), 'service'), route).toBe(false);
  for (const [method, route] of [
    ['POST', '/api/experts/:id/hire'],
    ['POST', '/api/experts/:id/retire'],
    ['GET', '/api/company'],
    ['GET', '/api/plans'],
    ['POST', '/api/board/issues'],
    ['PATCH', '/api/board/issues/:id'],
    ['PUT', '/api/chatrooms/:id/archive'],
    ['POST', '/api/system/restart-website'],
  ])
    expect(allowed(classify(method, route, route), 'service'), route).toBe(true);
});

const ownerHeaders = () => ({ origin: 'http://localhost', host: 'localhost' });
const ownerCookies = () => ({ [OWNER_COOKIE]: ownerToken });
it('refuses services at the exact routine middleware gate before any handler runs', async () => {
  expect(classify('POST', '/api/cron/jobs', '/api/cron/jobs')).toBe('agent');
  const prior = routineCalls;
  const owner = await app.inject({
    method: 'POST',
    url: '/api/cron/jobs',
    headers: ownerHeaders(),
    cookies: ownerCookies(),
    payload: {},
  });
  expect(owner.statusCode).toBe(200);
  expect(routineCalls).toBe(prior + 1);
  for (const requestHeaders of [headers(), { ...headers(), 'x-reverie-parent-session': 'unresolved' }]) {
    const denied = await app.inject({ method: 'POST', url: '/api/cron/jobs', headers: requestHeaders, payload: {} });
    expect(denied.statusCode, denied.body).toBe(403);
  }
  expect(routineCalls).toBe(prior + 1);
});
it('full owner retains the six operations with real same-origin owner authentication', async () => {
  const view = await app.inject({ url: '/api/company', cookies: ownerCookies() });
  expect(view.statusCode).toBe(200);
  expect(view.json().data.canManage).toBe(true);
  const requests = [
    { method: 'POST', url: '/api/company/employees/employee/wake', payload: {} },
    { method: 'PUT', url: '/api/company/employees/employee/session', payload: { sessionId: 'synthetic' } },
    { method: 'GET', url: '/api/plans' },
    { method: 'POST', url: '/api/board/issues', payload: { title: 'Owner fixture', status: 'doing' } },
    { method: 'PUT', url: '/api/chatrooms/room/placement', payload: { workspace: 'Synthetic' } },
    { method: 'POST', url: '/api/system/restart-website', payload: { confirmed: true } },
  ];
  for (const req of requests) {
    const r = await app.inject({ ...req, headers: ownerHeaders(), cookies: ownerCookies() });
    expect(r.statusCode, r.body).toBe(200);
  }
  expect([wakeCalls, rebindCalls, placementCalls, powerCalls]).toEqual([1, 1, 1, 1]);
});
it('other credentials and mixed service/agent headers cannot enter owner branches or mutate anything', async () => {
  const requests = [
    { method: 'POST', url: '/api/company/employees/employee/wake', payload: {} },
    { method: 'PUT', url: '/api/company/employees/employee/session', payload: { sessionId: 'synthetic' } },
    { method: 'GET', url: '/api/plans' },
    { method: 'POST', url: '/api/board/issues', payload: { title: 'Denied fixture', status: 'doing' } },
    { method: 'PUT', url: '/api/chatrooms/room/placement', payload: { category: 'Denied' } },
    { method: 'GET', url: '/api/chatrooms/room' },
    { method: 'POST', url: '/api/system/restart-website', payload: { confirmed: true } },
  ];
  const before = [wakeCalls, rebindCalls, placementCalls, powerCalls];
  const beforeBoard = structuredClone(boardRef.snapshot());
  for (const req of requests) {
    for (const h of [
      {},
      headers(),
      { ...headers(), 'x-reverie-parent-session': 'not-an-owner' },
      { [SERVICE_HEADER]: 'invalid' },
    ]) {
      const r = await app.inject({ ...req, headers: h });
      expect([401, 403]).toContain(r.statusCode);
    }
    const cross = await app.inject({
      ...req,
      headers: { origin: 'http://wrong.test', host: 'localhost' },
      cookies: ownerCookies(),
    });
    if (req.method !== 'GET') expect(cross.statusCode).toBe(403);
  }
  expect([wakeCalls, rebindCalls, placementCalls, powerCalls]).toEqual(before);
  expect(boardRef.snapshot()).toEqual(beforeBoard);
});
it('only explicitly named watcher service can perform scoped rebind and never gets owner capabilities', async () => {
  const named = await admin.issueServiceToken(storeRef, 'watcher');
  const h = { [SERVICE_HEADER]: named };
  const before = rebindCalls;
  const ok = await app.inject({
    method: 'PUT',
    url: '/api/company/employees/employee/session',
    headers: h,
    payload: { sessionId: 'synthetic' },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  expect(rebindCalls).toBe(before + 1);
  expect((await app.inject({ url: '/api/company', headers: h })).json().data.canManage).toBe(false);
  for (const [url, payload] of [
    ['/api/company/employees/employee/wake', {}],
    ['/api/board/issues', { title: 'Denied watcher' }],
    ['/api/system/restart-website', { confirmed: true }],
  ])
    expect((await app.inject({ method: 'POST', url, headers: h, payload })).statusCode).toBe(403);
});

it('headerless and mixed-header services cannot hire, retire or pin a runtime, before loading state or launching anything', async () => {
  const interactive = vi
    .spyOn(Session.prototype, 'startInteractive')
    .mockRejectedValue(new Error('Unexpected launch tripwire'));
  const shell = vi.spyOn(Session.prototype, 'startShell').mockRejectedValue(new Error('Unexpected launch tripwire'));
  const before = ctx.sessions.size;
  expertLoad.mockClear();
  try {
    for (const h of [headers(), { ...headers(), 'x-reverie-parent-session': 'unknown' }]) {
      for (const [url, payload] of [
        ['/api/experts/template/hire', { workingDir: dir }],
        ['/api/experts/template/retire', { sessionId: 'synthetic' }],
        ['/api/quick-start', { pinned: true, caseName: 'synthetic', mode: 'shell' }],
      ]) {
        const r = await app.inject({ method: 'POST', url, headers: h, payload });
        expect(r.statusCode, r.body).toBe(403);
      }
    }
    expect(expertLoad).not.toHaveBeenCalled();
    expect(ctx.sessions.size).toBe(before);
    expect(interactive).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
  } finally {
    interactive.mockRestore();
    shell.mockRestore();
  }
});
it('named service grants refuse mixed identities and other service names', async () => {
  const verify = serviceVerifier({ service, ctx }, 'watcher');
  const named = await admin.issueServiceToken(storeRef, 'watcher');
  expect(verify({ headers: { [SERVICE_HEADER]: named }, cookies: {} } as any)).toBe(true);
  expect(verify({ headers: headers(), cookies: {} } as any)).toBe(false);
  expect(
    verify({ headers: { [SERVICE_HEADER]: named, 'x-reverie-parent-session': 'unknown' }, cookies: {} } as any)
  ).toBe(false);
  expect(verify({ headers: { [SERVICE_HEADER]: named }, cookies: ownerCookies() } as any)).toBe(false);
});

it('local owner boundaries remain strict in log and off policies', async () => {
  const before = [wakeCalls, rebindCalls, placementCalls, powerCalls];
  const boardBefore = structuredClone(boardRef.snapshot());
  try {
    for (const policy of ['log', 'off'] as const) {
      await admin.setPolicy(storeRef, policy, { forceLockoutRisk: true });
      for (const [method, url, payload] of [
        ['POST', '/api/company/employees/employee/wake', {}],
        ['PUT', '/api/company/employees/employee/session', { sessionId: 'synthetic' }],
        ['GET', '/api/plans', undefined],
        ['POST', '/api/board/issues', { title: 'Refused service' }],
        ['PUT', '/api/chatrooms/room/placement', { category: 'Refused' }],
        ['GET', '/api/chatrooms/room', undefined],
        ['POST', '/api/system/restart-website', { confirmed: true }],
        ['POST', '/api/experts/template/hire', { workingDir: dir }],
        ['POST', '/api/experts/template/retire', { sessionId: 'synthetic' }],
        ['POST', '/api/quick-start', { pinned: true, mode: 'shell' }],
      ] as const) {
        const r = await app.inject({ method, url, headers: headers(), payload });
        expect(r.statusCode, `${policy} ${url}: ${r.body}`).toBe(403);
      }
    }
  } finally {
    await admin.setPolicy(storeRef, 'enforce', { forceLockoutRisk: true });
  }
  expect([wakeCalls, rebindCalls, placementCalls, powerCalls]).toEqual(before);
  expect(boardRef.snapshot()).toEqual(boardBefore);
});

it('stall-watch can read aggregate pending counts without private room data or any room authority', async () => {
  const named = await admin.issueServiceToken(storeRef, 'stall-watch');
  const h = { [SERVICE_HEADER]: named };
  const r = await app.inject({ url: '/api/chatrooms', headers: h });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data).toEqual({
    serviceView: 'pending-deliveries',
    rooms: [{ members: [{ sessionId: 'synthetic-member', pendingDeliveries: 3 }] }],
  });
  for (const value of [
    'Private room sentinel',
    'Private goal sentinel',
    'Private message sentinel',
    'ownerNames',
    'retired',
  ])
    expect(r.body).not.toContain(value);
  for (const url of ['/api/chatrooms/room', '/api/chatrooms/room/messages', '/api/chatrooms/room/files/file'])
    expect((await app.inject({ url, headers: h })).statusCode).toBe(403);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/chatrooms/room/placement',
        headers: h,
        payload: { category: 'Refused' },
      })
    ).statusCode
  ).toBe(403);
});
it('named usage readers get only the usage operation; generic services and mixed identities are refused', async () => {
  const read = vi.spyOn(subscriptions, 'readSubscriptionProfiles').mockResolvedValue([]);
  try {
    for (const name of ['plan-usage', 'routines']) {
      const named = await admin.issueServiceToken(storeRef, name);
      const h = { [SERVICE_HEADER]: named };
      expect((await app.inject({ url: '/api/subscription-profiles/usage', headers: h })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/subscription-profiles', headers: h })).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            url: '/api/subscription-profiles/usage',
            headers: { ...h, 'x-reverie-parent-session': 'unknown' },
          })
        ).statusCode
      ).toBe(403);
    }
    const before = read.mock.calls.length;
    expect((await app.inject({ url: '/api/subscription-profiles/usage', headers: headers() })).statusCode).toBe(403);
    expect(read).toHaveBeenCalledTimes(before);
  } finally {
    read.mockRestore();
  }
});
it('host service grants fail closed in multi-user mode', async () => {
  const named = await admin.issueServiceToken(storeRef, 'watcher');
  vi.stubEnv('REVERIE_MULTIUSER', '1');
  try {
    expect(
      serviceVerifier({ service, ctx }, 'watcher')({ headers: { [SERVICE_HEADER]: named }, cookies: {} } as any)
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/synthetic/broker.sock');
  }
});
