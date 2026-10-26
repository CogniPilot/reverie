/**
 * @fileoverview Owner marks on chat messages (owner-auth/marks.ts): only a user post from a request
 * with a valid, unrestricted owner session cookie and no agent header is marked `owner_typed`
 * (`owner_spoken` for speech), with the owner policy OFF. Everything else carries no mark, a client
 * cannot supply one, and the mark survives save/load and room history. Synthetic fixtures only.
 * Port: N/A (app.inject(); a loopback fake for the voice service).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { loadChatrooms, type ChatMessage, type ChatSender } from '../../src/chatroom-store.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { registerVoiceTurnRoutes } from '../../src/web/routes/voice-turn-routes.js';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { OwnerAuthService } from '../../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../../src/owner-auth/routes.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../../src/owner-auth/policy.js';
import { ownerVerifier } from '../../src/owner-auth/marks.js';
import * as admin from '../../src/owner-auth/admin.js';
import type { SessionPort } from '../../src/web/ports/session-port.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const USER = 'owner-test';
const NEW_PASSWORD = 'synthetic-correct-horse-42';
const ALPHA = '0000002d-0035-4000-8000-000000000047';
const BETA = '00000038-0043-4000-8000-000000000060';

describe('chatroom owner marks', () => {
  let dir: string;
  let file: string;
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let auth: OwnerAuthService;
  let upstream: http.Server;
  let roomId: string;
  let store: OwnerAuthStore;
  let owner: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owner-marks-'));
    file = join(dir, 'chatrooms.json');
    store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    const oneTime = (await admin.bootstrap(store, USER)).oneTimePassword;
    await admin.setPolicy(store, 'off'); // as deployed: the policy is off, the cookie still verifies
    auth = new OwnerAuthService({ store, auditFile: join(dir, 'owner-auth-audit.jsonl') });
    expect(auth.policy()).toBe('off');

    upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transcript: 'status of r1 please', reply: 'All green.' }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const harness = await createRouteTestHarness((fastify, c) => {
      const deps = { service: auth, ctx: c as unknown as SessionPort };
      registerOwnerPolicy(fastify, {
        ...deps,
        isCapabilityRequest: () => false,
        relations: { known: () => true, related: (a, b) => a === b, upward: () => false, keeper: () => false } as never,
      });
      registerOwnerRoutes(fastify, auth, false);
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {} });
      const verifiedOwner = ownerVerifier(deps);
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(join(dir, 'files')), verifiedOwner,
        undefined, undefined, { messageOwner: id => auth.isMessageOwner(id) });
      registerVoiceTurnRoutes(fastify, service, { serviceUrl: () => base, diagDir: () => join(dir, 'diag'), verifiedOwner, replyWaitMs: 2000 });
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [
      [ALPHA, 'alpha'],
      [BETA, 'beta'],
    ] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
    roomId = service.createRoom('r1', undefined).id;
    service.addMember(roomId, ALPHA, { voice: true });
    service.addMember(roomId, BETA);

    owner = await signIn(oneTime, NEW_PASSWORD);
  });

  /** Sign in with a one-time password (a restricted session), then change it: a full owner session. */
  async function signIn(oneTime: string, next: string): Promise<string> {
    const first = await app.inject({ method: 'POST', url: '/api/owner/login', payload: { username: USER, password: oneTime } });
    const limited = first.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTime, next },
      cookies: { [OWNER_COOKIE]: limited },
    });
    expect(changed.statusCode).toBe(200);
    return changed.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  }
  /** A host password reset: every session ends, the next sign-in is restricted until a change. */
  async function restrictedSession(): Promise<string> {
    const reset = await admin.resetPassword(store);
    const res = await app.inject({ method: 'POST', url: '/api/owner/login', payload: { username: USER, password: reset } });
    expect(res.json().data.next).not.toBe('done');
    return res.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  }

  afterEach(async () => {
    await service.stop();
    await app.close();
    await new Promise((r) => upstream.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const post = (opts: { cookie?: string; agent?: string; payload?: Record<string, unknown> } = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text: 'hello r1', ...opts.payload },
      ...(opts.cookie !== undefined ? { cookies: { [OWNER_COOKIE]: opts.cookie } } : {}),
      ...(opts.agent ? { headers: { 'x-reverie-parent-session': opts.agent } } : {}),
    });
  const sent = (res: { statusCode: number; json: () => { data: { message: ChatMessage } } }) => {
    expect(res.statusCode).toBe(200);
    return res.json().data.message;
  };
  const markOf = (m: ChatMessage) => (m.from as { mark?: string }).mark;

  it('carries server-verified owner authority through exact/history reads to the real coding gate', async () => {
    const posted = sent(await post({ cookie: owner }));
    const headers = { 'x-reverie-parent-session': ALPHA };
    const exact = await app.inject({ url: `/api/chatrooms/${roomId}/messages/${posted.id}`, headers });
    expect(exact.statusCode).toBe(200);
    const message = exact.json().data.message;
    expect(message.from.authenticatedOwner).toBe(true);
    const history = await app.inject({ url: `/api/chatrooms/${roomId}/messages`, headers });
    expect(history.json().data.messages.find((m: ChatMessage) => m.id === posted.id).from.authenticatedOwner).toBe(true);
    expect(service.room(roomId)!.messages.find(m => m.id === posted.id)!.from).not.toHaveProperty('authenticatedOwner');
    const python = spawnSync('python3', ['-I', '-c',
      'import json,sys; sys.path.insert(0,sys.argv[1]); from coding_tasks import permitted_sender; m=json.load(sys.stdin); print(json.dumps(permitted_sender({"tasks":{"workspace":{"rooms":[m["roomId"]]}}},m["roomId"],"workspace",m)))',
      fileURLToPath(new URL('../../../../python/reverie/hands', import.meta.url))],
      { input: JSON.stringify(message), encoding: 'utf8', timeout: 5000 });
    expect(python.status, python.stderr).toBe(0);
    expect(JSON.parse(python.stdout)).toBe(true);
  });

  it('never turns an unmarked, limited-human or agent message into owner authority', async () => {
    expect((await post({ payload: { authenticatedOwner: true, mark: 'owner_typed' } })).statusCode).toBe(403);
    const unsigned = service.post(roomId, { kind: 'user', name: 'Owner' }, 'legacy unmarked request', 'all', { deliver: false });
    const limited = service.post(roomId, { kind: 'human', name: 'Owner', humanId: 'limited', access: 'limited' }, 'request', 'all', { deliver: false });
    expect((await post({ cookie: owner, agent: ALPHA, payload: { authenticatedOwner: true, mark: 'owner_typed' } })).statusCode).toBe(400);
    const agent = sent(await post({ cookie: owner, agent: ALPHA }));
    for (const item of [unsigned, limited, agent]) {
      const response = await app.inject({ url: `/api/chatrooms/${roomId}/messages/${item.id}`,
        headers: { 'x-reverie-parent-session': ALPHA } });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.message.from.authenticatedOwner).toBe(false);
    }
  });

  it('does not grant coding authority from a cached account when its current file is corrupt', async () => {
    const posted = sent(await post({ cookie: owner }));
    const headers = { 'x-reverie-parent-session': ALPHA };
    expect((await app.inject({ url: `/api/chatrooms/${roomId}/messages/${posted.id}`, headers })).json().data.message.from.authenticatedOwner).toBe(true);
    await writeFile(join(dir, 'owner-auth.json'), '{');
    expect((await app.inject({ url: `/api/chatrooms/${roomId}/messages/${posted.id}`, headers })).json().data.message.from.authenticatedOwner).toBe(false);
  });

  it('rechecks owner authority when reading a request after a password reset', async () => {
    const posted = sent(await post({ cookie: owner }));
    const headers = { 'x-reverie-parent-session': ALPHA };
    expect((await app.inject({ url: `/api/chatrooms/${roomId}/messages/${posted.id}`, headers })).json().data.message.from.authenticatedOwner).toBe(true);
    await restrictedSession();
    expect((await app.inject({ url: `/api/chatrooms/${roomId}/messages/${posted.id}`, headers })).json().data.message.from.authenticatedOwner).toBe(false);
    const history = await app.inject({ url: `/api/chatrooms/${roomId}/messages`, headers });
    expect(history.json().data.messages.find((m: ChatMessage) => m.id === posted.id).from.authenticatedOwner).toBe(false);
  });

  it('marks a verified owner post owner_typed, in history and after save/load', async () => {
    const message = sent(await post({ cookie: owner }));
    expect(message.from).toEqual({ kind: 'user', name: 'user', mark: 'owner_typed' });
    const history = await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/messages`, cookies: { [OWNER_COOKIE]: owner } });
    const row = (history.json().data.messages as ChatMessage[]).find((m) => m.id === message.id)!;
    expect(markOf(row)).toBe('owner_typed');
    await service.stop();
    const onDisk = JSON.parse(await readFile(file, 'utf-8'));
    const raw = onDisk[0].messages.find((m: ChatMessage) => m.id === message.id);
    expect(raw.from.mark).toBe('owner_typed');
    const reloaded = (await loadChatrooms(file))[0].messages.find((m) => m.id === message.id)!;
    expect(markOf(reloaded)).toBe('owner_typed');
  });

  it('marks a verified owner spoken message owner_spoken', async () => {
    const message = sent(await post({ cookie: owner, payload: { spoken: true } }));
    expect(markOf(message)).toBe('owner_spoken');
  });

  it('refuses a headerless caller without a cookie without storing a post', async () => {
    const before = service.room(roomId)!.messages.length;
    expect((await post()).statusCode).toBe(403);
    expect(service.room(roomId)!.messages.length).toBe(before);
  });

  it.each([
    ['a bad cookie', 'not-a-real-session-token'],
    ['an empty cookie', ''],
  ])('refuses %s without storing a post', async (_label, cookie) => {
    const before = service.room(roomId)!.messages.length;
    expect((await post({ cookie })).statusCode).toBe(403);
    expect(service.room(roomId)!.messages.length).toBe(before);
  });

  it('refuses a restricted or ended owner session', async () => {
    const restricted = await restrictedSession();
    expect(auth.session(restricted)).toEqual({ restricted: true });
    const before = service.room(roomId)!.messages.length;
    expect((await post({ cookie: restricted })).statusCode).toBe(403);
    expect((await post({ cookie: owner })).statusCode).toBe(403);
    expect(service.room(roomId)!.messages.length).toBe(before);
  });

  it('gives no mark to an agent header with a valid owner cookie', async () => {
    const message = sent(await post({ cookie: owner, agent: ALPHA }));
    expect(message.from).toEqual({ kind: 'agent', sessionId: ALPHA, name: 'alpha' });
    expect(markOf(message)).toBeUndefined();
  });

  it('ignores a client-supplied mark: the request is refused and nothing is stored', async () => {
    const before = service.room(roomId)!.messages.length;
    for (const payload of [{ mark: 'owner_typed' }, { from: { kind: 'user', name: 'user', mark: 'owner_typed' } }]) {
      for (const cookie of [undefined, owner]) {
        const res = await post({ payload, cookie });
        expect(res.statusCode).toBe(cookie ? 400 : 403);
      }
      const agent = await post({ payload, agent: BETA });
      expect(agent.statusCode).toBe(400);
    }
    expect(service.room(roomId)!.messages.length).toBe(before);
    expect(service.room(roomId)!.messages.some((m) => markOf(m) !== undefined)).toBe(false);
  });

  it('never keeps a mark on bot, agent, system or external senders, nor an unknown value', () => {
    const forged = (from: ChatSender) => ({ ...from, mark: 'owner_typed' }) as unknown as ChatSender;
    const bot = { id: 'bot-r1', name: 'ticker', rooms: [roomId], maxPerHour: 5 };
    const posts = [
      service.post(roomId, forged({ kind: 'agent', sessionId: BETA, name: 'beta' }), 'agent text'),
      service.post(roomId, forged({ kind: 'bot', botId: 'bot-r1', name: 'ticker' }), 'bot text'),
      service.post(roomId, forged({ kind: 'system', name: 'system' }), 'system text'),
      service.postAsBot(bot, roomId, 'bot again', 0),
      service.post(
        roomId,
        forged({ kind: 'external', name: 'ext', provider: 'slack', connectionId: 'c1', channelId: 'k1', userId: 'u1', messageId: 'm1' }),
        'imported text'
      ),
      service.post(roomId, { kind: 'user', name: 'user', mark: 'owner_root' } as unknown as ChatSender, 'odd mark'),
    ];
    for (const m of posts) expect(markOf(m), m.text).toBeUndefined();
    expect(service.room(roomId)!.messages.filter((m) => markOf(m) !== undefined)).toEqual([]);
  });

  it('refuses an unverified edit and preserves the verified text and mark', async () => {
    const kept = sent(await post({ cookie: owner }));
    const ownerEdit = await app.inject({
      method: 'PUT',
      url: `/api/chatrooms/${roomId}/messages/${kept.id}`,
      payload: { text: 'hello r1, edited' },
      cookies: { [OWNER_COOKIE]: owner },
    });
    expect(ownerEdit.statusCode).toBe(200);
    expect(markOf(service.room(roomId)!.messages.find((m) => m.id === kept.id)!)).toBe('owner_typed');
    const anonEdit = await app.inject({
      method: 'PUT',
      url: `/api/chatrooms/${roomId}/messages/${kept.id}`,
      payload: { text: 'forged words' },
    });
    expect(anonEdit.statusCode).toBe(403);
    const after = service.room(roomId)!.messages.find((m) => m.id === kept.id)!;
    expect(after.text).toBe('hello r1, edited');
    expect(markOf(after)).toBe('owner_typed');
  });

  it('marks a voice-turn transcript owner_spoken only for a verified owner; the reply never', async () => {
    // The voice member answers each spoken turn in the room, linked to it, as it would live.
    const off = service.onMessage((_room, m) => {
      if (m.from.kind === 'user' && m.spoken)
        setImmediate(() =>
          service.post(roomId, { kind: 'agent', sessionId: ALPHA, name: 'alpha' }, 'All green.', ['user'], {
            replyTo: m.id,
          })
        );
    });
    const turn = (cookie?: string) =>
      app.inject({
        method: 'POST',
        url: `/api/voice/turn?room=${roomId}&member=${ALPHA}`,
        headers: { 'content-type': 'audio/webm' },
        payload: Buffer.from('fake-audio'),
        ...(cookie !== undefined ? { cookies: { [OWNER_COOKIE]: cookie } } : {}),
      });
    const verified = await turn(owner);
    expect(verified.statusCode).toBe(200);
    const [heard, reply] = verified.json().data.messages as ChatMessage[];
    expect(heard.from).toEqual({ kind: 'user', name: 'user', mark: 'owner_spoken' });
    expect(reply.from.kind).toBe('agent');
    expect(markOf(reply)).toBeUndefined();
    for (const cookie of [undefined, 'not-a-real-session-token', await restrictedSession()]) {
      const res = await turn(cookie);
      expect(res.statusCode).toBe(200);
      for (const m of res.json().data.messages as ChatMessage[]) expect(markOf(m)).toBeUndefined();
    }
    off();
  });
});
