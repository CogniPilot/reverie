/**
 * @fileoverview Tests for status-page-routes: stable names that redirect to an html-view page.
 *
 * Real files in a temp dir (no fs mocks), like html-view-routes.test.ts: the route's job is
 * its path policy, and a mocked realpath would make every containment check pass.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { HTML_VIEW_CSP, registerHtmlViewRoutes } from '../../src/web/routes/html-view-routes.js';
import { registerStatusPageRoutes, type StatusPage } from '../../src/web/routes/status-page-routes.js';
import { htmlViewCapabilities } from '../../src/html-view-capabilities.js';
import { isAppPage } from '../../src/owner-auth/policy.js';

describe('status page routes', () => {
  let harness: RouteTestHarness;
  let root: string;
  let pages: Record<string, StatusPage>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'status-page-'));
    const site = join(root, 'site');
    mkdirSync(join(site, 'sub'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<h1>status</h1>');
    writeFileSync(join(site, 'sub', 'deep.html'), '<h1>deep</h1>');
    writeFileSync(join(site, 'notes.txt'), 'text');
    writeFileSync(join(root, 'outside.html'), '<h1>outside</h1>');
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, '.hidden', 'index.html'), '<h1>hidden</h1>');
    const escape = join(root, 'escape'); mkdirSync(escape);
    symlinkSync(join(root, 'outside.html'), join(escape, 'index.html'));
    const deep = join(root, 'deep'); mkdirSync(join(deep, 'sub'), { recursive: true });
    writeFileSync(join(deep, 'sub', 'real.html'), '<h1>real</h1>');
    symlinkSync(join(deep, 'sub', 'real.html'), join(deep, 'index.html'));
    pages = {
      board: { dir: site, entry: 'index.html' },
      missingdir: { dir: join(root, 'nope'), entry: 'index.html' },
      missingentry: { dir: site, entry: 'absent.html' },
      textentry: { dir: site, entry: 'notes.txt' },
      pathentry: { dir: site, entry: 'sub/deep.html' },
      relative: { dir: 'site', entry: 'index.html' },
      hidden: { dir: join(root, '.hidden'), entry: 'index.html' },
      broad: { dir: tmpdir(), entry: 'index.html' },
      escape: { dir: escape, entry: 'index.html' },
      intosub: { dir: deep, entry: 'index.html' },
    };
    harness = await createRouteTestHarness((app, ctx) => {
      registerHtmlViewRoutes(app, ctx);
      registerStatusPageRoutes(app, async () => pages);
    });
  });

  afterEach(async () => {
    await harness.app.close();
    htmlViewCapabilities.revokeOwner(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const get = (url: string) => harness.app.inject({ method: 'GET', url });

  it('redirects a configured name to a live html-view page, relative to the base path', async () => {
    const res = await get('/status/board');
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    const location = String(res.headers.location);
    expect(location).toMatch(/^\.\.\/html-view\/[A-Za-z0-9_-]{16,}\/index\.html$/);
    const page = await get(new URL(location, 'http://console/status/board').pathname);
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe('<h1>status</h1>');
    expect(page.headers['content-security-policy']).toBe(HTML_VIEW_CSP);
  });

  it('is a stable bookmark: every visit gets a live capability for the same page', async () => {
    const first = String((await get('/status/board')).headers.location);
    expect(String((await get('/status/board')).headers.location)).toBe(first);
    htmlViewCapabilities.revokeOwner(undefined); // what a restart or the TTL does
    const again = await get('/status/board');
    expect(again.statusCode).toBe(302);
    expect(String(again.headers.location)).not.toBe(first);
    expect((await get(new URL(String(again.headers.location), 'http://console/status/board').pathname)).statusCode).toBe(200);
  });

  it('refuses unknown and malformed names', async () => {
    expect((await get('/status/unknown')).statusCode).toBe(404);
    expect((await get('/status/UPPER')).statusCode).toBe(404);
    expect((await get('/status/..')).statusCode).toBe(404);
  });

  it('reports a page that has not been generated', async () => {
    expect((await get('/status/missingdir')).statusCode).toBe(404);
    expect((await get('/status/missingentry')).statusCode).toBe(404);
  });

  it('refuses a misconfigured entry or directory', async () => {
    expect((await get('/status/textentry')).statusCode).toBe(500);
    expect((await get('/status/pathentry')).statusCode).toBe(500);
    expect((await get('/status/relative')).statusCode).toBe(500);
  });

  it('refuses an entry that links out of its directory or into a subdirectory', async () => {
    expect((await get('/status/escape')).statusCode).toBe(404);
    expect((await get('/status/intosub')).statusCode).toBe(404);
  });

  it('applies the html-view admission: no hidden directories, no broad roots', async () => {
    expect((await get('/status/hidden')).statusCode).toBe(403);
    expect((await get('/status/broad')).statusCode).toBe(403);
  });

  it('sends a signed-out browser to login for a status page, like the console root', () => {
    const req = { method: 'GET', url: '/status/board', headers: { accept: 'text/html' } } as unknown as FastifyRequest;
    expect(isAppPage(req, '/status/:name')).toBe(true);
    expect(isAppPage(req, '/board')).toBe(false);
  });
});
