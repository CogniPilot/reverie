import { registerChatTurnSummary } from './chat-turn-summary.js';
import { listClis } from '../../config/cli-registry/registry.js';
import { modePollsChat } from '../../chatroom-delivery.js';
import { registerChatAttention } from './chat-attention.js';
import { agentMessage } from '../../chatroom-agent-message.js';
import { z } from 'zod';
import { ChatDbError } from '../../chat-db.js';
/**
 * @fileoverview Chatroom routes: a shared room where the user, an appointed
 * coordinator session and worker sessions talk.
 *
 * Endpoints:
 * - `GET    /api/chatrooms[?member=<sessionId>|self]`   room summaries
 * - `POST   /api/chatrooms/dms`                         the user's direct message `{sessionId}`
 * - `PUT    /api/chatrooms/:id/placement`               workspace / category `{workspace?, category?}`
 * - `PUT    /api/chatrooms/:id/archive`                 archive or restore `{archived}`
 * - `POST   /api/chatrooms`                             create `{name, members?, coordinatorSessionId?}` (user, or a coordinator)
 * - `GET    /api/chatrooms/:id[?since=&limit=]`         room view (members + synopses + messages)
 * - `POST   /api/chatrooms/:id/read`                    move the user's read cursor `{at?}`
 * - `POST   /api/chatrooms/:id/clear-history`           hide existing DM history for this owner, without deleting messages
 * - `PUT    /api/chatrooms/:id`                         rename `{name}`
 * - `DELETE /api/chatrooms/:id`                         delete
 * - `POST   /api/chatrooms/:id/members`                 add `{sessionId, goal?, role?}`
 * - `DELETE /api/chatrooms/:id/members/:sessionId`      remove
 * - `POST   /api/chatrooms/:id/coordinator`             appoint `{sessionId|null}`
 * - `POST   /api/chatrooms/:id/members/:sessionId/status` synopsis `{goal?, progress?}`
 * - `POST   /api/chatrooms/:id/members/:sessionId/brief`  re-send the how-to-talk briefing
 * - `GET    /api/chatrooms/:id/messages[?since=&limit=]`  history
 * - `POST   /api/chatrooms/:id/messages`                post `{text, to?}`
 *
 * Who is speaking: a request carrying `X-Reverie-Parent-Session` (every
 * `reverie agent` call does) that resolves to a live session the caller can see
 * speaks AS that session; anything else (the browser) speaks as the user.
 * Agents may post, read, set their OWN synopsis, and (the coordinator only) add
 * or remove other members. An agent that is the coordinator of a room it can see may also
 * create a room (it becomes that room's coordinator; every member still has to be a session
 * it can see). Appointing coordinators, renaming and deleting a room are the user's. Rooms are owner-scoped in multi-user mode.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import {
  ChatroomError,
  MAX_MEMBERS,
  isDm,
  isPublicRoom,
  normalizeIcon,
  unreadFor,
  type ChatAttachment,
  type ChatRecipient,
  type ChatRoom,
  type ChatSender,
} from '../../chatroom-store.js';
import { ChatFileError, MAX_FILE_BYTES, VIDEO_SNIFF_BYTES, inlineVideoType, isInlineImage, type ChatFileStore } from '../../chatroom-files.js';
import fs from 'node:fs/promises';
import { parseByteRange } from '../http-range.js';
import { isRollCommand, rollCommand } from '../../chatroom-dice.js';

/**
 * Exactly one emoji: a single grapheme that is pictographic (with any variation
 * selector, skin tone or ZWJ sequence inside it), a flag (regional-indicator pair), or a
 * keycap (digit, # or * followed by U+20E3).
 */
function isReactionEmoji(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  if (graphemes.length !== 1) return false;
  return (
    /\p{Extended_Pictographic}/u.test(text) ||
    /^\p{Regional_Indicator}{2}$/u.test(text) ||
    /^[0-9#*]\uFE0F?\u20E3$/u.test(text)
  );
}
import type { ChatroomService } from '../../chatroom-service.js';
import { messagesSince, newerUnread, postWarnings } from '../../chatroom-warnings.js';
import type { SessionPort } from '../ports/session-port.js';
import {
  canAccessOwned,
  findSessionOrFail,
  getAuthUser,
  ownerFor,
  parseBody,
  resolveParentSessionId,
} from '../route-helpers.js';
import {
  ChatroomCoordinatorSchema,
  ChatroomArchiveSchema,
  ChatroomCreateSchema,
  ChatroomDmSchema,
  ChatroomClearHistorySchema,
  ChatroomMemberAddSchema,
  ChatroomMessageSchema,
  ChatroomPlacementSchema,
  ChatroomPollSchema,
  ChatroomPollVoteSchema,
  ChatroomPlaybackSchema,
  ChatroomEditSchema,
  ChatroomNotifySchema,
  ChatroomOrderSchema,
  ChatroomReplaceSchema,
  ChatroomReactionSchema,
  ChatroomWakeSchema,
  ChatroomVisibilitySchema,
  ChatroomReportSchema,
  ChatroomReadSchema,
  ChatroomUpdateSchema,
  ChatroomStatusSchema,
} from '../schemas.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { isSensitivePath } from '../sensitive-path.js';
import { checkLinkedFile, LinkedFileError } from '../../chat-linked-files.js';
import { NO_OWNER, ownerMark, type OwnerVerifier, type ServiceVerifier } from '../../owner-auth/marks.js';
import { OWNER_RANK, RolesStore, type Actor, type Permission } from '../../roles.js';

class PhoneStatusForbidden extends Error {}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ChatDbError) return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
  if (err instanceof PhoneStatusForbidden) return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, err.message));
  if (err instanceof ChatroomError) {
    if (err.code === 'UNAVAILABLE') return reply.code(503).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, err.message));
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400;
    return reply.code(status).send(createErrorResponse(ApiErrorCode[err.code], err.message));
  }
  if ((err as { code?: string }).code === 'INVALID_INPUT') {
    return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, (err as Error).message));
  }
  throw err;
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function registerChatroomRoutes(
  app: FastifyInstance,
  ctx: SessionPort,
  service: ChatroomService,
  files: ChatFileStore,
  /** Is this request a cookie-verified owner (owner-auth/marks.ts)? Only then is a user post marked. */
  verifiedOwner: OwnerVerifier = NO_OWNER,
  /** Roles and their permissions (src/roles.ts). The default has no assignments: every session is a Member, a coordinator is its room's Lead. */
  roles: RolesStore = new RolesStore(''),
  /** A session id to its company employee id, if it has one. */
  employeeOf: (sessionId: string) => string | undefined = () => undefined,
  host: { pendingStatus?: ServiceVerifier; human?: (req: FastifyRequest) => import('../../owner-auth/service.js').HumanIdentity | undefined; humanNames?: (room: ChatRoom) => readonly string[]; messageOwner?: (humanId: string | undefined) => boolean; readAt?: (id: string, roomId: string) => number | undefined; markRead?: (id: string, roomId: string, at?: number) => Promise<number> } = {}
): void {
  /** The session this request speaks as, or undefined for the user. */
  const caller = (req: FastifyRequest): string | undefined =>
    resolveParentSessionId(ctx, req, undefined, ownerFor(req));

  // Every room route needs an actual owner or an agent session. Services cannot borrow
  // owner identity by omitting a header, or impersonate an agent by adding one.
  const refuseUnresolvedParent = async (req: FastifyRequest, reply: FastifyReply) => {
    if (verifiedOwner(req)) return;
    if (req.method === 'GET' && req.routeOptions.url === '/api/chatrooms' && host.pendingStatus?.(req)) return;
    if (req.headers['x-reverie-service-token'] === undefined && req.headers['x-reverie-parent-session'] !== undefined && caller(req)) return;
    return reply
      .code(403)
      .send(
        createErrorResponse(
          ApiErrorCode.FORBIDDEN,
          'Verified owner or live agent session required'
        )
      );
  };
  app.addHook('onRoute', (options) => {
    if (!options.url.startsWith('/api/chatrooms')) return;
    const existing = options.preHandler ? [options.preHandler].flat() : [];
    options.preHandler = [refuseUnresolvedParent, ...existing];
  });

  registerChatAttention(app, ctx, service);
  registerChatTurnSummary(app, ctx, service);

  const phoneSchema = z.object({ mode: z.enum(['ring', 'vibrate', 'silent']) }).strict();
  const phoneActor = (req: FastifyRequest) => {
    const self = caller(req);
    const owner = verifiedOwner(req) && req.headers['x-reverie-parent-session'] === undefined;
    if (!owner && (!self || req.headers['x-reverie-parent-session'] !== self || !employeeOf(self))) {
      throw new PhoneStatusForbidden('Verified owner or exact bound employee caller required');
    }
    const coordinator = !!self && service.rooms().some(room => room.owner === ownerFor(req) && !room.archivedAt &&
      room.members.some(m => m.sessionId === self && m.role === 'coordinator'));
    return { self, owner, coordinator };
  };
  app.get('/api/chatrooms/phone-status', async (req, reply) => {
    try {
      const actor = phoneActor(req);
      return { success: true, data: { canSetOwn: true, canSetAgents: actor.owner || actor.coordinator,
        self: actor.self ?? 'owner', alertMode: actor.self ? service.alertMode(actor.self) ?? null : service.ownerPhoneStatus(ownerFor(req)) ?? null } };
    } catch (error) { return sendError(reply, error); }
  });
  app.put<{ Params: { target: string } }>('/api/chatrooms/phone-status/:target', async (req, reply) => {
    const body = phoneSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected only mode: ring, vibrate or silent'));
    try {
      const actor = phoneActor(req);
      const target = req.params.target === 'owner' ? undefined : req.params.target;
      const authorize = () => {
        const current = phoneActor(req);
        if (current.self !== actor.self || current.owner !== actor.owner) throw new PhoneStatusForbidden('Caller changed');
        if (!target) {
          if (!current.owner) throw new PhoneStatusForbidden('Only the owner sets owner status');
        } else {
          const session = ctx.sessions.get(target);
          if (!session || session.owner !== ownerFor(req) || !employeeOf(target)) throw new PhoneStatusForbidden('Target is not an employee in your company');
          if (!current.owner && !current.coordinator && current.self !== target) throw new PhoneStatusForbidden('Only owner, coordinator or self may set this mode');
        }
      };
      const alertMode = await service.setPhoneStatus(ownerFor(req), target, body.data.mode, actor.owner ? 'owner' : actor.self!, authorize);
      return { success: true, data: { alertMode: alertMode ?? null } };
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/chatrooms/alert-mode', async (req, reply) => {
    const self = caller(req);
    if (!self) return forbid(reply, 'A bound employee session is required');
    if (!employeeOf(self)) return forbid(reply, 'No employee binding');
    return { success: true, data: { alertMode: service.alertMode(self) ?? null } };
  });
  app.post('/api/chatrooms/alert-mode', async (req, reply) => {
    const self = caller(req);
    if (!self || !employeeOf(self)) return forbid(reply, 'A bound employee session is required');
    const body = req.body as { mode?: unknown; durationMs?: unknown } | null;
    if (!body || !['ring', 'vibrate', 'silent'].includes(String(body.mode)) || typeof body.durationMs !== 'number') {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected mode and durationMs'));
    }
    try {
      const alertMode = await service.setAlertMode(self, body.mode as 'ring' | 'vibrate' | 'silent', body.durationMs);
      return { success: true, data: { alertMode: alertMode ?? null } };
    } catch (error) { return sendError(reply, error); }
  });

  const userName = (req: FastifyRequest): string => host.human?.(req)?.name || (isMultiUserMode() ? getAuthUser(req).username : 'user');

  const roomOrFail = (req: FastifyRequest, id: string): ChatRoom => {
    const room = service.room(id);
    // A room belongs to its members: an agent that is not one sees nothing of it (a direct message or a private channel is not even
    // there for it). A public channel says how to get in, and still shows nothing of what is said in it.
    const self = caller(req);
    if (!room || !canAccessOwned(getAuthUser(req), room.owner)) throw new ChatroomError(`No chatroom ${id}`, 'NOT_FOUND');
    if (self && !room.members.some((m) => m.sessionId === self)) {
      if (isPublicRoom(room)) {
        throw new ChatroomError(`You are not in "${room.name}": join it first with reverie agent chat join ${room.id}`, 'NOT_FOUND');
      }
      throw new ChatroomError(`No chatroom ${id}`, 'NOT_FOUND');
    }
    return room;
  };

  /** Does `self` coordinate at least one live (not archived) room this caller can see? */
  const coordinatesVisibleRoom = (req: FastifyRequest, self: string): boolean => {
    const user = getAuthUser(req);
    return service
      .rooms()
      .some(
        (r) =>
          canAccessOwned(user, r.owner) &&
          !r.archivedAt &&
          r.members.some((m) => m.sessionId === self && m.role === 'coordinator')
      );
  };

  /**
   * Unread counts belong to the room's owner. In multi-user mode an admin lists every user's rooms,
   * but cannot clear their unread (the read call is a no-op for them), so those rooms report none.
   */
  const ownsHistoryView = (req: FastifyRequest, room: ChatRoom): boolean =>
    verifiedOwner(req) &&
    !caller(req) &&
    req.headers['x-reverie-parent-session'] === undefined &&
    req.headers['x-reverie-service-token'] === undefined &&
    room.owner === ownerFor(req) &&
    isDm(room) &&
    room.dm.includes('user');
  const historyViewer = (req: FastifyRequest): string => host.human?.(req)?.id ?? 'owner';
  const ownedView = (req: FastifyRequest, room: ChatRoom, options: { since?: number; limit?: number } = {}) => {
    const view = ownsHistoryView(req, room)
      ? service.ownerView(room, historyViewer(req), options)
      : service.view(room, options);
    const human = host.human?.(req),
      cursor = human && host.readAt?.(human.id, room.id);
    if (human && cursor !== undefined)
      return {
        ...view,
        userReadAt: cursor,
        ...unreadFor(
          {
            ...room,
            messages: room.messages.filter((message) => message.at > (view.historyAfter ?? -1)),
            userReadAt: cursor,
          },
          [human.name],
          human.id
        ),
      };
    if (isMultiUserMode() && room.owner !== getAuthUser(req).username) return { ...view, unread: 0, mentions: 0 };
    return view;
  };

  const forbid = (reply: FastifyReply, message: string): FastifyReply =>
    reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, message));

  /**
   * Who the request is for the roles resolver. Owner authority requires the verified cookie.
   * A session is its employee's role, plus
   * Lead where it holds this room's coordinator seat.
   */
  const actorFor = (req: FastifyRequest, room: ChatRoom): Actor => {
    const self = caller(req);
    if (verifiedOwner(req)) return { owner: true };
    if (!self) throw new ChatroomError('Verified owner or agent required', 'INVALID_INPUT');
    return {
      employeeId: employeeOf(self),
      lead: room.members.some((m) => m.sessionId === self && m.role === 'coordinator'),
      leadOfAny: coordinatesVisibleRoom(req, self),
      memberId: self,
    };
  };

  /** Does the request hold `permission` in `room`, counting the room's channel overrides? */
  const allowed = (req: FastifyRequest, room: ChatRoom, permission: Permission): boolean =>
    roles.can(actorFor(req, room), permission, room.overrides);

  /** Who to record for an action: the user's name, or the acting session's. */
  const byName = (req: FastifyRequest): string => {
    const self = caller(req);
    return self ? service.nameOf(self) : userName(req);
  };

  /** The rank of a message's sender in `room` (the user is the Owner and never a target). */
  const senderRank = (room: ChatRoom, from: ChatSender): { rank: number; owner: boolean } => {
    if (from.kind === 'user') return { rank: 0, owner: true };
    // System notices and anything else that is not an agent are Owner-only targets, like the user's own messages.
    if (from.kind !== 'agent') return { rank: 0, owner: true };
    const lead = room.members.some((m) => m.sessionId === from.sessionId && m.role === 'coordinator');
    return { rank: roles.rankOf({ employeeId: employeeOf(from.sessionId), lead }), owner: false };
  };

  /** A session that may join a room owned by `owner`: visible to the caller and owned the same way. */
  const joinableSession = (req: FastifyRequest, room: { owner?: string }, sessionId: string): string => {
    const session = findSessionOrFail(ctx, sessionId, req);
    if (isMultiUserMode() && (session.owner ?? undefined) !== (room.owner ?? undefined)) {
      throw new ChatroomError('That session belongs to another user', 'INVALID_INPUT');
    }
    return session.id;
  };

  app.get('/api/chatrooms', async (req) => {
    // The stall watcher needs only aggregate pending counts. Never return room names,
    // room identities, content, attachments or owner/role capabilities through this grant.
    if (host.pendingStatus?.(req) && !verifiedOwner(req)) {
      const sessions = new Set(service.rooms().flatMap(room => room.members.map(member => member.sessionId)));
      return { success: true, data: { serviceView: 'pending-deliveries', rooms: [{ members: [...sessions].map(sessionId => ({ sessionId, pendingDeliveries: service.deliveryStatus(sessionId).pending })) }] } };
    }
    const { member } = req.query as { member?: string };
    const self = caller(req);
    const memberId = member === 'self' ? self : member;
    const user = getAuthUser(req);
    const rooms = service
      .rooms()
      .filter((r) => canAccessOwned(user, r.owner))
      // An agent lists the rooms it is in (`agent chat rooms --all` also lists the public ones it could join).
      .filter((r) => !self || r.members.some((m) => m.sessionId === self))
      .filter((r) => !memberId || r.members.some((m) => m.sessionId === memberId));
    return {
      success: true,
      data: {
        self: self ?? null,
        // For an agent asking about its own rooms: where its last prompt came from, so a verb with no --room can reply there.
        ...(self && member === 'self' ? { lastDelivery: service.lastDeliveryRooms(self) ?? null } : {}),
        // What this server can do, so a page built for more never shows a control that does nothing.
        features: { search: !!verifiedOwner(req) && !self && host.human?.(req)?.primary !== false, pollingModes: listClis().filter(entry => modePollsChat(entry.id)).map(entry => entry.id), unread: true, dms: true, placement: true, replies: true, deletes: true, reports: true, topics: true, edits: true, pins: true, order: true, notify: true, replace: true },
        // What the owner is called in a room, so the page counts an `@name` of them as a mention.
        ownerNames: service.ownerNames(isMultiUserMode() ? user.username : undefined),
        // Sessions retired by a plan switch: the page keeps them out of its pickers (the owner sees them in a list).
        retired: self ? [] : service.retiredSessions((owner) => canAccessOwned(user, owner)).map((r) => r.sessionId),
        rooms: rooms.map((r) => {
          const view = ownedView(req, r, { limit: 1 });
          return { ...view, lastMessage: view.messages[0] ?? null, messages: undefined };
        }),
      },
    };
  });

  // The user's direct message with one agent. Only the user opens one here; agents already in a
  // DM post to it like any room, and one that is not a participant cannot see it.
  app.post('/api/chatrooms/dms', async (req, reply) => {
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user starts a direct message');
    const body = parseBody(ChatroomDmSchema, req.body);
    try {
      const sessionId = joinableSession(req, { owner: ownerFor(req) }, body.sessionId);
      return { success: true, data: ownedView(req, service.openDm(sessionId, ownerFor(req))) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/api/chatrooms/:id/placement', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user arranges chatrooms');
    const body = parseBody(ChatroomPlacementSchema, req.body);
    try {
      roomOrFail(req, id);
      return { success: true, data: service.view(service.placeRoom(id, body), { limit: 0 }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/api/chatrooms/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user archives chatrooms');
    const body = parseBody(ChatroomArchiveSchema, req.body);
    try {
      roomOrFail(req, id);
      return { success: true, data: service.view(service.archiveRoom(id, body.archived), { limit: 0 }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A plan switch gives an agent a new session; this moves the old one's place in every room to it. The owner may always do it. An agent
  // may only hand over ITS OWN place (the caller is the old session), to a successor that resumes its conversation (one native thread) and
  // was made by it or by the owner (not by another agent: a session can be created "resuming" anyone's thread). A name is not proof: an
  // agent can rename itself. Anything else (a fresh-thread move, a script run by someone else) is the owner's.
  app.post('/api/chatrooms/members/replace', async (req, reply) => {
    const body = parseBody(ChatroomReplaceSchema, req.body);
    const user = getAuthUser(req);
    const successor = ctx.sessions.get(body.to);
    if (!successor || !canAccessOwned(user, successor.owner)) {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'The new session is not an open session of yours'));
    }
    const self = caller(req);
    if (self) {
      const old = ctx.sessions.get(body.from);
      const thread = successor.claudeSessionId;
      const oneMind = !!thread && (thread === body.from || (!!old && old.claudeSessionId === thread));
      const handedByOld = self === body.from;
      const madeByOldOrOwner = !successor.parentSessionId || successor.parentSessionId === body.from;
      if (!(oneMind && handedByOld && madeByOldOrOwner)) {
        return forbid(reply, 'An agent may hand over only its own place, to a successor that resumes its conversation and was made by it or by the owner. Ask the owner to move it');
      }
    }
    try {
      const rooms = await service.replaceSession(body.from, body.to, caller(req) ? service.nameOf(caller(req) as string) : userName(req), (room) => canAccessOwned(user, room.owner));
      return { success: true, data: { rooms } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The retired sessions (the old rows left by plan switches): only the owner lists them, restores one (the places move back and the
  // successor retires in its stead) or forgets one.
  app.get('/api/chatrooms/retired', async (req, reply) => {
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user sees retired sessions');
    const user = getAuthUser(req);
    return {
      success: true,
      data: {
        retired: service.retiredSessions((owner) => canAccessOwned(user, owner)).map((r) => ({
          sessionId: r.sessionId,
          name: r.name,
          successorId: r.successorId,
          at: r.at,
          rooms: r.rooms.map((x) => ({ id: x.roomId, name: x.roomName })),
          restorable: !!ctx.sessions.get(r.sessionId),
        })),
      },
    };
  });

  app.post('/api/chatrooms/retired/:sessionId/restore', async (req, reply) => {
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user restores a retired session');
    const { sessionId } = req.params as { sessionId: string };
    const user = getAuthUser(req);
    const entry = service.retiredSessions((owner) => canAccessOwned(user, owner)).find((r) => r.sessionId === sessionId);
    if (!entry) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such retired session'));
    if (!ctx.sessions.get(sessionId)) return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, 'That session is gone, so there is nothing to restore'));
    try {
      const rooms = await service.replaceSession(entry.successorId, sessionId, userName(req), (room) => canAccessOwned(user, room.owner));
      return { success: true, data: { rooms } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/chatrooms/retired/:sessionId', async (req, reply) => {
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user forgets a retired session');
    const { sessionId } = req.params as { sessionId: string };
    const user = getAuthUser(req);
    const entry = service.retiredSessions((owner) => canAccessOwned(user, owner)).find((r) => r.sessionId === sessionId);
    if (!entry) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such retired session'));
    // Delete: the old session itself goes (its terminal is closed and its row removed; its transcript stays on disk), and it stops being a rollback.
    if (ctx.sessions.get(sessionId)) {
      try {
        await ctx.cleanupSession(sessionId, true, 'user_delete');
      } catch (err) {
        return reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Could not delete the session: ${(err as Error).message}`));
      }
    }
    await service.forgetRetired(sessionId);
    return { success: true, data: { sessionId } };
  });

  // The owner's order of channels in their sidebar. Only the owner sets it, and only for rooms they own; it is a view setting and does
  // not change what any agent sees.
  app.put('/api/chatrooms/order', async (req, reply) => {
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user arranges chatrooms');
    const body = parseBody(ChatroomOrderSchema, req.body);
    const user = getAuthUser(req);
    const mine = body.ids.filter((id) => {
      const room = service.room(id);
      return !!room && canAccessOwned(user, room.owner);
    });
    return { success: true, data: { placed: service.setRoomOrder(mine) } };
  });

  // The owner, or the room's coordinator (its admin), decides whether a channel is public (any agent can list it and join) or private
  // (members only, the default). Every other agent is refused; the owner can always change it back.
  app.put('/api/chatrooms/:id/visibility', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ChatroomVisibilitySchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      if (!allowed(req, room, 'room.settings')) {
        return forbid(reply, 'Only the user or someone with room settings rights makes a chatroom public or private');
      }
      const by = self ? { name: service.nameOf(self), kind: 'agent' as const } : { name: userName(req), kind: 'user' as const };
      return { success: true, data: service.view(await service.setRoomVisibility(id, body.visibility, by), { limit: 0 }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The public channels an agent could join: name, topic and size only. A private channel is never listed.
  app.get('/api/chatrooms/public', async (req) => {
    const self = caller(req);
    const user = getAuthUser(req);
    return { success: true, data: { rooms: service.publicRooms(isMultiUserMode() ? user.username : undefined, self) } };
  });

  // An agent joins a public channel itself, through the same checks as being added (a live session that takes chat); a private one
  // needs the owner or its coordinator to add it.
  app.post('/api/chatrooms/:id/join', async (req, reply) => {
    const { id } = req.params as { id: string };
    const self = caller(req);
    if (!self) return forbid(reply, 'Only an agent joins a channel itself; the owner adds members');
    try {
      const room = service.room(id);
      if (!room || !canAccessOwned(getAuthUser(req), room.owner) || isDm(room)) throw new ChatroomError(`No chatroom ${id}`, 'NOT_FOUND');
      if (room.members.some((m) => m.sessionId === self)) {
        return { success: true, data: { joined: false, room: service.view(room, { limit: 0 }) } };
      }
      if (!isPublicRoom(room) && !roles.can(actorFor(req, room), 'members.join_any', room.overrides)) {
        return forbid(reply, "This channel is private: ask the owner or the room's coordinator to add you");
      }
      const sessionId = joinableSession(req, room, self);
      service.addMember(id, sessionId, {});
      return { success: true, data: { joined: true, room: service.view(room, { limit: 0 }) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The owner sets, per room, whether a post to the whole room wakes every member or only those it is for.
  app.put('/api/chatrooms/:id/wake', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user sets how a chatroom wakes its members');
    const body = parseBody(ChatroomWakeSchema, req.body);
    try {
      roomOrFail(req, id);
      return { success: true, data: service.view(service.setRoomWake(id, body.mode), { limit: 0 }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms', async (req, reply) => {
    const self = caller(req);
    // The user may always create. An agent may only if it already coordinates a room it can see.
    if (self && !coordinatesVisibleRoom(req, self)) {
      return forbid(reply, 'Only the user or a coordinator can create chatrooms; ask the user');
    }
    const body = parseBody(ChatroomCreateSchema, req.body);
    try {
      if (self) {
        // The creator coordinates its own room; only the user appoints anyone else, and
        // no agent marks itself as the voice.
        if (body.coordinatorSessionId !== undefined && body.coordinatorSessionId !== self) {
          return forbid(reply, 'Only the user appoints the coordinator; a room you create is coordinated by you');
        }
        if (body.members?.some((m) => m.sessionId === self && m.voice !== undefined)) {
          return forbid(reply, 'Only the coordinator (or the user) marks a member as the voice, never itself');
        }
      }
      // Resolve and check every member BEFORE the room exists, so a bad id never
      // leaves a half-built room (or briefings queued for one) behind.
      const owner = ownerFor(req);
      const members = new Map<string, { goal?: string; icon?: string; voice?: boolean }>();
      for (const m of body.members ?? []) {
        members.set(joinableSession(req, { owner }, m.sessionId), { goal: m.goal, icon: m.icon, voice: m.voice });
      }
      // Validate the entries that will be used (a repeated session id keeps its last entry).
      for (const { icon } of members.values()) {
        if (icon !== undefined && normalizeIcon(icon) === undefined) {
          throw new ChatroomError('An icon is one emoji or at most two characters', 'INVALID_INPUT');
        }
      }
      // A room has one voice: asking for two is a mistake to report, not a silent last-wins.
      if ([...members.values()].filter((m) => m.voice).length > 1) {
        throw new ChatroomError('Only one member can be the voice', 'INVALID_INPUT');
      }
      const coordinator =
        self ?? (body.coordinatorSessionId ? joinableSession(req, { owner }, body.coordinatorSessionId) : undefined);
      // The creator takes a member slot too: refuse a full house now, never after the room exists.
      if (members.size + (coordinator && !members.has(coordinator) ? 1 : 0) > MAX_MEMBERS) {
        throw new ChatroomError(`At most ${MAX_MEMBERS} members per room, the coordinator included`, 'CONFLICT');
      }
      // A pane that would run room text as commands (a shell, including a shell creator)
      // is refused here, before the room exists.
      for (const [sessionId, options] of members) {
        service.assertJoinable(sessionId, sessionId === coordinator ? { ...options, role: 'coordinator' } : options);
      }
      if (coordinator && !members.has(coordinator)) service.assertJoinable(coordinator, { role: 'coordinator' });
      const room = service.createRoom(body.name, owner);
      // A room an agent builds is marked as its own work, its coordinator seat included.
      const addedBy = self ? { addedBy: self } : {};
      for (const [sessionId, options] of members) {
        if (sessionId !== coordinator) service.addMember(room.id, sessionId, { ...options, ...addedBy });
      }
      if (coordinator) service.addMember(room.id, coordinator, { ...members.get(coordinator), role: 'coordinator', ...addedBy });
      return { success: true, data: ownedView(req, room) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  const searchQuery = z.object({ q: z.string().trim().min(1).max(160), roomId: z.string().min(1).max(100).optional(),
    before: z.string().max(400).optional() }).strict();
  const searchCursor = z.object({ at: z.number().int().nonnegative(), id: z.string().min(1).max(100), roomId: z.string().min(1).max(100) }).strict();
  const humanSearch = (req: FastifyRequest) => verifiedOwner(req) && !caller(req) &&
    req.headers['x-reverie-parent-session'] === undefined && req.headers['x-reverie-service-token'] === undefined && host.human?.(req)?.primary !== false;
  app.get('/api/chatrooms/search', async (req, reply) => {
    if (!humanSearch(req)) return forbid(reply, 'Verified owner browser required for channel search');
    const parsed = searchQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected search words and optional channel/cursor'));
    try {
      const { q, roomId, before } = parsed.data;
      const cursor = before ? searchCursor.parse(JSON.parse(before)) : undefined;
      const user = getAuthUser(req);
      let rooms = service.rooms().filter(room => !isDm(room) && canAccessOwned(user, room.owner));
      if (roomId) { const room = roomOrFail(req, roomId); if (isDm(room)) throw new ChatroomError('Channel not found', 'NOT_FOUND'); rooms = rooms.filter(item => item.id === room.id); }
      const page = service.searchMessages(rooms.map(room => room.id), q, cursor);
      const names = new Map(rooms.map(room => [room.id, room.name]));
      return { success: true, data: { ...page, hits: page.hits.map(hit => ({ ...hit, roomName: names.get(hit.roomId) })), order: 'newest', timeZone: service.searchTimeZone(ownerFor(req)) } };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid search cursor'));
      return sendError(reply, error);
    }
  });
  app.get('/api/chatrooms/:id/search-context/:messageId', async (req, reply) => {
    if (!humanSearch(req)) return forbid(reply, 'Verified owner browser required for channel search');
    const { id, messageId } = req.params as { id: string; messageId: string };
    try {
      const room = roomOrFail(req, id);
      if (isDm(room)) throw new ChatroomError('Channel not found', 'NOT_FOUND');
      return { success: true, data: { roomId: id, roomName: room.name, messageId, timeZone: service.searchTimeZone(room.owner),
        messages: service.searchContext(id, messageId).map(message => ({ id: message.id, at: message.at,
          sender: message.from.name ?? '', text: message.text ?? '' })) } };
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/chatrooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };
    try {
      const room = roomOrFail(req, id);
      return {
        success: true,
        data: ownedView(req, room, { since: parseNumber(q.since), limit: parseNumber(q.limit) ?? 200 }),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/clear-history', async (req, reply) => {
    if (
      !verifiedOwner(req) ||
      caller(req) ||
      req.headers['x-reverie-parent-session'] !== undefined ||
      req.headers['x-reverie-service-token'] !== undefined
    )
      return forbid(reply, 'Only the owner clears their own DM view');
    const body = ChatroomClearHistorySchema.safeParse(req.body ?? {});
    if (!body.success)
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected an empty body'));
    try {
      const room = roomOrFail(req, (req.params as { id: string }).id);
      if (!ownsHistoryView(req, room)) return forbid(reply, 'Only your own direct-message view can be cleared');
      await service.clearOwnerHistory(room.id, historyViewer(req));
      return { success: true, data: ownedView(req, room) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // The user's read cursor. Persisted with the room, so it follows the owner across reloads
  // and devices. Agents never move it, and in multi-user mode only the room's own owner does
  // (an admin looking at someone else's room must not mark it read for them).
  app.post('/api/chatrooms/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user marks a chatroom read');
    const body = parseBody(ChatroomReadSchema, req.body ?? {});
    try {
      const room = roomOrFail(req, id);
      if (isMultiUserMode() && room.owner !== getAuthUser(req).username) {
        return { success: true, data: { userReadAt: room.userReadAt ?? 0, unread: 0, mentions: 0 } };
      }
      const human = host.human?.(req);
      if (human && !human.primary && host.markRead) {
        const at = await host.markRead(human.id, id, body.at);
        return { success: true, data: { userReadAt: at, ...unreadFor({ ...room, userReadAt: at }, [human.name], human.id) } };
      }
      return { success: true, data: service.markRead(id, body.at) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/api/chatrooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user can rename a chatroom');
    const body = parseBody(ChatroomUpdateSchema, req.body);
    try {
      roomOrFail(req, id);
      return { success: true, data: ownedView(req, service.updateRoom(id, body), { limit: 0 }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/chatrooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user can delete a chatroom');
    try {
      roomOrFail(req, id);
      await service.deleteRoom(id, userName(req));
      return { success: true, data: { id } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/members', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ChatroomMemberAddSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      if (self) {
        if (!allowed(req, room, 'members.add')) {
          return forbid(reply, 'Only the coordinator (or the user) can add members');
        }
        if (body.role === 'coordinator') return forbid(reply, 'Only the user appoints the coordinator');
        if (body.postOnly) return forbid(reply, 'Only the user adds a post-only member');
        // The coordinator may add a voice member: it is the one directing the room.
      }
      const sessionId = joinableSession(req, room, body.sessionId);
      if (service.isRetired(sessionId)) throw new ChatroomError('That session was retired after a plan switch: add its successor instead', 'CONFLICT');
      // Same rule as the status route: no agent marks itself as the voice, and re-adding
      // itself must not be the way around it.
      if (self && body.voice !== undefined && sessionId === self) {
        return forbid(reply, 'Only the coordinator (or the user) marks a member as the voice, never itself');
      }
      const member = service.addMember(id, sessionId, {
        goal: body.goal,
        icon: body.icon,
        voice: body.voice,
        role: body.role,
        postOnly: body.postOnly,
        ...(self ? { addedBy: self } : {}),
      });
      return { success: true, data: { member, room: ownedView(req, room, { limit: 0 }) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/chatrooms/:id/members/:sessionId', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      if (self && self !== sessionId) {
        if (!allowed(req, room, 'members.remove_others')) {
          return forbid(reply, 'Only the coordinator (or the user) can remove other members');
        }
        // Same rule as deleting a message: you can only remove someone ranked below you; anyone may leave.
        const lead = room.members.some((m) => m.sessionId === sessionId && m.role === 'coordinator');
        if (!roles.outranks(actorFor(req, room), roles.rankOf({ employeeId: employeeOf(sessionId), lead }))) {
          return forbid(reply, 'You can only remove a member ranked below you');
        }
      }
      if (!service.removeMember(id, sessionId)) throw new ChatroomError('Not a member of this room', 'NOT_FOUND');
      return { success: true, data: { room: ownedView(req, room, { limit: 0 }) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/coordinator', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user appoints the coordinator');
    const body = parseBody(ChatroomCoordinatorSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      let target: string | null = null;
      if (body.sessionId) {
        target = joinableSession(req, room, body.sessionId);
        if (!room.members.some((m) => m.sessionId === target)) {
          service.addMember(id, target, { role: 'coordinator' });
        }
      }
      service.appointCoordinator(id, target);
      return { success: true, data: ownedView(req, room, { limit: 0 }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Which messages wake a member: the member chooses for itself (`mentions` = only what is meant for it), and the owner can set any
  // member's. It never loses a message: what does not wake a member rides along with its next prompt, and `chat read` shows it all.
  app.put('/api/chatrooms/:id/members/:sessionId/notify', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    const body = parseBody(ChatroomNotifySchema, req.body);
    try {
      roomOrFail(req, id);
      const self = caller(req);
      if (self && self !== sessionId) return forbid(reply, 'An agent sets only its own notifications');
      return { success: true, data: { member: service.setMemberNotify(id, sessionId, body.mode) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/members/:sessionId/status', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    const body = parseBody(ChatroomStatusSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      if (self) {
        const isCoordinator = allowed(req, room, 'members.add');
        // Who answers spoken turns is decided by the user or the coordinator, never by an
        // agent about itself, so the mic can never be pointed at the wrong session.
        // Never about itself, coordinator included: the voice is whoever runs the voice daemon.
        if (body.voice !== undefined && (!isCoordinator || self === sessionId)) {
          return forbid(reply, 'Only the coordinator (or the user) marks a member as the voice, never itself');
        }
        const onlyVoice = Object.keys(body).every((k) => k === 'voice');
        if (self !== sessionId && !(isCoordinator && onlyVoice)) {
          return forbid(reply, 'Agents set only their own synopsis');
        }
      }
      return { success: true, data: { member: service.setStatus(id, sessionId, body) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/members/:sessionId/brief', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      // An agent may re-brief itself; only the coordinator may re-brief others or the room.
      if (self && self !== sessionId && !allowed(req, room, 'members.add')) {
        return forbid(reply, 'Only the coordinator (or the user) can re-brief other members');
      }
      const count = service.rebrief(id, sessionId === 'all' ? undefined : sessionId);
      if (count === 0) throw new ChatroomError('Not a member of this room', 'NOT_FOUND');
      return { success: true, data: { briefed: count } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Who a request is, for reactions and uploads: a member session, or the user. */
  const actor = (req: FastifyRequest, room: ChatRoom): string | undefined => {
    const self = caller(req);
    if (!self) return verifiedOwner(req) ? 'user' : undefined;
    return room.members.some((m) => m.sessionId === self) ? self : undefined;
  };

  app.delete('/api/chatrooms/:id/messages/:messageId', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    try {
      const room = roomOrFail(req, id);
      if (!allowed(req, room, 'messages.delete_others')) return forbid(reply, 'You cannot delete messages here (messages.delete_others)');
      const target = room.messages.find((m) => m.id === messageId);
      if (target && caller(req)) {
        const { rank, owner } = senderRank(room, target.from);
        if (!roles.outranks(actorFor(req, room), rank, owner)) return forbid(reply, 'You can only delete messages from someone ranked below you');
      }
      await service.deleteMessage(id, messageId, byName(req), roles.rankOf(actorFor(req, room)));
      return { success: true, data: { id: messageId, deleted: true } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Edit: only the user, only their own text messages. Quiet: nothing is sent to the members; they read the new text next time.
  app.put('/api/chatrooms/:id/messages/:messageId', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    if (!verifiedOwner(req)) return forbid(reply, 'Only the user edits messages');
    const body = parseBody(ChatroomEditSchema, req.body);
    try {
      roomOrFail(req, id);
      const message = await service.editMessage(id, messageId, body.text, userName(req), { ownerVerified: verifiedOwner(req) });
      return { success: true, data: { id: messageId, text: message.text, edited: message.edited ?? null } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Who may pin: the user, or the room's coordinator (an agent that coordinates THIS room). Returns who to record, or null. */
  const pinner = (req: FastifyRequest, room: ChatRoom): { name: string; kind: 'user' | 'agent' } | null => {
    const self = caller(req);
    if (!self) return verifiedOwner(req) ? { name: userName(req), kind: 'user' } : null;
    return allowed(req, room, 'pins.manage') ? { name: service.nameOf(self), kind: 'agent' } : null;
  };

  app.get('/api/chatrooms/:id/pins', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const room = roomOrFail(req, id);
      const after = ownsHistoryView(req, room) ? service.ownerHistoryAfter(room, historyViewer(req)) : -1;
      return { success: true, data: { pins: service.pinned(id).filter(message => message.at > after) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  for (const [method, on] of [['post', true], ['delete', false]] as const) {
    app[method]('/api/chatrooms/:id/messages/:messageId/pin', async (req, reply) => {
      const { id, messageId } = req.params as { id: string; messageId: string };
      try {
        const room = roomOrFail(req, id);
        const by = pinner(req, room);
        if (!by) return forbid(reply, 'You cannot pin messages here (pins.manage)');
        // The user can unpin anything; the coordinator cannot unpin what the user pinned.
        if (!on && by.kind === 'agent' && room.messages.find((m) => m.id === messageId)?.pinned?.kind === 'user') {
          return forbid(reply, 'Only the user can unpin a message the user pinned');
        }
        const message = await service.pinMessage(id, messageId, by, on);
        return { success: true, data: { id: messageId, pinned: message.pinned ?? null } };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  }

  app.post('/api/chatrooms/:id/messages/:messageId/restore', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    try {
      const room = roomOrFail(req, id);
      if (!allowed(req, room, 'messages.restore')) return forbid(reply, 'You cannot restore messages here (messages.restore)');
      // Undoing a deletion needs the deleter's rank or more: a Lead cannot undo a Moderator's or the Owner's moderation.
      const gone = room.messages.find((m) => m.id === messageId)?.deleted;
      if (gone && roles.rankOf(actorFor(req, room)) < (gone.byRank ?? OWNER_RANK)) {
        return forbid(reply, 'You can only restore a message deleted by someone ranked at or below you');
      }
      await service.restoreMessage(id, messageId, byName(req));
      return { success: true, data: { id: messageId, deleted: false } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/messages/:messageId/report', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = parseBody(ChatroomReportSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      // An agent reports as itself, and only from a room it belongs to; the user reports as before.
      if (self && !room.members.some((m) => m.sessionId === self)) return forbid(reply, 'Only a member of this room reports its messages');
      if (!allowed(req, room, 'messages.report')) return forbid(reply, 'You cannot report messages in this room');
      const from: ChatSender = self ? { kind: 'agent', sessionId: self, name: service.nameOf(self) } : { kind: 'user', name: userName(req), ...(host.human?.(req) ? { humanId: host.human(req)!.id } : {}) };
      const { message, dmId } = await service.reportMessage(id, messageId, body.reason ?? '', from);
      return { success: true, data: { message, dmId } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/messages/:messageId/reactions', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = parseBody(ChatroomReactionSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const who = actor(req, room);
      if (!who) return forbid(reply, 'Join the room before reacting');
      if (!allowed(req, room, 'messages.react')) return forbid(reply, 'You cannot react here (messages.react)');
      const emote = /^:([a-z0-9_]{2,32}):$/.exec(body.emoji);
      if (emote) {
        if (!(await files.emotesFor(id)).some((e) => e.name === emote[1])) {
          throw new ChatroomError(`No emote :${emote[1]}: in this room`, 'INVALID_INPUT');
        }
      } else if (!normalizeIcon(body.emoji) || !isReactionEmoji(body.emoji)) {
        // A real emoji (or a flag), never plain letters a member session could send.
        throw new ChatroomError('A reaction is one emoji or a :custom_emote:', 'INVALID_INPUT');
      }
      return { success: true, data: { reactions: service.react(id, messageId, body.emoji.trim(), who, body.on) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ─── Polls ───────────────────────────────────────────────────────────────────
  // A poll is a message with a question and options. Members vote (the user too); the user or the poll's author closes it.
  /**
   * In a channel everyone in it reads every message, so nothing anyone types is addressed to anyone: it goes to everyone, and a
   * `to` that is sent is ignored (not an error, so a caller that still sends one does not stall) and reported back as `toIgnored`.
   * Whoever it is for is @mentioned. The one exception is a spoken turn (the owner speaking to the room's voice member), and a
   * direct message is a room of its own, so it is untouched.
   */
  const recipientsFor = (
    room: ChatRoom,
    requested: string[] | undefined,
    spoken: boolean
  ): { to: 'all' | ChatRecipient[]; toIgnored: boolean } => {
    if (!isDm(room) && !spoken) {
      return { to: 'all', toIgnored: !!requested?.length && !(requested.length === 1 && requested[0].toLowerCase() === 'all') };
    }
    return { to: service.resolveRecipients(room, requested), toIgnored: false };
  };

  app.post('/api/chatrooms/:id/polls', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ChatroomPollSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      let from: ChatSender;
      if (self) {
        if (!room.members.some((m) => m.sessionId === self)) return forbid(reply, 'Join the room before posting a poll');
        if (!allowed(req, room, 'messages.post')) return forbid(reply, 'You cannot post in this room (messages.post)');
        from = { kind: 'agent', sessionId: self, name: service.nameOf(self) };
      } else {
        const mark = ownerMark(req, verifiedOwner, false);
        from = { kind: 'user', name: userName(req), ...(host.human?.(req) ? { humanId: host.human(req)!.id } : {}), ...(mark ? { mark } : {}) };
      }
      const recipients = recipientsFor(room, body.to, false);
      const message = service.createPoll(
        id,
        from,
        { question: body.question, options: body.options, multi: body.multi, closesAt: body.closesAt, recommended: body.recommended },
        recipients.to
      );
      return { success: true, data: { message, ...(recipients.toIgnored ? { toIgnored: true } : {}) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/messages/:messageId/poll/vote', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = parseBody(ChatroomPollVoteSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const who = actor(req, room);
      if (!who) return forbid(reply, 'Join the room before voting');
      if (!allowed(req, room, 'messages.react')) return forbid(reply, 'You cannot vote here (messages.react)');
      return { success: true, data: { poll: service.votePoll(id, messageId, who, body.options) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Car mode on the owner's page reports a message addressed to the user that it did not play, or cut short (playbackNotice).
  app.post('/api/chatrooms/:id/messages/:messageId/playback', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = parseBody(ChatroomPlaybackSchema, req.body);
    try {
      roomOrFail(req, id);
      // Only the owner's page plays aloud; an agent saying what the user heard would be a note in the user's name.
      if (caller(req)) return forbid(reply, "Only the user's page reports playback");
      return { success: true, data: { told: service.playbackNotice(id, messageId, body.outcome, body.reason) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/messages/:messageId/poll/close', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    try {
      const room = roomOrFail(req, id);
      const who = actor(req, room);
      if (!who) return forbid(reply, 'Join the room before closing a poll');
      const message = room.messages.find((m) => m.id === messageId);
      // polls.close_others closes another agent's poll, never the user's, and only one ranked below the closer.
      const closesOthers =
        message?.from.kind === 'agent' &&
        allowed(req, room, 'polls.close_others') &&
        roles.outranks(actorFor(req, room), senderRank(room, message.from).rank);
      if (message && who !== 'user' && !(message.from.kind === 'agent' && message.from.sessionId === who) && !closesOthers) {
        return forbid(reply, "Only the user, the poll's author, or someone with polls.close_others over its author closes a poll");
      }
      return { success: true, data: { poll: await service.closePoll(id, messageId, who, closesOthers) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ─── Attachments and emotes ─────────────────────────────────────────────────
  // Uploads are raw bytes (Content-Type application/octet-stream; the file's own type
  // rides the query), so the JSON body limit stays as it is everywhere else.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES },
      (_req, body, done) => done(null, body)
    );

    scope.post('/api/chatrooms/:id/files', async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { name?: string; type?: string };
      try {
        const room = roomOrFail(req, id);
        const who = actor(req, room);
        if (!who) return forbid(reply, 'Join the room before attaching files');
        if (!Buffer.isBuffer(req.body)) {
          throw new ChatroomError('Send the file as application/octet-stream', 'INVALID_INPUT');
        }
        // Uploads nobody attached within the grace period stop counting against the room.
        // A deleted message's files stay referenced (on its tombstone) so a restore finds them.
        const referenced = new Set(room.messages.flatMap((m) => [...(m.attachments ?? []), ...(m.deleted?.attachments ?? [])].map((a) => a.id)));
        await files.pruneUnreferenced(id, referenced);
        const file = await files.add(id, { name: q.name ?? 'file', type: q.type ?? '', data: req.body, by: who });
        return { success: true, data: { file: { id: file.id, name: file.name, size: file.size, type: file.type } } };
      } catch (err) {
        if (err instanceof ChatFileError) {
          return reply.code(err.status).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
        }
        return sendError(reply, err);
      }
    });

    scope.post('/api/chatrooms/:id/emotes', async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { name?: string; type?: string; scope?: string };
      try {
        roomOrFail(req, id);
        if (!verifiedOwner(req)) return forbid(reply, 'Only the user adds emotes');
        if (!Buffer.isBuffer(req.body))
          throw new ChatroomError('Send the image as application/octet-stream', 'INVALID_INPUT');
        const emote = await files.addEmote({
          name: String(q.name ?? ''),
          scope: q.scope === 'global' ? 'global' : id,
          type: String(q.type ?? ''),
          data: req.body,
        });
        service.emotesChanged(id);
        return { success: true, data: { emote: { name: emote.name, scope: emote.scope } } };
      } catch (err) {
        if (err instanceof ChatFileError) {
          return reply.code(err.status).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
        }
        return sendError(reply, err);
      }
    });
  });

  // Link a shared-drive file instead of uploading a copy: checked here and again on every read (chat-linked-files.ts).
  app.post('/api/chatrooms/:id/links', { bodyLimit: 8192 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const room = roomOrFail(req, id);
      const who = actor(req, room);
      if (!who) return forbid(reply, 'Join the room before linking files');
      const body = z.object({ path: z.string().max(4096) }).strict().safeParse(req.body);
      if (!body.success) throw new ChatroomError('Send { path } with the file\'s absolute shared-drive path', 'INVALID_INPUT');
      const checked = await checkLinkedFile(body.data.path);
      const referenced = new Set(room.messages.flatMap((m) => [...(m.attachments ?? []), ...(m.deleted?.attachments ?? [])].map((a) => a.id)));
      await files.pruneUnreferenced(id, referenced);
      const file = await files.addLink(id, { path: checked.path, name: checked.name, size: checked.size, type: checked.type, by: who });
      return { success: true, data: { file: { id: file.id, name: file.name, size: file.size, type: file.type, linked: true } } };
    } catch (err) {
      if (err instanceof LinkedFileError) return reply.code(err.status).send(createErrorResponse(err.status === 404 ? ApiErrorCode.NOT_FOUND : err.status === 403 ? ApiErrorCode.FORBIDDEN : ApiErrorCode.INVALID_INPUT, err.message));
      return sendError(reply, err);
    }
  });

  app.get('/api/chatrooms/:id/files/:fileId', async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    try {
      const room = roomOrFail(req, id);
      const file = await files.get(id, fileId);
      if (!file) throw new ChatroomError('No such file', 'NOT_FOUND');
      // A file whose only reference is a deleted message is not served (a restore serves it again).
      const live = room.messages.some((m) => !m.deleted && m.attachments?.some((a) => a.id === fileId));
      const dead = room.messages.some((m) => m.deleted?.attachments?.some((a) => a.id === fileId));
      if (dead && !live) throw new ChatroomError('No such file', 'NOT_FOUND');
      // Open first: a file gone since the index was read (pruned, room deleted) is a clean
      // 404 before any header, and the size and the stream both come from the open file.
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        // A linked file is read live from the shared drive, checked again now: it may have moved or become a symlink.
        let resolvedPath: string;
        if (file.link) {
          try {
            resolvedPath = (await checkLinkedFile(file.link)).real;
          } catch (error) {
            if (error instanceof LinkedFileError && error.status === 403)
              return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, error.message));
            throw error;
          }
        } else resolvedPath = await fs.realpath(file.path);
        if (isSensitivePath(resolvedPath))
          return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Access to this file is blocked'));
        handle = await fs.open(resolvedPath, 'r');
      } catch {
        throw new ChatroomError('No such file', 'NOT_FOUND');
      }
      // The shared drive is writable by agents: a folder on the path can become a symlink between the check and the open.
      // The open file must still be the file a fresh check finds, or nothing is served.
      if (file.link) {
        const opened = await handle.stat();
        const same = await checkLinkedFile(file.link).then((again) => fs.lstat(again.real)).then(
          (now) => now.dev === opened.dev && now.ino === opened.ino, () => false);
        if (!same) {
          await handle.close();
          return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'That file changed while it was opened; try again.'));
        }
      }
      const size = (await handle.stat()).size;
      let inlineType = isInlineImage(file.type) ? file.type : null;
      if (!inlineType && file.type.startsWith('video/')) {
        const head = Buffer.alloc(VIDEO_SNIFF_BYTES);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        inlineType = inlineVideoType(file.type, head.subarray(0, bytesRead));
      }
      const inline = inlineType !== null;
      const encoded = encodeURIComponent(file.name);
      reply
        .header('Content-Type', inlineType ?? 'application/octet-stream')
        .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', file.link ? 'no-store' : 'private, max-age=86400');
      // Streamed and range-aware: a large image opened a few times at once must not be
      // held in memory once per request.
      const range = parseByteRange(req.headers.range, size);
      reply.header('Accept-Ranges', 'bytes');
      if (range.kind === 'unsatisfiable') {
        await handle.close();
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      if (range.kind === 'partial') {
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(handle.createReadStream({ start: range.start, end: range.end }));
      }
      return reply.header('Content-Length', size).send(handle.createReadStream());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/chatrooms/:id/emotes', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      roomOrFail(req, id);
      const list = (await files.emotesFor(id)).map((e) => ({
        name: e.name,
        scope: e.scope === 'global' ? 'global' : 'room',
      }));
      return { success: true, data: { emotes: list } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/chatrooms/:id/emotes/:name/image', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    try {
      roomOrFail(req, id);
      const emote = (await files.emotesFor(id)).find((e) => e.name === name);
      if (!emote) throw new ChatroomError('No such emote', 'NOT_FOUND');
      reply
        .header('Content-Type', emote.type)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, max-age=3600');
      const resolvedPath = await fs.realpath(files.emotePath(emote));
      if (isSensitivePath(resolvedPath))
        return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Access to this file is blocked'));
      return reply.send(await fs.readFile(resolvedPath));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/chatrooms/:id/emotes/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const q = req.query as { scope?: string };
    try {
      const room = roomOrFail(req, id);
      // A global emote is every room's: that stays the user's. A room's own emote needs emotes.remove there.
      if (q.scope === 'global' ? !verifiedOwner(req) : !allowed(req, room, 'emotes.remove')) return forbid(reply, 'You cannot remove emotes here (emotes.remove)');
      if (!(await files.removeEmote(name, q.scope === 'global' ? 'global' : id))) {
        throw new ChatroomError('No such emote', 'NOT_FOUND');
      }
      service.emotesChanged(id);
      return { success: true, data: { name } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/chatrooms/delivery-status', async (req, reply) => {
    const self = caller(req);
    if (!self) return forbid(reply, 'An agent session is required');
    return { success: true, data: service.deliveryStatus(self) };
  });

  app.get('/api/chatrooms/:id/messages/:messageId', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      if (!self) return forbid(reply, 'An agent session is required');
      const data = service.exactAgentRead(self, id, messageId);
      return { success: true, data: { ...data, timeZone: service.displayTimeZone(room.owner), message: agentMessage(data.message, service.phoneAccepts(self, id, messageId), host.messageOwner ?? (() => false)) } };
    } catch (error) { return sendError(reply, error); }
  });

  // A separate purpose avoids recursion: the broker reauthorizes through the ordinary exact GET and files API.
  app.post('/api/chatrooms/:id/messages/:messageId/image-paths', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    try {
      roomOrFail(req, id);
      const self = caller(req);
      if (!self) return forbid(reply, 'An agent session is required');
      if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No materialization arguments accepted'));
      return { success: true, data: await service.agentImagePaths(self, id, messageId) };
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/chatrooms/:id/messages/:messageId/read-ack', async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    try {
      roomOrFail(req, id);
      const self = caller(req);
      if (!self) return forbid(reply, 'An agent session is required');
      const token = (req.body as { readToken?: unknown } | null)?.readToken;
      if (typeof token !== 'string' || token.length > 100) return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected readToken'));
      await service.acknowledgeExactAgentRead(self, id, messageId, token);
      return { success: true, data: { acknowledged: messageId } };
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/chatrooms/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };
    try {
      const room = roomOrFail(req, id);
      const view = ownedView(req, room, { since: parseNumber(q.since), limit: parseNumber(q.limit) ?? 50 });
      // An agent that reads the room has seen what it was given: its seen-marker moves to the newest message returned.
      const self = caller(req);
      if (self && room.members.some((m) => m.sessionId === self)) service.acknowledgeAgentRead(self, room.id, view.messages);
      const messages = self ? view.messages.map(message => agentMessage(message, service.phoneAccepts(self, id, message.id), host.messageOwner ?? (() => false))) : view.messages;
      return { success: true, data: { messages, members: view.members, timeZone: service.displayTimeZone(room.owner) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/chatrooms/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ChatroomMessageSchema, req.body);
    try {
      const room = roomOrFail(req, id);
      const self = caller(req);
      let from: ChatSender;
      if (self) {
        if (!room.members.some((m) => m.sessionId === self)) {
          return forbid(reply, 'Join the room before posting (ask the user or the coordinator to add you)');
        }
        if (!allowed(req, room, 'messages.post')) return forbid(reply, 'You cannot post in this room (messages.post)');
        from = { kind: 'agent', sessionId: self, name: service.nameOf(self) };
      } else {
        // An automated sender whose session id did not resolve must not speak as the user.
        if (body.requireAgent) return forbid(reply, 'Caller is not a known agent session');
        // The owner mark is the server's finding, never the client's: the body schema is strict.
        const mark = ownerMark(req, verifiedOwner, body.spoken === true);
        from = { kind: 'user', name: userName(req), ...(host.human?.(req) ? { humanId: host.human(req)!.id } : {}), ...(mark ? { mark } : {}) };
      }
      const spokenTurn = body.spoken === true && !self;
      const { to, toIgnored } = recipientsFor(room, body.to, spokenTurn);
      // Only the user speaks into the phone; an agent cannot mark its text as speech.
      const spoken = body.spoken === true && from.kind === 'user' ? { spoken: true as const } : {};
      const attachments: ChatAttachment[] = [];
      for (const fileId of new Set(body.attachments ?? [])) {
        const file = await files.get(id, fileId);
        if (!file) throw new ChatroomError(`No uploaded file ${fileId} in this room`, 'INVALID_INPUT');
        attachments.push({ id: file.id, name: file.name, size: file.size, type: file.type, path: file.path, ...(file.link ? { linked: true as const } : {}) });
      }
      // The user's `/roll ...` becomes a real server-side roll; an agent keeps using the roll tool.
      let text = body.text;
      if (from.kind === 'user' && isRollCommand(text)) {
        try {
          text = rollCommand(text, from.name);
        } catch (e) {
          throw new ChatroomError((e as Error).message, 'INVALID_INPUT');
        }
      }
      // Opt-in crossing guard. It runs after the route's last await, in the same tick as the post, so nothing can land
      // between this check and the stored message. Without the fields the post behaves exactly as before.
      if (body.ifNoNewerThan || body.ifLatest) {
        const cursor = body.ifLatest ? (self ? service.lastSeen(self, id)?.messageId : undefined) : body.ifNoNewerThan;
        if (!cursor) {
          return reply.code(409).send({ success: false, errorCode: 'CHAT_NO_READ_MARK',
            error: 'No read position in this room yet; read it, then post again' });
        }
        // One identity per writer: an agent by its session, a person by account (the owner when no humanId is set).
        const writer = (f: ChatSender) => f.kind === 'agent' ? `agent:${f.sessionId}`
          : f.kind === 'user' || f.kind === 'human' ? `person:${f.humanId ?? 'owner'}` : undefined;
        const poster = writer(from);
        const own = (by: ChatSender) => poster !== undefined && writer(by) === poster;
        // The owner's cleared DM history stays cleared: hidden messages are neither a cursor nor listed. Agents keep all of it.
        const all = service.room(id)?.messages ?? [];
        const after = ownsHistoryView(req, room) ? service.ownerHistoryAfter(room, historyViewer(req)) : -1;
        const newer = messagesSince(after < 0 ? all : all.filter((m) => m.at > after), cursor, own);
        if (!newer || newer.length) {
          const shown = (newer ?? []).slice(-5);
          return reply.code(409).send({
            success: false,
            errorCode: 'CHAT_NEWER_MESSAGES',
            error: newer ? `${newer.length} newer message${newer.length === 1 ? '' : 's'} arrived since you read; read them, then post again`
              : 'That message is not in this room\'s recent history; read the room, then post again',
            data: { newer: shown, more: (newer?.length ?? 0) > shown.length },
          });
        }
      }
      // Resolve fresh permitted names before the post, so a failed metadata read cannot hide a stored message.
      const humanNames = host.humanNames?.(room) ?? [];
      const message = service.post(id, from, text, to, {
        ...spoken,
        attachments,
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      });
      // The post stands; a name nobody in the room goes by only earns a heads-up the caller shows.
      const warnings = postWarnings(
        room,
        body.text,
        // Permitted humans are ordinary mention names, separate from owner authority and pane recipients.
        [...room.members.map((m) => service.nameOf(m.sessionId)), ...humanNames],
        service.ownerNames(room.owner),
        // Only an agent has a "last seen"; the service knows the newest message that member has seen here.
        self ? newerUnread(room.messages, self, service.lastSeen(self, id), service.ownerNames(room.owner)[0]) : null
      );
      return { success: true, data: { message, ...(toIgnored ? { toIgnored: true } : {}), ...(warnings.length ? { warnings } : {}) } };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
