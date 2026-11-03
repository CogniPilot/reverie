/**
 * `POST /api/plans/agent-requests/pending` with `employeeId`: a manager lists the moves filed for another expert. The
 * permission is the same check a manager's move request passes (Manage team plans, against the expert's current
 * session); without it, or without a current session, nothing is listed. Without `employeeId` it lists the caller's own.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPlanRequestRoutes } from '../src/web/routes/plan-request-routes.js';
import type { PlanMoveRequests } from '../src/plan-request.js';

let app: FastifyInstance;
const own = vi.fn(async () => [{ id: 'own-1' }]);
const forEmployee = vi.fn(async () => [{ id: 'theirs-1' }]);
const binding = vi.fn((employeeId: string) => (employeeId === 'emp-target' ? 'session-target' : undefined));
const capture = vi.fn(
  (request: { headers: Record<string, unknown> }, input: { employeeId: string; sessionId: string }) => {
    void input;
    return {
      authorized: () => request.headers['x-reverie-parent-session'] === 'session-manager',
      executor: {} as never,
    };
  }
);

beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  registerPlanRequestRoutes(
    app,
    { pendingForSession: own, pendingForEmployee: forEmployee, bindingOf: binding } as unknown as PlanMoveRequests,
    { authSessions: new Map() as never, sessions: new Map() as never },
    undefined,
    () => ({ authorized: () => false, executor: {} as never }),
    capture as never,
    (request) => {
      const session = request.headers['x-reverie-parent-session'];
      return typeof session === 'string' ? { sessionId: session } : undefined;
    }
  );
  await app.ready();
});
afterEach(async () => app.close());

const list = (session: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/plans/agent-requests/pending',
    headers: { 'x-reverie-parent-session': session },
    payload,
  });

it('lists the caller’s own requests without employeeId', async () => {
  const res = await list('session-member', {});
  expect(res.statusCode).toBe(200);
  expect(res.json().data).toEqual([{ id: 'own-1' }]);
  expect(own).toHaveBeenCalledWith('session-member', undefined);
  expect(forEmployee).not.toHaveBeenCalled();
});

it('lets a manager list another expert’s requests, checked against that expert’s current session', async () => {
  const res = await list('session-manager', { employeeId: 'emp-target' });
  expect(res.statusCode).toBe(200);
  expect(res.json().data).toEqual([{ id: 'theirs-1' }]);
  expect(capture.mock.calls[0][1]).toEqual({ employeeId: 'emp-target', sessionId: 'session-target' });
  expect(forEmployee).toHaveBeenCalledWith('emp-target', undefined);
});

it('refuses without Manage team plans, and for an expert with no current session, listing nothing', async () => {
  const denied = await list('session-member', { employeeId: 'emp-target' });
  expect(denied.statusCode).toBe(403);
  expect(denied.json().error).toContain('Manage team plans');
  const absent = await list('session-manager', { employeeId: 'emp-gone' });
  expect(absent.statusCode).toBe(404);
  expect(forEmployee).not.toHaveBeenCalled();
  expect((await list('session-manager', { employeeId: '../x' })).statusCode).toBe(400);
});
