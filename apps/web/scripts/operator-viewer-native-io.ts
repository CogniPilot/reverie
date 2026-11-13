/** Bounded credit for one original binary native-child stream; never delivery proof. */
import type { Writable } from 'node:stream';
import { FRAME_BYTES } from './operator-viewer-input.js';
import { writeBounded } from './operator-viewer-owner.js';

export const NATIVE_IO_WAIT_MS = 5000;

export function nativeFrame(kind: 'I' | 'R', payload: Buffer): Buffer {
  if (payload.length > FRAME_BYTES) throw new Error('Native attachment frame bound exceeded');
  const header = Buffer.alloc(5);
  header[0] = kind.charCodeAt(0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class NativeAttachmentIo {
  #stream?: Writable;
  #ready = false;
  #stopped = false;
  #waiters = new Set<() => void>();

  bind(stream: Writable): void {
    if (this.#stream || this.#stopped) throw new Error('Original native stream cannot be replaced');
    this.#stream = stream;
  }
  ready(): void {
    if (!this.#stream || this.#ready || this.#stopped) throw new Error('Original native stream is unavailable');
    this.#ready = true;
    this.#wake();
  }
  get stopped(): boolean { return this.#stopped; }
  stop(): void {
    this.#stopped = true;
    this.#wake();
  }
  #wake(): void {
    for (const notify of [...this.#waiters]) notify();
  }
  #assert(): Writable {
    const stream = this.#stream;
    if (this.#stopped || !this.#ready || !stream || stream.destroyed || !stream.writable) {
      this.stop();
      throw new Error('Original native attachment stream closed');
    }
    return stream;
  }
  #wait(test: () => boolean, deadline: number, stream?: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (failure?: {cause: unknown}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(check);
        stream?.off('drain', check);
        stream?.off('close', closed);
        stream?.off('error', closed);
        if (failure) reject(failure.cause); else resolve();
      };
      const closed = () => {
        this.#stopped = true;
        finish({cause: new Error('Original native attachment stream closed')});
        this.#wake();
      };
      const check = () => {
        if (this.#stopped || stream?.destroyed || (stream && !stream.writable)) return closed();
        try { if (test()) finish(); } catch (cause) {
          this.#stopped = true; finish({cause}); this.#wake();
        }
      };
      const timer = setTimeout(() => {
        this.#stopped = true;
        finish({cause: new Error('Original native attachment credit expired; input is unconfirmed')});
        this.#wake();
      }, Math.max(0, deadline - performance.now()));
      this.#waiters.add(check);
      stream?.on('drain', check);
      stream?.on('close', closed);
      stream?.on('error', closed);
      check();
    });
  }
  async drained(): Promise<void> {
    try {
      const deadline = performance.now() + NATIVE_IO_WAIT_MS;
      if (!this.#ready) await this.#wait(() => this.#ready, deadline);
      const stream = this.#assert();
      if (stream.writableNeedDrain) await this.#wait(() => !stream.writableNeedDrain, deadline, stream);
      if (this.#assert() !== stream) throw new Error('Original native attachment stream changed');
    } catch (cause) {this.stop(); throw cause;}
  }
  input(bytes: Buffer): void {
    if (bytes.length > 64 * 1024) throw new Error('Native attachment batch bound exceeded');
    try {writeBounded(this.#assert(), nativeFrame('I', bytes));} catch (cause) {this.stop(); throw cause;}
  }
  resize(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 1 || cols > 1000 || !Number.isSafeInteger(rows) || rows < 1 || rows > 500)
      throw new Error('Invalid native attachment geometry');
    try {writeBounded(this.#assert(), nativeFrame('R', Buffer.from(JSON.stringify([cols, rows]))));}
    catch (cause) {this.stop(); throw cause;}
  }
}
