import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { ChatDb, readArchive, standingLines } from '../../src/chat-db.js';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { OwnerAuthService } from '../../src/owner-auth/service.js';
import { OWNER_COOKIE } from '../../src/owner-auth/policy.js';
import { ownerVerifier } from '../../src/owner-auth/marks.js';
import { createHarness } from '../helpers/chat-app-harness.mjs';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
let auth: OwnerAuthService, token: string;
const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-cutoff-auth-'));
  auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(dir, 'auth.json')),
    auditFile: join(dir, 'audit.jsonl'),
    setupEnabled: true,
  });
  token = await auth.setup('synthetic-owner', 'tGr9!kP4mQ7#vZ2s', 'tGr9!kP4mQ7#vZ2s', '127.0.0.1');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const done of cleanup.splice(0).reverse()) await done();
});

async function fixture(database = true, multi = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-cutoff-'));
  const file = join(dir, 'rooms.json'),
    dbFile = join(dir, 'chat.db'),
    archiveDir = join(dir, 'archive');
  let clock = 1000;
  const events: Array<{ event: string; data: any }> = [];
  let service!: ChatroomService;
  const harness = await createRouteTestHarness(
    (app, ctx) => {
      service = new ChatroomService({
        file,
        ...(database ? { database: dbFile } : {}),
        archiveDir,
        getSession: (id) => ctx.sessions.get(id),
        now: () => clock,
        broadcast: (event, data) => events.push({ event, data }),
        deferDeliveryRecovery: true,
      });
      registerChatroomRoutes(
        app,
        ctx,
        service,
        new ChatFileStore(join(dir, 'files')),
        ownerVerifier({ service: auth, ctx }),
        undefined,
        (id) => id,
        { human: (req) => auth.identity(req.cookies?.[OWNER_COOKIE]) }
      );
    },
    multi ? { authUser: { username: 'alice', role: 'admin' } } : undefined
  );
  const { app, ctx } = harness;
  for (const id of [A, B]) {
    const session = createMockSession(id);
    session.name = id === A ? 'alpha' : 'bravo';
    if (multi) session.owner = 'alice';
    ctx.sessions.set(id, session as never);
  }
  await service.init();
  cleanup.push(async () => {
    await service.stop();
    await app.close();
  });
  const dm = service.openDm(A, multi ? 'alice' : undefined);
  const old = service.post(dm.id, { kind: 'agent', name: 'alpha', sessionId: A }, 'OLD-PRIVATE-HISTORY');
  const url = `/api/chatrooms/${dm.id}`;
  const cookies = { [OWNER_COOKIE]: token };
  const clear = (extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: url + '/clear-history', cookies, payload: {}, ...extra } as never);
  const get = (suffix = '', extra: Record<string, unknown> = {}) =>
    app.inject({ url: url + suffix, cookies, ...extra } as never);
  return {
    ...harness,
    service,
    dir,
    file,
    dbFile,
    archiveDir,
    dm,
    old,
    url,
    cookies,
    clear,
    get,
    events,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

for (const database of [true, false])
  describe(database ? 'durable database DM cutoff' : 'legacy JSON DM cutoff', () => {
    it('commits before ACK, hides history across devices/restart, and keeps stored messages unchanged', async () => {
      const f = await fixture(database);
      const before = structuredClone(f.dm.messages);
      const readAt = f.dm.userReadAt,
        pending = f.service.delivery.pendingFor(A),
        seen = f.service.lastSeen(A, f.dm.id);
      let rows: unknown;
      const snapshot = () => {
        const db = ChatDb.open(f.dbFile);
        try {
          return db.db.prepare('SELECT room_id,id,at,data FROM messages ORDER BY rowid').all();
        } finally {
          db.close();
        }
      };
      if (database) rows = snapshot();
      const response = await f.clear();
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        messages: [],
        messageCount: 0,
        unread: 0,
        mentions: 0,
        historyAfter: f.old.at,
        canClearHistory: true,
      });
      expect(f.dm.messages).toEqual(before);
      expect(f.dm.userReadAt).toBe(readAt);
      expect(f.service.lastSeen(A, f.dm.id)).toEqual(seen);
      expect(f.service.delivery.pendingFor(A)).toBe(pending);
      if (database) expect(snapshot()).toEqual(rows);
      else expect(JSON.parse(readFileSync(f.file, 'utf8'))[0].ownerHistoryAfter.owner).toBe(f.old.at);
      // An independent read uses no localStorage or device state.
      expect((await f.get('?since=0&limit=1000')).json().data.messages).toEqual([]);
      expect((await f.get('/messages?since=0&limit=1000')).json().data.messages).toEqual([]);
      const listed = (await f.app.inject({ url: '/api/chatrooms', cookies: f.cookies }))
        .json()
        .data.rooms.find((r: any) => r.id === f.dm.id);
      expect(listed.lastMessage).toBeNull();
      expect(listed.messageCount).toBe(0);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/chatrooms/dms',
            cookies: f.cookies,
            payload: { sessionId: A },
          })
        ).json().data.messages
      ).toEqual([]);
      const restored = new ChatroomService({
        file: f.file,
        ...(database ? { database: f.dbFile } : {}),
        archiveDir: f.archiveDir,
        getSession: (id) => f.ctx.sessions.get(id),
        broadcast: () => {},
        deferDeliveryRecovery: true,
      });
      await restored.init();
      cleanup.push(() => restored.stop());
      expect(restored.ownerView(restored.room(f.dm.id)!, 'owner').messages).toEqual([]);
      expect(restored.view(restored.room(f.dm.id)!).messages).toEqual(before);
    });
  });

describe('owner view boundary', () => {
  it('keeps cleared owner metadata on an admitted coordinator reset while channel-only mutations still refuse DMs', async () => {
    const f = await fixture();
    await f.clear();
    const resetCoordinator = () => f.app.inject({
      method: 'POST', url: f.url + '/coordinator', cookies: f.cookies, payload: { sessionId: null },
    });
    const cleared = await resetCoordinator();
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data).toMatchObject({
      messages: [], messageCount: 0, unread: 0, mentions: 0,
      canClearHistory: true, historyAfter: f.old.at,
    });
    f.setClock(2000);
    const next = f.service.post(f.dm.id, { kind: 'agent', sessionId: A, name: 'alpha' }, 'NEW-VISIBLE-MESSAGE');
    const after = await resetCoordinator();
    expect(after.statusCode).toBe(200);
    expect(after.json().data).toMatchObject({
      messages: [], messageCount: 1, unread: 1, canClearHistory: true, historyAfter: f.old.at,
    });
    expect(f.service.room(f.dm.id)!.messages.map(message => message.id)).toEqual([f.old.id, next.id]);
    const agent = await f.get('/messages', { cookies: {}, headers: { 'x-reverie-parent-session': A } });
    expect(agent.json().data.messages.map((message: any) => message.id)).toEqual([f.old.id, next.id]);
    expect(agent.json().data.historyAfter).toBeUndefined();
    for (const [suffix, payload] of [
      ['/placement', { workspace: 'test' }], ['/archive', { archived: true }],
      ['/visibility', { visibility: 'public' }], ['/wake', { mode: 'all' }],
    ] as const) {
      const refused = await f.app.inject({ method: 'PUT', url: f.url + suffix, cookies: f.cookies, payload });
      expect(refused.statusCode, suffix).toBe(409);
      expect(refused.json().success).toBe(false);
    }
    expect((await f.app.inject({ method: 'POST', url: f.url + '/join', cookies: f.cookies, payload: {} })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: f.url + '/join', headers: { 'x-reverie-parent-session': A }, payload: {} })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: f.url + '/coordinator', cookies: f.cookies, payload: { sessionId: A } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: f.url + '/coordinator', headers: { 'x-reverie-parent-session': A }, payload: { sessionId: null } })).statusCode).toBe(403);
  });
  it('clears through the actual owner route from the real UI and updates another device without deleting the agent history', async () => {
    const f = await fixture();
    const pages: any[] = [];
    try {
      for (let device = 0; device < 2; device++) {
        const page = await createHarness({
          sessions: [{ id: A, name: 'alpha', mode: 'claude' }],
          rooms: [f.service.ownerView(f.dm, 'owner')],
          narrow: device === 1,
        });
        pages.push(page);
        const original = page.app._api.bind(page.app);
        page.app._api = async (url: string, options: any = {}) => {
          if (!url.startsWith('/api/chatrooms')) return original(url, options);
          const result = await f.app.inject({
            method: options.method || 'GET',
            url,
            cookies: f.cookies,
            payload: options.body,
          });
          return { ok: result.statusCode < 400, status: result.statusCode, json: async () => result.json() };
        };
        await page.shell.selectRoom(f.dm.id);
        expect(page.document.body.textContent).toContain(f.old.text);
      }
      const first = pages[0];
      first.shell.clearDmHistory(f.dm.id);
      first.document.querySelector('dialog [aria-label="Clear history"]').click();
      await vi.waitFor(() => expect(first.app._chatRoom.messages).toEqual([]));
      const change = f.events.find((event) => event.data.action === 'history-cleared')!;
      expect(change).toBeDefined();
      pages[1].app._onChatroomChanged(change.data);
      expect(pages[1].app._chatRoom.messages).toEqual([]);
      for (const page of pages) expect(page.document.body.textContent).not.toContain(f.old.text);
      const agent = await f.get('/messages', { cookies: {}, headers: { 'x-reverie-parent-session': A } });
      expect(agent.json().data.messages[0].text).toBe(f.old.text);
      expect(f.service.room(f.dm.id)!.messages[0].text).toBe(f.old.text);
    } finally {
      for (const page of pages) page.window.close();
    }
  });
  it('keeps agent recent and exact reads intact, including hidden pinned messages', async () => {
    const f = await fixture();
    // Retained legacy pin data is still readable even though new DM pins are refused.
    f.dm.messages.find((message) => message.id === f.old.id)!.pinned = { kind: 'user', by: 'Owner', at: f.old.at };
    await f.clear();
    expect((await f.get('/pins')).json().data.pins).toEqual([]);
    const headers = { 'x-reverie-parent-session': A };
    const history = await f.get('/messages', { cookies: {}, headers });
    expect(history.json().data.messages[0].text).toBe(f.old.text);
    expect((await f.get('/messages/' + f.old.id, { cookies: {}, headers })).json().data.message.text).toBe(f.old.text);
    const room = (await f.get('', { cookies: {}, headers })).json().data;
    expect(room.historyAfter).toBeUndefined();
    expect(room.canClearHistory).toBeUndefined();
    expect(room.messages).toHaveLength(1);
    expect((await f.get('/pins', { cookies: {}, headers })).json().data.pins).toHaveLength(1);
    expect((await f.get('/messages/' + f.old.id)).statusCode).toBe(403);
  });
  it('shows new messages even with the same clock tick or a backward clock change; repeated clears advance only', async () => {
    const f = await fixture();
    await f.clear();
    f.setClock(0);
    const next = f.service.post(f.dm.id, { kind: 'agent', sessionId: A, name: 'alpha' }, 'new after clear');
    expect(next.at).toBeGreaterThan(f.old.at);
    expect((await f.get()).json().data.messages.map((m: any) => m.id)).toEqual([next.id]);
    expect((await f.get()).json().data.unread).toBe(1);
    await f.clear();
    expect((await f.get()).json().data.messages).toEqual([]);
    expect(f.dm.messages).toHaveLength(2);
  });
  it('uses separate identity cutoffs without affecting another owner identity or another DM', async () => {
    const f = await fixture();
    const other = f.service.openDm(B, undefined);
    const m = f.service.post(other.id, { kind: 'agent', sessionId: B, name: 'bravo' }, 'other DM');
    await f.clear();
    expect(f.service.ownerView(f.dm, 'another-owner').messages.map((m) => m.id)).toEqual([f.old.id]);
    expect(f.service.ownerView(other, 'owner').messages.map((m) => m.id)).toEqual([m.id]);
    expect(f.events.at(-1)?.data).toMatchObject({ action: 'history-cleared', viewerId: 'owner', roomId: f.dm.id });
  });
  it('rejects anonymous, service, agent and cookie-plus-agent/service writes even when policy is off', async () => {
    const f = await fixture();
    for (const extra of [
      { cookies: {} },
      { cookies: {}, headers: { 'x-reverie-parent-session': A } },
      { headers: { 'x-reverie-parent-session': A } },
      { headers: { 'x-reverie-service-token': 'synthetic' } },
      { cookies: {}, headers: { 'x-reverie-service-token': 'synthetic' } },
    ]) {
      expect((await f.clear(extra)).statusCode).toBe(403);
    }
    expect(f.dm.ownerHistoryAfter).toBeUndefined();
  });
  it('cannot clear a channel, an agent-only DM, or another company even as an administrator', async () => {
    vi.stubEnv('REVERIE_MULTIUSER', '1');
    const f = await fixture(true, true);
    const channel = f.service.createRoom('channel', 'alice');
    const otherCompany = f.service.openDm(B, 'bob');
    // A valid retained agent-only DM is not the owner's personal conversation.
    const agentOnly = f.service.createRoom('agent-only', 'alice');
    f.service.addMember(agentOnly.id, A);
    f.service.addMember(agentOnly.id, B);
    agentOnly.kind = 'dm';
    agentOnly.dm = [A, B];
    for (const id of [channel.id, otherCompany.id, agentOnly.id])
      expect((await f.clear({ url: `/api/chatrooms/${id}/clear-history` })).statusCode).toBe(403);
    expect((await f.clear()).statusCode).toBe(200);
  });
  it('rejects client-selected cutoffs and viewer identities', async () => {
    const f = await fixture();
    for (const payload of [{ historyAfter: 999999 }, { viewerId: 'another-owner' }, { delete: true }])
      expect((await f.clear({ payload })).statusCode).toBe(400);
    expect(f.dm.ownerHistoryAfter).toBeUndefined();
  });
  it('does not ACK or broadcast a failed database commit, and restores the old view', async () => {
    const f = await fixture();
    const db = (f.service as unknown as { db: ChatDb }).db;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'sync').mockImplementationOnce(() => {
      throw new Error('synthetic disk failure');
    });
    const before = f.events.length;
    expect((await f.clear()).statusCode).toBe(503);
    expect(f.events.slice(before).filter((e) => e.data.action === 'history-cleared')).toEqual([]);
    expect((await f.get()).json().data.messages[0].id).toBe(f.old.id);
  });
  it('archives only room metadata on clear; the message journal remains identical', async () => {
    const f = await fixture();
    const messages = () =>
      standingLines(readArchive(f.archiveDir).lines).filter(
        (line) => line.kind === undefined || line.kind === 'message'
      );
    const before = messages();
    await f.clear();
    expect(messages()).toEqual(before);
  });
  it('keeps zero-time history visible before a clear and does not hide a new first message in an empty DM', async () => {
    const f = await fixture();
    const empty = f.service.openDm(B, undefined);
    await f.service.clearOwnerHistory(empty.id, 'owner');
    f.setClock(0);
    const first = f.service.post(empty.id, { kind: 'agent', sessionId: B, name: 'bravo' }, 'first at zero');
    expect(first.at).toBe(0);
    expect(f.service.ownerView(empty, 'owner').messages[0].id).toBe(first.id);
    expect(f.service.ownerView(empty, 'another-owner').messages[0].id).toBe(first.id);
    await f.service.clearOwnerHistory(empty.id, 'owner');
    expect(f.service.ownerView(empty, 'owner').messages).toEqual([]);
  });
  it('returns a failure and restores the JSON view when its atomic file write fails', async () => {
    const f = await fixture(false);
    mkdirSync(f.file);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = f.events.length;
    expect((await f.clear()).statusCode).toBe(503);
    expect(f.events.slice(before).filter((e) => e.data.action === 'history-cleared')).toEqual([]);
    expect(f.service.room(f.dm.id)!.ownerHistoryAfter).toBeUndefined();
    expect((await f.get()).json().data.messages[0].id).toBe(f.old.id);
  });
});
