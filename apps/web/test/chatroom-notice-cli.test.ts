import { expect, it } from 'vitest';
import { agentChatHandle, agentChatHandleBefore, agentChatPending, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

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

it('bulk handle --before lists own pending agent/bot notices and resolves each with its own exact read', async () => {
  const calls: RequestOptions[] = [];
  const outputs: string[] = [];
  let listRoom = 'room';
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://example.test', selfId: 'own-session' },
    json: true,
    now: () => 2_000_000_000_000,
    io: { out: (s) => outputs.push(s), err: () => {}, exit: () => {} },
    request: async (_ctx, request) => {
      calls.push(request);
      const id = request.path.split('/').pop()!;
      const data =
        request.path === '/api/v1/chatrooms'
          ? { rooms: [{ id: 'room', name: 'Room', members: [] }] }
          : request.path === '/api/v1/chatrooms/notices/pending-before'
            ? { sourceReferences: [{ roomId: listRoom, messageId: 'one' }, { roomId: listRoom, messageId: 'two' }] }
            : request.method === 'POST'
              ? { source: { roomId: 'room', messageId: (request.body as { messageId: string }).messageId }, attention: { disposition: 'handled' } }
              : { message: { id }, readToken: 'exact-token-' + id };
      return { status: 200, text: '', json: { success: true, data } };
    },
  };
  expect(await agentChatHandleBefore(deps, { room: 'Room', before: '2026-10-27T00:00:00Z' })).toBe(0);
  expect(calls.find((r) => r.path.endsWith('/pending-before'))?.query).toEqual({ roomId: 'room', before: String(Date.parse('2026-10-27T00:00:00Z')) });
  expect(calls.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
    { roomId: 'room', messageId: 'one', readToken: 'exact-token-one', disposition: 'handled' },
    { roomId: 'room', messageId: 'two', readToken: 'exact-token-two', disposition: 'handled' },
  ]);
  expect(JSON.parse(outputs.at(-1)!)).toMatchObject({ roomId: 'room', handled: ['one', 'two'], failed: [] });

  calls.length = 0;
  expect(await agentChatHandleBefore(deps, { room: 'Room', before: String(2_000_000_000_001) })).not.toBe(0); // future
  expect(await agentChatHandleBefore(deps, { before: '1700000000000' })).not.toBe(0); // no explicit room
  expect(await agentChatHandleBefore(deps, { room: 'Room', before: '2026-10-27 00:00' })).not.toBe(0); // no offset
  listRoom = 'other';
  expect(await agentChatHandleBefore(deps, { room: 'Room', before: '1700000000000' })).not.toBe(0); // foreign listing
  expect(calls.some((r) => r.method === 'POST')).toBe(false);
});
