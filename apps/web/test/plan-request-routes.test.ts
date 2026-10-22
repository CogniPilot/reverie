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
