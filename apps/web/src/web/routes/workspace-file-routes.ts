/** Owner-only shared workspace browsing and exact byte transfers; no shell or arbitrary roots. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { sameOrigin as ownerSameOrigin } from '../../owner-auth/policy.js';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import { sharedWorkspaceRoot } from '../../shared-attachments.js';
import { WorkspaceError, WorkspaceFiles } from '../../workspace-files.js';

export function registerWorkspaceFileRoutes(
  app: FastifyInstance,
  verifiedOwner: OwnerVerifier,
  files = new WorkspaceFiles(sharedWorkspaceRoot)
): void {
  // Public package code keeps the existing global/static authentication boundary.
  // A worker response policy applies inside the worker without changing the console.
  app.get('/vendor/pdfjs-6.4.299/pdf.worker.mjs', async (_request, reply) =>
    reply
      .type('application/javascript; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(await readFile(new URL('../public/vendor/pdfjs-6.4.299/pdf.worker.mjs', import.meta.url)))
  );
  void app.register(async (scoped) => {
    scoped.addHook('onRequest', async (request, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'same-origin');
      if (!verifiedOwner(request) || request.headers['x-reverie-parent-session'] !== undefined)
        return reply.code(403).send({ success: false, error: 'Owner sign-in required.', errorCode: 'FORBIDDEN' });
      const origin = request.headers.origin;
      const sameOrigin = !origin || ownerSameOrigin(request);
      if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site')
        return reply
          .code(403)
          .send({ success: false, error: 'Use the same-origin owner console.', errorCode: 'FORBIDDEN' });
    });
    scoped.setErrorHandler((error: Error & { code?: string }, _request, reply) => {
      const status =
        error.name === 'AbortError'
          ? 408
          : error.code === 'ENOSPC'
            ? 507
            : error instanceof WorkspaceError
              ? error.status
              : error.code === 'EEXIST'
                ? 409
                : ['ENOENT', 'ENOTDIR'].includes(error.code || '')
                  ? 404
                  : 403;
      const message =
        error instanceof WorkspaceError
          ? error.message
          : status === 408
            ? 'Upload timed out. Try again with a faster connection or a smaller file.'
            : status === 507
              ? 'Workspace storage is full. Free space and try again.'
              : status === 409
                ? 'A file with this name already exists. Rename your upload first.'
                : status === 404
                  ? 'Workspace path not found.'
                  : 'This workspace path is unavailable.';
      void reply.code(status).send({
        success: false,
        error: message,
        errorCode: status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'INVALID_INPUT',
      });
    });
    scoped.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    const page = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply
        .type('text/html; charset=utf-8')
        .send(await readFile(new URL('../public/workspace-files.html', import.meta.url), 'utf8'));
    scoped.get('/workspace', page);
    scoped.get('/workspace-files.html', page);
    // These modules are referenced outside renderIndexHtml, so bypass immutable static caching.
    for (const asset of ['workspace-files.js', 'workspace-files.css']) {
      scoped.get('/' + asset, async (_request, reply) =>
        reply
          .type(asset.endsWith('.js') ? 'application/javascript' : 'text/css')
          .send(await readFile(new URL('../public/' + asset, import.meta.url), 'utf8'))
      );
    }
    scoped.get('/api/workspace/files', async (request) => ({
      success: true,
      data: await files.list(query(request).path ?? ''),
    }));
    scoped.get('/api/workspace/resolve', async (request) => ({
      success: true,
      data: await files.resolve(query(request).path),
    }));
    scoped.get('/api/workspace/file', async (request, reply) => {
      const result = await files.file(query(request).path, query(request).preview === '1', query(request).binding);
      // The final custody/identity check precedes stream EOF. An advertised
      // Content-Length lets HTTP clients finish before that check executes.
      // Keep stream completion authoritative (chunked on HTTP/1.1).
      reply.type(result.mime);
      reply.header('X-Reverie-File-Binding', result.binding);
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      reply.header(
        'Content-Disposition',
        `${query(request).preview === '1' ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`
      );
      return reply.send(result.stream);
    });
    scoped.post('/api/workspace/files', async (request, reply) => {
      if (!ownerSameOrigin(request))
        return reply
          .code(403)
          .send({ success: false, error: 'Upload from the same-origin owner console.', errorCode: 'FORBIDDEN' });
      if (
        request.headers['x-reverie-workspace-upload'] !== '1' ||
        request.headers['content-type'] !== 'application/octet-stream'
      )
        return reply
          .code(400)
          .send({ success: false, error: 'Use the workspace upload control.', errorCode: 'INVALID_INPUT' });
      const expected = Number(request.headers['content-length']);
      await files.upload(query(request).path ?? '', query(request).name, request.body as Readable, expected);
      return reply.code(201).send({ success: true });
    });
  });
}
function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}
