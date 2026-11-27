/**
 * The repair ladder after an adversarial review: what the review found, each as a test that failed before its fix.
 * Policy rules first, then the driver's office-wide rules.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUPERVISOR_HISTORY,
  assessEmployee,
  classifyEmployee,
  issueSupervisorAttempt,
  resumeSupervisorHistory,
  rollSupervisorHistory,
  type SupervisorAction,
  type SupervisorFlags,
  type SupervisorHistory,
  type SupervisorObservation,
} from '../src/employee-supervisor-policy.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ON: SupervisorFlags = { enabled: true, autoRepair: true, relaunchAvailable: false };

type Patch = {
  [K in keyof SupervisorObservation]?: SupervisorObservation[K] extends object | undefined
    ? Partial<SupervisorObservation[K]>
    : SupervisorObservation[K];
};
/** A boxed employee who is running normally; each case overrides what it is about. */
function observed(patch: Patch = {}): SupervisorObservation {
  const base: SupervisorObservation = {
    employeeId: 'e1',
    name: 'Stan',
    desiredRunning: true,
    onVacation: false,
    bindingMigration: false,
    boxed: true,
    session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', providerHealth: 'healthy' },
    laptop: {
      record: { phase: 'ready', version: 2, operationId: 'op-1' },
      bound: true,
      policyApproved: true,
      restoration: { state: 'attached' },
      templateOnRecord: true,
      poolAlive: true,
    },
  };
  return {
    ...base,
    ...patch,
    session: { ...base.session, ...patch.session },
    laptop: { ...base.laptop, ...patch.laptop },
  } as SupervisorObservation;
}
/** The laptop's own read says it is held at `code`; the office terminal is not attached. */
const held = (code: string, extra: Partial<NonNullable<SupervisorObservation['laptop']['continuation']>> = {}) =>
  observed({
    session: { available: false, viewerHealth: 'disconnected', providerHealth: 'unknown' },
    laptop: {
      record: { phase: 'resources-issued', version: 2, operationId: 'op-1' },
      restoration: { state: 'held', code: 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING' },
      continuation: { state: 'held', phase: 'resources-issued', code, allowedActions: ['observe'], ...extra },
    },
  });
const withLaptop = (base: SupervisorObservation, laptop: Patch['laptop'], session: Patch['session'] = {}) =>
  ({ ...base, session: { ...base.session, ...session }, laptop: { ...base.laptop, ...laptop } }) as SupervisorObservation;
const since = (at: number, fingerprint: string, patch: Partial<SupervisorHistory> = {}): SupervisorHistory => ({
  ...EMPTY_SUPERVISOR_HISTORY,
  fingerprint,
  since: at,
  ...patch,
});
const tried = (action: SupervisorAction, count: number, lastAt: number) => ({ [action]: { count, lastAt } });
/** One observation every thirty seconds from `from` up to, not including, `to`. */
const watch = (history: SupervisorHistory, seen: SupervisorObservation, from: number, to: number) => {
  for (let now = from; now < to; now += 30_000) history = rollSupervisorHistory(history, classifyEmployee(seen), now);
  return history;
};
type Assessment = ReturnType<typeof assessEmployee>;
/** How long after `from` the first pass comes at which `hit` holds, while `seen` is observed every thirty seconds. */
const until = (
  history: SupervisorHistory,
  seen: SupervisorObservation,
  from: number,
  hit: (result: Assessment) => boolean,
  limit = 12 * HOUR
) => {
  for (let now = from; now < from + limit; now += 30_000) {
    history = rollSupervisorHistory(history, classifyEmployee(seen), now);
    if (hit(assessEmployee(seen, history, ON, now))) return now - from;
  }
  return undefined;
};
const rebuilds = (result: Assessment) => result.next.action === 'rebuild-laptop';
const T = 1000;
void [held, withLaptop, since, tried, watch, until, rebuilds, T, HOUR];

describe('a step that an office restart interrupted', () => {
  const FAILED = 'code:DOCKER_RESOURCE_HELPER_FAILED';

  it('is settled as failed at the next office start, so nothing waits for its outcome for ever', () => {
    const issued = issueSupervisorAttempt(since(T, 'screen:sign-in'), 'replace-sign-in', T + MINUTE);
    expect(issued.lastAction).toMatchObject({ action: 'replace-sign-in', outcome: 'issued' });
    const resumed = resumeSupervisorHistory(issued);
    expect(resumed.lastAction).toEqual({
      action: 'replace-sign-in',
      at: T + MINUTE,
      outcome: 'failed',
      detail: 'interrupted by an office restart',
    });
    // The attempt stays spent: a restart never gives a step back for free.
    expect(resumed.attempts['replace-sign-in']).toEqual({ count: 1, lastAt: T + MINUTE });
  });

  it('counts an interrupted rebuild against the limit per day: it may have been carried out', () => {
    const issued = issueSupervisorAttempt(since(T, FAILED, { rebuilds: [T + 5 * MINUTE] }), 'rebuild-laptop', T + HOUR);
    const resumed = resumeSupervisorHistory(issued);
    expect(resumed.rebuilds).toEqual([T + 5 * MINUTE, T + HOUR]);
    expect(resumed.lastAction).toMatchObject({ action: 'rebuild-laptop', outcome: 'failed' });
    // Two today: the next one waits for the day to pass.
    const empty = withLaptop(held('DOCKER_RESOURCE_HELPER_FAILED'), { provider: 'exited' });
    const next = rollSupervisorHistory(resumed, classifyEmployee(empty), T + 2 * HOUR);
    expect(assessEmployee(empty, next, ON, T + 2 * HOUR).next).toMatchObject({
      action: null,
      waitingFor: expect.stringMatching(/^the daily limit on rebuilds of one laptop \(2\)/),
    });
  });

  it('leaves a step that had returned, and a rebuild that is never counted, as they were', () => {
    const done = { ...since(T, FAILED), lastAction: { action: 'rebuild-laptop' as const, at: T + HOUR, outcome: 'done' as const } };
    expect(resumeSupervisorHistory(done)).toEqual(done);
    const uncounted = issueSupervisorAttempt(since(T, FAILED), 'rebuild-laptop', T + HOUR, true);
    expect(resumeSupervisorHistory(uncounted).rebuilds).toEqual([]);
    expect(resumeSupervisorHistory(uncounted).lastAction).toMatchObject({ outcome: 'failed', uncounted: true });
  });
});
