import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PlanMoveError } from '../../plan-move.js';
import { PlanRequestId } from '../../plan-request-capability.js';
import type { PlanMoveRequests, PlanRequestExecution } from '../../plan-request.js';
import type { AuthPort, SessionPort } from '../ports/index.js';
import type { OwnerAuthService } from '../../owner-auth/service.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ownerFor, parseBody } from '../route-helpers.js';
import { authenticatedPlanMover } from '../plan-move-auth.js';

export function registerPlanRequestRoutes(
  app: FastifyInstance,
  requests: PlanMoveRequests,
  ctx: Pick<AuthPort, 'authSessions'> & Pick<SessionPort, 'sessions'>,
  ownerAuth: Pick<OwnerAuthService, 'session'> | undefined,
  capture: (request: FastifyRequest) => PlanRequestExecution,
  agentCapture?: (request: FastifyRequest, input: { employeeId: string; sessionId: string }) => PlanRequestExecution | undefined
): void {
  const failure = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof PlanMoveError)) throw error;
    return reply
      .code(error.status)
      .send(
        createErrorResponse(
          error.status === 404
            ? ApiErrorCode.NOT_FOUND
            : error.status === 403
              ? ApiErrorCode.FORBIDDEN
              : ApiErrorCode.CONFLICT,
          error.message
        )
      );
  };
  const agentInput = z.object({ id: PlanRequestId, employeeId: PlanRequestId, sessionId: PlanRequestId, toAccount: PlanRequestId }).strict();
  const agentExecution = (request: FastifyRequest, input: { employeeId: string; sessionId: string }) => {
    const execution = agentCapture?.(request, input);
    if (!execution?.authorized()) throw new PlanMoveError('This expert needs Move own plan or Manage team plans permission from the owner', 403);
    return execution;
  };
  app.post('/api/plans/agent-requests', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = parseBody(agentInput, request.body);
    try {
      const execution = agentExecution(request, input);
      return reply.code(202).send({ success: true, data: await requests.create(input, ownerFor(request), execution) });
    } catch (error) { return failure(reply, error); }
  });
  for (const action of ['status', 'cancel', 'reauthorize'] as const)
    app.post<{ Params: { id: string } }>(`/api/plans/agent-requests/:id/${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const id = PlanRequestId.parse(request.params.id), owner = ownerFor(request);
        const record = await requests.get(id, owner);
        const execution = agentExecution(request, { employeeId: record.employeeId, sessionId: record.newSession ?? record.sessionId });
        const data = action === 'cancel' ? await requests.cancel(id, owner)
          : action === 'reauthorize' ? await requests.reauthorize(id, owner, execution) : record;
        return { success: true, data };
      } catch (error) { return failure(reply, error); }
    });
  app.register(async (routes) => {
    routes.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!authenticatedPlanMover(request, ctx.authSessions, ownerAuth))
        return reply
          .code(403)
          .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Plan requests require the signed-in owner browser'));
    });
    routes.post('/api/plans/requests', async (request, reply) => {
      const input = parseBody(
        z
          .object({ id: PlanRequestId, employeeId: PlanRequestId, sessionId: PlanRequestId, toAccount: PlanRequestId })
          .strict(),
        request.body
      );
      try {
        return reply
          .code(202)
          .send({ success: true, data: await requests.create(input, ownerFor(request), capture(request)) });
      } catch (error) {
        return failure(reply, error);
      }
    });
    routes.post('/api/plans/requests/recent', async (request) => ({
      success: true,
      data: await requests.list(ownerFor(request)),
    }));
    routes.post<{ Params: { id: string } }>('/api/plans/requests/:id/status', async (request, reply) => {
      try {
        return { success: true, data: await requests.get(PlanRequestId.parse(request.params.id), ownerFor(request)) };
      } catch (error) {
        return failure(reply, error);
      }
    });
    routes.post<{ Params: { id: string } }>('/api/plans/requests/:id/cancel', async (request, reply) => {
      try {
        return {
          success: true,
          data: await requests.cancel(PlanRequestId.parse(request.params.id), ownerFor(request)),
        };
      } catch (error) {
        return failure(reply, error);
      }
    });
    routes.post<{ Params: { id: string } }>('/api/plans/requests/:id/reauthorize', async (request, reply) => {
      try {
        return {
          success: true,
          data: await requests.reauthorize(PlanRequestId.parse(request.params.id), ownerFor(request), capture(request)),
        };
      } catch (error) {
        return failure(reply, error);
      }
    });
  });
  for (const decision of ['approve', 'reject'] as const)
    app.post<{ Params: { id: string } }>(`/api/plans/requests/:id/${decision}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const actor = request.headers['x-reverie-parent-session'];
      const session = typeof actor === 'string' ? ctx.sessions.get(actor) : undefined;
      if (!session)
        return reply
          .code(403)
          .send(
            createErrorResponse(
              ApiErrorCode.FORBIDDEN,
              'Approval requires the exact current expert session and its private credential'
            )
          );
      const body = parseBody(
        decision === 'approve'
          ? z
              .object({ nonce: z.string().regex(/^[a-f0-9]{64}$/), handoff: z.string().trim().min(1).max(12000) })
              .strict()
          : z.object({ nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        request.body
      );
      try {
        const data = await requests.decide(
          PlanRequestId.parse(request.params.id),
          actor as string,
          body.nonce,
          decision,
          'handoff' in body && typeof body.handoff === 'string' ? body.handoff : '',
          session.owner
        );
        return reply.code(202).send({ success: true, data });
      } catch (error) {
        return failure(reply, error);
      }
    });
}
