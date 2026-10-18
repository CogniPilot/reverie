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

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ChatroomError,
  ChatroomStore,
  MAX_POLL_LABEL,
  MAX_POLL_OPTIONS,
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
import { ChatArchive, zoneWeek } from './chat-archive.js';
import { ChatroomDelivery, buildBriefing, paneAcceptsChat, roomLabel, senderLabel, wakeRecipients, type DeliverySession } from './chatroom-delivery.js';
import { quoteForPane } from './pane-quote.js';
import type { ChatBot } from './chat-bots.js';
import { ChatroomChanged, ChatroomMessage, ChatroomReaction, ChatroomTurn } from './web/sse-events.js';

export interface ChatSessionLike extends DeliverySession {
  readonly mode: string;
  readonly status: string;
  readonly owner?: string;
}

export interface ChatroomServiceDeps {
  file: string;
  getSession(id: string): ChatSessionLike | undefined;
  broadcast(event: string, data: unknown): void;
  now?: () => number;
  /** Attachment store; a deleted room's files are removed with it. */
  files?: { removeRoom(roomId: string): Promise<void> };
  /** Append-only JSON-lines log of deletions, restores and reports (default: next to `file`). */
  auditFile?: string;
  /** How long the poll author waits for an owner's votes to settle before hearing about them (default 3000 ms). */
  voteCoalesceMs?: number;
  /** The names an owner is called by in a room (their company-settings name), so an `@name` of them counts as a mention. */
  ownerNames?: (owner: string | undefined) => string[];
  /** Sessions whose retired state changed (retired, restored or deleted): the console refreshes their rows so a retired one leaves every tab list. */
  retiredChanged?: (sessionIds: string[]) => void;
  /** Where messages dropped past the per-room cap are archived (default: `chat-archive/` next to `file`). */
  archiveDir?: string;
  /** The company time zone for a room's owner: the archive's week files follow it (default UTC). */
  timeZone?: (owner: string | undefined) => string | undefined;
}

export interface ChatMemberView extends ChatMember {
  name: string;
  mode?: string;
  alive: boolean;
  working: boolean;
  pendingDeliveries: number;
  /** Accent hue (0-359) derived from the session id; the avatar colour. */
  hue: number;
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

export class ChatroomService {
  private store = new ChatroomStore();
  readonly delivery: ChatroomDelivery;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistChain: Promise<void> = Promise.resolve();
  private messageListeners = new Set<(room: ChatRoom, message: ChatMessage) => void>();

  /** What each agent session has seen of each room (chatroom-last-seen.ts), next to the rooms file. */
  readonly seen: LastSeenStore;

  /** Messages past the per-room cap, archived before they are dropped (chat-archive.ts). */
  private readonly archive: ChatArchive;

  constructor(private readonly deps: ChatroomServiceDeps) {
    this.archive = new ChatArchive(deps.archiveDir ?? join(dirname(deps.file), 'chat-archive'));
    this.seen = new LastSeenStore(deps.file ? join(dirname(deps.file), 'chat-last-seen.json') : undefined);
    this.delivery = new ChatroomDelivery({
      getSession: deps.getSession,
      now: deps.now,
      // A turn is starting for this member in this room: the page shows "is thinking" there until it ends.
      onWoken: (sessionId, roomId, at) => {
        const room = this.store?.get(roomId);
        if (room) this.deps.broadcast(ChatroomTurn, { owner: room.owner ?? '@single', roomId, sessionId, at });
      },
      onSubmitted: (sessionId, messages) => {
        for (const { roomId, messageId } of messages) this.markSeen(sessionId, roomId, messageId);
      },
      onStranded: (sessionId, messages) => {
        const rooms = [...new Set(messages.map((m) => m.roomId))];
        console.warn(`[chatroom] delivery to ${sessionId.slice(0, 8)} is still unsubmitted in its composer (rooms ${rooms.join(', ')})`);
        void this.audit({ action: 'delivery-stranded', sessionId, rooms, messages: messages.length }).catch(() => undefined);
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

  private retired: RetiredSession[] = [];

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
    const rooms = await loadChatrooms(this.deps.file);
    this.store = new ChatroomStore(rooms);
    await this.seen.load();
    this.learnNames(rooms);
    this.delivery.start();
  }

  async stop(): Promise<void> {
    for (const pending of this.voteNotices.values()) clearTimeout(pending.timer);
    this.voteNotices.clear();
    this.delivery.stop();
    await this.seen.flush();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.persistNow();
    }
    await this.persistChain;
  }

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

  view(room: ChatRoom, options: { since?: number; limit?: number } = {}): ChatRoomView {
    const members = room.members.map((m): ChatMemberView => {
      const s = this.deps.getSession(m.sessionId);
      const name = this.nameOf(m.sessionId);
      // A live name is kept on the membership too, so it survives a restart of the console.
      const liveName = cleanName(s?.name);
      if (liveName && m.lastName !== liveName) {
        m.lastName = liveName;
        this.schedulePersist();
      }
      return {
        ...m,
        name,
        mode: s?.mode,
        alive: !!s && s.pid !== null,
        working: !!s?.isWorking,
        pendingDeliveries: this.delivery.pendingFor(m.sessionId),
        hue: accentHue(m.sessionId),
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
      messages: this.store.messages(room.id, options),
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
    const moved = this.store.replaceMember(oldId, newId, candidates);
    for (const room of moved) {
      this.delivery.dropRoom(room.id, oldId);
      const member = room.members.find((m) => m.sessionId === newId);
      this.system(room, `${this.nameOf(newId)} moved to a new session`);
      if (member && !member.postOnly) this.brief(room, member);
      this.changed(room, 'updated');
    }
    if (moved.length) {
      // One badge per person: the old session is retired (and, if the new one was itself retired, it is back).
      this.retired = this.retired.filter((r) => r.sessionId !== newId && r.sessionId !== oldId);
      this.retired.push({ sessionId: oldId, name: oldName, successorId: newId, at: this.now(), owner: snapshot[0]?.owner, rooms: snapshot.map(({ roomId, roomName, member }) => ({ roomId, roomName, member })) });
      await this.saveRetired();
      this.deps.retiredChanged?.([oldId, newId]);
      await this.audit({ action: 'replace-session', by, from: oldId, to: newId, rooms: moved.map((r) => r.id) });
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
   * post-only; a post-only member never coordinates or speaks. Callers that build a room
   * check every member first so a refusal leaves nothing half-created.
   */
  assertJoinable(
    sessionId: string,
    options: { role?: ChatRole; voice?: boolean; postOnly?: boolean },
    existing?: ChatMember
  ): void {
    const postOnly = existing ? existing.postOnly : options.postOnly;
    if (!existing && !paneAcceptsChat(this.deps.getSession(sessionId)?.mode) && !postOnly) {
      const mode = this.deps.getSession(sessionId)?.mode ?? 'non-agent';
      throw new ChatroomError(
        `A ${mode} session would run room messages as commands; the user can add it as post-only`,
        'INVALID_INPUT'
      );
    }
    if (postOnly && (options.role === 'coordinator' || options.voice)) {
      throw new ChatroomError('A post-only member cannot coordinate or be the voice', 'INVALID_INPUT');
    }
  }

  addMember(
    roomId: string,
    sessionId: string,
    options: { role?: ChatRole; goal?: string; icon?: string; voice?: boolean; postOnly?: boolean; addedBy?: string } = {}
  ): ChatMember {
    const room = this.store.require(roomId);
    // Every path into a room (create, add, appoint, company invite/spawn) comes through here.
    this.assertJoinable(sessionId, options, room.members.find((m) => m.sessionId === sessionId));
    if (options.role === 'coordinator') this.assertCanLead(sessionId, 'coordinate');
    if (options.voice) this.assertCanLead(sessionId, 'be the voice');
    const wasCoordinator = room.members.find((m) => m.role === 'coordinator')?.sessionId;
    const { member, added } = this.store.addMember(roomId, sessionId, options, this.now());
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
    const appointed = this.store.setCoordinator(roomId, sessionId, this.now());
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
    const member = this.store.setStatus(roomId, sessionId, status, this.now());
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
    const message = this.store.post(roomId, from, text, to, this.now(), extra);
    // Only an agent's own signature names a session: a user, an external sender or the system never does.
    if (from.kind === 'agent' && cleanName(from.name)) this.knownNames.set(from.sessionId, cleanName(from.name));
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
    this.schedulePersist();
    for (const listener of this.messageListeners) listener(room, message);
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
  async deleteMessage(roomId: string, messageId: string, by: string): Promise<void> {
    const room = this.store.require(roomId);
    const original = this.store.findMessage(roomId, messageId);
    if (original.deleted) throw new ChatroomError('Already deleted', 'CONFLICT');
    await this.audit({ action: 'delete', roomId, by, message: original });
    this.store.tombstone(roomId, messageId, by, this.now());
    this.delivery.dropMessage(roomId, messageId);
    this.changed(room, 'updated');
    this.schedulePersist();
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
    return this.store.pinned(roomId);
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
    this.schedulePersist();
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
    await this.audit({ action: 'report', roomId, by: from.kind === 'user' ? from.name : 'agent', reason, message: original });
    const name = senderLabel({ ...original.from, name: this.nameOf(original.from.sessionId) });
    const snippet = original.text.replace(/\s+/g, ' ').trim().slice(0, 200) || '(attachment)';
    const text =
      `REPORT from the user about a message in ${quoteForPane(room.name, 80)} by ${name} (${new Date(original.at).toISOString()}): ` +
      `${quoteForPane(snippet, 200)}${reason.trim() ? ` Reason: ${quoteForPane(reason.trim(), 1000)}` : ''} Please look into it and tell the user what you find.`;
    const dm = this.openDm(coordinator.sessionId, room.owner);
    return { message: this.post(dm.id, from, text, 'all'), dmId: dm.id };
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

  async closePoll(roomId: string, messageId: string, who: string): Promise<ChatPoll> {
    const room = this.store.require(roomId);
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new ChatroomError('No such message', 'NOT_FOUND');
    const isAuthor = message.from.kind === 'agent' && message.from.sessionId === who;
    const isCoordinator =
      who !== USER_RECIPIENT && message.from.kind === 'agent' && room.members.some((m) => m.sessionId === who && m.role === 'coordinator');
    if (who !== USER_RECIPIENT && !isAuthor && !isCoordinator) {
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

  /** Toggle a reaction and tell every open panel. */
  react(roomId: string, messageId: string, emoji: string, who: string, on?: boolean): Record<string, string[]> {
    const room = this.store.require(roomId);
    const reactions = this.store.react(roomId, messageId, emoji, who, on);
    this.deps.broadcast(ChatroomReaction, { owner: room.owner ?? '@single', roomId, messageId, reactions });
    this.schedulePersist();
    return reactions;
  }

  /** Tell open panels a room's emotes changed (they re-fetch the list). */
  emotesChanged(roomId: string): void {
    const room = this.store.get(roomId);
    if (room) this.changed(room, 'emotes');
  }

  /** Room traffic for a member that does not resolve to an agent pane is dropped, so it cannot lead. */
  private assertCanLead(sessionId: string, what: 'coordinate' | 'be the voice'): void {
    if (!paneAcceptsChat(this.deps.getSession(sessionId)?.mode)) {
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
    this.deps.broadcast(ChatroomMessage, { owner: room.owner ?? '@single', roomId: room.id, message });
  }

  private changed(room: ChatRoom, action: 'created' | 'updated' | 'deleted' | 'status' | 'emotes' | 'read' | 'poll', messageId?: string): void {
    this.deps.broadcast(ChatroomChanged, { owner: room.owner ?? '@single', roomId: room.id, action, ...(messageId ? { messageId } : {}) });
    this.schedulePersist();
  }

  private schedulePersist(): void {
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

export { USER_RECIPIENT };
