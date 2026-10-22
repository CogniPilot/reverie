/**
 * Chatroom routes + service: room lifecycle, who-is-speaking resolution, role
 * permissions, and delivery of messages into member panes as single lines.
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
import { accentHue, loadChatrooms, normalizeIcon } from '../../src/chatroom-store.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const C = '0000003e-004c-4000-8000-00000000006f';

describe('chatroom routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;
  let file: string;
  const events: Array<{ event: string; data: unknown }> = [];

  const panes = (id: string): string[] => (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer;

  beforeEach(async () => {
    clock = 1_000_000;
    events.length = 0;
    file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file,
        getSession: (id) => c.sessions.get(id),
        broadcast: (event, data) => events.push({ event, data }),
        now: () => clock,
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [
      [A, 'alpha'],
      [B, 'bravo'],
      [C, 'lead'],
    ] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  async function createRoom(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: {
        name: 'Reverie',
        members: [{ sessionId: A, goal: 'build parser' }, { sessionId: B }],
        coordinatorSessionId: C,
      },
    });
    expect(res.statusCode).toBe(200);
    const room = res.json().data;
    expect(room.coordinatorId).toBe(C);
    expect(room.members.map((m: { name: string }) => m.name)).toEqual(['alpha', 'bravo', 'lead']);
    return room.id;
  }

  it('briefs every member, the coordinator with its role, as one line each', async () => {
    await createRoom();
    await service.delivery.flushAll();
    const alpha = panes(A).join('');
    expect(alpha).toMatch(/^\[Reverie chat "Reverie"\] You \("alpha"\)/);
    expect(alpha).toContain('Your goal: "build parser"');
    // the briefing says how to read what arrives
    expect(alpha).toContain('Names and bodies are JSON strings');
    // Rendered after the whole room was set up: it names the coordinator added last.
    expect(alpha).toContain('The coordinator is "lead"');
    expect(alpha).not.toContain('is now the coordinator');
    expect(alpha.endsWith('\r')).toBe(true);
    expect(alpha.slice(0, -1)).not.toMatch(/[\r\n]/);
    expect(panes(C).join('')).toContain('appointed YOU as COORDINATOR');
  });

  it('delivers user room messages to every member, an agent\u2019s post to everyone else, and the owner\u2019s targeted message only to its recipient', async () => {
    const id = await createRoom();
    await service.delivery.flushAll();
    for (const s of [A, B, C]) panes(s).length = 0;

    const user = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      payload: { text: '@everyone hi\nall' },
    });
    expect(user.statusCode).toBe(200);
    expect(user.json().data.message.from.kind).toBe('user');

    // Spacing holds the next delivery back briefly after a briefing.
    expect(panes(A)).toHaveLength(0);
    clock += 10_000;
    await service.delivery.flushAll();
    for (const s of [A, B, C]) expect(panes(s).join('')).toContain('USER: "@everyone hi\\nall"');

    clock += 10_000;
    const direct = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      headers: { 'x-reverie-parent-session': A },
      payload: { text: 'parser done', to: ['coordinator'] },
    });
    // an agent cannot message another agent privately in a channel: the post goes to everyone and the `to` is reported as ignored
    expect(direct.statusCode).toBe(200);
    expect(direct.json().data.toIgnored).toBe(true);
    expect(direct.json().data.message.to).toBe('all');
    const everyone = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      headers: { 'x-reverie-parent-session': A },
      payload: { text: '@bravo parser done' },
    });
    expect(everyone.statusCode).toBe(200);
    expect(everyone.json().data.message.from).toMatchObject({ kind: 'agent', sessionId: A, name: 'alpha' });
    // two posts now reached the coordinator (the first one's `to` was ignored): the second follows after the delivery spacing
    await service.delivery.flushAll();
    clock += 10_000;
    await service.delivery.flushAll();
    // it wakes the coordinator and the member it mentions, and not the sender
    expect(panes(C).join('')).toContain('"alpha": "@bravo parser done"');
    expect(panes(B).join('')).toContain('"alpha": "@bravo parser done"');
    expect(panes(A).join('')).not.toContain('parser done');
    expect(events.some((e) => e.event === 'chatroom:message')).toBe(true);

    // The owner cannot address one member either: a `to` is ignored and the post goes to everyone (@mention who it is for).
    clock += 10_000;
    const owner = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, payload: { text: 'only for the lead', to: ['coordinator'] } });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().data.message.to).toBe('all');
    expect(owner.json().data.toIgnored).toBe(true);
    clock += 10_000;
    await service.delivery.flushAll();
    expect(panes(C).join('')).toContain('USER: "only for the lead"');
    expect(panes(A).join('')).toContain('USER: "only for the lead"');
    // and an agent cannot do the same: its `to` was ignored, so that post went to everyone (the coordinator it named was woken by it)
    expect(panes(C).join('')).toContain('"alpha": "parser done"');
  });

  it('holds delivery while a member is mid-turn', async () => {
    const id = await createRoom();
    await service.delivery.flushAll();
    panes(B).length = 0;
    (ctx.sessions.get(B) as unknown as { isWorking: boolean }).isWorking = true;
    clock += 10_000;
    await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      payload: { text: '@bravo wait for it' },
    });
    await service.delivery.flushAll();
    expect(panes(B)).toHaveLength(0);
    (ctx.sessions.get(B) as unknown as { isWorking: boolean }).isWorking = false;
    await service.delivery.flushAll();
    expect(panes(B).join('')).toContain('USER: "@bravo wait for it"');
  });

  it('lets an agent set only its own synopsis and keeps appointment with the user', async () => {
    const id = await createRoom();
    const own = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${B}/status`,
      headers: { 'x-reverie-parent-session': B },
      payload: { progress: 'half way' },
    });
    expect(own.statusCode).toBe(200);
    const other = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      headers: { 'x-reverie-parent-session': B },
      payload: { progress: 'nope' },
    });
    expect(other.statusCode).toBe(403);
    const userEdit = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      payload: { goal: 'new goal' },
    });
    expect(userEdit.statusCode).toBe(200);
    const appoint = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/coordinator`,
      headers: { 'x-reverie-parent-session': C },
      payload: { sessionId: A },
    });
    expect(appoint.statusCode).toBe(403);
    const view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    const byName = Object.fromEntries(view.members.map((m: { name: string }) => [m.name, m]));
    expect(byName.bravo.progress).toBe('half way');
    expect(byName.alpha.goal).toBe('new goal');
  });

  describe('creating rooms as an agent', () => {
    const asAgent = (id: string, payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/chatrooms', headers: { 'x-reverie-parent-session': id }, payload });

    it('lets a coordinator create a room, made coordinator of it with its members briefed', async () => {
      await createRoom(); // C coordinates "Reverie"
      const res = await asAgent(C, { name: 'Side', members: [{ sessionId: A, goal: 'parse' }] });
      expect(res.statusCode).toBe(200);
      const room = res.json().data;
      expect(room.name).toBe('Side');
      expect(room.coordinatorId).toBe(C);
      expect(room.members.map((m: { sessionId: string }) => m.sessionId).sort()).toEqual([A, C].sort());
      expect(room.members.find((m: { sessionId: string }) => m.sessionId === C).role).toBe('coordinator');
      // The Reverie briefing went out on its own timer a moment ago; deliveries to one pane are spaced.
      clock += 10_000;
      await service.delivery.flushAll();
      expect(panes(A).join('')).toContain('"Side"');
    });

    it('refuses an agent that coordinates no room, and one that is not in any room', async () => {
      await createRoom(); // A and B are plain members
      expect((await asAgent(A, { name: 'Nope' })).statusCode).toBe(403);
      expect((await asAgent(B, { name: 'Nope' })).statusCode).toBe(403);
      const lone = createMockSession('00000043-0053-4000-8000-00000000007a');
      ctx.sessions.set(lone.id, lone as never);
      expect((await asAgent(lone.id, { name: 'Nope' })).statusCode).toBe(403);
      expect(service.rooms().map((r) => r.name)).toEqual(['Reverie']);
    });

    it('does not let a coordinator appoint someone else, nor mark itself the voice', async () => {
      await createRoom();
      expect((await asAgent(C, { name: 'X', coordinatorSessionId: A })).statusCode).toBe(403);
      expect((await asAgent(C, { name: 'X', members: [{ sessionId: C, voice: true }] })).statusCode).toBe(403);
      expect(service.rooms().map((r) => r.name)).toEqual(['Reverie']);
      // Naming itself as the coordinator is the same thing as the default.
      expect((await asAgent(C, { name: 'Same', coordinatorSessionId: C })).statusCode).toBe(200);
    });

    it('creates nothing when a member is unknown', async () => {
      await createRoom();
      const res = await asAgent(C, { name: 'Ghost', members: [{ sessionId: '00000046-0058-4000-8000-000000000089' }] });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(service.rooms().map((r) => r.name)).toEqual(['Reverie']);
    });

    it('does not let the coordinator of only an archived room create rooms', async () => {
      const id = await createRoom(); // C coordinates "Reverie"
      service.room(id)!.archivedAt = clock;
      expect((await asAgent(C, { name: 'Late' })).statusCode).toBe(403);
      expect(service.rooms().map((r) => r.name)).toEqual(['Reverie']);
    });

    it('refuses a full house before creating anything: 50 members plus the creator is 51', async () => {
      await createRoom();
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        const id = `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`;
        ctx.sessions.set(id, createMockSession(id) as never);
        ids.push(id);
      }
      const full = await asAgent(C, { name: 'Crowd', members: ids.map((sessionId) => ({ sessionId })) });
      expect(full.statusCode).toBe(409);
      expect(service.rooms().map((r) => r.name)).toEqual(['Reverie']);
      // 49 members plus the creator is exactly the limit and is fine.
      const ok = await asAgent(C, { name: 'Crowd', members: ids.slice(0, 49).map((sessionId) => ({ sessionId })) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.members).toHaveLength(50);
    });

    it('keeps rename, delete and appointment with the user', async () => {
      await createRoom();
      const id = (await asAgent(C, { name: 'Mine' })).json().data.id;
      const h = { 'x-reverie-parent-session': C };
      expect((await app.inject({ method: 'PUT', url: `/api/chatrooms/${id}`, headers: h, payload: { name: 'Z' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/api/chatrooms/${id}`, headers: h })).statusCode).toBe(403);
      const appoint = await app.inject({
        method: 'POST',
        url: `/api/chatrooms/${id}/coordinator`,
        headers: h,
        payload: { sessionId: A },
      });
      expect(appoint.statusCode).toBe(403);
    });
  });

  it('lets the coordinator add members but not a plain agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Solo', coordinatorSessionId: C },
    });
    const id = res.json().data.id;
    const byAgent = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members`,
      headers: { 'x-reverie-parent-session': A },
      payload: { sessionId: B },
    });
    // an agent that is not in the room does not even see it (404); a plain member is refused (403, below)
    expect(byAgent.statusCode).toBe(404);
    const byCoordinator = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members`,
      headers: { 'x-reverie-parent-session': C },
      payload: { sessionId: B, goal: 'tests' },
    });
    expect(byCoordinator.statusCode).toBe(200);
    clock += 10_000;
    await service.delivery.flushAll();
    expect(panes(C).join('')).toContain('"bravo" joined the room with goal: "tests"');
  });

  it('never lets a shell session receive room text: refused, or post-only when the user adds it', async () => {
    const id = await createRoom();
    const W = '00000043-0053-4000-8000-00000000007c';
    const watcher = createMockSession(W);
    watcher.name = 'watcher';
    watcher.mode = 'shell';
    ctx.sessions.set(W, watcher as never);
    const add = (payload: object, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members`, headers, payload });

    expect((await add({ sessionId: W })).statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Shelly', members: [{ sessionId: W }] },
    });
    expect(created.statusCode).toBe(400);
    expect(service.rooms().some((r) => r.name === 'Shelly')).toBe(false); // nothing half-created
    expect((await add({ sessionId: W, postOnly: true }, { 'x-reverie-parent-session': C })).statusCode).toBe(403);
    expect((await add({ sessionId: W, postOnly: true, role: 'coordinator' })).statusCode).toBe(400);
    expect((await add({ sessionId: W, postOnly: true, voice: true })).statusCode).toBe(400);
    const ok = await add({ sessionId: W, postOnly: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.member.postOnly).toBe(true);

    clock += 10_000;
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, payload: { text: '@alpha rm -rf / # to all' } });
    await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      payload: { text: 'direct', to: ['watcher'] },
    });
    clock += 10_000;
    await service.delivery.flushAll();
    expect(panes(W)).toEqual([]);
    expect(panes(A).join('')).toContain('rm -rf');

    // It can still post its alerts, as itself.
    const alert = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      headers: { 'x-reverie-parent-session': W },
      payload: { text: 'watcher alert', requireAgent: true },
    });
    expect(alert.statusCode).toBe(200);
    expect(alert.json().data.message.from).toMatchObject({ kind: 'agent', sessionId: W });
  });

  it('never lets a post-only or non-agent member lead, and never briefs a post-only member', async () => {
    const id = await createRoom();
    const D = '00000043-0053-4000-8000-00000000007d';
    const listener = createMockSession(D);
    listener.name = 'listener';                                    // an agent pane, added as post-only
    ctx.sessions.set(D, listener as never);
    expect((await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members`, payload: { sessionId: D, postOnly: true } })).statusCode).toBe(200);
    const appoint = (sessionId: string) =>
      app.inject({ method: 'POST', url: `/api/chatrooms/${id}/coordinator`, payload: { sessionId } });
    const voice = (sessionId: string) =>
      app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members/${sessionId}/status`, payload: { voice: true } });
    expect((await appoint(D)).statusCode).toBe(400);
    expect((await voice(D)).statusCode).toBe(400);

    // A member that predates the post-only flag but is now a shell pane cannot lead either.
    (ctx.sessions.get(B) as unknown as { mode: string }).mode = 'shell';
    expect((await appoint(B)).statusCode).toBe(400);
    expect((await voice(B)).statusCode).toBe(400);

    clock += 10_000;
    await service.delivery.flushAll();
    panes(D).length = 0;
    expect((await appoint(A)).statusCode).toBe(200);              // announcement goes to every other member
    service.rebrief(id);
    clock += 10_000;
    await service.delivery.flushAll();
    expect(panes(D)).toEqual([]);
    expect(panes(C).join('')).toContain('is now the coordinator');
  });

  it('refuses a requireAgent post whose caller session does not resolve instead of posting as the user', async () => {
    const id = await createRoom();
    for (const headers of [{}, { 'x-reverie-parent-session': '00000046-0058-4000-8000-000000000084' }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/chatrooms/${id}/messages`,
        headers,
        payload: { text: 'watcher alert', requireAgent: true },
      });
      expect(res.statusCode).toBe(403);
    }
    const agent = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      headers: { 'x-reverie-parent-session': A },
      payload: { text: 'watcher alert', requireAgent: true },
    });
    expect(agent.statusCode).toBe(200);
    expect(agent.json().data.message.from).toMatchObject({ kind: 'agent', sessionId: A });
    const view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    expect(view.messages.filter((m: { from: { kind: string } }) => m.from.kind === 'user')).toHaveLength(0);
  });

  it('refuses unknown recipients and posts from non-members, lists rooms by member, and persists', async () => {
    const id = await createRoom();
    const bad = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      payload: { text: 'x', to: ['nobody'] },
    });
    // a `to` is ignored now (not an error): the post goes to everyone
    expect(bad.statusCode).toBe(200);
    expect(bad.json().data.toIgnored).toBe(true);
    expect(bad.json().data.message.to).toBe('all');
    ctx.sessions.set(
      '00000043-0053-4000-8000-00000000007a',
      createMockSession('00000043-0053-4000-8000-00000000007a') as never
    );
    const outsider = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      headers: { 'x-reverie-parent-session': '00000043-0053-4000-8000-00000000007a' },
      payload: { text: 'let me in' },
    });
    expect(outsider.statusCode).toBe(404); // a private channel is not there for a session outside it
    const mine = await app.inject({
      method: 'GET',
      url: '/api/chatrooms?member=self',
      headers: { 'x-reverie-parent-session': A },
    });
    expect(mine.json().data.self).toBe(A);
    expect(mine.json().data.rooms).toHaveLength(1);
    await service.stop();
    const saved = await loadChatrooms(file);
    expect(saved[0].members).toHaveLength(3);
    expect(saved[0].messages.length).toBeGreaterThan(0);
  });

  it('lets an agent re-brief only itself unless it is the coordinator', async () => {
    const id = await createRoom();
    const other = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${B}/brief`,
      headers: { 'x-reverie-parent-session': A },
    });
    expect(other.statusCode).toBe(403);
    const all = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/all/brief`,
      headers: { 'x-reverie-parent-session': A },
    });
    expect(all.statusCode).toBe(403);
    const self = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/brief`,
      headers: { 'x-reverie-parent-session': A },
    });
    expect(self.statusCode).toBe(200);
    const byCoordinator = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/all/brief`,
      headers: { 'x-reverie-parent-session': C },
    });
    expect(byCoordinator.json().data.briefed).toBe(3);
  });

  it('creates nothing and queues nothing when a member id is bad', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Broken', members: [{ sessionId: A }, { sessionId: 'no-such-session' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(service.rooms()).toHaveLength(0);
    expect(service.delivery.pendingFor(A)).toBe(0);
  });

  it('drops undelivered entries when a room is deleted or a member leaves', async () => {
    // Busy panes keep their queues, so the briefings are still pending below.
    for (const s of [A, B, C]) (ctx.sessions.get(s) as unknown as { isWorking: boolean }).isWorking = true;
    const id = await createRoom();
    // Briefings are queued but not yet flushed.
    expect(service.delivery.pendingFor(B)).toBeGreaterThan(0);
    await app.inject({ method: 'DELETE', url: `/api/chatrooms/${id}/members/${B}` });
    expect(service.delivery.pendingFor(B)).toBe(0);
    expect(service.delivery.pendingFor(A)).toBeGreaterThan(0);
    await app.inject({ method: 'DELETE', url: `/api/chatrooms/${id}` });
    expect(service.delivery.pendingFor(A)).toBe(0);
    expect(service.delivery.pendingFor(C)).toBe(0);
  });

  it('sets, shows and clears member icons, from the member itself or the user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Icons', members: [{ sessionId: A, icon: '\u{1F9ED}' }], coordinatorSessionId: C },
    });
    const id = res.json().data.id;
    const byName = (view: { members: Array<{ name: string }> }) =>
      Object.fromEntries(view.members.map((m) => [m.name, m])) as Record<string, { icon?: string; hue: number }>;
    let view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    expect(byName(view).alpha.icon).toBe('\u{1F9ED}');
    // Members without an icon still get a deterministic accent.
    expect(byName(view).lead.icon).toBeUndefined();
    expect(byName(view).lead.hue).toBe(accentHue(C));

    const own = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${C}/status`,
      headers: { 'x-reverie-parent-session': C },
      payload: { icon: 'OK' },
    });
    expect(own.statusCode).toBe(200);
    const other = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      headers: { 'x-reverie-parent-session': C },
      payload: { icon: 'X' },
    });
    expect(other.statusCode).toBe(403);
    const tooLong = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      payload: { icon: 'abc' },
    });
    expect(tooLong.statusCode).toBe(400);
    const cleared = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      payload: { icon: '' },
    });
    expect(cleared.statusCode).toBe(200);
    view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    expect(byName(view).lead.icon).toBe('OK');
    expect(byName(view).alpha.icon).toBeUndefined();
    // The join line names the member, for the panel to draw its avatar.
    const join = view.messages.find((m: { text: string }) => m.text.startsWith('alpha joined'));
    expect(join.from.sessionId).toBe(A);
  });

  it('refuses a bad icon at create time without creating the room', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Bad', members: [{ sessionId: A, icon: 'abc' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(service.rooms()).toHaveLength(0);
  });

  it('tells members they may pick their own icon', async () => {
    await createRoom();
    await service.delivery.flushAll();
    expect(panes(A).join('')).toContain('reverie agent chat status --icon');
    expect(panes(C).join('')).toContain('reverie agent chat status --icon');
  });

  it('counts an emoji with modifiers as one character', () => {
    expect(normalizeIcon(' \u{1F9D1}\u{1F3FD}\u200D\u{1F4BB} ')).toBe('\u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}');
    expect(normalizeIcon('\u{1F50D}')).toBe('\u{1F50D}');
    expect(normalizeIcon('AB')).toBe('AB');
    expect(normalizeIcon('ABC')).toBeUndefined();
    expect(normalizeIcon('\u0007')).toBeUndefined();
    expect(normalizeIcon('   ')).toBe('');
  });

  it('refuses invisible format characters but keeps the ones emoji are made of', () => {
    expect(normalizeIcon('A\u200b')).toBeUndefined(); // zero-width space
    expect(normalizeIcon('\u202eA')).toBeUndefined(); // right-to-left override
    expect(normalizeIcon('\u2066A')).toBeUndefined(); // left-to-right isolate
    expect(normalizeIcon('A\u2028')).toBeUndefined(); // line separator
    // ZWJ sequence (family) and a subdivision flag (England) are single emoji.
    expect(normalizeIcon('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}');
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    expect(normalizeIcon(england)).toBe(england);
    expect(normalizeIcon('\u2764\uFE0F')).toBe('\u2764\uFE0F');
  });

  it('judges a repeated member by its last entry when creating a room', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: {
        name: 'Dup',
        members: [
          { sessionId: A, icon: 'abc' },
          { sessionId: A, icon: 'OK' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.members[0].icon).toBe('OK');
  });

  it('lets only the user or the coordinator mark the voice member', async () => {
    const id = await createRoom();
    const self = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      headers: { 'x-reverie-parent-session': A },
      payload: { voice: true },
    });
    expect(self.statusCode).toBe(403);
    const byCoordinator = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      headers: { 'x-reverie-parent-session': C },
      payload: { voice: true },
    });
    expect(byCoordinator.statusCode).toBe(200);
    // ...but the coordinator still cannot edit another member's synopsis.
    const synopsis = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      headers: { 'x-reverie-parent-session': C },
      payload: { voice: true, progress: 'x' },
    });
    expect(synopsis.statusCode).toBe(403);
    const byUser = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${B}/status`,
      payload: { voice: true },
    });
    expect(byUser.statusCode).toBe(200);
    const off = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${A}/status`,
      payload: { voice: false },
    });
    expect(off.statusCode).toBe(200);
    const view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    const byName = Object.fromEntries(view.members.map((m: { name: string; voice?: boolean }) => [m.name, m.voice]));
    expect(byName).toEqual({ alpha: undefined, bravo: true, lead: undefined });
  });

  it('marks a car-mode message as spoken but still delivers it to the member', async () => {
    const id = await createRoom();
    await service.delivery.flushAll();
    panes(A).length = 0;
    clock += 10_000;
    const res = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      payload: { text: 'how is the build', to: ['alpha'], spoken: true },
    });
    expect(res.json().data.message).toMatchObject({ spoken: true });
    expect(res.json().data.message.voice).toBeUndefined();
    await service.delivery.flushAll();
    expect(panes(A).join('')).toContain('USER -> you: "how is the build"');
    const byAgent = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/messages`,
      headers: { 'x-reverie-parent-session': A },
      payload: { text: 'pretend speech', spoken: true },
    });
    expect(byAgent.json().data.message.spoken).toBeUndefined();
  });

  it('keeps one voice per room and never lets the coordinator mark itself', async () => {
    const id = await createRoom();
    const self = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members/${C}/status`,
      headers: { 'x-reverie-parent-session': C },
      payload: { voice: true },
    });
    expect(self.statusCode).toBe(403);
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members/${A}/status`, payload: { voice: true } });
    await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members/${B}/status`, payload: { voice: true } });
    const view = (await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data;
    const flagged = view.members.filter((m: { voice?: boolean }) => m.voice).map((m: { name: string }) => m.name);
    expect(flagged).toEqual(['bravo']);
  });

  it('stops the coordinator marking itself through add, and refuses two voices at creation', async () => {
    const id = await createRoom();
    const viaAdd = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${id}/members`,
      headers: { 'x-reverie-parent-session': C },
      payload: { sessionId: C, voice: true },
    });
    expect(viaAdd.statusCode).toBe(403);
    const two = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: {
        name: 'Two voices',
        members: [
          { sessionId: A, voice: true },
          { sessionId: B, voice: true },
        ],
      },
    });
    expect(two.statusCode).toBe(400);
    expect(two.json().error).toContain('one member');
  });
});

describe('chatroom creation by a coordinator in multi-user mode', () => {
  const ALICE_LEAD = '0000002d-0036-4000-8000-00000000004d';
  const ALICE_WORKER = '0000002d-0036-4000-8000-00000000004e';
  const BOB_WORKER = '00000038-0044-4000-8000-000000000063';
  let app: FastifyInstance;
  let service: ChatroomService;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.REVERIE_MULTIUSER;
    process.env.REVERIE_MULTIUSER = '1';
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-mu-')), 'chatrooms.json');
    const harness = await createRouteTestHarness(
      (fastify, c) => {
        service = new ChatroomService({
          file,
          getSession: (id) => c.sessions.get(id),
          broadcast: () => {},
          now: () => 1_000_000,
        });
        registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
      },
      { authUser: { username: 'alice', role: 'user' } }
    );
    app = harness.app;
    for (const [id, owner] of [
      [ALICE_LEAD, 'alice'],
      [ALICE_WORKER, 'alice'],
      [BOB_WORKER, 'bob'],
    ] as const) {
      const s = createMockSession(id);
      (s as unknown as { owner: string }).owner = owner;
      harness.ctx.sessions.set(id, s as never);
    }
    // alice's lead already coordinates a room of hers.
    const seed = service.createRoom('Seed', 'alice');
    service.addMember(seed.id, ALICE_LEAD, { role: 'coordinator' });
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.REVERIE_MULTIUSER;
    else process.env.REVERIE_MULTIUSER = previous;
    await service.stop();
    await app.close();
  });

  const asLead = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/chatrooms', headers: { 'x-reverie-parent-session': ALICE_LEAD }, payload });

  it('stamps the new room with the creator\'s owner', async () => {
    const res = await asLead({ name: 'Alice side room', members: [{ sessionId: ALICE_WORKER }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.owner).toBe('alice');
    expect(service.rooms().find((r) => r.name === 'Alice side room')?.owner).toBe('alice');
  });

  it('cannot add a session it cannot see', async () => {
    const res = await asLead({ name: 'Leak', members: [{ sessionId: BOB_WORKER }] });
    expect(res.statusCode).toBe(404);
    expect(service.rooms().map((r) => r.name)).toEqual(['Seed']);
  });
});
