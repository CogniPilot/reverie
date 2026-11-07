/**
 * A small TS child for the Rust front's integration tests: the real FrontChannel on the inherited fd 3, serving the
 * fixture app (fixture-app.ts), so the front exchanges actual adapter bytes, lifecycle and shutdown with Node.
 * direct-child.ts serves the same app with no front, for paired runs.
 *
 * Run from apps/web with the channel on fd 3:  node --import tsx test/rust-front/front-child.ts
 *
 * Environment (all optional):
 *   FRONT_CHILD_HOST         main bind host (default 127.0.0.1)
 *   FRONT_CHILD_PORT         main bind port (default 0)
 *   FRONT_CHILD_TLS          "1" asks the front to bind main with TLS (default plain)
 *   FRONT_CHILD_BRIDGE_HOST  also bind a bridge listener on this host and the main port; it answers "bridge"
 *   FRONT_CHILD_FINISH_MS    how long shutdown waits for the channel to flush (default 5000)
 *
 * Routes and the per-response events: fixture-app.ts.
 *
 * Lifecycle, one JSON object per line on stderr: {"event":"bound","listener":"main","port":N}, then
 * "accepting" and {"event":"service_ready","port":N}; "shutdown" with the signal; then "closed", "unfinished" or
 * "fault" with its code.
 * A `shutdown` frame, SIGTERM or SIGINT closes Fastify (its preClose hook sends `unbind`), waits until every queued
 * frame has been flushed to fd 3 and TS's direction has ended, and exits 0. If that does not happen within
 * FRONT_CHILD_FINISH_MS it logs "unfinished" and exits 71: a clean exit always means `unbind` was sent.
 * As in direct-child.ts, Fastify's close destroys a connection whose response has ended but still holds body bytes
 * waiting for credit; the front sees that as abort.
 * A channel fault, including end of the channel, exits 70 without closing.
 */
import { createServer } from 'node:http';
import { FrontChannel, closeThroughFront } from '../../src/rust-front/front.js';
import { bounded, finishMs, fixtureApp, log, shutdownOnce } from './fixture-app.js';

const front = FrontChannel.fromInheritedFd();
const app = fixtureApp();
closeThroughFront(app, front);

const shutdown = shutdownOnce(async () => {
  await app.close();
  await front.finish(finishMs());
});
front.on('shutdown', (signal) => shutdown(signal));
front.on('fault', (fault) => {
  log('fault', { code: fault.code });
  process.exit(70);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const host = process.env.FRONT_CHILD_HOST || '127.0.0.1';
const tls = process.env.FRONT_CHILD_TLS === '1';
const bridgeHost = process.env.FRONT_CHILD_BRIDGE_HOST;
const bridge = bridgeHost ? createServer((_req, res) => res.end('bridge')) : undefined;
if (bridge)
  app.addHook('onClose', (_instance, done) => {
    front.unbind('bridge');
    bridge.close();
    done();
  });

const port = await front.bind('main', { host, port: bounded(process.env.FRONT_CHILD_PORT, 65535), tls });
log('bound', { listener: 'main', port });
await app.ready();
front.accepting('main', app.server);
log('accepting', { listener: 'main' });
if (bridgeHost && bridge) {
  const bridgePort = await front.bind('bridge', { host: bridgeHost, port, tls });
  log('bound', { listener: 'bridge', port: bridgePort });
  front.accepting('bridge', bridge);
  log('accepting', { listener: 'bridge' });
}
front.serviceReady();
log('service_ready', { port });
