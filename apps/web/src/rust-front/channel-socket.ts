/**
 * One client connection accepted by the Rust front, as the socket TS's own HTTP server reads and writes.
 *
 * The front emits it on a server that never listens (`server.emit('connection', socket)`), so Node's
 * parser, Fastify and `ws` run exactly as they do on a TCP socket. The peer facts come from `conn_open`,
 * as the front's socket reported them. Bytes to the client go out only within the credit the front has
 * granted: `_write` holds its callback while credit is exhausted, so `write()` reports real backpressure
 * and `'drain'` follows real credit. `_final` sends `end` behind every queued byte; `_destroy` sends
 * `abort` unless the front closed the connection first.
 */
import { Duplex } from 'node:stream';
import { MAX_DATA_BYTES, type AbortReason, type Listener, type SocketFacts } from './frames.js';

/** What `conn_open` says about one connection. */
export interface ConnFacts {
  listener: Listener;
  peer: SocketFacts;
  local: SocketFacts;
  encrypted: boolean;
}

/** The front channel's side of one connection; the channel applies the connection rules. */
export interface ConnLink {
  /** Bytes within granted credit, in order. */
  data(id: bigint, bytes: Buffer): void;
  end(id: bigint): void;
  abort(id: bigint): void;
  /** Bytes the consumer has read, which return to the receive pool. */
  consumed(id: bigint, bytes: number): void;
}

/** The error a socket reports when the front closes it, as a TCP socket would for the same cause. */
function closedBy(reason: AbortReason): NodeJS.ErrnoException {
  const code = reason === 'timeout' ? 'ETIMEDOUT' : 'ECONNRESET';
  return Object.assign(new Error(`connection closed by the front (${reason})`), { code });
}

export class ChannelSocket extends Duplex {
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly remoteFamily: 'IPv4' | 'IPv6';
  readonly localAddress: string;
  readonly localPort: number;
  /** Set only for TLS, as on a `tls.TLSSocket`; Fastify's `req.protocol` reads it. */
  readonly encrypted?: true;
  readonly connecting = false;
  readonly pending = false;
  bytesRead = 0;
  bytesWritten = 0;

  private credit = 0;
  private held: { chunk: Buffer; callback: (error?: Error | null) => void } | undefined;
  /** Bytes pushed to the readable side and not yet returned to the receive pool. */
  private unreleased = 0;
  private closedByFront = false;
  private timeoutMs = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: bigint,
    readonly facts: ConnFacts,
    private readonly link: ConnLink
  ) {
    // Node's HTTP server handles half-close itself, as it does for its own sockets.
    super({ allowHalfOpen: true });
    this.remoteAddress = facts.peer.address;
    this.remotePort = facts.peer.port;
    this.remoteFamily = facts.peer.address.includes(':') ? 'IPv6' : 'IPv4';
    this.localAddress = facts.local.address;
    this.localPort = facts.local.port;
    if (facts.encrypted) this.encrypted = true;
  }

  address(): { address: string; family: string; port: number } {
    return { address: this.localAddress, family: this.remoteFamily, port: this.localPort };
  }

  /** `data` from the client. */
  receive(bytes: Buffer): void {
    this.bytesRead += bytes.length;
    this.unreleased += bytes.length;
    this.touch();
    this.push(bytes);
    // A flowing consumer has taken the bytes by the time this runs; a paused one is caught by `_read`.
    queueMicrotask(() => this.release());
  }

  /** `end` from the client: its direction is finished. */
  receiveEnd(): void {
    this.push(null);
  }

  /** `abort` from the front, or the end of the channel generation. */
  receiveAbort(reason: AbortReason): void {
    this.closedByFront = true;
    // Node's HTTP server and `ws` listen for socket errors; a socket no server has taken yet just closes.
    this.destroy(this.listenerCount('error') > 0 ? closedBy(reason) : undefined);
  }

  /** `credit` from the front: bytes it will accept towards the client. */
  grant(bytes: number): void {
    this.credit += bytes;
    this.flush();
  }

  override _read(): void {
    this.release();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // An empty write carries no bytes, so it needs no credit and sends no frame; holding it would also
    // hold back `_final`, and with it `end`, which credit never gates.
    if (chunk.length === 0) {
      callback();
      return;
    }
    this.held = { chunk, callback };
    this.flush();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.link.end(this.id);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.timer);
    this.held = undefined;
    if (!this.closedByFront) this.link.abort(this.id);
    callback(error);
  }

  /** A real inactivity timer, as on a TCP socket: Node's keep-alive and request timeouts rely on it. */
  setTimeout(ms: number, callback?: () => void): this {
    this.timeoutMs = ms;
    if (callback) {
      if (ms === 0) this.off('timeout', callback);
      else this.once('timeout', callback);
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.touch();
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  private touch(): void {
    if (this.timeoutMs === 0 || this.destroyed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emit('timeout'), this.timeoutMs);
  }

  /** Sends as much of the held chunk as credit allows, and releases its callback once all of it is sent. */
  private flush(): void {
    while (this.held && this.credit > 0 && !this.destroyed) {
      const { chunk, callback } = this.held;
      const bytes = Math.min(this.credit, chunk.length, MAX_DATA_BYTES);
      this.link.data(this.id, chunk.subarray(0, bytes));
      this.credit -= bytes;
      this.bytesWritten += bytes;
      this.touch();
      if (bytes < chunk.length) {
        this.held = { chunk: chunk.subarray(bytes), callback };
        continue;
      }
      this.held = undefined;
      callback();
    }
  }

  /** Returns the bytes the consumer has read since the last call to the receive pool. */
  private release(): void {
    const consumed = this.unreleased - this.readableLength;
    if (consumed <= 0) return;
    this.unreleased -= consumed;
    this.link.consumed(this.id, consumed);
  }
}
