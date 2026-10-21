/**
 * Each agent chooses, per room, what wakes it: everything the room says (`all`) or only what is meant for it (`mentions`). A choice never
 * loses a message: what does not wake the member rides along with its next prompt. The owner always wakes it and can set anyone's.
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
const C = '0000003e-004c-4000-8000-00000000006f';
const AS = (id: string) => ({ 'x-codeman-parent-session': id });

describe('an agent chooses what wakes it', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;

  const panes = (id: string): string[] => (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer;
  const text = (id: string) => panes(id).join('');
  const names = new Map([[A, 'alpha'], [B, 'bravo'], [C, 'lead']]);

  beforeEach(async () => {
    clock = 1_000_000;
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {}, now: () => clock });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of names) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  /** A room of the three agents (with `lead` as coordinator unless told not to), briefings already delivered and cleared. */
  const room = async (name = 'Fleet', coordinator = true, wake: 'mentions' | 'all' | null = null) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name, members: [{ sessionId: A }, { sessionId: B }, { sessionId: C }], ...(coordinator ? { coordinatorSessionId: C } : {}) },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id as string;
    if (wake) expect((await app.inject({ method: 'PUT', url: `/api/chatrooms/${id}/wake`, payload: { mode: wake } })).statusCode).toBe(200);
    await settle();
    return id;
  };
  const settle = async () => {
    clock += 10_000;
    await service.delivery.flushAll();
    for (const id of names.keys()) panes(id).length = 0;
  };
  const post = (id: string, body: object, from?: string) =>
    app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, headers: from ? AS(from) : {}, payload: body });
  const flush = async () => {
    clock += 10_000;
    await service.delivery.flushAll();
  };
  const notify = (id: string, who: string, mode: string, from?: string) =>
    app.inject({ method: 'PUT', url: `/api/chatrooms/${id}/members/${who}/notify`, headers: from ? AS(from) : {}, payload: { mode } });

  it('an agent that chose mentions is not woken by an agent\'s plain post, but still gets it with its next prompt', async () => {
    const id = await room();
    expect((await notify(id, B, 'mentions', B)).statusCode).toBe(200);
    await post(id, { text: 'status update' }, A);
    await flush();
    expect(text(C)).toContain('"alpha": "status update"'); // the coordinator and the others are woken as the room says
    expect(panes(B)).toEqual([]);
    expect(service.delivery.pendingFor(B)).toBe(1);
    await post(id, { text: '@bravo your turn' }, A);
    await flush();
    expect(panes(B)).toHaveLength(1);
    expect(panes(B)[0].indexOf('status update')).toBeGreaterThan(-1);
    expect(panes(B)[0].indexOf('status update')).toBeLessThan(panes(B)[0].indexOf('@bravo your turn'));
    expect(service.delivery.pendingFor(B)).toBe(0);
  });

  it('the owner, a reply to its own message, a message addressed to it and a direct @ always wake it; @everyone does not', async () => {
    const id = await room();
    await notify(id, B, 'mentions', B);
    await post(id, { text: 'owner speaking' });
    await flush();
    expect(text(B)).toContain('USER: "owner speaking"');
    panes(B).length = 0;
    await post(id, { text: '@everyone heads up' }, A);
    await flush();
    expect(panes(B)).toEqual([]);
    expect(panes(C).join('')).toContain('@everyone heads up');
    const mine = (await post(id, { text: 'my question' }, B)).json().data.message.id as string;
    await flush();
    panes(B).length = 0;
    await post(id, { text: 'plain answer', replyTo: mine }, A);
    await flush();
    expect(text(B)).toContain('plain answer');
  });

  it('only the member itself or the owner sets it; a non-member sees no room; all undoes it', async () => {
    const id = await room();
    expect((await notify(id, B, 'mentions', A)).statusCode).toBe(403);
    expect((await notify(id, B, 'mentions', C)).statusCode).toBe(403); // not even the coordinator, for another member
    expect((await notify(id, B, 'mentions')).statusCode).toBe(200); // the owner
    expect(service.room(id)?.members.find((m) => m.sessionId === B)?.notify).toBe('mentions');
    expect((await notify(id, B, 'shout', B)).statusCode).toBe(400);
    expect((await notify(id, B, 'all', B)).statusCode).toBe(200);
    expect(service.room(id)?.members.find((m) => m.sessionId === B)?.notify).toBeUndefined();
    expect((await notify(id, '00000043-0053-4000-8000-00000000007a', 'mentions')).statusCode).toBe(404);
  });

  it('the setting is in the member\'s view and in its briefing, and a member that never set it reads nothing about it', async () => {
    const id = await room();
    await notify(id, B, 'mentions', B);
    const view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    expect(view.members.find((m: { sessionId: string }) => m.sessionId === B).notify).toBe('mentions');
    service.rebrief(id);
    await flush();
    expect(text(B)).toContain('You chose to be woken here only by a direct @mention');
    expect(text(A)).not.toContain('You chose to be woken');
  });

  it('it still holds in a room whose own wake mode is mentions: a member must be named, not just the coordinator\'s attention', async () => {
    const id = await room('Quiet', true, 'mentions');
    await notify(id, C, 'mentions', C); // the coordinator mutes itself too
    await post(id, { text: 'general note' }, A);
    await flush();
    expect(panes(C)).toEqual([]);
    await post(id, { text: '@lead please look' }, A);
    await flush();
    expect(text(C)).toContain('@lead please look');
  });
});
