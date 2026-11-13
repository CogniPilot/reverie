/** A single original Docker client on an owned PTY, using the packaged node-pty ABI. */
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

interface NativePty {
  readonly pid: number;
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal: string): void;
  onData(callback: (data: string | Buffer) => void): unknown;
  onExit(callback: (event: {exitCode: number}) => void): unknown;
}
interface PtyModule {spawn(file: string, args: string[], options: Record<string, unknown>): NativePty;}
export interface AttachmentPty {
  readonly pid: number;
  live(): boolean;
  drained(): Promise<void>;
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}
export function capturePtyStream(value: unknown): () => boolean {
  const original = value as {_socket?: {destroyed?: unknown; _handle?: {fd?: unknown}}; _fd?: unknown; _writable?: unknown};
  const stream = original?._socket, handle = stream?._handle, fd = original?._fd;
  if (!stream || !handle || !Number.isSafeInteger(fd) || Number(fd) < 0 || handle.fd !== fd) return () => false;
  // onExit follows ReadStream close in the pinned SDK. Retain this original
  // stream as a deny-only witness; a reused descriptor is never a new target.
  let closed = false;
  return () => {
    if (original._socket !== stream || stream._handle !== handle || original._fd !== fd || handle.fd !== fd
      || stream.destroyed !== false || original._writable !== true) closed = true;
    return !closed;
  };
}

interface WriteEntry {buffer: Buffer; offset: number;}
function writeQueue(value: unknown): WriteEntry[] {
  const stream = (value as {_writeStream?: unknown})?._writeStream;
  const queue = (stream as {_writeQueue?: unknown})?._writeQueue;
  if (!Array.isArray(queue)) throw new Error('Packaged PTY buffering interface unavailable');
  for (const entry of queue as Array<{buffer?: unknown; offset?: unknown}>) {
    if (!Buffer.isBuffer(entry?.buffer) || !Number.isSafeInteger(entry.offset) || Number(entry.offset) < 0 || Number(entry.offset) > entry.buffer.length)
      throw new Error('Packaged PTY buffering interface changed');
  }
  return queue as WriteEntry[];
}
export function bufferedPtyBytes(value: unknown): number {
  let total = 0;
  for (const entry of writeQueue(value)) {
    total += entry.buffer.length - entry.offset;
    if (total > 64 * 1024) throw new Error('Attachment PTY buffer capacity exceeded');
  }
  return total;
}
export class PtyWriteCredit {
  #pending: WriteEntry | undefined;
  #failed = false;
  constructor(private readonly child: unknown) {}
  empty(): boolean {
    try {
      if (this.#failed) throw new Error('Original attachment PTY write unconfirmed');
      const buffered = bufferedPtyBytes(this.child);
      if (this.#pending) {
        // The pinned SDK clears its queue on non-EAGAIN failure. Retain the
        // original entry so a dropped write cannot become fresh buffer credit.
        if (this.#pending.offset === this.#pending.buffer.length) this.#pending = undefined;
        else if (!writeQueue(this.child).includes(this.#pending)) throw new Error('Original attachment PTY write unconfirmed');
      }
      return buffered === 0 && !this.#pending;
    } catch (error) {this.#failed = true; throw error;}
  }
  wrote(bytes: Buffer): void {
    const queue = writeQueue(this.child);
    if (this.#failed || queue.length !== 1 || !queue[0].buffer.equals(bytes)) {
      this.#failed = true; throw new Error('Original attachment PTY write unconfirmed');
    }
    this.#pending = queue[0];
  }
}

export function loadAttachmentPty(): (containerId: string, cols: number, rows: number,
  output: (bytes: Buffer) => void, exit: (code: number) => void) => AttachmentPty {
  const require = createRequire(import.meta.url);
  const module: unknown = require(process.env.REVERIE_OPERATOR_NODE_PTY ?? 'node-pty');
  if (!module || typeof (module as PtyModule).spawn !== 'function') throw new Error('Canonical node-pty runtime unavailable');
  return (containerId, cols, rows, output, exit) => {
    const child = (module as PtyModule).spawn('docker', ['exec', '-it', containerId, '/bin/tmux', '-u', '-L', 'reverie-laptop', 'attach-session', '-t', '=office'],
      {cols, rows, name: 'xterm-256color', encoding: null, env: {...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8'}});
    const pid = child.pid;
    let alive = true, closing = false;
    const credit = new PtyWriteCredit(child);
    const streamOpen = capturePtyStream(child);
    const live = () => alive && !closing && child.pid === pid && streamOpen();
    child.onData(data => {if (live()) output(Buffer.isBuffer(data) ? data : Buffer.from(data));});
    child.onExit(event => {alive = false; exit(event.exitCode);});
    return {
      pid, live,
      async drained() {
        const deadline = performance.now() + 5000;
        while (true) {
          if (!live()) throw new Error('Original attachment PTY closed');
          if (credit.empty()) return;
          if (performance.now() >= deadline) throw new Error('Original attachment PTY drain unconfirmed');
          await delay(5);
        }
      },
      write(bytes) {
        if (!live() || bytes.length > 64 * 1024 || !credit.empty()) throw new Error('Original attachment PTY not writable');
        child.write(bytes);
        credit.wrote(bytes);
      },
      resize(nextCols, nextRows) {if (!live()) throw new Error('Original attachment PTY closed'); child.resize(nextCols, nextRows);},
      close() {if (live()) {closing = true; child.kill('SIGTERM');}},
    };
  };
}
