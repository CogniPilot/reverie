import { afterEach, expect, it } from 'vitest';
import { workspaceServer } from './helpers/workspace-server.js';
let server: Awaited<ReturnType<typeof workspaceServer>>;
afterEach(async () => {
  await server?.close();
});
it('serves only the fixed packaged worker with a worker-local no-eval policy and retains global hooks', async () => {
  server = await workspaceServer();
  const response = await server.app.inject({ url: '/vendor/pdfjs-6.4.299/pdf.worker.mjs' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('application/javascript');
  expect(response.headers['content-security-policy']).toBe(
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"
  );
  expect(response.headers['content-security-policy']).not.toContain("'unsafe-eval'");
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  const { createHash } = await import('node:crypto');
  expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(
    '07ceb740d746e5d9012fcf9f27d5c7dea09f7d2f5e74f5c8109e5787551a2333'
  );
  const { default: Fastify } = await import('fastify');
  const { registerWorkspaceFileRoutes } = await import('../src/web/routes/workspace-file-routes.js');
  const denied = Fastify();
  denied.addHook('onRequest', async (_request, reply) => reply.code(403).send('global refusal'));
  registerWorkspaceFileRoutes(denied, (() => false) as never);
  try {
    expect((await denied.inject({ url: '/vendor/pdfjs-6.4.299/pdf.worker.mjs' })).statusCode).toBe(403);
  } finally {
    await denied.close();
  }
});
