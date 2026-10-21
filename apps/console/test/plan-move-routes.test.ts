import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerPlanMoveRoutes } from '../src/web/routes/plan-move-routes.js';
import { PlanMoveError, type PlanMoves } from '../src/plan-move.js';
import type { AuthPort, AuthSessionRecord } from '../src/web/ports/auth-port.js';

describe('owner browser plan move API', () => {
  let app: FastifyInstance;
  const moves = { begin: vi.fn(), get: vi.fn(), cancel: vi.fn(), list: vi.fn() };
  const headers = { host: 'console.test', origin: 'https://console.test', cookie: 'codeman_session=owner' };
  const input = {
    id: 'move',
    employeeId: 'casey',
    sessionId: 'old',
    fromAccount: 'first',
    toAccount: 'second',
    handoff: 'Resume the task.',
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify();
    await app.register(cookie);
    const credentials = new Map<string, AuthSessionRecord>([
      ['owner', { ip: '127.0.0.1', ua: 'test', createdAt: 1, method: 'basic' }],
    ]);
    registerPlanMoveRoutes(app, moves as unknown as PlanMoves, {
      authSessions: credentials as unknown as AuthPort['authSessions'],
    });
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    '/api/plans/moves',
    '/api/plans/moves/preview',
    '/api/plans/moves/recent',
    '/api/plans/moves/move/status',
    '/api/plans/moves/move/cancel',
  ])('requires credentials on %s, even with no agent header', async (url) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { host: headers.host, origin: headers.origin },
      payload: input,
    });
    expect(response.statusCode).toBe(403);
    expect(moves.begin).not.toHaveBeenCalled();
    expect(moves.get).not.toHaveBeenCalled();
    expect(moves.cancel).not.toHaveBeenCalled();
  });

  it('returns recent moves only in the authenticated owner scope', async () => {
    moves.list.mockResolvedValue([{ id: 'move', phase: 'recovery-required' }]);
    const response = await app.inject({ method: 'POST', url: '/api/plans/moves/recent', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{ id: 'move', phase: 'recovery-required' }]);
    expect(moves.list).toHaveBeenCalledWith(undefined);
  });

  it('starts only a validated owner request and never responds with handoff text', async () => {
    moves.begin.mockResolvedValue({ id: 'move', phase: 'waiting' });
    const response = await app.inject({ method: 'POST', url: '/api/plans/moves', headers, payload: input });
    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(moves.begin).toHaveBeenCalledWith({ ...input, forceBusy: false }, undefined);
    expect(response.body).not.toContain(input.handoff);
  });

  it('refuses spoofed agents and cross-site requests before transaction code', async () => {
    for (const extra of [{ 'x-codeman-parent-session': 'claimed-agent' }, { origin: 'https://other.test' }]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/plans/moves',
            headers: { ...headers, ...extra },
            payload: input,
          })
        ).statusCode
      ).toBe(403);
    }
    expect(moves.begin).not.toHaveBeenCalled();
  });

  it('returns conflict errors and limits status to the current owner', async () => {
    moves.begin.mockRejectedValue(new PlanMoveError('Refresh stale allocation'));
    expect((await app.inject({ method: 'POST', url: '/api/plans/moves', headers, payload: input })).statusCode).toBe(
      409
    );
    moves.get.mockResolvedValue(undefined);
    expect((await app.inject({ method: 'POST', url: '/api/plans/moves/unknown/status', headers })).statusCode).toBe(
      404
    );
    expect(moves.get).toHaveBeenCalledWith('unknown', undefined);
  });

  it('cancels only a move owned by the signed-in caller', async () => {
    moves.cancel.mockResolvedValue(undefined);
    expect((await app.inject({ method: 'POST', url: '/api/plans/moves/move/cancel', headers })).json()).toEqual({
      success: true,
    });
    expect(moves.cancel).toHaveBeenCalledWith('move', undefined);
  });
});
