/**
 * The TS adapter for the Rust front, driven by an in-process fake front: TS's own Fastify server serves
 * connections that arrive as route-frames-v2 frames, with the peer facts, limits, backpressure, upgrade
 * path and Node timeouts it has on a TCP socket.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { ChannelSocket } from '../../src/rust-front/channel-socket.js';
import { FrontChannel, closeThroughFront, type FrontChannelOptions } from '../../src/rust-front/front.js';
import { FakeFront, type FakeConnection } from './fake-front.js';

const require = createRequire(import.meta.url);
const opened: { app: FastifyInstance; front: FrontChannel }[] = [];

afterEach(async () => {
  for (const { app, front } of opened.splice(0)) {
    front.removeAllListeners();
    await app.close().catch(() => undefined);
  }
});

/** A Fastify app behind a fake front: bound as main on port 41234 and accepting. */
async function fronted(
  app: FastifyInstance,
  options: FrontChannelOptions = {},
  setup: (app: FastifyInstance, front: FrontChannel) => void = () => undefined
): Promise<{ fake: FakeFront; front: FrontChannel }> {
  const fake = new FakeFront();
  const front = new FrontChannel(fake.channel, options);
  opened.push({ app, front });
  setup(app, front);
  await app.ready();
  const bound = front.bind('main', { host: '127.0.0.1', port: 0, tls: false });
  await fake.next('bind_request');
  fake.send(0n, { kind: 'bound', listener: 'main', port: 41234 });
  expect(await bound).toBe(41234);
  front.accepting('main', app.server);
  await fake.next('accepting');
  return { fake, front };
}

const get = (path: string, extra = '') => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('front channel lifecycle', () => {
  it('binds, accepts and fails as listen() would, in order', async () => {
    const fake = new FakeFront();
    const front = new FrontChannel(fake.channel);
    const app = Fastify();
    opened.push({ app, front });
    await app.ready();

    expect(() => front.accepting('main', app.server)).toThrow(/not bound/);
    const bound = front.bind('main', { host: '127.0.0.1', port: 0, tls: true });
    expect((await fake.next('bind_request')).body).toEqual({
      kind: 'bind_request',
      listener: 'main',
      tls: true,
      port: 0,
      host: '127.0.0.1',
    });
    expect(() => front.bind('main', { host: '127.0.0.1', port: 0, tls: false })).toThrow(/already binding/);
    fake.send(0n, { kind: 'bound', listener: 'main', port: 40001 });
    expect(await bound).toBe(40001);

    const bridge = front.bind('bridge', { host: '172.17.0.1', port: 40001, tls: true });
    fake.send(0n, { kind: 'bind_failed', listener: 'bridge', errno: 'EADDRINUSE', message: 'address already in use' });
    await expect(bridge).rejects.toMatchObject({ code: 'EADDRINUSE', message: 'address already in use' });

    front.accepting('main', app.server);
    front.serviceReady();
    await fake.next('service_ready');
    expect(fake.frames.map((frame) => frame.body.kind)).toEqual([
      'bind_request',
      'bind_request',
      'accepting',
      'service_ready',
    ]);
    expect(front.endedBy).toBeUndefined();
  });

  it('ends the generation on a reply nobody asked for, or a connection before accepting', async () => {
    for (const misstep of ['bound', 'conn_open'] as const) {
      const fake = new FakeFront();
      const front = new FrontChannel(fake.channel);
      const fault = new Promise((resolve) => front.once('fault', resolve));
      if (misstep === 'bound') fake.send(0n, { kind: 'bound', listener: 'main', port: 1 });
      else fake.open();
      await fault;
      expect(front.endedBy?.code, misstep).toBe('LIFECYCLE');
    }
  });

  it('forwards shutdown, and refuses a frame from another generation', async () => {
    const fake = new FakeFront();
    const front = new FrontChannel(fake.channel);
    const signal = new Promise((resolve) => front.once('shutdown', resolve));
    fake.send(0n, { kind: 'shutdown', signal: 'SIGTERM' });
    expect(await signal).toBe('SIGTERM');
    const fault = new Promise((resolve) => front.once('fault', resolve));
    fake.send(0n, { kind: 'shutdown', signal: 'SIGHUP' }, 2n);
    await fault;
    expect(front.endedBy?.code).toBe('GENERATION');
  });
});

describe('HTTP through the front channel', () => {
  async function app(): Promise<{ fake: FakeFront; front: FrontChannel; results: Record<string, unknown> }> {
    const results: Record<string, unknown> = {};
    const server = Fastify({ bodyLimit: 16 });
    await server.register(websocket);
    server.get('/peer', (req) => ({
      ip: req.ip,
      remote: req.raw.socket.remoteAddress,
      localPort: req.raw.socket.localPort,
      encrypted: (req.raw.socket as { encrypted?: boolean }).encrypted ?? null,
      protocol: req.protocol,
    }));
    server.post('/body', (req) => ({ length: JSON.stringify(req.body).length }));
    server.get('/kill', (req) => {
      req.raw.socket.destroy();
    });
    server.get('/sse', (_req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      // Above the socket's 64 KiB high-water mark, so write() reports backpressure.
      results.write = reply.raw.write(`data: ${'a'.repeat(80 * 1024)}\n\n`);
      reply.raw.once('drain', () => {
        results.drained = true;
        reply.raw.end('data: done\n\n');
      });
    });
    server.get('/ws', { websocket: true }, (socket) => {
      socket.on('message', (message: Buffer) => socket.send(`echo:${message.toString()}`));
    });
    return { ...(await fronted(server)), results };
  }

  it("gives req.ip, the socket's peer and local facts and req.protocol from conn_open", async () => {
    const { fake } = await app();
    const tls = await fake.request(get('/peer', 'Connection: close\r\n'), {
      peer: { address: '203.0.113.7', port: 5555 },
      local: { address: '0.0.0.0', port: 8443 },
      encrypted: true,
    });
    expect(JSON.parse(tls.split('\r\n\r\n')[1])).toEqual({
      ip: '203.0.113.7',
      remote: '203.0.113.7',
      localPort: 8443,
      encrypted: true,
      protocol: 'https',
    });
    const plain = await fake.request(get('/peer', 'Connection: close\r\n'), {
      peer: { address: '::1', port: 1 },
      local: { address: '::1', port: 3000 },
    });
    expect(JSON.parse(plain.split('\r\n\r\n')[1])).toMatchObject({ ip: '::1', encrypted: null, protocol: 'http' });
  });

  it("answers Fastify's own 413 past the body limit", async () => {
    const { fake } = await app();
    const body = JSON.stringify({ a: '0123456789012345678901234567890' });
    const response = await fake.request(
      `POST /body HTTP/1.1\r\nHost: x\r\nConnection: close\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`
    );
    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large');
  });

  it("turns the route's socket.destroy() into abort, with nothing after it", async () => {
    const { fake } = await app();
    const connection = fake.open();
    await fake.write(connection, get('/kill'));
    await fake.closed(connection);
    expect(connection.aborted).toBe('destroy');
    expect(connection.ended).toBe(false);
    expect(fake.text(connection)).toBe('');
  });

  it('holds SSE writes while credit is exhausted and drains when credit arrives', async () => {
    const { fake, results } = await app();
    const connection = fake.open({ credit: 0 });
    await fake.write(connection, get('/sse'));
    await sleep(100);
    expect(results.write).toBe(false);
    expect(fake.text(connection)).toBe('');
    fake.send(connection.id, { kind: 'credit', bytes: 1024 * 1024 });
    await fake.until(() => fake.text(connection).includes('data: done'), 2000, 'the drained SSE event');
    expect(results.drained).toBe(true);
    expect(fake.text(connection)).toContain(`data: ${'a'.repeat(80 * 1024)}\n\n`);
  });

  it('upgrades a WebSocket on the real upgrade path, keeping the head bytes, and echoes', async () => {
    const { fake } = await app();
    const connection = fake.open();
    const payload = Buffer.from('hi');
    const mask = Buffer.from([1, 2, 3, 4]);
    // One masked client text frame, sent in the same data frame as the upgrade request: Node hands it to
    // the upgrade as `head`, and the route only sees it if the head bytes reach `ws`.
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      Buffer.from(payload.map((byte, at) => byte ^ mask[at % 4])),
    ]);
    const upgrade =
      'GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
    await fake.write(connection, Buffer.concat([Buffer.from(upgrade), frame]));
    const echo = Buffer.from('echo:hi');
    await fake.until(() => Buffer.concat(connection.received).includes(echo), 2000, 'the echoed frame');
    const reply = Buffer.concat(connection.received);
    expect(reply.toString('latin1').split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    const head = reply.indexOf('\r\n\r\n') + 4;
    expect(reply.subarray(head)).toEqual(Buffer.concat([Buffer.from([0x81, echo.length]), echo]));
  });
});

describe('the three Node behaviours a never-listening server loses', () => {
  const tightTimeouts = (app: FastifyInstance) => {
    app.server.headersTimeout = 300;
    app.server.requestTimeout = 600;
    // Read when 'listening' installs tracking; @types/node does not declare it.
    (app.server as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval = 50;
  };
  const dropListening = (app: FastifyInstance) => {
    tightTimeouts(app);
    const emit = app.server.emit.bind(app.server);
    app.server.emit = ((event: string, ...rest: unknown[]) => event !== 'listening' && emit(event, ...rest)) as never;
  };

  async function slowHeaders(before: (app: FastifyInstance) => void): Promise<string> {
    const server = Fastify();
    server.get('/x', () => ({ ok: 1 }));
    const { fake } = await fronted(server, {}, before);
    const connection = fake.open();
    await fake.write(connection, 'GET /x HTTP/1.1\r\nHost: x\r\n');
    await sleep(900);
    return fake.text(connection).split('\r\n')[0];
  }

  it("answers Node's 408 to headers that never finish, and not without the 'listening' emit", async () => {
    expect(await slowHeaders(tightTimeouts)).toBe('HTTP/1.1 408 Request Timeout');
    expect(await slowHeaders(dropListening)).toBe('');
  });

  async function keepAlive(): Promise<{ closedAfter: number | undefined }> {
    const server = Fastify({ keepAliveTimeout: 100 });
    server.get('/x', () => ({ ok: 1 }));
    const { fake } = await fronted(server);
    const connection = fake.open();
    await fake.write(connection, get('/x'));
    await fake.until(() => fake.text(connection).includes('{"ok":1}'), 2000, 'the response');
    const start = Date.now();
    await fake.closed(connection, 2500).catch(() => undefined);
    return { closedAfter: connection.aborted || connection.ended ? Date.now() - start : undefined };
  }

  it('closes an idle keep-alive connection after keepAliveTimeout plus Node’s buffer, and not without setTimeout', async () => {
    const { closedAfter } = await keepAlive();
    // 100 ms plus Node's 1 s buffer; the 2.5 s wait above is the upper bound.
    expect(closedAfter).toBeGreaterThan(900);

    const real = ChannelSocket.prototype.setTimeout;
    ChannelSocket.prototype.setTimeout = function (this: ChannelSocket) {
      return this;
    };
    try {
      expect((await keepAlive()).closedAfter).toBeUndefined();
    } finally {
      ChannelSocket.prototype.setTimeout = real;
    }
  }, 10_000);

  async function shutdown(
    setup: (app: FastifyInstance, front: FrontChannel) => void
  ): Promise<FakeConnection & { unbound: boolean }> {
    const server = Fastify();
    server.get('/x', () => ({ ok: 1 }));
    const { fake } = await fronted(server, {}, setup);
    const connection = fake.open();
    await fake.write(connection, get('/x'));
    await fake.until(() => fake.text(connection).includes('{"ok":1}'), 2000, 'the response');
    await server.close();
    await sleep(100);
    return { ...connection, unbound: fake.frames.some((frame) => frame.body.kind === 'unbind') };
  }

  it("closes idle connections on app.close() through Node's own tracking, and not without the 'listening' emit", async () => {
    const closed = await shutdown((app, front) => closeThroughFront(app, front));
    expect(closed.aborted ?? closed.ended).toBeTruthy();
    expect(closed.unbound).toBe(true);
    // The hook only unbinds: without the emit the idle connection survives even with it installed.
    const open = await shutdown((app, front) => {
      dropListening(app);
      closeThroughFront(app, front);
    });
    expect(open.aborted).toBeUndefined();
    expect(open.ended).toBe(false);
    expect(open.unbound).toBe(true);
  });

  it("pins the 'listening' contract to the Node and Fastify versions it was checked on", async () => {
    // Only Node's own connection tracking may listen for 'listening' on a server that never listens, and
    // emitting it must not mark the server as listening. Recheck both before moving either version.
    expect(process.versions.node.split('.')[0]).toBe('22');
    expect((require('fastify/package.json') as { version: string }).version.split('.')[0]).toBe('5');
    const server = Fastify();
    server.get('/x', () => ({ ok: 1 }));
    await server.ready();
    expect(server.server.listeners('listening').map((listener) => listener.name)).toEqual(['setupConnectionsTracking']);
    await fronted(server);
    expect(server.server.listening).toBe(false);
    await server.close();
  });
});

describe('connection rules, the receive pool and the writer', () => {
  async function app(options: FrontChannelOptions = {}): Promise<{ fake: FakeFront; front: FrontChannel }> {
    const server = Fastify({ bodyLimit: 1024 * 1024 });
    server.get('/hang', () => new Promise(() => undefined));
    server.get('/kill', (req) => {
      req.raw.socket.destroy();
    });
    server.get('/big', (_req, reply) => reply.send(Buffer.alloc(300 * 1024, 0x62)));
    server.get('/big-then-kill', (req, reply) => {
      reply.raw.writeHead(200, { 'content-length': String(600 * 1024) });
      reply.raw.write(Buffer.alloc(300 * 1024, 0x63));
      setImmediate(() => req.raw.socket.destroy());
    });
    server.post('/count', (req) => ({ bytes: (req.body as Buffer).length }));
    server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body)
    );
    return fronted(server, options);
  }
  const faulted = (front: FrontChannel) => new Promise((resolve) => front.once('fault', resolve));

  it('ends the generation on a credit overrun, aborting every connection and closing the channel', async () => {
    const { fake, front } = await app({ grantBytes: 1024 });
    const hanging = fake.open();
    await fake.write(hanging, get('/hang'));
    await sleep(50);
    const fault = faulted(front);
    // TS has at most 1 KiB granted, however much it has regranted since the request.
    fake.send(hanging.id, { kind: 'data', bytes: Buffer.alloc(2048) });
    await fault;
    expect(front.endedBy?.code).toBe('CREDIT_OVERRUN');
    expect(front.openConnections).toBe(0);
    expect(fake.channel.destroyed).toBe(true);
  });

  it('ends the generation on a frame for a connection the front never opened', async () => {
    const { fake, front } = await app();
    const fault = faulted(front);
    fake.send(7n, { kind: 'data', bytes: Buffer.from('x') });
    await fault;
    expect(front.endedBy?.code).toBe('CONN_UNOPENED');
  });

  it('settles a crossed abort and late frames for a closed connection without a fault', async () => {
    const { fake, front } = await app();
    const killed = fake.open();
    await fake.write(killed, get('/kill'));
    await fake.closed(killed);
    // The client reset crosses TS's abort, and its late bytes and credit follow.
    fake.send(killed.id, { kind: 'abort', reason: 'peer_reset' });
    fake.send(killed.id, { kind: 'data', bytes: Buffer.from('late') });
    fake.send(killed.id, { kind: 'credit', bytes: 10 });
    fake.send(killed.id, { kind: 'end' });
    expect(await fake.request(get('/big', 'Connection: close\r\n'))).toContain('HTTP/1.1 200 OK');
    expect(front.endedBy).toBeUndefined();
    expect(front.poolInUse).toBe(0);
  });

  it('never grants more than the pool, and gives a starved connection credit when another closes', async () => {
    const { fake, front } = await app({ poolBytes: 128 * 1024, grantBytes: 64 * 1024 });
    const [a, b, c] = [fake.open(), fake.open(), fake.open()];
    await fake.until(() => a.credit > 0 && b.credit > 0, 2000, 'two grants');
    await sleep(20);
    expect([a.credit, b.credit, c.credit]).toEqual([64 * 1024, 64 * 1024, 0]);
    expect(front.poolInUse).toBe(128 * 1024);
    fake.send(a.id, { kind: 'abort', reason: 'peer_reset' });
    await fake.until(() => c.credit > 0, 2000, 'the starved grant');
    expect(c.credit).toBe(64 * 1024);
    expect(front.poolInUse).toBe(128 * 1024);
  });

  it('gives a waiting connection the bytes a busy one frees, while neither busy connection closes', async () => {
    const { fake, front } = await app({ poolBytes: 128 * 1024, grantBytes: 64 * 1024 });
    const [a, b, c] = [fake.open(), fake.open(), fake.open()];
    await fake.until(() => a.credit > 0 && b.credit > 0, 2000, 'two grants');
    expect(c.credit).toBe(0);
    // A and B each stream a body four times the pool and stay open afterwards (keep-alive).
    const body = Buffer.alloc(512 * 1024, 0x61);
    const post = Buffer.from(
      `POST /count HTTP/1.1\r\nHost: x\r\ncontent-type: application/octet-stream\r\ncontent-length: ${body.length}\r\n\r\n`
    );
    const streaming = [a, b].map((connection) => fake.write(connection, Buffer.concat([post, body])));
    // C can only send its request with bytes A or B free by being read.
    expect(await fake.request(get('/big', 'Connection: close\r\n'))).toContain('HTTP/1.1 200 OK');
    await Promise.all(streaming);
    for (const connection of [a, b])
      await fake.until(() => fake.text(connection).includes(`{"bytes":${body.length}}`), 2000, 'the streamed body');
    expect([a, b].map((connection) => connection.ended || connection.aborted !== undefined)).toEqual([false, false]);
    expect(front.poolInUse).toBeLessThanOrEqual(128 * 1024);
  });

  it('completes an empty write without credit or a data frame, so end still follows', async () => {
    const fake = new FakeFront();
    const front = new FrontChannel(fake.channel);
    const server = createServer();
    server.removeAllListeners('connection');
    const accepted = new Promise<ChannelSocket>((resolve) => server.once('connection', resolve));
    const bound = front.bind('main', { host: '127.0.0.1', port: 0, tls: false });
    fake.send(0n, { kind: 'bound', listener: 'main', port: 1 });
    await bound;
    front.accepting('main', server);
    const connection = fake.open({ credit: 0 });
    const socket = await accepted;
    const written = new Promise((resolve) => socket.write(Buffer.alloc(0), resolve));
    socket.end();
    await Promise.race([written, sleep(1000).then(() => Promise.reject(new Error('the empty write never completed')))]);
    await fake.closed(connection);
    expect(connection.ended).toBe(true);
    expect(connection.received).toEqual([]);
    // TS's only frames for it are its usual receive grant and the end: no data.
    expect(
      fake.frames
        .filter((frame) => frame.id === connection.id && frame.body.kind !== 'credit')
        .map((frame) => frame.body.kind)
    ).toEqual(['end']);
    expect(front.endedBy).toBeUndefined();
    socket.destroy();
  });

  it('grants again as the consumer reads, so a body larger than one grant arrives whole', async () => {
    const { fake, front } = await app({ grantBytes: 16 * 1024 });
    const body = Buffer.alloc(200 * 1024, 0x61);
    const response = await fake.request(
      `POST /count HTTP/1.1\r\nHost: x\r\nConnection: close\r\ncontent-type: application/octet-stream\r\ncontent-length: ${body.length}\r\n\r\n${body.toString('latin1')}`
    );
    expect(response.split('\r\n\r\n')[1]).toBe(`{"bytes":${body.length}}`);
    await sleep(20);
    expect(front.poolInUse).toBe(0);
  });

  it('on a congested channel, writes control first and a connection’s end only after all its data', async () => {
    const { fake } = await app();
    const big = fake.open();
    fake.peer.pause();
    await fake.write(big, get('/big', 'Connection: close\r\n'));
    await sleep(100);
    // While TS's writes are backed up, a new connection's credit grant is queued behind the big body.
    const other = fake.open();
    await sleep(50);
    fake.peer.resume();
    await fake.closed(big);
    await fake.until(() => other.credit > 0, 2000, 'the new connection’s credit');
    const order = fake.frames.map((frame) => `${frame.id}:${frame.body.kind}`);
    const lastData = order.lastIndexOf(`${big.id}:data`);
    expect(order.indexOf(`${other.id}:credit`)).toBeLessThan(lastData);
    expect(order.indexOf(`${big.id}:end`)).toBeGreaterThan(lastData);
    const response = Buffer.concat(big.received);
    expect(response.subarray(response.indexOf('\r\n\r\n') + 4)).toEqual(Buffer.alloc(300 * 1024, 0x62));
  });

  it('finish() flushes frames queued behind backpressure before ending the channel', async () => {
    const { fake, front } = await app();
    const big = fake.open();
    fake.peer.pause();
    await fake.write(big, get('/big'));
    await sleep(100);
    front.unbind('main');
    let settled = false;
    const finished = front.finish(2000).then(() => (settled = true));
    await sleep(100);
    expect(settled).toBe(false);
    const ended = new Promise((resolve) => fake.peer.once('end', resolve));
    fake.peer.resume();
    await finished;
    await ended;
    expect(fake.frames.some((frame) => frame.body.kind === 'unbind')).toBe(true);
    const response = Buffer.concat(big.received);
    expect(response.subarray(response.indexOf('\r\n\r\n') + 4)).toEqual(Buffer.alloc(300 * 1024, 0x62));
    // The channel ending after finish() is the expected end, not a fault.
    fake.peer.end();
    await sleep(20);
    expect(front.endedBy).toBeUndefined();
  });

  it('finish() rejects when the channel does not flush in time', async () => {
    const { fake, front } = await app();
    const big = fake.open();
    fake.peer.pause();
    await fake.write(big, get('/big'));
    await sleep(100);
    await expect(front.finish(200)).rejects.toThrow(/did not flush within 200 ms/);
  });

  it('discards a connection’s queued data when its abort is queued behind it', async () => {
    const { fake } = await app();
    const killed = fake.open();
    fake.peer.pause();
    await fake.write(killed, get('/big-then-kill'));
    await sleep(100);
    fake.peer.resume();
    await fake.closed(killed);
    expect(killed.aborted).toBe('destroy');
    const order = fake.frames.filter((frame) => frame.id === killed.id).map((frame) => frame.body.kind);
    expect(order.at(-1)).toBe('abort');
    expect(Buffer.concat(killed.received).length).toBeLessThan(300 * 1024);
  });
});
