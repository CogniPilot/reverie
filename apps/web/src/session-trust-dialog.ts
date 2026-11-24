/**
 * @fileoverview Recognizing Claude Code's workspace-trust dialog on screen, and
 * working out which keystroke answers it.
 *
 * Claude asks once per directory before it will read or edit anything. The
 * layout has changed under us at least twice; both of these are live shapes:
 *
 *   Quick safety check: Is this a project you created or one you trust? ...     (<= 2.1.220)
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *   Enter to confirm · Esc to cancel
 *
 *   Quick safety check: Is this a project you created or one you trust? ...     (2.1.252)
 *   Security guide
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 *
 * Reverie sessions run permission-skipping or classifier-guarded modes, so the
 * answer is always yes, and a session parked on this dialog is simply stuck.
 *
 * ⚠️ **Never press Enter without reading the selection.** The options are now
 * unnumbered, REVERSED, and the highlighted default is "No, exit" — so the blind
 * `\r` that answered the old layout picks *exit* on the new one and the pane
 * dies (`Pane is dead (status 1)`) seconds after the session starts, which is
 * exactly what a fresh case did on Claude Code 2.1.252. `trustDialogNextKey()`
 * reads the `❯` marker instead and moves the cursor onto the trust option before
 * it confirms anything.
 *
 * **Why the text has to be compacted.** tmux repaints a row by writing each word
 * and then a cursor-forward (`\x1b[C`) instead of a space, and Ink colours each
 * word separately, so the wire carries `I\x1b[Ctrust\x1b[Cthis\x1b[Cfolder`.
 * Stripping the escapes leaves `Itrustthisfolder`: the spaces are not there to
 * strip, they were never sent. A plain `includes('trust this folder')` therefore
 * never matched a single chunk, which is why the auto-accept had been silently
 * dead. Removing ALL whitespace instead is what survives both that repaint style
 * and the spaced full-screen redraw.
 *
 * **Why two markers are required.** Answering means pressing Enter, so a false
 * positive types into a live session. One phrase is not enough: an agent's own
 * transcript can quote it (this file does). Matching a trust phrase AND the
 * dialog's confirm affordance is the cheap way to require the actual widget, and
 * the caller adds the real guard by only looking during session startup.
 *
 * **This dialog is one of several.** A config directory Claude has never seen
 * shows a theme chooser and security notes before it and a Bypass Permissions
 * warning after it. The trust dialog's phrases, its options, the matcher and the
 * startup window all live in `session-first-run-screens.ts`, which treats it as
 * one row of a table; this module is the view onto that row, kept so the
 * dialog's history and its own tests stay in one place.
 */

import {
  WORKSPACE_TRUST_SCREEN,
  chooseNextKey,
  hasScreenMarkers,
  SCREEN_KEY_CONFIRM,
  SCREEN_KEY_DOWN,
  SCREEN_KEY_UP,
  FIRST_RUN_MAX_ATTEMPTS,
  FIRST_RUN_RETRY_MS,
  FIRST_RUN_SCAN_BYTES,
  FIRST_RUN_WINDOW_MS,
} from './session-first-run-screens.js';

export { compactScreenText } from './session-first-run-screens.js';

/** Move the selection one row down / up. Literal, so `send-keys -l` carries them. */
export const TRUST_KEY_DOWN = SCREEN_KEY_DOWN;
export const TRUST_KEY_UP = SCREEN_KEY_UP;

/** Confirm the highlighted option. */
export const TRUST_KEY_CONFIRM = SCREEN_KEY_CONFIRM;

/**
 * True when this text is the trust dialog rather than something merely talking
 * about it. Feed the RENDERED SCREEN where possible: the session's terminal
 * buffer is append-only, so the dialog stays in its tail long after it is gone.
 */
export function isTrustDialogScreen(text: string): boolean {
  return hasScreenMarkers(text, WORKSPACE_TRUST_SCREEN);
}

/**
 * The single keystroke that moves this dialog one step closer to "yes", or null
 * when the screen does not show clearly enough to touch.
 *
 * One step per call on purpose: the caller re-reads the screen between
 * keystrokes, so a moved cursor is CONFIRMED before Enter is pressed rather than
 * assumed. Firing arrow+Enter together would re-create the failure this exists
 * to prevent whenever the arrow is dropped (Ink drops keystrokes while it is
 * still mounting a widget) — the Enter would then land on "No, exit".
 *
 * Returning null is the safe answer, not a failure: an unreadable frame means
 * wait for the next repaint, and a layout whose options this cannot name means
 * leave the dialog to the human. The caller's startup window bounds the waiting.
 */
export function trustDialogNextKey(text: string): string | null {
  return WORKSPACE_TRUST_SCREEN.answer.kind === 'choose' ? chooseNextKey(text, WORKSPACE_TRUST_SCREEN.answer) : null;
}

/** How long after the pane starts the dialog is still plausible (see `FirstRunScan`). */
export const TRUST_DIALOG_WINDOW_MS = FIRST_RUN_WINDOW_MS;

/** Minimum gap between two keystrokes, and between two screen reads. */
export const TRUST_DIALOG_RETRY_MS = FIRST_RUN_RETRY_MS;

/** Keystrokes at this dialog before giving up and leaving it to the user. */
export const TRUST_DIALOG_MAX_ATTEMPTS = FIRST_RUN_MAX_ATTEMPTS;

/** How much of the append-only terminal buffer a direct-PTY session reads. */
export const TRUST_DIALOG_SCAN_BYTES = FIRST_RUN_SCAN_BYTES;
