import { describe, expect, it } from 'vitest';
import { decideRetention, seatOf, type RetentionInput, type RetiredRecord } from '../src/retired-retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

/** A seat that went a -> b -> c: a and b are retired, c is live. Plus an unrelated seat x -> y. */
function records(): RetiredRecord[] {
  return [
    { sessionId: 'a', successorId: 'b', at: NOW - 30 * DAY },
    { sessionId: 'b', successorId: 'c', at: NOW - 20 * DAY },
    { sessionId: 'x', successorId: 'y', at: NOW - 40 * DAY },
  ];
}

function input(over: Partial<RetentionInput> = {}): RetentionInput {
  const live = new Set(['a', 'b', 'c', 'x', 'y']);
  return {
    retired: records(),
    now: NOW,
    settings: { days: 7 },
    pinned: new Set(),
    exists: (id) => live.has(id),
    isRunning: (id) => live.has(id),
    ...over,
  };
}

const byId = (decisions: ReturnType<typeof decideRetention>) =>
  Object.fromEntries(decisions.map((d) => [d.sessionId, `${d.action}:${d.reason}`]));

describe('retired-session retention policy', () => {
  it('prunes an expired older rollback and keeps the newest one of each seat', () => {
    expect(byId(decideRetention(input()))).toEqual({
      a: 'prune:expired',
      b: 'keep:newest-for-seat',
      x: 'keep:newest-for-seat',
    });
  });

  it('groups a successor chain under the live session it ends in', () => {
    const map = new Map(records().map((r) => [r.sessionId, r]));
    expect(seatOf(records()[0], map)).toBe('c');
    expect(seatOf(records()[1], map)).toBe('c');
    expect(seatOf(records()[2], map)).toBe('y');
    expect(decideRetention(input()).map((d) => d.seat)).toEqual(['c', 'c', 'y']);
  });

  it('stops on a successor cycle instead of looping', () => {
    const cycle: RetiredRecord[] = [
      { sessionId: 'p', successorId: 'q', at: 1 },
      { sessionId: 'q', successorId: 'p', at: 2 },
    ];
    const map = new Map(cycle.map((r) => [r.sessionId, r]));
    expect(seatOf(cycle[0], map)).toBe('p');
    expect(seatOf(cycle[1], map)).toBe('q');
  });

  it('keeps everything when retention is off', () => {
    for (const days of [null, Number.NaN, -1]) {
      const decisions = decideRetention(input({ settings: { days } }));
      expect(decisions.every((d) => d.action === 'keep' && d.reason === 'retention-off')).toBe(true);
    }
    // Off means nothing automatic at all, not even forgetting the record of a session that is gone.
    const gone = decideRetention(input({ settings: { days: null }, exists: (id) => id !== 'a' }));
    expect(byId(gone).a).toBe('keep:retention-off');
  });

  it('forgets only the record of a session that is gone, and the newest live record stays the rollback', () => {
    const live = new Set(['a', 'c', 'x', 'y']);
    const decisions = byId(decideRetention(input({ exists: (id) => live.has(id), isRunning: (id) => live.has(id) })));
    expect(decisions).toEqual({ a: 'keep:newest-for-seat', b: 'forget:session-gone', x: 'keep:newest-for-seat' });
  });

  it('keeps a pinned session whatever its age', () => {
    expect(byId(decideRetention(input({ pinned: new Set(['a']) }))).a).toBe('keep:pinned');
  });

  it('never prunes while the live end of the chain is not running', () => {
    const running = new Set(['a', 'b', 'x', 'y']);
    const decisions = byId(decideRetention(input({ isRunning: (id) => running.has(id) })));
    expect(decisions.a).toBe('keep:successor-not-running');
    expect(decisions.b).toBe('keep:successor-not-running');
    expect(decisions.x).toBe('keep:newest-for-seat');
  });

  it('keeps an older rollback until it is a full window old', () => {
    const at = (age: number): RetiredRecord[] => [
      { sessionId: 'a', successorId: 'b', at: NOW - age },
      { sessionId: 'b', successorId: 'c', at: NOW - 1 },
    ];
    expect(byId(decideRetention(input({ retired: at(7 * DAY - 1) }))).a).toBe('keep:within-window');
    expect(byId(decideRetention(input({ retired: at(7 * DAY) }))).a).toBe('prune:expired');
    expect(byId(decideRetention(input({ retired: at(2), settings: { days: 0 } }))).a).toBe('prune:expired');
  });

  it('breaks a tie in retirement time by session id, so exactly one rollback is kept', () => {
    const tie: RetiredRecord[] = [
      { sessionId: 'm', successorId: 'z', at: NOW - 30 * DAY },
      { sessionId: 'n', successorId: 'z', at: NOW - 30 * DAY },
    ];
    const live = new Set(['m', 'n', 'z']);
    const decisions = decideRetention(input({ retired: tie, exists: (id) => live.has(id), isRunning: (id) => live.has(id) }));
    expect(decisions.filter((d) => d.action === 'keep').map((d) => d.sessionId)).toEqual(['n']);
    expect(decisions.filter((d) => d.action === 'prune').map((d) => d.sessionId)).toEqual(['m']);
  });

  it('returns one decision per record in input order and changes nothing it is given', () => {
    const given = records();
    const frozen = JSON.stringify(given);
    const decisions = decideRetention(input({ retired: given }));
    expect(decisions.map((d) => d.sessionId)).toEqual(['a', 'b', 'x']);
    expect(JSON.stringify(given)).toBe(frozen);
  });
});
