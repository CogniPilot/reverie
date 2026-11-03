/**
 * `reverie plans show`: advice on a Codex account's banked resets. Reverie only reads them, so it says where to apply
 * one, warns before one expires, and says whether now is a sensible time (the week at 100%, the weekly reset not close).
 */
import { describe, expect, it } from 'vitest';
import {
  BANKED_RESET_EXPIRY_WARN_MS,
  BANKED_RESET_NEAR_WEEKLY_MS,
  agentPlansShow,
  bankedResetAdvice,
  type AgentDeps,
  type PlanRowView,
} from '../src/cli-agent.js';

const NOW = Date.parse('2026-11-03T06:00:00Z');
const HOUR = 3600_000;

function row(
  over: {
    weekly?: number | null;
    weekReset?: number | null;
    banked?: PlanRowView['bankedResets'];
    provider?: string;
  } = {}
): PlanRowView {
  return {
    id: 'acct-1',
    label: 'Codex Gmail',
    provider: over.provider ?? 'openai',
    signedIn: true,
    status: 'ok',
    pace: {
      fiveHour: 10,
      weekly: over.weekly === undefined ? 100 : over.weekly,
      weekReset: over.weekReset === undefined ? NOW + 3 * 24 * HOUR : over.weekReset,
      pace: null,
      projected: null,
      runsOutAt: null,
      recommendation: '',
    },
    bankedResets:
      over.banked === undefined ? { availableCount: 2, earliestExpiresAt: NOW + 10 * 24 * HOUR } : over.banked,
    sessions: [],
  };
}

describe('bankedResetAdvice', () => {
  it('says a reset can be applied with the week used up and its reset far off, and where to apply it', () => {
    const lines = bankedResetAdvice(row(), NOW, 'UTC');
    expect(lines[0]).toBe('  the week is at 100% with 72 h to its reset: a banked reset can be applied now');
    expect(lines.at(-1)).toContain("apply it from the provider's own account page");
  });

  it('advises against applying below 100% or close to the weekly reset', () => {
    expect(bankedResetAdvice(row({ weekly: 64 }), NOW)[0]).toBe(
      '  not now: the week is at 64%; apply one only at 100%'
    );
    expect(bankedResetAdvice(row({ weekReset: NOW + BANKED_RESET_NEAR_WEEKLY_MS - HOUR }), NOW)[0]).toBe(
      '  not now: the week resets in 23 h anyway; keep the banked reset'
    );
    expect(bankedResetAdvice(row({ weekly: null }), NOW)[0]).toContain('current use is unknown');
  });

  it('warns when a banked reset is about to expire', () => {
    const soon = row({
      banked: { availableCount: 1, earliestExpiresAt: NOW + BANKED_RESET_EXPIRY_WARN_MS - 2 * HOUR },
    });
    expect(bankedResetAdvice(soon, NOW, 'UTC')[0]).toBe('  ! a banked reset expires in 70 h (Fri 6 Nov 04:00 UTC)');
    expect(bankedResetAdvice(row(), NOW).some((l) => l.includes('expires'))).toBe(false);
  });

  it('gives no timing advice from a stale reading: signed out, or a weekly reset already past', () => {
    const signedOut = { ...row(), signedIn: false };
    expect(bankedResetAdvice(signedOut, NOW)[0]).toContain('signed out: the last reading may be stale');
    expect(bankedResetAdvice(row({ weekReset: NOW - HOUR }), NOW)[0]).toContain('the recorded weekly reset has passed');
    // The expiry warning still shows: a reset expires whatever the reading says.
    const expiring = { ...signedOut, bankedResets: { availableCount: 1, earliestExpiresAt: NOW + 2 * HOUR } };
    expect(bankedResetAdvice(expiring, NOW)[0]).toContain('expires in 2 h');
  });

  it('says nothing without banked resets, when they are unknown, or for other providers', () => {
    expect(bankedResetAdvice(row({ banked: { availableCount: 0, earliestExpiresAt: null } }), NOW)).toEqual([]);
    expect(bankedResetAdvice(row({ banked: null }), NOW)).toEqual([]);
    expect(bankedResetAdvice(row({ provider: 'anthropic' }), NOW)).toEqual([]);
  });

  it('is printed by plans show after the account lines', async () => {
    const out: string[] = [];
    const deps: AgentDeps = {
      ctx: { apiUrl: 'http://x', selfId: 'self' },
      json: false,
      now: () => NOW,
      io: { out: (l) => out.push(l), err: (l) => out.push(l) },
      request: async () => ({
        status: 200,
        text: '',
        json: { success: true, data: { accounts: [row()], timeZone: 'UTC' } },
      }),
    };
    expect(await agentPlansShow(deps, { name: 'codex gmail' })).toBe(0);
    expect(out.some((l) => l.startsWith('  banked resets: 2'))).toBe(true);
    expect(out.at(-1)).toContain("provider's own account page");
  });
});
