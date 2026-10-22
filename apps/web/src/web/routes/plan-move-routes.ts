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
  execution?: (request: FastifyRequest) => PlanMoveExecutor
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
