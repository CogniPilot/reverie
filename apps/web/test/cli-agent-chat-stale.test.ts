/**
 * `reverie agent chat handle --stale [--owner]` and `chat pending --stale`: owner notices are only ever set aside as
 * stale, never bulk-handled, and only with a --before at least 72 hours back; refusals happen before any request.
 */
import { describe, expect, it } from 'vitest';
import {
  agentChatHandle,
  agentChatHandleBefore,
  agentChatPending,
  EXIT,
  type AgentDeps,
  type RequestOptions,
} from '../src/cli-agent.js';

const NOW = Date.parse('2026-11-03T05:00:00Z');
const HOUR = 60 * 60 * 1000;

function deps() {
  const calls: RequestOptions[] = [];
  const err: string[] = [];
  const out: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: '0000002d-0035-4000-8000-000000000047' },
    json: false,
    now: () => NOW,
    io: { out: (m: string) => void out.push(m), err: (m: string) => void err.push(m) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.path === '/api/v1/chatrooms')
        return {
          status: 200,
          text: '',
          json: { success: true, data: { rooms: [{ id: 'room-1', name: 'Reverie', members: [] }] } },
        };
      if (options.path.endsWith('/pending-before'))
        return {
          status: 200,
          text: '',
          json: { success: true, data: { sourceReferences: [{ roomId: 'room-1', messageId: 'm1' }] } },
        };
      if (options.path.includes('/messages/'))
        return {
          status: 200,
          text: '',
          json: { success: true, data: { message: { id: 'm1' }, readToken: '00000000-0000-4000-8000-000000000001' } },
        };
      if (options.path.endsWith('/notices/resolve'))
        return {
          status: 200,
          text: '',
          json: {
            success: true,
            data: {
              source: { roomId: 'room-1', messageId: 'm1' },
              attention: { disposition: (options.body as { disposition: string }).disposition },
            },
          },
        };
      return {
        status: 200,
        text: '',
        json: { success: true, data: { text: '', historyCoverage: {}, sourceReferences: [] } },
      };
    },
  };
  return { d, calls, err, out };
}

describe('chat handle --stale', () => {
  it('sends the stale disposition for one notice', async () => {
    const { d, calls, out } = deps();
    expect(await agentChatHandle(d, { room: 'Reverie', message: 'm1', stale: true })).toBe(EXIT.ok);
    expect(calls.at(-1)!.body).toMatchObject({ messageId: 'm1', disposition: 'stale' });
    expect(out.at(-1)).toBe('Notice m1 stale. Delivery and task state unchanged.');
  });

  it('refuses --owner without --stale, and --owner with a --before under 72 hours, before any request', async () => {
    for (const options of [
      { room: 'Reverie', before: String(NOW - 100 * HOUR), owner: true },
      { room: 'Reverie', before: String(NOW - 71 * HOUR), owner: true, stale: true },
    ]) {
      const { d, calls, err } = deps();
      expect(await agentChatHandleBefore(d, options)).toBe(EXIT.error);
      expect(calls).toHaveLength(0);
      expect(err.join('\n')).toMatch(/--owner/);
    }
  });

  it('asks for human notices and sets each aside as stale', async () => {
    const { d, calls, out } = deps();
    expect(
      await agentChatHandleBefore(d, { room: 'Reverie', before: String(NOW - 100 * HOUR), owner: true, stale: true })
    ).toBe(EXIT.ok);
    expect(calls.find((c) => c.path.endsWith('/pending-before'))!.query).toMatchObject({ humans: '1' });
    expect(
      calls
        .filter((c) => c.path.endsWith('/notices/resolve'))
        .map((c) => (c.body as { disposition: string }).disposition)
    ).toEqual(['stale']);
    expect(out.at(-1)).toMatch(/^Set aside 1 of 1 pending notices before .* as stale\. Not handled: /);
  });

  it('lists stale notices with chat pending --stale', async () => {
    const { d, calls } = deps();
    expect(await agentChatPending(d, { room: 'Reverie', stale: true })).toBe(EXIT.ok);
    expect(calls.at(-1)!.query).toMatchObject({ roomId: 'room-1', stale: '1' });
  });
});
