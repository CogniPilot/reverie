/** Actual owner policy/auth middleware; all adapters are synthetic read-only fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { registerOwnerPolicy, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import * as admin from '../src/owner-auth/admin.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { registerHealthMetadataProviderRoutes } from '../src/web/routes/session-health-provider-routes.js';
import { ServerHealthMetadataProvider } from '../src/session-health-provider.js';
import { ownerFor } from '../src/web/route-helpers.js';
const NOW = 100000;

describe('trusted health metadata projection', () => {
  let app: FastifyInstance;
  let service: OwnerAuthService;
  let store: OwnerAuthStore;
  let dir: string;
  let owner: string;
  let serviceToken: string;
  let clock: number;
  let read: ReturnType<typeof vi.fn>;
  let deps: Parameters<typeof registerHealthMetadataProviderRoutes>[1];
  let saved: string | undefined;

  beforeEach(async () => {
    saved = process.env.REVERIE_PASSWORD;
    process.env.REVERIE_PASSWORD = 'synthetic-shared';
    dir = await mkdtemp(join(tmpdir(), 'health-auth-'));
    store = new OwnerAuthStore(join(dir, 'owner.json'));
    const { oneTimePassword } = await admin.bootstrap(store, 'synthetic-owner');
    await admin.setPolicy(store, 'enforce', { forceLockoutRisk: true });
    serviceToken = await admin.issueServiceToken(store, 'synthetic-service');
    service = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl') });
    app = Fastify();
    await app.register(cookie);
    registerAuthMiddleware(app, false, '', service);
    const ctx = {
      sessions: new Map([
        ['session-1', { id: 'session-1' }],
        ['foreign', { id: 'foreign', owner: 'other-owner' }],
      ]),
    } as unknown as SessionPort;
    registerOwnerPolicy(app, {
      service,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: () => true,
        related: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerOwnerRoutes(app, service, false);
    clock = NOW;
    const session = ctx.sessions.get('session-1')!;
    read = vi.fn(() => ({
      employees: [{ id: 'employee:review.1', sessionId: 'session-1', sessionGeneration: 7, desiredRunning: true }],
    }));
    const verify = ownerVerifier({ service, ctx });
    deps = {
      authorized: (req, id) => verify(req) && !!ctx.sessions.get(id) && ctx.sessions.get(id)!.owner === ownerFor(req),
      now: () => clock,
      provider: new ServerHealthMetadataProvider({
        authority: {
          metadataBinding: () => ({ employeeId: 'employee:review.1', sessionId: 'session-1', sessionGeneration: 7 }),
        },
        canonical: read,
        session: () => session,
        now: () => clock,
      }),
    };
    registerHealthMetadataProviderRoutes(app, deps);
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      headers: { origin: 'http://localhost' },
      payload: { username: 'synthetic-owner', password: oneTimePassword },
    });
    expect(login.statusCode).toBe(200);
    const restricted = login.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      headers: { origin: 'http://localhost' },
      cookies: { [OWNER_COOKIE]: restricted },
      payload: { current: oneTimePassword, next: 'synthetic-correct-horse-42' },
    });
    expect(changed.statusCode).toBe(200);
    owner = changed.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  });
  afterEach(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.REVERIE_PASSWORD;
    else process.env.REVERIE_PASSWORD = saved;
    await rm(dir, { recursive: true, force: true });
  });
  const get = (url = '/api/session-health/session-1/metadata') =>
    app.inject({ method: 'GET', url, cookies: { [OWNER_COOKIE]: owner } });

  it('actual owner reads allowlisted metadata with UNKNOWN process and no action', async () => {
    const r = await get();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data).toMatchObject({ process: 'UNKNOWN', automaticAction: 'NONE' });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('refuses no-cookie/service and foreign/missing targets before reading', async () => {
    for (const headers of [{}, { 'x-reverie-service-token': serviceToken }])
      expect([401, 403]).toContain(
        (await app.inject({ method: 'GET', url: '/api/session-health/session-1/metadata', headers })).statusCode
      );
    for (const id of ['foreign', 'missing'])
      expect((await get('/api/session-health/' + id + '/metadata')).statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
  it('refuses claims, defaults unavailable without provider, and bounds read rate', async () => {
    expect((await get('/api/session-health/session-1/metadata?employeeId=other')).statusCode).toBe(400);
    const provider = deps.provider;
    deps.provider = undefined;
    expect((await get()).statusCode).toBe(503);
    deps.provider = provider;
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(429);
    clock += 1000;
    expect((await get()).statusCode).toBe(200);
  });
  it('sanitizes errors and rechecks authorization after read', async () => {
    read.mockImplementationOnce(() => {
      throw Error('SECRET_ERROR');
    });
    const r = await get();
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain('SECRET');
    clock += 1000;
    const original = read.getMockImplementation()!;
    read.mockImplementationOnce(() => {
      deps.authorized = () => false;
      return original();
    });
    expect((await get()).statusCode).toBe(403);
  });
  it.each(['off', 'log'] as const)('retains real owner-only metadata reads in %s policy', async (policy) => {
    await admin.setPolicy(store, policy);
    for (const headers of [
      {
        authorization: 'Basic ' + Buffer.from('admin:synthetic-shared').toString('base64'),
        'x-reverie-parent-session': 'session-1',
      },
      {
        authorization: 'Basic ' + Buffer.from('admin:synthetic-shared').toString('base64'),
        'x-reverie-service-token': serviceToken,
      },
    ])
      expect(
        (await app.inject({ method: 'GET', url: '/api/session-health/session-1/metadata', headers })).statusCode
      ).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
});
