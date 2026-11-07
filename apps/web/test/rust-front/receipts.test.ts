/**
 * Write receipts: a write through the front completes only when the front's `written` covers it, as a
 * TCP socket's write completes only when the kernel has accepted it. The socket rules run against a
 * recording link; draining, faults and generation loss run through a FrontChannel behind the fake front.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ChannelSocket, type ConnLink } from '../../src/rust-front/channel-socket.js';
import { FrontChannel } from '../../src/rust-front/front.js';
import { FakeFront, LOOPBACK } from './fake-front.js';

const facts = {
  listener: 'main' as const,
  peer: LOOPBACK,
  local: { address: '127.0.0.1', port: 3000 },
  encrypted: false,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls `predicate`, for outcomes that send the fake front no frame to wake `FakeFront.until` on. */
async function eventually(predicate: () => boolean, what: string, ms = 2000): Promise<void> {
  for (const start = Date.now(); !predicate(); await sleep(5)) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
  }
}

/** A ConnLink that records what the socket asks the channel to send. */
function recording(): ConnLink & { sent: number; frames: number; ended: boolean; aborted: boolean } {
  const link = {
    sent: 0,
    frames: 0,
    ended: false,
    aborted: false,
    data: (_id: bigint, bytes: Buffer) => {
      link.sent += bytes.length;
      link.frames++;
    },
    end: () => {
      link.ended = true;
    },
    abort: () => {
      link.aborted = true;
    },
    consumed: () => undefined,
  };
  return link;
}

function socket(maxStream?: number, credit = 1 << 20) {
  const link = recording();
  const s = new ChannelSocket(1n, facts, link, maxStream);
  s.on('error', () => undefined);
  if (credit > 0) s.grant(credit);
  return { s, link };
}

const code = (error: Error | null | undefined) => (error as NodeJS.ErrnoException | null | undefined)?.code;

describe('a ChannelSocket write completes on its receipt', () => {
  it('does not call back a framed write until the receipt covers it, and a partial receipt is not enough', async () => {
    const { s, link } = socket();
    let done = false;
    s.write(Buffer.alloc(100), () => (done = true));
    await tick();
    expect(link.sent).toBe(100);
    expect(done).toBe(false);
    s.receipt(60);
    await tick();
    expect(done).toBe(false);
    s.receipt(100);
    await tick();
    expect(done).toBe(true);
  });

  it('sends writes buffered behind a waiting one together, completed by one receipt', async () => {
    const { s, link } = socket();
    const done: number[] = [];
    s.write(Buffer.alloc(10), () => done.push(0));
    for (let i = 1; i <= 5; i++) s.write(Buffer.alloc(10), () => done.push(i));
    await tick();
    // The first write waits for its receipt; the five behind it are buffered by Node.
    expect(link.frames).toBe(1);
    s.receipt(10);
    await tick();
    // One `_writev` batch, one frame, then one receipt completes all five.
    expect(link.frames).toBe(2);
    expect(link.sent).toBe(60);
    s.receipt(60);
    await tick();
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps credit and receipts apart: credit frames, receipts complete', async () => {
    const link = recording();
    const s = new ChannelSocket(1n, facts, link);
    let done = false;
    s.write(Buffer.alloc(100), () => (done = true));
    s.grant(40);
    await tick();
    expect(link.sent).toBe(40);
    s.receipt(40);
    await tick();
    expect(done).toBe(false);
    s.grant(60);
    await tick();
    expect(link.sent).toBe(100);
    expect(done).toBe(false);
    s.receipt(100);
    await tick();
    expect(done).toBe(true);
  });

  it('sends end after the last write completes, as net.Socket shuts down after its last write, then finishes', async () => {
    const { s, link } = socket();
    let finished = false;
    s.on('finish', () => (finished = true));
    s.write(Buffer.alloc(50));
    s.receipt(50);
    s.end(Buffer.alloc(30));
    await tick();
    // Writable calls `_final` only once every write has called back, and the last one waits for its receipt.
    expect(link.sent).toBe(80);
    expect(link.ended).toBe(false);
    expect(finished).toBe(false);
    s.receipt(80);
    await tick();
    expect(link.ended).toBe(true);
    expect(finished).toBe(true);
  });

  it('on destroy sends abort at once and fails a write still waiting with ECANCELED, as TCP does', async () => {
    const { s, link } = socket();
    const result: Array<string | undefined> = [];
    s.write(Buffer.alloc(100), (error) => result.push((error as NodeJS.ErrnoException | null | undefined)?.code));
    await tick();
    s.destroy();
    await tick();
    expect(link.aborted).toBe(true);
    expect(result).toEqual(['ECANCELED']);
  });

  for (const [held, credit] of [
    ['with no credit', 0],
    ['part framed', 40],
  ] as const) {
    it(`on destroy fails a write still held ${held} with ECANCELED, once, and nothing completes later`, async () => {
      const { s, link } = socket(undefined, credit);
      const active: Array<string | undefined> = [];
      const queued: Array<string | undefined> = [];
      s.write(Buffer.alloc(100), (error) => active.push(code(error)));
      s.write(Buffer.alloc(10), (error) => queued.push(code(error)));
      await tick();
      expect(link.sent).toBe(credit);
      s.destroy();
      await tick();
      expect(link.aborted).toBe(true);
      expect(active).toEqual(['ECANCELED']);
      // The write buffered behind it is Node's to fail, as on TCP.
      expect(queued).toHaveLength(1);
      expect(queued[0]).toBeDefined();
      // A grant or receipt crossing the destroy neither frames nor completes anything.
      s.grant(1000);
      s.receipt(credit || 1);
      await tick();
      expect(link.sent).toBe(credit);
      expect(active).toEqual(['ECANCELED']);
      expect(queued).toHaveLength(1);
    });
  }

  it('resets the inactivity timer on a receipt, as write completion does on TCP', async () => {
    const { s } = socket();
    let timedOut = false;
    s.setTimeout(80, () => (timedOut = true));
    s.write(Buffer.alloc(10));
    for (let i = 1; i <= 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      s.receipt(Math.min(10, i * 3));
    }
    expect(timedOut).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(timedOut).toBe(true);
  });

  it('completes an empty write at once, with no frame and no receipt', async () => {
    const { s, link } = socket();
    let done = false;
    s.write(Buffer.alloc(0), () => (done = true));
    await tick();
    expect(done).toBe(true);
    expect(link.frames).toBe(0);
  });

  it('fails a write that would cross the stream bound and aborts only that connection', async () => {
    const { s, link } = socket(100);
    const codes: Array<string | undefined> = [];
    s.write(Buffer.alloc(60), (error) => codes.push((error as NodeJS.ErrnoException | null | undefined)?.code));
    s.receipt(60);
    await tick();
    s.write(Buffer.alloc(41), (error) => codes.push((error as NodeJS.ErrnoException | null | undefined)?.code));
    await tick();
    expect(codes).toEqual([undefined, 'ERR_OUT_OF_RANGE']);
    expect(link.sent).toBe(60);
    expect(link.aborted).toBe(true);
  });
});

const channels: FrontChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.removeAllListeners();
});

/** A FrontChannel behind the fake front, accepting on a plain HTTP server that runs `handler`. */
async function fronted(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const fake = new FakeFront();
  const front = new FrontChannel(fake.channel);
  channels.push(front);
  const faults: string[] = [];
  front.on('fault', (fault) => faults.push(fault.code));
  const bound = front.bind('main', { host: '127.0.0.1', port: 0, tls: false });
  await fake.next('bind_request');
  fake.send(0n, { kind: 'bound', listener: 'main', port: 41300 });
  await bound;
  front.accepting('main', createServer(handler));
  await fake.next('accepting');
  return { fake, front, faults };
}

describe('receipts through the front channel', () => {
  it('holds a half-closed connection open until the last receipt, then ends it and finishes the response', async () => {
    let finished = false;
    const { fake, front } = await fronted((_req, res) => {
      res.on('finish', () => (finished = true));
      res.end('x'.repeat(5000));
    });
    const connection = fake.open({ receipts: false });
    await fake.write(connection, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    // The client half-closes right after its request, as the front relays a FIN.
    fake.send(connection.id, { kind: 'end' });
    await fake.until(() => Buffer.concat(connection.received).length > 5000, 2000, 'the whole response');
    await sleep(50);
    const total = Buffer.concat(connection.received).length;
    // Every byte is framed, none is covered: no finish, no end, and the connection stays open.
    expect(finished).toBe(false);
    expect(connection.ended).toBe(false);
    expect(front.openConnections).toBe(1);
    fake.receipt(connection, total - 1);
    await sleep(50);
    expect(finished).toBe(false);
    expect(connection.ended).toBe(false);
    expect(front.openConnections).toBe(1);
    fake.receipt(connection, total);
    await fake.closed(connection);
    await fake.until(() => finished, 2000, 'the response to finish');
    expect(front.openConnections).toBe(0);
  });

  it('ends the generation on a receipt past the bytes sent', async () => {
    const { fake, faults } = await fronted((_req, res) => res.end('hello'));
    const connection = fake.open({ receipts: false });
    await fake.write(connection, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    await fake.until(() => connection.received.length > 0, 2000, 'the response');
    fake.receipt(connection, Buffer.concat(connection.received).length + 1);
    await eventually(() => faults.length > 0, 'a fault');
    expect(faults).toEqual(['CONN_WRITTEN']);
  });

  it('settles a receipt that crosses its connection’s abort without a fault', async () => {
    const { fake, front, faults } = await fronted((req) => req.socket.destroy());
    const connection = fake.open({ receipts: false });
    await fake.write(connection, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await fake.until(() => connection.aborted !== undefined, 2000, 'the abort');
    fake.send(connection.id, { kind: 'written', bytes: 1 });
    await tick();
    await tick();
    expect(faults).toEqual([]);
    expect(front.openConnections).toBe(0);
  });

  for (const [held, credit] of [
    ['with no credit', 0],
    ['part framed', 40],
  ] as const) {
    it(`on generation loss fails a response write still held ${held} with ECANCELED, once`, async () => {
      const codes: Array<string | undefined> = [];
      let served = false;
      const { fake } = await fronted((_req, res) => {
        served = true;
        res.write('x'.repeat(100), (error) => codes.push(code(error)));
      });
      // The front grants the response `credit` bytes, or none, so the write stays held.
      const connection = fake.open({ receipts: false, credit });
      await fake.write(connection, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');
      await eventually(() => served, 'the handler');
      await sleep(20);
      expect(Buffer.concat(connection.received).length).toBe(credit);
      expect(codes).toEqual([]);
      fake.peer.end();
      await eventually(() => codes.length > 0, 'the held write to fail');
      await sleep(20);
      expect(codes).toEqual(['ECANCELED']);
    });
  }

  it('on generation loss fails every write still waiting for its receipt', async () => {
    const codes: Array<string | undefined> = [];
    const { fake } = await fronted((_req, res) => {
      res.write('x'.repeat(100), (error) => codes.push((error as NodeJS.ErrnoException | null | undefined)?.code));
    });
    const connection = fake.open({ receipts: false });
    await fake.write(connection, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await fake.until(() => connection.received.length > 0, 2000, 'the response bytes');
    fake.peer.end();
    await eventually(() => codes.length > 0, 'the pending write to fail');
    expect(codes).toEqual(['ECANCELED']);
  });
});
