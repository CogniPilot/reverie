import { registeredMuxFixture } from './helpers/registered-mux-fixture.js';
/**
 * Provider first-run screens: recognising them, the one key that answers each,
 * and the window that keeps those keys off a live conversation.
 *
 * The failure this pins: a plan move launched Claude Code against a fresh config
 * directory, Claude showed its theme chooser, security notes, workspace-trust
 * question and Bypass Permissions warning in turn, nothing answered the first
 * two, the trust scan's 90 s window ran out behind them, and the move ended in
 * `recovery-required` with "The existing candidate is not at its verified
 * composer".
 *
 * The quoted phrases and the `❯` rows in the screens below are the literal text
 * read off that session. The rows around them are filler in the same layout, so
 * nothing in a matcher may depend on them.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import {
  FirstRunScan,
  PROVIDER_SCREENS,
  readProviderScreen,
  nameProviderScreen,
  describeStartupScreen,
  startupScreenStatus,
  compactScreenText,
  SCREEN_KEY_CONFIRM,
  SCREEN_KEY_DOWN,
  SCREEN_KEY_UP,
  FIRST_RUN_WINDOW_MS,
  FIRST_RUN_EXTENSION_MS,
  FIRST_RUN_MAX_MS,
  FIRST_RUN_MAX_ATTEMPTS,
  FIRST_RUN_RETRY_MS,
} from '../src/session-first-run-screens.js';
import {
  PlanMoveComposerNotReady,
  planMoveComposerWaitContinues,
  PLAN_MOVE_COMPOSER_WAIT_MS,
  PLAN_MOVE_FIRST_RUN_GRACE_MS,
} from '../src/plan-move.js';

const THEME = [
  ' Welcome to Claude Code',
  '',
  " Let's get started.",
  '',
  ' Choose the text style that looks best with your terminal',
  ' To change this later, run /theme',
  '',
  ' ❯ ✔ Dark mode',
  '     Light mode',
  '     Dark mode (colorblind-friendly)',
  '     Light mode (colorblind-friendly)',
].join('\n');

const SECURITY_NOTES = [
  ' Security notes:',
  '',
  ' 1. Claude can make mistakes',
  "    You should always review Claude's responses, especially when running code.",
  '',
  ' 2. Due to prompt injection risks, only use it with code you trust',
  '',
  ' Press Enter to continue…',
].join('\n');

const TRUST = [
  ' Accessing workspace:',
  ' /home/agent/work',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const TRUST_ON_YES = TRUST.replace(' ❯ No, exit\n   Yes,', '   No, exit\n ❯ Yes,');

const BYPASS = [
  ' WARNING: Claude Code running in Bypass Permissions mode',
  '',
  ' In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
  '',
  ' ❯ No, exit',
  '   Yes, I accept',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const BYPASS_ON_YES = BYPASS.replace(' ❯ No, exit\n   Yes,', '   No, exit\n ❯ Yes,');

/** Claude's sign-in: credentials are missing. Never answered. */
const CLAUDE_SIGN_IN = [
  ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.',
  '',
  ' Select login method:',
  '',
  ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
  '   2. Anthropic Console account · API usage billing',
].join('\n');

const CLAUDE_PASTE_CODE = [
  " Browser didn't open? Use the url below to sign in:",
  ' https://claude.ai/oauth/authorize?code=true',
  '',
  ' Paste code here if prompted >',
].join('\n');

/** Codex's first run: this one means the plan is not signed in. */
const CODEX_SIGN_IN = [
  '  Welcome to Codex, OpenAI’s command-line coding agent',
  '',
  '  Sign in with ChatGPT to use Codex as part of your paid plan',
  '',
  '> 1. Sign in with ChatGPT',
  '  2. Provide your own API key',
  '',
  '  Press Enter to continue',
].join('\n');

/** An ordinary working Claude session: composer and footer at the bottom. */
const COMPOSER = [
  '────────────────────────────────',
  '❯ ',
  '────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');
const CLAUDE_MARK = 'shift+tab';

/**
 * A live conversation whose transcript quotes every phrase above: this is the
 * prose of the bug report itself, the way an agent asked to fix it would see it.
 */
const QUOTING_PROSE = [
  '● The first-run screens, one after another:',
  '  1. Theme chooser: screen contains "Choose the text style that looks best with your terminal", with',
  '     `❯ ✔ Dark mode` preselected → Enter.',
  '  2. "Security notes:" … "Press Enter to continue…" → Enter.',
  '  3. Workspace trust: "Quick safety check: Is this a project you created or one you trust?" with options',
  '     `❯ No, exit` / `Yes, I trust this folder` → Down, then Enter to confirm · Esc to cancel.',
  '  4. "WARNING: Claude Code running in Bypass Permissions mode" with `❯ No, exit` / `Yes, I accept` → Down,',
  '     then Enter only once `❯` is on "Yes, I accept".',
  '  Codex has "Welcome to Codex … Sign in with ChatGPT", and Claude "Select login method:" with',
  '  "Claude account with subscription".',
].join('\n');
const QUOTING_TRANSCRIPT = `${QUOTING_PROSE}\n\n${COMPOSER}`;

/** What `capture-pane` gives when the pane is narrower than tmux's idea of a word gap: no whitespace at all. */
const squeezed = (screen: string) => screen.replace(/\s+/g, '');
/** What the wire carries: a cursor-forward where every space should be. */
const cursorForwards = (screen: string) => screen.replace(/ /g, '\x1b[C');

const read = (screen: string, composerMark?: string) => {
  const reading = readProviderScreen(screen, { composerMark });
  return reading ? { id: reading.screen.id, key: reading.key } : null;
};

describe('readProviderScreen', () => {
  it.each([
    ['theme chooser', THEME, 'claude-theme', SCREEN_KEY_CONFIRM],
    ['security notes', SECURITY_NOTES, 'claude-security-notes', SCREEN_KEY_CONFIRM],
    ['workspace trust on "No, exit"', TRUST, 'claude-workspace-trust', SCREEN_KEY_DOWN],
    ['workspace trust on the trust option', TRUST_ON_YES, 'claude-workspace-trust', SCREEN_KEY_CONFIRM],
    ['bypass warning on "No, exit"', BYPASS, 'claude-bypass-permissions', SCREEN_KEY_DOWN],
    ['bypass warning on "Yes, I accept"', BYPASS_ON_YES, 'claude-bypass-permissions', SCREEN_KEY_CONFIRM],
  ])('answers the %s with one key', (_name, screen, id, key) => {
    expect(read(screen)).toEqual({ id, key });
    expect(read(screen, CLAUDE_MARK)).toEqual({ id, key });
  });

  it.each([
    ['theme chooser', THEME, 'claude-theme', SCREEN_KEY_CONFIRM],
    ['security notes', SECURITY_NOTES, 'claude-security-notes', SCREEN_KEY_CONFIRM],
    ['workspace trust', TRUST, 'claude-workspace-trust', SCREEN_KEY_DOWN],
    ['bypass warning', BYPASS, 'claude-bypass-permissions', SCREEN_KEY_DOWN],
    ['bypass warning, moved', BYPASS_ON_YES, 'claude-bypass-permissions', SCREEN_KEY_CONFIRM],
  ])('reads the %s with its whitespace gone, and off the raw repaint', (_name, screen, id, key) => {
    // The literal phrase is not in either form, which is the whole reason the match is compacted.
    expect(squeezed(screen)).not.toContain(' ');
    expect(read(squeezed(screen))).toEqual({ id, key });
    expect(read(cursorForwards(screen))).toEqual({ id, key });
    expect(compactScreenText(cursorForwards(screen))).toBe(compactScreenText(screen));
  });

  it('never returns Enter while the highlight is on "No, exit"', () => {
    // The regression in one line: Enter here answers *exit* and kills the pane.
    for (const screen of [TRUST, BYPASS, squeezed(TRUST), squeezed(BYPASS)]) {
      expect(readProviderScreen(screen)?.key).toBe(SCREEN_KEY_DOWN);
    }
  });

  it('steers UP when the accepted option is the one above', () => {
    const numbered = [
      ' WARNING: Claude Code running in Bypass Permissions mode',
      '   1. Yes, I accept',
      ' ❯ 2. No, exit',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(read(numbered)).toEqual({ id: 'claude-bypass-permissions', key: SCREEN_KEY_UP });
    expect(read(numbered.replace('   1. Yes,', ' ❯ 1. Yes,').replace(' ❯ 2. No,', '   2. No,'))).toEqual({
      id: 'claude-bypass-permissions',
      key: SCREEN_KEY_CONFIRM,
    });
  });

  it('presses nothing when the frame does not say which option is highlighted', () => {
    // A layout this cannot read is a screen for the human, not a coin flip.
    expect(read(TRUST.replace(' ❯ No, exit', '   No, exit'))).toBeNull();
    expect(read(BYPASS.replace(' ❯ No, exit', '   No, exit'))).toBeNull();
    expect(read(THEME.replace(' ❯ ✔ Dark mode', '   ✔ Dark mode'))).toBeNull();
    // On an option the table does not name.
    expect(read(BYPASS.replace(' ❯ No, exit', ' ❯ Maybe later'))).toBeNull();
    expect(read(THEME.replace(' ❯ ✔ Dark mode', ' ❯ Surprise me'))).toBeNull();
  });

  it('continues past a notice only while its prompt is the last thing on screen', () => {
    expect(read(`${SECURITY_NOTES}\n\n   `)).toEqual({ id: 'claude-security-notes', key: SCREEN_KEY_CONFIRM });
    expect(read(SECURITY_NOTES.replace('continue…', 'continue...'))).toEqual({
      id: 'claude-security-notes',
      key: SCREEN_KEY_CONFIRM,
    });
    // A blind Enter is the one key with no highlight to check, so anything drawn after the prompt refuses it.
    expect(read(`${SECURITY_NOTES}\n\n> rm -rf build`)).toBeNull();
    expect(read(`${SECURITY_NOTES}\n${COMPOSER}`)).toBeNull();
  });

  it('reads the LAST frame in an append-only buffer, not the first', () => {
    // The direct-PTY fallback has no pane to capture, so it reads a buffer that
    // still holds every repaint since launch. The freshest frame is the truth.
    expect(read(`${THEME}\n${SECURITY_NOTES}`)).toEqual({ id: 'claude-security-notes', key: SCREEN_KEY_CONFIRM });
    expect(read(`${TRUST}\n${TRUST_ON_YES}`)).toEqual({ id: 'claude-workspace-trust', key: SCREEN_KEY_CONFIRM });
    // Both menus offer "No, exit"; the trust option lies above here and must not be steered onto.
    expect(read(`${TRUST_ON_YES}\n${BYPASS}`)).toEqual({ id: 'claude-bypass-permissions', key: SCREEN_KEY_DOWN });
    expect(read(`${TRUST_ON_YES}\n${BYPASS_ON_YES}`)).toEqual({
      id: 'claude-bypass-permissions',
      key: SCREEN_KEY_CONFIRM,
    });
  });

  it('does not match a conversation whose transcript merely quotes the screens', () => {
    // An agent reading or writing about this feature (this file, for one) must
    // not cause a key press. The composer under the quotes carries the last `❯`.
    expect(read(QUOTING_TRANSCRIPT, CLAUDE_MARK)).toBeNull();
    expect(read(squeezed(QUOTING_TRANSCRIPT), CLAUDE_MARK)).toBeNull();
    // Even for a caller that does not know the CLI's composer mark, nothing is ever typed.
    expect(readProviderScreen(QUOTING_TRANSCRIPT)?.key ?? null).toBeNull();
    expect(readProviderScreen(squeezed(QUOTING_TRANSCRIPT))?.key ?? null).toBeNull();
    // The prose alone, with no composer drawn under it: still no key.
    expect(readProviderScreen(QUOTING_PROSE)?.key ?? null).toBeNull();
    for (const phrase of [
      'Choose the text style that looks best with your terminal',
      'the second screen said "Security notes:" and "Press Enter to continue…" and nothing answered it',
      'the installer asks you to trust this folder before it runs',
      'WARNING: Claude Code running in Bypass Permissions mode',
    ]) {
      expect(read(phrase)).toBeNull();
      expect(read(`${phrase}\n${COMPOSER}`, CLAUDE_MARK)).toBeNull();
    }
  });

  it('sees nothing on an ordinary screen', () => {
    expect(read(COMPOSER, CLAUDE_MARK)).toBeNull();
    expect(read(COMPOSER)).toBeNull();
    expect(read('')).toBeNull();
  });

  it.each([
    ['Claude sign-in', CLAUDE_SIGN_IN, "Claude's sign-in screen"],
    ['Claude paste-code prompt', CLAUDE_PASTE_CODE, "Claude's sign-in screen"],
    ['Codex sign-in', CODEX_SIGN_IN, "Codex's sign-in screen"],
  ])('names the %s and never offers a key for it', (_name, screen, label) => {
    for (const text of [screen, squeezed(screen)]) {
      const reading = readProviderScreen(text);
      expect(reading?.screen.label).toBe(label);
      expect(reading?.screen.answer).toEqual({ kind: 'report', reason: 'credential' });
      expect(reading?.key).toBeNull();
    }
  });

  it('keeps every credential and decision row unanswerable by construction', () => {
    // A row that names a login, sign-in, API key or pasted code must be a `report` row.
    for (const screen of PROVIDER_SCREENS) {
      const words = [screen.id, screen.label, ...screen.markers.flat()].join(' ').toLowerCase();
      if (/sign-?in|login|apikey|api key|pastecode|chatgpt/.test(words)) expect(screen.answer.kind).toBe('report');
      // And every row needs two independent markers.
      expect(screen.markers[0].length).toBeGreaterThan(0);
      expect(screen.markers[1].length).toBeGreaterThan(0);
      expect(screen.markers[0].some((phrase) => screen.markers[1].includes(phrase))).toBe(false);
    }
  });
});

describe('FirstRunScan', () => {
  const options = { composerMark: CLAUDE_MARK };
  /** One read at `now`, as the session makes it: only when the scan says a read is due. */
  const readAt = (scan: FirstRunScan, now: number, screen: string) =>
    scan.due(now) ? scan.read(now, screen, options) : { action: 'skipped' as const };

  it('reads nothing before a launch arms it', () => {
    const scan = new FirstRunScan();
    expect(scan.active).toBe(false);
    expect(scan.due(1000)).toBe(false);
    expect(scan.read(1000, TRUST_ON_YES, options)).toEqual({ action: 'none' });
  });

  it('walks a whole first run, one key per frame, and ends at the composer', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    const frames = [THEME, SECURITY_NOTES, TRUST, TRUST_ON_YES, BYPASS, BYPASS_ON_YES];
    const keys: string[] = [];
    let now = 0;
    for (const frame of frames) {
      now += FIRST_RUN_RETRY_MS + 100;
      const step = readAt(scan, now, frame);
      expect(step.action).toBe('press');
      if (step.action === 'press') keys.push(step.key);
    }
    expect(keys).toEqual([
      SCREEN_KEY_CONFIRM,
      SCREEN_KEY_CONFIRM,
      SCREEN_KEY_DOWN,
      SCREEN_KEY_CONFIRM,
      SCREEN_KEY_DOWN,
      SCREEN_KEY_CONFIRM,
    ]);
    now += FIRST_RUN_RETRY_MS + 100;
    expect(readAt(scan, now, COMPOSER)).toEqual({ action: 'ended', reason: 'composer' });
    expect(scan.active).toBe(false);
    expect(scan.endReason).toBe('composer');
  });

  it('ends for good at the composer: nothing a conversation prints is read afterwards', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    expect(readAt(scan, 2000, COMPOSER)).toEqual({ action: 'ended', reason: 'composer' });
    // Still inside the 90 s window, and the pane now shows the real widget's text.
    for (const screen of [TRUST_ON_YES, BYPASS_ON_YES, SECURITY_NOTES, THEME]) {
      expect(readAt(scan, 10_000, screen)).toEqual({ action: 'skipped' });
      expect(scan.read(10_000, screen, options)).toEqual({ action: 'none' });
    }
  });

  it('types nothing at a conversation that quotes the screens, and stops there', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    expect(readAt(scan, 2000, QUOTING_TRANSCRIPT)).toEqual({ action: 'ended', reason: 'composer' });
    expect(scan.active).toBe(false);
  });

  it('closes after the startup window when no first-run screen was answered', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    expect(readAt(scan, FIRST_RUN_WINDOW_MS - 1, '')).toEqual({ action: 'none' });
    // A live agent can print this text hours in; only a launching pane can be showing the real widget.
    expect(readAt(scan, FIRST_RUN_WINDOW_MS + 1, TRUST_ON_YES)).toEqual({ action: 'skipped' });
    expect(scan.endReason).toBe('window');
    expect(scan.read(FIRST_RUN_WINDOW_MS + 2, TRUST_ON_YES, options)).toEqual({ action: 'none' });
  });

  it('stays open across a slow sequence: each screen it starts answering extends the window', () => {
    // The bug: the screens ahead of the trust dialog used up its one window.
    const scan = new FirstRunScan();
    scan.arm(0);
    const late = FIRST_RUN_WINDOW_MS - 5000;
    expect(readAt(scan, late, THEME).action).toBe('press');
    // Past the original window now, and the next screen is still answered.
    const later = FIRST_RUN_WINDOW_MS + 20_000;
    expect(later).toBeLessThan(late + FIRST_RUN_EXTENSION_MS);
    expect(readAt(scan, later, SECURITY_NOTES).action).toBe('press');
    const latest = later + FIRST_RUN_EXTENSION_MS - 1000;
    expect(readAt(scan, latest, TRUST).action).toBe('press');
    // With no further screen, it closes one extension after the last one it started on.
    expect(readAt(scan, latest + FIRST_RUN_EXTENSION_MS + 1, BYPASS_ON_YES)).toEqual({ action: 'skipped' });
    expect(scan.endReason).toBe('window');
  });

  it('does not extend the window for more keys at the same screen, or for a screen it only reports', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    const first = FIRST_RUN_WINDOW_MS - 10_000;
    expect(readAt(scan, first, TRUST).action).toBe('press');
    // A second key at the same screen, later: the deadline is still the first key's.
    expect(readAt(scan, first + 30_000, TRUST).action).toBe('press');
    expect(readAt(scan, first + FIRST_RUN_EXTENSION_MS - 1, CLAUDE_SIGN_IN).action).toBe('none');
    expect(readAt(scan, first + FIRST_RUN_EXTENSION_MS + 1, TRUST_ON_YES)).toEqual({ action: 'skipped' });
    expect(scan.endReason).toBe('window');
  });

  it('never outlives its hard limit, however many screens extend it', () => {
    const limits = { windowMs: 1000, extensionMs: 1000, maxMs: 2500, retryMs: 10, maxAttempts: 6 };
    const scan = new FirstRunScan(limits);
    scan.arm(0);
    expect(readAt(scan, 900, THEME).action).toBe('press');
    expect(readAt(scan, 1800, SECURITY_NOTES).action).toBe('press');
    expect(readAt(scan, 2400, TRUST).action).toBe('press');
    expect(readAt(scan, 2501, BYPASS_ON_YES)).toEqual({ action: 'skipped' });
    expect(scan.endReason).toBe('window');
    expect(FIRST_RUN_MAX_MS).toBeGreaterThan(FIRST_RUN_WINDOW_MS);
  });

  it('gives each screen its own attempt budget, and ends on a screen that will not answer', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    let now = 0;
    const tick = (screen: string) => readAt(scan, (now += FIRST_RUN_RETRY_MS + 1), screen);
    // Five dropped keys at the theme chooser do not eat into the trust dialog's budget.
    for (let i = 0; i < FIRST_RUN_MAX_ATTEMPTS - 1; i++) expect(tick(THEME).action).toBe('press');
    // A dialog that never moves (a dropped arrow, a wedged pane) runs out pressing arrows, never Enter.
    for (let i = 1; i <= FIRST_RUN_MAX_ATTEMPTS; i++) {
      expect(tick(TRUST)).toMatchObject({ action: 'press', key: SCREEN_KEY_DOWN, attempt: i });
    }
    expect(scan.answering('claude-workspace-trust', now)).toBe(false);
    expect(scan.answering('claude-bypass-permissions', now)).toBe(true);
    expect(tick(TRUST)).toMatchObject({ action: 'ended', reason: 'attempts', screen: { id: 'claude-workspace-trust' } });
    expect(scan.active).toBe(false);
    // Given up means given up: the next screen is the human's too.
    expect(tick(BYPASS_ON_YES)).toEqual({ action: 'skipped' });
    expect(scan.answering('claude-bypass-permissions', now)).toBe(false);
  });

  it('does not count a key that never reached the pane', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    let now = 0;
    for (let i = 0; i < FIRST_RUN_MAX_ATTEMPTS * 3; i++) {
      const step = readAt(scan, (now += FIRST_RUN_RETRY_MS + 1), SECURITY_NOTES);
      expect(step).toMatchObject({ action: 'press', attempt: 1 });
      scan.refund('claude-security-notes');
    }
    expect(scan.active).toBe(true);
  });

  it('reads at most once per retry interval', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    expect(scan.due(100)).toBe(true);
    expect(scan.due(100 + FIRST_RUN_RETRY_MS - 1)).toBe(false);
    expect(scan.due(100 + FIRST_RUN_RETRY_MS)).toBe(true);
  });

  it('never types at a sign-in screen, and keeps watching in case a person answers it', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    let now = 0;
    for (const screen of [CLAUDE_SIGN_IN, CODEX_SIGN_IN, CLAUDE_PASTE_CODE, CLAUDE_SIGN_IN]) {
      const step = readAt(scan, (now += FIRST_RUN_RETRY_MS + 1), screen);
      expect(step.action).toBe('none');
    }
    expect(scan.active).toBe(true);
    // The owner signed in by hand; the screens after it are still the office's.
    expect(readAt(scan, (now += FIRST_RUN_RETRY_MS + 1), SECURITY_NOTES).action).toBe('press');
  });

  it('is armed again by a relaunch, with a full window and fresh budgets', () => {
    const scan = new FirstRunScan();
    scan.arm(0);
    expect(readAt(scan, 2000, COMPOSER)).toEqual({ action: 'ended', reason: 'composer' });
    const relaunch = 3_600_000;
    scan.arm(relaunch);
    expect(scan.endReason).toBeNull();
    expect(readAt(scan, relaunch + 2000, THEME)).toMatchObject({ action: 'press', attempt: 1 });
  });
});

describe('nameProviderScreen', () => {
  /** A layout the matcher cannot answer: the highlight is on an option the table does not name. */
  const REDRAWN_THEME = THEME.replace(' ❯ ✔ Dark mode', ' ❯ ✔ Auto (match terminal)\n     Dark mode');

  it('names a screen the office cannot answer, without ever offering a key for it', () => {
    expect(readProviderScreen(REDRAWN_THEME)).toBeNull();
    const named = nameProviderScreen(REDRAWN_THEME, { composerMark: CLAUDE_MARK });
    expect(named).toMatchObject({ screen: { id: 'claude-theme' }, key: null });
    expect(describeStartupScreen('The new session', startupScreenStatus(named!, false))).toContain(
      "stuck at Claude's theme chooser"
    );
  });

  it('agrees with the matcher on a screen it can answer', () => {
    for (const screen of [THEME, SECURITY_NOTES, TRUST, BYPASS_ON_YES, CLAUDE_SIGN_IN, CODEX_SIGN_IN]) {
      expect(nameProviderScreen(screen, { composerMark: CLAUDE_MARK })).toEqual(readProviderScreen(screen));
    }
  });

  it('names nothing on a session that is at its composer', () => {
    expect(nameProviderScreen(QUOTING_TRANSCRIPT, { composerMark: CLAUDE_MARK })).toBeNull();
    expect(nameProviderScreen(COMPOSER, { composerMark: CLAUDE_MARK })).toBeNull();
    expect(nameProviderScreen('')).toBeNull();
  });
});

describe('describeStartupScreen', () => {
  const status = (screen: string, answering: boolean) => startupScreenStatus(readProviderScreen(screen)!, answering);

  it('names a sign-in screen and says the office will not answer it', () => {
    const credential = status(CLAUDE_SIGN_IN, true);
    // `answering` is never true for a screen the office does not answer.
    expect(credential).toMatchObject({ kind: 'credential', answering: false, label: "Claude's sign-in screen" });
    const sentence = describeStartupScreen("Stan's new session", credential);
    expect(sentence).toContain("Stan's new session is waiting at Claude's sign-in screen");
    expect(sentence).toContain('never answers a sign-in prompt');
    expect(describeStartupScreen("Stan's new session", status(CODEX_SIGN_IN, false))).toContain(
      "Stan's new session is waiting at Codex's sign-in screen"
    );
  });

  it('says whether a first-run screen is still being answered or has been given up on', () => {
    expect(describeStartupScreen('The new session', status(THEME, true))).toBe(
      "The new session has not reached its composer yet: the office is still answering Claude's theme chooser."
    );
    expect(describeStartupScreen('The new session', status(THEME, false))).toContain(
      "The new session is stuck at Claude's theme chooser"
    );
  });
});

describe('a plan move waiting on a candidate that is not at its composer', () => {
  const waiting = (screen: string, answering: boolean) =>
    new PlanMoveComposerNotReady({ who: "Stan's new session", ...startupScreenStatus(readProviderScreen(screen)!, answering) });

  it('keeps the plain refusal when the candidate shows no screen the office can name', () => {
    const error = new PlanMoveComposerNotReady();
    expect(error.message).toBe('The existing candidate is not at its verified composer');
    expect(error.waitingAt).toBeUndefined();
    expect(planMoveComposerWaitContinues(error, PLAN_MOVE_COMPOSER_WAIT_MS - 1)).toBe(true);
    expect(planMoveComposerWaitContinues(error, PLAN_MOVE_COMPOSER_WAIT_MS)).toBe(false);
  });

  it('names the screen instead of the generic composer message', () => {
    expect(waiting(CLAUDE_SIGN_IN, false).message).toContain("Stan's new session is waiting at Claude's sign-in screen");
    expect(waiting(BYPASS, false).message).toContain("Stan's new session is stuck at Claude's Bypass Permissions warning");
    expect(waiting(BYPASS, false)).toBeInstanceOf(PlanMoveComposerNotReady);
  });

  it('treats a first-run screen the office is still answering as still starting, within a bound', () => {
    const answering = waiting(TRUST, true);
    expect(planMoveComposerWaitContinues(answering, PLAN_MOVE_COMPOSER_WAIT_MS)).toBe(true);
    expect(planMoveComposerWaitContinues(answering, PLAN_MOVE_COMPOSER_WAIT_MS + PLAN_MOVE_FIRST_RUN_GRACE_MS - 1)).toBe(true);
    expect(planMoveComposerWaitContinues(answering, PLAN_MOVE_COMPOSER_WAIT_MS + PLAN_MOVE_FIRST_RUN_GRACE_MS)).toBe(false);
  });

  it('gives no extra time to a sign-in screen or to a screen the office gave up on', () => {
    for (const error of [waiting(CLAUDE_SIGN_IN, true), waiting(CODEX_SIGN_IN, true), waiting(TRUST, false)]) {
      expect(planMoveComposerWaitContinues(error, PLAN_MOVE_COMPOSER_WAIT_MS - 1)).toBe(true);
      expect(planMoveComposerWaitContinues(error, PLAN_MOVE_COMPOSER_WAIT_MS)).toBe(false);
    }
  });
});

describe('Session first-run screen scan', () => {
  afterEach(() => vi.useRealTimers());

  /** How long the scan waits before it reads the pane again by itself. */
  const READ_MS = FIRST_RUN_RETRY_MS + 100;

  /**
   * A session whose pane renders `screen()`, recording every key that reaches the
   * pane. Nothing here feeds the session PTY output: the scan has to drive itself.
   */
  function launched(screen: () => string, options: { deliver?: (key: string) => boolean; docker?: boolean } = {}) {
    const writes: string[] = [];
    const registry = registeredMuxFixture({ mode: 'claude', sessionId: 'first-run', muxName: 'reverie-first-run', pid: 42 });
    const mux = {
      ...registry,
      isAvailable: () => true,
      capturePaneText: () => screen(),
      sendInput: (_id: string, data: string) => {
        const delivered = options.deliver ? options.deliver(data) : true;
        if (delivered) writes.push(data);
        return Promise.resolve(delivered);
      },
    };
    const session = new Session({
      id: registry.subject.sessionId,
      workingDir: '/tmp',
      mode: 'claude',
      mux,
      muxSession: registry.subject,
      ...(options.docker
        ? {
            docker: {
              hostId: 'local',
              label: 'laptop',
              engine: 'docker',
              image: 'reverie/agent:base',
              containerName: 'reverie-laptop',
              hostWorkspacePath: '/tmp',
              containerWorkdir: '/tmp',
              network: 'bridge',
              mountCredentials: false,
              hooksEnabled: false,
              resumeOnStart: false,
            },
          }
        : {}),
    } as ConstructorParameters<typeof Session>[0]);
    const internals = session as unknown as { _armFirstRunScan(): void };
    return { session, writes, launch: () => internals._armFirstRunScan() };
  }

  /** The four screens in order; each advances only when the key that answers it arrives. */
  function firstRun() {
    const frames: Array<[string, string]> = [
      [THEME, SCREEN_KEY_CONFIRM],
      [SECURITY_NOTES, SCREEN_KEY_CONFIRM],
      [TRUST, SCREEN_KEY_DOWN],
      [TRUST_ON_YES, SCREEN_KEY_CONFIRM],
      [BYPASS, SCREEN_KEY_DOWN],
      [BYPASS_ON_YES, SCREEN_KEY_CONFIRM],
    ];
    let at = 0;
    return {
      screen: () => frames[at]?.[0] ?? COMPOSER,
      key: (key: string) => {
        // A wrong key on a menu is the bug: Enter on "No, exit" kills the pane.
        if (frames[at] && key !== frames[at][1]) throw new Error(`wrong key ${JSON.stringify(key)} at frame ${at}`);
        at++;
        return true;
      },
      done: () => at >= frames.length,
    };
  }

  it.each([false, true])('answers a whole first run by itself and stops at the composer (boxed=%s)', async (docker) => {
    vi.useFakeTimers();
    const run = firstRun();
    const { session, writes, launch } = launched(run.screen, { deliver: run.key, docker });
    launch();
    await vi.advanceTimersByTimeAsync(READ_MS * 8);
    expect(writes).toEqual([
      SCREEN_KEY_CONFIRM,
      SCREEN_KEY_CONFIRM,
      SCREEN_KEY_DOWN,
      SCREEN_KEY_CONFIRM,
      SCREEN_KEY_DOWN,
      SCREEN_KEY_CONFIRM,
    ]);
    expect(run.done()).toBe(true);
    expect(session.startupScreen()).toBeNull();
    // At its composer the session is a conversation: nothing more is typed, whatever it shows.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(6);
  });

  it('does not type into a conversation that quotes the screens', async () => {
    vi.useFakeTimers();
    const { writes, launch } = launched(() => QUOTING_TRANSCRIPT);
    launch();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(writes).toEqual([]);
  });

  it('reports a sign-in screen by name and never types at it', async () => {
    vi.useFakeTimers();
    const { session, writes, launch } = launched(() => CLAUDE_SIGN_IN);
    launch();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(writes).toEqual([]);
    expect(session.startupScreen()).toEqual({
      id: 'claude-sign-in',
      label: "Claude's sign-in screen",
      kind: 'credential',
      answering: false,
    });
  });

  it('says whether it is still answering the screen a candidate is waiting at', async () => {
    vi.useFakeTimers();
    // A dialog that never moves: the arrows are dropped.
    const { session, writes, launch } = launched(() => BYPASS);
    expect(session.startupScreen()).toMatchObject({ id: 'claude-bypass-permissions', kind: 'first-run', answering: false });
    launch();
    expect(session.startupScreen()).toMatchObject({ id: 'claude-bypass-permissions', answering: true });
    await vi.advanceTimersByTimeAsync(READ_MS * 20);
    expect(writes).toEqual(Array(FIRST_RUN_MAX_ATTEMPTS).fill(SCREEN_KEY_DOWN));
    expect(session.startupScreen()).toMatchObject({ id: 'claude-bypass-permissions', answering: false });
  });

  it('keeps trying a key the pane refused, without spending the screen budget on it', async () => {
    vi.useFakeTimers();
    let refusals = FIRST_RUN_MAX_ATTEMPTS * 2;
    const { writes, launch } = launched(() => (writes.length ? COMPOSER : SECURITY_NOTES), {
      deliver: () => refusals-- <= 0,
    });
    launch();
    await vi.advanceTimersByTimeAsync(READ_MS * (FIRST_RUN_MAX_ATTEMPTS * 2 + 3));
    expect(writes).toEqual([SCREEN_KEY_CONFIRM]);
  });

  it('is armed again when the pane is relaunched', async () => {
    vi.useFakeTimers();
    let screen = COMPOSER;
    const { writes, launch } = launched(() => screen);
    launch();
    await vi.advanceTimersByTimeAsync(READ_MS * 2);
    screen = TRUST_ON_YES;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toEqual([]); // the first launch reached its composer: over for good
    screen = THEME;
    launch(); // a respawn: a new CLI process, possibly on a config directory it has never seen
    await vi.advanceTimersByTimeAsync(READ_MS + 10);
    expect(writes).toEqual([SCREEN_KEY_CONFIRM]);
  });
});
