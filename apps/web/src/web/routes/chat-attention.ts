/** A single bounded, metadata-only long poll for the exact caller's accepted phone traffic. */
import type { FastifyInstance } from 'fastify';
import { isDm } from '../../chatroom-store.js';
import type { ChatroomService } from '../../chatroom-service.js';
import type { SessionPort } from '../ports/session-port.js';
import { ownerFor, resolveParentSessionId } from '../route-helpers.js';

export function registerChatAttention(app: FastifyInstance, ctx: SessionPort, service: ChatroomService, waitMs = 25_000) {
  const active = new Map<string, () => void>();
  app.addHook('preClose', async () => { for (const close of [...active.values()]) close(); });
  app.get('/api/chatrooms/attention', async (req, reply) => {
    const owner = ownerFor(req);
    const self = resolveParentSessionId(ctx, req, undefined, owner);
    if (!self || req.headers['x-reverie-parent-session'] !== self || req.headers['x-reverie-service-token'] !== undefined)
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    if (Object.keys(req.query as object).length)
      return reply.code(400).send({ success: false, error: 'Attention takes no target or query parameters' });
    if (!service.adminPhoneWakeEnabled)
      return reply.code(503).send({ success: false, error: 'Admin phone wake is not enabled for this instance' });
    if (active.has(self)) return reply.code(409).send({ success: false, error: 'An attention request is already waiting' });
    reply.header('Cache-Control', 'no-store');
    return new Promise(resolve => {
      let settled = false;
      const finish = (event?: { roomId: string; messageId: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        reply.raw.removeListener('close', close);
        active.delete(self);
        resolve({ success: true, data: { event: event ?? null } });
      };
      const close = () => finish();
      const unsubscribe = service.onMessage((postedRoom, message) => {
        // Read current membership and sender data; a stale event/removed seat never grants visibility.
        const room = service.room(postedRoom.id);
        if (!ctx.sessions.has(self) || ctx.sessions.get(self)?.owner !== owner || !room || room.owner !== owner ||
          room.archivedAt || !room.members.some(member => member.sessionId === self) ||
          (isDm(room) && !room.dm.includes(self))) return;
        const current = room.messages.find(item => item.id === message.id);
        if (!current || current.deleted || current.from.kind === 'system' ||
          (current.from.kind === 'agent' && current.from.sessionId === self)) return;
        if (service.phoneAccepts(self, room.id, current.id)) finish({ roomId: room.id, messageId: current.id });
      });
      const timer = setTimeout(close, waitMs);
      timer.unref();
      active.set(self, close);
      reply.raw.on('close', close);
    });
  });
}
