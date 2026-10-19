/**
 * `reverie agent chat poll close ROOM:ID`: the room comes from the ref (or --room), the id prefix finds the poll, and the close
 * is one POST to that poll.
 */
import { describe, expect, it } from 'vitest';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';
import { agentChatPollClose, parsePollRef } from '../src/cli-agent.js';

const ROOM = '08dfd0fa-1111-4000-8000-000000000001';
const POLL = 'abcdef12-0000-4000-8000-000000000009';

function fake() {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://x', selfId: 'self' },
    json: false,
    io: { out: (l) => out.push(l), err: (l) => out.push(l) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.path === '/api/v1/chatrooms') return { status: 200, text: '', json: { success: true, data: { rooms: [{ id: ROOM, name: 'host requests', dm: [] }] } } };
      if (options.path.endsWith('/messages')) {
        const poll = { question: 'q', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }], votes: { user: ['o1'] } };
        return { status: 200, text: '', json: { success: true, data: { messages: [{ id: POLL, at: 1, from: { kind: 'agent', sessionId: 'self', name: 'Otto' }, text: 'q', poll }], members: [] } } };
      }
      const poll = { question: 'q', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }], votes: { user: ['o1'] }, closed: { at: 2, by: 'self' } };
      return { status: 200, text: '', json: { success: true, data: { poll } } };
    },
  };
  return { deps, calls, out };
}

describe('reverie agent chat poll close', () => {
  it('parses ROOM:ID (a room name may hold spaces), and ID with --room', () => {
    expect(parsePollRef('host requests:abcdef12')).toEqual({ room: 'host requests', id: 'abcdef12' });
    expect(parsePollRef('abcdef12', 'reverie')).toEqual({ room: 'reverie', id: 'abcdef12' });
  });

  it('closes the poll the prefix names in the named room', async () => {
    const { deps, calls, out } = fake();
    expect(await agentChatPollClose(deps, { ref: 'host requests:abcdef' })).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/chatrooms/${ROOM}/messages/${POLL}/poll/close` });
    expect(out.join('\n')).toContain('closed poll abcdef12 in "host requests"');
  });

  it('refuses a short id before writing', async () => {
    const { deps, calls } = fake();
    expect(await agentChatPollClose(deps, { ref: 'host requests:abc' })).not.toBe(0);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
