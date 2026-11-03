import { describe, expect, it } from 'vitest';
import { composerIsEmpty } from '../src/session-submit-verifier.js';
import { claudeComposerIsReady } from '../src/plan-move-composer.js';

const footer = '⏵⏵ bypass permissions on · 1 shell · 1 feedback draft';
const frame = (prompt = '❯\u00a0', status = 'Custom model · usage 12%', last = footer) => [
  'Earlier generic answer.',
  '──────────────────── generic-label ─',
  prompt,
  '────────────────────────────────────',
  status,
  last,
].join('\n');

describe('Claude plan recovery composer observation', () => {
  it('recognizes the empty real task footer without the old shift+tab marker', () => {
    expect(frame()).not.toContain('shift+tab');
    expect(composerIsEmpty(frame(), '❯')).toBe(true);
    expect(claudeComposerIsReady(frame())).toBe(true);
    expect(claudeComposerIsReady(frame('❯', 'A different model · 0%'))).toBe(true);
    expect(claudeComposerIsReady(frame('❯', 'Generic status', '⏵⏵ bypass permissions on · 1 shell'))).toBe(true);
  });
  it('accepts ANSI rendering, plural tasks and no optional status row', () => {
    expect(claudeComposerIsReady(`\u001b[2m${frame()}\u001b[0m\n\n`)).toBe(true);
    expect(claudeComposerIsReady(frame('❯', 'Any model', footer.replace('1 shell', '12 shells')))).toBe(true);
    expect(claudeComposerIsReady(frame().replace('Custom model · usage 12%\n', ''))).toBe(true);
  });
  it.each(['❯ a draft', '❯ [Pasted text 40 chars]', '❯\n  wrapped draft', '❯\n\nmore draft', ' ❯'])('refuses nonempty or noncanonical composer %j', prompt => {
    expect(claudeComposerIsReady(frame(prompt))).toBe(false);
  });
  it.each(['Do you trust this folder?', 'Sign in to continue', 'Allow this command?', '❯ Yes', 'esc to interrupt'])('refuses dialog/working status %j', status => {
    expect(claudeComposerIsReady(frame('❯', status))).toBe(false);
  });
  it.each(['', '❯', '$ ', frame().replace(footer, 'unknown footer'), frame().replace(footer, '⏵⏵ bypass permissions on'), frame() + '\n$ ', frame().replace('1 feedback draft', 'press Enter to approve')])('refuses bare glyph, shell or unknown/incomplete footer %j', screen => {
    expect(claudeComposerIsReady(screen)).toBe(false);
  });
  it.each([
    '⏵⏵ bypass permissions on · 1 feedback draft · 1 shell',
    footer + ' · another chip',
    footer.replace('1 feedback draft', 'feedback draft'),
    footer.replace('1 shell', '0 shells'),
    '⏵⏵ bypass permissions on · 1 shell · ctrl+t to hide tasks',
  ])('refuses reordered, unknown, uncounted or unobserved task chrome %j', last => {
    expect(claudeComposerIsReady(frame('❯', 'Generic status', last))).toBe(false);
  });
  it.each([
    '✻ Working… (esc to interrupt)',
    '✻ Actualizing… (39s · ↓ 2.0k tokens)',
    'Esc to interrupt',
  ])('refuses the current native busy row immediately above the composer %j', busy => {
    expect(claudeComposerIsReady(frame().replace('Earlier generic answer.', busy))).toBe(false);
    expect(claudeComposerIsReady(frame().replace('Earlier generic answer.', busy).replace('Custom model · usage 12%\n', ''))).toBe(false);
  });
  it('keeps Goal chrome and earlier transcript working words outside the current busy-row fence', () => {
    const ready = frame().replace('Earlier generic answer.', 'Goal active');
    expect(claudeComposerIsReady(ready)).toBe(true);
    expect(claudeComposerIsReady('✻ Working… (esc to interrupt)\nEarlier answer finished.\n' + ready)).toBe(true);
  });
  it('requires both adjacent rulers, not a history-only or hidden draft glyph', () => {
    expect(claudeComposerIsReady(frame().replace('──────────────────── generic-label ─\n', ''))).toBe(false);
    expect(claudeComposerIsReady(frame().replace('────────────────────────────────────\n', ''))).toBe(false);
    expect(claudeComposerIsReady(frame() + '\nChoose an option:\n❯ Trust folder')).toBe(false);
    expect(claudeComposerIsReady(frame().replace('❯\u00a0', '❯\u00a0\n  ─ literal wrapped draft'))).toBe(false);
  });
  it('refuses oversized or unbounded custom status', () => {
    expect(claudeComposerIsReady('x'.repeat(131_073) + frame())).toBe(false);
    expect(claudeComposerIsReady(frame('❯', 'x'.repeat(513)))).toBe(false);
  });
});
