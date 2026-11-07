/**
 * The front-child fixture the Rust front's integration tests run, checked here without Rust: it is spawned with a real
 * socket pair on fd 3, and the test plays the front on the other end through the shared codec.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { FakeFront, type FakeConnection } from './fake-front.js';
import { responseBody, sseBody } from './http-body.js';

const web = resolve(import.meta.dirname, '../..');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

interface Running {
  child: ChildProcess;
  fake: FakeFront;
  events: Array<Record<string, unknown> & { event: string }>;
  exited: Promise<number | null>;
  /** Resolves when the child has ended its direction of the channel: everything it wrote has arrived. */
  channelEnded: Promise<void>;
}

function start(env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/rust-front/front-child.ts'], {
    cwd: web,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const fake = new FakeFront(1n, child.stdio[3] as Duplex);
  const events: Running['events'] = [];
  let partial = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines)
      try {
        events.push(JSON.parse(line) as Running['events'][number]);
      } catch {
        // Not a lifecycle line.
      }
  });
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const channelEnded = new Promise<void>((done) => fake.peer.once('end', () => done()));
  return { child, fake, events, exited, channelEnded };
}

/** Polls for a condition on the child's stderr events, which arrive outside FakeFront's frame-driven waits. */
async function eventually(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Finishes on a live socket. A finish whose socket was already destroyed is a truncation: Node completes the
 * cancelled writes and still emits `finish`. Delivery itself is judged from the bytes the client received. */
const genuine = (events: Running['events']) =>
  events.filter((event) => event.event === 'response_finish' && event.socketDestroyed === false);

/** The lifecycle events in order, without the per-response ones. */
const lifecycle = (events: Running['events']) =>
  events.map((event) => event.event).filter((event) => !event.startsWith('response_'));

async function ready(running: Running, port = 41000): Promise<void> {
  const request = await running.fake.next('bind_request');
  expect(request.body).toEqual({ kind: 'bind_request', listener: 'main', tls: false, port: 0, host: '127.0.0.1' });
  running.fake.send(0n, { kind: 'bound', listener: 'main', port });
  await running.fake.next('service_ready');
}

describe.runIf(process.platform !== 'win32')('the front-child fixture on a real fd 3', () => {
  it('binds, accepts and reports ready in order, then serves requests through the real adapter', async () => {
    const running = start();
    await ready(running);
    expect(running.fake.frames.map((frame) => frame.body.kind)).toEqual(['bind_request', 'accepting', 'service_ready']);
    const hello = await running.fake.request('GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect(hello).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(hello.endsWith('hello')).toBe(true);

    // Larger than one 64 KiB grant each way. The response gets one 64 KiB grant and must stop there; only grants given
    // as its bytes arrive let it finish, so this exercises response-credit replenishment across the real fd.
    const body = Buffer.alloc(300 * 1024, 0x61);
    const echo = running.fake.open({ credit: 64 * 1024 });
    await running.fake.write(
      echo,
      `POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\ncontent-type: application/octet-stream\r\ncontent-length: ${body.length}\r\n\r\n${body.toString('latin1')}`
    );
    const sent = () => Buffer.concat(echo.received).length;
    await running.fake.until(() => sent() === 64 * 1024, 5000, 'the first grant to be used');
    await sleep(200);
    expect(sent()).toBe(64 * 1024);
    expect(echo.ended).toBe(false);
    echo.replenish = true;
    running.fake.send(echo.id, { kind: 'credit', bytes: 64 * 1024 });
    await running.fake.closed(echo, 5000);
    running.fake.send(echo.id, { kind: 'end' });
    const echoed = running.fake.text(echo);
    expect(echoed.slice(echoed.indexOf('\r\n\r\n') + 4)).toBe(body.toString('latin1'));

    const peer = await running.fake.request('GET /peer HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', {
      peer: { address: '203.0.113.9', port: 40001 },
      local: { address: '0.0.0.0', port: 41000 },
      encrypted: true,
    });
    expect(JSON.parse(peer.slice(peer.indexOf('\r\n\r\n') + 4))).toEqual({
      ip: '203.0.113.9',
      remotePort: 40001,
      localPort: 41000,
      encrypted: true,
      protocol: 'https',
    });
    const finishes = () => running.events.filter((event) => event.event === 'response_finish');
    await eventually(() => finishes().length === 3, 5000, 'three response finishes');
    expect(lifecycle(running.events)).toEqual(['bound', 'accepting', 'service_ready']);
    expect(running.events.find((event) => event.event === 'service_ready')).toEqual({
      event: 'service_ready',
      port: 41000,
    });
    // Each response logs the shared app's events once its last byte is handed to the channel.
    expect(finishes()).toEqual([
      { event: 'response_finish', method: 'GET', url: '/hello', status: 200, socketDestroyed: false },
      { event: 'response_finish', method: 'POST', url: '/echo', status: 200, socketDestroyed: false },
      { event: 'response_finish', method: 'GET', url: '/peer', status: 200, socketDestroyed: false },
    ]);
  }, 20_000);

  it('logs an unfinished close for a destroyed response, which the front sees as abort', async () => {
    const running = start();
    await ready(running);
    const destroyed = running.fake.open();
    await running.fake.write(destroyed, 'GET /destroy HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    await running.fake.until(() => destroyed.aborted !== undefined, 5000, 'the destroy abort');
    await eventually(
      () => running.events.some((event) => event.event === 'response_close'),
      5000,
      'the response close event'
    );
    expect(running.events.filter((event) => event.event.startsWith('response_'))).toEqual([
      { event: 'response_close', method: 'GET', url: '/destroy', finished: false },
    ]);
  }, 20_000);

  it('on a shutdown frame, closes Fastify, sends unbind and exits 0', async () => {
    const running = start();
    await ready(running);
    running.fake.send(0n, { kind: 'shutdown', signal: 'SIGTERM' });
    await running.channelEnded;
    expect(running.fake.frames.at(-1)?.body).toEqual({ kind: 'unbind', listener: 'main' });
    expect(await running.exited).toBe(0);
    expect(lifecycle(running.events)).toEqual(['bound', 'accepting', 'service_ready', 'shutdown', 'closed']);
  }, 20_000);

  it('on SIGTERM, does the same', async () => {
    const running = start();
    await ready(running);
    running.child.kill('SIGTERM');
    await running.channelEnded;
    expect(running.fake.frames.at(-1)?.body).toEqual({ kind: 'unbind', listener: 'main' });
    expect(await running.exited).toBe(0);
  }, 20_000);

  it('exits 70 when the channel ends', async () => {
    const running = start();
    await ready(running);
    running.fake.peer.end();
    expect(await running.exited).toBe(70);
    expect(running.events.at(-1)).toEqual({ event: 'fault', code: 'CHANNEL_CLOSED' });
  }, 20_000);

  /** A response far larger than the socket buffers, read by nobody: the child's writes back up behind it. */
  async function congest(running: Running): Promise<FakeConnection> {
    // A client that reads nothing gets no receipts either: the front could not write to it.
    const big = running.fake.open({ credit: 16 * 1024 * 1024, receipts: false });
    await running.fake.write(big, 'GET /bytes?n=8388608 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    // Stop reading only once the request (which needs TS's request credit) is out.
    running.fake.peer.pause();
    await sleep(300);
    return big;
  }

  it('on shutdown behind a congested channel, exits 0 only after unbind has been delivered', async () => {
    const running = start();
    await ready(running);
    const big = await congest(running);
    running.fake.send(0n, { kind: 'shutdown', signal: 'SIGTERM' });
    await sleep(500);
    // Fastify has closed, but unbind is still queued behind the unread bytes: the child must still be waiting.
    expect(running.child.exitCode).toBeNull();
    running.fake.peer.resume();
    await running.channelEnded;
    expect(running.fake.frames.some((frame) => frame.body.kind === 'unbind')).toBe(true);
    // The queued response is flushed before Node's idle close, so it arrives whole.
    const response = Buffer.concat(big.received);
    expect(response.length - (response.indexOf('\r\n\r\n') + 4)).toBe(8 * 1024 * 1024);
    expect(await running.exited).toBe(0);
    expect(running.events.at(-1)).toEqual({ event: 'closed' });
  }, 20_000);

  it('on shutdown with an ended response still held for credit, aborts it like the direct child truncates', async () => {
    // The fronted pair of the direct child's truncation case: the response has called end(), but most of its body
    // waits in the socket for credit the front has not granted. Node's server.close() destroys it as idle, which
    // the front sees as abort, and the child still exits 0.
    const running = start();
    await ready(running);
    const total = 1024 * 1024;
    const held = running.fake.open({ credit: 64 * 1024 });
    await running.fake.write(held, `GET /bytes?n=${total} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    await running.fake.until(
      () => Buffer.concat(held.received).length === 64 * 1024,
      5000,
      'the first grant to be used'
    );
    running.fake.send(0n, { kind: 'shutdown', signal: 'SIGTERM' });
    expect(await running.exited).toBe(0);
    expect(held.aborted).toBe('destroy');
    expect(Buffer.concat(held.received).length).toBeLessThan(total);
    // The destroy fails the held write with ECANCELED and Node still emits `finish`, as on TCP; that finish is on a
    // destroyed socket, so it is a truncation, and no genuine one occurs.
    expect(genuine(running.events)).toEqual([]);
  }, 20_000);

  it('exits 71, not 0, when the channel cannot flush before the deadline', async () => {
    const running = start({ FRONT_CHILD_FINISH_MS: '500' });
    await ready(running);
    await congest(running);
    running.fake.send(0n, { kind: 'shutdown', signal: 'SIGTERM' });
    expect(await running.exited).toBe(71);
    // The channel finish timed out, not Fastify's close: unbind went out and only the channel drain is pending.
    expect(running.events.at(-1)).toEqual({
      event: 'unfinished',
      message: 'front channel did not flush within 500 ms',
    });
  }, 20_000);

  it('binds the bridge on the main port when asked, and unbinds both on shutdown', async () => {
    const running = start({ FRONT_CHILD_BRIDGE_HOST: '172.17.0.1' });
    const main = await running.fake.next('bind_request');
    running.fake.send(0n, { kind: 'bound', listener: 'main', port: 41000 });
    const bridge = await running.fake.next('bind_request', running.fake.frames.indexOf(main) + 1);
    expect(bridge.body).toEqual({
      kind: 'bind_request',
      listener: 'bridge',
      tls: false,
      port: 41000,
      host: '172.17.0.1',
    });
    running.fake.send(0n, { kind: 'bound', listener: 'bridge', port: 41000 });
    await running.fake.next('service_ready');
    const answer = await running.fake.request('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', {
      listener: 'bridge',
    });
    expect(answer.endsWith('bridge')).toBe(true);
    running.fake.send(0n, { kind: 'shutdown', signal: 'SIGTERM' });
    expect(await running.exited).toBe(0);
    const unbinds = running.fake.frames.filter((frame) => frame.body.kind === 'unbind').map((frame) => frame.body);
    expect(unbinds).toEqual([
      { kind: 'unbind', listener: 'main' },
      { kind: 'unbind', listener: 'bridge' },
    ]);
  }, 20_000);

  it('E5: an SSE write completes on its receipt, so backpressure and drain follow written, not framing or credit', async () => {
    const running = start();
    await ready(running);
    const events = 32;
    const size = 16 * 1024;
    // Credit for the whole stream, but no receipts: every byte can be framed, none is reported written.
    const stream = running.fake.open({ credit: 16 * 1024 * 1024, receipts: false });
    await running.fake.write(
      stream,
      `GET /sse?n=${events}&size=${size} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`
    );
    const writes = () => running.events.filter((event) => event.event === 'sse_write');
    const drains = () => running.events.filter((event) => event.event === 'sse_drain');
    await eventually(() => writes().some((event) => event.ok === false), 5000, 'an SSE write to report backpressure');
    await sleep(300);
    expect(Buffer.concat(stream.received).length).toBeGreaterThan(0);
    expect(drains()).toEqual([]);
    expect(writes().length).toBeLessThan(events);
    // The front now reports everything sent so far as written, and every later byte as it arrives.
    stream.receipts = true;
    running.fake.receipt(stream);
    await running.fake.closed(stream, 10_000);
    await eventually(() => genuine(running.events).length === 1, 5000, 'the SSE response to finish');
    // The whole stream, byte for byte, as the front received it.
    expect(responseBody(Buffer.concat(stream.received)).toString('latin1')).toBe(sseBody(events, size));
    expect(writes().map((event) => event.seq)).toEqual([...Array(events).keys()]);
    expect(drains().map((event) => event.seq)).toEqual(
      writes()
        .filter((event) => event.ok === false)
        .map((event) => event.seq)
    );
  }, 20_000);

  it('E3: asks the front for a TLS listener when FRONT_CHILD_TLS=1; the front terminates TLS', async () => {
    const running = start({ FRONT_CHILD_TLS: '1' });
    const request = await running.fake.next('bind_request');
    expect(request.body).toEqual({ kind: 'bind_request', listener: 'main', tls: true, port: 0, host: '127.0.0.1' });
  }, 20_000);
});
