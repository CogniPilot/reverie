/**
 * Submitting typed or pasted text in an agent CLI pane: let the paste settle, press Enter as its own keystroke, check that a
 * turn started, and press Enter once more if it did not.
 *
 * A long delivery reaches the CLI as one fast burst of keys (`send-keys -l`) or a bracketed paste. Codex and OpenCode fold such
 * a burst into a `[Pasted Content N chars]` chip and keep treating keys as part of the paste for a short window after the last
 * one; an Enter that lands inside that window (the old fixed 50 ms / 100 ms gap) becomes a newline in the paste, nothing
 * submits, and the next deliveries pile up in the composer. Short text never trips the burst detector, so it keeps the old gap.
 *
 * Pure apart from the injected IO, so the timing and the single retry are unit-tested with a fake mux
 * (test/submit-settle.test.ts).
 */
import { composerIsEmpty, promptStillInComposer } from './session-submit-verifier.js';
import { stripAnsi } from './utils/index.js';

/** Text up to this long keeps the old fixed gap before Enter: it is typed, not pasted, and must not be slowed. */
export const SHORT_TEXT_CHARS = 120;
/** The old gap between text and Enter on the key path. */
export const SHORT_SETTLE_MS = 50;
/** A long burst waits at least this long: past the paste-burst window CLIs keep open after the last key (Codex ~120 ms). */
export const SETTLE_MIN_MS = 150;
/** Extra wait per character of a long burst, so a big paste gets time to render. */
export const SETTLE_MS_PER_CHAR = 0.5;
/** Never wait longer than this for a paste to settle. */
export const SETTLE_MAX_MS = 2_000;
/** How often the pane is read while a long paste settles; two equal reads in a row mean it stopped changing. */
export const SETTLE_POLL_MS = 50;
/** After Enter, the pane is read this often, up to the window, for signs that a turn started. */
export const CONFIRM_POLL_MS = 100;
export const CONFIRM_WINDOW_MS = 1_000;

/** The longest wait before Enter for text of `length` characters (the floor applies to short text). */
export function settleBudgetMs(length: number, floorMs: number = SHORT_SETTLE_MS): number {
  if (length <= SHORT_TEXT_CHARS) return floorMs;
  return Math.max(floorMs, Math.min(SETTLE_MAX_MS, Math.round(SETTLE_MIN_MS + length * SETTLE_MS_PER_CHAR)));
}

export interface SubmitSettleIo {
  /** Press Enter once, as its own tmux command. */
  sendEnter(): Promise<unknown>;
  /** The pane's visible text, or null when it cannot be read. */
  capture(): string | null;
  sleep(ms: number): Promise<void>;
  log?(message: string): void;
}

/**
 * Wait until a just-typed text has settled. Short text waits the fixed `floorMs`. Long text waits at least SETTLE_MIN_MS, then
 * until two pane reads in a row agree, never past settleBudgetMs. Returns the time waited.
 */
export async function waitForPasteSettle(io: SubmitSettleIo, length: number, floorMs: number = SHORT_SETTLE_MS): Promise<number> {
  const budget = settleBudgetMs(length, floorMs);
  if (length <= SHORT_TEXT_CHARS) {
    await io.sleep(budget);
    return budget;
  }
  const first = Math.min(budget, Math.max(floorMs, SETTLE_MIN_MS));
  await io.sleep(first);
  let waited = first;
  let prev = io.capture();
  while (waited < budget) {
    const step = Math.min(SETTLE_POLL_MS, budget - waited);
    await io.sleep(step);
    waited += step;
    const cur = io.capture();
    if (cur !== null && cur === prev) break;
    prev = cur;
  }
  return waited;
}

export interface TurnSignals {
  /** The CLI's composer glyph (registry `workDetect.promptGlyph`); empty when it declares none. */
  glyph?: string;
  /** The CLI's busy line (registry `workDetect.workingLine`, a regex source); empty when it declares none. */
  workingLine?: string;
}

/**
 * Did a turn start for `text`? `true`: the session shows its busy line, or the composer that held the text before Enter no
 * longer does. `false`: the composer still holds it, or the CLI has a busy line that has not shown. `undefined`: nothing on
 * screen can say (no pane, no glyph, no busy line), so no Enter is re-sent.
 */
export function turnStarted(screen: string | null, text: string, signals: TurnSignals, heldBefore: boolean, fromEmptyComposer = false): boolean | undefined {
  if (screen === null) return undefined;
  const still = signals.glyph ? promptStillInComposer(screen, text, signals.glyph, fromEmptyComposer) : undefined;
  // A historical busy line is not evidence that the current composer was submitted.
  if (still === true) return false;
  if (signals.glyph === '›' && still === undefined) return undefined;
  if (signals.workingLine) {
    try {
      if (new RegExp(signals.workingLine).test(stripAnsi(screen))) return true;
    } catch {
      // A bad pattern from ~/.reverie/clis.json is no evidence either way.
    }
  }
  if (still === false && heldBefore) return true;
  return signals.workingLine ? false : undefined;
}

export type SubmitOutcome = 'started' | 'started-after-retry' | 'not-started' | 'unverified' | 'not-written';

async function watchForTurn(io: SubmitSettleIo, text: string, signals: TurnSignals, heldBefore: boolean, fromEmptyComposer: boolean): Promise<boolean | undefined> {
  let seen: boolean | undefined;
  for (let waited = 0; waited < CONFIRM_WINDOW_MS; waited += CONFIRM_POLL_MS) {
    await io.sleep(CONFIRM_POLL_MS);
    seen = turnStarted(io.capture(), text, signals, heldBefore, fromEmptyComposer);
    if (seen !== false) return seen;
  }
  return seen;
}

/**
 * Press Enter for `text` that is already in the composer and has settled, then confirm a turn started; when the pane says it
 * did not, press Enter exactly once more. Logs and returns the outcome.
 */
export async function submitAndConfirm(io: SubmitSettleIo, text: string, signals: TurnSignals, label = 'pane', fromEmptyComposer = false, requireOwnership = false): Promise<SubmitOutcome> {
  const before = io.capture();
  const heldBefore = !!signals.glyph && before !== null && promptStillInComposer(before, text, signals.glyph, fromEmptyComposer) === true;
  if (requireOwnership && signals.glyph === '›' && !heldBefore) return 'unverified';
  await io.sendEnter();
  let outcome: SubmitOutcome;
  const first = await watchForTurn(io, text, signals, heldBefore, fromEmptyComposer);
  if (first === true) outcome = 'started';
  else if (first === undefined) outcome = 'unverified';
  else {
    // A user can edit while the confirm window expires. Recheck complete ownership before retry.
    if (signals.glyph === '›' && promptStillInComposer(io.capture() ?? '', text, signals.glyph, fromEmptyComposer) !== true) return 'unverified';
    io.log?.(`${label}: no turn started ${CONFIRM_WINDOW_MS} ms after Enter (${text.length} chars), pressing Enter once more`);
    await io.sendEnter();
    outcome = (await watchForTurn(io, text, signals, heldBefore, fromEmptyComposer)) === true ? 'started-after-retry' : 'not-started';
  }
  io.log?.(`${label}: submit ${outcome} (${text.length} chars)`);
  return outcome;
}

/** The generic (non-OpenCode) delivery: type the text, let it settle, then Enter as a separate keystroke, confirmed. */
export async function typeAndSubmit(
  io: SubmitSettleIo & { typeText(text: string): Promise<unknown> },
  text: string,
  signals: TurnSignals,
  label?: string,
  requireEmptyComposer = false
): Promise<SubmitOutcome> {
  const fromEmptyComposer = !!signals.glyph && composerIsEmpty(io.capture(), signals.glyph);
  if (requireEmptyComposer && signals.glyph === '›' && !fromEmptyComposer) return 'not-written';
  await io.typeText(text);
  await waitForPasteSettle(io, text.length);
  return submitAndConfirm(io, text, signals, label, fromEmptyComposer, requireEmptyComposer);
}
