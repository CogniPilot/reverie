import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PlanMoveError, type PlanMoves, type PlanMoveExecutor } from '../../plan-move.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { authenticatedPlanMover } from '../plan-move-auth.js';
import { ownerFor, parseBody } from '../route-helpers.js';
import type { AuthPort } from '../ports/auth-port.js';
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
  targetMode?: (accountId: string) => Promise<'codex' | 'claude'>
): void {
  const failure = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof PlanMoveError)) throw error;
    const code =
      error.status === 404
        ? ApiErrorCode.NOT_FOUND
        : error.status === 403
          ? ApiErrorCode.FORBIDDEN
          : ApiErrorCode.CONFLICT;
    return reply.code(error.status).send(createErrorResponse(code, error.message));
  };

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
