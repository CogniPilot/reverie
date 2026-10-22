/**
 * Tests for usage-limit pause detection (auto-resume on usage limit).
 *
 * Message corpus mirrors real Claude Code output observed across
 * 1.0.x–2.1.x (GitHub issues + official error docs). Time expectations are
 * computed with the same local-Date APIs the implementation uses, so the
 * tests are timezone-independent.
 */
import { describe, it, expect } from 'vitest';
import { detectUsageLimitPause } from '../src/usage-limit-patterns.js';

/** Fixed "now" for deterministic tests: a real timestamp, any value works. */
const NOW = new Date(2026, 5, 10, 14, 0, 0).getTime(); // local Jun 10 2026, 2:00pm

/** Expected epoch ms for the next local occurrence of hour:minute after NOW. */
function nextLocal(hour: number, minute = 0, from = NOW): number {
  const d = new Date(from);
  let ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
  if (ts <= from) ts += 24 * 60 * 60 * 1000;
  return ts;
}

describe('detectUsageLimitPause', () => {
  describe('era 2 footer forms (v1.0.109+, ∙ separator, no timezone)', () => {
    it.each([
      ['5-hour limit reached ∙ resets 8pm', 20, 0],
      ['Session limit reached ∙ resets 8pm', 20, 0],
      ['Weekly limit reached ∙ resets 6pm', 18, 0],
      ['5-hour limit reached ∙ resets 10:30pm', 22, 30],
      ['5-hour limit reached ∙ resets 3am', 3, 0],
      ['5-hour limit reached ∙ resets 12am', 0, 0],
      ['5-hour limit reached ∙ resets 12pm', 12, 0],
    ])('parses "%s"', (msg, hour, minute) => {
      const det = detectUsageLimitPause(msg, NOW);
      expect(det).not.toBeNull();
      expect(det!.resetAt).toBe(nextLocal(hour, minute));
    });

    it('rolls over to tomorrow when the time already passed today', () => {
      // NOW is 2:00pm local; "resets 9am" must be tomorrow 9am
      const det = detectUsageLimitPause('5-hour limit reached ∙ resets 9am', NOW);
      expect(det!.resetAt).toBe(nextLocal(9, 0));
      expect(det!.resetAt).toBeGreaterThan(NOW);
    });
  });

  describe('era 3 forms (v2.0.55+, · separator, IANA timezone, action hints)', () => {
    it('parses with timezone and /upgrade suffix', () => {
      const det = detectUsageLimitPause(
        '5-hour limit reached · resets 3pm (Europe/Stockholm) · /upgrade to Max 20x or turn on /extra-usage',
        NOW
      );
      expect(det).not.toBeNull();
      // 3pm in Stockholm (UTC+2 in June) = 13:00 UTC
      const d = new Date(det!.resetAt);
      expect(d.getUTCHours()).toBe(13);
      expect(det!.resetAt).toBeGreaterThan(NOW);
    });

    it('parses generic "Limit reached" with minutes and timezone', () => {
      const det = detectUsageLimitPause(
        'Limit reached · resets 11:30am (Asia/Calcutta) · /upgrade to Max or turn on /extra-usage',
        NOW
      );
      expect(det).not.toBeNull();
      // 11:30am IST (UTC+5:30) = 06:00 UTC
      const d = new Date(det!.resetAt);
      expect(d.getUTCHours()).toBe(6);
      expect(d.getUTCMinutes()).toBe(0);
    });

    it('falls back to local time for unresolvable timezone (Etc/Unknown)', () => {
      const det = detectUsageLimitPause('Limit reached · resets 5pm (Etc/Unknown)', NOW);
      expect(det).not.toBeNull();
      expect(det!.resetAt).toBe(nextLocal(17, 0));
    });

    it('parses weekly date form "Dec 2, 7pm"', () => {
      const det = detectUsageLimitPause('Weekly limit reached · resets Dec 2, 7pm (Europe/Moscow) ·', NOW);
      // Dec 2 is >8 days from Jun 10 → implausible horizon → rejected
      expect(det).toBeNull();
    });

    it('parses near-future date form within the horizon', () => {
      const det = detectUsageLimitPause('Weekly limit reached ∙ resets Jun 15, 1pm', NOW);
      expect(det).not.toBeNull();
      const expected = new Date(2026, 5, 15, 13, 0).getTime();
      expect(det!.resetAt).toBe(expected);
    });

    it('parses malformed separator-less render', () => {
      const det = detectUsageLimitPause('Limit reached resets 1:30pm (Asia/Calcutta) ·', NOW);
      expect(det).not.toBeNull();
    });
  });

  describe('era 4 forms (v2.1.x, "You\'ve hit your limit")', () => {
    it.each([
      ["You've hit your limit · resets 1:40pm (UTC)", 13, 40],
      ["You've hit your session limit · resets 3:45pm", 15, 45],
      ["You've hit your Opus limit · resets 3:45pm", 15, 45],
    ])('parses "%s"', (msg) => {
      const det = detectUsageLimitPause(msg, NOW);
      expect(det).not.toBeNull();
      expect(det!.resetAt).toBeGreaterThan(NOW);
    });

    it('parses day-of-week form "resets Mon 12:00am"', () => {
      const det = detectUsageLimitPause("You've hit your weekly limit · resets Mon 12:00am", NOW);
      expect(det).not.toBeNull();
      const d = new Date(det!.resetAt);
      expect(d.getDay()).toBe(1); // Monday
      expect(d.getHours()).toBe(0);
      expect(det!.resetAt).toBeGreaterThan(NOW);
      expect(det!.resetAt).toBeLessThanOrEqual(NOW + 8 * 24 * 60 * 60 * 1000);
    });

    it('parses "May 5 at 9pm" date-with-at form (next-year rollover)', () => {
      // NOW is Jun 10 2026 — "May 5" is >2 days past → next year → beyond horizon → null
      const det = detectUsageLimitPause("You've hit your limit · resets May 5 at 9pm (UTC)", NOW);
      expect(det).toBeNull();
    });

    it('parses "Jun 12 at 9pm" date-with-at form within horizon', () => {
      const det = detectUsageLimitPause("You've hit your limit · resets Jun 12 at 9pm", NOW);
      expect(det).not.toBeNull();
      expect(det!.resetAt).toBe(new Date(2026, 5, 12, 21, 0).getTime());
    });

    it('parses extra-usage form "You\'re out of extra usage"', () => {
      const det = detectUsageLimitPause("You're out of extra usage · resets 1pm (UTC)", NOW);
      expect(det).not.toBeNull();
      const d = new Date(det!.resetAt);
      expect(d.getUTCHours()).toBe(13);
    });
  });

  describe('era 1 inline form (v1.0.x)', () => {
    it('parses "Your limit will reset at 2pm (America/New_York)"', () => {
      const det = detectUsageLimitPause(
        'Claude usage limit reached. Your limit will reset at 2pm (America/New_York)',
        NOW
      );
      expect(det).not.toBeNull();
      // 2pm EDT (UTC-4 in June) = 18:00 UTC
      expect(new Date(det!.resetAt).getUTCHours()).toBe(18);
    });
  });

  describe('raw API epoch form', () => {
    it('parses "Claude AI usage limit reached|<epoch>"', () => {
      const epoch = Math.floor(NOW / 1000) + 3600; // resets in 1h
      const det = detectUsageLimitPause(`Claude AI usage limit reached|${epoch}`, NOW);
      expect(det).not.toBeNull();
      expect(det!.resetAt).toBe(epoch * 1000);
    });

    it('returns past epoch as-is (stale message → caller retries soon)', () => {
      const epoch = Math.floor(NOW / 1000) - 600;
      const det = detectUsageLimitPause(`Claude AI usage limit reached|${epoch}`, NOW);
      expect(det).not.toBeNull();
      expect(det!.resetAt).toBeLessThan(NOW);
    });
  });

  describe('transcript and multi-line contexts', () => {
    it('detects the ⎿-prefixed transcript echo', () => {
      const det = detectUsageLimitPause(
        "⎿  You've hit your limit · resets 6pm (Asia/Bangkok)\n   /upgrade to increase your usage limit.",
        NOW
      );
      expect(det).not.toBeNull();
    });

    it('returns the LAST parseable occurrence in a chunk', () => {
      const chunk = [
        '5-hour limit reached ∙ resets 3pm',
        'some scrollback text',
        '5-hour limit reached ∙ resets 5pm',
      ].join('\n');
      const det = detectUsageLimitPause(chunk, NOW);
      expect(det!.resetAt).toBe(nextLocal(17, 0));
    });
  });

  describe('false-positive guards', () => {
    it.each([
      'the rate limit reached in tests was 30/min',
      'limit reached',
      'Usage limit reached', // bare banner: no reset time → not actionable
      'we reset at dawn',
      'resets 3pm', // time without a limit phrase
      'The speed limit reached 120 km/h before it resets',
      '5-hour limit reached ∙ resets 25pm', // invalid hour
      'limit reached ∙ resets 99:99pm',
    ])('ignores "%s"', (msg) => {
      expect(detectUsageLimitPause(msg, NOW)).toBeNull();
    });

    it('ignores empty and irrelevant data', () => {
      expect(detectUsageLimitPause('', NOW)).toBeNull();
      expect(detectUsageLimitPause('compiling project...', NOW)).toBeNull();
    });

    it('requires the reset time within the window after the phrase', () => {
      const farApart = 'limit reached' + ' x'.repeat(200) + ' resets 3pm';
      expect(detectUsageLimitPause(farApart, NOW)).toBeNull();
    });
  });
});
