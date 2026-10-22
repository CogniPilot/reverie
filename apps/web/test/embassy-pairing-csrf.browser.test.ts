/**
 * Two-scan pairing CSRF marker in a real browser (integration pins r1 §1; Inspector's console r2 check).
 *
 * The console's Origin allowlist matches by hostname and accepts any IP literal, so a page served from another
 * port of the same host passes it, and the SameSite=Strict owner cookie is same-site across ports. What stops
 * that page is the marker: CORS never allows `X-Reverie-CSRF`, so its preflight fails and the request is never
 * sent. Without the marker the request is simple and is sent, and the route refuses it before doing anything.
 * The routes run behind the real host guard and security headers (CORS) of the console.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { registerEmbassyPairingRoutes } from '../src/web/routes/embassy-pairing-routes.js';
import { registerHostGuard, registerSecurityHeaders } from '../src/web/middleware/auth.js';
import { buildHostPolicy } from '../src/web/network-auth-policy.js';
import type { EmbassyHost } from '../src/embassy-host.js';
import type { EmbassyPairing } from '../src/embassy-pairing.js';

const HANDLE = 'a'.repeat(32);
const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

let browser: Browser;
let context: BrowserContext;
let app: FastifyInstance;
let other: http.Server;
let consoleOrigin = '';
let otherOrigin = '';
/** Backend calls that a request actually reached (host or pairing method, by name). */
const reached: string[] = [];
/** Every non-preflight request the console answered: method, path, status. */
const seen: { method: string; url: string; status: number; body: string }[] = [];

function stub<T>(names: string[], answer: (name: string) => unknown): T {
  return Object.fromEntries(
    names.map((name) => [
      name,
      async () => {
        reached.push(name);
        return answer(name);
      },
    ])
  ) as T;
}

beforeAll(async () => {
  const host = stub<EmbassyHost>(['status', 'createInvite', 'listInvites'], (name) =>
    name === 'listInvites' ? [] : { status: 'ready' }
  );
  const pairing = stub<EmbassyPairing>(['get', 'list'], () => ({ handle: HANDLE, state: 'pending' }));
  app = Fastify();
  registerSecurityHeaders(app, false);
  registerHostGuard(app, () => buildHostPolicy('127.0.0.1'));
  app.addHook('onSend', (req, reply, payload, done) => {
    if (req.method !== 'OPTIONS') seen.push({ method: req.method, url: req.url, status: reply.statusCode, body: String(payload) });
    done(null, payload);
  });
  registerEmbassyPairingRoutes(
    app,
    host,
    pairing,
    (req) => /(?:^|;\s*)owner=1(?:;|$)/.test(req.headers.cookie ?? ''),
    () => buildHostPolicy('127.0.0.1')
  );
  app.get('/page', (_req, reply) => reply.type('text/html').send(PAGE));
  await app.listen({ host: '127.0.0.1', port: 0 });
  consoleOrigin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  other = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await new Promise((r) => other?.close(r));
});

beforeEach(async () => {
  await context?.close();
  context = await browser.newContext();
  // The owner cookie as the console sets it: HttpOnly, SameSite=Strict, host-only. Cookies ignore the port.
  await context.addCookies([{ name: 'owner', value: '1', url: consoleOrigin, httpOnly: true, sameSite: 'Strict' }]);
  reached.length = 0;
  seen.length = 0;
});

/** fetch from a page at `from` to the console; returns the status, or 'blocked' when the browser refused. */
async function fetchFrom(from: string, path: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
  const page = await context.newPage();
  await page.goto(`${from}${from === consoleOrigin ? '/page' : '/'}`);
  const result = await page.evaluate(
    async ({ url, init }) => {
      try {
        const res = await fetch(url, { ...init, credentials: 'include', mode: 'cors' });
        return res.status;
      } catch {
        return 'blocked';
      }
    },
    { url: `${consoleOrigin}${path}`, init }
  );
  await page.close();
  return result;
}

const marker = { 'X-Reverie-CSRF': '1' };
const json = { ...marker, 'Content-Type': 'application/json' };
const CALLS = [
  { path: '/api/embassy-host/invites', init: { method: 'GET', headers: marker } },
  { path: `/api/embassy-pairing/${HANDLE}`, init: { method: 'GET', headers: marker } }, // a GET that may claim
  { path: '/api/embassy-host', init: { method: 'GET', headers: marker } },
  {
    path: '/api/embassy-host/invites',
    init: { method: 'POST', headers: json, body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) },
  },
];

describe('two-scan pairing CSRF marker in Chromium', () => {
  it('same-origin owner page with the marker reaches every route (harness control)', async () => {
    for (const call of CALLS) expect(await fetchFrom(consoleOrigin, call.path, call.init)).toBe(200);
    expect(reached).toEqual(['listInvites', 'get', 'status', 'createInvite']);
  });

  it('a page on another localhost port cannot send the marker: the preflight fails and nothing is sent', async () => {
    for (const call of CALLS) expect(await fetchFrom(otherOrigin, call.path, call.init)).toBe('blocked');
    expect(seen).toEqual([]);
    expect(reached).toEqual([]);
  });

  it('without the marker the cross-port request is sent, and refused before any backend call', async () => {
    expect(await fetchFrom(otherOrigin, `/api/embassy-pairing/${HANDLE}`, { method: 'GET' })).toBe('blocked');
    expect(await fetchFrom(otherOrigin, '/api/embassy-host/invites', { method: 'GET' })).toBe('blocked');
    // A text/plain POST is a simple request; its Origin passes the hostname allowlist, so the route refuses it.
    expect(
      await fetchFrom(otherOrigin, '/api/embassy-host/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      })
    ).toBe('blocked');
    // Refused by the pairing route itself (the pinned envelope), not by the global guard.
    expect(seen.map((s) => [s.method, s.status, JSON.parse(s.body).errorCode])).toEqual([
      ['GET', 403, 'CSRF_REFUSED'],
      ['GET', 403, 'CSRF_REFUSED'],
      ['POST', 403, 'CSRF_REFUSED'],
    ]);
    expect(reached).toEqual([]);
  });
});
