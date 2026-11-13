import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import {
  withDelegatedSessionCreate,
  withDelegatedSessionStart,
  claimDelegatedSessionCreate,
  consumeDelegatedSessionCreate,
  delegatedSessionStartAdmission,
} from '../src/owner-auth/delegated-session-create.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { sessionCreateAdmission, withSessionCreateAdmission } from '../src/owner-auth/session-create-admission.js';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import { CASES_DIR } from '../src/web/route-helpers.js';
import { registerSubscriptionProfileRoutes } from '../src/web/routes/subscription-profile-routes.js';
import { SubscriptionUsageReader } from '../src/subscription-usage.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { installResponseEnvelope } from '../src/web/response-envelope.js';

function replacementContext(server: WebServer) {
  // Test-only access retains the real inferred ports. This server never listens,
  // restores sessions or starts providers; the tested app registers its own routes.
  const actual = server['createRouteContext']();
  return {
    ...actual,
    sessions: server['sessions'],
    addSession: vi.fn(actual.addSession),
    cleanupSession: vi.fn(actual.cleanupSession),
    setupSessionListeners: vi.fn(async () => {}),
    persistSessionState: vi.fn(),
    persistSessionStateNow: vi.fn(),
    getGlobalNiceConfig: vi.fn(async () => undefined),
    getWorkspaceHooksEnabled: vi.fn(async () => false),
    getAgentSkillEnabled: vi.fn(async () => false),
  };
}

describe('existing employee replacement through real owner policy and Session routes', () => {
  let app: FastifyInstance, directory: string, casePath: string, caseName: string;
  let ctx: ReturnType<typeof replacementContext>,
    company: CompanyService,
    companyStore: CompanyStore,
    fixtureServer: WebServer;
  let ownerCookie: string, employeeId: string;
  let start: MockInstance<Session['startInteractive']>;
  const retained: string[] = [];
  const ownedSources: Session[] = [];
  const replaceRooms = vi.fn(async (): Promise<Array<{ id: string; name: string }>> => []);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'replacement-admission-'));
    vi.stubEnv('REVERIE_MULTIUSER', '0');
    vi.stubEnv('REVERIE_DATA_DIR', join(directory, 'data'));
    const service = new OwnerAuthService({
      store: new OwnerAuthStore(join(directory, 'owner.json')),
      auditFile: join(directory, 'owner-audit.jsonl'),
      setupEnabled: true,
    });
    ownerCookie = await service.setup(
      'fixture_owner',
      'synthetic-permanent-forest-72',
      'synthetic-permanent-forest-72',
      '127.0.0.1'
    );
    fixtureServer = new WebServer(0, false, true);
    ctx = replacementContext(fixtureServer);
    const source = new Session({ id, workingDir: directory, mode: 'claude' });
    ownedSources.push(source);
    ctx.sessions.set(id, source);
    companyStore = new CompanyStore(join(directory, 'company.json'));
    await companyStore.init();
    company = new CompanyService(companyStore, {
      getSession: (sid) => ctx.sessions.get(sid),
      chatrooms: {
        rooms: () => [],
        room: () => undefined,
        addMember: () => {
          throw new Error('Unexpected room join');
        },
        setStatus: () => {
          throw new Error('Unexpected room status');
        },
        replaceSession: replaceRooms,
      },
      research: {
        start: async () => {
          throw new Error('Unexpected research start');
        },
        inspect: async () => undefined,
        stop: async () => {},
      },
    });
    employeeId = (
      await company.hire({
        name: 'Reviewer',
        icon: 'R',
        position: 'Reviewer',
        expertise: ['systems'],
        sessionId: id,
        researchEnabled: false,
      })
    ).id;
    caseName = `replacement-${randomUUID()}`;
    casePath = join(CASES_DIR, caseName);
    await mkdir(casePath, { recursive: true });
    await mkdir(join(directory, 'data'), { recursive: true });
    await writeFile(
      join(directory, 'data', 'subscription-profiles.json'),
      JSON.stringify([
        {
          id: 'alternate-account',
          label: 'Alternate',
          provider: 'anthropic',
          configDir: join(directory, 'account'),
          openCodeDataDir: join(directory, 'opencode'),
        },
      ])
    );
    app = Fastify();
    await app.register(cookie);
    installResponseEnvelope(app, '');
    registerOwnerPolicy(app, {
      service,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: (sid) => ctx.sessions.has(sid),
        related: (a, b) => a === b,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
        coordinated: () => false,
      },
    });
    const verifiedOwner = ownerVerifier({ service, ctx });
    registerSubscriptionProfileRoutes(app, new SubscriptionUsageReader('fixture'), async () => [], verifiedOwner);
    registerSessionRoutes(app, ctx, { company, verifiedOwner });
    installRouteErrorHandler(app);
    await app.ready();
    // This suite exercises API authority/publication only, never provider or tmux effects.
    start = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await app?.close();
    for (const session of new Set([...ownedSources.splice(0), ...ctx.sessions.values()])) await session.stop(false);
    await fixtureServer.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (casePath) await rm(casePath, { recursive: true, force: true });
    // Lifecycle logging has its own existing async writer; retain owned roots
    // until the whole suite has stopped submitting writes.
    retained.push(directory);
    replaceRooms.mockReset();
  });
  afterAll(async () => {
    for (const root of retained) await rm(root, { recursive: true, force: true });
  });
  const creation = () => ({
    employeeId,
    workingDir: casePath,
    mode: 'claude',
    parentSessionId: id,
    subscriptionProfileId: 'alternate-account',
  });
  const approved = <T,>(body: unknown, authorized: () => boolean, run: () => Promise<T>) =>
    withDelegatedSessionCreate({ sessionId: id, owner: undefined, payload: body, authorized }, run);
  const injectCreation = (body = creation()) =>
    app.inject({ method: 'POST', url: '/api/sessions', headers: { 'x-reverie-parent-session': id }, payload: body });
  it.each([false, true])('refuses direct self quick-start replacement even with Move own plan=%s', async (granted) => {
    await company.update(employeeId, undefined, { permissions: { moveOwnPlan: granted } }, () => {});
    const before = companyStore.snapshot();
    const response = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      headers: { 'x-reverie-parent-session': id },
      payload: { employeeId, caseName, mode: 'claude', subscriptionProfileId: 'alternate-account' },
    });
    expect(response.statusCode).toBe(403);
    expect(ctx.addSession).not.toHaveBeenCalled();
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.getWorkspaceHooksEnabled).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(companyStore.snapshot()).toEqual(before);
    expect(await readdir(casePath)).toEqual([]);
  });
  it('preserves explicit verified-owner replacement using the same ordinary quick-start API', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      cookies: { [OWNER_COOKIE]: ownerCookie },
      headers: { origin: 'http://localhost:80' },
      payload: { employeeId, caseName, mode: 'claude', subscriptionProfileId: 'alternate-account' },
    });
    expect(response.statusCode).toBe(200);
    expect(start).toHaveBeenCalledOnce();
    expect(companyStore.snapshot().employees[0].sessionId).not.toBe(id);
    expect(ctx.sessions.get(companyStore.snapshot().employees[0].sessionId)?.toState()).toMatchObject({
      subscriptionProfile: { id: 'alternate-account' },
    });
  });
  it('refuses unknown employee and mixed owner/agent quick-start requests before any prefix or registration', async () => {
    for (const target of [randomUUID(), employeeId]) {
      const before = companyStore.snapshot();
      const response = await app.inject({
        method: 'POST',
        url: '/api/quick-start',
        cookies: { [OWNER_COOKIE]: ownerCookie },
        headers: { origin: 'http://localhost:80', 'x-reverie-parent-session': id },
        payload: { employeeId: target, caseName, mode: 'claude', subscriptionProfileId: 'alternate-account' },
      });
      expect(response.statusCode).toBe(403);
      expect(companyStore.snapshot()).toEqual(before);
    }
    expect(ctx.addSession).not.toHaveBeenCalled();
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.getWorkspaceHooksEnabled).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(await readdir(casePath)).toEqual([]);
  });
  it('allows one exact approved replacement, never repurposing its grant for quick-start or a second request', async () => {
    const body = creation();
    await approved(
      body,
      () => true,
      async () => {
        const wrongRoute = await app.inject({
          method: 'POST',
          url: '/api/quick-start',
          headers: { 'x-reverie-parent-session': id },
          payload: { employeeId, caseName, mode: 'claude' },
        });
        expect(wrongRoute.statusCode).toBe(403);
        const response = await injectCreation(body);
        expect(response.statusCode).toBe(200);
        expect(companyStore.snapshot().employees[0].sessionId).not.toBe(id);
        expect((await injectCreation(body)).statusCode).toBe(403);
      }
    );
    expect(ctx.addSession).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
  it.each(['permission', 'binding', 'caller-object'] as const)(
    'refuses an approved replacement after slow setup changes %s',
    async (change) => {
      await company.update(employeeId, undefined, { permissions: { moveOwnPlan: true } }, () => {});
      const source = ctx.sessions.get(id),
        generation = companyStore.snapshot().employees[0].sessionGeneration;
      const authorized = () => {
        const employee = companyStore.snapshot().employees[0];
        return (
          ctx.sessions.get(id) === source &&
          employee.sessionId === id &&
          employee.sessionGeneration === generation &&
          employee.permissions.moveOwnPlan
        );
      };
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      ctx.getGlobalNiceConfig.mockImplementation(async () => {
        entered();
        await gate;
        return undefined;
      });
      const body = creation(),
        pending = approved(body, authorized, () => injectCreation(body));
      try {
        await waiting;
        if (change === 'permission')
          await company.update(employeeId, undefined, { permissions: { moveOwnPlan: false } }, () => {});
        else if (change === 'binding')
          await companyStore.update((state) => {
            state.employees[0].sessionGeneration++;
          });
        else {
          const successor = new Session({ id, workingDir: directory, mode: 'claude' });
          ownedSources.push(successor);
          ctx.sessions.set(id, successor);
        }
      } finally {
        release();
      }
      const expected = companyStore.snapshot();
      expect((await pending).statusCode).toBe(403);
      expect(companyStore.snapshot()).toEqual(expected);
      expect(ctx.addSession).not.toHaveBeenCalled();
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(replaceRooms).not.toHaveBeenCalled();
    }
  );
  it.each(['grant', 'binding'] as const)(
    'rechecks %s while a real company writer delays first replacement publication',
    async (change) => {
      let lockEntered!: () => void,
        release!: () => void,
        queued!: () => void,
        current = true;
      const entered = new Promise<void>((resolve) => {
          lockEntered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      const atPublication = new Promise<void>((resolve) => {
        queued = resolve;
      });
      const blocker = companyStore.update(
        (state) => {
          if (change === 'binding') state.employees[0].sessionGeneration++;
        },
        () => {},
        async () => {
          lockEntered();
          await gate;
        }
      );
      await entered;
      const original = company.completeSpawn.bind(company);
      vi.spyOn(company, 'completeSpawn').mockImplementation((...args) => {
        const pending = original(...args);
        queued();
        return pending;
      });
      const body = creation(),
        pending = approved(
          body,
          () => current,
          () => injectCreation(body)
        );
      try {
        await atPublication;
        if (change === 'grant') current = false;
      } finally {
        release();
      }
      await blocker;
      const expected = companyStore.snapshot();
      expect((await pending).statusCode).toBe(change === 'grant' ? 403 : 409);
      expect(companyStore.snapshot()).toEqual(expected);
      expect(replaceRooms).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    }
  );
  it('finishes only its already-committed binding transition after grant revocation, denying a later request', async () => {
    let current = true;
    replaceRooms.mockImplementation(async () => {
      current = false;
      return [];
    });
    const body = creation();
    await approved(
      body,
      () => current,
      async () => {
        expect((await injectCreation(body)).statusCode).toBe(200);
        expect(companyStore.snapshot().employees[0].sessionId).not.toBe(id);
        expect(companyStore.snapshot().employees[0].bindingMigration).toBeUndefined();
        expect((await injectCreation(body)).statusCode).toBe(403);
      }
    );
    expect(replaceRooms).toHaveBeenCalledOnce();
    expect(ctx.addSession).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
});

const id = '00000001-0001-4000-8000-000000000001';
const other = '00000002-0002-4000-8000-000000000002';
const payload = { mode: 'claude', workingDir: '/synthetic/project', parentSessionId: id, subscriptionProfileId: 'fixture-account' };
describe('private delegated session-create authority', () => {
  let app: FastifyInstance, handled: number;
  let authorized: boolean;
  let revokeOnParse: boolean;
  let sessions: Map<string, { id: string }>;
  let recordedCandidate: boolean;
  beforeEach(async () => {
    handled = 0; authorized = true; revokeOnParse = false; app = Fastify(); await app.register(cookie);
    sessions = new Map([[id, { id }], [other, { id: other }]]);
    recordedCandidate = false;
    registerOwnerPolicy(app, {
      service: { policy: () => 'enforce', session: () => undefined, service: () => false, audit: vi.fn(), closeEnded() {} } as any,
      ctx: { sessions } as any,
      isCapabilityRequest: () => false,
      relations: { known: () => true, related: (a: string, b: string) => a === b || (recordedCandidate && a === id && b === other), upward: () => false, keeper: () => false, admin: () => false, coordinated: () => false },
    });
    app.addHook('preValidation', async () => { if (revokeOnParse) authorized = false; });
    app.post('/api/sessions', async () => { handled++; return { session: { id: 'child' } }; });
    app.post('/api/sessions/:id/interactive', async () => { handled++; return {}; });
    app.post('/api/settings', async () => { handled++; return {}; });
    await app.ready();
  });
  it('preserves the missing original actor only for one exact approved descendant start', async () => {
    sessions.delete(id); recordedCandidate = true;
    const start = (method = 'POST', url = `/api/sessions/${other}/interactive`, caller = id) => app.inject({ method: method as 'POST', url, headers: { 'x-reverie-parent-session': caller } });
    const scope = <T>(fn: () => Promise<T>) => withDelegatedSessionStart({ sessionId: id, owner: undefined, targetSessionId: other, authorized: () => authorized }, fn);
    expect((await start()).statusCode).toBe(403);
    for (const [method, url, caller] of [
      ['GET', `/api/sessions/${other}/interactive`, id],
      ['POST', '/api/settings', id],
      ['POST', `/api/sessions/${id}/interactive`, id],
      ['POST', `/api/sessions/${other}/interactive`, other],
    ]) expect((await scope(() => start(method, url, caller))).statusCode).not.toBe(200);
    expect(handled).toBe(0);
    await scope(async () => {
      expect((await start()).statusCode).toBe(200);
      expect((await start()).statusCode).toBe(403);
    });
    expect((await start()).statusCode).toBe(403);
    authorized = false;
    expect((await scope(() => start())).statusCode).toBe(403);
    expect(handled).toBe(1);
  });
  afterEach(async () => { await app.close(); });
  const request = (body: any = payload, caller = id, url = '/api/sessions') => app.inject({ method: 'POST', url, headers: { 'x-reverie-parent-session': caller }, payload: body });
  const grant = <T>(fn: () => Promise<T>, owner?: string) => withDelegatedSessionCreate({ sessionId: id, owner, payload, authorized: () => authorized }, fn);

  it('starts only the exact candidate inside a one-use private scope, never through a direct request', async () => {
    const start = (target = other) => app.inject({ method: 'POST', url: `/api/sessions/${target}/interactive`, headers: { 'x-reverie-parent-session': id } });
    const scope = <T>(fn: () => Promise<T>) => withDelegatedSessionStart({ sessionId: id, owner: undefined, targetSessionId: other, authorized: () => authorized }, fn);
    expect((await start()).statusCode).toBe(403);
    // A recorded descendant is required even with the private grant.
    const result = await scope(() => start()); expect(result.statusCode).toBe(403);
    expect((await scope(() => start(id))).statusCode).toBe(403);
    expect(handled).toBe(0);
  });
  it('allows exactly one matching request, preserving direct-request denial before and after', async () => {
    expect((await request()).statusCode).toBe(403);
    await grant(async () => { expect((await request()).statusCode).toBe(200); expect((await request()).statusCode).toBe(403); });
    expect((await request()).statusCode).toBe(403); expect(handled).toBe(1);
  });
  it('rejects changed body, account, parent, caller, owner and route without calling a handler', async () => {
    for (const body of [{ ...payload, subscriptionProfileId: 'different' }, { ...payload, parentSessionId: other }, { ...payload, envOverrides: { PRIVILEGED: 'yes' } }])
      expect((await grant(() => request(body))).statusCode).toBe(403);
    expect((await grant(() => request(payload, other))).statusCode).toBe(403);
    expect((await grant(() => request(), 'different-owner')).statusCode).toBe(403);
    expect((await grant(() => request(payload, id, '/api/settings'))).statusCode).toBe(403);
    expect(handled).toBe(0);
  });
  it('claims only one of two concurrent requests and never grants an unrelated concurrent request', async () => {
    let signal!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const active = grant(async () => { signal(); await held; return Promise.all([request(), request()]); });
    await started; expect((await request()).statusCode).toBe(403); release();
    expect((await active).map(res => res.statusCode).sort()).toEqual([200, 403]); expect(handled).toBe(1);
  });
  it('rechecks revocation at the parsed-body boundary and closes inherited async scopes after return', async () => {
    revokeOnParse = true;
    expect((await grant(() => request())).statusCode).toBe(403); expect(handled).toBe(0);
    authorized = true; revokeOnParse = false;
    let later!: () => void;
    let pending!: Promise<any>;
    await grant(async () => { pending = new Promise<void>(resolve => { later = resolve; }).then(() => request()); });
    later(); expect((await pending).statusCode).toBe(403); expect(handled).toBe(0);
  });

  it('keeps launch admission bound to the exact consumed request and private grant lifetime', async () => {
    const req: any = { method: 'POST', url: `/api/sessions/${other}/interactive`, routeOptions: { url: '/api/sessions/:id/interactive' }, headers: { 'x-reverie-parent-session': id }, body: undefined };
    let admitted!: () => boolean;
    expect(delegatedSessionStartAdmission(req)).toBeUndefined();
    await withDelegatedSessionStart({ sessionId: id, owner: undefined, targetSessionId: other, authorized: () => authorized }, async () => {
      admitted = delegatedSessionStartAdmission(req)!;
      expect(admitted()).toBe(false);
      expect(claimDelegatedSessionCreate(req, id)).toBe(true);
      expect(admitted()).toBe(false);
      expect(consumeDelegatedSessionCreate(req)).toBe(true);
      expect(admitted()).toBe(true);
      expect(delegatedSessionStartAdmission({ ...req })!()).toBe(false);
      req.body = { clearBreaker: true };
      expect(admitted()).toBe(false);
      req.body = undefined;
      authorized = false;
      expect(admitted()).toBe(false);
      authorized = true;
      expect(admitted()).toBe(true);
    });
    expect(admitted()).toBe(false);
  });

  it('refuses the real interactive route when listener setup revokes the consumed start grant', async () => {
    const routes = new Map<string, (...args: any[]) => any>();
    const registration: any = new Proxy({}, { get: (_target, method) => (url: string, ...args: any[]) => {
      if (method === 'post') routes.set(url, args.at(-1));
    } });
    const startInteractive = vi.fn(async () => { throw new Error('provider start must not be reached'); });
    const session = { id: other, owner: undefined, mode: 'codex', isBusy: () => false, startInteractive };
    const context: any = {
      sessions: new Map([[other, session]]), store: { getConfig: () => ({ ralphEnabled: false }) }, mux: {},
      setupSessionListeners: async () => { await Promise.resolve(); authorized = false; },
    };
    registerSessionRoutes(registration, context, { remoteWake: {} as any });
    const req: any = { method: 'POST', url: `/api/sessions/${other}/interactive`, routeOptions: { url: '/api/sessions/:id/interactive' }, params: { id: other }, headers: { 'x-reverie-parent-session': id }, body: undefined };
    await withDelegatedSessionStart({ sessionId: id, owner: undefined, targetSessionId: other, authorized: () => authorized }, async () => {
      expect(claimDelegatedSessionCreate(req, id)).toBe(true);
      expect(consumeDelegatedSessionCreate(req)).toBe(true);
      const result = await routes.get('/api/sessions/:id/interactive')!(req);
      expect(result).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    });
    expect(startInteractive).not.toHaveBeenCalled();
  });

  it('keeps the private creation fence bound to one exact payload, request, owner and scope lifetime', async () => {
    const req: any = { method: 'POST', url: '/api/sessions', routeOptions: { url: '/api/sessions' }, headers: {}, body: payload };
    expect(sessionCreateAdmission(req)).toBeUndefined();
    let admitted!: () => boolean;
    await withSessionCreateAdmission({ owner: undefined, payload, authorized: () => authorized }, async () => {
      admitted = sessionCreateAdmission(req)!;
      expect(admitted()).toBe(true);
      expect(sessionCreateAdmission({ ...req })!()).toBe(false);
      req.body = { ...payload, subscriptionProfileId: 'other' };
      expect(admitted()).toBe(false);
      req.body = payload;
      authorized = false;
      expect(admitted()).toBe(false);
      authorized = true;
      expect(admitted()).toBe(true);
    });
    expect(admitted()).toBe(false);
    await withSessionCreateAdmission({ owner: 'other-owner', payload, authorized: () => true }, async () => {
      expect(sessionCreateAdmission(req)!()).toBe(false);
    });
    await withSessionCreateAdmission({ owner: undefined, payload, authorized: () => true }, async () => {
      expect(sessionCreateAdmission({ ...req, url: '/api/settings', routeOptions: { url: '/api/settings' } })!()).toBe(false);
    });
  });

  it('does not turn the creation fence or forged body fields into HTTP create authority', async () => {
    expect((await request({ ...payload, admitted: true, authorized: true })).statusCode).toBe(403);
    expect((await withSessionCreateAdmission({ owner: undefined, payload, authorized: () => true }, () => request())).statusCode).toBe(403);
    expect(handled).toBe(0);
  });
});
