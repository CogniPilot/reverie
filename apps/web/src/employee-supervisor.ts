/**
 * @fileoverview The office recovery supervisor's driver.
 *
 * On every tick it reads each employee who should be running, asks the pure policy (`employee-supervisor-policy.ts`)
 * for one condition and one next step, and runs that step through its ports. The ports are the same application
 * services the owner's routes call; this class holds no Engine, no session and no HTTP client.
 *
 * Bounds it keeps itself:
 * - one tick at a time, and at most one action per employee per tick;
 * - never a second action for an employee while an earlier one has not returned;
 * - a small number of actions per tick, and none in the first moments after the office starts;
 * - an attempt is persisted BEFORE its effect, so an office restart cannot repeat a step for free;
 * - an employee the owner stopped or sent out of the office is never read through a port, let alone acted on,
 *   with one exception that is no repair step: keeping approved limits in place (below).
 *
 * Keeping limits. A reload of the host's service manager resets the limits a helper wrote on every running laptop,
 * whoever it belongs to. So beside the ladder, at most once per pass and once per `limitsCheckMs` for each
 * employee, the supervisor asks the `keepLimits` port to put the approved limits of a finished, running laptop back.
 * It is asked for every employee whose laptop may be running, whatever their attendance and whatever their condition
 * reads: a laptop keeps running through most of what the ladder repairs (a lost terminal, a start-up screen, a
 * handoff that is still owed), and the reload resets its limits all the same. The port itself finds out whether
 * the laptop is finished and running and whether a set-up step, a rebuild or another repair of it is in flight. It
 * writes only values the owner already approved, attaches nothing, starts nothing, changes no attendance and spends
 * no attempt of the ladder. One state is left out: while a step of a plan move is running, the move owns the laptop.
 *
 * Keeping the pool. All laptops share one pool, and its anchor does not survive a host restart: every laptop and
 * the anchor are then stopped, and no laptop can be set up before the anchor runs again. That is no employee's
 * problem, so it is no rung of anyone's ladder. Before the employees of a pass are looked at, and only while no
 * employee who should be in the office has an attached terminal, the supervisor asks the `keepPool` port for one
 * look at the pool: at most every `poolReadMs`. The first look only reads. A later look may take the one step the
 * earlier one found (recover the stopped pool, finish a recovery that did not finish, record the pool's
 * observation), no earlier than `poolDwellMs` after the pool was first seen that way and with `poolBackoffMs`
 * between attempts. The last backoff repeats: the step is tried again for as long as the pool is down, and nothing
 * here ever stops for good. What the look found is given to every employee's assessment as `laptop.pool`, so their
 * rebuilds and starts wait for the pool instead of spending attempts against it. The service behind the port
 * refuses to recover a pool cold while any laptop of the box runs; the supervisor never decides that, and never
 * takes a read that failed for a stopped pool.
 *
 * Keeping the office from rebuilding every laptop at once. The policy decides for one employee and knows nothing of
 * the others, so a fault of the office itself, or of something all laptops share, looks to it like the same fault
 * in each laptop. The driver knows all employees and holds a brake on the one step that can cost a working agent
 * its turn, the rebuild of a laptop an agent runs in (`#officeBrake`): one such rebuild an hour across the office,
 * kept across restarts; none for a pane the office cannot read while it reads no laptop at all, in which case it
 * asks for its own restart; and for a cause that several employees share, one laptop as a probe, and no other
 * before that one is healthy again.
 */
import {
  EMPTY_SUPERVISOR_HISTORY,
  assessEmployee,
  classifyEmployee,
  issueSupervisorAttempt,
  newSupervisorRound,
  officeReading,
  resumeSupervisorHistory,
  sightEmployee,
  rollSupervisorHistory,
  settleSupervisorAttempt,
  type SupervisorAction,
  type SupervisorAssessment,
  type SupervisorCondition,
  type SupervisorHistory,
  type SupervisorObservation,
  type SupervisorOutcome,
  type SupervisorPolicy,
  type SupervisorPrecondition,
  type SupervisorProviderPresence,
  type SupervisorStoredHome,
  type SupervisorStoredHomeCause,
  SUPERVISOR_OCCUPIED_PROOFS,
  SUPERVISOR_POLICY,
} from './employee-supervisor-policy.js';

/** The identity of one employee as the company records it right now. */
export interface SupervisedEmployee {
  readonly id: string;
  readonly name: string;
  readonly owner: string | undefined;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly desiredRunning: boolean | undefined;
  readonly onVacation: boolean;
  readonly bindingMigration: boolean;
  /** The subscription plan the employee should run on, when it is one. */
  readonly planAccountId?: string;
  readonly planLabel?: string;
}

export type SupervisorMove = NonNullable<SupervisorObservation['move']> & { readonly toAccount?: string };
export type SupervisorLaptopReading = NonNullable<SupervisorObservation['laptop']['continuation']>;
export interface SupervisorActionResult {
  readonly outcome: Exclude<SupervisorOutcome, 'issued'>;
  /** A code or a short phrase. Never a credential, a path or terminal text. */
  readonly detail?: string;
}
/** Throws once the supervisor may no longer act for this employee. Every port effect rechecks it. */
export type SupervisorGuard = () => void;

/**
 * A plain fact about an employee's running laptop, read inside it: whether anything of the employee runs there
 * besides the agent and the laptop's own fixed processes (a job that was started detached, a tmux server of
 * their own). A rebuild would end it. `unknown`: the read could not be made or gave no answer, which is never
 * `false`. With `true`: how many such processes, and the names of up to five. `cpu`: what the whole laptop used
 * of the CPU between this read and the one before it, when there was one. `at`: when it was read.
 *
 * The driver puts it on the observation as `laptop.otherWork` (the three-valued fact) and
 * `laptop.otherWorkDetail` (all of this), and on the report as `otherWork`. No rule of the policy reads it yet.
 */
export interface SupervisorOtherWork {
  readonly otherWork: true | false | 'unknown';
  readonly processes?: number;
  readonly names?: readonly string[];
  readonly cpu?: { readonly usedMs: number; readonly overMs: number };
  readonly at: number;
}

/** One read of a stopped laptop's stored home: what was found, and why where the finding has a cause. */
export interface SupervisorStoredHomeReading {
  readonly found: SupervisorStoredHome;
  readonly cause?: SupervisorStoredHomeCause;
}
/** The step a look at the shared pool calls for. */
export type SupervisorPoolStep = 'recover-pool' | 'finish-pool-recovery' | 'reconcile-pool' | 'remove-dead-anchor';
/** What one look at the shared pool found, and how the one step it took ended, when it took one. */
export interface SupervisorPoolResult {
  /**
   * `up`: the pool's anchor runs and no recovery is open, so a laptop can be set up. `down`: the anchor is stopped
   * or a recovery is open. `unknown`: the pool could not be read; it is never taken for stopped. `none`: no
   * laptop record names a pool, as in an office that never finished a laptop, so there is nothing to recover and
   * a laptop set-up creates it.
   */
  readonly pool: 'up' | 'down' | 'unknown' | 'none';
  /** The step this look would take, or took. */
  readonly step?: SupervisorPoolStep;
  /** How the step ended. Absent when none was taken. */
  readonly outcome?: SupervisorActionResult['outcome'];
  /** A code or a short phrase. Never a credential, a path or terminal text. */
  readonly detail?: string;
  /** The employee whose laptop record stood for the pool. */
  readonly employeeId?: string;
}
/** A guard for one employee whose record stands for the pool. `repair` also needs the owner's switch for repairs. */
export type SupervisorPoolGuard = (employee: SupervisedEmployee, tier: 'retry' | 'repair') => SupervisorGuard;
/** The last look at the shared pool, for reports. DATA only. */
export interface SupervisorPoolReport {
  readonly pool: SupervisorPoolResult['pool'];
  /** The step the pool calls for now. */
  readonly step?: SupervisorPoolStep;
  /** The code or phrase of the last look. */
  readonly detail?: string;
  readonly at: number;
  /** When the pool was first seen as it is now. */
  readonly since: number;
  /** Steps taken since then. */
  readonly attempts: number;
  /** Since when the pool has not been up, without a break. Absent while it is up, or there is none. */
  readonly downSince?: number;
  /** When the office looks at the pool again. */
  readonly nextLookAt?: number;
  /** The earliest time at which the office takes `step`. */
  readonly stepAt?: number;
  /** `step` needs the owner's switch for repairs (`supervisorAutoRepair`), and it is off: the step is not taken. */
  readonly stepNeedsRepairSwitch?: true;
  /** The last step that was taken for the pool, and how it ended. */
  readonly last?: {
    readonly step: SupervisorPoolStep;
    readonly at: number;
    readonly outcome: SupervisorActionResult['outcome'];
    readonly detail?: string;
  };
}

export interface SupervisorAuditEntry {
  readonly admin: 'office supervisor';
  readonly action: string;
  readonly target: string;
  readonly detail: Record<string, unknown>;
}

export interface EmployeeSupervisorPorts {
  now(): number;
  /** The office has restored its sessions and its laptop runtime is current. */
  ready(): boolean;
  /**
   * What the office is doing about not being ready, when it is doing something that takes a while (it restarts
   * itself after its laptop configuration changed). Shown on every employee, because nothing is checked meanwhile.
   */
  notReady?(): string | undefined;
  employees(): readonly SupervisedEmployee[];
  /** The owner's two switches. */
  flags(owner: string | undefined): { readonly enabled: boolean; readonly autoRepair: boolean };
  /** Everything that is already in memory. No Engine call and no await. */
  glance(employee: SupervisedEmployee): Omit<SupervisorObservation, 'move' | 'planSignedIn' | 'laptopSignedIn'>;
  openMove(employee: SupervisedEmployee): Promise<SupervisorMove | undefined>;
  planSignedIn?(accountId: string): Promise<boolean | undefined>;
  /**
   * The office's own restart, for a fault that looks like the office's and not any laptop's: it reads none of its
   * laptops. `request` is called on every pass while that stands; the restart keeps its own conditions and limits
   * (office-self-restart.ts), and `refused` says that this office never restarts itself. `lastAt` is when it last
   * did, from the record that survives the restart. Absent where the office cannot restart itself at all.
   */
  readonly officeRestart?: {
    request(reason: string): 'pending' | 'refused';
    lastAt(): number | undefined;
  };
  /**
   * Whether the last read of the employee's plan sign-in copies found a usable one in their laptop. From memory:
   * no read is made for it. `undefined` when no recent read says.
   */
  laptopSignedIn?(employee: SupervisedEmployee): boolean | undefined;
  /** The owner's observe read of the laptop set-up. */
  readLaptop(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorLaptopReading | undefined>;
  /** The stopped source a set-up would start from, for an employee with no record. */
  readSource(
    employee: SupervisedEmployee,
    guard: SupervisorGuard
  ): Promise<'stopped' | 'running' | 'absent' | 'outdated' | 'unknown'>;
  /** Fresh positive read of what runs in the employee's laptops. */
  readProvider(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorProviderPresence>;
  /** Read inside the employee's running laptop. See `SupervisorOtherWork`. Absent where the office cannot. */
  readOtherWork?(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorOtherWork>;
  /**
   * Put the approved limits of this employee's finished, running laptop back in place, wherever the employee is.
   * `done` with `unchanged`, `restored` or `not-running`; undefined when the employee has no finished laptop.
   * Absent where the office has no laptops.
   */
  keepLimits?(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorActionResult | undefined>;
  /**
   * One look at the pool every laptop shares. With `step`, that step is taken when this look calls for exactly
   * it; a look that calls for another one only says so. `candidates` are the employees whose laptop record may
   * stand for the pool, those in the office first. Absent where the office has no laptops.
   */
  keepPool?(
    candidates: readonly SupervisedEmployee[],
    guard: SupervisorPoolGuard,
    step?: SupervisorPoolStep
  ): Promise<SupervisorPoolResult>;
  /** A fresh read of the stored home of this employee's stopped laptop. Absent where the office cannot read one. */
  readStoredHome?(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorStoredHomeReading>;
  /**
   * What the office checks of a stored home with the verifier image it is configured with: `full`, `compare-only`
   * (an unchanged home is confirmed; a changed one cannot be told apart and is never rebuilt on), `image-missing`
   * (nothing can be confirmed, so no stopped laptop is rebuilt), `unknown` (not found out yet) or `none` (no
   * verifier is configured, and a stopped laptop is rebuilt by its recorded path).
   */
  storedHomeCheck?(): 'none' | 'full' | 'compare-only' | 'image-missing' | 'unknown';
  /**
   * Record which filesystem this employee's running laptop has its home on, for a later proof. `recorded`,
   * `not-running` (no finished laptop runs), `not-recorded` (the read found nothing a proof could use),
   * `unsupported` (no verifier that can make the read) or `failed`. Absent where the office has no laptops.
   */
  rememberHome?(
    employee: SupervisedEmployee,
    guard: SupervisorGuard
  ): Promise<'recorded' | 'not-running' | 'not-recorded' | 'unsupported' | 'failed'>;
  /**
   * One effect each. A port that is absent is a step this office cannot take. `proved` is what the policy asked to
   * be proved again for this step and still stood when it was issued; a step whose effect depends on it proves it
   * once more itself, last. Absent means nothing was proved.
   */
  readonly actions: {
    readonly [K in SupervisorAction]?: (
      employee: SupervisedEmployee,
      guard: SupervisorGuard,
      move: SupervisorMove | undefined,
      proved?: readonly SupervisorPrecondition[]
    ) => Promise<SupervisorActionResult>;
  };
  load(): Map<string, SupervisorHistory>;
  save(histories: ReadonlyMap<string, SupervisorHistory>): Promise<void>;
  audit(entry: SupervisorAuditEntry): void;
  log(line: string): void;
}

export interface EmployeeSupervisorLimits {
  /** Effectful actions started in one tick, across all employees. */
  readonly actionsPerTick: number;
  /** No pass at all this long after the supervisor was created: the office is still reattaching its laptops, and
   * starting the office must change nothing by itself. */
  readonly startupGraceMs: number;
  /** How long one tick waits for an action before it moves on. The action keeps its seat until it returns. */
  readonly actionWaitMs: number;
  /** How often the laptop of an employee with no step pending (waiting for a person, unknown) is read again. */
  readonly idleReadMs: number;
  /** How often the approved limits of one employee's running laptop are checked, and put back when they are gone. */
  readonly limitsCheckMs: number;
  /** How often the shared pool is looked at while no employee's terminal is attached. */
  readonly poolReadMs?: number;
  /** The pool must have been seen the same way this long before the first step is taken for it. */
  readonly poolDwellMs?: number;
  /** Wait after pool step N before step N+1. The last value repeats for as long as the pool needs a step. */
  readonly poolBackoffMs?: readonly number[];
  /** How long a finding that stops a rebuild for the stored home (renumbered, different) stands before it is read again. */
  readonly storedHomeReadMs?: number;
  /** Wait after read N of a stored home that could not tell, before read N+1. The last value repeats. */
  readonly storedHomeRetryMs?: readonly number[];
  /** The return of a stopped pool begins a new round of repair steps for everyone at most this often. */
  readonly poolRoundMs?: number;
  /** How many employees' running laptops have their home recorded in one pass. */
  readonly homeRecordsPerTick?: number;
  /** Wait after attempt N to record a home that was not recorded, before attempt N+1. The last value repeats. */
  readonly homeRecordRetryMs?: readonly number[];
  /** Least time, across the office, between two rebuilds of laptops that an agent runs in or may run in. */
  readonly occupiedRebuildSpacingMs?: number;
  /** A cause that several employees share must have been shared this long before one laptop is rebuilt as a probe. */
  readonly sharedCauseProbeMs?: number;
  /** After this long without reading any laptop, the office asks for its own restart. */
  readonly officeBlindRestartMs?: number;
  /** A restart of the office no longer ago than this counts as tried for the fault that stands now. */
  readonly officeRestartTriedMs?: number;
}
export const SUPERVISOR_LIMITS: Required<EmployeeSupervisorLimits> = {
  actionsPerTick: 2,
  startupGraceMs: 90_000,
  actionWaitMs: 5 * 60_000,
  idleReadMs: 2 * 60_000,
  limitsCheckMs: 10 * 60_000,
  poolReadMs: 60_000,
  poolDwellMs: 60_000,
  // Nobody can be brought back while the pool is stopped, so the step is never left alone for longer than an hour.
  poolBackoffMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
  storedHomeReadMs: 10 * 60_000,
  storedHomeRetryMs: [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000],
  poolRoundMs: 10 * 60_000,
  homeRecordsPerTick: 2,
  homeRecordRetryMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
  occupiedRebuildSpacingMs: 60 * 60_000,
  sharedCauseProbeMs: 30 * 60_000,
  officeBlindRestartMs: 30 * 60_000,
  officeRestartTriedMs: 6 * 60 * 60_000,
};
/** Which of the owner's two switches each pool step needs. Starting the stopped anchor is a repair. */
const POOL_STEP_TIER: Readonly<Record<SupervisorPoolStep, 'retry' | 'repair'>> = {
  'recover-pool': 'repair',
  'finish-pool-recovery': 'repair',
  'reconcile-pool': 'retry',
  // Removing the anchor that the Engine reports dead discards a container: a repair.
  'remove-dead-anchor': 'repair',
};
/** Said once with a pool step that needs the switch for repairs: what happens with it on, and the calls with it off. */
const POOL_REPAIR_NOTE =
  ' (taken by the office itself while the company setting supervisorAutoRepair is on; by hand: GET ' +
  '/api/company/employees/:id/docker-pool/cold-preview, then POST …/docker-pool/cold-recover, or POST ' +
  '…/docker-pool/cold-resume for a recovery that did not finish)';
/** Findings about a stored home that stop a rebuild, and the one that says nothing was read. */
const STORED_HOME_HELD = new Set<SupervisorStoredHome>(['renumbered', 'different', 'changed', 'unknown']);
/** The proofs under which a rebuild discards a laptop whose agent may be in a conversation. */
const WORKING_AGENT_PROOFS: readonly SupervisorPrecondition[] = [
  'terminal-input-held',
  'agent-between-turns',
  'agent-unreadable',
];
const OFFICE_BLIND = 'the office reads none of its laptops although the container engine says that they run';
/** How long the engine's word that a laptop runs with an agent in it stands without being heard again. */
const RUNNING_SEEN_MS = 5 * 60_000;
/** A time as a sentence names it, as the policy writes it. */
function when(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
/** What holds one employee, as the office compares it between employees. Empty for one nothing holds. */
function causeOf(assessment: Pick<SupervisorAssessment, 'condition' | 'fingerprint' | 'code'>): string {
  if (assessment.condition === 'healthy' || assessment.condition === 'owner-stopped') return '';
  return assessment.fingerprint || 'state:' + (assessment.code ?? assessment.condition);
}
/** A limits check that found the employee busy is asked again this soon. */
const LIMITS_BUSY_RETRY_MS = 60_000;

/** The last check of the approved limits of one employee's laptop. */
export interface SupervisorLimitsReport {
  readonly at: number;
  readonly outcome: SupervisorActionResult['outcome'];
  /** `unchanged`, `restored` or `not-running` when it was done; otherwise the code or phrase of the refusal. */
  readonly detail?: string;
}

/** What `GET /api/company` shows for one employee. */
export interface SupervisorReport {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly condition: SupervisorCondition;
  readonly sentence: string;
  /** The raw code behind the condition, for tooltips. */
  readonly code?: string;
  /** When this problem was first seen. Absent while there is none. */
  readonly since?: number;
  readonly checkedAt: number;
  /** What the supervisor last did for this employee, and how that ended. */
  readonly last?: SupervisorHistory['lastAction'];
  /** What it will do next and no earlier than when. */
  readonly next?: { readonly action: SupervisorAction; readonly at: number };
  /** Why it is not doing anything right now. */
  readonly waitingFor?: string;
  /** When that wait ends by itself, where it is known: a limit lifts, or the repair steps start again. */
  readonly waitingUntil?: number;
  /** What a person or a managing agent has to do, when the supervisor will not. */
  readonly needsHuman?: string;
  /** The last check of the laptop's approved limits, for an employee who has a finished laptop. */
  readonly limits?: SupervisorLimitsReport;
  /** The office's last look at the shared pool, while no terminal is attached and it is looking. */
  readonly pool?: SupervisorPoolReport;
  /** What the office checks of a stopped laptop's stored home with the verifier image it has. */
  readonly storedHomeCheck?: ReturnType<NonNullable<EmployeeSupervisorPorts['storedHomeCheck']>>;
  /** The last read of other work in the employee's running laptop. See `SupervisorOtherWork`. */
  readonly otherWork?: SupervisorOtherWork;
}

class SupervisorStopped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SupervisorStopped';
  }
}

/** Conditions that are settled from memory alone: nothing is gained by reading the laptop. */
const NO_LAPTOP_READ = new Set<SupervisorCondition>([
  'healthy',
  'owner-stopped',
  'move-in-progress',
  'move-held-retryable',
  'waiting-first-run-screen',
  'stuck-first-run-screen',
  'needs-sign-in',
]);

export class EmployeeSupervisor {
  readonly #histories: Map<string, SupervisorHistory>;
  readonly #reports = new Map<string, SupervisorReport>();
  /** Employees with an action that has not returned yet. */
  readonly #acting = new Map<string, Promise<void>>();
  readonly #announced = new Map<string, string>();
  readonly #readings = new Map<string, { at: number; operationId: string; reading: SupervisorLaptopReading }>();
  /** The observation being assessed reused a kept laptop reading. Only read within one pass. */
  #reused = false;
  /** The last read that found a laptop occupied or unreadable. Never one that found it empty. */
  readonly #occupied = new Map<string, { at: number; presence: 'running' | 'unknown' }>();
  /** The last read of other work in each employee's running laptop, made with the read of what runs there. */
  readonly #otherWork = new Map<string, SupervisorOtherWork>();
  /** The last limits check of each employee, and when the next one is due. In memory: a restart checks again. */
  readonly #limits = new Map<string, SupervisorLimitsReport>();
  readonly #limitsDue = new Map<string, number>();
  /** The last look at the shared pool. Undefined while a terminal is attached, when nobody looks. In memory. */
  #pool?: SupervisorPoolReport;
  /** The owner whose switches the pool step was last decided with. */
  #poolOwner: string | undefined;
  #poolDue = 0;
  #poolLastStep = 0;
  /** A look found the pool stopped since it was last up. */
  #poolWasDown = false;
  /** When the return of the pool last began a new round for everyone. */
  #poolRoundAt = Number.NEGATIVE_INFINITY;
  #poolFlight?: Promise<void>;
  /** The last read of a stored home that stopped a rebuild or failed. Never one that allowed it. */
  readonly #storedHome = new Map<
    string,
    { at: number; found: SupervisorStoredHome; cause?: SupervisorStoredHomeCause; since: number; reads: number }
  >();
  /**
   * The laptop operation whose home was last asked to be recorded for each employee, whether that was done, and
   * how often it was tried without. In memory: an office start records every running laptop again.
   */
  readonly #homeRecords = new Map<string, { operationId: string; at: number; done: boolean; tries: number }>();
  readonly #resolved: Required<EmployeeSupervisorLimits>;
  /** What holds each employee in the office, from their last report. Compared between employees. In memory. */
  readonly #causes = new Map<string, string>();
  /** Since when each cause has been shared by more than one employee in the office. In memory. */
  readonly #sharedSince = new Map<string, number>();
  /** Since when the office has read none of its laptops while something holds an employee. In memory. */
  #blindSince?: number;
  #restartAnswer?: 'pending' | 'refused';
  /** What each employee's laptop said, at their last look, about whether the office reads its laptops. In memory. */
  readonly #reading = new Map<string, ReturnType<typeof officeReading>>();
  /** When the engine last reported each employee's laptop running with an agent in it. In memory. */
  readonly #runningSeen = new Map<string, number>();
  /** Employees a plan move or another operation of the office's own holds, at their last look. In memory. */
  readonly #operating = new Set<string>();
  readonly #startedAt: number;
  #flight?: Promise<void>;
  #closed = false;
  #dirty = false;

  constructor(
    private readonly ports: EmployeeSupervisorPorts,
    private readonly policy: SupervisorPolicy = SUPERVISOR_POLICY,
    private readonly limits: EmployeeSupervisorLimits = SUPERVISOR_LIMITS
  ) {
    // The pacing is kept across an office start; the clocks that count what this process has watched are not.
    this.#histories = new Map([...ports.load()].map(([id, history]) => [id, resumeSupervisorHistory(history, policy)]));
    this.#startedAt = ports.now();
    this.#resolved = { ...SUPERVISOR_LIMITS, ...limits };
  }

  /** The last look at the shared pool, while the supervisor is looking. DATA only. */
  pool(): SupervisorPoolReport | undefined {
    return this.#pool;
  }

  /** The latest report for each employee of one owner. DATA only. */
  reports(owner: string | undefined): readonly SupervisorReport[] {
    const ids = new Set(
      this.ports
        .employees()
        .filter((employee) => employee.owner === owner)
        .map((employee) => employee.id)
    );
    return [...this.#reports.values()].filter((report) => ids.has(report.employeeId));
  }

  /** Stop deciding. Actions already running finish under their own guards, which now refuse. */
  close(): void {
    this.#closed = true;
  }

  /** One pass over every employee. A pass that is still running is joined, never doubled. Never rejects. */
  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    const flight = this.#pass()
      .catch((error: unknown) => this.ports.log(`[supervisor] pass failed: ${describe(error)}`))
      .finally(() => {
        if (this.#flight === flight) this.#flight = undefined;
      });
    this.#flight = flight;
    return flight;
  }

  async #pass(): Promise<void> {
    if (this.#closed) return;
    if (!this.ports.ready()) return this.#unready();
    if (this.ports.now() - this.#startedAt < this.limits.startupGraceMs) return;
    const employees = this.ports.employees();
    const known = new Set(employees.map((employee) => employee.id));
    for (const id of [...this.#histories.keys()]) if (!known.has(id)) this.#forget(id);
    for (const id of [...this.#reports.keys()])
      if (!known.has(id)) {
        this.#reports.delete(id);
        this.#announced.delete(id);
        this.#readings.delete(id);
        this.#occupied.delete(id);
        this.#otherWork.delete(id);
        this.#storedHome.delete(id);
      }
    for (const id of [...this.#limitsDue.keys()])
      if (!known.has(id)) {
        this.#limitsDue.delete(id);
        this.#limits.delete(id);
      }
    for (const id of [...this.#homeRecords.keys()]) if (!known.has(id)) this.#homeRecords.delete(id);
    // Whoever was acted on longest ago goes first, so one noisy employee cannot take every seat. Among employees
    // who are level, as all are after a host restart, the order the office gives them is kept: that is its
    // start-up order (employee-startup-order.ts). The seats of a pass space them out.
    const place = new Map(employees.map((employee, index) => [employee.id, index]));
    const order = [...employees].sort(
      (a, b) =>
        (this.#histories.get(a.id)?.lastAction?.at ?? 0) - (this.#histories.get(b.id)?.lastAction?.at ?? 0) ||
        place.get(a.id)! - place.get(b.id)!
    );
    if (!this.#closed) await this.#keepPool(employees);
    this.#lookAtOffice(employees);
    let seats = this.limits.actionsPerTick;
    for (const employee of order) {
      if (this.#closed) break;
      try {
        if (await this.#one(employee, seats > 0)) seats--;
      } catch (error) {
        this.ports.log(`[supervisor] ${employee.name} (${employee.id}): could not be checked: ${describe(error)}`);
      }
    }
    if (!this.#closed) await this.#keepLimits(employees);
    if (!this.#closed) await this.#keepHomeRecords(employees);
    await this.#persist();
  }

  /**
   * Whether the approved limits of this employee's laptop are looked at now. They are for every employee, whatever
   * their attendance and whatever their condition reads: what a report says about an employee says nothing about
   * whether their laptop runs, and a running laptop needs its limits. An employee who reads as anything but
   * running normally used to be left to the ladder, which puts limits back only for the holds it has a step for;
   * a lost terminal, a start-up screen or a handoff that is still owed left the laptop without the check for as
   * long as they lasted. The one state that is left out is a plan move step in flight: the move stops, builds and
   * starts laptops of this employee until it has come back, and the check knows nothing of a move's flight.
   */
  #limitsLookedAt(employee: SupervisedEmployee): boolean {
    if (employee.desiredRunning !== true || employee.onVacation) return true;
    return this.#reports.get(employee.id)?.condition !== 'move-in-progress';
  }

  /** An employee who should be in the office has a terminal attached to a laptop, so laptops run in the pool. */
  #laptopAttached(employees: readonly SupervisedEmployee[]): boolean {
    return employees.some((employee) => {
      const { laptop, session } = this.ports.glance(employee);
      return (
        laptop.poolAlive === true ||
        (laptop.restoration?.state === 'attached' && session.available && session.viewerHealth !== 'disconnected')
      );
    });
  }

  /** The office-level look at the shared pool. See the file comment. */
  async #keepPool(employees: readonly SupervisedEmployee[]): Promise<void> {
    const keep = this.ports.keepPool?.bind(this.ports);
    if (!keep || this.#poolFlight) return;
    const now = this.ports.now();
    const inOffice = employees.filter(
      (row) =>
        row.desiredRunning === true && !row.onVacation && !row.bindingMigration && this.ports.flags(row.owner).enabled
    );
    if (!inOffice.length || this.#laptopAttached(inOffice)) {
      if (this.#pool && this.#pool.pool !== 'up')
        this.ports.log('[supervisor] shared pool: a laptop is attached again');
      if (inOffice.length) this.#poolReturned(now);
      this.#pool = undefined;
      this.#poolDue = 0;
      return;
    }
    // Nobody is attached and nothing has been read yet: the pool is unknown, never assumed to be up.
    this.#pool ??= { pool: 'unknown', at: now, since: now, attempts: 0, downSince: now, nextLookAt: now };
    if (now < this.#poolDue) return;
    const before = this.#pool;
    // The employees in the office come first; anyone's laptop record can stand for the pool they all share.
    const candidates = [...inOffice, ...employees.filter((row) => !inOffice.includes(row) && !row.bindingMigration)];
    const stepAt = this.#poolStepAt(before);
    // A step is taken only for what an earlier look already found, and only with the switch it needs.
    const owner = inOffice[0]!.owner;
    this.#poolOwner = owner;
    const allowed = !!before.step && (POOL_STEP_TIER[before.step] === 'retry' || this.ports.flags(owner).autoRepair);
    const act = allowed && stepAt !== undefined && stepAt <= now ? before.step : undefined;
    if (act) this.#poolLastStep = now;
    this.#poolDue = now + this.#resolved.poolReadMs;
    const work = (async (): Promise<SupervisorPoolResult> => {
      try {
        return await keep(candidates, (employee, tier) => this.#poolGuard(employee, tier), act);
      } catch (error) {
        return { pool: 'unknown', detail: describe(error) };
      }
    })().then((result) => {
      this.#poolFlight = undefined;
      this.#poolLooked(before, result, act, now);
    });
    this.#poolFlight = work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.limits.actionWaitMs);
      timer.unref?.();
    });
    await Promise.race([work, waited]);
    if (timer) clearTimeout(timer);
  }

  /**
   * The pool runs again after a look had found it stopped. Every employee starts a new round of repair steps now
   * instead of waiting out the rest of one whose attempts were used against the stopped pool, or before it
   * stopped: after a host restart nobody sits out six hours. At most once per `poolRoundMs`, so that a pool
   * that keeps stopping cannot keep the ladders going without a pause. The limit of rebuilds per day is kept.
   */
  #poolReturned(now: number): void {
    if (!this.#poolWasDown) return;
    this.#poolWasDown = false;
    if (now - this.#poolRoundAt < this.#resolved.poolRoundMs) return;
    this.#poolRoundAt = now;
    let renewed = 0;
    for (const [id, history] of this.#histories) {
      const next = newSupervisorRound(history);
      if (next === history) continue;
      this.#remember(id, next);
      renewed++;
    }
    if (renewed)
      this.ports.log(
        `[supervisor] shared pool: running again; ${renewed} employee(s) start a new round of repair steps`
      );
  }

  /** The earliest time at which the step a pool report calls for is taken: after the dwell, and after the wait
   * that follows the steps already taken for it. */
  #poolStepAt(report: Pick<SupervisorPoolReport, 'step' | 'since' | 'attempts'>): number | undefined {
    if (!report.step) return undefined;
    const backoff = this.#resolved.poolBackoffMs;
    return Math.max(
      report.since + this.#resolved.poolDwellMs,
      report.attempts ? this.#poolLastStep + (backoff[Math.min(report.attempts, backoff.length) - 1] ?? 0) : 0
    );
  }

  /** What the policy is told about a pool that is not up. See `poolDetail` of the observation. */
  #poolDetail(): NonNullable<SupervisorObservation['laptop']['poolDetail']> | undefined {
    const pool = this.#pool;
    if (!pool || pool.downSince === undefined) return undefined;
    const refused =
      pool.step && pool.last?.step === pool.step && pool.last.outcome !== 'done' ? pool.last.detail : undefined;
    return {
      since: pool.downSince,
      ...(pool.detail ? { code: pool.detail } : {}),
      ...(pool.step ? { step: pool.step } : {}),
      ...(pool.stepAt === undefined ? {} : { stepAt: pool.stepAt }),
      ...(refused ? { refused } : {}),
      ...(pool.stepNeedsRepairSwitch ? { repairOff: true } : {}),
    };
  }

  /** Record one look at the pool. A line and an audit entry are written for every step that was taken, and one
   * line when what the pool is, or what it needs, changes. */
  #poolLooked(
    before: SupervisorPoolReport,
    result: SupervisorPoolResult,
    asked: SupervisorPoolStep | undefined,
    at: number
  ): void {
    const took = asked !== undefined && result.outcome !== undefined;
    const same = before.pool === result.pool && before.step === result.step;
    const last = took
      ? { step: result.step!, at, outcome: result.outcome!, ...(result.detail ? { detail: result.detail } : {}) }
      : before.last;
    const usable = result.pool === 'up' || result.pool === 'none';
    if (result.pool === 'down') this.#poolWasDown = true;
    else if (result.pool === 'up') this.#poolReturned(at);
    const base = {
      pool: result.pool,
      ...(result.step ? { step: result.step } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      at,
      since: same ? before.since : at,
      attempts: (same || took ? before.attempts : 0) + (took ? 1 : 0),
      ...(last ? { last } : {}),
    };
    const stepAt = this.#poolStepAt(base);
    const blocked =
      !!result.step && POOL_STEP_TIER[result.step] === 'repair' && !this.ports.flags(this.#poolOwner).autoRepair;
    // What the step waits for and when it is tried again is part of every report.
    const report: SupervisorPoolReport = {
      ...base,
      ...(usable ? {} : { downSince: before.downSince ?? at }),
      nextLookAt: this.#poolDue,
      ...(stepAt === undefined ? {} : { stepAt: Math.max(stepAt, this.#poolDue) }),
      ...(blocked ? { stepNeedsRepairSwitch: true as const } : {}),
    };
    this.#pool = report;
    try {
      if (took) {
        this.ports.log(
          `[supervisor] shared pool: ${result.step} -> ${result.outcome}` +
            `${result.detail ? ' ' + result.detail : ''} (pool ${result.pool}; attempt ${report.attempts})`
        );
        this.ports.audit({
          admin: 'office supervisor',
          action: 'supervisor_' + result.step!.replaceAll('-', '_'),
          target: 'shared pool',
          detail: {
            outcome: result.outcome,
            ...(result.detail ? { detail: result.detail } : {}),
            pool: result.pool,
            attempt: report.attempts,
            ...(result.employeeId ? { id: result.employeeId } : {}),
          },
        });
      } else if (!same || before.detail !== result.detail)
        this.ports.log(
          `[supervisor] shared pool: ${result.pool}` +
            `${result.detail ? ' ' + result.detail : ''}${result.step ? '; next: ' + result.step : ''}` +
            (result.step && POOL_STEP_TIER[result.step] === 'repair' ? POOL_REPAIR_NOTE : '')
        );
    } catch {
      /* best-effort */
    }
  }

  /**
   * Throws unless the supervisor may still act for the pool through this employee's record: the owner's switch
   * (and the one for repairs, for a step that starts the stopped anchor), the ready office and the unchanged
   * employee. Attendance is not asked: the pool belongs to the box, and nobody is started or returned by it.
   */
  #poolGuard(employee: SupervisedEmployee, tier: 'retry' | 'repair'): SupervisorGuard {
    const identity = this.#identityGuard(employee);
    return () => {
      identity();
      if (tier === 'repair' && !this.ports.flags(employee.owner).autoRepair)
        throw new SupervisorStopped('Automatic repairs were switched off');
    };
  }

  /**
   * Keeping a record of each running laptop's home. After a host restart the device number of the filesystem a
   * home is on can have changed, and what proves that it is the same filesystem is a record the office made
   * while the laptop ran. The next restart may come at any time, so the record is made promptly: for every
   * employee whose finished laptop has none on record in this office process, `homeRecordsPerTick` of them per
   * pass, those in the office first. A laptop operation is recorded once; a new one (a rebuild, a plan move) is
   * recorded again. An attempt that recorded nothing is tried again after `homeRecordRetryMs`, for as long as it
   * takes: a laptop that was not running may run later, and a helper that timed out may answer. Like the limits
   * check it needs the first switch only, asks nothing about attendance, attaches and starts nothing, and spends
   * no attempt of a repair step.
   */
  async #keepHomeRecords(employees: readonly SupervisedEmployee[]): Promise<void> {
    const remember = this.ports.rememberHome?.bind(this.ports);
    if (!remember) return;
    const now = this.ports.now(),
      retry = this.#resolved.homeRecordRetryMs;
    const operation = (employee: SupervisedEmployee) => this.ports.glance(employee).laptop.record?.operationId;
    const due = employees.filter((row) => {
      const operationId = operation(row),
        kept = this.#homeRecords.get(row.id);
      if (!operationId || row.bindingMigration || this.#acting.has(row.id) || !this.ports.flags(row.owner).enabled)
        return false;
      if (!kept || kept.operationId !== operationId) return true;
      return !kept.done && now - kept.at >= (retry[Math.min(kept.tries, retry.length) - 1] ?? 0);
    });
    const inOffice = (row: SupervisedEmployee) => Number(row.desiredRunning === true && !row.onVacation);
    for (const employee of due.sort((a, b) => inOffice(b) - inOffice(a)).slice(0, this.#resolved.homeRecordsPerTick)) {
      if (this.#closed) return;
      const operationId = operation(employee)!,
        kept = this.#homeRecords.get(employee.id),
        tries = kept?.operationId === operationId ? kept.tries + 1 : 1;
      const guard = this.#identityGuard(employee);
      let outcome: Awaited<ReturnType<typeof remember>> | 'busy';
      try {
        guard();
        outcome = await remember(employee, guard);
      } catch (error) {
        outcome = error instanceof SupervisorStopped ? 'busy' : 'failed';
      }
      const done = outcome === 'recorded';
      this.#homeRecords.set(employee.id, { operationId, at: now, done, tries });
      // One line when a home is recorded, and one when an attempt first records nothing.
      if (done || tries === 1)
        this.ports.log(`[supervisor] ${employee.name} (${employee.id}): record-home -> ${outcome}`);
    }
  }

  /** The limits check of the one employee whose check is longest overdue. See the file comment. */
  async #keepLimits(employees: readonly SupervisedEmployee[]): Promise<void> {
    const keep = this.ports.keepLimits?.bind(this.ports);
    if (!keep) return;
    const now = this.ports.now(),
      due = (employee: SupervisedEmployee) => this.#limitsDue.get(employee.id) ?? 0;
    const employee = employees
      .filter(
        (row) =>
          due(row) <= now &&
          !row.bindingMigration &&
          !this.#acting.has(row.id) &&
          this.#limitsLookedAt(row) &&
          this.ports.flags(row.owner).enabled
      )
      .sort((a, b) => due(a) - due(b) || a.id.localeCompare(b.id))[0];
    if (!employee) return;
    this.#limitsDue.set(employee.id, now + this.limits.limitsCheckMs);
    const guard = this.#identityGuard(employee);
    const work = (async (): Promise<SupervisorActionResult | undefined> => {
      try {
        guard();
        return await keep(employee, guard);
      } catch (error) {
        return error instanceof SupervisorStopped
          ? { outcome: 'busy', detail: error.message }
          : { outcome: 'failed', detail: describe(error) };
      }
    })().then((result) => {
      this.#acting.delete(employee.id);
      this.#limitsChecked(employee, result, now);
    });
    this.#acting.set(employee.id, work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.limits.actionWaitMs);
      timer.unref?.();
    });
    await Promise.race([work, waited]);
    if (timer) clearTimeout(timer);
  }

  /** Record one limits check. A line and an audit entry are written when limits were put back, and once when a
   * check starts to be refused or to fail; a check that found everything in place says nothing. */
  #limitsChecked(employee: SupervisedEmployee, result: SupervisorActionResult | undefined, at: number): void {
    const before = this.#limits.get(employee.id);
    if (!result) {
      this.#limits.delete(employee.id);
      return;
    }
    if (result.outcome === 'busy') {
      // Another operation held the employee and nothing was tried: the earlier finding stands, and this is asked
      // again soon.
      this.#limitsDue.set(employee.id, at + LIMITS_BUSY_RETRY_MS);
      return;
    }
    const entry: SupervisorLimitsReport = {
      at,
      outcome: result.outcome,
      ...(result.detail ? { detail: result.detail } : {}),
    };
    this.#limits.set(employee.id, entry);
    const report = this.#reports.get(employee.id);
    if (report) this.#reports.set(employee.id, { ...report, limits: entry });
    const restored = entry.outcome === 'done' && entry.detail === 'restored';
    const changed = !before || before.outcome !== entry.outcome || before.detail !== entry.detail;
    if (!restored && (entry.outcome === 'done' || !changed)) return;
    try {
      this.ports.log(
        `[supervisor] ${employee.name} (${employee.id}): keep-limits -> ${entry.outcome}` +
          `${entry.detail ? ' ' + entry.detail : ''}`
      );
      this.ports.audit({
        admin: 'office supervisor',
        action: 'supervisor_keep_limits',
        target: employee.name,
        detail: {
          id: employee.id,
          sessionId: employee.sessionId,
          outcome: entry.outcome,
          ...(entry.detail ? { detail: entry.detail } : {}),
        },
      });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Throws unless the supervisor may still keep limits for exactly this employee: the owner's switch, the ready
   * office and the unchanged employee. Attendance is not asked, in either direction.
   */
  #identityGuard(employee: SupervisedEmployee): SupervisorGuard {
    return () => {
      if (this.#closed) throw new SupervisorStopped('The office supervisor has stopped');
      if (!this.ports.ready()) throw new SupervisorStopped('The office is not ready');
      if (!this.ports.flags(employee.owner).enabled)
        throw new SupervisorStopped('The office supervisor was switched off');
      const live = this.ports.employees().find((row) => row.id === employee.id);
      if (
        !live ||
        live.owner !== employee.owner ||
        live.sessionId !== employee.sessionId ||
        live.sessionGeneration !== employee.sessionGeneration ||
        live.bindingMigration
      )
        throw new SupervisorStopped('The employee changed');
    };
  }

  /**
   * Nothing is read or decided while the office is not ready. When it says what it is doing about that, every
   * report says so too, instead of showing a step from before that nobody is going to take.
   */
  #unready(): void {
    const waitingFor = this.ports.notReady?.();
    if (!waitingFor) return;
    const checkedAt = this.ports.now();
    for (const [id, report] of this.#reports) {
      const { next: _next, waitingUntil: _until, ...rest } = report;
      this.#reports.set(id, { ...rest, checkedAt, waitingFor });
    }
  }

  #forget(id: string): void {
    this.#histories.delete(id);
    this.#dirty = true;
  }

  async #persist(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      await this.ports.save(this.#histories);
    } catch (error) {
      this.#dirty = true;
      this.ports.log(`[supervisor] could not save its state: ${describe(error)}`);
    }
  }

  /** Keep a history, or drop it once it says nothing. The file is written only when something changed. */
  #remember(id: string, history: SupervisorHistory): void {
    const before = this.#histories.get(id);
    const blank =
      history.fingerprint === '' &&
      history.transitSince === undefined &&
      !history.lastAction &&
      !history.rebuilds.length &&
      !Object.keys(history.attempts).length;
    if (blank) {
      if (before) this.#forget(id);
      return;
    }
    if (before && JSON.stringify(before) === JSON.stringify(history)) return;
    this.#histories.set(id, history);
    this.#dirty = true;
  }

  /** Throws unless the supervisor may still act for exactly this employee. */
  #guard(employee: SupervisedEmployee, tier: 'retry' | 'repair'): SupervisorGuard {
    return () => {
      if (this.#closed) throw new SupervisorStopped('The office supervisor has stopped');
      if (!this.ports.ready()) throw new SupervisorStopped('The office is not ready');
      const flags = this.ports.flags(employee.owner);
      if (!flags.enabled || (tier === 'repair' && !flags.autoRepair))
        throw new SupervisorStopped('The office supervisor was switched off');
      const live = this.ports.employees().find((row) => row.id === employee.id);
      if (
        !live ||
        live.owner !== employee.owner ||
        live.sessionId !== employee.sessionId ||
        live.sessionGeneration !== employee.sessionGeneration ||
        live.desiredRunning !== true ||
        live.onVacation ||
        live.bindingMigration
      )
        throw new SupervisorStopped('The employee changed or is no longer meant to be running');
    };
  }

  async #observe(employee: SupervisedEmployee, enabled: boolean, fresh = false): Promise<SupervisorObservation> {
    this.#reused = false;
    const glance = this.ports.glance(employee);
    if (!enabled) return glance;
    const guard = this.#guard(employee, 'retry');
    const move = await this.ports.openMove(employee);
    let observed: SupervisorObservation = { ...glance, ...(move ? { move } : {}) };
    const first = classifyEmployee(observed);
    // Only for a laptop at its sign-in screen. A plan move that stopped at one is not judged by the plan's sign-in:
    // nothing about that move depends on it (see `SUPERVISOR_MOVE_POLICY`).
    if (first.condition === 'needs-sign-in') {
      const account = employee.planAccountId;
      const signedIn =
        account && this.ports.planSignedIn ? await this.ports.planSignedIn(account).catch(() => undefined) : undefined;
      if (signedIn !== undefined) observed = { ...observed, planSignedIn: signedIn };
      const held = first.condition === 'needs-sign-in' ? this.ports.laptopSignedIn?.(employee) : undefined;
      if (held !== undefined) observed = { ...observed, laptopSignedIn: held };
    }
    if (!glance.boxed || glance.busy || NO_LAPTOP_READ.has(first.condition) || first.code?.startsWith('move-'))
      return observed;
    if (first.code === 'decision-screen' || first.code === 'first-run-screen' || glance.laptop.rebuildPending)
      return observed;
    if (glance.laptop.record) {
      // While no step is pending for this employee, the same reading serves for a while: a laptop that waits for
      // a person is not inspected every half minute.
      const now = this.ports.now();
      const last = this.#reports.get(employee.id);
      const kept = this.#readings.get(employee.id);
      const idle = !!last && !last.next && last.condition !== 'starting';
      if (
        !fresh &&
        kept &&
        idle &&
        kept.operationId === glance.laptop.record.operationId &&
        now - kept.at < this.limits.idleReadMs
      ) {
        this.#reused = true;
        return { ...observed, laptop: { ...observed.laptop, continuation: kept.reading } };
      }
      const continuation = await this.ports.readLaptop(employee, guard);
      if (!continuation) return observed;
      this.#readings.set(employee.id, {
        at: now,
        operationId: glance.laptop.record.operationId,
        reading: continuation,
      });
      return { ...observed, laptop: { ...observed.laptop, continuation } };
    }
    if (!glance.laptop.policyApproved) return observed;
    return { ...observed, laptop: { ...observed.laptop, source: await this.ports.readSource(employee, guard) } };
  }

  /** Returns true when an action was started for this employee. */
  async #one(employee: SupervisedEmployee, seat: boolean): Promise<boolean> {
    const now = this.ports.now();
    const previous = this.#histories.get(employee.id) ?? EMPTY_SUPERVISOR_HISTORY;
    if (employee.desiredRunning !== true || employee.onVacation) {
      // Stopped by choice: described from the record alone. No port is read and nothing is remembered but the reset.
      // The approved limits of a laptop that still runs are kept by the pass itself (`#keepLimits`).
      const stopped: SupervisorObservation = {
        employeeId: employee.id,
        name: employee.name,
        desiredRunning: employee.desiredRunning,
        onVacation: employee.onVacation,
        bindingMigration: employee.bindingMigration,
        boxed: false,
        session: { available: false, runtimeHealth: 'unknown', viewerHealth: 'unknown' },
        laptop: { record: null, bound: false, policyApproved: false, templateOnRecord: false },
      };
      const history = rollSupervisorHistory(previous, classifyEmployee(stopped), now, this.policy);
      // Only the reset is kept; `since` moves with the clock and is not worth a write on its own.
      this.#remember(employee.id, { ...history, since: 0 });
      this.#report(employee, assessEmployee(stopped, history, this.#flags(employee), now, this.policy), history, now);
      this.#reading.delete(employee.id);
      this.#runningSeen.delete(employee.id);
      this.#operating.delete(employee.id);
      return false;
    }
    if (this.#acting.has(employee.id)) {
      // An employee with a step in flight says nothing about the office; the step itself keeps the office from
      // asking for its own restart (`#officeOperating`).
      this.#reading.set(employee.id, 'no-evidence');
      // A step for this employee has not returned. Nothing is read or decided beside it.
      const running = this.#reports.get(employee.id);
      if (running)
        this.#reports.set(employee.id, { ...running, checkedAt: now, waitingFor: 'the last step to return' });
      return false;
    }
    const flags = this.#flags(employee);
    // A laptop that was just found occupied or unreadable is not asked again every half minute. Only a reading
    // that forbids a rebuild is ever kept: one that would allow it is always made immediately before the step.
    const occupied = this.#occupied.get(employee.id);
    const stored = this.#storedHome.get(employee.id);
    // The same holds for a stored home that was found renumbered or different. What the office's own look at the
    // shared pool found is given to every assessment while it is looking.
    const retry = this.#resolved.storedHomeRetryMs;
    const storedFresh =
      stored &&
      now - stored.at <
        (stored.found === 'unknown'
          ? (retry[Math.min(stored.reads, retry.length) - 1] ?? 0)
          : this.#resolved.storedHomeReadMs);
    const storedSeen = (entry: NonNullable<typeof stored>) => ({
      storedHome: entry.found,
      storedHomeDetail: { ...(entry.cause ? { cause: entry.cause } : {}), since: entry.since, reads: entry.reads },
    });
    const withOccupied = (seen: SupervisorObservation): SupervisorObservation => {
      const kept = occupied && now - occupied.at < this.limits.idleReadMs;
      const laptop = {
        ...seen.laptop,
        ...(kept ? { provider: occupied.presence } : {}),
        // Read with the reading above, and kept exactly as long.
        ...(kept ? this.#otherWorkSeen(employee.id) : {}),
        ...(storedFresh ? storedSeen(stored) : {}),
        ...(this.#pool ? { pool: this.#pool.pool } : {}),
        ...(this.#poolDetail() ? { poolDetail: this.#poolDetail()! } : {}),
      };
      return { ...seen, laptop };
    };
    let observed = withOccupied(await this.#observe(employee, flags.enabled));
    this.#noteReading(employee, observed, now);
    let history = rollSupervisorHistory(previous, sightEmployee(observed), now, this.policy);
    let assessment = assessEmployee(observed, history, flags, now, this.policy);
    this.#remember(employee.id, history);
    const due = (step: SupervisorAssessment) => step.next.action !== null && (step.next.at ?? 0) <= now;
    if (due(assessment) && seat && this.#reused) {
      // A step is never decided on a reading that was kept from an earlier pass.
      observed = withOccupied(await this.#observe(employee, flags.enabled, true));
      history = rollSupervisorHistory(previous, sightEmployee(observed), now, this.policy);
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      this.#remember(employee.id, history);
    }
    if (!due(assessment) || !seat || !this.ports.actions[assessment.next.action!]) {
      this.#report(employee, assessment, history, now);
      return false;
    }
    if (assessment.next.preconditions.includes('no-agent-running')) {
      // The one read a rebuild depends on is made last, and the decision is taken again with it.
      const provider = await this.ports
        .readProvider(employee, this.#guard(employee, 'repair'))
        .catch(() => 'unknown' as const);
      if (provider === 'running' || provider === 'unknown')
        this.#occupied.set(employee.id, { at: now, presence: provider });
      else this.#occupied.delete(employee.id);
      await this.#readOtherWork(employee, provider, now);
      const laptop = { ...observed.laptop, provider, ...this.#otherWorkSeen(employee.id) };
      observed = { ...observed, laptop };
      this.#noteReading(employee, observed, now);
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      // A laptop the read found occupied may still be rebuilt, between its agent's turns: that is decided next.
      if (!due(assessment) || assessment.next.preconditions.includes('no-agent-running')) {
        this.#report(employee, assessment, history, now);
        return false;
      }
    }
    if (assessment.next.preconditions.includes('stored-home') && observed.laptop.storedHome === undefined) {
      // Nothing runs in the laptop. Before it is replaced by one bound to the same home path, that path is read,
      // and the decision is taken again with what was found. The step reads it once more itself.
      const read = this.ports.readStoredHome?.bind(this.ports);
      const seen: SupervisorStoredHomeReading = read
        ? await read(employee, this.#guard(employee, 'repair')).catch(() => ({
            found: 'unknown' as const,
            cause: 'read-refused' as const,
          }))
        : { found: 'unchecked' };
      // The same finding for the same reason, read after read, keeps the time it was first found.
      const same = stored && stored.found === seen.found && stored.cause === seen.cause;
      const entry = {
        at: now,
        found: seen.found,
        ...(seen.cause ? { cause: seen.cause } : {}),
        since: same ? stored.since : now,
        reads: same ? stored.reads + 1 : 1,
      };
      if (STORED_HOME_HELD.has(seen.found)) this.#storedHome.set(employee.id, entry);
      else this.#storedHome.delete(employee.id);
      observed = { ...observed, laptop: { ...observed.laptop, ...storedSeen(entry) } };
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      if (!due(assessment) || !assessment.next.preconditions.includes('stored-home')) {
        this.#report(employee, assessment, history, now);
        return false;
      }
    }
    if (assessment.next.preconditions.some((name) => SUPERVISOR_OCCUPIED_PROOFS.includes(name))) {
      // A laptop an agent may run in. The office terminal is looked at once more, from memory, and the decision is
      // taken again with it: the step goes ahead only when exactly the same is still asked to be proved. The laptop
      // itself was read in this pass. The step proves all of it again itself, immediately before the rebuild.
      // A start-up screen the agent is parked on is read from the pane again by that look: a screen that showed
      // is never taken from an earlier read.
      const asked = assessment.next.preconditions.join();
      observed = { ...observed, session: this.ports.glance(employee).session };
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      if (!due(assessment) || assessment.next.preconditions.join() !== asked) {
        this.#report(employee, assessment, history, now);
        return false;
      }
    }
    const braked = this.#officeBrake(employee, assessment, now);
    if (braked) {
      this.#report(employee, { ...assessment, next: { action: null, ...braked, preconditions: [] } }, history, now);
      return false;
    }
    const action = assessment.next.action!;
    history = issueSupervisorAttempt(history, action, now, assessment.next.uncounted);
    // The office-wide limit counts from the moment the step is issued, and the mark is saved before its effect.
    const marked = this.#workingAgentRebuild(assessment) ? { before: history.occupiedRebuildAt } : undefined;
    if (marked) history = { ...history, occupiedRebuildAt: now };
    this.#remember(employee.id, history);
    await this.#persist();
    this.#report(
      employee,
      { ...assessment, next: { action: null, preconditions: [] } },
      history,
      now,
      'the step that is running'
    );
    await this.#act(employee, action, assessment, observed.move as SupervisorMove | undefined, marked);
    return true;
  }

  /** The employees who should be in the office now. Only they are compared with each other. */
  #inOffice(employees: readonly SupervisedEmployee[] = this.ports.employees()): SupervisedEmployee[] {
    return employees.filter((row) => row.desiredRunning === true && !row.onVacation && !row.bindingMigration);
  }

  /**
   * Keep what one employee's observation says about the office: whether their laptop is read, runs unread, or says
   * nothing (`officeReading`), and whether an operation of the office's own holds them. The engine's word that a
   * laptop runs with an agent in it comes from the read a rebuild makes, which is not made on every pass, so it
   * stands for `RUNNING_SEEN_MS`; a read that finds no laptop or no agent ends it at once.
   */
  #noteReading(employee: SupervisedEmployee, observed: SupervisorObservation, now: number): void {
    const provider = observed.laptop.provider;
    if (provider === 'running' || observed.laptop.continuation?.state === 'ready')
      this.#runningSeen.set(employee.id, now);
    else if (provider !== undefined && provider !== 'unknown') this.#runningSeen.delete(employee.id);
    const seen = this.#runningSeen.get(employee.id);
    this.#reading.set(employee.id, officeReading(observed, seen !== undefined && now - seen <= RUNNING_SEEN_MS));
    if (observed.busy || observed.move) this.#operating.add(employee.id);
    else this.#operating.delete(employee.id);
  }

  /**
   * An operation that the office itself runs is in flight, or pending, for some employee: a step of this
   * supervisor, a look at or a step for the shared pool, a plan move that is open, a laptop set-up, rebuild or
   * repair, a session start or stop. The office never asks for its own restart beside one: a restart would cut it
   * off, and for a plan move it would also reset what the move's own clocks have watched.
   */
  #officeOperating(): boolean {
    return this.#acting.size > 0 || !!this.#poolFlight || this.#pool?.step !== undefined || this.#operating.size > 0;
  }

  /**
   * Once per pass, before any employee is looked at: which causes are shared, and whether the office reads any of
   * its laptops at all. Both are judged from what the last pass reported, so they are half a minute old.
   *
   * "The office reads none of its laptops" has one meaning: the engine reports laptops RUNNING, the office can
   * attach to or read none of them, and it reads no other laptop either. `officeReading` says which employees are
   * evidence of that and which say nothing (a stopped laptop, one being built, moved, rebuilt or started, one that
   * waits for the pool, one any operation of the office's own holds). At least two such laptops are needed. One
   * laptop that runs and cannot be read is as likely that laptop's fault as the office's, and a restart of the
   * office drops every terminal for it; so with one, in an office of one employee as in any other, the laptop's
   * own ladder applies and the office does not restart itself. Two that fail in the same way at the same time are
   * unlikely to be two separate faults.
   *
   * After `officeBlindRestartMs` of that the office asks for its own restart on every pass, for as long as it
   * stands, and never while an operation of its own is in flight (`#officeOperating`).
   */
  #lookAtOffice(employees: readonly SupervisedEmployee[]): void {
    const now = this.ports.now(),
      inOffice = this.#inOffice(employees),
      present = new Set(inOffice.map((row) => row.id));
    for (const id of [...this.#causes.keys()]) if (!present.has(id)) this.#causes.delete(id);
    const holders = new Map<string, number>();
    for (const cause of this.#causes.values()) holders.set(cause, (holders.get(cause) ?? 0) + 1);
    for (const [cause, count] of holders)
      if (count > 1 && !this.#sharedSince.has(cause)) this.#sharedSince.set(cause, now);
    for (const cause of [...this.#sharedSince.keys()])
      if ((holders.get(cause) ?? 0) < 2) this.#sharedSince.delete(cause);
    for (const id of [...this.#reading.keys()])
      if (!present.has(id)) {
        this.#reading.delete(id);
        this.#runningSeen.delete(id);
        this.#operating.delete(id);
      }
    const readings = [...this.#reading.values()],
      blind = !readings.includes('reads') && readings.filter((value) => value === 'cannot-read').length > 1;
    if (!blind) {
      this.#blindSince = undefined;
      this.#restartAnswer = undefined;
      return;
    }
    this.#blindSince ??= now;
    if (now - this.#blindSince < this.#resolved.officeBlindRestartMs) return;
    if (this.#officeOperating()) {
      this.#restartAnswer = undefined;
      return;
    }
    try {
      this.#restartAnswer = this.ports.officeRestart?.request(OFFICE_BLIND);
    } catch {
      this.#restartAnswer = undefined;
    }
  }

  /** The step is a rebuild that discards a laptop whose agent may be in a conversation. */
  #workingAgentRebuild(assessment: SupervisorAssessment): boolean {
    return (
      assessment.next.action === 'rebuild-laptop' &&
      assessment.next.preconditions.some((name) => WORKING_AGENT_PROOFS.includes(name))
    );
  }

  /** The newest rebuild, across the office, of a laptop that an agent ran in or may have run in. */
  #lastWorkingAgentRebuild(): { readonly id: string; readonly at: number } | undefined {
    let last: { id: string; at: number } | undefined;
    for (const [id, history] of this.#histories) {
      const at = history.occupiedRebuildAt;
      if (at !== undefined && (!last || at > last.at)) last = { id, at };
    }
    return last;
  }

  /**
   * The office-wide brake on rebuilding laptops that agents run in. The policy decides for one employee and knows
   * nothing of the others; one fault of the office or of something all laptops share would otherwise look like the
   * same fault in every laptop, and every one of them would be rebuilt within a minute. Returns why the step is not
   * taken now, or undefined when it may be.
   *
   * - One such rebuild an hour, across the office and across office restarts. The worst case is one working agent
   *   lost per hour, with every other laptop watched meanwhile.
   * - A pane the office cannot read is no reason while the office reads none of its laptops: that is the office's
   *   fault. It asks for its own restart instead (`#lookAtOffice`). Only once a restart has been tried, or this
   *   office cannot restart itself, is the cause treated as one that several employees share.
   * - A cause that more than one employee in the office shares is the office's or their shared ground's fault
   *   until shown otherwise. No laptop is rebuilt for it at first. After `sharedCauseProbeMs` one laptop is rebuilt
   *   as a probe, and no other laptop is touched until that one is healthy. Then the next one follows, an hour
   *   later at the earliest. A probe that does not come back healthy keeps every other laptop as it is.
   */
  #officeBrake(
    employee: SupervisedEmployee,
    assessment: SupervisorAssessment,
    now: number
  ): { readonly waitingFor: string; readonly at?: number } | undefined {
    if (!this.#workingAgentRebuild(assessment)) return undefined;
    const last = this.#lastWorkingAgentRebuild(),
      spacing = this.#resolved.occupiedRebuildSpacingMs;
    if (last && now - last.at < spacing)
      return {
        at: last.at + spacing,
        waitingFor:
          'the limit of one rebuild an hour, across the office, of a laptop that an agent runs in; the next may run ' +
          `at ${when(last.at + spacing)}`,
      };
    const cause = causeOf(assessment),
      inOffice = this.#inOffice(),
      sharing = inOffice.filter((row) => row.id !== employee.id && this.#causes.get(row.id) === cause);
    const blind = assessment.next.preconditions.includes('agent-unreadable') && this.#blindSince !== undefined;
    if (blind) {
      const restart = this.ports.officeRestart,
        restarted = restart?.lastAt(),
        tried =
          !restart ||
          this.#restartAnswer === 'refused' ||
          (restarted !== undefined && now - restarted < this.#resolved.officeRestartTriedMs);
      if (!tried || now - this.#blindSince! < this.#resolved.officeBlindRestartMs)
        return {
          waitingFor: `the office to read at least one laptop again: ${OFFICE_BLIND}, so the fault is taken to be the office's own and it restarts itself before any laptop is rebuilt for a pane it cannot read`,
        };
    }
    if (!sharing.length && !blind) return undefined;
    const since = this.#sharedSince.get(cause) ?? (blind ? this.#blindSince! : now),
      probeAt = since + this.#resolved.sharedCauseProbeMs,
      others = sharing.length;
    if (now < probeAt)
      return {
        at: probeAt,
        waitingFor:
          `the office to see whether this is one laptop's fault: this employee shares what holds them with ${others} ` +
          `other${others === 1 ? '' : 's'} in the office, so one laptop is rebuilt as a probe at ${when(probeAt)}`,
      };
    const probe =
      last && last.at >= since && last.id !== employee.id ? inOffice.find((row) => row.id === last.id) : undefined;
    if (probe && this.#reports.get(probe.id)?.condition !== 'healthy')
      return {
        waitingFor:
          `the laptop of ${probe.name} to come back healthy: it was rebuilt as a probe for what several employees ` +
          'share, and no other laptop is touched before that',
      };
    return undefined;
  }

  #flags(employee: SupervisedEmployee) {
    return {
      ...this.ports.flags(employee.owner),
      relaunchAvailable: !!this.ports.actions['relaunch-provider'],
      signInRepairAvailable: !!this.ports.actions['replace-sign-in'],
    };
  }

  async #act(
    employee: SupervisedEmployee,
    action: SupervisorAction,
    assessment: SupervisorAssessment,
    move: SupervisorMove | undefined,
    /** Set for a rebuild that counts against the office-wide limit: the mark the employee carried before it. */
    marked?: { readonly before: number | undefined }
  ): Promise<void> {
    const tier = this.policy.ladder[action].tier;
    const run = this.ports.actions[action]!;
    const work = (async (): Promise<SupervisorActionResult> => {
      try {
        const guard = this.#guard(employee, tier);
        guard();
        return await run(employee, guard, move, assessment.next.preconditions);
      } catch (error) {
        return error instanceof SupervisorStopped
          ? { outcome: 'busy', detail: error.message }
          : { outcome: 'failed', detail: describe(error) };
      }
    })().then((result) => {
      this.#acting.delete(employee.id);
      const ended = settleSupervisorAttempt(
        this.#histories.get(employee.id) ?? EMPTY_SUPERVISOR_HISTORY,
        result.outcome,
        result.detail
      );
      // A step that found the employee busy tried nothing, so it does not count against the office either.
      const { occupiedRebuildAt: _mark, ...unmarked } = ended;
      const settled: SupervisorHistory =
        marked && result.outcome === 'busy'
          ? { ...unmarked, ...(marked.before === undefined ? {} : { occupiedRebuildAt: marked.before }) }
          : ended;
      this.#remember(employee.id, settled);
      const report = this.#reports.get(employee.id);
      if (report) this.#reports.set(employee.id, { ...report, last: settled.lastAction });
      const attempt = settled.attempts[action]?.count ?? 0;
      // Reporting never changes what was done, and never throws out of this promise.
      try {
        this.ports.log(
          `[supervisor] ${employee.name} (${employee.id}): ${action} -> ${result.outcome}` +
            `${result.detail ? ' ' + result.detail : ''} (${assessment.condition}${assessment.code ? ', ' + assessment.code : ''}; attempt ${attempt})`
        );
        this.ports.audit({
          admin: 'office supervisor',
          action: 'supervisor_' + action.replaceAll('-', '_'),
          target: employee.name,
          detail: {
            id: employee.id,
            sessionId: employee.sessionId,
            condition: assessment.condition,
            ...(assessment.code ? { code: assessment.code } : {}),
            outcome: result.outcome,
            ...(result.detail ? { detail: result.detail } : {}),
            attempt,
            ...(assessment.next.preconditions.length ? { proved: [...assessment.next.preconditions] } : {}),
            ...(move ? { moveId: move.id } : {}),
          },
        });
      } catch {
        /* best-effort */
      }
    });
    this.#acting.set(employee.id, work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.limits.actionWaitMs);
      timer.unref?.();
    });
    await Promise.race([work, waited]);
    if (timer) clearTimeout(timer);
    // A step that outlives the wait keeps its seat in #acting; its result is still recorded when it returns.
    void work.then(() => this.#persist()).catch(() => {});
  }

  /**
   * With a read that found a laptop of the employee running: whether anything else of theirs runs in it. A plain
   * fact, kept for the observation and the report. A laptop that does not run has no reading.
   */
  async #readOtherWork(employee: SupervisedEmployee, provider: SupervisorProviderPresence, now: number): Promise<void> {
    const read = this.ports.readOtherWork?.bind(this.ports);
    if (provider !== 'running' || !read) {
      this.#otherWork.delete(employee.id);
      return;
    }
    const unknown = { otherWork: 'unknown' as const, at: now };
    this.#otherWork.set(employee.id, await read(employee, this.#guard(employee, 'retry')).catch(() => unknown));
  }

  /** The last read of other work, as the observation carries it: the fact, and everything that was read. */
  #otherWorkSeen(employeeId: string): {
    readonly otherWork?: SupervisorOtherWork['otherWork'];
    readonly otherWorkDetail?: SupervisorOtherWork;
  } {
    const work = this.#otherWork.get(employeeId);
    return work ? { otherWork: work.otherWork, otherWorkDetail: work } : {};
  }

  #report(
    employee: SupervisedEmployee,
    assessment: SupervisorAssessment,
    history: SupervisorHistory,
    now: number,
    waitingFor: string | undefined = assessment.next.waitingFor
  ): void {
    const problem = assessment.fingerprint !== '';
    const report: SupervisorReport = {
      employeeId: employee.id,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      condition: assessment.condition,
      sentence: assessment.sentence,
      ...(assessment.code ? { code: assessment.code } : {}),
      ...(problem && history.since > 0 ? { since: history.since } : {}),
      checkedAt: now,
      ...(history.lastAction ? { last: history.lastAction } : {}),
      ...(assessment.next.action ? { next: { action: assessment.next.action, at: assessment.next.at ?? now } } : {}),
      ...(waitingFor ? { waitingFor } : {}),
      ...(!assessment.next.action && assessment.next.at !== undefined && waitingFor === assessment.next.waitingFor
        ? { waitingUntil: assessment.next.at }
        : {}),
      ...(assessment.needsHuman ? { needsHuman: assessment.needsHuman } : {}),
      ...(this.#limits.has(employee.id) ? { limits: this.#limits.get(employee.id)! } : {}),
      ...(this.#pool && assessment.condition !== 'owner-stopped' ? { pool: this.#pool } : {}),
      ...(this.ports.storedHomeCheck && assessment.condition !== 'owner-stopped'
        ? { storedHomeCheck: this.ports.storedHomeCheck() }
        : {}),
      ...(this.#otherWork.has(employee.id) ? { otherWork: this.#otherWork.get(employee.id)! } : {}),
    };
    this.#reports.set(employee.id, report);
    const cause = causeOf(assessment);
    if (cause) this.#causes.set(employee.id, cause);
    else this.#causes.delete(employee.id);
    // One console line when an employee starts to need a person, and one when that ends.
    const key = assessment.needsHuman
      ? `${assessment.condition}\0${assessment.fingerprint}\0${assessment.needsHuman}`
      : '';
    if (key === (this.#announced.get(employee.id) ?? '')) return;
    this.#announced.set(employee.id, key);
    this.ports.log(
      key
        ? `[supervisor] ${employee.name} (${employee.id}) needs a person: ${assessment.sentence} ${assessment.needsHuman}`
        : `[supervisor] ${employee.name} (${employee.id}) no longer needs a person: ${assessment.sentence}`
    );
  }
}

/** The type of a failure and its code when it has one. Never its message: that may quote a command or a path. */
function describe(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown failure';
  const value = error as { name?: unknown; code?: unknown; status?: unknown };
  const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,96}$/.test(value.code) ? value.code : undefined;
  const name = typeof value.name === 'string' && /^[A-Za-z]{1,40}$/.test(value.name) ? value.name : 'Error';
  return code ?? name;
}
