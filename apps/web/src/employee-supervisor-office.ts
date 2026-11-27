/**
 * @fileoverview The office supervisor's ports, composed from the running office.
 *
 * This is the only place the supervisor meets the application: every read and every step below is one call to a
 * service method that an owner route already calls. The supervisor is named `office supervisor` in the admin audit
 * log and in plan move audit lines; it never borrows an owner request.
 *
 * What stands where a route proves the owner:
 * - laptop steps: `DockerSupervisorLaptops` (see that file's comment);
 * - continuing a held plan move: a `supervisor` requester for the ORIGINAL of that move
 *   (`captureDockerPlanMoveSupervisorRequester`), built by the server and passed in as `moveExecutor`;
 * - abandoning a held plan move: `PlanMoves.abandonHeldDockerMove` with the supervisor's guard as its `authorized`
 *   check. The route keeps refusing every agent, worker and service identity; this caller is none of them. It
 *   writes the move's journal only and takes no executor, so it cannot issue, repeat or inspect a provider launch;
 * - closing a held move of the retired runtime, which gates no laptop and only keeps its employee locked: the
 *   owner's own adoption (`PlanMoves.resolve`) when the employee already works on the session that move was
 *   creating, otherwise `PlanMoves.settleRetiredMove`. Both change the journal only and keep the employee where
 *   they work now;
 * - a lost terminal: the same wake the owner's Wake starts, which attaches only a provider that is already running;
 * - a lost terminal whose input is also held for good: what the office's own terminal object says of that hold and
 *   of the agent's turn (`readSupervisedTerminal`), read from memory. The rebuild that follows is a laptop step;
 * - any other laptop that only a rebuild settles while an agent runs in it: what that same terminal object shows
 *   of the agent's turn (`readTerminalTurn`), so that the laptop is rebuilt between turns and never during one;
 * - an employee with no approved resource limits: `DockerSupervisorLaptops.applyStandingLimits`, which saves the
 *   owner's standing default through the store method behind the docker-policy route;
 * - a session that is not in a laptop: the same wake;
 * - a laptop at the provider's sign-in screen: the plan sign-in reconciler's own pass for that one plan, asked for
 *   now instead of at its next read. It places only a sign-in some holder of that plan already has;
 * - an agent parked on a provider start-up screen (a sign-in the office put back, a first-run screen it could not
 *   answer): what the office's own terminal object says of that screen (`readParkedScreen`), read from one pane
 *   capture. The office never types at such a screen from here. The rebuild that starts the agent again is a
 *   laptop step, under the rule of every laptop an agent may run in;
 * - keeping a running laptop's approved limits in place: `DockerSupervisorLaptops.keepLimits`, for an employee in
 *   the office or not;
 * - the pool every laptop shares, after a host restart: `DockerSupervisorLaptops.keepPool`, under the owner's
 *   standing switch for repairs where the cold recovery routes prove a signed-in owner;
 * - the stored home of a stopped laptop, before it is rebuilt: `DockerSupervisorLaptops.storedHome`, a read.
 */
import type { CompanyService } from './company-service.js';
import type { CompanyEmployee } from './company-types.js';
import type { CompanyWakeReport } from './company-wake.js';
import type { DockerSupervisorLaptops } from './docker-employee-supervisor-laptops.js';
import { employeeStartupOrder } from './employee-startup-order.js';
import { laptopSignInHolderId, type PlanSignInReport } from './plan-signin-reconciler.js';
import type {
  EmployeeSupervisorPorts,
  SupervisedEmployee,
  SupervisorActionResult,
  SupervisorAuditEntry,
  SupervisorGuard,
  SupervisorMove,
  SupervisorPoolGuard,
  SupervisorPoolStep,
} from './employee-supervisor.js';
import {
  SIGN_IN_NO_FOLDER,
  SIGN_IN_NOWHERE,
  readParkedScreen,
  readSupervisedTerminal,
  readTerminalTurn,
  type SupervisedScreenTerminal,
  type SupervisorBusy,
  type SupervisorHistory,
  type SupervisorPrecondition,
  type SupervisorScreenReading,
} from './employee-supervisor-policy.js';
import { PlanMoveError, type PlanMoveExecutor, type PlanMoveRecord, type PlanMoves } from './plan-move.js';
import { viewerHealth } from './worker-provider-health.js';

interface OfficeSession extends SupervisedScreenTerminal {
  readonly runtimeHealth?: 'healthy' | 'dead' | 'disconnected' | 'unknown';
  readonly runtimeHealthScope?: 'provider' | 'terminal';
}

export interface OfficeSupervisorDeps {
  readonly company: Pick<CompanyService, 'registeredEmployees' | 'view' | 'employeeRecoveryAvailable' | 'store'>;
  session(sessionId: string): OfficeSession | undefined;
  /**
   * The saved record of a session says its terminal input is held. Asked only while the office has no terminal
   * object for that session, as after an office restart: the hold is saved and outlives the object.
   */
  inputHeldOnRecord?(sessionId: string): boolean;
  /** The office has restored its sessions; false while it is starting or shutting down. */
  ready(): boolean;
  /** What the office is doing about not being ready, when that takes a while; see `EmployeeSupervisorPorts`. */
  notReady?(): string | undefined;
  /** Present only under the boxed laptop runtime. */
  readonly laptops?: DockerSupervisorLaptops;
  /** The laptop runtime's own last attempt to attach each office terminal. */
  restorations(): readonly { employeeId: string; state: 'attached' | 'held'; code?: string }[];
  providerHealth?(employee: CompanyEmployee): { state: 'healthy' | 'dead' | 'unknown' } | undefined;
  ownerStopPending(sessionId: string): boolean;
  readonly moves: Pick<
    PlanMoves,
    'list' | 'get' | 'continueDocker' | 'abandonHeldDockerMove' | 'resolve' | 'settleRetiredMove'
  >;
  /** A plan move executor that can only continue the original of a held move, while `current` holds. */
  moveExecutor(employee: SupervisedEmployee, current: () => boolean): PlanMoveExecutor;
  planSignedIn(accountId: string): Promise<boolean | undefined>;
  /**
   * Read every copy of one plan's sign-in now and put right what can be (`reconcile`), and what the last read of
   * one plan found (`report`, from memory). Absent where no laptop holds one.
   */
  readonly signIn?: {
    reconcile(accountId: string): Promise<PlanSignInReport | undefined>;
    report?(accountId: string): PlanSignInReport | undefined;
  };
  /** The owner's Wake. */
  wake(employeeId: string, options: { stillCurrent: () => boolean }): Promise<CompanyWakeReport>;
  load(): Map<string, SupervisorHistory>;
  save(histories: ReadonlyMap<string, SupervisorHistory>): Promise<void>;
  audit(entry: SupervisorAuditEntry): void;
  log?(line: string): void;
  now?(): number;
}

/** How often a session that looks fine has its screen read for a provider start-up screen. */
const SCREEN_READ_MS = 60_000;
/** How old the reconciler's last read of a plan may be and still say what a laptop holds. It reads once a minute. */
const SIGN_IN_REPORT_MS = 5 * 60_000;
/**
 * How long a held move of the retired runtime is left out of the supervisor's view after its closing step was
 * refused. Such a move gates no laptop, so it must not stand in front of the laptop's own repair; it is offered
 * again after this time.
 */
const RETIRED_MOVE_RETRY_MS = 6 * 60 * 60_000;
const MOVE_BUSY = /still (?:active|working|waiting)/;
/** A held move of the retired runtime that the office may close: no laptop journal and no resource transaction. */
const retiredHeld = (row: PlanMoveRecord): boolean =>
  row.backend !== 'docker' &&
  row.phase === 'recovery-required' &&
  !row.resourceIntent &&
  !row.resourcePhase &&
  row.resourceOwnerScope === undefined &&
  !row.purpose;
/** The sentence a move closed by the office carries from then on: who closed it, on which rule, and why. */
const closingNote = (move: SupervisorMove): string =>
  "Closed by the office on the owner's standing rule (company setting supervisorAutoRepair), because it could " +
  'not be finished. It had stopped with: ' +
  (move.error ?? 'no recorded reason').slice(0, 600);
const holds = (guard: SupervisorGuard) => () => {
  try {
    guard();
    return true;
  } catch {
    return false;
  }
};

/** What a terminal the office is reading shows of its agent's turn; nothing for one it is not reading. */
function shownTurn(session: OfficeSession | undefined): Partial<ReturnType<typeof readTerminalTurn>> {
  const seen = readTerminalTurn(session);
  return seen.turn === 'unknown' ? {} : seen;
}

export function officeSupervisorPorts(deps: OfficeSupervisorDeps): EmployeeSupervisorPorts {
  const now = deps.now ?? Date.now;
  const screens = new Map<string, { at: number; value: SupervisorScreenReading }>();
  // In the office's start-up order: the supervisor attends to employees who are level in that order.
  const employees = (): SupervisedEmployee[] =>
    employeeStartupOrder(deps.company.registeredEmployees()).map((employee) => ({
      id: employee.id,
      name: employee.name,
      owner: employee.owner,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      desiredRunning: employee.desiredRunning,
      onVacation: employee.onVacation === true,
      bindingMigration: !!employee.bindingMigration,
      ...(employee.runtimeRecipe?.subscriptionProfile
        ? {
            planAccountId: employee.runtimeRecipe.subscriptionProfile.id,
            planLabel: employee.runtimeRecipe.subscriptionProfile.label,
          }
        : employee.runtimeRecipe?.customModel
          ? { planLabel: 'their local model' }
          : {}),
    }));
  const flags = (owner: string | undefined) => {
    const settings = deps.company.view(owner).settings;
    return { enabled: settings.supervisorEnabled !== false, autoRepair: settings.supervisorAutoRepair !== false };
  };
  const screen = (employee: SupervisedEmployee, session: OfficeSession | undefined): SupervisorScreenReading => {
    if (!session?.startupScreen || session.pid === null || session.paneExit || session.status === 'busy') {
      screens.delete(employee.sessionId);
      return {};
    }
    // A session that looked fine is read again a minute later. One that showed a screen is read at every look, so
    // the look the driver takes before a step reads the pane and never a kept screen.
    const cached = screens.get(employee.sessionId);
    if (cached && !cached.value.startupScreen && now() - cached.at < SCREEN_READ_MS) return cached.value;
    const value = readParkedScreen(session);
    if (screens.size > 512) screens.clear();
    screens.set(employee.sessionId, { at: now(), value });
    return value;
  };
  const busy = (employee: SupervisedEmployee, session: OfficeSession | undefined): SupervisorBusy | undefined =>
    deps.company.store.publicationUnconfirmed
      ? 'publication-unconfirmed'
      : deps.ownerStopPending(employee.sessionId)
        ? 'owner-stop-pending'
        : !deps.company.employeeRecoveryAvailable(employee.id, employee.owner)
          ? 'recovery-pending'
          : deps.laptops?.flightActive(employee.id)
            ? 'continuation-flight'
            : session?.paneLifecycleInFlight
              ? 'lifecycle-in-progress'
              : undefined;
  const glance: EmployeeSupervisorPorts['glance'] = (employee) => {
    const session = deps.session(employee.sessionId);
    const rows = deps.company.registeredEmployees();
    const row = rows.find((value) => value.id === employee.id);
    const reports = deps.restorations();
    const report = reports.find((value) => value.employeeId === employee.id);
    const laptop = deps.laptops?.glance(employee.id);
    const health = row ? deps.providerHealth?.(row)?.state : undefined;
    const parked = screen(employee, session);
    const held = busy(employee, session);
    return {
      employeeId: employee.id,
      name: employee.name,
      desiredRunning: employee.desiredRunning,
      onVacation: employee.onVacation,
      bindingMigration: employee.bindingMigration,
      // Under the laptop runtime every employee runs in a laptop; nothing is started on the office host.
      boxed: !!deps.laptops,
      ...(employee.planLabel ? { planLabel: employee.planLabel } : {}),
      session: {
        available: !!session,
        runtimeHealth: session?.runtimeHealth ?? 'unknown',
        viewerHealth: viewerHealth(session),
        ...(health ? { providerHealth: health } : {}),
        ...parked,
        // What the pane shows of the agent's turn is read for every laptop: a rebuild is judged by it. A pane
        // that is not read reports nothing, which the policy takes for unknown. A held input is reported on top.
        ...(deps.laptops ? shownTurn(session) : {}),
        ...readSupervisedTerminal(session, !session && deps.inputHeldOnRecord?.(employee.sessionId) === true),
      },
      laptop: {
        record: null,
        bound: false,
        policyApproved: false,
        templateOnRecord: false,
        ...laptop,
        ...(report
          ? {
              restoration:
                report.state === 'attached' ? { state: 'attached' } : { state: 'held', code: report.code ?? '' },
            }
          : {}),
        // Another laptop of this box is attached to a live terminal, so the pool they share is alive.
        poolAlive: reports.some(
          (other) =>
            other.employeeId !== employee.id &&
            other.state === 'attached' &&
            rows.some((value) => value.id === other.employeeId && deps.session(value.sessionId)?.pid != null)
        ),
      },
      ...(held ? { busy: held } : {}),
    };
  };
  /** When the closing step of a held move of the retired runtime was last refused, by move. In memory only. */
  const retiredRefused = new Map<string, number>();
  const shown = (row: PlanMoveRecord, allowedActions: readonly string[]): SupervisorMove => ({
    id: row.id,
    docker: row.backend === 'docker',
    phase: row.phase,
    busy: false,
    ...(row.error ? { error: row.error } : {}),
    allowedActions,
    toAccount: row.toAccount,
  });
  const openMove = async (employee: SupervisedEmployee): Promise<SupervisorMove | undefined> => {
    // Newest first, as the service lists them.
    const rows = (await deps.moves.list(employee.owner)).filter(
      (row) => row.employeeId === employee.id && !['completed', 'failed'].includes(row.phase)
    );
    // A held move of the retired runtime never gated a laptop: a laptop move, or any move that is working, is
    // shown before it.
    const open = rows.filter((row) => row.backend === 'docker' || row.phase !== 'recovery-required');
    const oldest = open.at(-1);
    // With more than one open move none is continued: which of them the employee should end on is not the office's
    // to choose. They are closed one at a time, oldest first, until one is left; that one keeps its whole ladder.
    if (oldest)
      return shown(
        oldest,
        (oldest.allowedActions ?? []).filter((name) => open.length === 1 || name === 'abandon')
      );
    // Closing one is a repair. With repairs switched off it stays out of sight, as it always was: shown, it would
    // only stand in front of the laptop's own retries.
    if (!deps.laptops || !flags(employee.owner).autoRepair) return undefined;
    const retired = rows
      .filter(retiredHeld)
      .filter((row) => now() - (retiredRefused.get(row.id) ?? -Infinity) >= RETIRED_MOVE_RETRY_MS)
      .at(-1);
    return retired ? shown(retired, ['settle']) : undefined;
  };
  const moveRefusal = (error: unknown): SupervisorActionResult => {
    if (!(error instanceof PlanMoveError)) throw error;
    // A PlanMoveError carries a sentence written for the API caller.
    return { outcome: MOVE_BUSY.test(error.message) ? 'busy' : 'refused', detail: error.message };
  };
  /**
   * Close a held move of the retired runtime and keep the employee where they work now. When the employee already
   * works on the session the move was creating and its source was verifiably cleaned up, that is the owner's own
   * adoption, which finishes the record. Otherwise, or when the adoption's own checks refuse, only the record is
   * closed. Neither starts, stops or rebinds a session.
   */
  const closeRetired = async (
    employee: SupervisedEmployee,
    guard: SupervisorGuard,
    record: PlanMoveRecord | undefined,
    move: SupervisorMove
  ): Promise<SupervisorActionResult> => {
    if (!record || record.employeeId !== employee.id || !retiredHeld(record))
      return { outcome: 'refused', detail: 'the move changed' };
    const boxed = () => {
      if (!holds(guard)()) throw new PlanMoveError('The office supervisor may no longer close this move', 403);
      if (!deps.laptops?.glance(employee.id).bound)
        throw new PlanMoveError('The employee does not work in a laptop, so this move keeps its own recovery', 409);
    };
    boxed();
    if (record.newSession === employee.sessionId && record.sourceStopRequested && record.sourceCleanupVerified) {
      try {
        await deps.moves.resolve(
          move.id,
          { oldSession: record.oldSession, newSession: record.newSession, toAccount: record.toAccount },
          employee.owner,
          deps.moveExecutor(employee, holds(guard))
        );
        return { outcome: 'done', detail: 'adopted ' + move.id };
      } catch (error) {
        if (!(error instanceof PlanMoveError) || MOVE_BUSY.test(error.message)) throw error;
      }
    }
    await deps.moves.settleRetiredMove(move.id, employee.id, employee.owner, boxed, closingNote(move));
    return { outcome: 'done', detail: 'closed ' + move.id };
  };
  const laptops = deps.laptops;
  return {
    now,
    ready: () => deps.ready(),
    ...(deps.notReady ? { notReady: () => deps.notReady!() } : {}),
    employees,
    flags,
    glance,
    openMove,
    planSignedIn: (accountId) => deps.planSignedIn(accountId),
    laptopSignedIn: (employee) => {
      const report = employee.planAccountId ? deps.signIn?.report?.(employee.planAccountId) : undefined;
      if (!report || now() - report.checkedAt > SIGN_IN_REPORT_MS) return undefined;
      const holder = report.holders.find((value) => value.id === laptopSignInHolderId(employee.id));
      return holder ? holder.state === 'usable' : undefined;
    },
    readLaptop: async (employee, guard) => laptops?.read(employee, guard),
    readSource: async (employee, guard) => (laptops ? laptops.source(employee, guard) : 'unknown'),
    readProvider: async (employee, guard) => (laptops ? laptops.provider(employee, guard) : 'unknown'),
    ...(laptops
      ? {
          keepLimits: (employee: SupervisedEmployee, guard: SupervisorGuard) => laptops.keepLimits(employee, guard),
          keepPool: (
            candidates: readonly SupervisedEmployee[],
            guard: SupervisorPoolGuard,
            step?: SupervisorPoolStep
          ) => laptops.keepPool(candidates, guard, step),
          readStoredHome: (employee: SupervisedEmployee, guard: SupervisorGuard) => laptops.storedHome(employee, guard),
          storedHomeCheck: () => laptops.storedHomeCheck(),
          rememberHome: (employee: SupervisedEmployee, guard: SupervisorGuard) => laptops.rememberHome(employee, guard),
        }
      : {}),
    actions: {
      ...(laptops
        ? {
            'resend-continuation': (employee: SupervisedEmployee, guard: SupervisorGuard) =>
              laptops.resend(employee, guard),
            'apply-standing-limits': (employee: SupervisedEmployee, guard: SupervisorGuard) =>
              laptops.applyStandingLimits(employee, guard),
            'start-continuation': (employee: SupervisedEmployee, guard: SupervisorGuard) =>
              laptops.start(employee, guard),
            'rebuild-laptop': (
              employee: SupervisedEmployee,
              guard: SupervisorGuard,
              _move: SupervisorMove | undefined,
              proved?: readonly SupervisorPrecondition[]
            ) => laptops.rebuild(employee, guard, proved),
          }
        : {}),
      ...(deps.signIn
        ? {
            'replace-sign-in': async (
              employee: SupervisedEmployee,
              guard: SupervisorGuard
            ): Promise<SupervisorActionResult> => {
              if (!employee.planAccountId) return { outcome: 'refused', detail: 'the employee is on no plan' };
              guard();
              const report = await deps.signIn!.reconcile(employee.planAccountId);
              const id = laptopSignInHolderId(employee.id);
              const holder = report?.holders.find((value) => value.id === id);
              if (!report || !holder) return { outcome: 'refused', detail: SIGN_IN_NO_FOLDER };
              if (holder.state === 'usable')
                return {
                  outcome: 'done',
                  detail: report.transfers.some((transfer) => transfer.to === id && transfer.outcome === 'written')
                    ? 'sign-in placed'
                    : 'sign-in already in place',
                };
              return {
                outcome: 'refused',
                detail: report.usable ? 'the sign-in could not be placed yet' : SIGN_IN_NOWHERE,
              };
            },
          }
        : {}),
      'reconnect-viewer': async (employee, guard) => {
        const report = await deps.wake(employee.id, { stillCurrent: holds(guard) });
        if (report.awakened.includes(employee.id)) return { outcome: 'done', detail: 'attached' };
        const reason = report.skipped.find((row) => row.employeeId === employee.id)?.reason ?? 'not-attached';
        return {
          outcome: ['recovery-in-progress', 'lifecycle-in-progress'].includes(reason) ? 'busy' : 'refused',
          detail: reason,
        };
      },
      'continue-move': async (employee, guard, move) => {
        if (!move) return { outcome: 'refused', detail: 'no held move' };
        guard();
        try {
          const record = await deps.moves.get(move.id, employee.owner);
          if (
            !record ||
            record.employeeId !== employee.id ||
            record.phase !== 'recovery-required' ||
            !record.newSession
          )
            return { outcome: 'refused', detail: 'the move changed' };
          // The move outlives this call and rebinds the employee's session when it completes, so its authority
          // follows the employee by id: still switched on, same owner, still meant to be running in the office.
          const current = () => {
            const live = deps.company.registeredEmployees().find((row) => row.id === employee.id);
            return (
              deps.ready() &&
              flags(employee.owner).enabled &&
              !!live &&
              live.owner === employee.owner &&
              live.desiredRunning === true &&
              live.onVacation !== true
            );
          };
          await deps.moves.continueDocker(
            move.id,
            { oldSession: record.oldSession, newSession: record.newSession, toAccount: record.toAccount },
            employee.owner,
            deps.moveExecutor(employee, current)
          );
          return { outcome: 'done', detail: 'continuing ' + move.id };
        } catch (error) {
          return moveRefusal(error);
        }
      },
      'abandon-move': async (employee, guard, move) => {
        if (!move) return { outcome: 'refused', detail: 'no held move' };
        try {
          const record = await deps.moves.get(move.id, employee.owner);
          // Asked again for a move that has ended since: nothing is left to close, and that is no failure.
          if (record?.employeeId === employee.id && ['completed', 'failed'].includes(record.phase))
            return { outcome: 'done', detail: 'already closed ' + move.id };
          if (!move.docker) return await closeRetired(employee, guard, record, move);
          await deps.moves.abandonHeldDockerMove(
            move.id,
            employee.id,
            employee.owner,
            () => {
              if (!holds(guard)())
                throw new PlanMoveError('The office supervisor may no longer abandon this move', 403);
            },
            closingNote(move)
          );
          return { outcome: 'done', detail: 'abandoned ' + move.id };
        } catch (error) {
          if (!move.docker && !(error instanceof PlanMoveError && MOVE_BUSY.test(error.message)))
            retiredRefused.set(move.id, now());
          return moveRefusal(error);
        }
      },
    },
    load: () => deps.load(),
    save: (histories) => deps.save(histories),
    audit: (entry) => deps.audit(entry),
    log: deps.log ?? ((line) => console.log(line)),
  };
}
