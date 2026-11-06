/**
 * Per-connection ordering on one side of the channel, as a pure state machine. It mirrors
 * `reverie-contracts::route_frames_v2::conn`, and both run the `conn` sequences in the shared cases.
 *
 * Each side keeps its open connections and `nextId`, the id after the highest the front has opened.
 * Ids are monotone and never reused in a generation, so any id below `nextId` that is not open is
 * closed, and a late frame for it is settled and dropped without a tombstone set. A connection closes
 * when both directions have ended, or on `abort` from either side; an `abort` that crosses one already
 * sent or received is normal.
 */

export type ConnFaultCode = 'CONN_UNOPENED' | 'CONN_AFTER_END' | 'CONN_FULL';

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
  | { kind: 'credit'; bytes: number };

/** What a received connection frame means once the rules are applied. */
export type Received =
  | { received: 'opened' }
  | { received: 'data'; bytes: number }
  /** The peer ended its direction; `closed` when ours had ended too. */
  | { received: 'ended'; closed: boolean }
  | { received: 'aborted' }
  | { received: 'credit'; bytes: number }
  /** For a closed connection: drop it, releasing `data` bytes to the pool. */
  | { received: 'late'; data: number };

interface Ends {
  local: boolean;
  remote: boolean;
}

export class ConnTable {
  private nextId = 1n;
  private readonly open = new Map<bigint, Ends>();

  constructor(private readonly maxOpen: number) {}

  get openCount(): number {
    return this.open.size;
  }

  /** The front opens its next connection; the caller then sends `conn_open` with this id. */
  openNext(): bigint {
    if (this.open.size >= this.maxOpen) throw new ConnFault('CONN_FULL');
    const id = this.nextId++;
    this.open.set(id, { local: false, remote: false });
    return id;
  }

  /** Applies a frame received for `id`. */
  receive(id: bigint, frame: ConnFrame): Received {
    if (frame.kind === 'open') return this.acceptOpen(id);
    const ends = this.open.get(id);
    if (!ends) return this.late(id, frame);
    if ((frame.kind === 'data' || frame.kind === 'end') && ends.remote) throw new ConnFault('CONN_AFTER_END');
    switch (frame.kind) {
      case 'data':
        return { received: 'data', bytes: frame.bytes };
      case 'end': {
        ends.remote = true;
        const closed = ends.local;
        if (closed) this.open.delete(id);
        return { received: 'ended', closed };
      }
      case 'abort':
        this.open.delete(id);
        return { received: 'aborted' };
      case 'credit':
        return { received: 'credit', bytes: frame.bytes };
    }
  }

  /** Checks a frame this side is about to send for `id`. `false` means the connection has already
   * closed (a crossing `abort`), so the frame is not sent. */
  send(id: bigint, frame: ConnFrame): boolean {
    const ends = this.open.get(id);
    if (!ends) {
      if (id < this.nextId) return false;
      throw new ConnFault('CONN_UNOPENED');
    }
    if (frame.kind === 'open') throw new ConnFault('CONN_UNOPENED');
    if ((frame.kind === 'data' || frame.kind === 'end') && ends.local) throw new ConnFault('CONN_AFTER_END');
    if (frame.kind === 'end') {
      ends.local = true;
      if (ends.remote) this.open.delete(id);
    } else if (frame.kind === 'abort') this.open.delete(id);
    return true;
  }

  private acceptOpen(id: bigint): Received {
    if (id !== this.nextId) throw new ConnFault('CONN_UNOPENED');
    if (this.open.size >= this.maxOpen) throw new ConnFault('CONN_FULL');
    this.nextId++;
    this.open.set(id, { local: false, remote: false });
    return { received: 'opened' };
  }

  private late(id: bigint, frame: ConnFrame): Received {
    if (id >= this.nextId) throw new ConnFault('CONN_UNOPENED');
    return { received: 'late', data: frame.kind === 'data' ? frame.bytes : 0 };
  }
}
