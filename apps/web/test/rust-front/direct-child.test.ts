/**
 * The direct-Node child of the paired fixture: the same app and events as the fronted child, on a real TCP listener.
 * These pin the direct side's shutdown behaviour, the baseline a fronted slow-client run is compared against.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';

const web = resolve(import.meta.dirname, '../..');
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
      { event: 'response_finish', method: 'GET', url: '/hello', status: 200 },
      { event: 'response_finish', method: 'POST', url: '/echo', status: 200 },
      { event: 'response_finish', method: 'GET', url: '/peer', status: 200 },
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
    // Read slowly, at most one buffered chunk every 2 ms, until the child logs finish: Node's socket has handed the
    // last byte to the kernel, but the client has not read it all.
    const chunks: Buffer[] = [];
    const deadline = Date.now() + 15_000;
    while (!has(running, 'response_finish')) {
      if (Date.now() > deadline) throw new Error('timed out waiting for response_finish');
      const chunk = socket.read() as Buffer | null;
      if (chunk) chunks.push(chunk);
      await sleep(2);
    }
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
    expect(has(running, 'response_finish')).toBe(false);
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(0);
    const { bytes } = await drain(socket);
    expect(bodyOf(bytes).length).toBeLessThan(total);
    expect(has(running, 'response_finish')).toBe(false);
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
});
