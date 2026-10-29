import { describe, expect, it } from 'vitest';
import { agentChatRead, type AgentDeps } from '../src/cli-agent.js';

const sid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
const mid = '33333333-3333-4333-8333-333333333333';
const fid = '44444444-4444-4444-8444-444444444444';
const path = '/tmp/.reverie-chat-images/55555555-5555-4555-8555-555555555555.png';
const message = {
  id: mid,
  at: 0,
  from: { kind: 'user', name: 'owner' },
  to: 'all',
  text: '',
  attachments: [{ id: fid, name: 'chart.png', type: 'image/png', size: 12, path: '/private/server/chart.png' }],
};

function fixture(json = false, ready = true) {
  const calls: string[] = [];
  const out: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://localhost', selfId: sid },
    json,
    io: { out: (text) => out.push(text), err: () => {} },
    request: async (_ctx, opts) => {
      calls.push(opts.method + ' ' + opts.path);
      const data =
        opts.path === '/api/v1/chatrooms'
          ? { rooms: [{ id: rid, name: 'room', members: [] }] }
          : opts.path.endsWith('/image-paths')
            ? ready
              ? { status: 'ready', files: [{ fileId: fid, path, bytes: 12, expiresInSeconds: 1800 }] }
              : { status: 'unavailable' }
            : opts.path.endsWith('/' + mid)
              ? { message: structuredClone(message), readToken: 'read-token' }
              : { messages: [structuredClone(message)], members: [] };
      return { status: 200, text: '', json: { success: true, data } };
    },
  };
  return { deps, calls, out };
}

describe('ordinary agent chat reads expose local images by default', () => {
  it.each([false, true])('recent read json=%s requests images without an opt-in flag', async (json) => {
    const f = fixture(json);
    expect(await agentChatRead(f.deps, { limit: 20 })).toBe(0);
    expect(f.calls.at(-1)).toBe(`POST /api/v1/chatrooms/${rid}/messages/${mid}/image-paths`);
    expect(f.out.join('\n')).toContain(path);
    expect(f.out.join('\n')).not.toContain('/private/server');
    expect(f.calls.some((call) => call.includes('read-ack'))).toBe(false);
  });
  it('an exact read creates a fresh path without acknowledging it implicitly', async () => {
    const f = fixture();
    expect(await agentChatRead(f.deps, { limit: 20, message: mid })).toBe(0);
    expect(f.out.join('\n')).toContain(path);
    expect(f.calls.some((call) => call.includes('read-ack'))).toBe(false);
  });
  it.each([false, true])(
    'unavailable copies retain readable text but never advertise a server path json=%s',
    async (json) => {
      const f = fixture(json, false);
      expect(await agentChatRead(f.deps, { limit: 20 })).toBe(0);
      expect(f.out.join('\n')).not.toContain('/private/server');
      expect(f.out.join('\n')).toContain(json ? 'unavailable' : 'local image unavailable');
    }
  );
});
