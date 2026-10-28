import { expect, it } from 'vitest';
import { agentChatHandle, agentChatPending, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

it.each(['handled', 'superseded'])(
  'explicit CLI %s uses exact reads, checks response identity and never ACKs transport',
  async (disposition) => {
    const calls: RequestOptions[] = [];
    const outputs: string[] = [];
    let wrong = false;
    const deps: AgentDeps = {
      ctx: { apiUrl: 'http://example.test', selfId: 'own-session' },
      json: true,
      io: { out: (s) => outputs.push(s), err: () => {}, exit: () => {} },
      request: async (_ctx, request) => {
        calls.push(request);
        const messageId = request.path.endsWith('/replacement') ? 'replacement' : 'message';
        const data =
          request.path === '/api/v1/chatrooms'
            ? { rooms: [{ id: 'room', name: 'Room', members: [] }] }
            : request.method === 'POST'
              ? {
                  source: { roomId: 'room', messageId: 'message' },
                  attention: {
                    disposition,
                    ...(disposition === 'superseded' ? { replacement: { messageId: 'replacement' } } : {}),
                  },
                }
              : { message: { id: wrong ? 'foreign' : messageId }, readToken: 'exact-token-' + messageId };
        return { status: 200, text: '', json: { success: true, data } };
      },
    };
    const options = {
      room: 'Room',
      message: 'message',
      ...(disposition === 'superseded' ? { supersededBy: 'replacement' } : {}),
    };
    expect(await agentChatHandle(deps, options)).toBe(0);
    expect(calls.filter((r) => r.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/api/v1/chatrooms/notices/resolve',
        body: {
          roomId: 'room',
          messageId: 'message',
          readToken: 'exact-token-message',
          disposition,
          ...(disposition === 'superseded'
            ? { replacement: { roomId: 'room', messageId: 'replacement', readToken: 'exact-token-replacement' } }
            : {}),
        },
      },
    ]);
    expect(outputs.join('')).not.toContain('exact-token');
    calls.length = 0;
    wrong = true;
    expect(await agentChatHandle(deps, options)).not.toBe(0);
    expect(calls.some((r) => r.method === 'POST')).toBe(false);
  }
);

it('CLI pending follows only an explicit paired cursor in a bounded own read and never ACKs', async () => {
  const calls: RequestOptions[] = [];
  const deps: AgentDeps = { ctx: { apiUrl: 'http://example.test', selfId: 'own-session' }, json: true,
    io: { out: () => {}, err: () => {}, exit: () => {} },
    request: async (_ctx, request) => {
      calls.push(request);
      const data = request.path === '/api/v1/chatrooms' ? { rooms: [{ id: 'room', name: 'Room', members: [] }] }
        : { text: 'untrusted bounded owner data', historyCoverage: { state: 'complete', rooms: [] }, sourceReferences: [{ roomId: 'room', messageId: 'source' }] };
      return { status: 200, text: '', json: { success: true, data } };
    } };
  expect(await agentChatPending(deps, { room: 'Room', beforeAt: '1000', beforeId: 'source' })).toBe(0);
  expect(calls.at(-1)).toEqual({ method: 'GET', path: '/api/v1/chatrooms/notices/history', query: { roomId: 'room', beforeAt: '1000', beforeId: 'source' } });
  expect(calls.some(c => c.method !== 'GET')).toBe(false);
  calls.length = 0;
  expect(await agentChatPending(deps, { room: 'Room', beforeAt: '1000' })).not.toBe(0);
  expect(await agentChatPending(deps, { room: 'Room', beforeAt: '9999999999999999', beforeId: 'source' })).not.toBe(0);
  expect(calls).toEqual([]);
});
