/** The owner-facing bots dashboard reuses the existing registry and scheduler APIs. */
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import { sameOrigin } from '../../owner-auth/policy.js';

export function registerBotsPageRoutes(app: FastifyInstance, verifiedOwner: OwnerVerifier): void {
  void app.register(async (scoped) => {
    scoped.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      if (
        !verifiedOwner(request) ||
        request.headers['x-reverie-parent-session'] !== undefined ||
        request.headers['x-reverie-service-token'] !== undefined ||
        (request.headers.origin && !sameOrigin(request)) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      )
        return reply.code(403).send({ success: false, error: 'Owner sign-in required.' });
    });
    for (const [path, file, type] of [
      ['/bots', 'bots.html', 'text/html'],
      ['/bots.js', 'bots.js', 'application/javascript'],
      ['/bots.css', 'bots.css', 'text/css'],
    ]) {
      scoped.get(path, async (_request, reply) =>
        reply.type(type + '; charset=utf-8').send(await readFile(new URL('../public/' + file, import.meta.url), 'utf8'))
      );
    }
  });
}
