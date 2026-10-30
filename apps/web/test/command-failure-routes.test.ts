import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCommandFailureRoutes } from '../src/web/routes/command-failure-routes.js';
import { parseFailureReport } from '../src/command-failure-reports.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const row = (id = A) => ({ employee_id: id, harness: 'hands', status: 'ready',
  counts: [{ tool: 'zip', category: 'COMMAND_NOT_FOUND', exit: 127, count: 2 }],
  truncated: false, evicted: 0, expired: 0, dropped: 0 });
const report = (ids = [A]) => ({ v: 1, enabled: true, provenance: 'SELF_REPORTED_RESULT',
  harness_support: { hands: 'self_reported', claude: 'unavailable', codex: 'unavailable' },
  employees: ids.map(id => row(id)),
  top_repeats: [{ tool: 'zip', category: 'COMMAND_NOT_FOUND', exit: 127, count: 2 * ids.length, employee_count: ids.length }],
  truncated: false });
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function setup(options: { verify?: boolean; rows?: { id: string; owner?: string }[]; read?: (ids: readonly string[]) => Promise<unknown> } = {}) {
  const app = Fastify({ logger: false }); apps.push(app);
  const state = { owner: true, rows: options.rows ?? [{ id: A, owner: 'fixture' }] };
  const read = vi.fn(options.read ?? (async (ids: readonly string[]) => report([...ids])));
  const page = vi.fn(async () => '<main>Fixed metadata view</main>');
  registerCommandFailureRoutes(app, {
    verifiedOwner: options.verify === false ? undefined : () => state.owner,
    employees: () => state.rows,
    read: read as never, page,
  });
  return { app, state, read, page };
}

describe('owner-only command failure metadata', () => {
  it('refuses absent/limited/agent/service authority before any metadata or page read', async () => {
    const missing = setup({ verify: false });
    for (const path of ['/command-failures', '/command-failures.js', '/command-failures.css', '/api/company/command-failures']) expect((await missing.app.inject(path)).statusCode).toBe(403);
    expect(missing.read).not.toHaveBeenCalled(); expect(missing.page).not.toHaveBeenCalled();
    const scoped = setup();
    for (const headers of [{ 'x-reverie-parent-session': A }, { 'x-reverie-service-token': 'synthetic' }]) {
      expect((await scoped.app.inject({ url: '/api/company/command-failures', headers })).statusCode).toBe(403);
    }
    scoped.state.owner = false;
    expect((await scoped.app.inject('/api/company/command-failures')).statusCode).toBe(403);
    expect(scoped.read).not.toHaveBeenCalled();
  });
  it('publishes validated per-agent metadata and no-store page for the current owner', async () => {
    const { app, read } = setup();
    const response = await app.inject('/api/company/command-failures');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().data).toEqual(report()); expect(read).toHaveBeenCalledWith([A]);
    const page = await app.inject('/command-failures');
    expect(page.statusCode).toBe(200); expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    for (const asset of ['command-failures.js', 'command-failures.css']) {
      const response = await app.inject('/' + asset);
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    }
  });
  it('never accepts a caller-selected harness, path, command or unknown employee', async () => {
    const { app, read } = setup();
    for (const query of ['harness=claude', 'path=synthetic', 'command=synthetic', 'employeeId=bad', `employeeId=${A}&employeeId=${B}`]) {
      expect((await app.inject('/api/company/command-failures?' + query)).statusCode).toBe(400);
    }
    expect((await app.inject('/api/company/command-failures?employeeId=' + B)).statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it('rechecks logout after a slow report and drops all data', async () => {
    const fixture = setup();
    fixture.read.mockImplementation(async () => { fixture.state.owner = false; return report(); });
    const response = await fixture.app.inject('/api/company/command-failures');
    expect(response.statusCode).toBe(403); expect(response.body).not.toContain('COMMAND_NOT_FOUND');
  });
  it('rechecks logout after slow page loading', async () => {
    const fixture = setup();
    fixture.page.mockImplementation(async () => { fixture.state.owner = false; return 'SYNTHETIC_PRIVATE'; });
    const response = await fixture.app.inject('/command-failures');
    expect(response.statusCode).toBe(403); expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
  });
  it('refuses owner/EID rebinding, deletion and duplicate identities after the await', async () => {
    for (const rows of [[{ id: A, owner: 'changed' }], [], [{ id: A, owner: 'fixture' }, { id: A, owner: 'changed' }]]) {
      const fixture = setup();
      fixture.read.mockImplementation(async () => { fixture.state.rows = rows; return report(); });
      expect((await fixture.app.inject('/api/company/command-failures?employeeId=' + A)).statusCode).toBe(409);
    }
  });
  it('all-employees read cannot silently omit a newly added employee', async () => {
    const fixture = setup();
    fixture.read.mockImplementation(async () => { fixture.state.rows.push({ id: B, owner: 'fixture' }); return report(); });
    expect((await fixture.app.inject('/api/company/command-failures')).statusCode).toBe(409);
  });
  it('keeps a selected employee bound while an unrelated employee is added', async () => {
    const fixture = setup();
    fixture.read.mockImplementation(async () => { fixture.state.rows.push({ id: B, owner: 'fixture' }); return report(); });
    expect((await fixture.app.inject('/api/company/command-failures?employeeId=' + A)).statusCode).toBe(200);
  });
  it('never echoes native errors or malformed private values', async () => {
    const fixture = setup({ read: async () => { throw new Error('SYNTHETIC_PRIVATE'); } });
    let response = await fixture.app.inject('/api/company/command-failures');
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
    for (const bad of [{ ...report(), argv: 'SYNTHETIC_PRIVATE' }, { ...report(), employees: [{ ...row(), counts: [{ ...row().counts[0], tool: 'SYNTHETIC_PRIVATE' }] }] }, report([B])]) {
      fixture.read.mockResolvedValue(bad);
      response = await fixture.app.inject('/api/company/command-failures');
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
    }
  });
  it('refuses corrupt group types, unsafe counts and false disabled payloads', () => {
    for (const changes of [{ count: true }, { count: 2049 }, { exit: true }, { exit: 0 }, { category: 'OTHER' }, { stderr: 'SYNTHETIC_PRIVATE' }]) {
      const bad = { ...report(), employees: [{ ...row(), counts: [{ ...row().counts[0], ...changes }] }] };
      expect(() => parseFailureReport(bad, [A])).toThrow();
    }
    expect(() => parseFailureReport({ ...report(), enabled: false }, [A])).toThrow();
  });
  it('caps roster requests and exposes no write or enablement route', async () => {
    const fixture = setup({ rows: Array.from({ length: 65 }, (_, index) => ({ id: `${(index + 1).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000` })) });
    expect((await fixture.app.inject('/api/company/command-failures')).statusCode).toBe(400);
    expect(fixture.read).not.toHaveBeenCalled();
    expect((await fixture.app.inject({ method: 'POST', url: '/api/company/command-failures', payload: { enabled: true } })).statusCode).toBe(404);
  });
});

describe('command failure static publication boundary', () => {
  async function staticFixture() {
    const root = mkdtempSync(join(tmpdir(), 't9-static-'));
    const app = Fastify({ logger: false });
    const state = { owner: false };
    const page = vi.fn(async () => '<main>Fixed metadata view</main>');
    try {
      for (const file of ['command-failures.html', 'command-failures.js', 'command-failures.css']) {
        const bytes = readFileSync(new URL('../src/web/public/' + file, import.meta.url));
        writeFileSync(join(root, file), bytes);
        writeFileSync(join(root, file + '.gz'), gzipSync(bytes));
        writeFileSync(join(root, file + '.br'), brotliCompressSync(bytes));
      }
      writeFileSync(join(root, 'unrelated.txt'), 'unrelated');
      await app.register(fastifyStatic, { root, prefix: '/', cacheControl: false, preCompressed: true,
        setHeaders: reply => {
          if (reply.getHeader('Cache-Control') === undefined) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        },
      });
      registerCommandFailureRoutes(app, { verifiedOwner: () => state.owner, employees: () => [], page });
      return { app, state, page, close: async () => { await app.close(); rmSync(root, { recursive: true }); } };
    } catch (error) { await app.close(); rmSync(root, { recursive: true }); throw error; }
  }

  it('protects HTML, assets and generated compressed aliases for GET and HEAD', async () => {
    const fixture = await staticFixture();
    try {
      for (const name of ['command-failures', 'command-failures.html', 'command-failures.js', 'command-failures.css']) {
        for (const suffix of name.includes('.') ? ['', '.br', '.gz'] : ['']) {
          for (const method of ['GET', 'HEAD'] as const) {
            const response = await fixture.app.inject({ method, url: '/' + name + suffix + '?v=fixture', headers: { 'accept-encoding': 'br, gzip' } });
            expect(response.statusCode).toBe(403);
            expect(response.headers['cache-control']).toBe('no-store');
            expect(response.body).not.toContain('id="employee"');
          }
        }
      }
      expect(fixture.page).not.toHaveBeenCalled();
      fixture.state.owner = true;
      for (const headers of [{ 'x-reverie-parent-session': A }, { 'x-reverie-service-token': 'synthetic' }]) {
        expect((await fixture.app.inject({ url: '/command-failures.html', headers })).statusCode).toBe(403);
      }
    } finally { await fixture.close(); }
  });

  it('keeps encoded and normalized wildcard aliases private without changing other static files', async () => {
    const fixture = await staticFixture();
    try {
      for (const path of ['/command-failures%2ehtml', '/%63ommand-failures.html', '/command-failures%2ehtml.gz', '/x/../command-failures.html.br']) {
        const response = await fixture.app.inject(path);
        expect(response.statusCode).toBe(403);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      fixture.state.owner = true;
      for (const extension of ['html', 'js', 'css']) {
        for (const compressed of ['br', 'gz']) {
          const response = await fixture.app.inject('/command-failures.' + extension + '.' + compressed);
          expect(response.statusCode).toBe(404);
          expect(response.headers['cache-control']).toBe('no-store');
        }
      }
      const unrelated = await fixture.app.inject('/unrelated.txt');
      expect(unrelated.statusCode).toBe(200);
      expect(unrelated.headers['cache-control']).toContain('immutable');
    } finally { await fixture.close(); }
  });

  it('serves the owner HTML alias with the same loader and post-await logout check', async () => {
    const fixture = await staticFixture();
    try {
      fixture.state.owner = true;
      for (const path of ['/command-failures', '/command-failures.html']) {
        const response = await fixture.app.inject(path);
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe('<main>Fixed metadata view</main>');
        expect(response.headers['cache-control']).toBe('no-store');
      }
      fixture.page.mockImplementation(async () => { fixture.state.owner = false; return 'SYNTHETIC_PRIVATE'; });
      const response = await fixture.app.inject('/command-failures.html');
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await fixture.close(); }
  });
});
