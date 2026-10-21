/**
 * A post to the whole room wakes only the members it is for: the @mentioned, the author of the message it replies to, and the
 * coordinator. Everyone else still gets it, in order, with the next prompt that does wake them (read later, not lost); it never
 * wakes a pane by itself. Addressed messages, direct messages and rooms with no coordinator behave as before.
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
import { ChatroomDelivery, MAX_PASSIVE_PER_SESSION, PASSIVE_MAX_AGE_MS, buildBriefing, wakeRecipients } from '../../src/chatroom-delivery.js';
import type { ChatMessage, ChatRoom } from '../../src/chatroom-store.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const C = '0000003e-004c-4000-8000-00000000006f';
const AS = (id: string) => ({ 'x-codeman-parent-session': id });

describe('mention-only delivery', () => {
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
  const room = async (name = 'Fleet', coordinator = true, wake: 'mentions' | 'all' | null = 'mentions') => {
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

  it('a post that mentions nobody wakes only the coordinator; the others hold it for their next prompt', async () => {
    const id = await room();
    await post(id, { text: 'status please' });
    await flush();
    expect(text(C)).toContain('USER: "status please"');
    expect(panes(A)).toEqual([]);
    expect(panes(B)).toEqual([]);
    expect(service.delivery.pendingFor(A)).toBe(1);
    // nothing wakes them later by itself
    await flush();
    await flush();
    expect(panes(A)).toEqual([]);
  });

  it('a later mention wakes the member and brings the held messages along, in order, in one line', async () => {
    const id = await room();
    await post(id, { text: 'first' });
    await flush();
    clock += 10_000;
    await post(id, { text: 'second' }, B);
    await flush();
    await post(id, { text: '@alpha your turn' });
    await flush();
    const lines = panes(A);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.indexOf('"first"')).toBeGreaterThan(-1);
    expect(line.indexOf('"first"')).toBeLessThan(line.indexOf('"second"'));
    expect(line.indexOf('"second"')).toBeLessThan(line.indexOf('"@alpha your turn"'));
    expect(service.delivery.pendingFor(A)).toBe(0);
    // bravo was not mentioned and wrote 'second': still asleep, still holding the others
    expect(panes(B)).toEqual([]);
  });

  it('@everyone wakes all; a name inside a word or an address does not wake anyone', async () => {
    const id = await room();
    await post(id, { text: '@everyone standup' });
    await flush();
    for (const who of [A, B, C]) expect(text(who)).toContain('@everyone standup');
    for (const who of [A, B, C]) panes(who).length = 0;
    clock += 10_000;
    await post(id, { text: 'mail a@alpha.io, ask @alphabet, @bravos too, email@bravo' });
    await flush();
    expect(panes(A)).toEqual([]);
    expect(panes(B)).toEqual([]);
    expect(text(C)).toContain('mail a@alpha.io');
  });

  it('a reply wakes the author of the message it answers, and the mention rule ignores case', async () => {
    const id = await room();
    const first = (await post(id, { text: 'parser done' }, A)).json().data.message.id as string;
    await flush();
    for (const who of [A, B, C]) panes(who).length = 0;
    clock += 10_000;
    await post(id, { text: 'thanks', replyTo: first }, B);
    await flush();
    expect(text(A)).toContain('"thanks"');
    clock += 10_000;
    panes(A).length = 0;
    await post(id, { text: '@BRAVO please check' }, A);
    await flush();
    expect(text(B)).toContain('@BRAVO please check');
  });

  it('a room with no coordinator and no mention still wakes everyone', async () => {
    const id = await room('Loose', false);
    await post(id, { text: 'anyone there?' });
    await flush();
    for (const who of [A, B, C]) expect(text(who)).toContain('anyone there?');
  });

  it('a typed `to` is ignored (the post goes to the room and wakes by the room\u2019s rule); a direct message wakes its member as before', async () => {
    const id = await room();
    await post(id, { text: 'just you', to: ['bravo'] });
    await flush();
    // bravo was not mentioned and the room wakes by mention: held, not woken; the coordinator is woken
    expect(panes(B)).toEqual([]);
    expect(text(C)).toContain('USER: "just you"');
    expect(panes(A)).toEqual([]);
    panes(C).length = 0;
    clock += 10_000;
    const dm = (await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } })).json().data;
    await settle();
    await post(dm.id, { text: 'hello in private' });
    await flush();
    expect(text(A)).toContain('hello in private');
  });

  it('keeps at most MAX_PASSIVE held messages, drops stale ones, and never types a held one alone', async () => {
    const id = await room();
    for (let i = 0; i < MAX_PASSIVE_PER_SESSION + 5; i++) await post(id, { text: `n${i}` });
    expect(service.delivery.pendingFor(A)).toBe(MAX_PASSIVE_PER_SESSION);
    await flush();
    expect(panes(A)).toEqual([]);
    // old ones are dropped when the member is finally woken, the fresh ones are not
    clock += PASSIVE_MAX_AGE_MS + 1;
    await post(id, { text: 'fresh' });
    await post(id, { text: '@alpha wake' });
    await flush();
    const line = text(A);
    expect(line).toContain('@alpha wake');
    expect(line).toContain('"fresh"');
    expect(line).not.toContain('"n44"');
  });

  it('long held messages never push the message that wakes the member out of its line', async () => {
    const id = await room();
    const big = 'x'.repeat(900);
    for (let i = 0; i < 6; i++) await post(id, { text: `${big}${i}` });
    await post(id, { text: '@alpha short wake-up' });
    await flush();
    expect(panes(A)).toHaveLength(1);
    expect(text(A)).toContain('@alpha short wake-up');
    expect(service.delivery.pendingFor(A)).toBe(0);
    // the newest held messages were kept, the oldest dropped
    expect(text(A)).toContain(`${big}5`);
    expect(text(A)).not.toContain(`${big}0`);
    // and the member is told that some were left out
    expect(text(A)).toMatch(/SYSTEM: \d+ earlier messages? not shown \(read them with reverie agent chat read\)/);
  });

  it('says nothing about omissions when nothing was dropped, and counts each drop once', async () => {
    const id = await room();
    await post(id, { text: 'one quiet note' });
    await post(id, { text: '@alpha wake' });
    await flush();
    expect(text(A)).not.toContain('not shown');
    for (const who of [A, B, C]) panes(who).length = 0;
    clock += 10_000;
    for (let i = 0; i < MAX_PASSIVE_PER_SESSION + 3; i++) await post(id, { text: `m${i}` });
    await post(id, { text: '@alpha again' });
    await flush();
    expect(text(A)).toContain('3 earlier messages not shown');
    for (const who of [A, B, C]) panes(who).length = 0;
    clock += 10_000;
    await post(id, { text: '@alpha once more' });
    await flush();
    expect(text(A)).not.toContain('not shown');
  });

  it('the owner always wakes someone who is there: a coordinator that is gone or is not a chat pane is not counted', async () => {
    const id = await room();
    ctx.sessions.delete(C); // the coordinator's session is gone
    await post(id, { text: 'is anyone there?' });
    await flush();
    expect(text(A)).toContain('is anyone there?');
    expect(text(B)).toContain('is anyone there?');
    for (const who of [A, B]) panes(who).length = 0;
    // a coordinator that is a plain shell cannot take chat either
    const shell = createMockSession(C);
    shell.name = 'lead';
    (shell as unknown as { mode: string }).mode = 'shell';
    ctx.sessions.set(C, shell as never);
    clock += 10_000;
    await post(id, { text: 'second try' });
    await flush();
    expect(text(A)).toContain('second try');
    // when the message names someone who is there, only that member is woken
    for (const who of [A, B]) panes(who).length = 0;
    clock += 10_000;
    await post(id, { text: '@bravo only you' });
    await flush();
    expect(text(B)).toContain('@bravo only you');
    expect(panes(A)).toEqual([]);
  });

  it('an agent that writes to the room is not turned into a wake-up of everyone when the coordinator is gone', async () => {
    const id = await room();
    ctx.sessions.delete(C);
    await post(id, { text: 'status note, nobody mentioned' }, B);
    await flush();
    expect(panes(A)).toEqual([]);
  });

  it('@all and @here are plain text now: only @everyone wakes everyone', async () => {
    const id = await room();
    await post(id, { text: '@all quick one' }, B);
    await post(id, { text: 'heads up @here' }, B);
    await flush();
    expect(panes(A)).toEqual([]);
    clock += 10_000;
    await post(id, { text: '@everyone quick one' }, B);
    await flush();
    expect(text(A)).toContain('@everyone quick one');
  });

  it('the room to answer is the one whose message woke the member, not the rooms of the held ones', async () => {
    const one = await room('One');
    const two = await room('Two');
    await post(one, { text: 'quiet note in one' });
    await post(two, { text: '@alpha you in two' });
    await flush();
    expect(text(A)).toContain('quiet note in one');
    expect(service.delivery.lastDeliveryRooms(A)?.roomIds).toEqual([two]);
  });
});

describe('wakeRecipients', () => {
  const member = (sessionId: string, role?: 'coordinator') => ({ sessionId, role, name: sessionId }) as never;
  const room = (coordinator?: string): ChatRoom =>
    ({ id: 'r', name: 'R', wake: 'mentions', members: [member(A, coordinator === A ? 'coordinator' : undefined), member(B, coordinator === B ? 'coordinator' : undefined), member(C, coordinator === C ? 'coordinator' : undefined)], messages: [] }) as never;
  const msg = (t: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
    ({ id: 'm', at: 1, from: { kind: 'user', name: 'user' }, to: 'all', text: t, ...extra }) as never;
  const nameOf = (id: string) => names2.get(id) ?? id;
  const names2 = new Map([[A, 'alpha'], [B, 'bravo'], [C, 'lead']]);
  const woken = (r: ChatRoom, m: ChatMessage, env: Record<string, string> = {}) => [...wakeRecipients(r, m, [A, B, C], nameOf, env)].sort();

  it('wakes the coordinator and the mentioned, everyone for @everyone, and honours REVERIE_CHAT_WAKE=all', () => {
    expect(woken(room(C), msg('hi'))).toEqual([C]);
    expect(woken(room(C), msg('hi @alpha'))).toEqual([A, C].sort());
    expect(woken(room(C), msg('@everyone hi'))).toEqual([A, B, C].sort());
    expect(woken(room(C), msg('hi'), { REVERIE_CHAT_WAKE: 'all' })).toEqual([A, B, C].sort());
    expect(woken(room(), msg('hi'))).toEqual([A, B, C].sort());
  });

  it('wakes nobody when the coordinator wrote it and mentioned no one (they all read it next time)', () => {
    const fromCoordinator = msg('plan', { from: { kind: 'agent', sessionId: C, name: 'lead' } } as never);
    expect(wakeRecipients(room(C), fromCoordinator, [A, B], nameOf, {})).toEqual(new Set());
  });

  it('wakes every recipient of an addressed message, a direct message, a poll and a system line', () => {
    expect(woken(room(C), msg('x', { to: [A] } as never))).toEqual([A, B, C].sort());
    expect(woken({ ...room(C), kind: 'dm', dm: ['user', A] } as never, msg('x'))).toEqual([A, B, C].sort());
    expect(woken(room(C), msg('x', { poll: { question: 'q', options: [] } } as never))).toEqual([A, B, C].sort());
    expect(woken(room(C), msg('x', { from: { kind: 'system', name: 's' } } as never))).toEqual([A, B, C].sort());
  });
});

describe('a room decides how it wakes its members', () => {
  const m = (sessionId: string, role?: 'coordinator') => ({ sessionId, role, name: sessionId }) as never;
  const baseRoom = (wake?: 'all' | 'mentions'): ChatRoom =>
    ({ id: 'r', name: 'R', ...(wake ? { wake } : {}), members: [m(A), m(B), m(C, 'coordinator')], messages: [] }) as never;
  const post = { id: 'p', at: 1, from: { kind: 'user', name: 'user' }, to: 'all', text: 'hi' } as never as ChatMessage;
  const nm = (id: string) => id;
  const who = (r: ChatRoom, env: Record<string, string> = {}) => [...wakeRecipients(r, post, [A, B, C], nm, env)].sort();

  it('a room with no setting wakes everyone, as before, unless the console default is mentions', () => {
    expect(who(baseRoom())).toEqual([A, B, C].sort());
    expect(who(baseRoom(), { REVERIE_CHAT_WAKE: 'mentions' })).toEqual([C]);
  });

  it('a room set to mentions wakes only the coordinator and the mentioned; one set to all wakes everyone even when the default is mentions', () => {
    expect(who(baseRoom('mentions'))).toEqual([C]);
    expect(who(baseRoom('all'), { REVERIE_CHAT_WAKE: 'mentions' })).toEqual([A, B, C].sort());
  });

  it('the briefing teaches the wake rules only in a room that wakes by mention, and always how to answer once', () => {
    const plain = buildBriefing(baseRoom('all'), baseRoom('all').members[0], nm);
    const quiet = buildBriefing(baseRoom('mentions'), baseRoom('mentions').members[0], nm);
    for (const text of [plain, quiet]) expect(text).toContain('post ONE reply with a single reverie agent chat say and end your turn');
    expect(plain).not.toContain('You are woken by a message that @mentions you');
    expect(quiet).toContain('You are woken by a message that @mentions you');
  });

  it('wakes every reachable member when the owner writes and nobody the message is for can be reached; an agent never triggers that', () => {
    const live = new Set([A, B]);
    const reach = (id: string) => live.has(id);
    const owner = [...wakeRecipients(baseRoom('mentions'), post, [A, B, C], nm, {}, reach)].sort();
    expect(owner).toEqual([A, B].sort());
    const agentPost = { ...post, from: { kind: 'agent', sessionId: A, name: 'a' } } as never as ChatMessage;
    // the agent's post still goes only to the coordinator it is for; nobody else is woken in its place
    expect([...wakeRecipients(baseRoom('mentions'), agentPost, [B, C], nm, {}, reach)]).toEqual([C]);
    // a reachable coordinator is still the only one woken
    const all = (id: string) => id !== 'zzz';
    expect([...wakeRecipients(baseRoom('mentions'), post, [A, B, C], nm, {}, all)]).toEqual([C]);
  });

  it('the briefing does not tell agents they are woken only by mention when the kill switch is set', () => {
    const before = process.env.REVERIE_CHAT_WAKE;
    try {
      process.env.REVERIE_CHAT_WAKE = 'all';
      expect(buildBriefing(baseRoom('mentions'), baseRoom('mentions').members[0], nm)).not.toContain('You are woken by a message that @mentions you');
    } finally {
      if (before === undefined) delete process.env.REVERIE_CHAT_WAKE;
      else process.env.REVERIE_CHAT_WAKE = before;
    }
  });

  it('the kill switch wakes everyone in every room, whatever a room says', () => {
    expect(who(baseRoom('mentions'), { REVERIE_CHAT_WAKE: 'all' })).toEqual([A, B, C].sort());
  });
});

describe('the wake setting of a room', () => {
  const names = new Map([[A, 'alpha'], [B, 'bravo'], [C, 'lead']]);
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let file: string;
  let clock: number;
  const panes = (id: string): string[] => (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer;

  beforeEach(async () => {
    clock = 1_000_000;
    file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
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

  const make = async (name: string) =>
    (await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name, members: [{ sessionId: A }, { sessionId: B }, { sessionId: C }], coordinatorSessionId: C } })).json().data.id as string;
  const setWake = (id: string, mode: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: `/api/chatrooms/${id}/wake`, headers, payload: { mode } });
  const settle = async () => {
    clock += 10_000;
    await service.delivery.flushAll();
    for (const id of names.keys()) panes(id).length = 0;
  };

  it('is set by the owner only, shows in the room view, validates the mode, and is cleared by default', async () => {
    const id = await make('Fleet');
    expect((await setWake(id, 'mentions', { 'x-codeman-parent-session': A })).statusCode).toBe(403);
    expect((await setWake(id, 'sometimes')).statusCode).toBe(400);
    expect((await setWake('nope', 'mentions')).statusCode).toBe(404);
    const set = await setWake(id, 'mentions');
    expect(set.statusCode).toBe(200);
    expect(set.json().data.wake).toBe('mentions');
    expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}` })).json().data.wake).toBe('mentions');
    expect((await setWake(id, 'default')).json().data.wake).toBeUndefined();
  });

  it('applies to its own room only: the quiet room holds, the control room still wakes everyone', async () => {
    const quiet = await make('Quiet');
    const control = await make('Control');
    await settle();
    await settle(); // two briefings are longer than one line: the rest follows
    await setWake(quiet, 'mentions');
    await app.inject({ method: 'POST', url: `/api/chatrooms/${quiet}/messages`, payload: { text: 'to the quiet room' } });
    clock += 10_000;
    await service.delivery.flushAll();
    // the quiet room woke only its coordinator
    expect(panes(A)).toEqual([]);
    expect(panes(C).join('')).toContain('to the quiet room');
    // the control room still wakes everyone, and the held message of the quiet room comes along with it
    await app.inject({ method: 'POST', url: `/api/chatrooms/${control}/messages`, payload: { text: 'to the control room' } });
    clock += 10_000;
    await service.delivery.flushAll();
    expect(panes(A).join('')).toContain('to the control room');
    expect(panes(A).join('')).toContain('to the quiet room');
    expect(panes(B).join('')).toContain('to the control room');
    // going back to all wakes everyone at once
    for (const id of names.keys()) panes(id).length = 0;
    await setWake(quiet, 'all');
    await app.inject({ method: 'POST', url: `/api/chatrooms/${quiet}/messages`, payload: { text: 'now everyone' } });
    clock += 10_000;
    await service.delivery.flushAll();
    expect(panes(B).join('')).toContain('now everyone');
  });

  it('is kept when the console restarts, and a direct message refuses it', async () => {
    const id = await make('Fleet');
    await setWake(id, 'mentions');
    await service.stop();
    const again = new ChatroomService({ file, getSession: (sid) => ctx.sessions.get(sid), broadcast: () => {}, now: () => clock });
    await again.init();
    expect(again.room(id)?.wake).toBe('mentions');
    await again.stop();
    const dm = (await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } })).json().data;
    expect((await setWake(dm.id, 'mentions')).statusCode).toBe(409);
  });
});

describe('what a full queue keeps', () => {
  const pane = () => {
    const writes: string[] = [];
    return { id: 'p', name: 'p', mode: 'claude', isWorking: false, pid: 1, writes, writeViaMux: async (d: string) => (writes.push(d), true) };
  };
  const R = { id: 'room-1', name: 'One' };

  it('drops held context first: 70 waking messages and 40 held ones keep every waking one', async () => {
    let clock = 1_000_000;
    const p = pane();
    p.isWorking = true;
    const delivery = new ChatroomDelivery({ getSession: () => p, now: () => clock });
    for (let i = 0; i < 70; i++) delivery.enqueue('p', R, `"a": "w${i}"`, { messageId: `w${i}` });
    for (let i = 0; i < 40; i++) delivery.enqueue('p', R, `"a": "h${i}"`, { messageId: `h${i}`, passive: true });
    expect(delivery.pendingFor('p')).toBe(100);
    p.isWorking = false;
    clock += 60_000;
    await delivery.flushAll();
    const line = p.writes.join('');
    for (const i of [0, 1, 35, 69]) expect(line).toContain(`"w${i}"`);
    expect(line).not.toContain('"h0"'); // the oldest held ones are the ones that went
    expect(line).toContain('"h39"');
    expect(line).toMatch(/SYSTEM: \d+ earlier messages? not shown/);
  });

  it('only drops the oldest waking message when nothing held is left, as the bound always did', async () => {
    const p = pane();
    p.isWorking = true;
    const delivery = new ChatroomDelivery({ getSession: () => p, now: () => 1_000_000 });
    for (let i = 0; i < 105; i++) delivery.enqueue('p', R, `"a": "w${i}"`, { messageId: `w${i}` });
    expect(delivery.pendingFor('p')).toBe(100);
  });

  it('long waking messages are never pushed out of the line by held context', async () => {
    let clock = 1_000_000;
    const p = pane();
    p.isWorking = true;
    const delivery = new ChatroomDelivery({ getSession: () => p, now: () => clock });
    const big = 'x'.repeat(900);
    for (let i = 0; i < 40; i++) delivery.enqueue('p', R, `"a": "h${i} ${'y'.repeat(60)}"`, { messageId: `h${i}`, passive: true });
    for (let i = 0; i < 3; i++) delivery.enqueue('p', R, `"u": "wake${i} ${big}"`, { messageId: `w${i}` });
    p.isWorking = false;
    clock += 60_000;
    await delivery.flushAll();
    expect(p.writes).toHaveLength(1);
    for (let i = 0; i < 3; i++) expect(p.writes[0]).toContain(`wake${i} `);
    expect(delivery.pendingFor('p')).toBe(0);
  });
});

