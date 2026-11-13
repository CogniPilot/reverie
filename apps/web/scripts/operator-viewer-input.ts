/** Bounded attachment I/O. A probe authorizes only the immutable batch sealed before it. */
export const FRAME_BYTES = 262_144;
const QUEUE_BYTES = 1024 * 1024;
const QUEUE_SLOTS = 4096;
const BATCH_BYTES = 64 * 1024;

export class AttachmentFrames {
  #header = Buffer.alloc(5);
  #headerUsed = 0;
  #payload: Buffer | undefined;
  #used = 0;
  constructor(private readonly accept: (kind: number, payload: Buffer) => void) {}
  feed(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.#payload) {
        const count = Math.min(5 - this.#headerUsed, bytes.length - offset);
        bytes.copy(this.#header, this.#headerUsed, offset, offset + count);
        this.#headerUsed += count; offset += count;
        if (this.#headerUsed < 5) continue;
        const length = this.#header.readUInt32BE(1);
        if (length > FRAME_BYTES) throw new Error('Attachment frame bound exceeded');
        this.#payload = Buffer.alloc(length);
      }
      const count = Math.min(this.#payload.length - this.#used, bytes.length - offset);
      bytes.copy(this.#payload, this.#used, offset, offset + count);
      this.#used += count; offset += count;
      if (this.#used === this.#payload.length) {
        const kind = this.#header[0], payload = this.#payload;
        this.#headerUsed = 0; this.#used = 0; this.#payload = undefined;
        this.accept(kind, payload);
      }
    }
  }
}

type Event = {kind: 'input'; bytes: Buffer} | {kind: 'resize'; cols: number; rows: number};
export interface AttachmentIoPort {
  live(): boolean;
  drained(): Promise<void>;
  probe(): Promise<void>;
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  fail(error: unknown): void;
}
export class AttachmentInput {
  #events: Event[] = [];
  #bytes = 0;
  #slots = 0;
  #running = false;
  #stopped = false;
  #waiters: Array<() => void> = [];
  constructor(private readonly port: AttachmentIoPort) {}
  input(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.#reserve(bytes.length, Math.ceil(bytes.length / BATCH_BYTES));
    for (let offset = 0; offset < bytes.length; offset += BATCH_BYTES)
      this.#events.push({kind: 'input', bytes: Buffer.from(bytes.subarray(offset, offset + BATCH_BYTES))});
    this.#schedule();
  }
  resize(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 1 || cols > 1000 || !Number.isSafeInteger(rows) || rows < 1 || rows > 500)
      throw new Error('Invalid attachment resize');
    this.#reserve(0, 1); this.#events.push({kind: 'resize', cols, rows}); this.#schedule();
  }
  stop(): void {this.#stopped = true; this.#events = []; this.#finish();}
  idle(): Promise<void> {
    return this.#running ? new Promise(resolve => this.#waiters.push(resolve)) : Promise.resolve();
  }
  #reserve(bytes: number, slots: number): void {
    if (this.#stopped) throw new Error('Attachment input is closed');
    if (this.#bytes + bytes > QUEUE_BYTES || this.#slots + slots > QUEUE_SLOTS) {
      this.stop(); throw new Error('Attachment input capacity exceeded; queued input is unconfirmed');
    }
    this.#bytes += bytes; this.#slots += slots;
  }
  #schedule(): void {
    if (this.#running) return;
    this.#running = true;
    queueMicrotask(() => {void this.#pump().catch(error => {this.stop(); this.port.fail(error);})
      .finally(() => {
        this.#running = false;
        if (!this.#stopped && this.#events.length > 0) this.#schedule();
        else this.#finish();
      });});
  }
  #assertLive(): void {
    if (this.#stopped || !this.port.live()) throw new Error('Original attachment no longer available');
  }
  async #pump(): Promise<void> {
    while (!this.#stopped && this.#events.length > 0) {
      // Do not accumulate unbounded writes inside the PTY SDK. This is only
      // buffer credit, never evidence of delivery or target authority.
      await this.port.drained(); this.#assertLive();
      const first = this.#events.shift()!;
      const batch: Event[] = [first];
      let bytes = first.kind === 'input' ? first.bytes.length : 0;
      if (first.kind === 'input') {
        while (this.#events[0]?.kind === 'input') {
          const next = this.#events[0];
          if (bytes + next.bytes.length > BATCH_BYTES) break;
          batch.push(this.#events.shift()!); bytes += next.bytes.length;
        }
      }
      // Arrivals after this point belong to a later, independently probed batch.
      await this.port.probe(); this.#assertLive();
      if (first.kind === 'resize') this.port.resize(first.cols, first.rows);
      else this.port.write(Buffer.concat(batch.map(event => (event as {bytes: Buffer}).bytes), bytes));
      await this.port.drained(); this.#assertLive();
      this.#bytes -= bytes; this.#slots -= batch.length;
    }
  }
  #finish(): void {
    if (!this.#running) for (const resolve of this.#waiters.splice(0)) resolve();
  }
}
