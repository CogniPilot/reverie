import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { previewControl, registerPreviewRoutes } from '../src/web/routes/preview-routes.js';

const app = Fastify();
const control = vi.fn(async () => ({ status: 200, body: { previews: [] } }));
let task: string, full: string, restricted: string;
beforeAll(async () => {
  task = await mkdtemp(join(tmpdir(), 'preview-owner-'));
  const store = new OwnerAuthStore(join(task, 'owner.json'));
  const password = (await bootstrap(store, 'fixture-owner')).oneTimePassword;
  const service = new OwnerAuthService({ store, auditFile: join(task, 'audit.jsonl') });
  await app.register(cookie);
  registerOwnerRoutes(app, service, false);
  registerPreviewRoutes(app, ownerVerifier({ service, ctx: { sessions: new Map() } as never }), control);
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/owner/login',
    payload: { username: 'fixture-owner', password },
  });
  restricted = login.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  const changed = await app.inject({
    method: 'POST',
    url: '/api/owner/password',
    cookies: { [OWNER_COOKIE]: restricted },
    payload: { current: password, next: 'Coral!water71-riverMaple' },
  });
  expect(changed.statusCode).toBe(200);
  full = changed.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
});
afterAll(async () => {
  await app.close();
  await rm(task, { recursive: true, force: true });
});
const cookies = () => ({ [OWNER_COOKIE]: full });
const expose = { sessionId: '11111111-2222-4333-8444-555555555555', port: 8734, path: '/index.html' };

describe('isolated previews owner boundary', () => {
  it('requires a full owner cookie even when global enforcement is off', async () => {
    for (const url of ['/previews', '/previews.js', '/api/previews']) {
      for (const headers of [{}, { 'x-reverie-parent-session': 'agent' }, { 'x-reverie-service-token': 'service' }])
        expect((await app.inject({ url, headers })).statusCode).toBe(403);
      expect((await app.inject({ url, cookies: { [OWNER_COOKIE]: restricted } })).statusCode).toBe(403);
      expect((await app.inject({ url, cookies: cookies() })).statusCode).toBe(200);
    }
  });
  it('rejects same-site preview origins, foreign sites and mixed owner-agent credentials', async () => {
    control.mockClear();
    for (const headers of [
      { origin: 'https://random.preview.example.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'x-reverie-parent-session': 'agent' },
      { 'x-reverie-service-token': 'service' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/previews', cookies: cookies(), headers, payload: expose }))
          .statusCode
      ).toBe(403);
    }
    expect(control).not.toHaveBeenCalled();
  });
  it('only sends a validated session and port to the fixed control socket', async () => {
    control.mockClear();
    const response = await app.inject({ method: 'POST', url: '/api/previews', cookies: cookies(), payload: expose });
    expect(response.statusCode).toBe(200);
    expect(control).toHaveBeenCalledWith('POST', '/previews', expose);
    for (const change of [
      { host: '169.254.169.254' },
      { port: 80 },
      { path: '//evil.test/' },
      { path: '/\\evil.test' },
      { sessionId: 'host' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/previews',
            cookies: cookies(),
            payload: { ...expose, ...change },
          })
        ).statusCode
      ).toBe(400);
  });
  it('handles empty-body DELETE without requiring JSON and never accepts an arbitrary control path', async () => {
    const id = 'a'.repeat(32);
    const response = await app.inject({ method: 'DELETE', url: '/api/previews/' + id, cookies: cookies() });
    expect(response.statusCode).toBe(200);
    expect(control).toHaveBeenCalledWith('DELETE', '/previews/' + id, undefined);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/previews/not-a-preview', cookies: cookies() })).statusCode
    ).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('returns a useful unavailable state instead of silently using the main origin', async () => {
    control.mockRejectedValueOnce(new Error('missing socket'));
    const response = await app.inject({ url: '/api/previews', cookies: cookies() });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('not configured');
  });
  it('uses the actual Unix socket transport without credentials or body headers on DELETE', async () => {
    const socketPath = join(task, 'preview.sock');
    const previous = process.env.REVERIE_PREVIEW_SOCKET;
    process.env.REVERIE_PREVIEW_SOCKET = socketPath;
    const seen: unknown[] = [];
    const server = createServer((request, response) => {
      seen.push({
        method: request.method,
        path: request.url,
        auth: request.headers.authorization,
        type: request.headers['content-type'],
      });
      response.setHeader('Content-Type', 'application/json');
      response.end('{"success":true}');
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(await previewControl('DELETE', '/previews/' + 'a'.repeat(32))).toEqual({
        status: 200,
        body: { success: true },
      });
      expect(seen).toEqual([
        { method: 'DELETE', path: '/previews/' + 'a'.repeat(32), auth: undefined, type: undefined },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.REVERIE_PREVIEW_SOCKET;
      else process.env.REVERIE_PREVIEW_SOCKET = previous;
    }
  });
});
