import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
/**
 * The opt-in crossing guard on `POST /api/chatrooms/:id/messages`: with `ifNoNewerThan` (a message id) or `ifLatest`
 * (this session's own read mark) the post is refused with 409 and the newer messages when someone else posted after
 * that point, so a reply written against a stale view is reread instead of crossing. Without either field nothing
 * changes. The writer's own posts, system lines and deleted messages never block.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/index.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const MISSING = '00000009-0009-4000-8000-000000000009';

describe('chat post crossing guard', () => {
  let app: FastifyInstance;
  let service: ChatroomService;
  let clock: number;

  beforeEach(async () => {
    clock = 1_000;
    const file = join(mkdtempSync(join(tmpdir(), 'chat-if-latest-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file,
        getSession: (id) => c.sessions.get(id),
        broadcast: () => undefined,
        now: () => clock,
        ownerNames: (owner) => (owner === undefined ? ['Pat'] : []),
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))), trustedFixtureOwner);
    });
    app = harness.app;
    for (const [id, name] of [
      [A, 'alpha'],
      [B, 'bravo'],
    ] as const) {
      const s = createMockSession(id);
      s.name = name;
      harness.ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  async function makeRoom(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Reverie', members: [{ sessionId: A }, { sessionId: B }] },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data.id as string;
  }
  const say = (id: string, from: string | undefined, payload: Record<string, unknown>) => {
    clock += 10;
    return app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      ...(from ? { headers: { 'x-reverie-parent-session': from } } : {}),
      payload,
    });
  };
  const post = async (id: string, from: string | undefined, text: string) => {
    const res = await say(id, from, { text });
    expect(res.statusCode).toBe(200);
    return res.json().data.message.id as string;
  };
  const texts = (id: string) => service.room(id)!.messages.filter((m) => m.from.kind !== 'system').map((m) => m.text);

  it('posts as before without the fields, however much arrived', async () => {
    const id = await makeRoom();
    await post(id, A, 'one');
    await post(id, B, 'two');
    const res = await say(id, A, { text: 'three' });
    expect(res.statusCode).toBe(200);
    expect(texts(id)).toEqual(['one', 'two', 'three']);
  });

  it('posts when nothing arrived after the given message', async () => {
    const id = await makeRoom();
    const last = await post(id, B, 'question');
    const res = await say(id, A, { text: 'answer', ifNoNewerThan: last });
    expect(res.statusCode).toBe(200);
    expect(texts(id)).toEqual(['question', 'answer']);
  });

  it('refuses with the newer messages, and stores nothing, when someone else posted after it', async () => {
    const id = await makeRoom();
    const read = await post(id, B, 'question');
    const late = await post(id, B, 'never mind, already fixed');
    const res = await say(id, A, { text: 'stale answer', ifNoNewerThan: read });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ success: false, errorCode: 'CHAT_NEWER_MESSAGES' });
    expect(body.error).toContain('1 newer message arrived');
    expect(body.data).toEqual({ newer: [{ id: late, from: 'bravo', at: expect.any(Number), excerpt: 'never mind, already fixed' }], more: false });
    expect(texts(id)).toEqual(['question', 'never mind, already fixed']);
  });

  it('shows the newest five and says there are more', async () => {
    const id = await makeRoom();
    const read = await post(id, B, 'start');
    for (let i = 1; i <= 7; i++) await post(id, B, `m${i}`);
    const res = await say(id, A, { text: 'late', ifNoNewerThan: read });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('7 newer messages');
    expect(res.json().data.newer.map((m: { excerpt: string }) => m.excerpt)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    expect(res.json().data.more).toBe(true);
  });

  it("ignores the writer's own posts, system lines and deleted messages", async () => {
    const id = await makeRoom();
    const read = await post(id, B, 'question');
    await post(id, A, 'part one');
    const gone = await post(id, B, 'oops');
    expect((await app.inject({ method: 'DELETE', url: `/api/chatrooms/${id}/messages/${gone}` })).statusCode).toBe(200);
    service.room(id)!.messages.push({ id: 'sys-1', at: clock + 1, from: { kind: 'system', name: 'system' }, text: 'bravo joined', to: 'all' } as never);
    const res = await say(id, A, { text: 'part two', ifNoNewerThan: read });
    expect(res.statusCode).toBe(200);
  });

  it('the owner is one writer too: their own earlier post does not block them', async () => {
    const id = await makeRoom();
    const read = await post(id, A, 'status?');
    await post(id, undefined, 'looking');
    expect((await say(id, undefined, { text: 'done', ifNoNewerThan: read })).statusCode).toBe(200);
    await post(id, A, 'thanks');
    expect((await say(id, undefined, { text: 'one more', ifNoNewerThan: read })).statusCode).toBe(409);
  });

  it('refuses an id that is not in the room', async () => {
    const id = await makeRoom();
    await post(id, B, 'question');
    const res = await say(id, A, { text: 'answer', ifNoNewerThan: MISSING });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'CHAT_NEWER_MESSAGES', data: { newer: [], more: false } });
    expect(res.json().error).toContain('not in this room');
  });

  it('ifLatest uses the read mark the server keeps for this session', async () => {
    const id = await makeRoom();
    const first = await post(id, B, 'question');
    service.markSeen(A, id, first);
    expect((await say(id, A, { text: 'answer', ifLatest: true })).statusCode).toBe(200);
    await post(id, B, 'follow-up');
    const res = await say(id, A, { text: 'crossing', ifLatest: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().data.newer.map((m: { excerpt: string }) => m.excerpt)).toEqual(['follow-up']);
  });

  it('ifLatest without a read mark is refused, not posted', async () => {
    const id = await makeRoom();
    await post(id, B, 'question');
    const agent = await say(id, A, { text: 'answer', ifLatest: true });
    expect(agent.statusCode).toBe(409);
    expect(agent.json().errorCode).toBe('CHAT_NO_READ_MARK');
    const owner = await say(id, undefined, { text: 'answer', ifLatest: true });
    expect(owner.statusCode).toBe(409);
    expect(owner.json().errorCode).toBe('CHAT_NO_READ_MARK');
    expect(texts(id)).toEqual(['question']);
  });

  it('rejects both fields together and a malformed id', async () => {
    const id = await makeRoom();
    const read = await post(id, B, 'question');
    expect((await say(id, A, { text: 'x', ifNoNewerThan: read, ifLatest: true })).statusCode).toBe(400);
    expect((await say(id, A, { text: 'x', ifNoNewerThan: 'm-12' })).statusCode).toBe(400);
    expect((await say(id, A, { text: 'x', ifLatest: false })).statusCode).toBe(400);
    expect(texts(id)).toEqual(['question']);
  });
});
