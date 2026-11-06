/**
 * The direct half of the paired fixture: the fixture app (fixture-app.ts) that front-child.ts serves behind the Rust
 * front, here listening on its own TCP socket with no front, so integration tests can run identical slow-client
 * bodies and triggers against both and compare what each delivers.
 *
 * Run from apps/web:  node --import tsx test/rust-front/direct-child.ts
 *
 * Environment (all optional):
 *   FRONT_CHILD_HOST       bind host (default 127.0.0.1)
 *   FRONT_CHILD_PORT       bind port (default 0)
 *   FRONT_CHILD_FINISH_MS  how long shutdown waits for Fastify to close (default 5000)
 *   FRONT_CHILD_TLS        "1" serves the app over Node https, the direct pair of the front's TLS listener; it then
 *                          needs FRONT_CHILD_TLS_CERT and FRONT_CHILD_TLS_KEY, PEM file paths
 *                          (test/rust-front/fixtures/tls holds a fixed pair for 127.0.0.1 and localhost)
 * No bridge: that is the front's.
 *
 * Routes and the per-response events: fixture-app.ts.
 *
 * Lifecycle, one JSON object per line on stderr: {"event":"listening","port":N}, then {"event":"service_ready",
 * "port":N}; "shutdown" with the signal; then "closed" or "unfinished".
 * SIGTERM or SIGINT closes Fastify, whose server.close() stops accepting and runs Node's closeIdleConnections, then
 * waits for the remaining connections to end. Once that resolves it exits 0; if it does not within
 * FRONT_CHILD_FINISH_MS it logs "unfinished" and exits 71.
 * Exit 0 is not delivery. Node counts a connection as idle once its response has called end(), even with body bytes
 * still queued behind a slow client, and destroys it, truncating the response. Bytes the kernel had already accepted
 * may also still be in flight.
 */
import { readFileSync } from 'node:fs';
import { bounded, finishMs, fixtureApp, log, shutdownOnce } from './fixture-app.js';

function tlsPair(): { cert: Buffer; key: Buffer } | undefined {
  if (process.env.FRONT_CHILD_TLS !== '1') return undefined;
  const { FRONT_CHILD_TLS_CERT: cert, FRONT_CHILD_TLS_KEY: key } = process.env;
  if (!cert || !key) throw new Error('FRONT_CHILD_TLS=1 needs FRONT_CHILD_TLS_CERT and FRONT_CHILD_TLS_KEY');
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

const app = fixtureApp(tlsPair());

const shutdown = shutdownOnce(() => {
  const ms = finishMs();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Fastify did not close within ${ms} ms`)), ms);
  });
  return Promise.race([app.close(), deadline]).finally(() => clearTimeout(timer));
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({
  host: process.env.FRONT_CHILD_HOST || '127.0.0.1',
  port: bounded(process.env.FRONT_CHILD_PORT, 65535),
});
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : 0;
log('listening', { port });
log('service_ready', { port });
