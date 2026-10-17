/**
 * Plan pacing: elapsed week, pace, burn rate, projection, recommendation and the
 * account suggestion, with time as a parameter.
 */
import { describe, expect, it } from 'vitest';
import { addSample, burnRate, planPace, recommend, suggestAccount, WEEK_MS } from '../src/plan-pace.js';

const H = 3600 * 1000;
const RESET = Date.UTC(2026, 9, 20, 0, 0, 0);
const START = RESET - WEEK_MS;

describe('planPace', () => {
  it('computes elapsed, pace, burn and projection for an account half way through its week', () => {
    const now = START + WEEK_MS / 2; // 50 % elapsed
    const p = planPace({
      signedIn: true,
      fiveHour: { usedPercentage: 20, resetAt: now + 2 * H },
      sevenDay: { usedPercentage: 30, resetAt: RESET },
      samples: [
        { at: now - 6 * H, weekly: 24 },
        { at: now - 3 * H, weekly: 27 },
        { at: now, weekly: 30 },
      ],
      now,
    });
    expect(p.weekStart).toBe(START);
    expect(p.elapsed).toBe(50);
    expect(p.pace).toBe(-20);
    expect(p.burnPerHour).toBe(1);
    expect(p.projected).toBe(30 + 84); // 84 h left at 1 %/h
    expect(p.recommendation).toBe('push');
  });

  it('accepts reset times in epoch seconds or ISO text', () => {
    const now = START + WEEK_MS / 4;
    expect(planPace({ signedIn: true, sevenDay: { usedPercentage: 10, resetAt: RESET / 1000 }, now }).elapsed).toBe(25);
    expect(
      planPace({ signedIn: true, sevenDay: { usedPercentage: 10, resetAt: new Date(RESET).toISOString() }, now })
        .elapsed
    ).toBe(25);
  });

  it('projects from the average so far when there is no recent history', () => {
    const now = START + 24 * H;
    const p = planPace({ signedIn: true, sevenDay: { usedPercentage: 12, resetAt: RESET }, now });
    expect(p.burnPerHour).toBeNull();
    expect(p.projected).toBe(84); // 0.5 %/h over 168 h
    expect(p.runsOutAt).toBeNull(); // stays under 100 %
  });

  it('says when the week runs out if usage would pass 100 % before the reset', () => {
    const now = START + 10 * H; // 30 % used in 10 h: 3 %/h
    const p = planPace({ signedIn: true, sevenDay: { usedPercentage: 30, resetAt: RESET }, now });
    expect(p.projected).toBeGreaterThan(100);
    expect(p.runsOutAt).toBe(now + (70 / 3) * H);
  });

  it('gives no pace without a weekly reading', () => {
    const p = planPace({ signedIn: true, fiveHour: { usedPercentage: 40, resetAt: START }, now: START });
    expect(p.pace).toBeNull();
    expect(p.recommendation).toBe('steady');
  });
});

describe('recommend', () => {
  it('stops at a nearly full 5-hour window or a spent week, whatever the pace', () => {
    expect(recommend({ signedIn: true, fiveHour: 95, weekly: 10, pace: -40 })).toBe('stop');
    expect(recommend({ signedIn: true, fiveHour: 10, weekly: 100, pace: 0 })).toBe('stop');
  });
  it('pushes below -15, eases above +15, steadies between', () => {
    expect(recommend({ signedIn: true, fiveHour: 5, weekly: 10, pace: -15.1 })).toBe('push');
    expect(recommend({ signedIn: true, fiveHour: 5, weekly: 60, pace: 15.1 })).toBe('ease');
    expect(recommend({ signedIn: true, fiveHour: 5, weekly: 40, pace: -15 })).toBe('steady');
    expect(recommend({ signedIn: true, fiveHour: 5, weekly: 40, pace: 15 })).toBe('steady');
  });
  it('asks for a login when signed out, and says unknown with no readings', () => {
    expect(recommend({ signedIn: false, fiveHour: null, weekly: null, pace: null })).toBe('login');
    expect(recommend({ signedIn: true, fiveHour: null, weekly: null, pace: null })).toBe('unknown');
  });
});

describe('burnRate', () => {
  it('ignores samples from before the window started (a reset) and too-short spans', () => {
    const now = START + 2 * H;
    expect(
      burnRate(
        [
          { at: START - 2 * H, weekly: 90 },
          { at: START + H, weekly: 2 },
          { at: now, weekly: 4 },
        ],
        now,
        START
      )
    ).toBe(2);
    expect(
      burnRate(
        [
          { at: now - 5 * 60 * 1000, weekly: 1 },
          { at: now, weekly: 2 },
        ],
        now,
        START
      )
    ).toBeNull();
  });
});

describe('suggestAccount', () => {
  const row = (id: string, provider: string, pace: number, rec = 'steady', signedIn = true, fiveHour = 10) => ({
    id,
    provider,
    signedIn,
    pace: { pace, fiveHour, recommendation: rec } as never,
  });
  it('picks the signed-in account of that provider with the most headroom, never one told to stop', () => {
    const rows = [
      row('busy', 'anthropic', 20, 'ease'),
      row('fresh', 'anthropic', -30, 'push'),
      row('spent', 'anthropic', -60, 'stop'),
      row('out', 'anthropic', -90, 'login', false),
      row('codex', 'openai', -80, 'push'),
    ];
    expect(suggestAccount(rows, 'anthropic')?.id).toBe('fresh');
    expect(suggestAccount(rows, 'openai')?.id).toBe('codex');
    expect(suggestAccount([row('only', 'anthropic', 0, 'stop')], 'anthropic')).toBeNull();
  });
});

describe('addSample', () => {
  it('keeps one sample per 5 minutes and 8 days of history', () => {
    let s = addSample([], { at: 0, weekly: 1 });
    s = addSample(s, { at: 60_000, weekly: 2 });
    expect(s).toEqual([{ at: 60_000, weekly: 2 }]);
    s = addSample(s, { at: 10 * 60_000, weekly: 3 });
    expect(s).toHaveLength(2);
    s = addSample(s, { at: 9 * 24 * H, weekly: 5 });
    expect(s).toEqual([{ at: 9 * 24 * H, weekly: 5 }]);
  });
});
