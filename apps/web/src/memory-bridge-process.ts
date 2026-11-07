/** Own the actual bridge child until its close event, including abort errors.
 * A callback alone can precede termination and is never a settlement receipt.
 */
import { execFile } from 'node:child_process';
import type { BridgeRunner } from './mcp-memory-tools.js';

const MAX_BUFFER = 1024 * 1024;
const CLEANUP_MS = 2_000;

export const runMemoryBridge: BridgeRunner = (program, args, { env, input, timeoutMs, signal }) =>
  new Promise((resolve) => {
    const began = performance.now();
    let outcome: { stdout: string; stderr: string; code: number } | undefined;
    let closed = false;
    let interrupted = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (!closed || !outcome) return;
      // Event-loop delay can deliver close before the overdue monitor callback.
      // Acceptance uses the original monotonic deadline, not callback order.
      if (outcome.code === 0 && (interrupted || (timeoutMs > 0 && performance.now() - began >= timeoutMs))) {
        outcome.code = 1;
      }
      if (cleanup) clearTimeout(cleanup);
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener('abort', aborted);
      resolve(outcome);
    };
    const stop = (end = performance.now() + CLEANUP_MS) => {
      if (closed || cleanup) return;
      interrupted = true;
      // execFile owns the first SIGTERM. Its timeout/overflow callback can wait
      // for close, so independently arm one escalation at the first stop end.
      // A failed kill still cannot stand in for the actual close event.
      cleanup = setTimeout(
        () => {
          if (!closed) child.kill('SIGKILL');
        },
        Math.max(0, end - performance.now())
      );
    };
    const aborted = () => stop();
    const child = execFile(
      program,
      args,
      { env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal },
      (error, stdout, stderr) => {
        outcome = {
          stdout: String(stdout),
          stderr: String(stderr),
          code: error ? (typeof error.code === 'number' ? error.code : 1) : interrupted ? 1 : 0,
        };
        if (error) stop();
        finish();
      }
    );
    child.once('close', () => {
      closed = true;
      finish();
    });
    if (timeoutMs > 0) {
      const end = began + timeoutMs;
      deadline = setTimeout(() => stop(end + CLEANUP_MS), Math.max(0, end - performance.now()));
    }
    // Observe the same per-stream UTF-8 byte count used by execFile. It remains
    // the sole output collector and error producer; this watcher owns cleanup.
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0;
      stream?.on('data', (chunk: string | Buffer) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BUFFER) stop();
      });
    }
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) stop();
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
