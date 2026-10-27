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
    expect(p.fiveHourReset).toBe(now + 2 * H);
    expect(p.weekStart).toBe(START);
    expect(p.elapsed).toBe(50);
    expect(p.pace).toBe(-20);
    expect(p.burnPerHour).toBe(1);
    expect(p.projected).toBe(30 + 84); // 84 h left at 1 %/h
    expect(p.recommendation).toBe('push');
  });

  it('retains only actual five-hour reset metadata and does not derive five-hour history from weekly samples', () => {
    const now = START + H;
    for (const resetAt of [RESET, RESET / 1000, new Date(RESET).toISOString()]) {
      expect(planPace({ signedIn: true, fiveHour: { usedPercentage: 0, resetAt }, now })).toMatchObject({ fiveHour: 0, fiveHourReset: RESET });
    }
    expect(planPace({ signedIn: true, sevenDay: { usedPercentage: 60, resetAt: RESET }, now }).fiveHourReset).toBeNull();
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

describe('burn rate needs an hour of readings from one period', () => {
  const now = START + 40 * H;
  it('gives no rate from two readings minutes apart, however far apart their values are (27% then 61%)', () => {
    const samples = [
      { at: now - 12 * 60 * 1000, weekly: 27 },
      { at: now, weekly: 61 },
    ];
    expect(burnRate(samples, now, START, RESET)).toBeNull();
    const p = planPace({ signedIn: true, sevenDay: { usedPercentage: 61, resetAt: RESET }, samples, now });
    expect(p.burnPerHour).toBeNull();
    expect(p.burnBasis).toBe('average');
    expect(p.runsOutAt === null || p.runsOutAt > now + 24 * H).toBe(true);
  });

  it('gives a rate from an hour or more of readings', () => {
    expect(burnRate([{ at: now - H, weekly: 50 }, { at: now, weekly: 51 }], now, START, RESET)).toBe(1);
  });

  it('ignores readings that belong to another weekly period (another account misfiled here)', () => {
    const other = RESET - 2 * 24 * H;
    const samples = [
      { at: now - 3 * H, weekly: 25, resetAt: other },
      { at: now - H, weekly: 59, resetAt: RESET },
      { at: now, weekly: 60, resetAt: RESET },
    ];
    expect(burnRate(samples, now, START, RESET)).toBe(1);
    // Readings saved before resets were recorded still count.
    expect(burnRate([{ at: now - 2 * H, weekly: 10 }, { at: now, weekly: 12 }], now, START, RESET)).toBe(1);
  });

  it('uses only the run after the last drop: 59, 27, 61, 62 over 3 h gives the 61 to 62 run, or null under an hour', () => {
    const samples = [
      { at: now - 3 * H, weekly: 59 },
      { at: now - 2 * H, weekly: 27 },
      { at: now - H, weekly: 61 },
      { at: now, weekly: 62 },
    ];
    expect(burnRate(samples, now, START, RESET)).toBe(1);
    const short = [
      { at: now - 3 * H, weekly: 59 },
      { at: now - 90 * 60 * 1000, weekly: 27 },
      { at: now - 40 * 60 * 1000, weekly: 61 },
      { at: now, weekly: 62 },
    ];
    expect(burnRate(short, now, START, RESET)).toBeNull();
  });

  it('skips samples marked misattributed, and fits a slope so one noisy reading cannot swing the rate', () => {
    const marked = [
      { at: now - 3 * H, weekly: 27, misattributed: true },
      { at: now - 2 * H, weekly: 60 },
      { at: now, weekly: 62 },
    ];
    expect(burnRate(marked, now, START, RESET)).toBe(1);
    const noisy = [0, 1, 2, 3, 4].map((i) => ({ at: now - (4 - i) * H, weekly: 50 + i + (i === 4 ? 2 : 0) }));
    // first-to-last would say 1.5/h; the fit over the five readings says 1.4.
    expect(burnRate(noisy, now, START, RESET)).toBe(1.4);
  });

  it('says there is no basis early in the week instead of extrapolating the first hours', () => {
    const early = START + 3 * H;
    const p = planPace({ signedIn: true, sevenDay: { usedPercentage: 9, resetAt: RESET }, samples: [], now: early });
    expect(p.burnBasis).toBeNull();
    expect(p.projected).toBeNull();
    expect(p.runsOutAt).toBeNull();
  });

  it('reports what is left, the hours to the reset and the steady rate that spends exactly the rest', () => {
    const p = planPace({ signedIn: true, sevenDay: { usedPercentage: 61, resetAt: RESET }, samples: [], now });
    expect(p.remainingPct).toBe(39);
    expect(p.hoursToReset).toBe(128);
    expect(p.sustainablePctPerHour).toBe(0.3);
    const over = planPace({ signedIn: true, sevenDay: { usedPercentage: 104, resetAt: RESET }, samples: [], now });
    expect(over.remainingPct).toBe(0);
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

describe('banked credit cutoff', () => {
  it.each([5, 9])('uses the earlier future credit expiry or weekly reset (%i days)', (days) => {
    const now = START + 24 * H;
    const p = planPace({ signedIn: true, sevenDay: { usedPercentage: 20, resetAt: RESET }, now,
      bankedResets: { availableCount: 2, earliestExpiresAt: START + days * 24 * H },
      samples: [{ at: now - 2 * H, weekly: 18 }, { at: now, weekly: 20 }] });
    const stop = Math.min(RESET, START + days * 24 * H);
    expect(p.weekReset).toBe(RESET);
    expect(p.budgetStop).toBe(stop);
    expect(p.hoursToReset).toBe((stop - now) / H);
    expect(p.projected).toBe(20 + (stop - now) / H);
  });
  it.each([null, NaN, 0, START])('ignores unavailable or expired credit expiry %s', (expiry) => {
    const p = planPace({ signedIn: true, sevenDay: { usedPercentage: 20, resetAt: RESET }, now: START + H,
      bankedResets: { availableCount: 1, earliestExpiresAt: expiry } });
    expect(p.budgetStop).toBe(RESET);
  });
});
