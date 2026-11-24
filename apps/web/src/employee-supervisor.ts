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
 * - an employee the owner stopped or sent out of the office is never read through a port, let alone acted on.
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
  /** Everything that is already in memory. No Engine call and no await. */
  glance(employee: SupervisedEmployee): Omit<SupervisorObservation, 'move' | 'planSignedIn'>;
  openMove(employee: SupervisedEmployee): Promise<SupervisorMove | undefined>;
  planSignedIn?(accountId: string): Promise<boolean | undefined>;
  /** The owner's observe read of the laptop set-up. */
  readLaptop(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorLaptopReading | undefined>;
  /** The stopped source a set-up would start from, for an employee with no record. */
  readSource(
    employee: SupervisedEmployee,
    guard: SupervisorGuard
  ): Promise<'stopped' | 'running' | 'absent' | 'unknown'>;
  /** Fresh positive read of what runs in the employee's laptops. */
  readProvider(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorProviderPresence>;
  /** One effect each. A port that is absent is a step this office cannot take. */
  readonly actions: {
    readonly [K in SupervisorAction]?: (
      employee: SupervisedEmployee,
      guard: SupervisorGuard,
      move: SupervisorMove | undefined
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
  /** No action this long after the supervisor was created: the office is still reattaching its laptops. */
  readonly startupGraceMs: number;
  /** How long one tick waits for an action before it moves on. The action keeps its seat until it returns. */
  readonly actionWaitMs: number;
}
export const SUPERVISOR_LIMITS: EmployeeSupervisorLimits = {
  actionsPerTick: 2,
  startupGraceMs: 90_000,
  actionWaitMs: 5 * 60_000,
};

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
  'needs-sign-in',
]);

export class EmployeeSupervisor {
  readonly #histories: Map<string, SupervisorHistory>;
  readonly #reports = new Map<string, SupervisorReport>();
  /** Employees with an action that has not returned yet. */
  readonly #acting = new Map<string, Promise<void>>();
  readonly #announced = new Map<string, string>();
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
    const employees = this.ports.employees();
    const known = new Set(employees.map((employee) => employee.id));
    for (const id of [...this.#histories.keys()]) if (!known.has(id)) this.#forget(id);
    for (const id of [...this.#reports.keys()])
      if (!known.has(id)) {
        this.#reports.delete(id);
        this.#announced.delete(id);
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
    await this.#persist();
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

  async #observe(employee: SupervisedEmployee, enabled: boolean): Promise<SupervisorObservation> {
    const glance = this.ports.glance(employee);
    if (!enabled) return glance;
    const guard = this.#guard(employee, 'retry');
    const move = await this.ports.openMove(employee);
    let observed: SupervisorObservation = { ...glance, ...(move ? { move } : {}) };
    const first = classifyEmployee(observed);
    if (first.condition === 'needs-sign-in' || first.code === 'move-sign-in') {
      const account = move?.toAccount ?? employee.planAccountId;
      const signedIn =
        account && this.ports.planSignedIn ? await this.ports.planSignedIn(account).catch(() => undefined) : undefined;
      if (signedIn !== undefined) observed = { ...observed, planSignedIn: signedIn };
    }
    if (!glance.boxed || glance.busy || NO_LAPTOP_READ.has(first.condition) || first.code?.startsWith('move-'))
      return observed;
    if (first.code === 'decision-screen' || first.code === 'first-run-screen') return observed;
    if (glance.laptop.record) {
      const continuation = await this.ports.readLaptop(employee, guard);
      return continuation ? { ...observed, laptop: { ...observed.laptop, continuation } } : observed;
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
    const flags = this.#flags(employee);
    let observed = await this.#observe(employee, flags.enabled);
    let history = rollSupervisorHistory(previous, classifyEmployee(observed), now, this.policy);
    let assessment = assessEmployee(observed, history, flags, now, this.policy);
    this.#remember(employee.id, history);
    const acting = this.#acting.has(employee.id);
    const due = (step: SupervisorAssessment) => step.next.action !== null && (step.next.at ?? 0) <= now;
    if (
      !due(assessment) ||
      acting ||
      !seat ||
      now - this.#startedAt < this.limits.startupGraceMs ||
      !this.ports.actions[assessment.next.action!]
    ) {
      this.#report(employee, assessment, history, now, acting ? 'the last step to return' : undefined);
      return false;
    }
    if (assessment.next.preconditions.includes('no-agent-running')) {
      // The one read a rebuild depends on is made last, and the decision is taken again with it.
      const provider = await this.ports
        .readProvider(employee, this.#guard(employee, 'repair'))
        .catch(() => 'unknown' as const);
      observed = { ...observed, laptop: { ...observed.laptop, provider } };
      assessment = assessEmployee(observed, history, flags, now, this.policy);
      if (!due(assessment) || assessment.next.preconditions.length) {
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
    return { ...this.ports.flags(employee.owner), relaunchAvailable: !!this.ports.actions['relaunch-provider'] };
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
        return await run(employee, guard, move);
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
