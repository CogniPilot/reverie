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
 * It is asked for an employee who is stopped or out of the office and for one who is running normally: the two
 * states in which no repair step looks at the laptop. It writes only values the owner already approved, attaches
 * nothing, starts nothing, changes no attendance and spends no attempt of the ladder.
 */
import {
  EMPTY_SUPERVISOR_HISTORY,
  assessEmployee,
  classifyEmployee,
  issueSupervisorAttempt,
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
  employees(): readonly SupervisedEmployee[];
  /** The owner's two switches. */
  flags(owner: string | undefined): { readonly enabled: boolean; readonly autoRepair: boolean };
  /**
   * Everything that is already in memory. No Engine call and no await. `fresh` asks for the agent's start-up
   * screen to be read from the pane now instead of from the last read: a step is never decided on a kept one.
   */
  glance(
    employee: SupervisedEmployee,
    fresh?: boolean
  ): Omit<SupervisorObservation, 'move' | 'planSignedIn' | 'laptopSignedIn'>;
  openMove(employee: SupervisedEmployee): Promise<SupervisorMove | undefined>;
  planSignedIn?(accountId: string): Promise<boolean | undefined>;
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
  /**
   * Put the approved limits of this employee's finished, running laptop back in place, wherever the employee is.
   * `done` with `unchanged`, `restored` or `not-running`; undefined when the employee has no finished laptop.
   * Absent where the office has no laptops.
   */
  keepLimits?(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorActionResult | undefined>;
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
}
export const SUPERVISOR_LIMITS: EmployeeSupervisorLimits = {
  actionsPerTick: 2,
  startupGraceMs: 90_000,
  actionWaitMs: 5 * 60_000,
  idleReadMs: 2 * 60_000,
  limitsCheckMs: 10 * 60_000,
};
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
  /** What a person or a managing agent has to do, when the supervisor will not. */
  readonly needsHuman?: string;
  /** The last check of the laptop's approved limits, for an employee who has a finished laptop. */
  readonly limits?: SupervisorLimitsReport;
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
  'at-sign-in-screen',
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
  /** The last limits check of each employee, and when the next one is due. In memory: a restart checks again. */
  readonly #limits = new Map<string, SupervisorLimitsReport>();
  readonly #limitsDue = new Map<string, number>();
  readonly #startedAt: number;
  #flight?: Promise<void>;
  #closed = false;
  #dirty = false;

  constructor(
    private readonly ports: EmployeeSupervisorPorts,
    private readonly policy: SupervisorPolicy = SUPERVISOR_POLICY,
    private readonly limits: EmployeeSupervisorLimits = SUPERVISOR_LIMITS
  ) {
    this.#histories = ports.load();
    this.#startedAt = ports.now();
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
    if (this.#closed || !this.ports.ready()) return;
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
      }
    for (const id of [...this.#limitsDue.keys()])
      if (!known.has(id)) {
        this.#limitsDue.delete(id);
        this.#limits.delete(id);
      }
    // Whoever was acted on longest ago goes first, so one noisy employee cannot take every seat.
    const order = [...employees].sort(
      (a, b) =>
        (this.#histories.get(a.id)?.lastAction?.at ?? 0) - (this.#histories.get(b.id)?.lastAction?.at ?? 0) ||
        a.id.localeCompare(b.id)
    );
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
    await this.#persist();
  }

  /**
   * Whether no repair step looks at this employee's laptop right now: the employee is stopped or out of the office,
   * or was just read as running normally. Every other condition belongs to the ladder, which repairs limits itself.
   */
  #unattended(employee: SupervisedEmployee): boolean {
    if (employee.desiredRunning !== true || employee.onVacation) return true;
    return this.#reports.get(employee.id)?.condition === 'healthy';
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
          this.#unattended(row) &&
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
    if (
      first.condition === 'at-sign-in-screen' ||
      first.condition === 'needs-sign-in' ||
      first.code === 'move-sign-in'
    ) {
      const account = move?.toAccount ?? employee.planAccountId;
      const signedIn =
        account && this.ports.planSignedIn ? await this.ports.planSignedIn(account).catch(() => undefined) : undefined;
      if (signedIn !== undefined) observed = { ...observed, planSignedIn: signedIn };
      const held = first.condition === 'at-sign-in-screen' ? this.ports.laptopSignedIn?.(employee) : undefined;
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
      return false;
    }
    if (this.#acting.has(employee.id)) {
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
    const withOccupied = (seen: SupervisorObservation): SupervisorObservation =>
      occupied && now - occupied.at < this.limits.idleReadMs
        ? { ...seen, laptop: { ...seen.laptop, provider: occupied.presence } }
        : seen;
    let observed = withOccupied(await this.#observe(employee, flags.enabled));
    let history = rollSupervisorHistory(previous, classifyEmployee(observed), now, this.policy);
    let assessment = assessEmployee(observed, history, flags, now, this.policy);
    this.#remember(employee.id, history);
    const due = (step: SupervisorAssessment) => step.next.action !== null && (step.next.at ?? 0) <= now;
    if (due(assessment) && seat && this.#reused) {
      // A step is never decided on a reading that was kept from an earlier pass.
      observed = withOccupied(await this.#observe(employee, flags.enabled, true));
      history = rollSupervisorHistory(previous, classifyEmployee(observed), now, this.policy);
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
      observed = { ...observed, laptop: { ...observed.laptop, provider } };
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      if (!due(assessment) || assessment.next.preconditions.length) {
        this.#report(employee, assessment, history, now);
        return false;
      }
    }
    if (assessment.next.preconditions.includes('terminal-input-held')) {
      // The office terminal is looked at once more, from memory, and the decision is taken again with it. The step
      // proves the same again itself, immediately before it asks for the rebuild.
      observed = { ...observed, session: this.ports.glance(employee).session };
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      if (!due(assessment) || !assessment.next.preconditions.includes('terminal-input-held')) {
        this.#report(employee, assessment, history, now);
        return false;
      }
    }
    if (assessment.next.preconditions.includes('agent-parked-at-screen')) {
      // The pane is read once more, now and not from the last read, and the decision is taken again with it. The
      // step proves the screen and the idle pane again itself, immediately before it starts the agent again.
      observed = { ...observed, session: this.ports.glance(employee, true).session };
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      if (!due(assessment) || !assessment.next.preconditions.includes('agent-parked-at-screen')) {
        this.#report(employee, assessment, history, now);
        return false;
      }
    }
    const action = assessment.next.action!;
    history = issueSupervisorAttempt(history, action, now);
    this.#remember(employee.id, history);
    await this.#persist();
    this.#report(
      employee,
      { ...assessment, next: { action: null, preconditions: [] } },
      history,
      now,
      'the step that is running'
    );
    await this.#act(employee, action, assessment, observed.move as SupervisorMove | undefined);
    return true;
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
    move: SupervisorMove | undefined
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
      const settled = settleSupervisorAttempt(
        this.#histories.get(employee.id) ?? EMPTY_SUPERVISOR_HISTORY,
        result.outcome,
        result.detail
      );
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
      ...(assessment.needsHuman ? { needsHuman: assessment.needsHuman } : {}),
      ...(this.#limits.has(employee.id) ? { limits: this.#limits.get(employee.id)! } : {}),
    };
    this.#reports.set(employee.id, report);
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
