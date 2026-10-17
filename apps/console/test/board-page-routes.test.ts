import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { registerBoardPageRoutes } from '../src/web/routes/board-page-routes.js';

const SHIPPED = join(__dirname, '..', 'src', 'web', 'public', 'board.html');

describe('GET /board (page)', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-page-'));
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page from the console origin, never cached, on /board and /board.html', async () => {
    writeFileSync(join(dir, 'board.html'), '<!doctype html><title>Board</title>');
    app = Fastify();
    registerBoardPageRoutes(app, dir);
    await app.ready();
    for (const url of ['/board', '/board.html']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toContain('<title>Board</title>');
    }
  });

  it('answers a clear 404 when the page is not installed', async () => {
    app = Fastify();
    registerBoardPageRoutes(app, dir);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/board' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('shipped board.html', () => {
  const html = readFileSync(SHIPPED, 'utf-8');

  it('reads the board API with the viewer login and refreshes every minute', () => {
    expect(html).toContain("fetch('/api/board'");
    expect(html).toContain("credentials: 'same-origin'");
    expect(html).toContain('setInterval(load, 60e3)');
  });

  it('has a phone viewport and no horizontal page overflow rule it relies on', () => {
    expect(html).toContain('name="viewport"');
    expect(html).toContain('[hidden]{display:none!important}');
  });

  it('its script parses', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('calls no external host', () => {
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
  });
});
