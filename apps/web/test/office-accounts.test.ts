import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerOwnerPolicy, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerOfficeRoutes } from '../src/web/routes/office-routes.js';
import { ChatroomStore, senderWithoutForgedMark, type ChatSender } from '../src/chatroom-store.js';
import type { ChatroomService } from '../src/chatroom-service.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { senderLabel } from '../src/chatroom-delivery.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { base32Decode, hotp, totpStep } from '../src/owner-auth/crypto.js';
import { unreadFor } from '../src/chatroom-store.js';
import { authenticatedPlanMover } from '../src/web/plan-move-auth.js';
import { AUTH_COOKIE_NAME } from '../src/web/middleware/auth.js';

const password = 'Synthetic-correct-harbor-42!';
let directory: string, app: FastifyInstance, auth: OfficeAuthService, store: OwnerAuthStore, rooms: ChatroomStore;
let primary: string, open: string, privateRoom: string, clock: number, oldBoundary: string | undefined;
const options = (cookieValue?: string, payload?: unknown): InjectOptions['headers'] => ({
  host: 'localhost',
  origin: 'http://localhost',
  ...(cookieValue ? { cookie: OWNER_COOKIE + '=' + cookieValue } : {}),
  ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
});
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token?: string,
  payload?: unknown,
  extra = {}
) {
  return app.inject({
    method,
    url,
    headers: { ...options(token, payload), ...extra },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}
const tokenOf = (response: Awaited<ReturnType<typeof call>>) => {
  const value = response.cookies.find((c) => c.name === OWNER_COOKIE)?.value;
  expect(value).toBeTruthy();
  return value!;
};
async function login(username: string, secret: string) {
  const signed = await call('POST', '/api/owner/login', undefined, { username, password: secret });
  expect(signed.statusCode, signed.body).toBe(200);
  return tokenOf(signed);
}
async function replacePassword(token: string, current: string) {
  const changed = await call('POST', '/api/owner/password', token, { current, next: password });
  expect(changed.statusCode, changed.body).toBe(200);
  return tokenOf(changed);
}
async function invite(role: 'limited' | 'owner' = 'limited', username = 'coworker') {
  const made = await call('POST', '/api/office/accounts', primary, { username, name: 'River', role, rooms: [open] });
  expect(made.statusCode, made.body).toBe(200);
  const record = made.json().data;
  const restricted = await login(username, record.oneTimePassword);
  return { ...record, restricted, token: await replacePassword(restricted, record.oneTimePassword) };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'office-accounts-'));
  clock = Date.now();
  oldBoundary = process.env.REVERIE_PASSWORD;
  process.env.REVERIE_PASSWORD = 'synthetic-boundary';
  store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  const initial = await bootstrap(store, 'fixture-owner', { enforce: true, now: clock });
  auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), now: () => clock }, () => ({
    name: 'Original Owner',
  }));
  rooms = new ChatroomStore();
  open = rooms.create('shared', undefined).id;
  privateRoom = rooms.create('private', undefined).id;
  const dm = rooms.create('dm fixture', undefined);
  dm.kind = 'dm';
  dm.dm = ['user', 'fixture-agent'];
  const chat = {
    rooms: () => rooms.list(),
    room: (id: string) => rooms.get(id),
    nameOf: () => 'Agent',
    post: (id: string, from: ChatSender, text: string) => rooms.post(id, from, text),
  } as unknown as ChatroomService;
  app = Fastify();
  await app.register(cookie);
  registerAuthMiddleware(app, false, '', auth);
  const ctx = {
    sessions: new Map([['fixture-agent', { id: 'fixture-agent', owner: undefined }]]),
  } as unknown as SessionPort;
  registerOwnerPolicy(app, {
    service: auth,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: () => true,
      related: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  registerOwnerRoutes(app, auth, false);
  registerOfficeRoutes(app, auth, chat);
  const owner = ownerVerifier({ service: auth, ctx });
  app.get('/', async () => 'full console');
  for (const path of [
    '/api/settings',
    '/api/events',
    '/api/company',
    '/api/filesystem/download',
    '/api/chatrooms',
    '/api/future/private',
    '/ws/terminal',
  ])
    app.get(path, async () => ({ sensitive: true }));
  app.post('/api/sessions/:id/input', async () => ({ sensitive: true }));
  app.get('/api/verified-owner-fixture', async (req) => ({ owner: owner(req) }));
  primary = await replacePassword(await login('fixture-owner', initial.oneTimePassword), initial.oneTimePassword);
});
afterEach(async () => {
  await app.close();
  if (oldBoundary === undefined) delete process.env.REVERIE_PASSWORD;
  else process.env.REVERIE_PASSWORD = oldBoundary;
  await rm(directory, { recursive: true, force: true });
});

it('requires a complete current account before granting message-owner authority', async () => {
  const original = await readFile(store.file, 'utf8');
  expect(auth.isMessageOwner('owner')).toBe(true);
  for (const invalid of [{}, { mustChange: false }, { version: 1, mustChange: false },
    { ...JSON.parse(original), password: {} }, { ...JSON.parse(original), mustChange: 'false' }]) {
    await writeFile(store.file, JSON.stringify(invalid));
    expect(auth.isMessageOwner('owner')).toBe(false);
  }
  await writeFile(store.file, original);
  expect(auth.isMessageOwner('owner')).toBe(true);
});

it('rechecks invited-owner roles from disk instead of cached office people', async () => {
  const person = await invite('owner');
  const file = join(directory, 'office-people.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  expect(auth.isMessageOwner(person.person.id)).toBe(true);
  original.people.find((p: { id: string }) => p.id === person.person.id).role = 'limited';
  await writeFile(file, JSON.stringify(original));
  expect(auth.isMessageOwner(person.person.id)).toBe(false);
  await writeFile(file, '{}');
  expect(auth.isMessageOwner(person.person.id)).toBe(false);
  expect(auth.isMessageOwner('owner')).toBe(true);
});

it('invites a channel-limited human, forces an individual password, and never marks that human as owner', async () => {
  const person = await invite();
  expect((await call('GET', '/api/office/me', person.restricted)).statusCode).toBe(401);
  expect(auth.identity(person.token)).toMatchObject({
    id: person.person.id,
    name: 'River',
    role: 'limited',
    primary: false,
  });
  expect(
    (await call('GET', '/api/office/rooms', person.token)).json().data.rooms.map((r: { id: string }) => r.id)
  ).toEqual([open]);
  expect((await call('GET', '/api/office/rooms/' + privateRoom, person.token)).statusCode).toBe(404);
  expect(
    (
      await call('POST', '/api/office/rooms/' + open + '/messages', person.token, {
        text: 'hello',
        from: { kind: 'user', mark: 'owner_typed' },
      })
    ).statusCode
  ).toBe(400);
  expect(
    (await call('POST', '/api/office/rooms/' + open + '/messages', person.token, { text: 'hello' })).statusCode
  ).toBe(200);
  const message = rooms.get(open)!.messages.at(-1)!;
  expect(message.from).toEqual({ kind: 'human', name: 'River', humanId: person.person.id, access: 'limited' });
  expect(senderLabel(message.from)).toContain('not the owner');
  expect(senderLabel(message.from)).not.toMatch(/^USER/);
  expect(senderWithoutForgedMark({ ...message.from, mark: 'owner_typed' } as ChatSender)).not.toHaveProperty('mark');
  const view = (await call('GET', '/api/office/rooms/' + open, person.token)).json().data;
  expect(view).not.toHaveProperty('userReadAt');
  expect(view.messages[0]).not.toHaveProperty('attachments');
});

it('rechecks the current human role for marked coding requests without trusting an old owner label', async () => {
  const person = await invite('owner', 'coding-owner');
  expect(auth.isMessageOwner('owner')).toBe(true);
  expect(auth.isMessageOwner(person.person.id)).toBe(true);
  expect(auth.isMessageOwner(undefined)).toBe(false);
  expect(auth.isMessageOwner('missing-human')).toBe(false);
  expect((await call('PUT', '/api/office/accounts/' + person.person.id, primary, { role: 'limited' })).statusCode).toBe(200);
  expect(auth.isMessageOwner(person.person.id)).toBe(false);
  expect(auth.isMessageOwner('owner')).toBe(true);
});

it('refuses every administrative surface, global stream, forged principal and unknown route for a limited cookie', async () => {
  const person = await invite();
  for (const url of [
    '/api/settings',
    '/api/events',
    '/api/company',
    '/api/filesystem/download',
    '/api/chatrooms',
    '/api/future/private',
    '/ws/terminal',
    '/api/office/accounts',
    '/people',
    '/people.js',
    '/api/office/future-admin',
    '/%61pi/settings',
    '/assets/avatars/../../api/settings',
  ])
    expect((await call('GET', url, person.token)).statusCode, url).toBe(403);
  expect((await call('POST', '/api/sessions/fixture-agent/input', person.token, { text: 'run' })).statusCode).toBe(403);
  const basic = 'Basic ' + Buffer.from('admin:synthetic-boundary').toString('base64');
  for (const extra of [
    { 'x-reverie-parent-session': 'fixture-agent', authorization: basic },
    { 'x-reverie-service-token': 'made-up', authorization: basic },
  ])
    expect((await call('GET', '/api/office/rooms', person.token, undefined, extra)).statusCode).toBe(403);
  expect((await call('GET', '/', person.token)).headers.location).toBe('/office');
  expect((await call('GET', '/office', person.token)).statusCode).toBe(200);
  expect(
    (await call('POST', '/api/office/presence', person.token, {}, { origin: 'https://outside.test' })).statusCode
  ).toBe(403);
  expect(
    (await call('GET', '/api/office/rooms', person.token, undefined, { 'sec-fetch-site': 'cross-site' })).statusCode
  ).toBe(403);
  for (const policy of ['off', 'log'] as const) {
    await store.update((a) => {
      a.policy = policy;
    });
    expect(auth.policy()).toBe('enforce');
    expect((await call('GET', '/api/settings', person.token)).statusCode).toBe(403);
    expect((await call('GET', '/api/settings')).statusCode).toBe(401);
  }
});

it('gives an additional owner full access while password and two-step changes stay on their own account', async () => {
  const person = await invite('owner', 'second-owner');
  expect((await call('GET', '/', person.token)).body).toBe('full console');
  expect((await call('GET', '/api/settings', person.token)).statusCode).toBe(200);
  expect((await call('GET', '/api/verified-owner-fixture', person.token)).json().owner).toBe(true);
  expect((await call('GET', '/api/owner/status', person.token)).json().data.username).toBe('second-owner');
  expect((await call('GET', '/api/owner/status', primary)).json().data.username).toBe('fixture-owner');
  expect((await call('POST', '/api/owner/2fa/start', person.token, {})).statusCode).toBe(200);
  expect(store.read()!.totpPending).toBeUndefined();
  const authStore = auth.forSession(person.token).store;
  expect(authStore.read()!.totpPending).toBeDefined();
  expect(
    (
      await call('POST', '/api/owner/password', person.token, {
        current: password,
        next: 'Different-synthetic-harbor-43!',
        username: 'fixture-owner',
      })
    ).statusCode
  ).toBe(409);
  expect((await call('POST', '/api/owner/logout-everywhere', person.token, {})).statusCode).toBe(200);
  expect(auth.session(person.token)).toBeUndefined();
  expect(auth.session(primary)).toBeDefined();
});

it('validates channel grants and names and protects the original recovery owner', async () => {
  for (const roomsGrant of [[rooms.list().find((r) => r.kind === 'dm')!.id], ['missing'], [open, open]])
    expect(
      (
        await call('POST', '/api/office/accounts', primary, {
          username: 'invitee',
          name: 'River',
          role: 'limited',
          rooms: roomsGrant,
        })
      ).statusCode
    ).toBe(400);
  expect(
    (
      await call('POST', '/api/office/accounts', primary, {
        username: '../invalid',
        name: 'River',
        role: 'limited',
        rooms: [],
      })
    ).statusCode
  ).toBe(400);
  expect(
    (
      await call('POST', '/api/office/accounts', primary, {
        username: 'fixture-owner',
        name: 'River',
        role: 'owner',
        rooms: [],
      })
    ).statusCode
  ).toBe(409);
  expect((await call('PUT', '/api/office/accounts/owner', primary, { disabled: true })).statusCode).toBe(404);
  await invite();
  expect(
    (
      await call('POST', '/api/office/accounts', primary, {
        username: 'COWORKER',
        name: 'Other',
        role: 'limited',
        rooms: [],
      })
    ).statusCode
  ).toBe(409);
});

it('revokes live cookies and sockets immediately on access changes and disable, without touching other logins', async () => {
  const person = await invite(),
    socket = new Socket();
  auth.track(person.token, socket);
  expect((await call('PUT', '/api/office/accounts/' + person.person.id, primary, { rooms: [] })).statusCode).toBe(200);
  expect(socket.destroyed).toBe(true);
  expect(auth.session(person.token)).toBeUndefined();
  expect(auth.session(primary)).toBeDefined();
  const renewed = await login('coworker', password);
  expect((await call('GET', '/api/office/rooms', renewed)).json().data.rooms).toEqual([]);
  await call('PUT', '/api/office/accounts/' + person.person.id, primary, { disabled: true });
  expect((await call('GET', '/api/office/me', renewed)).statusCode).toBe(401);
  expect((await call('POST', '/api/owner/login', undefined, { username: 'coworker', password })).statusCode).toBe(401);
});

it('expires presence, supports multiple browsers, and retains human identity and grants on reload', async () => {
  const person = await invite();
  const secondBrowser = await login('coworker', password);
  await call('POST', '/api/office/presence', person.token, {});
  await call('POST', '/api/office/presence', primary, {});
  await call('POST', '/api/office/presence', secondBrowser, {});
  expect(auth.members(rooms.get(open)!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'owner', online: true }),
      expect.objectContaining({ id: person.person.id, online: true }),
    ])
  );
  expect(auth.members(rooms.get(privateRoom)!)).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: person.person.id })])
  );
  await call('POST', '/api/owner/logout', person.token, {});
  expect(auth.members(rooms.get(open)!).find((p) => p.id === person.person.id)?.online).toBe(true);
  clock += 66_000;
  expect(auth.members(rooms.get(open)!).every((p) => !p.online)).toBe(true);
  await call('PUT', '/api/office/me', secondBrowser, { name: 'New name', avatar: '/assets/avatars/pack-151.png' });
  const reloaded = new OfficeAuthService({ store, auditFile: join(directory, 'new-audit.jsonl'), now: () => clock });
  expect(reloaded.list()).toEqual([
    expect.objectContaining({
      id: person.person.id,
      name: 'New name',
      avatar: '/assets/avatars/pack-151.png',
      rooms: [open],
      role: 'limited',
    }),
  ]);
  expect(reloaded.session(secondBrowser)).toBeUndefined();
  const metadata = await readFile(join(directory, 'office-people.json'), 'utf8');
  expect(metadata).not.toContain(password);
  expect(metadata).not.toContain(person.oneTimePassword);
  expect(metadata).not.toContain('password');
});

it('completes two-step sign-in for a limited account using only its own authenticator', async () => {
  const person = await invite();
  const start = await call('POST', '/api/owner/2fa/start', person.token, {});
  expect(start.statusCode, start.body).toBe(200);
  const secret = start.json().data.secret;
  const code = () => hotp(base32Decode(secret), totpStep(clock));
  expect((await call('POST', '/api/owner/2fa/confirm', person.token, { code: code() })).statusCode).toBe(200);
  expect(store.read()!.totp).toBeUndefined();
  auth.logout(person.token);
  clock += 30_000;
  const first = await call('POST', '/api/owner/login', undefined, { username: 'coworker', password });
  expect(first.json().data.next).toBe('second-factor');
  expect(first.cookies).toHaveLength(0);
  const second = await call('POST', '/api/owner/login/second-factor', undefined, {
    challenge: first.json().data.challenge,
    code: code(),
  });
  expect(second.statusCode, second.body).toBe(200);
  expect(auth.identity(tokenOf(second))).toMatchObject({ id: person.person.id, role: 'limited' });
  const ownerLogin = await call('POST', '/api/owner/login', undefined, { username: 'fixture-owner', password });
  expect(ownerLogin.json().data.next).toBe('done');
});

it('persists a separate read cursor and counts other humans without mutating the primary owner cursor', async () => {
  const person = await invite('owner');
  const channel = rooms.get(open)!;
  channel.userReadAt = 1;
  rooms.post(open, { kind: 'user', humanId: person.person.id, name: 'River' }, 'from another human', 'all', 10);
  expect(unreadFor(channel).unread).toBe(1);
  expect(unreadFor(channel, [], person.person.id).unread).toBe(0);
  await auth.markRead(person.person.id, open, 20);
  expect(auth.cursor(person.person.id, open)).toBe(20);
  expect(channel.userReadAt).toBe(1);
  expect(auth.cursor('owner', open)).toBeUndefined();
  const reloaded = new OfficeAuthService({ store, auditFile: join(directory, 'other-audit.jsonl') });
  expect(reloaded.cursor(person.person.id, open)).toBe(20);
  expect(auth.list()[0]).not.toHaveProperty('readAt');
});

it('never lets a limited login borrow a stale Basic administrator session for plan changes', async () => {
  const person = await invite();
  const request = {
    headers: { host: 'localhost', origin: 'http://localhost' },
    cookies: { [OWNER_COOKIE]: person.token, [AUTH_COOKIE_NAME]: 'old-basic-cookie' },
  };
  expect(authenticatedPlanMover(request as never, { get: () => ({ role: 'admin' }) } as never, auth)).toBe(false);
});

it('blocks old cookies and concurrent login until a role change has revoked prior sessions', async () => {
  const person = await invite();
  const child = auth.forSession(person.token),
    revoke = child.logoutEverywhere.bind(child);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(child, 'logoutEverywhere').mockImplementation(async () => {
    await hold;
    await revoke();
  });
  const pending = auth.update(person.person.id, { role: 'owner' });
  try {
    expect(auth.session(person.token)).toBeUndefined();
    const attempt = await call('POST', '/api/owner/login', undefined, { username: 'coworker', password });
    expect(attempt.statusCode).toBe(429);
    expect((await call('GET', '/api/settings', person.token)).statusCode).toBe(401);
  } finally {
    release();
    await pending;
  }
  expect(auth.session(person.token)).toBeUndefined();
  expect(auth.identity(await login('coworker', password))?.role).toBe('owner');
});
