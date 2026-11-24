import { describe, it, expect } from 'vitest';
import {
  EMPTY_SUPERVISOR_HISTORY,
  SUPERVISOR_PATHS,
  SUPERVISOR_POLICY,
  assessEmployee,
  classifyEmployee,
  classifyMoveError,
  issueSupervisorAttempt,
  recordSupervisorAttempt,
  settleSupervisorAttempt,
  rollSupervisorHistory,
  supervisorCodeKind,
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
    ['a held move of the retired runtime', move('x', { docker: false }), 'needs-owner'],
    ['a held move with no continue step', move('x', { allowedActions: [] }), 'needs-owner'],
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
      'needs-owner',
    ],
    [
      'a session on a screen that is the owner’s choice',
      observed({ session: { startupScreen: { label: 'a permissions prompt', kind: 'decision', answering: false } } }),
      'needs-owner',
    ],
    ['a laptop set-up that is still running', held('DOCKER_CONTINUATION_BUSY'), 'starting'],
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
    ['no approved limits on a set-up', held('DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED'), 'needs-owner'],
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
      'needs-owner',
    ],
    [
      'no laptop at all',
      observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'absent' } }),
      'unknown',
    ],
    ['a code nobody has listed', held('DOCKER_CONTINUATION_SOMETHING_NEW'), 'unknown', /does not recognize/],
    ['a code that is not a code', held('rm -rf /'), 'unknown'],
    [
      'an employee outside a laptop who is connected',
      observed({ boxed: false, laptop: { record: null, bound: false, restoration: undefined } }),
      'healthy',
    ],
    [
      'an employee outside a laptop who is not connected',
      observed({ boxed: false, session: { available: false }, laptop: { record: null, bound: false, restoration: undefined } }),
      'unknown',
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
      'healthy', 'starting', 'waiting-first-run-screen', 'needs-sign-in', 'needs-owner', 'provider-exited',
      'viewer-lost', 'held-retryable', 'held-needs-rebuild', 'laptop-not-started', 'move-in-progress',
      'move-held-retryable', 'owner-stopped', 'unknown',
    ];
    expect([...seen].sort()).toEqual([...all].sort());
  });

  it('never gives an unknown condition a ladder', () => {
    for (const condition of ['unknown', 'needs-owner', 'needs-sign-in', 'owner-stopped', 'healthy', 'starting'] as const)
      expect(SUPERVISOR_PATHS[condition]).toBeUndefined();
    const result = assessEmployee(held('DOCKER_CONTINUATION_SOMETHING_NEW'), since(0, 'x'), ON, 99 * MINUTE);
    expect(result.next.action).toBeNull();
    expect(result.needsHuman).toMatch(/docker-policy/);
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

  it('names the plan and says where to sign in', () => {
    const screen = { label: "Claude's sign-in screen", kind: 'credential' as const, answering: false };
    const unsigned = classifyEmployee(observed({ planSignedIn: false, session: { startupScreen: screen } }));
    expect(unsigned.needsHuman).toMatch(/Sign in the plan “Max 20x” at the office/);
    const signed = classifyEmployee(observed({ planSignedIn: true, session: { startupScreen: screen } }));
    expect(signed.condition).toBe('needs-sign-in');
    expect(signed.needsHuman).toMatch(/signed in at the office, but this laptop's own sign-in folder does not have it/);
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
    it('is never automatic while an agent runs in the laptop', () => {
      const result = provider('running');
      expect(result.next.action).toBeNull();
      expect(result.needsHuman).toMatch(/would discard its conversation.*confirmDiscardRunning/);
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
      expect(twice.next.action).toBeNull();
      expect(twice.needsHuman).toMatch(/Rebuilding did not help/);
      const today = assessEmployee(
        { ...failed, laptop: { ...failed.laptop, provider: 'exited' } },
        { ...history, rebuilds: [60 * MINUTE, 120 * MINUTE] },
        ON,
        180 * MINUTE
      );
      expect(today.next.action).toBeNull();
      expect(today.needsHuman).toMatch(/already rebuilt this laptop 2 times today/);
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
    it('is never abandoned for a reason the office does not recognize', () => {
      const odd = move('The original Docker journal changed');
      const result = assessEmployee(
        odd,
        since(0, classifyEmployee(odd).fingerprint, { attempts: tried('continue-move', 3, MINUTE) }),
        ON,
        60 * MINUTE
      );
      expect(result.next.action).toBeNull();
      expect(result.needsHuman).toMatch(/does not abandon a move for a reason it does not recognize/);
    });
    it('is never abandoned while it waits for a sign-in', () => {
      const error = describeStartupScreen("Stan's new session", { label: "Claude's sign-in screen", kind: 'credential', answering: false });
      const waiting = assessEmployee(move(error), since(0, 'x'), ON, 60 * MINUTE);
      expect(waiting).toMatchObject({ condition: 'needs-sign-in', next: { action: null } });
      expect(waiting.needsHuman).toMatch(/Sign in the plan “Max 20x”/);
      // Once the office reports the plan signed in, the move is continued, and still never abandoned for it.
      const signed = { ...move(error), planSignedIn: true };
      expect(assessEmployee(signed, since(0, 'x'), ON, 60 * MINUTE).next.action).toBe('continue-move');
      const spent = assessEmployee(signed, since(0, 'x', { attempts: tried('continue-move', 3, 0) }), ON, 60 * MINUTE);
      expect(spent.next.action).toBeNull();
      expect(spent.needsHuman).toBeTruthy();
    });
    it('is left alone when its record does not offer abandon', () => {
      const result = assessEmployee(
        move('DOCKER_RESOURCE_HELPER_FAILED', { allowedActions: ['continue-original'] }),
        since(0, 'x', { attempts: tried('continue-move', 3, 0) }),
        ON,
        60 * MINUTE
      );
      expect(result.next.action).toBeNull();
      expect(result.needsHuman).toMatch(/cannot be abandoned here/);
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

  it('reports a start that never finishes', () => {
    const starting = held('DOCKER_CONTINUATION_BUSY');
    const history = rollSupervisorHistory(EMPTY_SUPERVISOR_HISTORY, classifyEmployee(starting), 1000);
    expect(assessEmployee(starting, history, ON, 1000 + 14 * MINUTE).needsHuman).toBeUndefined();
    expect(assessEmployee(starting, history, ON, 1000 + 15 * MINUTE).needsHuman).toMatch(/has not changed for a while/);
  });

  it('nudges a lost terminal and then asks for a person, never for a rebuild', () => {
    const lost = observed({ laptop: { restoration: { state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' } } });
    const fp = classifyEmployee(lost).fingerprint;
    expect(assessEmployee(lost, since(0, fp), ON, 0).next).toMatchObject({ action: 'reconnect-viewer', at: 45_000 });
    const spent = assessEmployee(lost, since(0, fp, { attempts: tried('reconnect-viewer', 6, 0) }), ON, 60 * MINUTE);
    expect(spent.next.action).toBeNull();
    expect(spent.needsHuman).toMatch(/could not reconnect the terminal/);
    expect(SUPERVISOR_PATHS['viewer-lost']).not.toContain('rebuild-laptop');
  });

  it('starts a fresh laptop source and gives up after three tries', () => {
    const fresh = observed({ laptop: { record: null, bound: false, restoration: undefined, source: 'stopped' } });
    expect(assessEmployee(fresh, since(0, 'source-stopped'), ON, MINUTE).next.action).toBe('start-continuation');
    const spent = assessEmployee(fresh, since(0, 'source-stopped', { attempts: tried('start-continuation', 3, 0) }), ON, 60 * MINUTE);
    expect(spent.next.action).toBeNull();
    expect(spent.needsHuman).toMatch(/would not start/);
  });

  it('orders every path from the least to the most destructive step', () => {
    const order: SupervisorAction[] = [
      'resend-continuation', 'start-continuation', 'continue-move', 'reconnect-viewer', 'relaunch-provider',
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

  it('asks for a person once a laptop has been unreadable for fifteen minutes', () => {
    const failed = held('DOCKER_RESOURCE_HELPER_FAILED');
    const unread = { ...failed, laptop: { ...failed.laptop, provider: 'unknown' as const } };
    const history = since(MINUTE, classifyEmployee(failed).fingerprint);
    expect(assessEmployee(unread, history, ON, 15 * MINUTE).needsHuman).toBeUndefined();
    const stuck = assessEmployee(unread, history, ON, 16 * MINUTE);
    expect(stuck.next.action).toBeNull();
    expect(stuck.needsHuman).toMatch(/cannot read what is running in this laptop/);
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

  it('a laptop at a sign-in screen whose plan is signed in at the office is reported, never answered', () => {
    const screen = observed({
      planSignedIn: true,
      session: { startupScreen: { label: "Claude's sign-in screen", kind: 'credential', answering: false } },
    });
    const result = assessEmployee(screen, since(0, classifyEmployee(screen).fingerprint), ON, 600 * MINUTE);
    expect(result).toMatchObject({ condition: 'needs-sign-in', next: { action: null } });
    expect(result.sentence).toBe("Stan is waiting at Claude's sign-in screen.");
    expect(result.needsHuman).toMatch(/the plan “Max 20x” is signed in at the office/);
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
