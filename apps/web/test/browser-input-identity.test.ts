/** Real sign-ins and middleware; no native registration, provider, host socket or live instance. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { AUTH_COOKIE_NAME, registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerInputIdentityRoutes } from '../src/web/routes/input-identity-routes.js';
import { registerMeRoutes } from '../src/web/routes/me-routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import {
  createUser,
  deleteUser,
  hashPassword,
  invalidateUsersCache,
  setPassword,
  updateUser,
} from '../src/user-store.js';

const password = 'Synthetic-input-journal-identity-42!';
let directory: string, store: OwnerAuthStore, service: OfficeAuthService;
let app: FastifyInstance | undefined, state: ReturnType<typeof registerAuthMiddleware> | undefined;
beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  vi.stubEnv('REVERIE_PASSWORD', '');
  directory = await mkdtemp(join(tmpdir(), 'input-identity-'));
  store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  service = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: false });
});
afterEach(async () => {
  await app?.close();
  for (const map of Object.values(state ?? {})) map?.dispose();
  app = undefined;
  state = undefined;
  vi.unstubAllEnvs();
  invalidateUsersCache();
  await rm(directory, { recursive: true, force: true });
});
async function start() {
  app = Fastify();
  await app.register(cookie);
  state = registerAuthMiddleware(app, false, '', service);
  registerOwnerPolicy(app, {
    service,
    ctx: { sessions: new Map() } as unknown as SessionPort,
    isCapabilityRequest: () => false,
    relations: {
      known: () => false,
      related: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  registerInputIdentityRoutes(app, service, state.authSessions !== null);
  registerMeRoutes(app, { authSessions: state.authSessions, qrAuthFailures: state.qrAuthFailures, https: false });
  await app.ready();
}
async function setup() {
  service = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  return service.setup('fixture-owner', password, password, '127.0.0.1');
}
function owner(token: string) {
  return app!.inject({ url: '/api/input-identity', cookies: { [OWNER_COOKIE]: token } });
}
const basic = (name: string, pass = password) => ({
  authorization: 'Basic ' + Buffer.from(`${name}:${pass}`).toString('base64'),
});

it('returns a stable genuine owner partition with no enrollment or account writes', async () => {
  const token = await setup();
  await start();
  const before = await readFile(store.file, 'utf8');
  const first = await owner(token),
    second = await owner(token);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual(second.json());
  expect(first.json().data).toEqual({
    version: 1,
    kind: 'account',
    scopeId: JSON.stringify([store.readCurrent()!.accountId, 'owner']),
    epoch: 1,
  });
  expect(first.headers['cache-control']).toBe('no-store');
  expect(first.headers.vary).toBe('Cookie, Authorization');
  expect(await readFile(store.file, 'utf8')).toBe(before);
  expect((await app!.inject('/api/input-identity')).statusCode).toBe(401);
});

it('keeps legacy accounts usable without enrolling and binds fallback to the actual login', async () => {
  const initial = await setup();
  service.logout(initial);
  await store.update((account) => {
    delete account.accountId;
  });
  const first = (await service.login('fixture-owner', password, '127.0.0.1')).session!;
  const second = (await service.login('fixture-owner', password, '127.0.0.2')).session!;
  await start();
  const before = await readFile(store.file, 'utf8');
  const a = (await owner(first)).json().data;
  expect(a.kind).toBe('session');
  expect((await owner(first)).json().data).toEqual(a);
  expect((await owner(second)).json().data.scopeId).not.toBe(a.scopeId);
  expect(await readFile(store.file, 'utf8')).toBe(before);
});

it.each(['owner', 'limited'] as const)(
  'partitions real secondary %s humans without granting owner access',
  async (role) => {
    const primary = await setup();
    const made = await service.create({ username: 'fixture-member', name: 'Member', role, rooms: [] });
    const login = await service.login('fixture-member', made.oneTimePassword, '127.0.0.1');
    const token = await service
      .forSession(login.session)
      .changePassword(login.session, { current: made.oneTimePassword, next: password }, '127.0.0.1');
    await start();
    const result = await owner(token);
    expect(result.statusCode).toBe(200);
    expect(result.json().data.scopeId).not.toBe((await owner(primary)).json().data.scopeId);
    expect(JSON.parse(result.json().data.scopeId)[1]).toBe(made.person.id);
    expect(service.session(token)?.role).toBe(role);
    await service.update(made.person.id, { disabled: true });
    expect((await owner(token)).statusCode).not.toBe(200);
  }
);

it('refuses restricted, revoked, stale-epoch and changed-credential sessions', async () => {
  const token = await setup();
  const made = await service.create({ username: 'fixture-member', name: 'Member', role: 'owner', rooms: [] });
  const restricted = (await service.login('fixture-member', made.oneTimePassword, '127.0.0.1')).session!;
  await start();
  expect((await owner(restricted)).statusCode).toBe(403);
  await store.update((account) => {
    account.epoch++;
  });
  expect((await owner(token)).statusCode).not.toBe(200);
  const fresh = (await service.login('fixture-owner', password, '127.0.0.1')).session!;
  await store.update((account) => {
    account.passwordChangedAt++;
  });
  expect((await owner(fresh)).statusCode).toBe(403);
  service.logout(fresh);
  expect((await owner(fresh)).statusCode).not.toBe(200);
});

it('attests the first Basic response and its exact cookie, but never a synthetic admin or raw header', async () => {
  vi.stubEnv('REVERIE_PASSWORD', password);
  await start();
  const first = await app!.inject({ url: '/api/input-identity', headers: basic('admin') });
  expect(first.statusCode).toBe(200);
  expect(first.json().data.kind).toBe('session');
  const token = first.cookies.find((c) => c.name === AUTH_COOKIE_NAME)!.value;
  const second = await app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: token } });
  expect(second.json()).toEqual(first.json());
  const independent = await app!.inject({ url: '/api/input-identity', headers: basic('admin') });
  expect(independent.json().data.scopeId).not.toBe(first.json().data.scopeId);
  state!.authSessions!.delete(token);
  expect((await app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: token } })).statusCode).toBe(
    401
  );
  expect((await app!.inject({ url: '/api/input-identity', headers: basic('admin', 'wrong') })).statusCode).toBe(401);
});

it('supports real multi-user authentication and refuses live disabled or password-restricted users', async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '1');
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  invalidateUsersCache();
  await createUser({ username: 'fixture-user', password, role: 'user' });
  await start();
  const first = await app!.inject({ url: '/api/input-identity', headers: basic('fixture-user') });
  expect(first.statusCode).toBe(200);
  const token = first.cookies.find((c) => c.name === AUTH_COOKIE_NAME)!.value;
  const probe = () => app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: token } });
  expect((await probe()).json()).toEqual(first.json());
  await updateUser('fixture-user', { mustChangePassword: true });
  expect((await probe()).statusCode).toBe(403);
  await updateUser('fixture-user', { disabled: true });
  expect((await probe()).statusCode).toBe(401);
});

it.each(['recreate', 'password'] as const)(
  'refuses a multi-user cookie after out-of-band credential %s',
  async (change) => {
    vi.stubEnv('REVERIE_MULTIUSER', '1');
    vi.stubEnv('REVERIE_DATA_DIR', directory);
    invalidateUsersCache();
    await createUser({ username: 'fixture-user', password, role: 'user' });
    await start();
    const first = await app!.inject({ url: '/api/input-identity', headers: basic('fixture-user') });
    const token = first.cookies.find((c) => c.name === AUTH_COOKIE_NAME)!.value;
    if (change === 'recreate') {
      await deleteUser('fixture-user');
      await createUser({ username: 'fixture-user', password, role: 'user' });
    } else await setPassword('fixture-user', password);
    const stale = await app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: token } });
    expect(stale.statusCode).toBe(401);
    const fresh = await app!.inject({ url: '/api/input-identity', headers: basic('fixture-user') });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().data.scopeId).not.toBe(first.json().data.scopeId);
  }
);

it('preserves the explicitly changed-password cookie with a new journal scope and revokes its siblings', async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '1');
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  invalidateUsersCache();
  await createUser({ username: 'fixture-user', password, role: 'user' });
  await start();
  const first = await app!.inject({ url: '/api/input-identity', headers: basic('fixture-user') });
  const sibling = await app!.inject({ url: '/api/input-identity', headers: basic('fixture-user') });
  const token = first.cookies.find((c) => c.name === AUTH_COOKIE_NAME)!.value;
  const changed = await app!.inject({
    method: 'POST',
    url: '/api/me/password',
    cookies: { [AUTH_COOKIE_NAME]: token },
    payload: { currentPassword: password, newPassword: password + '-changed' },
  });
  expect(changed.statusCode).toBe(200);
  const current = await app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: token } });
  expect(current.statusCode).toBe(200);
  expect(current.json().data.scopeId).not.toBe(first.json().data.scopeId);
  const siblingToken = sibling.cookies.find((c) => c.name === AUTH_COOKIE_NAME)!.value;
  expect(
    (await app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: siblingToken } })).statusCode
  ).toBe(401);
});

it('binds an actual hash-upgrade login to the new committed credentials', async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '1');
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  invalidateUsersCache();
  await createUser({ username: 'fixture-user', password, role: 'user' });
  const file = join(directory, 'users.json');
  const fixture = JSON.parse(await readFile(file, 'utf8'));
  fixture.users[0].password = await hashPassword(password, { N: 1024, r: 8, p: 1 });
  await writeFile(file, JSON.stringify(fixture));
  invalidateUsersCache();
  await start();
  const first = await app!.inject({ url: '/api/input-identity', headers: basic('fixture-user') });
  expect(first.statusCode).toBe(200);
  const token = first.cookies.find((c) => c.name === AUTH_COOKIE_NAME)!.value;
  expect((await app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: token } })).json()).toEqual(
    first.json()
  );
  expect(JSON.parse(await readFile(file, 'utf8')).users[0].password.N).toBe(16384);
});

it('does not invent provenance for an older multi-user cookie lacking an authentication fingerprint', async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '1');
  vi.stubEnv('REVERIE_DATA_DIR', directory);
  invalidateUsersCache();
  await createUser({ username: 'fixture-user', password, role: 'user' });
  await start();
  const first = await app!.inject({ url: '/api/input-identity', headers: basic('fixture-user') });
  const token = first.cookies.find((c) => c.name === AUTH_COOKIE_NAME)!.value;
  delete state!.authSessions!.get(token)!.credentialFingerprint;
  expect((await app!.inject({ url: '/api/input-identity', cookies: { [AUTH_COOKIE_NAME]: token } })).statusCode).toBe(
    403
  );
  expect(state!.authSessions!.get(token)!.credentialFingerprint).toBeUndefined();
});

it('labels no-auth compatibility explicitly, refusing stale credentials and agent routing hints', async () => {
  await start();
  const result = await app!.inject('/api/input-identity');
  expect(result.statusCode).toBe(200);
  expect(result.json().data).toMatchObject({ version: 1, kind: 'anonymous', epoch: 0 });
  for (const cookies of [{ [OWNER_COOKIE]: 'stale' }, { [AUTH_COOKIE_NAME]: 'stale' }])
    expect((await app!.inject({ url: '/api/input-identity', cookies })).statusCode).toBe(403);
  for (const headers of [
    { 'x-reverie-parent-session': 'arbitrary' },
    { 'x-reverie-service-token': 'arbitrary' },
    basic('admin'),
  ])
    expect((await app!.inject({ url: '/api/input-identity', headers })).statusCode).toBe(403);
});
