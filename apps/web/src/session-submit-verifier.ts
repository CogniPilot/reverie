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
 * schedule; only while the complete LAST composer (including wrapped rows and paste
 * chips) represents what was sent, send Enter again. Only an empty composer confirms
 * submission. Different or incomplete content stays unverified and is never submitted
 * for the user. A pane with no composer line at all (a shell, a CLI whose glyph is not
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

/**
 * A long paste that the CLI folded into a placeholder instead of showing its text. Codex draws
 * `[Pasted Content 1801 chars]`, so the composer never starts with the prompt's head and the
 * check used to read it as somebody else's text and stop, leaving a room delivery unsent for
 * hours (2026-10-16). All chips and visible text must account for the complete prompt;
 * matching one chip beside another draft does not establish ownership. An entirely opaque
 * chip additionally requires an observed empty composer before this write.
 */
const PASTE_PLACEHOLDER = /\[Pasted (?:Content|text)[^\]]*?(\d+) chars\]/gi;
const PASTE_SLACK_CHARS = 4;
/** After the last Enter of the schedule, how long to wait before the final look. */
const FINAL_LOOK_MS = 2_000;

/**
 * Codex draws an empty composer as `› ` and a dim placeholder (`Ask Codex to do anything` or one of its other hints). A plain
 * capture cannot tell that from typed text, so composer reads keep the pane's SGR codes (capturePaneText `escapes`) and a dim
 * run straight after the glyph is dropped. Typed text and paste chips are never dim (measured on codex-cli 0.163.0, 2026-10-29).
 */
// eslint-disable-next-line no-control-regex
const CODEX_DIM_PLACEHOLDER = /^((?:\x1b\[[0-9;]*m)*›(?:\x1b\[[0-9;]*m)* ?)\x1b\[2m[^\x1b\n]*\x1b\[(?:0|22)?m/gmu;

/** The complete last composer, including wrapped text, ending before the CLI's chrome. */
export function composerBody(screen: string, glyph: string): string | undefined {
  if (!glyph || screen.length > 1_048_576) return undefined;
  const lines = stripAnsi(glyph === '›' ? screen.replace(CODEX_DIM_PLACEHOLDER, '$1') : screen).split('\n');
  // Any model name, as the registry's codex modelDetect reads it: `GPT-6.1-Sol high · /…`, but also a custom provider's
  // `qwen3-coder:30b default · /…`. A GPT-only pattern never found a footer there, so such a composer never read as empty
  // and chat to the session waited forever.
  const codexFooter = /^[A-Za-z0-9][\w.:/@+-]{0,79}(?:\s+[\w()-]+)?\s+·\s+(?:\/|~\/)/u;
  const footers = glyph === '›' ? lines.flatMap((line, i) => codexFooter.test(line.trim()) ? [i] : []) : [];
  // Codex draft rows may contain blanks, rulers, box drawing and literal glyphs. Only
  // its actual model/path footer bounds the composer; absent/ambiguous chrome refuses.
  if (glyph === '›' && footers.length !== 1) return undefined;
  const end = glyph === '›' ? footers[0] : lines.length;
  let last = -1;
  let previous = -1;
  for (let i = 0; i < end; i++) {
    // Codex's real prompt is at column zero. An indented literal glyph is draft content.
    if ((glyph === '›' ? lines[i] : lines[i].trimStart()).startsWith(glyph)) {
      previous = last;
      last = i;
    }
  }
  if (last < 0) return undefined;
  // A column-zero glyph straight under another with no transcript bullet between may be a literal glyph inside a draft: refuse.
  // Only the last pair counts. Higher up, two user rows in a row are plain history: a message steered into a running turn is
  // echoed right under the one that started it (codex-cli 0.163.0), and refusing there left every mid-turn delivery unverified.
  if (glyph === '›' && previous >= 0 && !lines.slice(previous + 1, last).some(line => /^[•●✻]/u.test(line))) return undefined;
  const body = [lines[last].trimStart().slice(glyph.length).trimStart()];
  for (const line of lines.slice(last + 1, end)) {
    const text = line.trim();
    if (glyph !== '›' && (/^[─━═╭╮╰╯]/u.test(line) || /^⏵⏵/u.test(text))) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

export function composerIsEmpty(screen: string | null | undefined, glyph: string): boolean {
  return screen != null && composerBody(screen, glyph) === '';
}

/** Match every visible segment and every opaque span, in order; never just one matching chip. */
export function placeholderHoldsPrompt(composer: string, prompt: string, allowOpaque = false): boolean {
  return !!composer.match(PASTE_PLACEHOLDER) && renderedHoldsPrompt(composer, prompt, allowOpaque);
}

function renderedHoldsPrompt(composer: string, prompt: string, allowOpaque = false): boolean {
  const chips = [...composer.matchAll(PASTE_PLACEHOLDER)];
  if (chips.length > 64 || prompt.length > 131_072) return false;
  const literal = composer.replace(PASTE_PLACEHOLDER, '');
  // A count alone cannot distinguish a person's paste. Only a write observed from an empty
  // composer may use that evidence; mixed pastes additionally bind all their visible text.
  if (!literal.trim() && !allowOpaque) return false;
  const pieces: Array<string | number> = [];
  let offset = 0;
  for (const chip of chips) {
    pieces.push(composer.slice(offset, chip.index), Number(chip[1]));
    offset = chip.index! + chip[0].length;
  }
  pieces.push(composer.slice(offset));
  const match = (chars: string[]): boolean => {
    let positions = new Set([0]);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const next = new Set<number>();
      for (const start of positions) {
        if (typeof piece === 'number') {
          if (!Number.isSafeInteger(piece) || piece <= 0) continue;
          const end = start + piece;
          if (end <= chars.length) next.add(end);
          // Only an otherwise wholly opaque paste can include its terminal line ending.
          else if (!literal.trim() && allowOpaque && end - chars.length <= PASTE_SLACK_CHARS) next.add(chars.length);
        } else {
          let at = new Set([start]);
          const visible = Array.from(piece);
          for (let j = 0; j < visible.length; j++) {
            const char = visible[j];
            const after = new Set<number>();
            if (char === '\n') {
              // A rendered wrap can split a token or replace its one space. Only row
              // indentation is layout; spaces inside a visible row remain significant.
              while (j + 1 < visible.length && /[ \t]/u.test(visible[j + 1])) j++;
              for (const pos of at) { after.add(pos); if (chars[pos] === ' ') after.add(pos + 1); }
            } else for (const pos of at) if (chars[pos] === char) after.add(pos + 1);
            at = after;
            if (!at.size) break;
          }
          for (const pos of at) next.add(pos);
        }
      }
      positions = next;
      if (!positions.size) return false;
    }
    return positions.has(chars.length);
  };
  // Rust CLI counters use Unicode scalars; other CLIs report JavaScript UTF-16 length.
  return match(Array.from(prompt)) || match(prompt.split(''));
}

/**
 * Whether `prompt` is still sitting unsubmitted in the composer of `screen`.
 *
 * - `true`: the entire last composer represents this prompt.
 * - `false`: the composer is empty (the prompt was taken).
 * - `undefined`: missing, different or ambiguous composer; nothing is sent.
 *
 * Rendered row breaks and continuation indentation may be layout. Spaces within each
 * visible row remain significant; a changed token must never become an automatic Enter.
 */
export function promptStillInComposer(screen: string, prompt: string, glyph: string, allowOpaque = false): boolean | undefined {
  const body = composerBody(screen, glyph);
  if (body === undefined) return undefined;
  if (!body) return false;
  if (body.match(PASTE_PLACEHOLDER)) {
    return placeholderHoldsPrompt(body, prompt, allowOpaque) ? true : undefined;
  }
  return renderedHoldsPrompt(body, prompt) ? true : undefined;
}

/**
 * How a prompt ended, reported once per `arm`:
 * - `submitted`: a check found the composer empty.
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

  arm(text: string, onOutcome?: (outcome: SubmitOutcome) => void, fromEmptyComposer = false): void {
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
          const still = promptStillInComposer(this.deps.capture() ?? '', text, this.deps.glyph(), fromEmptyComposer);
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
      const still = promptStillInComposer(screen ?? '', text, this.deps.glyph(), fromEmptyComposer);
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
