/**
 * Heads-ups the post route hands back with a message that was posted anyway (never a refusal). Every front end (the CLI, MCP, the
 * page) shows the same list, so the check lives here and not in any one of them.
 */
import type { ChatMessage, ChatRoom } from './chatroom-store.js';
import { roomLabel } from './chatroom-delivery.js';
import { textMentions } from './chatroom-store.js';

export interface PostWarning {
  /** What kind of heads-up this is, for a front end that wants to treat one differently. */
  code: 'stray-mention' | 'retired-mention' | 'newer-unread';
  /** The line to show, ready to print. */
  text: string;
  /** The @names it is about (without the @), or who wrote the newer messages. */
  names: string[];
}

/** Words that name the whole room or its owner, so an @ to them is never a stray one. */
const MENTION_ALWAYS_OK = ['everyone', 'user', 'owner'];
/** Old synonyms of `@everyone` (Owner 10-21: one room-wide word). They are plain text now; the writer is told so. */
const RETIRED_ROOM_WORDS = ['all', 'here'];

/**
 * The @names in `text` that no member of the room goes by (case-insensitive; `@everyone`, `@user`, `@owner` and the
 * owner's own names are always fine; `@all` and `@here` get their own heads-up). Not inside a word or an address (a@b), same as how the room reads a mention.
 */
export function strayMentions(text: string, memberNames: readonly string[], ownerNames: readonly string[] = []): string[] {
  const known = new Set([...memberNames, ...ownerNames, ...MENTION_ALWAYS_OK, ...RETIRED_ROOM_WORDS].map((n) => n.trim().toLowerCase()));
  const stray = new Map<string, string>();
  for (const found of text.matchAll(/(^|[^\w@])@([A-Za-z][\w-]*)/g)) {
    const name = found[2].replace(/-+$/, '');
    const key = name.toLowerCase();
    if (!key || known.has(key) || stray.has(key)) continue;
    stray.set(key, name);
  }
  return [...stray.values()];
}

/**
 * Messages from others that arrived in the room after the last one `selfId` saw (`seen`: a delivered-and-submitted prompt or a read,
 * the server's own record). Nothing is said when the server has no record. The marker message's place in the window decides; if it is
 * no longer there (trimmed or removed), its time does, so older messages are never counted. Own posts, system lines and deleted
 * messages never count, and neither does anything outside this room.
 */
export function newerUnread(
  messages: readonly Pick<ChatMessage, 'id' | 'at' | 'from' | 'deleted'>[],
  selfId: string,
  seen: { messageId: string; at: number } | undefined,
  ownerName?: string
): { count: number; names: string[] } | null {
  if (!seen) return null;
  const index = messages.findIndex((m) => m.id === seen.messageId);
  const later = index >= 0 ? messages.slice(index + 1) : messages.filter((m) => m.at > seen.at);
  const names = new Set<string>();
  let count = 0;
  for (const m of later) {
    if (m.deleted || m.from.kind === 'system') continue;
    if (m.from.kind === 'agent' && m.from.sessionId === selfId) continue;
    count++;
    // The owner's posts are stored as plain "user"; say what the room calls them.
    names.add(m.from.kind === 'user' && ownerName ? ownerName : m.from.name);
  }
  return count ? { count, names: [...names] } : null;
}

/** The heads-ups for a message just posted to `room` by someone who is not its author's concern: @names nobody in the room goes by. */
export function postWarnings(
  room: Pick<ChatRoom, 'name' | 'kind' | 'dm'>,
  text: string,
  memberNames: readonly string[],
  ownerNames: readonly string[] = [],
  unread: { count: number; names: string[] } | null = null
): PostWarning[] {
  const warnings: PostWarning[] = [];
  const taken = new Set([...memberNames, ...ownerNames].map((n) => n.trim().toLowerCase()));
  const retired = RETIRED_ROOM_WORDS.filter((n) => !taken.has(n) && textMentions(text, n));
  if (retired.length) {
    warnings.push({
      code: 'retired-mention',
      names: retired,
      text: `${retired.map((n) => `@${n}`).join(' and ')} no longer ${retired.length === 1 ? 'notifies' : 'notify'} anyone; use @everyone to reach the whole room`,
    });
  }
  const stray = strayMentions(text, memberNames, ownerNames);
  if (stray.length) {
    const one = stray.length === 1;
    warnings.push({
      code: 'stray-mention',
      names: stray,
      text: `${stray.map((n) => `@${n}`).join(', ')} ${one ? 'is' : 'are'} not in "${roomLabel(room as { name: string; kind?: 'dm'; dm?: string[] })}", so they will not see this; ask a coordinator to add them, or post where they are`,
    });
  }
  if (unread) {
    const n = unread.count;
    warnings.push({
      code: 'newer-unread',
      names: unread.names,
      text: `${n} newer message${n === 1 ? '' : 's'} from ${unread.names.join(', ')} in "${roomLabel(room as { name: string; kind?: 'dm'; dm?: string[] })}" came in before this was posted; run: reverie agent chat read`,
    });
  }
  return warnings;
}
