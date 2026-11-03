import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDb } from '../src/chat-db.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, setPolicy } from '../src/owner-auth/admin.js';
import { registerOwnerPolicy, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/index.js';
import { agent, createHarness, member, message, room, user } from './helpers/chat-app-harness.mjs';
import type { ChatRoom, ChatMessage } from '../src/chatroom-store.js';

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'message-search-')); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const msg = (r: string, id: string, text = 'needle mission', at = 1): ChatMessage => ({ roomId: r, id, at, text, from: { kind: 'user', name: 'Tester' }, to: 'all' });
const channel = (id: string, messages: ChatMessage[]): ChatRoom => ({ id, name: id, createdAt: 1, userReadAt: 0, members: [], messages });

describe('indexed channel search', () => {
  it('pages whole history around, before and after a message, with tombstones as the chat shows them', () => {
    const db = ChatDb.open(join(temp(), 'chat.db'));
    try {
      const a = channel('a', Array.from({ length: 1120 }, (_, i) => msg('a', `m${String(i).padStart(4, '0')}`, `message ${i}`, i + 1)));
      a.messages[59] = { ...a.messages[59], text: '', deleted: { at: 5, by: 'user', attachments: [{ id: 'f', name: 'f.txt', size: 1, type: 'text/plain' }] } } as ChatMessage;
      db.sync([a], 1000);
      const ids = (page: { messages: ChatMessage[] } | undefined) => page?.messages.map(m => m.id) ?? [];
      // m0010 left memory at the 1000-message rollover; its page still comes from the database.
      const around = db.historyWindow('a', 'm0010', { older: 25, newer: 25, include: true })!;
      expect(ids(around)).toEqual(Array.from({ length: 36 }, (_, i) => `m${String(i).padStart(4, '0')}`));
      expect([around.olderMore, around.newerMore]).toEqual([false, true]);
      const older = db.historyWindow('a', 'm0100', { older: 50, newer: 0, include: false })!;
      expect(ids(older)).toEqual(Array.from({ length: 50 }, (_, i) => `m${String(i + 50).padStart(4, '0')}`));
      expect([older.olderMore, older.newerMore]).toEqual([true, true]);
      const tombstone = older.messages.find(m => m.id === 'm0059')!;
      expect(tombstone.deleted).toEqual({ at: 5, by: 'user' }); expect(tombstone.text).toBe('');
      const newest = db.historyWindow('a', 'm1100', { older: 0, newer: 50, include: false })!;
      expect(ids(newest)).toEqual(Array.from({ length: 19 }, (_, i) => `m${i + 1101}`));
      expect(newest.newerMore).toBe(false);
      // A deleted message is a page anchor like any other, shown as its tombstone.
      expect(db.historyWindow('a', 'm0059', { older: 0, newer: 0, include: true })?.messages).toEqual([tombstone]);
      expect(ids(db.historyWindow('a', 'm0059', { older: 0, newer: 1, include: false }))).toEqual(['m0060']);
      expect(db.historyWindow('a', 'missing', { older: 1, newer: 1, include: false })).toBeUndefined();
    } finally { db.close(); }
  });

  it('finds archived messages after memory rollover/restart, excludes unauthorized rooms and changes/deletes', () => {
    const file = join(temp(), 'chat.db'); let db = ChatDb.open(file);
    const a = channel('a', [msg('a', 'old'), ...Array.from({ length: 1001 }, (_, i) => msg('a', `later-${i}`, 'ordinary', i + 2))]);
    const b = channel('b', [msg('b', 'secret')]);
    db.sync([a, b], 1000);
    expect(a.messages.some(m => m.id === 'old')).toBe(false);
    expect(db.searchMessages(['a'], 'needle').hits.map(m => m.id)).toEqual(['old']);
    expect(db.searchMessages(['a'], 'need').hits.map(m => m.id)).toEqual(['old']);
    db.close(); db = ChatDb.open(file);
    try {
      expect(db.historyWindow('a', 'old', { older: 5, newer: 5, include: true })?.messages[0].id).toBe('old');
      expect(db.searchMessages(['a'], 'needle').hits.some(m => m.id === 'secret')).toBe(false);
      b.messages[0].text = 'changed'; db.sync([a, b], 1000);
      expect(db.searchMessages(['b'], 'needle').hits).toEqual([]);
      b.messages[0].deleted = { at: 9, by: 'user' }; db.sync([a, b], 1000);
      expect(db.searchMessages(['b'], 'changed').hits).toEqual([]);
      expect(db.historyWindow('b', 'secret', { older: 5, newer: 5, include: true })?.messages).toMatchObject([{ id: 'secret', deleted: { at: 9 } }]);
    } finally { db.close(); }
  });

  it('bounds large excerpts/context, skips removed-room history and preserves tied cross-room sources', () => {
    const db = ChatDb.open(join(temp(), 'chat.db'));
    try {
      const a = channel('a', [msg('a', 'same', 'needle ' + 'x'.repeat(1100000))]);
      const b = channel('b', [msg('b', 'same', 'needle')]);
      db.sync([a, b], 1000);
      const page = db.searchMessages(['a', 'b'], 'needle');
      expect(page.hits).toHaveLength(2); expect(page.hits[0].roomId).toBe('b');
      expect(page.hits.every(hit => hit.text.length <= 2000)).toBe(true);
      const prepare = vi.spyOn(db.db, 'prepare');
      expect(() => db.historyWindow('a', 'same', { older: 5, newer: 5, include: true })).toThrow('bounded response');
      expect(prepare.mock.calls.some(([query]) => query.startsWith('SELECT data'))).toBe(false);
      prepare.mockRestore();
      expect(db.searchMessages(['a', 'b'], 'needle', { at: 1, id: 'same', roomId: 'b' }).hits.map(hit => hit.roomId)).toEqual(['a']);
      db.sync([a], 1000);
      // The route supplies only current room IDs; retained removed-room DB rows never expand that set.
      expect(db.searchMessages(['a'], 'needle').hits.every(hit => hit.roomId === 'a')).toBe(true);
    } finally { db.close(); }
  });

  it('uses exclusive tied-time cursor pages, bounds context and treats query operators literally', () => {
    const db = ChatDb.open(join(temp(), 'chat.db'));
    try {
      db.sync([channel('a', Array.from({ length: 65 }, (_, i) => msg('a', String(i).padStart(3, '0'))))], 1000);
      const first = db.searchMessages(['a'], 'needle');
      const second = db.searchMessages(['a'], 'needle', first.next!);
      const third = db.searchMessages(['a'], 'needle', second.next!);
      expect([first.hits.length, second.hits.length, third.hits.length]).toEqual([30, 30, 5]);
      expect(new Set([...first.hits, ...second.hits, ...third.hits].map(m => m.id)).size).toBe(65);
      expect(first.hits[0].text.length).toBeLessThanOrEqual(2000);
      expect(third.next).toBeNull(); expect(db.historyWindow('a', '032', { older: 5, newer: 5, include: true })?.messages).toHaveLength(11);
      expect(db.searchMessages(['a'], 'needle OR never').hits).toEqual([]);
      expect(db.searchMessages(['a'], '" OR *')).not.toBeUndefined();
      expect(() => db.searchMessages(['a'], '***')).toThrow();
      expect(() => db.searchMessages(['a'], 'word '.repeat(13))).toThrow();
      expect(db.searchMessages([], 'needle').hits).toEqual([]);
    } finally { db.close(); }
  });
});

describe('human search route', () => {
  it('reports unavailable instead of pretending an uninitialized/JSON-only store has no historical matches', async () => {
    const chat = new ChatroomService({ file: join(temp(), 'chatrooms.json'), database: false, getSession: () => undefined, broadcast: () => {} });
    await chat.init();
    try {
      expect(() => chat.searchMessages([], 'needle')).toThrow('requires the chat database');
      expect(() => chat.historyPage('room', 'source', 'around')).toThrow('requires the chat database');
    } finally { await chat.stop(); }
  });

  it('runs the real enforced owner-cookie middleware and preserves cross-owner visibility', async () => {
    vi.stubEnv('REVERIE_MULTIUSER', '1');
    const dir = temp(); const store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    const { oneTimePassword } = await bootstrap(store, 'search-owner');
    await setPolicy(store, 'enforce', { forceLockoutRisk: true });
    const auth = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl') });
    let chat!: ChatroomService;
    const h = await createRouteTestHarness((app, ctx) => {
      registerOwnerPolicy(app, { service: auth, ctx, isCapabilityRequest: () => false,
        relations: { known: id => ctx.sessions.has(id), related: (a, b) => a === b, upward: () => false, keeper: () => false, admin: () => false } });
      registerOwnerRoutes(app, auth, false);
      chat = new ChatroomService({ file: join(dir, 'chatrooms.json'), database: join(dir, 'chat.db'), getSession: id => ctx.sessions.get(id), broadcast: () => {} });
      registerChatroomRoutes(app, ctx, chat, new ChatFileStore(join(dir, 'files')), ownerVerifier({ service: auth, ctx }));
    }, { authUser: { username: 'alice', role: 'user' } });
    await chat.init();
    try {
      const a = chat.createRoom('mine', 'alice'), b = chat.createRoom('foreign', 'bob');
      const own = chat.post(a.id, { kind: 'user', name: 'Owner' }, 'needle visible', 'all', { deliver: false });
      chat.post(b.id, { kind: 'user', name: 'Other' }, 'needle private', 'all', { deliver: false });
      const login = await h.app.inject({ method: 'POST', url: '/api/owner/login', payload: { username: 'search-owner', password: oneTimePassword } });
      const first = login.cookies.find(cookie => cookie.name === OWNER_COOKIE)!.value;
      expect((await h.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle' })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle', cookies: { [OWNER_COOKIE]: first } })).statusCode).toBe(403);
      const changed = await h.app.inject({ method: 'POST', url: '/api/owner/password', headers: { origin: 'http://localhost' }, cookies: { [OWNER_COOKIE]: first }, payload: { current: oneTimePassword, next: 'synthetic-Quasar!8-lantern' } });
      expect(changed.statusCode).toBe(200);
      const cookies = { [OWNER_COOKIE]: changed.cookies.find(cookie => cookie.name === OWNER_COOKIE)!.value };
      const result = await h.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle', cookies });
      expect(result.statusCode).toBe(200); expect(result.json().data.hits.map((hit: { id: string }) => hit.id)).toEqual([own.id]);
      expect((await h.app.inject({ method: 'GET', url: `/api/chatrooms/search?q=needle&roomId=${a.id}`, cookies })).json().data.hits.map((hit: { id: string }) => hit.id)).toEqual([own.id]);
      expect((await h.app.inject({ method: 'GET', url: `/api/chatrooms/search?q=needle&roomId=${b.id}`, cookies })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: `/api/chatrooms/${b.id}/history/anything?page=around`, cookies })).statusCode).toBe(404);
      const feature = await h.app.inject({ method: 'GET', url: '/api/chatrooms', cookies }); expect(feature.json().data.features.search).toBe(true);
      // Real limited-account policy executes before the route even when global owner enforcement is off.
      const originalSession = auth.session.bind(auth);
      const sessionFixture = vi.spyOn(auth, 'session').mockImplementation(token => token === 'synthetic-limited' ? { restricted: false, role: 'limited' } : originalSession(token));
      await setPolicy(store, 'off');
      for (const url of ['/api/chatrooms/search?q=needle', `/api/chatrooms/${a.id}/history/${own.id}?page=around`]) {
        const limited = await h.app.inject({ method: 'GET', url, cookies: { [OWNER_COOKIE]: 'synthetic-limited' } });
        expect(limited.statusCode).toBe(403); expect(limited.json().error).toContain('limited channel access');
      }
      sessionFixture.mockRestore();
    } finally { await chat.stop(); await h.app.close(); }
  });

  it('refuses agent/service headers and never advances read, ACK or handling state', async () => {
    const dir = temp(); let service!: ChatroomService; let zone = 'America/New_York';
    const harness = await createRouteTestHarness((app, ctx) => {
      service = new ChatroomService({ file: join(dir, 'chatrooms.json'), database: join(dir, 'chat.db'), getSession: id => ctx.sessions.get(id), broadcast: () => {}, timeZone: () => zone });
      registerChatroomRoutes(app, ctx, service, new ChatFileStore(join(dir, 'files')), trustedFixtureOwner);
    });
    await service.init();
    try {
      const r = service.createRoom('search me', undefined);
      const m = service.post(r.id, { kind: 'user', name: 'Owner' }, 'needle <img src=x onerror=alert(1)>', 'all', { deliver: false });
      const before = JSON.stringify(service.room(r.id));
      const result = await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle' });
      expect(result.statusCode).toBe(200); expect(result.json().data.timeZone).toBe('America/New_York'); expect(result.json().data.hits[0].id).toBe(m.id);
      const context = await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${r.id}/history/${m.id}?page=around` });
      expect(context.statusCode).toBe(200); expect(context.json().data.messages[0].text).toContain('<img');
      expect(JSON.stringify(service.room(r.id))).toBe(before);
      zone = 'invalid-zone';
      expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle' })).json().data.timeZone).toBe('UTC');
      expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=x&before=bad' })).statusCode).toBe(400);
      expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=x&unexpected=yes' })).statusCode).toBe(400);
      for (const query of ['', '?page=sideways', '?page=around&limit=999'])
        expect((await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${r.id}/history/${m.id}${query}` })).statusCode).toBe(400);
      const newer = await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${r.id}/history/${m.id}?page=newer` });
      expect(newer.json().data).toMatchObject({ roomId: r.id, messageId: m.id, messages: [], newerMore: false });
      const sid = '0000002d-0035-4000-8000-000000000047'; harness.ctx.sessions.set(sid, createMockSession(sid) as never);
      for (const headers of [{ 'x-reverie-parent-session': sid }, { 'x-reverie-service-token': 'bad' }, { 'x-reverie-parent-session': 'missing' }]) {
        expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle', headers })).statusCode).toBe(403);
        expect((await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${r.id}/history/${m.id}?page=around`, headers })).statusCode).toBe(403);
      }
    } finally { await service.stop(); await harness.app.close(); }
  });
});

const fixtures = () => [room('r1', 'Office', [member('s1', 'Agent')]), room('r2', 'Project', [])];
describe('real chat search pane', () => {
  it('renders hostile results as text and closes accessibly without touching the draft or read state', async () => {
    const h = await createHarness({ rooms: fixtures(), features: { search: true } });
    try {
      const input = h.app._chatEls.input; input.value = 'unsent draft'; const readsBefore = h.server.reads.length;
      const original = h.app._chatApi.bind(h.app); const calls: string[] = [];
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (path.startsWith('/api/chatrooms/search?')) { calls.push(path); return { ok: true, data: { hits: [{ id: 'archived', roomId: 'r2', roomName: 'Project', sender: 'Owner', at: 1, text: '<img src=x onerror=alert(1)> needle' }], next: null } }; }
        return original(path, opts);
      };
      (h.document.querySelector('.ca-head-search') as HTMLButtonElement).click();
      const state = h.shell.messageSearch; state.input.value = 'needle'; await h.shell.runMessageSearch();
      expect(state.results.textContent).toContain('<img'); expect(state.results.querySelector('img')).toBeNull(); expect(state.results.querySelector('mark')?.textContent).toBe('needle');
      expect([...state.results.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Jump']);
      expect(h.app._chatEls.input).toBe(input); expect(input.value).toBe('unsent draft');
      expect(calls).toHaveLength(1); expect(h.server.posts).toHaveLength(0);
      state.pane.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(h.shell.messageSearch).toBeNull(); expect(h.document.activeElement?.classList.contains('ca-head-search')).toBe(true);
      expect(h.server.reads).toHaveLength(readsBefore);
    } finally { h.dom.window.close(); }
  });

  it('Jump rewinds the main chat to a message it does not hold, then back to the present', async () => {
    // The live room holds h12 but not h11: the rewind must not hand back to it before reaching the room's end.
    const live = [message('h12', 'r2', agent('s1', 'Agent'), 'text h12', 1132), message('n1', 'r2', agent('s1', 'Agent'), 'newest', 5000)];
    const h = await createHarness({ rooms: [room('r1', 'Office', [member('s1', 'Agent')]), room('r2', 'Project', [member('s1', 'Agent')], { messages: live, messageCount: 2 })], features: { search: true, unread: true } });
    try {
      const page = (ids: string[], more: { olderMore: boolean; newerMore: boolean }) =>
        ({ ok: true, data: { messages: ids.map((id, i) => message(id, 'r2', agent('s1', 'Agent'), `text ${id}`, 1000 + Number(id.slice(1)) * 10 + i)), ...more } });
      const original = h.app._chatApi.bind(h.app); const history: string[] = [];
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (path.includes('/history/')) {
          history.push(path);
          if (path.endsWith('page=around')) return page(['h10', 'h11', 'h12'], { olderMore: true, newerMore: true });
          if (path.endsWith('page=older')) return page(['h08', 'h09'], { olderMore: false, newerMore: true });
          return page(['h13'], { olderMore: true, newerMore: false });
        }
        return original(path, opts);
      };
      const readsBefore = h.server.reads.length;
      await h.shell.jumpTo('h11', 'r2');
      expect(h.shell.roomId).toBe('r2');
      expect(history).toEqual(['/api/chatrooms/r2/history/h11?page=around']);
      const drawn = () => [...h.document.querySelectorAll('.chatroom-feed [data-msg-id]')].map(n => (n as HTMLElement).dataset.msgId);
      expect(drawn()).toEqual(['h10', 'h11', 'h12']);
      expect(h.document.querySelector('[data-msg-id="h11"]')?.classList.contains('is-flash')).toBe(true);
      const bar = h.document.querySelector('.ca-jump-bar') as HTMLElement;
      expect(bar.hidden).toBe(false); expect(bar.textContent).toContain("You're viewing older messages");
      // Someone else's new message waits in the live room; the rewound feed keeps its place and nothing is marked read.
      const incoming = message('n2', 'r2', agent('s1', 'Agent'), 'while away', 6000);
      h.shell.handleMessage({ roomId: 'r2', message: incoming });
      expect(drawn()).toEqual(['h10', 'h11', 'h12']); expect(h.shell.room.messages.at(-1).id).toBe('n2');
      h.shell.rooms.find((r: { id: string }) => r.id === 'r2').unread = 1;
      await h.shell.markRead(); expect(h.server.reads).toHaveLength(readsBefore);
      await h.app._loadOlderChat(); // what reaching the top of the feed calls
      expect(drawn()).toEqual(['h08', 'h09', 'h10', 'h11', 'h12']);
      await h.app._loadOlderChat(); expect(history).toHaveLength(2); // no older history left
      await h.shell.extendHistory('newer');
      expect(drawn()).toEqual(['h08', 'h09', 'h10', 'h11', 'h12', 'h13']);
      // Past the last stored message the live room is the rest: the next step down rejoins it.
      await h.shell.extendHistory('newer');
      expect(h.shell.historyView()).toBeNull(); expect(drawn()).toEqual(['h12', 'n1', 'n2']);
      await h.shell.jumpTo('h11', 'r2');
      (bar.querySelector('button') as HTMLButtonElement).click();
      expect(h.shell.historyView()).toBeNull(); expect(drawn()).toEqual(['h12', 'n1', 'n2']); expect(bar.hidden).toBe(true);
      // A message the feed already draws is shown in place, without asking the server.
      const asked = history.length; await h.shell.jumpTo('n1', 'r2');
      expect(history).toHaveLength(asked); expect(h.shell.historyView()).toBeNull();
      // The reader's own message brings a rewound feed back to the present; another room drops the rewind.
      await h.shell.jumpTo('h11', 'r2');
      h.shell.handleMessage({ roomId: 'r2', message: message('n3', 'r2', user, 'mine', 7000) });
      expect(h.shell.historyView()).toBeNull(); expect(drawn()).toContain('n3');
      await h.shell.jumpTo('h11', 'r2'); await h.shell.selectRoom('r1'); await h.shell.selectRoom('r2');
      expect(h.shell.historyView()).toBeNull();
      await h.flush();
    } finally { h.dom.window.close(); }
  });

  it('only the latest jump applies: a return to the present or another room opening retires a pending answer', async () => {
    const live = [message('n1', 'r2', agent('s1', 'Agent'), 'newest', 5000)];
    const h = await createHarness({ rooms: [room('r1', 'Office', [member('s1', 'Agent')]), room('r2', 'Project', [member('s1', 'Agent')], { messages: live, messageCount: 1 })], features: { search: true } });
    try {
      // Each history request waits until the test answers it, so answers can arrive late or out of order.
      const original = h.app._chatApi.bind(h.app); const pending = new Map<string, (value: unknown) => void>();
      h.app._chatApi = (path: string, opts: unknown) => {
        const hit = path.match(/\/history\/([^?]+)\?page=around/);
        if (!hit) return original(path, opts);
        return new Promise(resolve => pending.set(hit[1], resolve));
      };
      const answer = async (id: string) => {
        pending.get(id)!({ ok: true, data: { messages: [message(id, 'r2', agent('s1', 'Agent'), `text ${id}`, 100)], olderMore: true, newerMore: true } });
        pending.delete(id); await h.flush(5);
      };
      const drawn = () => [...h.document.querySelectorAll('.chatroom-feed [data-msg-id]')].map(n => (n as HTMLElement).dataset.msgId);
      await h.shell.selectRoom('r2');
      // Jump to present while the answer is on its way: the live room stays.
      const first = h.shell.jumpTo('a1', 'r2'); await h.flush(5);
      h.shell.leaveHistory(); await answer('a1'); await first;
      expect(h.shell.historyView()).toBeNull(); expect(drawn()).toEqual(['n1']);
      // The same while already rewound.
      await (async () => { const jump = h.shell.jumpTo('a2', 'r2'); await h.flush(5); await answer('a2'); await jump; })();
      expect(drawn()).toEqual(['a2']);
      const third = h.shell.jumpTo('a3', 'r2'); await h.flush(5);
      h.shell.leaveHistory(); await answer('a3'); await third;
      expect(h.shell.historyView()).toBeNull(); expect(drawn()).toEqual(['n1']);
      // Two jumps answered in reverse order: the later one wins.
      const older = h.shell.jumpTo('b1', 'r2'); const newer = h.shell.jumpTo('b2', 'r2'); await h.flush(5);
      await answer('b2'); await answer('b1'); await Promise.all([older, newer]);
      expect(drawn()).toEqual(['b2']);
      // Leaving the room and coming back before the answer: it no longer applies.
      h.shell.leaveHistory();
      const away = h.shell.jumpTo('c1', 'r2'); await h.flush(5);
      await h.shell.selectRoom('r1'); await h.shell.selectRoom('r2');
      await answer('c1'); await away;
      expect(h.shell.historyView()).toBeNull(); expect(drawn()).toEqual(['n1']);
      await h.flush();
    } finally { h.dom.window.close(); }
  });

  it('a rewound page shows what the room now holds after a delete or edit, here or in another tab', async () => {
    const old = message('old', 'r1', agent('s1', 'Agent'), 'retained original text', 100);
    const latest = message('latest', 'r1', agent('s1', 'Agent'), 'present', 1000);
    const h = await createHarness({ rooms: [room('r1', 'Office', [member('s1', 'Agent')], { messages: [old, latest] })], features: { search: true, deletes: true, edits: true } });
    try {
      // The history route reads the fake server's current copy, as the real one reads the database.
      const original = h.app._chatApi.bind(h.app); const asked: string[] = [];
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (!path.includes('/history/')) return original(path, opts);
        asked.push(path);
        return { ok: true, data: { messages: [structuredClone(h.server.rooms[0].messages.find((m: { id: string }) => m.id === 'old'))], olderMore: false, newerMore: true } };
      };
      h.window.confirm = () => true;
      // Archived: the live room no longer holds it, so Jump rewinds.
      h.app._chatRoom.messages = h.app._chatRoom.messages.filter((m: { id: string }) => m.id !== 'old');
      h.shell.renderFeed();
      await h.shell.jumpTo('old');
      await h.shell.saveEdit(h.shell.historyView().messages[0], 'corrected text');
      expect(h.app._chatEls.feed.textContent).toContain('corrected text');
      expect(h.app._chatEls.feed.textContent).not.toContain('retained original text');
      // Another tab edits it again: the room's changed refresh brings the page along.
      h.server.rooms[0].messages.find((m: { id: string }) => m.id === 'old').text = 'edited elsewhere';
      await h.app._loadChatRoom('r1', { quiet: true });
      expect(h.app._chatEls.feed.textContent).toContain('edited elsewhere');
      await h.shell.deleteMessage(h.shell.historyView().messages[0]);
      expect(h.shell.historyView()?.messages.map((m: { id: string; deleted?: unknown }) => [m.id, !!m.deleted])).toEqual([['old', true]]);
      expect(h.app._chatEls.feed.textContent).not.toContain('edited elsewhere');
      // A refresh still on its way when the reader returns to the present does not rewind again.
      let release!: () => void;
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (!path.includes('/history/')) return original(path, opts);
        await new Promise<void>(done => { release = done; });
        return { ok: true, data: { messages: [structuredClone(old)], olderMore: false, newerMore: true } };
      };
      const reload = h.app._loadChatRoom('r1', { quiet: true }); await h.flush(5);
      h.shell.leaveHistory(); release(); await reload;
      expect(h.shell.historyView()).toBeNull(); expect(asked.length).toBeGreaterThan(1);
      // Nor does it replace a newer jump that landed first.
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (!path.includes('/history/')) return original(path, opts);
        if (path.includes('/history/newer-target')) return { ok: true, data: { messages: [message('newer-target', 'r1', agent('s1', 'Agent'), 'newer jump', 50)], olderMore: true, newerMore: true } };
        await new Promise<void>(done => { release = done; });
        return { ok: true, data: { messages: [structuredClone(old)], olderMore: false, newerMore: true } };
      };
      h.shell.history = { roomId: 'r1', messages: [structuredClone(old)], olderMore: false, newerMore: true, busy: false };
      const late = h.app._loadChatRoom('r1', { quiet: true }); await h.flush(5);
      await h.shell.jumpTo('newer-target'); release(); await late;
      expect(h.shell.historyView()?.messages.map((m: { id: string }) => m.id)).toEqual(['newer-target']);
      await h.flush();
    } finally { h.dom.window.close(); }
  });

  it('a jump whose page was on its way while the room reloaded asks again', async () => {
    const old = message('old', 'r1', agent('s1', 'Agent'), 'text before the change', 100);
    const latest = message('latest', 'r1', agent('s1', 'Agent'), 'present', 1000);
    const h = await createHarness({ rooms: [room('r1', 'Office', [member('s1', 'Agent')], { messages: [old, latest] })], features: { search: true, deletes: true } });
    try {
      const toasts: string[] = []; h.shell.toast = (text: string) => { toasts.push(text); };
      // The live room no longer holds it (it was archived), so Jump has to rewind.
      const archive = () => { h.app._chatRoom.messages = h.app._chatRoom.messages.filter((m: { id: string }) => m.id !== 'old'); h.shell.renderFeed(); };
      const serverCopy = () => h.server.rooms[0].messages.find((m: { id: string }) => m.id === 'old');
      // The first answer was formed before another tab's change; later ones read the room as it now is.
      const original = h.app._chatApi.bind(h.app); let release!: () => void; let asked = 0; let reloadEachTime = false;
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (!path.includes('/history/')) return original(path, opts);
        const snapshot = structuredClone(serverCopy());
        if (asked++ === 0) await new Promise<void>(done => { release = done; });
        if (reloadEachTime) await h.app._loadChatRoom('r1', { quiet: true });
        return { ok: true, data: { messages: [snapshot], olderMore: false, newerMore: true } };
      };
      const change = async (edit: (m: { text: string; deleted?: unknown }) => void) => {
        archive(); asked = 0; const jump = h.shell.jumpTo('old'); await h.flush(5);
        edit(serverCopy()); await h.app._loadChatRoom('r1', { quiet: true });
        release(); await jump; return asked;
      };
      // Edited elsewhere: the jump shows the edited text.
      expect(await change(m => { m.text = 'edited elsewhere'; })).toBe(2);
      expect(h.app._chatEls.feed.textContent).toContain('edited elsewhere');
      expect(h.app._chatEls.feed.textContent).not.toContain('text before the change');
      // Deleted elsewhere: the jump is refused instead of drawing the old text.
      h.shell.leaveHistory();
      expect(await change(m => { m.text = ''; m.deleted = { at: 2000, by: 'user' }; })).toBe(2);
      expect(h.shell.historyView()).toBeNull(); expect(toasts.at(-1)).toBe('That message is no longer available');
      expect(h.app._chatEls.feed.textContent).not.toContain('text before the change');
      // A room that keeps reloading: after a few tries the reader is told, nothing stale is drawn.
      serverCopy().deleted = undefined; serverCopy().text = 'restored'; reloadEachTime = true; asked = 1;
      archive(); await h.shell.jumpTo('old');
      expect(asked).toBe(5); expect(h.shell.historyView()).toBeNull();
      expect(toasts.at(-1)).toBe('The chat changed while loading. Try again.');
      await h.flush();
    } finally { h.dom.window.close(); }
  });

  it('a page loaded on scroll is dropped when the room reloaded on its way, even if the rewind could not refresh', async () => {
    const h = await createHarness({ rooms: fixtures(), features: { search: true } });
    try {
      h.shell.toast = () => {};
      const original = h.app._chatApi.bind(h.app); let release!: () => void; let refreshFails = false;
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (!path.includes('/history/')) return original(path, opts);
        if (path.endsWith('page=older')) {
          await new Promise<void>(done => { release = done; });
          return { ok: true, data: { messages: [message('stale', 'r1', agent('s1', 'Agent'), 'older page from before', 1)], olderMore: false, newerMore: true } };
        }
        if (refreshFails) return { ok: false, error: 'Search unavailable' };
        return { ok: true, data: { messages: [message('mid', 'r1', agent('s1', 'Agent'), 'middle', 5)], olderMore: true, newerMore: true } };
      };
      await h.shell.jumpTo('mid');
      const older = h.shell.extendHistory('older'); await h.flush(5);
      refreshFails = true; await h.app._loadChatRoom('r1', { quiet: true });
      release(); await older;
      expect(h.shell.historyView()?.messages.map((m: { id: string }) => m.id)).toEqual(['mid']);
      await h.flush();
    } finally { h.dom.window.close(); }
  });

  it('a reply to a message the feed no longer holds jumps through history; a gone one is reported', async () => {
    const h = await createHarness({ rooms: fixtures(), features: { search: true } });
    try {
      const original = h.app._chatApi.bind(h.app); const toasts: string[] = [];
      h.shell.toast = (text: string) => { toasts.push(text); };
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (path.includes('/history/gone')) return { ok: false, error: 'Message is no longer available' };
        if (path.includes('/history/tomb')) return { ok: true, data: { messages: [message('tomb', 'r1', agent('s1', 'Agent'), '', 6, { deleted: { at: 7, by: 'user' } })], olderMore: false, newerMore: true } };
        if (path.includes('/history/')) return { ok: true, data: { messages: [message('old', 'r1', agent('s1', 'Agent'), 'parent', 5)], olderMore: false, newerMore: true } };
        return original(path, opts);
      };
      await h.shell.jumpTo('gone');
      expect(toasts).toEqual(['Message is no longer available']); expect(h.shell.historyView()).toBeNull();
      // A deleted message comes back as its tombstone; it is not a place to jump to.
      await h.shell.jumpTo('tomb');
      expect(toasts.at(-1)).toBe('That message is no longer available'); expect(h.shell.historyView()).toBeNull();
      await h.shell.jumpTo('old');
      expect(h.shell.historyView()?.messages.map((m: { id: string }) => m.id)).toEqual(['old']);
      // Without server search (an older server) nothing is asked for.
      h.shell.leaveHistory(); h.app._chatFeatures.search = false; const asked = toasts.length;
      await h.shell.jumpTo('old');
      expect(toasts.slice(asked)).toEqual(['That message is no longer available']); expect(h.shell.historyView()).toBeNull();
      await h.flush();
    } finally { h.dom.window.close(); }
  });

  it('ignores late results after query/scope change and after closing; errors clear previous result content', async () => {
    const h = await createHarness({ rooms: fixtures(), features: { search: true } });
    try {
      h.shell.openMessageSearch(); const state = h.shell.messageSearch;
      let resolve!: (value: unknown) => void;
      h.app._chatApi = () => new Promise(done => { resolve = done; });
      state.input.value = 'old'; const pending = h.shell.runMessageSearch();
      state.scope.value = 'r2'; state.scope.dispatchEvent(new h.window.Event('change'));
      resolve({ ok: true, data: { hits: [{ text: 'stale secret' }], next: null } }); await pending;
      expect(state.results.textContent).not.toContain('stale');
      state.input.value = 'new'; const closed = h.shell.runMessageSearch(); h.shell.closeMessageSearch();
      resolve({ ok: true, data: { hits: [{ text: 'late' }], next: null } }); await closed;
      expect(h.document.querySelector('.ca-message-search')).toBeNull();
      h.shell.openMessageSearch(); const fresh = h.shell.messageSearch; fresh.input.value = 'new'; fresh.results.textContent = 'previous';
      h.app._chatApi = async () => ({ ok: false, error: 'Access changed' }); await h.shell.runMessageSearch();
      expect(fresh.results.textContent).toBe(''); expect(fresh.status.textContent).toBe('Access changed');
    } finally { h.dom.window.close(); }
  });

  it('hides search for older servers and closes it on page/permission transition', async () => {
    const h = await createHarness({ rooms: fixtures(), features: {} });
    try {
      expect((h.document.querySelector('.ca-head-search') as HTMLButtonElement).hidden).toBe(true);
      h.app._chatFeatures.search = true; h.shell.renderHeader(); h.shell.openMessageSearch();
      h.shell.embed = 'board'; h.shell.renderHeader(); expect(h.shell.messageSearch).toBeNull();
    } finally { h.dom.window.close(); }
  });
});
