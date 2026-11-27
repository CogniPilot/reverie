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
 * Unknown input is never actionable: a code this table does not list classifies as `unknown`, which has no ladder.
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
  /** A `starting` or `unknown` state older than this is reported as needing a person. */
  readonly stalledAfterMs: number;
  /** A laptop whose terminal input is held is rebuilt only after its agent's pane has been idle and silent this long. */
  readonly heldInputIdleMs: number;
  /** A turn that such a laptop's agent has not ended this long after the problem was first seen is reported. */
  readonly heldInputTurnMs: number;
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
 * - A rebuild discards a laptop, so it waits longest, runs at most twice per episode and twice per day, and is
 *   never chosen while an agent may be running in that laptop (see `rebuildGate`), with one exception.
 * - The exception is a laptop whose office terminal has its input held for good (see `heldInputRebuildGate`). The
 *   office can never type to that agent again and no reconnect gives the terminal back, so once the agent's turn
 *   has ended, keeping it gains nothing. Such a laptop is rebuilt while its agent runs, but never in the middle of a
 *   turn: the pane must have been idle and silent for two minutes. The office terminal calls a pane idle after a few
 *   silent seconds and a look at the screen; two more minutes cover a pause between two tool calls that this look
 *   missed, while a working agent redraws its pane every second. A turn that has not ended thirty minutes after the
 *   problem was first seen is reported to a person, because by then an ordinary turn has finished; the office goes
 *   on waiting and never rebuilds in the middle of it. An agent that ended its turn with work left running (a
 *   monitor, a background shell) is given those same thirty minutes for it: a job of ordinary length finishes, and
 *   a shell that never ends does not keep the employee out of reach for good.
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
};

/** The two owner switches. Both off means the supervisor only describes what it sees. */
export interface SupervisorFlags {
  /** Observe, retry and reconnect. */
  readonly enabled: boolean;
  /** Abandon a dead-end move, and rebuild a laptop nothing is running in or whose terminal input is held for good. */
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
 *   It is the only reason for which a rebuild may discard a laptop its agent runs in.
 * - `stored-home`: a read of the stopped laptop's stored HOME and Nix directories (`laptop.storedHome`). A new
 *   laptop is bound to the same paths, so the step waits when they no longer hold the recorded directories.
 */
export type SupervisorPrecondition = 'no-agent-running' | 'terminal-input-held' | 'stored-home';

/**
 * The stored HOME and Nix directories of a finished laptop that is stopped, compared with what its storage holder
 * recorded. `verified`: the same directories (under a new device number only when the office could prove or was
 * granted that). `unchecked`: there is no stopped, finished laptop to compare, or this office has no verifier.
 * `renumbered`: unchanged directories on a device number that nothing accepts. `different`: other directories.
 * `unknown`: the read failed.
 */
export type SupervisorStoredHome = 'verified' | 'unchecked' | 'renumbered' | 'different' | 'unknown';

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
     * What the office terminal shows of the agent's turn, reported with `inputHeld`: `working` while one is in
     * progress, `idle` once it has ended, `unknown` while the office is not reading the pane. Never read as idle.
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
    /** Another laptop of the same box is attached and running, so the shared pool they all use is alive. */
    readonly poolAlive?: boolean;
    /**
     * What the office's own look at the shared pool last found, while no laptop is attached: `up` (its anchor runs
     * and no recovery is open), `down` (the anchor is stopped, as after a host restart, or a recovery is open) or
     * `unknown`. `none`: no laptop record names a pool, so there is none to recover and a laptop set-up creates it.
     * Absent while the office is not looking.
     */
    readonly pool?: 'up' | 'down' | 'unknown' | 'none';
    /** A fresh read of the stopped laptop's stored directories. Only made before a rebuild is decided. */
    readonly storedHome?: SupervisorStoredHome;
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
  if (!terminal || !paneWatched(terminal)) return { inputHeld: true, turn: 'unknown' };
  if (terminal.isWorking || terminal.status === 'busy') return { inputHeld: true, turn: 'working' };
  if (terminal.status !== 'idle') return { inputHeld: true, turn: 'unknown' };
  const idleSince = Math.max(terminal.lastActivityAt ?? 0, terminal.lastPromptTime ?? 0, terminal.paneStartedAt ?? 0);
  return {
    inputHeld: true,
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
 * - `stopped`: the laptop container is not running. A stopped laptop is rebuilt. When no other laptop of the box
 *   is running either, the host most likely restarted: the office recovers the shared pool first, by itself, and
 *   the rebuild waits for that (`rebuildGate`).
 * - `retry-owner`: re-send while the operation offers it; otherwise the cause is outside one laptop.
 * - `provider`: the laptop runs but no agent of this employee is confirmed in it.
 * - `viewer`: the agent may be fine; the office terminal is not attached.
 * - `owner`: recognized, and only the owner may settle it.
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
  // The small container that holds the laptop's home and Nix directories open is not running, as after a host
  // restart, and nothing starts it again. A fresh laptop gets a new one.
  DOCKER_CONTINUATION_STORAGE_UNCONFIRMED: [
    'rebuild',
    "The container that holds {name}'s home storage for their laptop is not running, so the laptop cannot be confirmed.",
  ],
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
export function sharedPoolCode(code: string | undefined): boolean {
  return code !== undefined && SHARED_POOL_CODES.has(code);
}
const REPAIR_POOL_BY_HAND =
  'The office puts the approved limits of the shared pool back itself and tries again about every ten minutes. ' +
  'The same by hand: GET …/docker-pool/status, then POST …/docker-pool/repair ' +
  '(or …/docker-pool/reconcile when the status offers that instead). No laptop is stopped.';
/** Shown while a rebuild or a start waits for the pool that the office is recovering after a host restart. */
const POOL_WAIT = 'the shared pool, which the office is recovering after a host restart';
/** A refused local-model launch check: its code carries the reason after this prefix and its message says the rest. */
const LOCAL_MODEL_PREFIX = 'DOCKER_CONTINUATION_LOCAL_MODEL_';

const OWNER_STEPS: Readonly<Record<string, string>> = {
  DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED:
    'Approve the resource limits: PUT /api/company/employees/:id/docker-policy, then continue the laptop.',
  DOCKER_CONTINUATION_FOREIGN_PROVIDER:
    'Look at the laptop terminal. Rebuild the laptop (POST …/docker-rebuild/preview, then /apply) once nothing in it matters.',
  DOCKER_CONTINUATION_RUNTIME_CHANGED: 'Restart the office so it reads its configuration again.',
  DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED: REPAIR_POOL_BY_HAND,
  DOCKER_CONTINUATION_POOL_UNCONFIRMED: REPAIR_POOL_BY_HAND,
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
 * know: such a move is still continued (the move's own record offers that), but it is never abandoned automatically.
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
    fingerprint = `move:${move.id}:${error}`,
    held = `${name}'s plan move stopped part-way: ${error}`;
  if (!move.docker)
    return classified('needs-owner', held, {
      code: 'move-held',
      fingerprint,
      needsHuman: 'This move belongs to the retired runtime. Resolve it: POST /api/plans/moves/:id/resolve.',
    });
  const kind = classifyMoveError(move.error);
  if (kind === 'sign-in' && observed.planSignedIn !== true)
    return classified('needs-sign-in', held, {
      code: 'move-sign-in',
      fingerprint,
      needsHuman: `Sign in ${plan(observed)} at the office (Plans). The office then continues the move on its own.`,
    });
  if (kind === 'owner-decision')
    return classified('needs-owner', held, {
      code: 'move-owner-decision',
      fingerprint,
      needsHuman: "Answer the screen in the new session's terminal, then continue the move.",
    });
  if (!move.allowedActions.includes('continue-original'))
    return classified('needs-owner', held, {
      code: 'move-held',
      fingerprint,
      needsHuman: 'This move offers no continue step. Read it: POST /api/plans/moves/:id/status.',
    });
  return classified('move-held-retryable', held, { code: 'move-' + kind, fingerprint });
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
  if (!kind)
    return classified('unknown', `${name}'s laptop reports ${clip(code, 96)}, which the office does not recognize.`, {
      code,
      fingerprint,
      needsHuman: 'Read the laptop: GET /api/company/employees/:id/docker-policy. Rebuild it if nothing in it matters.',
    });
  const sentence = codeSentence(code, name, message);
  if (kind === 'wait') return classified('starting', sentence, { code });
  if (kind === 'viewer') return classified('viewer-lost', sentence, { code, fingerprint });
  if (kind === 'provider')
    return classified(
      'provider-exited',
      providerExit ? `${name}'s agent is not running in their laptop. ${clip(providerExit, 400)}` : sentence,
      { code, fingerprint }
    );
  if (kind === 'owner')
    return classified('needs-owner', sentence, { code, fingerprint, needsHuman: OWNER_STEPS[code] });
  // What a host restart looks like. Nobody is asked for anything: the office recovers the shared pool itself and
  // the rebuild rung waits for it.
  if (kind === 'stopped' && !poolUsable(observed))
    return classified(
      'held-needs-rebuild',
      `${sentence} No other laptop of this office is running either, so the office recovers the shared pool first.`,
      { code, fingerprint }
    );
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

function classifyLaptop(observed: SupervisorObservation): SupervisorClassification {
  const { laptop, session, name } = observed;
  if (laptop.rebuildPending)
    return classified('held-needs-rebuild', `${name}'s laptop rebuild was started and has not finished.`, {
      code: 'rebuild-pending',
      fingerprint: 'rebuild-pending',
    });
  if (!laptop.record) {
    if (!laptop.policyApproved)
      return classified('needs-owner', `${name} has no laptop and no approved resource limits.`, {
        code: 'no-policy',
        fingerprint: 'no-policy',
        needsHuman: OWNER_STEPS.DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED,
      });
    if (laptop.source === 'stopped')
      return classified('laptop-not-started', `${name} has a fresh laptop that has not been started yet.`, {
        code: 'source-stopped',
        fingerprint: 'source-stopped',
      });
    // An unused laptop holds nothing, so replacing it loses nothing: the rebuild rung takes it, under the same
    // switch, limits and proofs as every other rebuild. With repairs switched off the owner is told the calls.
    if (laptop.source === 'outdated') return classifyCode(observed, 'DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED');
    return classified('unknown', `${name} has no laptop record, and the office found no laptop to start from.`, {
      code: 'no-laptop',
      fingerprint: 'no-laptop',
      needsHuman: 'Read GET /api/company/employees/:id/docker-policy to see which laptop, if any, exists.',
    });
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
    return classified('unknown', `${name} is not connected. Their session is not in a laptop the supervisor manages.`, {
      code: 'not-boxed',
      fingerprint: 'not-boxed',
      needsHuman: 'Wake the employee: POST /api/company/employees/:id/wake.',
    });
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
  return condition === 'viewer-lost' && observed.session.inputHeld === true;
}

// ─── Ladder ───────────────────────────────────────────────────────────────────

/** The rungs each base condition may climb, in order. A condition that is not listed has no automatic step. */
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

const DAY = 24 * 60 * MINUTE;

type Gate =
  | { readonly kind: 'ok'; readonly preconditions?: readonly SupervisorPrecondition[] }
  | { readonly kind: 'skip' }
  | { readonly kind: 'wait'; readonly waitingFor: string }
  | { readonly kind: 'human'; readonly needsHuman: string };

const REBUILD_BY_HAND =
  'Rebuild the laptop: POST /api/company/employees/:id/docker-rebuild/preview, then /apply, then continue it.';
/** The same calls for a laptop whose agent is still running, as it is while only the terminal's input is held. */
const REBUILD_RUNNING_CALLS =
  'POST /api/company/employees/:id/docker-rebuild/preview, then /apply with confirmDiscardRunning (that ends ' +
  'whatever the agent is doing), then continue it.';
const REBUILD_RUNNING_BY_HAND = 'Rebuild the laptop: ' + REBUILD_RUNNING_CALLS;

/** The two limits every automatic rebuild keeps, whatever its reason. Undefined when both allow one. */
function rebuildLimit(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy,
  byHand: string
): Gate | undefined {
  if (!observed.laptop.templateOnRecord)
    return {
      kind: 'human',
      needsHuman:
        'No owner-approved laptop layout is on record for this employee, so the office cannot rebuild on its own. ' +
        byHand,
    };
  if (history.rebuilds.filter((at) => now - at < DAY).length >= policy.rebuildsPerDay)
    return {
      kind: 'human',
      needsHuman: `The office already rebuilt this laptop ${policy.rebuildsPerDay} times today and it did not hold. ${byHand}`,
    };
  return undefined;
}

/** What the office waits for before it rebuilds a laptop whose terminal input is held, by what the pane shows. */
const HELD_INPUT_WAIT: Readonly<Record<SupervisorTurn, string>> = {
  working: "the agent's current turn to end",
  idle: "the agent's terminal to stay quiet a little longer",
  unknown: "a reading of the agent's terminal",
};

const HELD_INPUT_BACKGROUND_WAIT = 'the work the agent left running to finish';

/**
 * The one exception to "never while an agent is running", and only for a lost terminal whose input is held for
 * good (`terminalHeldForGood`): the office can never type to that agent again, so once its turn has ended, keeping
 * it gains nothing, and a rebuild keeps its home directory and the conversation saved in it.
 *
 * It is allowed only while the pane is seen idle and has been silent for `heldInputIdleMs`. A turn in progress is
 * waited for, and so is a pane the office is not reading: `unknown` is never treated as idle. When that has lasted
 * `heldInputTurnMs` since the problem was first seen, a person is told; the office still rebuilds on its own as
 * soon as the turn has ended, and never before. Work the agent left running after its turn is waited for as well,
 * but only for that long: after it the idle laptop is rebuilt with that work still running. With repairs switched off nothing is waited for on the owner's
 * behalf: the usual sentence names the switch and the calls.
 *
 * What runs in the laptop is not asked here. The step proves the hold and the idle pane again itself, and confirms
 * the discard only for the one recorded laptop (`DockerSupervisorLaptops.rebuild`).
 */
function heldInputRebuildGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  flags: SupervisorFlags,
  now: number,
  policy: SupervisorPolicy
): Gate {
  const limit = rebuildLimit(observed, history, now, policy, REBUILD_RUNNING_BY_HAND);
  if (limit) return limit;
  const { turn = 'unknown', idleSince, background } = observed.session;
  const overdue = history.since > 0 && now - history.since >= policy.heldInputTurnMs;
  const quiet = turn === 'idle' && idleSince !== undefined && now - idleSince >= policy.heldInputIdleMs;
  if (quiet && (!background || overdue)) return { kind: 'ok', preconditions: ['terminal-input-held'] };
  if (quiet) return { kind: 'wait', waitingFor: HELD_INPUT_BACKGROUND_WAIT };
  if (!overdue || !flags.enabled || !flags.autoRepair) return { kind: 'wait', waitingFor: HELD_INPUT_WAIT[turn] };
  return {
    kind: 'human',
    needsHuman:
      "The office rebuilds this laptop only after the agent's current turn has ended, and after " +
      `${Math.round(policy.heldInputTurnMs / MINUTE)} minutes it still cannot see that it has. It goes on waiting ` +
      `and rebuilds as soon as the turn ends. To rebuild now instead: ${REBUILD_RUNNING_CALLS}`,
  };
}

/**
 * A laptop is rebuilt automatically only when nothing can be lost with it: a fresh read says no agent runs in it
 * (it exited, was never started, or the laptop is stopped or gone). `running` is the owner's decision; `unknown`
 * is never treated as absence. The one exception has its own gate (`heldInputRebuildGate`).
 */
function rebuildGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy
): Gate {
  const limit = rebuildLimit(observed, history, now, policy, REBUILD_BY_HAND);
  if (limit) return limit;
  const provider = observed.laptop.provider;
  if (provider === 'running')
    return {
      kind: 'human',
      needsHuman:
        'An agent is running in a laptop of this employee, or the office cannot show that a running laptop is empty, ' +
        'so rebuilding would discard its conversation. That needs the owner: ' +
        'POST …/docker-rebuild/preview, then /apply with confirmDiscardRunning.',
    };
  if (provider === 'unknown')
    return history.since > 0 && now - history.since >= policy.stalledAfterMs
      ? {
          kind: 'human',
          needsHuman:
            'The office cannot read what is running in this laptop, so it will not rebuild it on its own. ' +
            REBUILD_BY_HAND,
        }
      : { kind: 'wait', waitingFor: 'a confirmed read of what is running in the laptop' };
  // No laptop of this employee runs, and no other laptop of the box does either: that is what a host restart
  // looks like. The office recovers the shared pool itself, and no laptop is rebuilt before that: a rebuild
  // retires the laptop record the recovery reads, and a fresh laptop could not be set up without the pool.
  if (provider === 'no-laptop' && observed.laptop.poolAlive === false && !poolUsable(observed))
    return { kind: 'wait', waitingFor: POOL_WAIT };
  // A finding that stops the rebuild is known without asking again what runs in the laptop.
  const stored = observed.laptop.storedHome;
  if (stored !== undefined && storedHomeGate(stored).kind !== 'ok') return storedHomeGate(stored);
  if (provider === undefined) return { kind: 'ok', preconditions: ['no-agent-running'] };
  // Only a finished laptop that is stopped has a stored home to compare with what its holder recorded.
  const finished = ['ready', 'provider-issued'].includes(observed.laptop.record?.phase ?? '');
  return provider === 'no-laptop' && finished ? storedHomeGate(stored) : { kind: 'ok', preconditions: [] };
}

const STORED_HOME_RENUMBERED =
  "The filesystem this employee's home is on has a new device number since their laptop was built, and the office " +
  'holds no earlier record of that filesystem to prove it is the same one. It reads the home again about every ' +
  'ten minutes and rebuilds the laptop by itself once this is settled. To settle it, either set the company ' +
  'setting acceptStorageRenumbering (PUT /api/company/settings), which accepts a new device number while both ' +
  'recorded directories are otherwise unchanged, or approve this one laptop: POST ' +
  '/api/company/employees/:id/docker-storage/device-approval.';
const STORED_HOME_DIFFERENT =
  "The directory at this employee's home path is not the one their laptop was built on (another inode, owner or " +
  'mode), which is what a different or missing disk at that path looks like. The office will not start them on ' +
  'it. Once the right filesystem is mounted, the office finds the recorded directory at its next read, about ' +
  'every ten minutes, and rebuilds the laptop by itself. To accept the directory that is there now instead: ' +
  REBUILD_BY_HAND;

/**
 * A rebuilt laptop is bound to the home path of the laptop it replaces. Before a stopped laptop is rebuilt, the
 * office reads whether that path still holds the recorded directory. Only a positive finding stops the rebuild,
 * and it is read again later: nothing here is final.
 */
function storedHomeGate(stored: SupervisorStoredHome | undefined): Gate {
  if (stored === undefined) return { kind: 'ok', preconditions: ['stored-home'] };
  if (stored === 'renumbered') return { kind: 'human', needsHuman: STORED_HOME_RENUMBERED };
  if (stored === 'different') return { kind: 'human', needsHuman: STORED_HOME_DIFFERENT };
  if (stored === 'unknown') return { kind: 'wait', waitingFor: "a read of the laptop's stored home directory" };
  return { kind: 'ok', preconditions: [] };
}

/** Another laptop of the box is attached, or the office's own look found the pool's anchor running, or found
 * that no laptop record names a pool at all, so that there is nothing to wait for. */
function poolUsable(observed: SupervisorObservation): boolean {
  return observed.laptop.poolAlive === true || observed.laptop.pool === 'up' || observed.laptop.pool === 'none';
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
  heldInput = false
): Gate {
  const seen = observed.laptop.continuation,
    move = observed.move;
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
    case 'start-continuation':
      // A fresh laptop cannot be set up while the pool's anchor is stopped or a recovery of it is open. Only a
      // look that found exactly that holds the start: a pool the office could not read is tried, as it always was.
      if (observed.laptop.pool === 'down' && observed.laptop.poolAlive !== true)
        return { kind: 'wait', waitingFor: POOL_WAIT };
      return observed.laptop.source === 'stopped' && observed.laptop.policyApproved
        ? { kind: 'ok' }
        : { kind: 'wait', waitingFor: 'a stopped laptop source and approved resource limits' };
    case 'continue-move':
      return move?.docker && move.allowedActions.includes('continue-original') ? { kind: 'ok' } : { kind: 'skip' };
    case 'reconnect-viewer':
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
    case 'abandon-move': {
      const kind = classifyMoveError(move?.error);
      if (!move?.allowedActions.includes('abandon'))
        return {
          kind: 'human',
          needsHuman: 'This move cannot be abandoned here. Read it: POST /api/plans/moves/:id/status.',
        };
      if (kind !== 'first-run' && kind !== 'laptop-step')
        return {
          kind: 'human',
          needsHuman:
            'Continuing the move did not help, and the office does not abandon a move for a reason it does not ' +
            'recognize. Continue it (POST /api/plans/moves/:id/resolve) or abandon it (POST /api/plans/moves/:id/abandon).',
        };
      return { kind: 'ok' };
    }
    case 'rebuild-laptop':
      // A new laptop would join the same pool and be held by the same thing. The office goes on putting the
      // pool's limits back in place (see `EmployeeSupervisor`); the sentence is shown while it does.
      if (seen?.code && SHARED_POOL_CODES.has(seen.code)) return { kind: 'human', needsHuman: REPAIR_POOL_BY_HAND };
      return heldInput
        ? heldInputRebuildGate(observed, history, flags, now, policy)
        : rebuildGate(observed, history, now, policy);
  }
}

const TIER_OFF: Readonly<Record<SupervisorTier, string>> = {
  retry: 'Automatic retries are switched off (company setting supervisorEnabled).',
  repair: 'Automatic repairs are switched off (company setting supervisorAutoRepair).',
};

const BY_HAND: Readonly<Record<SupervisorAction, string>> = {
  'resend-continuation':
    'Continue the laptop: POST /api/company/employees/:id/docker-continuation with its original request.',
  'start-continuation': 'Start the laptop: GET …/docker-policy, then POST …/docker-continuation.',
  'continue-move': 'Continue the move: POST /api/plans/moves/:id/resolve with action continue-original.',
  'reconnect-viewer': 'Reconnect the terminal from the employee card, or wake the employee.',
  'replace-sign-in': 'Sign the plan in at the office (Plans), or in the laptop terminal.',
  'relaunch-provider': 'Restart the agent in its laptop.',
  'abandon-move': 'Abandon the move: POST /api/plans/moves/:id/abandon, then rebuild the laptop.',
  'rebuild-laptop': REBUILD_BY_HAND,
};

const EXHAUSTED: Readonly<Partial<Record<SupervisorCondition, string>>> = {
  'viewer-lost':
    'The office could not reconnect the terminal on its own. The agent may still be working; reconnect from the ' +
    'employee card, or restart the office.',
  'provider-exited': 'The office could not bring the agent back on its own. ' + REBUILD_BY_HAND,
  'held-retryable': 'Repeating the step and rebuilding did not help. ' + REBUILD_BY_HAND,
  'held-needs-rebuild': 'Rebuilding did not help. ' + REBUILD_BY_HAND,
  'laptop-not-started': 'The laptop would not start. Read GET …/docker-policy, then POST …/docker-continuation.',
  'move-held-retryable': 'The move is still held. ' + BY_HAND['abandon-move'],
};
/** Said once every step for a lost terminal whose input is held for good has been tried. */
const HELD_INPUT_EXHAUSTED = 'The office could not rebuild the laptop on its own. ' + REBUILD_RUNNING_BY_HAND;

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
 */
export function assessEmployee(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  flags: SupervisorFlags,
  now: number,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): SupervisorAssessment {
  const base = classifyEmployee(observed),
    heldInput = terminalHeldForGood(observed, base.condition),
    path = heldInput ? SUPERVISOR_HELD_INPUT_PATH : (SUPERVISOR_PATHS[base.condition] ?? []);
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
    const stalled =
      (base.condition === 'starting' || base.condition === 'waiting-first-run-screen') &&
      history.transitSince !== undefined &&
      now - history.transitSince >= policy.stalledAfterMs;
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
      allowed = gate(action, observed, history, flags, now, policy, heldInput);
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
    if (allowed.kind === 'wait') return result(idle(allowed.waitingFor), action);
    const at = Math.max(history.since + rung.dwellMs, tried.count ? tried.lastAt + backoff(rung, tried.count) : 0);
    return result({ action, at, preconditions: allowed.preconditions ?? [] }, action, placing(action));
  }
  return result(idle(), path.at(-1), heldInput ? HELD_INPUT_EXHAUSTED : (EXHAUSTED[base.condition] ?? base.needsHuman));
}

// ─── History ──────────────────────────────────────────────────────────────────

/**
 * Carry the history across one observation. A problem keeps its `since` while its detail is unchanged, including
 * across the moments it reads as busy or starting (a retry in flight). Attempt counts end only with the episode:
 * after the employee has stayed healthy, or once the owner has stopped them.
 */
export function rollSupervisorHistory(
  history: SupervisorHistory,
  seen: Pick<SupervisorClassification, 'condition' | 'fingerprint'>,
  now: number,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): SupervisorHistory {
  const rebuilds = history.rebuilds.filter((at) => now - at < DAY),
    last = history.lastAction ? { lastAction: history.lastAction } : {};
  if (seen.condition === 'owner-stopped') return { fingerprint: '', since: now, attempts: {}, rebuilds, ...last };
  if (seen.condition === 'healthy') {
    const healthySince = history.healthySince ?? now;
    return now - healthySince >= policy.healthyResetMs
      ? { fingerprint: '', since: healthySince, healthySince, attempts: {}, rebuilds, ...last }
      : {
          fingerprint: history.fingerprint,
          since: history.since,
          healthySince,
          attempts: history.attempts,
          rebuilds,
          ...last,
        };
  }
  const kept = { attempts: history.attempts, rebuilds, ...last };
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
