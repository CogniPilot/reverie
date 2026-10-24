/** Real TLS preview, real owner login and browser origin/storage isolation. Synthetic files only. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, setPolicy } from '../src/owner-auth/admin.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerPreviewRoutes } from '../src/web/routes/preview-routes.js';

it('opens a real HTTPS agent page and WASM, blocks office API/storage access and revokes it', async () => {
  const task = await mkdtemp(join(tmpdir(), 'previews-browser-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(task, 'key.pem'),
      '-out',
      join(task, 'cert.pem'),
      '-subj',
      '/CN=*.preview.test',
      '-addext',
      'subjectAltName=DNS:*.preview.test',
    ],
    { stdio: 'ignore' }
  );
  const previous = process.env.REVERIE_PREVIEW_SOCKET;
  process.env.REVERIE_PREVIEW_SOCKET = join(task, 'preview.sock');
  const child = spawn('python3', [resolve('../../tests/fixtures/preview_browser.py'), task], {
    env: { ...process.env, PYTHONPATH: resolve('../../python') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = Fastify();
  let errors = '';
  child.stderr.on('data', (value) => {
    errors += value;
  });
  const browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP *.preview.test 127.0.0.1', '--no-proxy-server'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const started = await new Promise<{ upstreamPort: number }>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Preview fixture did not start: ' + errors)), 10000);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Preview fixture exited: ' + errors));
      });
      child.stdout.on('data', (value) => {
        output += value;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        resolve(JSON.parse(output.trim()));
      });
    });
    const store = new OwnerAuthStore(join(task, 'owner.json'));
    const password = (await bootstrap(store, 'fixture-owner')).oneTimePassword;
    await setPolicy(store, 'enforce', { forceLockoutRisk: true });
    const service = new OwnerAuthService({ store, auditFile: join(task, 'owner-audit.jsonl') });
    const ctx = { sessions: new Map() } as never;
    await app.register(cookie);
    registerOwnerPolicy(app, {
      service,
      ctx,
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
    registerPreviewRoutes(app, ownerVerifier({ service, ctx }));
    let sensitiveReads = 0;
    app.get('/api/private-fixture', async () => {
      sensitiveReads++;
      return { secret: 'owner-only' };
    });
    app.get('/api/company', async () => ({
      success: true,
      data: { employees: [{ name: 'Fixture laptop', sessionId: '11111111-2222-4333-8444-555555555555' }] },
    }));
    app.get('/bots.css', async (_request, reply) => reply.type('text/css').send('body{font-family:sans-serif}'));
    const listening = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = listening.replace('127.0.0.1', 'localhost');
    const context = await browser.newContext({ ignoreHTTPSErrors: true }); // Only this synthetic self-signed fixture.
    expect(
      (
        await context.request.post(base + '/api/owner/login', { data: { username: 'fixture-owner', password } })
      ).status()
    ).toBe(200);
    expect(
      (
        await context.request.post(base + '/api/owner/password', {
          headers: { Origin: base },
          data: { current: password, next: 'Fuchsia!river73-lanternQuartz' },
        })
      ).status()
    ).toBe(200);
    const owner = await context.newPage();
    await owner.goto(base + '/previews');
    await owner.evaluate(() => localStorage.setItem('owner-private', 'not-for-preview'));
    await owner.getByLabel('Laptop', { exact: true }).selectOption('11111111-2222-4333-8444-555555555555');
    await owner.getByLabel('Port', { exact: true }).fill(String(started.upstreamPort));
    const popup = owner.waitForEvent('popup');
    await owner.getByRole('button', { name: 'Expose and open', exact: true }).click();
    const preview = await popup;
    await preview.waitForURL(/^https:\/\/[a-f0-9]{32}\.preview\.test:/);
    await preview.getByText('Agent page ready', { exact: true }).waitFor();
    const state = await preview.evaluate(async (office) => {
      let apiReadable = false;
      try {
        await (await fetch(office + '/api/private-fixture', { credentials: 'include' })).json();
        apiReadable = true;
      } catch {
        /* CSP/CORS deny. */
      }
      let openerReadable = false;
      try {
        openerReadable = window.opener !== null && !!window.opener.localStorage.getItem('owner-private');
      } catch {
        /* SOP denies. */
      }
      const wasm = await WebAssembly.compileStreaming(fetch('/module.wasm'));
      return {
        apiReadable,
        openerReadable,
        openerNull: window.opener === null,
        stored: localStorage.getItem('owner-private'),
        cookie: document.cookie,
        secure: window.isSecureContext,
        isolated: crossOriginIsolated,
        wasm: wasm instanceof WebAssembly.Module,
      };
    }, base);
    expect(state).toEqual({
      apiReadable: false,
      openerReadable: false,
      openerNull: true,
      stored: null,
      cookie: '',
      secure: true,
      isolated: true,
      wasm: true,
    });
    expect(sensitiveReads).toBe(0);
    const allCookies = await context.cookies();
    expect(allCookies.find((c) => c.name === 'reverie_owner')?.domain).toBe('localhost');
    const previewCookie = allCookies.find((c) => c.name === '__Host-reverie_preview');
    expect(previewCookie?.httpOnly).toBe(true);
    expect(previewCookie?.secure).toBe(true);
    expect(previewCookie?.domain).toBe(new URL(preview.url()).hostname);
    const leaked = await preview.evaluate(async () => (await fetch('/seen')).json());
    for (const headers of leaked) expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie');
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    expect((await other.request.get(base + '/api/previews')).status()).toBe(401);
    const stranger = await other.newPage();
    expect((await stranger.goto(preview.url()))?.status()).toBe(403);
    await owner.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    await owner.getByText('No laptop ports are exposed.', { exact: true }).waitFor();
    expect((await preview.reload())?.status()).toBe(404);
    await other.close();
    await context.close();
  } finally {
    await browser.close();
    await app.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    if (previous === undefined) delete process.env.REVERIE_PREVIEW_SOCKET;
    else process.env.REVERIE_PREVIEW_SOCKET = previous;
    await rm(task, { recursive: true, force: true });
  }
}, 30000);
