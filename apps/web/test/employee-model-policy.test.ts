/**
 * Pure model decisions: which frames a slash command may be typed into, how a per-model limit is
 * read, and what the office does next. Frames: test/fixtures/claude-model-frames.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  fallbackRestoreAt,
  limitPromptSurface,
  modelIdForDisplay,
  modelMatchesDisplay,
  paneRefusesCommand,
  planEmployeeModel,
  readModelConfirmation,
  readModelLimit,
  type ModelPlanInput,
} from '../src/employee-model-policy.js';
import {
  ACCOUNT_LIMIT,
  DRAFT,
  FOOTER,
  IDLE,
  MENU,
  NOTICE,
  NOW,
  WORKING,
  frame,
  glyph,
} from './fixtures/claude-model-frames.js';

describe('which frames a slash command may be typed into', () => {
  it('allows only an idle, empty composer', () => {
    expect(paneRefusesCommand(IDLE, glyph)).toBeNull();
    expect(paneRefusesCommand(WORKING, glyph)).toBe('working');
    expect(paneRefusesCommand(DRAFT, glyph)).toBe('composer-not-empty');
    expect(paneRefusesCommand(null, glyph)).toBe('unreadable');
  });
  it('never types into a limit menu, the auto-continue footer or another dialog', () => {
    expect(paneRefusesCommand(MENU, glyph)).toBe('limit-prompt');
    expect(paneRefusesCommand(FOOTER, glyph)).toBe('limit-prompt');
    const trust = [
      'Do you trust the files in this folder?',
      '❯ 1. Yes, proceed',
      '  2. No, exit',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(paneRefusesCommand(trust, glyph)).toBe('dialog');
  });
  it('refuses a screen with no composer at all', () => {
    expect(
      paneRefusesCommand('Choose the text style that looks best with your terminal\n  1. Auto\n  2. Dark mode', glyph)
    ).toBe('no-composer');
  });
});

describe('reading a per-model limit', () => {
  it('reads the family, the stated reset and the surface', () => {
    expect(readModelLimit(NOTICE, NOW)).toEqual({
      family: 'fable',
      resetAt: Date.UTC(2026, 10, 26, 4, 0),
      surface: 'notice',
    });
    expect(readModelLimit(MENU, NOW)).toMatchObject({ family: 'fable', surface: 'menu' });
    expect(readModelLimit(FOOTER, NOW)).toMatchObject({ family: 'fable', surface: 'footer' });
    expect(limitPromptSurface(IDLE)).toBeNull();
  });
  it('reads a bare notice only just above the composer, and a passed reset as over', () => {
    const worked = frame([
      "  ⎿  You've hit your Fable limit · resets Nov 26, 4am (UTC)",
      ...Array.from({ length: 10 }, (_, i) => `● Later work, step ${i + 1}.`),
      '✻ Brewed for 6s · done 12:00 AM',
    ]);
    expect(readModelLimit(worked, NOW)).toBeNull();
    const after = Date.UTC(2026, 10, 26, 5, 0);
    expect(
      planEmployeeModel({
        fallbackModel: 'claude-opus-5-5',
        display: 'Fable 5.2',
        limit: readModelLimit(NOTICE, after),
        now: after,
      })
    ).toEqual({ kind: 'none', reason: 'nothing-to-do' });
  });
  it('ignores an account-wide limit and an ordinary frame', () => {
    expect(readModelLimit(ACCOUNT_LIMIT, NOW)).toBeNull();
    expect(readModelLimit(IDLE, NOW)).toBeNull();
    expect(readModelLimit(frame(['  ⚠ 5-hour limit reached ∙ resets 8pm']), NOW)).toBeNull();
  });
});

describe('model names', () => {
  it('matches ids and aliases against the reported display name', () => {
    expect(modelMatchesDisplay('claude-opus-5-5', 'Opus 5.5')).toBe(true);
    expect(modelMatchesDisplay('claude-opus-5-5', 'Opus 5.5 (1M context)')).toBe(true);
    expect(modelMatchesDisplay('opus', 'Opus 5.5')).toBe(true);
    expect(modelMatchesDisplay('claude-opus-5-5', 'Fable 5.2')).toBe(false);
    expect(modelMatchesDisplay('claude-opus-5', 'Opus 5.5')).toBe(true);
    expect(modelMatchesDisplay('claude-opus-5-5', undefined)).toBe(false);
    expect(modelMatchesDisplay('claude-sonnet-4-5-20250929', 'Sonnet 4.5')).toBe(true);
  });
  it('names the id of a plain display name and reads Claude’s confirmation', () => {
    expect(modelIdForDisplay('Fable 5.2')).toBe('claude-fable-5-2');
    expect(modelIdForDisplay('Opus 5')).toBe('claude-opus-5');
    expect(modelIdForDisplay('my-local-model')).toBeUndefined();
    const confirmed = frame(
      ['❯ /model claude-opus-5-5', '  ⎿  Set model to Opus 5.5 and saved as your default for new sessions'],
      { model: 'Opus 5.5' }
    );
    expect(readModelConfirmation(confirmed)).toBe('Opus 5.5');
    expect(readModelConfirmation(IDLE)).toBeUndefined();
  });
});

describe('the next step for an employee', () => {
  const base: ModelPlanInput = { fallbackModel: 'claude-opus-5-5', display: 'Fable 5.2', limit: null, now: NOW };
  it('does nothing without a choice, a limit or a known model', () => {
    expect(planEmployeeModel(base)).toEqual({ kind: 'none', reason: 'nothing-to-do' });
    expect(planEmployeeModel({ ...base, preferred: 'claude-opus-5-5', display: undefined })).toEqual({
      kind: 'none',
      reason: 'model-unknown',
    });
    expect(planEmployeeModel({ ...base, preferred: 'claude-fable-5-2' })).toEqual({
      kind: 'none',
      reason: 'nothing-to-do',
    });
  });
  it('switches to the recorded choice', () => {
    expect(planEmployeeModel({ ...base, preferred: 'claude-opus-5-5' })).toEqual({
      kind: 'switch',
      model: 'claude-opus-5-5',
      reason: 'preference',
    });
  });
  it('falls back off a live per-model limit, pressing Escape only for its menu or footer', () => {
    const notice = planEmployeeModel({ ...base, limit: readModelLimit(NOTICE, NOW) });
    expect(notice).toEqual({
      kind: 'fallback',
      escape: false,
      record: {
        from: 'Fable 5.2',
        family: 'fable',
        to: 'claude-opus-5-5',
        restore: 'claude-fable-5-2',
        resetAt: Date.UTC(2026, 10, 26, 4, 0),
        at: NOW,
      },
    });
    expect(planEmployeeModel({ ...base, limit: readModelLimit(MENU, NOW) })).toMatchObject({
      kind: 'fallback',
      escape: true,
    });
    expect(planEmployeeModel({ ...base, limit: readModelLimit(FOOTER, NOW) })).toMatchObject({
      kind: 'fallback',
      escape: true,
    });
    // A recorded choice is what comes back after the reset.
    expect(planEmployeeModel({ ...base, preferred: 'fable', limit: readModelLimit(NOTICE, NOW) })).toMatchObject({
      record: { restore: 'fable' },
    });
  });
  it('leaves an old notice, a disabled switch and a limit on the fallback itself alone', () => {
    expect(planEmployeeModel({ ...base, display: 'Opus 5.5', limit: readModelLimit(NOTICE, NOW) })).toEqual({
      kind: 'none',
      reason: 'nothing-to-do',
    });
    expect(planEmployeeModel({ ...base, fallbackModel: null, limit: readModelLimit(NOTICE, NOW) })).toEqual({
      kind: 'none',
      reason: 'nothing-to-do',
    });
    expect(
      planEmployeeModel({ ...base, fallbackModel: 'claude-fable-5-3', limit: readModelLimit(NOTICE, NOW) })
    ).toEqual({ kind: 'none', reason: 'nothing-to-do' });
  });
  it('holds the fallback until the reset, then restores and forgets it', () => {
    const record = {
      from: 'Fable 5.2',
      family: 'fable',
      to: 'claude-opus-5-5',
      restore: 'claude-fable-5-2',
      resetAt: NOW + 3_600_000,
      at: NOW,
    };
    expect(planEmployeeModel({ ...base, display: 'Opus 5.5', fallback: record })).toEqual({
      kind: 'none',
      reason: 'nothing-to-do',
    });
    // A restart came back on the limited model before the reset: back to the fallback.
    expect(planEmployeeModel({ ...base, display: 'Fable 5.2', fallback: record })).toEqual({
      kind: 'switch',
      model: 'claude-opus-5-5',
      reason: 'fallback',
    });
    const later = fallbackRestoreAt(record);
    expect(later).toBe(NOW + 3_600_000 + 120_000);
    expect(planEmployeeModel({ ...base, display: 'Opus 5.5', fallback: record, now: later })).toEqual({
      kind: 'switch',
      model: 'claude-fable-5-2',
      reason: 'restore',
    });
    expect(planEmployeeModel({ ...base, display: 'Fable 5.2', fallback: record, now: later })).toEqual({
      kind: 'clear-fallback',
      restored: true,
    });
    expect(
      planEmployeeModel({ ...base, display: 'Opus 5.5', fallback: { ...record, restore: undefined }, now: later })
    ).toEqual({ kind: 'clear-fallback', restored: false });
  });
  it('never falls back twice while one is in force', () => {
    const record = { family: 'fable', to: 'claude-opus-5-5', restore: 'fable', resetAt: NOW + 3_600_000, at: NOW };
    expect(
      planEmployeeModel({ ...base, display: 'Fable 5.2', fallback: record, limit: readModelLimit(NOTICE, NOW) }).kind
    ).toBe('switch');
    const opusLimit = readModelLimit(
      frame(["  ⎿  You've hit your Opus limit · resets 6am"], { model: 'Opus 5.5' }),
      NOW
    );
    expect(planEmployeeModel({ ...base, display: 'Opus 5.5', fallback: record, limit: opusLimit })).toEqual({
      kind: 'none',
      reason: 'fallback-limited',
    });
  });
});
