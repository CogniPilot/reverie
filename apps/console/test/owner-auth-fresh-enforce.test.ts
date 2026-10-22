/**
 * @fileoverview A fresh image volume starts in enforce: docker/entrypoint.sh writes the policy marker
 * `enforce` before any owner account exists, and bootstrap keeps it. Pins that the shared Basic
 * password (REVERIE_PASSWORD, inherited by every process in the container) never reaches an owner
 * route on its own, that an agent header with it is refused, and that the signed-in owner gets through,
 * across a restart. Same hook order as server.ts: Basic auth, then the owner policy.
 * Synthetic fixtures only. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerOwnerPolicy, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import * as admin from '../src/owner-auth/admin.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const USER = 'owner';
const NEW_PASSWORD = 'synthetic-correct-horse-42';
const AGENT = '0000002d-0035-4000-8000-000000000047';
const PASSWORD = 'synthetic-shared-password';
const BASIC = 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64');

/** One route per owner family the console registers (plans, settings, CLI registry, cron, company, models, tunnel). */
const OWNER_ROUTES: Array<['GET' | 'PUT' | 'POST', string]> = [
  ['GET', '/api/settings'],
  ['PUT', '/api/settings'],
  ['GET', '/api/subscription-profiles'],
  ['POST', '/api/subscription-profiles'],
  ['GET', '/api/clis'],
  ['POST', '/api/clis'],
  ['GET', '/api/cron/jobs'],
  ['POST', '/api/cron/jobs'],
  ['PUT', '/api/company/settings'],
  ['POST', '/api/model-endpoints'],
  ['GET', '/api/tunnel/info'],
  ['GET', '/ws/terminal'],
  ['GET', '/api/not-a-route'],
];

describe('fresh volume: enforce by default', () => {
  let dir: string;
  let store: OwnerAuthStore;
  let app: FastifyInstance;
  let savedPassword: string | undefined;
  let clock: number;
  const sessions = new Map<string, unknown>([[AGENT, { id: AGENT, owner: undefined }]]);

  /** A console start: new service and app over the same volume (owner sessions live in memory). */
  async function start() {
    const service = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl'), now: () => clock });
    app = Fastify();
    await app.register(fastifyCookie);
    registerAuthMiddleware(app, false);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions } as unknown as SessionPort,
      isCapabilityRequest: (req) => (req.url ?? '').startsWith('/q/'),
      relations: { known: () => true, related: (caller, target) => caller === target, upward: () => false, keeper: () => false, admin: () => false },
      now: () => clock,
    });
    registerOwnerRoutes(app, service, false);
    for (const [method, url] of OWNER_ROUTES) {
      if (url !== '/api/not-a-route') app.route({ method, url, handler: async () => ({ success: true }) });
    }
    app.get('/api/sessions', async () => ({ success: true, data: 'list' }));
    app.get('/', async () => 'app');
    await app.ready();
    return service;
  }

  const call = (
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    opts: { cookies?: Record<string, string>; headers?: Record<string, string>; basic?: boolean } = {}
  ) =>
    app.inject({
      method,
      url,
      cookies: opts.cookies,
      headers: { origin: 'http://localhost:80', ...(opts.basic === false ? {} : { authorization: BASIC }), ...(opts.headers ?? {}) },
      ...(method === 'GET' ? {} : { payload: {} }),
    });
  const ownerCookie = (res: { cookies: Array<{ name: string; value: string }> }) =>
    res.cookies.find((c) => c.name === OWNER_COOKIE)?.value;
  async function signIn(password: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: { username: USER, password },
      headers: { origin: 'http://localhost:80', authorization: BASIC },
    });
    expect(res.statusCode).toBe(200);
    return ownerCookie(res)!;
  }

  beforeEach(async () => {
    savedPassword = process.env.REVERIE_PASSWORD;
    process.env.REVERIE_PASSWORD = PASSWORD; // the middleware reads it at registration
    dir = await mkdtemp(join(tmpdir(), 'owner-fresh-'));
    store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    clock = 1_700_000_000_000;
    await writeFile(store.markerFile, 'enforce\n', { mode: 0o600 }); // what the entrypoint writes
  });
  afterEach(async () => {
    await app?.close();
    if (savedPassword === undefined) delete process.env.REVERIE_PASSWORD;
    else process.env.REVERIE_PASSWORD = savedPassword;
    await rm(dir, { recursive: true, force: true });
  });

  it('before any account: enforce; Basic alone and Basic plus an agent header never reach an owner route', async () => {
    const service = await start();
    expect(store.read()).toBeUndefined();
    expect(service.policy()).toBe('enforce');
    for (const [method, url] of OWNER_ROUTES) {
      expect((await call(method, url, { basic: false })).statusCode, `${method} ${url} no Basic`).toBe(401);
      expect((await call(method, url)).statusCode, `${method} ${url} Basic only`).toBe(401);
      const agent = await call(method, url, { headers: { 'x-reverie-parent-session': AGENT } });
      expect(agent.statusCode, `${method} ${url} Basic + agent`).toBe(403);
    }
    expect((await call('GET', '/api/sessions', { headers: { 'x-reverie-parent-session': AGENT } })).statusCode).toBe(200);
    const page = await call('GET', '/');
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe('/owner/login?next=%2F');
  });

  it('bootstrap keeps enforce; the signed-in owner reaches every family; a restart still enforces', async () => {
    const { oneTimePassword } = await admin.bootstrap(store, USER, { now: clock });
    expect(store.read()!.policy).toBe('enforce');
    expect(store.readMarker()).toBe('enforce');
    await start();
    const restricted = await signIn(oneTimePassword);
    expect((await call('PUT', '/api/settings', { cookies: { [OWNER_COOKIE]: restricted } })).statusCode).toBe(403);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTimePassword, next: NEW_PASSWORD },
      cookies: { [OWNER_COOKIE]: restricted },
      headers: { origin: 'http://localhost:80', authorization: BASIC },
    });
    expect(changed.statusCode).toBe(200);
    const owner = ownerCookie(changed)!;
    for (const [method, url] of OWNER_ROUTES) {
      const expected = url === '/api/not-a-route' ? 404 : 200;
      expect((await call(method, url, { cookies: { [OWNER_COOKIE]: owner } })).statusCode, `${method} ${url} owner`).toBe(expected);
    }
    for (const [method, url] of OWNER_ROUTES) {
      const agent = await call(method, url, { headers: { 'x-reverie-parent-session': AGENT } });
      expect(agent.statusCode, `${method} ${url} Basic + agent after sign-in`).toBe(403);
    }

    await app.close();
    const restarted = await start();
    expect(restarted.policy()).toBe('enforce');
    expect((await call('PUT', '/api/settings', { cookies: { [OWNER_COOKIE]: owner } })).statusCode).toBe(401); // sessions are in memory
    expect((await call('PUT', '/api/settings')).statusCode).toBe(401);
    const again = await signIn(NEW_PASSWORD);
    expect((await call('PUT', '/api/settings', { cookies: { [OWNER_COOKIE]: again } })).statusCode).toBe(200);
  });
});

describe('bootstrap policy from the marker', () => {
  let dir: string;
  let store: OwnerAuthStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owner-marker-'));
    store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('no marker: log, as before (a source install keeps its trial mode)', async () => {
    await admin.bootstrap(store, USER);
    expect(store.read()!.policy).toBe('log');
  });

  it('a log marker stays log; an unreadable marker fails closed to enforce', async () => {
    await writeFile(store.markerFile, 'log\n');
    await admin.bootstrap(store, USER);
    expect(store.read()!.policy).toBe('log');
    await rm(store.file);
    await writeFile(store.markerFile, 'garbage\n');
    await admin.bootstrap(store, USER);
    expect(store.read()!.policy).toBe('enforce');
  });

  it('--enforce (a native install): no marker still starts in enforce, and the marker follows', async () => {
    await admin.bootstrap(store, USER, { enforce: true });
    expect(store.read()!.policy).toBe('enforce');
    expect(store.readMarker()).toBe('enforce');
  });

  it('--enforce only raises: a replaced log account becomes enforce; without it a replace keeps the policy', async () => {
    await writeFile(store.markerFile, 'log\n');
    await admin.bootstrap(store, USER);
    await admin.bootstrap(store, USER, { force: true });
    expect(store.read()!.policy).toBe('log');
    await admin.bootstrap(store, USER, { force: true, enforce: true });
    expect(store.read()!.policy).toBe('enforce');
    expect(store.readMarker()).toBe('enforce');
    await admin.bootstrap(store, USER, { force: true });
    expect(store.read()!.policy).toBe('enforce');
  });
});
