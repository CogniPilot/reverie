/** Owner control of isolated preview origins. No laptop HTML is served by this app. */
import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import { sameOrigin } from '../../owner-auth/policy.js';
import { isMultiUserMode } from '../../config/multiuser.js';

const Page = z
  .string()
  .max(4096)
  .startsWith('/')
  .refine(
    (s) =>
      !s.startsWith('//') &&
      !s.includes('\\') &&
      !s.includes('#') &&
      !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
const Expose = z
  .object({
    sessionId: z.string().uuid(),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .refine((p) => p !== 8092 && p !== 8093),
    path: Page,
  })
  .strict();
const Open = z.object({ path: Page }).strict();
const Id = z.string().regex(/^[a-f0-9]{32}$/);
export type PreviewControl = (
  method: string,
  path: string,
  body?: unknown
) => Promise<{ status: number; body: unknown }>;

/** Fixed owner-only Unix transport, never a caller-selected host/URL/socket. */
export const previewControl: PreviewControl = (method, path, body) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath: process.env.REVERIE_PREVIEW_SOCKET || '/run/reverie-control/preview.sock',
        method,
        path,
        agent: false,
        headers:
          data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.length > 65536) req.destroy(new Error('Preview response too large'));
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 502, body: JSON.parse(text) as unknown });
          } catch {
            // The proxy returns plain HTTP errors. Never echo its internals.
            resolve({ status: res.statusCode || 502, body: { error: 'Preview request refused.' } });
          }
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error('Preview control timeout')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(data);
  });

export function registerPreviewRoutes(
  app: FastifyInstance,
  verifiedOwner: OwnerVerifier,
  control = previewControl
): void {
  void app.register(async (scoped) => {
    scoped.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      if (
        !verifiedOwner(request) ||
        request.headers['x-reverie-parent-session'] !== undefined ||
        request.headers['x-reverie-service-token'] !== undefined ||
        (request.headers.origin && !sameOrigin(request)) ||
        ['same-site', 'cross-site'].includes(String(request.headers['sec-fetch-site']))
      )
        return reply.code(403).send({ error: 'Owner sign-in required.' });
      // One configured owner instance per proxy. Never pool tenants into this registry.
      if (isMultiUserMode()) return reply.code(503).send({ error: 'Previews require a dedicated owner instance.' });
    });
    for (const [path, file, type] of [
      ['/previews', 'previews.html', 'text/html'],
      ['/previews.js', 'previews.js', 'application/javascript'],
    ]) {
      scoped.get(path, async (_request, reply) =>
        reply.type(type + '; charset=utf-8').send(await readFile(new URL('../public/' + file, import.meta.url), 'utf8'))
      );
    }
    for (const [method, url] of [
      ['GET', '/api/previews'],
      ['POST', '/api/previews'],
      ['DELETE', '/api/previews/:id'],
      ['POST', '/api/previews/:id/open'],
    ] as const) {
      scoped.route({
        method,
        url,
        bodyLimit: 4096,
        handler: async (request, reply) => {
          const id = (request.params as { id?: string }).id;
          if (id !== undefined && !Id.safeParse(id).success) return reply.code(400).send({ error: 'Invalid preview.' });
          const schema = id ? Open : Expose;
          const parsed = method === 'POST' ? schema.safeParse(request.body) : undefined;
          if (parsed && !parsed.success)
            return reply.code(400).send({ error: 'Select a laptop, port and local page path.' });
          try {
            const path = '/previews' + (id ? '/' + id + (url.endsWith('/open') ? '/open' : '') : '');
            const result = await control(method, path, parsed?.success ? parsed.data : undefined);
            return reply.code(result.status).send(result.body);
          } catch {
            return reply.code(503).send({
              error: 'HTTPS preview service is not configured or is unavailable. See the laptop previews setup guide.',
            });
          }
        },
      });
    }
  });
}
