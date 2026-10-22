/**
 * In a channel everyone in it reads every message: nothing an agent posts (a message or a poll) is addressed to anyone. A `to` it
 * still sends, one agent, the coordinator or the user, is ignored (not an error) and reported as `toIgnored`. The owner's own
 * targeted messages and a direct message the owner opened are unchanged. This keeps the conversation visible; it is not a security
 * boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const AGENT = (id: string) => ({ 'x-reverie-parent-session': id });

describe('no private messages between agents in a channel', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;

  beforeEach(async () => {
    clock = 1_000_000;
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {}, now: () => clock });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [[A, 'alpha'], [B, 'bravo']] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const room = async () => (await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'Reverie', members: [{ sessionId: A }, { sessionId: B }], coordinatorSessionId: B } })).json().data.id as string;
  const say = (id: string, from: string | undefined, to?: string[]) =>
    app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, headers: from ? AGENT(from) : {}, payload: { text: 'hello', ...(to ? { to } : {}) } });

  it('ignores any `to` an agent sends: the post goes to everyone, and the answer says so', async () => {
    const id = await room();
    for (const to of [['bravo'], [B.slice(0, 8)], ['coordinator'], ['user', 'bravo'], ['user'], ['nobody']]) {
      const res = await say(id, A, to);
      expect(res.statusCode, JSON.stringify(to)).toBe(200);
      expect(res.json().data.message.to, JSON.stringify(to)).toBe('all');
      expect(res.json().data.toIgnored, JSON.stringify(to)).toBe(true);
    }
    // all of them are in the room's feed as ordinary posts to everyone
    const posted = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/messages` })).json().data.messages as Array<{ from: { kind: string }; to: unknown }>;
    expect(posted.filter((m) => m.from.kind === 'agent').every((m) => m.to === 'all')).toBe(true);
  });

  it('takes a post with no `to`, or with the word "all", exactly as before and does not call it ignored', async () => {
    const id = await room();
    for (const to of [undefined, ['all']]) {
      const res = await say(id, A, to);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.toIgnored).toBeUndefined();
      expect(res.json().data.message.to).toBe('all');
    }
  });

  it('wakes the member a whole-room post is for, like any other post to everyone (nothing reaches only the owner)', async () => {
    const id = await room();
    const res = await say(id, A, ['user']);
    expect(res.json().data.message.to).toBe('all');
    expect(res.json().data.message.to).not.toEqual(['user']);
  });

  it('ignores a `to` from the owner too, except a spoken turn, and leaves the owner’s direct message with an agent as it was', async () => {
    const id = await room();
    const owner = await say(id, undefined, ['bravo']);
    expect(owner.statusCode).toBe(200);
    expect(owner.json().data.message.to).toBe('all');
    expect(owner.json().data.toIgnored).toBe(true);
    // a person speaking to the room's voice member is the one aimed message left
    const spoken = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, payload: { text: 'hello there', to: ['bravo'], spoken: true } });
    expect(spoken.statusCode).toBe(200);
    expect(spoken.json().data.message.to).toEqual([B]);
    expect(spoken.json().data.toIgnored).toBeUndefined();
    // an agent can never mark itself as speaking
    const fakeSpoken = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, headers: AGENT(A), payload: { text: 'hi', to: ['bravo'], spoken: true } });
    expect(fakeSpoken.json().data.message.to).toBe('all');
    const dm = (await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } })).json().data;
    const inDm = await say(dm.id, A, ['user']);
    expect(inDm.statusCode).toBe(200);
  });

  it('applies to a poll an agent asks as well: it goes to everyone', async () => {
    const id = await room();
    const ask = (to?: string[]) =>
      app.inject({ method: 'POST', url: `/api/chatrooms/${id}/polls`, headers: AGENT(A), payload: { question: 'Ship?', options: ['Yes', 'No'], ...(to ? { to } : {}) } });
    for (const to of [['bravo'], ['user'], undefined]) {
      const res = await ask(to);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.message.to).toBe('all');
    }
    expect((await ask(['bravo'])).json().data.toIgnored).toBe(true);
    expect((await ask()).json().data.toIgnored).toBeUndefined();
  });
});
