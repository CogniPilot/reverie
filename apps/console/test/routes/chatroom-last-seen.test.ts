/**
 * An agent's seen-marker per room: a line that was only typed into its pane does not count, a read through the API does,
 * and nobody else's read moves it.
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

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const AS = (id: string) => ({ 'x-codeman-parent-session': id });

describe('what an agent has seen of a room', () => {
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
    for (const [id, name] of [[A, 'alpha'], [B, 'bravo'], [C, 'charlie']]) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  it('typed is not seen; an agent read moves only its own marker, to the newest message it got', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'Fleet', members: [{ sessionId: A }, { sessionId: B }] } });
    const room = res.json().data.id as string;
    const ids: string[] = [];
    for (const text of ['first', 'second']) {
      clock += 1_000;
      const r = await app.inject({ method: 'POST', url: `/api/chatrooms/${room}/messages`, payload: { text } });
      ids.push(r.json().data.id ?? r.json().data.message?.id);
    }
    clock += 10_000;
    await service.delivery.flushAll(); // typed into A's and B's panes; the mock pane reports no outcome
    expect(service.lastSeen(A, room)).toBeUndefined();

    expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${room}/messages`, headers: AS(A) })).statusCode).toBe(200);
    expect(service.lastSeen(A, room)?.messageId).toBe(ids[1]);
    expect(service.lastSeen(B, room)).toBeUndefined(); // A's read is not B's

    await app.inject({ method: 'GET', url: `/api/chatrooms/${room}/messages` }); // the owner's read marks no agent
    expect(service.lastSeen(B, room)).toBeUndefined();
    await app.inject({ method: 'GET', url: `/api/chatrooms/${room}/messages`, headers: AS(C) }); // not a member
    expect(service.lastSeen(C, room)).toBeUndefined();
  });

  it('a non-member cannot read a PUBLIC room here, so it never gets a marker there', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'Open', members: [{ sessionId: A }] } });
    const room = res.json().data.id as string;
    expect((await app.inject({ method: 'PUT', url: `/api/chatrooms/${room}/visibility`, payload: { visibility: 'public' } })).statusCode).toBe(200);
    clock += 1_000;
    await app.inject({ method: 'POST', url: `/api/chatrooms/${room}/messages`, payload: { text: 'hello' } });
    // The route refuses non-members even for a public room; the read hook's own membership check is only a second guard.
    expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${room}/messages`, headers: AS(C) })).statusCode).toBe(404);
    expect(service.lastSeen(C, room)).toBeUndefined();
  });

  it('a line the pane was SEEN to submit marks every message in it as seen', async () => {
    const pane = ctx.sessions.get(B) as unknown as { writeViaMux: (d: string, o?: { onOutcome?: (x: string) => void }) => Promise<boolean> };
    pane.writeViaMux = async (_data, options) => {
      options?.onOutcome?.('submitted');
      return true;
    };
    const res = await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'Fleet', members: [{ sessionId: A }, { sessionId: B }] } });
    const room = res.json().data.id as string;
    clock += 1_000;
    const r = await app.inject({ method: 'POST', url: `/api/chatrooms/${room}/messages`, payload: { text: '@bravo please look' } });
    const id = r.json().data.id ?? r.json().data.message?.id;
    clock += 10_000;
    await service.delivery.flushAll();
    expect(service.lastSeen(B, room)?.messageId).toBe(id);
    expect(service.lastSeen(A, room)).toBeUndefined(); // A's mock pane reports nothing: typed is not seen
  });
});
