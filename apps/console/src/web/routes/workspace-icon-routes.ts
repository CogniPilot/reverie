/**
 * Workspace pictures. Anyone signed in reads them; only the owner (a request that does not name an agent session) sets, clears or
 * renames one. The body is the raw image, checked by its bytes before anything is stored.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_AVATAR_BYTES } from '../../agent-avatars.js';
import { WorkspaceIconError, WorkspaceIconStore } from '../../workspace-icons.js';
import { ownerFor, parseBody } from '../route-helpers.js';

const RenameSchema = z.object({ from: z.string().max(200), to: z.string().max(200) }).strict();

export function registerWorkspaceIconRoutes(app: FastifyInstance, store: WorkspaceIconStore): void {
  const owner = (req: FastifyRequest): string | undefined => ownerFor(req);
  /** The parent-session header is a hint agent tooling sets, not authentication (same rule as the company routes). */
  const ownerOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.headers['x-codeman-parent-session'] === undefined) return true;
    void reply.code(403).send({ success: false, error: 'Only the owner sets workspace pictures' });
    return false;
  };
  const guard = async (reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> => {
    try {
      return { success: true, data: await work() };
    } catch (error) {
      if (!(error instanceof WorkspaceIconError)) throw error;
      return reply.code(error.status).send({ success: false, error: error.message });
    }
  };

  app.get('/api/workspace-icons', async (req) => ({ success: true, data: { icons: await store.list(owner(req)) } }));

  void app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      { parseAs: 'buffer', bodyLimit: MAX_AVATAR_BYTES + 1024 },
      (_req, body, done) => done(null, body)
    );
    scope.put('/api/workspace-icons/image', async (req, reply) => {
      if (!ownerOnly(req, reply)) return reply;
      const name = (req.query as { name?: string }).name ?? '';
      return guard(reply, async () => ({ url: await store.put(owner(req), name, req.body) }));
    });
  });

  app.delete('/api/workspace-icons', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply;
    const name = (req.query as { name?: string }).name ?? '';
    return guard(reply, async () => {
      await store.remove(owner(req), name);
      return {};
    });
  });

  app.post('/api/workspace-icons/rename', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply;
    const body = parseBody(RenameSchema, req.body);
    return guard(reply, async () => ({ url: (await store.rename(owner(req), body.from, body.to)) ?? null }));
  });

  app.get('/api/workspace-icons/:key', async (req, reply) => {
    const stored = await store.get(owner(req), (req.params as { key: string }).key);
    if (!stored) return reply.code(404).send({ success: false, error: 'No workspace picture' });
    // The link a page uses carries ?v=<version>, which changes with every new picture, so a given link never changes: browsers keep
    // it for a year and ask again only with the ETag (a 304 sends no body).
    const etag = `"${createHash('sha256').update(stored.data).digest('hex').slice(0, 32)}"`;
    reply
      .header('ETag', etag)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.header('Content-Type', stored.type).send(stored.data);
  });
}
