/**
 * @fileoverview The old plans page address, now a redirect to the Board's Plans section.
 *
 * Routes:
 * - `GET /plans` and `GET /plans.html` (authenticated like every page) — 302 to `/board#sec-burn`, where
 *   the plan accounts are renamed, signed in, added and removed. Never cached, so the address can be
 *   pointed elsewhere again without a stale browser copy.
 *
 * `public/plans.html` stays in the tree for now; nothing serves it.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

export const PLANS_PAGE_FILE = 'plans.html';
export const PLANS_REDIRECT = '/board#sec-burn';

export function registerPlansPageRoutes(app: FastifyInstance): void {
  const redirect = async (_req: unknown, reply: FastifyReply) =>
    reply.header('Cache-Control', 'no-store').redirect(PLANS_REDIRECT, 302);
  // ⚠️ /plans.html needs its own route: the static plugin would give it a year of `immutable`.
  app.get('/plans', redirect);
  app.get('/plans.html', redirect);
}
