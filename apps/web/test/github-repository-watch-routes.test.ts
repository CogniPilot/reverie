import { registerChatBotRoutes } from '../src/web/routes/chat-bot-routes.js';
/** Real fixture owner cookies/classification; no instance credentials or network calls. */
import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { OWNER_COOKIE, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { ChatBotRegistry } from '../src/chat-bots.js';
import { BoardStore } from '../src/board-store.js';
import { registerBotWatches } from '../src/bot-watches-runtime.js';
import { PublicationCredentialVault } from '../src/publication-credentials.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import type { ChatroomService } from '../src/chatroom-service.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(multi = false) {
  const dir = await mkdtemp(join(tmpdir(), 'github-routes-')),
    store = new OwnerAuthStore(join(dir, 'auth.json')),
    first = (await bootstrap(store, 'fixture-owner')).oneTimePassword;
  const auth = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl') }),
    serviceToken = await issueServiceToken(store, 'fixture-service');
  const app = Fastify();
  await app.register(cookie);
  registerOwnerRoutes(app, auth, false);
  const bots = new ChatBotRegistry(join(dir, 'bots.json'));
  await bots.set('github', { name: 'GitHub', rooms: ['room'], maxPerHour: 30 });
  const board = new BoardStore(join(dir, 'board.json'));
  await board.init();
  const room = { id: 'room', name: 'Room', members: [], messages: [] };
  const ctx = { sessions: new Map() } as unknown as SessionPort;
  const vault = new PublicationCredentialVault(join(dir, 'vault'), { audit: () => {} });
  const runtime = await registerBotWatches(app, {
    dataPath: (n) => join(dir, n),
    bots,
    board,
    employees: () => [],
    running: () => false,
    multiUser: multi,
    verifiedOwner: ownerVerifier({ service: auth, ctx }),
    credentials: vault,
    chat: {
      room: () => room,
      rooms: () => [room],
      auditEntry: async () => {},
      adminPhoneWakeEnabled: true,
    } as unknown as ChatroomService,
  });
  registerChatBotRoutes(app, bots, ownerVerifier({ service: auth, ctx }), (id) => runtime.github.usesBot(id));
  await bots.set('unused', { name: 'Unused', rooms: ['room'], maxPerHour: 10 });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/owner/login',
    payload: { username: 'fixture-owner', password: first },
  });
  const updated = await app.inject({
    method: 'POST',
    url: '/api/owner/password',
    cookies: { [OWNER_COOKIE]: login.cookies.find((c) => c.name === OWNER_COOKIE)!.value },
    headers: { origin: 'http://localhost' },
    payload: { current: first, next: 'Fixture!private-owner-only-987' },
  });
  expect(updated.statusCode).toBe(200);
  const token = updated.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  const cfg = {
    id: 'repo',
    enabled: true,
    owner: 'owner',
    repo: 'repo',
    botId: 'github',
    roomId: 'room',
    visibility: 'public',
    intervalMinutes: 30,
    events: { issues: true, pullRequests: true, workflowFailures: true },
    credentialId: null,
  };
  return {
    app,
    auth,
    vault,
    token,
    serviceToken,
    cfg,
    headers: { origin: 'http://localhost' },
    cookies: { [OWNER_COOKIE]: token },
  };
}
it('actual unrestricted owner can configure/read CAS status; agents/services/cookie-header cannot', async () => {
  const f = await fixture();
  for (const options of [
    {},
    { headers: { 'x-reverie-parent-session': 'agent' } },
    { headers: { [SERVICE_HEADER]: f.serviceToken } },
    { cookies: f.cookies, headers: { 'x-reverie-parent-session': 'agent' } },
  ])
    for (const method of ['GET', 'PUT'] as const) {
      const r = await f.app.inject({
        method,
        url: '/api/bot-watches/github',
        ...options,
        ...(method === 'PUT' ? { payload: { version: 1, expectedRevision: 0, watches: [f.cfg] } } : {}),
      });
      expect(r.statusCode).toBe(403);
    }
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/bot-watches/github',
    cookies: f.cookies,
    headers: f.headers,
    payload: { version: 1, expectedRevision: 0, watches: [f.cfg] },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().data.revision).toBe(1);
  const read = await f.app.inject({ url: '/api/bot-watches/github', cookies: f.cookies });
  expect(read.headers['cache-control']).toBe('no-store');
  expect(read.json().data.watches[0].status.state).toBe('not-run');
  expect(read.json().data.watches[0]).not.toHaveProperty('scan');
  const stale = await f.app.inject({
    method: 'PUT',
    url: '/api/bot-watches/github',
    cookies: f.cookies,
    payload: { version: 1, expectedRevision: 0, watches: [f.cfg] },
  });
  expect(stale.statusCode).toBe(409);
});
it('malformed JSON and rejected extra command/token fields never echo submitted secret text', async () => {
  const f = await fixture(),
    secret = 'owned-synthetic-secret-not-a-real-PAT';
  for (const payload of [
    JSON.stringify({ version: 1, expectedRevision: 0, watches: [{ ...f.cfg, launchCommand: secret }] }),
    '{"credentialId":"' + secret + '" INVALID}',
  ]) {
    const r = await f.app.inject({
      method: 'PUT',
      url: '/api/bot-watches/github',
      cookies: f.cookies,
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(secret);
  }
});
it('multi-user remains unavailable even with an actual valid owner cookie', async () => {
  const f = await fixture(true);
  const r = await f.app.inject({ url: '/api/bot-watches/github', cookies: f.cookies });
  expect(r.statusCode).toBe(403);
});
it('private null-handle config is honestly auth-required and status never returns PAT material', async () => {
  const f = await fixture();
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/bot-watches/github',
    cookies: f.cookies,
    payload: { version: 1, expectedRevision: 0, watches: [{ ...f.cfg, visibility: 'private' }] },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().data.watches[0].status.state).toBe('auth-required');
  expect(saved.body).not.toContain('token:');
});

it('server refuses deleting a linked bot, allows unrelated bot and permits deletion after watch removal', async () => {
  const f = await fixture();
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/bot-watches/github',
    cookies: f.cookies,
    payload: { version: 1, expectedRevision: 0, watches: [f.cfg] },
  });
  expect(saved.statusCode).toBe(200);
  expect((await f.app.inject({ method: 'DELETE', url: '/api/chat-bots/github', cookies: f.cookies })).statusCode).toBe(
    409
  );
  expect((await f.app.inject({ method: 'DELETE', url: '/api/chat-bots/unused', cookies: f.cookies })).statusCode).toBe(
    200
  );
  expect(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/bot-watches/github',
        cookies: f.cookies,
        payload: { version: 1, expectedRevision: 1, watches: [] },
      })
    ).statusCode
  ).toBe(200);
  expect((await f.app.inject({ method: 'DELETE', url: '/api/chat-bots/github', cookies: f.cookies })).statusCode).toBe(
    200
  );
});
