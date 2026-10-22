import type { Session } from './session.js';

/** Work evidence, rather than the display status, protects a runtime transaction. */
export function restartEligibility(
  session: Pick<
    Session,
    'isBusy' | 'isWorking' | 'runningTaskCount' | 'lastSubmitAt' | 'lastActivityAt' | 'paneDialog'
  >,
  now = Date.now()
): { blocked: boolean; recoverable: boolean } {
  const recent = (stamp: number, window: number) => !Number.isFinite(stamp) || (stamp > 0 && now - stamp < window);
  const busy = session.isBusy();
  const recentWork =
    recent(session.lastSubmitAt, 30_000) || ((busy || session.isWorking) && recent(session.lastActivityAt, 30_000));
  const running = session.runningTaskCount > 0;
  return {
    blocked: running || session.isWorking || recentWork || Boolean(session.paneDialog),
    // Owner confirmation can recover stale work detection, never a running task or recent activity.
    recoverable:
      busy &&
      !running &&
      !session.paneDialog &&
      !recent(session.lastSubmitAt, 120_000) &&
      !recent(session.lastActivityAt, 120_000),
  };
}
