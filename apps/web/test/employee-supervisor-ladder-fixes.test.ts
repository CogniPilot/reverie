/**
 * The repair ladder after an adversarial review: what the review found, each as a test that failed before its fix.
 * Policy rules first, then the driver's office-wide rules.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SUPERVISOR_HISTORY,
  SUPERVISOR_POLICY,
  assessEmployee,
  classifyEmployee,
  issueSupervisorAttempt,
  resumeSupervisorHistory,
  rollSupervisorHistory,
  sightEmployee,
  supervisorCodeKind,
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
  hit: (result: Assessment, now: number) => boolean,
  limit = 12 * HOUR
) => {
  for (let now = from; now < from + limit; now += 30_000) {
    history = rollSupervisorHistory(history, classifyEmployee(seen), now);
    if (hit(assessEmployee(seen, history, ON, now), now)) return now - from;
  }
  return undefined;
};
/** The rebuild is the step to take, and it is due. */
const rebuilds = (result: Assessment, now: number) =>
  result.next.action === 'rebuild-laptop' && (result.next.at ?? 0) <= now;
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

describe('a laptop whose own read says it is ready, with an agent running in it', () => {
  /** The office's last attach attempt is stuck on `code`; the read made now says ready; the pane is attached and idle. */
  const contradicted = (code: string, session: Patch['session'] = {}) =>
    observed({
      session: { turn: 'idle', idleSince: 0, ...session },
      laptop: {
        restoration: { state: 'held', code },
        continuation: { state: 'ready', phase: 'ready', allowedActions: ['observe'] },
        provider: 'running',
      },
    });

  it.each([
    ['a wait code', 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING'],
    ['a code that says the agent could not be verified', 'DOCKER_CONTINUATION_EXISTING_PROVIDER_UNCONFIRMED'],
    ['a code that says the laptop is stopped', 'DOCKER_CONTINUATION_DESTINATION_STOPPED'],
    ['a code the table does not list', 'DOCKER_SOMETHING_NOBODY_LISTED'],
  ])('is never rebuilt for the office’s older attach report, stuck on %s: the terminal is what is wrong', (_title, code) => {
    const seen = contradicted(code);
    expect(classifyEmployee(seen)).toMatchObject({ condition: 'viewer-lost', code });
    expect(until(EMPTY_SUPERVISOR_HISTORY, seen, T, rebuilds)).toBeUndefined();
    // What is tried is the step that discards nothing.
    expect(until(EMPTY_SUPERVISOR_HISTORY, seen, T, (result) => result.next.action === 'reconnect-viewer')).toBe(0);
  });

  it('is not rebuilt because a health report calls the agent dead while the read finds it running', () => {
    const dead = observed({
      session: { providerHealth: 'dead', turn: 'idle', idleSince: 0 },
      laptop: { continuation: { state: 'ready', phase: 'ready', allowedActions: ['observe'] }, provider: 'running' },
    });
    expect(classifyEmployee(dead).condition).toBe('provider-exited');
    expect(until(EMPTY_SUPERVISOR_HISTORY, dead, T, rebuilds)).toBeUndefined();
    const waiting = assessEmployee(dead, watch(EMPTY_SUPERVISOR_HISTORY, dead, T, T + HOUR), ON, T + HOUR);
    expect(waiting.next).toMatchObject({
      action: null,
      waitingFor: expect.stringMatching(/the laptop's own read says it is ready and an agent runs in it/),
    });
    expect(waiting.needsHuman).toBeUndefined();
    // Once the read inside the laptop agrees that no agent runs, nothing is lost and it is rebuilt.
    expect(until(EMPTY_SUPERVISOR_HISTORY, withLaptop(dead, { provider: 'exited' }), T, rebuilds)).toBe(3 * MINUTE);
  });

  it('is not rebuilt on a rebuild read alone, with no read of the laptop that says it is held', () => {
    // A laptop of this employee runs, and nothing the laptop itself reported says it is held.
    const unread = observed({
      session: { available: false, turn: 'idle', idleSince: 0 },
      laptop: { record: null, bound: false, restoration: undefined, source: 'running', provider: 'running' },
    });
    expect(classifyEmployee(unread)).toMatchObject({ condition: 'held-needs-rebuild', code: 'no-laptop' });
    expect(until(EMPTY_SUPERVISOR_HISTORY, unread, T, rebuilds)).toBeUndefined();
  });

  it('keeps the two exceptions: a held terminal input and an agent parked on a start-up screen', () => {
    const heldInput = contradicted('DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED', { inputHeld: true });
    const refused: SupervisorHistory = {
      ...since(T, classifyEmployee(heldInput).fingerprint, { attempts: tried('reconnect-viewer', 1, T + 45_000) }),
      lastAction: { action: 'reconnect-viewer', at: T + 45_000, outcome: 'refused' },
    };
    expect(assessEmployee(heldInput, refused, ON, T + 10 * MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['terminal-input-held'],
    });
    const parked = observed({
      session: {
        turn: 'idle',
        idleSince: 0,
        startupScreen: { label: 'a chooser', kind: 'first-run', answering: false, proof: 'widget' },
      },
      laptop: { continuation: { state: 'ready', phase: 'ready', allowedActions: ['observe'] }, provider: 'running' },
    } as Patch);
    expect(until(EMPTY_SUPERVISOR_HISTORY, parked, T, rebuilds)).toBeDefined();
  });
});

describe('a laptop that reports a code while an agent runs in it', () => {
  /** An agent runs in the held laptop; the office terminal is attached and has shown the pane idle for a long time. */
  const reachable = (seen: SupervisorObservation) => withLaptop(seen, { provider: 'running' }, { turn: 'idle', idleSince: 0 });
  /** The same, with no reading of the pane at all. */
  const unreachable = (seen: SupervisorObservation) => withLaptop(seen, { provider: 'running' });

  it('is rebuilt between turns for a code the table lists as settled by a rebuild', () => {
    for (const code of ['DOCKER_RESOURCE_HELPER_FAILED', 'DOCKER_CONTINUATION_FOREIGN_PROVIDER'])
      expect([code, until(EMPTY_SUPERVISOR_HISTORY, reachable(held(code)), T, rebuilds)]).toEqual([code, 3 * MINUTE]);
  });

  it('is rebuilt for a code the table does not list only when the laptop’s own read reports it, after thirty minutes', () => {
    const own = reachable(held('DOCKER_SOMETHING_NOBODY_LISTED'));
    expect(until(EMPTY_SUPERVISOR_HISTORY, own, T, rebuilds)).toBe(30 * MINUTE);
    // The same code in the office's attach report, with no read of the laptop that bears it out: never.
    const reported = observed({
      session: { available: false, turn: 'idle', idleSince: 0 },
      laptop: { restoration: { state: 'held', code: 'DOCKER_SOMETHING_NOBODY_LISTED' }, provider: 'running' },
    });
    expect(classifyEmployee(reported)).toMatchObject({ code: 'DOCKER_SOMETHING_NOBODY_LISTED' });
    expect(until(EMPTY_SUPERVISOR_HISTORY, reported, T, rebuilds)).toBeUndefined();
  });

  const others: Array<[string, SupervisorObservation]> = [
    ['a step to send again', held('DOCKER_RESOURCE_HELPER_RETRY_EXHAUSTED')],
    ['an agent that is not confirmed', held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED')],
    ['a read that never succeeds', held('DOCKER_CONTINUATION_UNCONFIRMED')],
    [
      'a set-up that stopped between two steps',
      observed({
        session: { available: false },
        laptop: {
          record: { phase: 'pool-ready', version: 2, operationId: 'op-1' },
          continuation: { state: 'pending', phase: 'pool-ready', allowedActions: ['observe'] },
        },
      }),
    ],
  ];

  it.each(others)('is never rebuilt for %s while the office can reach its agent', (_title, seen) => {
    expect(until(EMPTY_SUPERVISOR_HISTORY, reachable(seen), T, rebuilds)).toBeUndefined();
    const history = watch(EMPTY_SUPERVISOR_HISTORY, reachable(seen), T, T + 3 * HOUR);
    const waiting = assessEmployee(reachable(seen), history, ON, T + 3 * HOUR);
    expect(waiting.next.action).toBeNull();
    expect(waiting.needsHuman).toBeUndefined();
    // A turn in progress changes nothing about that.
    const working = withLaptop(seen, { provider: 'running' }, { turn: 'working' });
    expect(until(EMPTY_SUPERVISOR_HISTORY, working, T, rebuilds)).toBeUndefined();
  });

  it.each(others)('is rebuilt for %s only after two hours in which the office had no reading of its pane', (_title, seen) => {
    const after = until(EMPTY_SUPERVISOR_HISTORY, unreachable(seen), T, rebuilds)!;
    expect(after).toBeGreaterThanOrEqual(2 * HOUR);
    expect(after).toBeLessThanOrEqual(2 * HOUR + 15 * MINUTE);
  });

  it('says why a laptop the office can reach is kept', () => {
    const seen = reachable(held('DOCKER_RESOURCE_HELPER_RETRY_EXHAUSTED'));
    const history = watch(EMPTY_SUPERVISOR_HISTORY, seen, T, T + HOUR);
    expect(assessEmployee(seen, history, ON, T + HOUR).next.waitingFor).toMatch(
      /its agent runs and the office can reach it.*so the laptop is kept$/
    );
  });

  it('reads plainly transient results of a read as waits, not as codes it does not know', () => {
    for (const code of [
      'DOCKER_RESOURCE_OBSERVATION_CHANGED',
      'DOCKER_RESOURCE_MEMBERS_CHANGED',
      'DOCKER_RESOURCE_MEMBERS_UNKNOWN',
      'DOCKER_RESOURCE_LEAF_CENSUS_CHANGED',
      'DOCKER_RESOURCE_CONTAINER_UNKNOWN',
      'DOCKER_RESOURCE_PROBE_PROCESS_EXITED',
      'DOCKER_CONTINUATION_CONTAINER_STATE_UNKNOWN',
      'DOCKER_CONTINUATION_DESTINATION_STATE_UNKNOWN',
    ]) {
      expect([code, supervisorCodeKind(code)]).toEqual([code, 'wait']);
      const seen = classifyEmployee(held(code));
      expect([code, seen.condition]).toEqual([code, 'starting']);
      expect(seen.sentence).not.toMatch(/does not recognize|undefined|\{name\}/);
    }
  });

  it('watches a hold that names no code at all for thirty minutes, like any code it does not know', () => {
    const nameless = observed({
      session: { available: false },
      laptop: { record: { phase: 'resources-issued', version: 2, operationId: 'op-1' }, restoration: { state: 'held', code: '' }, provider: 'exited' },
    });
    expect(classifyEmployee(nameless).condition).toBe('held-needs-rebuild');
    expect(until(EMPTY_SUPERVISOR_HISTORY, nameless, T, rebuilds)).toBe(30 * MINUTE);
  });
});

describe('work an agent left running when its turn ended', () => {
  const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
  /** An agent runs in the held laptop; its pane is idle and silent since long ago. */
  const idle = (background: boolean, seen = failed) =>
    withLaptop(seen, { provider: 'running' }, { turn: 'idle', idleSince: 0, ...(background ? { background: true } : {}) });
  /** Roll what the driver rolls: the classification and what the idle pane says of work left running. */
  const rollOn = (history: SupervisorHistory, seen: SupervisorObservation, from: number, to: number) => {
    for (let now = from; now < to; now += 30_000) history = rollSupervisorHistory(history, sightEmployee(seen), now);
    return history;
  };
  const dueAfter = (history: SupervisorHistory, seen: SupervisorObservation, from: number) => {
    for (let now = from; now < from + 12 * HOUR; now += 30_000) {
      history = rollSupervisorHistory(history, sightEmployee(seen), now);
      if (rebuilds(assessEmployee(seen, history, ON, now), now)) return now - from;
    }
    return undefined;
  };

  it('is given four hours from when the office first saw it, however long the problem has stood', () => {
    // The laptop was held for three hours with nothing left running; then the pane shows a job.
    const before = rollOn(EMPTY_SUPERVISOR_HISTORY, idle(false), T, T + 3 * MINUTE);
    expect(dueAfter(before, idle(false), T + 3 * MINUTE)).toBe(0);
    const held3h = rollOn(EMPTY_SUPERVISOR_HISTORY, withLaptop(idle(false), {}, { turn: 'working' }), T, T + 3 * HOUR);
    const first = rollSupervisorHistory(held3h, sightEmployee(idle(true)), T + 3 * HOUR);
    expect(first.backgroundSince).toBe(T + 3 * HOUR);
    expect(assessEmployee(idle(true), first, ON, T + 3 * HOUR).next).toEqual({
      action: null,
      at: T + 7 * HOUR,
      waitingFor: 'the work the agent left running to finish',
      preconditions: [],
    });
    expect(dueAfter(held3h, idle(true), T + 3 * HOUR)).toBe(4 * HOUR);
    expect(SUPERVISOR_POLICY.backgroundGraceMs).toBe(4 * HOUR);
  });

  it('has a grace of its own beside a code the office does not know, which is watched for thirty minutes too', () => {
    // Before, both waits ran from the same moment, so a job left running got no grace at all.
    const odd = held('DOCKER_SOMETHING_NOBODY_LISTED');
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, idle(true, odd), T)).toBe(4 * HOUR);
  });

  it('is rebuilt over at once when the pane shows the work has finished', () => {
    const waiting = rollOn(EMPTY_SUPERVISOR_HISTORY, idle(true), T, T + HOUR);
    expect(waiting.backgroundSince).toBe(T);
    const finished = rollSupervisorHistory(waiting, sightEmployee(idle(false)), T + HOUR);
    expect(finished.backgroundSince).toBeUndefined();
    expect(dueAfter(waiting, idle(false), T + HOUR)).toBe(0);
  });

  it('keeps its clock while a turn runs or the pane cannot be read, and starts a new one for new work', () => {
    let history = rollOn(EMPTY_SUPERVISOR_HISTORY, idle(true), T, T + HOUR);
    history = rollOn(history, withLaptop(idle(false), {}, { turn: 'working' }), T + HOUR, T + 2 * HOUR);
    expect(history.backgroundSince).toBe(T);
    history = rollOn(history, withLaptop(failed, { provider: 'running' }), T + 2 * HOUR, T + 2 * HOUR + MINUTE);
    expect(history.backgroundSince).toBe(T);
    // A shell that never ends does not keep the laptop for good: four hours from its first sighting.
    expect(dueAfter(history, idle(true), T + 2 * HOUR + MINUTE)).toBe(2 * HOUR - MINUTE);
    // The work finished, and later the agent left other work running: that has its own four hours.
    history = rollOn(rollOn(history, idle(false), T + 3 * HOUR, T + 3 * HOUR + MINUTE), failed, T + 3 * HOUR + MINUTE, T + 5 * HOUR);
    expect(rollSupervisorHistory(history, sightEmployee(idle(true)), T + 5 * HOUR).backgroundSince).toBe(T + 5 * HOUR);
  });

  it('is watched anew after an office start', () => {
    const saved = rollOn(EMPTY_SUPERVISOR_HISTORY, idle(true), T, T + 5 * HOUR);
    expect(resumeSupervisorHistory(saved).backgroundSince).toBeUndefined();
    expect(dueAfter(resumeSupervisorHistory(saved), idle(true), T + 6 * HOUR)).toBe(4 * HOUR);
  });

  it('gets the same four hours behind a terminal whose input is held', () => {
    const heldInput = observed({
      session: { inputHeld: true, turn: 'idle', idleSince: 0, background: true },
      laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' }, provider: 'running' },
    });
    const refused: SupervisorHistory = {
      ...since(T, classifyEmployee(heldInput).fingerprint, { attempts: tried('reconnect-viewer', 1, T + 45_000) }),
      lastAction: { action: 'reconnect-viewer', at: T + 45_000, outcome: 'refused' },
    };
    expect(dueAfter(refused, heldInput, T + MINUTE)).toBe(4 * HOUR);
  });

  it('is not what an agent parked on a start-up screen is kept for: that keeps its thirty minutes', () => {
    const parked = observed({
      session: {
        turn: 'idle',
        idleSince: 0,
        background: true,
        startupScreen: { label: 'a chooser', kind: 'first-run', answering: false, proof: 'widget' },
      },
      laptop: { continuation: { state: 'ready', phase: 'ready', allowedActions: ['observe'] }, provider: 'running' },
    } as Patch);
    const after = dueAfter(EMPTY_SUPERVISOR_HISTORY, parked, T)!;
    expect(after).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(after).toBeLessThan(HOUR);
  });
});
