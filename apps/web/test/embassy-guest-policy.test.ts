/**
 * @fileoverview Embassy guest routes behind the owner policy: every route, reads included, needs a full owner
 * session in every policy mode (off, log and enforce). No cookie, a forged or real agent header, an owner cookie
 * sent with an agent header, and a restricted (one-time password) owner are all refused before the client runs.
 * Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { allowed, classify, registerOwnerPolicy, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { relations } from '../src/owner-auth/relations.js';
import * as admin from '../src/owner-auth/admin.js';
import { registerEmbassyGuestRoutes } from '../src/web/routes/embassy-guest-routes.js';
import type { EmbassyGuestClient } from '../src/embassy-guest-client.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const USER = 'owner-test';
const PASSWORD = 'synthetic-correct-horse-42';
const ORIGIN = 'http://localhost:80';
const KEY = `embassy-v1|https://embassy.example.ts.net:8443|${'T'.repeat(43)}`;
const ROOM = '00000016-001c-4000-8000-000000000026';
const AGENT = '0000002d-0035-4000-8000-000000000047'; // a live agent session
const FORGED = '00000046-0058-4000-8000-000000000084'; // no such session

type Route = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; route: string; url: string; payload?: object; call: string };
const ROUTES: Route[] = [
  { method: 'GET', route: '/api/embassy-guest', url: '/api/embassy-guest', call: 'list' },
  { method: 'POST', route: '/api/embassy-guest/preview', url: '/api/embassy-guest/preview', payload: { key: KEY }, call: 'preview' },
  {
    method: 'POST',
    route: '/api/embassy-guest/join',
    url: '/api/embassy-guest/join',
    payload: { key: KEY, confirmedOrigin: 'https://embassy.example.ts.net:8443' },
    call: 'join',
  },
  { method: 'GET', route: '/api/embassy-guest/:id/posts', url: `/api/embassy-guest/${ROOM}/posts?after=0`, call: 'posts' },
  {
    method: 'POST',
    route: '/api/embassy-guest/:id/posts',
    url: `/api/embassy-guest/${ROOM}/posts`,
    payload: { text: 'hello', requestId: '00000009-000a-4000-8000-00000000000b' },
    call: 'post',
  },
  { method: 'PUT', route: '/api/embassy-guest/:id', url: `/api/embassy-guest/${ROOM}`, payload: { enabled: false }, call: 'setEnabled' },
  { method: 'DELETE', route: '/api/embassy-guest/:id', url: `/api/embassy-guest/${ROOM}`, call: 'leave' },
];

describe('embassy guest owner policy classification', () => {
  it.each(ROUTES.map((r) => [r.method, r.route, r.url]))('%s %s is owner-class', (method, route, url) => {
    expect(classify(method, route, url)).toBe('owner');
  });

  it('owner-class refuses every caller but the owner', () => {
    expect(allowed('owner', 'owner')).toBe(true);
    for (const caller of ['restricted-owner', 'service', 'agent', 'invalid', 'anonymous'] as const) {
      expect(allowed('owner', caller), caller).toBe(false);
    }
  });
});

describe.each(['off', 'log', 'enforce'] as const)('embassy guest routes under policy %s', (mode) => {
  let dir: string;
  let store: OwnerAuthStore;
  let service: OwnerAuthService;
  let app: FastifyInstance;
  let calls: string[];
  let restricted: string;
  let oneTimePassword: string;

  const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) =>
    res.cookies.find((c) => c.name === OWNER_COOKIE)?.value;
  const login = (password: string) =>
    app.inject({ method: 'POST', url: '/api/owner/login', payload: { username: USER, password }, remoteAddress: '127.0.0.1' });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'embassy-guest-policy-'));
    store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    const oneTime = (await admin.bootstrap(store, USER, { now: Date.now() })).oneTimePassword;
    await admin.setPolicy(store, mode, { forceLockoutRisk: true });
    service = new OwnerAuthService({ store, auditFile: join(dir, 'owner-auth-audit.jsonl') });
    const sessions = new Map([[AGENT, { id: AGENT }]]);
    const ctx = { sessions } as unknown as SessionPort;
    calls = [];
    // Every client method records the call and answers; a refused request must never reach it.
    const client = new Proxy({} as EmbassyGuestClient, {
      get: (_t, name) => () => {
        calls.push(String(name));
        return {};
      },
    });
    app = Fastify();
    await app.register(fastifyCookie);
    registerOwnerPolicy(app, {
      service,
      ctx,
      isCapabilityRequest: () => false,
      relations: relations({
        recordedParent: () => undefined,
        known: (id) => sessions.has(id),
        rooms: () => [],
        predecessor: () => undefined,
        employeeOf: () => undefined,
        keepers: () => service.keepers(),
      }),
    });
    registerOwnerRoutes(app, service, false);
    registerEmbassyGuestRoutes(app, client, ownerVerifier({ service, ctx }));
    await app.ready();
    expect(service.policy()).toBe(mode);

    // A one-time password session is restricted until the password changes.
    oneTimePassword = oneTime;
    restricted = cookieOf(await login(oneTime))!;
    expect(service.session(restricted)).toEqual({ restricted: true });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  // The password change gives a full session (it may end the restricted one).
  async function fullOwner(): Promise<string> {
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTimePassword, next: PASSWORD },
      cookies: { [OWNER_COOKIE]: restricted },
      headers: { origin: ORIGIN },
    });
    expect(changed.statusCode).toBe(200);
    const full = cookieOf(changed)!;
    expect(service.session(full)).toEqual({ restricted: false });
    return full;
  }

  const send = (r: Route, cookies: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: r.method, url: r.url, payload: r.payload, cookies, headers: { origin: ORIGIN, ...headers } });

  const refusals: Array<[string, boolean, Record<string, string>]> = [
    ['no cookie and no header', false, {}],
    ['a forged agent header', false, { 'x-reverie-parent-session': FORGED }],
    ['a real agent session header', false, { 'x-reverie-parent-session': AGENT }],
    ['a full owner cookie with an agent header', true, { 'x-reverie-parent-session': AGENT }],
  ];

  it.each(refusals)('refuses %s on every route, reads included', async (_name, withOwner, headers) => {
    const cookies = withOwner ? { [OWNER_COOKIE]: await fullOwner() } : {};
    for (const r of ROUTES) {
      const res = await send(r, cookies, headers);
      expect([401, 403], `${r.method} ${r.url} -> ${res.statusCode}`).toContain(res.statusCode);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a restricted (one-time password) owner on every route', async () => {
    for (const r of ROUTES) {
      const res = await send(r, { [OWNER_COOKIE]: restricted });
      expect([401, 403], `${r.method} ${r.url} -> ${res.statusCode}`).toContain(res.statusCode);
    }
    expect(service.session(restricted)).toEqual({ restricted: true }); // still the restricted session throughout
    expect(calls).toEqual([]);
  });

  it('refuses an unknown owner cookie on every route', async () => {
    for (const r of ROUTES) {
      const res = await send(r, { [OWNER_COOKIE]: 'x'.repeat(43) });
      expect([401, 403], `${r.method} ${r.url} -> ${res.statusCode}`).toContain(res.statusCode);
    }
    expect(calls).toEqual([]);
  });

  it('serves a full owner on every route', async () => {
    const full = await fullOwner();
    for (const r of ROUTES) {
      const res = await send(r, { [OWNER_COOKIE]: full });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(200);
    }
    expect(calls).toEqual(ROUTES.map((r) => r.call));
  });
});
