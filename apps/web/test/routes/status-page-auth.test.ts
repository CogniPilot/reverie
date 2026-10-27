/**
 * @fileoverview The stable status-page route behind the real auth stack: Basic middleware, then the
 * owner policy (enforce), mounted under a base path with server.ts's rewrite and Location prefixing.
 * Only a signed-in owner reaches the settings lookup and the capability mint; every other caller,
 * on GET and HEAD, stops before either. Synthetic fixtures only. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { OfficeAuthService } from '../../src/owner-auth/office.js';
import * as admin from '../../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../../src/owner-auth/routes.js';
import { allowed, classify, registerOwnerPolicy, OWNER_COOKIE, STATUS_PAGE_ROUTE } from '../../src/owner-auth/policy.js';
import { isCapabilityRequest, registerAuthMiddleware } from '../../src/web/middleware/auth.js';
import { registerOfficeRoutes } from '../../src/web/routes/office-routes.js';
import { registerHtmlViewRoutes } from '../../src/web/routes/html-view-routes.js';
import { registerStatusPageRoutes, type StatusPage } from '../../src/web/routes/status-page-routes.js';
import { htmlViewCapabilities } from '../../src/html-view-capabilities.js';
import { joinBasePath, stripBasePath } from '../../src/config/base-path.js';
import { ChatroomStore } from '../../src/chatroom-store.js';
import type { ChatroomService } from '../../src/chatroom-service.js';
import type { SessionPort } from '../../src/web/ports/session-port.js';

const BASE = '/reverie';
const PAGE = BASE + '/status/board';
const SHARED = 'synthetic-shared-password';
const BASIC = 'Basic ' + Buffer.from(`admin:${SHARED}`).toString('base64');
const PASSWORD = 'Synthetic-correct-harbor-42!';
const AGENT = '0000002d-0035-4000-8000-000000000047';
const ORIGIN = { host: 'localhost', origin: 'http://localhost' };

describe('status page route behind the owner policy', () => {
  let root: string, app: FastifyInstance, store: OwnerAuthStore, savedPassword: string | undefined;
  let owner: string, serviceToken: string, lookups: number;
  let mint: ReturnType<typeof vi.spyOn>;

  const call = (method: 'GET' | 'HEAD' | 'POST', url: string, headers: Record<string, string> = {}, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { ...ORIGIN, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(payload ? { payload } : {}),
    } as InjectOptions);
  const withCookie = (token: string, extra: Record<string, string> = {}) => ({ cookie: `${OWNER_COOKIE}=${token}`, ...extra });
  const tokenOf = (res: Awaited<ReturnType<typeof call>>) => {
    const value = res.cookies.find((c) => c.name === OWNER_COOKIE)?.value;
    expect(value, res.body).toBeTruthy();
    return value!;
  };
  const login = async (username: string, secret: string) =>
    tokenOf(await call('POST', BASE + '/api/owner/login', {}, { username, password: secret }));
  const replacePassword = async (token: string, current: string) =>
    tokenOf(await call('POST', BASE + '/api/owner/password', withCookie(token), { current, next: PASSWORD }));
  const invite = async (role: 'limited' | 'owner', username: string) => {
    const made = await call('POST', BASE + '/api/office/accounts', withCookie(owner), { username, name: 'River', role, rooms: [] });
    expect(made.statusCode, made.body).toBe(200);
    return { ...made.json().data, restricted: await login(username, made.json().data.oneTimePassword) };
  };
  /** Neither the page settings nor the capability store were touched. */
  const untouched = () => {
    expect(lookups).toBe(0);
    expect(mint).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'status-page-auth-'));
    mkdirSync(join(root, 'site'));
    writeFileSync(join(root, 'site', 'index.html'), '<h1>status</h1>');
    const pages: Record<string, StatusPage> = { board: { dir: join(root, 'site'), entry: 'index.html' } };
    lookups = 0;
    mint = vi.spyOn(htmlViewCapabilities, 'mint');
    savedPassword = process.env.REVERIE_PASSWORD;
    process.env.REVERIE_PASSWORD = SHARED; // read by the middleware at registration
    store = new OwnerAuthStore(join(root, 'owner-auth.json'));
    const initial = await admin.bootstrap(store, 'fixture-owner', { enforce: true });
    serviceToken = await admin.issueServiceToken(store, 'synthetic-watcher');
    const service = new OfficeAuthService({ store, auditFile: join(root, 'audit.jsonl') }, () => ({ name: 'Owner' }));
    const sessions = new Map([[AGENT, { id: AGENT, owner: undefined }]]);

    // The same wiring as server.ts: strip the base path on the way in, prefix root-absolute Locations on the way out.
    app = Fastify({ rewriteUrl: (req) => stripBasePath(BASE, req.url || '') });
    await app.register(cookie);
    app.addHook('onSend', (_req, reply, payload, done) => {
      const loc = reply.getHeader('location');
      if (typeof loc === 'string') reply.header('location', joinBasePath(BASE, loc));
      done(null, payload);
    });
    registerAuthMiddleware(app, false, BASE, service);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions } as unknown as SessionPort,
      isCapabilityRequest: (req) => isCapabilityRequest(req, BASE),
      basePath: BASE,
      relations: { known: () => true, related: (a, b) => a === b, upward: () => false, keeper: () => false, admin: () => false },
    });
    registerOwnerRoutes(app, service, false);
    const rooms = new ChatroomStore();
    registerOfficeRoutes(app, service, { rooms: () => rooms.list(), room: (id: string) => rooms.get(id) } as unknown as ChatroomService);
    registerHtmlViewRoutes(app, { sessions } as unknown as SessionPort);
    registerStatusPageRoutes(app, async () => {
      lookups++;
      return pages;
    });
    await app.ready();
    owner = await replacePassword(await login('fixture-owner', initial.oneTimePassword), initial.oneTimePassword);
    mint.mockClear();
  });

  afterEach(async () => {
    await app.close();
    mint.mockRestore();
    htmlViewCapabilities.revokeOwner(undefined);
    if (savedPassword === undefined) delete process.env.REVERIE_PASSWORD;
    else process.env.REVERIE_PASSWORD = savedPassword;
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the signed-in owner: a live capability under the base path, and the page through it', async () => {
    const res = await call('GET', PAGE, withCookie(owner, { accept: 'text/html' }));
    expect(res.statusCode, res.body).toBe(302);
    const location = String(res.headers.location);
    expect(location).toMatch(/^\.\.\/html-view\/[A-Za-z0-9_-]{16,}\/index\.html$/);
    expect(mint).toHaveBeenCalledTimes(1);
    const target = new URL(location, 'http://localhost' + PAGE).pathname;
    expect(target.startsWith(BASE + '/html-view/')).toBe(true);
    const page = await call('GET', target); // no cookie: the capability is the credential
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe('<h1>status</h1>');
  });

  it('sends a signed-out browser to login under the base path, and back to the page after it', async () => {
    const res = await call('GET', PAGE, { accept: 'text/html' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(BASE + '/owner/login?next=' + encodeURIComponent('/status/board'));
    untouched();
    // The return trip: next names the page relative to the mount, and the owner then gets through.
    const next = new URL(String(res.headers.location), 'http://localhost').searchParams.get('next')!;
    expect((await call('GET', joinBasePath(BASE, next), withCookie(owner, { accept: 'text/html' }))).statusCode).toBe(302);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('refuses a signed-out non-browser request and Basic auth alone', async () => {
    expect((await call('GET', PAGE)).statusCode).toBe(401);
    expect((await call('GET', PAGE, { authorization: BASIC, accept: 'text/html' })).statusCode).toBe(302); // to login
    expect((await call('GET', PAGE, { authorization: BASIC })).statusCode).toBe(401);
    expect((await call('GET', PAGE, withCookie('forged-cookie'))).statusCode).toBe(401);
    untouched();
  });

  it('refuses agents and service tokens, even with the shared Basic password', async () => {
    // Like the console root: an app page sends every non-owner to the owner login, never to the handler.
    for (const caller of [{ 'x-reverie-parent-session': AGENT }, { 'x-reverie-service-token': serviceToken }]) {
      const res = await call('GET', PAGE, { authorization: BASIC, ...caller });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(BASE + '/owner/login?next=' + encodeURIComponent('/status/board'));
    }
    untouched();
  });

  it('refuses a limited login, before and after its password change, and sends a restricted owner to the account page', async () => {
    const person = await invite('limited', 'coworker');
    expect((await call('GET', PAGE, withCookie(person.restricted, { accept: 'text/html' }))).statusCode).toBe(403);
    const limited = await replacePassword(person.restricted, person.oneTimePassword);
    expect((await call('GET', PAGE, withCookie(limited, { accept: 'text/html' }))).statusCode).toBe(403);
    expect((await call('GET', PAGE, withCookie(limited))).statusCode).toBe(403);
    const second = await invite('owner', 'second-owner');
    const restricted = await call('GET', PAGE, withCookie(second.restricted, { accept: 'text/html' }));
    expect(restricted.statusCode).toBe(302);
    expect(restricted.headers.location).toBe(BASE + '/owner/account');
    untouched();
  });

  it('is owner-class for every method, not only the GET that the login redirect covers', () => {
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
      expect(classify(method, STATUS_PAGE_ROUTE, '/status/board'), method).toBe('owner');
      for (const caller of ['agent', 'service', 'anonymous', 'invalid', 'limited'] as const)
        expect(allowed('owner', caller), caller).toBe(false);
    }
  });

  it('has no HEAD route: HEAD reaches neither the settings nor the mint, for any caller', async () => {
    const person = await invite('limited', 'coworker');
    const limited = await replacePassword(person.restricted, person.oneTimePassword);
    for (const headers of [
      withCookie(owner),
      {},
      { accept: 'text/html' },
      withCookie(limited),
      { authorization: BASIC, 'x-reverie-parent-session': AGENT },
      { authorization: BASIC, 'x-reverie-service-token': serviceToken },
    ]) {
      const res = await call('HEAD', PAGE, headers);
      expect([401, 403, 404], JSON.stringify(headers)).toContain(res.statusCode);
      expect(res.headers.location).toBeUndefined();
    }
    expect((await call('HEAD', PAGE, withCookie(owner))).statusCode).toBe(404);
    untouched();
  });
});
