/**
 * @fileoverview The pure mention feed (`src/chatroom-mentions.ts`): why a message is in it, the cross-room merge, cursor
 * paging, and the horizon a capped room imposes so nothing is skipped.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMentionFeed,
  decodeMentionCursor,
  encodeMentionCursor,
  mentionReasons,
  type MentionRoomScan,
} from '../src/chatroom-mentions.js';
import type { ChatMessage } from '../src/chatroom-store.js';

const ME = { sessionId: 'me-0000-0001', name: 'Reviewer' };
const PEER = { kind: 'agent', sessionId: 'peer-0000-0002', name: 'Peer' } as const;

const msg = (id: string, at: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, roomId: 'r', at, to: 'all', text, from: PEER, ...extra }) as ChatMessage;
const room = (id: string, messages: ChatMessage[], capped = false): MentionRoomScan => ({
  id,
  name: id,
  messages,
  capped,
});
const start = { at: 0, id: '' };

describe('mentionReasons', () => {
  it('names each reason a message is in the feed', () => {
    expect(mentionReasons(msg('a', 1, '@Reviewer look'), ME, false)).toEqual(['mention']);
    expect(mentionReasons(msg('a', 1, 'look', { to: [ME.sessionId] }), ME, false)).toEqual(['addressed']);
    expect(mentionReasons(msg('a', 1, '@everyone standup'), ME, false)).toEqual(['everyone']);
    expect(mentionReasons(msg('a', 1, 'HOLD on the branch'), ME, true)).toEqual(['hold']);
    expect(mentionReasons(msg('a', 1, 'NO-GO on that'), ME, true)).toEqual(['hold']);
  });

  it('leaves out plain room posts, holds unless asked, the caller’s own posts and deleted messages', () => {
    expect(mentionReasons(msg('a', 1, 'general update'), ME, true)).toEqual([]);
    expect(mentionReasons(msg('a', 1, 'HOLD on the branch'), ME, false)).toEqual([]);
    expect(
      mentionReasons(
        msg('a', 1, '@Reviewer', { from: { kind: 'agent', sessionId: ME.sessionId, name: 'Reviewer' } }),
        ME,
        true
      )
    ).toEqual([]);
    expect(mentionReasons(msg('a', 1, '@Reviewer', { deleted: { at: 2, by: 'user' } }), ME, true)).toEqual([]);
    // A mention is a whole @name, not a prefix of a longer one.
    expect(mentionReasons(msg('a', 1, '@Reviewers all'), ME, false)).toEqual([]);
  });
});

describe('buildMentionFeed', () => {
  it('merges rooms in time order and continues after everything scanned', () => {
    const feed = buildMentionFeed(
      [
        room('A', [msg('a1', 10, '@Reviewer one'), msg('a2', 30, 'noise')]),
        room('B', [msg('b1', 20, '@Reviewer two')]),
      ],
      ME,
      { cursor: start, limit: 10, holds: false }
    );
    expect(feed.items.map((i) => [i.room, i.messageId, i.reasons])).toEqual([
      ['A', 'a1', ['mention']],
      ['B', 'b1', ['mention']],
    ]);
    // The cursor moves past the unmatched a2 too, so the next call does not rescan it.
    expect(feed).toMatchObject({ next: { at: 30, id: 'a2' }, complete: true });
  });

  it('pages by limit without losing or repeating items', () => {
    const messages = [1, 2, 3, 4, 5].map((n) => msg(`m${n}`, n, `@Reviewer ${n}`));
    const first = buildMentionFeed([room('A', messages)], ME, { cursor: start, limit: 2, holds: false });
    expect(first.items.map((i) => i.messageId)).toEqual(['m1', 'm2']);
    expect(first.complete).toBe(false);
    const rest = messages.filter((m) => m.at > first.next!.at || (m.at === first.next!.at && m.id > first.next!.id));
    const second = buildMentionFeed([room('A', rest)], ME, { cursor: first.next!, limit: 10, holds: false });
    expect(second.items.map((i) => i.messageId)).toEqual(['m3', 'm4', 'm5']);
    expect(second.complete).toBe(true);
  });

  it('stops at a capped room’s last scanned message so a quieter room cannot skip ahead of it', () => {
    const busy = room('Busy', [msg('x1', 10, '@Reviewer a'), msg('x2', 20, 'noise')], true);
    const quiet = room('Quiet', [msg('q1', 15, '@Reviewer b'), msg('q2', 40, '@Reviewer c')]);
    const feed = buildMentionFeed([busy, quiet], ME, { cursor: start, limit: 10, holds: false });
    expect(feed.items.map((i) => i.messageId)).toEqual(['x1', 'q1']);
    expect(feed).toMatchObject({ next: { at: 20, id: 'x2' }, complete: false });
  });

  it('caps excerpts', () => {
    const feed = buildMentionFeed([room('A', [msg('a', 1, `@Reviewer ${'x'.repeat(1000)}`)])], ME, {
      cursor: start,
      limit: 1,
      holds: false,
    });
    expect(feed.items[0].excerpt.length).toBe(240);
  });
});

describe('mention cursors', () => {
  it('round-trips and rejects anything else', () => {
    const cursor = { at: 1793682436684, id: 'ee54a134-6ff7-4eef-abfa-a3db581637b4' };
    expect(decodeMentionCursor(encodeMentionCursor(cursor))).toEqual(cursor);
    for (const bad of ['', 'm1.', 'm2.1.YQ', 'm1.x.YQ', 'm1.1.***'])
      expect(decodeMentionCursor(bad), bad).toBeUndefined();
  });
});
