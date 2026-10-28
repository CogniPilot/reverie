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
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
import type { ChatRoom, ChatMessage } from '../src/chatroom-store.js';

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'message-search-')); roots.push(path); return path; };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const msg = (r: string, id: string, text = 'needle mission', at = 1): ChatMessage => ({ roomId: r, id, at, text, from: { kind: 'user', name: 'Tester' }, to: 'all' });
const channel = (id: string, messages: ChatMessage[]): ChatRoom => ({ id, name: id, createdAt: 1, userReadAt: 0, members: [], messages });

describe('indexed channel search', () => {
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
      expect(db.searchContext('a', 'old')?.[0].id).toBe('old');
      expect(db.searchMessages(['a'], 'needle').hits.some(m => m.id === 'secret')).toBe(false);
      b.messages[0].text = 'changed'; db.sync([a, b], 1000);
      expect(db.searchMessages(['b'], 'needle').hits).toEqual([]);
      b.messages[0].deleted = { at: 9, by: 'user' }; db.sync([a, b], 1000);
      expect(db.searchMessages(['b'], 'changed').hits).toEqual([]);
      expect(db.searchContext('b', 'secret')).toBeUndefined();
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
      expect(() => db.searchContext('a', 'same')).toThrow('bounded response');
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
      expect(third.next).toBeNull(); expect(db.searchContext('a', '032')).toHaveLength(11);
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
      expect(() => chat.searchContext('room', 'source')).toThrow('requires the chat database');
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
      expect((await h.app.inject({ method: 'GET', url: `/api/chatrooms/${b.id}/search-context/anything`, cookies })).statusCode).toBe(404);
      const feature = await h.app.inject({ method: 'GET', url: '/api/chatrooms', cookies }); expect(feature.json().data.features.search).toBe(true);
      // Real limited-account policy executes before the route even when global owner enforcement is off.
      const originalSession = auth.session.bind(auth);
      const sessionFixture = vi.spyOn(auth, 'session').mockImplementation(token => token === 'synthetic-limited' ? { restricted: false, role: 'limited' } : originalSession(token));
      await setPolicy(store, 'off');
      for (const url of ['/api/chatrooms/search?q=needle', `/api/chatrooms/${a.id}/search-context/${own.id}`]) {
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
      const context = await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${r.id}/search-context/${m.id}` });
      expect(context.statusCode).toBe(200); expect(context.json().data.messages[0].text).toContain('<img');
      expect(JSON.stringify(service.room(r.id))).toBe(before);
      zone = 'invalid-zone';
      expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle' })).json().data.timeZone).toBe('UTC');
      expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=x&before=bad' })).statusCode).toBe(400);
      expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=x&unexpected=yes' })).statusCode).toBe(400);
      const sid = '0000002d-0035-4000-8000-000000000047'; harness.ctx.sessions.set(sid, createMockSession(sid) as never);
      for (const headers of [{ 'x-reverie-parent-session': sid }, { 'x-reverie-service-token': 'bad' }, { 'x-reverie-parent-session': 'missing' }]) {
        expect((await harness.app.inject({ method: 'GET', url: '/api/chatrooms/search?q=needle', headers })).statusCode).toBe(403);
        expect((await harness.app.inject({ method: 'GET', url: `/api/chatrooms/${r.id}/search-context/${m.id}`, headers })).statusCode).toBe(403);
      }
    } finally { await service.stop(); await harness.app.close(); }
  });
});

const fixtures = () => [room('r1', 'Office', [member('s1', 'Agent')]), room('r2', 'Project', [])];
describe('real chat search pane', () => {
  it('keeps chat/draft mounted, renders hostile result as text, opens archived context and closes accessibly', async () => {
    const h = await createHarness({ rooms: fixtures(), features: { search: true } });
    try {
      const input = h.app._chatEls.input; input.value = 'unsent draft'; const readsBefore = h.server.reads.length;
      const original = h.app._chatApi.bind(h.app); const calls: string[] = [];
      h.app._chatApi = async (path: string, opts: unknown) => {
        if (path.startsWith('/api/chatrooms/search?')) { calls.push(path); return { ok: true, data: { hits: [{ id: 'archived', roomId: 'r2', roomName: 'Project', sender: 'Owner', at: 1, text: '<img src=x onerror=alert(1)> needle' }], next: null } }; }
        if (path.includes('/search-context/')) { calls.push(path); return { ok: true, data: { roomId: 'r2', roomName: 'Project', messages: [{ id: 'archived', sender: 'Owner', at: 1, text: 'original archived source' }] } }; }
        return original(path, opts);
      };
      (h.document.querySelector('.ca-head-search') as HTMLButtonElement).click();
      const state = h.shell.messageSearch; state.input.value = 'needle'; await h.shell.runMessageSearch();
      expect(state.results.textContent).toContain('<img'); expect(state.results.querySelector('img')).toBeNull(); expect(state.results.querySelector('mark')?.textContent).toBe('needle');
      expect(h.app._chatEls.input).toBe(input); expect(input.value).toBe('unsent draft');
      await h.shell.openSearchContext({ roomId: 'r2', id: 'archived' });
      expect(state.results.querySelector('[data-source-id="archived"]')?.textContent).toContain('original archived source');
      expect(h.shell.roomId).toBe('r1'); expect(input.value).toBe('unsent draft');
      expect(calls).toHaveLength(2); expect(h.server.posts).toHaveLength(0);
      state.pane.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(h.shell.messageSearch).toBeNull(); expect(h.document.activeElement?.classList.contains('ca-head-search')).toBe(true);
      expect(h.server.reads).toHaveLength(readsBefore);
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
