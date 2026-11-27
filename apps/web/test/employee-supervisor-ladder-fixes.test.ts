/**
 * The repair ladder after an adversarial review: what the review found, each as a test that failed before its fix.
 * Policy rules first, then the driver's office-wide rules.
 */
import { describe, expect, it } from 'vitest';
import {
  EmployeeSupervisor,
  type EmployeeSupervisorPorts,
  type SupervisedEmployee,
  type SupervisorLaptopReading,
} from '../src/employee-supervisor.js';
import {
  EMPTY_SUPERVISOR_HISTORY,
  SUPERVISOR_POLICY,
  assessEmployee,
  classifyEmployee,
  issueSupervisorAttempt,
  officeReading,
  resumeSupervisorHistory,
  rollSupervisorHistory,
  sightEmployee,
  supervisorCodeKind,
  type SupervisorAction,
  type SupervisorFlags,
  type SupervisorHistory,
  type SupervisorObservation,
  type SupervisorProviderPresence,
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
  ({
    ...base,
    session: { ...base.session, ...session },
    laptop: { ...base.laptop, ...laptop },
  }) as SupervisorObservation;
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
    const done = {
      ...since(T, FAILED),
      lastAction: { action: 'rebuild-laptop' as const, at: T + HOUR, outcome: 'done' as const },
    };
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
  ])(
    'is never rebuilt for the office’s older attach report, stuck on %s: the terminal is what is wrong',
    (_title, code) => {
      const seen = contradicted(code);
      expect(classifyEmployee(seen)).toMatchObject({ condition: 'viewer-lost', code });
      expect(until(EMPTY_SUPERVISOR_HISTORY, seen, T, rebuilds)).toBeUndefined();
      // What is tried is the step that discards nothing.
      expect(until(EMPTY_SUPERVISOR_HISTORY, seen, T, (result) => result.next.action === 'reconnect-viewer')).toBe(0);
    }
  );

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
  const reachable = (seen: SupervisorObservation) =>
    withLaptop(seen, { provider: 'running' }, { turn: 'idle', idleSince: 0 });
  /** The same, with no reading of the pane at all. */
  const unreachable = (seen: SupervisorObservation) => withLaptop(seen, { provider: 'running' });

  it('is rebuilt between turns for a code the table lists as settled by a rebuild', () => {
    for (const code of ['DOCKER_RESOURCE_HELPER_FAILED', 'DOCKER_CONTINUATION_FOREIGN_PROVIDER'])
      expect([code, until(EMPTY_SUPERVISOR_HISTORY, reachable(held(code)), T, rebuilds)]).toEqual([code, 3 * MINUTE]);
  });

  it('is never rebuilt for a code the table does not list while its agent can be reached, and after two hours when it cannot', () => {
    const own = reachable(held('DOCKER_SOMETHING_NOBODY_LISTED'));
    expect(until(EMPTY_SUPERVISOR_HISTORY, own, T, rebuilds)).toBeUndefined();
    expect(
      assessEmployee(own, since(T, 'code:DOCKER_SOMETHING_NOBODY_LISTED'), ON, T + 6 * HOUR).next.waitingFor
    ).toMatch(/^the laptop's own report to clear: it names a code the office does not know/);
    expect(
      assessEmployee(own, since(T, 'code:DOCKER_SOMETHING_NOBODY_LISTED'), ON, T + 6 * HOUR).needsHuman
    ).toBeUndefined();
    // An attached terminal is reach enough, whether or not the pane is read.
    const attached = withLaptop(
      held('DOCKER_SOMETHING_NOBODY_LISTED'),
      { provider: 'running', restoration: { state: 'attached' } },
      {
        available: true,
        viewerHealth: 'connected',
      }
    );
    expect(until(EMPTY_SUPERVISOR_HISTORY, attached, T, rebuilds)).toBeUndefined();
    // No terminal and no pane: the rule of an agent nobody can reach, two hours after the problem was first seen.
    expect(until(EMPTY_SUPERVISOR_HISTORY, unreachable(held('DOCKER_SOMETHING_NOBODY_LISTED')), T, rebuilds)).toBe(
      2 * HOUR
    );
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

  it.each(others)(
    'is rebuilt for %s only after two hours in which the office had no reading of its pane',
    (_title, seen) => {
      const after = until(EMPTY_SUPERVISOR_HISTORY, unreachable(seen), T, rebuilds)!;
      expect(after).toBeGreaterThanOrEqual(2 * HOUR);
      expect(after).toBeLessThanOrEqual(2 * HOUR + 15 * MINUTE);
    }
  );

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
      laptop: {
        record: { phase: 'resources-issued', version: 2, operationId: 'op-1' },
        restoration: { state: 'held', code: '' },
        provider: 'exited',
      },
    });
    expect(classifyEmployee(nameless).condition).toBe('held-needs-rebuild');
    expect(until(EMPTY_SUPERVISOR_HISTORY, nameless, T, rebuilds)).toBe(30 * MINUTE);
  });
});

describe('work an agent left running when its turn ended', () => {
  const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
  /** An agent runs in the held laptop; its pane is idle and silent since long ago. */
  const idle = (background: boolean, seen = failed) =>
    withLaptop(
      seen,
      { provider: 'running' },
      { turn: 'idle', idleSince: 0, ...(background ? { background: true } : {}) }
    );
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
    // Before, both waits ran from the same moment, so a job left running got no grace at all. Such a laptop is
    // rebuilt only once its agent cannot be reached; work a read inside it found is then given its four hours.
    const odd = held('DOCKER_SOMETHING_NOBODY_LISTED');
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, withLaptop(odd, { provider: 'running', otherWork: true }), T)).toBe(
      4 * HOUR
    );
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, idle(true, odd), T)).toBeUndefined();
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
    history = rollOn(
      rollOn(history, idle(false), T + 3 * HOUR, T + 3 * HOUR + MINUTE),
      failed,
      T + 3 * HOUR + MINUTE,
      T + 5 * HOUR
    );
    expect(rollSupervisorHistory(history, sightEmployee(idle(true)), T + 5 * HOUR).backgroundSince).toBe(T + 5 * HOUR);
  });

  // What a read made inside the laptop found beside the agent: a job started detached, a tmux server of the
  // employee's own. The pane shows none of it. `true` is the same thing as work the pane shows.
  const other = (found: true | false | 'unknown' | undefined, base = idle(false)) =>
    withLaptop(base, found === undefined ? {} : { otherWork: found });

  it('gives work that only a read inside the laptop found the same four hours, from when it was first seen', () => {
    // With nothing found the idle, silent laptop is rebuilt after the rung's own three minutes; a read that found
    // none changes nothing.
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, other(undefined), T)).toBe(3 * MINUTE);
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, other(false), T)).toBe(3 * MINUTE);
    // The laptop was held for three hours; then a read finds a detached job that the pane does not show.
    const held3h = rollOn(EMPTY_SUPERVISOR_HISTORY, withLaptop(idle(false), {}, { turn: 'working' }), T, T + 3 * HOUR);
    const first = rollSupervisorHistory(held3h, sightEmployee(other(true)), T + 3 * HOUR);
    expect(first.backgroundSince).toBe(T + 3 * HOUR);
    expect(assessEmployee(other(true), first, ON, T + 3 * HOUR).next).toEqual({
      action: null,
      at: T + 7 * HOUR,
      waitingFor: 'the work the agent left running to finish',
      preconditions: [],
    });
    expect(dueAfter(held3h, other(true), T + 3 * HOUR)).toBe(4 * HOUR);
    // The pane shows work and the read found more: one clock, from the first of the two sightings.
    const both = rollOn(EMPTY_SUPERVISOR_HISTORY, idle(true), T, T + HOUR);
    expect(dueAfter(both, other(true, idle(true)), T + HOUR)).toBe(3 * HOUR);
  });

  it('counts those four hours whatever the pane shows meanwhile, and ends them when a read finds the work gone', () => {
    let history = rollOn(EMPTY_SUPERVISOR_HISTORY, other(true), T, T + HOUR);
    expect(history.backgroundSince).toBe(T);
    // A turn runs, the pane cannot be read, the pane is idle and shows nothing: the job is still there.
    history = rollOn(history, other(true, withLaptop(idle(false), {}, { turn: 'working' })), T + HOUR, T + 2 * HOUR);
    history = rollOn(history, other(true, withLaptop(failed, { provider: 'running' })), T + 2 * HOUR, T + 3 * HOUR);
    expect(history.backgroundSince).toBe(T);
    expect(dueAfter(history, other(true), T + 3 * HOUR)).toBe(HOUR);
    // A read finds none any more, and the pane shows none: nothing is waited for.
    const gone = rollSupervisorHistory(history, sightEmployee(other(false)), T + 3 * HOUR);
    expect(gone.backgroundSince).toBeUndefined();
    expect(dueAfter(history, other(false), T + 3 * HOUR)).toBe(0);
    // A read that found none does not end what the pane itself shows.
    expect(rollSupervisorHistory(history, sightEmployee(other(false, idle(true))), T + 3 * HOUR).backgroundSince).toBe(
      T
    );
  });

  it('gives a read that could not tell the same four hours as work that was found, never a rebuild at once', () => {
    // A read that could not say what runs beside the agent is not taken for "nothing": it starts the clock, and
    // the idle, silent laptop is rebuilt when the four hours are up, as for work that was seen.
    expect(sightEmployee(other('unknown')).background).toBe(true);
    expect(rollOn(EMPTY_SUPERVISOR_HISTORY, other('unknown'), T, T + HOUR).backgroundSince).toBe(T);
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, other('unknown'), T)).toBe(4 * HOUR);
    // It ends no clock either: work that was seen keeps its four hours from its first sighting, and no more.
    const seen = rollOn(EMPTY_SUPERVISOR_HISTORY, other(true), T, T + HOUR);
    const unread = rollOn(seen, other('unknown'), T + HOUR, T + 2 * HOUR);
    expect(unread.backgroundSince).toBe(T);
    expect(dueAfter(unread, other(true), T + 2 * HOUR)).toBe(2 * HOUR);
    // Work the pane shows is waited for whatever the read says.
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, other('unknown', idle(true)), T)).toBe(4 * HOUR);
  });

  it('gives found work its time too where the pane cannot be read at all', () => {
    // An unreadable pane leads to a rebuild two hours after the problem was first seen. Found work is not ended
    // then: it has four hours from its own first sighting.
    const blind = withLaptop(failed, { provider: 'running' });
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, blind, T)).toBe(2 * HOUR);
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, other(true, blind), T)).toBe(4 * HOUR);
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, other('unknown', blind), T)).toBe(4 * HOUR);
    expect(dueAfter(EMPTY_SUPERVISOR_HISTORY, other(false, blind), T)).toBe(2 * HOUR);
  });

  it('is watched anew after an office start', () => {
    const saved = rollOn(EMPTY_SUPERVISOR_HISTORY, idle(true), T, T + 5 * HOUR);
    expect(resumeSupervisorHistory(saved).backgroundSince).toBeUndefined();
    expect(dueAfter(resumeSupervisorHistory(saved), idle(true), T + 6 * HOUR)).toBe(4 * HOUR);
  });

  it('gets the same four hours behind a terminal whose input is held', () => {
    const heldInput = observed({
      session: { inputHeld: true, turn: 'idle', idleSince: 0, background: true },
      laptop: {
        restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' },
        provider: 'running',
      },
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

// ─── The driver: rules that hold across the whole office ───────────────────────

type Session = SupervisorObservation['session'];
interface Desk {
  employee: SupervisedEmployee;
  session: Session;
  restoration: SupervisorObservation['laptop']['restoration'];
  reading: SupervisorLaptopReading | undefined;
  provider: SupervisorProviderPresence;
  /** The employee's open plan move, and what else of the office's own holds them. */
  move?: NonNullable<Awaited<ReturnType<EmployeeSupervisorPorts['openMove']>>>;
  busy?: SupervisorObservation['busy'];
}
const ATTACHED_IDLE: Session = {
  available: true,
  runtimeHealth: 'healthy',
  viewerHealth: 'connected',
  turn: 'idle',
  idleSince: 0,
};
const UNREADABLE: Session = { available: false, runtimeHealth: 'unknown', viewerHealth: 'unknown' };
const READY: SupervisorLaptopReading = { state: 'ready', phase: 'ready', allowedActions: ['observe'] };
const heldAt = (code: string): SupervisorLaptopReading => ({
  state: 'held',
  phase: 'ready',
  code,
  allowedActions: ['observe'],
});
const VIEW_LOST = { state: 'held' as const, code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' };

/** An office of laptops driven by the real supervisor, with a clock the test moves. */
function officeOf(
  ids: string[],
  desk: (id: string) => Pick<Desk, 'session' | 'restoration' | 'reading' | 'provider'>,
  options: {
    saved?: Map<string, SupervisorHistory>;
    officeRestart?: { asked: string[]; answer: 'pending' | 'refused'; lastAt?: number; nextAt?: number };
    /** What a read inside each laptop finds beside the agent. Without it the office cannot make that read. */
    otherWork?: (id: string) => true | false | 'unknown';
    /** The laptop operation each such read says it was made in. */
    otherWorkOf?: (id: string) => string;
    /** The rebuild of this employee, the how-many-th of the office, never returns. */
    hang?: (id: string, count: number) => boolean;
  } = {}
) {
  const start = 1_800_000_000_000;
  const state = { now: start, saved: options.saved ?? new Map<string, SupervisorHistory>() };
  const desks = new Map<string, Desk>(
    ids.map((id) => [
      id,
      {
        employee: {
          id,
          name: id.toUpperCase(),
          owner: undefined,
          sessionId: 's-' + id,
          sessionGeneration: 1,
          desiredRunning: true,
          onVacation: false,
          bindingMigration: false,
        },
        ...desk(id),
      },
    ])
  );
  const rebuilt: Array<{ id: string; minute: number; proved: string }> = [];
  /** What a rebuild does to the laptop, per employee. Left alone, the laptop comes back exactly as it was. */
  const afterRebuild = new Map<string, (target: Desk) => void>();
  const ports: EmployeeSupervisorPorts = {
    now: () => state.now,
    ready: () => true,
    employees: () => [...desks.values()].map((row) => row.employee),
    flags: () => ({ enabled: true, autoRepair: true }),
    glance: (employee) => {
      const row = desks.get(employee.id)!;
      return {
        employeeId: employee.id,
        name: employee.name,
        desiredRunning: employee.desiredRunning,
        onVacation: employee.onVacation,
        bindingMigration: false,
        boxed: true,
        session: row.session,
        laptop: {
          record: { phase: 'ready', version: 2, operationId: 'op-' + employee.id },
          bound: true,
          policyApproved: true,
          templateOnRecord: true,
          ...(row.restoration ? { restoration: row.restoration } : {}),
          poolAlive: true,
        },
        ...(row.busy ? { busy: row.busy } : {}),
      };
    },
    openMove: async (employee) => desks.get(employee.id)!.move,
    readLaptop: async (employee) => desks.get(employee.id)!.reading,
    readSource: async () => 'unknown',
    readProvider: async (employee) => desks.get(employee.id)!.provider,
    ...(options.otherWork
      ? {
          readOtherWork: async (employee: SupervisedEmployee) => ({
            otherWork: options.otherWork!(employee.id),
            at: state.now,
            ...(options.otherWorkOf ? { operationId: options.otherWorkOf(employee.id) } : {}),
          }),
        }
      : {}),
    actions: {
      'rebuild-laptop': async (employee, _guard, _move, proved) => {
        const hung = options.hang?.(employee.id, rebuilt.length) === true;
        rebuilt.push({
          id: employee.id,
          minute: Math.round((state.now - start) / MINUTE),
          proved: hung ? 'hung' : (proved ?? []).join(),
        });
        if (hung) return new Promise(() => {});
        afterRebuild.get(employee.id)?.(desks.get(employee.id)!);
        return { outcome: 'done', detail: 'rebuilt' };
      },
      'reconnect-viewer': async () => ({ outcome: 'refused', detail: 'not-attached' }),
    },
    ...(options.officeRestart
      ? {
          officeRestart: {
            request: (reason: string) => {
              options.officeRestart!.asked.push(reason);
              return options.officeRestart!.answer;
            },
            lastAt: () => options.officeRestart!.lastAt,
            nextAt: () => options.officeRestart!.nextAt,
          },
        }
      : {}),
    load: () => state.saved,
    save: async (histories) => void (state.saved = new Map(histories)),
    audit: () => {},
    log: () => {},
  };
  const limits = {
    actionsPerTick: 2,
    startupGraceMs: 0,
    actionWaitMs: 50,
    idleReadMs: 2 * MINUTE,
    limitsCheckMs: 10 * MINUTE,
  };
  let supervisor = new EmployeeSupervisor(ports, undefined, limits);
  const run = async (minutes: number) => {
    for (let elapsed = 0; elapsed < minutes * MINUTE; elapsed += 30_000) {
      state.now += 30_000;
      await supervisor.tick();
    }
  };
  return {
    state,
    start,
    desks,
    rebuilt,
    afterRebuild,
    run,
    report: (id: string) => supervisor.reports(undefined).find((row) => row.employeeId === id)!,
    /** The office process ends and a new one starts on what was saved. */
    restart: () => void (supervisor = new EmployeeSupervisor(ports, undefined, limits)),
    supervisor: () => supervisor,
  };
}
const healthy = (target: Desk) => {
  target.session = ATTACHED_IDLE;
  target.restoration = { state: 'attached' };
  target.reading = READY;
};

describe('one cause that every laptop of the office shares', () => {
  const FIVE = ['a', 'b', 'c', 'd', 'e'];
  /** Every laptop reports the same code that a rebuild settles; every pane is attached, idle and silent. */
  const sameCode = () =>
    officeOf(FIVE, () => ({
      session: ATTACHED_IDLE,
      restoration: VIEW_LOST,
      reading: heldAt('DOCKER_RESOURCE_HELPER_FAILED'),
      provider: 'running',
    }));

  it('does not rebuild five laptops within a minute: one is rebuilt as a probe, and no other while it is not healthy', async () => {
    const o = sameCode();
    await o.run(30);
    // The cause must have been shared for thirty minutes before anything is tried.
    expect(o.rebuilt).toEqual([]);
    await o.run(8 * 60);
    expect(o.rebuilt[0]!.minute).toBeGreaterThanOrEqual(30);
    // The probe did not come back healthy, so nobody else was touched. The probe keeps its own limit of two a day.
    expect(new Set(o.rebuilt.map((row) => row.id)).size).toBe(1);
    expect(o.rebuilt.length).toBeLessThanOrEqual(2);
    const probe = o.rebuilt[0]!.id;
    for (const id of FIVE.filter((other) => other !== probe)) {
      expect(o.report(id).waitingFor).toMatch(/to come back healthy.*no other laptop is touched before that$/);
      expect(o.report(id).needsHuman).toBeUndefined();
    }
  });

  it('goes on to the next laptop once the probe is healthy, one laptop an hour', async () => {
    const o = sameCode();
    for (const id of FIVE) o.afterRebuild.set(id, healthy);
    await o.run(7 * 60);
    expect(o.rebuilt.map((row) => row.id).sort()).toEqual(FIVE);
    const minutes = o.rebuilt.map((row) => row.minute);
    for (let index = 1; index < minutes.length; index++)
      expect(minutes[index]! - minutes[index - 1]!).toBeGreaterThanOrEqual(60);
    expect(o.rebuilt.every((row) => row.proved === 'agent-between-turns,laptop-held')).toBe(true);
  });
});

describe('an office that can read none of its laptops', () => {
  const FIVE = ['a', 'b', 'c', 'd', 'e'];
  /** No terminal is attached and no laptop can be read, although an agent runs in each. */
  const blind = (options: Parameters<typeof officeOf>[2] = {}) =>
    officeOf(
      FIVE,
      () => ({
        session: UNREADABLE,
        restoration: VIEW_LOST,
        reading: { state: 'held', phase: 'ready', code: 'DOCKER_CONTINUATION_UNCONFIRMED', allowedActions: [] },
        provider: 'running',
      }),
      options
    );

  it('rebuilds no laptop for a pane it cannot read, and asks for its own restart after thirty minutes', async () => {
    const officeRestart = { asked: [] as string[], answer: 'pending' as const };
    const o = blind({ officeRestart });
    // The engine first says that these laptops run when a rebuild comes due, eighteen minutes in. From then on the
    // office knows that it cannot read laptops that run, and thirty minutes later it asks.
    await o.run(47);
    expect(officeRestart.asked).toEqual([]);
    await o.run(4);
    expect(officeRestart.asked.length).toBeGreaterThan(0);
    expect(officeRestart.asked[0]).toMatch(/reads none of its laptops/);
    await o.run(6 * 60);
    expect(o.rebuilt).toEqual([]);
    for (const id of FIVE) {
      expect(o.report(id).waitingFor).toMatch(/the office reads none of its laptops/);
      expect(o.report(id).needsHuman).toBeUndefined();
    }
  });

  it('after a restart that did not help, rebuilds one laptop as a probe and touches no other while it is not healthy', async () => {
    // This office process started after the office had restarted itself for this, twenty minutes ago.
    const officeRestart = {
      asked: [] as string[],
      answer: 'pending' as const,
      lastAt: 1_800_000_000_000 - 20 * MINUTE,
    };
    const o = blind({ officeRestart });
    await o.run(135);
    expect(o.rebuilt).toEqual([]);
    await o.run(6 * 60);
    expect(new Set(o.rebuilt.map((row) => row.id)).size).toBe(1);
    expect(o.rebuilt[0]!.proved).toMatch(/agent-unreadable/);
    expect(o.rebuilt.length).toBeLessThanOrEqual(2);
  });

  it('treats an office that cannot restart itself as one whose restart was tried', async () => {
    const o = blind({ officeRestart: { asked: [], answer: 'refused' } });
    await o.run(8 * 60);
    expect(new Set(o.rebuilt.map((row) => row.id)).size).toBe(1);
  });

  it('still rebuilds the one laptop it cannot read while it reads the others', async () => {
    const o = officeOf(['a', 'b', 'c'], (id) =>
      id === 'a'
        ? {
            session: UNREADABLE,
            restoration: VIEW_LOST,
            reading: { state: 'held', phase: 'ready', code: 'DOCKER_CONTINUATION_UNCONFIRMED', allowedActions: [] },
            provider: 'running',
          }
        : { session: ATTACHED_IDLE, restoration: { state: 'attached' }, reading: READY, provider: 'running' }
    );
    await o.run(3 * 60);
    expect(o.rebuilt.map((row) => [row.id, row.proved])).toEqual([['a', 'laptop-held,agent-unreadable']]);
    expect(o.rebuilt[0]!.minute).toBeGreaterThanOrEqual(135);
  });
});

describe('rebuilding laptops that agents run in, across the office', () => {
  /** Two laptops, each held for a cause of its own that a rebuild settles, each with an idle, silent pane. */
  const two = (saved?: Map<string, SupervisorHistory>) =>
    officeOf(
      ['a', 'b'],
      (id) => ({
        session: ATTACHED_IDLE,
        restoration: VIEW_LOST,
        reading: heldAt(id === 'a' ? 'DOCKER_RESOURCE_HELPER_FAILED' : 'DOCKER_CONTINUATION_IDENTITY_UNCONFIRMED'),
        provider: 'running',
      }),
      { ...(saved ? { saved } : {}) }
    );

  it('is done at most once an hour, whatever the causes', async () => {
    const o = two();
    for (const id of ['a', 'b']) o.afterRebuild.set(id, healthy);
    await o.run(30);
    expect(o.rebuilt).toHaveLength(1);
    const waiting = o.report(o.rebuilt[0]!.id === 'a' ? 'b' : 'a');
    expect(waiting.waitingFor).toMatch(
      /^the limit of one rebuild an hour, across the office, of a laptop that an agent runs in/
    );
    expect(Math.abs(waiting.waitingUntil! - (o.start + (o.rebuilt[0]!.minute + 60) * MINUTE))).toBeLessThanOrEqual(
      30_000
    );
    await o.run(45);
    expect(o.rebuilt).toHaveLength(2);
    expect(o.rebuilt[1]!.minute - o.rebuilt[0]!.minute).toBeGreaterThanOrEqual(60);
  });

  it('keeps that hour across an office restart', async () => {
    const o = two();
    for (const id of ['a', 'b']) o.afterRebuild.set(id, healthy);
    await o.run(10);
    expect(o.rebuilt).toHaveLength(1);
    o.restart();
    await o.run(45);
    expect(o.rebuilt).toHaveLength(1);
    await o.run(10);
    expect(o.rebuilt).toHaveLength(2);
  });

  it('does not count a laptop that a read showed to be empty', async () => {
    const o = officeOf(['a', 'b'], (id) => ({
      session: UNREADABLE,
      restoration: VIEW_LOST,
      reading: heldAt(id === 'a' ? 'DOCKER_RESOURCE_HELPER_FAILED' : 'DOCKER_CONTINUATION_IDENTITY_UNCONFIRMED'),
      provider: 'exited',
    }));
    for (const id of ['a', 'b']) o.afterRebuild.set(id, healthy);
    await o.run(10);
    expect(o.rebuilt.map((row) => row.id).sort()).toEqual(['a', 'b']);
  });
});

describe('what counts as the office not reading a laptop that runs', () => {
  const ready = { state: 'ready' as const, phase: 'ready', allowedActions: ['observe'] };
  /** A laptop whose own read says ready, with no terminal of the office on it. */
  const unattached = (patch: Patch = {}) =>
    observed({
      ...patch,
      session: { available: false, viewerHealth: 'unknown', ...patch.session },
      laptop: { restoration: VIEW_LOST, continuation: ready, ...patch.laptop },
    });
  const moving = {
    id: 'move-1',
    docker: true,
    phase: 'recovery-required',
    busy: false,
    error: 'x',
    allowedActions: ['continue-original'],
  };

  it.each<[string, SupervisorObservation, boolean, ReturnType<typeof officeReading>]>([
    // The office reads it.
    ['a healthy employee with an attached terminal', observed(), true, 'reads'],
    [
      'a pane the office reads, whatever the laptop reports',
      withLaptop(held('DOCKER_RESOURCE_HELPER_FAILED'), {}, { turn: 'idle', idleSince: 0 }),
      true,
      'reads',
    ],
    [
      'an agent at a start-up screen, which the office read off its pane',
      observed({
        session: { turn: 'idle', idleSince: 0, startupScreen: { label: 'x', kind: 'credential', answering: false } },
      }),
      true,
      'reads',
    ],
    // Evidence: the engine says it runs, and the office cannot attach to it or read it.
    ['a laptop whose own read says ready, with no terminal on it', unattached(), false, 'cannot-read'],
    [
      'a laptop the engine lists as running whose read fails',
      withLaptop(held('DOCKER_CONTINUATION_UNCONFIRMED'), {}),
      true,
      'cannot-read',
    ],
    [
      'the same with a read that timed out',
      withLaptop(held('DOCKER_RESOURCE_PROBE_DEADLINE'), {}),
      true,
      'cannot-read',
    ],
    // No evidence either way.
    [
      'a laptop whose read fails while nothing says that it runs',
      held('DOCKER_CONTINUATION_UNCONFIRMED'),
      false,
      'no-evidence',
    ],
    ['an employee the owner stopped', unattached({ desiredRunning: false }), true, 'no-evidence'],
    ['an employee who is out of the office', unattached({ onVacation: true }), true, 'no-evidence'],
    [
      'an employee whose plan move is held',
      { ...unattached(), move: moving } as SupervisorObservation,
      true,
      'no-evidence',
    ],
    [
      'an employee whose plan move is running',
      { ...unattached(), move: { ...moving, phase: 'creating', busy: true } } as SupervisorObservation,
      true,
      'no-evidence',
    ],
    ['an employee who is being moved to another session', unattached({ bindingMigration: true }), true, 'no-evidence'],
    ['a laptop a set-up step is running for', unattached({ busy: 'continuation-flight' }), true, 'no-evidence'],
    ['a laptop another operation holds', unattached({ busy: 'laptop-operation' }), true, 'no-evidence'],
    ['a session that is being started or stopped', unattached({ busy: 'lifecycle-in-progress' }), true, 'no-evidence'],
    ['a laptop whose rebuild has not finished', unattached({ laptop: { rebuildPending: true } }), true, 'no-evidence'],
    ['a laptop that waits for the shared pool', unattached({ laptop: { pool: 'down' } }), true, 'no-evidence'],
    ['a laptop while the pool cannot be read', unattached({ laptop: { pool: 'unknown' } }), true, 'no-evidence'],
    ['a stopped laptop', held('DOCKER_CONTINUATION_CONTAINER_STOPPED'), false, 'no-evidence'],
    ['a laptop that is being set up', held('DOCKER_CONTINUATION_BUSY'), true, 'no-evidence'],
    ['a set-up that has not finished', held('DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING'), true, 'no-evidence'],
    [
      'a laptop held in the middle of its set-up, which never had a terminal',
      held('DOCKER_RESOURCE_HELPER_FAILED'),
      true,
      'no-evidence',
    ],
    ['a laptop whose agent has exited', held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED'), true, 'no-evidence'],
    [
      'a fresh laptop that was never started',
      observed({ session: { available: false }, laptop: { record: null, restoration: undefined, source: 'stopped' } }),
      false,
      'no-evidence',
    ],
    [
      'an employee with no laptop',
      observed({ session: { available: false }, laptop: { record: null, restoration: undefined, source: 'unknown' } }),
      false,
      'no-evidence',
    ],
    [
      'a terminal whose input the office itself holds',
      unattached({ session: { inputHeld: true } }),
      true,
      'no-evidence',
    ],
    ['a session that is not in a laptop', unattached({ boxed: false }), true, 'no-evidence'],
    ['the wait for the office’s own restart', held('DOCKER_CONTINUATION_RUNTIME_CHANGED'), true, 'no-evidence'],
  ])('%s', (_title, seen, running, expected) => {
    expect(officeReading(seen, running)).toBe(expected);
  });
});

describe('the office asking for its own restart', () => {
  const unread = () => ({
    session: UNREADABLE,
    restoration: VIEW_LOST,
    reading: READY,
    provider: 'running' as const,
  });
  const restartable = () => ({ asked: [] as string[], answer: 'pending' as const });
  const heldMove = {
    id: 'move-1',
    docker: true,
    phase: 'recovery-required',
    busy: false,
    error: 'DOCKER_RESOURCE_HELPER_FAILED',
    allowedActions: [],
  };

  it('asks when it reads none of several laptops that run', async () => {
    const officeRestart = restartable();
    const o = officeOf(['a', 'b', 'c'], unread, { officeRestart });
    await o.run(29);
    expect(officeRestart.asked).toEqual([]);
    await o.run(3);
    expect(officeRestart.asked.length).toBeGreaterThan(0);
  });

  it.each<[string, (o: ReturnType<typeof officeOf>) => void]>([
    ['their plan move is held', (o) => (o.desks.get('a')!.move = heldMove)],
    [
      'a step of their plan move has been running',
      (o) => (o.desks.get('a')!.move = { ...heldMove, phase: 'creating', busy: true }),
    ],
    ['their laptop is stopped', (o) => (o.desks.get('a')!.reading = heldAt('DOCKER_CONTINUATION_CONTAINER_STOPPED'))],
    ['a laptop operation holds them', (o) => (o.desks.get('a')!.busy = 'laptop-operation')],
  ])('never asks for an office with one employee because %s', async (_title, arrange) => {
    const officeRestart = restartable();
    const o = officeOf(['a'], unread, { officeRestart });
    arrange(o);
    await o.run(4 * 60);
    expect(officeRestart.asked).toEqual([]);
  });

  it('never asks for one laptop that runs and cannot be read: that is left to the laptop’s own ladder', async () => {
    const officeRestart = restartable();
    const o = officeOf(['a'], unread, { officeRestart });
    await o.run(4 * 60);
    expect(officeRestart.asked).toEqual([]);
    // The same holds beside employees whose laptops say nothing about the office.
    const others = officeOf(
      ['a', 'b', 'c'],
      (id) =>
        id === 'a'
          ? unread()
          : { ...unread(), reading: heldAt('DOCKER_CONTINUATION_CONTAINER_STOPPED'), provider: 'no-laptop' },
      { officeRestart }
    );
    await others.run(4 * 60);
    expect(officeRestart.asked).toEqual([]);
  });

  it('does not count stopped laptops, as after a host restart, as laptops it cannot read', async () => {
    const officeRestart = restartable();
    const o = officeOf(
      ['a', 'b', 'c'],
      () => ({
        session: UNREADABLE,
        restoration: VIEW_LOST,
        reading: heldAt('DOCKER_CONTINUATION_CONTAINER_STOPPED'),
        provider: 'no-laptop',
      }),
      { officeRestart }
    );
    await o.run(4 * 60);
    expect(officeRestart.asked).toEqual([]);
  });

  it.each<[string, (o: ReturnType<typeof officeOf>) => void, (o: ReturnType<typeof officeOf>) => void]>([
    [
      'a plan move of any employee is open',
      (o) => (o.desks.get('c')!.move = heldMove),
      (o) => delete o.desks.get('c')!.move,
    ],
    [
      'an operation holds any employee',
      (o) => (o.desks.get('c')!.busy = 'continuation-flight'),
      (o) => delete o.desks.get('c')!.busy,
    ],
  ])('does not ask while %s, and asks once that has ended', async (_title, begin, end) => {
    const officeRestart = restartable();
    const o = officeOf(['a', 'b', 'c'], unread, { officeRestart });
    begin(o);
    await o.run(3 * 60);
    expect(officeRestart.asked).toEqual([]);
    end(o);
    await o.run(35);
    expect(officeRestart.asked.length).toBeGreaterThan(0);
  });
});

describe('the office asking for its own restart beside what a closed plan move still owes', () => {
  const unread = () => ({
    session: UNREADABLE,
    restoration: VIEW_LOST,
    reading: { state: 'held', phase: 'ready', code: 'DOCKER_CONTINUATION_UNCONFIRMED', allowedActions: [] },
    provider: 'running' as const,
  });
  it.each(['handoff-owed', 'handoff-unconfirmed'])(
    'asks although one of five unreadable laptops carries a handoff that is %s',
    async (phase) => {
      const officeRestart = { asked: [] as string[], answer: 'pending' as const };
      const o = officeOf(['a', 'b', 'c', 'd', 'e'], unread, { officeRestart });
      o.desks.get('a')!.move = { id: 'm1', docker: true, phase, busy: false, allowedActions: [] };
      await o.run(60);
      expect(officeRestart.asked.length).toBeGreaterThan(0);
      expect(officeRestart.asked[0]).toMatch(/reads none of its laptops/);
    }
  );
});

describe('a read inside the laptop that could not say what else runs there', () => {
  /** A reachable agent, idle and silent, on a laptop held for a cause a rebuild settles. */
  const reachable = (found: true | false | 'unknown') =>
    officeOf(
      ['a'],
      () => ({
        session: ATTACHED_IDLE,
        restoration: VIEW_LOST,
        reading: heldAt('DOCKER_RESOURCE_HELPER_FAILED'),
        provider: 'running',
      }),
      { otherWork: () => found }
    );

  it.each<[true | false | 'unknown', number, number]>([
    [false, 0, 10],
    [true, 235, 250],
    ['unknown', 235, 250],
  ])('with the read saying %s, rebuilds between minute %i and %i', async (found, from, to) => {
    const o = reachable(found);
    await o.run(5 * 60);
    expect(o.rebuilt.length).toBeGreaterThan(0);
    expect(o.rebuilt[0]!.minute).toBeGreaterThanOrEqual(from);
    expect(o.rebuilt[0]!.minute).toBeLessThanOrEqual(to);
    expect(o.report('a').needsHuman).toBeUndefined();
  });

  it('says what it waits for meanwhile, and when that ends', async () => {
    const o = reachable('unknown');
    await o.run(30);
    expect(o.rebuilt).toEqual([]);
    expect(o.report('a').waitingFor).toBe('the work the agent left running to finish');
    expect(o.report('a').waitingUntil).toBeGreaterThan(o.state.now + 3 * HOUR);
  });
});

describe('a laptop whose agent exited while other work may still run in it', () => {
  const EXITED: Session = {
    available: true,
    runtimeHealth: 'healthy',
    viewerHealth: 'connected',
    providerHealth: 'dead',
  };
  const exited = (ids: string[], found: true | false | 'unknown') =>
    officeOf(
      ids,
      () => ({
        session: EXITED,
        restoration: { state: 'attached' },
        reading: heldAt('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED'),
        provider: 'exited',
      }),
      { otherWork: () => found }
    );
  const back = (target: Desk) => {
    healthy(target);
    target.provider = 'running';
  };

  it.each<[true | 'unknown']>([[true], ['unknown']])(
    'with the read inside the laptop saying %s, is given four hours before it is rebuilt',
    async (found) => {
      const o = exited(['a'], found);
      o.afterRebuild.set('a', back);
      await o.run(60);
      expect(o.rebuilt).toEqual([]);
      expect(o.report('a').waitingFor).toBe(
        'the work that still runs in the laptop, beside an agent that has exited, to finish'
      );
      expect(o.report('a').needsHuman).toBeUndefined();
      await o.run(4 * 60);
      expect(o.rebuilt).toHaveLength(1);
      expect(o.rebuilt[0]!.minute).toBeGreaterThanOrEqual(235);
      expect(o.rebuilt[0]!.minute).toBeLessThanOrEqual(250);
    }
  );

  it('is rebuilt at once when the read found nothing beside the agent', async () => {
    const o = exited(['a'], false);
    o.afterRebuild.set('a', back);
    await o.run(15);
    expect(o.rebuilt.map((row) => row.id)).toEqual(['a']);
  });

  it('rebuilds one of five laptops whose agents exited at once, and the next only once that one is healthy', async () => {
    const FIVE = ['a', 'b', 'c', 'd', 'e'];
    const stuck = exited(FIVE, false);
    await stuck.run(2 * 60);
    // The probe did not come back: nobody else is touched, and everybody says whom they wait for.
    expect(new Set(stuck.rebuilt.map((row) => row.id)).size).toBe(1);
    const probe = stuck.rebuilt[0]!.id;
    for (const id of FIVE.filter((other) => other !== probe)) {
      expect(stuck.report(id).waitingFor).toMatch(
        /^the laptop of [A-E] to come back healthy: its agent exited as this employee's did/
      );
      expect(stuck.report(id).needsHuman).toBeUndefined();
    }
    const fine = exited(FIVE, false);
    for (const id of FIVE) fine.afterRebuild.set(id, back);
    await fine.run(30);
    expect(fine.rebuilt.map((row) => row.id).sort()).toEqual(FIVE);
  });
});

describe('an office that can read none of its laptops and may not restart itself again today', () => {
  it('does not wait for a restart the limits forbid: one laptop is rebuilt as a probe', async () => {
    const start = 1_800_000_000_000;
    // Two restarts today, the later one seven hours ago: the next is allowed seventeen hours from now.
    const officeRestart = {
      asked: [] as string[],
      answer: 'pending' as const,
      lastAt: start - 7 * HOUR,
      nextAt: start + 17 * HOUR,
    };
    const o = officeOf(
      ['a', 'b', 'c', 'd', 'e'],
      () => ({
        session: UNREADABLE,
        restoration: VIEW_LOST,
        reading: { state: 'held', phase: 'ready', code: 'DOCKER_CONTINUATION_UNCONFIRMED', allowedActions: [] },
        provider: 'running',
      }),
      { officeRestart }
    );
    await o.run(4 * 60);
    expect(new Set(o.rebuilt.map((row) => row.id)).size).toBe(1);
    expect(o.rebuilt[0]!.proved).toMatch(/agent-unreadable/);
    expect(o.rebuilt[0]!.minute).toBeLessThan(4 * 60);
  });
});

describe('a step that hangs, as the restart of the office weighs it', () => {
  const held = () => ({
    session: ATTACHED_IDLE,
    restoration: VIEW_LOST,
    reading: heldAt('DOCKER_RESOURCE_HELPER_FAILED'),
    provider: 'running' as const,
  });

  it('is no longer said to be in flight once its time is up, also for an employee the owner stopped meanwhile', async () => {
    const o = officeOf(['a'], held, { hang: () => true });
    await o.run(20);
    expect(o.rebuilt.map((row) => row.proved)).toEqual(['hung']);
    expect(o.supervisor().stepInFlight()).toBe(
      'a step of the office supervisor for A that is running (rebuild-laptop)'
    );
    o.desks.get('a')!.employee = { ...o.desks.get('a')!.employee, desiredRunning: false };
    await o.run(15);
    expect(o.supervisor().stepInFlight()).toBeUndefined();
    await o.run(3 * 60);
    expect(o.supervisor().stepInFlight()).toBeUndefined();
  });

  it('is not said to be in flight past its time even before a pass has looked at it', async () => {
    const o = officeOf(['a'], held, { hang: () => true });
    await o.run(10);
    expect(o.supervisor().stepInFlight()).toMatch(/rebuild-laptop/);
    o.state.now += 30 * MINUTE;
    expect(o.supervisor().stepInFlight()).toBeUndefined();
  });

  it('is forgotten with an employee who was removed', async () => {
    const o = officeOf(
      ['a', 'b'],
      (id) =>
        id === 'a'
          ? held()
          : { session: ATTACHED_IDLE, restoration: { state: 'attached' }, reading: READY, provider: 'running' },
      { hang: (id) => id === 'a' }
    );
    await o.run(10);
    expect(o.supervisor().stepInFlight()).toMatch(/for A /);
    o.desks.delete('a');
    await o.run(1);
    expect(o.supervisor().stepInFlight() ?? '').not.toMatch(/for A /);
  });
});

describe('a step that hangs past its time', () => {
  it('makes the office ask for its own restart, which is what ends it', async () => {
    const officeRestart = { asked: [] as string[], answer: 'pending' as const };
    const o = officeOf(
      ['a'],
      () => ({
        session: ATTACHED_IDLE,
        restoration: VIEW_LOST,
        reading: heldAt('DOCKER_RESOURCE_HELPER_FAILED'),
        provider: 'running',
      }),
      { hang: () => true, officeRestart }
    );
    await o.run(30);
    expect(o.rebuilt).toHaveLength(1);
    expect(officeRestart.asked).toEqual([]);
    await o.run(10);
    expect(officeRestart.asked.at(-1)).toBe(
      'a step of the office has not returned for half an hour, and only a new office process ends it'
    );
  });
});

describe('a read of other work made in a laptop other than the one on record', () => {
  const exited = (of: string) =>
    officeOf(
      ['a'],
      () => ({
        session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', providerHealth: 'dead' },
        restoration: { state: 'attached' },
        reading: heldAt('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED'),
        provider: 'exited',
      }),
      { otherWork: () => true, otherWorkOf: () => of }
    );

  it('counts for the laptop it was made in, and says nothing of another one', async () => {
    // Made in the laptop on record: the work found there is given its four hours.
    const own = exited('op-a');
    await own.run(60);
    expect(own.rebuilt).toEqual([]);
    // Made in a laptop that is not the one on record: it is no reading of this one, which is rebuilt at once.
    const other = exited('op-replaced');
    await other.run(15);
    expect(other.rebuilt.map((row) => row.id)).toEqual(['a']);
  });
});
