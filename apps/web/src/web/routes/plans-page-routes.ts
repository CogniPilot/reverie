/**
 * @fileoverview Company plans and the legacy plans-page redirects.
 *
 * Routes:
 * - `GET /plans` and `GET /plans.html` (authenticated like every page) — 302 to `/#company-plans`, where
 *   the plan accounts are renamed, signed in, added and removed. Never cached, so the address can be
 *   pointed elsewhere again without a stale browser copy.
 *
 * `GET /company/plans` serves the uncached Company plans frame. The old `public/plans.html` is not served.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLANS_PAGE_FILE = 'plans.html';
export const PLANS_REDIRECT = '/#company-plans';
export const COMPANY_PLANS_PAGE_FILE = 'company-plans.html';

export function registerPlansPageRoutes(app: FastifyInstance, dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')): void {
  const redirect = async (_req: unknown, reply: FastifyReply) =>
    reply.header('Cache-Control', 'no-store').redirect(PLANS_REDIRECT, 302);
  // ⚠️ /plans.html needs its own route: the static plugin would give it a year of `immutable`.
  app.get('/plans', redirect);
  app.get('/plans.html', redirect);
  const serve = async (_req: unknown, reply: FastifyReply) => {
    try {
      const page = await readFile(join(dir, COMPANY_PLANS_PAGE_FILE), 'utf-8');
      return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(page);
    } catch {
      return reply.code(404).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Company plans are not installed in this build');
    }
  };
  app.get('/company/plans', serve);
  app.get('/company-plans.html', serve);
}
