/**
 * The front-child fixture the Rust front's integration tests run, checked here without Rust: it is spawned with a real
 * socket pair on fd 3, and the test plays the front on the other end through the shared codec.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { FakeFront } from './fake-front.js';

const web = resolve(import.meta.dirname, '../..');
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

interface Running {
  child: ChildProcess;
  fake: FakeFront;
  events: Array<Record<string, unknown>>;
  exited: Promise<number | null>;
}

function start(env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/rust-front/front-child.ts'], {
    cwd: web,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const fake = new FakeFront(1n, child.stdio[3] as Duplex);
  const events: Array<Record<string, unknown>> = [];
  let partial = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines)
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a lifecycle line.
      }
  });
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return { child, fake, events, exited };
}

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

    // Larger than one 64 KiB grant each way, so credit flows across the real fd in both directions.
    const body = Buffer.alloc(300 * 1024, 0x61);
    const echoed = await running.fake.request(
      `POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\ncontent-type: application/octet-stream\r\ncontent-length: ${body.length}\r\n\r\n${body.toString('latin1')}`
    );
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
    expect(running.events.map((event) => event.event)).toEqual(['bound', 'accepting', 'service_ready']);
  }, 20_000);

  it('on a shutdown frame, closes Fastify, sends unbind and exits 0', async () => {
    const running = start();
    await ready(running);
    running.fake.send(0n, { kind: 'shutdown', signal: 'SIGTERM' });
    expect(await running.exited).toBe(0);
    expect(running.fake.frames.at(-1)?.body).toEqual({ kind: 'unbind', listener: 'main' });
    expect(running.events.map((event) => event.event)).toEqual([
      'bound',
      'accepting',
      'service_ready',
      'shutdown',
      'closed',
    ]);
  }, 20_000);

  it('on SIGTERM, does the same', async () => {
    const running = start();
    await ready(running);
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(0);
    expect(running.fake.frames.at(-1)?.body).toEqual({ kind: 'unbind', listener: 'main' });
  }, 20_000);

  it('exits 70 when the channel ends', async () => {
    const running = start();
    await ready(running);
    running.fake.peer.end();
    expect(await running.exited).toBe(70);
    expect(running.events.at(-1)).toEqual({ event: 'fault', code: 'CHANNEL_CLOSED' });
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
});
