/**
 * The crossing guard and the owner's Clear history: a refusal shown to the owner lists only messages after their
 * cutoff, and a cursor at or before it counts as not in the room. Agents keep the full history, so their refusals
 * still list what the owner cleared. Both the database and the JSON store.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { OwnerAuthService } from '../../src/owner-auth/service.js';
import { OWNER_COOKIE } from '../../src/owner-auth/policy.js';
import { ownerVerifier } from '../../src/owner-auth/marks.js';

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


for (const database of [true, false]) describe(database ? 'guard cutoff database' : 'guard cutoff JSON', () => {
  it('owner crossing refusal never reintroduces messages hidden by the owner cutoff', async () => {
    const f = await fixture(database);
    f.setClock(2000);
    const hidden = f.service.post(f.dm.id, {kind:'agent', name:'alpha', sessionId:A}, 'HIDDEN-CROSSING-BEFORE-CLEAR');
    expect((await f.clear()).statusCode).toBe(200);
    expect((await f.get('/messages?since=0&limit=1000')).json().data.messages).toEqual([]);
    const before=structuredClone(f.dm.messages);
    const res=await f.app.inject({method:'POST',url:f.url+'/messages',cookies:f.cookies,
      payload:{text:'do not store my stale reply',ifNoNewerThan:f.old.id}});
    expect(res.statusCode).toBe(409);
    expect(f.dm.messages).toEqual(before);
    expect(res.body).not.toContain(hidden.text);
    expect(res.json().data.newer).toEqual([]);
  });
  it('after the cutoff the owner guard works as usual', async () => {
    const f = await fixture(database);
    f.setClock(2000);
    f.service.post(f.dm.id, { kind: 'agent', name: 'alpha', sessionId: A }, 'CLEARED-LINE');
    expect((await f.clear()).statusCode).toBe(200);
    f.setClock(3000);
    const fresh = f.service.post(f.dm.id, { kind: 'agent', name: 'alpha', sessionId: A }, 'FRESH-AFTER-CLEAR');
    const post = (text: string, ifNoNewerThan: string) =>
      f.app.inject({ method: 'POST', url: f.url + '/messages', cookies: f.cookies, payload: { text, ifNoNewerThan } });
    expect((await post('answer', fresh.id)).statusCode).toBe(200);
    f.setClock(4000);
    const later = f.service.post(f.dm.id, { kind: 'agent', name: 'alpha', sessionId: A }, 'LATER-AFTER-CLEAR');
    const res = await post('stale', fresh.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().data.newer.map((m: any) => m.id)).toEqual([later.id]);
    expect(res.body).not.toContain('CLEARED-LINE');
  });
  it('agent crossing refusal still retains the same old message for agent memory', async () => {
    const f = await fixture(database);
    f.setClock(2000);
    const hidden=f.service.post(f.dm.id,{kind:'user',name:'Owner'},'HIDDEN-OWNER-LINE-FOR-AGENT');
    expect((await f.clear()).statusCode).toBe(200);
    const res=await f.app.inject({method:'POST',url:f.url+'/messages',headers:{'x-reverie-parent-session':A},
      payload:{text:'do not store agent reply',ifNoNewerThan:f.old.id}});
    expect(res.statusCode).toBe(409);
    expect(res.json().data.newer.map((m: any)=>m.id)).toContain(hidden.id);
  });
});
