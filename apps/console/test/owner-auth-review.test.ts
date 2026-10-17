/**
 * @fileoverview Owner sign-in, review fixes: encoded-path bypass (B1), agent session scoping (H1),
 * per-source lockout and device bypass (H2), exact-origin owner writes and the sandboxed web-tab
 * proxy (H3), concurrency (M1), a missing or corrupt account file (M2), stream closing (M3), host CLI
 * audit and guard (M4), one-time password expiry and the forced change after a reset (M5),
 * replacing two-step (M6) and the bounded would-deny log (L1). Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { base32Decode, hotp, totpStep } from '../src/owner-auth/crypto.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService, current, ONE_TIME_TTL_MS, DECAY_MS } from '../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { classify, registerOwnerPolicy, OWNER_COOKIE, DEVICE_COOKIE } from '../src/owner-auth/policy.js';
import { relations, runtimeLineage, type RelationSources } from '../src/owner-auth/relations.js';
import { OWNER_SCRIPT, safeNext } from '../src/owner-auth/pages.js';
import { buildUpstreamRequestHeaders, upstreamCookieHeader } from '../src/web/webview-proxy.js';
import { withSandbox } from '../src/web/routes/webview-routes.js';
import * as admin from '../src/owner-auth/admin.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const USER = 'owner-test';
const PASSWORD = 'synthetic-correct-horse-42';
const ORIGIN = { origin: 'http://localhost:80' };
const A = 'aaaaaaaa-0000-4000-8000-000000000001'; // the calling agent
const CHILD = 'bbbbbbbb-0000-4000-8000-000000000002'; // spawned by A
const GRANDCHILD = 'cccccccc-0000-4000-8000-000000000003';
const MEMBER = 'dddddddd-0000-4000-8000-000000000004'; // in a room A coordinates
const STRANGER = 'eeeeeeee-0000-4000-8000-000000000005';
const KEEPER = 'ffffffff-0000-4000-8000-000000000006'; // bound to a company employee
const RESTARTED = '11111111-0000-4000-8000-000000000007'; // a watcher restart: no recorded parent
const OLD = '22222222-0000-4000-8000-000000000008'; // its stopped predecessor, spawned by A
const STOPPED = '33333333-0000-4000-8000-000000000009'; // someone else's stopped record
const STOPPED_CHILD = '44444444-0000-4000-8000-00000000000a'; // A's stopped child
const EMPLOYEE = 'employee-keeper';

describe('owner sign-in review fixes', () => {
  let dir: string;
  let store: OwnerAuthStore;
  let service: OwnerAuthService;
  let app: FastifyInstance;
  let clock: number;
  let oneTime: string;
  const sessions = new Map<string, { id: string; owner?: string; parentSessionId?: string }>([
    [A, { id: A }],
    [CHILD, { id: CHILD, parentSessionId: A }],
    [GRANDCHILD, { id: GRANDCHILD, parentSessionId: CHILD }],
    [MEMBER, { id: MEMBER }],
    [STRANGER, { id: STRANGER }],
    [KEEPER, { id: KEEPER }],
    [RESTARTED, { id: RESTARTED }],
  ]);
  // Persisted records of stopped sessions, the runtime watcher's lineage, company bindings, rooms.
  const persisted = new Map<string, { parentSessionId?: string }>([
    [OLD, { parentSessionId: A }],
    [STOPPED, {}],
    [STOPPED_CHILD, { parentSessionId: A }],
  ]);
  const lineage = new Map<string, string>([[RESTARTED, OLD]]);
  const employees = new Map<string, string>([[KEEPER, EMPLOYEE]]);
  let ctoEmployee: string | undefined;
  const rooms: Array<{ members: Array<{ sessionId: string; role: string; addedBy?: string }> }> = [
    { members: [{ sessionId: A, role: 'coordinator' }, { sessionId: MEMBER, role: 'agent' }] },
  ];
  const sources = (): RelationSources => ({
    recordedParent: (id) => sessions.get(id)?.parentSessionId ?? persisted.get(id)?.parentSessionId,
    known: (id) => sessions.has(id) || persisted.has(id),
    rooms: () => rooms,
    predecessor: (id) => lineage.get(id),
    employeeOf: (id) => employees.get(id),
    ctoEmployee: () => ctoEmployee,
    keepers: () => service.keepers(),
  });

  async function build(policy?: 'off' | 'log' | 'enforce') {
    if (policy) await admin.setPolicy(store, policy);
    service = new OwnerAuthService({ store, auditFile: join(dir, 'owner-auth-audit.jsonl'), now: () => clock });
    app = Fastify();
    await app.register(fastifyCookie);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions } as unknown as SessionPort,
      isCapabilityRequest: () => false,
      relations: relations(sources()),
      now: () => clock,
    });
    registerOwnerRoutes(app, service, false);
    app.put('/api/settings', async () => ({ success: true }));
    app.get('/ws/sessions/:id/terminal', async () => ({ success: true }));
    app.post('/api/sessions/:id/input', async () => ({ success: true }));
    app.get('/api/sessions/:id/terminal', async () => ({ success: true }));
    app.get('/api/sessions/:id', async () => ({ success: true }));
    app.delete('/api/sessions/:id', async () => ({ success: true }));
    app.post('/api/quick-start', async (req) => ({ success: true, data: { body: req.body } }));
    app.get('/', async () => 'app');
    await app.ready();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owner-auth-review-'));
    store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    clock = 1_700_000_000_000;
    ctoEmployee = undefined;
    rooms.length = 1;
    oneTime = (await admin.bootstrap(store, USER, { now: clock })).oneTimePassword;
    await build();
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cookie = (res: { cookies: Array<{ name: string; value: string }> }, name = OWNER_COOKIE) =>
    res.cookies.find((c) => c.name === name)?.value;
  const login = (password: string, remoteAddress = '127.0.0.1', cookies: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: { username: USER, password },
      remoteAddress,
      cookies,
    });
  async function owner(): Promise<string> {
    const first = await login(oneTime);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTime, next: PASSWORD },
      cookies: { [OWNER_COOKIE]: cookie(first)! },
      headers: ORIGIN,
    });
    expect(changed.statusCode).toBe(200);
    return cookie(changed)!;
  }
  const audit = () => readFile(join(dir, 'owner-auth-audit.jsonl'), 'utf8').catch(() => '');
  // Audit lines are appended fire-and-forget (a slow disk never delays a request): wait for them.
  const audited = (pattern: RegExp | string) =>
    vi.waitFor(async () => (typeof pattern === 'string' ? expect(await audit()).toContain(pattern) : expect(await audit()).toMatch(pattern)));

  describe('B1: classification by the matched route', () => {
    it.each([
      ['PUT', '/%61pi/settings'],
      ['PUT', '/%61%70%69/settings'],
      ['GET', '/%77s/sessions/x/terminal'],
      ['PUT', '/API/settings'],
      ['PUT', '/api//settings'],
      ['PUT', '/api/./settings'],
      ['PUT', '/static/../api/settings'],
      ['PUT', '/%2e%2e/api/settings'],
      ['GET', '/%E0%A4%A'],
    ])('refuses an anonymous %s %s under enforce', async (method, url) => {
      await app.close();
      await build('enforce');
      const res = await app.inject({ method: method as 'GET' | 'PUT', url });
      // 401 from the policy, or 400 where the router itself rejects an undecodable URL: never the handler.
      expect([400, 401], url).toContain(res.statusCode);
    });

    it('classifies an unmatched path by its decoded form', () => {
      for (const url of ['/%61pi/x', '/%2Fapi/x', '//api/x', '/%57S/x', '/a/../api/x', '/x/..', '/%E0%A4%A']) {
        expect(classify('GET', undefined, url), url).toBe('owner');
      }
      expect(classify('GET', undefined, '/assets/app.js')).toBe('public');
      expect(classify('GET', undefined, '/apiary')).toBe('public');
    });
  });

  describe('H1: agents act only on related sessions', () => {
    const asAgent = { 'x-codeman-parent-session': A };
    it('allows itself, descendants and members of rooms it coordinates; refuses any other session', async () => {
      await app.close();
      await build('enforce');
      for (const [target, status, readStatus] of [
        [A, 200, 200],
        [CHILD, 200, 200],
        [GRANDCHILD, 200, 200],
        [MEMBER, 200, 403], // a room member: input only (v5)
        [STRANGER, 403, 403],
      ] as Array<[string, number, number]>) {
        const input = await app.inject({
          method: 'POST',
          url: `/api/sessions/${target}/input`,
          headers: asAgent,
          payload: {},
        });
        expect(input.statusCode, `input ${target}`).toBe(status);
        const read = await app.inject({ method: 'GET', url: `/api/sessions/${target}/terminal`, headers: asAgent });
        expect(read.statusCode, `terminal ${target}`).toBe(readStatus);
      }
      // Metadata stays readable; the owner reaches everything.
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${STRANGER}`, headers: asAgent })).statusCode).toBe(
        200
      );
    });

    it('the relation follows the spawn chain and coordinated rooms only', () => {
      const { related } = relations(sources());
      expect(related(A, GRANDCHILD)).toBe(true);
      expect(related(CHILD, A)).toBe(false); // a child does not reach its parent (only by input, upward)
      expect(related(A, STRANGER)).toBe(false);
    });
  });

  describe('H2: no caller can lock the owner out everywhere', () => {
    it('a loopback flood locks only loopback; the owner signs in from elsewhere and with a remembered device', async () => {
      const session = await owner();
      // Remember this device via two-step.
      const start = await app.inject({
        method: 'POST',
        url: '/api/owner/2fa/start',
        cookies: { [OWNER_COOKIE]: session },
        headers: ORIGIN,
      });
      const secret = start.json().data.secret as string;
      const code = () => hotp(base32Decode(secret), totpStep(clock));
      await app.inject({
        method: 'POST',
        url: '/api/owner/2fa/confirm',
        payload: { code: code() },
        cookies: { [OWNER_COOKIE]: session },
        headers: ORIGIN,
      });
      clock += 30_000;
      const challenge = (await login(PASSWORD, '192.168.4.28')).json().data.challenge;
      const remembered = await app.inject({
        method: 'POST',
        url: '/api/owner/login/second-factor',
        payload: { challenge, code: code(), remember: true },
        remoteAddress: '192.168.4.28',
      });
      const device = cookie(remembered, DEVICE_COOKIE)!;
      // Agents on loopback (any 127/8 address counts as one source) lock it.
      for (let i = 0; i < 12; i++) {
        clock += 6 * 60 * 1000;
        await login('wrong-password', `127.0.0.${(i % 3) + 1}`);
      }
      expect((await login(PASSWORD, '127.0.0.9')).statusCode).toBe(429);
      await audited('lockout_started');
      // The owner's own device, even from a locked source, is not affected.
      expect((await login(PASSWORD, '127.0.0.1', { [DEVICE_COOKIE]: device })).statusCode).toBe(200);
      // Another source is not affected (it has its own bucket).
      clock += 30_000;
      expect((await login(PASSWORD, '192.168.4.28')).json().data.next).toBe('second-factor');
    });

    it('escalation decays: a success or a quiet day starts the bucket over', () => {
      const locked = { failures: 0, lastFailureAt: 0, lockedUntil: 1000, lockouts: 5 };
      expect(current(locked, 1000 + DECAY_MS).lockouts ?? 0).toBe(0);
      expect(current({ failures: 4, lastFailureAt: 5, lockedUntil: 0, lockouts: 2 }, 5 + DECAY_MS).failures).toBe(0);
      expect(current({ failures: 4, lastFailureAt: 5, lockedUntil: 0, lockouts: 2 }, 5 + DECAY_MS - 1).failures).toBe(
        4
      );
    });
  });

  describe('H3: owner cookie writes from the console origin only; sandboxed web tabs', () => {
    it('refuses an owner write or WebSocket from another origin or without one', async () => {
      const session = await owner();
      await app.close();
      await build('enforce');
      const fresh = cookie(await login(PASSWORD))!;
      void session;
      const put = (headers: Record<string, string>) =>
        app.inject({ method: 'PUT', url: '/api/settings', cookies: { [OWNER_COOKIE]: fresh }, headers });
      expect((await put(ORIGIN)).statusCode).toBe(200);
      expect((await put({})).statusCode).toBe(403);
      expect((await put({ origin: 'http://localhost:5173' })).statusCode).toBe(403); // an agent's dev server
      expect((await put({ origin: 'https://other.example.ts.net', host: 'console.example.ts.net' })).statusCode).toBe(
        403
      );
      expect(
        (await put({ origin: 'https://console.example.ts.net', host: 'console.example.ts.net:443' })).statusCode
      ).toBe(200);
      const ws = await app.inject({
        method: 'GET',
        url: '/ws/sessions/x/terminal',
        cookies: { [OWNER_COOKIE]: fresh },
        headers: { upgrade: 'websocket', connection: 'upgrade', origin: 'http://localhost:5173' },
      });
      expect(ws.statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/api/owner/logout-everywhere', cookies: { [OWNER_COOKIE]: fresh } }))
          .statusCode
      ).toBe(403);
    });

    it('proxied web-tab documents are always sandboxed (no same-origin)', () => {
      expect(withSandbox(undefined)).toMatch(/^sandbox allow-scripts/);
      const merged = withSandbox("default-src 'self'; sandbox allow-same-origin allow-scripts");
      expect(merged).toContain("default-src 'self'");
      expect(merged).not.toContain('allow-same-origin');
    });
  });

  it('M1: a burst from one source is evaluated one at a time', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => login('wrong-password')));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(1);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(9);
  });

  describe('M2: a missing or corrupt account file fails closed', () => {
    it('keeps enforcing when the file disappears, and agents keep working', async () => {
      await app.close();
      await build('enforce');
      expect((await app.inject({ method: 'PUT', url: '/api/settings' })).statusCode).toBe(401);
      await unlink(store.file);
      expect((await app.inject({ method: 'PUT', url: '/api/settings' })).statusCode).toBe(401);
      const agent = await app.inject({
        method: 'GET',
        url: `/api/sessions/${A}/terminal`,
        headers: { 'x-codeman-parent-session': A },
      });
      expect(agent.statusCode).toBe(200);
      await audited('account_file_missing');
    });

    it('a corrupt file does not take the console down', async () => {
      await app.close();
      await build('enforce');
      expect((await app.inject({ method: 'PUT', url: '/api/settings' })).statusCode).toBe(401); // a good copy is seen
      await writeFile(store.file, '{ not json');
      expect((await app.inject({ method: 'PUT', url: '/api/settings' })).statusCode).toBe(401);
      const agent = await app.inject({
        method: 'GET',
        url: `/api/sessions/${A}`,
        headers: { 'x-codeman-parent-session': A },
      });
      expect(agent.statusCode).toBe(200);
      await audited('account_file_corrupt');
      // Sign-in is never checked against the last good copy of a corrupt file.
      expect((await login(PASSWORD)).statusCode).toBe(503);
    });
  });

  it('M3: long-lived connections of ended sessions are closed', async () => {
    const session = await owner();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as unknown as Socket;
    service.track(session, socket);
    expect(service.closeEnded()).toBe(0); // still signed in
    await app.inject({
      method: 'POST',
      url: '/api/owner/logout-everywhere',
      cookies: { [OWNER_COOKIE]: session },
      headers: ORIGIN,
    });
    expect(socket.destroy).toHaveBeenCalled();
  });

  describe('M4: the host CLI is audited and refuses to run inside an agent session', () => {
    it('audits every admin action without secrets', async () => {
      await admin.setPolicy(store, 'enforce');
      const fresh = await admin.resetPassword(store, clock);
      const token = await admin.issueServiceToken(store, 'watcher');
      await admin.unlock(store);
      const log = await audit();
      for (const event of [
        'owner_bootstrapped',
        'policy_changed',
        'password_reset',
        'service_token_issued',
        'unlocked',
      ]) {
        expect(log).toContain(event);
      }
      expect(log).toContain('"actor":"host-cli"');
      for (const secret of [oneTime, fresh, token]) expect(log).not.toContain(secret);
    });

    it('refuses inside an agent session unless --host', () => {
      expect(() => admin.assertHostShell({ CODEMAN_SESSION_ID: A }, false)).toThrow('host shell');
      expect(() => admin.assertHostShell({ CODEMAN_SESSION_ID: A }, true)).not.toThrow();
      expect(() => admin.assertHostShell({}, false)).not.toThrow();
    });
  });

  describe('M5: one-time passwords', () => {
    it('expire after 30 minutes', async () => {
      clock += ONE_TIME_TTL_MS + 1000;
      const res = await login(oneTime);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toContain('expired');
    });

    it('a reset still forces the change when two-step is on', async () => {
      const session = await owner();
      const start = await app.inject({
        method: 'POST',
        url: '/api/owner/2fa/start',
        cookies: { [OWNER_COOKIE]: session },
        headers: ORIGIN,
      });
      const secret = start.json().data.secret as string;
      await app.inject({
        method: 'POST',
        url: '/api/owner/2fa/confirm',
        payload: { code: hotp(base32Decode(secret), totpStep(clock)) },
        cookies: { [OWNER_COOKIE]: session },
        headers: ORIGIN,
      });
      clock += 30_000;
      const reset = await admin.resetPassword(store, clock);
      const challenge = (await login(reset)).json().data.challenge;
      const second = await app.inject({
        method: 'POST',
        url: '/api/owner/login/second-factor',
        payload: { challenge, code: hotp(base32Decode(secret), totpStep(clock)) },
      });
      expect(second.json().data.next).toBe('change-password');
    });
  });

  it('M6: replacing two-step needs a current code; a pending secret expires', async () => {
    const session = await owner();
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url, payload, cookies: { [OWNER_COOKIE]: session }, headers: ORIGIN });
    const first = (await post('/api/owner/2fa/start')).json().data.secret as string;
    await post('/api/owner/2fa/confirm', { code: hotp(base32Decode(first), totpStep(clock)) });
    clock += 30_000;
    expect((await post('/api/owner/2fa/start')).statusCode).toBe(400); // no current code
    expect((await post('/api/owner/2fa/start', { code: '000000' })).statusCode).toBe(401);
    clock += 10_000;
    const replacement = await post('/api/owner/2fa/start', { code: hotp(base32Decode(first), totpStep(clock)) });
    expect(replacement.statusCode).toBe(200);
    const second = replacement.json().data.secret as string;
    clock += 11 * 60 * 1000; // the pending secret expired
    expect(
      (await post('/api/owner/2fa/confirm', { code: hotp(base32Decode(second), totpStep(clock)) })).statusCode
    ).toBe(400);
  });

  it('L1: junk paths in log mode cannot grow the would-deny log', async () => {
    await app.close();
    await build('log');
    for (let i = 0; i < 30; i++) await app.inject({ method: 'GET', url: `/api/junk-${i}` });
    await audited('policy_would_deny');
    const lines = (await audit()).split('\n').filter((l) => l.includes('policy_would_deny'));
    expect(lines).toHaveLength(1);
  });

  it('the sign-in and account page script parses', () => {
    expect(() => new Function(OWNER_SCRIPT)).not.toThrow();
  });

  describe('Delta v4', () => {
    const asAgent = (id: string) => ({ 'x-codeman-parent-session': id });
    const act = (caller: string, method: 'POST' | 'GET' | 'DELETE', target: string) =>
      app.inject({
        method,
        url: method === 'POST' ? `/api/sessions/${target}/input` : method === 'GET' ? `/api/sessions/${target}/terminal` : `/api/sessions/${target}`,
        headers: asAgent(caller),
        ...(method === 'POST' ? { payload: {} } : {}),
      });
    const enforce = async () => {
      await app.close();
      await build('enforce');
    };

    it('D1: the owner cookies never reach a web tab upstream, on either proxy path', () => {
      const raw = 'reverie_owner=tok; Reverie_Owner_Device=dev; codeman_session=s; app=1; theme=dark';
      expect(upstreamCookieHeader(raw, 'codeman_session')).toBe('app=1; theme=dark');
      expect(upstreamCookieHeader(['reverie_owner=tok', 'a=b'], 'codeman_session')).toBe('a=b');
      expect(upstreamCookieHeader('reverie_owner=tok', 'codeman_session')).toBeUndefined();
      const headers = buildUpstreamRequestHeaders({ cookie: raw }, new URL('http://127.0.0.1:9000/'), {
        forwardCookies: true,
        sessionCookieName: 'codeman_session',
      });
      expect(headers.cookie).toBe('app=1; theme=dark');
      // The WebSocket path uses the same filter (and no longer copies the raw header).
      const routes = readFileSync(join(__dirname, '../src/web/routes/webview-routes.ts'), 'utf8');
      expect(routes).toContain('upstreamCookieHeader(req.headers.cookie, AUTH_COOKIE_NAME)');
      expect(routes).not.toMatch(/cookie: String\(req\.headers\.cookie\)/);
    });

    it('D2: next= keeps only same-origin paths, resolved as the browser would', () => {
      const origin = 'https://console.example';
      for (const raw of ['/\t/evil.example', '/\n/evil.example', '//evil.example', '/\\evil.example', 'https://evil.example/x',
        'javascript:alert(1)', '//evil.example//other.example/x', '/\t//evil.example//x', '/owner/login', '/OWNER/account', '', null]) {
        expect(safeNext(raw as string | null, origin), JSON.stringify(raw)).toBe('/');
      }
      expect(safeNext('/session/abc?tab=2#end', origin)).toBe(origin + '/session/abc?tab=2#end');
      expect(safeNext('/a/../b', origin)).toBe(origin + '/b');
      // Dot segments can normalise a path to `//host`; the absolute URL keeps the origin (v5).
      for (const raw of ['/.//evil.example', '/a/..//evil.example', '/./%2E%2E//evil.example']) {
        expect(new URL(safeNext(raw, origin), origin).host, raw).toBe('console.example');
      }
      // The copy embedded in the page script is the same function.
      expect(OWNER_SCRIPT).toContain(safeNext.toString());
      const embedded = new Function('return (' + safeNext.toString() + ')')() as typeof safeNext;
      expect(embedded('/\t/evil.example', origin)).toBe('/');
      expect(embedded('/ok', origin)).toBe(origin + '/ok');
      expect(new URL(embedded('/.//evil.example', origin)).host).toBe('console.example');
    });

    it("D3: an agent cannot retire another session's stopped record, only its own descendants'", async () => {
      await enforce();
      expect((await act(A, 'DELETE', STOPPED)).statusCode).toBe(403);
      expect((await act(A, 'DELETE', STOPPED_CHILD)).statusCode).toBe(200);
      expect((await act(A, 'DELETE', 'unknown-session')).statusCode).toBe(200); // the handler answers 404
    });

    it('D4: a deleted account file plus a restart keeps the policy (fails closed)', async () => {
      await admin.setPolicy(store, 'enforce');
      expect(readFileSync(store.markerFile, 'utf8').trim()).toBe('enforce');
      await app.close();
      await unlink(store.file);
      await build(); // a restart: no last good copy in memory
      expect(service.policy()).toBe('enforce');
      expect((await app.inject({ method: 'PUT', url: '/api/settings' })).statusCode).toBe(401);
      const signIn = await login(PASSWORD);
      expect(signIn.statusCode).toBe(503);
      expect(signIn.json().error).toMatch(/missing/);
      expect((await act(A, 'GET', A)).statusCode).toBe(200); // agents keep working
      await audited(/account_file_missing.*marker/);
      await writeFile(store.markerFile, 'garbage');
      await app.close();
      await build();
      expect(service.policy()).toBe('enforce'); // an unreadable marker fails closed too
      await unlink(store.markerFile);
      await app.close();
      await build();
      expect(service.policy()).toBe('off'); // both removed: nothing was ever set up
    });

    it('D4: an account written before the marker existed gets one', async () => {
      await unlink(store.markerFile);
      await app.close();
      await build();
      service.policy();
      await vi.waitFor(() => expect(readFileSync(store.markerFile, 'utf8').trim()).toBe('log'));
    });

    it('D6: the CLI refusal does not suggest how to bypass it', () => {
      expect(() => admin.assertHostShell({ CODEMAN_SESSION_ID: 'x' }, false)).toThrow(/host shell/);
      expect(() => admin.assertHostShell({ CODEMAN_SESSION_ID: 'x' }, false)).not.toThrow(/--host/);
    });

    it('keepers: an owner-set employee (or the CTO) may nudge and interrupt any session, see status only, never end one', async () => {
      await enforce();
      expect((await act(KEEPER, 'POST', STRANGER)).statusCode).toBe(403);
      await admin.addKeeper(store, EMPLOYEE);
      expect((await act(KEEPER, 'POST', STRANGER)).statusCode).toBe(200);
      // Status only (v5): metadata yes, terminal or transcript no, never ending a session.
      expect((await act(KEEPER, 'GET', STRANGER)).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${STRANGER}`, headers: asAgent(KEEPER) })).statusCode).toBe(200);
      expect((await act(KEEPER, 'DELETE', STRANGER)).statusCode).toBe(403);
      expect((await act(STRANGER, 'POST', KEEPER)).statusCode).toBe(403); // not symmetric
      await admin.removeKeeper(store, EMPLOYEE);
      expect((await act(KEEPER, 'POST', STRANGER)).statusCode).toBe(403);
      // `cto` follows the company's CTO setting.
      await admin.addKeeper(store, 'cto');
      expect((await act(KEEPER, 'POST', STRANGER)).statusCode).toBe(403);
      ctoEmployee = EMPLOYEE;
      expect((await act(KEEPER, 'POST', STRANGER)).statusCode).toBe(200);
      await audited(/"event":"keeper_added".*"actor":"host-cli"/);
      await audited(/"event":"keeper_removed"/);
      await audited(/"event":"keeper_action"/);
      await expect(admin.addKeeper(store, 'not an id!')).rejects.toThrow(/keeper/);
      expect(admin.describe(store).keepers).toEqual(['cto']);
    });

    it('a worker may message (input only) its parent and its coordinator', async () => {
      await enforce();
      expect((await act(CHILD, 'POST', A)).statusCode).toBe(200); // parent
      expect((await act(GRANDCHILD, 'POST', A)).statusCode).toBe(200); // ancestor
      expect((await act(MEMBER, 'POST', A)).statusCode).toBe(200); // its room's coordinator
      expect((await act(CHILD, 'GET', A)).statusCode).toBe(403); // but not read it
      expect((await act(CHILD, 'DELETE', A)).statusCode).toBe(403);
      expect((await act(STRANGER, 'POST', A)).statusCode).toBe(403);
    });

    it("a watcher-restarted session inherits its predecessor's parent, for upward input only", async () => {
      await enforce();
      expect((await act(RESTARTED, 'POST', A)).statusCode).toBe(200); // it can message A
      // The watcher record is writable by agents, so it never gives A control of RESTARTED (v5, N3).
      expect((await act(A, 'POST', RESTARTED)).statusCode).toBe(403);
      expect((await act(A, 'GET', RESTARTED)).statusCode).toBe(403);
      expect((await act(STRANGER, 'POST', RESTARTED)).statusCode).toBe(403);
    });

    it('runtimeLineage reads the watcher record read-only and follows changes', async () => {
      const file = join(dir, 'controller-state.json');
      const lineageOf = runtimeLineage(file);
      expect(lineageOf('new')).toBeUndefined(); // no file
      await writeFile(file, JSON.stringify({ restore_source: { from: 'old', to: 'new' } }));
      expect(lineageOf('new')).toBe('old');
      await writeFile(file, '{ broken');
      await utimes(file, new Date(), new Date(Date.now() + 5000));
      expect(lineageOf('new')).toBeUndefined();
    });
  });

  describe('Delta v5', () => {
    const asAgent = (id: string) => ({ 'x-codeman-parent-session': id });
    const quickStart = (caller: string, parentSessionId?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/quick-start',
        headers: asAgent(caller),
        payload: { caseName: 'x', ...(parentSessionId !== undefined ? { parentSessionId } : {}) },
      });
    const sendInput = (caller: string, target: string) =>
      app.inject({ method: 'POST', url: `/api/sessions/${target}/input`, headers: asAgent(caller), payload: {} });
    const readTerminal = (caller: string, target: string) =>
      app.inject({ method: 'GET', url: `/api/sessions/${target}/terminal`, headers: asAgent(caller) });

    it("N1: an agent cannot declare another session as its new child's parent", async () => {
      await app.close();
      await build('enforce');
      expect((await quickStart(A, STRANGER)).json().data.body).toEqual({ caseName: 'x' }); // dropped: A's own header names the parent
      expect((await quickStart(A, CHILD)).json().data.body.parentSessionId).toBe(CHILD); // its own descendant: kept
      expect((await quickStart(A, A)).json().data.body.parentSessionId).toBe(A);
      expect((await quickStart(A)).json().data.body).toEqual({ caseName: 'x' });
      await audited(/"event":"parent_ignored".*"declared":"eeeeeeee/);
      // The owner and services are not limited.
      const owner = await app.inject({ method: 'POST', url: '/api/quick-start', payload: { parentSessionId: STRANGER } });
      expect(owner.statusCode).toBe(401); // anonymous under enforce
    });

    it('N1: in log mode the declared parent is kept and only audited', async () => {
      await app.close();
      await build('log');
      expect((await quickStart(A, STRANGER)).json().data.body.parentSessionId).toBe(STRANGER);
      await audited(/"reason":"parent_declared"/);
    });

    it('N2: a room gives input only, and only through seats the owner made', async () => {
      await app.close();
      await build('enforce');
      // Owner-made room: A coordinates, MEMBER is in it. Input yes; read and kill no.
      expect((await sendInput(A, MEMBER)).statusCode).toBe(200);
      expect((await readTerminal(A, MEMBER)).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/api/sessions/${MEMBER}`, headers: asAgent(A) })).statusCode).toBe(403);
      // A builds a room around STRANGER (its own coordinator seat and the member it added): nothing.
      rooms.push({ members: [{ sessionId: A, role: 'coordinator', addedBy: A }, { sessionId: STRANGER, role: 'agent', addedBy: A }] });
      expect((await sendInput(A, STRANGER)).statusCode).toBe(403);
      // A adds STRANGER to the owner-made room: still nothing.
      rooms[0].members.push({ sessionId: STRANGER, role: 'agent', addedBy: A });
      expect((await sendInput(A, STRANGER)).statusCode).toBe(403);
      // An agent-made coordinator seat over an owner-placed member: nothing either.
      rooms.push({ members: [{ sessionId: KEEPER, role: 'coordinator', addedBy: KEEPER }, { sessionId: MEMBER, role: 'agent' }] });
      expect((await sendInput(KEEPER, MEMBER)).statusCode).toBe(403);
    });

    it("N3: a forged watcher record never makes an agent the victim's ancestor", async () => {
      const file = join(dir, 'controller-state.json');
      await writeFile(file, JSON.stringify({ restore_source: { from: CHILD, to: STRANGER } })); // STRANGER has no parent
      const forged = relations({ ...sources(), predecessor: runtimeLineage(file) });
      expect(forged.related(A, STRANGER)).toBe(false); // the review's probe R1, flipped
      expect(forged.upward(STRANGER, A)).toBe(true); // what lineage is for: the restarted session reaches up
    });

    it('the review probes R2 and R3 are closed', async () => {
      // R3: a room A coordinates and filled itself.
      const r3 = relations({ ...sources(), rooms: () => [{ members: [{ sessionId: A, role: 'coordinator', addedBy: A }, { sessionId: STRANGER, role: 'agent', addedBy: A }] }] });
      expect(r3.related(A, STRANGER)).toBe(false);
      expect(r3.coordinated(A, STRANGER)).toBe(false);
      // R2 rests on a declared parent, which quick-start no longer records (N1 above). A parent the
      // console did record still allows upward input, by design.
      await app.close();
      await build('enforce');
      expect((await quickStart(STRANGER, A)).json().data.body.parentSessionId).toBeUndefined();
    });
  });
});
