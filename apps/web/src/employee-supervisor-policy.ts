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
  | 'stuck-first-run-screen'
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
  /**
   * An agent parked on a start-up screen is started again this long after work was first seen left running in its
   * pane. Such an agent has no conversation that could have started any.
   */
  readonly heldInputTurnMs: number;
  /**
   * Work an agent left running after its turn (a monitor, a background shell) is waited for until this long after
   * the office first saw it, before the laptop is rebuilt with it still running.
   */
  readonly backgroundGraceMs: number;
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
 *   background shell) is given four hours from when the office first saw that work: the jobs agents leave running
 *   on this machine are builds and test runs of one to three hours, their output lands in the home directory a
 *   rebuild keeps, and the laptops this rule serves either go on working meanwhile or cannot be reached with or
 *   without the wait. A shell that never ends does not keep a laptop for good. The clock is the work's own: it
 *   does not start with the problem, so a job that began late is not cut short for a problem that began early.
 *   An agent parked on a start-up screen has no conversation that could have started any work, and keeps the
 *   thirty minutes this wait used to be.
 * - The same rule, with the same times, serves every other laptop that only a rebuild settles while an agent still
 *   runs in it (`betweenTurnsGate`). It is rebuilt between the agent's turns and never in the middle of one.
 * - An agent parked on a provider start-up screen (a sign-in, a first-run screen the office could not answer) is in
 *   no turn at all: it never reached its composer. It is started again, by a relaunch where the office has one and
 *   otherwise by a rebuild, under that same rule, and only on proof that the screen is really up (see
 *   `parkedScreenGate`).
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
  backgroundGraceMs: 4 * 60 * MINUTE,
};

/** The two owner switches. Both off means the supervisor only describes what it sees. */
export interface SupervisorFlags {
  /** Observe, retry and reconnect. */
  readonly enabled: boolean;
  /**
   * Abandon a dead-end move, rebuild a laptop (at once when nothing runs in it, otherwise between its agent's
   * turns or while its agent is parked on a provider start-up screen), and give an employee who has no approved
   * limits the owner's standing default.
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
 * - `agent-parked-at-screen`: the office terminal still shows the agent on a provider start-up screen, proved by
 *   more than the screen's words, and its pane still shows no turn in progress. An agent there never reached its
 *   composer, so a relaunch or a rebuild discards no conversation.
 * - `stored-home`: nothing runs in the laptop, and a read of its stored HOME and Nix directories
 *   (`laptop.storedHome`) found nothing against them. A new laptop is bound to the same paths, so the step is not
 *   taken while they no longer hold the recorded directories. It allows no discard of anything that runs.
 *
 * `terminal-input-held`, `agent-between-turns`, `agent-unreadable` and `agent-parked-at-screen` are the only
 * reasons for which a rebuild may discard a laptop its agent runs in.
 */
export type SupervisorPrecondition =
  | 'no-agent-running'
  | 'terminal-input-held'
  | 'agent-between-turns'
  | 'agent-unreadable'
  | 'laptop-held'
  | 'agent-parked-at-screen'
  | 'stored-home';

/** The proofs that allow a rebuild to discard the one recorded laptop while an agent may run in it. */
export const SUPERVISOR_OCCUPIED_PROOFS: readonly SupervisorPrecondition[] = [
  'terminal-input-held',
  'agent-between-turns',
  'agent-unreadable',
  'agent-parked-at-screen',
];

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
  /**
   * Whether the last read of that plan's sign-in copies found a usable one in this employee's laptop. `undefined`
   * when no recent read says. Read for an employee at a sign-in screen only.
   */
  readonly laptopSignedIn?: boolean;
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
      /**
       * How the office knows the screen is up: its live widget on the frame, or a launch of this office that has
       * not reached its composer. Absent when only the screen's words were read, which a conversation that quotes
       * the screen shows as well; nothing is then restarted for it.
       */
      readonly proof?: 'widget' | 'launch';
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

/** An office terminal that can also say which provider start-up screen its pane is parked on. */
export interface SupervisedScreenTerminal extends SupervisedTerminal {
  /** `shown` is how the terminal knows: by the live `widget`, by its own `launch`, or only by the `words`. */
  startupScreen?(): {
    readonly label: string;
    readonly kind: 'first-run' | 'credential' | 'decision';
    readonly answering: boolean;
    readonly shown?: 'widget' | 'launch' | 'words';
  } | null;
}

export type SupervisorScreenReading = Pick<SupervisorObservation['session'], 'startupScreen'>;

/**
 * The provider start-up screen one office terminal shows, when the office knows it by more than its words. The
 * observation is built with it and a step reads it again immediately before it acts. What the pane shows of a turn
 * is read beside it by `readTerminalTurn`, as for every laptop.
 *
 * Nothing is reported for a pane the office is not reading, for an agent that is working, or for a screen the
 * office knows only by its words: none of those is a parked agent.
 */
export function readParkedScreen(terminal: SupervisedScreenTerminal | undefined): SupervisorScreenReading {
  if (!terminal?.startupScreen || !paneWatched(terminal) || terminal.status === 'busy') return {};
  let screen: ReturnType<NonNullable<SupervisedScreenTerminal['startupScreen']>>;
  try {
    screen = terminal.startupScreen();
  } catch {
    return {};
  }
  if (!screen || (screen.shown !== 'widget' && screen.shown !== 'launch')) return {};
  return {
    startupScreen: { label: screen.label, kind: screen.kind, answering: screen.answering, proof: screen.shown },
  };
}

export interface SupervisorAttempt {
  readonly count: number;
  readonly lastAt: number;
  /** One attempt of this rung was given back at an office start in this round; see `resumeSupervisorHistory`. */
  readonly resumed?: true;
}

/** What the supervisor remembers about one employee. Persisted, so an office restart keeps the ladder. */
export interface SupervisorHistory {
  /** Detail of the problem being worked on; empty while there is none. */
  readonly fingerprint: string;
  /** When that problem was first seen. */
  readonly since: number;
  /** When the employee was last seen to become healthy; cleared by the next problem. */
  readonly healthySince?: number;
  /**
   * Since when the employee has been seen, without a break, in the starting or between-states condition that
   * `transitOf` names. Any other observation ends that run, and so does an office start (`resumeSupervisorHistory`).
   */
  readonly transitSince?: number;
  /** The condition `transitSince` counts; see `transitKey`. */
  readonly transitOf?: string;
  /**
   * Since when this office process has seen the problem `fingerprint` names without a break. `since` says when a
   * problem was first seen, across the moments it reads as starting or healthy and across office restarts, and it
   * paces the steps. This clock is what every bound that allows a laptop to be discarded is measured by
   * (`watchedSince`): time in which the office saw something else, or was not running, does not count.
   */
  readonly watchSince?: number;
  /**
   * Since when an idle pane of this employee has shown work that its agent left running, in this office process.
   * It is kept while a turn runs or the pane cannot be read, and ends when an idle pane shows none: the grace such
   * work is given counts from here and from nothing else (`backgroundGraceMs`).
   */
  readonly backgroundSince?: number;
  /**
   * When a rebuild of this employee's laptop was last issued while an agent ran in it, or may have. Written by the
   * driver, which keeps an office-wide limit by it (`EmployeeSupervisor`), and kept across office restarts for a day.
   */
  readonly occupiedRebuildAt?: number;
  readonly attempts: Readonly<Partial<Record<SupervisorAction, SupervisorAttempt>>>;
  /** Times of this employee's automatic rebuilds within the last day. */
  readonly rebuilds: readonly number[];
  readonly lastAction?: {
    readonly action: SupervisorAction;
    readonly at: number;
    readonly outcome: SupervisorOutcome;
    readonly detail?: string;
    /** A rebuild of a laptop that was stopped from outside: it is not added to `rebuilds` when it is done. */
    readonly uncounted?: true;
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
  /**
   * The rebuild replaces a laptop that was stopped from outside together with its storage holder, as after a host
   * restart. It is not counted against the limit of rebuilds per day (`issueSupervisorAttempt`).
   */
  readonly uncounted?: true;
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
 * - `wait`: a read that raced or an operation still running; observe again. One that never ends is treated as a
 *   laptop that never finished starting.
 * - `retry`: the same request sent again is the documented next step. A laptop nothing runs in is rebuilt if that
 *   never helps; one whose agent runs and can be reached is kept (`rebuildGate`).
 * - `rebuild`: the operation cannot advance; a fresh laptop is the reset. Only this kind is a reason to rebuild a
 *   laptop whose agent runs and can be reached, and then between that agent's turns.
 * - `stopped`: the laptop container is not running. A stopped laptop is rebuilt. When no other laptop of the box
 *   is running either, the host most likely restarted: the office recovers the shared pool first, by itself, and
 *   the rebuild waits for that (`rebuildGate`).
 * - `retry-owner`: re-send while the operation offers it; otherwise the cause is outside one laptop and the office
 *   works on it there (the shared pool, the stored home), or says what only a person can change.
 * - `provider`: the laptop runs but no agent of this employee is confirmed in it. The agent is started again in
 *   place where the office can do that; a laptop a read shows to be empty is rebuilt.
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
  // More results of those reads that say nothing about any one laptop: something moved while it was read, or a
  // container was between two states. Unlisted, each would count as a code the office does not know.
  DOCKER_RESOURCE_OBSERVATION_CHANGED: ['wait', "A laptop's processes changed while the office was reading them."],
  DOCKER_RESOURCE_MEMBERS_CHANGED: ['wait', 'A laptop started or stopped while the shared pool was being read.'],
  DOCKER_RESOURCE_MEMBERS_UNKNOWN: ['wait', 'The office could not read which laptops are in the shared pool just now.'],
  DOCKER_RESOURCE_LEAF_CENSUS_CHANGED: [
    'wait',
    'The limits helpers of the shared pool changed while the office was reading them.',
  ],
  DOCKER_RESOURCE_CONTAINER_UNKNOWN: ['wait', 'A laptop was between two states while the office was reading it.'],
  DOCKER_RESOURCE_PROBE_PROCESS_EXITED: ['wait', "A process ended while the office was reading a laptop's processes."],
  DOCKER_CONTINUATION_CONTAINER_STATE_UNKNOWN: [
    'wait',
    "{name}'s laptop container was between two states while the office was reading it.",
  ],
  DOCKER_CONTINUATION_DESTINATION_STATE_UNKNOWN: [
    'wait',
    "{name}'s laptop container reported a state the office could not read just now.",
  ],

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
  // never helps, and where an agent runs there, only between its turns.
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
 * Two causes are outside: an operation that only has to finish (`wait`), and something every laptop shares
 * (`owner`: the pool's limits, the office's own configuration). Continuing such a move again finds the same
 * thing, and the office repairs each of them by another path, so the move is given thirty minutes from the moment
 * the problem was first seen. That covers the repair of the pool's limits. After it the move is abandoned: the
 * employee is not kept out of work for a move that cannot finish.
 *
 * Only a continue can tell whether such a cause is gone: the laptop of an employee who is being moved is not read,
 * and the office's look at the pool says whether its anchor runs, not whether its limits are confirmed again. So
 * the three continues of a round are spread as probes over that time instead of being spent in its first minutes:
 * one at once, one not before `outsideProbeMs`, and the last not before the thirty minutes are over. The move is
 * abandoned only after that last probe has found the cause still there. A move is therefore never abandoned
 * because all its probes fell inside an outage that then ended. For as long as the cause is outside the move it is
 * one problem, whichever code names it at the moment, so a second code of the same outage does not start the
 * thirty minutes again.
 *
 * A host restart is not one of these and is not given a time, because there the office does see the cause. While
 * its own look finds the pool down (`poolDown`), a move is neither continued nor closed, whatever its error and
 * for as long as that lasts: see `abandonMoveGate`. No probe is spent against a pool that is known to be down;
 * the probes above are for the causes that look does not show. A move that stopped because a laptop's storage
 * holder is not running (`DOCKER_CONTINUATION_STORAGE_UNCONFIRMED`) is a step of the move itself: nothing starts
 * a holder again, so no other repair would let that move go on.
 *
 * A move that stopped at the sign-in screen of its new session is NOT such a cause, whatever the office reports
 * about the plan. That screen is only reached after the move has launched the agent in the candidate laptop, and
 * the candidate keeps the plan's sign-in in a folder of its own. A sign-in made at the office afterwards does not
 * reach that folder, the office places none there for a held move, and a sign-in typed into the candidate changes
 * the account material the move installed, which the move's own check then refuses
 * (`DOCKER_PLAN_ACCOUNT_AUTH_CHANGED`). Waiting for the plan to be signed in could therefore never finish the
 * move. A continue succeeds only when the candidate got past the screen by itself, so such a move is continued and
 * abandoned on the same times as any other; once it is abandoned the employee is an ordinary employee on that plan
 * and the laptop's own sign-in repair applies.
 */
export const SUPERVISOR_MOVE_POLICY: { readonly outsideCauseMs: number; readonly outsideProbeMs: number } = {
  outsideCauseMs: 30 * MINUTE,
  outsideProbeMs: 10 * MINUTE,
};
/** The classes of move error whose cause lies outside the move. */
const OUTSIDE_MOVE_CAUSES: readonly SupervisorMoveErrorClass[] = ['wait', 'owner'];

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
  const kind = classifyMoveError(move.error);
  return classified('move-held-retryable', `${name}'s plan move stopped part-way: ${error}`, {
    code: 'move-' + kind,
    // A cause outside the move is one problem for as long as it lasts, whichever code names it at the moment.
    fingerprint: OUTSIDE_MOVE_CAUSES.includes(kind) ? `move:${move.id}:outside` : fingerprint,
  });
}

/** What a held laptop move waits for outside itself, in plain words; undefined when its cause is its own. */
function moveCauseOutside(observed: SupervisorObservation): string | undefined {
  const kind = classifyMoveError(observed.move?.error);
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
 * When the next continue of a move held by a cause outside itself may run: the first at once, the last of the
 * round not before the wait for that cause is over, any other not before `outsideProbeMs`. Each is a probe, and
 * the last one is what the abandon is judged by (`abandonMoveGate`).
 */
function outsideProbeAt(history: SupervisorHistory, policy: SupervisorPolicy): number {
  const count = history.attempts['continue-move']?.count ?? 0;
  if (count >= policy.ladder['continue-move'].maxAttempts - 1)
    return history.since + SUPERVISOR_MOVE_POLICY.outsideCauseMs;
  return count === 0 ? history.since : history.since + SUPERVISOR_MOVE_POLICY.outsideProbeMs;
}

/**
 * Continue: only a laptop move, and only while its record offers it. For a move held by a cause outside itself
 * the continues are probes, spread over the wait for that cause (`outsideProbeAt`).
 */
function continueMoveGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy
): Gate {
  const move = observed.move;
  if (!move?.docker || !move.allowedActions.includes('continue-original')) return { kind: 'skip' };
  // A move cannot go on while the anchor of the pool is stopped: its laptops are stopped with it. No continue is
  // spent against that, and the wait has no end of its own (see `abandonMoveGate`).
  if (poolDown(observed)) return { kind: 'wait', waitingFor: POOL_WAIT };
  const outside = moveCauseOutside(observed);
  if (!outside || history.since <= 0) return { kind: 'ok' };
  const at = outsideProbeAt(history, policy);
  return now < at ? { kind: 'wait', waitingFor: outside, at } : { kind: 'ok' };
}

/**
 * A continue of this round was made after the wait for the outside cause was over. The ladder reaches the abandon
 * only once that continue's outcome has been watched, so the move being held now says that it found the cause
 * still there.
 */
function probedAfterWait(history: SupervisorHistory): boolean {
  const tried = history.attempts['continue-move'];
  return !!tried?.count && tried.lastAt >= history.since + SUPERVISOR_MOVE_POLICY.outsideCauseMs;
}

/**
 * Close the move: abandon a laptop move, or settle one of the retired runtime. Nothing about the error decides
 * whether, only when. What the record offers is not asked here: the service that closes the move decides that
 * itself and refuses in its own words, and a refusal spends one of the rung's few attempts.
 *
 * A move whose cause is outside itself is given `SUPERVISOR_MOVE_POLICY.outsideCauseMs` first, and is abandoned
 * only after a continue made once that time was over found the cause still there. Where this round's continues
 * were used up before that, by an earlier error of the same move, nothing is abandoned in this round: the next
 * round continues the move again first. A move that offers no continue cannot be probed and is abandoned when the
 * time is over.
 */
function abandonMoveGate(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy
): Gate {
  const move = observed.move;
  if (!move) return { kind: 'skip' };
  if (!move.docker) return { kind: 'ok' };
  // While the office's own look says the pool is down, as after a host restart, a move is not closed: nothing was
  // tried for it with a pool that works, and closing it would not bring the employee back any sooner, because no
  // laptop can be rebuilt or started either. Once the pool is back the move is continued as often as any other,
  // and closed after that if it is still held.
  if (poolDown(observed)) return { kind: 'wait', waitingFor: POOL_WAIT };
  const outside = moveCauseOutside(observed);
  if (!outside) return { kind: 'ok' };
  if (!moveCauseOverdue(history, now)) return outsideCauseWait(outside, history);
  if (!move.allowedActions.includes('continue-original') || probedAfterWait(history)) return { kind: 'ok' };
  const again = ladderRestartAt(history, policy);
  return {
    kind: 'wait',
    waitingFor: 'the next round of repair steps, which continues the move once more before it may be closed',
    ...(again === undefined ? {} : { at: again }),
  };
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
  if (laptop.restoration?.state === 'held') {
    const code = laptop.restoration.code;
    // With no read of the laptop made now, the office's last attempt to attach its terminal is all there is.
    if (seen?.state !== 'ready' || supervisorCodeKind(code) === 'viewer') return classifyCode(observed, code);
    // The laptop's own read, made now, says it is ready and its agent runs. The attach report is older and
    // narrower: whatever it says, what is wrong is the terminal, and nothing in it is a reason to touch the laptop.
    return classified(
      'viewer-lost',
      `${name}'s laptop is ready and its agent runs, but the office terminal is not connected to it.`,
      { code: code || 'viewer-disconnected', fingerprint: 'viewer:' + code }
    );
  }
  return classified('viewer-lost', `${name}'s agent is running, but the office terminal is not connected to it.`, {
    code: 'viewer-disconnected',
    fingerprint: 'viewer-disconnected',
  });
}

/**
 * What one observation is rolled into the history as: its classification, and what an idle pane says of work the
 * agent left running. Only an idle pane says anything about that, so every other reading leaves it out.
 */
export function sightEmployee(
  observed: SupervisorObservation
): SupervisorClassification & { readonly background?: boolean } {
  const { turn, background } = observed.session;
  return { ...classifyEmployee(observed), ...(turn === 'idle' ? { background: background === true } : {}) };
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
    // A sign-in the office puts back and an agent it starts again ask nobody for anything. The one thing it
    // cannot do is sign a plan in that is signed in nowhere, so that alone is said, as soon as it is known.
    if (screen.kind === 'credential')
      return classified('needs-sign-in', `${name} is waiting at ${screen.label}.`, {
        code: observed.planSignedIn === false ? 'plan-signed-out' : 'sign-in-screen',
        fingerprint,
        ...(observed.planSignedIn === false ? { needsHuman: signedOutAtOffice(observed) } : {}),
      });
    if (screen.kind === 'first-run' && screen.answering)
      return classified('waiting-first-run-screen', `${name} is starting: the office is answering ${screen.label}.`);
    // No screen is left to the owner. One the office could not answer is cleared by starting the agent again.
    return classified(
      'stuck-first-run-screen',
      `${name} is stuck at ${screen.label}, which the office could not answer.`,
      { code: 'first-run-screen', fingerprint }
    );
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

/** What is said while the office itself is signed out of the plan. Information: the office goes on trying. */
function signedOutAtOffice(observed: SupervisorObservation): string {
  return (
    `${plan(observed).replace(/^t/, 'T')} is not signed in at the office. Only the account holder can sign a plan in ` +
    '(Plans); the office never types a sign-in. While this laptop still holds a sign-in that works, the office ' +
    'starts the agent again with it. Otherwise it puts the sign-in into the laptop and starts the agent again once ' +
    'the plan is signed in.'
  );
}

/** What is said once neither the office nor the laptop is known to hold a sign-in of the plan that works. */
function signedOutEverywhere(observed: SupervisorObservation): string {
  return (
    `Neither the office nor this laptop holds a sign-in of ${plan(observed)} that works. Only the account holder ` +
    'can sign a plan in (Plans). The office never types a sign-in; once the plan is signed in, it puts the sign-in ' +
    'into this laptop and starts the agent again by itself.'
  );
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
  'needs-sign-in': ['replace-sign-in', 'relaunch-provider', 'rebuild-laptop'],
  'stuck-first-run-screen': ['relaunch-provider', 'rebuild-laptop'],
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
  /** `uncounted`: the rebuild this allows is not counted against the limit per day; see `stoppedFromOutside`. */
  | {
      readonly kind: 'ok';
      readonly preconditions?: readonly SupervisorPrecondition[];
      readonly uncounted?: boolean;
    }
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
 *
 * `daily: false` leaves the limit per day out. It is for one rebuild only: see `stoppedFromOutside`.
 */
function rebuildLimit(
  observed: SupervisorObservation,
  history: SupervisorHistory,
  now: number,
  policy: SupervisorPolicy,
  byHand: string,
  daily = true
): Gate | undefined {
  const layout = layoutGate(observed, byHand);
  if (layout || !daily) return layout;
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

/** Why a laptop is not rebuilt for a report that the laptop's own read does not bear out. */
const READY_AND_RUNNING =
  "the office's reports of this laptop to agree: the laptop's own read says it is ready and an agent runs in it, " +
  'or nothing the laptop itself reported says it is held, so it is not rebuilt';

/** A laptop code the office does not recognize is what holds this employee. */
function unrecognizedCode(base: Pick<SupervisorClassification, 'code' | 'fingerprint'>): boolean {
  // Read from the fingerprint: a hold that names no code at all is one the office does not recognize either.
  return base.fingerprint.startsWith('code:') && supervisorCodeKind(base.fingerprint.slice(5)) === undefined;
}

const FOREIGN_PROVIDER = 'DOCKER_CONTINUATION_FOREIGN_PROVIDER';

/**
 * What the laptop's own read reports is a reason to rebuild it although its agent runs and the office can reach
 * it: a code the table lists as settled by a rebuild, something the office did not start in the laptop's terminal,
 * or a code the table does not list, which was watched for `unrecognizedAfterMs` before it came this far. A code
 * that only the office's attach report carries is none of these.
 */
function rebuildCause(
  observed: SupervisorObservation,
  base: Pick<SupervisorClassification, 'code' | 'fingerprint'> | undefined
): boolean {
  const seen = observed.laptop.continuation,
    code = seen?.state === 'held' ? seen.code : undefined;
  if (!code) return false;
  const kind = supervisorCodeKind(code);
  return kind === 'rebuild' || code === FOREIGN_PROVIDER || (kind === undefined && base?.code === code);
}

/** The office terminal is attached to the agent's pane and reads it, so the agent can be reached. */
function paneRead(session: SupervisorObservation['session']): boolean {
  return session.turn === 'working' || (session.turn === 'idle' && session.idleSince !== undefined);
}

/** Why a held laptop whose agent can be reached is kept. */
const REACHABLE_AGENT =
  "the laptop's hold to clear: its agent runs and the office can reach it, and what holds the laptop is not " +
  'something a rebuild is known to settle, so the laptop is kept';

/**
 * "Between turns", as one rule: the office terminal shows the pane idle, and it has been silent for
 * `heldInputIdleMs`. The policy decides with it, and the step that stops the laptop asks it again itself
 * (`DockerSupervisorLaptops`), so the two cannot differ. A pane with no time on it is not a reading.
 */
export function paneQuiet(
  reading: Pick<SupervisorObservation['session'], 'turn' | 'idleSince'>,
  now: number,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): boolean {
  return (
    reading.turn === 'idle' && reading.idleSince !== undefined && now - reading.idleSince >= policy.heldInputIdleMs
  );
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
 * - The agent ended its turn with work left running: that is waited for until `backgroundGraceMs` after the office
 *   first saw it (`backgroundSince`), and then the idle laptop is rebuilt with it.
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
  const watched = watchedSince(history);
  // Work left running has a clock of its own, from when it was first seen. An agent parked on a start-up screen
  // has no conversation that could have started any, so what its pane shows is given the short wait only.
  const grace = proof.includes('agent-parked-at-screen') ? policy.heldInputTurnMs : policy.backgroundGraceMs,
    leftSince = history.backgroundSince,
    overdue = leftSince !== undefined && now - leftSince >= grace;
  const quiet = paneQuiet(observed.session, now, policy);
  if (quiet && (!background || overdue)) return { kind: 'ok', preconditions: proof };
  if (quiet)
    return {
      kind: 'wait',
      waitingFor: HELD_INPUT_BACKGROUND_WAIT,
      ...(leftSince === undefined ? {} : { at: leftSince + grace }),
    };
  if (turn === 'working' || (turn === 'idle' && idleSince !== undefined))
    return { kind: 'wait', waitingFor: HELD_INPUT_WAIT[turn] };
  // A laptop that this read shows to be empty never comes here: `rebuildGate` decides for it.
  if (observed.laptop.provider === undefined) return { kind: 'ok', preconditions: ['no-agent-running'] };
  const at = watched + policy.blindRebuildMs;
  if (watched > 0 && now >= at)
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

/** Details of a `replace-sign-in` step that the policy reads. Written by the office's step, compared here. */
export const SIGN_IN_NO_FOLDER = 'the laptop has no sign-in folder of this plan to read';
export const SIGN_IN_NOWHERE = 'no usable sign-in of this plan is held anywhere';

/**
 * Putting the sign-in back was already answered for good for this problem, so it is not repeated and the next step
 * is considered at once. Two answers say so: the laptop holds a usable sign-in and its agent still shows the
 * screen (a client reads its sign-in when it starts, so placing the file again changes nothing), or the laptop has
 * no sign-in folder of this plan to put one into (only a new laptop gets one). A later step that was tried for
 * this problem says the same, because it is only reached past this one. So does a read of the plan's copies that
 * was made since and found a usable sign-in in the laptop: there is nothing left to place.
 */
function signInAnswered(observed: SupervisorObservation, history: SupervisorHistory): boolean {
  if (observed.laptopSignedIn === true) return true;
  const last = history.lastAction;
  if (!last || last.at < history.since) return false;
  if (last.action === 'relaunch-provider' || last.action === 'rebuild-laptop') return true;
  if (last.action !== 'replace-sign-in' || history.attempts['replace-sign-in']?.lastAt !== last.at) return false;
  return last.outcome === 'done' || (last.outcome === 'refused' && last.detail === SIGN_IN_NO_FOLDER);
}

/**
 * No copy of the plan's sign-in is known to work. Either the last look at every copy found none that can be used
 * (the office's own included, whatever its Plans page says of it), or the office is signed out of the plan and the
 * last look did not find or place a usable one in the laptop. A new agent or a new laptop would stop at the same
 * screen. A later read that found a usable sign-in in the laptop ends it at once: the plan was signed in, and the
 * reconciler has put the sign-in there.
 */
function signedInNowhere(observed: SupervisorObservation, history: SupervisorHistory): boolean {
  if (observed.laptopSignedIn === true) return false;
  const last = history.lastAction;
  const looked = last && last.at >= history.since && last.action === 'replace-sign-in' ? last : undefined;
  if (looked?.outcome === 'refused' && looked.detail === SIGN_IN_NOWHERE) return true;
  return observed.planSignedIn === false && looked?.outcome !== 'done';
}

/**
 * Starting an agent again that is parked on a provider start-up screen: a relaunch inside its laptop where the
 * office can do that, otherwise a rebuild, which keeps the home directory and continues the saved conversation.
 *
 * An agent on such a screen is in no turn: it has not reached its composer, so nothing of a conversation is running
 * that the step could discard. That is not assumed from the screen's name. The step is taken under the rule of
 * every laptop an agent may run in (`betweenTurnsGate`: the pane idle and silent, work left running waited for),
 * with one more demand of its own:
 *
 * - the office knows the screen by more than its words (`proof`): the live widget on the frame, or a launch of
 *   its own that has not shown a composer since. A conversation that quotes a screen shows the same words, and
 *   nothing is restarted for words. The step proves the screen again itself (`agent-parked-at-screen`).
 *
 * A rebuild keeps the limits every rebuild keeps, and a laptop that a read shows to be empty is left to the rules
 * of an empty laptop, as for a held terminal input. An employee a plan move owns is left to the move.
 *
 * A sign-in screen of a plan that is signed in nowhere is not restarted: the new agent would stop at the same
 * screen. That is the one thing said to a person here, and the office goes on reading.
 */
function parkedScreenGate(
  action: 'relaunch-provider' | 'rebuild-laptop',
  observed: SupervisorObservation,
  history: SupervisorHistory,
  flags: SupervisorFlags,
  now: number,
  policy: SupervisorPolicy
): Gate {
  const screen = observed.session.startupScreen;
  if (!screen?.proof || !observed.boxed || observed.move) return { kind: 'skip' };
  const relaunch = action === 'relaunch-provider';
  if (relaunch && (!flags.relaunchAvailable || observed.laptop.record?.version === 3)) return { kind: 'skip' };
  if (screen.kind === 'credential' && signedInNowhere(observed, history))
    return relaunch ? { kind: 'skip' } : { kind: 'human', needsHuman: signedOutEverywhere(observed) };
  if (!relaunch) {
    const { turn = 'unknown', idleSince } = observed.session,
      provider = observed.laptop.provider;
    const unread = turn === 'unknown' || (turn === 'idle' && idleSince === undefined);
    if (unread && provider !== undefined && provider !== 'running' && provider !== 'unknown')
      return rebuildGate(observed, history, now, policy);
    const limit = rebuildLimit(observed, history, now, policy, REBUILD_RUNNING_BY_HAND);
    if (limit) return limit;
  }
  const between = betweenTurnsGate(observed, history, now, policy, ['agent-parked-at-screen']);
  // A relaunch discards nothing but the parked agent, and only with the screen proved: it never goes ahead on a
  // read of what runs in the laptop alone.
  return relaunch && between.kind === 'ok' && !between.preconditions?.includes('agent-parked-at-screen')
    ? { kind: 'wait', waitingFor: HELD_INPUT_WAIT.unknown }
    : between;
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
  // The limit per day is not asked of a laptop that may have been stopped from outside until the read that says
  // whether anything of this employee runs has been made: with a laptop running, it holds as for any other.
  const outside = holderStopped(observed) && (observed.laptop.provider ?? 'no-laptop') === 'no-laptop';
  const limit = rebuildLimit(observed, history, now, policy, REBUILD_BY_HAND, !outside);
  if (limit) return limit;
  const watched = watchedSince(history),
    settles = watched + policy.unrecognizedAfterMs;
  if (base && unrecognizedCode(base) && now < settles)
    return {
      kind: 'wait',
      waitingFor: `the code to clear by itself; if it still stands, the laptop is treated as held at ${when(settles)}`,
      at: settles,
    };
  const provider = observed.laptop.provider;
  if (provider === 'unknown' && !(watched > 0 && now - watched >= policy.stalledAfterMs))
    return { kind: 'wait', waitingFor: 'a confirmed read of what is running in the laptop' };
  if (provider === 'running' || provider === 'unknown') {
    // An agent runs there, or may. Such a laptop is rebuilt only for what the laptop itself reports: its own read,
    // made in this pass, must say that it is held or unfinished. A read that says ready, or no read at all, leaves
    // only the office's secondary reports (its last attach, a health reading), and none of those is a reason to
    // discard a laptop whose own read finds nothing wrong. The steps that discard nothing go on.
    if (!laptopHeld(observed).length) return { kind: 'wait', waitingFor: READY_AND_RUNNING };
    // A working agent is given up, between its turns, for a cause a rebuild is known to settle. For any other
    // hold (a step to send again, a read that never succeeds, a set-up that stopped) it is given up only when the
    // office cannot reach it at all: an employee nobody can talk to is not kept for the sake of a turn nobody sees.
    if (!rebuildCause(observed, base) && paneRead(observed.session))
      return { kind: 'wait', waitingFor: REACHABLE_AGENT };
    return betweenTurnsGate(observed, history, now, policy, ['agent-between-turns', 'laptop-held']);
  }
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
  const allowed: Gate = provider === 'no-laptop' && finished ? storedHomeGate(stored) : { kind: 'ok' };
  return allowed.kind === 'ok' && stoppedFromOutside(observed) ? { ...allowed, uncounted: true } : allowed;
}

const STORAGE_UNCONFIRMED = 'DOCKER_CONTINUATION_STORAGE_UNCONFIRMED';

/** The laptop's own read says the container that holds its home and Nix directories open is not running. */
function holderStopped(observed: SupervisorObservation): boolean {
  const seen = observed.laptop.continuation;
  return seen?.state === 'held' && seen.code === STORAGE_UNCONFIRMED;
}

/**
 * A laptop that was stopped from outside: a fresh read finds no laptop of this employee running, and the laptop's
 * storage holder is stopped as well. A holder runs nothing of the employee's and never stops with its laptop: a
 * laptop that crashes, is killed for memory or is stopped by hand leaves its holder running. Both are down
 * together after the host or the container engine restarted.
 *
 * Rebuilding such a laptop discards nothing that runs and says nothing about whether an earlier rebuild held: the
 * laptop did hold, and the host went down. So it is neither held back by the limit of rebuilds per day nor
 * counted against it (`uncounted`). Without this, a third host restart within a day would keep every employee out
 * of the office until the first of that day's rebuilds was a day old. Everything else a rebuild needs still
 * holds: the layout, the pool, the stored home, the attempts of a round and the switch for repairs.
 */
function stoppedFromOutside(observed: SupervisorObservation): boolean {
  return observed.laptop.provider === 'no-laptop' && holderStopped(observed);
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
 *
 * This gate is asked for the laptop a fresh read found stopped. A rebuild that reaches a stopped laptop by another
 * way (a laptop the office could not read for hours is rebuilt as one an agent may run in) meets the same read in
 * the step itself (`DockerSupervisorLaptops.rebuild`), which makes it for every stopped, finished laptop.
 */
function storedHomeGate(stored: SupervisorStoredHome | undefined): Gate {
  if (stored === 'renumbered') return { kind: 'human', needsHuman: STORED_HOME_RENUMBERED };
  if (stored === 'different') return { kind: 'human', needsHuman: STORED_HOME_DIFFERENT };
  if (stored === 'unknown') return { kind: 'wait', waitingFor: "a read of the laptop's stored home directory" };
  // Not read yet, or read and nothing found against it: the driver reads it where it has not, and the step is
  // told that it was asked for and reads it once more itself.
  return { kind: 'ok', preconditions: ['stored-home'] };
}

/**
 * The office's own look found the pool's anchor stopped, or a recovery of it open, and no other laptop of the box
 * is attached. A pool it could not read is not known to be down.
 */
function poolDown(observed: SupervisorObservation): boolean {
  return observed.laptop.pool === 'down' && observed.laptop.poolAlive !== true;
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
  heldInput = false,
  /** What this observation was classified as, for the rules that depend on its code. */
  base?: Pick<SupervisorClassification, 'code' | 'fingerprint'>
): Gate {
  const seen = observed.laptop.continuation;
  switch (action) {
    case 'resend-continuation': {
      // Offered by the operation itself, and never for a plan move's private record.
      const offered = seen?.allowedActions.filter((name) => RESENDABLE.includes(name)) ?? [];
      if (
        !observed.laptop.record ||
        observed.laptop.record.version === 3 ||
        !offered.length ||
        resendAnswered(offered, seen?.code, history)
      )
        return { kind: 'skip' };
      // No step of a set-up and no repair in place gets past a stopped anchor, so none is spent against one.
      return poolDown(observed) ? { kind: 'wait', waitingFor: POOL_WAIT } : { kind: 'ok' };
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
      // A fresh laptop cannot be set up while the pool's anchor is stopped or a recovery of it is open. Only a
      // look that found exactly that holds the start: a pool the office could not read is tried, as it always was.
      if (poolDown(observed)) return { kind: 'wait', waitingFor: POOL_WAIT };
      return observed.laptop.source === 'stopped' && observed.laptop.policyApproved
        ? { kind: 'ok' }
        : { kind: 'wait', waitingFor: 'a stopped laptop source and approved resource limits' };
    case 'continue-move':
      return continueMoveGate(observed, history, now, policy);
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
        observed.session.startupScreen?.kind === 'credential' &&
        !signInAnswered(observed, history)
        ? { kind: 'ok' }
        : { kind: 'skip' };
    case 'relaunch-provider':
      // An agent on a start-up screen is started again only on proof that it is parked there.
      if (observed.session.startupScreen) return parkedScreenGate(action, observed, history, flags, now, policy);
      return flags.relaunchAvailable && observed.laptop.record?.version !== 3 ? { kind: 'ok' } : { kind: 'skip' };
    case 'abandon-move':
      return abandonMoveGate(observed, history, now, policy);
    case 'rebuild-laptop':
      // A new laptop would join the same pool and be held by the same thing. The office goes on putting the
      // pool's limits back in place (see `EmployeeSupervisor`); the sentence is shown while it does.
      if (seen?.code && SHARED_POOL_CODES.has(seen.code)) return { kind: 'human', needsHuman: REPAIR_POOL_BY_HAND };
      if (observed.session.startupScreen) return parkedScreenGate(action, observed, history, flags, now, policy);
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
  'replace-sign-in': 'Switch them on and the office puts the sign-in back itself.',
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

/** What an employee waits for while the office terminal works through a provider's first-run screens. */
const FIRST_RUN_WAIT = 'the office to finish answering the start-up screen';

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
    clock = path === SUPERVISOR_STALLED_PATH ? { ...history, since: stalledFrom!, watchSince: stalledFrom! } : history;
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
    // A screen the office is answering has its own short clock: the scan ends within minutes, and the screen is
    // then gone or the agent is started again (`stuck-first-run-screen`). It is never called stalled.
    if (base.condition === 'waiting-first-run-screen') return result(idle(FIRST_RUN_WAIT));
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
    return result(
      { action, at, preconditions: allowed.preconditions ?? [], ...(allowed.uncounted ? { uncounted: true } : {}) },
      action,
      placing(action)
    );
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
 *
 * Two clocks count unbroken runs of observations and nothing else. `transitSince` counts the run of one starting or
 * between-states condition: a start that follows a plan move, a start-up screen or the wait for the office's own
 * restart begins its own run, so it is never called stalled for the time those took. `watchSince` counts the run
 * of one problem. Both end with any other observation, and neither survives an office start.
 */
export function rollSupervisorHistory(
  history: SupervisorHistory,
  seen: Pick<SupervisorClassification, 'condition' | 'fingerprint'> & {
    readonly code?: string;
    /** What an idle pane said of work left running; absent when no idle pane was read. See `sightEmployee`. */
    readonly background?: boolean;
  },
  now: number,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): SupervisorHistory {
  const rebuilds = history.rebuilds.filter((at) => now - at < DAY),
    // What every branch below carries on: the last step, and for a day the driver's office-wide mark.
    last = {
      ...(history.lastAction ? { lastAction: history.lastAction } : {}),
      ...(history.occupiedRebuildAt !== undefined && now - history.occupiedRebuildAt < DAY
        ? { occupiedRebuildAt: history.occupiedRebuildAt }
        : {}),
    },
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
  // Work left running keeps its first sighting while nothing says it has finished: a turn in progress and a pane
  // that is not read say nothing either way. An idle pane that shows none ends it.
  const leftSince =
    seen.background === true
      ? (history.backgroundSince ?? now)
      : seen.background === false
        ? undefined
        : history.backgroundSince;
  const kept = { attempts, rebuilds, ...last, ...(leftSince === undefined ? {} : { backgroundSince: leftSince }) };
  // In transit (starting, moving): the problem being worked on, if any, keeps its clock.
  if (seen.fingerprint === '') {
    const transitOf = transitKey(seen),
      running = history.transitOf === transitOf && history.transitSince !== undefined;
    return {
      fingerprint: history.fingerprint,
      since: history.since,
      transitSince: running ? history.transitSince : now,
      transitOf,
      ...kept,
    };
  }
  const same = seen.fingerprint === history.fingerprint;
  return {
    fingerprint: seen.fingerprint,
    since: same ? history.since : now,
    watchSince: same ? (history.watchSince ?? now) : now,
    ...kept,
  };
}

/**
 * The starting or between-states condition a run of `transitSince` counts. The wait for the office's own restart is
 * a state of its own: it is not the laptop that is starting.
 */
function transitKey(seen: { readonly condition: SupervisorCondition; readonly code?: string }): string {
  return seen.code === RUNTIME_CHANGED ? `${seen.condition}:office-restart` : seen.condition;
}

/**
 * Since when this office process has watched the current problem without a break. Every wait that ends in a laptop
 * being discarded is measured from here: the thirty minutes of an unrecognized code, the fifteen of a laptop that
 * cannot be read and the two hours of a pane that cannot be read. Work left running has its own (`backgroundSince`). A history that
 * was never rolled has no such clock, and then the problem's own start is all there is.
 */
function watchedSince(history: SupervisorHistory): number {
  return history.watchSince ?? history.since;
}

/**
 * A history as an office that has just started may use it. What paces the ladder is kept, so a restart cannot
 * repeat a step for free: the problem and when it was first seen, the attempts, the day's rebuilds and the last
 * step. The clocks that count how long this office has WATCHED a state are dropped, and each starts again at the
 * first observation of that state: while the office was down it watched nothing and tried nothing, and for a
 * minute after every start each employee reads as starting while their terminal is attached again. Without this a
 * bound could be met at the first look after a restart, and a laptop be rebuilt that the office had not tried to
 * read. The healthy clock is dropped for the same reason: ten healthy minutes are ten minutes that were seen.
 *
 * One attempt is given back: see `continueGivenBack`. A step that was issued and never settled is settled here:
 * see `settleInterrupted`.
 */
export function resumeSupervisorHistory(
  history: SupervisorHistory,
  policy: SupervisorPolicy = SUPERVISOR_POLICY
): SupervisorHistory {
  const {
    transitSince: _transitSince,
    transitOf: _transitOf,
    watchSince: _watchSince,
    healthySince: _healthySince,
    backgroundSince: _backgroundSince,
    ...kept
  } = history;
  return continueGivenBack(settleInterrupted(kept), policy);
}

/** Said of a step whose outcome the office process that issued it did not live to record. */
export const INTERRUPTED_BY_RESTART = 'interrupted by an office restart';

/**
 * A step is recorded as issued before its effect and settled when it returns. An office that stops in between
 * leaves it issued, and no later process would ever settle it: every rule that reads how the last step ended would
 * wait for an outcome that cannot come. The new process cannot know how far the step got, so it is settled as
 * failed, with the attempt still spent. A rebuild is the one step whose effect is rationed by the day, so an
 * interrupted one is counted as carried out: the limit must not be passed because the office fell over.
 */
function settleInterrupted(history: SupervisorHistory): SupervisorHistory {
  const last = history.lastAction;
  if (last?.outcome !== 'issued') return history;
  const settled = settleSupervisorAttempt(history, 'failed', INTERRUPTED_BY_RESTART);
  return last.action === 'rebuild-laptop' && !last.uncounted
    ? { ...settled, rebuilds: [...settled.rebuilds, last.at].slice(-8) }
    : settled;
}

/**
 * A held plan move whose continues an earlier office process used up gets one of them back at an office start.
 *
 * The time before a move is abandoned is counted from when its error was first seen, across restarts. Without this,
 * a move whose continues were used before the restart would be abandoned at the new process's first look, although
 * a restart puts right some of what stops a move: it attaches every terminal again and reads the laptop
 * configuration afresh. So the new process continues the move once itself, watches that, and only then may close
 * it. It is one attempt, given back at most once in a round (`resumed`, which ends with the round's counts), so an
 * office that keeps restarting cannot continue a move for ever: from its second start on, the move is closed as it
 * was before. A continue repeats no paid step, whoever asks for it.
 */
function continueGivenBack(history: SupervisorHistory, policy: SupervisorPolicy): SupervisorHistory {
  const tried = history.attempts['continue-move'],
    max = policy.ladder['continue-move'].maxAttempts;
  if (!history.fingerprint.startsWith('move:') || !tried || tried.resumed || tried.count < max || max < 1)
    return history;
  return {
    ...history,
    attempts: { ...history.attempts, 'continue-move': { count: max - 1, lastAt: tried.lastAt, resumed: true } },
  };
}

/** Count one attempt, before its effect: a throw or an office restart in the middle has still spent it. */
export function issueSupervisorAttempt(
  history: SupervisorHistory,
  action: SupervisorAction,
  at: number,
  /** `SupervisorNextStep.uncounted` of the step that is issued. */
  uncounted = false
): SupervisorHistory {
  const before = history.attempts[action]?.count ?? 0;
  return {
    ...history,
    attempts: { ...history.attempts, [action]: { ...history.attempts[action], count: before + 1, lastAt: at } },
    lastAction: {
      action,
      at,
      outcome: 'issued',
      ...(uncounted && action === 'rebuild-laptop' ? { uncounted: true as const } : {}),
    },
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
        ? { ...history.attempts, [last.action]: { ...spent, count: Math.max(0, spent.count - 1) } }
        : history.attempts,
    rebuilds:
      last.action === 'rebuild-laptop' && outcome === 'done' && !last.uncounted
        ? [...history.rebuilds, last.at].slice(-8)
        : history.rebuilds,
    lastAction: {
      action: last.action,
      at: last.at,
      outcome,
      ...(detail ? { detail: clip(detail, 300) } : {}),
      ...(last.uncounted ? { uncounted: true as const } : {}),
    },
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
