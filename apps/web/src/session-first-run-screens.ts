/**
 * @fileoverview The screens a provider CLI shows before its composer on a config
 * directory it has never seen, which of them the office answers, and the one
 * keystroke that answers each. Pure: no IO, no timers.
 *
 * A plan move launches the CLI against a fresh per-move config directory, so
 * Claude Code walks through its whole first run, one screen after another:
 *
 *   Choose the text style that looks best with your terminal      (theme chooser)
 *   ❯ ✔ Dark mode
 *
 *   Security notes: ... Press Enter to continue…                  (security notes)
 *
 *   Quick safety check: Is this a project you created or one you trust?
 *   ❯ No, exit                                                    (workspace trust)
 *     Yes, I trust this folder
 *
 *   WARNING: Claude Code running in Bypass Permissions mode
 *   ❯ No, exit                                                    (bypass warning)
 *     Yes, I accept
 *
 * Nothing answered the first two, the workspace-trust scan ran out its startup
 * window behind them, and the move ended in `recovery-required` with the owner
 * clicking four screens by hand. The office launched that session, in that mode,
 * on the owner's instruction, so each of these has exactly one answer.
 *
 * The screens are DATA ({@link PROVIDER_SCREENS}); add a row to teach the office
 * another one. A row is either answered or only reported:
 *
 * - `choose`: a menu. Enter is pressed only once `❯` sits on an option the row
 *   accepts; while it sits on one the row declines ("No, exit") the office sends
 *   an arrow instead, read from this frame, and waits for the next frame.
 * - `continue`: a "press Enter" page with no menu. Enter is pressed only when
 *   the prompt is the last thing on the screen.
 * - `report`: a sign-in or paste-code screen. NEVER typed into: the office holds
 *   no key that answers one, and a credential is never typed by the office. It is
 *   recognised so the office can put the plan's sign-in back and start the agent
 *   again (the supervisor's steps; nothing here does that).
 *
 * A screen that asks for a decision is never a `report` row. It gets the one
 * standing answer that spends no money, buys or enables no usage credits and
 * widens no access, as a `choose` row: the API-key question is answered
 * "No (recommended)", so a key found in the environment is never billed.
 *
 * A session that stays on a screen is restarted by the supervisor, and a restart
 * discards whatever the pane was doing. So a reading also says HOW the office
 * knows the screen is up ({@link StartupScreenStatus.shown}): by its live widget
 * on this frame, by a launch of this office that has not reached its composer
 * since, or only by its words. Words alone are what a transcript that quotes
 * the screen shows too, and nothing is ever restarted for them.
 *
 * The discipline is the workspace-trust dialog's (`session-trust-dialog.ts`,
 * which is now a view onto one row of this table), made to hold for every row:
 *
 * ⚠️ **Match the compacted screen, never the stream.** tmux repaints a row as
 * words joined by cursor-forwards, so the spaces were never sent;
 * {@link compactScreenText} removes all whitespace on both sides of the match.
 *
 * ⚠️ **Two independent markers per screen.** One phrase can be quoted by an
 * agent's transcript (this file quotes all of them).
 *
 * ⚠️ **The screen must be the live widget, not text about it.** A `choose` row
 * needs the LAST `❯` on the screen to sit on one of its own options, so the
 * composer's `❯` under a transcript that quotes the dialog ends the match; a
 * `continue` row needs its prompt at the very end of the screen; and a screen
 * that shows the CLI's composer mark is no first-run screen at all.
 *
 * ⚠️ **One key per frame.** The caller re-reads the screen between keystrokes,
 * so a moved cursor is confirmed before Enter is pressed. Ink drops keys while a
 * widget mounts; arrow+Enter in one burst would land the Enter on "No, exit".
 *
 * {@link FirstRunScan} is the time and attempt bookkeeping around the matcher.
 */

import { stripAnsi } from './utils/index.js';

/** Ink's selection marker. The only marked row while a menu is up. */
export const SELECTION_MARK = '❯';

/** Move the selection one row down / up. Literal, so `send-keys -l` carries them. */
export const SCREEN_KEY_DOWN = '\x1b[B';
export const SCREEN_KEY_UP = '\x1b[A';

/** Confirm the highlighted option, or continue past a notice. */
export const SCREEN_KEY_CONFIRM = '\r';

/**
 * Charset-select sequences (`ESC ( B`), which tmux emits around styled runs and
 * `stripAnsi` does not cover. Left in, they would land inside a phrase as a
 * literal `(B` and break the match.
 */
// eslint-disable-next-line no-control-regex
const CHARSET_SELECT = /\x1b[()][AB0]/g;

/**
 * What may stand between `❯` and an option's text: the `1.` of a numbered
 * layout and the check mark Claude puts on the current setting.
 */
const OPTION_PREFIX = /^(?:\d+\.|[✔✓])+/;

/** What may follow a `continue` prompt at the end of the screen: its own ellipsis. */
const CONTINUE_TAIL = /^[.…]{0,3}$/;

/**
 * Normalize a screen or PTY chunk for phrase matching: escapes dropped, every
 * whitespace run removed, lowercased.
 */
export function compactScreenText(text: string): string {
  return stripAnsi(text).replace(CHARSET_SELECT, '').replace(/\s+/g, '').toLowerCase();
}

/** How a recognised screen is dealt with. Every phrase is compacted and lowercased. */
export type ProviderScreenAnswer =
  | {
      /** A menu: Enter once `❯` is on an `accept` option, an arrow while it is on a `decline` one. */
      readonly kind: 'choose';
      readonly accept: readonly string[];
      readonly decline: readonly string[];
    }
  | {
      /** A notice: Enter, only while `anchor` is the last thing on the screen. */
      readonly kind: 'continue';
      readonly anchor: string;
    }
  | {
      /** A credential prompt: named, never answered. */
      readonly kind: 'report';
      readonly reason: 'credential';
      /** What shows that the screen itself is up, since no key is ever read from it. */
      readonly live: ProviderScreenLiveness;
    };

/**
 * The live-widget proof of a screen the office never answers, in the two forms the answered rows use:
 * the LAST `❯` on the screen sits on one of the screen's own options, or its prompt is the last thing on it.
 */
export type ProviderScreenLiveness =
  | { readonly kind: 'selection'; readonly options: readonly string[] }
  | { readonly kind: 'prompt'; readonly anchor: string };

export interface ProviderScreenPattern {
  /** Stable key for the attempt budget and logs. */
  readonly id: string;
  /** What to call the screen when talking to the owner, e.g. "Claude's sign-in screen". */
  readonly label: string;
  /** Two groups of phrases; the screen must carry at least one phrase from EACH. */
  readonly markers: readonly [readonly string[], readonly string[]];
  readonly answer: ProviderScreenAnswer;
}

/** The workspace-trust dialog. Exported because `session-trust-dialog.ts` is a view onto it. */
export const WORKSPACE_TRUST_SCREEN: ProviderScreenPattern = {
  id: 'claude-workspace-trust',
  label: "Claude's workspace trust question",
  markers: [
    [
      'trustthisfolder', // 2.x: "1. Yes, I trust this folder"
      'trustthefiles', // older: "Do you trust the files in this folder?"
      'oneyoutrust', // 2.x question: "a project you created or one you trust?"
    ],
    // The dialog's own affordances. Prose that quotes the question will not have these.
    ['entertoconfirm', 'esctocancel', '2.no,exit'],
  ],
  // "No, exit" is the highlighted DEFAULT since 2.1.252.
  answer: { kind: 'choose', accept: ['yes,itrustthisfolder'], decline: ['no,exit'] },
};

/**
 * Every screen the office knows. Order does not decide a match: when more than
 * one row fits (an append-only buffer still holding an earlier screen), the row
 * whose markers sit latest in the text wins.
 */
export const PROVIDER_SCREENS: readonly ProviderScreenPattern[] = [
  {
    id: 'claude-theme',
    label: "Claude's theme chooser",
    markers: [['choosethetextstylethatlooksbestwithyourterminal'], ['darkmode', 'lightmode']],
    // Any highlighted theme will do. The preselected one was the dark default; since 2.1.326 it is a new first
    // option, "Auto (match terminal)". Without it in this list the office named the screen and never answered it,
    // and a rebuilt laptop sat at the chooser (measured 2026-11-24).
    answer: { kind: 'choose', accept: ['auto(matchterminal)', 'darkmode', 'lightmode'], decline: [] },
  },
  {
    id: 'claude-security-notes',
    label: "Claude's security notes",
    markers: [['securitynotes:'], ['pressentertocontinue']],
    answer: { kind: 'continue', anchor: 'pressentertocontinue' },
  },
  WORKSPACE_TRUST_SCREEN,
  {
    id: 'claude-bypass-permissions',
    label: "Claude's Bypass Permissions warning",
    markers: [['bypasspermissionsmode'], ['yes,iaccept']],
    answer: { kind: 'choose', accept: ['yes,iaccept'], decline: ['no,exit'] },
  },
  {
    // A decision with a standing answer. "Yes" would bill the key found in the environment for every request, so
    // the office only ever confirms "No (recommended)", the option Claude highlights by default, and steers back
    // onto it from "Yes". An employee whose plan is then not signed in reaches the sign-in screen below.
    id: 'claude-api-key',
    label: "Claude's API key question",
    markers: [['doyouwanttousethisapikey'], ['no(recommended)', 'customapikey']],
    answer: { kind: 'choose', accept: ['no(recommended)'], decline: ['yes'] },
  },
  // ── Reported, never answered ────────────────────────────────────────────────
  {
    id: 'claude-sign-in',
    label: "Claude's sign-in screen",
    markers: [['selectloginmethod'], ['claudeaccountwithsubscription', 'anthropicconsoleaccount']],
    answer: {
      kind: 'report',
      reason: 'credential',
      live: { kind: 'selection', options: ['claudeaccountwithsubscription', 'anthropicconsoleaccount'] },
    },
  },
  {
    id: 'claude-sign-in-code',
    label: "Claude's sign-in screen",
    markers: [['pastecodehere'], ['signin', 'login', 'browser']],
    // An empty prompt. Once somebody has typed at it, a person is signing in and the screen is theirs.
    answer: { kind: 'report', reason: 'credential', live: { kind: 'prompt', anchor: 'pastecodehereifprompted>' } },
  },
  {
    id: 'codex-sign-in',
    label: "Codex's sign-in screen",
    markers: [['welcometocodex'], ['signinwithchatgpt']],
    answer: { kind: 'report', reason: 'credential', live: { kind: 'prompt', anchor: 'pressentertocontinue' } },
  },
];

/** A recognised screen and the single keystroke that moves it forward, if the office answers it. */
export interface ProviderScreenReading {
  readonly screen: ProviderScreenPattern;
  /** Null for a `report` screen: nothing is ever typed at it. */
  readonly key: string | null;
  /**
   * The frame shows the screen's own widget: `❯` on one of its options, or its prompt last on the screen. False
   * when only its words are there, which a conversation that quotes the screen shows as well.
   */
  readonly live: boolean;
}

export interface ProviderScreenReadOptions {
  /**
   * The CLI's composer mark (`capabilities.composerReadyMark`). A screen that
   * shows it is at its composer, so whatever else it says is transcript.
   */
  readonly composerMark?: string;
}

function lastIndexOfAny(compact: string, phrases: readonly string[]): number {
  let last = -1;
  for (const phrase of phrases) last = Math.max(last, compact.lastIndexOf(phrase));
  return last;
}

/** Where a row's markers put it in the text, or -1 when either group is missing. */
function markerPosition(compact: string, pattern: ProviderScreenPattern): number {
  const first = lastIndexOfAny(compact, pattern.markers[0]);
  const second = lastIndexOfAny(compact, pattern.markers[1]);
  return first < 0 || second < 0 ? -1 : Math.min(first, second);
}

/**
 * True when the text carries both of a row's markers. This is the cheap half of
 * a match: it says the words are present, not that the widget is live.
 */
export function hasScreenMarkers(text: string, pattern: ProviderScreenPattern): boolean {
  return markerPosition(compactScreenText(text), pattern) >= 0;
}

/**
 * The keystroke that moves a menu one step closer to an accepted option, or null
 * when this text does not show clearly enough to touch.
 *
 * The LAST `❯` decides. A pane capture holds one frame and so one marker, while
 * the direct-PTY fallback reads an append-only buffer where every repaint since
 * launch is still present: there the freshest frame is the one at the end. And a
 * `❯` that is not on one of this menu's options (a composer under a transcript
 * that quotes the menu) means the menu is not what is on screen.
 *
 * Which way the accepted option lies is read from THIS frame. The trust dialog
 * has put it both above and below "No, exit"; the order flipping again costs a
 * repaint, not a killed session.
 */
export function chooseNextKey(text: string, answer: ProviderScreenAnswer & { kind: 'choose' }): string | null {
  return chooseNextKeyCompact(compactScreenText(text), answer);
}

function chooseNextKeyCompact(compact: string, answer: ProviderScreenAnswer & { kind: 'choose' }): string | null {
  const at = compact.lastIndexOf(SELECTION_MARK);
  if (at < 0) return null; // marker missing: wait for the next repaint
  const selected = compact.slice(at + SELECTION_MARK.length).replace(OPTION_PREFIX, '');
  if (answer.accept.some((option) => selected.startsWith(option))) return SCREEN_KEY_CONFIRM;
  if (!answer.decline.some((option) => selected.startsWith(option))) return null; // not on an option we can name
  if (answer.accept.some((option) => compact.includes(option, at))) return SCREEN_KEY_DOWN;
  if (answer.accept.some((option) => compact.lastIndexOf(option, at) >= 0)) return SCREEN_KEY_UP;
  return null; // nothing to steer onto
}

function continueKeyCompact(compact: string, anchor: string): string | null {
  const at = compact.lastIndexOf(anchor);
  return at >= 0 && CONTINUE_TAIL.test(compact.slice(at + anchor.length)) ? SCREEN_KEY_CONFIRM : null;
}

/** Whether the LAST `❯` on the screen sits on one of these options. */
function selectionOn(compact: string, options: readonly string[]): boolean {
  const at = compact.lastIndexOf(SELECTION_MARK);
  if (at < 0) return false;
  const selected = compact.slice(at + SELECTION_MARK.length).replace(OPTION_PREFIX, '');
  return options.some((option) => selected.startsWith(option));
}

/** Whether the frame shows this row's own widget, by the row's own options or prompt. Never a reason to type. */
function screenLive(compact: string, screen: ProviderScreenPattern): boolean {
  const answer = screen.answer;
  if (answer.kind === 'choose') return selectionOn(compact, [...answer.accept, ...answer.decline]);
  if (answer.kind === 'continue') return continueKeyCompact(compact, answer.anchor) !== null;
  return answer.live.kind === 'selection'
    ? selectionOn(compact, answer.live.options)
    : continueKeyCompact(compact, answer.live.anchor) !== null;
}

function composerVisible(compact: string, composerMark: string | undefined): boolean {
  const mark = composerMark ? compactScreenText(composerMark) : '';
  // A mark that is just a glyph (one CLI's is `❯` itself) cannot tell a composer from a menu.
  return mark.length >= 3 && compact.includes(mark);
}

/**
 * Whether this text shows the CLI's composer. The scan ends for good at the
 * first sighting: from then on the pane is a conversation.
 */
export function showsComposer(text: string, composerMark: string | undefined): boolean {
  return composerVisible(compactScreenText(text), composerMark);
}

/**
 * The known screen this text shows, and the one key that answers it.
 *
 * Feed the RENDERED SCREEN where possible. Returns null when no row fits, when a
 * row's words are present but its widget is not live (see the file comment), or
 * when the composer is on screen.
 *
 * Returning null is the safe answer, not a failure: an unreadable frame means
 * wait for the next repaint, and a layout this cannot read means leave the
 * screen to the human.
 */
export function readProviderScreen(
  text: string,
  options: ProviderScreenReadOptions = {}
): ProviderScreenReading | null {
  const compact = compactScreenText(text);
  if (composerVisible(compact, options.composerMark)) return null;
  let best: ProviderScreenReading | null = null;
  let bestAt = -1;
  for (const screen of PROVIDER_SCREENS) {
    const at = markerPosition(compact, screen);
    if (at < 0 || at <= bestAt) continue;
    const answer = screen.answer;
    let key: string | null = null;
    if (answer.kind === 'choose') key = chooseNextKeyCompact(compact, answer);
    else if (answer.kind === 'continue') key = continueKeyCompact(compact, answer.anchor);
    // An answerable row with no key is words about the screen, or a frame still painting.
    if (answer.kind !== 'report' && key === null) continue;
    best = { screen, key, live: screenLive(compact, screen) };
    bestAt = at;
  }
  return best;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/**
 * The known screen a session that is short of its composer is showing, for
 * saying where it is stuck. NEVER a reason to type: `key` is only set when
 * {@link readProviderScreen} itself would answer the frame.
 *
 * Looser than the matcher on purpose. A screen whose words are there but whose
 * widget this cannot read (Claude redrew the menu, the highlight sits on an
 * option the table does not name) is exactly the one the office fails to answer,
 * and "stuck at Claude's theme chooser" is what the owner needs to hear then.
 * The cost of naming on words alone is a wrong label, never a keystroke.
 */
export function nameProviderScreen(
  text: string,
  options: ProviderScreenReadOptions = {}
): ProviderScreenReading | null {
  const live = readProviderScreen(text, options);
  if (live) return live;
  const compact = compactScreenText(text);
  if (composerVisible(compact, options.composerMark)) return null;
  let best: ProviderScreenReading | null = null;
  let bestAt = -1;
  for (const screen of PROVIDER_SCREENS) {
    const at = markerPosition(compact, screen);
    if (at > bestAt) {
      // A menu whose highlight sits on a declined option with nothing to steer onto is still that menu.
      best = { screen, key: null, live: screenLive(compact, screen) };
      bestAt = at;
    }
  }
  return best;
}

/**
 * How the office knows a named screen is really what the pane shows:
 * - `widget`: this frame shows the screen's own live widget.
 * - `launch`: this frame carries only its words (or is a screen the table does not know), on a pane this office
 *   launched that has not shown its composer since, and that shows no composer now.
 * - `words`: only its words are there. A conversation that quotes the screen reads the same, so this names a
 *   screen and proves nothing.
 */
export type StartupScreenProof = 'widget' | 'launch' | 'words';

/** Why a session has not reached its composer. */
export interface StartupScreenStatus {
  readonly id: string;
  readonly label: string;
  /**
   * `first-run`: one the office answers. `credential`: a sign-in, which it never types into. `decision` is no
   * longer produced, because every decision row has a standing answer; the value stays for the sentence of a plan
   * move that was held before that.
   */
  readonly kind: 'first-run' | 'credential' | 'decision';
  /** True while the office is still working through it; false once it has given up or never would. */
  readonly answering: boolean;
  readonly shown: StartupScreenProof;
}

export function startupScreenStatus(
  reading: ProviderScreenReading,
  answering: boolean,
  /** The pane was launched by this office and has not shown its composer since, nor does it now. */
  shortOfComposer = false
): StartupScreenStatus {
  const answer = reading.screen.answer;
  return {
    id: reading.screen.id,
    label: reading.screen.label,
    kind: answer.kind === 'report' ? answer.reason : 'first-run',
    answering: answer.kind !== 'report' && answering,
    shown: reading.live ? 'widget' : shortOfComposer ? 'launch' : 'words',
  };
}

/** A row that begins with a rule: the line Claude draws above and below its composer. */
const RULE_ROW = /^[─━═]{8}/;

/**
 * Whether the frame shows a composer by its shape: the last row that starts with the selection glyph has a rule row
 * under it. A menu's highlighted option has its other options under it instead. A second, independent sign of a
 * conversation beside the composer mark, which a footer can drop (`· 1 shell · ↓ to manage` carries no
 * `shift+tab`). Only ever a reason NOT to act.
 */
export function showsComposerRow(text: string): boolean {
  const rows = stripAnsi(text)
    .replace(CHARSET_SELECT, '')
    .split('\n')
    .map((row) => row.trim());
  let last = -1;
  rows.forEach((row, index) => {
    if (row.startsWith(SELECTION_MARK)) last = index;
  });
  return last >= 0 && rows.slice(last + 1).some((row) => RULE_ROW.test(row));
}

/** The status of a pane that is short of its composer on a screen no row of the table names. */
export const UNKNOWN_STARTUP_SCREEN: StartupScreenStatus = Object.freeze({
  id: 'unknown-startup-screen',
  label: 'a start-up screen the office does not know',
  kind: 'first-run',
  answering: false,
  shown: 'launch',
});

/** What a session's own scan says about its launch, for {@link readStartupScreen}. */
export interface StartupScanView {
  readonly active: boolean;
  readonly endReason: FirstRunScanEnd | null;
  /** The pane was launched by this office and has not been seen at its composer since. */
  readonly shortOfComposer: boolean;
  answering(screenId: string, now: number): boolean;
}

/**
 * The start-up screen a pane is parked on, with how the office knows.
 *
 * A screen the table names is returned on its words, as {@link nameProviderScreen} names it, with the proof beside
 * it. A screen the table does NOT name is returned only on positive evidence that the pane never left its start-up:
 * this office launched it, its scan closed (the start-up window ran out, or a screen would not answer) without one
 * sight of the composer, the CLI has a composer mark the scan could have seen, and the frame shows text and no
 * composer. Anything less reads null, which is what a conversation reads.
 */
export function readStartupScreen(
  text: string,
  scan: StartupScanView,
  now: number,
  options: ProviderScreenReadOptions = {}
): StartupScreenStatus | null {
  const reading = nameProviderScreen(text, options);
  const shortOfComposer = scan.shortOfComposer && !showsComposerRow(text);
  if (reading) return startupScreenStatus(reading, scan.answering(reading.screen.id, now), shortOfComposer);
  // Still open: the pane may only be slow. Never ended: the session is going away.
  if (!shortOfComposer || scan.active || scan.endReason === null) return null;
  const compact = compactScreenText(text);
  const mark = options.composerMark ? compactScreenText(options.composerMark) : '';
  // Without a usable mark the scan could never have seen a composer, so its silence about one says nothing.
  if (mark.length < 3 || compact === '' || compact.includes(mark)) return null;
  return UNKNOWN_STARTUP_SCREEN;
}

const SHAPE_ROWS = 16;
const SHAPE_ROW_LENGTH = 100;

/**
 * The shape of a screen for the log, so a row can be written for one the table does not answer: its last rows, each
 * shortened, with everything that could be a secret or a private detail replaced. These screens are provider
 * chrome, but one of them prints part of an API key and another the workspace path, so links, addresses, paths and
 * every long run of letters and digits are removed before anything is logged.
 */
export function screenShape(text: string): string {
  const rows = stripAnsi(text)
    .replace(CHARSET_SELECT, '')
    .split('\n')
    // eslint-disable-next-line no-control-regex
    .map((row) => row.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim())
    .filter((row) => row !== '')
    .slice(-SHAPE_ROWS)
    .map((row) =>
      row
        .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<link>')
        .replace(/\S+@\S+\.\S+/g, '<address>')
        .replace(/(?:~|\.{1,2})?\/[^\s/]+(?:\/[^\s/]*)+/g, '<path>')
        .replace(/\bsk-[\w.*…-]+/gi, '<key>')
        .replace(/[\w+/=.-]*\d[\w+/=.-]{11,}|[\w+/=-]{24,}/g, '<token>')
        .slice(0, SHAPE_ROW_LENGTH)
    );
  return rows.join(' | ');
}

/**
 * One plain sentence for a session parked on a start-up screen, e.g.
 * "Stan's new session is waiting at Claude's sign-in screen. …".
 *
 * @param who the session's owner-facing name, e.g. "Stan's new session"
 */
export function describeStartupScreen(
  who: string,
  status: Pick<StartupScreenStatus, 'label' | 'kind' | 'answering'>
): string {
  if (status.kind === 'credential')
    return `${who} is waiting at ${status.label}. The office never answers a sign-in prompt: that plan has to be signed in before this session can start.`;
  if (status.kind === 'decision')
    return `${who} is waiting at ${status.label}. That choice is the owner's, so the office has not answered it.`;
  if (status.answering)
    return `${who} has not reached its composer yet: the office is still answering ${status.label}.`;
  return `${who} is stuck at ${status.label}, which the office could not answer on its own.`;
}

// ─── The scan ─────────────────────────────────────────────────────────────────

/**
 * How long after the pane starts a first-run screen is still plausible. They
 * render before the main UI, so this only has to cover a slow first launch;
 * leaving it open forever would let a transcript that quotes one trigger a key.
 */
export const FIRST_RUN_WINDOW_MS = 90_000;

/**
 * How much longer the scan stays open after it starts answering a screen it has
 * not answered before in this launch. A fresh config directory shows several in
 * a row, and each may take its time to paint.
 */
export const FIRST_RUN_EXTENSION_MS = 60_000;

/** However many screens extend it, the scan never outlives this, measured from the launch. */
export const FIRST_RUN_MAX_MS = 5 * 60_000;

/** Minimum gap between two keystrokes, and between two screen reads. */
export const FIRST_RUN_RETRY_MS = 1500;

/**
 * Keystrokes at ONE screen before giving up and leaving it to the user. A key
 * can land while Ink is still mounting the widget and be dropped; retrying costs
 * nothing, but retrying forever would hammer Enter into whatever came next.
 *
 * Six rather than three because a menu needs an arrow and then Enter, each
 * confirmed against a re-read of the screen, so three left one dropped key of
 * slack. Each screen has its own six: a budget shared by the whole sequence
 * would be spent by the first two screens and strand the session on the third.
 */
export const FIRST_RUN_MAX_ATTEMPTS = 6;

/**
 * How much of the append-only terminal buffer to read on a direct-PTY session,
 * which has no pane to capture. Small on purpose: a screen scrolls out of a
 * short tail as soon as the CLI repaints its main UI, which is what keeps a
 * fallback retry from firing at an already-answered screen.
 */
export const FIRST_RUN_SCAN_BYTES = 4000;

export interface FirstRunScanLimits {
  readonly windowMs: number;
  readonly extensionMs: number;
  readonly maxMs: number;
  readonly retryMs: number;
  readonly maxAttempts: number;
}

export const FIRST_RUN_LIMITS: FirstRunScanLimits = {
  windowMs: FIRST_RUN_WINDOW_MS,
  extensionMs: FIRST_RUN_EXTENSION_MS,
  maxMs: FIRST_RUN_MAX_MS,
  retryMs: FIRST_RUN_RETRY_MS,
  maxAttempts: FIRST_RUN_MAX_ATTEMPTS,
};

/** Why a scan stopped. It never restarts by itself; only a new launch arms it again. */
export type FirstRunScanEnd = 'composer' | 'window' | 'attempts';

export type FirstRunScanStep =
  /** Nothing to type at this frame. `screen` is set when a reported screen is showing. */
  | { readonly action: 'none'; readonly screen?: ProviderScreenPattern }
  /** Send exactly this key, then read the screen again. `attempt` counts keys at this screen. */
  | { readonly action: 'press'; readonly key: string; readonly screen: ProviderScreenPattern; readonly attempt: number }
  /** The scan is over. `screen` is the one it gave up on, for `attempts`. */
  | { readonly action: 'ended'; readonly reason: FirstRunScanEnd; readonly screen?: ProviderScreenPattern };

/**
 * The guard around the matcher: when the office may still type at a first-run
 * screen, and when it must stop for good.
 *
 * The property being kept is **the office never types into a live conversation**.
 * A single 90 s window with one attempt cap kept it for ONE dialog, and broke on
 * a sequence: the screens ahead of the trust dialog used the window up. Here it
 * holds across a sequence because every way the scan is kept open is evidence
 * the pane is still launching, and the scan ends at the first evidence it is not:
 *
 * - It is armed only by a launch (a new pane, a respawned pane), never by a
 *   viewer reattaching to a pane that is already running.
 * - It stays open {@link FIRST_RUN_WINDOW_MS} from the launch. Only *starting to
 *   answer a screen not yet answered in this launch* extends it, by
 *   {@link FIRST_RUN_EXTENSION_MS}, and a screen is only answered when it passed
 *   the live-widget match. So the extension is granted by a first-run widget on
 *   screen, at most once per row of the table, and never past
 *   {@link FIRST_RUN_MAX_MS}.
 * - Each screen has its own {@link FIRST_RUN_MAX_ATTEMPTS}. Spending it ends the
 *   whole scan: a screen that does not answer is one the office misreads.
 * - The first sight of the composer ends the scan for good. A conversation
 *   cannot start before the composer, so nothing a conversation prints is ever
 *   read by an armed scan on a pane that reached it.
 */
export class FirstRunScan {
  private armedAt = 0;
  private deadline = 0;
  private lastReadAt = 0;
  private open = false;
  private ended: FirstRunScanEnd | null = null;
  private attempts = new Map<string, number>();
  private extended = new Set<string>();
  private launched = false;
  private shaped = new Set<string>();

  constructor(private readonly limits: FirstRunScanLimits = FIRST_RUN_LIMITS) {}

  /** A pane was launched or respawned: start over with a full window and fresh budgets. */
  arm(now: number): void {
    this.armedAt = now;
    this.deadline = now + this.limits.windowMs;
    this.lastReadAt = 0;
    this.open = true;
    this.ended = null;
    this.attempts = new Map();
    this.extended = new Set();
    this.launched = true;
    this.shaped = new Set();
  }

  /**
   * The pane this scan was armed for turned out to be one that was already running (the office attached to it).
   * Nothing is known about what it has shown, so the scan is no evidence of a launch short of its composer.
   */
  attached(): void {
    this.launched = false;
  }

  /**
   * The pane was launched by this office and has not been seen at its composer since. It is evidence only together
   * with a frame that shows no composer now ({@link readStartupScreen}); it never opens the scan or permits a key.
   */
  get shortOfComposer(): boolean {
    return this.launched && this.ended !== 'composer';
  }

  /**
   * A read outside the scan (the supervisor's) saw the composer. The launch reached it, for good, whenever that
   * was: a start-up window that closed on a slow launch must not leave the pane looking short of its composer.
   */
  composerSeen(): void {
    this.finish('composer');
  }

  /** True the first time one screen's shape is offered for the log in this launch, so each is logged once. */
  claimShape(screenId: string): boolean {
    if (this.shaped.has(screenId)) return false;
    this.shaped.add(screenId);
    return true;
  }

  /** Whether the scan may still read the screen. False before the first launch and after any end. */
  get active(): boolean {
    return this.open;
  }

  /** Why the scan is over, or null while it is armed, was never armed, or was only disarmed. */
  get endReason(): FirstRunScanEnd | null {
    return this.ended;
  }

  /** Stop without a verdict (the session is going away). */
  disarm(): void {
    this.open = false;
  }

  private finish(reason: FirstRunScanEnd): void {
    this.open = false;
    this.ended = reason;
  }

  /**
   * Whether a read is due now. Closes the window when it has passed. A true
   * answer claims the read, so two callers racing to read get one frame between them.
   */
  due(now: number): boolean {
    if (!this.open) return false;
    if (now > this.deadline) {
      this.finish('window'); // anything matching now is not a first-run screen
      return false;
    }
    if (this.lastReadAt !== 0 && now - this.lastReadAt < this.limits.retryMs) return false;
    this.lastReadAt = now;
    return true;
  }

  /** Whether the office is still willing to type at this screen. */
  answering(screenId: string, now: number): boolean {
    return this.open && now <= this.deadline && (this.attempts.get(screenId) ?? 0) < this.limits.maxAttempts;
  }

  /**
   * Decide what to do about one frame. Call only after {@link due} said yes.
   * A `press` has already been charged to the screen's budget; {@link refund} it
   * if the key never reached the pane.
   */
  read(now: number, text: string, options: ProviderScreenReadOptions = {}): FirstRunScanStep {
    if (!this.open) return { action: 'none' };
    const reading = readProviderScreen(text, options);
    if (!reading) {
      if (!showsComposer(text, options.composerMark)) return { action: 'none' };
      this.finish('composer');
      return { action: 'ended', reason: 'composer' };
    }
    const screen = reading.screen;
    if (reading.key === null) return { action: 'none', screen };
    const attempt = (this.attempts.get(screen.id) ?? 0) + 1;
    if (attempt > this.limits.maxAttempts) {
      this.finish('attempts'); // leave it to the user rather than keep typing
      return { action: 'ended', reason: 'attempts', screen };
    }
    this.attempts.set(screen.id, attempt);
    if (!this.extended.has(screen.id)) {
      this.extended.add(screen.id);
      const extended = Math.max(this.deadline, now + this.limits.extensionMs);
      this.deadline = Math.min(this.armedAt + this.limits.maxMs, extended);
    }
    return { action: 'press', key: reading.key, screen, attempt };
  }

  /** The key for this screen was refused before it reached the pane: it was not an attempt. */
  refund(screenId: string): void {
    const attempts = this.attempts.get(screenId);
    if (attempts) this.attempts.set(screenId, attempts - 1);
  }
}
