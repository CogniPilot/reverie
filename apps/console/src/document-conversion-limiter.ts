/**
 * @fileoverview Global concurrency limiter for spawning external document
 * converters (pdftoppm / LibreOffice `soffice` / Word-COM `powershell.exe`).
 *
 * Without a cap, N simultaneous thumbnail/preview requests for *distinct*
 * documents fork N converter processes at once — each held open for up to the
 * multi-minute conversion timeout. That is a localhost resource-exhaustion
 * (fork-bomb-shaped) vector: a handful of large PDFs detected at once can pin
 * CPU and RAM. This module serializes converter spawns down to a small fixed
 * pool; excess spawns queue (FIFO) until a slot frees. The in-flight cache in
 * `document-preview-cache.ts` already de-dups *identical* inputs; this bounds
 * the *distinct* case the cache can't.
 *
 * Permit accounting transfers the slot directly to the next waiter on release
 * (rather than decrement-then-reacquire) so the active count can never exceed
 * the cap even under interleaved async resumption.
 *
 * NOT re-entrant: never call `runWithConversionLimit` from inside a task that is
 * already holding a slot — a nested acquire under a full pool would deadlock.
 * The converter call sites only ever acquire once per request (the office path
 * acquires for `soffice` and `pdftoppm` sequentially, not nested).
 */

/**
 * Max converter processes allowed to run concurrently across the whole process.
 * Override with CODEMAN_MAX_DOCUMENT_CONVERSIONS (clamped to >= 1).
 */
const MAX_CONCURRENT_DOCUMENT_CONVERSIONS = (() => {
  const raw = Number(process.env.CODEMAN_MAX_DOCUMENT_CONVERSIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
})();

let active = 0;
const waiters: Array<() => void> = [];

/** Test/diagnostic hook: converters currently holding a slot. */
export function getActiveConversionCount(): number {
  return active;
}

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_DOCUMENT_CONVERSIONS) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter — `active` stays at the cap.
    next();
  } else {
    active--;
  }
}

/** Run `task` once a converter slot is free, releasing the slot afterward. */
export async function runWithConversionLimit<T>(task: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}
