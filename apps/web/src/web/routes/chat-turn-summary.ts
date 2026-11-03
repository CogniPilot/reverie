/** Exact-caller, side-effect-free context; no room reads, ACKs, wakes or delivery changes. */
import type { FastifyInstance } from 'fastify';
import type { ChatroomService } from '../../chatroom-service.js';
import type { SessionPort } from '../ports/session-port.js';
import { ownerFor, resolveParentSessionId } from '../route-helpers.js';
import { ChatroomError } from '../../chatroom-store.js';
import { z } from 'zod';
import { DIGEST_CURSOR_MAX } from '../../chatroom-digest.js';
import { decodeMentionCursor, encodeMentionCursor } from '../../chatroom-mentions.js';

const ref = z
  .object({ roomId: z.string().min(1).max(200), messageId: z.string().min(1).max(200), readToken: z.string().uuid() })
  .strict();
const resolution = ref
  .extend({ disposition: z.enum(['handled', 'superseded', 'stale']), replacement: ref.optional() })
  .strict();
const historyQuery = z
  .object({
    roomId: z.string().min(1).max(200),
    beforeAt: z
      .string()
      .regex(/^\d{1,16}$/)
      .optional(),
    beforeId: z.string().min(1).max(200).optional(),
    // Only the notices this caller set aside as stale.
    stale: z.literal('1').optional(),
  })
  .strict();
// GET continues from the stored cursor, or shows everything with since=all; an explicit cursor is POSTed (see DIGEST_CURSOR_MAX).
const digestQuery = z.object({ since: z.literal('all').optional() }).strict();
const digestBody = z.object({ since: z.string().min(1).max(DIGEST_CURSOR_MAX) }).strict();
const mentionsQuery = z
  .object({
    roomId: z.string().min(1).max(200).optional(),
    // A cursor from an earlier page (m1.…), or an epoch-ms start time.
    since: z.string().min(1).max(600).optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional(),
    holds: z.enum(['0', '1']).optional(),
  })
  .strict();
/** Without `since`, the feed starts this long ago. */
export const MENTION_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// humans=1 also lists owner and other human notices: only to set them aside as stale, and only past the stale age.
const pendingBeforeQuery = z
  .object({
    roomId: z.string().min(1).max(200),
    before: z.string().regex(/^\d{1,16}$/),
    humans: z.literal('1').optional(),
  })
  .strict();

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

  app.get('/api/chatrooms/digest', async (req, reply) => {
    const self = resolveParentSessionId(ctx, req, undefined, ownerFor(req));
    if (
      !self ||
      req.headers['x-reverie-parent-session'] !== self ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    const parsed = digestQuery.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ success: false, error: 'Digest takes only since=all; POST an explicit cursor as {"since": cursor}' });
    reply.header('Cache-Control', 'no-store');
    try {
      return { success: true, data: service.actionableDigest(self, parsed.data.since) };
    } catch (error) {
      if (!(error instanceof ChatroomError)) throw error;
      return reply
        .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 503)
        .send({ success: false, error: error.message });
    }
  });

  // The same digest from an explicit cursor; like since=all it never moves the stored cursor.
  app.post('/api/chatrooms/digest', async (req, reply) => {
    const self = resolveParentSessionId(ctx, req, undefined, ownerFor(req));
    if (
      !self ||
      req.headers['x-reverie-parent-session'] !== self ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    const parsed = digestBody.safeParse(req.body);
    if (Object.keys(req.query as object).length || !parsed.success || parsed.data.since === 'all')
      return reply.code(400).send({ success: false, error: 'Expected {"since": cursor} from an earlier digest' });
    reply.header('Cache-Control', 'no-store');
    try {
      return { success: true, data: service.actionableDigest(self, parsed.data.since) };
    } catch (error) {
      if (!(error instanceof ChatroomError)) throw error;
      return reply
        .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 503)
        .send({ success: false, error: error.message });
    }
  });

  // The caller's mentions, addressed messages, @everyone and (holds=1) hold wording across its rooms, paged forward by
  // cursor. Read-only: unlike the room messages route it never moves the seen mark.
  app.get('/api/chatrooms/mentions', async (req, reply) => {
    const self = resolveParentSessionId(ctx, req, undefined, ownerFor(req));
    if (
      !self ||
      req.headers['x-reverie-parent-session'] !== self ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    const parsed = mentionsQuery.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ success: false, error: 'Expected roomId, since (cursor or epoch ms), limit 1-200 and holds=0|1' });
    const { since, roomId } = parsed.data;
    const cursor =
      since === undefined
        ? { at: Date.now() - MENTION_DEFAULT_WINDOW_MS, id: '' }
        : /^\d{1,16}$/.test(since)
          ? { at: Number(since), id: '' }
          : decodeMentionCursor(since);
    const limit = Number(parsed.data.limit ?? 50);
    if (!cursor || limit < 1 || limit > 200)
      return reply
        .code(400)
        .send({ success: false, error: 'since must be a cursor from an earlier page or epoch ms; limit 1-200' });
    reply.header('Cache-Control', 'no-store');
    try {
      const feed = service.mentionFeed(self, { roomId, cursor, limit, holds: parsed.data.holds === '1' });
      return {
        success: true,
        data: { ...feed, next: feed.next ? encodeMentionCursor(feed.next) : (since ?? encodeMentionCursor(cursor)) },
      };
    } catch (error) {
      if (!(error instanceof ChatroomError)) throw error;
      return reply.code(error.code === 'NOT_FOUND' ? 404 : 503).send({ success: false, error: error.message });
    }
  });

  app.post('/api/chatrooms/notices/resolve', async (req, reply) => {
    const self = resolveParentSessionId(ctx, req, undefined, ownerFor(req));
    if (
      !self ||
      req.headers['x-reverie-parent-session'] !== self ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    if (Object.keys(req.query as object).length)
      return reply.code(400).send({ success: false, error: 'Resolution takes no query parameters' });
    const parsed = resolution.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ success: false, error: 'Expected exact source/readToken, disposition and optional replacement' });
    reply.header('Cache-Control', 'no-store');
    try {
      return { success: true, data: service.resolveNotice(self, parsed.data) };
    } catch (error) {
      if (!(error instanceof ChatroomError)) throw error;
      const code =
        error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : error.code === 'UNAVAILABLE' ? 503 : 400;
      return reply.code(code).send({ success: false, error: error.message });
    }
  });

  // The caller's own notices from agents and bots in one room, still pending before a time: what an explicit bulk
  // "handle before" resolves one exact read at a time. Owner and other human messages are listed only with humans=1, for
  // setting them aside as stale, and only before the stale age (the service refuses a later time).
  app.get('/api/chatrooms/notices/pending-before', async (req, reply) => {
    const self = resolveParentSessionId(ctx, req, undefined, ownerFor(req));
    if (
      !self ||
      req.headers['x-reverie-parent-session'] !== self ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    const parsed = pendingBeforeQuery.safeParse(req.query);
    if (!parsed.success || !Number.isSafeInteger(Number(parsed.data.before)))
      return reply.code(400).send({ success: false, error: 'Expected own roomId and before (epoch milliseconds)' });
    reply.header('Cache-Control', 'no-store');
    try {
      const summary = service.turnSummary(self, undefined, {
        roomId: parsed.data.roomId,
        before: Number(parsed.data.before),
        humans: parsed.data.humans === '1',
      });
      return { success: true, data: { sourceReferences: summary.sourceReferences ?? [] } };
    } catch (error) {
      if (!(error instanceof ChatroomError)) throw error;
      const code = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 503;
      return reply.code(code).send({ success: false, error: error.message });
    }
  });

  app.get('/api/chatrooms/notices/history', async (req, reply) => {
    const self = resolveParentSessionId(ctx, req, undefined, ownerFor(req));
    if (
      !self ||
      req.headers['x-reverie-parent-session'] !== self ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return reply.code(403).send({ success: false, error: 'Exact agent caller required' });
    const parsed = historyQuery.safeParse(req.query);
    if (
      !parsed.success ||
      (parsed.data.beforeAt === undefined) !== (parsed.data.beforeId === undefined) ||
      (parsed.data.beforeAt !== undefined && !Number.isSafeInteger(Number(parsed.data.beforeAt)))
    )
      return reply
        .code(400)
        .send({ success: false, error: 'Expected own roomId and optional paired beforeAt/beforeId' });
    reply.header('Cache-Control', 'no-store');
    try {
      return {
        success: true,
        data: service.turnSummary(self, {
          roomId: parsed.data.roomId,
          ...(parsed.data.beforeAt !== undefined
            ? { before: { at: Number(parsed.data.beforeAt), id: parsed.data.beforeId! } }
            : {}),
          stale: parsed.data.stale === '1',
        }),
      };
    } catch (error) {
      if (!(error instanceof ChatroomError)) throw error;
      return reply.code(error.code === 'NOT_FOUND' ? 404 : 503).send({ success: false, error: error.message });
    }
  });
}
