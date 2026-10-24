/**
 * @fileoverview Verify that a programmatically sent prompt actually LEFT the composer,
 * and press Enter again while it has not.
 *
 * Claude Code 2.1.277 (auto-installed 2026-09-18) takes typed text the moment its
 * composer paints but ignores Enter for the first 30 to 50 seconds after it, so the
 * `send-keys -l <text>` + `send-keys Enter` pair `TmuxManager.sendInput()` sends 50 ms
 * apart leaves the prompt sitting on the composer with `0 tokens`, and every caller
 * that then waits for the turn (send-and-wait, the agent skill, the maintainer bot,
 * cron, Ralph) burns its whole timeout on a turn that never started. Measured through
 * the input route on 2026-09-19: an Enter at 28 s stranded, one at 51 s submitted.
 *
 * The rule: after a write that carried a carriage return, read the pane on a short
 * schedule; while the LAST composer line (the CLI's own prompt glyph) still holds the
 * head of what was sent, send Enter again. An empty composer ends it, and so does a
 * composer holding anything else, because that text is the user's or the CLI's, never
 * ours. A pane with no composer line at all (a shell, a CLI whose glyph is not
 * declared, a direct-PTY session with no pane to read) does nothing: this runs for
 * EVERY programmatic sender, so a blind Enter here could confirm a dialog nobody asked
 * about. The composer is the last glyph line on purpose: Claude Code echoes a submitted
 * prompt with the same glyph higher up in the transcript, so only the last one says
 * whether the text was taken.
 *
 * Pure apart from the injected capture, send and log, so the schedule, the cap and
 * every stop condition are unit-tested with fake timers (test/session-submit-verifier.test.ts).
 */
import { stripAnsi } from './utils/index.js';

/**
 * When to look, counted from the write: 2 s catches the common case (taken) with one
 * capture, and the tail reaches 60 s, past twice the longest window measured. Enter is
 * re-sent at every check that still finds the prompt, so a 50 s window costs about
 * seven Enters and one capture each; a taken prompt costs one capture.
 */
export const SUBMIT_VERIFY_DELAYS_MS: readonly number[] = [
  2_000, 3_000, 5_000, 5_000, 5_000, 10_000, 10_000, 10_000, 10_000,
];

/** How many leading characters of the prompt have to match, whitespace removed. */
const PROMPT_HEAD_CHARS = 24;

/**
 * A long paste that the CLI folded into a placeholder instead of showing its text. Codex draws
 * `[Pasted Content 1801 chars]`, so the composer never starts with the prompt's head and the
 * check used to read it as somebody else's text and stop, leaving a room delivery unsent for
 * hours (2026-10-16). A placeholder counts as ours only when its character count is the length
 * of what we just typed (a few characters of slack for the line ending): a person's own paste
 * of another size is still left alone.
 */
const PASTE_PLACEHOLDER = /\[Pasted (?:Content|text)[^\]]*?(\d+) chars\]/gi;
const PASTE_SLACK_CHARS = 4;
/** After the last Enter of the schedule, how long to wait before the final look. */
const FINAL_LOOK_MS = 2_000;

/** Whether `composer` (one line, glyph removed) holds a paste placeholder the size of `prompt`. */
export function placeholderHoldsPrompt(composer: string, prompt: string): boolean {
  const length = prompt.length;
  let total = 0, count = 0;
  for (const m of composer.matchAll(PASTE_PLACEHOLDER)) {
    total += Number(m[1]); count++;
    if (Math.abs(Number(m[1]) - length) <= PASTE_SLACK_CHARS) return true;
  }
  return count > 1 && Math.abs(total - length) <= PASTE_SLACK_CHARS;
}

const compact = (s: string): string => s.replace(/\s+/g, '');

/**
 * Whether `prompt` is still sitting unsubmitted in the composer of `screen`.
 *
 * - `true`: the last `glyph` line holds the prompt's head.
 * - `false`: the composer is empty (the prompt was taken) or holds other text.
 * - `undefined`: no composer line at all; nothing can be said, so nothing is sent.
 *
 * Whitespace is removed on both sides before comparing, because the composer wraps a
 * long prompt onto indented continuation lines and Claude Code draws a no-break space
 * after the glyph; `\s` covers that one in JavaScript.
 */
export function promptStillInComposer(screen: string, prompt: string, glyph: string): boolean | undefined {
  if (!glyph) return undefined;
  const composerLines = stripAnsi(screen)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(glyph));
  if (composerLines.length === 0) return undefined;
  const line = composerLines[composerLines.length - 1].slice(glyph.length);
  const composer = compact(line);
  if (!composer) return false;
  const head = compact(prompt).slice(0, PROMPT_HEAD_CHARS);
  if (head.length > 0 && composer.startsWith(head)) return true;
  return placeholderHoldsPrompt(line, prompt);
}

/**
 * How a prompt ended, reported once per `arm`:
 * - `submitted`: a check found the composer without it (empty, or holding someone else's text).
 * - `stranded`: still in the composer after the whole schedule; a person has to look.
 * - `unverified`: there is no composer to read (no glyph, no pane), or a newer write replaced the
 *   check before it decided. Nothing can be said, so callers must not count it as seen.
 */
export type SubmitOutcome = 'submitted' | 'stranded' | 'unverified';

export interface SubmitVerifierDeps {
  /** The rendered pane, or null when there is none to read. */
  capture: () => string | null | undefined;
  /** Press Enter once. Failures are swallowed; the next check decides again. */
  sendEnter: () => Promise<unknown> | unknown;
  /** The CLI's composer glyph, resolved at check time (the registry can change). */
  glyph: () => string;
  log?: (message: string) => void;
  /** Test seam; production uses SUBMIT_VERIFY_DELAYS_MS. */
  delaysMs?: readonly number[];
}

/**
 * One per session. `arm(text)` starts the schedule for the prompt just sent and
 * cancels any earlier one: a newer write owns the composer now, and re-sending Enter
 * for an older prompt could submit the newer one early. `cancel()` is for teardown.
 */
export class SubmitVerifier {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private readonly deps: SubmitVerifierDeps) {}

  arm(text: string, onOutcome?: (outcome: SubmitOutcome) => void): void {
    this.cancel();
    const gen = this.generation;
    const pending = { onOutcome };
    this.pending = pending;
    const settle = (outcome: SubmitOutcome): void => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      try {
        pending.onOutcome?.(outcome);
      } catch {
        // A caller's bookkeeping must never stop the check.
      }
    };
    const delays = this.deps.delaysMs ?? SUBMIT_VERIFY_DELAYS_MS;
    let step = 0;
    let elapsed = 0;
    let resent = 0;

    const schedule = (): void => {
      if (step >= delays.length) {
        // The last check just pressed Enter: look once more before calling it stranded.
        this.timer = setTimeout(() => {
          this.timer = null;
          if (gen !== this.generation) return;
          const still = promptStillInComposer(this.deps.capture() ?? '', text, this.deps.glyph());
          if (still === true) {
            this.deps.log?.(`prompt still in the composer after ${Math.round(elapsed / 1000)}s; giving up, it needs a person`);
            settle('stranded');
          } else settle(still === false ? 'submitted' : 'unverified');
        }, FINAL_LOOK_MS);
        this.timer.unref?.();
        return;
      }
      const delay = delays[step++];
      elapsed += delay;
      this.timer = setTimeout(() => void check(), delay);
      this.timer.unref?.();
    };
    const check = async (): Promise<void> => {
      this.timer = null;
      if (gen !== this.generation) return;
      const screen = this.deps.capture();
      const still = promptStillInComposer(screen ?? '', text, this.deps.glyph());
      if (still === false) return settle('submitted');
      if (still === undefined) return settle('unverified');
      resent++;
      this.deps.log?.(
        `prompt still in the composer after ${Math.round(elapsed / 1000)}s, re-sending Enter (${resent}/${delays.length})`
      );
      try {
        await this.deps.sendEnter();
      } catch {
        // The next check re-reads the screen and decides again.
      }
      if (gen !== this.generation) return;
      schedule();
    };
    schedule();
  }

  /** The outcome callback of the check in flight; a newer arm or cancel settles it as unverified. */
  private pending: { onOutcome?: (outcome: SubmitOutcome) => void } | undefined;

  cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending?.onOutcome) {
      try {
        pending.onOutcome('unverified');
      } catch {
        // ignore
      }
    }
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
