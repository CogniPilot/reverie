/**
 * Dialog detection off a captured pane: Claude Code panels and dialogs that wait
 * on the user (auto-mode setup, trust dialog, login), but never an ordinary
 * composer or a running turn.
 */
import { describe, expect, it } from 'vitest';
import { paneDialogFooter } from '../src/session-activity.js';

const RULE = '─'.repeat(120);

// Captured from a live Claude Code 2.1.284 pane stuck for two hours (2026-10-14).
const AUTO_MODE_PANEL = [
  "● Everything left depends on the build. I'll wait for the monitor event.",
  '✻ Brewed for 10m 29s · done 3:30 PM · 1 shell still running',
  '❯ /auto-mode-setup',
  RULE,
  '  Teach auto mode about your environment?',
  '  Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other',
  '  repositories. Claude analyzes this data and customizes auto mode to make better decisions.',
  '    How you use Claude here     Mixed',
  '  ❯ Also scan shell history     false',
  '    Also scan your other repos  false',
  '    Continue',
  '  ←/→ to change usage · Enter to continue · Esc to cancel',
  `${'─'.repeat(74)} issue-432: emit ast-json with --source-root ─`,
  'Background task update waiting while this panel is open',
  '',
  '',
].join('\n');

const TRUST_DIALOG = [
  RULE,
  ' Do you trust the files in this folder?',
  '',
  ' /home/user/codeman-cases/demo',
  '',
  ' ❯ Yes, I trust this folder',
  '   No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const IDLE_COMPOSER = [
  '● Done. The tests pass.',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell · ← for agents',
].join('\n');

const WORKING = [
  '✻ Actualizing… (13m 23s · ↓ 2.0k tokens · esc to interrupt)',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

describe('paneDialogFooter', () => {
  it('finds the auto-mode usage panel footer under its border and notice', () => {
    expect(paneDialogFooter(AUTO_MODE_PANEL)).toBe('←/→ to change usage · Enter to continue · Esc to cancel');
  });

  it('finds the workspace trust dialog', () => {
    expect(paneDialogFooter(TRUST_DIALOG)).toBe('Enter to confirm · Esc to cancel');
  });

  it('finds a login prompt and strips ANSI', () => {
    expect(paneDialogFooter('Login successful\n\x1b[2mPress Enter to continue…\x1b[0m\n')).toBe(
      'Press Enter to continue…'
    );
  });

  it('ignores an ordinary composer and a running turn (esc to interrupt)', () => {
    expect(paneDialogFooter(IDLE_COMPOSER)).toBeNull();
    expect(paneDialogFooter(WORKING)).toBeNull();
    expect(paneDialogFooter('')).toBeNull();
    expect(paneDialogFooter(null)).toBeNull();
  });

  it("ignores the agent's own last message above an idle composer, even when it quotes a dialog", () => {
    const agentSaysIt = [
      '● To finish the login, open the link, then press Enter to continue (Esc to cancel).',
      '',
      RULE,
      '❯ ',
      RULE,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(paneDialogFooter(agentSaysIt)).toBeNull();
  });

  it('only looks at the bottom of the screen, not old scrollback text', () => {
    const old = ['The docs say: press Enter to continue.', ...Array(12).fill('ordinary output'), IDLE_COMPOSER].join(
      '\n'
    );
    expect(paneDialogFooter(old)).toBeNull();
  });

  it('keeps the footer short enough for a tooltip', () => {
    expect(paneDialogFooter(`Esc to cancel ${'x'.repeat(400)}`)!.length).toBe(160);
  });
});
