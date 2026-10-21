/**
 * @fileoverview The board page: one fixed link to the console's own board.
 *
 * Routes:
 * - `GET /board` and `GET /board.html` (authenticated like every page) — the page shipped in
 *   `public/board.html`, served from the console origin so it can read `GET /api/board` with the
 *   viewer's own login. It is never cached: a new build or a changed login must show at once.
 *
 * The data comes from the board API (board-routes.ts); this route only serves the page.
 */

import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOARD_PAGE_FILE = 'board.html';

const publicDir = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function registerBoardPageRoutes(app: FastifyInstance, dir: string = publicDir()): void {
  const serve = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    try {
      const page = await readFile(join(dir, BOARD_PAGE_FILE), 'utf-8');
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(page);
    } catch {
      return reply
        .code(404)
        .header('Cache-Control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('The board page is not installed in this build');
    }
  };
  // ⚠️ /board.html needs its own route: the static plugin would give it a year of `immutable`.
  app.get('/board', serve);
  app.get('/board.html', serve);
  app.get('/company-board.css', async (_req, reply) => {
    try {
      const styles = await readFile(join(dir, 'company-board.css'), 'utf-8');
      return reply.header('Cache-Control', 'no-store').type('text/css; charset=utf-8').send(styles);
    } catch {
      return reply.code(404).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Company and Board styles are not installed in this build');
    }
  });
}
