/**
 * The fixed Fastify app both integration children serve: front-child.ts behind the Rust front on fd 3, and
 * direct-child.ts on its own TCP listener. One app and one event log mean a slow-client case can run the same routes,
 * bodies and triggers against both and compare what each delivers.
 *
 * Routes:
 *   GET  /hello            200 "hello"
 *   POST /echo             200, the request body back (application/octet-stream, up to 8 MiB)
 *   GET  /bytes?n=N        200, N bytes of "x" (N up to 64 MiB)
 *   GET  /slow?ms=M        200 "slow" after M ms (M up to 60 s)
 *   GET  /destroy          destroys its socket without a response
 *   GET  /peer             200 JSON of the peer and local facts the request arrived with
 *   GET  /sse?n&size&ms    200 text/event-stream: n events of `size` bytes of data, `ms` apart (n up to 4096,
 *                          size up to 256 KiB, ms up to 10 s), waiting for `drain` whenever a write reports backpressure
 *
 * Every response logs one JSON object per line on stderr:
 *   {"event":"response_finish","method","url","status","socketDestroyed"} when Node's `finish` fires on the response,
 *   and {"event":"response_close","method","url","finished"} when it closes, `finished` being its writableFinished.
 * With `socketDestroyed: false`, `finish` means the response's last byte has been accepted by its socket's write path:
 * by the kernel for a direct TCP socket, and by the OS for the front's client socket (its `written` receipt) for a
 * fronted one. Neither says the client has read the bytes. With `socketDestroyed: true` the socket was destroyed with
 * bytes still queued: Node completes the pending writes with ECANCELED and still emits `finish`, on TCP as through the
 * front, so that event is a truncation, not a delivery.
 * /sse also logs {"event":"sse_write","seq","bytes","ok"} per event, `ok` being the write's backpressure result, and
 * {"event":"sse_drain","seq"} when a write that reported backpressure drains.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

export const log = (event: string, fields: Record<string, unknown> = {}) =>
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
export const bounded = (value: unknown, max: number) => Math.min(Math.max(Number(value) || 0, 0), max);

/** FRONT_CHILD_FINISH_MS, the bound on a shutdown's wait (default 5000). */
export const finishMs = () => bounded(process.env.FRONT_CHILD_FINISH_MS, 600_000) || 5000;

/** Resolves on `drain`, or on `close` if the response is destroyed first; false then. */
function drained(res: ServerResponse): Promise<boolean> {
  return new Promise((done) => {
    const settle = (ok: boolean) => () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      done(ok);
    };
    const onDrain = settle(true);
    const onClose = settle(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/** The fixture app, served over Node `https` when given a certificate and key (the direct child's TLS listener). */
export function fixtureApp(https?: { cert: Buffer; key: Buffer }): FastifyInstance {
  const app = (https
    ? Fastify({ bodyLimit: 8 * 1024 * 1024, https })
    : Fastify({ bodyLimit: 8 * 1024 * 1024 })) as unknown as FastifyInstance;
  app.addHook('onRequest', (req, reply, done) => {
    const res = reply.raw;
    const socket = res.socket;
    const fields = { method: req.method, url: req.url };
    res.once('finish', () => {
      log('response_finish', { ...fields, status: res.statusCode, socketDestroyed: socket?.destroyed !== false });
    });
    res.once('close', () => log('response_close', { ...fields, finished: res.writableFinished }));
    done();
  });
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
  app.get('/sse', async (req, reply) => {
    const query = req.query as { n?: string; size?: string; ms?: string };
    const n = bounded(query.n, 4096);
    const data = `data: ${'x'.repeat(bounded(query.size, 256 * 1024))}\n\n`;
    const ms = bounded(query.ms, 10_000);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (let seq = 0; seq < n && !res.destroyed; seq++) {
      const ok = res.write(data);
      log('sse_write', { seq, bytes: Buffer.byteLength(data), ok });
      if (!ok) {
        if (!(await drained(res))) return;
        log('sse_drain', { seq });
      }
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    }
    if (!res.destroyed) res.end();
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
  return app;
}

/**
 * Returns the one shutdown both children run on a signal: log "shutdown", await `close`, then log "closed" and exit 0,
 * or log "unfinished" with the error's message and exit 71 if it rejects. Each child bounds its own `close` by
 * FRONT_CHILD_FINISH_MS. Calls after the first are ignored.
 */
export function shutdownOnce(close: () => Promise<void>): (signal: string) => void {
  let closing = false;
  return (signal) => {
    if (closing) return;
    closing = true;
    log('shutdown', { signal });
    close().then(
      () => {
        log('closed');
        process.exit(0);
      },
      (error: Error) => {
        log('unfinished', { message: error.message });
        process.exit(71);
      }
    );
  };
}
