/**
 * @fileoverview Chatrooms: a shared conversation between the user and a set of
 * sessions, one of which may be appointed coordinator.
 *
 * Pure state plus a persistence adapter. The store knows nothing about panes or
 * SSE; `chatroom-delivery.ts` turns a posted message into pane input and the
 * route module broadcasts. Rooms persist to `chatrooms.json` in the instance data
 * dir (mode 0600, tmp+rename), because messages can carry anything a prompt can.
 *
 * Model:
 * - A room has members (session ids), each with a role (`coordinator` | `agent`)
 *   and a short synopsis: `goal` and `progress`, written by the agent itself or
 *   by the user.
 * - A message comes from the user, a member session, or the system (joins,
 *   appointments). It goes to everyone (`to: 'all'`) or to a list of recipients,
 *   where a recipient is a member session id or the literal `user`.
 * - At most one coordinator per room; appointing a new one demotes the old.
 * - A direct message is a room with `kind: 'dm'` and its participants in `dm`
 *   (sorted: `user` and/or session ids). Its `members` are the participant sessions;
 *   the user is implicit in every room, so the user reads every DM. A DM has no
 *   coordinator. A two-person DM is unique per pair, has no name of its own (the label
 *   comes from the participants) and stays between those two: once one has left,
 *   nobody posts. A group DM (three to MAX_DM_PARTICIPANTS) may be named, takes new
 *   participants and lets one leave, and any number of them may share people.
 * - An ordinary room sits in a `workspace` (a Reverie case or project; the rail icon)
 *   under an optional `category`, and can be archived: read-only, kept for history.
 * - `userReadAt` is the user's read cursor; `unreadFor()` counts what came after it.
 */

import { AVATAR_URL } from './agent-avatars.js';
import type { RoomOverride } from './roles.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';

export type ChatRole = 'coordinator' | 'agent';

export interface ChatMember {
  sessionId: string;
  role: ChatRole;
  goal: string;
  /** One emoji or a 1-2 character glyph shown as the member's avatar; absent = initial on its accent colour. */
  icon?: string;
  /** The member's profile image (`/api/avatars/<id>?v=<ms>`), shown instead of `icon` when set. */
  avatar?: string;
  /**
   * This member answers spoken turns (push-to-talk through the local voice service).
   * Set explicitly by the user or the coordinator; never inferred from a name.
   */
  voice?: true;
  /**
   * Posts to the room but never receives deliveries: a non-agent session (a shell running a
   * watcher) whose pane must not be typed into. Only the user adds one.
   */
  postOnly?: true;
  /**
   * The agent session that added this member (a coordinator's add, a room it created, an invite).
   * Absent when the user, the host or a service added it, or for members older than this field.
   * Owner sign-in counts only owner-made seats when deciding which agent may type into which session.
   */
  addedBy?: string;
  /**
   * `mentions`: this member chose to be woken only by what is meant for it (a direct @name, a reply to its message, a message
   * addressed to it, and always the owner); everything else still reaches it with its next prompt. Absent = woken as the room says.
   */
  notify?: 'mentions';
  progress: string;
  /** A short "away" note others see next to the name ("back at 3"); absent = here. */
  away?: string;
  joinedAt: number;
  updatedAt: number;
  /** The last name its session was seen with, so a member whose session is gone keeps its name instead of showing an id. */
  lastName?: string;
}

/**
 * Set server-side only (owner-auth/marks.ts): a cookie-verified owner typed (or said) this user
 * message. Absent on every other message; a user message without it is the owner by absence only.
 */
export type ChatOwnerMark = 'owner_typed' | 'owner_spoken';

export type ChatSender =
  | { kind: 'user'; name: string; mark?: ChatOwnerMark }
  | {
      kind: 'external';
      name: string;
      provider: 'slack' | 'discord';
      connectionId: string;
      channelId: string;
      userId: string;
      messageId: string;
    }
  | { kind: 'agent'; sessionId: string; name: string; employeeId?: string }
  /** A post-only scheduled sender (see chat-bots.ts): never a member, never reads, shown with a BOT badge. */
  | { kind: 'bot'; botId: string; name: string; icon?: string }
  | { kind: 'system'; name: string; /** The member a join line is about, for its avatar. */ sessionId?: string };

/** `user` addresses the human; anything else is a member session id. */
export type ChatRecipient = string;
export const USER_RECIPIENT = 'user';

export type ChatWakeMode = 'all' | 'mentions';

/** Who may find and enter a room: `private` (members only; the default) or `public` (any agent can list it and join). */
export type ChatVisibility = 'public' | 'private';

export interface ChatMessage {
  id: string;
  roomId: string;
  at: number;
  from: ChatSender;
  to: 'all' | ChatRecipient[];
  text: string;
  /** Files attached to the message (chatroom-files.ts); `path` is where agents read them. */
  attachments?: ChatAttachment[];
  /** Set when the user deleted the message: its content is gone from the room (kept in the audit log), this tombstone stays. */
  deleted?: { at: number; by: string; /** Rank of whoever deleted it; absent means the Owner (100), as for deletions made before roles. A restore needs at least this rank. */ byRank?: number; /** The files stay referenced so the upload sweep keeps them for a restore. */ attachments?: ChatAttachment[] };
  /** The id of the earlier message in this room that this one answers (a Discord-style reply). */
  replyTo?: string;
  /** Reactions: emoji (or `:emote:`) -> who reacted ('user' or session ids). */
  reactions?: Record<string, string[]>;
  /** Spoken turns: a dashboard path that plays this message's audio (voice-turn-routes.ts). */
  audioUrl?: string;
  /** Spoken turns are shown in the room but never typed into a pane (the voice service already answered). */
  voice?: true;
  /**
   * Said aloud and transcribed by the phone (car mode). Unlike `voice`, it is an ordinary
   * message the member answers as usual; the flag only marks it as speech.
   */
  spoken?: true;
  /** A poll: `text` is its question. Votes are kept per voter. */
  poll?: ChatPoll;
  /** Set when the owner edited the message's text: `text` is the new text, the original is in the audit log. */
  edited?: { at: number };
  /** Pinned in the room (a rule or an announcement): who pinned it and when. Pinned messages feed the members' briefing. */
  pinned?: { at: number; by: string; /** The user's pin or the room coordinator's: the coordinator cannot unpin the user's. */ kind: 'user' | 'agent' };
}

export interface ChatPollOption {
  id: string;
  label: string;
}

export interface ChatPoll {
  question: string;
  options: ChatPollOption[];
  /** Several options may be chosen. */
  multi?: true;
  /** After this time (ms) the poll takes no more votes. */
  closesAt?: number;
  /** The option the poll's author suggests (an option id). */
  recommended?: string;
  /** Set when the poll was closed early. */
  closed?: { at: number; by: string };
  /** Voter ('user' or a member's session id) -> the option ids chosen. */
  votes: Record<string, string[]>;
}

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  /** Absolute path of the stored file on this machine. */
  path: string;
}

/** Poll limits: the question, the options and each option's label. */
export const MAX_POLL_OPTIONS = 10;
export const MAX_POLL_QUESTION = 300;
export const MAX_POLL_LABEL = 100;

/** Is the poll still taking votes at `now`? */
export function pollIsOpen(poll: ChatPoll, now: number): boolean {
  return !poll.closed && !(poll.closesAt !== undefined && now >= poll.closesAt);
}

/** Most reactions one message may carry (distinct emoji). */
export const MAX_REACTION_KINDS = 20;

export interface ChatRoom {
  id: string;
  /** Empty for a DM (its label is derived from the participants). */
  name: string;
  /** Absent for an ordinary room. */
  kind?: 'dm';
  /** A DM's participants, sorted: `user` and/or session ids (two, or a group of up to MAX_DM_PARTICIPANTS). */
  dm?: string[];
  /** An ordinary room's workspace (a Reverie case or project); absent = the default one. */
  workspace?: string;
  /** An ordinary room's category heading inside its workspace. */
  category?: string;
  /** What the channel is for, shown in its header (ordinary rooms only). */
  topic?: string;
  /** When the room was archived (read-only); absent = active. */
  archivedAt?: number;
  /**
   * Who a post to the whole room wakes: `all` (every member, as always) or `mentions` (the @mentioned, the author replied to, the
   * coordinator; the rest read it with their next prompt). Absent = the console's default (REVERIE_CHAT_WAKE, else `all`).
   */
  wake?: ChatWakeMode;
  /** Absent = private. A direct message is always private. */
  visibility?: ChatVisibility;
  /** The owner's place for this channel in their sidebar (1 is first); channels the owner never placed come after the placed ones. */
  position?: number;
  /** Channel allow/deny overrides for roles and members (roles-contract section 5); absent = none. Edited through the overrides API. */
  overrides?: RoomOverride[];
  /** The user's read cursor (ms): messages after it are unread. */
  userReadAt?: number;
  /** Multi-user owner; undefined in single-user mode. */
  owner?: string;
  createdAt: number;
  members: ChatMember[];
  messages: ChatMessage[];
}

/** Ordinary rooms; DMs count against MAX_DMS instead. */
export const MAX_ROOMS = 50;
export const MAX_DMS = 200;
export const MAX_DM_PARTICIPANTS = 10;
export const MAX_PLACEMENT_CHARS = 40;
export const MAX_MEMBERS = 50;
export const MAX_MESSAGES_PER_ROOM = 1000;
export const MAX_MESSAGE_CHARS = 8000;
/** Pinned messages in one room. */
export const MAX_PINS = 10;
export const MAX_SYNOPSIS_CHARS = 500;
export const MAX_ROOM_NAME_CHARS = 80;
export const MAX_ROOM_TOPIC_CHARS = 500;

export const MAX_ICON_GRAPHEMES = 2;
export const MAX_ICON_CHARS = 16;

/**
 * Characters an icon may not contain: controls, line/paragraph separators, and
 * invisible format characters (zero-width spaces, bidi overrides and isolates)
 * that would alter how the name beside the avatar renders. The two format
 * characters emoji are built from stay allowed: ZWJ (U+200D, joined emoji
 * sequences) and tag characters (U+E0020-E007F, subdivision flags).
 */
const HIDDEN_ICON_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200d\u{e0020}-\u{e007f}])\p{Cf}/u;

/**
 * Normalise an avatar icon: trimmed, at most two user-perceived characters (an
 * emoji with modifiers counts as one), no control characters. `''` clears it.
 * Returns undefined for anything that does not fit, so callers can refuse it.
 */
export function normalizeIcon(raw: string): string | undefined {
  // Checked on the raw input: trim() would silently drop a line separator.
  if (HIDDEN_ICON_CHARS.test(raw.replace(/^[ \t]+|[ \t]+$/g, ''))) return undefined;
  const text = raw.trim();
  if (!text) return '';
  if (text.length > MAX_ICON_CHARS) return undefined;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  return graphemes.length <= MAX_ICON_GRAPHEMES ? text : undefined;
}

/** Set ('' clears) a member's profile image; only a URL of the avatar route is ever stored. */
function setAvatar(member: ChatMember, avatar: string): void {
  if (!avatar) delete member.avatar;
  else if (AVATAR_URL.test(avatar)) member.avatar = avatar;
  else throw new ChatroomError('Not a profile image of this server', 'INVALID_INPUT');
}

function setIcon(member: ChatMember, icon: string): void {
  if (icon) member.icon = icon;
  else delete member.icon;
}

/** A room has at most ONE voice member: marking one clears every other. */
function setVoice(room: ChatRoom, member: ChatMember, voice: boolean, pollingLead = false): void {
  if (voice && member.postOnly && !pollingLead) throw new ChatroomError('A post-only member cannot be the voice', 'INVALID_INPUT');
  if (voice) {
    for (const other of room.members) if (other !== member) delete other.voice;
    member.voice = true;
  } else {
    delete member.voice;
  }
}

function iconOrThrow(raw: string): string {
  const icon = normalizeIcon(raw);
  if (icon === undefined) throw new ChatroomError('An icon is one emoji or at most two characters', 'INVALID_INPUT');
  return icon;
}

/** Deterministic accent hue (0-359) for a session id, so every avatar looks assigned. */
export function accentHue(sessionId: string): number {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

export class ChatroomError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT' | 'UNAVAILABLE'
  ) {
    super(message);
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export class ChatroomStore {
  private rooms = new Map<string, ChatRoom>();

  constructor(rooms: ChatRoom[] = []) {
    for (const room of rooms) {
      // A room from before read cursors starts read up to its newest message, so the
      // first load does not light up every room.
      if (typeof room.userReadAt !== 'number') room.userReadAt = room.messages.at(-1)?.at ?? room.createdAt;
      this.rooms.set(room.id, room);
    }
  }

  /**
   * Put every room back to `rooms` (a change the database did not commit). A room that still exists
   * keeps its object, so whoever holds it sees the rollback; rooms not in `rooms` go.
   */
  reset(rooms: ChatRoom[]): void {
    const ids = new Set(rooms.map((r) => r.id));
    for (const id of [...this.rooms.keys()]) if (!ids.has(id)) this.rooms.delete(id);
    for (const room of rooms) {
      const current = this.rooms.get(room.id);
      if (!current) {
        this.rooms.set(room.id, room);
        continue;
      }
      for (const key of Object.keys(current)) if (!(key in room)) delete (current as unknown as Record<string, unknown>)[key];
      Object.assign(current, room);
    }
  }

  list(): ChatRoom[] {
    return [...this.rooms.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ChatRoom | undefined {
    return this.rooms.get(id);
  }

  /** Rooms the session belongs to. */
  roomsFor(sessionId: string): ChatRoom[] {
    return this.list().filter((r) => r.members.some((m) => m.sessionId === sessionId));
  }

  require(id: string): ChatRoom {
    const room = this.rooms.get(id);
    if (!room) throw new ChatroomError(`No chatroom ${id}`, 'NOT_FOUND');
    return room;
  }

  create(
    name: string,
    owner: string | undefined,
    now = Date.now(),
    placement: { workspace?: string; category?: string } = {}
  ): ChatRoom {
    if (this.list().filter((r) => !isDm(r)).length >= MAX_ROOMS) {
      throw new ChatroomError(`At most ${MAX_ROOMS} chatrooms`, 'CONFLICT');
    }
    const clean = clip(name, MAX_ROOM_NAME_CHARS);
    if (!clean) throw new ChatroomError('A chatroom needs a name', 'INVALID_INPUT');
    const room: ChatRoom = {
      id: randomUUID(),
      name: clean,
      owner,
      createdAt: now,
      userReadAt: now,
      members: [],
      messages: [],
    };
    applyPlacement(room, placement);
    this.rooms.set(room.id, room);
    return room;
  }

  /** Move an ordinary room to another workspace or category (`''` clears one). */
  place(id: string, placement: { workspace?: string; category?: string }): ChatRoom {
    const room = this.require(id);
    if (isDm(room)) throw new ChatroomError('A direct message has no workspace or category', 'CONFLICT');
    applyPlacement(room, placement);
    return room;
  }

  /** Archive (read-only, kept for history) or restore an ordinary room. */
  archive(id: string, archived: boolean, now = Date.now()): ChatRoom {
    const room = this.require(id);
    if (isDm(room)) throw new ChatroomError('A direct message cannot be archived', 'CONFLICT');
    if (archived) room.archivedAt ??= now;
    else delete room.archivedAt;
    return room;
  }

  /** Set how a room wakes its members (`default` removes the room's own setting). A direct message has none. */
  setWake(id: string, mode: ChatWakeMode | 'default'): ChatRoom {
    const room = this.require(id);
    if (isDm(room)) throw new ChatroomError('A direct message always wakes its other member', 'CONFLICT');
    if (mode === 'default') delete room.wake;
    else room.wake = mode;
    return room;
  }

  /** Make an ordinary room public or private (a direct message is always private). */
  /**
   * Set the owner's order of channels: the rooms listed get positions 1..n in the order given. Unknown ids, repeats and direct messages
   * are skipped. Returns the rooms that were placed.
   */
  setOrder(ids: string[]): ChatRoom[] {
    const placed: ChatRoom[] = [];
    for (const id of ids) {
      const room = this.get(id);
      if (!room || isDm(room) || placed.includes(room)) continue;
      room.position = placed.length + 1;
      placed.push(room);
    }
    return placed;
  }

  /** Set one member's own notification choice (`all` removes it). */
  setNotify(roomId: string, sessionId: string, mode: 'all' | 'mentions'): ChatMember {
    const member = this.require(roomId).members.find((m) => m.sessionId === sessionId);
    if (!member) throw new ChatroomError('No such member', 'NOT_FOUND');
    if (mode === 'mentions') member.notify = 'mentions';
    else delete member.notify;
    return member;
  }

  setVisibility(id: string, visibility: ChatVisibility): ChatRoom {
    const room = this.require(id);
    if (isDm(room)) throw new ChatroomError('A direct message is always private', 'CONFLICT');
    if (visibility === 'public') room.visibility = 'public';
    else delete room.visibility;
    return room;
  }

  /** The two-person DM between `a` and `b`, if there is one. */
  findDm(a: string, b: string): ChatRoom | undefined {
    const key = dmKey([a, b]);
    return this.list().find((r) => isDm(r) && r.dm.length === 2 && dmKey(r.dm) === key);
  }

  /**
   * Open a DM between `participants` (`user` and/or session ids). Two people reuse
   * their DM when there is one; three or more always start a new group (optionally
   * named).
   */
  openDm(
    participants: string[],
    owner: string | undefined,
    options: { name?: string; now?: number } = {}
  ): { room: ChatRoom; created: boolean } {
    const now = options.now ?? Date.now();
    const dm = [...new Set(participants.filter(Boolean))].sort();
    if (dm.length < 2) throw new ChatroomError('A direct message needs two different participants', 'INVALID_INPUT');
    if (dm.length > MAX_DM_PARTICIPANTS) {
      throw new ChatroomError(`A group direct message has at most ${MAX_DM_PARTICIPANTS} people`, 'INVALID_INPUT');
    }
    if (dm.length === 2) {
      const existing = this.findDm(dm[0], dm[1]);
      if (existing) return { room: existing, created: false };
    }
    if (this.list().filter(isDm).length >= MAX_DMS) {
      throw new ChatroomError(`At most ${MAX_DMS} direct messages`, 'CONFLICT');
    }
    const room: ChatRoom = {
      id: randomUUID(),
      name: dm.length > 2 ? clip(options.name ?? '', MAX_ROOM_NAME_CHARS) : '',
      kind: 'dm',
      dm,
      owner,
      createdAt: now,
      userReadAt: now,
      members: dm
        .filter((p) => p !== USER_RECIPIENT)
        .map((sessionId) => ({ sessionId, role: 'agent', goal: '', progress: '', joinedAt: now, updatedAt: now })),
      messages: [],
    };
    this.rooms.set(room.id, room);
    return { room, created: true };
  }

  /** Move the user's read cursor forward (never back). */
  markRead(roomId: string, at: number): number {
    const room = this.require(roomId);
    if (Number.isFinite(at) && at > (room.userReadAt ?? 0)) room.userReadAt = at;
    return room.userReadAt ?? 0;
  }

  rename(id: string, name: string): ChatRoom {
    const room = this.require(id);
    if (isDm(room) && room.dm.length === 2) {
      throw new ChatroomError('A two-person direct message cannot be renamed', 'CONFLICT');
    }
    const clean = clip(name, MAX_ROOM_NAME_CHARS);
    // A group DM may drop its name and go back to the participants' names.
    if (isDm(room)) {
      room.name = clean;
      return room;
    }
    if (!clean) throw new ChatroomError('A chatroom needs a name', 'INVALID_INPUT');
    room.name = clean;
    return room;
  }

  /** Set (or with `''` clear) an ordinary room's topic. */
  setTopic(id: string, topic: string): ChatRoom {
    const room = this.require(id);
    if (isDm(room)) throw new ChatroomError('A direct message has no topic', 'INVALID_INPUT');
    const clean = clip(topic, MAX_ROOM_TOPIC_CHARS).trim();
    if (clean) room.topic = clean;
    else delete room.topic;
    return room;
  }

  delete(id: string): boolean {
    return this.rooms.delete(id);
  }

  member(roomId: string, sessionId: string): ChatMember | undefined {
    return this.rooms.get(roomId)?.members.find((m) => m.sessionId === sessionId);
  }

  coordinator(roomId: string): ChatMember | undefined {
    return this.rooms.get(roomId)?.members.find((m) => m.role === 'coordinator');
  }

  /** Add a member, or update the goal of an existing one. Returns whether it was new. */
  addMember(
    roomId: string,
    sessionId: string,
    options: { role?: ChatRole; goal?: string; icon?: string; voice?: boolean; postOnly?: boolean; addedBy?: string; pollingLead?: boolean } = {},
    now = Date.now()
  ): { member: ChatMember; added: boolean } {
    const room = this.require(roomId);
    const existing = room.members.find((m) => m.sessionId === sessionId);
    if (room.archivedAt) throw new ChatroomError('This room is archived', 'CONFLICT');
    if (isDm(room) && options.role === 'coordinator') {
      throw new ChatroomError('A direct message has no coordinator', 'INVALID_INPUT');
    }
    if (isDm(room) && !existing) {
      if (room.dm.length === 2) {
        throw new ChatroomError('A two-person direct message stays between those two', 'CONFLICT');
      }
      if (room.dm.length >= MAX_DM_PARTICIPANTS) {
        throw new ChatroomError(`A group direct message has at most ${MAX_DM_PARTICIPANTS} people`, 'CONFLICT');
      }
      room.dm = [...room.dm, sessionId].sort();
    }
    if (existing) {
      if (options.goal !== undefined) existing.goal = clip(options.goal, MAX_SYNOPSIS_CHARS);
      if (options.icon !== undefined) setIcon(existing, iconOrThrow(options.icon));
      if (options.voice !== undefined) setVoice(room, existing, options.voice, options.pollingLead);
      if (options.role === 'coordinator') this.setCoordinator(roomId, sessionId, now, options.pollingLead);
      existing.updatedAt = now;
      return { member: existing, added: false };
    }
    if (room.members.length >= MAX_MEMBERS) throw new ChatroomError(`At most ${MAX_MEMBERS} members`, 'CONFLICT');
    const member: ChatMember = {
      sessionId,
      role: 'agent',
      goal: clip(options.goal ?? '', MAX_SYNOPSIS_CHARS),
      ...(options.icon ? { icon: iconOrThrow(options.icon) || undefined } : {}),
      ...(options.postOnly ? { postOnly: true as const } : {}),
      ...(options.addedBy ? { addedBy: options.addedBy } : {}),
      progress: '',
      joinedAt: now,
      updatedAt: now,
    };
    room.members.push(member);
    if (options.voice) setVoice(room, member, true, options.pollingLead);
    if (options.role === 'coordinator') this.setCoordinator(roomId, sessionId, now, options.pollingLead);
    return { member, added: true };
  }

  removeMember(roomId: string, sessionId: string): boolean {
    const room = this.require(roomId);
    const before = room.members.length;
    room.members = room.members.filter((m) => m.sessionId !== sessionId);
    // Someone leaving a group DM leaves the group; a two-person DM keeps both names (and goes quiet).
    if (isDm(room) && room.dm.length > 2) room.dm = room.dm.filter((p) => p !== sessionId);
    return room.members.length !== before;
  }

  /**
   * A session was replaced by its successor (a plan switch starts a new session): in every room it is in, `newId` takes its place with
   * the same role (coordinator included), goal, progress, icon, voice and notify setting, and a direct message's participant list
   * follows. Messages already written keep the old session's name. If `newId` is already a member the old one is removed, handing over the coordinator
   * seat and any goal, progress, icon, voice, notify or away note the successor has not set itself. `rooms` limits it to the rooms the caller may touch. Returns the rooms that changed.
   */
  replaceMember(oldId: string, newId: string, rooms: ChatRoom[]): ChatRoom[] {
    const changed: ChatRoom[] = [];
    for (const room of rooms) {
      const old = room.members.find((m) => m.sessionId === oldId);
      if (!old) continue;
      const already = room.members.find((m) => m.sessionId === newId);
      if (already) {
        if (old.role === 'coordinator') already.role = 'coordinator';
        // A successor made with its parent's header is already in the parent's rooms, empty: it inherits what the old one had set,
        // but keeps anything it set itself.
        if (!already.goal && old.goal) already.goal = old.goal;
        if (!already.progress && old.progress) already.progress = old.progress;
        if (!already.icon && !already.avatar) {
          if (old.icon) already.icon = old.icon;
          if (old.avatar) already.avatar = old.avatar;
        }
        if (old.voice && !already.voice) already.voice = true;
        if (old.notify && !already.notify) already.notify = old.notify;
        if (old.away && !already.away) already.away = old.away;
        already.updatedAt = Date.now();
        room.members = room.members.filter((m) => m !== old);
      } else {
        old.sessionId = newId;
        old.updatedAt = Date.now();
      }
      if (isDm(room)) room.dm = [...new Set(room.dm.map((p) => (p === oldId ? newId : p)))];
      changed.push(room);
    }
    return changed;
  }

  /** Appoint `sessionId` (a member) as coordinator, demoting any other; `null` clears it. */
  setCoordinator(roomId: string, sessionId: string | null, now = Date.now(), pollingLead = false): ChatMember | undefined {
    const room = this.require(roomId);
    if (isDm(room) && sessionId !== null)
      throw new ChatroomError('A direct message has no coordinator', 'INVALID_INPUT');
    if (sessionId !== null && !room.members.some((m) => m.sessionId === sessionId)) {
      throw new ChatroomError('The coordinator must be a member of the room', 'INVALID_INPUT');
    }
    if (!pollingLead && room.members.some((m) => m.sessionId === sessionId && m.postOnly)) {
      throw new ChatroomError('A post-only member cannot coordinate', 'INVALID_INPUT');
    }
    let appointed: ChatMember | undefined;
    for (const m of room.members) {
      const next: ChatRole = m.sessionId === sessionId ? 'coordinator' : 'agent';
      if (m.role !== next) m.updatedAt = now;
      m.role = next;
      if (next === 'coordinator') appointed = m;
    }
    return appointed;
  }

  setStatus(
    roomId: string,
    sessionId: string,
    status: { goal?: string; progress?: string; away?: string; icon?: string; voice?: boolean; avatar?: string },
    now = Date.now(),
    pollingLead = false
  ): ChatMember {
    const member = this.member(roomId, sessionId);
    if (!member) throw new ChatroomError('Not a member of this room', 'NOT_FOUND');
    if (status.goal !== undefined) member.goal = clip(status.goal, MAX_SYNOPSIS_CHARS);
    if (status.progress !== undefined) member.progress = clip(status.progress, MAX_SYNOPSIS_CHARS);
    if (status.away !== undefined) {
      const away = clip(status.away, MAX_SYNOPSIS_CHARS).trim();
      if (away) member.away = away;
      else delete member.away;
    }
    if (status.icon !== undefined) setIcon(member, iconOrThrow(status.icon));
    if (status.avatar !== undefined) setAvatar(member, status.avatar);
    if (status.voice !== undefined) setVoice(this.require(roomId), member, status.voice, pollingLead);
    member.updatedAt = now;
    return member;
  }

  post(
    roomId: string,
    from: ChatSender,
    text: string,
    to: 'all' | ChatRecipient[] = 'all',
    now = Date.now(),
    extra: { audioUrl?: string; voice?: true; spoken?: true; attachments?: ChatAttachment[]; replyTo?: string; poll?: ChatPoll } = {}
  ): ChatMessage {
    const room = this.require(roomId);
    if (room.archivedAt && from.kind !== 'system') throw new ChatroomError('This room is archived', 'CONFLICT');
    if (from.kind === 'external' && isDm(room))
      throw new ChatroomError('External channels cannot link direct messages', 'INVALID_INPUT');
    if (from.kind === 'bot' && isDm(room)) throw new ChatroomError('A bot cannot post in a direct message', 'INVALID_INPUT');
    if (isDm(room) && from.kind !== 'system') {
      const gone = room.dm.find((p) => p !== USER_RECIPIENT && !room.members.some((m) => m.sessionId === p));
      if (gone) throw new ChatroomError('The other participant has left this direct message', 'CONFLICT');
      if (from.kind === 'agent' && !room.dm.includes(from.sessionId)) {
        throw new ChatroomError('Only its participants post in a direct message', 'INVALID_INPUT');
      }
    }
    from = senderWithoutForgedMark(from);
    const body = clip(text, MAX_MESSAGE_CHARS);
    if (!body && !extra.attachments?.length) throw new ChatroomError('Empty message', 'INVALID_INPUT');
    if (extra.attachments && !extra.attachments.length) delete extra.attachments;
    if (extra.replyTo === undefined) delete extra.replyTo;
    else if (!room.messages.some((m) => m.id === extra.replyTo && !m.deleted)) {
      throw new ChatroomError('The message being replied to is not in this room', 'INVALID_INPUT');
    }
    let recipients: 'all' | ChatRecipient[] = 'all';
    if (to !== 'all') {
      recipients = [...new Set(to)];
      for (const r of recipients) {
        if (r !== USER_RECIPIENT && !room.members.some((m) => m.sessionId === r)) {
          throw new ChatroomError(`Recipient ${r} is not in this room`, 'INVALID_INPUT');
        }
      }
      if (recipients.length === 0) throw new ChatroomError('No recipients', 'INVALID_INPUT');
    }
    // Strictly increasing within a room: the read cursor is a timestamp, so a message sharing the
    // millisecond (or an earlier one, after a clock step) of the one last read must still sort after it.
    const last = room.messages.at(-1)?.at;
    const at = last !== undefined && now <= last ? last + 1 : now;
    const message: ChatMessage = { id: randomUUID(), roomId, at, from, to: recipients, text: body, ...extra };
    room.messages.push(message);
    // Past MAX_MESSAGES_PER_ROOM the oldest wait here until the service has archived them (dropArchived).
    return message;
  }

  /** Each room's messages past MAX_MESSAGES_PER_ROOM, oldest first: what the next save archives, then drops. */
  overflow(): Array<{ room: ChatRoom; messages: ChatMessage[] }> {
    const out: Array<{ room: ChatRoom; messages: ChatMessage[] }> = [];
    for (const room of this.rooms.values()) {
      const over = room.messages.length - MAX_MESSAGES_PER_ROOM;
      if (over > 0) out.push({ room, messages: room.messages.slice(0, over) });
    }
    return out;
  }

  /** Drop archived messages from the front of a room: only those still at the front, by id. Returns how many. */
  dropArchived(roomId: string, ids: ReadonlySet<string>): number {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    let n = 0;
    while (n < room.messages.length && ids.has(room.messages[n].id)) n++;
    room.messages.splice(0, n);
    return n;
  }

  /** Messages after `since` (exclusive, ms), newest `limit`. */
  /** The message with this id, tombstones included. */
  findMessage(roomId: string, messageId: string): ChatMessage {
    const message = this.require(roomId).messages.find((m) => m.id === messageId);
    if (!message) throw new ChatroomError('No such message', 'NOT_FOUND');
    return message;
  }

  /**
   * Replace a message with a tombstone (same id, time, sender and recipients; no text, files, reactions
   * or reply link). Returns the original, which the caller has already put in the audit log.
   */
  tombstone(roomId: string, messageId: string, by: string, at: number, byRank?: number): ChatMessage {
    const room = this.require(roomId);
    const index = room.messages.findIndex((m) => m.id === messageId);
    if (index < 0) throw new ChatroomError('No such message', 'NOT_FOUND');
    const original = room.messages[index];
    if (original.deleted) throw new ChatroomError('Already deleted', 'CONFLICT');
    room.messages[index] = {
      id: original.id,
      roomId: original.roomId,
      at: original.at,
      from: original.from,
      to: original.to,
      text: '',
      deleted: { at, by, ...(byRank !== undefined && byRank < 100 ? { byRank } : {}), ...(original.attachments?.length ? { attachments: original.attachments } : {}) },
    };
    return original;
  }

  /** Put an audited original back in place of its tombstone. */
  restore(roomId: string, original: ChatMessage): void {
    const room = this.require(roomId);
    const index = room.messages.findIndex((m) => m.id === original.id);
    if (index < 0) throw new ChatroomError('No such message', 'NOT_FOUND');
    if (!room.messages[index].deleted) throw new ChatroomError('That message is not deleted', 'CONFLICT');
    room.messages[index] = original;
  }

  /**
   * Replace the text of a message (an edit). Returns the original, which the caller has already put in the audit log.
   * Recipients, time, replies and reactions are kept: an edit changes what was said, not who it was said to.
   */
  editText(roomId: string, messageId: string, text: string, at: number, options: { ownerVerified?: boolean } = {}): ChatMessage {
    const message = this.findMessage(roomId, messageId);
    if (message.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    if (message.poll) throw new ChatroomError('A poll cannot be edited', 'INVALID_INPUT');
    if (message.from.kind !== 'user') throw new ChatroomError('Only your own messages can be edited', 'INVALID_INPUT');
    const body = clip(text, MAX_MESSAGE_CHARS);
    if (!body && !message.attachments?.length) throw new ChatroomError('Empty message', 'INVALID_INPUT');
    const original = { ...message };
    message.text = body;
    message.edited = { at };
    // An owner mark vouches for the text: an edit by anyone but a verified owner drops it.
    if (!options.ownerVerified && 'mark' in message.from) {
      const { mark: _dropped, ...unmarked } = message.from;
      message.from = unmarked;
    }
    return original;
  }

  /** The room's pinned messages, newest pin first (deleted messages are never pinned: a tombstone drops the pin). */
  pinned(roomId: string): ChatMessage[] {
    return this.require(roomId)
      .messages.filter((m) => m.pinned && !m.deleted)
      .sort((a, b) => (b.pinned?.at ?? 0) - (a.pinned?.at ?? 0));
  }

  /** Pin (with `by`) or unpin (`by` undefined) one message. Returns whether anything changed. */
  setPinned(roomId: string, messageId: string, by: { name: string; kind: 'user' | 'agent' } | undefined, at: number): boolean {
    const message = this.findMessage(roomId, messageId);
    if (message.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    if (by === undefined) {
      if (!message.pinned) return false;
      delete message.pinned;
      return true;
    }
    if (message.pinned) return false;
    if (message.from.kind === 'system') throw new ChatroomError('A room notice cannot be pinned', 'INVALID_INPUT');
    if (this.pinned(roomId).length >= MAX_PINS) {
      throw new ChatroomError(`At most ${MAX_PINS} pinned messages in a room: unpin one first`, 'CONFLICT');
    }
    message.pinned = { at, by: by.name, kind: by.kind };
    return true;
  }

  /**
   * Toggle (or set, with `on`) one person's reaction on a message. Returns the message's
   * reactions afterwards; an emoji nobody uses any more is dropped.
   */
  react(roomId: string, messageId: string, emoji: string, who: string, on?: boolean): Record<string, string[]> {
    const room = this.require(roomId);
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new ChatroomError('No such message', 'NOT_FOUND');
    if (message.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    const reactions = (message.reactions ??= {});
    const list = reactions[emoji] ?? [];
    const has = list.includes(who);
    const want = on ?? !has;
    if (want && !has) {
      if (!reactions[emoji] && Object.keys(reactions).length >= MAX_REACTION_KINDS) {
        throw new ChatroomError(`At most ${MAX_REACTION_KINDS} different reactions on a message`, 'CONFLICT');
      }
      reactions[emoji] = [...list, who];
    } else if (!want && has) {
      const rest = list.filter((w) => w !== who);
      if (rest.length) reactions[emoji] = rest;
      else delete reactions[emoji];
    }
    if (!Object.keys(reactions).length) delete message.reactions;
    return message.reactions ?? {};
  }

  /**
   * Set one voter's choice on a poll (an empty list withdraws the vote). Returns the poll afterwards.
   * The voter must be the user or a member of the room; a closed or expired poll takes no more votes.
   */
  vote(roomId: string, messageId: string, who: string, optionIds: string[], now = Date.now()): ChatPoll {
    const room = this.require(roomId);
    if (who !== USER_RECIPIENT && !room.members.some((m) => m.sessionId === who)) {
      throw new ChatroomError('Only members of the room vote', 'INVALID_INPUT');
    }
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new ChatroomError('No such message', 'NOT_FOUND');
    if (message.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    const poll = message.poll;
    if (!poll) throw new ChatroomError('That message is not a poll', 'INVALID_INPUT');
    if (!pollIsOpen(poll, now)) throw new ChatroomError('This poll is closed', 'CONFLICT');
    const chosen = [...new Set(optionIds)];
    if (chosen.some((id) => !poll.options.some((o) => o.id === id))) {
      throw new ChatroomError('Not an option of this poll', 'INVALID_INPUT');
    }
    if (chosen.length > 1 && !poll.multi) throw new ChatroomError('This poll takes one choice', 'INVALID_INPUT');
    if (chosen.length) poll.votes[who] = chosen;
    else delete poll.votes[who];
    return poll;
  }

  /** Close a poll early. Who may is the caller's decision (the service checks). */
  closePoll(roomId: string, messageId: string, by: string, now = Date.now()): ChatPoll {
    const room = this.require(roomId);
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new ChatroomError('No such message', 'NOT_FOUND');
    if (message.deleted) throw new ChatroomError('That message was deleted', 'CONFLICT');
    if (!message.poll) throw new ChatroomError('That message is not a poll', 'INVALID_INPUT');
    if (!pollIsOpen(message.poll, now)) throw new ChatroomError('This poll is already closed', 'CONFLICT');
    message.poll.closed = { at: now, by };
    return message.poll;
  }

  messages(roomId: string, options: { since?: number; limit?: number } = {}): ChatMessage[] {
    const room = this.require(roomId);
    const since = options.since ?? 0;
    const list = room.messages.filter((m) => m.at > since);
    const limit = options.limit ?? 200;
    // A tombstone keeps its file references in the store (so the upload sweep leaves the files for a restore) but never shows them.
    return list.slice(Math.max(0, list.length - limit)).map((m) => (m.deleted?.attachments ? { ...m, deleted: { at: m.deleted.at, by: m.deleted.by } } : m));
  }

  toJSON(): ChatRoom[] {
    return this.list();
  }
}

export function isDm(room: ChatRoom): room is ChatRoom & { kind: 'dm'; dm: string[] } {
  return room.kind === 'dm' && Array.isArray(room.dm) && room.dm.length >= 2;
}

/** Participants as one sorted key. */
export function dmKey(participants: string[]): string {
  return [...participants].sort().join('|');
}

/** In a two-person DM, the participant that is not `self` (`user` or a session id). */
export function dmPeer(room: ChatRoom, self: string): string | undefined {
  return isDm(room) && room.dm.length === 2 && room.dm.includes(self) ? room.dm.find((p) => p !== self) : undefined;
}

function applyPlacement(room: ChatRoom, placement: { workspace?: string; category?: string }): void {
  for (const key of ['workspace', 'category'] as const) {
    const value = placement[key];
    if (value === undefined) continue;
    const clean = clip(value, MAX_PLACEMENT_CHARS);
    if (clean) room[key] = clean;
    else delete room[key];
  }
}

/** Is `@name` in the text (not inside a word or an address like a@b, and not followed by a name character)? Case-insensitive. */
export function textMentions(text: string | undefined, name: string): boolean {
  if (!text || !name.trim()) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, 'i').test(text);
}

/** Words that name the owner or the whole room: `@user`, `@owner`, `@everyone`, and the owner's own name. */
export function mentionsOwner(text: string | undefined, ownerNames: readonly string[] = []): boolean {
  return ['user', 'owner', 'everyone', ...ownerNames].some((n) => textMentions(text, n));
}

/**
 * The user's unread state for a room: `unread` counts messages after the read cursor
 * that someone other than the user wrote (system lines excluded); `mentions` those
 * that name the user (`@user`, `@owner`, their own name) or the whole room (`@everyone`), or were
 * addressed to them in an older room, which is every one of them in a DM with the user.
 */
export function unreadFor(room: ChatRoom, ownerNames: readonly string[] = []): { unread: number; mentions: number } {
  const since = room.userReadAt ?? 0;
  const withUser = isDm(room) && room.dm.includes(USER_RECIPIENT);
  let unread = 0;
  let mentions = 0;
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const m = room.messages[i];
    if (m.at <= since) break;
    if (m.from.kind !== 'agent' || m.deleted) continue;
    unread++;
    // A mention of the owner: a message addressed to them (older rooms), or one that @names them or everyone.
    if (withUser || (m.to !== 'all' && m.to.includes(USER_RECIPIENT)) || (m.to === 'all' && mentionsOwner(m.text, ownerNames))) mentions++;
  }
  return { unread, mentions };
}

/**
 * Who should RECEIVE a message in their pane: every member except the sender for
 * a room-wide message, else the listed member sessions. `user` is never a pane.
 */
/** Can any agent find this room and join it? Only an ordinary room the owner made public. */
export function isPublicRoom(room: ChatRoom): boolean {
  return !isDm(room) && room.visibility === 'public';
}

export function messageRecipients(room: ChatRoom, message: ChatMessage): string[] {
  const sender = message.from.kind === 'agent' ? message.from.sessionId : undefined;
  if (message.from.kind === 'system') return [];
  const ids =
    message.to === 'all' ? room.members.map((m) => m.sessionId) : message.to.filter((r) => r !== USER_RECIPIENT);
  return ids.filter((id) => id !== sender);
}

/**
 * Resolve a recipient token an agent or the browser typed: `user`, `all`,
 * `coordinator`, a member's full id, a unique id prefix of 8+ chars, or a member's
 * name (case-insensitive, via `nameOf`). Returns `undefined` when nothing (or
 * more than one member) matches, never a guess.
 */
export function resolveRecipient(
  room: ChatRoom,
  token: string,
  nameOf: (sessionId: string) => string | undefined
): ChatRecipient | 'all' | undefined {
  const t = token.trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  if (lower === 'user' || lower === 'human' || lower === 'me') return USER_RECIPIENT;
  if (lower === 'all' || lower === 'everyone' || lower === 'room') return 'all';
  if (lower === 'coordinator' || lower === 'orchestrator') {
    return room.members.find((m) => m.role === 'coordinator')?.sessionId;
  }
  const exact = room.members.find((m) => m.sessionId === t);
  if (exact) return exact.sessionId;
  const byName = room.members.filter((m) => nameOf(m.sessionId)?.toLowerCase() === lower);
  if (byName.length === 1) return byName[0].sessionId;
  if (byName.length > 1) return undefined;
  if (t.length >= 8) {
    const byPrefix = room.members.filter((m) => m.sessionId.startsWith(t));
    if (byPrefix.length === 1) return byPrefix[0].sessionId;
  }
  return undefined;
}

/**
 * Only a user message may carry an owner mark, and only a known one: a bot, agent, system or
 * external sender (or an unknown value) loses it. Copies, so the caller's object is never changed.
 */
export function senderWithoutForgedMark(from: ChatSender): ChatSender {
  if (!('mark' in from)) return from;
  const { mark, ...rest } = from as ChatSender & { mark?: unknown };
  if (from.kind === 'user' && (mark === 'owner_typed' || mark === 'owner_spoken')) return { ...rest, mark } as ChatSender;
  return rest as ChatSender;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export async function loadChatrooms(file: string): Promise<ChatRoom[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is ChatRoom =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as ChatRoom).id === 'string' &&
        typeof (r as ChatRoom).name === 'string' &&
        Array.isArray((r as ChatRoom).members) &&
        Array.isArray((r as ChatRoom).messages)
    );
  } catch {
    return [];
  }
}

export async function saveChatrooms(file: string, rooms: ChatRoom[]): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rooms), { mode: 0o600 });
  await fs.rename(tmp, file);
}
