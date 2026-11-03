/**
 * @fileoverview The mention feed behind `reverie agent chat mentions`: every message across the caller's rooms that
 * @-mentions it, addresses it by name, says @everyone, or (on request) uses hold wording, paged forward by a stable
 * (at, id) cursor. Nothing here expires: the feed reaches as far back as the room history kept on disk.
 *
 * Pure: the service hands in each visible room's messages after the cursor, already capped, and says which rooms hit
 * their cap. Reading the feed never moves a seen mark, acknowledges delivery or resolves attention.
 */
import { textMentions, type ChatMessage } from './chatroom-store.js';

export interface MentionCursor {
  at: number;
  id: string;
}

export type MentionReason = 'mention' | 'addressed' | 'everyone' | 'hold';

export interface MentionItem {
  roomId: string;
  room: string;
  messageId: string;
  at: number;
  from: string;
  fromKind: string;
  reasons: MentionReason[];
  /** Untrusted text: callers quote it before showing it. */
  excerpt: string;
}

export interface MentionRoomScan {
  id: string;
  name: string;
  /** Messages after the cursor, oldest first. */
  messages: ChatMessage[];
  /** True when `messages` stops at the scan cap, so later messages in this room are still unread by the feed. */
  capped: boolean;
}

export interface MentionFeed {
  items: MentionItem[];
  /** Pass back as the next cursor; absent only when the feed returned nothing new. */
  next?: MentionCursor;
  /** False when more matching messages may follow `next` (the limit or a room's scan cap was reached). */
  complete: boolean;
}

export const MENTION_EXCERPT = 240;

/** Hold wording, as reviewers use it. Broad on purpose: a coordinator would rather see a stray "hold" than miss one. */
const HOLD_WORDING = /\b(hold|holds|holding|blocker|blocked|do not merge|don't merge)\b|\bNO[- ]GO\b/i;

const after = (m: { at: number; id: string }, c: MentionCursor) => m.at > c.at || (m.at === c.at && m.id > c.id);
const order = (a: { at: number; id: string }, b: { at: number; id: string }) =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Why `message` is in the caller's feed, or an empty list when it is not. */
export function mentionReasons(
  message: ChatMessage,
  me: { sessionId: string; name: string },
  holds: boolean
): MentionReason[] {
  if (message.deleted || (message.from.kind === 'agent' && message.from.sessionId === me.sessionId)) return [];
  const reasons: MentionReason[] = [];
  if (me.name && textMentions(message.text, me.name)) reasons.push('mention');
  if (message.to !== 'all' && message.to.includes(me.sessionId)) reasons.push('addressed');
  if (textMentions(message.text, 'everyone')) reasons.push('everyone');
  if (holds && HOLD_WORDING.test(message.text ?? '')) reasons.push('hold');
  return reasons;
}

/**
 * Merge the rooms into one feed after `cursor`. When a room stopped at its scan cap, nothing later than the last message
 * scanned there can be returned yet (that room's next messages could come first), so the feed ends at that horizon and
 * the next call continues from it.
 */
export function buildMentionFeed(
  rooms: MentionRoomScan[],
  me: { sessionId: string; name: string },
  options: { cursor: MentionCursor; limit: number; holds: boolean }
): MentionFeed {
  let horizon: MentionCursor | undefined;
  let latest: MentionCursor | undefined;
  for (const room of rooms) {
    const last = room.messages[room.messages.length - 1];
    if (last && (!latest || order(last, latest) > 0)) latest = { at: last.at, id: last.id };
  }
  for (const room of rooms) {
    if (!room.capped || !room.messages.length) continue;
    const last = room.messages[room.messages.length - 1];
    if (!horizon || order(last, horizon) < 0) horizon = { at: last.at, id: last.id };
  }
  const matched: Array<MentionItem & { id: string }> = [];
  for (const room of rooms)
    for (const message of room.messages) {
      if (!after(message, options.cursor) || (horizon && order(message, horizon) > 0)) continue;
      const reasons = mentionReasons(message, me, options.holds);
      if (!reasons.length) continue;
      matched.push({
        id: message.id,
        roomId: room.id,
        room: room.name,
        messageId: message.id,
        at: message.at,
        from: message.from.name,
        fromKind: message.from.kind,
        reasons,
        excerpt: (message.text ?? '').slice(0, MENTION_EXCERPT),
      });
    }
  matched.sort(order);
  const items = matched.slice(0, options.limit).map(({ id: _id, ...item }) => item);
  const truncated = matched.length > options.limit;
  const lastItem = items[items.length - 1];
  // Continue after the last item returned when the limit cut the list; otherwise after everything scanned.
  const next = truncated ? { at: lastItem.at, id: lastItem.messageId } : (horizon ?? latest);
  return { items, ...(next ? { next } : {}), complete: !truncated && !horizon };
}

/** `m1.<at>.<id>`: printable, and safe to pass back on a command line. */
export function encodeMentionCursor(cursor: MentionCursor): string {
  return `m1.${cursor.at}.${Buffer.from(cursor.id, 'utf8').toString('base64url')}`;
}

export function decodeMentionCursor(token: string): MentionCursor | undefined {
  const match = /^m1\.(\d{1,16})\.([A-Za-z0-9_-]{0,400})$/.exec(token);
  if (!match) return undefined;
  return { at: Number(match[1]), id: Buffer.from(match[2], 'base64url').toString('utf8') };
}
