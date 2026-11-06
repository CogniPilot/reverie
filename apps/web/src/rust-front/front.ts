/**
 * The TS end of the Rust front's channel: one route-frames-v2 stream, inherited on fd 3.
 *
 * The front owns the listening sockets. TS asks it to bind each listener, says when it is accepting,
 * and receives each client connection as `conn_open`, which becomes a `ChannelSocket` emitted on a
 * server that never listens. This class keeps the connection rules (`ConnTable`), the receive pool and
 * its credit grants, and the writer's three queues:
 *  1. priority control (lifecycle, `credit`, `abort`), bounded by the control reserve;
 *  2. the snapshot lane, which 2a does not use;
 *  3. one stream queue per connection, served round-robin, holding its `data` and then its `end` in
 *     order, so a graceful `end` is never written before the bytes queued ahead of it.
 * Any frame, rule or credit fault ends the generation: every connection is aborted and the channel is
 * closed. TS never recovers a generation; the front exits with TS's status and its supervisor restarts both.
 */
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { ChannelSocket, type ConnLink } from './channel-socket.js';
import { ConnFault, ConnTable, type ConnFaultCode } from './conn-table.js';
import {
  FrameError,
  FrameReader,
  MAX_DATA_BYTES,
  encode,
  type Body,
  type FrameErrorCode,
  type Listener,
  type Signal,
} from './frames.js';

/** The channel's file descriptor in TS: never 0–2, which TS's own children may inherit. */
export const CHANNEL_FD = 3;
export const MAX_CONNECTIONS = 4096;
/** Client bytes buffered in TS: granted to the front and not yet read by their consumer. */
export const POOL_BYTES = 32 * 1024 * 1024;
/** The most a connection may have granted and unread at once. */
export const GRANT_BYTES = 64 * 1024;
/** Pending priority-control frames, in bytes. */
export const CONTROL_RESERVE_BYTES = 1024 * 1024;

export type FrontFaultCode =
  | FrameErrorCode
  | ConnFaultCode
  | 'GENERATION'
  | 'LIFECYCLE'
  | 'CREDIT_OVERRUN'
  | 'CONTROL_RESERVE'
  | 'CHANNEL_CLOSED';

/** The reason a generation ended. */
export class FrontFault extends Error {
  constructor(readonly code: FrontFaultCode) {
    super(`front channel generation ended: ${code}`);
  }
}

export interface BindOptions {
  host: string;
  port: number;
  tls: boolean;
}

export interface FrontChannelOptions {
  /** The front's generation; 2a runs exactly one TS child per front, so one generation. */
  generation?: bigint;
  maxConnections?: number;
  poolBytes?: number;
  grantBytes?: number;
  controlReserveBytes?: number;
}

type ListenerState =
  | { state: 'binding'; resolve: (port: number) => void; reject: (error: Error) => void }
  | { state: 'bound'; port: number }
  | { state: 'accepting'; port: number; server: Server }
  | { state: 'unbound' };

interface Connection {
  socket: ChannelSocket;
  /** Credit granted to the front and not yet used. */
  granted: number;
  /** Bytes received and not yet read by the consumer. */
  unread: number;
  /** The front has sent `end`, so TS's own `end` closes the connection. */
  remoteEnded: boolean;
}

interface ControlItem {
  bytes: number;
  /** The frame, encoded when it is written; undefined if it is no longer needed. */
  wire: () => Buffer | undefined;
}

/** `fault` once, when the generation ends; `shutdown` when the front forwards a signal. */
export class FrontChannel extends EventEmitter<{ fault: [FrontFault]; shutdown: [Signal] }> {
  private readonly generation: bigint;
  private readonly poolBytes: number;
  private readonly grantBytes: number;
  private readonly controlReserveBytes: number;
  private readonly reader = new FrameReader('to_ts');
  private readonly table: ConnTable;
  private readonly bindings = new Map<Listener, ListenerState>();
  private readonly connections = new Map<bigint, Connection>();
  /** Connections waiting for pool space, in the order they started waiting. */
  private readonly starved = new Set<bigint>();
  private poolUsed = 0;
  private readonly control: ControlItem[] = [];
  private controlBytes = 0;
  /** One pending `credit` per connection: later grants add to it. */
  private readonly pendingCredit = new Map<bigint, number>();
  private readonly streams = new Map<bigint, Buffer[]>();
  private readonly rotation: bigint[] = [];
  private writable = true;
  private ended: FrontFault | undefined;
  /** Set once `finish` has ended TS's direction: the channel closing after that is the expected end, not a fault. */
  private finished = false;
  /** Runs once the writer has handed every queued frame to the channel. */
  private onIdle: (() => void) | undefined;
  /** The one finish in flight, shared by every caller so none is left waiting on a replaced hook. */
  private finishing: Promise<void> | undefined;
  /** Callers waiting for every stream queue to be handed to the channel. */
  private readonly streamWaiters = new Set<() => void>();
  private readonly link: ConnLink;

  constructor(
    private readonly channel: Duplex,
    options: FrontChannelOptions = {}
  ) {
    super();
    this.generation = options.generation ?? 1n;
    this.poolBytes = options.poolBytes ?? POOL_BYTES;
    this.grantBytes = Math.min(options.grantBytes ?? GRANT_BYTES, this.poolBytes);
    this.controlReserveBytes = options.controlReserveBytes ?? CONTROL_RESERVE_BYTES;
    this.table = new ConnTable(options.maxConnections ?? MAX_CONNECTIONS);
    this.link = {
      data: (id, bytes) => this.sendData(id, bytes),
      end: (id) => this.sendEnd(id),
      abort: (id) => this.sendAbort(id),
      consumed: (id, bytes) => this.consumed(id, bytes),
    };
    channel.on('data', (chunk: Buffer) => this.read(chunk));
    channel.on('end', () => this.finished || this.fault('CHANNEL_CLOSED'));
    channel.on('error', () => this.finished || this.fault('CHANNEL_CLOSED'));
    channel.on('drain', () => {
      this.writable = true;
      this.pump();
    });
  }

  /** The channel TS inherits from the front. */
  static fromInheritedFd(options: FrontChannelOptions = {}): FrontChannel {
    return new FrontChannel(new Socket({ fd: CHANNEL_FD, readable: true, writable: true }), options);
  }

  /** Why the generation ended, once it has. */
  get endedBy(): FrontFault | undefined {
    return this.ended;
  }

  get openConnections(): number {
    return this.connections.size;
  }

  /** Bytes of the receive pool granted or unread. */
  get poolInUse(): number {
    return this.poolUsed;
  }

  /** Asks the front to bind `listener`; resolves with the bound port, or rejects as `listen()` would. */
  bind(listener: Listener, options: BindOptions): Promise<number> {
    const current = this.bindings.get(listener);
    if (current && current.state !== 'unbound') throw new Error(`${listener} listener is already ${current.state}`);
    return new Promise((resolve, reject) => {
      this.bindings.set(listener, { state: 'binding', resolve, reject });
      this.sendControl({ kind: 'bind_request', listener, tls: options.tls, port: options.port, host: options.host });
    });
  }

  /** Starts delivering `listener`'s connections to `server`, which never listens itself. */
  accepting(listener: Listener, server: Server): void {
    const current = this.bindings.get(listener);
    if (current?.state !== 'bound') throw new Error(`${listener} listener is not bound`);
    restoreListeningBehaviour(server);
    this.bindings.set(listener, { state: 'accepting', port: current.port, server });
    this.sendControl({ kind: 'accepting', listener });
  }

  serviceReady(): void {
    this.sendControl({ kind: 'service_ready' });
  }

  /**
   * Writes every queued frame, then ends TS's direction of the channel. It resolves once the channel has flushed
   * them, so a clean exit after it means the front was sent everything, `unbind` included. It rejects if the
   * generation ends first or the channel has not flushed within `timeoutMs`. Later calls share the first call's
   * outcome and deadline.
   */
  finish(timeoutMs: number): Promise<void> {
    if (this.finishing) return this.finishing;
    if (this.ended) return Promise.reject(this.ended);
    this.finishing = new Promise((resolve, reject) => {
      const done = (error?: Error | null) => {
        clearTimeout(timer);
        this.off('fault', done);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error(`front channel did not flush within ${timeoutMs} ms`)), timeoutMs);
      this.once('fault', done);
      this.onIdle = () => {
        this.finished = true;
        this.channel.end((error?: Error | null) => done(error));
      };
      this.pump();
    });
    return this.finishing;
  }

  /**
   * Resolves true once every connection's queued `data` and `end` have been handed to the channel, or false if that
   * has not happened within `timeoutMs` or the generation ended. Shutdown waits on it before Node's idle close
   * destroys sockets, because an abort discards what a connection still has queued.
   */
  flushStreams(timeoutMs: number): Promise<boolean> {
    if (this.ended) return Promise.resolve(false);
    if (this.streams.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (flushed: boolean) => {
        clearTimeout(timer);
        this.streamWaiters.delete(waiter);
        this.off('fault', onFault);
        resolve(flushed);
      };
      const waiter = () => done(true);
      const onFault = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.streamWaiters.add(waiter);
      this.once('fault', onFault);
    });
  }

  /** Asks the front to close `listener`. Connections it accepted before this keep running. */
  unbind(listener: Listener): void {
    const current = this.bindings.get(listener);
    if (current?.state !== 'bound' && current?.state !== 'accepting') return;
    this.bindings.set(listener, { state: 'unbound' });
    this.sendControl({ kind: 'unbind', listener });
  }

  private read(chunk: Buffer): void {
    if (this.ended) return;
    try {
      for (const frame of this.reader.push(chunk)) {
        if (this.ended) return;
        if (frame.generation !== this.generation) throw new FrontFault('GENERATION');
        this.receive(frame.id, frame.body);
      }
    } catch (error) {
      if (error instanceof FrameError || error instanceof ConnFault || error instanceof FrontFault)
        this.fault(error.code);
      else throw error;
    }
  }

  private receive(id: bigint, body: Body): void {
    switch (body.kind) {
      case 'bound':
      case 'bind_failed': {
        const current = this.bindings.get(body.listener);
        if (current?.state !== 'binding') throw new FrontFault('LIFECYCLE');
        if (body.kind === 'bound') {
          this.bindings.set(body.listener, { state: 'bound', port: body.port });
          current.resolve(body.port);
        } else {
          this.bindings.set(body.listener, { state: 'unbound' });
          current.reject(Object.assign(new Error(body.message || body.errno), { code: body.errno }));
        }
        return;
      }
      case 'shutdown':
        this.emit('shutdown', body.signal);
        return;
      case 'conn_open':
        this.open(id, body);
        return;
      case 'data': {
        const outcome = this.table.receive(id, { kind: 'data', bytes: body.bytes.length });
        if (outcome.received === 'late') return;
        const connection = this.connection(id);
        if (body.bytes.length > connection.granted) throw new FrontFault('CREDIT_OVERRUN');
        connection.granted -= body.bytes.length;
        connection.unread += body.bytes.length;
        connection.socket.receive(body.bytes);
        return;
      }
      case 'end': {
        const outcome = this.table.receive(id, { kind: 'end' });
        if (outcome.received !== 'ended') return;
        const connection = this.connection(id);
        connection.remoteEnded = true;
        if (outcome.closed) this.settle(id);
        connection.socket.receiveEnd();
        return;
      }
      case 'abort': {
        const outcome = this.table.receive(id, { kind: 'abort' });
        if (outcome.received !== 'aborted') return;
        const { socket } = this.connection(id);
        this.settle(id);
        this.dropStream(id);
        socket.receiveAbort(body.reason);
        return;
      }
      case 'credit': {
        const outcome = this.table.receive(id, { kind: 'credit', bytes: body.bytes });
        if (outcome.received === 'credit') this.connection(id).socket.grant(body.bytes);
        return;
      }
    }
  }

  private open(id: bigint, body: Extract<Body, { kind: 'conn_open' }>): void {
    this.table.receive(id, { kind: 'open' });
    const target = this.bindings.get(body.listener);
    if (target?.state !== 'accepting' && target?.state !== 'unbound') throw new FrontFault('LIFECYCLE');
    const socket = new ChannelSocket(id, body, this.link);
    this.connections.set(id, { socket, granted: 0, unread: 0, remoteEnded: false });
    if (target.state === 'unbound') {
      // Accepted before the front saw `unbind`: refuse it as a closed listener would.
      socket.destroy();
      return;
    }
    this.regrant(id);
    target.server.emit('connection', socket);
  }

  private connection(id: bigint): Connection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error(`connection ${id} is open in the table but not here`);
    return connection;
  }

  /** The connection has closed: everything it held returns to the pool, and its grants are forgotten. */
  private settle(id: bigint): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.poolUsed -= connection.granted + connection.unread;
    this.connections.delete(id);
    this.pendingCredit.delete(id);
    this.starved.delete(id);
    this.feedStarved();
  }

  private consumed(id: bigint, bytes: number): void {
    const connection = this.connections.get(id);
    if (!connection || this.ended) return;
    connection.unread -= bytes;
    this.poolUsed -= bytes;
    // Connections already waiting are served first, in order. The consumer then tops up from what is left,
    // or waits behind them: regranting it first would hand it back every byte it just freed.
    this.feedStarved();
    this.regrant(id);
  }

  /** Tops the connection up to `grantBytes` granted and unread, as far as the pool allows. */
  private regrant(id: bigint): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    const wanted = this.grantBytes - connection.granted - connection.unread;
    if (wanted <= 0) return;
    const bytes = Math.min(wanted, this.poolBytes - this.poolUsed);
    if (bytes < wanted) this.starved.add(id);
    else this.starved.delete(id);
    if (bytes <= 0) return;
    connection.granted += bytes;
    this.poolUsed += bytes;
    this.grantCredit(id, bytes);
  }

  private feedStarved(): void {
    for (const id of this.starved) {
      if (this.poolUsed >= this.poolBytes) return;
      this.regrant(id);
    }
  }

  private grantCredit(id: bigint, bytes: number): void {
    const pending = this.pendingCredit.get(id);
    this.pendingCredit.set(id, (pending ?? 0) + bytes);
    if (pending !== undefined) return;
    this.queueControl(HEADER_AND_CREDIT, () => {
      const granted = this.pendingCredit.get(id);
      this.pendingCredit.delete(id);
      if (!granted || !this.table.send(id, { kind: 'credit', bytes: granted })) return undefined;
      return encode({ generation: this.generation, id, body: { kind: 'credit', bytes: granted } }, 'to_front');
    });
    this.pump();
  }

  private sendData(id: bigint, bytes: Buffer): void {
    if (this.ended || !this.check(() => this.table.send(id, { kind: 'data', bytes: bytes.length }))) return;
    for (let at = 0; at < bytes.length; at += MAX_DATA_BYTES) {
      const body: Body = { kind: 'data', bytes: Buffer.from(bytes.subarray(at, at + MAX_DATA_BYTES)) };
      this.queueStream(id, encode({ generation: this.generation, id, body }, 'to_front'));
    }
    this.pump();
  }

  private sendEnd(id: bigint): void {
    if (this.ended || !this.check(() => this.table.send(id, { kind: 'end' }))) return;
    this.queueStream(id, encode({ generation: this.generation, id, body: { kind: 'end' } }, 'to_front'));
    // Ending the second direction closes the connection.
    if (this.connections.get(id)?.remoteEnded) this.settle(id);
    this.pump();
  }

  private sendAbort(id: bigint): void {
    if (this.ended || !this.check(() => this.table.send(id, { kind: 'abort' }))) return;
    // An abort discards the connection's queued bytes; the front forgets its grants on close too.
    this.dropStream(id);
    this.settle(id);
    const wire = encode({ generation: this.generation, id, body: { kind: 'abort', reason: 'destroy' } }, 'to_front');
    this.queueControl(wire.length, () => wire);
    this.pump();
  }

  /** Runs a connection-rule check for a frame TS is about to send; a fault ends the generation. */
  private check(send: () => boolean): boolean {
    try {
      return send();
    } catch (error) {
      if (!(error instanceof ConnFault)) throw error;
      this.fault(error.code);
      return false;
    }
  }

  private sendControl(body: Body): void {
    if (this.ended) throw this.ended;
    const wire = encode({ generation: this.generation, id: 0n, body }, 'to_front');
    this.queueControl(wire.length, () => wire);
    this.pump();
  }

  private queueControl(bytes: number, wire: () => Buffer | undefined): void {
    if (this.controlBytes + bytes > this.controlReserveBytes) {
      this.fault('CONTROL_RESERVE');
      return;
    }
    this.controlBytes += bytes;
    this.control.push({ bytes, wire });
  }

  private queueStream(id: bigint, wire: Buffer): void {
    const queue = this.streams.get(id);
    if (queue) {
      queue.push(wire);
      return;
    }
    this.streams.set(id, [wire]);
    this.rotation.push(id);
  }

  private dropStream(id: bigint): void {
    if (!this.streams.delete(id)) return;
    this.rotation.splice(this.rotation.indexOf(id), 1);
    this.streamsFlushed();
  }

  private streamsFlushed(): void {
    if (this.streams.size > 0) return;
    for (const waiter of [...this.streamWaiters]) waiter();
  }

  /** Writes while the channel accepts: all priority control first, then one stream frame per turn. */
  private pump(): void {
    while (this.writable && !this.ended) {
      let wire: Buffer | undefined;
      const item = this.control.shift();
      if (item) {
        this.controlBytes -= item.bytes;
        wire = item.wire();
        if (!wire) continue;
      } else {
        const id = this.rotation.shift();
        if (id === undefined) {
          const idle = this.onIdle;
          this.onIdle = undefined;
          idle?.();
          return;
        }
        const queue = this.streams.get(id) as Buffer[];
        wire = queue.shift() as Buffer;
        if (queue.length > 0) this.rotation.push(id);
        else {
          this.streams.delete(id);
          this.streamsFlushed();
        }
      }
      this.writable = this.channel.write(wire);
    }
  }

  /** Ends the generation: every connection is aborted, every pending bind fails, and the channel closes. */
  private fault(code: FrontFaultCode): void {
    if (this.ended) return;
    const fault = new FrontFault(code);
    this.ended = fault;
    for (const { socket } of this.connections.values()) socket.receiveAbort('generation');
    this.connections.clear();
    for (const state of this.bindings.values()) if (state.state === 'binding') state.reject(fault);
    this.channel.destroy();
    this.emit('fault', fault);
  }
}

/** A `credit` frame's wire size, counted against the control reserve while it is pending. */
const HEADER_AND_CREDIT = 4 + 18 + 4;

/**
 * Node installs connection tracking (header and request timeouts, idle close) only on a server's
 * `'listening'` event, and a server fed through `emit('connection')` never listens. Emitting it once
 * restores them, and with them the idle close in `server.close()`. On the pinned Node and Fastify
 * versions only Node's own tracking listens for it, and
 * `server.listening` stays false; test/rust-front/adapter.test.ts pins both.
 */
const tracked = new WeakSet<Server>();
export function restoreListeningBehaviour(server: Server): void {
  if (tracked.has(server)) return;
  tracked.add(server);
  server.emit('listening');
}

/**
 * When Fastify starts closing: waits (at most `flushMs`) until every connection's queued response bytes have been
 * handed to the front, then asks it to stop accepting on `listener`. Fastify then calls `server.close()` even though
 * it never listened, and Node's `close()` runs `closeIdleConnections()` (working once the `'listening'` emit above
 * has installed tracking). Its destroy becomes an abort, which would discard bytes still queued, hence the flush.
 */
export function closeThroughFront(
  app: FastifyInstance,
  front: FrontChannel,
  listener: Listener = 'main',
  flushMs = 5000
): void {
  app.addHook('preClose', async () => {
    await front.flushStreams(flushMs);
    front.unbind(listener);
  });
}
