/**
 * Which retired sessions may be pruned. A plan switch retires the old session (ChatroomService
 * `RetiredSession`); its terminal keeps running until the owner deletes it. This decides, without
 * touching anything, which of them an automatic prune may delete and why every other one stays.
 *
 * Checks, in order, first match wins:
 * 1. retention off: keep everything;
 * 2. the session is gone: only the record is left, so forget it;
 * 3. the owner pinned it: keep;
 * 4. its successor chain has no live end (the end is gone, stopped, or the chain is a cycle of retired
 *    sessions): keep, it may be the only working copy;
 * 5. it is the newest retired session of its seat (the most recent rollback): keep;
 * 6. retired less than the retention window ago: keep;
 * 7. otherwise prune, through the same path as the owner's Delete.
 *
 * A seat is the live session a successor chain ends in, so records retired by successive plan
 * switches of one employee group together without needing the employee binding of the old session.
 * A session restored and retired again gets a new record, so its window starts over.
 */

/** The fields of a retired-session record this policy reads. */
export interface RetiredRecord {
  readonly sessionId: string;
  readonly successorId: string;
  readonly at: number;
}

export interface RetentionSettings {
  /** Days a retired session is kept before it may be pruned; null turns automatic pruning off. */
  readonly days: number | null;
}

export interface RetentionInput {
  readonly retired: readonly RetiredRecord[];
  readonly now: number;
  readonly settings: RetentionSettings;
  readonly pinned: ReadonlySet<string>;
  /** Whether a session record exists, running or stopped. */
  exists(sessionId: string): boolean;
  /** Whether a session is running. */
  isRunning(sessionId: string): boolean;
}

export type KeepReason =
  | 'retention-off'
  | 'pinned'
  | 'chain-cycle'
  | 'successor-not-running'
  | 'newest-for-seat'
  | 'within-window';

export type RetentionDecision =
  | { readonly sessionId: string; readonly seat: string; readonly action: 'prune'; readonly reason: 'expired' }
  | { readonly sessionId: string; readonly seat: string; readonly action: 'forget'; readonly reason: 'session-gone' }
  | { readonly sessionId: string; readonly seat: string; readonly action: 'keep'; readonly reason: KeepReason };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The live session a successor chain ends in: the first successor that is not itself retired. */
export function seatOf(record: RetiredRecord, bySession: ReadonlyMap<string, RetiredRecord>): string {
  const seen = new Set<string>([record.sessionId]);
  let next = record.successorId;
  for (let hop = bySession.get(next); hop && !seen.has(hop.sessionId); hop = bySession.get(next)) {
    seen.add(hop.sessionId);
    next = hop.successorId;
  }
  return next;
}

/** One decision per retired record, in input order. */
export function decideRetention(input: RetentionInput): RetentionDecision[] {
  const bySession = new Map(input.retired.map((r) => [r.sessionId, r] as const));
  const seats = new Map(input.retired.map((r) => [r.sessionId, seatOf(r, bySession)] as const));
  const newest = new Map<string, RetiredRecord>();
  for (const r of input.retired) {
    if (!input.exists(r.sessionId)) continue;
    const seat = seats.get(r.sessionId)!;
    const best = newest.get(seat);
    if (!best || r.at > best.at || (r.at === best.at && r.sessionId > best.sessionId)) newest.set(seat, r);
  }
  const days = input.settings.days;
  return input.retired.map((r): RetentionDecision => {
    const seat = seats.get(r.sessionId)!;
    const keep = (reason: KeepReason): RetentionDecision => ({ sessionId: r.sessionId, seat, action: 'keep', reason });
    if (days === null || !(days >= 0)) return keep('retention-off');
    if (!input.exists(r.sessionId)) return { sessionId: r.sessionId, seat, action: 'forget', reason: 'session-gone' };
    if (input.pinned.has(r.sessionId)) return keep('pinned');
    // A cycle ends on a retired session, whose terminal still runs: that is no live end.
    if (bySession.has(seat)) return keep('chain-cycle');
    if (!input.isRunning(seat)) return keep('successor-not-running');
    if (newest.get(seat)?.sessionId === r.sessionId) return keep('newest-for-seat');
    if (input.now - r.at < days * DAY_MS) return keep('within-window');
    return { sessionId: r.sessionId, seat, action: 'prune', reason: 'expired' };
  });
}
