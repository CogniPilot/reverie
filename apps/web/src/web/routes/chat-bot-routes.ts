import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
/**
 * @fileoverview Chat bot registry routes. Reading is open to any caller (names and allowlists are
 * not secret); creating, changing or removing a bot is the owner's alone, so an agent cannot widen
 * a bot's allowlist or raise its cap.
 */
import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ChatBotError, type ChatBotRegistry } from '../../chat-bots.js';

export function registerChatBotRoutes(app: FastifyInstance, bots: ChatBotRegistry, verifiedOwner: OwnerVerifier = NO_OWNER, hasRoutines: (id: string) => boolean = () => false): void {

  const fail = (err: unknown) => {
    if (err instanceof ChatBotError) {
      const code = err.code === 'NOT_FOUND' ? ApiErrorCode.NOT_FOUND : err.code === 'CONFLICT' ? ApiErrorCode.OPERATION_FAILED : ApiErrorCode.INVALID_INPUT;
      return createErrorResponse(code, err.message);
    }
    throw err;
  };

  app.get('/api/chat-bots', async () => ({ success: true, data: { bots: bots.list() } }));

  app.put('/api/chat-bots/:id', async (req) => {
    if (!verifiedOwner(req)) return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the owner edits a bot');
    const { id } = req.params as { id: string };
    try {
      return { success: true, data: { bot: await bots.set(id, req.body) } };
    } catch (err) {
      return fail(err);
    }
  });

  app.delete('/api/chat-bots/:id', async (req, reply) => {
    if (!verifiedOwner(req)) return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the owner removes a bot');
    const { id } = req.params as { id: string };
    if (hasRoutines(id)) return reply.code(409).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, "Delete this bot's routines first"));
    if (!(await bots.remove(id))) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such bot');
    return { success: true, data: {} };
  });
}
