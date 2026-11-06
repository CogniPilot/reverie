/** Own the actual bridge child until its close event, including abort errors.
 * A callback alone can precede termination and is never a settlement receipt.
 */
import { execFile } from 'node:child_process';
import type { BridgeRunner } from './mcp-memory-tools.js';

export const runMemoryBridge: BridgeRunner = (program, args, { env, input, timeoutMs, signal }) =>
  new Promise((resolve) => {
    let outcome: { stdout: string; stderr: string; code: number } | undefined;
    let closed = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (!closed || !outcome) return;
      if (cleanup) clearTimeout(cleanup);
      signal?.removeEventListener('abort', stop);
      resolve(outcome);
    };
    const stop = () => {
      if (closed || cleanup) return;
      // execFile owns the first timeout/abort signal. Retain the actual child
      // through a single escalation; a failed kill still requires close.
      cleanup = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 2_000);
    };
    const child = execFile(
      program,
      args,
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, signal },
      (error, stdout, stderr) => {
        outcome = {
          stdout: String(stdout),
          stderr: String(stderr),
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        };
        if (error) stop();
        finish();
      }
    );
    child.once('close', () => {
      closed = true;
      finish();
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
