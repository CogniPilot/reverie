/**
 * One client connection accepted by the Rust front, as the socket TS's own HTTP server reads and writes.
 *
 * The front emits it on a server that never listens (`server.emit('connection', socket)`), so Node's
 * parser, Fastify and `ws` run exactly as they do on a TCP socket. The peer facts come from `conn_open`,
 * as the front's socket reported them. Bytes to the client go out only within the credit the front has
 * granted, and a write completes only once the front's `written` receipts cover it: the OS has accepted
 * those bytes for the client, which is what a TCP socket's write callback means. So `write()` reports real
 * backpressure, `'drain'` follows real completion, and a response's `finish` means what it does on TCP.
 * Writable calls `_final` only after the last write's callback, so `end` follows the receipt that covers
 * every byte, as a TCP socket's shutdown follows its last write's completion; `_destroy` sends
 * `abort` unless the front closed the connection first, and fails the write in flight with `ECANCELED`,
 * as a TCP socket's destroy does.
 */
import { Duplex } from 'node:stream';
import { MAX_DATA_BYTES, MAX_STREAM_BYTES, type AbortReason, type Listener, type SocketFacts } from './frames.js';

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

type Callback = (error?: Error | null) => void;

/** The error the write in flight gets when the socket is destroyed, as on TCP. */
function cancelled(): NodeJS.ErrnoException {
  return Object.assign(new Error('write cancelled: the connection was destroyed'), { code: 'ECANCELED' });
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
  /** The write not yet framed, and its callback. */
  private held: { chunk: Buffer; callback: Callback } | undefined;
  /** The framed write waiting for its receipt: its callback runs once `written` reaches `until`. */
  private waiting: { until: number; callback: Callback } | undefined;
  /** The front's last `written`: stream bytes the OS has accepted for the client. */
  private written = 0;
  /** Bytes pushed to the readable side and not yet returned to the receive pool. */
  private unreleased = 0;
  private closedByFront = false;
  private timeoutMs = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: bigint,
    readonly facts: ConnFacts,
    private readonly link: ConnLink,
    /** The most bytes this connection may send; a parameter only so tests can reach it. */
    private readonly maxStream = MAX_STREAM_BYTES
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

  /** `written` from the front: its total of this connection's bytes the OS has accepted. The channel has
   * checked that it advances and stays within what was sent. */
  receipt(bytes: number): void {
    // A completed write is activity on a TCP socket too.
    if (bytes > this.written) this.touch();
    this.written = bytes;
    if (this.waiting && this.written >= this.waiting.until) {
      const { callback } = this.waiting;
      this.waiting = undefined;
      callback();
    }
  }

  /** `credit` from the front: bytes it will accept towards the client. */
  grant(bytes: number): void {
    this.credit += bytes;
    this.flush();
  }

  override _read(): void {
    this.release();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: Callback): void {
    this.send(chunk, callback);
  }

  /** Writes buffered behind a waiting one go out together, so many small writes cost one receipt wait. */
  override _writev(chunks: Array<{ chunk: Buffer }>, callback: Callback): void {
    this.send(Buffer.concat(chunks.map(({ chunk }) => chunk)), callback);
  }

  private send(chunk: Buffer, callback: Callback): void {
    // An empty write carries no bytes, so it needs no credit, sends no frame and waits for no receipt;
    // holding it would also hold back `_final`, and with it `end`, which credit never gates.
    if (chunk.length === 0) {
      callback();
      return;
    }
    if (chunk.length > this.maxStream - this.bytesWritten) {
      // Past the stream bound no receipt could cover it: fail the write, which destroys the socket.
      callback(Object.assign(new Error('write past the stream bound'), { code: 'ERR_OUT_OF_RANGE' }));
      return;
    }
    this.held = { chunk, callback };
    this.flush();
  }

  override _final(callback: Callback): void {
    this.link.end(this.id);
    callback();
  }

  override _destroy(error: Error | null, callback: Callback): void {
    clearTimeout(this.timer);
    // Node leaves the write in flight to `_destroy`: it is held for credit or waiting for its receipt, never
    // both, and is failed once here. The writes buffered behind it are Node's to fail.
    const active = (this.held ?? this.waiting)?.callback;
    this.held = undefined;
    this.waiting = undefined;
    if (!this.closedByFront) this.link.abort(this.id);
    callback(error);
    active?.(cancelled());
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

  /** Sends as much of the held chunk as credit allows. Once all of it is sent, its callback waits for the
   * receipt that covers it. */
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
      this.waiting = { until: this.bytesWritten, callback };
      // The receipt can already be in: a channel that delivers synchronously answers inside `data()`.
      this.receipt(this.written);
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
