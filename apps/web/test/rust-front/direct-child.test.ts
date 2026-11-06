/**
 * The direct-Node child of the paired fixture: the same app and events as the fronted child, on a real TCP listener.
 * These pin the direct side's shutdown behaviour, the baseline a fronted slow-client run is compared against.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { connect as connectTls } from 'node:tls';

const web = resolve(import.meta.dirname, '../..');
const tlsDir = resolve(import.meta.dirname, 'fixtures/tls');
const tlsEnv = {
  FRONT_CHILD_TLS: '1',
  FRONT_CHILD_TLS_CERT: resolve(tlsDir, 'cert.pem'),
  FRONT_CHILD_TLS_KEY: resolve(tlsDir, 'key.pem'),
};
const ca = readFileSync(resolve(tlsDir, 'cert.pem'));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const children: ChildProcess[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

type Event = Record<string, unknown> & { event: string };

interface Running {
  child: ChildProcess;
  events: Event[];
  exited: Promise<number | null>;
}

function start(env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/rust-front/direct-child.ts'], {
    cwd: web,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  const events: Event[] = [];
  let partial = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines)
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
        // Not an event line.
      }
  });
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return { child, events, exited };
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const has = (running: Running, event: string) => running.events.some((entry) => entry.event === event);
/** Finishes on a live socket. A finish whose socket was already destroyed is a truncation: Node completes the
 * cancelled writes and still emits `finish`. Delivery itself is judged from the bytes the client read. */
const genuine = (running: Running) =>
  running.events.filter((entry) => entry.event === 'response_finish' && entry.socketDestroyed === false);

async function ready(running: Running): Promise<number> {
  await until(() => has(running, 'service_ready'), 15_000, 'service_ready');
  return running.events.find((entry) => entry.event === 'service_ready')?.port as number;
}

/** Opens a connection and sends one request; the socket stays paused, so nothing is read until the test reads. */
async function send(port: number, request: string): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  await new Promise<void>((done, fail) => socket.once('connect', done).once('error', fail));
  socket.write(request);
  return socket;
}

/** Waits until the SSE stream is stopped on backpressure: its last write reported it, that write has not drained,
 * and no write follows for 300 ms. */
async function stalled(writes: () => Event[], drains: () => Event[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the SSE stream to stall');
    const before = writes().length;
    await sleep(300);
    const last = writes().at(-1);
    if (writes().length === before && last?.ok === false && !drains().some((entry) => entry.seq === last.seq)) return;
  }
}

/** As `send`, over TLS to the fixed test certificate. */
async function sendTls(port: number, request: string): Promise<Socket> {
  const socket = connectTls({ port, host: '127.0.0.1', ca, servername: 'localhost' });
  sockets.push(socket);
  await new Promise<void>((done, fail) => socket.once('secureConnect', done).once('error', fail));
  socket.write(request);
  return socket;
}

/** Reads slowly, at most one buffered chunk every 2 ms, until the child logs a genuine finish. */
async function readUntilFinish(running: Running, socket: Socket, chunks: Buffer[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (genuine(running).length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for response_finish');
    const chunk = socket.read() as Buffer | null;
    if (chunk) chunks.push(chunk);
    await sleep(2);
  }
}

/** Reads everything until the peer ends, resolving with the bytes and whether the socket ended cleanly. */
function drain(socket: Socket, chunks: Buffer[] = []): Promise<{ bytes: Buffer; clean: boolean }> {
  return new Promise((done) => {
    let clean = false;
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => (clean = true));
    socket.once('error', () => undefined);
    socket.once('close', () => done({ bytes: Buffer.concat(chunks), clean }));
  });
}

const bodyOf = (bytes: Buffer) => bytes.subarray(bytes.indexOf('\r\n\r\n') + 4);
const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`;

describe.runIf(process.platform !== 'win32')('the direct-Node child of the paired fixture', () => {
  it('listens, reports its port, serves the shared routes and logs each response finish', async () => {
    const running = start();
    const port = await ready(running);
    expect(port).toBeGreaterThan(0);
    expect(running.events.slice(0, 2)).toEqual([
      { event: 'listening', port },
      { event: 'service_ready', port },
    ]);

    const hello = await drain(await send(port, get('/hello')));
    expect(hello.bytes.toString()).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(bodyOf(hello.bytes).toString()).toBe('hello');

    const body = Buffer.alloc(300 * 1024, 0x61);
    const echo = await drain(
      await send(
        port,
        `POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\ncontent-type: application/octet-stream\r\ncontent-length: ${body.length}\r\n\r\n${body.toString('latin1')}`
      )
    );
    expect(bodyOf(echo.bytes).equals(body)).toBe(true);

    const peer = JSON.parse(bodyOf((await drain(await send(port, get('/peer')))).bytes).toString()) as Record<
      string,
      unknown
    >;
    expect(peer).toMatchObject({ ip: '127.0.0.1', localPort: port, encrypted: false, protocol: 'http' });

    await until(() => running.events.filter((entry) => entry.event === 'response_close').length === 3, 5000, 'closes');
    expect(running.events.filter((entry) => entry.event === 'response_finish')).toEqual([
      { event: 'response_finish', method: 'GET', url: '/hello', status: 200, socketDestroyed: false },
      { event: 'response_finish', method: 'POST', url: '/echo', status: 200, socketDestroyed: false },
      { event: 'response_finish', method: 'GET', url: '/peer', status: 200, socketDestroyed: false },
    ]);
    expect(running.events.filter((entry) => entry.event === 'response_close').map((entry) => entry.finished)).toEqual([
      true,
      true,
      true,
    ]);
  }, 20_000);

  it('logs an unfinished close for a destroyed response, and the client gets no response', async () => {
    const running = start();
    const port = await ready(running);
    const destroyed = await drain(await send(port, get('/destroy')));
    expect(destroyed.bytes.length).toBe(0);
    await until(() => has(running, 'response_close'), 5000, 'the response close event');
    expect(running.events.filter((entry) => entry.event.startsWith('response_'))).toEqual([
      { event: 'response_close', method: 'GET', url: '/destroy', finished: false },
    ]);
  }, 20_000);

  it('on SIGTERM while idle, closes and exits 0', async () => {
    const running = start();
    await ready(running);
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(0);
    expect(running.events.map((entry) => entry.event)).toEqual(['listening', 'service_ready', 'shutdown', 'closed']);
  }, 20_000);

  it('on SIGTERM after the genuine response finish, with bytes still unread, delivers the whole response', async () => {
    const running = start();
    const port = await ready(running);
    const total = 8 * 1024 * 1024;
    const socket = await send(port, get(`/bytes?n=${total}`));
    // Read slowly until the child logs a genuine finish: Node's socket has handed the last byte to the kernel, but the
    // client has not read it all.
    const chunks: Buffer[] = [];
    await readUntilFinish(running, socket, chunks);
    const readAtShutdown = Buffer.concat(chunks).length;
    running.child.kill('SIGTERM');
    await sleep(300);
    const { bytes, clean } = await drain(socket, chunks);
    expect(readAtShutdown).toBeLessThan(total);
    expect(bodyOf(bytes).length).toBe(total);
    expect(clean).toBe(true);
    expect(await running.exited).toBe(0);
    const order = running.events.map((entry) => entry.event);
    expect(order.indexOf('response_finish')).toBeLessThan(order.indexOf('shutdown'));
    expect(order.at(-1)).toBe('closed');
  }, 30_000);

  it('on SIGTERM before finish, behind a client that reads nothing, destroys the response and still exits 0', async () => {
    // The baseline a fronted run must not assume away: Node 22's server.close() runs closeIdleConnections, which spares
    // a connection only while its response has not called end(). This response has ended but is still queued behind
    // a client that reads nothing, so the close destroys it mid-body and the child exits 0 with the response truncated.
    const running = start();
    const port = await ready(running);
    // Larger than any loopback socket buffers, so the response cannot finish without the client reading.
    const total = 64 * 1024 * 1024;
    const socket = await send(port, get(`/bytes?n=${total}`));
    await sleep(500);
    expect(genuine(running)).toEqual([]);
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(0);
    const { bytes } = await drain(socket);
    expect(bodyOf(bytes).length).toBeLessThan(total);
    // Any finish here is Node completing the cancelled writes of the destroyed socket, not a delivery.
    expect(genuine(running)).toEqual([]);
    // The response's own close event can land after the exit, so only the lifecycle end is pinned here.
    expect(running.events.at(-1)).toEqual({ event: 'closed' });
  }, 30_000);

  it('waits for a response that has not ended, and exits 71 if it outlives the deadline', async () => {
    const running = start({ FRONT_CHILD_FINISH_MS: '500' });
    const port = await ready(running);
    const socket = await send(port, get('/slow?ms=3000'));
    await sleep(100);
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(71);
    expect(running.events.at(-1)).toEqual({ event: 'unfinished', message: 'Fastify did not close within 500 ms' });
    socket.destroy();
  }, 30_000);

  it('delivers a response that ends during shutdown, inside the deadline, and exits 0', async () => {
    const running = start();
    const port = await ready(running);
    const socket = await send(port, get('/slow?ms=300'));
    await sleep(100);
    running.child.kill('SIGTERM');
    const { bytes } = await drain(socket);
    expect(bodyOf(bytes).toString()).toBe('slow');
    expect(await running.exited).toBe(0);
    const order = running.events.map((entry) => entry.event);
    expect(order.indexOf('shutdown')).toBeLessThan(order.indexOf('response_finish'));
    expect(order.at(-1)).toBe('closed');
  }, 30_000);

  it('E3: serves the same app over TLS with the fixed certificate, and reports the request as encrypted', async () => {
    const running = start(tlsEnv);
    const port = await ready(running);
    const hello = await drain(await sendTls(port, get('/hello')));
    expect(bodyOf(hello.bytes).toString()).toBe('hello');
    const peer = JSON.parse(bodyOf((await drain(await sendTls(port, get('/peer')))).bytes).toString()) as Record<
      string,
      unknown
    >;
    expect(peer).toMatchObject({ ip: '127.0.0.1', localPort: port, encrypted: true, protocol: 'https' });
  }, 20_000);

  it('E3 with E1: over TLS, SIGTERM after the genuine finish still delivers the whole 8 MiB', async () => {
    const running = start(tlsEnv);
    const port = await ready(running);
    const total = 8 * 1024 * 1024;
    const socket = await sendTls(port, get(`/bytes?n=${total}`));
    const chunks: Buffer[] = [];
    await readUntilFinish(running, socket, chunks);
    expect(Buffer.concat(chunks).length).toBeLessThan(total);
    running.child.kill('SIGTERM');
    await sleep(300);
    const { bytes, clean } = await drain(socket, chunks);
    expect(bodyOf(bytes).equals(Buffer.alloc(total, 0x78))).toBe(true);
    expect(clean).toBe(true);
    expect(await running.exited).toBe(0);
  }, 30_000);

  it('E3 with E2: over TLS, SIGTERM before finish behind a client that reads nothing truncates and exits 0', async () => {
    const running = start(tlsEnv);
    const port = await ready(running);
    const total = 64 * 1024 * 1024;
    const socket = await sendTls(port, get(`/bytes?n=${total}`));
    await sleep(500);
    expect(genuine(running)).toEqual([]);
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(0);
    const { bytes } = await drain(socket);
    expect(bodyOf(bytes).length).toBeLessThan(total);
    expect(genuine(running)).toEqual([]);
  }, 30_000);

  it('E5: an SSE stream behind a slow reader stalls on backpressure, drains as the client reads, and arrives whole', async () => {
    const running = start();
    const port = await ready(running);
    // 16 MiB, more than the loopback socket buffers can absorb, so the stream must stall until the client reads.
    const events = 256;
    const size = 64 * 1024;
    const socket = await send(port, get(`/sse?n=${events}&size=${size}`));
    const writes = () => running.events.filter((entry) => entry.event === 'sse_write');
    const drains = () => running.events.filter((entry) => entry.event === 'sse_drain');
    await stalled(writes, drains);
    expect(writes().length).toBeLessThan(events);
    const { bytes } = await drain(socket);
    const text = bodyOf(bytes).toString('latin1');
    expect(text.split('data: ').length - 1).toBe(events);
    expect(text.split('').filter((char) => char === 'x').length).toBe(events * size);
    await until(() => genuine(running).length === 1, 5000, 'the SSE response to finish');
    expect(writes().map((entry) => entry.seq)).toEqual([...Array(events).keys()]);
    // Every write that reported backpressure drained before the next one.
    expect(drains().map((entry) => entry.seq)).toEqual(
      writes()
        .filter((entry) => entry.ok === false)
        .map((entry) => entry.seq)
    );
  }, 30_000);
});
