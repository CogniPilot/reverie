import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PlanMoveError, type PlanMoves, type PlanMoveExecutor } from '../../plan-move.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { authenticatedPlanMover } from '../plan-move-auth.js';
import { ownerFor, parseBody } from '../route-helpers.js';
import type { AuthPort } from '../ports/auth-port.js';
import { OwnPlanRecoveries, type OwnPlanRecovery } from '../../agent-plan-recovery.js';
import type { OwnerAuthService } from '../../owner-auth/service.js';

const Identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);

export function registerPlanMoveRoutes(
  app: FastifyInstance,
  moves: PlanMoves,
  auth: Pick<AuthPort, 'authSessions'>,
  ownerAuth?: Pick<OwnerAuthService, 'session'>,
  execution?: (request: FastifyRequest) => PlanMoveExecutor,
  targetMode?: (accountId: string) => Promise<'codex' | 'claude'>,
  selfRecovery?: (request: FastifyRequest) => OwnPlanRecovery | undefined
): void {
  const failure = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof PlanMoveError)) throw error;
    const code =
      error.status === 404
        ? ApiErrorCode.NOT_FOUND
        : error.status === 403
          ? ApiErrorCode.FORBIDDEN
          : error.status === 503 ? ApiErrorCode.OPERATION_FAILED : ApiErrorCode.CONFLICT;
    return reply.code(error.status).send({ ...createErrorResponse(code, error.message), ...(error.blocker ? { blocker: error.blocker } : {}) });
  };

  const recoveries = new OwnPlanRecoveries(moves);
  app.addHook('onClose', () => recoveries.close());
  const own = (request: FastifyRequest) => {
    const actor = selfRecovery?.(request);
    if (!actor) throw new PlanMoveError('Own move recovery requires your current Move own plan permission and exact agent connection', 403);
    actor.assertCurrent();
    return actor;
  };
  app.post('/api/plans/agent-moves/current', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    parseBody(z.object({}).strict(), request.body ?? {});
    try {
      const actor = own(request);
      const data = (await moves.list(actor.owner)).filter(row => row.employeeId === actor.employeeId &&
        !['completed', 'failed'].includes(row.phase));
      actor.assertCurrent();
      return { success: true, data };
    } catch (error) { return failure(reply, error); }
  });
  for (const action of ['status', 'resolve'] as const)
    app.post<{ Params: { id: string } }>(`/api/plans/agent-moves/:id/${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const actor = own(request), id = Identifier.parse(request.params.id);
        const record = await moves.get(id, actor.owner);
        actor.assertCurrent();
        if (!record || record.employeeId !== actor.employeeId) throw new PlanMoveError('Unknown own move', 404);
        if (action === 'status') {
          parseBody(z.object({}).strict(), request.body ?? {});
          return { success: true, data: record, recovery: recoveries.status(id, actor.employeeId) };
        }
        const input = parseBody(z.object({ action: z.literal('adopt-existing'), oldSession: Identifier,
          newSession: Identifier, toAccount: Identifier }).strict(), request.body);
        if (record.newSession !== actor.sessionId) throw new PlanMoveError('Recovery requires your exact current destination session', 403);
        const recovery = recoveries.enqueue(record, input, actor);
        return reply.code(202).send({ success: true, data: record, recovery });
      } catch (error) { return failure(reply, error); }
    });

  app.register(async (routes) => {
    routes.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!authenticatedPlanMover(request, auth.authSessions, ownerAuth))
        return reply
          .code(403)
          .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Plan moves require the signed-in owner browser'));
    });

    // Older tabs must not bypass the expert's approval by using the retired immediate-move endpoint.
    routes.post('/api/plans/moves', async (_request, reply) => reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, 'Create a plan request and let the expert prepare its handoff and approve the switch.')));

    routes.post('/api/plans/moves/force', async (request, reply) => {
      const input = parseBody(z.object({ id: Identifier, employeeId: Identifier, sessionId: Identifier,
        toAccount: Identifier, handoff: z.string().trim().min(1).max(12000) }).strict(), request.body);
      if (!execution || !targetMode) return reply.code(503).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Owner force move is unavailable'));
      try {
        const executor = execution(request), owner = ownerFor(request);
        const snapshot = await executor.snapshot(input.employeeId, owner);
        if (snapshot.sessionId !== input.sessionId) throw new PlanMoveError('The expert changed; refresh before forcing a move');
        const mode = await targetMode(input.toAccount);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.handoff)) throw new PlanMoveError('Use plain handoff text');
        const data = await moves.begin({ ...input, handoff: input.handoff.replace(/[\r\n]+/g, ' '), fromAccount: snapshot.account, forceBusy: true,
          targetMode: mode, ...(snapshot.model ? { model: snapshot.model } : {}) }, owner, executor);
        return reply.code(202).send({ success: true, data });
      } catch (error) { return failure(reply, error); }
    });

    routes.post('/api/plans/moves/recent', async (request) => ({
      success: true,
      data: await moves.list(ownerFor(request)),
    }));

    routes.post('/api/plans/moves/preview', async (request, reply) => {
      const input = parseBody(z.object({ employeeId: Identifier, sessionId: Identifier }).strict(), request.body);
      if (!execution)
        return reply.code(503).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Move preview is unavailable'));
      try {
        const snapshot = await execution(request).snapshot(input.employeeId, ownerFor(request));
        if (snapshot.sessionId !== input.sessionId)
          throw new PlanMoveError('The employee changed; refresh before moving');
        return { success: true, data: snapshot };
      } catch (error) {
        return failure(reply, error);
      }
    });

    routes.post<{ Params: { id: string } }>('/api/plans/moves/:id/status', async (request, reply) => {
      const record = await moves.get(request.params.id, ownerFor(request));
      if (!record) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Unknown move'));
      return { success: true, data: record };
    });

    routes.post<{ Params: { id: string } }>('/api/plans/moves/:id/resolve', async (request, reply) => {
      const input = parseBody(z.object({ action: z.literal('adopt-existing'), oldSession: Identifier,
        newSession: Identifier, toAccount: Identifier }).strict(), request.body);
      if (!execution) return reply.code(503).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Native recovery inspection is unavailable'));
      try {
        const data = await moves.resolve(request.params.id, input, ownerFor(request), execution(request));
        return { success: true, data };
      } catch (error) { return failure(reply, error); }
    });

    routes.post<{ Params: { id: string } }>('/api/plans/moves/:id/cancel', async (request, reply) => {
      try {
        await moves.cancel(request.params.id, ownerFor(request));
        return { success: true };
      } catch (error) {
        return failure(reply, error);
      }
    });
  });
}
