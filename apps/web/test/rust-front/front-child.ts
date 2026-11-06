/**
 * A small TS child for the Rust front's integration tests: the real FrontChannel on the inherited fd 3, serving a
 * fixed Fastify app, so the front exchanges actual adapter bytes, lifecycle and shutdown with Node.
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
 * Routes on main:
 *   GET  /hello            200 "hello"
 *   POST /echo             200, the request body back (application/octet-stream, up to 8 MiB)
 *   GET  /bytes?n=N        200, N bytes of "x" (N up to 64 MiB)
 *   GET  /slow?ms=M        200 "slow" after M ms (M up to 60 s)
 *   GET  /destroy          destroys its socket, which the front sees as abort(destroy)
 *   GET  /peer             200 JSON of the peer and local facts the request arrived with
 *
 * Lifecycle, one JSON object per line on stderr: {"event":"bound","listener":"main","port":N}, then
 * "accepting" and "service_ready"; "shutdown" with the signal; then "closed", "unfinished" or "fault" with its code.
 * A `shutdown` frame, SIGTERM or SIGINT closes Fastify (its preClose hook sends `unbind`), waits until every queued
 * frame has been flushed to fd 3 and TS's direction has ended, and exits 0. If that does not happen within
 * FRONT_CHILD_FINISH_MS it logs "unfinished" and exits 71: a clean exit always means `unbind` was sent.
 * A channel fault, including end of the channel, exits 70 without closing.
 */
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { FrontChannel, closeThroughFront } from '../../src/rust-front/front.js';

const log = (event: string, fields: Record<string, unknown> = {}) =>
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
const bounded = (value: unknown, max: number) => Math.min(Math.max(Number(value) || 0, 0), max);

const front = FrontChannel.fromInheritedFd();
const app = Fastify({ bodyLimit: 8 * 1024 * 1024 });
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
app.get('/hello', () => 'hello');
app.post('/echo', (req, reply) => reply.type('application/octet-stream').send(req.body as Buffer));
app.get('/bytes', (req, reply) =>
  reply.type('application/octet-stream').send(Buffer.alloc(bounded((req.query as { n?: string }).n, 64 << 20), 0x78))
);
app.get('/slow', async (req) => {
  await new Promise((resolve) => setTimeout(resolve, bounded((req.query as { ms?: string }).ms, 60_000)));
  return 'slow';
});
app.get('/destroy', (req) => {
  req.raw.socket.destroy();
});
app.get('/peer', (req) => {
  const socket = req.raw.socket as {
    remoteAddress?: string;
    remotePort?: number;
    localPort?: number;
    encrypted?: boolean;
  };
  return {
    ip: req.ip,
    remotePort: socket.remotePort,
    localPort: socket.localPort,
    encrypted: socket.encrypted === true,
    protocol: req.protocol,
  };
});
closeThroughFront(app, front);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log('shutdown', { signal });
  await app.close();
  try {
    await front.finish(bounded(process.env.FRONT_CHILD_FINISH_MS, 600_000) || 5000);
  } catch (error) {
    log('unfinished', { message: (error as Error).message });
    process.exit(71);
  }
  log('closed');
  process.exit(0);
}
front.on('shutdown', (signal) => void shutdown(signal));
front.on('fault', (fault) => {
  log('fault', { code: fault.code });
  process.exit(70);
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

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
log('service_ready');
