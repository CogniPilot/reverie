/** Exact-caller, side-effect-free context; no room reads, ACKs, wakes or delivery changes. */
import type { FastifyInstance } from 'fastify';
import type { ChatroomService } from '../../chatroom-service.js';
import type { SessionPort } from '../ports/session-port.js';
import { ownerFor, resolveParentSessionId } from '../route-helpers.js';

export function registerChatTurnSummary(app: FastifyInstance, ctx: SessionPort, service: ChatroomService): void {
  app.get('/api/chatrooms/turn-summary', async (req, reply) => {
    const self = resolveParentSessionId(ctx, req, undefined, ownerFor(req));
    if (
      !self ||
      req.headers['x-reverie-parent-session'] !== self ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    if (Object.keys(req.query as object).length)
      return reply.code(400).send({ success: false, error: 'Summary takes no target or query parameters' });
    reply.header('Cache-Control', 'no-store');
    return { success: true, data: service.turnSummary(self) };
  });
}
