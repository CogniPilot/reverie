import { describe, it, expect } from 'vitest';
import {
  EMPTY_SUPERVISOR_HISTORY,
  SUPERVISOR_HELD_INPUT_PATH,
  SUPERVISOR_LIMITS_PATH,
  SUPERVISOR_OCCUPIED_PROOFS,
  SUPERVISOR_PATHS,
  SUPERVISOR_POLICY,
  SUPERVISOR_STALLED_PATH,
  assessEmployee,
  classifyEmployee,
  classifyMoveError,
  issueSupervisorAttempt,
  readParkedScreen,
  ladderRestartAt,
  readSupervisedTerminal,
  readTerminalTurn,
  recordSupervisorAttempt,
  resumeSupervisorHistory,
  settleSupervisorAttempt,
  rollSupervisorHistory,
  supervisorCodeKind,
  type SupervisedScreenTerminal,
  type SupervisedTerminal,
  type SupervisorAction,
  type SupervisorCondition,
  type SupervisorFlags,
  type SupervisorHistory,
  type SupervisorObservation,
} from '../src/employee-supervisor-policy.js';
import { dockerRecoveryGuidance } from '../src/docker-recovery-guidance.js';
import { describeStartupScreen } from '../src/session-first-run-screens.js';
import { PlanMoveComposerNotReady } from '../src/plan-move.js';

const MINUTE = 60_000;
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
    planLabel: 'Max 20x',
    session: { available: true, runtimeHealth: 'healthy', viewerHealth: 'connected', providerHealth: 'healthy' },
    laptop: {
      record: { phase: 'ready', version: 2, operationId: 'op-1' },
      bound: true,
      policyApproved: true,
      restoration: { state: 'attached' },
      templateOnRecord: true,
    },
  };
  return {
    ...base,
    ...patch,
    session: { ...base.session, ...patch.session },
    laptop: { ...base.laptop, ...patch.laptop },
    ...(patch.move ? { move: patch.move as SupervisorObservation['move'] } : {}),
  } as SupervisorObservation;
}
const held = (code: string, extra: Partial<NonNullable<SupervisorObservation['laptop']['continuation']>> = {}) =>
  observed({
    session: { available: false, viewerHealth: 'disconnected', providerHealth: 'unknown' },
    laptop: {
      record: { phase: 'resources-issued', version: 2, operationId: 'op-1' },
      restoration: { state: 'held', code: 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING' },
      continuation: { state: 'held', phase: 'resources-issued', code, allowedActions: ['observe'], ...extra },
    },
  });
const move = (error: string | undefined, extra: Partial<NonNullable<SupervisorObservation['move']>> = {}) =>
  observed({
    move: {
      id: 'move-1',
      docker: true,
      phase: 'recovery-required',
      busy: false,
      error,
      allowedActions: ['continue-original', 'abandon'],
      ...extra,
    },
  });
const since = (at: number, fingerprint: string, patch: Partial<SupervisorHistory> = {}): SupervisorHistory => ({
  ...EMPTY_SUPERVISOR_HISTORY,
  fingerprint,
  since: at,
  ...patch,
});
const tried = (action: SupervisorAction, count: number, lastAt: number) => ({ [action]: { count, lastAt } });

describe('employee supervisor: classification', () => {
  const cases: Array<[string, SupervisorObservation, SupervisorCondition, RegExp?]> = [
    ['a running employee', observed(), 'healthy'],
    ['an employee the owner stopped', observed({ desiredRunning: false }), 'owner-stopped'],
    ['an employee who is out of the office', observed({ onVacation: true }), 'owner-stopped', /out of the office/],
    ['an employee without a recorded intent', observed({ desiredRunning: undefined }), 'owner-stopped'],
    ['a binding migration', observed({ bindingMigration: true }), 'move-in-progress'],
    ['a move that is working', move(undefined, { phase: 'starting' }), 'move-in-progress'],
    ['a held move whose step is in flight', move('x', { busy: true }), 'move-in-progress'],
    ['a held move', move('The original Docker move flight changed'), 'move-held-retryable', /stopped part-way/],
    ['a held move of the retired runtime', move('x', { docker: false }), 'move-held-retryable', /before the laptop runtime/],
    ['a held move with no continue step', move('x', { allowedActions: [] }), 'move-held-retryable'],
    [
      'a session parked on a sign-in screen',
      observed({ session: { startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false } } }),
      'needs-sign-in',
      /sign-in screen/,
    ],
    [
      'a session on a first-run screen the office is answering',
      observed({ session: { startupScreen: { label: "Claude's theme chooser", kind: 'first-run', answering: true } } }),
      'waiting-first-run-screen',
    ],
    [
      'a session on a first-run screen the office gave up on',
      observed({ session: { startupScreen: { label: "Claude's theme chooser", kind: 'first-run', answering: false } } }),
      'stuck-first-run-screen',
    ],
    [
      // No row of the table reports a decision any more. A reading that still says so is no reason to ask the owner.
      'a session on a screen once left to the owner',
      observed({ session: { startupScreen: { label: 'a permissions prompt', kind: 'decision', answering: false } } }),
      'stuck-first-run-screen',
    ],
    ['a laptop set-up that is still running', held('DOCKER_CONTINUATION_BUSY'), 'starting'],
    ['a laptop read that a busy box could not finish in time', held('DOCKER_RESOURCE_PROBE_DEADLINE'), 'starting'],
    ['a first process the office could not read just now', held('DOCKER_RESOURCE_INIT_UNKNOWN'), 'starting'],
    ['a first process that changed while it was read', held('DOCKER_RESOURCE_INIT_CHANGED'), 'starting'],
    ['a laptop read that failed without a named reason', held('DOCKER_CONTINUATION_UNCONFIRMED'), 'starting'],
    [
      'a set-up step waiting for its acknowledgement',
      observed({
        laptop: {
          record: { phase: 'start-issued', version: 2, operationId: 'op-1' },
          continuation: { state: 'pending', phase: 'start-issued', allowedActions: ['observe'] },
        },
      }),
      'starting',
    ],
    [
      'a set-up that stopped between steps',
      observed({
        laptop: {
          record: { phase: 'pool-ready', version: 2, operationId: 'op-1' },
          continuation: { state: 'pending', phase: 'pool-ready', allowedActions: ['observe', 'continue'] },
        },
      }),
      'held-retryable',
    ],
    ['a limits step that lost a process', held('DOCKER_RESOURCE_HELPER_RETRY_PENDING'), 'held-retryable'],
    ['a failed limits helper', held('DOCKER_RESOURCE_HELPER_FAILED'), 'held-needs-rebuild'],
    ['an unacknowledged limits helper', held('DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED'), 'held-needs-rebuild'],
    [
      'a stopped laptop while other laptops run',
      { ...held('DOCKER_CONTINUATION_CONTAINER_STOPPED'), laptop: { ...held('DOCKER_CONTINUATION_CONTAINER_STOPPED').laptop, poolAlive: true } },
      'held-needs-rebuild',
    ],
    ['a stopped laptop when no laptop runs', held('DOCKER_CONTINUATION_DESTINATION_STOPPED'), 'needs-owner', /No other laptop of this office is running either/],
    ['an agent that is not running', held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED'), 'provider-exited'],
    [
      'an attached employee whose record was never moved on to ready',
      observed({ laptop: { record: { phase: 'provider-issued', version: 2, operationId: 'op-1' } } }),
      'healthy',
    ],
    [
      'an agent the health reader calls dead',
      observed({ session: { providerHealth: 'dead' } }),
      'provider-exited',
    ],
    [
      'a terminal that could not be attached',
      observed({ laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' } } }),
      'viewer-lost',
    ],
    ['a disconnected terminal', observed({ session: { viewerHealth: 'disconnected' } }), 'viewer-lost'],
    ['an office with no session object', observed({ session: { available: false } }), 'viewer-lost'],
    ['no approved limits on a set-up', held('DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED'), 'laptop-not-started'],
    ['the shared pool helper', held('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED'), 'needs-owner'],
    ['an unverified shared pool with nothing to re-send', held('DOCKER_CONTINUATION_POOL_UNCONFIRMED'), 'needs-owner'],
    [
      'an unverified shared pool whose helper was never started',
      held('DOCKER_CONTINUATION_POOL_UNCONFIRMED', { allowedActions: ['observe', 'continue'] }),
      'held-retryable',
    ],
    [
      'a fresh laptop source',
      observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped' } }),
      'laptop-not-started',
    ],
    [
      'no laptop and no approved limits',
      observed({ laptop: { record: null, bound: false, restoration: undefined, policyApproved: false } }),
      'laptop-not-started',
    ],
    [
      'no laptop at all, and no record of an earlier one',
      observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'absent', templateOnRecord: false } }),
      'unknown',
      /found no laptop to start from/,
    ],
    [
      'no laptop, with an earlier laptop operation on record',
      observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'absent' } }),
      'held-needs-rebuild',
    ],
    ['a code nobody has listed', held('DOCKER_CONTINUATION_SOMETHING_NEW'), 'held-needs-rebuild', /does not recognize/],
    ['a code that is not a code', held('rm -rf /'), 'held-needs-rebuild'],
    ['something the office did not start in the laptop terminal', held('DOCKER_CONTINUATION_FOREIGN_PROVIDER'), 'held-needs-rebuild', /cannot take it over/],
    ['an office whose laptop configuration changed under it', held('DOCKER_CONTINUATION_RUNTIME_CHANGED'), 'starting', /restarts itself/],
    [
      'an employee outside a laptop who is connected',
      observed({ boxed: false, laptop: { record: null, bound: false, restoration: undefined } }),
      'healthy',
    ],
    [
      'an employee outside a laptop who is not connected',
      observed({ boxed: false, session: { available: false }, laptop: { record: null, bound: false, restoration: undefined } }),
      'viewer-lost',
      /the office wakes it/,
    ],
  ];
  it.each(cases)('%s', (_title, input, condition, sentence) => {
    const result = classifyEmployee(input);
    expect(result.condition).toBe(condition);
    expect(result.sentence).toMatch(/^[A-Z“].*[.:a-z”…)]/);
    expect(result.sentence).not.toMatch(/undefined|\{name\}/);
    if (sentence) expect(result.sentence).toMatch(sentence);
  });

  it('covers every condition of the closed set', () => {
    const seen = new Set(cases.map(([, input]) => classifyEmployee(input).condition));
    // `move-held-dead-end` is `move-held-retryable` once its ladder reaches the abandon rung (see the ladder tests).
    const all: SupervisorCondition[] = [
      'healthy', 'starting', 'waiting-first-run-screen', 'stuck-first-run-screen', 'needs-sign-in', 'needs-owner',
      'provider-exited',
      'viewer-lost', 'held-retryable', 'held-needs-rebuild', 'laptop-not-started', 'move-in-progress',
      'move-held-retryable', 'owner-stopped', 'unknown',
    ];
    expect([...seen].sort()).toEqual([...all].sort());
  });

  it('gives no ladder to a condition that is not a laptop or move it can work on', () => {
    for (const condition of ['unknown', 'needs-owner', 'owner-stopped', 'healthy', 'starting'] as const)
      expect(SUPERVISOR_PATHS[condition]).toBeUndefined();
  });

  it('recognizes every resource helper code the recovery guidance describes', () => {
    for (const code of [
      'DOCKER_RESOURCE_HELPER_RETRY_PENDING', 'DOCKER_RESOURCE_HELPER_RETRY_EXHAUSTED',
      'DOCKER_RESOURCE_HELPER_RETRY_UNCONFIRMED', 'DOCKER_RESOURCE_HELPER_ATTEMPTS_SPENT',
      'DOCKER_RESOURCE_HELPER_REFUSED', 'DOCKER_RESOURCE_HELPER_CLOSE_UNCONFIRMED',
      'DOCKER_RESOURCE_HELPER_FAILURE_UNKNOWN', 'DOCKER_RESOURCE_HELPER_RETRY_SCOPE_CHANGED',
      'DOCKER_RESOURCE_LEAF_WRITER_IMAGE_UNAVAILABLE',
    ]) {
      const guidance = dockerRecoveryGuidance(code)!;
      const kind = supervisorCodeKind(code)!;
      // The supervisor re-sends exactly where the guidance offers `retry`, and rebuilds where it offers only that.
      expect([code, ['retry', 'retry-owner'].includes(kind)]).toEqual([code, guidance.allowedActions.includes('retry')]);
    }
  });

  it('reads a local-model launch check by its prefix and keeps its own sentence', () => {
    const refusal = held('DOCKER_CONTINUATION_LOCAL_MODEL_SOCKET_NOT_MOUNTED', {
      phase: 'identity-ready',
      allowedActions: ['observe', 'continue'],
      message: 'Stan’s laptop was created without the local model socket.',
    });
    expect(classifyEmployee(refusal)).toMatchObject({
      condition: 'held-retryable',
      sentence: 'Stan’s laptop was created without the local model socket.',
    });
    expect(supervisorCodeKind('DOCKER_CONTINUATION_LOCAL_MODEL_')).toBeUndefined();
    expect(supervisorCodeKind('DOCKER_CONTINUATION_LOCAL_MODEL_x; rm')).toBeUndefined();
  });

  it('asks for a sign-in only when the office itself is signed out of the plan, and names the plan', () => {
    const screen = { label: "Claude's sign-in screen", kind: 'credential' as const, answering: false };
    const unsigned = classifyEmployee(observed({ planSignedIn: false, session: { startupScreen: screen } }));
    expect(unsigned).toMatchObject({ condition: 'needs-sign-in', code: 'plan-signed-out' });
    expect(unsigned.needsHuman).toMatch(/^The plan “Max 20x” is not signed in at the office\./);
    expect(unsigned.needsHuman).toMatch(/Only the account holder can sign a plan in \(Plans\)/);
    expect(unsigned.needsHuman).not.toMatch(/terminal/);
    // Signed in at the office, or not known yet: the office repairs it and asks nobody.
    for (const planSignedIn of [true, undefined]) {
      const signed = classifyEmployee(observed({ planSignedIn, session: { startupScreen: screen } }));
      expect(signed).toMatchObject({ condition: 'needs-sign-in', code: 'sign-in-screen' });
      expect(signed.needsHuman).toBeUndefined();
      expect(signed.fingerprint).toBe(unsigned.fingerprint);
    }
  });

  it('keeps how an exited agent ended in its sentence', () => {
    const result = classifyEmployee(
      held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED', {
        phase: 'provider-issued',
        providerExit: 'The agent exited with status 1 right after it started. Its last line was: model not found',
      })
    );
    expect(result.sentence).toBe(
      "Stan's agent is not running in their laptop. The agent exited with status 1 right after it started. Its last line was: model not found"
    );
  });
});

describe('employee supervisor: plan move errors', () => {
  it('reads the sentences the office itself writes', () => {
    const screen = (kind: 'credential' | 'decision' | 'first-run', answering = false) =>
      describeStartupScreen("Stan's new session", { label: 'a screen', kind, answering });
    expect(classifyMoveError(screen('credential'))).toBe('sign-in');
    expect(classifyMoveError(screen('decision'))).toBe('owner-decision');
    expect(classifyMoveError(screen('first-run', true))).toBe('first-run');
    expect(classifyMoveError(screen('first-run'))).toBe('first-run');
    expect(classifyMoveError(new PlanMoveComposerNotReady().message)).toBe('first-run');
  });
  it('reads a laptop code by the same table as a laptop hold', () => {
    expect(classifyMoveError('DOCKER_RESOURCE_HELPER_FAILED')).toBe('laptop-step');
    expect(classifyMoveError('DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED')).toBe('laptop-step');
    expect(classifyMoveError('DOCKER_RESOURCE_HELPER_RETRY_PENDING')).toBe('laptop-step');
    expect(classifyMoveError('DOCKER_CONTINUATION_BUSY')).toBe('wait');
    expect(classifyMoveError('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED')).toBe('owner');
  });
  it('calls everything else unrecognized', () => {
    for (const text of [undefined, '', 'Docker move unavailable', 'DOCKER_NEW_THING', 'The original Docker journal changed'])
      expect(classifyMoveError(text)).toBe('unrecognized');
  });
});

describe('employee supervisor: ladder', () => {
  const pending = held('DOCKER_RESOURCE_HELPER_RETRY_PENDING', { allowedActions: ['observe', 'continue', 'retry', 'rebuild-preview'] });
  const fingerprint = 'code:DOCKER_RESOURCE_HELPER_RETRY_PENDING';

  it('waits out the dwell before the first retry', () => {
    const result = assessEmployee(pending, since(1000, fingerprint), ON, 1000);
    expect(result).toMatchObject({ condition: 'held-retryable', next: { action: 'resend-continuation', at: 21_000 } });
  });

  it('spaces retries by the backoff and stops at the bound', () => {
    const rung = SUPERVISOR_POLICY.ladder['resend-continuation'];
    const at = (count: number, lastAt: number) =>
      assessEmployee(pending, since(0, fingerprint, { attempts: tried('resend-continuation', count, lastAt) }), ON, lastAt).next;
    expect(at(1, 100_000)).toMatchObject({ action: 'resend-continuation', at: 100_000 + 30_000 });
    expect(at(2, 100_000)).toMatchObject({ action: 'resend-continuation', at: 100_000 + 2 * MINUTE });
    expect(at(3, 100_000)).toMatchObject({ action: 'resend-continuation', at: 100_000 + 5 * MINUTE });
    expect(at(rung.maxAttempts, 100_000)).toMatchObject({ action: null, at: 100_000 + rung.escalateAfterMs });
  });

  it('escalates to a rebuild only after the last retry has had time to settle', () => {
    const attempts = tried('resend-continuation', 4, 10 * MINUTE);
    const waiting = assessEmployee(pending, since(0, fingerprint, { attempts }), ON, 11 * MINUTE);
    expect(waiting).toMatchObject({ condition: 'held-retryable', next: { action: null, waitingFor: 'the outcome of the last attempt' } });
    const escalated = assessEmployee(pending, since(0, fingerprint, { attempts }), ON, 12 * MINUTE);
    expect(escalated).toMatchObject({
      condition: 'held-needs-rebuild',
      next: { action: 'rebuild-laptop', preconditions: ['no-agent-running'] },
    });
  });

  it('goes straight to the rebuild rung when the operation offers nothing to re-send', () => {
    const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
    const result = assessEmployee(failed, since(0, 'code:DOCKER_RESOURCE_HELPER_FAILED'), ON, MINUTE);
    expect(result).toMatchObject({ condition: 'held-needs-rebuild', next: { action: 'rebuild-laptop', at: 3 * MINUTE } });
  });

  it('re-sends first even for a rebuild code while the operation still offers it', () => {
    const failed = held('DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED', { allowedActions: ['observe', 'continue'] });
    const result = assessEmployee(failed, since(0, 'code:DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED'), ON, MINUTE);
    expect(result.next.action).toBe('resend-continuation');
  });

  it('never re-sends a plan move record through the laptop route', () => {
    const replacement = held('DOCKER_RESOURCE_HELPER_RETRY_PENDING', { allowedActions: ['observe', 'continue'] });
    const result = assessEmployee(
      { ...replacement, laptop: { ...replacement.laptop, record: { phase: 'resources-issued', version: 3, operationId: 'op-1' } } },
      since(0, fingerprint),
      ON,
      MINUTE
    );
    expect(result.next.action).toBe('rebuild-laptop');
  });

  describe('rebuild', () => {
    const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
    const history = since(0, 'code:DOCKER_RESOURCE_HELPER_FAILED');
    const provider = (kind: NonNullable<SupervisorObservation['laptop']['provider']> | undefined, patch = {}) =>
      assessEmployee({ ...failed, laptop: { ...failed.laptop, provider: kind, ...patch } }, history, ON, 10 * MINUTE);

    it('asks the driver for a fresh read before it is decided', () => {
      expect(provider(undefined).next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['no-agent-running'] });
    });
    it.each(['exited', 'absent', 'no-laptop'] as const)('is automatic when the agent is %s', (kind) => {
      expect(provider(kind).next).toMatchObject({ action: 'rebuild-laptop', preconditions: [] });
    });
    it('is not asked for while an agent runs in a laptop whose pane the office is not reading', () => {
      const result = provider('running');
      expect(result.next).toMatchObject({
        action: null,
        waitingFor: "a reading of the agent's terminal; if there is still none, the laptop is rebuilt at 1970-01-01 02:00 UTC",
        at: 120 * MINUTE,
      });
      expect(result.needsHuman).toBeUndefined();
    });
    it('treats an unreadable laptop as unknown, not as empty', () => {
      const result = provider('unknown');
      expect(result.next).toMatchObject({ action: null, waitingFor: 'a confirmed read of what is running in the laptop' });
      expect(result.needsHuman).toBeUndefined();
    });
    it('needs an approved laptop layout on record', () => {
      const result = provider('exited', { templateOnRecord: false });
      expect(result.next.action).toBeNull();
      expect(result.needsHuman).toMatch(/No owner-approved laptop layout/);
    });
    it('is bounded per episode and per day', () => {
      const twice = assessEmployee(
        { ...failed, laptop: { ...failed.laptop, provider: 'exited' } },
        { ...history, attempts: tried('rebuild-laptop', 2, MINUTE) },
        ON,
        60 * MINUTE
      );
      // Both tries of this round are used. The ladder does not end: it says when it starts again.
      expect(twice.next).toMatchObject({
        action: null,
        at: MINUTE + 6 * 60 * MINUTE,
        waitingFor: "the next round of repair steps, which starts at 1970-01-01 06:01 UTC: this round's did not help",
      });
      expect(twice.needsHuman).toBeUndefined();
      const today = assessEmployee(
        { ...failed, laptop: { ...failed.laptop, provider: 'exited' } },
        { ...history, rebuilds: [60 * MINUTE, 120 * MINUTE] },
        ON,
        180 * MINUTE
      );
      // The limit per day is a pause that says when it lifts.
      expect(today.next).toMatchObject({
        action: null,
        at: 25 * 60 * MINUTE,
        waitingFor: expect.stringMatching(/^the daily limit on rebuilds of one laptop \(2\): .* may run at 1970-01-02 01:00 UTC$/),
      });
      expect(today.needsHuman).toBeUndefined();
      const nextDay = assessEmployee(
        { ...failed, laptop: { ...failed.laptop, provider: 'exited' } },
        { ...history, rebuilds: [60 * MINUTE, 120 * MINUTE] },
        ON,
        26 * 60 * MINUTE
      );
      expect(nextDay.next.action).toBe('rebuild-laptop');
    });
    it('waits fifteen minutes between two rebuilds', () => {
      const again = assessEmployee(
        { ...failed, laptop: { ...failed.laptop, provider: 'exited' } },
        { ...history, attempts: tried('rebuild-laptop', 1, 20 * MINUTE) },
        ON,
        21 * MINUTE
      );
      expect(again.next).toMatchObject({ action: 'rebuild-laptop', at: 35 * MINUTE });
    });
  });

  describe('an exited agent', () => {
    const exited = held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED', { phase: 'provider-issued' });
    const history = since(0, 'code:DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED');
    it('is relaunched in place when the office can', () => {
      const result = assessEmployee(exited, history, { ...ON, relaunchAvailable: true }, MINUTE);
      expect(result).toMatchObject({ condition: 'provider-exited', next: { action: 'relaunch-provider' } });
    });
    it('is rebuilt when it cannot, once nothing runs in the laptop', () => {
      const result = assessEmployee(exited, history, ON, MINUTE);
      expect(result).toMatchObject({ condition: 'provider-exited', next: { action: 'rebuild-laptop', at: 3 * MINUTE } });
    });
  });

  describe('a held plan move', () => {
    const composer = move(new PlanMoveComposerNotReady().message);
    const fp = classifyEmployee(composer).fingerprint;
    it('is continued first', () => {
      expect(assessEmployee(composer, since(0, fp), ON, 0).next).toMatchObject({ action: 'continue-move', at: MINUTE });
    });
    it('is abandoned only after three continues and fifteen minutes on the same error', () => {
      const attempts = tried('continue-move', 3, 8 * MINUTE);
      const settling = assessEmployee(composer, since(0, fp, { attempts }), ON, 10 * MINUTE);
      expect(settling).toMatchObject({ condition: 'move-held-retryable', next: { action: null } });
      const early = assessEmployee(composer, since(0, fp, { attempts }), ON, 12 * MINUTE);
      expect(early).toMatchObject({ condition: 'move-held-dead-end', next: { action: 'abandon-move', at: 15 * MINUTE } });
    });
    it('restarts the fifteen minutes when the error changes', () => {
      const history = rollSupervisorHistory(since(0, 'move:move-1:something else'), classifyEmployee(composer), 14 * MINUTE);
      expect(history.since).toBe(14 * MINUTE);
    });
  });

  describe('switches', () => {
    const failed = { ...held('DOCKER_RESOURCE_HELPER_FAILED'), laptop: { ...held('DOCKER_RESOURCE_HELPER_FAILED').laptop, provider: 'exited' as const } };
    const pendingHistory = since(0, fingerprint);
    it('does nothing when the supervisor is switched off, and says what to do by hand', () => {
      const off = assessEmployee(pending, pendingHistory, { ...ON, enabled: false }, 60 * MINUTE);
      expect(off.next.action).toBeNull();
      expect(off.needsHuman).toMatch(/supervisorEnabled.*docker-continuation/);
    });
    it('still retries with repairs switched off, but neither abandons nor rebuilds', () => {
      const retry = assessEmployee(pending, pendingHistory, { ...ON, autoRepair: false }, 60 * MINUTE);
      expect(retry.next.action).toBe('resend-continuation');
      const rebuild = assessEmployee(failed, since(0, 'x'), { ...ON, autoRepair: false }, 60 * MINUTE);
      expect(rebuild.next.action).toBeNull();
      expect(rebuild.needsHuman).toMatch(/supervisorAutoRepair.*docker-rebuild/);
      const abandon = assessEmployee(
        move('DOCKER_RESOURCE_HELPER_FAILED'),
        since(0, 'x', { attempts: tried('continue-move', 3, 0) }),
        { ...ON, autoRepair: false },
        60 * MINUTE
      );
      expect(abandon.next.action).toBeNull();
      expect(abandon.needsHuman).toMatch(/supervisorAutoRepair.*abandon/);
    });
  });

  it('starts nothing beside another operation on the same employee', () => {
    for (const busy of ['continuation-flight', 'laptop-operation', 'owner-stop-pending', 'recovery-pending', 'lifecycle-in-progress', 'publication-unconfirmed'] as const) {
      const result = assessEmployee({ ...pending, busy }, since(0, fingerprint), ON, 60 * MINUTE);
      expect([busy, result.next.action]).toEqual([busy, null]);
      expect(result.next.waitingFor).toBeTruthy();
    }
  });

  it('never returns an action for an employee the owner stopped, whatever else is observed', () => {
    for (const patch of [{ desiredRunning: false }, { onVacation: true }, { desiredRunning: undefined }] as const) {
      const stopped = { ...held('DOCKER_RESOURCE_HELPER_FAILED'), ...patch, move: move('DOCKER_RESOURCE_HELPER_FAILED').move };
      const result = assessEmployee(stopped, since(0, 'x', { attempts: {} }), ON, 600 * MINUTE);
      expect(result).toMatchObject({ condition: 'owner-stopped', next: { action: null } });
      expect(result.needsHuman).toBeUndefined();
    }
  });

  it('treats a start that never finishes as a hold, and asks nobody', () => {
    const starting = held('DOCKER_CONTINUATION_BUSY');
    const history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, classifyEmployee(starting), 1000);
    const early = assessEmployee(starting, history, ON, 1000 + 14 * MINUTE);
    expect(early).toMatchObject({ condition: 'starting', next: { action: null } });
    expect(early.needsHuman).toBeUndefined();
    // Fifteen minutes on, the rebuild is considered, with its usual wait counted from that moment.
    const stalled = assessEmployee(starting, history, ON, 1000 + 15 * MINUTE);
    expect(stalled).toMatchObject({
      condition: 'held-needs-rebuild',
      next: { action: 'rebuild-laptop', at: 1000 + 18 * MINUTE, preconditions: ['no-agent-running'] },
    });
    expect(stalled.needsHuman).toBeUndefined();
  });

  it('nudges a lost terminal, never rebuilds for it, and starts the nudges again six hours on', () => {
    const lost = observed({ laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' } } });
    const fp = classifyEmployee(lost).fingerprint;
    expect(assessEmployee(lost, since(0, fp), ON, 0).next).toMatchObject({ action: 'reconnect-viewer', at: 45_000 });
    const spent = assessEmployee(lost, since(0, fp, { attempts: tried('reconnect-viewer', 6, 0) }), ON, 60 * MINUTE);
    expect(spent.next).toMatchObject({ action: null, at: 6 * 60 * MINUTE });
    expect(spent.next.waitingFor).toMatch(/^the next round of repair steps, which starts at 1970-01-01 06:00 UTC/);
    expect(spent.needsHuman).toBeUndefined();
    expect(SUPERVISOR_PATHS['viewer-lost']).not.toContain('rebuild-laptop');
  });

  it('starts a fresh laptop source, three tries a round', () => {
    const fresh = observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped' } });
    expect(assessEmployee(fresh, since(0, 'source-stopped'), ON, MINUTE).next.action).toBe('start-continuation');
    const spent = assessEmployee(fresh, since(0, 'source-stopped', { attempts: tried('start-continuation', 3, 0) }), ON, 60 * MINUTE);
    expect(spent.next).toMatchObject({ action: null, at: 6 * 60 * MINUTE });
    expect(spent.needsHuman).toBeUndefined();
  });

  it('orders every path from the least to the most destructive step', () => {
    const order: SupervisorAction[] = [
      'resend-continuation', 'start-continuation', 'continue-move', 'reconnect-viewer', 'replace-sign-in', 'relaunch-provider',
      'abandon-move', 'rebuild-laptop',
    ];
    for (const path of Object.values(SUPERVISOR_PATHS)) {
      const ranks = path!.map((action) => order.indexOf(action));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      const tiers = path!.map((action) => SUPERVISOR_POLICY.ladder[action].tier);
      expect(tiers.lastIndexOf('retry')).toBeLessThan(tiers.includes('repair') ? tiers.indexOf('repair') : tiers.length);
    }
    for (const rung of Object.values(SUPERVISOR_POLICY.ladder)) {
      expect(rung.maxAttempts).toBeGreaterThan(0);
      expect(rung.maxAttempts).toBeLessThanOrEqual(6);
      expect(rung.backoffMs.every((ms) => ms >= 30_000)).toBe(true);
    }
  });
});

describe('employee supervisor: history', () => {
  const problem = { condition: 'held-retryable' as const, fingerprint: 'code:A' };
  const transit = { condition: 'starting' as const, fingerprint: '' };
  const healthy = { condition: 'healthy' as const, fingerprint: '' };

  it('keeps a problem’s clock and attempts across the retry it caused', () => {
    let history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, problem, 1000);
    history = recordSupervisorAttempt(history, 'resend-continuation', 2000, 'done');
    history = rollSupervisorHistory(history, transit, 3000);
    history = rollSupervisorHistory(history, problem, 4000);
    expect(history).toMatchObject({ fingerprint: 'code:A', since: 1000, attempts: { 'resend-continuation': { count: 1, lastAt: 2000 } } });
  });

  it('keeps the attempts when the problem changes, so a flapping laptop stays bounded', () => {
    let history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, problem, 1000);
    history = recordSupervisorAttempt(history, 'rebuild-laptop', 2000, 'done');
    history = rollSupervisorHistory(history, { condition: 'laptop-not-started', fingerprint: 'source-stopped' }, 3000);
    history = rollSupervisorHistory(history, healthy, 4000);
    history = rollSupervisorHistory(history, problem, 5000);
    expect(history).toMatchObject({ since: 5000, attempts: { 'rebuild-laptop': { count: 1 } }, rebuilds: [2000] });
  });

  it('ends the episode only after ten healthy minutes', () => {
    let history = recordSupervisorAttempt(rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, problem, 0), 'rebuild-laptop', 1000, 'done');
    history = rollSupervisorHistory(history, healthy, 2000);
    history = rollSupervisorHistory(history, healthy, 2000 + 9 * MINUTE);
    expect(history.attempts['rebuild-laptop']?.count).toBe(1);
    history = rollSupervisorHistory(history, healthy, 2000 + 10 * MINUTE);
    expect(history.attempts).toEqual({});
    // The daily rebuild budget outlives the episode.
    expect(history.rebuilds).toEqual([1000]);
    expect(history.lastAction).toMatchObject({ action: 'rebuild-laptop', outcome: 'done' });
  });

  it('starts over once the owner has stopped the employee', () => {
    const history = rollSupervisorHistory(
      recordSupervisorAttempt(rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, problem, 0), 'resend-continuation', 1, 'done'),
      { condition: 'owner-stopped', fingerprint: '' },
      5000
    );
    expect(history).toMatchObject({ fingerprint: '', attempts: {} });
  });

  it('counts a rebuild toward the day only when it was done', () => {
    const refused = recordSupervisorAttempt(EMPTY_SUPERVISOR_HISTORY, 'rebuild-laptop', 10, 'refused', 'DOCKER_REPROVISION_BUSY');
    expect(refused.rebuilds).toEqual([]);
    expect(refused.attempts['rebuild-laptop']).toEqual({ count: 1, lastAt: 10 });
    expect(refused.lastAction).toEqual({ action: 'rebuild-laptop', at: 10, outcome: 'refused', detail: 'DOCKER_REPROVISION_BUSY' });
  });

  it('spends an attempt when it is issued and gives it back only when nothing was tried', () => {
    const issued = issueSupervisorAttempt(EMPTY_SUPERVISOR_HISTORY, 'rebuild-laptop', 10);
    expect(issued).toMatchObject({ attempts: { 'rebuild-laptop': { count: 1, lastAt: 10 } }, lastAction: { outcome: 'issued' }, rebuilds: [] });
    expect(settleSupervisorAttempt(issued, 'done').rebuilds).toEqual([10]);
    expect(settleSupervisorAttempt(issued, 'failed', 'EPIPE').attempts['rebuild-laptop']).toEqual({ count: 1, lastAt: 10 });
    const busy = settleSupervisorAttempt(issued, 'busy', 'DOCKER_REPROVISION_BUSY');
    expect(busy.attempts['rebuild-laptop']).toEqual({ count: 0, lastAt: 10 });
    expect(busy.rebuilds).toEqual([]);
    // Settling twice, or settling nothing, changes nothing.
    expect(settleSupervisorAttempt(busy, 'done')).toBe(busy);
    expect(settleSupervisorAttempt(EMPTY_SUPERVISOR_HISTORY, 'done')).toBe(EMPTY_SUPERVISOR_HISTORY);
  });
});

describe('employee supervisor: laptops the office cannot judge alone', () => {
  it('finishes a rebuild that was recorded and not finished', () => {
    const pending = observed({ laptop: { record: null, bound: false, restoration: undefined, rebuildPending: true } });
    const seen = classifyEmployee(pending);
    expect(seen).toMatchObject({ condition: 'held-needs-rebuild', code: 'rebuild-pending' });
    expect(assessEmployee(pending, since(0, seen.fingerprint), ON, 5 * MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['no-agent-running'],
    });
  });

  it('leaves a stopped laptop to the owner while no other laptop runs, and rebuilds it once one does', () => {
    const stopped = held('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    const alone = assessEmployee(stopped, since(0, 'x'), ON, 60 * MINUTE);
    expect(alone).toMatchObject({ condition: 'needs-owner', next: { action: null } });
    expect(alone.needsHuman).toMatch(/recover the shared pool first.*cold-preview/);
    const withOthers = { ...stopped, laptop: { ...stopped.laptop, poolAlive: true, provider: 'no-laptop' as const } };
    expect(assessEmployee(withOthers, since(0, 'x'), ON, 60 * MINUTE).next.action).toBe('rebuild-laptop');
  });

  it('builds no laptop while none is running anywhere, because that is what a host restart looks like', () => {
    const failed = held('DOCKER_CONTINUATION_DESTINATION_UNCONFIRMED');
    const history = since(0, classifyEmployee(failed).fingerprint);
    const gone = (poolAlive: boolean | undefined, provider: 'no-laptop' | 'absent') =>
      assessEmployee({ ...failed, laptop: { ...failed.laptop, provider, poolAlive } }, history, ON, 10 * MINUTE);
    expect(gone(true, 'no-laptop').next.action).toBe('rebuild-laptop');
    const alone = gone(false, 'no-laptop');
    expect(alone.next.action).toBeNull();
    expect(alone.needsHuman).toMatch(/No laptop of this office is running.*cold-recover/);
    // A laptop that runs with no agent in it is evidence that the box is up.
    expect(gone(false, 'absent').next.action).toBe('rebuild-laptop');
  });

  it('treats a laptop that has been unreadable for fifteen minutes as one an agent runs in', () => {
    const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
    const unread = { ...failed, laptop: { ...failed.laptop, provider: 'unknown' as const } };
    const history = since(MINUTE, classifyEmployee(failed).fingerprint);
    expect(assessEmployee(unread, history, ON, 15 * MINUTE).next).toMatchObject({
      action: null,
      waitingFor: 'a confirmed read of what is running in the laptop',
    });
    // Never as an empty one: from here on the rebuild waits for the agent to be between turns.
    const stuck = assessEmployee(unread, history, ON, 16 * MINUTE);
    expect(stuck.next).toMatchObject({ action: null, at: 121 * MINUTE });
    expect(stuck.next.waitingFor).toMatch(/^a reading of the agent's terminal; if there is still none, the laptop is rebuilt at/);
    expect(stuck.needsHuman).toBeUndefined();
    const idle = { ...unread, session: { ...unread.session, turn: 'idle' as const, idleSince: 10 * MINUTE } };
    expect(assessEmployee(idle, history, ON, 16 * MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['agent-between-turns', 'laptop-held'],
    });
  });
});

describe('employee supervisor: last night', () => {
  it('a plan move left in recovery-required is continued, then abandoned, then the laptop is rebuilt', () => {
    const stuck = move('DOCKER_RESOURCE_HELPER_FAILED');
    let history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, classifyEmployee(stuck), 0);
    const actions: Array<[number, string]> = [];
    for (let now = 0; now <= 20 * MINUTE; now += 30_000) {
      history = rollSupervisorHistory(history, classifyEmployee(stuck), now);
      const next = assessEmployee(stuck, history, ON, now).next;
      if (next.action && (next.at ?? 0) <= now) {
        actions.push([now / MINUTE, next.action]);
        history = recordSupervisorAttempt(history, next.action, now, 'done');
      }
    }
    expect(actions).toEqual([
      [1, 'continue-move'],
      [3, 'continue-move'],
      [8, 'continue-move'],
      [15, 'abandon-move'],
      [20, 'abandon-move'],
    ]);
    // With the move closed, the laptop it left behind is what remains.
    const after = { ...held('DOCKER_RESOURCE_HELPER_FAILED'), laptop: { ...held('DOCKER_RESOURCE_HELPER_FAILED').laptop, provider: 'absent' as const } };
    history = rollSupervisorHistory(history, classifyEmployee(after), 21 * MINUTE);
    expect(assessEmployee(after, history, ON, 21 * MINUTE).next).toMatchObject({ action: 'rebuild-laptop', at: 24 * MINUTE });
  });

  it('a laptop held at DOCKER_RESOURCE_HELPER_FAILED is rebuilt and then started', () => {
    const failed = { ...held('DOCKER_RESOURCE_HELPER_FAILED'), laptop: { ...held('DOCKER_RESOURCE_HELPER_FAILED').laptop, provider: 'absent' as const } };
    const history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, classifyEmployee(failed), 0);
    expect(assessEmployee(failed, history, ON, 3 * MINUTE).next).toMatchObject({ action: 'rebuild-laptop', at: 3 * MINUTE });
    const rebuilt = observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped' } });
    const after = rollSupervisorHistory(recordSupervisorAttempt(history, 'rebuild-laptop', 3 * MINUTE, 'done'), classifyEmployee(rebuilt), 4 * MINUTE);
    expect(assessEmployee(rebuilt, after, ON, 5 * MINUTE).next).toMatchObject({ action: 'start-continuation', at: 4 * MINUTE + 20_000 });
  });

  it('a laptop held at DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED takes the same road', () => {
    const failed = held('DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED');
    expect(assessEmployee(failed, since(0, classifyEmployee(failed).fingerprint), ON, 5 * MINUTE)).toMatchObject({
      condition: 'held-needs-rebuild',
      next: { action: 'rebuild-laptop' },
    });
  });

  it('an agent that exited inside a healthy running laptop is rebuilt once a fresh read shows it exited', () => {
    const dead = held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED', { phase: 'ready', providerExit: 'The agent exited with status 0 right after it started.' });
    const history = since(0, classifyEmployee(dead).fingerprint);
    expect(assessEmployee(dead, history, ON, 4 * MINUTE).next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['no-agent-running'] });
    const fresh = (provider: 'exited' | 'running') => ({ ...dead, laptop: { ...dead.laptop, provider } });
    expect(assessEmployee(fresh('exited'), history, ON, 4 * MINUTE).next).toMatchObject({ action: 'rebuild-laptop', preconditions: [] });
    expect(assessEmployee(fresh('running'), history, ON, 4 * MINUTE).next.action).toBeNull();
  });

  it('an unused laptop made for an earlier laptop image is replaced by the rebuild rung, or the owner is told the calls', () => {
    // After the office was redeployed with another laptop image this read as "no laptop record, and the office
    // found no laptop to start from", and nothing said that a rebuild was the way out.
    const outdated = observed({
      session: { available: false, viewerHealth: 'disconnected', providerHealth: 'unknown' },
      laptop: { record: null, bound: false, restoration: undefined, source: 'outdated' },
    });
    const seen = classifyEmployee(outdated);
    expect(seen).toMatchObject({
      condition: 'held-needs-rebuild',
      code: 'DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED',
      sentence: "Stan's laptop has never been started and was made for an earlier laptop image, so the office cannot start it.",
    });
    const history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, seen, 0);
    // There is no record to re-send, so the rebuild rung is next; it still waits for a read that nothing runs.
    expect(assessEmployee(outdated, history, ON, MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      at: 3 * MINUTE,
      preconditions: ['no-agent-running'],
    });
    const withProvider = (provider: 'no-laptop' | 'running' | 'unknown', poolAlive = true) => ({
      ...outdated,
      laptop: { ...outdated.laptop, provider, poolAlive },
    });
    expect(assessEmployee(withProvider('no-laptop'), history, ON, 3 * MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: [],
    });
    // The same limits as every other rebuild: never beside a running laptop, an unread one or a dead pool.
    const occupied = assessEmployee(withProvider('running'), history, ON, 3 * MINUTE);
    expect(occupied.next).toMatchObject({ action: null, at: 120 * MINUTE });
    expect(occupied.needsHuman).toBeUndefined();
    expect(assessEmployee(withProvider('unknown'), history, ON, 3 * MINUTE).next).toMatchObject({
      action: null,
      waitingFor: 'a confirmed read of what is running in the laptop',
    });
    expect(assessEmployee(withProvider('no-laptop', false), history, ON, 3 * MINUTE).needsHuman).toMatch(/cold-recover/);
    const spent = { attempts: tried('rebuild-laptop', 2, 0) };
    expect(assessEmployee(withProvider('no-laptop'), since(0, seen.fingerprint, spent), ON, 60 * MINUTE).next).toMatchObject({
      action: null,
      at: 6 * 60 * MINUTE,
    });
    // Repairs switched off, or no layout on record: nothing is replaced and the owner is given the two calls.
    const calls = /POST \/api\/company\/employees\/:id\/docker-rebuild\/preview, then \/apply/;
    const off = assessEmployee(outdated, history, { ...ON, autoRepair: false }, 3 * MINUTE);
    expect(off.next.action).toBeNull();
    expect(off.needsHuman).toMatch(calls);
    const bare = { ...outdated, laptop: { ...outdated.laptop, templateOnRecord: false } };
    expect(assessEmployee(bare, history, ON, 3 * MINUTE)).toMatchObject({
      next: { action: null },
      needsHuman: expect.stringMatching(calls),
    });
    // The policy read that reports this state names the same step.
    expect(supervisorCodeKind('DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED')).toBe('rebuild');
    const guidance = dockerRecoveryGuidance('DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED')!;
    expect(guidance.allowedActions).toEqual(['rebuild-preview']);
    expect(guidance.message).toMatch(/earlier laptop image.*docker-rebuild\/preview.*docker-rebuild\/apply/s);
    // The source the rebuild leaves behind is started by the ordinary rung.
    const rebuilt = observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped' } });
    const after = rollSupervisorHistory(
      recordSupervisorAttempt(history, 'rebuild-laptop', 3 * MINUTE, 'done'),
      classifyEmployee(rebuilt),
      4 * MINUTE
    );
    expect(assessEmployee(rebuilt, after, ON, 5 * MINUTE).next).toMatchObject({ action: 'start-continuation' });
  });

  it('a laptop at a sign-in screen whose plan is signed in at the office is rebuilt, and nobody is asked', () => {
    const screen = observed({
      planSignedIn: true,
      session: {
        startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false, proof: 'widget' },
        turn: 'idle',
        idleSince: 0,
      },
    });
    const result = assessEmployee(screen, since(0, classifyEmployee(screen).fingerprint), ON, 10 * MINUTE);
    expect(result).toMatchObject({
      condition: 'needs-sign-in',
      next: { action: 'rebuild-laptop', preconditions: ['agent-parked-at-screen'] },
    });
    expect(result.sentence).toBe("Stan is waiting at Claude's sign-in screen.");
    expect(result.needsHuman).toBeUndefined();
  });

  it('a local-model agent that exited at launch keeps its evidence and is rebuilt', () => {
    const dead = held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED', {
      phase: 'provider-issued',
      providerExit: 'The agent exited with status 1 right after it started. Its last line was: connection refused',
    });
    const result = assessEmployee({ ...dead, planLabel: 'qwen local', laptop: { ...dead.laptop, provider: 'exited' } }, since(0, classifyEmployee(dead).fingerprint), ON, 4 * MINUTE);
    expect(result).toMatchObject({ condition: 'provider-exited', next: { action: 'rebuild-laptop' } });
    expect(result.sentence).toMatch(/connection refused/);
  });
});

describe('employee supervisor: limits a reload of the service manager reset', () => {
  /** A laptop whose set-up finished and whose agent is running, held by what a fresh read found. */
  const running = (code: string, allowedActions: string[]) => {
    const base = held(code, { phase: 'ready', allowedActions });
    return {
      ...base,
      laptop: {
        ...base.laptop,
        record: { phase: 'ready', version: 2, operationId: 'op-1' },
        provider: 'running' as const,
        templateOnRecord: true,
      },
    };
  };
  const pool = running('DOCKER_CONTINUATION_POOL_UNCONFIRMED', ['observe', 'repair-pool']);
  const poolHistory = (patch: Partial<SupervisorHistory> = {}) =>
    since(0, 'code:DOCKER_CONTINUATION_POOL_UNCONFIRMED', patch);

  it('repairs the shared pool on its own when the laptop’s read offers that', () => {
    const result = assessEmployee(pool, poolHistory(), ON, MINUTE);
    expect(result).toMatchObject({ condition: 'held-retryable', next: { action: 'resend-continuation' } });
    expect(result.needsHuman).toBeUndefined();
  });

  it.each(['DOCKER_CONTINUATION_POOL_UNCONFIRMED', 'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED'])(
    'names the pool repair, and asks the owner, when %s offers nothing',
    (code) => {
      const result = assessEmployee(running(code, ['observe']), since(0, 'code:' + code), ON, MINUTE);
      expect(result).toMatchObject({ condition: 'needs-owner', next: { action: null } });
      expect(result.needsHuman).toContain('docker-pool/repair');
    }
  );

  it('never rebuilds a laptop for the pool that all laptops share, whatever runs in it', () => {
    const spent = tried('resend-continuation', SUPERVISOR_POLICY.ladder['resend-continuation'].maxAttempts, 0);
    for (const provider of ['running', 'exited', 'absent', 'no-laptop'] as const) {
      const result = assessEmployee(
        { ...pool, laptop: { ...pool.laptop, provider } },
        poolHistory({ attempts: spent }),
        ON,
        99 * MINUTE
      );
      expect([provider, result.next.action]).toEqual([provider, null]);
      expect(result.needsHuman).toContain('docker-pool/repair');
    }
  });

  it.each(['DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED', 'DOCKER_RESOURCE_LEAF_ACK_MISSING'])(
    'puts a running laptop’s own limits back before a rebuild is ever considered (%s)',
    (code) => {
      const leaf = running(code, ['observe', 'repair']);
      const first = assessEmployee(leaf, since(0, 'code:' + code), ON, MINUTE);
      expect(first).toMatchObject({ condition: 'held-needs-rebuild', next: { action: 'resend-continuation' } });
      // Once that never helped, a laptop with a running agent is rebuilt between that agent's turns, and only then.
      const spent = tried('resend-continuation', SUPERVISOR_POLICY.ladder['resend-continuation'].maxAttempts, 0);
      const after = assessEmployee(leaf, since(0, 'code:' + code, { attempts: spent }), ON, 99 * MINUTE);
      expect(after.next.action).toBeNull();
      expect(after.needsHuman).toBeUndefined();
      const working = { ...leaf, session: { ...leaf.session, turn: 'working' as const } };
      expect(assessEmployee(working, since(0, 'code:' + code, { attempts: spent }), ON, 99 * MINUTE).next).toMatchObject({
        action: null,
        waitingFor: "the agent's current turn to end",
      });
      const idle = { ...leaf, session: { ...leaf.session, turn: 'idle' as const, idleSince: 90 * MINUTE } };
      expect(assessEmployee(idle, since(0, 'code:' + code, { attempts: spent }), ON, 99 * MINUTE).next).toMatchObject({
        action: 'rebuild-laptop',
        preconditions: ['agent-between-turns', 'laptop-held'],
      });
    }
  );

  it('only describes the repair while automatic retries are switched off', () => {
    const result = assessEmployee(pool, poolHistory(), { ...ON, enabled: false }, MINUTE);
    expect(result.next.action).toBeNull();
    expect(result.needsHuman).toContain('supervisorEnabled');
  });

  it('knows the acknowledgement code as one a laptop can be rebuilt for, and the pool codes as outside one laptop', () => {
    expect(supervisorCodeKind('DOCKER_RESOURCE_LEAF_ACK_MISSING')).toBe('rebuild');
    expect(supervisorCodeKind('DOCKER_CONTINUATION_POOL_UNCONFIRMED')).toBe('retry-owner');
    expect(supervisorCodeKind('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED')).toBe('retry-owner');
  });
});

describe('employee supervisor: a set-up made for an image the office no longer uses', () => {
  const CODE = 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED';
  const FINGERPRINT = 'code:' + CODE;
  /**
   * As observed after an office deploy: the set-up stopped earlier at `pool-issued` with a helper it never started,
   * so the read still offers `continue`; no laptop container of this employee runs; another laptop of the box does.
   */
  const outdated = (provider?: 'no-laptop' | 'running' | 'unknown') => {
    const base = held(CODE, { phase: 'pool-issued', allowedActions: ['observe', 'continue'] });
    return {
      ...base,
      laptop: {
        ...base.laptop,
        record: { phase: 'pool-issued', version: 2, operationId: 'op-1' },
        poolAlive: true,
        ...(provider ? { provider } : {}),
      },
    };
  };
  /** The history after `count` re-sends, the last one at `at` and refused with `detail`. */
  const refused = (at: number, detail: string, count = 1, first = 0) =>
    Array.from({ length: count }).reduce<SupervisorHistory>(
      (history) => recordSupervisorAttempt(history, 'resend-continuation', at, 'refused', detail),
      since(first, FINGERPRINT)
    );

  it('reads as a laptop that needs a rebuild and sends the request once to find out', () => {
    const result = assessEmployee(outdated(), since(0, FINGERPRINT), ON, MINUTE);
    expect(result).toMatchObject({
      condition: 'held-needs-rebuild',
      code: CODE,
      next: { action: 'resend-continuation', at: 20_000 },
    });
  });

  it('rebuilds after the one refused re-send instead of sending the same request again', () => {
    const history = refused(30_000, CODE);
    const result = assessEmployee(outdated(), history, ON, MINUTE);
    // The rebuild's own dwell, counted from when the problem was first seen: nothing waits on the re-send.
    expect(result).toMatchObject({
      condition: 'held-needs-rebuild',
      next: { action: 'rebuild-laptop', at: 3 * MINUTE, preconditions: ['no-agent-running'] },
    });
    expect(result.needsHuman).toBeUndefined();
    // With the read that found no laptop of this employee running, the rebuild is due with nothing left to prove.
    const proved = assessEmployee(outdated('no-laptop'), history, ON, 3 * MINUTE);
    expect(proved.next).toEqual({ action: 'rebuild-laptop', at: 3 * MINUTE, preconditions: [] });
  });

  it('keeps every rule of a rebuild: never beside a running agent, never on an unread laptop', () => {
    const history = refused(30_000, CODE);
    const occupied = assessEmployee(outdated('running'), history, ON, 5 * MINUTE);
    expect(occupied.next.action).toBeNull();
    expect(occupied.next.waitingFor).toMatch(/^a reading of the agent's terminal/);
    expect(occupied.needsHuman).toBeUndefined();
    const unread = assessEmployee(outdated('unknown'), history, ON, 5 * MINUTE);
    expect(unread.next).toMatchObject({ action: null, waitingFor: 'a confirmed read of what is running in the laptop' });
  });

  it('names the switch and the calls at once when automatic repairs are off, and re-sends nothing more', () => {
    const result = assessEmployee(outdated(), refused(30_000, CODE), { ...ON, autoRepair: false }, MINUTE);
    expect(result.next.action).toBeNull();
    expect(result.needsHuman).toMatch(/supervisorAutoRepair.*docker-rebuild\/preview/);
  });

  it('never sends a request again that was refused with a code only a fresh laptop settles', () => {
    for (const detail of [
      CODE,
      'DOCKER_CONTINUATION_POLICY_CHANGED',
      'DOCKER_CONTINUATION_DESTINATION_CHANGED',
      'DOCKER_CONTINUATION_CONTAINER_STOPPED',
    ]) {
      expect(supervisorCodeKind(detail)).toMatch(/^(rebuild|stopped)$/);
      // Whatever the count and however long ago within this problem: no pass schedules that re-send again.
      for (const now of [31_000, 2 * MINUTE, 30 * MINUTE, 600 * MINUTE])
        expect([detail, now, assessEmployee(outdated(), refused(30_000, detail), ON, now).next.action]).not.toEqual([
          detail,
          now,
          'resend-continuation',
        ]);
    }
  });

  it('counts a refusal that named the hold the laptop shows now, even when that hold was first seen afterwards', () => {
    // The re-send was made for another hold; its refusal is what the next read then showed.
    const history = { ...refused(30_000, CODE), since: 60_000 };
    expect(assessEmployee(outdated(), history, ON, 2 * MINUTE).next.action).toBe('rebuild-laptop');
  });

  it('does not let an old refusal of an earlier episode or another problem stop a new re-send', () => {
    // Episode over: the attempts are cleared, the last action is still on record.
    const earlier = { ...refused(30_000, CODE), attempts: {}, since: 900 * MINUTE };
    expect(assessEmployee(outdated(), earlier, ON, 901 * MINUTE).next.action).toBe('resend-continuation');
    // Same episode, another hold that was first seen after the refusal.
    const other = held('DOCKER_CONTINUATION_IDENTITY_UNCONFIRMED', { allowedActions: ['observe', 'continue'] });
    const moved = { ...refused(30_000, CODE), fingerprint: 'code:DOCKER_CONTINUATION_IDENTITY_UNCONFIRMED', since: MINUTE };
    expect(assessEmployee(other, moved, ON, 2 * MINUTE).next.action).toBe('resend-continuation');
  });

  it('keeps re-sending what was refused for a reason that passes, or is offered for the hold itself', () => {
    // A refusal that is no rebuild code says nothing about the request.
    for (const detail of ['DOCKER_RESOURCE_HELPER_RETRY_PENDING', 'DOCKER_CONTINUATION_TARGET_CHANGED', 'no reason'])
      expect([detail, assessEmployee(outdated(), refused(30_000, detail), ON, 2 * MINUTE).next.action]).toEqual([
        detail,
        'resend-continuation',
      ]);
    // An in-place repair or a guided retry is offered for the hold itself and keeps its attempts.
    for (const offer of ['repair', 'repair-pool', 'retry']) {
      const base = held('DOCKER_RESOURCE_LEAF_ACK_MISSING', { allowedActions: ['observe', 'continue', offer] });
      const history = recordSupervisorAttempt(
        since(0, 'code:DOCKER_RESOURCE_LEAF_ACK_MISSING'),
        'resend-continuation',
        30_000,
        'refused',
        'DOCKER_RESOURCE_LEAF_ACK_MISSING'
      );
      expect([offer, assessEmployee(base, history, ON, 2 * MINUTE).next.action]).toEqual([offer, 'resend-continuation']);
    }
    // A re-send that was busy or failed tried nothing or proved nothing.
    for (const outcome of ['busy', 'failed'] as const) {
      const history = recordSupervisorAttempt(since(0, FINGERPRINT), 'resend-continuation', 30_000, outcome, CODE);
      expect([outcome, assessEmployee(outdated(), history, ON, 2 * MINUTE).next.action]).toEqual([
        outcome,
        'resend-continuation',
      ]);
    }
  });
});

describe('employee supervisor: a terminal the office can never type into again', () => {
  const VIEW = 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED';
  const FINGERPRINT = 'code:' + VIEW;
  const T0 = 100 * MINUTE;
  const lost = (patch: Patch = {}) =>
    observed({ ...patch, laptop: { restoration: { state: 'held', code: VIEW }, ...patch.laptop } });
  /** The agent runs in its laptop, idle for ten minutes already, but the office terminal's input is held for good. */
  const heldInput = (session: Patch['session'] = {}, laptop: Patch['laptop'] = {}) =>
    lost({ session: { inputHeld: true, turn: 'idle', idleSince: T0 - 10 * MINUTE, ...session }, laptop });
  /** The problem was first seen at T0 and the one nudge, 45 s later, was refused. */
  const refusedOnce = (patch: Partial<SupervisorHistory> = {}) =>
    recordSupervisorAttempt(since(T0, FINGERPRINT, patch), 'reconnect-viewer', T0 + 45_000, 'refused', 'start-unconfirmed');
  const at = (minutes: number) => T0 + minutes * MINUTE;
  /** A time as the policy writes it into a sentence. */
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  it('says what is wrong in one sentence and keeps the code and the clock of the lost terminal', () => {
    expect(classifyEmployee(heldInput())).toEqual({
      condition: 'viewer-lost',
      sentence:
        "The office can no longer type into Stan's terminal, so the laptop has to be rebuilt once the agent's current turn has ended.",
      code: VIEW,
      fingerprint: FINGERPRINT,
    });
    expect(classifyEmployee(lost()).sentence).toBe("The office terminal could not be connected to Stan's laptop.");
    // The same holds when the laptop's own attach was never reported and only the viewer reads as lost.
    const unreported = observed({ session: { viewerHealth: 'disconnected', inputHeld: true, turn: 'idle' }, laptop: { restoration: undefined } });
    expect(classifyEmployee(unreported)).toMatchObject({ condition: 'viewer-lost', sentence: expect.stringMatching(/can no longer type/) });
  });

  it('nudges the terminal once, and goes on to the rebuild as soon as that nudge was refused', () => {
    expect(assessEmployee(heldInput(), since(T0, FINGERPRINT), ON, T0).next).toMatchObject({
      action: 'reconnect-viewer',
      at: T0 + 45_000,
    });
    // Refused 45 s in. The rebuild keeps its own three minutes, and nothing waits for five more nudges.
    expect(assessEmployee(heldInput(), refusedOnce(), ON, at(1))).toMatchObject({
      condition: 'viewer-lost',
      next: { action: 'rebuild-laptop', at: at(3), preconditions: ['terminal-input-held'] },
    });
    expect(assessEmployee(heldInput(), refusedOnce(), ON, at(1)).needsHuman).toBeUndefined();
  });

  it('keeps a lost terminal that still takes input exactly as it was: nudged six times and never rebuilt', () => {
    const plain = assessEmployee(lost(), refusedOnce(), ON, at(1));
    expect(plain.next).toMatchObject({ action: 'reconnect-viewer', at: T0 + 45_000 + 30_000, preconditions: [] });
    const spent = assessEmployee(lost(), since(T0, FINGERPRINT, { attempts: tried('reconnect-viewer', 6, T0) }), ON, at(60));
    expect(spent.next).toMatchObject({ action: null, at: T0 + 6 * 60 * MINUTE });
    expect(spent.needsHuman).toBeUndefined();
    // Not even while what the pane shows was reported for some other reason.
    expect(classifyEmployee(lost({ session: { turn: 'idle', idleSince: T0 } })).condition).toBe('viewer-lost');
    const stray = assessEmployee(lost({ session: { turn: 'idle', idleSince: T0 } }), refusedOnce(), ON, at(60));
    expect(stray.next.action).toBe('reconnect-viewer');
  });

  it('gives a nudge that failed or found the employee busy its ordinary attempts', () => {
    for (const outcome of ['failed', 'busy'] as const) {
      const history = recordSupervisorAttempt(since(T0, FINGERPRINT), 'reconnect-viewer', T0 + 45_000, outcome);
      expect([outcome, assessEmployee(heldInput(), history, ON, at(10)).next.action]).toEqual([outcome, 'reconnect-viewer']);
    }
    // A refusal of an earlier problem says nothing about this one.
    const earlier = { ...refusedOnce(), since: at(5) };
    expect(assessEmployee(heldInput(), earlier, ON, at(6)).next.action).toBe('reconnect-viewer');
    // Six nudges that all failed still end at the rebuild, after the last one has had time to settle.
    const spent = since(T0, FINGERPRINT, { attempts: tried('reconnect-viewer', 6, at(20)) });
    expect(assessEmployee(heldInput(), spent, ON, at(24)).next).toMatchObject({ action: null, at: at(25) });
    expect(assessEmployee(heldInput({ idleSince: at(20) }), spent, ON, at(25)).next.action).toBe('rebuild-laptop');
  });

  it('never rebuilds in the middle of a turn: it waits for the turn to end and the pane to stay quiet', () => {
    const working = assessEmployee(heldInput({ turn: 'working', idleSince: undefined }), refusedOnce(), ON, at(10));
    expect(working.next).toEqual({ action: null, waitingFor: "the agent's current turn to end", preconditions: [] });
    expect(working.needsHuman).toBeUndefined();
    // The turn ended at minute 10. Two silent minutes later the rebuild may run.
    const quiet = (now: number) => assessEmployee(heldInput({ idleSince: at(10) }), refusedOnce(), ON, now);
    expect(quiet(at(11)).next).toEqual({
      action: null,
      waitingFor: "the agent's terminal to stay quiet a little longer",
      preconditions: [],
    });
    expect(quiet(at(12) - 1).next.action).toBeNull();
    expect(quiet(at(12)).next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['terminal-input-held'] });
    expect(SUPERVISOR_POLICY.heldInputIdleMs).toBe(2 * MINUTE);
  });

  it('gives work the agent left running thirty minutes to finish, then rebuilds with it still running', () => {
    // The turn ended long ago, and the pane says a monitor or a background shell is still going.
    const left = (now: number) => assessEmployee(heldInput({ background: true }), refusedOnce(), ON, now);
    expect(left(at(10)).next).toEqual({
      action: null,
      at: at(30),
      waitingFor: 'the work the agent left running to finish',
      preconditions: [],
    });
    expect(left(at(10)).needsHuman).toBeUndefined();
    expect(left(at(30) - 1).next.action).toBeNull();
    // A shell that never ends does not keep the employee out of reach for good.
    expect(left(at(30)).next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['terminal-input-held'] });
    expect(left(at(30)).needsHuman).toBeUndefined();
    // The work finished before that: the ordinary rule applies at once.
    expect(assessEmployee(heldInput(), refusedOnce(), ON, at(10)).next.action).toBe('rebuild-laptop');
  });

  it('never takes a pane it is not reading for an idle one', () => {
    // An agent runs in the laptop, as a read inside it said, and the office has no reading of its pane.
    const waits = (session: Patch['session'], now = at(10)) =>
      assessEmployee(heldInput(session, { provider: 'running' }), refusedOnce(), ON, now).next;
    const unread = {
      action: null,
      at: at(120),
      waitingFor: `a reading of the agent's terminal; if there is still none, the laptop is rebuilt at ${stamp(at(120))}`,
      preconditions: [],
    };
    expect(waits({ turn: 'unknown', idleSince: undefined })).toEqual(unread);
    expect(waits({ turn: undefined, idleSince: undefined })).toEqual(unread);
    // Idle, but nothing says since when: that is no reading either.
    expect(waits({ idleSince: undefined })).toEqual(unread);
    expect(waits({ turn: 'unknown', idleSince: undefined }, at(120) - 1)).toEqual(unread);
  });

  it('asks what runs in a laptop whose pane it cannot read, and rebuilds an empty one at once', () => {
    const blind = (laptop: Patch['laptop'] = {}) =>
      assessEmployee(heldInput({ turn: 'unknown', idleSince: undefined }, laptop), refusedOnce(), ON, at(10));
    // The read inside the laptop is asked for first.
    expect(blind().next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['no-agent-running'] });
    // Nothing runs there: nothing can be lost, and nothing more has to be proved.
    for (const provider of ['exited', 'absent', 'no-laptop'] as const)
      expect(blind({ provider, poolAlive: true }).next).toMatchObject({ action: 'rebuild-laptop', preconditions: [] });
    // An agent runs there, or the read cannot say: unknown is never taken for empty.
    for (const provider of ['running', 'unknown'] as const) expect(blind({ provider }).next.action).toBeNull();
  });

  it('rebuilds a laptop whose pane cannot be read two hours after the problem was first seen', () => {
    const blind = (now: number, session: Patch['session'] = { turn: 'unknown', idleSince: undefined }) =>
      assessEmployee(heldInput(session, { provider: 'running' }), refusedOnce(), ON, now);
    expect(blind(at(120) - 1).next.action).toBeNull();
    expect(blind(at(120)).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['terminal-input-held', 'agent-unreadable'],
    });
    expect(blind(at(120)).needsHuman).toBeUndefined();
    // A turn the office can see is never cut short by that bound, however long it lasts.
    expect(blind(at(600), { turn: 'working', idleSince: undefined }).next).toEqual({
      action: null,
      waitingFor: "the agent's current turn to end",
      preconditions: [],
    });
    expect(SUPERVISOR_POLICY.blindRebuildMs).toBe(120 * MINUTE);
  });

  it('asks nobody when the turn has not ended after thirty minutes, and rebuilds once it has', () => {
    const working = heldInput({ turn: 'working', idleSince: undefined });
    for (const now of [at(30) - 1, at(30), at(90)]) {
      const waiting = assessEmployee(working, refusedOnce(), ON, now);
      expect(waiting.next).toEqual({ action: null, waitingFor: "the agent's current turn to end", preconditions: [] });
      expect(waiting.needsHuman).toBeUndefined();
    }
    // A pane that never stays quiet is waited for in the same way.
    const restless = assessEmployee(heldInput({ idleSince: at(89) }), refusedOnce(), ON, at(90));
    expect(restless.next).toMatchObject({ action: null, waitingFor: expect.stringMatching(/stay quiet/) });
    expect(restless.needsHuman).toBeUndefined();
    // Hours later the turn ends: the office rebuilds on its own.
    const ended = assessEmployee(heldInput({ idleSince: at(200) }), refusedOnce(), ON, at(203));
    expect(ended.next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['terminal-input-held'] });
    expect(ended.needsHuman).toBeUndefined();
    expect(SUPERVISOR_POLICY.heldInputTurnMs).toBe(30 * MINUTE);
  });

  it('with automatic repairs switched off names the switch and the calls, and waits for nothing', () => {
    const off = { ...ON, autoRepair: false };
    for (const [session, now] of [
      [{}, at(10)],
      [{ turn: 'working' as const, idleSince: undefined }, at(10)],
      [{ turn: 'working' as const, idleSince: undefined }, at(90)],
    ] as const) {
      const result = assessEmployee(heldInput(session), refusedOnce(), off, now);
      expect(result.next).toEqual({ action: null, preconditions: [] });
      expect(result.needsHuman).toMatch(/^Automatic repairs are switched off \(company setting supervisorAutoRepair\)\. Rebuild the laptop: .*docker-rebuild\/preview, then \/apply with confirmDiscardRunning/);
    }
    // The nudge is a retry and is still sent once.
    expect(assessEmployee(heldInput(), since(T0, FINGERPRINT), off, at(1)).next.action).toBe('reconnect-viewer');
    const disabled = assessEmployee(heldInput(), refusedOnce(), { ...ON, enabled: false }, at(10));
    expect(disabled.next.action).toBeNull();
    expect(disabled.needsHuman).toMatch(/supervisorEnabled.*confirmDiscardRunning/);
  });

  it('keeps every limit of a rebuild', () => {
    const noLayout = assessEmployee(heldInput({}, { templateOnRecord: false }), refusedOnce(), ON, at(10));
    expect(noLayout.next.action).toBeNull();
    expect(noLayout.needsHuman).toMatch(/No owner-approved laptop layout.*confirmDiscardRunning/);
    const today = assessEmployee(heldInput(), refusedOnce({ rebuilds: [T0 - 60 * MINUTE, T0 - 30 * MINUTE] }), ON, at(10));
    expect(today.next).toMatchObject({ action: null, at: T0 + 23 * 60 * MINUTE });
    expect(today.next.waitingFor).toMatch(/^the daily limit on rebuilds of one laptop \(2\)/);
    expect(today.needsHuman).toBeUndefined();
    // Fifteen minutes between two rebuilds, and two per episode.
    const once = recordSupervisorAttempt(refusedOnce(), 'rebuild-laptop', at(3), 'refused', 'DOCKER_REBUILD_REMOVAL_UNCONFIRMED');
    expect(assessEmployee(heldInput(), once, ON, at(4)).next).toMatchObject({ action: 'rebuild-laptop', at: at(18) });
    const twice = recordSupervisorAttempt(once, 'rebuild-laptop', at(18), 'refused', 'DOCKER_REBUILD_REMOVAL_UNCONFIRMED');
    expect(assessEmployee(heldInput(), twice, ON, at(20)).next).toMatchObject({ action: null, waitingFor: 'the outcome of the last attempt' });
    const spent = assessEmployee(heldInput(), twice, ON, at(60));
    expect(spent.next).toMatchObject({ action: null, at: at(18) + 6 * 60 * MINUTE });
    expect(spent.next.waitingFor).toMatch(/^the next round of repair steps, which starts at/);
    expect(spent.needsHuman).toBeUndefined();
    expect(assessEmployee({ ...heldInput(), busy: 'laptop-operation' }, refusedOnce(), ON, at(10)).next).toMatchObject({
      action: null,
      waitingFor: 'another laptop operation that is running',
    });
  });

  it('does not go back to the nudge after a rebuild that was refused or found a turn in progress', () => {
    for (const outcome of ['refused', 'busy', 'failed'] as const) {
      const history = recordSupervisorAttempt(refusedOnce(), 'rebuild-laptop', at(3), outcome);
      expect([outcome, assessEmployee(heldInput(), history, ON, at(30)).next.action]).toEqual([outcome, 'rebuild-laptop']);
    }
    // A turn that started in the last moment gave the attempt back, so the rebuild runs as soon as it has ended.
    const given = recordSupervisorAttempt(refusedOnce(), 'rebuild-laptop', at(3), 'busy', 'the agent is in the middle of a turn');
    expect(given.attempts['rebuild-laptop']).toEqual({ count: 0, lastAt: at(3) });
    expect(assessEmployee(heldInput({ idleSince: at(5) }), given, ON, at(7)).next).toMatchObject({ action: 'rebuild-laptop', at: at(3) });
  });

  it('judges a held input beside another problem by that problem: the rule between turns, and its own proofs', () => {
    const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
    const result = assessEmployee(
      { ...failed, session: { ...failed.session, inputHeld: true, turn: 'idle', idleSince: 0 }, laptop: { ...failed.laptop, provider: 'running' } },
      since(T0, 'code:DOCKER_RESOURCE_HELPER_FAILED'),
      ON,
      at(60)
    );
    expect(result.next).toMatchObject({ action: 'rebuild-laptop', preconditions: ['agent-between-turns', 'laptop-held'] });
    expect(result.needsHuman).toBeUndefined();
    // And the steps of this one path run from the least to the most destructive, the repair behind the switch.
    expect(SUPERVISOR_HELD_INPUT_PATH).toEqual(['reconnect-viewer', 'rebuild-laptop']);
    expect(SUPERVISOR_HELD_INPUT_PATH.map((action) => SUPERVISOR_POLICY.ladder[action].tier)).toEqual(['retry', 'repair']);
    expect(SUPERVISOR_PATHS['viewer-lost']).toEqual(['reconnect-viewer']);
  });

  describe('reading the office terminal', () => {
    const terminal = (patch: Partial<SupervisedTerminal> = {}): SupervisedTerminal => ({
      pid: 77,
      status: 'idle',
      runtimeHealth: 'unknown',
      terminalInputHeld: true,
      isWorking: false,
      lastActivityAt: 5000,
      lastPromptTime: 4000,
      paneStartedAt: 1000,
      ...patch,
    });

    it('reports nothing for a terminal that takes input, whatever its pane shows', () => {
      expect(readSupervisedTerminal(terminal({ terminalInputHeld: false }))).toEqual({});
      expect(readSupervisedTerminal(terminal({ terminalInputHeld: false, isWorking: true }), true)).toEqual({});
      expect(readSupervisedTerminal(undefined)).toEqual({});
    });

    it('calls the pane idle since its last output, its last ended turn or its last attach, whichever is latest', () => {
      expect(readSupervisedTerminal(terminal())).toEqual({ inputHeld: true, turn: 'idle', idleSince: 5000 });
      expect(readSupervisedTerminal(terminal({ lastPromptTime: 9000 })).idleSince).toBe(9000);
      // An office that attached a moment ago has watched the pane only since then.
      expect(readSupervisedTerminal(terminal({ paneStartedAt: 20_000 })).idleSince).toBe(20_000);
      expect(readSupervisedTerminal(terminal({ lastActivityAt: 0, lastPromptTime: 0, paneStartedAt: 0 }))).toEqual({ inputHeld: true, turn: 'idle' });
    });

    it('says when the idle pane shows work its agent left running', () => {
      expect(readSupervisedTerminal(terminal({ watching: '1 monitor' }))).toEqual({ inputHeld: true, turn: 'idle', idleSince: 5000, background: true });
      expect(readSupervisedTerminal(terminal({ watching: null })).background).toBeUndefined();
      // A turn in progress is waited for by its own rule.
      expect(readSupervisedTerminal(terminal({ isWorking: true, status: 'busy', watching: '1 monitor' }))).toEqual({ inputHeld: true, turn: 'working' });
    });

    it('calls a turn in progress working', () => {
      expect(readSupervisedTerminal(terminal({ isWorking: true, status: 'busy' }))).toEqual({ inputHeld: true, turn: 'working' });
      expect(readSupervisedTerminal(terminal({ status: 'busy' }))).toEqual({ inputHeld: true, turn: 'working' });
    });

    it.each([
      ['has no process', { pid: null }],
      ['shows an exited pane', { paneExit: { code: 0 } }],
      ['is being reconnected', { viewerInputHeld: true }],
      ['is being started or attached', { paneLifecycleInFlight: true }],
      ['lost its client', { runtimeHealth: 'disconnected' }],
      ['is stopped', { status: 'stopped' }],
      ['does not say whether it is working', { isWorking: undefined }],
    ] as Array<[string, Partial<SupervisedTerminal>]>)('knows nothing of the turn while the terminal %s', (_title, patch) => {
      expect(readSupervisedTerminal(terminal(patch))).toEqual({ inputHeld: true, turn: 'unknown' });
    });

    it('asks the saved record only when the office has no terminal object, and then knows nothing of the turn', () => {
      expect(readSupervisedTerminal(undefined, true)).toEqual({ inputHeld: true, turn: 'unknown' });
      expect(readSupervisedTerminal(undefined, false)).toEqual({});
    });
  });
});

describe('employee supervisor: an agent parked on a start-up screen the office could not answer', () => {
  const stuck = (patch: Partial<SupervisorObservation['session']> = {}, label = "Claude's theme chooser") =>
    observed({
      session: {
        startupScreen: { label, kind: 'first-run', answering: false, proof: 'launch' },
        turn: 'idle',
        idleSince: 0,
        ...patch,
      },
    });
  const seen = (at: number, input = stuck()) => since(at, classifyEmployee(input).fingerprint);
  const RELAUNCH: SupervisorFlags = { ...ON, relaunchAvailable: true };

  it('is a condition of its own with a path, and is never left to the owner', () => {
    const result = classifyEmployee(stuck());
    expect(result).toMatchObject({
      condition: 'stuck-first-run-screen',
      code: 'first-run-screen',
      sentence: "Stan is stuck at Claude's theme chooser, which the office could not answer.",
    });
    expect(result.needsHuman).toBeUndefined();
    expect(SUPERVISOR_PATHS['stuck-first-run-screen']).toEqual(['relaunch-provider', 'rebuild-laptop']);
    // A screen the table does not know at all is the same condition, under the name the terminal gives it.
    expect(classifyEmployee(stuck({}, 'a start-up screen the office does not know'))).toMatchObject({
      condition: 'stuck-first-run-screen',
      sentence: 'Stan is stuck at a start-up screen the office does not know, which the office could not answer.',
    });
  });

  it('is rebuilt three minutes after it was first seen, on proof that the agent is parked', () => {
    expect(assessEmployee(stuck(), seen(MINUTE), ON, 3 * MINUTE).next).toEqual({
      action: 'rebuild-laptop',
      at: 4 * MINUTE,
      preconditions: ['agent-parked-at-screen'],
    });
    // What runs in the laptop is not asked: an agent does. The proof is the pane, read again by the driver and the step.
    expect(assessEmployee(stuck(), seen(MINUTE), ON, 10 * MINUTE).next.preconditions).not.toContain('no-agent-running');
  });

  it('is relaunched inside its laptop first where the office can do that', () => {
    expect(assessEmployee(stuck(), seen(MINUTE), RELAUNCH, 3 * MINUTE).next).toEqual({
      action: 'relaunch-provider',
      at: MINUTE + 30_000,
      preconditions: ['agent-parked-at-screen'],
    });
    const relaunched = { ...seen(MINUTE), attempts: tried('relaunch-provider', 2, 5 * MINUTE) };
    expect(assessEmployee(stuck({ idleSince: 6 * MINUTE }), relaunched, RELAUNCH, 10 * MINUTE).next.action).toBe('rebuild-laptop');
  });

  // The waits are those of every laptop an agent may run in (`betweenTurnsGate`): one rule, not a second one.
  it.each([
    ['the pane is still changing', { turn: 'working' as const, idleSince: undefined }, "the agent's current turn to end"],
    ['the pane went quiet a minute ago', { idleSince: 9 * MINUTE }, "the agent's terminal to stay quiet a little longer"],
    ['the pane says work was left running', { background: true }, 'the work the agent left running to finish'],
  ])('waits and asks nobody while %s', (_title, session, waitingFor) => {
    for (const flags of [ON, RELAUNCH]) {
      const result = assessEmployee(stuck(session), seen(MINUTE), flags, 10 * MINUTE);
      expect(result.next).toMatchObject({ action: null, waitingFor });
      expect(result.needsHuman).toBeUndefined();
    }
  });

  it('asks what runs in the laptop when the pane shows no turn at all, and then waits the long wait of an unread pane', () => {
    const unread = stuck({ turn: 'unknown', idleSince: undefined });
    // First a read inside the laptop: an empty laptop has nothing to lose.
    expect(assessEmployee(unread, seen(MINUTE), ON, 10 * MINUTE).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['no-agent-running'],
    });
    const empty = { ...unread, laptop: { ...unread.laptop, provider: 'exited' as const } };
    expect(assessEmployee(empty, seen(MINUTE), ON, 10 * MINUTE).next).toMatchObject({ action: 'rebuild-laptop', preconditions: [] });
    // An agent runs there and the pane cannot be read: two hours, and the screen is still what the step proves.
    const occupied = { ...unread, laptop: { ...unread.laptop, provider: 'running' as const } };
    const waiting = assessEmployee(occupied, seen(MINUTE), ON, 10 * MINUTE);
    expect(waiting.next).toMatchObject({ action: null, at: MINUTE + SUPERVISOR_POLICY.blindRebuildMs });
    expect(waiting.needsHuman).toBeUndefined();
    expect(assessEmployee(occupied, seen(MINUTE), ON, MINUTE + SUPERVISOR_POLICY.blindRebuildMs).next).toMatchObject({
      action: 'rebuild-laptop',
      preconditions: ['agent-parked-at-screen', 'agent-unreadable'],
    });
    // A relaunch never goes ahead on a read of the laptop alone.
    expect(assessEmployee(unread, seen(MINUTE), RELAUNCH, 10 * MINUTE).next).toMatchObject({
      action: null,
      waitingFor: "a reading of the agent's terminal",
    });
  });

  it('is never taken for a laptop that has been starting too long while the office is still answering the screen', () => {
    const answering = observed({ session: { startupScreen: { label: "Claude's theme chooser", kind: 'first-run', answering: true, proof: 'widget' }, turn: 'idle', idleSince: 0 } });
    // The laptop was starting for twenty minutes before the screen showed: the stalled rule would be due.
    const history = { ...EMPTY_SUPERVISOR_HISTORY, transitSince: MINUTE };
    const result = assessEmployee(answering, history, RELAUNCH, 30 * MINUTE);
    expect(result).toMatchObject({ condition: 'waiting-first-run-screen', next: { action: null, waitingFor: 'the office to finish answering the start-up screen' } });
    expect(result.needsHuman).toBeUndefined();
    // And a screen the office gave up on is its own problem with its own clock, not a stalled start.
    const stuckNow = assessEmployee(stuck(), rollSupervisorHistory(history, classifyEmployee(stuck()), 30 * MINUTE), ON, 30 * MINUTE);
    expect(stuckNow).toMatchObject({ condition: 'stuck-first-run-screen', next: { action: 'rebuild-laptop', at: 33 * MINUTE, preconditions: ['agent-parked-at-screen'] } });
  });

  it('takes no step for a screen without proof, or beside a plan move', () => {
    const words = observed({ session: { startupScreen: { label: "Claude's theme chooser", kind: 'first-run', answering: false }, turn: 'idle', idleSince: 0 } });
    const moving = { ...stuck(), move: { id: 'm', docker: true, phase: 'approval', busy: false, allowedActions: [] } };
    for (const input of [words, moving])
      for (const now of [MINUTE, 10 * MINUTE, 120 * MINUTE])
        expect(assessEmployee(input, seen(MINUTE, input), RELAUNCH, now).next.action).toBeNull();
  });

  it('never says to answer it in a terminal, whatever was tried', () => {
    let history = seen(MINUTE);
    const said: string[] = [];
    for (let now = MINUTE; now <= 8 * 60 * MINUTE; now += MINUTE) {
      history = rollSupervisorHistory(history, classifyEmployee(stuck()), now);
      const result = assessEmployee(stuck({ idleSince: now - 5 * MINUTE }), history, ON, now);
      if (result.needsHuman) said.push(result.needsHuman);
      if (result.next.action && (result.next.at ?? 0) <= now)
        history = recordSupervisorAttempt(history, result.next.action, now, 'refused', 'DOCKER_REPROVISION_SOURCE_UNCONFIRMED');
    }
    // Nobody is asked for anything at any point, and the wait between rounds names when the next one starts.
    expect(said).toEqual([]);
    const between = assessEmployee(stuck({ idleSince: 0 }), history, ON, history.lastAction!.at + 30 * MINUTE);
    expect(between.next.waitingFor).toMatch(/the next round of repair steps, which starts at /);
    expect(between.next.at).toBe(ladderRestartAt(history));
    // Two rebuilds, six hours, and two more: the steps are given back, the screen is never given up on.
    expect(history.attempts['rebuild-laptop']!.count).toBeGreaterThanOrEqual(1);
    expect(history.lastAction!.at).toBeGreaterThan(6 * 60 * MINUTE);
  });

  it('is still answered by the office while its scan is open, and that is no problem to work on', () => {
    const answering = observed({ session: { startupScreen: { label: "Claude's API key question", kind: 'first-run', answering: true, proof: 'widget' } } });
    expect(classifyEmployee(answering)).toMatchObject({ condition: 'waiting-first-run-screen', fingerprint: '' });
    expect(assessEmployee(answering, EMPTY_SUPERVISOR_HISTORY, RELAUNCH, 10 * MINUTE).next.action).toBeNull();
  });
});

describe('employee supervisor: reading a parked start-up screen off the office terminal', () => {
  const screen = { label: "Claude's sign-in screen", kind: 'credential' as const, answering: false, shown: 'widget' as const };
  const terminal = (patch: Partial<SupervisedScreenTerminal> = {}): SupervisedScreenTerminal => ({
    pid: 7,
    status: 'idle',
    runtimeHealth: 'healthy',
    isWorking: false,
    lastActivityAt: 5000,
    lastPromptTime: 0,
    paneStartedAt: 1000,
    startupScreen: () => screen,
    ...patch,
  });

  it('reports the screen with its proof, and leaves the turn to the one reading every laptop is judged by', () => {
    expect(readParkedScreen(terminal())).toEqual({
      startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false, proof: 'widget' },
    });
    expect(readParkedScreen(terminal({ startupScreen: () => ({ ...screen, shown: 'launch' }) }))).toEqual({
      startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false, proof: 'launch' },
    });
    // What the pane shows of a turn is `readTerminalTurn`'s to say, for a parked screen as for a held input.
    expect(readTerminalTurn(terminal())).toEqual({ turn: 'idle', idleSince: 5000 });
  });

  it.each([
    ['there is no terminal', undefined],
    ['the terminal cannot name a screen', terminal({ startupScreen: undefined })],
    ['the pane shows no start-up screen', terminal({ startupScreen: () => null })],
    ['the screen is known only by its words', terminal({ startupScreen: () => ({ ...screen, shown: 'words' }) })],
    ['the reading does not say how it is known', terminal({ startupScreen: () => ({ label: 'x', kind: 'credential', answering: false }) })],
    ['the pane cannot be read', terminal({ startupScreen: () => { throw new Error('tmux gone'); } })],
    ['the terminal has no process', terminal({ pid: null })],
    ['the terminal lost its client', terminal({ runtimeHealth: 'disconnected' })],
    ['the terminal is being reconnected', terminal({ viewerInputHeld: true })],
    ['a start or stop of the pane is running', terminal({ paneLifecycleInFlight: true })],
    ['the pane exited', terminal({ paneExit: { code: 0 } })],
    ['the agent is working', terminal({ status: 'busy', isWorking: true })],
    ['the office does not track its work', terminal({ isWorking: undefined })],
  ])('reports nothing when %s', (_title, input) => {
    expect(readParkedScreen(input)).toEqual({});
  });

  it('does not read the pane at all while the agent works', () => {
    let reads = 0;
    const counting = terminal({ status: 'busy', startupScreen: () => (reads++, screen) });
    readParkedScreen(counting);
    expect(reads).toBe(0);
  });
});

describe('employee supervisor: a plan move that stopped part-way never waits for the owner', () => {
  const START = 1_000 * MINUTE;
  const signInScreen = describeStartupScreen("Stan's new session", {
    label: "Claude's sign-in screen",
    kind: 'credential',
    answering: false,
  });
  const decisionScreen = describeStartupScreen("Stan's new session", {
    label: "Claude's usage-credit offer",
    kind: 'decision',
    answering: false,
  });
  /**
   * Tick every 30 s as the office does. Every step ends as `outcome`; a move that was closed is gone at the next
   * tick. Returns each step with the minute it ran at, and every sentence that asked for a person on the way.
   */
  function timeline(seen: SupervisorObservation, minutes: number, outcome: 'done' | 'refused' = 'refused') {
    let history = EMPTY_SUPERVISOR_HISTORY,
      now = START,
      current = seen;
    const actions: Array<[number, string]> = [],
      asked: string[] = [];
    for (; now <= START + minutes * MINUTE; now += 30_000) {
      history = rollSupervisorHistory(history, classifyEmployee(current), now);
      const result = assessEmployee(current, history, ON, now);
      if (result.needsHuman) asked.push(result.needsHuman);
      const next = result.next;
      if (!next.action || (next.at ?? 0) > now) continue;
      actions.push([(now - START) / MINUTE, next.action]);
      const closed = next.action === 'abandon-move' && outcome === 'done';
      history = recordSupervisorAttempt(history, next.action, now, closed || next.action !== 'abandon-move' ? outcome : 'refused');
      if (closed) current = observed();
    }
    return { actions, asked, history, condition: classifyEmployee(current).condition };
  }
  const continues: Array<[number, string]> = [
    [1, 'continue-move'],
    [3, 'continue-move'],
    [8, 'continue-move'],
  ];

  it('asks nobody for anything, whatever stopped the move and whatever its record offers', () => {
    const cases: SupervisorObservation[] = [
      move('x', { docker: false, allowedActions: ['settle'] }),
      move(signInScreen),
      { ...move(signInScreen), planSignedIn: true },
      move(decisionScreen),
      move('x', { allowedActions: [] }),
      move('x', { allowedActions: ['continue-original'] }),
      move('x', { allowedActions: ['abandon'] }),
      move(undefined),
      move('The original Docker journal changed'),
      move('DOCKER_CONTINUATION_BUSY'),
      move('DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED'),
      move('DOCKER_RESOURCE_HELPER_FAILED'),
      move(new PlanMoveComposerNotReady().message),
    ];
    for (const seen of cases) {
      const first = classifyEmployee(seen);
      expect(first, JSON.stringify(seen.move)).toMatchObject({ condition: 'move-held-retryable' });
      expect(first.needsHuman).toBeUndefined();
      const run = timeline(seen, 45, 'done');
      expect(run.asked, JSON.stringify(seen.move)).toEqual([]);
      expect(run.actions.at(-1)?.[1], JSON.stringify(seen.move)).toBe('abandon-move');
      expect(run.condition).toBe('healthy');
    }
  });

  it('closes a move of the retired runtime after the fifteen minutes, and never continues it', () => {
    const retired = move('The server restarted during this move; inspect both sessions before retrying', {
      docker: false,
      allowedActions: ['settle'],
    });
    expect(classifyEmployee(retired)).toMatchObject({ condition: 'move-held-retryable', code: 'move-retired' });
    expect(timeline(retired, 30, 'done').actions).toEqual([[15, 'abandon-move']]);
    // Even a record that claims to offer a continue is not continued: only a laptop move has one.
    const odd = move('x', { docker: false, allowedActions: ['continue-original'] });
    expect(timeline(odd, 30, 'done').actions).toEqual([[15, 'abandon-move']]);
  });

  it('continues a move at a sign-in screen three times and abandons it, whatever the office says of the plan', () => {
    // Signing the plan in at the office cannot finish such a move, so nothing waits for it: see
    // SUPERVISOR_MOVE_POLICY. A continue succeeds only when the candidate got past the screen by itself.
    for (const planSignedIn of [false, undefined, true]) {
      const held = { ...move(signInScreen), planSignedIn };
      expect(classifyEmployee(held)).toMatchObject({ condition: 'move-held-retryable', code: 'move-sign-in' });
      const history = since(START, classifyEmployee(held).fingerprint);
      expect(assessEmployee(held, history, ON, START + 2 * MINUTE).next).toMatchObject({ action: 'continue-move' });
      expect(timeline(held, 45).actions).toEqual([...continues, [15, 'abandon-move'], [20, 'abandon-move']]);
      expect(timeline(held, 45, 'done').asked).toEqual([]);
    }
  });

  it('has no rule about a sign-in the office placed: a recent one changes nothing', () => {
    const held = move(signInScreen);
    const history = since(START, classifyEmployee(held).fingerprint, {
      attempts: tried('continue-move', 3, START + 8 * MINUTE),
      lastAction: { action: 'replace-sign-in', at: START + 19 * MINUTE, outcome: 'done' },
    });
    expect(assessEmployee(held, history, ON, START + 20 * MINUTE).next).toMatchObject({ action: 'abandon-move' });
  });

  it('continues a move at a decision screen three times and then abandons it', () => {
    const decision = move(decisionScreen);
    expect(classifyEmployee(decision)).toMatchObject({ condition: 'move-held-retryable', code: 'move-owner-decision' });
    expect(timeline(decision, 45, 'done').actions).toEqual([...continues, [15, 'abandon-move']]);
  });

  it('closes a move that offers no continue step without trying one', () => {
    for (const allowedActions of [[], ['abandon']])
      expect(timeline(move('x', { allowedActions }), 45, 'done').actions).toEqual([[15, 'abandon-move']]);
  });

  it('asks the service to abandon even when the record does not offer it, and spends an attempt on the refusal', () => {
    const run = timeline(move('x', { allowedActions: ['continue-original'] }), 45);
    expect(run.actions).toEqual([...continues, [15, 'abandon-move'], [20, 'abandon-move']]);
    expect(run.history.attempts['abandon-move']).toMatchObject({ count: 2 });
  });

  it('continues an error it does not recognize as often as any other and then abandons the move', () => {
    for (const error of [undefined, 'Docker move unavailable', 'The original Docker journal changed'])
      expect(timeline(move(error), 45, 'done').actions).toEqual([...continues, [15, 'abandon-move']]);
  });

  describe('a move held by a cause outside itself', () => {
    const POOL = 'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED';
    const probes: Array<[number, string]> = [
      [1, 'continue-move'],
      [10, 'continue-move'],
      [30, 'continue-move'],
    ];

    it('spreads its three continues over the thirty minutes and abandons only after the last one failed', () => {
      for (const error of ['DOCKER_CONTINUATION_BUSY', POOL]) {
        const outside = move(error);
        expect(timeline(outside, 45, 'done').actions).toEqual([...probes, [33, 'abandon-move']]);
        expect(timeline(outside, 45).actions).toEqual([...probes, [33, 'abandon-move'], [38, 'abandon-move']]);
      }
    });

    it('says what it waits for between two probes, and until when', () => {
      const outside = move(POOL);
      const history = since(START, classifyEmployee(outside).fingerprint, {
        attempts: tried('continue-move', 2, START + 10 * MINUTE),
      });
      const waiting = assessEmployee(outside, history, ON, START + 20 * MINUTE);
      expect(waiting.next).toEqual({
        action: null,
        at: START + 30 * MINUTE,
        waitingFor: 'the repair of what holds the move, which every laptop shares',
        preconditions: [],
      });
      expect(waiting.needsHuman).toBeUndefined();
      // The second probe waits for its own time.
      const second = assessEmployee(
        outside,
        { ...history, attempts: tried('continue-move', 1, START + MINUTE) },
        ON,
        START + 5 * MINUTE
      );
      expect(second.next).toMatchObject({ action: null, at: START + 10 * MINUTE });
    });

    it('is finished by a later probe when the cause is gone by then, and is never abandoned', () => {
      // The outage ends twenty minutes in. The first two probes fell inside it; the last one finishes the move.
      let history = EMPTY_SUPERVISOR_HISTORY,
        current = move(POOL);
      const actions: Array<[number, string]> = [];
      for (let now = START; now <= START + 90 * MINUTE; now += 30_000) {
        history = rollSupervisorHistory(history, classifyEmployee(current), now);
        const next = assessEmployee(current, history, ON, now).next;
        if (!next.action || (next.at ?? 0) > now) continue;
        actions.push([(now - START) / MINUTE, next.action]);
        history = recordSupervisorAttempt(history, next.action, now, 'done');
        if (now >= START + 20 * MINUTE) current = observed();
      }
      expect(actions).toEqual(probes);
      expect(classifyEmployee(current).condition).toBe('healthy');
    });

    it('is not abandoned on the strength of probes that were made before the thirty minutes were over', () => {
      const outside = move(POOL);
      const fingerprint = classifyEmployee(outside).fingerprint;
      // All three continues of this round were spent on an earlier error of the move, before this cause was seen.
      const spent = since(START + 10 * MINUTE, fingerprint, { attempts: tried('continue-move', 3, START + 8 * MINUTE) });
      const restart = START + 8 * MINUTE + SUPERVISOR_POLICY.ladderRestartMs;
      for (const minute of [20, 40, 45, 120]) {
        const result = assessEmployee(outside, spent, ON, START + minute * MINUTE);
        expect(result.next.action, String(minute)).toBeNull();
        expect(result.needsHuman).toBeUndefined();
      }
      expect(assessEmployee(outside, spent, ON, START + 45 * MINUTE).next).toMatchObject({
        at: restart,
        waitingFor: 'the next round of repair steps, which continues the move once more before it may be closed',
      });
      // The next round continues the move first, and only then may it be closed.
      const next = rollSupervisorHistory(spent, classifyEmployee(outside), restart);
      expect(next.attempts).toEqual({});
      expect(assessEmployee(outside, next, ON, restart).next).toMatchObject({ action: 'continue-move' });
      const probed = { ...next, attempts: tried('continue-move', 3, restart + 7 * MINUTE) };
      expect(assessEmployee(outside, probed, ON, restart + 10 * MINUTE).next).toMatchObject({ action: 'abandon-move' });
    });

    it('holds the last probe back even when the earlier ones were spent on another error', () => {
      const outside = move(POOL);
      const history = since(START + 5 * MINUTE, classifyEmployee(outside).fingerprint, {
        attempts: tried('continue-move', 2, START + 3 * MINUTE),
      });
      expect(assessEmployee(outside, history, ON, START + 20 * MINUTE).next).toMatchObject({
        action: null,
        at: START + 35 * MINUTE,
      });
      expect(assessEmployee(outside, history, ON, START + 35 * MINUTE).next).toMatchObject({ action: 'continue-move' });
    });

    it('is one problem whichever code names the cause, so a second code does not start the wait again', () => {
      const first = classifyEmployee(move(POOL)),
        second = classifyEmployee(move('DOCKER_CONTINUATION_POOL_UNCONFIRMED'));
      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.sentence).not.toBe(second.sentence);
      const rolled = rollSupervisorHistory(since(START, first.fingerprint), second, START + 31 * MINUTE);
      expect(rolled.since).toBe(START);
      // An error of the move's own is another problem, and so is another move.
      expect(classifyEmployee(move('The original Docker journal changed')).fingerprint).not.toBe(first.fingerprint);
      expect(classifyEmployee(move(POOL, { id: 'move-2' })).fingerprint).not.toBe(first.fingerprint);
    });

    it('is abandoned when the thirty minutes are over if its record offers no continue to probe with', () => {
      expect(timeline(move(POOL, { allowedActions: ['abandon'] }), 45, 'done').actions).toEqual([[30, 'abandon-move']]);
    });

    it('goes through the same probes in every later round', () => {
      const run = timeline(move(POOL), 8 * 60);
      // Round two starts six hours after the last attempt; the wait is long over, so its probes follow each other.
      expect(run.actions).toEqual([
        ...probes,
        [33, 'abandon-move'],
        [38, 'abandon-move'],
        [398, 'continue-move'],
        [400, 'continue-move'],
        [405, 'continue-move'],
        [408, 'abandon-move'],
        [413, 'abandon-move'],
      ]);
      expect(run.asked).toEqual([]);
    });
  });

  it('asks nobody once both rungs are used up, and says when the next round starts', () => {
    const stuck = move('x');
    const used = since(START, classifyEmployee(stuck).fingerprint, {
      attempts: { ...tried('continue-move', 3, START), ...tried('abandon-move', 2, START + 20 * MINUTE) },
    });
    const result = assessEmployee(stuck, used, ON, START + 60 * MINUTE);
    expect(result.next).toMatchObject({ action: null, at: START + 20 * MINUTE + 6 * 60 * MINUTE });
    expect(result.next.waitingFor).toMatch(/the next round of repair steps/);
    expect(result.needsHuman).toBeUndefined();
    // At that time the counts are cleared and the same move is continued again, then abandoned.
    const next = START + 20 * MINUTE + 6 * 60 * MINUTE;
    const rolled = rollSupervisorHistory(used, classifyEmployee(stuck), next);
    expect(rolled.attempts).toEqual({});
    expect(rolled.since).toBe(START);
    expect(assessEmployee(stuck, rolled, ON, next).next).toMatchObject({ action: 'continue-move' });
  });

  it('goes round again every six hours while the service refuses to close the move, and never asks anyone', () => {
    const run = timeline(move('The original Docker journal changed'), 13 * 60);
    const round: Array<[number, string]> = [...continues, [15, 'abandon-move'], [20, 'abandon-move']];
    const later = (from: number): Array<[number, string]> => [
      [from, 'continue-move'],
      [from + 2, 'continue-move'],
      [from + 7, 'continue-move'],
      [from + 10, 'abandon-move'],
      [from + 15, 'abandon-move'],
    ];
    // The second round starts six hours after the first one's last attempt, the third six hours after the second's.
    expect(run.actions).toEqual([...round, ...later(20 + 360), ...later(20 + 360 + 15 + 360)]);
    expect(run.asked).toEqual([]);
  });

  it('closes the move in a later round when the service accepts then, and closes it only once', () => {
    let history = EMPTY_SUPERVISOR_HISTORY,
      current = move('x');
    const closes: number[] = [];
    for (let now = START; now <= START + 8 * 60 * MINUTE; now += 30_000) {
      history = rollSupervisorHistory(history, classifyEmployee(current), now);
      const next = assessEmployee(current, history, ON, now).next;
      if (!next.action || (next.at ?? 0) > now) continue;
      // The first round is refused throughout; the second round's abandon is accepted.
      const accepted = next.action === 'abandon-move' && now > START + 6 * 60 * MINUTE;
      history = recordSupervisorAttempt(history, next.action, now, accepted ? 'done' : 'refused');
      if (accepted) {
        closes.push((now - START) / MINUTE);
        current = observed();
      }
    }
    expect(closes).toEqual([390]);
    expect(classifyEmployee(current).condition).toBe('healthy');
  });

  it('starts the same ladder again once its attempt counts are cleared, for the same move and the same error', () => {
    const stuck = move('x');
    const cleared = since(START, classifyEmployee(stuck).fingerprint);
    // The problem is as old as before; only the counts are gone.
    expect(assessEmployee(stuck, cleared, ON, START + 6 * 60 * MINUTE).next).toMatchObject({
      action: 'continue-move',
      at: START + MINUTE,
    });
    const again = { ...cleared, attempts: tried('continue-move', 3, START + 6 * 60 * MINUTE) };
    expect(assessEmployee(stuck, again, ON, START + 6 * 60 * MINUTE + 4 * MINUTE).next).toMatchObject({
      action: 'abandon-move',
      at: START + 15 * MINUTE,
    });
  });

  it('leaves both steps to the owner’s switches', () => {
    const stuck = move('x');
    const history = since(START, classifyEmployee(stuck).fingerprint, { attempts: tried('continue-move', 3, START) });
    const off = assessEmployee(stuck, history, { ...ON, autoRepair: false }, START + 60 * MINUTE);
    expect(off.next.action).toBeNull();
    expect(off.needsHuman).toMatch(/supervisorAutoRepair/);
    expect(assessEmployee(stuck, since(START, 'x'), { ...ON, enabled: false }, START + 60 * MINUTE).next.action).toBeNull();
  });

  it('never acts beside a move that is working, and leaves a finished move alone', () => {
    for (const patch of [{ busy: true }, { phase: 'checking' }, { phase: 'stopping' }]) {
      const working = move('x', patch);
      expect(classifyEmployee(working).condition).toBe('move-in-progress');
      expect(assessEmployee(working, since(START, ''), ON, START + 600 * MINUTE).next.action).toBeNull();
    }
    for (const phase of ['completed', 'failed'])
      expect(classifyEmployee(move('x', { phase })).condition).toBe('healthy');
  });
});

describe('employee supervisor: no path ends for good', () => {
  const HOUR = 60 * MINUTE;
  /** A time as the policy writes it into a sentence. */
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const FAILED = 'code:DOCKER_RESOURCE_HELPER_FAILED';
  const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
  const withLaptop = (base: SupervisorObservation, laptop: Patch['laptop'], session: Patch['session'] = {}) =>
    ({ ...base, session: { ...base.session, ...session }, laptop: { ...base.laptop, ...laptop } }) as SupervisorObservation;
  /** Nothing runs in the laptop and another laptop of the office does, so a rebuild has nothing left to prove. */
  const empty = (base: SupervisorObservation) => withLaptop(base, { provider: 'exited', poolAlive: true });

  describe('a ladder that has used every rung', () => {
    const last = 40 * MINUTE;
    const spent = since(0, FAILED, {
      attempts: { ...tried('resend-continuation', 4, 10 * MINUTE), ...tried('rebuild-laptop', 2, last) },
      rebuilds: [25 * MINUTE],
    });

    it('says when it starts again and asks nobody', () => {
      expect(ladderRestartAt(spent)).toBe(last + 6 * HOUR);
      expect(ladderRestartAt(EMPTY_SUPERVISOR_HISTORY)).toBeUndefined();
      const waiting = assessEmployee(empty(failed), spent, ON, 2 * HOUR);
      expect(waiting.next).toEqual({
        action: null,
        at: last + 6 * HOUR,
        waitingFor: `the next round of repair steps, which starts at ${stamp(last + 6 * HOUR)}: this round's did not help`,
        preconditions: [],
      });
      expect(waiting.needsHuman).toBeUndefined();
      expect(SUPERVISOR_POLICY.ladderRestartMs).toBe(6 * HOUR);
    });

    it('starts again at that moment and not before, with the problem, its clock and the day’s rebuilds kept', () => {
      const seen = classifyEmployee(empty(failed));
      expect(rollSupervisorHistory(spent, seen, last + 6 * HOUR - 1).attempts).toEqual(spent.attempts);
      const again = rollSupervisorHistory(spent, seen, last + 6 * HOUR);
      expect(again).toMatchObject({ fingerprint: FAILED, since: 0, attempts: {}, rebuilds: [25 * MINUTE] });
      expect(assessEmployee(empty(failed), again, ON, last + 6 * HOUR).next).toMatchObject({
        action: 'rebuild-laptop',
        preconditions: [],
      });
    });

    it('holds for every path, whoever owns its rungs: the rule lives in the history alone', () => {
      const paths: Array<[SupervisorObservation, SupervisorAction[]]> = [
        [observed({ laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' } } }), ['reconnect-viewer']],
        [observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped' } }), ['start-continuation']],
        [held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED'), ['relaunch-provider', 'rebuild-laptop']],
        [move('DOCKER_RESOURCE_HELPER_FAILED'), ['continue-move', 'abandon-move']],
        [
          observed({ session: { startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false } } }),
          ['replace-sign-in'],
        ],
      ];
      for (const [seen, actions] of paths) {
        const base = classifyEmployee(seen);
        const attempts = Object.assign(
          {},
          ...actions.map((action) => tried(action, SUPERVISOR_POLICY.ladder[action].maxAttempts, HOUR))
        ) as SupervisorHistory['attempts'];
        const history = since(0, base.fingerprint, { attempts });
        expect([base.condition, rollSupervisorHistory(history, base, 7 * HOUR - 1).attempts]).toEqual([base.condition, attempts]);
        expect([base.condition, rollSupervisorHistory(history, base, 7 * HOUR).attempts]).toEqual([base.condition, {}]);
      }
    });

    it('keeps the limit of rebuilds per day across rounds', () => {
      const seen = classifyEmployee(empty(failed));
      const twoToday = { ...spent, rebuilds: [25 * MINUTE, last] };
      const again = rollSupervisorHistory(twoToday, seen, last + 6 * HOUR);
      expect(again.attempts).toEqual({});
      // A new round, but the day is not over: the rebuild waits for the limit, and says until when.
      expect(assessEmployee(empty(failed), again, ON, last + 6 * HOUR).next).toMatchObject({
        action: null,
        at: 25 * MINUTE + 24 * HOUR,
        waitingFor: expect.stringMatching(/^the daily limit on rebuilds of one laptop \(2\)/),
      });
    });
  });

  describe('the limit of rebuilds per day', () => {
    it('is a pause: the next day the ladder goes on by itself', () => {
      const today = since(0, FAILED, { rebuilds: [HOUR, 2 * HOUR] });
      const paused = assessEmployee(empty(failed), today, ON, 3 * HOUR);
      expect(paused.next).toEqual({
        action: null,
        at: 25 * HOUR,
        waitingFor:
          'the daily limit on rebuilds of one laptop (2): the earlier ones did not hold, and the next one may run at ' +
          stamp(25 * HOUR),
        preconditions: [],
      });
      expect(paused.needsHuman).toBeUndefined();
      const tomorrow = rollSupervisorHistory(today, classifyEmployee(empty(failed)), 25 * HOUR);
      expect(tomorrow.rebuilds).toEqual([2 * HOUR]);
      expect(assessEmployee(empty(failed), tomorrow, ON, 25 * HOUR).next.action).toBe('rebuild-laptop');
    });
  });

  describe('a laptop code the office does not recognize', () => {
    const odd = held('DOCKER_CONTINUATION_SOMETHING_NEW');
    const history = since(0, 'code:DOCKER_CONTINUATION_SOMETHING_NEW');

    it('is watched for thirty minutes and asks nobody', () => {
      const result = assessEmployee(odd, history, ON, 29 * MINUTE);
      expect(result).toMatchObject({ condition: 'held-needs-rebuild', code: 'DOCKER_CONTINUATION_SOMETHING_NEW' });
      expect(result.next).toEqual({
        action: null,
        at: 30 * MINUTE,
        waitingFor: `the code to clear by itself; if it still stands, the laptop is treated as held at ${stamp(30 * MINUTE)}`,
        preconditions: [],
      });
      expect(result.needsHuman).toBeUndefined();
      // Not even a laptop that is known to be empty is rebuilt before that.
      expect(assessEmployee(empty(odd), history, ON, 29 * MINUTE).next.action).toBeNull();
      expect(SUPERVISOR_POLICY.unrecognizedAfterMs).toBe(30 * MINUTE);
    });

    it('is then a hold under every rule of a rebuild', () => {
      expect(assessEmployee(odd, history, ON, 30 * MINUTE).next).toMatchObject({
        action: 'rebuild-laptop',
        preconditions: ['no-agent-running'],
      });
      expect(assessEmployee(empty(odd), history, ON, 30 * MINUTE).next).toMatchObject({ action: 'rebuild-laptop', preconditions: [] });
      const working = withLaptop(odd, { provider: 'running' }, { turn: 'working' });
      expect(assessEmployee(working, history, ON, 30 * HOUR).next).toMatchObject({
        action: null,
        waitingFor: "the agent's current turn to end",
      });
      const off = assessEmployee(empty(odd), history, { ...ON, autoRepair: false }, 30 * MINUTE);
      expect(off.next.action).toBeNull();
      expect(off.needsHuman).toMatch(/^Automatic repairs are switched off \(company setting supervisorAutoRepair\)\./);
    });

    it('is first answered with the request again when the laptop itself offers that', () => {
      const offered = held('DOCKER_CONTINUATION_SOMETHING_NEW', { allowedActions: ['observe', 'continue'] });
      expect(assessEmployee(offered, history, ON, MINUTE).next).toMatchObject({ action: 'resend-continuation', at: 20_000 });
    });
  });

  describe('something the office did not start in the laptop terminal', () => {
    const foreign = held('DOCKER_CONTINUATION_FOREIGN_PROVIDER');
    const history = since(0, 'code:DOCKER_CONTINUATION_FOREIGN_PROVIDER');

    it('is a hold the rebuild settles, asked of nobody', () => {
      const result = assessEmployee(foreign, history, ON, 3 * MINUTE);
      expect(result).toMatchObject({
        condition: 'held-needs-rebuild',
        next: { action: 'rebuild-laptop', at: 3 * MINUTE, preconditions: ['no-agent-running'] },
      });
      expect(result.needsHuman).toBeUndefined();
      // What was left there has ended: nothing can be lost.
      expect(assessEmployee(empty(foreign), history, ON, 3 * MINUTE).next).toMatchObject({ action: 'rebuild-laptop', preconditions: [] });
    });

    it('is rebuilt between that process’s turns when the office can see its pane, and after two hours when it cannot', () => {
      // First seen one second in: a problem with no clock at all is never called overdue.
      const seen = since(1000, 'code:DOCKER_CONTINUATION_FOREIGN_PROVIDER');
      const running = (session: Patch['session'], now: number) =>
        assessEmployee(withLaptop(foreign, { provider: 'running' }, session), seen, ON, now).next;
      expect(running({ turn: 'working' }, 50 * HOUR)).toMatchObject({ action: null, waitingFor: "the agent's current turn to end" });
      expect(running({ turn: 'idle', idleSince: 9 * MINUTE }, 10 * MINUTE)).toMatchObject({ action: null });
      expect(running({ turn: 'idle', idleSince: 8 * MINUTE }, 10 * MINUTE)).toMatchObject({
        action: 'rebuild-laptop',
        preconditions: ['agent-between-turns', 'laptop-held'],
      });
      // The office never attached a terminal to what it did not start: there is no reading at all.
      expect(running({}, 2 * HOUR)).toMatchObject({ action: null, at: 2 * HOUR + 1000 });
      expect(running({}, 2 * HOUR + 1000)).toMatchObject({
        action: 'rebuild-laptop',
        preconditions: ['laptop-held', 'agent-unreadable'],
      });
    });

    it('still does not let a plan move be abandoned for it', () => {
      expect(classifyMoveError('DOCKER_CONTINUATION_FOREIGN_PROVIDER')).toBe('owner');
      expect(supervisorCodeKind('DOCKER_CONTINUATION_FOREIGN_PROVIDER')).toBe('owner');
    });
  });

  describe('an office whose laptop configuration changed while it was running', () => {
    const changed = held('DOCKER_CONTINUATION_RUNTIME_CHANGED');

    it('is a wait for the office’s own restart: no laptop step, no stall, nobody asked', () => {
      const history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, classifyEmployee(changed), 0);
      for (const now of [MINUTE, 16 * MINUTE, 30 * HOUR]) {
        const result = assessEmployee(withLaptop(changed, { provider: 'exited', poolAlive: true }), history, ON, now);
        expect(result).toMatchObject({ condition: 'starting', code: 'DOCKER_CONTINUATION_RUNTIME_CHANGED' });
        expect(result.next).toEqual({
          action: null,
          waitingFor: 'the office to restart itself and read its laptop configuration again',
          preconditions: [],
        });
        expect(result.needsHuman).toBeUndefined();
      }
    });
  });

  describe('a laptop that never finishes starting', () => {
    const starting = held('DOCKER_CONTINUATION_BUSY');
    const history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, classifyEmployee(starting), 0);

    it('is sent its request again when it offers that, then rebuilt, counted from the fifteenth minute', () => {
      expect(SUPERVISOR_STALLED_PATH).toEqual(['resend-continuation', 'rebuild-laptop']);
      const offered = held('DOCKER_CONTINUATION_BUSY', { allowedActions: ['observe', 'continue'] });
      expect(assessEmployee(offered, history, ON, 15 * MINUTE)).toMatchObject({
        condition: 'starting',
        next: { action: 'resend-continuation', at: 15 * MINUTE + 20_000 },
      });
      expect(assessEmployee(empty(starting), history, ON, 15 * MINUTE)).toMatchObject({
        condition: 'held-needs-rebuild',
        next: { action: 'rebuild-laptop', at: 18 * MINUTE, preconditions: [] },
      });
    });

    it('is not rebuilt while it still becomes healthy in between', () => {
      const healthy = rollSupervisorHistory(history, classifyEmployee(observed()), 10 * MINUTE);
      const again = rollSupervisorHistory(healthy, classifyEmployee(starting), 11 * MINUTE);
      expect(assessEmployee(starting, again, ON, 20 * MINUTE).next.action).toBeNull();
    });
  });

  describe('an employee with no approved resource limits', () => {
    const bare = (standing?: { enabled: boolean; limits: boolean; layout: boolean }) =>
      observed({
        session: { available: false },
        laptop: { record: null, bound: false, restoration: undefined, policyApproved: false, ...(standing ? { standing } : {}) },
      });
    const history = since(0, 'no-policy');

    it('is given the owner’s standing default, one minute after that was first seen', () => {
      expect(SUPERVISOR_LIMITS_PATH).toEqual(['apply-standing-limits']);
      const result = assessEmployee(bare({ enabled: true, limits: true, layout: false }), history, ON, 30_000);
      expect(result).toMatchObject({
        condition: 'laptop-not-started',
        code: 'no-policy',
        next: { action: 'apply-standing-limits', at: MINUTE, preconditions: [] },
      });
      expect(result.needsHuman).toBeUndefined();
      // A set-up that reports the same thing takes the same path.
      const reported = withLaptop(held('DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED'), {
        policyApproved: false,
        standing: { enabled: true, limits: true, layout: true },
      });
      expect(assessEmployee(reported, since(0, 'code:DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED'), ON, MINUTE).next.action).toBe(
        'apply-standing-limits'
      );
    });

    it('with limits in place, has its stopped laptop started by the next reading', () => {
      const approved = observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped' } });
      const seen = classifyEmployee(approved);
      const next = rollSupervisorHistory(recordSupervisorAttempt(history, 'apply-standing-limits', MINUTE, 'done'), seen, 2 * MINUTE);
      expect(assessEmployee(approved, next, ON, 3 * MINUTE).next.action).toBe('start-continuation');
    });

    it('names the owner’s switch when he switched the standing defaults off, and that is the only refusal', () => {
      const off = assessEmployee(bare({ enabled: false, limits: true, layout: true }), history, ON, 5 * MINUTE);
      expect(off.next.action).toBeNull();
      expect(off.needsHuman).toBe(
        'The standing defaults are switched off (company setting supervisorStandingDefaults). Approve the resource ' +
          'limits: PUT /api/company/employees/:id/docker-policy, then continue the laptop.'
      );
      const repairsOff = assessEmployee(bare({ enabled: true, limits: true, layout: true }), history, { ...ON, autoRepair: false }, 5 * MINUTE);
      expect(repairsOff.next.action).toBeNull();
      expect(repairsOff.needsHuman).toMatch(/^Automatic repairs are switched off \(company setting supervisorAutoRepair\)\. Approve the resource limits/);
    });

    it('makes up no number: with no limits approved for anyone it says what is missing', () => {
      for (const standing of [{ enabled: true, limits: false, layout: false }, undefined]) {
        const none = assessEmployee(bare(standing), history, ON, 5 * MINUTE);
        expect(none.next.action).toBeNull();
        expect(none.needsHuman).toMatch(/^No employee of this office has approved resource limits, so the office has no approved value/);
      }
    });

    it('is a repair that is tried twice a round', () => {
      expect(SUPERVISOR_POLICY.ladder['apply-standing-limits']).toMatchObject({ tier: 'repair', maxAttempts: 2 });
      const spent = since(0, 'no-policy', { attempts: tried('apply-standing-limits', 2, MINUTE) });
      expect(assessEmployee(bare({ enabled: true, limits: true, layout: true }), spent, ON, HOUR).next).toMatchObject({
        action: null,
        at: MINUTE + 6 * HOUR,
      });
    });
  });

  describe('a laptop with no layout of its own on record', () => {
    const noLayout = (standing?: { enabled: boolean; limits: boolean; layout: boolean }) =>
      withLaptop(empty(failed), { templateOnRecord: false, ...(standing ? { standing } : {}) });
    const history = since(0, FAILED);

    it('is rebuilt with the layout the other laptops share', () => {
      const result = assessEmployee(noLayout({ enabled: true, limits: true, layout: true }), history, ON, 3 * MINUTE);
      expect(result.next).toMatchObject({ action: 'rebuild-laptop', preconditions: [] });
      expect(result.needsHuman).toBeUndefined();
    });

    it('names the owner’s switch, or says that no laptop of the office has a layout at all', () => {
      const off = assessEmployee(noLayout({ enabled: false, limits: true, layout: true }), history, ON, 3 * MINUTE);
      expect(off.next.action).toBeNull();
      expect(off.needsHuman).toMatch(
        /^No laptop layout is on record for this employee\. The standing defaults are switched off \(company setting supervisorStandingDefaults\)\. Rebuild the laptop: /
      );
      for (const standing of [{ enabled: true, limits: true, layout: false }, undefined]) {
        const none = assessEmployee(noLayout(standing), history, ON, 3 * MINUTE);
        expect(none.next.action).toBeNull();
        expect(none.needsHuman).toMatch(/^No owner-approved laptop layout is on record for this employee, and no other laptop of this office has one/);
      }
    });
  });

  describe('an employee whose session is not in a laptop', () => {
    const outside = observed({ boxed: false, session: { available: false }, laptop: { record: null, bound: false, restoration: undefined } });

    it('is woken, as the owner’s Wake does, six times a round', () => {
      const result = assessEmployee(outside, since(0, 'not-boxed'), ON, MINUTE);
      expect(result).toMatchObject({ condition: 'viewer-lost', code: 'not-boxed', next: { action: 'reconnect-viewer', at: 45_000 } });
      expect(result.needsHuman).toBeUndefined();
      const spent = since(0, 'not-boxed', { attempts: tried('reconnect-viewer', 6, HOUR) });
      expect(assessEmployee(outside, spent, ON, 2 * HOUR).next).toMatchObject({ action: null, at: 7 * HOUR });
      // No laptop step is ever taken for it, held input or not.
      const heldInput = { ...outside, session: { ...outside.session, inputHeld: true } };
      expect(assessEmployee(heldInput, spent, ON, 2 * HOUR).next.action).toBeNull();
      expect(assessEmployee(heldInput, since(0, 'not-boxed'), ON, MINUTE).next.action).toBe('reconnect-viewer');
    });
  });

  describe('an employee with no laptop', () => {
    const gone = (templateOnRecord: boolean) =>
      observed({
        session: { available: false },
        laptop: { record: null, bound: false, restoration: undefined, source: 'unknown', templateOnRecord },
      });

    it('has one made again by the rebuild when an earlier laptop operation is on record', () => {
      const result = assessEmployee(gone(true), since(0, 'no-laptop'), ON, 3 * MINUTE);
      expect(result).toMatchObject({
        condition: 'held-needs-rebuild',
        code: 'no-laptop',
        next: { action: 'rebuild-laptop', at: 3 * MINUTE, preconditions: ['no-agent-running'] },
      });
      expect(result.needsHuman).toBeUndefined();
    });

    it('says exactly what is missing for an employee who never had one, and goes on reading', () => {
      const result = assessEmployee(gone(false), since(0, 'no-laptop'), ON, 3 * MINUTE);
      expect(result).toMatchObject({ condition: 'unknown', code: 'no-laptop', next: { action: null } });
      expect(result.needsHuman).toMatch(/^This employee has never had a laptop in this office, and the office has no operation that makes a first one/);
      // The moment a stopped laptop of this employee exists, it is started.
      const made = observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped', templateOnRecord: false } });
      expect(assessEmployee(made, since(0, 'source-stopped'), ON, MINUTE).next.action).toBe('start-continuation');
    });
  });

  describe('never in the middle of a turn', () => {
    /** Every problem below was first seen one second in. */
    const T = 1000;
    const reasons: Array<[string, SupervisorObservation, SupervisorHistory]> = [
      ['a failed limits helper', failed, since(T, FAILED)],
      ['a code the office does not recognize', held('DOCKER_CONTINUATION_SOMETHING_NEW'), since(T, 'code:DOCKER_CONTINUATION_SOMETHING_NEW')],
      ['something the office did not start', held('DOCKER_CONTINUATION_FOREIGN_PROVIDER'), since(T, 'code:DOCKER_CONTINUATION_FOREIGN_PROVIDER')],
      ['an agent that is not confirmed', held('DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED'), since(T, 'code:DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED')],
      [
        'a start that never finishes',
        held('DOCKER_CONTINUATION_BUSY'),
        rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, classifyEmployee(held('DOCKER_CONTINUATION_BUSY')), T),
      ],
      [
        'a held terminal input',
        observed({
          session: { inputHeld: true },
          laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' } },
        }),
        recordSupervisorAttempt(since(T, 'code:DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED'), 'reconnect-viewer', 46_000, 'refused'),
      ],
    ];

    it.each(reasons)('%s: a turn the office can see is waited for, however long it lasts', (_title, seen, history) => {
      for (const provider of ['running', 'unknown'] as const)
        for (const now of [HOUR, 3 * HOUR, 5 * HOUR]) {
          const result = assessEmployee(withLaptop(seen, { provider }, { turn: 'working' }), history, ON, now);
          expect([provider, now, result.next]).toEqual([
            provider,
            now,
            { action: null, waitingFor: "the agent's current turn to end", preconditions: [] },
          ]);
          expect(result.needsHuman).toBeUndefined();
        }
    });

    it.each(reasons)('%s: an idle pane must have been silent for two minutes', (_title, seen, history) => {
      const idle = (idleSince: number) =>
        assessEmployee(withLaptop(seen, { provider: 'running' }, { turn: 'idle', idleSince }), history, ON, HOUR).next;
      expect(idle(HOUR - 2 * MINUTE + 1)).toMatchObject({ action: null, waitingFor: "the agent's terminal to stay quiet a little longer" });
      expect(idle(HOUR - 2 * MINUTE).action).toBe('rebuild-laptop');
      expect(SUPERVISOR_OCCUPIED_PROOFS.some((proof) => idle(HOUR - 2 * MINUTE).preconditions.includes(proof))).toBe(true);
    });

    it.each(reasons)('%s: work left running is given thirty minutes from when the problem was first seen', (_title, seen, history) => {
      const left = (now: number) =>
        assessEmployee(withLaptop(seen, { provider: 'running' }, { turn: 'idle', idleSince: 0, background: true }), history, ON, now).next;
      const from = history.since > 0 ? history.since : history.transitSince! + 15 * MINUTE;
      expect(left(from + 30 * MINUTE - 1)).toMatchObject({ action: null });
      expect(left(from + 31 * MINUTE).action).toBe('rebuild-laptop');
    });

    it('reads what a pane shows of the turn whether or not the terminal’s input is held', () => {
      const pane: SupervisedTerminal = { pid: 7, status: 'idle', isWorking: false, lastActivityAt: 500, lastPromptTime: 300, paneStartedAt: 100 };
      expect(readTerminalTurn(pane)).toEqual({ turn: 'idle', idleSince: 500 });
      expect(readTerminalTurn({ ...pane, watching: 'a monitor' })).toEqual({ turn: 'idle', idleSince: 500, background: true });
      expect(readTerminalTurn({ ...pane, isWorking: true })).toEqual({ turn: 'working' });
      expect(readTerminalTurn({ ...pane, status: 'busy' })).toEqual({ turn: 'working' });
      for (const unread of [undefined, { ...pane, pid: null }, { ...pane, runtimeHealth: 'disconnected' }, { ...pane, paneExit: {} }, { pid: 7 }])
        expect(readTerminalTurn(unread)).toEqual({ turn: 'unknown' });
      expect(readSupervisedTerminal(pane)).toEqual({});
    });
  });

  describe('the clocks behind every bound count unbroken runs that this office has watched', () => {
    const STEP = 30_000;
    /** Nothing here starts at time zero: a problem with no clock at all is never called overdue. */
    const T = 1000;
    type Assessment = ReturnType<typeof assessEmployee>;
    /** One observation every thirty seconds from `from` up to, not including, `to`. */
    const watch = (history: SupervisorHistory, seen: SupervisorObservation, from: number, to: number) => {
      for (let now = from; now < to; now += STEP) history = rollSupervisorHistory(history, classifyEmployee(seen), now);
      return history;
    };
    /** How long after `from` the first pass comes at which `hit` holds, while `seen` is observed every thirty seconds. */
    const until = (history: SupervisorHistory, seen: SupervisorObservation, from: number, hit: (result: Assessment) => boolean) => {
      for (let now = from; now < from + 8 * HOUR; now += STEP) {
        history = rollSupervisorHistory(history, classifyEmployee(seen), now);
        if (hit(assessEmployee(seen, history, ON, now))) return now - from;
      }
      return undefined;
    };
    const starting = held('DOCKER_CONTINUATION_BUSY');
    const stalled = (result: Assessment) => result.condition !== 'starting' || result.next.action !== null;
    const rebuilds = (result: Assessment) => result.next.action === 'rebuild-laptop';
    const odd = held('DOCKER_CONTINUATION_SOMETHING_NEW');
    /** An agent runs in the held laptop and the office has no reading of its pane. */
    const unread = withLaptop(failed, { provider: 'running' });

    describe('a laptop that is starting', () => {
      it('after hours of running normally, is stalled fifteen minutes after it was first seen starting and not before', () => {
        const healthy = watch(EMPTY_SUPERVISOR_HISTORY, observed(), T, T + 3 * HOUR);
        expect(healthy.transitSince).toBeUndefined();
        const from = T + 3 * HOUR;
        expect(assessEmployee(starting, rollSupervisorHistory(healthy, classifyEmployee(starting), from), ON, from)).toMatchObject({
          condition: 'starting',
          next: { action: null },
        });
        expect(until(healthy, starting, from, stalled)).toBe(15 * MINUTE);
        // And the rebuild keeps its own three minutes from that moment.
        const seen = watch(healthy, starting, from, from + 15 * MINUTE + STEP);
        expect(assessEmployee(starting, seen, ON, from + 15 * MINUTE).next).toMatchObject({
          action: 'rebuild-laptop',
          at: from + 18 * MINUTE,
          preconditions: ['no-agent-running'],
        });
      });

      it.each<[string, SupervisorObservation]>([
        ['was stopped by the owner', observed({ desiredRunning: false })],
        ['was out of the office', observed({ onVacation: true })],
        ['was being moved to another plan', move(undefined, { phase: 'starting' })],
        ['was being moved to another session', observed({ bindingMigration: true })],
        ['was at a start-up screen the office was answering', observed({ session: { startupScreen: { label: 'a chooser', kind: 'first-run', answering: true } } })],
        ['waited for the office to restart itself', held('DOCKER_CONTINUATION_RUNTIME_CHANGED')],
      ])('that for two hours before %s is not stalled for that time', (_title, before) => {
        const earlier = watch(EMPTY_SUPERVISOR_HISTORY, before, T, T + 2 * HOUR);
        const from = T + 2 * HOUR;
        const first = rollSupervisorHistory(earlier, classifyEmployee(starting), from);
        expect(first).toMatchObject({ transitSince: from, transitOf: 'starting' });
        expect(assessEmployee(starting, first, ON, from)).toMatchObject({ condition: 'starting', next: { action: null } });
        expect(until(earlier, starting, from, stalled)).toBe(15 * MINUTE);
      });

      it('starts its fifteen minutes again with each new stretch: a flapping read never adds up', () => {
        // Ten minutes starting, one healthy minute, starting again.
        let history = watch(EMPTY_SUPERVISOR_HISTORY, starting, T, T + 10 * MINUTE);
        history = watch(history, observed(), T + 10 * MINUTE, T + 11 * MINUTE);
        expect(until(history, starting, T + 11 * MINUTE, stalled)).toBe(15 * MINUTE);
        // Fourteen minutes starting, then a plan move for a minute, then starting again.
        history = watch(EMPTY_SUPERVISOR_HISTORY, starting, T, T + 14 * MINUTE);
        history = watch(history, observed({ bindingMigration: true }), T + 14 * MINUTE, T + 15 * MINUTE);
        expect(until(history, starting, T + 15 * MINUTE, stalled)).toBe(15 * MINUTE);
        // Five minutes starting and half a minute healthy, over and over for three hours: never stalled.
        history = EMPTY_SUPERVISOR_HISTORY;
        for (let now = T; now < T + 3 * HOUR; now += STEP) {
          const seen = Math.floor((now - T) / STEP) % 11 === 10 ? observed() : starting;
          history = rollSupervisorHistory(history, classifyEmployee(seen), now);
          expect([now, stalled(assessEmployee(starting, history, ON, now))]).toEqual([now, false]);
        }
      });

      it('that is seen without a break is stalled after fifteen minutes whatever the wait is called', () => {
        // Two different waits of the same starting laptop are one run.
        const history = watch(EMPTY_SUPERVISOR_HISTORY, held('DOCKER_CONTINUATION_UNCONFIRMED'), T, T + 10 * MINUTE);
        expect(until(history, starting, T + 10 * MINUTE, stalled)).toBe(5 * MINUTE);
      });
    });

    describe('an office start', () => {
      it('keeps what paces the ladder and drops every clock of what was watched', () => {
        const saved: SupervisorHistory = {
          fingerprint: FAILED,
          since: 5000,
          healthySince: 6000,
          transitSince: 7000,
          transitOf: 'starting',
          watchSince: 5000,
          attempts: tried('rebuild-laptop', 1, 8000),
          rebuilds: [8000],
          lastAction: { action: 'rebuild-laptop', at: 8000, outcome: 'refused', detail: 'x' },
        };
        expect(resumeSupervisorHistory(saved)).toEqual({
          fingerprint: FAILED,
          since: 5000,
          attempts: tried('rebuild-laptop', 1, 8000),
          rebuilds: [8000],
          lastAction: { action: 'rebuild-laptop', at: 8000, outcome: 'refused', detail: 'x' },
        });
        expect(resumeSupervisorHistory(EMPTY_SUPERVISOR_HISTORY)).toEqual(EMPTY_SUPERVISOR_HISTORY);
      });

      it('does not make an employee who is being attached again look stalled for the time the office was down', () => {
        // Starting for ten minutes when the office went down; it is back three hours later.
        const saved = watch(EMPTY_SUPERVISOR_HISTORY, starting, T, T + 10 * MINUTE);
        const up = T + 3 * HOUR;
        // What the saved clock would say, which is why it is not used:
        expect(until(saved, starting, up, stalled)).toBe(0);
        expect(until(resumeSupervisorHistory(saved), starting, up, stalled)).toBe(15 * MINUTE);
        // A file an earlier office wrote, with a clock that names no condition, is not trusted either.
        expect(until({ ...EMPTY_SUPERVISOR_HISTORY, transitSince: T }, starting, up, stalled)).toBe(15 * MINUTE);
      });

      it('does not count the time the office was down as healthy time', () => {
        const spent = since(T, FAILED, { attempts: tried('rebuild-laptop', 2, T), healthySince: T + MINUTE });
        const up = T + 3 * HOUR;
        expect(rollSupervisorHistory(spent, classifyEmployee(observed()), up).attempts).toEqual({});
        const resumed = rollSupervisorHistory(resumeSupervisorHistory(spent), classifyEmployee(observed()), up);
        expect(resumed).toMatchObject({ healthySince: up, attempts: tried('rebuild-laptop', 2, T) });
      });
    });

    describe('a code the office does not recognize', () => {
      const held30 = (history: SupervisorHistory, from: number) => until(history, odd, from, rebuilds);

      it('is watched for thirty minutes from when that code was first seen, whatever was seen before', () => {
        expect(held30(EMPTY_SUPERVISOR_HISTORY, T)).toBe(30 * MINUTE);
        // Two hours of another problem first.
        expect(held30(watch(EMPTY_SUPERVISOR_HISTORY, failed, T, T + 2 * HOUR), T + 2 * HOUR)).toBe(30 * MINUTE);
        // Two hours of a plan move first.
        expect(held30(watch(EMPTY_SUPERVISOR_HISTORY, observed({ bindingMigration: true }), T, T + 2 * HOUR), T + 2 * HOUR)).toBe(30 * MINUTE);
      });

      it('must stand without a break: a code that cleared and came back is watched for thirty minutes again', () => {
        // Twenty minutes, five healthy minutes (the same episode: the problem keeps when it was first seen), back.
        let history = watch(EMPTY_SUPERVISOR_HISTORY, odd, T, T + 20 * MINUTE);
        history = watch(history, observed(), T + 20 * MINUTE, T + 25 * MINUTE);
        const back = rollSupervisorHistory(history, classifyEmployee(odd), T + 25 * MINUTE);
        expect(back).toMatchObject({ since: T, watchSince: T + 25 * MINUTE });
        expect(held30(history, T + 25 * MINUTE)).toBe(30 * MINUTE);
        // The same when it read as starting for a minute in between.
        history = watch(watch(EMPTY_SUPERVISOR_HISTORY, odd, T, T + 29 * MINUTE), starting, T + 29 * MINUTE, T + 30 * MINUTE);
        expect(held30(history, T + 30 * MINUTE)).toBe(30 * MINUTE);
      });

      it('is watched for thirty minutes again after an office start, however long it stood before', () => {
        const saved = watch(EMPTY_SUPERVISOR_HISTORY, odd, T, T + 29 * MINUTE);
        const up = T + 4 * HOUR;
        const first = rollSupervisorHistory(resumeSupervisorHistory(saved), classifyEmployee(odd), up);
        expect(first).toMatchObject({ since: T, watchSince: up });
        expect(assessEmployee(odd, first, ON, up).next).toMatchObject({ action: null, at: up + 30 * MINUTE });
        expect(held30(resumeSupervisorHistory(saved), up)).toBe(30 * MINUTE);
      });
    });

    describe('a laptop whose pane the office cannot read', () => {
      const heldInput = observed({
        session: { inputHeld: true },
        laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' }, provider: 'running' },
      });

      it('is rebuilt two hours after that problem was first seen in an unbroken run', () => {
        expect(until(EMPTY_SUPERVISOR_HISTORY, unread, T, rebuilds)).toBe(2 * HOUR);
        // Ninety minutes, five healthy minutes, and the problem is back: two hours from then, not twenty-five minutes.
        let history = watch(EMPTY_SUPERVISOR_HISTORY, unread, T, T + 90 * MINUTE);
        history = watch(history, observed(), T + 90 * MINUTE, T + 95 * MINUTE);
        expect(until(history, unread, T + 95 * MINUTE, rebuilds)).toBe(2 * HOUR);
        // Another problem for three hours first: two hours from the first sight of this one.
        expect(until(watch(EMPTY_SUPERVISOR_HISTORY, odd, T, T + 3 * HOUR), unread, T + 3 * HOUR, rebuilds)).toBe(2 * HOUR);
      });

      it('is not rebuilt at the first look after an office start: the two hours start again there', () => {
        // The problem stood for five hours before the office went down, so the saved history is far past the bound.
        const saved = watch(EMPTY_SUPERVISOR_HISTORY, unread, T, T + 5 * HOUR);
        const up = T + 6 * HOUR;
        const first = rollSupervisorHistory(resumeSupervisorHistory(saved), classifyEmployee(unread), up);
        expect(first).toMatchObject({ since: T, watchSince: up });
        expect(assessEmployee(unread, first, ON, up).next).toMatchObject({
          action: null,
          at: up + 2 * HOUR,
          waitingFor: `a reading of the agent's terminal; if there is still none, the laptop is rebuilt at ${stamp(up + 2 * HOUR)}`,
        });
        expect(until(resumeSupervisorHistory(saved), unread, up, rebuilds)).toBe(2 * HOUR);
      });

      it('holds the same for a held terminal input, the laptop that has no terminal object after an office start', () => {
        const FINGERPRINT = classifyEmployee(heldInput).fingerprint;
        const saved = recordSupervisorAttempt(since(T, FINGERPRINT, { watchSince: T }), 'reconnect-viewer', T + 45_000, 'refused');
        // Back three hours later, within the same round of steps: the one nudge is not repeated.
        const up = T + 3 * HOUR;
        // Used as it was saved, the bound would be met at the first look:
        expect(until(saved, heldInput, up, rebuilds)).toBe(0);
        const resumed = resumeSupervisorHistory(saved);
        expect(until(resumed, heldInput, up, rebuilds)).toBe(2 * HOUR);
        // A read inside the laptop that finds no agent is still acted on at once: that is a read, made now.
        const empty = withLaptop(heldInput, { provider: 'exited', poolAlive: true });
        expect(until(resumed, empty, up, rebuilds)).toBe(0);
      });

      it('measures the two shorter waits the same way', () => {
        const up = T + 6 * HOUR;
        // A read that cannot say what runs in the laptop: fifteen minutes before it counts as an agent.
        const unknown = withLaptop(failed, { provider: 'unknown' }, { turn: 'idle', idleSince: 0 });
        const savedUnknown = resumeSupervisorHistory(watch(EMPTY_SUPERVISOR_HISTORY, unknown, T, T + 5 * HOUR));
        expect(until(savedUnknown, unknown, up, rebuilds)).toBe(15 * MINUTE);
        // Work the agent left running: thirty minutes.
        const left = withLaptop(failed, { provider: 'running' }, { turn: 'idle', idleSince: 0, background: true });
        const savedLeft = resumeSupervisorHistory(watch(EMPTY_SUPERVISOR_HISTORY, left, T, T + 5 * HOUR));
        expect(until(savedLeft, left, up, rebuilds)).toBe(30 * MINUTE);
      });
    });
  });
});
