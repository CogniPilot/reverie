import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerPlanRequestRoutes } from '../src/web/routes/plan-request-routes.js';
import type { PlanMoveRequests } from '../src/plan-request.js';
import { PlanMoveError } from '../src/plan-move.js';
import { classify } from '../src/owner-auth/policy.js';

describe('plan request route authority', () => {
  let app: FastifyInstance;
  const requests = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    reauthorize: vi.fn(),
    decide: vi.fn(),
  };
  const headers = { host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=owner' };
  const input = { id: 'request', employeeId: 'alex', sessionId: 'source', toAccount: 'second' };
  const execution = { authorized: () => true, executor: {} as never };
  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify();
    await app.register(cookie);
    registerPlanRequestRoutes(
      app,
      requests as unknown as PlanMoveRequests,
      {
        authSessions: new Map([['owner', { ip: '127.0.0.1', ua: 'fixture', createdAt: 1, method: 'basic' }]]) as never,
        sessions: new Map([['source', { owner: 'owner-a' }]]) as never,
      },
      undefined,
      () => execution
    );
  });
  afterEach(async () => {
    await app.close();
  });
  it('creates only from signed-in same-origin owner and accepts no handoff, nonce or force controls', async () => {
    requests.create.mockResolvedValue({ ...input, phase: 'pending' });
    const response = await app.inject({ method: 'POST', url: '/api/plans/requests', headers, payload: input });
    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(requests.create).toHaveBeenCalledWith(input, undefined, execution);
    for (const extra of [{ cookie: '' }, { origin: 'https://other.test' }, { 'x-reverie-parent-session': 'source' }]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/plans/requests',
            headers: { ...headers, ...extra },
            payload: input,
          })
        ).statusCode
      ).toBe(403);
    }
    const before = requests.create.mock.calls.length;
    for (const extra of [{ forceBusy: true }, { handoff: 'owner-written' }, { nonce: 'a'.repeat(64) }])
      expect(
        (await app.inject({ method: 'POST', url: '/api/plans/requests', headers, payload: { ...input, ...extra } }))
          .statusCode
      ).not.toBe(202);
    expect(requests.create).toHaveBeenCalledTimes(before);
  });
  it('agent headers alone never approve and exact session plus one-time body credential is passed to the scoped service', async () => {
    requests.decide.mockResolvedValue({ id: 'request', phase: 'executing' });
    const url = '/api/plans/requests/request/approve';
    expect(
      (await app.inject({ method: 'POST', url, payload: { nonce: 'a'.repeat(64), handoff: 'Handoff' } })).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-reverie-parent-session': 'source' },
          payload: { handoff: 'Handoff' },
        })
      ).statusCode
    ).not.toBe(202);
    expect(requests.decide).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-reverie-parent-session': 'source' },
      payload: { nonce: 'a'.repeat(64), handoff: 'Handoff' },
    });
    expect(response.statusCode).toBe(202);
    expect(requests.decide).toHaveBeenCalledWith('request', 'source', 'a'.repeat(64), 'approve', 'Handoff', 'owner-a');
    requests.decide.mockRejectedValue(new PlanMoveError('Invalid approval', 403));
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-reverie-parent-session': 'source' },
          payload: { nonce: 'b'.repeat(64), handoff: 'Handoff' },
        })
      ).statusCode
    ).toBe(403);
  });
  it('keeps owner status/cancel/reauthorize private and whitelists only the two exact agent decisions', async () => {
    for (const suffix of ['status', 'cancel', 'reauthorize']) {
      const url = `/api/plans/requests/request/${suffix}`;
      expect(
        (await app.inject({ method: 'POST', url, headers: { 'x-reverie-parent-session': 'source' } })).statusCode
      ).toBe(403);
    }
    // Route classification grants only decision transport; nonce + binding checks still authorize it.
    expect(classify('POST', '/api/plans/requests/:id/approve', '/api/plans/requests/request/approve')).toBe('agent');
    expect(classify('POST', '/api/plans/requests/:id/reject', '/api/plans/requests/request/reject')).toBe('agent');
    expect(classify('POST', '/api/plans/requests/:id/reauthorize', '/api/plans/requests/request/reauthorize')).toBe(
      'owner'
    );
    expect(classify('POST', undefined, '/api/plans/requests/request/approve/extra')).toBe('owner');
  });
});

describe('pending plan requests require an actual self agent in every policy mode', () => {
  it('refuses services, spoofed headers and owners while scoping the agent to itself', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { OwnerAuthStore } = await import('../src/owner-auth/store.js');
    const { OwnerAuthService } = await import('../src/owner-auth/service.js');
    const { registerOwnerPolicy, callerOf, SERVICE_HEADER, OWNER_COOKIE } = await import('../src/owner-auth/policy.js');
    const admin = await import('../src/owner-auth/admin.js');
    const root = await mkdtemp(join(tmpdir(), 'plan-pending-principal-'));
    const store = new OwnerAuthStore(join(root, 'owner.json'));
    const boot = await admin.bootstrap(store, 'synthetic-owner', { enforce: true });
    const token = await admin.issueServiceToken(store, 'synthetic-service');
    const auth = new OwnerAuthService({ store, auditFile: join(root, 'audit.jsonl') });
    const restricted = (await auth.login('synthetic-owner', boot.oneTimePassword, '127.0.0.1')).session!;
    const owner = await auth.changePassword(restricted, { current: boot.oneTimePassword, next: 'correct-horse-plan-42-battery' }, '127.0.0.1');
    const ctx = { sessions: new Map([['source', { id: 'source', owner: undefined }]]), authSessions: new Map() };
    const list = vi.fn(async () => [{ id: 'request', phase: 'pending' }]);
    const server = Fastify(); await server.register(cookie);
    registerOwnerPolicy(server, { service: auth, ctx: ctx as never, isCapabilityRequest: () => false,
      relations: { known: () => false, related: () => false, upward: () => false, keeper: () => false, admin: () => false } as never });
    registerPlanRequestRoutes(server, { pendingForSession: list } as never, ctx as never, auth,
      () => ({ authorized: () => false, executor: {} as never }), undefined, request => {
        const caller = callerOf(request, { service: auth, ctx: ctx as never });
        return caller.kind === 'agent' && caller.session && request.headers['x-reverie-parent-session'] === caller.session ? { sessionId: caller.session } : undefined;
      });
    try {
      for (const mode of ['enforce', 'log', 'off'] as const) {
        await admin.setPolicy(store, mode, { forceLockoutRisk: true });
        for (const headers of [{}, { [SERVICE_HEADER]: token }, { [SERVICE_HEADER]: token, 'x-reverie-parent-session': 'source' }, { 'x-reverie-parent-session': 'missing' }, { cookie: `${OWNER_COOKIE}=${owner}` }, { cookie: `${OWNER_COOKIE}=${owner}`, 'x-reverie-parent-session': 'source' }]) {
          const before = list.mock.calls.length;
          const result = await server.inject({ method: 'POST', url: '/api/plans/agent-requests/pending', headers: { host: 'console.test', origin: 'https://console.test', ...headers }, payload: {} });
          expect([401, 403]).toContain(result.statusCode); expect(list).toHaveBeenCalledTimes(before);
        }
        const own = await server.inject({ method: 'POST', url: '/api/plans/agent-requests/pending', headers: { 'x-reverie-parent-session': 'source' }, payload: {} });
        expect(own.statusCode).toBe(200); expect(own.headers['cache-control']).toBe('no-store');
        expect(list).toHaveBeenLastCalledWith('source', undefined);
        const before = list.mock.calls.length;
        expect((await server.inject({ method: 'POST', url: '/api/plans/agent-requests/pending', headers: { 'x-reverie-parent-session': 'source' }, payload: { sessionId: 'other' } })).statusCode).toBe(400);
        expect(list).toHaveBeenCalledTimes(before);
      }
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });
});
