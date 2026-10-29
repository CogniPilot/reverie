/**
 * Typing a line into an OpenCode pane without tripping its "!" shell-mode key.
 *
 * OpenCode's prompt treats a "!" keystroke as "enter shell mode" while the composer is empty. When a whole line is typed as one
 * burst of keys (`tmux send-keys -l`), the first "!" of the burst is taken as that key even though the box is no longer empty,
 * and the rest of the line, with its Enter, runs as a shell command. Pasted text never reaches the key binding.
 *
 * Three guards, all for OpenCode panes and only for text an agent or the chat delivery sends (a person's own typing is left alone):
 *  1. "!" becomes the fullwidth "！" (U+FF01): the same meaning to a reader, and not the ASCII key.
 *  2. Behind REVERIE_OPENCODE_PASTE=1 the line is sent as a bracketed paste (load-buffer, paste-buffer -p -d) instead of keys. OpenCode
 *     folds a long paste into a "[Pasted ~N lines]" chip unless its config sets `experimental.disable_paste_summary: true`, which the
 *     host must do first; so this is off by default (see docs/opencode-shell-mode.md).
 *  3. Before Enter, a pane whose footer says it is in shell mode gets Escape, which keeps the text and returns to normal mode.
 */
import { markTypedUnsent, submitAndConfirm, waitForPasteSettle, writeGateOpen, type SubmitSettleIo, type TurnSignals } from './submit-settle.js';

/** The fullwidth exclamation mark that stands in for "!". */
export const FULLWIDTH_BANG = '！';

/**
 * Make every ASCII "!" fullwidth. `keepLeading` leaves a "!" that opens the text: when a person types `!ls` into the box on
 * purpose, that first key is meant to start shell mode, and only the ones later in the line need the guard.
 */
export function guardShellKey(text: string, options: { keepLeading?: boolean } = {}): string {
  if (options.keepLeading && text.startsWith('!')) return `!${text.slice(1).replace(/!/g, FULLWIDTH_BANG)}`;
  return text.replace(/!/g, FULLWIDTH_BANG);
}

/** Does the bottom of a captured pane show OpenCode's shell-mode footer? */
export function footerShowsShellMode(capture: string | null | undefined): boolean {
  if (!capture) return false;
  const tail = capture.replace(/\s+$/, '').split('\n').slice(-8).join('\n');
  return /esc\s+exit\s+shell\s+mode/i.test(tail);
}

/** Bracketed-paste delivery is opt-in: it needs OpenCode's `experimental.disable_paste_summary` set by the host. */
export function pasteDeliveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.REVERIE_OPENCODE_PASTE === '1';
}

/** What typing needs from the multiplexer; injected so the sequence can be tested without tmux. */
export interface OpencodeTypingIo {
  /** Run one tmux command (arguments, not a shell string). `stdin` is given to the command. */
  tmux(args: string[], stdin?: string): Promise<void>;
  /** The pane's visible text, or null when unknown. */
  capture(): string | null;
  sleep(ms: number): Promise<void>;
  log?(message: string): void;
}

export interface OpencodeTypingOptions {
  target: string;
  /** Text without its Enter. */
  text: string;
  /** Press Enter after the text. */
  enter: boolean;
  paste: boolean;
  /** A tmux buffer name unique to this delivery. */
  buffer: string;
  /** The text is a person's: a leading "!" is theirs to mean (see guardShellKey). */
  person?: boolean;
  /** Check that a turn started after Enter and press Enter once more if not (src/submit-settle.ts). */
  confirm?: TurnSignals & { label?: string };
}

/** Delay between the paste and Enter (the TUI handles a paste asynchronously). */
export const PASTE_SETTLE_MS = 100;
/** Delay between the text and Enter on the key path (same as the generic path). */
export const KEYS_SETTLE_MS = 50;
/** After Escape, wait this long before looking at the footer or pressing Enter, so the two keys are never read as one chord. */
export const ESCAPE_SETTLE_MS = 120;
/** The footer is read up to this many times, this far apart: the TUI draws on its own frame and can lag the keys. */
export const FOOTER_POLLS = 3;
export const FOOTER_POLL_MS = 50;
/** Escapes sent at most; after that Enter is withheld rather than risk running the line in bash. */
export const MAX_ESCAPES = 2;

/** Does the footer show shell mode in any of a few reads taken a frame apart? */
async function shellModeShown(io: OpencodeTypingIo): Promise<boolean> {
  for (let i = 0; i < FOOTER_POLLS; i++) {
    if (footerShowsShellMode(io.capture())) return true;
    if (i < FOOTER_POLLS - 1) await io.sleep(FOOTER_POLL_MS);
  }
  return false;
}

/**
 * Type `opts.text` into an OpenCode pane and (with `enter`) submit it. Returns 'blocked' when the pane stayed in shell mode after
 * the Escapes: the text is left in the box and Enter is NOT pressed (it would run the line in bash); the submit verifier tries
 * again later.
 *
 * A gated write (submit-settle withWriteGate: an agent's input while a plan move may take the composer) is re-checked right
 * before the text, before each Escape and before Enter, and submitAndConfirm re-checks it before its retry. Closed before the
 * text: 'not-written', nothing typed. Closed after it: 'withheld', the text is left unsent and recorded as such.
 */
export async function typeIntoOpencode(io: OpencodeTypingIo, opts: OpencodeTypingOptions): Promise<'sent' | 'blocked' | 'not-written' | 'withheld'> {
  const text = guardShellKey(opts.text, { keepLeading: opts.person });
  if (!writeGateOpen()) return 'not-written';
  const withheld = (): 'withheld' => {
    markTypedUnsent();
    io.log?.(`${opts.confirm?.label ?? 'opencode'}: the write's gate closed after the text (a plan move took the composer): Enter withheld, text left unsent`);
    return 'withheld';
  };
  if (text) {
    if (opts.paste) {
      await io.tmux(['load-buffer', '-b', opts.buffer, '-'], text);
      await io.tmux(['paste-buffer', '-p', '-d', '-b', opts.buffer, '-t', opts.target]);
    } else {
      await io.tmux(['send-keys', '-t', opts.target, '-l', text]);
    }
  }
  if (!opts.enter) return 'sent';
  const enterIo: SubmitSettleIo = { ...io, sendEnter: () => io.tmux(['send-keys', '-t', opts.target, 'Enter']) };
  // A long line is a paste to OpenCode: Enter waits for it to settle, or it is folded into the paste chip.
  await waitForPasteSettle(enterIo, text.length, opts.paste ? PASTE_SETTLE_MS : KEYS_SETTLE_MS);
  // A person who typed a leading "!" meant shell mode: leave it be.
  if (!opts.person || !opts.text.startsWith('!')) {
    for (let escapes = 0; await shellModeShown(io); escapes++) {
      if (escapes >= MAX_ESCAPES) return 'blocked';
      if (!writeGateOpen()) return withheld();
      // Back to normal mode with the text kept; then, a beat later and only once the footer agrees, Enter.
      await io.tmux(['send-keys', '-t', opts.target, 'Escape']);
      await io.sleep(ESCAPE_SETTLE_MS);
    }
  }
  if (!writeGateOpen()) return withheld();
  if (opts.confirm && text) await submitAndConfirm(enterIo, text, opts.confirm, opts.confirm.label);
  else await enterIo.sendEnter();
  return 'sent';
}
