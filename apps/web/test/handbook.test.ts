import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHandbookRoutes, HANDBOOK_PAGES, renderHandbookMarkdown } from '../src/web/routes/handbook-routes.js';
import { classify } from '../src/owner-auth/policy.js';
import { employeeProfileContext } from '../src/company-types.js';
import { createHarness } from './helpers/chat-app-harness.mjs';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function setup(dir?: string) {
  const app = Fastify();
  registerHandbookRoutes(app, dir);
  apps.push(app);
  return app;
}

describe('shared office handbook', () => {
  it('serves the same current Markdown to agents, raw readers and escaped human pages', async () => {
    const app = setup();
    const index = await app.inject('/api/handbook');
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.json().data.pages).toHaveLength(HANDBOOK_PAGES.length);
    for (const p of index.json().data.pages) {
      const api = await app.inject(p.apiUrl),
        raw = await app.inject(p.markdownUrl),
        html = await app.inject(p.url);
      expect(api.statusCode).toBe(200);
      expect(raw.statusCode).toBe(200);
      expect(html.statusCode).toBe(200);
      expect(raw.body).toBe(api.json().data.markdown);
      expect(html.body).toContain(renderHandbookMarkdown(raw.body));
      expect(raw.headers['content-type']).toContain('text/markdown');
      expect(html.headers['content-security-policy']).toContain("default-src 'none'");
      expect(html.body).toContain('aria-current="page"');
      expect(html.headers['cache-control']).toBe('no-store');
    }
  });
  it('publishes a bounded linked workflow guide for every registered page', async () => {
    const app = setup();
    const expected = [
      'getting-started',
      'board',
      'profiles',
      'models',
      'work',
      'laptops',
      'recovery',
      'power',
      'permissions',
      'operations',
      'memory',
      'plugins',
      'previews',
    ];
    expect(HANDBOOK_PAGES.map((p) => p.slug).sort()).toEqual(expected.sort());
    for (const p of HANDBOOK_PAGES) {
      const raw = (await app.inject('/handbook/' + p.slug + '.md')).body;
      expect(raw.split(/\s+/).length).toBeLessThan(650);
      expect(raw).toMatch(/\[[^\]]+\]\(\/handbook\/[a-z-]+\)/);
      for (const match of raw.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        expect(match[1]).toMatch(/^\/handbook\/[a-z-]+$/);
        expect((await app.inject(match[1])).statusCode).toBe(200);
      }
    }
  });
  it('searches page text and safely renders queries with no script dependencies', async () => {
    const app = setup();
    const result = await app.inject('/handbook?q=retry');
    expect(result.body).toContain('/handbook/recovery');
    expect(result.body).not.toContain('<script');
    const unsafe = await app.inject('/handbook?q=%22%3E%3Cscript%3E');
    expect(unsafe.body).not.toContain('<script>');
    expect(unsafe.body).toContain('&quot;&gt;&lt;script&gt;');
    expect((await app.inject('/handbook?q=' + 'x'.repeat(201))).statusCode).toBe(400);
  });
  it('rejects unknown pages and traversal without reading arbitrary project files', async () => {
    const app = setup();
    for (const url of ['/api/handbook/unknown', '/handbook/company.json', '/api/handbook/..%2F..%2Fcompany.json']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('ENOENT');
    }
    expect((await setup('/nonexistent-handbook-fixture').inject('/api/handbook/recovery')).statusCode).toBe(503);
  });
  it('keeps raw HTML and executable links inert', () => {
    const html = renderHandbookMarkdown(
      '<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[Good](/handbook/recovery)\n\n```\n<script>alert(1)</script>\n```'
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="/handbook/recovery"');
  });
  it('permits scoped agent reads without adding any write or owner permission', () => {
    expect(classify('GET', '/api/handbook', '/api/handbook')).toBe('agent');
    expect(classify('GET', '/api/handbook/:slug', '/api/handbook/recovery')).toBe('agent');
    expect(classify('POST', '/api/handbook/:slug', '/api/handbook/recovery')).toBe('owner');
  });
  it('puts handbook pointers and the actual recovery grant in ordinary agent context', () => {
    const e = {
      name: 'River',
      position: 'CTO',
      expertise: ['reviews'],
      permissions: { recoverEmployees: false, moveOwnPlan: false, managePlans: false },
    };
    const disabled = employeeProfileContext(e);
    expect(disabled).toContain('GET /api/handbook');
    expect(disabled).toContain('/api/handbook/recovery');
    expect(disabled).toContain('Recovery grant: disabled');
    expect(employeeProfileContext({ ...e, permissions: { ...e.permissions, recoverEmployees: true } })).toContain(
      'Recovery grant: enabled'
    );
  });
  it('makes the handbook discoverable from the Office page', async () => {
    const h = await createHarness();
    try {
      const previous = h.app._chatApi.bind(h.app);
      h.app._chatApi = (path: string, options: any) => path === '/api/company'
        ? Promise.resolve({ ok: true, data: { canManage: true } })
        : path === '/api/chatrooms/phone-status'
          ? Promise.resolve({ ok: true, data: { self: 'owner', canSetOwn: true } })
          : previous(path, options);
      h.shell.openPage('office');
      await h.flush();
      const button = h.document.querySelector('[aria-label="Handbook"]') as HTMLButtonElement;
      expect(button).not.toBeNull();
      button.click();
      await h.flush();
      expect(h.document.querySelector('iframe[src="/handbook"]')).not.toBeNull();
    } finally {
      h.window.close();
    }
  });
});
