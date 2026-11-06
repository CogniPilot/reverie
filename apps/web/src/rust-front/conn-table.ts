/**
 * Per-connection ordering on one side of the channel, as a pure state machine. It mirrors
 * `reverie-contracts::route_frames_v2::conn`, and both run the `conn` sequences in the shared cases.
 *
 * Each side keeps its open connections and `nextId`, the id after the highest the front has opened.
 * Ids are monotone and never reused in a generation, so any id below `nextId` that is not open is
 * closed, and a late frame for it is settled and dropped without a tombstone set. A connection closes on
 * `abort` from either side; an `abort` that crosses one already sent or received is normal. Without an
 * abort it closes once both directions have ended *and* the front has reported, in `written`, every
 * TS→front stream byte as accepted by the OS. Until then it drains, so the receipt that finishes TS's
 * last write still has an open connection to land on.
 */
import { MAX_STREAM_BYTES } from './frames.js';

export type ConnFaultCode = 'CONN_UNOPENED' | 'CONN_AFTER_END' | 'CONN_FULL' | 'CONN_WRITTEN' | 'CONN_STREAM_BOUND';

/** A frame that breaks the connection rules. Like a frame error, it ends the generation. */
export class ConnFault extends Error {
  constructor(readonly code: ConnFaultCode) {
    super(code);
  }
}

/** A connection frame, as the rules see it. */
export type ConnFrame =
  | { kind: 'open' }
  | { kind: 'data'; bytes: number }
  | { kind: 'end' }
  | { kind: 'abort' }
  | { kind: 'credit'; bytes: number }
  | { kind: 'written'; bytes: number };

/** What a received connection frame means once the rules are applied. */
export type Received =
  | { received: 'opened' }
  | { received: 'data'; bytes: number }
  /** The peer ended its direction; `closed` when that closed the connection. */
  | { received: 'ended'; closed: boolean }
  | { received: 'aborted' }
  | { received: 'credit'; bytes: number }
  /** The front reports this many stream bytes accepted; `closed` when that drained the connection. */
  | { received: 'written'; bytes: number; closed: boolean }
  /** For a closed connection: drop it, releasing `data` bytes to the pool. */
  | { received: 'late'; data: number };

/** Which end of the channel a table belongs to. The TS→front stream is the one `written` counts: TS
 * sends its bytes and receives the receipts, the front receives the bytes and sends them. */
export type Side = 'front' | 'ts';

class Ends {
  local = false;
  remote = false;
  /** TS→front `data` bytes so far. */
  stream = 0;
  /** The last `written`. */
  written = 0;

  get closed(): boolean {
    return this.local && this.remote && this.written === this.stream;
  }

  /** Counts `bytes` more of the TS→front stream. */
  carry(bytes: number): void {
    if (bytes > MAX_STREAM_BYTES - this.stream) throw new ConnFault('CONN_STREAM_BOUND');
    this.stream += bytes;
  }

  /** Records a receipt for the TS→front stream. */
  receipt(bytes: number): void {
    if (bytes <= this.written || bytes > this.stream) throw new ConnFault('CONN_WRITTEN');
    this.written = bytes;
  }
}

export class ConnTable {
  private nextId = 1n;
  private readonly open = new Map<bigint, Ends>();

  constructor(
    private readonly side: Side,
    private readonly maxOpen: number
  ) {}

  get openCount(): number {
    return this.open.size;
  }

  /** The front opens its next connection; the caller then sends `conn_open` with this id. */
  openNext(): bigint {
    if (this.open.size >= this.maxOpen) throw new ConnFault('CONN_FULL');
    const id = this.nextId++;
    this.open.set(id, new Ends());
    return id;
  }

  /** Applies a frame received for `id`. */
  receive(id: bigint, frame: ConnFrame): Received {
    if (frame.kind === 'open') return this.acceptOpen(id);
    if (frame.kind === 'abort' && this.open.delete(id)) return { received: 'aborted' };
    const ends = this.open.get(id);
    if (!ends) return this.late(id, frame);
    if ((frame.kind === 'data' || frame.kind === 'end') && ends.remote) throw new ConnFault('CONN_AFTER_END');
    let received: Received;
    switch (frame.kind) {
      case 'data':
        if (this.side === 'front') ends.carry(frame.bytes);
        received = { received: 'data', bytes: frame.bytes };
        break;
      case 'end':
        ends.remote = true;
        received = { received: 'ended', closed: ends.closed };
        break;
      case 'credit':
        received = { received: 'credit', bytes: frame.bytes };
        break;
      case 'written':
        if (this.side === 'front') throw new ConnFault('CONN_WRITTEN');
        ends.receipt(frame.bytes);
        received = { received: 'written', bytes: frame.bytes, closed: ends.closed };
        break;
      case 'abort':
        throw new Error('handled above');
    }
    if (ends.closed) this.open.delete(id);
    return received;
  }

  /** Checks a frame this side is about to send for `id`. `false` means the connection has already
   * closed (a crossing `abort`), so the frame is not sent. The front calls this for a `written` as
   * the frame goes to the channel, not when it is queued: the receipt that drains a connection is the
   * one that closes it. */
  send(id: bigint, frame: ConnFrame): boolean {
    if (frame.kind === 'abort' && this.open.delete(id)) return true;
    const ends = this.open.get(id);
    if (!ends) {
      if (id < this.nextId) return false;
      throw new ConnFault('CONN_UNOPENED');
    }
    if (frame.kind === 'open') throw new ConnFault('CONN_UNOPENED');
    if ((frame.kind === 'data' || frame.kind === 'end') && ends.local) throw new ConnFault('CONN_AFTER_END');
    if (frame.kind === 'data' && this.side === 'ts') ends.carry(frame.bytes);
    else if (frame.kind === 'end') ends.local = true;
    else if (frame.kind === 'written') {
      if (this.side === 'ts') throw new ConnFault('CONN_WRITTEN');
      ends.receipt(frame.bytes);
    }
    if (ends.closed) this.open.delete(id);
    return true;
  }

  private acceptOpen(id: bigint): Received {
    if (id !== this.nextId) throw new ConnFault('CONN_UNOPENED');
    if (this.open.size >= this.maxOpen) throw new ConnFault('CONN_FULL');
    this.nextId++;
    this.open.set(id, new Ends());
    return { received: 'opened' };
  }

  private late(id: bigint, frame: ConnFrame): Received {
    if (id >= this.nextId) throw new ConnFault('CONN_UNOPENED');
    return { received: 'late', data: frame.kind === 'data' ? frame.bytes : 0 };
  }
}
