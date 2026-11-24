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
 *   check. The route keeps refusing every agent, worker and service identity; this caller is none of them;
 * - a lost terminal: the same wake the owner's Wake starts, which attaches only a provider that is already running.
 */
import type { CompanyService } from './company-service.js';
import type { CompanyEmployee } from './company-types.js';
import type { CompanyWakeReport } from './company-wake.js';
import type { DockerSupervisorLaptops } from './docker-employee-supervisor-laptops.js';
import type {
  EmployeeSupervisorPorts,
  SupervisedEmployee,
  SupervisorActionResult,
  SupervisorAuditEntry,
  SupervisorGuard,
  SupervisorMove,
} from './employee-supervisor.js';
import type { SupervisorBusy, SupervisorHistory, SupervisorObservation } from './employee-supervisor-policy.js';
import { PlanMoveError, type PlanMoveExecutor, type PlanMoves } from './plan-move.js';
import { viewerHealth } from './worker-provider-health.js';

interface OfficeSession {
  readonly pid: number | null;
  readonly status?: string;
  readonly runtimeHealth?: 'healthy' | 'dead' | 'disconnected' | 'unknown';
  readonly runtimeHealthScope?: 'provider' | 'terminal';
  readonly paneExit?: unknown;
  readonly viewerInputHeld?: boolean;
  readonly paneLifecycleInFlight?: boolean;
  startupScreen?(): NonNullable<SupervisorObservation['session']['startupScreen']> | null;
}

export interface OfficeSupervisorDeps {
  readonly company: Pick<CompanyService, 'registeredEmployees' | 'view' | 'employeeRecoveryAvailable' | 'store'>;
  session(sessionId: string): OfficeSession | undefined;
  /** The office has restored its sessions; false while it is starting or shutting down. */
  ready(): boolean;
  /** Present only under the boxed laptop runtime. */
  readonly laptops?: DockerSupervisorLaptops;
  /** The laptop runtime's own last attempt to attach each office terminal. */
  restorations(): readonly { employeeId: string; state: 'attached' | 'held'; code?: string }[];
  providerHealth?(employee: CompanyEmployee): { state: 'healthy' | 'dead' | 'unknown' } | undefined;
  ownerStopPending(sessionId: string): boolean;
  readonly moves: Pick<PlanMoves, 'list' | 'get' | 'continueDocker' | 'abandonHeldDockerMove'>;
  /** A plan move executor that can only continue the original of a held move, while `current` holds. */
  moveExecutor(employee: SupervisedEmployee, current: () => boolean): PlanMoveExecutor;
  planSignedIn(accountId: string): Promise<boolean | undefined>;
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
const holds = (guard: SupervisorGuard) => () => {
  try {
    guard();
    return true;
  } catch {
    return false;
  }
};

export function officeSupervisorPorts(deps: OfficeSupervisorDeps): EmployeeSupervisorPorts {
  const now = deps.now ?? Date.now;
  const screens = new Map<string, { at: number; value: SupervisorObservation['session']['startupScreen'] }>();
  const employees = (): SupervisedEmployee[] =>
    deps.company.registeredEmployees().map((employee) => ({
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
  const screen = (employee: SupervisedEmployee, session: OfficeSession | undefined) => {
    if (!session?.startupScreen || session.pid === null || session.paneExit || session.status === 'busy') {
      screens.delete(employee.sessionId);
      return undefined;
    }
    const cached = screens.get(employee.sessionId);
    if (cached && now() - cached.at < SCREEN_READ_MS) return cached.value;
    let value: SupervisorObservation['session']['startupScreen'];
    try {
      const read = session.startupScreen();
      value = read ? { label: read.label, kind: read.kind, answering: read.answering } : undefined;
    } catch {
      value = undefined;
    }
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
    const startupScreen = screen(employee, session);
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
        ...(startupScreen ? { startupScreen } : {}),
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
  const openMove = async (employee: SupervisedEmployee): Promise<SupervisorMove | undefined> => {
    const open = (await deps.moves.list(employee.owner))
      .filter((row) => row.employeeId === employee.id && !['completed', 'failed'].includes(row.phase))
      // A held move of the retired runtime never gated a laptop and keeps its own recovery record.
      .filter((row) => row.backend === 'docker' || row.phase !== 'recovery-required');
    const row = open[0];
    if (!row) return undefined;
    return {
      id: row.id,
      docker: row.backend === 'docker',
      phase: row.phase,
      busy: false,
      ...(row.error ? { error: row.error } : {}),
      // More than one open move is the owner's to untangle: nothing is offered.
      allowedActions: open.length === 1 ? [...(row.allowedActions ?? [])] : [],
      toAccount: row.toAccount,
    };
  };
  const moveRefusal = (error: unknown): SupervisorActionResult => {
    if (!(error instanceof PlanMoveError)) throw error;
    // A PlanMoveError carries a sentence written for the API caller.
    return {
      outcome: /still (?:active|working|waiting)/.test(error.message) ? 'busy' : 'refused',
      detail: error.message,
    };
  };
  const laptops = deps.laptops;
  return {
    now,
    ready: () => deps.ready(),
    employees,
    flags,
    glance,
    openMove,
    planSignedIn: (accountId) => deps.planSignedIn(accountId),
    readLaptop: async (employee, guard) => laptops?.read(employee, guard),
    readSource: async (employee, guard) => (laptops ? laptops.source(employee, guard) : 'unknown'),
    readProvider: async (employee, guard) => (laptops ? laptops.provider(employee, guard) : 'unknown'),
    actions: {
      ...(laptops
        ? {
            'resend-continuation': (employee: SupervisedEmployee, guard: SupervisorGuard) =>
              laptops.resend(employee, guard),
            'start-continuation': (employee: SupervisedEmployee, guard: SupervisorGuard) =>
              laptops.start(employee, guard),
            'rebuild-laptop': (employee: SupervisedEmployee, guard: SupervisorGuard) =>
              laptops.rebuild(employee, guard),
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
          await deps.moves.abandonHeldDockerMove(move.id, employee.id, employee.owner, () => {
            if (!holds(guard)()) throw new PlanMoveError('The office supervisor may no longer abandon this move', 403);
          });
          return { outcome: 'done', detail: 'abandoned ' + move.id };
        } catch (error) {
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
