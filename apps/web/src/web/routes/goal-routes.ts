/** Effect-free Goal API over one server-composed canonical facade; omitted trust/custody denies. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CompanyStore } from '../../company-store.js';
import { GoalLifecycle, GoalLifecycleError } from '../../goal-lifecycle.js';
import { GoalAccessError, type GoalAuthentication } from '../../goal-access.js';

export function registerGoalRoutes(
  app: FastifyInstance,
  store: CompanyStore,
  auth?: GoalAuthentication,
  now: () => number = Date.now
): void {
  // Compatibility helper for isolated core/API tests. Production registers CompanyService.goals directly below.
  registerGoalServiceRoutes(app, new GoalLifecycle(store, now, auth));
}

export function registerGoalServiceRoutes(app: FastifyInstance, goals: GoalLifecycle): void {
  const run = async (reply: FastifyReply, operation: () => Promise<unknown>) => {
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      if (!(error instanceof GoalLifecycleError || error instanceof GoalAccessError)) throw error;
      reply.code(error.status);
      return { success: false, errorCode: error.code, error: error.message };
    }
  };
  const input = (req: FastifyRequest) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.hasOwn(req.body, 'goalId'))
      throw new GoalLifecycleError('Body must be a command without a path-owned goalId', 'GOAL_INVALID', 400);
    return { ...req.body, goalId: (req.params as { id: string }).id };
  };
  app.get('/api/goals', (req, reply) => run(reply, () => goals.list(req)));
  app.get<{ Params: { id: string } }>('/api/goals/:id', (req, reply) =>
    run(reply, () => goals.get(req.params.id, req))
  );
  app.post('/api/goals', (req, reply) => run(reply, () => goals.create(req.body, req)));
  app.post('/api/goals/:id/transitions', (req, reply) => run(reply, () => goals.transition(input(req), req)));
  app.post('/api/goals/:id/adopt', (req, reply) => run(reply, () => goals.adopt(input(req), req)));
  app.post('/api/goals/:id/unblock-proofs', (req, reply) => run(reply, () => goals.attestUnblocker(input(req), req)));
  app.post('/api/goal-grants', (req, reply) => run(reply, () => goals.issueGrant(req.body, req)));
  app.post<{ Params: { id: string } }>('/api/goal-grants/:id/revoke', (req, reply) =>
    run(reply, () => goals.revokeGrant(req.params.id, req))
  );
  app.post<{ Params: { id: string } }>('/api/goal-unblock-proofs/:id/revoke', (req, reply) =>
    run(reply, () => goals.revokeUnblockProof(req.params.id, req))
  );
  app.get<{ Params: { employeeId: string }; Querystring: { grantId?: string } }>(
    '/api/goal-metadata/:employeeId',
    (req, reply) => run(reply, () => goals.forEmployee(req.params.employeeId, req, req.query.grantId))
  );
}
