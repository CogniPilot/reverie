/** The exact wire shape of the preview routes behind the real console server, which previews.js and its fixtures rely on. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';

let server: WebServer, directory: string, cookie: string, proxy: Server | undefined;
const headers = { host: 'localhost', origin: 'http://localhost' }, password = 'fixture-amber-harbor-lantern-37-Q';
const previous = process.env.REVERIE_PREVIEW_SOCKET;
const owner = (method: 'GET' | 'POST', url: string, payload?: object) =>
  server.app.inject({ method, url, headers: { ...headers, cookie }, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'preview-envelope-'));
  const auth = new OwnerAuthService({ store: new OwnerAuthStore(dataPath('owner-auth.json')),
    auditFile: dataPath('owner-auth-audit.jsonl'), setupEnabled: true });
  await auth.setup('fixture-owner', password, password, '127.0.0.1');
  server = new WebServer(0, false, true, '127.0.0.1');
  await server.start();
  const login = await server.app.inject({ method: 'POST', url: '/api/owner/login', headers, payload: { username: 'fixture-owner', password } });
  cookie = 'reverie_owner=' + login.cookies.find((item: { name: string }) => item.name === 'reverie_owner')!.value;
}, 30000);
afterAll(async () => {
  if (previous === undefined) delete process.env.REVERIE_PREVIEW_SOCKET; else process.env.REVERIE_PREVIEW_SOCKET = previous;
  await new Promise<void>(resolve => (proxy ? proxy.close(() => resolve()) : resolve()));
  await server?.stop();
  await rm(directory, { recursive: true, force: true });
});

it('wraps the preview service reply in the console envelope: listing and errors are its data', async () => {
  const socket = join(directory, 'preview.sock');
  proxy = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { previews: [] } : { preview: { id: 'a'.repeat(32) }, url: 'https://x.preview.test/' }));
  });
  await new Promise<void>(resolve => proxy!.listen(socket, resolve));
  process.env.REVERIE_PREVIEW_SOCKET = socket;
  const listing = await owner('GET', '/api/previews');
  expect({ status: listing.statusCode, body: listing.json() }).toEqual({ status: 200, body: { success: true, data: { previews: [] } } });

  process.env.REVERIE_PREVIEW_SOCKET = join(directory, 'missing.sock');
  const missing = await owner('GET', '/api/previews');
  expect(missing.statusCode).toBe(503);
  // The error a person needs is inside data, not at the top level: previews.js must read it there.
  expect(missing.json()).toEqual({ success: true, data: { error: expect.stringContaining('HTTPS preview service is not configured') } });
  const company = await owner('GET', '/api/company');
  expect(company.json()).toMatchObject({ success: true, data: { employees: expect.any(Array) } });
});
