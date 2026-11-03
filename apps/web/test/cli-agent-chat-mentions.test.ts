/**
 * `reverie agent chat mentions`: the query it sends (room resolved to an id, --since as a cursor or a time, --holds,
 * --limit), quoted output with the next cursor, and refusing a bad --since before any request.
 */
import { describe, expect, it } from 'vitest';
import { agentChatMentions, EXIT, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

function deps(json = false, data: unknown = undefined) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: '0000002d-0035-4000-8000-000000000047' },
    json,
    io: { out: (m: string) => void out.push(m), err: (m: string) => void err.push(m) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.path === '/api/v1/chatrooms')
        return {
          status: 200,
          text: '',
          json: { success: true, data: { rooms: [{ id: 'room-1', name: 'Reverie', members: [] }] } },
        };
      return {
        status: 200,
        text: '',
        json: {
          success: true,
          data: data ?? {
            items: [
              {
                room: 'Reverie',
                messageId: 'abcdef0123',
                at: 0,
                from: 'Peer',
                reasons: ['mention'],
                excerpt: '@Reviewer "look"\nnow',
              },
            ],
            next: 'm1.5.YQ',
            complete: true,
            source: 'database',
            timeZone: 'UTC',
          },
        },
      };
    },
  };
  return { d, calls, out, err };
}

describe('agent chat mentions', () => {
  it('sends the room id, since, holds and limit, and prints quoted lines with the next cursor', async () => {
    const { d, calls, out } = deps();
    expect(await agentChatMentions(d, { room: 'Reverie', since: 'm1.4.YQ', holds: true, limit: 20 })).toBe(EXIT.ok);
    expect(calls.at(-1)).toMatchObject({
      method: 'GET',
      path: '/api/v1/chatrooms/mentions',
      query: { roomId: 'room-1', since: 'm1.4.YQ', holds: '1', limit: '20' },
    });
    // The excerpt is quoted, so its newline and quotes cannot start a new line or pose as another speaker.
    expect(out[0]).toContain('"Peer" [mention] abcdef01: "@Reviewer \\"look\\"\\nnow"');
    expect(out.at(-1)).toBe('next: --since m1.5.YQ');
  });

  it('turns an ISO time into epoch ms and defaults to all rooms', async () => {
    const { d, calls } = deps();
    expect(await agentChatMentions(d, { since: '2026-11-03T00:00:00-05:00' })).toBe(EXIT.ok);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toEqual({ since: String(Date.parse('2026-11-03T05:00:00Z')), limit: '50', holds: '0' });
  });

  it('says when there is more to read, and when nothing is new', async () => {
    const { d, out } = deps(false, {
      items: [],
      next: 'm1.9.YQ',
      complete: false,
      source: 'recent-only',
      timeZone: 'UTC',
    });
    expect(await agentChatMentions(d, {})).toBe(EXIT.ok);
    expect(out).toEqual(['No new mentions.', 'more after: --since m1.9.YQ (recent window only: no chat database)']);
  });

  it('refuses a malformed --since before sending anything', async () => {
    const { d, calls, err } = deps();
    expect(await agentChatMentions(d, { since: 'yesterday' })).toBe(EXIT.error);
    expect(calls).toHaveLength(0);
    expect(err.join('\n')).toContain('--since');
  });
});
