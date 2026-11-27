/**
 * @fileoverview The office recovery supervisor's decision core (pure).
 *
 * The office records what every employee SHOULD be doing (`desiredRunning`, `onVacation`, the runtime recipe and
 * the laptop record) and can read what each one IS doing. This module turns one employee's observation into exactly
 * one condition from a closed set, one plain sentence, and the next step of a fixed, bounded repair ladder.
 *
 * Nothing here performs an effect, reads a clock or holds state: the driver (`employee-supervisor.ts`) supplies the
 * observation, the persisted history and the time, and runs the step through the same service methods the owner's
 * routes call. A condition, a sentence and an action name are DATA; none of them authorizes the action they name.
 *
 * Unknown input is never acted on at once. A laptop code this table does not list is watched first; only when it
 * has stood for `unrecognizedAfterMs` is the laptop treated as held, and then under every rule of a rebuild.
 *
 * No path ends for good. A ladder whose rungs are all used starts again `ladderRestartMs` after its last attempt
 * (`ladderRestartAt`), and a limit says when it lifts. The office says that it will not act in one case only: the
 * owner switched that kind of step off in the company settings.
 */

/** Closed set. `needs-owner` covers every recognized state that only a person (or a granted agent) may settle. */
export type SupervisorCondition =
  | 'healthy'
  | 'starting'
  | 'waiting-first-run-screen'
  | 'needs-sign-in'
  | 'needs-owner'
  | 'provider-exited'
  | 'viewer-lost'
  | 'held-retryable'
  | 'held-needs-rebuild'
  | 'laptop-not-started'
  | 'move-in-progress'
  | 'move-held-retryable'
  | 'move-held-dead-end'
  | 'owner-stopped'
  | 'unknown';

/** Every effect the supervisor can ask for, least destructive first. */
export type SupervisorAction =
  | 'resend-continuation'
  | 'apply-standing-limits'
  | 'start-continuation'
  | 'continue-move'
  | 'reconnect-viewer'
  | 'replace-sign-in'
  | 'relaunch-provider'
  | 'abandon-move'
  | 'rebuild-laptop';

/** `retry` repeats or reconnects and discards nothing. `repair` gives something up (a held move, a laptop). */
export type SupervisorTier = 'retry' | 'repair';

export interface SupervisorRung {
  readonly tier: SupervisorTier;
  /** Attempts per episode (an episode ends once the employee has been healthy for `healthyResetMs`). */
  readonly maxAttempts: number;
  /** The condition must have lasted this long before the first attempt. */
  readonly dwellMs: number;
  /** Wait after attempt N before attempt N+1; the last value repeats. */
  readonly backoffMs: readonly number[];
  /** After the last attempt, how long its outcome is watched before the next rung is considered. */
  readonly escalateAfterMs: number;
}

export interface SupervisorPolicy {
  readonly ladder: Readonly<Record<SupervisorAction, SupervisorRung>>;
  /** Automatic rebuilds of one laptop per rolling day, across episodes. */
  readonly rebuildsPerDay: number;
  /** Continuously healthy this long ends the episode and clears its attempt counts. */
  readonly healthyResetMs: number;
  /**
   * A laptop that has been starting or between states this long is treated as held, and a read that could not say
   * what runs in a laptop for this long is treated as one that found an agent.
   */
  readonly stalledAfterMs: number;
  /** A laptop an agent may run in is rebuilt only after that agent's pane has been idle and silent this long. */
  readonly heldInputIdleMs: number;
  /** Work an agent left running after its turn is waited for until this long after the problem was first seen. */
  readonly heldInputTurnMs: number;
  /** A ladder whose rungs are all used starts again this long after its last attempt. */
  readonly ladderRestartMs: number;
  /** A laptop code the office does not recognize is treated as a hold once it has stood this long. */
  readonly unrecognizedAfterMs: number;
  /**
   * A laptop that has to be rebuilt while the office cannot read its agent's pane at all is rebuilt once the
   * problem has stood this long.
   */
  readonly blindRebuildMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * The repair ladder as data. Reasons for the defaults:
 *
 * - Retries are cheap and guarded by the operation they repeat (an unknown outcome is never repeated there), so they
 *   start within a minute and are spaced out; four re-sends cover the helper's own three-writer budget per request.
 *   A request that was refused with a code only a fresh laptop settles is the exception: see `resendAnswered`.
 * - A viewer is first left to the laptop runtime's own ten-second reconnect; the supervisor only adds a nudge.
 * - A sign-in the laptop is missing is put back at once. It replaces one file the client at the sign-in screen is
 *   waiting for and gives nothing up, so it is a retry: it also runs with automatic repairs switched off.
 * - Abandoning a move waits 15 minutes on the SAME error and three failed continues: a move that only needed time
 *   or one more read has finished by then, and abandoning writes the journal only (nothing is stopped or removed).
 *   Every held move ends there, whatever stopped it: a move is never kept for the owner. A move that waits for
 *   something outside itself is given longer first (see `SUPERVISOR_MOVE_POLICY`).
 * - A rebuild discards a laptop, so it waits longest, runs at most twice per episode and twice per day, and is
 *   never chosen in the middle of a turn of an agent that runs in that laptop (see `rebuildGate`).
 * - The first laptop to be rebuilt while its agent runs was one whose office terminal has its input held for good
 *   (see `heldInputRebuildGate`). The
 *   office can never type to that agent again and no reconnect gives the terminal back, so once the agent's turn
 *   has ended, keeping it gains nothing. Such a laptop is rebuilt while its agent runs, but never in the middle of a
 *   turn: the pane must have been idle and silent for two minutes. The office terminal calls a pane idle after a few
 *   silent seconds and a look at the screen; two more minutes cover a pause between two tool calls that this look
 *   missed, while a working agent redraws its pane every second. A turn the office can see is waited for, however
 *   long it lasts, and nobody is asked. An agent that ended its turn with work left running (a monitor, a
 *   background shell) is given thirty minutes from when the problem was first seen: an ordinary turn has finished
 *   by then, a job of ordinary length finishes, and a shell that never ends does not keep the employee out of
 *   reach for good.
 * - The same rule, with the same times, serves every other laptop that only a rebuild settles while an agent still
 *   runs in it (`betweenTurnsGate`). It is rebuilt between the agent's turns and never in the middle of one.
 * - A pane the office cannot read at all is the hard case: after an office restart there is no terminal object for
 *   a session whose input is held, and a process the office did not start was never attached. Waiting for a reading
 *   that cannot come would leave the employee out of reach for good, so the laptop is rebuilt two hours after the
 *   problem was first seen. Two hours is four times the thirty minutes an ordinary turn is given, so only an
 *   unusually long turn can be cut short, and what such a turn loses is its unfinished step: the home directory and
 *   the conversation saved in it are kept, and the fresh laptop continues that conversation. A read made inside the
 *   laptop is asked first, and a laptop it shows to be empty is rebuilt without this wait.
 * - A code the office does not recognize may be a state of a newer laptop runtime that settles by itself. It is
 *   watched for thirty minutes, twice the time after which a recognized wait is called stalled, and only then
 *   treated as a hold.
 * - Limits that the owner approved for the other employees are given to an employee who has none after one minute:
 *   the step writes a record and stops nothing.
 * - A ladder that has used every rung starts again six hours after its last attempt. That is four rounds a day of
 *   steps that are cheap or guarded; the rebuild keeps its own limit of two per day across rounds.
 */
export const SUPERVISOR_POLICY: SupervisorPolicy = {
  ladder: {
    'resend-continuation': {
      tier: 'retry',
      maxAttempts: 4,
      dwellMs: 20 * SECOND,
      backoffMs: [30 * SECOND, 2 * MINUTE, 5 * MINUTE],
      escalateAfterMs: 2 * MINUTE,
    },
    'apply-standing-limits': {
      tier: 'repair',
      maxAttempts: 2,
      dwellMs: MINUTE,
      backoffMs: [5 * MINUTE],
      escalateAfterMs: MINUTE,
    },
    'start-continuation': {
      tier: 'retry',
      maxAttempts: 3,
      dwellMs: 20 * SECOND,
      backoffMs: [MINUTE, 5 * MINUTE],
      escalateAfterMs: 2 * MINUTE,
    },
    'continue-move': {
      tier: 'retry',
      maxAttempts: 3,
      dwellMs: MINUTE,
      backoffMs: [2 * MINUTE, 5 * MINUTE],
      escalateAfterMs: 3 * MINUTE,
    },
    'reconnect-viewer': {
      tier: 'retry',
      maxAttempts: 6,
      dwellMs: 45 * SECOND,
      backoffMs: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
      escalateAfterMs: 5 * MINUTE,
    },
    'replace-sign-in': {
      tier: 'retry',
      maxAttempts: 3,
      dwellMs: 0,
      backoffMs: [MINUTE, 5 * MINUTE],
      escalateAfterMs: 3 * MINUTE,
    },
    'relaunch-provider': {
      tier: 'retry',
      maxAttempts: 2,
      dwellMs: 30 * SECOND,
      backoffMs: [2 * MINUTE],
      escalateAfterMs: 2 * MINUTE,
    },
    'abandon-move': {
      tier: 'repair',
      maxAttempts: 2,
      dwellMs: 15 * MINUTE,
      backoffMs: [5 * MINUTE],
      escalateAfterMs: MINUTE,
    },
    'rebuild-laptop': {
      tier: 'repair',
      maxAttempts: 2,
      dwellMs: 3 * MINUTE,
      backoffMs: [15 * MINUTE],
      escalateAfterMs: 10 * MINUTE,
    },
  },
  rebuildsPerDay: 2,
  healthyResetMs: 10 * MINUTE,
  stalledAfterMs: 15 * MINUTE,
  heldInputIdleMs: 2 * MINUTE,
  heldInputTurnMs: 30 * MINUTE,
  ladderRestartMs: 6 * 60 * MINUTE,
  unrecognizedAfterMs: 30 * MINUTE,
  blindRebuildMs: 2 * 60 * MINUTE,
};

/** The two owner switches. Both off means the supervisor only describes what it sees. */
export interface SupervisorFlags {
  /** Observe, retry and reconnect. */
  readonly enabled: boolean;
  /**
   * Abandon a dead-end move, rebuild a laptop (at once when nothing runs in it, otherwise between its agent's
   * turns), and give an employee who has no approved limits the owner's standing default.
   */
  readonly autoRepair: boolean;
  /** The office can relaunch an exited agent inside its running laptop. */
  readonly relaunchAvailable: boolean;
  /** The office can put the sign-in of a plan back into a laptop that lost it. */
  readonly signInRepairAvailable?: boolean;
}

export type SupervisorProviderPresence = 'running' | 'exited' | 'absent' | 'no-laptop' | 'unknown';

export type SupervisorBusy =
  | 'continuation-flight'
  | 'laptop-operation'
  | 'owner-stop-pending'
  | 'recovery-pending'
  | 'lifecycle-in-progress'
  | 'publication-unconfirmed';

export type SupervisorTurn = 'working' | 'idle' | 'unknown';

/**
 * What a step asks to be proved again, last, before it runs.
 * - `no-agent-running`: a fresh read inside the laptop finds no agent.
 * - `terminal-input-held`: the office terminal's input is still held and its pane still shows no turn in progress.
 * - `agent-between-turns`: an agent may run in the laptop, and the office terminal still shows its pane idle: no
 *   turn is in progress.
 * - `agent-unreadable`: the office has no reading of the pane and `blindRebuildMs` has passed. Beside one of the
 *   two above it lifts their demand for an idle pane; a pane that is read and shows a turn in progress still stops
 *   the step.
 * - `laptop-held`: the laptop's own read still says it is held or unfinished.
 *
 * The three in the middle are the only reasons for which a rebuild may discard a laptop its agent runs in.
 */
export type SupervisorPrecondition =
  | 'no-agent-running'
  | 'terminal-input-held'
  | 'agent-between-turns'
  | 'agent-unreadable'
  | 'laptop-held';

/** The proofs that allow a rebuild to discard the one recorded laptop while an agent may run in it. */
export const SUPERVISOR_OCCUPIED_PROOFS: readonly SupervisorPrecondition[] = [
  'terminal-input-held',
  'agent-between-turns',
  'agent-unreadable',
];

/** Everything the office can read about one employee, already reduced to plain values. */
export interface SupervisorObservation {
  readonly employeeId: string;
  readonly name: string;
  readonly desiredRunning: boolean | undefined;
  readonly onVacation: boolean;
  readonly bindingMigration: boolean;
  /** The employee runs in a Docker laptop under the boxed runtime. Others are only described. */
  readonly boxed: boolean;
  /** Owner-facing name of the plan or model the employee should run on. */
  readonly planLabel?: string;
  /** Whether the office reports that plan signed in. `undefined` when it does not know. */
  readonly planSignedIn?: boolean;
  readonly session: {
    readonly available: boolean;
    readonly runtimeHealth: 'healthy' | 'dead' | 'disconnected' | 'unknown';
    readonly viewerHealth: 'connected' | 'disconnected' | 'unknown';
    readonly providerHealth?: 'healthy' | 'dead' | 'unknown';
    /** The provider start-up screen the session is parked on, when the scanner names one. */
    readonly startupScreen?: {
      readonly label: string;
      readonly kind: 'first-run' | 'credential' | 'decision';
      readonly answering: boolean;
    };
    /**
     * The office can never type into this terminal again: an input it may have sent was never confirmed, and
     * neither health nor a new client clears that. Absent while the terminal takes input.
     */
    readonly inputHeld?: boolean;
    /**
     * What the office terminal shows of the agent's turn: `working` while one is in progress, `idle` once it has
     * ended, `unknown` (or absent) while the office is not reading the pane. Never read as idle.
     */
    readonly turn?: SupervisorTurn;
    /** Since when this office process has seen the pane idle and silent. Reported with `turn: 'idle'`. */
    readonly idleSince?: number;
    /** The idle pane says its agent left work running: a monitor or a background shell. Reported with `turn: 'idle'`. */
    readonly background?: boolean;
  };
  readonly laptop: {
    readonly record: { readonly phase: string; readonly version: number; readonly operationId: string } | null;
    /** The employee carries a published laptop binding. */
    readonly bound: boolean;
    readonly policyApproved: boolean;
    /** State of the stopped source a new set-up would start from. Read only while there is no record. `outdated`:
     * it has never been started and was made for an earlier laptop image, so this office cannot start it. */
    readonly source?: 'stopped' | 'running' | 'absent' | 'outdated' | 'unknown';
    /** The runtime's own last attempt to attach the office terminal. */
    readonly restoration?: { readonly state: 'attached' } | { readonly state: 'held'; readonly code: string };
    /** A fresh read of the set-up operation, in the shape the owner's observe route returns. */
    readonly continuation?: {
      readonly state: 'ready' | 'pending' | 'held';
      readonly phase: string;
      readonly code?: string;
      readonly allowedActions: readonly string[];
      /** One sentence about how the agent ended, when the laptop kept that evidence. */
      readonly providerExit?: string;
      readonly message?: string;
    };
    /** Fresh positive read of what runs in the laptop. Only made before a rebuild is decided. */
    readonly provider?: SupervisorProviderPresence;
    /** An owner-approved laptop layout is on record for this employee. */
    readonly templateOnRecord: boolean;
    /**
     * The owner's standing defaults (company setting `supervisorStandingDefaults`): whether they are switched on,
     * and whether resource limits and a laptop layout that the owner approved for the other employees exist to give
     * to an employee who has none of their own. Absent where the office has no laptops.
     */
    readonly standing?: { readonly enabled: boolean; readonly limits: boolean; readonly layout: boolean };
    /** Another laptop of the same box is attached and running, so the shared pool they all use is alive. */
    readonly poolAlive?: boolean;
    /** A rebuild of this laptop is recorded but not finished. The same request sent again finishes it. */
    readonly rebuildPending?: boolean;
  };
  /** The employee's open plan move, when there is one. */
  readonly move?: {
    readonly id: string;
    readonly docker: boolean;
    readonly phase: string;
    /** A step of the move is running right now. */
    readonly busy: boolean;
    readonly error?: string;
    readonly allowedActions: readonly string[];
  };
  /** Another owner of this employee is working; no action may start beside it. */
  readonly busy?: SupervisorBusy;
}

/** The part of the office's own terminal object that says whether it still takes input and what its pane shows. */
export interface SupervisedTerminal {
  readonly pid: number | null;
  readonly status?: string;
  readonly runtimeHealth?: string;
  readonly paneExit?: unknown;
  readonly viewerInputHeld?: boolean;
  readonly paneLifecycleInFlight?: boolean;
  readonly terminalInputHeld?: boolean;
  readonly isWorking?: boolean;
  /** What the pane says its agent left running after its turn (a monitor, a background shell), or nothing. */
  readonly watching?: string | null;
  /** Times, 0 for never: the pane's last output, the end of its last turn, and its last start or attach. */
  readonly lastActivityAt?: number;
  readonly lastPromptTime?: number;
  readonly paneStartedAt?: number;
}

export type SupervisorTerminalReading = Pick<
  SupervisorObservation['session'],
  'inputHeld' | 'turn' | 'idleSince' | 'background'
>;

/** The office is attached to the pane and reading it, so what it says about the agent's turn is first-hand. */
function paneWatched(terminal: SupervisedTerminal): boolean {
  return (
    terminal.pid !== null &&
    typeof terminal.isWorking === 'boolean' &&
    !terminal.paneExit &&
    !terminal.viewerInputHeld &&
    !terminal.paneLifecycleInFlight &&
    terminal.runtimeHealth !== 'disconnected' &&
    terminal.runtimeHealth !== 'dead'
  );
}

/**
 * One office terminal reduced to what a held input is judged by. The observation is built with it and a rebuild
 * reads it again immediately before it is requested, so the two cannot disagree. A terminal that takes input
 * reports nothing.
 *
 * `heldOnRecord` is asked only when the office has no terminal object for the session (after an office restart):
 * the saved session then still says its input is held, and nothing shows the pane, so the turn is unknown.
 */
export function readSupervisedTerminal(
  terminal: SupervisedTerminal | undefined,
  heldOnRecord = false
): SupervisorTerminalReading {
  if (!(terminal ? terminal.terminalInputHeld === true : heldOnRecord)) return {};
  return { inputHeld: true, ...readTerminalTurn(terminal) };
}

/**
 * What one office terminal shows of its agent's turn, whether or not its input is held. It is what every rebuild of
 * a laptop that an agent may run in is judged by: the observation carries it and the step reads it again last.
 * No terminal object, or a pane the office is not attached to and reading, is `unknown` and never idle.
 */
export function readTerminalTurn(
  terminal: SupervisedTerminal | undefined
): Pick<SupervisorTerminalReading, 'idleSince' | 'background'> & { readonly turn: SupervisorTurn } {
  if (!terminal || !paneWatched(terminal)) return { turn: 'unknown' };
  if (terminal.isWorking || terminal.status === 'busy') return { turn: 'working' };
  if (terminal.status !== 'idle') return { turn: 'unknown' };
  const idleSince = Math.max(terminal.lastActivityAt ?? 0, terminal.lastPromptTime ?? 0, terminal.paneStartedAt ?? 0);
  return {
    turn: 'idle',
    ...(idleSince > 0 ? { idleSince } : {}),
    ...(terminal.watching ? { background: true } : {}),
  };
}

export interface SupervisorAttempt {
  readonly count: number;
  readonly lastAt: number;
}

/** What the supervisor remembers about one employee. Persisted, so an office restart keeps the ladder. */
export interface SupervisorHistory {
  /** Detail of the problem being worked on; empty while there is none. */
  readonly fingerprint: string;
  /** When that problem was first seen. */
  readonly since: number;
  /** When the employee was last seen to become healthy; cleared by the next problem. */
  readonly healthySince?: number;
  /** When the employee was first seen starting or between states without having become healthy since. */
  readonly transitSince?: number;
  readonly attempts: Readonly<Partial<Record<SupervisorAction, SupervisorAttempt>>>;
  /** Times of this employee's automatic rebuilds within the last day. */
  readonly rebuilds: readonly number[];
  readonly lastAction?: {
    readonly action: SupervisorAction;
    readonly at: number;
    readonly outcome: SupervisorOutcome;
    readonly detail?: string;
  };
}

/**
 * How an action ended. `issued` is what is recorded before the effect, so a crash in the middle still spent the
 * attempt. `busy` means another operation held the employee and nothing was tried: that attempt is given back.
 */
export type SupervisorOutcome = 'issued' | 'done' | 'refused' | 'failed' | 'busy';

export const EMPTY_SUPERVISOR_HISTORY: SupervisorHistory = Object.freeze({
  fingerprint: '',
  since: 0,
  attempts: Object.freeze({}),
  rebuilds: Object.freeze([]),
});

/** A history-free reading of one observation. */
export interface SupervisorClassification {
  readonly condition: SupervisorCondition;
  readonly sentence: string;
  /** The raw code or error class the condition was read from, for tooltips and logs. */
  readonly code?: string;
  /** Stable detail of the problem. Empty for conditions that are not problems. */
  readonly fingerprint: string;
  /** What only a person can do about it, when the classification alone already says so. */
  readonly needsHuman?: string;
}

export interface SupervisorNextStep {
  /** The action to take, or null when there is nothing to do right now. */
  readonly action: SupervisorAction | null;
  /** Earliest time the action may run (or the next rung is considered). */
  readonly at?: number;
  /** Why nothing is happening yet, in plain words. */
  readonly waitingFor?: string;
  /** What the driver must re-prove immediately before running the action. */
  readonly preconditions: readonly SupervisorPrecondition[];
}

export interface SupervisorAssessment {
  readonly condition: SupervisorCondition;
  readonly sentence: string;
  readonly code?: string;
  readonly fingerprint: string;
  readonly next: SupervisorNextStep;
  /** What a person or a managing agent has to do, when the supervisor will not or cannot. */
  readonly needsHuman?: string;
}

// ─── Codes ────────────────────────────────────────────────────────────────────

/**
 * How a recognized laptop code is handled:
 * - `wait`: a read that raced or an operation still running; observe again.
 * - `retry`: the same request sent again is the documented next step; a rebuild follows if that never helps.
 * - `rebuild`: the operation cannot advance; a fresh laptop is the reset.
 * - `stopped`: the laptop container is not running. One stopped laptop is rebuilt; when no other laptop of the box
 *   is running either, the host most likely restarted and the shared pool has to be recovered first.
 * - `retry-owner`: re-send while the operation offers it; otherwise the cause is outside one laptop.
 * - `provider`: the laptop runs but no agent of this employee is confirmed in it.
 * - `viewer`: the agent may be fine; the office terminal is not attached.
 * - `owner`: recognized, and once left to the owner. Each now has its own way forward (`classifyOwnerCode`); a
 *   plan move that is held by one is still not abandoned for it.
 */
export type SupervisorCodeKind =
  | 'wait'
  | 'retry'
  | 'rebuild'
  | 'stopped'
  | 'retry-owner'
  | 'provider'
  | 'viewer'
  | 'owner';

const CODES: Readonly<Record<string, readonly [SupervisorCodeKind, string]>> = {
  DOCKER_CONTINUATION_BUSY: ['wait', 'Another laptop operation for {name} is running right now.'],
  DOCKER_REPROVISION_BUSY: ['wait', 'Another laptop operation for {name} is running right now.'],
  DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING: ['wait', "{name}'s laptop set-up has not finished yet."],
  DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ: ['wait', "{name}'s laptop changed while it was being read."],
  DOCKER_CONTINUATION_UNCONFIRMED: ['wait', "The office could not read {name}'s laptop just now."],
  DOCKER_CONTINUATION_EXISTING_PROVIDER_UNCONFIRMED: [
    'wait',
    "The office could not verify the agent process in {name}'s laptop.",
  ],
  DOCKER_CONTINUATION_TARGET_CHANGED: ['wait', "{name}'s record changed while their laptop was being read."],
  DOCKER_CONTINUATION_ORIGINAL_CHANGED: ['wait', "{name}'s laptop record changed while it was being read."],
  DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED: ['wait', "{name}'s agent changed while it was being read."],
  DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED: ['wait', "{name}'s agent changed while it was being read."],
  DOCKER_CONTINUATION_OFFICE_CHANGED: ['wait', "{name}'s attendance changed while their laptop was being set up."],
  DOCKER_CONTINUATION_OFFICE_UNCONFIRMED: ['wait', "{name}'s return to the office is not recorded yet."],
  // Reads of the laptops' processes that a busy box can fail. Each read is repeated; one that never succeeds is
  // reported as stalled, like any other wait.
  DOCKER_RESOURCE_PROBE_DEADLINE: [
    'wait',
    "The office could not finish reading {name}'s laptop in time; the box is busy.",
  ],
  DOCKER_RESOURCE_INIT_UNKNOWN: ['wait', 'The office could not read the first process of a laptop just now.'],
  DOCKER_RESOURCE_INIT_CHANGED: ['wait', "A laptop's first process changed while the office was reading it."],

  DOCKER_RESOURCE_HELPER_RETRY_PENDING: [
    'retry',
    "Setting the resource limits of {name}'s laptop was interrupted by a process that ended. That is harmless.",
  ],
  DOCKER_RESOURCE_HELPER_RETRY_EXHAUSTED: [
    'retry',
    "Setting the resource limits of {name}'s laptop failed three times in a row on a busy box.",
  ],
  DOCKER_RESOURCE_HELPER_RETRY_UNCONFIRMED: [
    'retry',
    "The office could not confirm that an earlier attempt to set {name}'s laptop limits has stopped.",
  ],
  DOCKER_EPHEMERAL_PREPARATION_REQUIRED: ['retry', "{name}'s laptop scratch space still has to be prepared."],
  DOCKER_CONTINUATION_EFFECT_UNCONFIRMED: [
    'retry',
    "A step of {name}'s laptop set-up did not confirm that it finished.",
  ],

  DOCKER_RESOURCE_HELPER_FAILED: ['rebuild', "The helper that sets {name}'s laptop limits failed."],
  DOCKER_RESOURCE_WORKER_HELPER_UNACKNOWLEDGED: [
    'rebuild',
    "The helper that sets {name}'s laptop limits never confirmed them.",
  ],
  DOCKER_RESOURCE_HELPER_ATTEMPTS_SPENT: [
    'rebuild',
    "Setting the resource limits of {name}'s laptop failed as often as the office tries for one laptop.",
  ],
  DOCKER_RESOURCE_HELPER_REFUSED: ['rebuild', "The helper refused to set {name}'s laptop limits."],
  DOCKER_RESOURCE_HELPER_CLOSE_UNCONFIRMED: [
    'rebuild',
    "The helper could not confirm it released {name}'s laptop control files.",
  ],
  DOCKER_RESOURCE_HELPER_FAILURE_UNKNOWN: [
    'rebuild',
    "The helper that sets {name}'s laptop limits stopped without a reason the office recognizes.",
  ],
  DOCKER_RESOURCE_HELPER_RETRY_SCOPE_CHANGED: [
    'rebuild',
    "{name}'s laptop or its approved limits changed after the limits step failed.",
  ],
  // Both are put right in place while the laptop runs, when the read offers that; a rebuild follows only if that
  // never helps, and never while an agent is running there.
  DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED: ['rebuild', "{name}'s laptop does not show its approved resource limits."],
  DOCKER_RESOURCE_LEAF_ACK_MISSING: [
    'rebuild',
    "Nothing on record confirms the approved resource limits of {name}'s laptop any more.",
  ],
  DOCKER_CONTINUATION_START_UNCONFIRMED: ['rebuild', "{name}'s laptop was asked to start and is not running."],
  DOCKER_CONTINUATION_DESTINATION_UNCONFIRMED: ['rebuild', "{name}'s laptop container cannot be found."],
  DOCKER_CONTINUATION_DESTINATION_NOT_STOPPED: [
    'rebuild',
    "{name}'s new laptop was already running before the office started it.",
  ],
  DOCKER_CONTINUATION_DESTINATION_CHANGED: ['rebuild', "{name}'s laptop is not the container the office recorded."],
  DOCKER_CONTINUATION_CONTAINER_STOPPED: ['stopped', "{name}'s laptop container has stopped."],
  DOCKER_CONTINUATION_DESTINATION_STOPPED: ['stopped', "{name}'s laptop container has stopped."],
  DOCKER_CONTINUATION_IDENTITY_UNCONFIRMED: ['rebuild', "{name}'s laptop does not hold its office credential."],
  DOCKER_CONTINUATION_POLICY_CHANGED: [
    'rebuild',
    "{name}'s approved resource limits changed after their laptop set-up began.",
  ],
  DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED: [
    'rebuild',
    "{name}'s laptop was built from an image this office no longer uses.",
  ],
  // Read from the unused source of an employee who has no laptop record; see `classifyLaptop`.
  DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED: [
    'rebuild',
    "{name}'s laptop has never been started and was made for an earlier laptop image, so the office cannot start it.",
  ],

  // The pool's approved limits are written again in place when the read offers that. No laptop is rebuilt for it.
  DOCKER_CONTINUATION_POOL_UNCONFIRMED: [
    'retry-owner',
    'The shared resource pool that all laptops use is not confirmed.',
  ],
  DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED: [
    'retry-owner',
    'Nothing on record confirms the limits of the shared resource pool.',
  ],
  DOCKER_CONTINUATION_STORAGE_UNCONFIRMED: ['retry-owner', "{name}'s home storage could not be verified."],
  DOCKER_RESOURCE_LEAF_WRITER_IMAGE_UNAVAILABLE: [
    'retry-owner',
    'The office is configured with a limits helper image that the container engine does not have.',
  ],

  DOCKER_CONTINUATION_PROVIDER_UNCONFIRMED: ['provider', "No running agent is confirmed in {name}'s laptop."],
  DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED: [
    'viewer',
    "The office terminal could not be connected to {name}'s laptop.",
  ],

  DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED: ['owner', "{name}'s laptop has no approved resource limits."],
  DOCKER_CONTINUATION_FOREIGN_PROVIDER: [
    'owner',
    "Something the office did not start is running in {name}'s laptop terminal.",
  ],
  DOCKER_CONTINUATION_RUNTIME_CHANGED: ['owner', "The office's laptop configuration changed while it was running."],
};
/** Holds whose cause is the pool that every laptop shares. Rebuilding one laptop never settles them. */
const SHARED_POOL_CODES: ReadonlySet<string> = new Set([
  'DOCKER_CONTINUATION_POOL_UNCONFIRMED',
  'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED',
]);
/** What a laptop read offers that the supervisor's re-send performs. */
const RESENDABLE: readonly string[] = ['continue', 'retry', 'repair', 'repair-pool'];
/** Codes that say a fresh laptop is the reset. A re-send refused with one of them has nothing left to re-send. */
const FRESH_LAPTOP_KINDS: readonly (SupervisorCodeKind | undefined)[] = ['rebuild', 'stopped'];
const REPAIR_POOL_BY_HAND =
  'Put the approved limits of the shared pool back: GET …/docker-pool/status, then POST …/docker-pool/repair ' +
  '(or …/docker-pool/reconcile when the status offers that instead). No laptop is stopped.';
/** A refused local-model launch check: its code carries the reason after this prefix and its message says the rest. */
const LOCAL_MODEL_PREFIX = 'DOCKER_CONTINUATION_LOCAL_MODEL_';

const OWNER_STEPS: Readonly<Record<string, string>> = {
  DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED:
    'Approve the resource limits: PUT /api/company/employees/:id/docker-policy, then continue the laptop.',
  DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED: REPAIR_POOL_BY_HAND,
  DOCKER_CONTINUATION_POOL_UNCONFIRMED: REPAIR_POOL_BY_HAND,
  DOCKER_CONTINUATION_STORAGE_UNCONFIRMED:
    'After a host restart, approve the storage device change: POST …/docker-storage/device-approval.',
  DOCKER_RESOURCE_LEAF_WRITER_IMAGE_UNAVAILABLE:
    'Load the configured helper image or correct the office setting, then continue the laptop.',
};

export function supervisorCodeKind(code: string): SupervisorCodeKind | undefined {
  if (Object.hasOwn(CODES, code)) return CODES[code]![0];
  return code.startsWith(LOCAL_MODEL_PREFIX) && /^[A-Z_]{1,64}$/.test(code.slice(LOCAL_MODEL_PREFIX.length))
    ? 'retry-owner'
    : undefined;
}

function codeSentence(code: string, name: string, message?: string): string {
  if (Object.hasOwn(CODES, code)) return CODES[code]![1].replaceAll('{name}', name);
  return message ? clip(message, 400) : `${name}'s agent cannot start with its current model settings.`;
}

function clip(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean;
}

// ─── Plan moves ───────────────────────────────────────────────────────────────

/**
 * Why a held plan move stopped, read from its recorded error. `unrecognized` is every text this module does not
 * know: such a move is continued as often as any other (the move's own record offers that) and then abandoned.
 * The class decides only how long the office waits before it abandons, never whether it does.
 */
export type SupervisorMoveErrorClass =
  | 'sign-in'
  | 'owner-decision'
  | 'first-run'
  | 'laptop-step'
  | 'wait'
  | 'owner'
  | 'unrecognized';

export function classifyMoveError(error: string | undefined): SupervisorMoveErrorClass {
  const text = (error ?? '').trim();
  if (!text) return 'unrecognized';
  // The three sentences `describeStartupScreen` writes, and the bare composer refusal.
  if (text.includes('The office never answers a sign-in prompt')) return 'sign-in';
  if (text.includes("That choice is the owner's")) return 'owner-decision';
  if (
    text.includes('has not reached its composer yet') ||
    text.includes('which the office could not answer on its own') ||
    text === 'The existing candidate is not at its verified composer'
  )
    return 'first-run';
  if (/^DOCKER_[A-Z0-9_]{1,96}$/.test(text)) {
    const kind = supervisorCodeKind(text);
    if (kind === 'retry' || kind === 'rebuild' || kind === 'stopped' || kind === 'provider') return 'laptop-step';
    if (kind === 'wait' || kind === 'viewer') return 'wait';
    if (kind === 'owner' || kind === 'retry-owner') return 'owner';
  }
  return 'unrecognized';
}

const ACTIVE_MOVE_PHASES = new Set(['waiting', 'creating', 'starting', 'checking', 'stopping']);

/**
 * How long a held move is kept for a cause that lies outside the move, before it is abandoned like any other.
 *
 * Three causes are outside: the plan the employee is being moved to is not signed in at the office, an operation
 * that only has to finish (`wait`), and something every laptop shares (`owner`: the pool, the storage, the office's
 * own configuration). Continuing such a move again finds the same thing, and the office repairs each of them by
 * another path, so the move is given thirty minutes from the moment the problem was first seen. That covers a
 * sign-in the office places or refreshes itself and the recovery of the shared pool after a host restart. After it
 * the move is abandoned: the employee is not kept out of work for a move that cannot finish.
 */
export const SUPERVISOR_MOVE_POLICY: { readonly outsideCauseMs: number } = { outsideCauseMs: 30 * MINUTE };

// ─── Classification ───────────────────────────────────────────────────────────

const classified = (
  condition: SupervisorCondition,
  sentence: string,
  detail: { code?: string; fingerprint?: string; needsHuman?: string } = {}
): SupervisorClassification => ({
  condition,
  sentence,
  ...(detail.code ? { code: detail.code } : {}),
  fingerprint: detail.fingerprint ?? '',
  ...(detail.needsHuman ? { needsHuman: detail.needsHuman } : {}),
});

function plan(observed: SupervisorObservation): string {
  return observed.planLabel ? `the plan “${clip(observed.planLabel, 80)}”` : 'their plan';
}

function classifyMove(observed: SupervisorObservation): SupervisorClassification | undefined {
  const move = observed.move,
    name = observed.name;
  if (!move) return undefined;
  if (move.busy || ACTIVE_MOVE_PHASES.has(move.phase))
    return classified('move-in-progress', `${name} is being moved to another plan.`);
  if (move.phase !== 'recovery-required') return undefined;
  const error = clip(move.error ?? 'no reason was recorded', 300),
    fingerprint = `move:${move.id}:${error}`;
  // Every held move has the same ladder: it is continued while its record offers that, and then closed. None is
  // kept for the owner, so no class of error and no missing step ends in a sentence that asks for one.
  if (!move.docker)
    return classified(
      'move-held-retryable',
      `A plan move of ${name} from before the laptop runtime is still on record as stopped part-way: ${error}`,
      { code: 'move-retired', fingerprint }
    );
  return classified('move-held-retryable', `${name}'s plan move stopped part-way: ${error}`, {
    code: 'move-' + classifyMoveError(move.error),
    fingerprint,
  });
}

/** What a held laptop move waits for outside itself, in plain words; undefined when its cause is its own. */
function moveCauseOutside(observed: SupervisorObservation): string | undefined {
  const kind = classifyMoveError(observed.move?.error);
  if (kind === 'sign-in' && observed.planSignedIn !== true) return "the move's new plan to be signed in at the office";
  if (kind === 'wait') return 'the operation that holds the move to finish';
  if (kind === 'owner') return 'the repair of what holds the move, which every laptop shares';
  return undefined;
}

function moveCauseOverdue(history: SupervisorHistory, now: number): boolean {
  return history.since > 0 && now - history.since >= SUPERVISOR_MOVE_POLICY.outsideCauseMs;
}

/** The wait for a cause outside the move. It ends by itself when the move is closed for it after all. */
function outsideCauseWait(waitingFor: string, history: SupervisorHistory): Gate {
  return history.since > 0
    ? { kind: 'wait', waitingFor, at: history.since + SUPERVISOR_MOVE_POLICY.outsideCauseMs }
    : { kind: 'wait', waitingFor };
}

/**
 * A sign-in the office put into this employee's laptop is still settling: the step is running, or it ended less
 * than its own watch time ago. A move is not closed in that window, because the continue that follows a placed
 * sign-in is what finishes it.
 */
function signInBeingPlaced(history: SupervisorHistory, now: number, policy: SupervisorPolicy): boolean {
  const last = history.lastAction;
  if (!last || last.action !== 'replace-sign-in') return false;
  if (last.outcome === 'issued') return true;
  return last.outcome === 'done' && now - last.at < policy.ladder['replace-sign-in'].escalateAfterMs;
}

/**
 * Continue: only a laptop move, and only while its record offers it. A move that waits at the sign-in screen of a
 * plan the office does not report signed in is not continued: the continue would read the same screen and spend an
 * attempt. It is waited for instead, for `SUPERVISOR_MOVE_POLICY.outsideCauseMs`, and continued at once when the
 * plan becomes signed in. After that time the rung steps aside and the move is closed.
 */
function continueMoveGate(observed: SupervisorObservation, history: SupervisorHistory, now: number): Gate {
  const move = observed.move;
  if (!move?.docker || !move.allowedActions.includes('continue-original')) return { kind: 'skip' };
  const outside = classifyMoveError(move.error) === 'sign-in' ? moveCauseOutside(observed) : undefined;
  if (!outside) return { kind: 'ok' };
  return moveCauseOverdue(history, now) ? { kind: 'skip' } : outsideCauseWait(outside, history);
}

/**
 * Close the move: abandon a laptop move, or settle one of the retired runtime. Nothing about the error decides
 * whether, only when. A move whose cause is outside itself is given `SUPERVISOR_MOVE_POLICY.outsideCauseMs` first,
 * and no move is closed while a sign-in the office placed for it is settling. What the record offers is not asked
 * here: the service that closes the move decides that itself and refuses in its own words, and a refusal spends
 * one of the rung's few attempts.
 */
function abandonMoveGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy
): Gate {
  if (!observed.move) return { kind: 'skip' };
  if (!observed.move.docker) return { kind: 'ok' };
  if (signInBeingPlaced(history, now, policy))
    return { kind: 'wait', waitingFor: 'the sign-in the office placed to take effect' };
  const outside = moveCauseOutside(observed);
  return outside && !moveCauseOverdue(history, now) ? outsideCauseWait(outside, history) : { kind: 'ok' };
}

const POLICY_REQUIRED = 'DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED';
const RUNTIME_CHANGED = 'DOCKER_CONTINUATION_RUNTIME_CHANGED';
const NO_POLICY = 'no-policy';
const NO_LAPTOP = 'no-laptop';
const NOT_BOXED = 'not-boxed';

/**
 * The three codes that were once left to the owner.
 * - No approved limits: the limits step gives the employee the owner's standing default (`SUPERVISOR_LIMITS_PATH`).
 * - Something the office did not start runs in the laptop terminal: the office cannot adopt it, so the laptop is
 *   held until it is rebuilt, between that process's turns like any other laptop an agent runs in.
 * - The office's laptop configuration changed under it: no laptop is at fault and no laptop step helps. The office
 *   restarts itself (`office-self-restart.ts`); for the employee this is a wait, and it is never called stalled.
 */
function classifyOwnerCode(code: string, sentence: string): SupervisorClassification {
  const fingerprint = 'code:' + code;
  if (code === POLICY_REQUIRED) return classified('laptop-not-started', sentence, { code, fingerprint });
  if (code === RUNTIME_CHANGED)
    return classified('starting', `${sentence} The office restarts itself to read it again.`, { code });
  return classified(
    'held-needs-rebuild',
    `${sentence} The office cannot take it over, so the laptop is rebuilt once nothing in it is in the middle of a turn.`,
    { code, fingerprint }
  );
}

function classifyCode(
  observed: SupervisorObservation,
  code: string,
  message?: string,
  providerExit?: string
): SupervisorClassification {
  const name = observed.name,
    kind = supervisorCodeKind(code),
    fingerprint = 'code:' + code;
  // Watched first, then treated as a hold that a rebuild settles: see `unrecognizedCode` and `rebuildGate`.
  if (!kind)
    return classified(
      'held-needs-rebuild',
      `${name}'s laptop reports ${clip(code, 96)}, which the office does not recognize.`,
      { code, fingerprint }
    );
  const sentence = codeSentence(code, name, message);
  if (kind === 'wait') return classified('starting', sentence, { code });
  if (kind === 'viewer') return classified('viewer-lost', sentence, { code, fingerprint });
  if (kind === 'provider')
    return classified(
      'provider-exited',
      providerExit ? `${name}'s agent is not running in their laptop. ${clip(providerExit, 400)}` : sentence,
      { code, fingerprint }
    );
  if (kind === 'owner') return classifyOwnerCode(code, sentence);
  if (kind === 'stopped' && observed.laptop.poolAlive !== true)
    return classified('needs-owner', `${sentence} No other laptop of this office is running either.`, {
      code,
      fingerprint,
      needsHuman:
        'After a host restart, recover the shared pool first: GET …/docker-pool/cold-preview, then POST ' +
        '…/docker-pool/cold-recover. Then rebuild this laptop.',
    });
  if (kind === 'retry-owner') {
    const offered = observed.laptop.continuation?.allowedActions.some((action) => RESENDABLE.includes(action));
    return offered
      ? classified('held-retryable', sentence, { code, fingerprint })
      : classified('needs-owner', sentence, {
          code,
          fingerprint,
          needsHuman: OWNER_STEPS[code] ?? 'Repair what the sentence names, then continue the laptop.',
        });
  }
  return classified(kind === 'retry' ? 'held-retryable' : 'held-needs-rebuild', sentence, { code, fingerprint });
}

/**
 * The one state the office cannot leave by itself. Every laptop operation it has makes a laptop from the record of
 * an earlier one: that record fixes where the employee's home directory is, and the employee's own office network
 * is made by the host set-up. An employee with neither a laptop nor any record of one has nothing to build from.
 * The office goes on reading, and starts a stopped laptop of this employee as soon as one exists.
 */
const NO_FIRST_LAPTOP =
  'This employee has never had a laptop in this office, and the office has no operation that makes a first one: ' +
  'every laptop is made from the record of an earlier one. Create the first laptop once with the host set-up; the ' +
  'office starts it by itself as soon as it exists.';

function classifyLaptop(observed: SupervisorObservation): SupervisorClassification {
  const { laptop, session, name } = observed;
  if (laptop.rebuildPending)
    return classified('held-needs-rebuild', `${name}'s laptop rebuild was started and has not finished.`, {
      code: 'rebuild-pending',
      fingerprint: 'rebuild-pending',
    });
  if (!laptop.record) {
    // The limits step gives them the owner's standing default; see `SUPERVISOR_LIMITS_PATH`.
    if (!laptop.policyApproved)
      return classified('laptop-not-started', `${name} has no laptop and no approved resource limits.`, {
        code: NO_POLICY,
        fingerprint: NO_POLICY,
      });
    if (laptop.source === 'stopped')
      return classified('laptop-not-started', `${name} has a fresh laptop that has not been started yet.`, {
        code: 'source-stopped',
        fingerprint: 'source-stopped',
      });
    // An unused laptop holds nothing, so replacing it loses nothing: the rebuild rung takes it, under the same
    // switch, limits and proofs as every other rebuild. With repairs switched off the owner is told the calls.
    if (laptop.source === 'outdated') return classifyCode(observed, 'DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED');
    const missing = `${name} has no laptop record, and the office found no laptop to start from.`;
    // An earlier laptop operation of this employee is on record, and the rebuild makes a laptop from that record.
    if (laptop.templateOnRecord)
      return classified('held-needs-rebuild', missing, { code: NO_LAPTOP, fingerprint: NO_LAPTOP });
    return classified('unknown', missing, { code: NO_LAPTOP, fingerprint: NO_LAPTOP, needsHuman: NO_FIRST_LAPTOP });
  }
  const seen = laptop.continuation;
  if (seen?.state === 'held' && seen.code) return classifyCode(observed, seen.code, seen.message, seen.providerExit);
  if (seen?.state === 'pending') {
    // A step that is issued settles by observation. A step that only waits to be issued needs the request again.
    return seen.allowedActions.includes('continue')
      ? classified('held-retryable', `${name}'s laptop set-up stopped before the step after “${seen.phase}”.`, {
          code: 'pending:' + seen.phase,
          fingerprint: 'pending:' + seen.phase,
        })
      : classified('starting', `${name}'s laptop is being set up (${seen.phase}).`);
  }
  if (laptop.restoration?.state === 'held' && seen?.state !== 'ready')
    return classifyCode(observed, laptop.restoration.code);
  // Without a fresh read, a record whose agent launch was issued counts as published, as it does for the laptop
  // runtime's own attach: an employee whose terminal is attached is not read just to move that record on.
  const ready = seen ? seen.state === 'ready' : ['ready', 'provider-issued'].includes(laptop.record.phase);
  if (!ready) return classified('starting', `${name}'s laptop is being set up (${laptop.record.phase}).`);
  if (session.providerHealth === 'dead')
    return classified('provider-exited', `${name}'s agent has exited inside their laptop.`, {
      code: 'provider-dead',
      fingerprint: 'provider-dead',
    });
  const attached = laptop.restoration?.state === 'attached';
  if (session.available && session.viewerHealth !== 'disconnected' && (attached || !laptop.restoration))
    return classified('healthy', `${name} is running.`);
  if (laptop.restoration?.state === 'held') return classifyCode(observed, laptop.restoration.code);
  return classified('viewer-lost', `${name}'s agent is running, but the office terminal is not connected to it.`, {
    code: 'viewer-disconnected',
    fingerprint: 'viewer-disconnected',
  });
}

/** One observation, one condition. Reads no history and no clock. */
export function classifyEmployee(observed: SupervisorObservation): SupervisorClassification {
  const name = observed.name;
  if (observed.onVacation || observed.desiredRunning !== true)
    return classified(
      'owner-stopped',
      `${name} is ${observed.onVacation ? 'out of the office' : 'stopped'} by choice.`
    );
  if (observed.bindingMigration) return classified('move-in-progress', `${name} is being moved to another session.`);
  const move = classifyMove(observed);
  if (move) return move;
  const screen = observed.session.startupScreen;
  if (screen) {
    const fingerprint = 'screen:' + screen.label;
    if (screen.kind === 'credential')
      return classified('needs-sign-in', `${name} is waiting at ${screen.label}.`, {
        code: 'sign-in-screen',
        fingerprint,
        needsHuman:
          observed.planSignedIn === true
            ? `${plan(observed)} is signed in at the office, but this laptop's own sign-in folder does not have it. ` +
              'Sign in inside the laptop terminal, or rebuild the laptop so it is created with that plan.'
            : `Sign in ${plan(observed)} at the office (Plans), or in the laptop terminal. The office never answers a sign-in prompt.`,
      });
    if (screen.kind === 'decision')
      return classified('needs-owner', `${name} is waiting at ${screen.label}.`, {
        code: 'decision-screen',
        fingerprint,
        needsHuman: "That choice is the owner's. Answer it in the session's terminal.",
      });
    if (screen.answering)
      return classified('waiting-first-run-screen', `${name} is starting: the office is answering ${screen.label}.`);
    return classified('needs-owner', `${name} is stuck at ${screen.label}, which the office could not answer.`, {
      code: 'first-run-screen',
      fingerprint,
      needsHuman: "Answer it in the session's terminal.",
    });
  }
  if (!observed.boxed) {
    const { session } = observed;
    if (session.available && session.runtimeHealth !== 'dead' && session.runtimeHealth !== 'disconnected')
      return classified('healthy', `${name} is running.`);
    // No laptop step applies to a session outside a laptop. The office wakes it, as the owner's Wake does.
    return classified(
      'viewer-lost',
      `${name} is not connected. Their session is not in a laptop, so the office wakes it.`,
      {
        code: NOT_BOXED,
        fingerprint: NOT_BOXED,
      }
    );
  }
  const laptop = classifyLaptop(observed);
  // What decides the repair is said first. The code and the problem's clock stay those of the lost terminal.
  return terminalHeldForGood(observed, laptop.condition)
    ? {
        ...laptop,
        sentence:
          `The office can no longer type into ${name}'s terminal, so the laptop has to be rebuilt once the agent's ` +
          'current turn has ended.',
      }
    : laptop;
}

/**
 * A lost terminal whose input is also held for good. No reconnect gives such a terminal back: the hold is evidence
 * of an input that may have been sent, every attach is refused while it stands, and only a new laptop ends it.
 * A held input beside any other condition changes nothing: that condition keeps its own path and rules.
 */
function terminalHeldForGood(observed: SupervisorObservation, condition: SupervisorCondition): boolean {
  return condition === 'viewer-lost' && observed.boxed && observed.session.inputHeld === true;
}

// ─── Ladder ───────────────────────────────────────────────────────────────────

/**
 * The rungs each base condition may climb, in order. A condition that is not listed has no automatic step here;
 * `ladderPath` adds the paths that depend on more than the condition.
 */
export const SUPERVISOR_PATHS: Readonly<Partial<Record<SupervisorCondition, readonly SupervisorAction[]>>> = {
  'viewer-lost': ['reconnect-viewer'],
  'needs-sign-in': ['replace-sign-in'],
  'provider-exited': ['relaunch-provider', 'rebuild-laptop'],
  'held-retryable': ['resend-continuation', 'rebuild-laptop'],
  'held-needs-rebuild': ['resend-continuation', 'rebuild-laptop'],
  'laptop-not-started': ['start-continuation'],
  'move-held-retryable': ['continue-move', 'abandon-move'],
};

/**
 * The path of a lost terminal whose input is also held for good (`terminalHeldForGood`). A lost terminal that
 * still takes input keeps the path above and is never rebuilt for it.
 */
export const SUPERVISOR_HELD_INPUT_PATH: readonly SupervisorAction[] = ['reconnect-viewer', 'rebuild-laptop'];

/**
 * The path of an employee who has no approved resource limits (`no-policy`, or a set-up that reports the same).
 * One step gives them the owner's standing default; the laptop is started from the reading that follows.
 */
export const SUPERVISOR_LIMITS_PATH: readonly SupervisorAction[] = ['apply-standing-limits'];

/**
 * The path of a laptop that has been starting, or between two states, for `stalledAfterMs` without becoming
 * healthy. A wait that does not end is a hold: the recorded request is sent again when the laptop offers that, and
 * the rebuild follows under its usual rules.
 */
export const SUPERVISOR_STALLED_PATH: readonly SupervisorAction[] = ['resend-continuation', 'rebuild-laptop'];

const DAY = 24 * 60 * MINUTE;

type Gate =
  | { readonly kind: 'ok'; readonly preconditions?: readonly SupervisorPrecondition[] }
  | { readonly kind: 'skip' }
  /** `at`: when the wait ends by itself, where that is known. */
  | { readonly kind: 'wait'; readonly waitingFor: string; readonly at?: number }
  | { readonly kind: 'human'; readonly needsHuman: string };

/** A time as a sentence names it. A sentence built with one stays the same for as long as that time holds. */
function when(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** The owner's own switch for the two standing defaults. Naming it is the only refusal the office gives here. */
const STANDING_OFF = 'The standing defaults are switched off (company setting supervisorStandingDefaults).';

const REBUILD_BY_HAND =
  'Rebuild the laptop: POST /api/company/employees/:id/docker-rebuild/preview, then /apply, then continue it.';
/** The same calls for a laptop whose agent is still running, as it is while only the terminal's input is held. */
const REBUILD_RUNNING_CALLS =
  'POST /api/company/employees/:id/docker-rebuild/preview, then /apply with confirmDiscardRunning (that ends ' +
  'whatever the agent is doing), then continue it.';
const REBUILD_RUNNING_BY_HAND = 'Rebuild the laptop: ' + REBUILD_RUNNING_CALLS;

/**
 * The layout a rebuild uses. An employee's own is the one the owner approved for their most recent laptop
 * operation. One who has none is given the owner's standing default: what every laptop of the office that has a
 * layout shares (`standing.layout`). Two cases are left: the owner switched the standing defaults off, which is
 * named, and an office in which no laptop has a layout at all, so that there is nothing approved to build with.
 */
function layoutGate(observed: SupervisorObservation, byHand: string): Gate | undefined {
  const { templateOnRecord, standing } = observed.laptop;
  if (templateOnRecord || (standing?.enabled && standing.layout)) return undefined;
  if (standing && !standing.enabled)
    return { kind: 'human', needsHuman: `No laptop layout is on record for this employee. ${STANDING_OFF} ${byHand}` };
  return {
    kind: 'human',
    needsHuman:
      'No owner-approved laptop layout is on record for this employee, and no other laptop of this office has one ' +
      `the office could build with. ${byHand}`,
  };
}

/**
 * The two limits every automatic rebuild keeps, whatever its reason. Undefined when both allow one. The limit per
 * day is a pause and not an end: it says when the next rebuild may run, and the ladder goes on from there.
 */
function rebuildLimit(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy,
  byHand: string
): Gate | undefined {
  const layout = layoutGate(observed, byHand);
  if (layout) return layout;
  const today = history.rebuilds.filter((at) => now - at < DAY);
  if (today.length < policy.rebuildsPerDay) return undefined;
  const at = today[today.length - policy.rebuildsPerDay]! + DAY;
  return {
    kind: 'wait',
    waitingFor:
      `the daily limit on rebuilds of one laptop (${policy.rebuildsPerDay}): the earlier ones did not hold, and ` +
      `the next one may run at ${when(at)}`,
    at,
  };
}

/** What the office waits for before it rebuilds a laptop an agent may run in, by what the pane shows. */
const HELD_INPUT_WAIT: Readonly<Record<SupervisorTurn, string>> = {
  working: "the agent's current turn to end",
  idle: "the agent's terminal to stay quiet a little longer",
  unknown: "a reading of the agent's terminal",
};

const HELD_INPUT_BACKGROUND_WAIT = 'the work the agent left running to finish';

/** A laptop code the office does not recognize is what holds this employee. */
function unrecognizedCode(base: Pick<SupervisorClassification, 'code' | 'fingerprint'>): boolean {
  return !!base.code && base.fingerprint === 'code:' + base.code && supervisorCodeKind(base.code) === undefined;
}

/** The laptop's own read still says it is held or unfinished. Asked to be proved again by the step. */
function laptopHeld(observed: SupervisorObservation): readonly SupervisorPrecondition[] {
  const seen = observed.laptop.continuation;
  return seen && seen.state !== 'ready' ? ['laptop-held'] : [];
}

/**
 * The rebuild of a laptop that an agent may run in. It is the rule that was made for a terminal whose input is
 * held for good, and it serves every laptop that only a rebuild settles: the home directory and the conversation
 * saved in it are kept, so what a rebuild can cost is the turn in progress, and that is what is never given up.
 *
 * - The pane is seen idle and has been silent for `heldInputIdleMs`: the laptop is rebuilt (`proof`).
 * - A turn is in progress: it is waited for, however long it takes.
 * - The agent ended its turn with work left running: that is waited for until `heldInputTurnMs` after the problem
 *   was first seen, and then the idle laptop is rebuilt with it.
 * - The office is not reading the pane. `unknown` is never treated as idle. A read made inside the laptop is asked
 *   first, and a laptop it shows to be empty is rebuilt at once. Otherwise the laptop is rebuilt `blindRebuildMs`
 *   after the problem was first seen (`agent-unreadable`): see `SUPERVISOR_POLICY` for why that long. The wait
 *   says when.
 *
 * The step proves the pane again itself, and confirms the discard only for the one recorded laptop
 * (`DockerSupervisorLaptops.rebuild`).
 */
function betweenTurnsGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy,
  proof: readonly SupervisorPrecondition[]
): Gate {
  const { turn = 'unknown', idleSince, background } = observed.session;
  const overdue = history.since > 0 && now - history.since >= policy.heldInputTurnMs;
  const quiet = turn === 'idle' && idleSince !== undefined && now - idleSince >= policy.heldInputIdleMs;
  if (quiet && (!background || overdue)) return { kind: 'ok', preconditions: proof };
  if (quiet)
    return { kind: 'wait', waitingFor: HELD_INPUT_BACKGROUND_WAIT, at: history.since + policy.heldInputTurnMs };
  if (turn === 'working' || (turn === 'idle' && idleSince !== undefined))
    return { kind: 'wait', waitingFor: HELD_INPUT_WAIT[turn] };
  // A laptop that this read shows to be empty never comes here: `rebuildGate` decides for it.
  if (observed.laptop.provider === undefined) return { kind: 'ok', preconditions: ['no-agent-running'] };
  const at = history.since + policy.blindRebuildMs;
  if (history.since > 0 && now >= at)
    return {
      kind: 'ok',
      preconditions: [...proof.filter((name) => name !== 'agent-between-turns'), 'agent-unreadable'],
    };
  return {
    kind: 'wait',
    waitingFor: `${HELD_INPUT_WAIT.unknown}; if there is still none, the laptop is rebuilt at ${when(at)}`,
    at,
  };
}

/**
 * A lost terminal whose input is held for good (`terminalHeldForGood`): the office can never type to that agent
 * again, so once its turn has ended, keeping it gains nothing, and a rebuild keeps its home directory and the
 * conversation saved in it. It was the first laptop to be rebuilt while its agent runs; the rule is
 * `betweenTurnsGate`, with the hold as what the step proves again.
 *
 * What runs in the laptop is asked only while the office cannot read the pane. A laptop that this read shows to be
 * empty has nothing to lose, and the rules of an empty laptop decide for it (`rebuildGate`).
 */
function heldInputRebuildGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  _flags: SupervisorFlags,
  now: number,
  policy: SupervisorPolicy
): Gate {
  const { turn = 'unknown', idleSince } = observed.session,
    provider = observed.laptop.provider;
  const unread = turn === 'unknown' || (turn === 'idle' && idleSince === undefined);
  if (unread && provider !== undefined && provider !== 'running' && provider !== 'unknown')
    return rebuildGate(observed, history, now, policy);
  const limit = rebuildLimit(observed, history, now, policy, REBUILD_RUNNING_BY_HAND);
  if (limit) return limit;
  return betweenTurnsGate(observed, history, now, policy, ['terminal-input-held']);
}

/**
 * A laptop that nothing runs in is rebuilt as soon as a fresh read says so: its agent exited, was never started, or
 * the laptop is stopped or gone. Nothing can be lost with it.
 *
 * A laptop an agent runs in is rebuilt between that agent's turns (`betweenTurnsGate`), never in the middle of
 * one. `unknown`, a read that could not say what runs there, is never treated as absence: it is asked again until
 * the problem has stood for `stalledAfterMs`, and from then on the laptop is treated as one an agent runs in.
 *
 * A code the office does not recognize (`base`) is watched for `unrecognizedAfterMs` before any of this.
 */
function rebuildGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy,
  base?: Pick<SupervisorClassification, 'code' | 'fingerprint'>
): Gate {
  const limit = rebuildLimit(observed, history, now, policy, REBUILD_BY_HAND);
  if (limit) return limit;
  const settles = history.since + policy.unrecognizedAfterMs;
  if (base && unrecognizedCode(base) && now < settles)
    return {
      kind: 'wait',
      waitingFor: `the code to clear by itself; if it still stands, the laptop is treated as held at ${when(settles)}`,
      at: settles,
    };
  const provider = observed.laptop.provider;
  if (provider === 'unknown' && !(history.since > 0 && now - history.since >= policy.stalledAfterMs))
    return { kind: 'wait', waitingFor: 'a confirmed read of what is running in the laptop' };
  if (provider === 'running' || provider === 'unknown')
    return betweenTurnsGate(observed, history, now, policy, ['agent-between-turns', ...laptopHeld(observed)]);
  // No laptop of this employee runs, and no other laptop of the box does either: that is what a host restart
  // looks like, and then the shared pool has to be recovered before any laptop is built.
  if (provider === 'no-laptop' && observed.laptop.poolAlive === false)
    return {
      kind: 'human',
      needsHuman:
        'No laptop of this office is running. After a host restart, recover the shared pool first: GET ' +
        '…/docker-pool/cold-preview, then POST …/docker-pool/cold-recover. ' +
        REBUILD_BY_HAND,
    };
  return { kind: 'ok', preconditions: provider === undefined ? ['no-agent-running'] : [] };
}

/**
 * The request sent again was already answered for good.
 *
 * `continue` says the record has a step it has not issued yet. It does not say the laptop's hold stands in front of
 * that step: a request whose image, limits or container no longer match is refused before anything is issued, and
 * the read goes on offering `continue`. One re-send finds out. Once the service has refused it with a code that
 * only a fresh laptop settles, the same request is not sent for that hold again and the next rung is considered at
 * once. `retry`, `repair` and `repair-pool` are offered for the hold itself and keep their attempts.
 *
 * The refusal counts while it belongs to this episode and to this problem: it is the hold the laptop shows now, or
 * it was given since this problem was first seen.
 */
function resendAnswered(offered: readonly string[], code: string | undefined, history: SupervisorHistory): boolean {
  const last = history.lastAction;
  if (!last || last.action !== 'resend-continuation' || last.outcome !== 'refused' || !last.detail) return false;
  if (!offered.every((name) => name === 'continue')) return false;
  if (history.attempts['resend-continuation']?.lastAt !== last.at) return false;
  if (!FRESH_LAPTOP_KINDS.includes(supervisorCodeKind(last.detail))) return false;
  return last.detail === code || last.at >= history.since;
}

/**
 * The reconnect of a terminal whose input is held for good was already answered for good.
 *
 * Every attach of such a terminal is refused, whatever the laptop's health, so the six nudges and their backoff
 * would only keep the employee out of reach. One refusal for this problem is the answer: the nudge is not repeated
 * and the next rung is considered at once. A rebuild that was tried for this problem says the same, because it is
 * only reached past this rung; without that, a rebuild that was refused would send the ladder back to a nudge.
 */
function reconnectAnswered(history: SupervisorHistory): boolean {
  const last = history.lastAction;
  if (!last || last.at < history.since) return false;
  if (last.action === 'rebuild-laptop') return true;
  return (
    last.action === 'reconnect-viewer' &&
    last.outcome === 'refused' &&
    history.attempts['reconnect-viewer']?.lastAt === last.at
  );
}

function gate(
  action: SupervisorAction,
  observed: SupervisorObservation,
  history: SupervisorHistory,
  flags: SupervisorFlags,
  now: number,
  policy: SupervisorPolicy,
  /** `terminalHeldForGood` for this observation. */
  heldInput = false,
  /** What this observation was classified as, for the rules that depend on its code. */
  base?: Pick<SupervisorClassification, 'code' | 'fingerprint'>
): Gate {
  const seen = observed.laptop.continuation;
  switch (action) {
    case 'resend-continuation': {
      // Offered by the operation itself, and never for a plan move's private record.
      const offered = seen?.allowedActions.filter((name) => RESENDABLE.includes(name)) ?? [];
      return observed.laptop.record &&
        observed.laptop.record.version !== 3 &&
        offered.length &&
        !resendAnswered(offered, seen?.code, history)
        ? { kind: 'ok' }
        : { kind: 'skip' };
    }
    case 'apply-standing-limits': {
      // The owner's standing default is the most restrictive limits approved for the other employees
      // (docker-standing-defaults.ts). The office never makes up a number: with none approved anywhere it has
      // nothing to give, and that, like the owner's switch, is said.
      const standing = observed.laptop.standing;
      if (observed.laptop.policyApproved) return { kind: 'skip' };
      if (standing?.enabled && standing.limits) return { kind: 'ok' };
      return {
        kind: 'human',
        needsHuman:
          standing && !standing.enabled
            ? `${STANDING_OFF} ${OWNER_STEPS[POLICY_REQUIRED]}`
            : `No employee of this office has approved resource limits, so the office has no approved value to give this one. ${OWNER_STEPS[POLICY_REQUIRED]}`,
      };
    }
    case 'start-continuation':
      return observed.laptop.source === 'stopped' && observed.laptop.policyApproved
        ? { kind: 'ok' }
        : { kind: 'wait', waitingFor: 'a stopped laptop source and approved resource limits' };
    case 'continue-move':
      return continueMoveGate(observed, history, now);
    case 'reconnect-viewer':
      // A session outside a laptop has no laptop record to judge by: the wake itself decides.
      if (!observed.boxed) return { kind: 'ok' };
      return observed.laptop.record &&
        ['ready', 'provider-issued'].includes(observed.laptop.record.phase) &&
        !(heldInput && reconnectAnswered(history))
        ? { kind: 'ok' }
        : { kind: 'skip' };
    case 'replace-sign-in':
      // Only for a laptop parked on the provider's own sign-in screen. A plan move that waits for a sign-in keeps
      // its own record, and a supervisor that is switched off describes the screen as it always did.
      return flags.enabled &&
        flags.signInRepairAvailable === true &&
        observed.boxed &&
        !observed.move &&
        observed.session.startupScreen?.kind === 'credential'
        ? { kind: 'ok' }
        : { kind: 'skip' };
    case 'relaunch-provider':
      return flags.relaunchAvailable && observed.laptop.record?.version !== 3 ? { kind: 'ok' } : { kind: 'skip' };
    case 'abandon-move':
      return abandonMoveGate(observed, history, now, policy);
    case 'rebuild-laptop':
      // A new laptop would join the same pool and be held by the same thing.
      if (seen?.code && SHARED_POOL_CODES.has(seen.code)) return { kind: 'human', needsHuman: REPAIR_POOL_BY_HAND };
      return heldInput
        ? heldInputRebuildGate(observed, history, flags, now, policy)
        : rebuildGate(observed, history, now, policy, base);
  }
}

const TIER_OFF: Readonly<Record<SupervisorTier, string>> = {
  retry: 'Automatic retries are switched off (company setting supervisorEnabled).',
  repair: 'Automatic repairs are switched off (company setting supervisorAutoRepair).',
};

const BY_HAND: Readonly<Record<SupervisorAction, string>> = {
  'resend-continuation':
    'Continue the laptop: POST /api/company/employees/:id/docker-continuation with its original request.',
  'apply-standing-limits': OWNER_STEPS[POLICY_REQUIRED]!,
  'start-continuation': 'Start the laptop: GET …/docker-policy, then POST …/docker-continuation.',
  'continue-move': 'Continue the move: POST /api/plans/moves/:id/resolve with action continue-original.',
  'reconnect-viewer': 'Reconnect the terminal from the employee card, or wake the employee.',
  'replace-sign-in': 'Sign the plan in at the office (Plans), or in the laptop terminal.',
  'relaunch-provider': 'Restart the agent in its laptop.',
  'abandon-move': 'Abandon the move: POST /api/plans/moves/:id/abandon, then rebuild the laptop.',
  'rebuild-laptop': REBUILD_BY_HAND,
};

/**
 * When the ladder starts again: `ladderRestartMs` after the newest attempt of any rung. At that time
 * `rollSupervisorHistory` clears the attempt counts, whatever the path and whatever stopped it, so no ladder ends
 * for good. Undefined while no attempt is counted. The limit on rebuilds per day is kept across rounds.
 */
export function ladderRestartAt(
  history: Pick<SupervisorHistory, 'attempts'>,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): number | undefined {
  const times = Object.values(history.attempts).map((attempt) => attempt.lastAt);
  return times.length ? Math.max(...times) + policy.ladderRestartMs : undefined;
}

/** What an employee waits for while the office's laptop configuration is no longer the one it started with. */
const OFFICE_RESTART_WAIT = 'the office to restart itself and read its laptop configuration again';

/** The rungs one observation may climb. A condition with none has no automatic step. */
function ladderPath(base: SupervisorClassification, heldInput: boolean, stalled: boolean): readonly SupervisorAction[] {
  if (heldInput) return SUPERVISOR_HELD_INPUT_PATH;
  if (base.code === NO_POLICY || base.code === POLICY_REQUIRED) return SUPERVISOR_LIMITS_PATH;
  // The wait for the office's own restart is no laptop's fault, and a start-up screen has its own steps.
  if (stalled && base.condition === 'starting' && base.code !== RUNTIME_CHANGED) return SUPERVISOR_STALLED_PATH;
  return SUPERVISOR_PATHS[base.condition] ?? [];
}

/**
 * The office put the plan's sign-in back and the agent still shows the sign-in screen. The office has no way to
 * start an agent again inside a running laptop, so what is left is the owner's rebuild, named call by call.
 */
const SIGN_IN_PLACED =
  "The office put the plan's sign-in back into this laptop, and the agent is still at the sign-in screen. It has to " +
  'be started again, which the office can only do by rebuilding the laptop: POST ' +
  '/api/company/employees/:id/docker-rebuild/preview, then POST …/docker-rebuild/apply with the scope digest that ' +
  'preview returned (and confirmDiscardRunning while the preview lists a running laptop: an agent at a sign-in ' +
  'screen has no conversation in progress), then continue it.';

/** The condition a base condition is reported as once its ladder has reached a given rung. */
function reported(base: SupervisorCondition, rung: SupervisorAction | undefined): SupervisorCondition {
  if (base === 'move-held-retryable' && rung === 'abandon-move') return 'move-held-dead-end';
  if (base === 'held-retryable' && rung === 'rebuild-laptop') return 'held-needs-rebuild';
  // A laptop that never finished starting is held once its ladder has reached the rebuild.
  if (base === 'starting' && rung === 'rebuild-laptop') return 'held-needs-rebuild';
  return base;
}

const BUSY: Readonly<Record<SupervisorBusy, string>> = {
  'continuation-flight': 'a laptop set-up step that is running',
  'laptop-operation': 'another laptop operation that is running',
  'owner-stop-pending': 'an owner stop that the laptop has not confirmed',
  'recovery-pending': 'an owner recovery operation that is open',
  'lifecycle-in-progress': 'a start or stop of the session that is running',
  'publication-unconfirmed': 'the office to confirm its last saved record',
};

function backoff(rung: SupervisorRung, count: number): number {
  return rung.backoffMs[Math.min(count, rung.backoffMs.length) - 1] ?? 0;
}

/**
 * The whole decision for one employee: its condition, sentence and the single next step.
 *
 * At most one action is returned. An action is returned only when its rung has attempts left, its tier is switched
 * on, nothing else is working on the employee and its own gate passes; `next.at` says when it may run.
 *
 * A ladder whose rungs are all used does not end. `next.at` then says when it starts again (`ladderRestartAt`), and
 * a limit that pauses a step says when it lifts.
 */
export function assessEmployee(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  flags: SupervisorFlags,
  now: number,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): SupervisorAssessment {
  const base = classifyEmployee(observed),
    heldInput = terminalHeldForGood(observed, base.condition);
  // A laptop that has been starting or between states for too long. Its ladder counts from that moment.
  const stalledFrom =
      (base.condition === 'starting' || base.condition === 'waiting-first-run-screen') &&
      history.transitSince !== undefined
        ? history.transitSince + policy.stalledAfterMs
        : undefined,
    stalled = stalledFrom !== undefined && now >= stalledFrom,
    path = ladderPath(base, heldInput, stalled && observed.boxed),
    clock = path === SUPERVISOR_STALLED_PATH ? { ...history, since: stalledFrom! } : history;
  const result = (
    next: SupervisorNextStep,
    rung?: SupervisorAction,
    // `null`: nobody is asked for anything, whatever the classification alone would say.
    needsHuman: string | null | undefined = base.needsHuman
  ): SupervisorAssessment => ({
    condition: reported(base.condition, rung),
    sentence: base.sentence,
    ...(base.code ? { code: base.code } : {}),
    fingerprint: base.fingerprint,
    next,
    ...(needsHuman ? { needsHuman } : {}),
  });
  const idle = (waitingFor?: string, at?: number): SupervisorNextStep => ({
    action: null,
    ...(at === undefined ? {} : { at }),
    ...(waitingFor ? { waitingFor } : {}),
    preconditions: [],
  });
  if (!path.length) {
    if (base.code === RUNTIME_CHANGED) return result(idle(OFFICE_RESTART_WAIT));
    return result(
      idle(),
      undefined,
      stalled
        ? 'This has not changed for a while. Read the laptop: GET /api/company/employees/:id/docker-policy.'
        : base.needsHuman
    );
  }
  // A sign-in the office is putting back itself asks nobody for anything, until an attempt found none to place.
  const last = history.lastAction;
  const placing = (action: SupervisorAction): null | undefined =>
    action === 'replace-sign-in' && !(last?.action === action && ['refused', 'failed'].includes(last.outcome))
      ? null
      : undefined;
  for (const action of path) {
    const rung = policy.ladder[action],
      tried = history.attempts[action] ?? { count: 0, lastAt: 0 },
      allowed = gate(action, observed, clock, flags, now, policy, heldInput, base);
    if (allowed.kind === 'skip') continue;
    if (tried.count >= rung.maxAttempts) {
      const settles = tried.lastAt + rung.escalateAfterMs;
      if (now < settles) return result(idle('the outcome of the last attempt', settles), action, placing(action));
      // Placed, and still at the sign-in screen: the agent has to be started again, which only a rebuild does.
      if (action === 'replace-sign-in' && last?.action === action && last.outcome === 'done')
        return result(idle(), action, SIGN_IN_PLACED);
      continue;
    }
    if (allowed.kind === 'human') return result(idle(), action, allowed.needsHuman);
    if (!flags.enabled || (rung.tier === 'repair' && !flags.autoRepair)) {
      const byHand = heldInput && action === 'rebuild-laptop' ? REBUILD_RUNNING_BY_HAND : BY_HAND[action];
      return result(idle(), action, `${TIER_OFF[!flags.enabled ? 'retry' : 'repair']} ${byHand}`);
    }
    if (observed.busy) return result(idle(BUSY[observed.busy]), action, placing(action));
    if (allowed.kind === 'wait') return result(idle(allowed.waitingFor, allowed.at), action);
    const at = Math.max(clock.since + rung.dwellMs, tried.count ? tried.lastAt + backoff(rung, tried.count) : 0);
    return result({ action, at, preconditions: allowed.preconditions ?? [] }, action, placing(action));
  }
  // Every rung is used or does not apply. The ladder does not end here: it starts again, and says when.
  const again = ladderRestartAt(history, policy);
  return result(
    again === undefined
      ? idle()
      : idle(`the next round of repair steps, which starts at ${when(again)}: this round's did not help`, again),
    path.at(-1)
  );
}

// ─── History ──────────────────────────────────────────────────────────────────

/**
 * Carry the history across one observation. A problem keeps its `since` while its detail is unchanged, including
 * across the moments it reads as busy or starting (a retry in flight). Attempt counts end with the episode, after
 * the employee has stayed healthy or once the owner has stopped them, and with the round: `ladderRestartMs` after
 * the newest attempt they are cleared and the ladder starts again (`ladderRestartAt`). This is the one place that
 * rule lives, so it holds for every path. The record of the day's rebuilds is never cleared by it.
 */
export function rollSupervisorHistory(
  history: SupervisorHistory,
  seen: Pick<SupervisorClassification, 'condition' | 'fingerprint'>,
  now: number,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): SupervisorHistory {
  const rebuilds = history.rebuilds.filter((at) => now - at < DAY),
    last = history.lastAction ? { lastAction: history.lastAction } : {},
    again = ladderRestartAt(history, policy),
    attempts = again !== undefined && now >= again ? {} : history.attempts;
  if (seen.condition === 'owner-stopped') return { fingerprint: '', since: now, attempts: {}, rebuilds, ...last };
  if (seen.condition === 'healthy') {
    const healthySince = history.healthySince ?? now;
    return now - healthySince >= policy.healthyResetMs
      ? { fingerprint: '', since: healthySince, healthySince, attempts: {}, rebuilds, ...last }
      : {
          fingerprint: history.fingerprint,
          since: history.since,
          healthySince,
          attempts,
          rebuilds,
          ...last,
        };
  }
  const kept = { attempts, rebuilds, ...last };
  // In transit (starting, moving): the problem being worked on, if any, keeps its clock.
  if (seen.fingerprint === '')
    return {
      fingerprint: history.fingerprint,
      since: history.since,
      transitSince: history.transitSince ?? now,
      ...kept,
    };
  return seen.fingerprint === history.fingerprint
    ? { fingerprint: history.fingerprint, since: history.since, ...kept }
    : { fingerprint: seen.fingerprint, since: now, ...kept };
}

/** Count one attempt, before its effect: a throw or an office restart in the middle has still spent it. */
export function issueSupervisorAttempt(
  history: SupervisorHistory,
  action: SupervisorAction,
  at: number
): SupervisorHistory {
  const before = history.attempts[action]?.count ?? 0;
  return {
    ...history,
    attempts: { ...history.attempts, [action]: { count: before + 1, lastAt: at } },
    lastAction: { action, at, outcome: 'issued' },
  };
}

/** Record how the last issued attempt ended. A `busy` attempt tried nothing and is given back; its time is kept. */
export function settleSupervisorAttempt(
  history: SupervisorHistory,
  outcome: Exclude<SupervisorOutcome, 'issued'>,
  detail?: string
): SupervisorHistory {
  const last = history.lastAction;
  if (!last || last.outcome !== 'issued') return history;
  const spent = history.attempts[last.action] ?? { count: 1, lastAt: last.at };
  return {
    ...history,
    attempts:
      outcome === 'busy'
        ? { ...history.attempts, [last.action]: { count: Math.max(0, spent.count - 1), lastAt: spent.lastAt } }
        : history.attempts,
    rebuilds:
      last.action === 'rebuild-laptop' && outcome === 'done'
        ? [...history.rebuilds, last.at].slice(-8)
        : history.rebuilds,
    lastAction: { action: last.action, at: last.at, outcome, ...(detail ? { detail: clip(detail, 300) } : {}) },
  };
}

/** Both steps at once, for an attempt whose outcome is already known. */
export function recordSupervisorAttempt(
  history: SupervisorHistory,
  action: SupervisorAction,
  at: number,
  outcome: Exclude<SupervisorOutcome, 'issued'>,
  detail?: string
): SupervisorHistory {
  return settleSupervisorAttempt(issueSupervisorAttempt(history, action, at), outcome, detail);
}
