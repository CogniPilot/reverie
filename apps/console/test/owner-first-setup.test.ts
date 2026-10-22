import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerOwnerPolicy, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import * as admin from '../src/owner-auth/admin.js';

const PASSWORD = 'synthetic-permanent-forest-72';
describe('first browser account claim', () => {
  let directory: string;
  let store: OwnerAuthStore;
  let service: OwnerAuthService;
  let app: FastifyInstance;
  let auth: ReturnType<typeof registerAuthMiddleware>;
  const make = (target = new OwnerAuthStore(store.file)) =>
    new OwnerAuthService({ store: target, auditFile: join(directory, 'audit.jsonl'), setupEnabled: true });
  beforeEach(async () => {
    vi.stubEnv('REVERIE_PASSWORD', 'internal-api-only');
    vi.stubEnv('REVERIE_MULTIUSER', '0');
    directory = await mkdtemp(join(tmpdir(), 'reverie-first-account-'));
    store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
    service = make(store);
    app = Fastify();
    await app.register(cookie);
    auth = registerAuthMiddleware(app, false, '', service);
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
    registerOwnerRoutes(app, service, false);
    app.get('/', async () => 'app');
    app.get('/api/settings', async () => ({ success: true }));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    for (const map of Object.values(auth)) map?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const claim = (
    payload: unknown = { username: 'Chosen_User', password: PASSWORD, confirmation: PASSWORD },
    headers = { origin: 'http://localhost:80' }
  ) => app.inject({ method: 'POST', url: '/api/owner/setup', headers, payload });
  it('shows Create account without Basic or a bootstrap login, immediately enforces and signs the chosen owner into the app', async () => {
    expect(service.policy()).toBe('enforce');
    const navigation = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    expect(navigation.statusCode).toBe(302);
    expect(navigation.headers.location).toBe('/owner/setup?next=%2F');
    expect(navigation.headers['www-authenticate']).toBeUndefined();
    const page = await app.inject('/owner/setup');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Create account');
    expect(page.body).toContain('Confirm password');
    expect(page.body).not.toContain('Current password');
    const response = await claim();
    expect(response.statusCode).toBe(200);
    const owner = response.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
    expect(store.read()).toMatchObject({ username: 'chosen_user', policy: 'enforce', mustChange: false, epoch: 1 });
    expect(store.readMarker()).toBe('enforce');
    expect((await app.inject({ url: '/api/settings', cookies: { [OWNER_COOKIE]: owner } })).statusCode).toBe(200);
    expect((await app.inject('/api/settings')).statusCode).toBe(401);
    expect((await claim()).statusCode).toBe(409);
    expect((await app.inject('/owner/setup')).headers.location).toBe('/owner/login');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/owner/login',
          payload: { username: 'chosen_user', password: PASSWORD },
        })
      ).json().data.next
    ).toBe('done');
  });
  it('rejects cross-origin, missing-Origin and agent registration attempts before changing disk', async () => {
    for (const headers of [
      { origin: 'http://evil.invalid' },
      {},
      { origin: 'http://localhost:80', 'x-reverie-parent-session': 'agent' },
    ]) {
      expect((await claim(undefined, headers as never)).statusCode).toBeGreaterThanOrEqual(400);
      expect(store.isUnclaimed()).toBe(true);
    }
  });
  it('rejects invalid names, weak passwords and mismatched confirmation without claiming, and bounds source attempts', async () => {
    expect((await claim({ username: 'a', password: PASSWORD, confirmation: PASSWORD })).statusCode).toBe(400);
    expect((await claim({ username: 'valid', password: 'short', confirmation: 'short' })).statusCode).toBe(400);
    expect((await claim({ username: 'valid', password: PASSWORD, confirmation: 'different' })).statusCode).toBe(400);
    for (let i = 0; i < 2; i++) await claim({ username: '', password: PASSWORD, confirmation: PASSWORD });
    const limit = await claim();
    expect(limit.statusCode).toBe(429);
    expect(limit.headers['retry-after']).toBe('60');
    expect(store.isUnclaimed()).toBe(true);
  });
  it('a different process/service racing for the same pristine store can never overwrite the winner', async () => {
    const other = make();
    const results = await Promise.allSettled([
      service.setup('first-owner', PASSWORD, PASSWORD, 'source-one'),
      other.setup('second-owner', PASSWORD, PASSWORD, 'source-two'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
    expect(['first-owner', 'second-owner']).toContain(store.read()!.username);
    expect(make().setupAvailable()).toBe(false);
  });
  it('existing bootstrap accounts, recovery markers, corrupt accounts and dangling symlinks never reopen registration', async () => {
    await admin.bootstrap(store, 'owner', { enforce: true });
    expect(service.setupAvailable()).toBe(false);
    await rm(store.file);
    expect(make().setupAvailable()).toBe(false);
    expect(make().policy()).toBe('enforce');
    await rm(store.markerFile);
    await writeFile(store.file, '{broken');
    expect(make().setupAvailable()).toBe(false);
    expect(make().policy()).toBe('enforce');
    await rm(store.file);
    await symlink(join(directory, 'missing-account'), store.file);
    expect(make().setupAvailable()).toBe(false);
    expect(make().policy()).toBe('enforce');
  });
  it('persists the enforce marker before account exposure, so interrupted setup requires recovery instead of reopening registration', async () => {
    const original = store.writeMarker.bind(store);
    vi.spyOn(store, 'writeMarker').mockImplementation(async (policy) => {
      await original(policy);
      throw new Error('simulated interruption');
    });
    await expect(service.setup('owner-name', PASSWORD, PASSWORD, 'source')).rejects.toThrow('simulated interruption');
    expect(store.read()).toBeUndefined();
    expect(store.readMarker()).toBe('enforce');
    expect(make().setupAvailable()).toBe(false);
    expect(make().policy()).toBe('enforce');
  });
  it('does not enable setup for source installs unless explicitly enabled', () => {
    const disabled = new OwnerAuthService({ store, auditFile: join(directory, 'audit.jsonl'), setupEnabled: false });
    expect(disabled.setupAvailable()).toBe(false);
    expect(disabled.policy()).toBe('off');
  });
});
