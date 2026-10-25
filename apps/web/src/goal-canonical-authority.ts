/** Read-only Goal authority from the existing CompanyService store and real current runtime/owner services.
 * No trust reader, signer, generation allocator, grant writer, custody proof or production bootstrap. */
import type { FastifyRequest } from 'fastify';
import type { CompanyService } from './company-service.js';
import type { CompanyEmployee, CompanyState, GoalGrant, GoalRecord } from './company-types.js';
import type { SessionManager } from './session-manager.js';
import type { ChatroomService } from './chatroom-service.js';
import type { OwnerAuthService } from './owner-auth/service.js';
import { GoalAccessError, type GoalAuthentication, type GoalPrincipal } from './goal-access.js';
import { ownerGoalAuthentication } from './goal-owner-auth.js';
import { goalRouteAction, type GoalAction } from './goal-route-policy.js';

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const SESSION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const valid = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\n') && !value.includes('\r') && pattern.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function refuse(): never {
  throw new GoalAccessError('Canonical Goal authority unavailable or no longer current');
}
function synchronous(value: unknown): void {
  if (value !== undefined) {
    if (value && typeof (value as PromiseLike<unknown>).then === 'function')
      void Promise.resolve(value).catch(() => undefined);
    refuse();
  }
}
export interface CanonicalGoalBinding {
  readonly owner?: string;
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}
export interface GoalCanonicalAuthorityOptions {
  /** The SAME CompanyService used by WebServer, never a second store/status service. */
  readonly company: Pick<CompanyService, 'store'>;
  readonly sessions: Pick<SessionManager, 'getSession'>;
  readonly retirement: Pick<ChatroomService, 'isRetired'>;
  readonly owner: Pick<OwnerAuthService, 'session'>;
  /** Existing mandatory custody port. This class does not establish deployment isolation. */
  readonly custody: Pick<GoalAuthentication, 'assertPrivateCustody'>;
  readonly now?: () => number;
}

/** Supplies GoalBrokerPorts.binding and GoalServerPorts.assertAction structurally.
 * It authenticates nobody: only the accepted proof/owner boundary may supply principals.
 * Scope admission supplements (never replaces) canonical r3 command/CAS/replay checks. */
export class GoalCanonicalAuthority {
  private readonly options?: Readonly<GoalCanonicalAuthorityOptions>;
  constructor(options?: GoalCanonicalAuthorityOptions) {
    if (options) this.options = Object.freeze({ ...options });
  }
  private get source(): Readonly<GoalCanonicalAuthorityOptions> {
    return this.options ?? refuse();
  }
  private snapshot(): CompanyState {
    const { company, custody } = this.source;
    synchronous(custody.assertPrivateCustody(company.store.file));
    const state = company.store.snapshot(); // Existing fresh canonical read, not a cached/parallel authority store.
    synchronous(custody.assertPrivateCustody(company.store.file));
    return state;
  }
  private employee(state: CompanyState, id: unknown, owner?: string): CompanyEmployee {
    if (!valid(ID, id)) refuse();
    const matches = state.employees.filter((employee) => employee.id === id && employee.owner === owner);
    if (matches.length !== 1) refuse();
    const employee = matches[0]!;
    if (
      employee.bindingMigration ||
      employee.onVacation ||
      employee.desiredRunning === false ||
      !valid(SESSION, employee.sessionId) ||
      !positive(employee.sessionGeneration) ||
      state.employees.filter((candidate) => candidate.sessionId === employee.sessionId).length !== 1
    )
      refuse();
    return employee;
  }
  private liveEmployee(state: CompanyState, id: unknown, owner?: string): CompanyEmployee {
    const employee = this.employee(state, id, owner);
    const session = this.source.sessions.getSession(employee.sessionId);
    if (
      !session ||
      session.id !== employee.sessionId ||
      session.owner !== employee.owner ||
      !session.isRunning() ||
      this.source.retirement.isRetired(employee.sessionId)
    )
      refuse();
    return employee;
  }
  private principal(state: CompanyState, principal: GoalPrincipal, request: FastifyRequest): void {
    if (principal.kind === 'owner') {
      ownerGoalAuthentication(this.source.owner, this.source.custody).assertCurrent(principal, request);
      return;
    }
    if (principal.kind !== 'employee') refuse();
    const employee = this.liveEmployee(state, principal.employeeId, principal.owner);
    if (employee.sessionId !== principal.sessionId || employee.sessionGeneration !== principal.sessionGeneration)
      refuse();
  }
  /** Exact current binding only. The fixed OfficeAPI connection remains distinct from this canonical lookup. */
  binding(sessionId: string): CanonicalGoalBinding | undefined {
    try {
      if (!valid(SESSION, sessionId)) refuse();
      const state = this.snapshot(),
        matches = state.employees.filter((employee) => employee.sessionId === sessionId);
      if (matches.length !== 1) refuse();
      const employee = this.liveEmployee(state, matches[0]!.id, matches[0]!.owner);
      return Object.freeze({
        owner: employee.owner,
        employeeId: employee.id,
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
      });
    } catch {
      return undefined;
    }
  }
  private goal(state: CompanyState, id: unknown, principal: GoalPrincipal): GoalRecord {
    if (!valid(ID, id)) refuse();
    const matches = state.goals.filter((goal) => goal.id === id && goal.owner === principal.owner);
    if (matches.length !== 1) refuse();
    return matches[0]!;
  }
  private target(state: CompanyState, goal: GoalRecord): void {
    const employee = this.employee(state, goal.employeeId, goal.owner);
    if (employee.sessionId !== goal.sessionId || employee.sessionGeneration !== goal.sessionGeneration) refuse();
  }
  private grant(
    state: CompanyState,
    id: unknown,
    kind: GoalGrant['kind'],
    principal: GoalPrincipal,
    targetId: string,
    goal?: GoalRecord,
    expectedSequence?: unknown
  ): void {
    if (principal.kind !== 'employee' || !valid(ID, id)) refuse();
    const matches = state.goalGrants.filter((grant) => grant.id === id && grant.owner === principal.owner);
    if (matches.length !== 1) refuse();
    const grant = matches[0]!,
      now = (this.source.now ?? Date.now)();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      grant.kind !== kind ||
      grant.employeeId !== principal.employeeId ||
      grant.sessionId !== principal.sessionId ||
      grant.sessionGeneration !== principal.sessionGeneration ||
      grant.targetEmployeeId !== targetId ||
      grant.expiresAt <= now ||
      state.goalGrantRevocations.some(
        (revocation) => revocation.grantId === grant.id && revocation.owner === principal.owner
      )
    )
      refuse();
    const target = this.employee(state, targetId, principal.owner);
    if (grant.targetSessionId !== target.sessionId || grant.targetSessionGeneration !== target.sessionGeneration)
      refuse();
    if (
      kind === 'VERIFY' &&
      (!goal ||
        principal.employeeId === targetId ||
        grant.goalId !== goal.id ||
        grant.goalGeneration !== goal.generation ||
        grant.goalSequence !== expectedSequence)
    )
      refuse();
  }
  assertAction(action: GoalAction, principal: GoalPrincipal, request: FastifyRequest): void {
    try {
      if (goalRouteAction(request) !== action) refuse();
      const state = this.snapshot();
      this.principal(state, principal, request);
      const params = (request.params ?? {}) as Record<string, unknown>;
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const own = (goal: GoalRecord) =>
        principal.kind === 'employee' &&
        goal.employeeId === principal.employeeId &&
        goal.sessionId === principal.sessionId &&
        goal.sessionGeneration === principal.sessionGeneration;
      switch (action) {
        case 'READ':
          if (request.routeOptions.url === '/api/goals/:id') {
            const goal = this.goal(state, params.id, principal);
            if (principal.kind !== 'owner') {
              if (!own(goal)) refuse();
              this.target(state, goal);
            }
          }
          break; // list visibility remains the core's exact own/owner filter, never a team full-read grant.
        case 'CREATE': {
          const target = this.employee(state, body.employeeId, principal.owner);
          if (
            body.sessionId !== target.sessionId ||
            body.sessionGeneration !== target.sessionGeneration ||
            (principal.kind !== 'owner' && principal.employeeId !== target.id)
          )
            refuse();
          break;
        }
        case 'METADATA_READ':
          if (!valid(ID, params.employeeId)) refuse();
          if (principal.kind !== 'owner' && principal.employeeId !== params.employeeId)
            this.grant(
              state,
              (request.query as Record<string, unknown> | undefined)?.grantId,
              'METADATA_READ',
              principal,
              params.employeeId
            );
          break;
        case 'TRANSITION': {
          const goal = this.goal(state, params.id, principal);
          this.target(state, goal);
          if (principal.kind !== 'owner') {
            if (body.verifierGrantId !== undefined)
              this.grant(
                state,
                body.verifierGrantId,
                'VERIFY',
                principal,
                goal.employeeId,
                goal,
                body.expectedSequence
              );
            else if (!own(goal)) refuse();
          }
          // r3 owns transition legality, worker REVIEW freeze and exact historical replay. No preview mutation here.
          break;
        }
        case 'ADOPT':
        case 'ATTEST_UNBLOCKER': {
          if (principal.kind !== 'owner') refuse();
          const goal = this.goal(state, params.id, principal);
          if (action === 'ADOPT') this.employee(state, goal.employeeId, principal.owner);
          else this.target(state, goal);
          break;
        }
        case 'ISSUE_GRANT':
          if (principal.kind !== 'owner') refuse();
          this.employee(state, body.employeeId, principal.owner);
          this.employee(state, body.targetEmployeeId, principal.owner);
          if (body.kind === 'VERIFY') {
            const goal = this.goal(state, body.goalId, principal);
            this.target(state, goal);
          } else if (body.kind !== 'METADATA_READ') refuse();
          break;
        case 'REVOKE_GRANT':
          if (
            principal.kind !== 'owner' ||
            !valid(ID, params.id) ||
            !state.goalGrants.some((grant) => grant.id === params.id && grant.owner === principal.owner)
          )
            refuse();
          break;
        case 'REVOKE_PROOF':
          if (
            principal.kind !== 'owner' ||
            !valid(ID, params.id) ||
            !state.goalUnblockProofs.some((proof) => proof.id === params.id && proof.owner === principal.owner)
          )
            refuse();
          break;
        default:
          refuse();
      }
      // Repeat current owner/runtime and custody after all scoped lookup work; the canonical facade repeats at commit.
      synchronous(this.source.custody.assertPrivateCustody(this.source.company.store.file));
      this.principal(state, principal, request);
    } catch {
      refuse();
    }
  }
}
