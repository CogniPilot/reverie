import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionPort } from '../ports/session-port.js';
import { findSessionOrFail } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';

const querySchema = z
  .object({
    clientId: z.string().max(128),
    seq: z
      .string()
      .max(16)
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .transform(Number)
      .refine(Number.isSafeInteger),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Inspect the original input receipt without entering any dispatch/admission/reservation path. */
export function registerInputReceiptRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get('/api/sessions/:id/input-receipt', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie, Authorization');
    const session = findSessionOrFail(ctx, (req.params as { id: string }).id, req);
    const query = querySchema.safeParse(req.query);
    if (!query.success)
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            'Expected exact clientId, safe integer seq and SHA-256 fingerprint'
          )
        );
    const state = ctx.terminalInput.inspect(session, query.data, () => ctx.sessions.get(session.id) === session);
    return { success: true, data: { version: 1, ...query.data, state } };
  });
}
