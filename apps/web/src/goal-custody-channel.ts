/** Bounded persistent transport to one operator-pinned closed helper.
 * No listener, identity/path/engine arguments, authority cache or request lease.
 * A worker thread services async private pipes while the commit guard waits on
 * bounded shared memory; it never supplies authorization, only fresh G replies.
 */
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

// JavaScript runs as a separate thread of this same server/process identity.
// Only the already pinned program/endpoint are passed; no caller data enters it.
const transport = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const control = new Int32Array(workerData.memory, 0, 2);
const output = new Uint8Array(workerData.memory, 8);
const child = spawn(workerData.executable, ['--goal-custody-stream'], {
  env: { REVERIE_WORKER_SOCKET: workerData.socket }, stdio: ['pipe', 'pipe', 'ignore']
});
let pending = false, failed = false, timer, received = Buffer.alloc(0);
function finish(state, bytes) {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (bytes) { output.set(bytes); Atomics.store(control, 1, bytes.length); }
  pending = false;
  Atomics.store(control, 0, state); Atomics.notify(control, 0);
}
function fail() {
  failed = true;
  if (pending) finish(3);
  child.kill('SIGKILL');
}
child.on('error', fail); child.on('exit', fail);
child.stdin.on('error', fail); child.stdout.on('error', fail);
child.stdout.on('data', chunk => {
  if (!pending || failed || received.length + chunk.length > 32773) return fail();
  received = Buffer.concat([received, chunk]);
  if (received.length < 5) return;
  const length = received.readUInt32BE(1);
  if (received[0] !== 74 || length > 32768 || received.length > length + 5) return fail();
  if (received.length === length + 5) finish(2, received.subarray(5));
});
parentPort.on('message', operation => {
  if (operation === 'close') { failed = true; if (timer) clearTimeout(timer); child.kill('SIGKILL'); parentPort.close(); return; }
  if (operation !== 'G' || pending || failed) { finish(3); return fail(); }
  pending = true; received = Buffer.alloc(0);
  timer = setTimeout(fail, 2000);
  child.stdin.write('G', error => { if (error) fail(); });
});
parentPort.on('close', () => child.kill('SIGKILL'));
`;

export class GoalCustodyChannel {
  private readonly memory = new SharedArrayBuffer(32768 + 8);
  private readonly control = new Int32Array(this.memory, 0, 2);
  private readonly output = new Uint8Array(this.memory, 8);
  private readonly worker: Worker;
  private closed = false;
  private busy = false;
  constructor(executable: string, socket: string) {
    this.worker = new Worker(transport, { eval: true, workerData: { executable, socket, memory: this.memory } });
    this.worker.on('error', () => this.close());
    this.worker.unref();
  }
  project(): string {
    if (this.closed || this.busy) throw Error('Private Goal custody transport unavailable');
    this.busy = true;
    try {
      Atomics.store(this.control, 0, 0);
      Atomics.store(this.control, 1, 0);
      this.worker.postMessage('G');
      const deadline = performance.now() + 2500;
      while (Atomics.load(this.control, 0) === 0) {
        const remaining = deadline - performance.now();
        if (remaining <= 0 || Atomics.wait(this.control, 0, 0, remaining) === 'timed-out')
          throw Error('Private Goal custody transport deadline exceeded');
      }
      const size = Atomics.load(this.control, 1);
      if (Atomics.load(this.control, 0) !== 2 || size < 1 || size > 32768)
        throw Error('Private Goal custody transport refused');
      return new TextDecoder('utf-8', { fatal: true }).decode(this.output.subarray(0, size));
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.postMessage('close');
    } catch {
      /* already unavailable */
    }
    const shutdown = setTimeout(() => {
      void this.worker.terminate().catch(() => undefined);
    }, 2500);
    shutdown.unref();
    this.worker.once('exit', () => clearTimeout(shutdown));
  }
}
