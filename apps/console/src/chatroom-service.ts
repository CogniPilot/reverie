/**
 * @fileoverview Chatroom service: store + persistence + pane delivery + SSE.
 *
 * The single mutation boundary for chatrooms. Every change goes through a method
 * here, which persists (debounced, 0600 tmp+rename), broadcasts, and queues pane
 * delivery; routes never touch the store directly.
 *
 * SSE: `chatroom:message` carries one new message; `chatroom:changed` says a room's
 * name, members, roles or synopses changed (or it was created/deleted) and the
 * client re-fetches. Both carry the room's `owner` for multi-user routing.
 */

import { randomUUID, createHash } from 'node:crypto';
import { EmployeeAlertModes, type AlertLease, type AlertMode } from './employee-alert-mode.js';
import { isOwnerMark } from './owner-auth/marks.js';
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, promises as fs, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ChatroomError,
  ChatroomStore,
  MAX_POLL_LABEL,
  MAX_POLL_OPTIONS,
  MAX_MESSAGES_PER_ROOM,
  MAX_POLL_QUESTION,
  accentHue,
  isDm,
  isPublicRoom,
  USER_RECIPIENT,
  loadChatrooms,
  messageRecipients,
  pollIsOpen,
  resolveRecipient,
  saveChatrooms,
  textMentions,
  unreadFor,
  type ChatMember,
  type ChatMessage,
  type ChatPoll,
  type ChatRecipient,
  type ChatRole,
  type ChatRoom,
  type ChatSender,
} from './chatroom-store.js';
import { LastSeenStore, type SeenMark } from './chatroom-last-seen.js';
import { PendingDeliveryStore } from './chatroom-pending-delivery.js';
import { ChatArchive, zoneWeek } from './chat-archive.js';
import { ChatDb, ChatDbSyncError, importLegacy, readArchive, standingLines, type JournalLine, type SyncChanges } from './chat-db.js';
import { ChatroomDelivery, buildBriefing, paneAcceptsChat, modePollsChat, roomLabel, senderLabel, wakeRecipients, renderForRecipient, type DeliverySession } from './chatroom-delivery.js';
import { quoteForPane } from './pane-quote.js';
import { messageWithEmployeeIdentity, stampEmployeeSender, type ChatIdentityLookup } from './chat-message-identity.js';

/** What car mode did with a message addressed to the user (see ChatroomService.playbackNotice). */
export type ChatPlaybackOutcome = 'not-played' | 'interrupted';
/** Why, in the app's words: what it did, not what the user heard. */
export const PLAYBACK_REASONS = {
  'other-room': 'another room was open',
  'read-aloud-off': 'read aloud is off in this room',
  'audio-failed': 'the audio failed',
  stopped: 'read aloud was stopped',
  'timed-out': 'the audio did not report its end in time',
} as const;
export type ChatPlaybackReason = keyof typeof PLAYBACK_REASONS;
const PLAYBACK_NOTICE_MEMORY = 5000;
import type { ChatBot } from './chat-bots.js';
import { ChatroomChanged, ChatroomMessage, ChatroomReaction, ChatroomTurn } from './web/sse-events.js';

export interface ChatSessionLike extends DeliverySession {
  readonly mode: string;
  readonly status: string;
  readonly owner?: string;
}

const CLOSED_ALERT = 'Chat is read-only: a change could not be saved or undone on disk. Fix the disk, then restart the console.';

export interface ChatroomServiceDeps {
  file: string;
  employeeOf?: (sessionId: string) => string | undefined;
  /** The pronouns on a member's employee record (owner-set), shown with the member in every room view. */
  pronounsOf?: (sessionId: string) => string | undefined;
  getSession(id: string): ChatSessionLike | undefined;
  broadcast(event: string, data: unknown): void;
  now?: () => number;
  /** Attachment store; a deleted room's files are removed with it. */
  files?: { removeRoom(roomId: string): Promise<void> };
  /** Append-only JSON-lines log of deletions, restores and reports (default: next to `file`). */
  auditFile?: string;
  /** How long the poll author waits for an owner's votes to settle before hearing about them (default 3000 ms). */
  voteCoalesceMs?: number;
  /** How long an @mentioned agent has to reply before the feed says it has not (default 3 min; REVERIE_OWED_REPLY_MS). */
  owedReplyMs?: number;
  /** The names an owner is called by in a room (their company-settings name), so an `@name` of them counts as a mention. */
  ownerNames?: (owner: string | undefined) => string[];
  /** Sessions whose retired state changed (retired, restored or deleted): the console refreshes their rows so a retired one leaves every tab list. */
  retiredChanged?: (sessionIds: string[]) => void;
  /** Where messages dropped past the per-room cap are archived (default: `chat-archive/` next to `file`). */
  archiveDir?: string;
  /** The company time zone for a room's owner: the archive's week files follow it (default UTC). */
  timeZone?: (owner: string | undefined) => string | undefined;
  /** Tell the owner outside chat (web push) that chat cannot start or has gone read-only. */
  alert?: (text: string) => Promise<unknown> | void;
  /**
   * The chat database (chat-db.ts). When set, rooms and messages live there: every change is committed
   * (and copied to the archive files) before the call that made it returns, and chatrooms.json is only
   * read once, to import it, when the database does not exist yet. Unset: chatrooms.json as before.
   */
  database?: string;
  /** The server calls startDelivery after it has finished restoring all session records. */
  deferDeliveryRecovery?: boolean;
}

export interface ChatMemberView extends ChatMember {
  name: string;
  alertMode?: AlertLease;
  mode?: string;
  alive: boolean;
  working: boolean;
  pendingDeliveries: number;
  /** Accent hue (0-359) derived from the session id; the avatar colour. */
  hue: number;
  /** The member's pronouns, from its employee record; absent when none are set. */
  pronouns?: string;
}

/** A session replaced by its successor after a plan switch: out of every room, hidden, and kept only to roll back to (or to forget). */
export interface RetiredSession {
  sessionId: string;
  name: string;
  successorId: string;
  at: number;
  owner?: string;
  /** Where it was, so Restore can put it back with the same role, goal and settings. */
  rooms: Array<{ roomId: string; roomName: string; member: ChatMember }>;
}

export interface ChatRoomView {
  id: string;
  name: string;
  owner?: string;
  createdAt: number;
  coordinatorId?: string;
  members: ChatMemberView[];
  messages: ChatMessage[];
  messageCount: number;
  lastMessageAt?: number;
  workspace?: string;
  category?: string;
  topic?: string;
  archivedAt?: number;
  /** The room's own wake setting, if the owner set one. */
  wake?: 'all' | 'mentions';
  /** `private` (members only, the default) or `public` (any agent can list it and join). */
  visibility: 'public' | 'private';
  /** The owner's place for the channel in their sidebar, if they placed it. */
  position?: number;
  kind?: 'dm';
  /** A direct message's participants (`user` and/or session ids). */
  dm?: string[];
  /** The user's read cursor (ms), persisted with the room and so with its owner. */
  userReadAt: number;
  /** Agent messages after the read cursor (0 in a direct message the user is not part of). */
  unread: number;
  /** Of those, the ones addressed to the user (`--to user`); in a direct message with the user, all of them. */
  mentions: number;
}

const PERSIST_DEBOUNCE_MS = 500;

/**
 * What the user has not seen in a room. A direct message with the user counts every agent
 * message as a mention (the store's rule), so one can never go unseen; a direct message
 * between agents is not the user's to be notified about.
 */
function userUnread(room: ChatRoom, ownerNames: readonly string[] = []): { unread: number; mentions: number } {
  if (isDm(room) && !room.dm.includes(USER_RECIPIENT)) return { unread: 0, mentions: 0 };
  return unreadFor(room, ownerNames);
}

/** A name fit to keep and show: no control, zero-width or bidirectional-override characters, whitespace collapsed, at most 100 characters; '' for anything else. */
function cleanName(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
}

/** One owner request an agent owes a reply to (see trackOwedReplies). */
interface OwedReply {
  sessionId: string;
  roomId: string;
  messageId: string;
  at: number;
  delivery: 'pending' | 'submitted' | 'unconfirmed';
  /** When the agent's pane was last seen go (or stay) idle; undefined while it is working. The grace runs from here. */
  idleSince: number | undefined;
  /** The fixed-deadline "delivery still unconfirmed" line was shown. */
  deliveryNoted: boolean;
  timer: ReturnType<typeof setTimeout>;
}
/** How often an owed reply's pane is checked for idleness (at most; half the grace when that is shorter). */
const OWED_IDLE_RECHECK_MS = 30_000;
/** While it keeps working, after this long an unconfirmed delivery is said so once. */
const OWED_DELIVERY_DEADLINE_MS = 10 * 60_000;

function etTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
}

export class ChatroomService {
  private store = new ChatroomStore();
  readonly delivery: ChatroomDelivery;
  private readonly alertModes: EmployeeAlertModes;
  private exactReadReceipts = new Map<string, { sessionId: string; roomId: string; messageId: string; hash: string; until: number; session: ChatSessionLike; pid: number | null; employeeId?: string }>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistChain: Promise<void> = Promise.resolve();
  private messageListeners = new Set<(room: ChatRoom, message: ChatMessage) => void>();

  /** What each agent session has seen of each room (chatroom-last-seen.ts), next to the rooms file. */
  readonly seen: LastSeenStore;
  private pendingStore: PendingDeliveryStore | undefined;
  private deliveryReady: boolean;
  private deliveryStart: Promise<void> | undefined;
  private uncertainNotices = new Map<string, { at: number; count: number }>();
  /**
   * Owed replies, one per request: the owner @mentioned or addressed an agent (or @everyone). Settled only by that agent's post
   * whose replyTo is exactly that message. Key: session NUL room NUL message.
   */
  private owedReplies = new Map<string, OwedReply>();
  /** Last visible delivery-problem notice per session NUL room, so a stuck pane can not flood the feed. */
  private deliveryNotices = new Map<string, number>();

  /** Messages past the per-room cap, archived before they are dropped (chat-archive.ts); with the database, its second record. */
  private readonly archive: ChatArchive;

  /** The chat database, when `deps.database` is set and it opened (or was imported) cleanly. */
  private db: ChatDb | undefined;
  /** Set when a failed commit could not be voided in the archive: writes refused until a restart. */
  private writesClosed: string | undefined;

  constructor(private readonly deps: ChatroomServiceDeps) {
    this.alertModes = new EmployeeAlertModes(deps.file ? join(dirname(deps.file), 'employee-alert-modes.json') : undefined, () => this.now());
    this.deliveryReady = !deps.deferDeliveryRecovery;
    this.archive = new ChatArchive(deps.archiveDir ?? join(dirname(deps.file), 'chat-archive'));
    this.seen = new LastSeenStore(deps.file ? join(dirname(deps.file), 'chat-last-seen.json') : undefined);
    this.delivery = new ChatroomDelivery({
      getSession: deps.getSession,
      forceWake: (sessionId, roomId, messageId) => {
        const message = this.store.get(roomId)?.messages.find((m) => m.id === messageId);
        const mode = this.alertMode(sessionId)?.mode;
        // The owner wakes a member on Ring or Vibrate; on Silent only by @mentioning it or @everyone (alertAllows).
        if (message?.from.kind === 'user' && isOwnerMark(message.from.mark) && mode !== 'silent') return true;
        return (mode === 'vibrate' || mode === 'silent') && this.alertAllows(sessionId, roomId, messageId);
      },
      allowFragment: (sessionId, roomId, messageId) => this.alertAllows(sessionId, roomId, messageId),
      now: deps.now,
      isReady: () => this.deliveryReady,
      pendingStore: () => this.pendingStore,
      onPersistenceError: () => {
        this.writesClosed = 'Pending delivery persistence failed; restart after repairing storage';
        console.error('[chatroom] pending delivery persistence failed; delivery stopped');
        void Promise.resolve(this.deps.alert?.('Chat delivery stopped: pending deliveries could not be saved.')).catch(() => undefined);
      },
      // A turn is starting for this member in this room: the page shows "is thinking" there until it ends.
      onWoken: (sessionId, roomId, at) => {
        const room = this.store?.get(roomId);
        if (room) this.deps.broadcast(ChatroomTurn, { owner: room.owner ?? '@single', roomId, sessionId, at });
      },
      onSubmitted: (sessionId, messages) => {
        for (const { roomId, messageId } of messages) this.markSeen(sessionId, roomId, messageId);
        this.noteOwedDelivery(sessionId, messages, 'submitted');
      },
      onStranded: (sessionId, messages) => {
        const rooms = [...new Set(messages.map((m) => m.roomId))];
        console.warn(`[chatroom] delivery to ${sessionId.slice(0, 8)} is still unsubmitted in its composer (rooms ${rooms.join(', ')})`);
        void this.audit({ action: 'delivery-stranded', sessionId, rooms, messages: messages.length }).catch(() => undefined);
        this.noticeDeliveryProblem(sessionId, rooms, 'Delivery to %s failed: the message is still unsent in its composer (held, not resent)');
        this.noteOwedDelivery(sessionId, messages, 'unconfirmed');
      },
      onUncertain: (sessionId, messages) => {
        const rooms = [...new Set(messages.map((m) => m.roomId))];
        console.warn(`[chatroom] delivery to ${sessionId.slice(0, 8)} may have been typed; inspect its pane before retrying`);
        void this.audit({ action: 'delivery-uncertain', sessionId, rooms, messages: messages.length }).catch(() => undefined);
        this.noticeDeliveryProblem(sessionId, rooms, 'Delivery to %s is unconfirmed: it may or may not have been submitted (held, not resent)');
        this.noteOwedDelivery(sessionId, messages, 'unconfirmed');
        const now = this.now();
        const notice = this.uncertainNotices.get(sessionId) ?? { at: -Infinity, count: 0 };
        notice.count++;
        this.uncertainNotices.set(sessionId, notice);
        if (now - notice.at >= 30 * 60_000) {
          const count = notice.count;
          notice.at = now;
          notice.count = 0;
          void this.raiseAlert(`Chat delivery to session ${sessionId.slice(0, 8)} is paused (${count} unconfirmed event${count === 1 ? '' : 's'} since the previous notice). Inspect its pane, then use reverie agent chat read for the affected rooms.`);
        }
      },
    });
  }

  /** Move a member's seen-marker for a room to this message (if newer). Unknown rooms or messages are ignored. */
  markSeen(sessionId: string, roomId: string, messageId: string): void {
    const room = this.store?.get(roomId);
    const message = room?.messages.find((m) => m.id === messageId);
    if (!room || !message) return;
    this.seen.advance(sessionId, roomId, { messageId, at: message.at });
  }

  /** The newest message of this room the session is known to have seen (submitted to its prompt or read via the API). */
  lastSeen(sessionId: string, roomId: string): SeenMark | undefined {
    return this.seen.get(sessionId, roomId);
  }

  deliveryStatus(sessionId: string): { blocked: boolean; pending: number; held: Array<{ roomId: string; messageId: string }> } {
    const holds = this.delivery.inspectionFor(sessionId);
    return {
      blocked: holds.length > 0,
      pending: this.delivery.pendingFor(sessionId),
      held: holds.filter((item) => this.store.get(item.roomId)?.members.some((m) => m.sessionId === sessionId)),
    };
  }

  private exactVisibleMessage(sessionId: string, roomId: string, messageId: string): ChatMessage {
    const room = this.store.get(roomId);
    const session = this.deps.getSession(sessionId);
    if (!room || !session || session.pid === null || session.owner !== room.owner || !room.members.some((m) => m.sessionId === sessionId)) {
      throw new ChatroomError('No visible room for this live session', 'NOT_FOUND');
    }
    const message = room.messages.find((m) => m.id === messageId)
      ?? (this.db ? JSON.parse(String(this.db.db.prepare('SELECT data FROM messages WHERE room_id = ? AND id = ?').get(roomId, messageId)?.data ?? 'null')) as ChatMessage | null : null);
    if (!message || message.id !== messageId || message.roomId !== roomId) throw new ChatroomError('No such message in this room', 'NOT_FOUND');
    if (message.deleted) throw new ChatroomError('Deleted messages require separate owner resolution', 'CONFLICT');
    return structuredClone(this.messageIdentity(room, message));
  }

  exactAgentRead(sessionId: string, roomId: string, messageId: string): { message: ChatMessage; readToken: string } {
    const message = this.exactVisibleMessage(sessionId, roomId, messageId);
    for (const [token, receipt] of this.exactReadReceipts) if (receipt.until <= this.now()) this.exactReadReceipts.delete(token);
    if (this.exactReadReceipts.size >= 256) throw new ChatroomError('Too many pending exact reads; wait for expiry', 'UNAVAILABLE');
    const readToken = randomUUID();
    this.exactReadReceipts.set(readToken, { sessionId, roomId, messageId, hash: createHash('sha256').update(JSON.stringify(message)).digest('hex'), until: this.now() + 60_000, session: this.deps.getSession(sessionId)!, pid: this.deps.getSession(sessionId)!.pid, employeeId: this.deps.employeeOf?.(sessionId) });
    return { message, readToken };
  }

  async acknowledgeExactAgentRead(sessionId: string, roomId: string, messageId: string, token: string): Promise<void> {
    const receipt = this.exactReadReceipts.get(token);
    if (!receipt || receipt.sessionId !== sessionId || receipt.roomId !== roomId || receipt.messageId !== messageId || receipt.until <= this.now()) {
      throw new ChatroomError('Exact-read receipt is missing, expired or belongs to another request', 'CONFLICT');
    }
    const check = () => {
      const current = this.deps.getSession(sessionId);
      if (current !== receipt.session || current?.pid !== receipt.pid || this.deps.employeeOf?.(sessionId) !== receipt.employeeId) throw new ChatroomError('Session or employee binding changed; read again', 'CONFLICT');
      const message = this.exactVisibleMessage(sessionId, roomId, messageId);
      if (receipt.until <= this.now() || createHash('sha256').update(JSON.stringify(message)).digest('hex') !== receipt.hash) throw new ChatroomError('Message changed; read it again before acknowledging', 'CONFLICT');
    };
    check();
    this.exactReadReceipts.delete(token);
    await this.audit({ action: 'exact-read-ack-request', sessionId, roomId, messageId });
    check();
    this.delivery.acknowledgeRead(sessionId, roomId, [messageId]);
  }

  /** Reading a page covers its returned identities, not earlier gaps hidden by the newest seen mark. */
  acknowledgeAgentRead(sessionId: string, roomId: string, messages: ChatMessage[]): void {
    if (!this.store.get(roomId)?.members.some((m) => m.sessionId === sessionId)) return;
    this.delivery.acknowledgeRead(sessionId, roomId, messages.map((m) => m.id));
    for (const message of messages) this.markSeen(sessionId, roomId, message.id);
  }

  private retired: RetiredSession[] = [];

  private depsWithIdentity(): ChatIdentityLookup {
    return { getSession: (sessionId) => this.deps.getSession(sessionId), employeeOf: this.deps.employeeOf, retired: this.retired };
  }

  private messageIdentity(room: ChatRoom, message: ChatMessage): ChatMessage {
    return messageWithEmployeeIdentity(message, room.owner, this.depsWithIdentity());
  }

  private get retiredFile(): string {
    return `${this.deps.file}.retired.json`;
  }

  private async loadRetired(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.retiredFile, 'utf-8')) as unknown;
      this.retired = Array.isArray(parsed)
        ? parsed.filter((r): r is RetiredSession => !!r && typeof (r as RetiredSession).sessionId === 'string' && Array.isArray((r as RetiredSession).rooms))
        : [];
    } catch {
      this.retired = [];
    }
  }

  private async saveRetired(): Promise<void> {
    await fs.mkdir(dirname(this.retiredFile), { recursive: true });
    const tmp = `${this.retiredFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.retired), { mode: 0o600 });
    await fs.rename(tmp, this.retiredFile);
  }

  /** The sessions retired by a plan switch that this owner may see (newest first). */
  retiredSessions(canSee: (owner: string | undefined) => boolean = () => true): RetiredSession[] {
    return this.retired.filter((r) => canSee(r.owner)).sort((a, b) => b.at - a.at);
  }

  isRetired(sessionId: string): boolean {
    return this.retired.some((r) => r.sessionId === sessionId);
  }

  /** Forget a retired session (it is not a rollback any more). Returns whether it was there. */
  async forgetRetired(sessionId: string): Promise<boolean> {
    const before = this.retired.length;
    this.retired = this.retired.filter((r) => r.sessionId !== sessionId);
    if (this.retired.length === before) return false;
    await this.saveRetired();
    this.deps.retiredChanged?.([sessionId]);
    return true;
  }

  async init(): Promise<void> {
    await this.loadRetired();
    const rooms = this.deps.database ? await this.openDatabase(this.deps.database) : await loadChatrooms(this.deps.file);
    this.store = new ChatroomStore(rooms);
    await this.seen.load();
    this.learnNames(rooms);
    if (this.deps.file) {
      try {
        const opened = PendingDeliveryStore.openRecoverable(join(dirname(this.deps.file), 'chat-pending-delivery.db'));
        this.pendingStore = opened.store;
        if (opened.quarantined) {
          console.warn('[chatroom] invalid pending delivery database preserved; starting empty', opened.quarantined);
          await this.audit({ action: 'delivery-journal-quarantined', path: opened.quarantined }).catch(() => undefined);
          await Promise.resolve().then(() => this.deps.alert?.('Chat started with an empty delivery queue after preserving an invalid delivery database. Use chat read for messages that may need catching up.'))
            .catch(() => undefined);
        }
      } catch (error) {
        this.pendingStore?.close();
        this.db?.close();
        throw error;
      }
    }
    if (!this.deps.deferDeliveryRecovery) await this.startDelivery();
  }

  /** Called once the registry is complete: only then is a missing session actually gone. */
  startDelivery(): Promise<void> {
    return this.deliveryStart ??= (async () => {
      this.delivery.stop(); // Bootstrap messages are rebuilt once from their durable identities.
      this.deliveryReady = true;
      try {
        if (this.pendingStore) await this.recoverPendingDeliveries();
        this.delivery.start();
      } catch (error) {
        this.deliveryReady = false;
        this.delivery.stop();
        this.writesClosed = 'Delivery recovery failed; inspect storage and restart';
        console.error('[chatroom] delivery recovery failed; chat writes are closed', error);
        await this.raiseAlert('Chat is read-only: delivery recovery failed during startup. Inspect storage and restart after repair.');
        throw error;
      }
    })();
  }

  async stop(): Promise<void> {
    this.deliveryReady = false;
    for (const pending of this.voteNotices.values()) clearTimeout(pending.timer);
    this.voteNotices.clear();
    for (const owed of this.owedReplies.values()) clearTimeout(owed.timer);
    this.owedReplies.clear();
    this.delivery.stop();
    await this.seen.flush();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.persistNow();
    }
    await this.persistChain;
    // A last full compare: anything changed without naming its room is committed now.
    if (this.db && !this.writesClosed) {
      try {
        this.syncDatabase();
      } catch {
        // Logged by syncDatabase.
      }
    }
    this.db?.close();
    this.db = undefined;
    this.pendingStore?.close();
  }

  /** Restore only the exact queued identities: a newer seen mark cannot cover an older hole. */
  private async recoverPendingDeliveries(): Promise<void> {
    const pending = this.pendingStore!;
    const uncertain = new Map<string, number>();
    const gone = new Set<string>();
    for (const entry of pending.list()) {
      if (gone.has(entry.sessionId)) continue;
      const room = this.store.get(entry.roomId);
      const member = room?.members.find((m) => m.sessionId === entry.sessionId);
      const session = this.deps.getSession(entry.sessionId);
      if (!session) {
        pending.forget(entry.sessionId);
        gone.add(entry.sessionId);
        continue;
      }
      const message = room?.messages.find((m) => m.id === entry.messageId)
        ?? (this.db ? JSON.parse(String(this.db.db.prepare('SELECT data FROM messages WHERE room_id = ? AND id = ?')
          .get(entry.roomId, entry.messageId)?.data ?? 'null')) as ChatMessage | null : null);
      // Membership and owner scope are checked again, never inferred from persisted recipients.
      if (!room || !member || !session || member.postOnly || session.owner !== room.owner || message?.deleted
        || (message && !messageRecipients(room, message).includes(entry.sessionId))) {
        pending.remove([entry.id]);
        continue;
      }
      if (entry.state === 'uncertain' || !message) {
        pending.state([entry.id], 'uncertain');
        this.delivery.holdForInspection(entry.sessionId, [{ roomId: entry.roomId, messageId: entry.messageId }]);
        uncertain.set(entry.roomId, (uncertain.get(entry.roomId) ?? 0) + 1);
        continue;
      }
      const recipients = messageRecipients(room, message);
      const awake = wakeRecipients(room, message, recipients, this.nameOf);
      this.delivery.enqueue(entry.sessionId, room, renderForRecipient(room, message, entry.sessionId, this.nameOf), {
        deliveryId: entry.id, messageId: entry.messageId, at: entry.at,
        passive: entry.passive || !awake.has(entry.sessionId),
      });
    }
    if (uncertain.size) {
      const counts = Object.fromEntries(uncertain);
      console.warn('[chatroom] unconfirmed deliveries require pane inspection and chat read; not automatically pasted again', counts);
      await this.audit({ action: 'delivery-recovery-uncertain', rooms: counts });
      await Promise.resolve(this.deps.alert?.('Some chat deliveries were unconfirmed at restart. Inspect panes and use chat read; they were not pasted again.'))
        .catch(() => undefined);
    }
  }

  /**
   * Open the chat database, importing chatrooms.json and the archive files into it first if it does
   * not exist. A database that fails its integrity check throws (the console does not start on it). An
   * import that does not match its sources is set aside (`chat.db.rejected-<ms>`) and the rooms come
   * from chatrooms.json as before, with an error logged.
   */
  private async openDatabase(file: string): Promise<ChatRoom[]> {
    if (!existsSync(file) && !this.importDatabase(file)) return loadChatrooms(this.deps.file);
    try {
      this.db = ChatDb.open(file);
    } catch (err) {
      // Chat itself is what failed, so this cannot be posted to a room: the log line, the nonzero exit
      // (cli.ts) and the supervisor's exit record and ALERT file are where it shows.
      console.error(
        `[chatroom] REFUSING TO START: ${(err as Error).message}. Nothing was changed. Recover from the newest nightly backup ` +
          `(node dist/chat-db-cli.js check --db BACKUP, then put it in place of ${file}) or rebuild from the archive ` +
          `(node dist/chat-db-cli.js rebuild --archive ${this.archive.dir} --out NEW.db --compare BACKUP).`
      );
      await this.raiseAlert('Chat did not start: its database failed a check. Nothing was changed. The console log has the recovery steps.');
      throw err;
    }
    this.voidOrphans();
    return this.db.loadRooms(MAX_MESSAGES_PER_ROOM);
  }

  /**
   * A txn in the archive that the database never committed and nothing voided: left by writes closed
   * (its void could not be written) or by a crash between the archive append and the commit. Its void
   * goes in now, so a rebuild does not bring it back. Only the plain (current) weeks can hold one: a
   * week is gzipped on an append, and the first append of a run comes after this. If the void still
   * cannot be written, writes stay closed.
   */
  /** The owner alert; never throws (an alert must not change what happens next). */
  private async raiseAlert(text: string): Promise<void> {
    try {
      await this.deps.alert?.(text);
    } catch (err) {
      console.error('[chatroom] owner alert failed:', err);
    }
  }

  private voidOrphans(): void {
    const lines = readArchive(this.archive.dir, { plainOnly: true }).lines;
    const voided = new Set<string>();
    const txns = new Set<string>();
    for (const line of lines) {
      if (line.kind === 'void') voided.add(line.txn);
      else if (line.txn) txns.add(line.txn);
    }
    const open = [...txns].filter((t) => !voided.has(t));
    if (!open.length) return;
    const committed = this.db!.committedTxns(open);
    const orphans = open.filter((t) => !committed.has(t));
    if (!orphans.length) return;
    const now = this.now();
    try {
      this.appendJournal(orphans.map((txn) => ({ kind: 'void', txn, archivedAt: now })), now);
      console.error(`[chatroom] voided ${orphans.length} archive txn(s) the database never committed (writes closed or a crash mid-commit): ${orphans.join(', ')}`);
    } catch (err) {
      this.writesClosed = `the archive has txn(s) ${orphans.join(', ')}, which the database did not commit, and they could not be voided at start`;
      console.error(`[chatroom] WRITES CLOSED: ${this.writesClosed}. Chat stays readable; restart the console after fixing the disk.`, err);
      void this.raiseAlert(CLOSED_ALERT);
    }
  }

  private importDatabase(file: string): boolean {
    const json = this.deps.file;
    // The rollback: chatrooms.json as it was at this attempt, one copy per attempt; the log names the
    // copy that matches the database it made.
    const attempt = this.now();
    const frozen = existsSync(json) ? join(dirname(json), `chatrooms.pre-sqlite-${attempt}.json`) : undefined;
    if (frozen) {
      copyFileSync(json, frozen, fsConstants.COPYFILE_EXCL);
      chmodSync(frozen, 0o600);
    }
    const tmp = `${file}.import-${process.pid}`;
    const report = importLegacy({ json, archiveDir: this.archive.dir, dbFile: tmp });
    if (!report.ok) {
      const aside = `${file}.rejected-${attempt}`;
      renameSync(tmp, aside);
      console.error(`[chatroom] the chat database import did not match chatrooms.json and the archive (kept as ${aside}, its source as ${frozen ?? 'no chatrooms.json'}); staying on chatrooms.json:`, report.problems);
      return false;
    }
    // The archive files become the second record: a baseline of every room, and of every message the
    // archive does not already hold as imported (the archived ones are there), then every change after it.
    const now = this.now();
    const archived = new Map<string, string>();
    for (const line of standingLines(readArchive(this.archive.dir).lines)) {
      if (line.kind === undefined || line.kind === 'message') archived.set(`${line.roomId}/${line.message.id}`, JSON.stringify(line.message));
    }
    const lines: JournalLine[] = [];
    for (const room of loadImportedRooms(tmp)) {
      const { messages, ...data } = room;
      lines.push({ kind: 'room', roomId: room.id, archivedAt: now, data });
      for (const message of messages) {
        if (archived.get(`${room.id}/${message.id}`) !== JSON.stringify(message)) lines.push({ roomId: room.id, room: room.name, archivedAt: now, message });
      }
    }
    this.archive.appendSync(zoneWeek(now, this.deps.timeZone?.(undefined)), lines.map((l) => JSON.stringify(l)));
    renameSync(tmp, file);
    console.log(
      `[chatroom] chat database created from chatrooms.json and the archive: ${report.totals.rooms} rooms, ${report.totals.messages} messages; rollback copy: ${frozen ?? 'none (no chatrooms.json)'}`
    );
    return true;
  }

  /**
   * Commit what changed (in `roomId` only, when given) to the database, its copy to the archive files
   * first, under one txn id; the window trims after. If it cannot be committed, memory goes back to
   * what is (no one may read what a restart would lose), a `void` line for the txn follows its archive
   * lines, and the caller gets UNAVAILABLE (503). If even the void line cannot be written, the archive
   * holds a change the database does not, so writes stop until a restart (fail closed).
   */
  private syncDatabase(roomId?: string): void {
    const now = this.now();
    const db = this.db!;
    if (this.writesClosed) {
      this.store.reset(db.committed());
      throw new ChatroomError(`Chat is read-only until the console restarts: ${this.writesClosed}`, 'UNAVAILABLE');
    }
    const txn = randomUUID();
    try {
      db.sync(this.store.list(), MAX_MESSAGES_PER_ROOM, (changes) => this.journal(changes, now, txn), roomId ? new Set([roomId]) : undefined, txn);
    } catch (err) {
      this.store.reset(db.committed());
      if (err instanceof ChatDbSyncError && err.journaled) {
        try {
          this.appendJournal([{ kind: 'void', txn, archivedAt: now }], now);
        } catch (voidErr) {
          this.writesClosed = `the archive has txn ${txn}, which the database did not commit, and it could not be voided`;
          console.error(`[chatroom] WRITES CLOSED: ${this.writesClosed}. Chat stays readable; restart the console after fixing the disk.`, voidErr);
          void this.raiseAlert(CLOSED_ALERT);
        }
      }
      console.error('[chatroom] chat database commit failed; the change was undone in memory:', err);
      throw new ChatroomError('The chat database could not save that change, so nothing was kept. Try again.', 'UNAVAILABLE');
    }
    void this.archive.sweep(now, this.deps.timeZone?.(undefined)).catch((err) => console.warn('[chat-archive] gzip of ended weeks failed (kept as plain files):', err));
  }

  private journal(changes: SyncChanges, now: number, txn: string): void {
    const lines: JournalLine[] = [];
    for (const data of changes.rooms) lines.push({ kind: 'room', txn, roomId: data.id, archivedAt: now, data });
    for (const { room, message } of changes.messages) lines.push({ txn, roomId: room.id, room: room.name, archivedAt: now, message });
    for (const roomId of changes.deletedRooms) lines.push({ kind: 'room-deleted', txn, roomId, archivedAt: now });
    this.appendJournal(lines, now);
  }

  /** Lines to the week file of `now` in the zone of each room's owner (a removed room's: the default zone). */
  private appendJournal(lines: JournalLine[], now: number): void {
    const byWeek = new Map<string, string[]>();
    for (const line of lines) {
      const owner = line.kind === 'room' ? line.data.owner : line.kind === 'void' ? undefined : this.store.get(line.roomId)?.owner;
      const week = zoneWeek(now, this.deps.timeZone?.(owner));
      const group = byWeek.get(week) ?? [];
      group.push(JSON.stringify(line));
      byWeek.set(week, group);
    }
    for (const [week, group] of byWeek) this.archive.appendSync(week, group);
  }

  /** Messages whose author was already told how car mode played them (see playbackNotice), oldest first. */
  private readonly playbackNoticed = new Set<string>();

  /** Owner votes waiting to be told to a poll's author, by poll message id (see scheduleOwnerVoteNotice). */
  private readonly voteNotices = new Map<string, { timer: ReturnType<typeof setTimeout>; initial: string[] }>();

  /** What the owner of a room is called there (see `ChatroomServiceDeps.ownerNames`). */
  ownerNames(owner: string | undefined): string[] {
    try {
      return (this.deps.ownerNames?.(owner) ?? []).map((n) => String(n).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The last name seen for each session: its live name, what it signed its messages with, or the name kept on its membership. */
  private readonly knownNames = new Map<string, string>();

  /** A session's name: the live one; if it is gone, the last one seen (it keeps its name offline); only then its short id. */
  /** The rooms the last prompt delivered to a session came from (see ChatroomDelivery.lastDeliveryRooms). */
  lastDeliveryRooms(sessionId: string): { roomIds: string[]; at: number } | undefined {
    return this.delivery.lastDeliveryRooms(sessionId);
  }

  nameOf = (sessionId: string): string => {
    const live = cleanName(this.deps.getSession(sessionId)?.name);
    if (live) {
      this.knownNames.set(sessionId, live);
      return live;
    }
    return this.knownNames.get(sessionId) || sessionId.slice(0, 8);
  };

  /** Remember the names rooms already hold (membership first, then what agents signed, newest last), at start. */
  private learnNames(rooms: Iterable<ChatRoom>): void {
    const all = [...rooms];
    // What agents signed first; the name kept on a membership is what was last seen live, so it is applied last and wins.
    for (const room of all) {
      for (const msg of room.messages) {
        if (msg.from.kind === 'agent' && cleanName(msg.from.name) && !msg.deleted) this.knownNames.set(msg.from.sessionId, cleanName(msg.from.name));
      }
    }
    for (const room of all) for (const m of room.members) if (cleanName(m.lastName)) this.knownNames.set(m.sessionId, cleanName(m.lastName));
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  onMessage(listener: (room: ChatRoom, message: ChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  rooms(): ChatRoom[] {
    return this.store.list();
  }

  room(id: string): ChatRoom | undefined {
    return this.store.get(id);
  }

  roomsFor(sessionId: string): ChatRoom[] {
    return this.store.roomsFor(sessionId);
  }

  alertMode(sessionId: string): AlertLease | undefined {
    const employee = this.deps.employeeOf?.(sessionId);
    return employee ? this.alertModes.get(employee) : undefined;
  }

  async setAlertMode(sessionId: string, mode: AlertMode, durationMs: number): Promise<AlertLease | undefined> {
    const employeeId = this.deps.employeeOf?.(sessionId);
    if (!employeeId) throw new ChatroomError('No employee binding for this session', 'CONFLICT');
    if (!['ring', 'vibrate', 'silent'].includes(mode) || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 28800000) throw new ChatroomError('Duration must be greater than zero and at most eight hours', 'INVALID_INPUT');
    await this.audit({ action: 'alert-mode-request', sessionId, employeeId, mode, durationMs });
    if (this.deps.employeeOf?.(sessionId) !== employeeId) throw new ChatroomError('Employee binding changed', 'CONFLICT');
    const lease = this.alertModes.set(employeeId, mode, durationMs);
    this.delivery.applyAlertPolicy(sessionId);
    await this.audit({ action: 'alert-mode-changed', sessionId, employeeId, mode, until: lease?.until ?? null });
    for (const room of this.store.list()) if (room.members.some((m) => m.sessionId === sessionId)) this.deps.broadcast(ChatroomChanged, { owner: room.owner ?? '@single', roomId: room.id });
    return lease;
  }

  private phoneWrites: Promise<unknown> = Promise.resolve();

  ownerPhoneStatus(owner?: string): AlertLease | undefined {
    return this.alertModes.get(`@owner:${owner ?? '@single'}`);
  }

  /** Authorization and audit must succeed before the synchronous durable commit. */
  setPhoneStatus(owner: string | undefined, target: string | undefined, mode: AlertMode, by: string,
    authorize: () => void): Promise<AlertLease | undefined> {
    const run = async () => {
      authorize();
      const employee = target ? this.deps.employeeOf?.(target) : undefined;
      if (target && !employee) throw new ChatroomError('No employee binding', 'CONFLICT');
      const key = employee ?? `@owner:${owner ?? '@single'}`;
      await this.audit({ action: 'phone-status-request', by, owner: owner ?? '@single', target: target ?? 'owner',
        employeeId: employee, before: this.alertModes.get(key) ?? null, mode });
      authorize();
      if (target && this.deps.employeeOf?.(target) !== employee) throw new ChatroomError('Employee binding changed', 'CONFLICT');
      const lease = this.alertModes.set(key, mode, 28800000);
      void this.audit({ action: 'phone-status-changed', by, owner: owner ?? '@single',
        target: target ?? 'owner', employeeId: employee, mode, after: lease ?? null }).catch(() => undefined);
      // A delivery/broadcast failure after commit must not report a refused write.
      if (target) {
        try { this.delivery.applyAlertPolicy(target); } catch { /* durable mode is authoritative */ }
        for (const room of this.store.list()) if (room.members.some(m => m.sessionId === target)) {
          try { this.deps.broadcast(ChatroomChanged, { owner: room.owner ?? '@single', roomId: room.id }); } catch { /* refreshed on next read */ }
        }
      }
      return lease;
    };
    const result = this.phoneWrites.then(run);
    this.phoneWrites = result.catch(() => undefined);
    return result;
  }

  private alertAllows(sessionId: string, roomId: string, messageId?: string): boolean {
    const lease = this.alertMode(sessionId);
    if (!lease || lease.mode === 'ring') return true;
    const room = this.store.get(roomId);
    const message = room?.messages.find((m) => m.id === messageId);
    if (!message) return false;
    const owner = message.from.kind === 'user' && isOwnerMark(message.from.mark);
    if (owner && lease.mode === 'vibrate') return true;
    const name = this.nameOf(sessionId);
    const unique = room?.members.filter((m) => this.nameOf(m.sessionId).toLowerCase() === name.toLowerCase()).length === 1;
    const direct = unique && textMentions(message.text, name);
    // Silent: only the owner's direct @mention or his @everyone. Vibrate: a direct @mention from anyone.
    if (owner) return direct || textMentions(message.text, 'everyone');
    return lease.mode === 'vibrate' && direct;
  }

  view(room: ChatRoom, options: { since?: number; limit?: number } = {}): ChatRoomView {
    const members = room.members.map((m): ChatMemberView => {
      const s = this.deps.getSession(m.sessionId);
      const name = this.nameOf(m.sessionId);
      // A live name is kept on the membership too, so it survives a restart of the console.
      const liveName = cleanName(s?.name);
      const pronouns = this.deps.pronounsOf?.(m.sessionId);
      if (liveName && m.lastName !== liveName) {
        m.lastName = liveName;
        this.schedulePersist(room.id);
      }
      return {
        ...m,
        name,
        mode: s?.mode,
        alertMode: this.alertMode(m.sessionId),
        alive: !!s && s.pid !== null,
        working: !!s?.isWorking,
        pendingDeliveries: this.delivery.pendingFor(m.sessionId),
        hue: accentHue(m.sessionId),
        ...(pronouns ? { pronouns } : {}),
      };
    });
    const last = room.messages[room.messages.length - 1];
    return {
      id: room.id,
      name: room.name,
      owner: room.owner,
      createdAt: room.createdAt,
      coordinatorId: room.members.find((m) => m.role === 'coordinator')?.sessionId,
      members,
      messages: this.store.messages(room.id, options).map((message) => this.messageIdentity(room, message)),
      messageCount: room.messages.length,
      lastMessageAt: last?.at,
      workspace: room.workspace,
      category: room.category,
      topic: room.topic,
      archivedAt: room.archivedAt,
      wake: room.wake,
      visibility: isPublicRoom(room) ? 'public' : 'private',
      position: room.position,
      kind: room.kind,
      dm: isDm(room) ? room.dm : undefined,
      userReadAt: room.userReadAt ?? 0,
      ...userUnread(room, this.ownerNames(room.owner)),
    };
  }

  /** Resolve recipient tokens (names, prefixes, `user`, `coordinator`, `all`). Throws on an unknown token. */
  resolveRecipients(room: ChatRoom, tokens: string[] | undefined): 'all' | ChatRecipient[] {
    if (!tokens || tokens.length === 0) return 'all';
    const out: ChatRecipient[] = [];
    for (const token of tokens) {
      const r = resolveRecipient(room, token, this.nameOf);
      if (r === undefined)
        throw Object.assign(new Error(`Unknown or ambiguous recipient "${token}"`), { code: 'INVALID_INPUT' });
      if (r === 'all') return 'all';
      out.push(r);
    }
    return out;
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  createRoom(name: string, owner: string | undefined): ChatRoom {
    const room = this.store.create(name, owner, this.now());
    this.changed(room, 'created');
    return room;
  }

  /**
   * Open the user's direct message with `sessionId` (or reuse the one that exists). A new one
   * briefs the agent once. `owner` stamps it in multi-user mode.
   */
  openDm(sessionId: string, owner: string | undefined): ChatRoom {
    const result = this.store.openDm([USER_RECIPIENT, sessionId], owner, { now: this.now() });
    if (result.created) {
      for (const member of result.room.members) this.brief(result.room, member);
      this.changed(result.room, 'created');
    }
    return result.room;
  }

  /** Move an ordinary room to a workspace / category (`''` clears one). */
  placeRoom(id: string, placement: { workspace?: string; category?: string }): ChatRoom {
    const room = this.store.place(id, placement);
    this.changed(room, 'updated');
    return room;
  }

  /** Archive (read-only, kept for history) or restore an ordinary room. */
  archiveRoom(id: string, archived: boolean): ChatRoom {
    const room = this.store.archive(id, archived, this.now());
    this.changed(room, 'updated');
    return room;
  }

  /** One member's notification choice in this room: `mentions` (woken only by what is meant for it) or `all` (as the room says). */
  setMemberNotify(roomId: string, sessionId: string, mode: 'all' | 'mentions'): ChatMember {
    const room = this.store.require(roomId);
    const member = this.store.setNotify(roomId, sessionId, mode);
    this.changed(room, 'updated');
    return member;
  }

  /**
   * Move a replaced session's place in every room to its successor (see `ChatroomStore.replaceMember`). The new member is briefed in each
   * room, the old one's undelivered lines are dropped, each room says so, and the move is logged. The caller has already decided it
   * may happen (the owner, or proof that both sessions are one mind).
   */
  async replaceSession(oldId: string, newId: string, by: string, canTouch: (room: ChatRoom) => boolean): Promise<Array<{ id: string; name: string }>> {
    if (oldId === newId) throw new ChatroomError('That is the same session', 'INVALID_INPUT');
    const candidates = this.store.list().filter((r) => canTouch(r));
    // What the old session had, kept so Restore can put it back exactly.
    const snapshot = candidates
      .map((r) => ({ room: r, member: r.members.find((m) => m.sessionId === oldId) }))
      .filter((x): x is { room: ChatRoom; member: ChatMember } => !!x.member)
      .map((x) => ({ roomId: x.room.id, roomName: x.room.name, member: structuredClone(x.member), owner: x.room.owner }));
    const oldName = this.nameOf(oldId);
    // All or nothing: if anything after the seats move throws (a room's notice, the retired record), every touched room gets its old
    // members and DM pair back, so a person is never left half in one session and half in the other.
    const before = candidates
      .filter((r) => r.members.some((m) => m.sessionId === oldId))
      .map((r) => ({ room: r, members: structuredClone(r.members), dm: r.dm ? [...r.dm] : undefined }));
    const retiredBefore = this.retired;
    let moved: ChatRoom[] = [];
    try {
      moved = this.store.replaceMember(oldId, newId, candidates);
      for (const room of moved) this.changed(room, 'updated');
      if (moved.length) {
        // One badge per person: the old session is retired (and, if the new one was itself retired, it is back).
        this.retired = this.retired.filter((r) => r.sessionId !== newId && r.sessionId !== oldId);
        this.retired.push({ sessionId: oldId, name: oldName, successorId: newId, at: this.now(), owner: snapshot[0]?.owner, rooms: snapshot.map(({ roomId, roomName, member }) => ({ roomId, roomName, member })) });
        await this.saveRetired();
      }
    } catch (error) {
      this.retired = retiredBefore;
      for (const { room, members, dm } of before) {
        room.members = members;
        if (dm) room.dm = dm;
        try { this.changed(room, 'updated'); } catch { /* the rollback must finish for every room */ }
      }
      throw error;
    }
    if (moved.length) {
      // Committed: only now are the old session's undelivered lines dropped (each is a copy of a room line).
      for (const room of moved) this.delivery.dropRoom(room.id, oldId);
      // The notices wait for the commit, so the history never says a move happened that was rolled back. A notice that fails now
      // must not undo the move.
      for (const room of moved) {
        try {
          const member = room.members.find((m) => m.sessionId === newId);
          this.system(room, `${this.nameOf(newId)} moved to a new session`);
          if (member && !member.postOnly) this.brief(room, member);
        } catch (error) {
          console.warn(`[chatroom] move notice for ${room.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.deps.retiredChanged?.([oldId, newId]);
      // Committed: a failed audit line is reported, never a reason to put the seats back on a session that is already running.
      try {
        await this.audit({ action: 'replace-session', by, from: oldId, to: newId, rooms: moved.map((r) => r.id) });
      } catch (error) {
        console.warn(`[chatroom] replace-session audit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return moved.map((r) => ({ id: r.id, name: r.name }));
  }

  /** Save the owner's channel order (the page's sidebar). Agents' room lists and briefings do not use it. */
  setRoomOrder(ids: string[]): number {
    const placed = this.store.setOrder(ids);
    if (placed.length) this.changed(placed[0], 'updated');
    return placed.length;
  }

  /**
   * Make a room public (any agent can list it and join) or private (members only). A change is logged in the room ("<who> made this
   * channel public") and in the audit log; setting what it already is changes and logs nothing.
   */
  async setRoomVisibility(id: string, visibility: 'public' | 'private', by: { name: string; kind: 'user' | 'agent' }): Promise<ChatRoom> {
    const before = this.store.require(id);
    const was = isPublicRoom(before) ? 'public' : 'private';
    const room = this.store.setVisibility(id, visibility);
    if (was !== visibility) {
      await this.audit({ action: 'visibility', roomId: id, by: by.name, byKind: by.kind, from: was, to: visibility });
      this.system(room, `${by.kind === 'user' ? 'The owner' : by.name} made this channel ${visibility}`);
    }
    this.changed(room, 'updated');
    return room;
  }

  /** The public rooms an agent could join: name, topic and size only, never a member list or a message. */
  publicRooms(owner: string | undefined, memberOf?: string): Array<{ id: string; name: string; topic?: string; memberCount: number; joined: boolean }> {
    return this.rooms()
      .filter((r) => isPublicRoom(r) && !r.archivedAt && (r.owner ?? undefined) === (owner ?? undefined))
      .map((r) => ({ id: r.id, name: r.name, topic: r.topic, memberCount: r.members.length, joined: !!memberOf && r.members.some((m) => m.sessionId === memberOf) }));
  }

  /** Set who a post to the whole room wakes (`default` clears the room's own setting). */
  setRoomWake(id: string, mode: 'all' | 'mentions' | 'default'): ChatRoom {
    const room = this.store.setWake(id, mode);
    this.changed(room, 'updated');
    return room;
  }

  /**
   * Move the user's read cursor forward to `at` (default: the newest message). Never
   * backward, and never past the newest message: a client cannot pre-read the future.
   */
  markRead(roomId: string, at?: number): { userReadAt: number; unread: number; mentions: number } {
    const room = this.store.require(roomId);
    const newest = room.messages.at(-1)?.at ?? room.createdAt;
    const before = room.userReadAt ?? 0;
    const cursor = this.store.markRead(roomId, Math.min(at ?? newest, newest));
    if (cursor !== before) this.changed(room, 'read');
    return { userReadAt: cursor, ...userUnread(room, this.ownerNames(room.owner)) };
  }

  renameRoom(id: string, name: string): ChatRoom {
    const room = this.store.rename(id, name);
    this.changed(room, 'updated');
    return room;
  }

  /** Rename and/or set the topic in one change. */
  updateRoom(id: string, change: { name?: string; topic?: string }): ChatRoom {
    let room = this.store.require(id);
    if (change.topic !== undefined && isDm(room)) throw new ChatroomError('A direct message has no topic', 'INVALID_INPUT');
    if (change.name !== undefined) room = this.store.rename(id, change.name);
    if (change.topic !== undefined) room = this.store.setTopic(id, change.topic);
    this.changed(room, 'updated');
    return room;
  }

  /** Delete a room. Its whole content goes to the audit log first (so nothing is destroyed) and its files are moved aside. */
  async deleteRoom(id: string, by = 'user'): Promise<boolean> {
    const room = this.store.get(id);
    if (!room) return false;
    await this.audit({ action: 'delete-room', roomId: id, by, room });
    this.seen.forget(undefined, id);
    if (!this.store.delete(id)) return false;
    this.delivery.dropRoom(id);
    void this.deps.files?.removeRoom(id).catch(() => {});
    this.changed(room, 'deleted');
    return true;
  }

  /**
   * Refuse a member whose pane would run room text as commands, unless the user adds it as
   * post-only. An explicitly registered polling agent may lead without pane delivery; an ordinary post-only member may not. Callers that build a room
   * check every member first so a refusal leaves nothing half-created.
   */
  assertJoinable(
    sessionId: string,
    options: { role?: ChatRole; voice?: boolean; postOnly?: boolean },
    existing?: ChatMember
  ): void {
    const postOnly = modePollsChat(this.deps.getSession(sessionId)?.mode) || (existing ? existing.postOnly : options.postOnly);
    if (!existing && !paneAcceptsChat(this.deps.getSession(sessionId)?.mode) && !postOnly) {
      const mode = this.deps.getSession(sessionId)?.mode ?? 'non-agent';
      throw new ChatroomError(
        `A ${mode} session would run room messages as commands; the user can add it as post-only`,
        'INVALID_INPUT'
      );
    }
    if (postOnly && !modePollsChat(this.deps.getSession(sessionId)?.mode) && (options.role === 'coordinator' || options.voice)) {
      throw new ChatroomError('A post-only member cannot coordinate or be the voice', 'INVALID_INPUT');
    }
  }

  addMember(
    roomId: string,
    sessionId: string,
    options: { role?: ChatRole; goal?: string; icon?: string; voice?: boolean; postOnly?: boolean; addedBy?: string } = {}
  ): ChatMember {
    const room = this.store.require(roomId);
    // Registry capability chooses transport; a client cannot turn typed delivery on for a poller.
    if (modePollsChat(this.deps.getSession(sessionId)?.mode)) options = { ...options, postOnly: true };
    // Every path into a room (create, add, appoint, company invite/spawn) comes through here.
    this.assertJoinable(sessionId, options, room.members.find((m) => m.sessionId === sessionId));
    if (options.role === 'coordinator') this.assertCanLead(sessionId, 'coordinate');
    if (options.voice) this.assertCanLead(sessionId, 'be the voice');
    const wasCoordinator = room.members.find((m) => m.role === 'coordinator')?.sessionId;
    const { member, added } = this.store.addMember(roomId, sessionId, { ...options, pollingLead: modePollsChat(this.deps.getSession(sessionId)?.mode) }, this.now());
    if (added) {
      this.system(room, `${this.nameOf(sessionId)} joined${member.goal ? ` (goal: ${member.goal})` : ''}`, sessionId);
      this.brief(room, member);
      // The coordinator hears about every arrival so it can put the newcomer to work.
      const coordinator = room.members.find((m) => m.role === 'coordinator');
      if (
        coordinator &&
        coordinator.sessionId !== sessionId &&
        !this.delivery.hasPendingBrief(coordinator.sessionId, room.id)
      ) {
        this.delivery.enqueue(
          coordinator.sessionId,
          room,
          `SYSTEM -> you: ${quoteForPane(this.nameOf(sessionId), 80)} joined the room${member.goal ? ` with goal: ${quoteForPane(member.goal, 500)}` : ''}. Give it direction.`
        );
      }
    }
    if (member.role === 'coordinator' && wasCoordinator !== sessionId) this.announceCoordinator(room, member, added);
    this.changed(room, 'updated');
    return member;
  }

  removeMember(roomId: string, sessionId: string): boolean {
    const room = this.store.require(roomId);
    const name = this.nameOf(sessionId);
    if (!this.store.removeMember(roomId, sessionId)) return false;
    this.delivery.dropRoom(roomId, sessionId);
    if (!this.store.roomsFor(sessionId).length) this.delivery.forget(sessionId);
    this.system(room, `${name} left`);
    this.changed(room, 'updated');
    return true;
  }

  appointCoordinator(roomId: string, sessionId: string | null): ChatMember | undefined {
    const room = this.store.require(roomId);
    if (sessionId !== null) this.assertCanLead(sessionId, 'coordinate');
    const previous = room.members.find((m) => m.role === 'coordinator')?.sessionId;
    const appointed = this.store.setCoordinator(roomId, sessionId, this.now(), modePollsChat(sessionId ? this.deps.getSession(sessionId)?.mode : undefined));
    if (appointed && previous !== appointed.sessionId) this.announceCoordinator(room, appointed, false);
    if (!appointed && previous) this.system(room, 'The room has no coordinator now');
    this.changed(room, 'updated');
    return appointed;
  }

  setStatus(
    roomId: string,
    sessionId: string,
    status: { goal?: string; progress?: string; away?: string; icon?: string; voice?: boolean; avatar?: string }
  ): ChatMember {
    const room = this.store.require(roomId);
    if (status.voice) this.assertCanLead(sessionId, 'be the voice');
    const member = this.store.setStatus(roomId, sessionId, status, this.now(), modePollsChat(this.deps.getSession(sessionId)?.mode));
    this.changed(room, 'status');
    return member;
  }

  post(
    roomId: string,
    from: ChatSender,
    text: string,
    to: 'all' | ChatRecipient[] = 'all',
    options: {
      deliver?: boolean;
      audioUrl?: string;
      voice?: true;
      spoken?: true;
      attachments?: import('./chatroom-store.js').ChatAttachment[];
      replyTo?: string;
      poll?: import('./chatroom-store.js').ChatPoll;
    } = {}
  ): ChatMessage {
    const room = this.store.require(roomId);
    const { deliver = true, ...extra } = options;
    from = stampEmployeeSender(from, room.owner, this.depsWithIdentity());
    const message = this.store.post(roomId, from, text, to, this.now(), extra);
    // Only an agent's own signature names a session: a user, an external sender or the system never does.
    if (from.kind === 'agent' && cleanName(from.name)) this.knownNames.set(from.sessionId, cleanName(from.name));
    // Persisted before it is shown or delivered: with the database, committed before anyone sees it.
    this.schedulePersist(room.id);
    this.deps.broadcast(ChatroomMessage, { owner: room.owner ?? '@single', roomId: room.id, message });
    // A spoken turn was already answered by the voice service: show it, never type it into a pane.
    if (deliver) {
      const postOnly = new Set(room.members.filter((m) => m.postOnly).map((m) => m.sessionId));
      const recipients = messageRecipients(room, message).filter((id) => !postOnly.has(id));
      // Only the members the message is for are woken; the rest read it with their next prompt (cheaper, and nothing is hidden).
      this.delivery.deliverMessage(room, message, recipients, this.nameOf, wakeRecipients(room, message, recipients, this.nameOf, process.env, (id) => {
        const session = this.deps.getSession(id);
        return !!session && session.pid !== null && paneAcceptsChat(session.mode);
      }));
    }
    this.trackOwedReplies(room, message, deliver);
    for (const listener of this.messageListeners) listener(room, message);
    return message;
  }

  private owedReplyMs(): number {
    const env = Number(process.env.REVERIE_OWED_REPLY_MS);
    return this.deps.owedReplyMs ?? (Number.isFinite(env) && env > 0 ? env : 3 * 60_000);
  }

  /**
   * An owner post that @mentions or addresses an agent that takes chat (or says @everyone) makes it owe a reply to THAT message
   * in that room; each request is watched on its own. Only a post by that agent whose replyTo is exactly that message settles
   * it; nothing is inferred. The no-reply line is timed by idleness: the grace starts when the pane is first seen idle and
   * restarts whenever work resumes, so a long task that just finished is not warned at once (idle is a timing signal only,
   * never proof of delivery or of reading). While it keeps working, a
   * separate fixed deadline may say once that delivery is still unconfirmed, labelled as that. Both are system lines: shown,
   * never typed into a pane, and they create no obligation. Prototype: owed replies are not kept across a restart.
   */
  private trackOwedReplies(room: ChatRoom, message: ChatMessage, delivered: boolean): void {
    if (message.from.kind === 'agent') {
      if (!message.replyTo) return;
      const key = `${message.from.sessionId}\u0000${room.id}\u0000${message.replyTo}`;
      const owed = this.owedReplies.get(key);
      if (owed) {
        clearTimeout(owed.timer);
        this.owedReplies.delete(key);
      }
      return;
    }
    if (message.from.kind !== 'user' || !delivered || isDm(room)) return;
    const text = message.text ?? '';
    const everyone = textMentions(text, 'everyone');
    for (const member of room.members) {
      const id = member.sessionId;
      if (member.postOnly) continue;
      const addressed = message.to !== 'all' && message.to.includes(id);
      if (!everyone && !addressed && !textMentions(text, this.nameOf(id))) continue;
      const session = this.deps.getSession(id);
      if (!session || session.pid === null || !paneAcceptsChat(session.mode)) continue;
      const key = `${id}\u0000${room.id}\u0000${message.id}`;
      if (this.owedReplies.has(key)) continue;
      const idleSince = session.isWorking ? undefined : this.now();
      const owed: OwedReply = { sessionId: id, roomId: room.id, messageId: message.id, at: message.at, delivery: 'pending', idleSince, deliveryNoted: false, timer: undefined as never };
      this.owedReplies.set(key, owed);
      this.armOwedReply(key, owed, this.owedRecheckMs());
    }
  }

  private owedRecheckMs(): number {
    return Math.max(1, Math.min(OWED_IDLE_RECHECK_MS, Math.floor(this.owedReplyMs() / 2)));
  }

  private armOwedReply(key: string, owed: OwedReply, ms: number): void {
    owed.timer = setTimeout(() => this.checkOwedReply(key), ms);
    owed.timer.unref?.();
  }

  private checkOwedReply(key: string): void {
    const owed = this.owedReplies.get(key);
    if (!owed) return;
    const room = this.store.get(owed.roomId);
    if (!room || room.archivedAt) {
      this.owedReplies.delete(key);
      return;
    }
    const session = this.deps.getSession(owed.sessionId);
    const now = this.now();
    if (session?.isWorking) {
      owed.idleSince = undefined; // work resumed: the grace starts again when it next goes idle
      // Still working: not a missed reply. Past the fixed delivery deadline, say once that delivery itself is unconfirmed.
      if (!owed.deliveryNoted && owed.delivery !== 'submitted' && now - owed.at >= OWED_DELIVERY_DEADLINE_MS) {
        owed.deliveryNoted = true;
        this.system(room, `Delivery to ${this.nameOf(owed.sessionId)} still unconfirmed ${Math.round((now - owed.at) / 60_000)} min after the ${etTime(owed.at)} ET message to it (it is still working)`, owed.sessionId);
      }
      this.armOwedReply(key, owed, this.owedRecheckMs());
      return;
    }
    owed.idleSince ??= now;
    if (now - owed.idleSince < this.owedReplyMs()) {
      this.armOwedReply(key, owed, this.owedRecheckMs());
      return;
    }
    this.owedReplies.delete(key);
    const mins = Math.round((now - owed.at) / 60_000);
    const delivery = owed.delivery === 'pending' ? 'not yet confirmed' : owed.delivery;
    this.system(room, `Reply from ${this.nameOf(owed.sessionId)} unconfirmed: no reply linked to the ${etTime(owed.at)} ET message to it after ${mins} min (delivery: ${delivery})`, owed.sessionId);
  }

  private noteOwedDelivery(sessionId: string, messages: { roomId: string; messageId: string }[], delivery: 'submitted' | 'unconfirmed'): void {
    for (const { roomId, messageId } of messages) {
      const owed = this.owedReplies.get(`${sessionId}\u0000${roomId}\u0000${messageId}`);
      if (owed && owed.delivery !== 'submitted') owed.delivery = delivery;
    }
  }

  /** A failed or unconfirmed delivery is shown in each affected room, at most once per 10 minutes per member and room. */
  private noticeDeliveryProblem(sessionId: string, roomIds: string[], template: string): void {
    const now = this.now();
    for (const roomId of roomIds) {
      const room = this.store.get(roomId);
      if (!room || room.archivedAt) continue;
      const key = `${sessionId}\u0000${roomId}`;
      if (now - (this.deliveryNotices.get(key) ?? -Infinity) < 10 * 60_000) continue;
      this.deliveryNotices.set(key, now);
      this.system(room, template.replace('%s', () => this.nameOf(sessionId)), sessionId);
    }
  }

  /** A routine failure notice is shown in its room and queued for its author, without creating an owed reply. */
  noticeMember(roomId: string, sessionId: string, text: string): ChatMessage {
    const room = this.store.require(roomId);
    const present = room.members.some((m) => m.sessionId === sessionId);
    const message = this.post(roomId, { kind: 'system', name: 'system' }, text, present ? [sessionId] : 'all', { deliver: false });
    this.delivery.deliverMessage(room, message, [sessionId], this.nameOf, new Set([sessionId]), !present);
    return message;
  }

  /** Throws unless this bot may post in this room now: allowlisted, room there and open, under its hourly cap. */
  checkBotPost(bot: ChatBot, roomId: string, recentPosts: number): void {
    if (!bot.rooms.includes(roomId)) throw new ChatroomError(`${bot.name} may not post in that room`, 'INVALID_INPUT');
    const room = this.store.require(roomId);
    if (isDm(room)) throw new ChatroomError('A bot cannot post in a direct message', 'INVALID_INPUT');
    if (room.archivedAt) throw new ChatroomError('This room is archived', 'CONFLICT');
    if (recentPosts >= bot.maxPerHour) throw new ChatroomError(`${bot.name} reached its limit of ${bot.maxPerHour} posts an hour`, 'CONFLICT');
  }

  /**
   * A bot's post (`recentPosts` = its posts in the last hour, from the caller's run history). It goes to
   * everyone, so an `@name` in the text wakes that member as any message would.
   */
  postAsBot(bot: ChatBot, roomId: string, text: string, recentPosts: number): ChatMessage {
    this.checkBotPost(bot, roomId, recentPosts);
    const from: ChatSender = { kind: 'bot', botId: bot.id, name: bot.name, ...(bot.icon ? { icon: bot.icon } : {}) };
    return this.post(roomId, from, text, 'all');
  }

  private get auditFile(): string {
    return this.deps.auditFile ?? `${this.deps.file}.audit.jsonl`;
  }

  /** An audit line written by another part of the console (the resume guard); same append-only log. */
  async auditEntry(entry: Record<string, unknown>): Promise<void> {
    await this.audit(entry);
  }

  /** Append one line to the audit log. Nothing here ever rewrites or truncates it. */
  private async audit(entry: Record<string, unknown>): Promise<void> {
    await fs.mkdir(dirname(this.auditFile), { recursive: true });
    await fs.appendFile(this.auditFile, `${JSON.stringify({ at: this.now(), ...entry })}\n`, { mode: 0o600 });
  }

  /** The newest audited deletion of a message, with the original as it was. */
  private async auditedOriginal(roomId: string, messageId: string): Promise<ChatMessage | undefined> {
    let raw = '';
    try {
      raw = await fs.readFile(this.auditFile, 'utf-8');
    } catch {
      return undefined;
    }
    let found: ChatMessage | undefined;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { action?: string; roomId?: string; message?: ChatMessage };
        if (entry.action === 'delete' && entry.roomId === roomId && entry.message?.id === messageId) found = entry.message;
      } catch {
        /* a torn line is skipped, never repaired */
      }
    }
    return found;
  }

  /**
   * Soft delete: the original goes to the audit log first (a message is never dropped without a record),
   * then the room keeps a tombstone. Open panels reload the room.
   */
  async deleteMessage(roomId: string, messageId: string, by: string, byRank?: number): Promise<void> {
    const room = this.store.require(roomId);
    const original = this.store.findMessage(roomId, messageId);
    if (original.deleted) throw new ChatroomError('Already deleted', 'CONFLICT');
    await this.audit({ action: 'delete', roomId, by, message: original });
    this.store.tombstone(roomId, messageId, by, this.now(), byRank);
    this.delivery.dropMessage(roomId, messageId);
    this.changed(room, 'updated');
  }

  /**
   * Edit the user's own message. The original text goes to the audit log first; the room keeps the new text with an `edited` mark.
   * The members that RECEIVED the original (it was typed into their pane) are sent one line with the new text, because an agent
   * would otherwise go on acting on the old one; a member that never got it is sent nothing and reads the new text.
   */
  async editMessage(
    roomId: string,
    messageId: string,
    text: string,
    by: string,
    options: { ownerVerified?: boolean } = {}
  ): Promise<ChatMessage> {
    const room = this.store.require(roomId);
    const original = this.store.findMessage(roomId, messageId);
    if (original.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    if (original.poll) throw new ChatroomError('A poll cannot be edited', 'INVALID_INPUT');
    if (original.from.kind !== 'user') throw new ChatroomError('Only your own messages can be edited', 'INVALID_INPUT');
    const next = text.trim();
    if (!next && !original.attachments?.length) throw new ChatroomError('Empty message', 'INVALID_INPUT');
    if (next === original.text) return original;
    await this.audit({ action: 'edit', roomId, by, messageId, before: original.text, after: next });
    this.store.editText(roomId, messageId, next, this.now(), options);
    const edited = this.store.findMessage(roomId, messageId);
    // A member whose pane was typed the original, or still has it queued (the note then rides right behind it, in the same line).
    const informed = new Set([...this.delivery.receivedBy(roomId, messageId), ...this.delivery.queuedFor(roomId, messageId)]);
    for (const sessionId of informed) {
      const member = room.members.find((m) => m.sessionId === sessionId);
      if (!member || member.postOnly) continue;
      this.delivery.enqueue(
        sessionId,
        room,
        `SYSTEM: edited: ${quoteForPane(edited.text, 400)} (the user edited a message you received in ${quoteForPane(roomLabel(room), 80)}; the full text is in reverie agent chat read)`
      );
    }
    this.changed(room, 'updated', messageId);
    return edited;
  }

  /**
   * Pin or unpin a message (the route decides who may: the user, or the room's coordinator). A change is logged, and the members are
   * sent a one-line notice, because the newest pins are part of their briefing (the room's rules) and the briefing itself is not re-sent.
   */
  async pinMessage(roomId: string, messageId: string, by: { name: string; kind: 'user' | 'agent' }, on: boolean): Promise<ChatMessage> {
    const room = this.store.require(roomId);
    if (isDm(room)) throw new ChatroomError('Pins are for channels', 'INVALID_INPUT');
    const changed = this.store.setPinned(roomId, messageId, on ? by : undefined, this.now());
    if (changed) {
      await this.audit({ action: on ? 'pin' : 'unpin', roomId, by: by.name, byKind: by.kind, messageId });
      this.changed(room, 'updated', messageId);
      // A one-line notice, not a whole briefing (that is the expensive part); the next briefing carries the pin list anyway.
      const pinned = this.store.findMessage(roomId, messageId);
      const who = by.kind === 'user' ? 'the owner' : `the coordinator ${quoteForPane(by.name, 40)}`;
      const line = `SYSTEM: ${on ? 'pinned' : 'unpinned'} by ${who}: ${quoteForPane(pinned.text, 120)} (reverie agent chat pins lists the room's pins)`;
      for (const m of room.members) if (!m.postOnly) this.delivery.enqueue(m.sessionId, room, line);
    }
    return this.store.findMessage(roomId, messageId);
  }

  pinned(roomId: string): ChatMessage[] {
    const room = this.store.require(roomId);
    return this.store.pinned(roomId).map((message) => this.messageIdentity(room, message));
  }

  /** Bring a deleted message back from the audit log (the restore is logged too). */
  async restoreMessage(roomId: string, messageId: string, by: string): Promise<void> {
    const room = this.store.require(roomId);
    if (!this.store.findMessage(roomId, messageId).deleted) throw new ChatroomError('That message is not deleted', 'CONFLICT');
    const original = await this.auditedOriginal(roomId, messageId);
    if (!original) throw new ChatroomError('The original is not in the audit log', 'NOT_FOUND');
    await this.audit({ action: 'restore', roomId, by, messageId });
    this.store.restore(roomId, original);
    this.changed(room, 'updated');
  }

  /**
   * Report a message to the room's coordinator in the user's own direct message with them (not in the room, so
   * other members, including the one reported, do not see it). The report is appended to the audit log first;
   * it cannot be unsent, and deleting the message later does not remove it from the log.
   */
  async reportMessage(roomId: string, messageId: string, reason: string, from: ChatSender): Promise<{ message: ChatMessage; dmId: string }> {
    const room = this.store.require(roomId);
    const original = this.store.findMessage(roomId, messageId);
    if (original.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    if (original.from.kind !== 'agent') {
      throw new ChatroomError('Only an agent\'s message can be reported', 'INVALID_INPUT');
    }
    const coordinator = room.members.find((m) => m.role === 'coordinator');
    if (!coordinator) throw new ChatroomError('This room has no coordinator to report to', 'INVALID_INPUT');
    if (original.from.kind === 'agent' && original.from.sessionId === coordinator.sessionId) {
      throw new ChatroomError('A coordinator\'s own message cannot be reported to the coordinator', 'INVALID_INPUT');
    }
    const reporter = from.kind === 'agent' ? this.nameOf(from.sessionId) : 'the user';
    await this.audit({ action: 'report', roomId, by: from.kind === 'user' ? from.name : reporter, reason, message: original });
    const name = senderLabel({ ...original.from, name: this.nameOf(original.from.sessionId) });
    const snippet = original.text.replace(/\s+/g, ' ').trim().slice(0, 200) || '(attachment)';
    const text =
      `REPORT from ${from.kind === 'agent' ? quoteForPane(reporter, 80) : reporter} about a message in ${quoteForPane(room.name, 80)} by ${name} (${new Date(original.at).toISOString()}): ` +
      `${quoteForPane(snippet, 200)}${reason.trim() ? ` Reason: ${quoteForPane(reason.trim(), 1000)}` : ''} Please look into it and tell ${from.kind === 'agent' ? quoteForPane(reporter, 80) : 'the user'} what you find.`;
    const dm = this.openDm(coordinator.sessionId, room.owner);
    // An agent is not a participant of the coordinator's direct message, so its report goes in as a system notice naming it.
    const sender: ChatSender = from.kind === 'agent' ? { kind: 'system', name: 'report' } : from;
    return { message: this.post(dm.id, sender, text, 'all'), dmId: dm.id };
  }

  /**
   * Post a poll. `options` are the labels in order; `recommended` names one of them (its label, or its 1-based number).
   * The message text is the question, so a client that knows nothing about polls still shows it.
   */
  createPoll(
    roomId: string,
    from: ChatSender,
    input: { question: string; options: string[]; multi?: boolean; closesAt?: number; recommended?: string },
    to: 'all' | ChatRecipient[] = 'all'
  ): ChatMessage {
    const question = input.question.trim().replace(/\s+/g, ' ');
    if (!question) throw new ChatroomError('A poll needs a question', 'INVALID_INPUT');
    if (question.length > MAX_POLL_QUESTION) throw new ChatroomError(`The question is at most ${MAX_POLL_QUESTION} characters`, 'INVALID_INPUT');
    const labels = input.options.map((o) => o.trim().replace(/\s+/g, ' '));
    if (labels.length < 2 || labels.length > MAX_POLL_OPTIONS) {
      throw new ChatroomError(`A poll has 2 to ${MAX_POLL_OPTIONS} options`, 'INVALID_INPUT');
    }
    if (labels.some((l) => !l || l.length > MAX_POLL_LABEL)) {
      throw new ChatroomError(`Each option is 1 to ${MAX_POLL_LABEL} characters`, 'INVALID_INPUT');
    }
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
      throw new ChatroomError('Two options are the same', 'INVALID_INPUT');
    }
    const now = this.now();
    if (input.closesAt !== undefined && !(input.closesAt > now)) {
      throw new ChatroomError('The closing time is already past', 'INVALID_INPUT');
    }
    const options = labels.map((label, i) => ({ id: `o${i + 1}`, label }));
    let recommended: string | undefined;
    if (input.recommended !== undefined && input.recommended.trim() !== '') {
      recommended = this.pollOptionIds({ options } as unknown as ChatPoll, [input.recommended])[0];
    }
    const poll: ChatPoll = {
      question,
      options,
      ...(input.multi ? { multi: true as const } : {}),
      ...(input.closesAt !== undefined ? { closesAt: input.closesAt } : {}),
      ...(recommended ? { recommended } : {}),
      votes: {},
    };
    return this.post(roomId, from, question, to, { poll });
  }

  /** Option ids from what a caller typed: an id (`o2`), a 1-based number, or a label (any case). */
  pollOptionIds(poll: ChatPoll, tokens: string[]): string[] {
    return tokens.map((raw) => {
      const t = raw.trim();
      const hit =
        poll.options.find((o) => o.id === t) ??
        (/^\d{1,2}$/.test(t) ? poll.options[Number(t) - 1] : undefined) ??
        poll.options.find((o) => o.label.toLowerCase() === t.toLowerCase());
      if (!hit) throw new ChatroomError(`Not an option of this poll: ${t.slice(0, 40)}`, 'INVALID_INPUT');
      return hit.id;
    });
  }

  /**
   * Record (or withdraw, with an empty list) one voter's choice and tell every open panel. The agent that asked hears about the
   * OWNER's votes only (one quoted line once they settle); other members' votes are read with `poll-results`.
   */
  votePoll(roomId: string, messageId: string, who: string, tokens: string[]): ChatPoll {
    const room = this.store.require(roomId);
    const message = room.messages.find((m) => m.id === messageId);
    if (message?.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    if (!message?.poll) throw new ChatroomError(message ? 'That message is not a poll' : 'No such message', message ? 'INVALID_INPUT' : 'NOT_FOUND');
    const before = message.poll.votes[who] ? [...message.poll.votes[who]] : [];
    const poll = this.store.vote(roomId, messageId, who, this.pollOptionIds(message.poll, tokens), this.now());
    this.changed(room, 'poll', messageId);
    if (who === USER_RECIPIENT) this.scheduleOwnerVoteNotice(roomId, message, before);
    return poll;
  }

  /**
   * The owner votes, changes or withdraws in quick succession: one note to the author, after the votes settle, saying where the
   * vote ended up. Nothing is sent if it ended where it began.
   */
  private scheduleOwnerVoteNotice(roomId: string, message: ChatMessage, before: string[]): void {
    const key = message.id;
    const pending = this.voteNotices.get(key);
    if (pending) clearTimeout(pending.timer);
    const initial = pending ? pending.initial : before;
    const timer = setTimeout(() => this.flushOwnerVoteNotice(roomId, message.id), this.deps.voteCoalesceMs ?? 3000);
    timer.unref?.();
    this.voteNotices.set(key, { timer, initial });
  }

  private flushOwnerVoteNotice(roomId: string, messageId: string): void {
    const pending = this.voteNotices.get(messageId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.voteNotices.delete(messageId);
    const room = this.store.get(roomId);
    const message = room?.messages.find((m) => m.id === messageId);
    const poll = message?.poll;
    if (!room || !message || !poll || message.deleted) return;
    const now = poll.votes[USER_RECIPIENT] ?? [];
    if (now.length === pending.initial.length && now.every((id) => pending.initial.includes(id))) return;
    const labels = now.map((id) => quoteForPane(poll.options.find((o) => o.id === id)?.label ?? id, 100));
    this.tellPollAuthor(
      room,
      message,
      USER_RECIPIENT,
      labels.length
        ? `voted ${labels.join(', ')} on poll ${quoteForPane(poll.question, 200)}`
        : `withdrew the vote on poll ${quoteForPane(poll.question, 200)}`
    );
  }

  /**
   * Close a poll early: the user, the agent that asked it, or the room's coordinator (an agent's poll only; the user's own
   * polls are the user's to close). The closing is audited before it happens, so a refused audit closes nothing. When the
   * coordinator closes someone else's poll, the author is told on one quoted line.
   */
  /** Polls whose close is between its audit line and the store write (see closePoll). */
  private readonly closingPolls = new Set<string>();

  async closePoll(roomId: string, messageId: string, who: string, closesOthers = false): Promise<ChatPoll> {
    const room = this.store.require(roomId);
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new ChatroomError('No such message', 'NOT_FOUND');
    const isAuthor = message.from.kind === 'agent' && message.from.sessionId === who;
    // The route found that this member holds polls.close_others over the author (roles.ts); the coordinator seat is that for a Lead.
    const isCoordinator =
      who !== USER_RECIPIENT && message.from.kind === 'agent' && room.members.some((m) => m.sessionId === who && m.role === 'coordinator');
    if (who !== USER_RECIPIENT && !isAuthor && !isCoordinator && !closesOthers) {
      throw new ChatroomError("Only the user, the poll's author or the room's coordinator closes a poll", 'INVALID_INPUT');
    }
    if (message.poll && !message.deleted && pollIsOpen(message.poll, this.now())) {
      // Two closes at once would both see it open across the audit await: the second is refused before it writes a line.
      if (this.closingPolls.has(messageId)) throw new ChatroomError('This poll is already being closed', 'CONFLICT');
      this.closingPolls.add(messageId);
      try {
        await this.audit({
          action: 'poll-close',
          roomId,
          messageId,
          by: who,
          as: who === USER_RECIPIENT ? 'user' : isAuthor ? 'author' : 'coordinator',
          question: message.poll.question,
        });
      } finally {
        this.closingPolls.delete(messageId);
      }
    }
    // The owner's last vote reaches the author before the news that the poll closed.
    this.flushOwnerVoteNotice(roomId, messageId);
    const poll = this.store.closePoll(roomId, messageId, who, this.now());
    this.changed(room, 'poll', messageId);
    const totals = poll.options.map((o) => `${quoteForPane(o.label, 100)}: ${Object.values(poll.votes).filter((v) => v.includes(o.id)).length}`).join(', ');
    const what = `closed poll ${quoteForPane(poll.question, 200)} (results: ${totals})`;
    if (isCoordinator && !isAuthor && message.from.kind === 'agent') {
      const author = room.members.find((m) => m.sessionId === (message.from as { sessionId: string }).sessionId);
      if (author && !author.postOnly) this.delivery.enqueue(author.sessionId, room, `SYSTEM -> you: ${quoteForPane(this.nameOf(who), 80)} (the room's coordinator) ${what}`, { messageId: message.id });
    } else {
      this.tellPollAuthor(room, message, who, what);
    }
    return poll;
  }

  /** A one-line, quoted note to the agent that asked the poll, about what the user did. The user's label is the only unquoted one. */
  private tellPollAuthor(room: ChatRoom, message: ChatMessage, who: string, what: string): void {
    const author = message.from.kind === 'agent' ? message.from.sessionId : undefined;
    if (!author || author === who || who !== USER_RECIPIENT) return;
    const member = room.members.find((m) => m.sessionId === author);
    if (!member || member.postOnly) return;
    this.delivery.enqueue(author, room, `USER ${what}`, { messageId: message.id });
  }

  /**
   * Car mode on the owner's page did not play a message addressed to the user, or stopped partway: its agent author gets one
   * private line saying what the app did (not what the user heard), once per message. Returns whether a line was queued.
   */
  playbackNotice(roomId: string, messageId: string, outcome: ChatPlaybackOutcome, reason: ChatPlaybackReason): boolean {
    const room = this.store.require(roomId);
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new ChatroomError('No such message', 'NOT_FOUND');
    if (message.from.kind !== 'agent' || message.deleted) return false;
    const author = message.from.sessionId;
    const member = room.members.find((m) => m.sessionId === author);
    if (!member || member.postOnly || this.playbackNoticed.has(messageId)) return false;
    // Delivery types into the pane: a polling author (its chat comes by API) or a shell pane gets nothing typed. Deferred, not
    // marked as told, until a poll-readable notice exists.
    if (!paneAcceptsChat(this.deps.getSession(author)?.mode)) return false;
    this.playbackNoticed.add(messageId);
    // A dedupe memory, not a record: the oldest ids go once it is large.
    if (this.playbackNoticed.size > PLAYBACK_NOTICE_MEMORY) this.playbackNoticed.delete(this.playbackNoticed.values().next().value as string);
    const what = outcome === 'not-played' ? 'Not played aloud' : 'Playback interrupted';
    this.delivery.enqueue(
      author,
      room,
      `SYSTEM -> you: car mode on the user's page: ${what} (${PLAYBACK_REASONS[reason]}): your message ${quoteForPane(message.text, 80)}. Its text is in the room.`,
      { messageId }
    );
    return true;
  }

  /** Toggle a reaction and tell every open panel. */
  react(roomId: string, messageId: string, emoji: string, who: string, on?: boolean): Record<string, string[]> {
    const room = this.store.require(roomId);
    const reactions = this.store.react(roomId, messageId, emoji, who, on);
    this.schedulePersist(roomId);
    this.deps.broadcast(ChatroomReaction, { owner: room.owner ?? '@single', roomId, messageId, reactions });
    return reactions;
  }

  /** Tell open panels a room's emotes changed (they re-fetch the list). */
  emotesChanged(roomId: string): void {
    const room = this.store.get(roomId);
    if (room) this.changed(room, 'emotes');
  }

  /** A leader must accept typed chat or explicitly declare API/poll delivery. */
  private assertCanLead(sessionId: string, what: 'coordinate' | 'be the voice'): void {
    const mode = this.deps.getSession(sessionId)?.mode;
    if (!paneAcceptsChat(mode) && !modePollsChat(mode)) {
      throw new ChatroomError(`Only an agent session can ${what}`, 'INVALID_INPUT');
    }
  }

  /** Re-send the briefing to one member (or every member). */
  rebrief(roomId: string, sessionId?: string): number {
    const room = this.store.require(roomId);
    const targets = room.members.filter((m) => !m.postOnly && (!sessionId || m.sessionId === sessionId));
    for (const m of targets) this.brief(room, m);
    return targets.length;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private brief(room: ChatRoom, member: ChatMember): void {
    if (member.postOnly) return; // posts only; never typed into
    // Rendered at delivery time, from the live member record, so it reflects every
    // change made before the pane reads it.
    this.delivery.enqueue(
      member.sessionId,
      room,
      () => {
        const live = this.store.get(room.id);
        const current = live?.members.find((m) => m.sessionId === member.sessionId);
        return live && current ? buildBriefing(live, current, this.nameOf) : `You were removed from ${quoteForPane(roomLabel(room), 80)}.`;
      },
      { brief: true }
    );
  }

  private announceCoordinator(room: ChatRoom, coordinator: ChatMember, justBriefed: boolean): void {
    this.system(room, `${this.nameOf(coordinator.sessionId)} is now the coordinator`);
    if (!justBriefed) this.brief(room, coordinator);
    for (const m of room.members) {
      if (m.sessionId === coordinator.sessionId || m.postOnly) continue;
      if (this.delivery.hasPendingBrief(m.sessionId, room.id)) continue; // its briefing names the coordinator
      this.delivery.enqueue(
        m.sessionId,
        room,
        `SYSTEM: ${quoteForPane(this.nameOf(coordinator.sessionId), 80)} is now the coordinator of this room; follow its direction and report to it.`
      );
    }
  }

  /** A room event shown in the feed. Not delivered to panes (deliveries above say what matters). */
  private system(room: ChatRoom, text: string, sessionId?: string): void {
    const from: ChatSender = { kind: 'system', name: 'system', ...(sessionId ? { sessionId } : {}) };
    const message = this.store.post(room.id, from, text, 'all', this.now());
    // With the database, committed before it is shown (a JSON save stays with the caller's change).
    if (this.db) this.schedulePersist(room.id);
    this.deps.broadcast(ChatroomMessage, { owner: room.owner ?? '@single', roomId: room.id, message });
  }

  private changed(room: ChatRoom, action: 'created' | 'updated' | 'deleted' | 'status' | 'emotes' | 'read' | 'poll', messageId?: string): void {
    // Persisted first: with the database the change is committed before anyone is told of it.
    this.schedulePersist(room.id);
    this.deps.broadcast(ChatroomChanged, { owner: room.owner ?? '@single', roomId: room.id, action, ...(messageId ? { messageId } : {}) });
  }

  /** `roomId`: the only room that changed (with the database, only it is compared); without it, all are. */
  private schedulePersist(roomId?: string): void {
    if (this.db) return this.syncDatabase(roomId);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    this.persistChain = this.persistChain.then(() => this.save()).catch((err) => console.error('[chatroom] persist failed:', err));
  }

  /** Archive what the rooms hold past the cap, drop it, then write the rooms file. */
  private async save(): Promise<void> {
    if (this.db) return this.syncDatabase();
    await this.archiveOverflow();
    await saveChatrooms(this.deps.file, this.store.toJSON());
  }

  /**
   * Messages past the cap go to the archive first and leave the room only once it has them. If the
   * append fails they stay (the room runs over the cap) and the next save tries again.
   */
  private async archiveOverflow(): Promise<void> {
    const overflow = this.store.overflow();
    if (!overflow.length) return;
    const now = this.now();
    try {
      const zone = (owner: string | undefined) => this.deps.timeZone?.(owner);
      const batches = overflow.map((o) => ({ ...o, week: zoneWeek(now, zone(o.room.owner)) }));
      await this.archive.append(batches, now, zone(undefined));
    } catch (err) {
      const over = overflow.reduce((n, o) => n + o.messages.length, 0);
      console.warn(`[chatroom] archive failed; keeping ${over} message(s) past the cap until it works:`, err);
      return;
    }
    for (const { room, messages } of overflow) this.store.dropArchived(room.id, new Set(messages.map((m) => m.id)));
  }
}

/** The rooms (with all their messages) of a database file just imported. */
function loadImportedRooms(file: string): ChatRoom[] {
  const db = ChatDb.open(file);
  try {
    return db.exportRooms();
  } finally {
    db.close();
  }
}

export { USER_RECIPIENT };
