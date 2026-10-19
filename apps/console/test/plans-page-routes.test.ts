import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { registerPlansPageRoutes } from '../src/web/routes/plans-page-routes.js';

const SHIPPED = join(__dirname, '..', 'src', 'web', 'public', 'plans.html');

describe('GET /plans (redirect)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('redirects /plans and /plans.html to the Board Plans section, never cached', async () => {
    app = Fastify();
    registerPlansPageRoutes(app);
    await app.ready();
    for (const url of ['/plans', '/plans.html']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('/board#sec-burn');
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('shipped plans.html', () => {
  const html = readFileSync(SHIPPED, 'utf-8');

  it('uses only the existing plans and subscription-profile APIs', () => {
    const paths = new Set([...html.matchAll(/['"`](\/api\/[a-z/-]+)/g)].map((m) => m[1]));
    expect([...paths].sort()).toEqual(['/api/plans', '/api/plans/accounts/', '/api/plans/logins/', '/api/subscription-profiles', '/api/subscription-profiles/']);
  });

  it('has a script that parses and a phone viewport', () => {
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
    expect(() => new vm.Script(script)).not.toThrow();
    expect(html).toContain('width=device-width');
  });
});
