/**
 * @fileoverview Resume a Codex session whose last turn died because the model was at capacity.
 *
 * When the provider is overloaded Codex does not retry: codex-cli 0.163.0 (measured 2026-10-29 against a mock Responses
 * server returning `server_is_overloaded`, as an HTTP 503 and as a `response.failed` event) ends the turn at once with
 *
 *   ■ Selected model is at capacity. Please try a different model.
 *
 * and then sits at an empty composer. Nothing else will ever wake it, so an employee in the middle of a goal just stops.
 *
 * The rule: when the pane is idle and the LAST transcript line above an empty composer is such an error, type `continue`
 * after a backoff (1, 2, 5, 10, then every 15 minutes, about two hours in all) and give up after that. Every attempt
 * re-reads the screen first, so a person who typed, a session that resumed on its own or any newer output cancels it. Only a
 * line Codex itself drew (column zero, its `■` error mark) counts: an agent quoting the message in an answer is indented
 * under a `•` bullet and is never matched.
 *
 * Pure apart from the injected capture, send, clock and log (test/capacity-stall.test.ts).
 *
 * @module capacity-stall
 */
import { composerIsEmpty } from './session-submit-verifier.js';
import { stripAnsi } from './utils/index.js';

/** Waits before each retry; the list's length caps the attempts. */
export const CAPACITY_RETRY_DELAYS_MS: readonly number[] = [
  60_000, 120_000, 300_000, 600_000, 900_000, 900_000, 900_000, 900_000, 900_000, 900_000,
];

/** What is typed to resume the turn. */
export const CAPACITY_RETRY_PROMPT = 'continue';

/** After output that mentions capacity, look at the settled screen this much later. */
export const CAPACITY_CHECK_DELAY_MS = 3_000;

/** Codex's own end-of-turn error row for an overloaded model. */
const CAPACITY_ERROR_ROW = /^■ .*(?:\bat capacity\b|server_is_overloaded|\boverloaded\b|\bhigh demand\b)/iu;

/** A cheap pre-filter for streamed output: only then is the screen read. */
const CAPACITY_WORDS = /at capacity|server_is_overloaded|overloaded|high demand/i;

/** The capacity error that ended the last turn, or null when the screen does not show exactly that. */
export function capacityStallLine(screen: string | null | undefined, glyph: string): string | null {
  if (!screen || glyph !== '›' || !composerIsEmpty(screen, glyph)) return null;
  const lines = stripAnsi(screen).split('\n');
  let composer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(glyph)) { composer = i; break; }
  }
  for (let i = composer - 1; i >= 0; i--) {
    const row = lines[i].trimEnd();
    if (!row) continue;
    return CAPACITY_ERROR_ROW.test(row) ? row : null;
  }
  return null;
}

export type CapacityRetryEvent =
  | { kind: 'scheduled'; attempt: number; delayMs: number; line: string }
  | { kind: 'retried'; attempt: number }
  | { kind: 'gave-up'; attempts: number; line: string };

export interface CapacityRetryDeps {
  /** The pane with its SGR codes (composer reads need them), or null when unreadable. */
  capture(): string | null | undefined;
  glyph(): string;
  isWorking(): boolean;
  isStopped(): boolean;
  /** Type the prompt and press Enter, only into an empty composer. */
  send(prompt: string): Promise<boolean>;
  onEvent?(event: CapacityRetryEvent): void;
  log?(message: string): void;
  /** Test seam; production uses CAPACITY_RETRY_DELAYS_MS. */
  delaysMs?: readonly number[];
}

/** One per session. `check()` on every turn end; `noteOutput()` on streamed output; `destroy()` on teardown. */
export class CapacityRetry {
  private retryTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private gaveUp = false;

  constructor(private readonly deps: CapacityRetryDeps) {}

  private get delays(): readonly number[] {
    return this.deps.delaysMs ?? CAPACITY_RETRY_DELAYS_MS;
  }

  /** Streamed output: an error that ends a turn too fast to ever show it working gets looked at too. */
  noteOutput(cleanData: string): void {
    if (this.checkTimer || this.retryTimer || !CAPACITY_WORDS.test(cleanData)) return;
    this.checkTimer = setTimeout(() => { this.checkTimer = null; this.check(); }, CAPACITY_CHECK_DELAY_MS);
    this.checkTimer.unref?.();
  }

  /** Read the screen: arm the next retry when the last turn died at capacity, forget the streak when it did not. */
  check(): void {
    if (this.deps.isStopped() || this.deps.isWorking() || this.retryTimer) return;
    const line = capacityStallLine(this.deps.capture(), this.deps.glyph());
    if (!line) {
      // A turn ended some other way: the provider is back, or a person took over. The next stall starts afresh.
      this.attempts = 0;
      this.gaveUp = false;
      return;
    }
    if (this.attempts >= this.delays.length) {
      if (!this.gaveUp) {
        this.gaveUp = true;
        this.deps.log?.(`model still at capacity after ${this.attempts} retries; leaving the session for a person`);
        this.deps.onEvent?.({ kind: 'gave-up', attempts: this.attempts, line });
      }
      return;
    }
    const delayMs = this.delays[this.attempts];
    this.deps.log?.(`last turn ended at model capacity ("${line.slice(0, 80)}"); retry ${this.attempts + 1}/${this.delays.length} in ${Math.round(delayMs / 1000)}s`);
    this.deps.onEvent?.({ kind: 'scheduled', attempt: this.attempts + 1, delayMs, line });
    this.retryTimer = setTimeout(() => void this.fire(), delayMs);
    this.retryTimer.unref?.();
  }

  private async fire(): Promise<void> {
    this.retryTimer = null;
    if (this.deps.isStopped() || this.deps.isWorking()) return;
    // The screen decides again: anything typed or printed since the schedule means it is not ours to resume.
    if (!capacityStallLine(this.deps.capture(), this.deps.glyph())) { this.attempts = 0; return; }
    this.attempts++;
    const sent = await this.deps.send(CAPACITY_RETRY_PROMPT).catch(() => false);
    this.deps.log?.(`capacity retry ${this.attempts}/${this.delays.length}: ${sent ? 'sent' : 'not sent'} "${CAPACITY_RETRY_PROMPT}"`);
    if (sent) this.deps.onEvent?.({ kind: 'retried', attempt: this.attempts });
    // Not written (the composer was not empty after all): look again on the next turn end or capacity output.
  }

  destroy(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.retryTimer = null;
    this.checkTimer = null;
  }
}
