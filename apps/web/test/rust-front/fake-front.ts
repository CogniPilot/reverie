/**
 * An in-process stand-in for the Rust front: the other end of a FrontChannel's channel. It speaks
 * route-frames-v2 through the shared codec, records every frame TS sends, and plays clients.
 */
import { duplexPair, type Duplex } from 'node:stream';
import {
  FrameReader,
  encode,
  type AbortReason,
  type Body,
  type Frame,
  type Listener,
  type SocketFacts,
} from '../../src/rust-front/frames.js';

export interface FakeConnection {
  id: bigint;
  /** Bytes TS sent towards the client. */
  received: Buffer[];
  ended: boolean;
  aborted: AbortReason | undefined;
  /** Credit TS has granted for client bytes, and not yet used. */
  credit: number;
  /** Grant back every response byte as it arrives, as a front draining to a fast client would. */
  replenish: boolean;
  /** Report each response byte as accepted by the OS the moment it arrives, as a front writing to a
   * socket with room would. Off, receipts wait for `receipt()`, as behind a client that reads nothing. */
  receipts: boolean;
  /** The last `written` sent. */
  written: number;
}

export const LOOPBACK: SocketFacts = { address: '127.0.0.1', port: 50000 };

export class FakeFront {
  /** The end a FrontChannel reads and writes. */
  readonly channel: Duplex;
  readonly peer: Duplex;
  /** Every frame TS has sent, in order. */
  readonly frames: Frame[] = [];
  readonly connections = new Map<bigint, FakeConnection>();
  private readonly reader = new FrameReader('to_front');
  private nextId = 1n;
  private readonly waiters = new Set<() => void>();

  /** With `peer`, the fake front drives that stream (a real inherited fd in a child's tests), and `channel` is unused. */
  constructor(
    readonly generation = 1n,
    peer?: Duplex
  ) {
    [this.channel, this.peer] = peer ? [peer, peer] : duplexPair();
    this.peer.on('data', (chunk: Buffer) => {
      for (const frame of this.reader.push(chunk)) this.record(frame);
    });
  }

  send(id: bigint, body: Body, generation = this.generation): void {
    this.peer.write(encode({ generation, id, body }, 'to_ts'));
  }

  /** Bytes as they would arrive on the wire, for frames the codec itself would refuse to build. */
  sendRaw(wire: Buffer): void {
    this.peer.write(wire);
  }

  /** Resolves once `predicate` holds, checked after every frame from TS; rejects after `ms`. */
  until(predicate: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}`));
      }, ms);
      this.waiters.add(check);
    });
  }

  /** The first frame from TS of `kind` at or after index `from`. */
  async next<K extends Body['kind']>(kind: K, from = 0): Promise<Frame & { body: Extract<Body, { kind: K }> }> {
    const find = () => this.frames.slice(from).find((frame) => frame.body.kind === kind);
    await this.until(() => find() !== undefined, undefined, `a ${kind} frame`);
    return find() as Frame & { body: Extract<Body, { kind: K }> };
  }

  /** Accepts a client connection: `conn_open`, then `credit` towards the client unless told otherwise. */
  open(
    options: {
      listener?: Listener;
      peer?: SocketFacts;
      local?: SocketFacts;
      encrypted?: boolean;
      credit?: number;
      replenish?: boolean;
      receipts?: boolean;
    } = {}
  ): FakeConnection {
    const id = this.nextId++;
    const connection: FakeConnection = {
      id,
      received: [],
      ended: false,
      aborted: undefined,
      credit: 0,
      replenish: options.replenish ?? false,
      receipts: options.receipts ?? true,
      written: 0,
    };
    this.connections.set(id, connection);
    this.send(id, {
      kind: 'conn_open',
      listener: options.listener ?? 'main',
      peer: options.peer ?? LOOPBACK,
      local: options.local ?? { address: '127.0.0.1', port: 3000 },
      encrypted: options.encrypted ?? false,
    });
    const credit = options.credit ?? 1024 * 1024;
    if (credit > 0) this.send(id, { kind: 'credit', bytes: credit });
    return connection;
  }

  /** Client bytes, sent as TS's credit allows. */
  async write(connection: FakeConnection, bytes: Buffer | string): Promise<void> {
    let rest = Buffer.from(bytes);
    while (rest.length > 0) {
      await this.until(() => connection.credit > 0 || connection.aborted !== undefined, 2000, 'credit from TS');
      if (connection.aborted) return;
      const size = Math.min(rest.length, connection.credit, 64 * 1024);
      connection.credit -= size;
      this.send(connection.id, { kind: 'data', bytes: rest.subarray(0, size) });
      rest = rest.subarray(size);
    }
  }

  /** Reports `bytes` of `connection`'s response as accepted by the OS, as the front's `written` does. */
  receipt(connection: FakeConnection, bytes = Buffer.concat(connection.received).length): void {
    connection.written = bytes;
    this.send(connection.id, { kind: 'written', bytes });
  }

  text(connection: FakeConnection): string {
    return Buffer.concat(connection.received).toString('latin1');
  }

  /** Waits until TS has closed its direction of `connection`, by `end` or `abort`. */
  closed(connection: FakeConnection, ms = 2000): Promise<void> {
    return this.until(
      () => connection.ended || connection.aborted !== undefined,
      ms,
      `connection ${connection.id} to close`
    );
  }

  /** One request on a fresh connection; resolves with everything TS sent once it closes. The client
   * then closes its own direction too, as a client's FIN relayed by the front would. */
  async request(raw: string, options: Parameters<FakeFront['open']>[0] = {}): Promise<string> {
    const connection = this.open(options);
    await this.write(connection, raw);
    await this.closed(connection);
    if (!connection.aborted) this.send(connection.id, { kind: 'end' });
    return this.text(connection);
  }

  private record(frame: Frame): void {
    this.frames.push(frame);
    const connection = this.connections.get(frame.id);
    if (connection) {
      if (frame.body.kind === 'data') {
        connection.received.push(frame.body.bytes);
        if (connection.replenish) this.send(frame.id, { kind: 'credit', bytes: frame.body.bytes.length });
        if (connection.receipts && connection.aborted === undefined) this.receipt(connection);
      }
      if (frame.body.kind === 'end') connection.ended = true;
      if (frame.body.kind === 'abort') connection.aborted = frame.body.reason;
      if (frame.body.kind === 'credit') connection.credit += frame.body.bytes;
    }
    for (const waiter of [...this.waiters]) waiter();
  }
}
