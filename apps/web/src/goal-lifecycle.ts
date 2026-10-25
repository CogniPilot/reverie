/** Authenticated, effect-free Goal commands over the private canonical company transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serviceAuthorityFits, type CompanyStore } from './company-store.js';
import {
  GoalBlockerSchema,
  GoalEvidenceRefSchema,
  GoalRecordSchema,
  GoalStateSchema,
  type CompanyEmployee,
  type CompanyState,
  type GoalGrant,
  type GoalRecord,
  type ServiceGrant,
  type ServicePurposes,
  DEFAULT_SERVICE_PURPOSES,
  SERVICE_PURPOSE_NAME,
  servicePurposeScope,
  type GoalState,
  type GoalTransitionReceipt,
} from './company-types.js';
import { GoalAccessError, INACCESSIBLE_GOAL_AUTH, type GoalAuthentication, type GoalPrincipal } from './goal-access.js';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const positive = z.number().int().positive();
const instant = z.number().int().nonnegative();
const sequence = z.number().int().nonnegative();
const PrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner'), owner: z.string().min(1).max(100).optional() }).strict(),
  z
    .object({
      kind: z.literal('employee'),
      owner: z.string().min(1).max(100).optional(),
      employeeId: id,
      sessionId: id,
      sessionGeneration: positive,
    })
    .strict(),
]);
const nextAction = z.string().trim().min(1).max(2000);
const fence = {
  goalId: id,
  generation: positive,
  expectedState: GoalStateSchema,
  expectedSequence: sequence,
  sessionId: id,
  sessionGeneration: positive,
};
const CreateSchema = z
  .object({
    createId: id,
    employeeId: id,
    sessionId: id,
    sessionGeneration: positive,
    objective: z.string().trim().min(1).max(8000),
    nextAction,
    deadlineAt: instant.optional(),
    inputDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(100)
      .default([]),
  })
  .strict();
const TransitionSchema = z
  .object({
    ...fence,
    transitionId: id,
    to: GoalStateSchema,
    nextAction,
    blocker: GoalBlockerSchema.optional(),
    deadlineAt: instant.optional(),
    semanticProgressAt: instant.optional(),
    evidenceRefs: z.array(GoalEvidenceRefSchema).max(200).optional(),
    verifierGrantId: id.optional(),
    unblockProofId: id.optional(),
  })
  .strict();
const AdoptSchema = z.object({ ...fence, transitionId: id, nextAction }).strict();
const GrantSchema = z
  .object({
    kind: z.enum(['VERIFY', 'METADATA_READ']),
    employeeId: id,
    targetEmployeeId: id,
    goalId: id.optional(),
    generation: positive.optional(),
    expectedSequence: sequence.optional(),
    expiresAt: instant,
  })
  .strict();
const SERVICE_GRANT_MAX_MS = 90 * 24 * 3600_000;
const ServiceGrantInputSchema = z
  .object({
    purpose: z.string().regex(SERVICE_PURPOSE_NAME),
    principal: id,
    epoch: id,
    employeeIds: z.array(id).max(256).default([]),
    resources: z.array(id).max(256).default([]),
    expiresAt: instant,
  })
  .strict();
const ProofSchema = z
  .object({
    ...fence,
    blockerDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceRef: GoalEvidenceRefSchema,
    expiresAt: instant,
  })
  .strict();
export type CreateGoalInput = z.input<typeof CreateSchema>;
export type TransitionGoalInput = z.input<typeof TransitionSchema>;

export class GoalLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: 'GOAL_NOT_FOUND' | 'GOAL_CONFLICT' | 'GOAL_FORBIDDEN' | 'GOAL_INVALID' | 'GOAL_IDEMPOTENCY_REUSE',
    readonly status: 400 | 403 | 404 | 409
  ) {
    super(message);
  }
}
function refuse(message: string): never {
  throw new GoalLifecycleError(message, 'GOAL_FORBIDDEN', 403);
}
function conflict(message: string): never {
  throw new GoalLifecycleError(message, 'GOAL_CONFLICT', 409);
}
function invalid(message: string): never {
  throw new GoalLifecycleError(message, 'GOAL_INVALID', 400);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid('Goal command has an invalid or unsupported field');
  return result.data;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)])
    );
  return value;
}
export function goalDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
const terminal = new Set<GoalState>(['DONE', 'NO_GO', 'CANCELLED']);
const edges: Record<GoalState, readonly GoalState[]> = {
  READY: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['HOLD', 'REVIEW', 'CANCELLED'],
  HOLD: ['ACTIVE', 'CANCELLED'],
  REVIEW: ['ACTIVE', 'DONE', 'NO_GO', 'CANCELLED'],
  DONE: ['ACTIVE'],
  NO_GO: ['ACTIVE'],
  CANCELLED: ['ACTIVE'],
};
const employeeOf = (state: CompanyState, employeeId: string, owner?: string) =>
  state.employees.find((e) => e.id === employeeId && e.owner === owner);
function active(employee: CompanyEmployee | undefined): asserts employee is CompanyEmployee {
  if (!employee || employee.bindingMigration || employee.onVacation || employee.desiredRunning === false)
    refuse('Employee binding is missing, migrating or inactive');
}
function principalEmployee(state: CompanyState, principal: GoalPrincipal): CompanyEmployee | undefined {
  if (principal.kind === 'owner') return undefined;
  const employee = employeeOf(state, principal.employeeId, principal.owner);
  active(employee);
  if (employee.sessionId !== principal.sessionId || employee.sessionGeneration !== principal.sessionGeneration)
    refuse('Authenticated employee binding is stale');
  return employee;
}
function ownerOnly(principal: GoalPrincipal): void {
  if (principal.kind !== 'owner') refuse('Only the authenticated owner issues Goal authority');
}
function findGoal(state: CompanyState, goalId: string, principal: GoalPrincipal): GoalRecord {
  const goal = state.goals.find((g) => g.id === goalId && g.owner === principal.owner);
  if (!goal) throw new GoalLifecycleError('Unknown owned Goal', 'GOAL_NOT_FOUND', 404);
  return goal;
}
function currentTarget(state: CompanyState, goal: GoalRecord): CompanyEmployee {
  const employee = employeeOf(state, goal.employeeId, goal.owner);
  active(employee);
  if (employee.sessionId !== goal.sessionId || employee.sessionGeneration !== goal.sessionGeneration)
    conflict('Goal requires explicit authenticated owner adoption of the new session');
  return employee;
}
type Fenced = {
  goalId: string;
  generation: number;
  sessionId: string;
  sessionGeneration: number;
  expectedState: GoalState;
  expectedSequence: number;
};
function checkFence(goal: GoalRecord, input: Fenced, cas = true): void {
  if (
    goal.generation !== input.generation ||
    goal.sessionId !== input.sessionId ||
    goal.sessionGeneration !== input.sessionGeneration
  )
    conflict('Goal generation or session fence changed');
  if (cas && (goal.state !== input.expectedState || goal.transitionSequence !== input.expectedSequence))
    conflict('Goal state or sequence changed');
}
function snapshot(goal: GoalRecord): GoalRecord['creation'] {
  return {
    sessionId: goal.sessionId,
    sessionGeneration: goal.sessionGeneration,
    generation: goal.generation,
    state: goal.state,
    blocker: goal.blocker,
    nextAction: goal.nextAction,
    deadlineAt: goal.deadlineAt,
    semanticProgressAt: goal.semanticProgressAt,
    updatedAt: goal.updatedAt,
    transitionSequence: goal.transitionSequence,
    evidenceCount: goal.evidenceRefs.length,
  };
}
/** VERIFY is decision authority, never implicit full-record read authority. */
export type GoalVerificationView = Pick<
  GoalRecord,
  'id' | 'generation' | 'sessionId' | 'sessionGeneration' | 'state' | 'transitionSequence' | 'updatedAt'
>;
export type GoalVerificationReceipt = Pick<
  GoalTransitionReceipt,
  | 'transitionId'
  | 'sequence'
  | 'generation'
  | 'from'
  | 'to'
  | 'actorKind'
  | 'actorEmployeeId'
  | 'actorSessionId'
  | 'actorSessionGeneration'
  | 'authorityId'
  | 'operation'
  | 'at'
>;
export type GoalCommandResult =
  | { visibility: 'full'; goal: GoalRecord; receipt: GoalTransitionReceipt }
  | { visibility: 'verification'; goal: GoalVerificationView; receipt: GoalVerificationReceipt };

function canReadFull(goal: GoalRecord, principal: GoalPrincipal): boolean {
  return (
    goal.owner === principal.owner &&
    (principal.kind === 'owner' ||
      (goal.employeeId === principal.employeeId &&
        goal.sessionId === principal.sessionId &&
        goal.sessionGeneration === principal.sessionGeneration))
  );
}
function atReceipt(goal: GoalRecord, receipt: GoalTransitionReceipt, principal: GoalPrincipal): GoalCommandResult {
  // Construct the closed view directly: never spread a receipt/snapshot into a restricted response.
  // In particular receipt.after and requestDigest contain or fingerprint private worker input.
  if (!canReadFull(goal, principal))
    return {
      visibility: 'verification',
      goal: {
        id: goal.id,
        generation: receipt.generation,
        sessionId: receipt.after.sessionId,
        sessionGeneration: receipt.after.sessionGeneration,
        state: receipt.to,
        transitionSequence: receipt.sequence,
        updatedAt: receipt.after.updatedAt,
      },
      receipt: {
        transitionId: receipt.transitionId,
        sequence: receipt.sequence,
        generation: receipt.generation,
        from: receipt.from,
        to: receipt.to,
        actorKind: receipt.actorKind,
        actorEmployeeId: receipt.actorEmployeeId,
        actorSessionId: receipt.actorSessionId,
        actorSessionGeneration: receipt.actorSessionGeneration,
        authorityId: receipt.authorityId,
        operation: receipt.operation,
        at: receipt.at,
      },
    };
  const historical = structuredClone(goal);
  const { evidenceCount, ...after } = receipt.after;
  Object.assign(historical, after);
  historical.blocker = after.blocker;
  historical.deadlineAt = after.deadlineAt;
  historical.transitions = historical.transitions.filter((r) => r.sequence <= receipt.sequence);
  historical.evidenceRefs = historical.evidenceRefs.slice(0, evidenceCount);
  return { visibility: 'full', goal: GoalRecordSchema.parse(historical), receipt: structuredClone(receipt) };
}
function receipt(
  goal: GoalRecord,
  transitionId: string,
  requestDigest: string,
  from: GoalState,
  principal: GoalPrincipal,
  at: number,
  operation: 'TRANSITION' | 'ADOPT',
  authorityId?: string,
  unblockProofId?: string
): GoalTransitionReceipt {
  const result: GoalTransitionReceipt = {
    transitionId,
    requestDigest,
    sequence: goal.transitionSequence,
    generation: goal.generation,
    from,
    to: goal.state,
    actorKind: principal.kind === 'owner' ? 'owner' : authorityId ? 'verifier' : 'worker',
    ...(principal.kind === 'employee'
      ? {
          actorEmployeeId: principal.employeeId,
          actorSessionId: principal.sessionId,
          actorSessionGeneration: principal.sessionGeneration,
        }
      : {}),
    authorityId,
    unblockProofId,
    operation,
    after: snapshot(goal),
    at,
  };
  goal.transitions.push(result);
  GoalRecordSchema.parse(goal);
  return result;
}

/** No runtime effects. Public commands authenticate context; no command accepts an actor/grant assertion. */
export class GoalLifecycle {
  constructor(
    private readonly store: CompanyStore,
    private readonly now: () => number = Date.now,
    private readonly auth: GoalAuthentication = INACCESSIBLE_GOAL_AUTH,
    /** Deployment-configured service purposes; only these can be granted. */
    private readonly servicePurposes: ServicePurposes = DEFAULT_SERVICE_PURPOSES
  ) {}

  private async authenticate(context: unknown): Promise<GoalPrincipal> {
    this.auth.assertPrivateCustody(this.store.file);
    const principal = await this.auth.authenticate(context);
    if (!principal) throw new GoalAccessError('Goal authenticated integration is unavailable or refused');
    if (!PrincipalSchema.safeParse(principal).success)
      throw new GoalAccessError('Authentication adapter returned an invalid principal');
    this.auth.assertPrivateCustody(this.store.file);
    this.auth.assertCurrent(principal, context);
    return principal;
  }
  private async update<T>(
    context: unknown,
    work: (state: CompanyState, principal: GoalPrincipal, retain: (check: () => void) => void) => T
  ): Promise<T> {
    const principal = await this.authenticate(context);
    const checks: Array<() => void> = [];
    const validate = () => {
      this.auth.assertPrivateCustody(this.store.file);
      this.auth.assertCurrent(principal, context);
      for (const check of checks) check();
    };
    return this.store.update((state) => {
      principalEmployee(state, principal);
      checks.push(() => {
        principalEmployee(state, principal);
      });
      return work(state, principal, (check) => checks.push(check));
    }, validate);
  }
  private async read<T>(context: unknown, work: (state: CompanyState, principal: GoalPrincipal) => T): Promise<T> {
    const principal = await this.authenticate(context);
    const state = this.store.snapshot();
    this.auth.assertCurrent(principal, context);
    principalEmployee(state, principal);
    return structuredClone(work(state, principal));
  }
  async list(context?: unknown): Promise<GoalRecord[]> {
    return this.read(context, (state, principal) =>
      state.goals.filter((g) => g.owner === principal.owner && canReadFull(g, principal))
    );
  }
  async get(goalId: string, context?: unknown): Promise<GoalRecord> {
    parse(id, goalId);
    return this.read(context, (state, principal) => {
      const goal = findGoal(state, goalId, principal);
      if (principal.kind !== 'owner') {
        if (!canReadFull(goal, principal)) refuse('No full-record read grant for this binding');
        currentTarget(state, goal);
      }
      return goal;
    });
  }
  async forEmployee(employeeId: string, context?: unknown, metadataGrantId?: string) {
    parse(id, employeeId);
    return this.read(context, (state, principal) => {
      if (principal.kind !== 'owner' && principal.employeeId !== employeeId)
        this.grant(state, principal, metadataGrantId, 'METADATA_READ', employeeId);
      return state.goals
        .filter((g) => g.owner === principal.owner && g.employeeId === employeeId)
        .map((g) => ({
          id: g.id,
          generation: g.generation,
          employeeId: g.employeeId,
          sessionId: g.sessionId,
          sessionGeneration: g.sessionGeneration,
          state: g.state,
          blockerCategory: g.blocker?.category,
          bindingState: (() => {
            const employee = employeeOf(state, g.employeeId, g.owner);
            return employee?.bindingMigration
              ? 'MIGRATING'
              : employee?.sessionId === g.sessionId && employee.sessionGeneration === g.sessionGeneration
                ? 'CURRENT'
                : 'STALE';
          })(),
          deadlineAt: g.deadlineAt,
          semanticProgressAt: g.semanticProgressAt,
          updatedAt: g.updatedAt,
          transitionSequence: g.transitionSequence,
        }));
    });
  }
  async create(raw: unknown, context?: unknown): Promise<GoalRecord> {
    const input = parse(CreateSchema, raw);
    return this.update(context, (state, principal) => {
      const employee = employeeOf(state, input.employeeId, principal.owner);
      active(employee);
      if (employee.sessionId !== input.sessionId || employee.sessionGeneration !== input.sessionGeneration)
        conflict('Create session fence changed');
      if (principal.kind !== 'owner' && principal.employeeId !== employee.id)
        refuse('A worker creates only its own Goal');
      const digest = goalDigest({ input, principal });
      const replay = state.goals.find((g) => g.owner === principal.owner && g.createId === input.createId);
      if (replay) {
        currentTarget(state, replay);
        if (replay.generation !== 1) conflict('Create replay belongs to a superseded generation');
        if (replay.createRequestDigest !== digest)
          throw new GoalLifecycleError('Changed createId reuse', 'GOAL_IDEMPOTENCY_REUSE', 409);
        const { evidenceCount: _count, ...creation } = replay.creation;
        return GoalRecordSchema.parse({
          ...replay,
          ...creation,
          blocker: creation.blocker,
          deadlineAt: creation.deadlineAt,
          evidenceRefs: [],
          transitions: [],
        });
      }
      const at = this.now();
      const goal = GoalRecordSchema.parse({
        id: randomUUID(),
        createId: input.createId,
        employeeId: input.employeeId,
        sessionId: input.sessionId,
        sessionGeneration: input.sessionGeneration,
        objective: input.objective,
        nextAction: input.nextAction,
        deadlineAt: input.deadlineAt,
        inputDigests: input.inputDigests,
        owner: principal.owner,
        generation: 1,
        state: 'READY',
        createRequestDigest: digest,
        semanticProgressAt: at,
        evidenceRefs: [],
        createdAt: at,
        updatedAt: at,
        transitionSequence: 0,
        transitions: [],
        creation: {
          sessionId: input.sessionId,
          sessionGeneration: input.sessionGeneration,
          generation: 1,
          state: 'READY',
          nextAction: input.nextAction,
          deadlineAt: input.deadlineAt,
          semanticProgressAt: at,
          updatedAt: at,
          transitionSequence: 0,
          evidenceCount: 0,
        },
      });
      state.goals.push(goal);
      return goal;
    });
  }
  private grant(
    state: CompanyState,
    principal: GoalPrincipal,
    grantId: string | undefined,
    kind: GoalGrant['kind'],
    target: string,
    goal?: GoalRecord,
    expectedSequence?: number
  ): GoalGrant {
    if (principal.kind !== 'employee') refuse('An exact employee verifier/read grant is required');
    const grant = state.goalGrants.find((g) => g.id === grantId && g.owner === principal.owner);
    if (
      !grant ||
      grant.kind !== kind ||
      grant.employeeId !== principal.employeeId ||
      grant.sessionId !== principal.sessionId ||
      grant.sessionGeneration !== principal.sessionGeneration ||
      grant.targetEmployeeId !== target ||
      grant.expiresAt <= this.now() ||
      state.goalGrantRevocations.some((r) => r.grantId === grant.id && r.owner === principal.owner)
    )
      refuse('Goal grant is absent, expired, revoked or differently scoped');
    const targetEmployee = employeeOf(state, target, principal.owner);
    active(targetEmployee);
    if (
      grant.targetSessionId !== targetEmployee.sessionId ||
      grant.targetSessionGeneration !== targetEmployee.sessionGeneration
    )
      refuse('Grant target binding changed');
    if (
      kind === 'VERIFY' &&
      (!goal ||
        principal.employeeId === goal.employeeId ||
        grant.goalId !== goal.id ||
        grant.goalGeneration !== goal.generation ||
        grant.goalSequence !== expectedSequence)
    )
      refuse('Verifier grant does not name this independent exact review gate');
    return grant;
  }
  async issueGrant(raw: unknown, context?: unknown): Promise<GoalGrant> {
    const input = parse(GrantSchema, raw);
    return this.update(context, (state, principal) => {
      ownerOnly(principal);
      const employee = employeeOf(state, input.employeeId, principal.owner);
      const target = employeeOf(state, input.targetEmployeeId, principal.owner);
      active(employee);
      active(target);
      const at = this.now();
      if (input.expiresAt <= at || input.expiresAt > at + 3600_000) invalid('Grant expiry must be within one hour');
      if (input.kind === 'VERIFY') {
        if (!input.goalId) invalid('Verifier grant requires a Goal');
        const goal = findGoal(state, input.goalId, principal);
        currentTarget(state, goal);
        if (
          goal.employeeId !== target.id ||
          employee.id === target.id ||
          goal.generation !== input.generation ||
          goal.transitionSequence !== input.expectedSequence ||
          goal.state !== 'REVIEW'
        )
          refuse('Grant must name an independent exact current REVIEW gate');
      } else if (input.goalId !== undefined || input.generation !== undefined || input.expectedSequence !== undefined)
        invalid('Metadata grants name a target employee only');
      const grant: GoalGrant = {
        id: randomUUID(),
        kind: input.kind,
        owner: principal.owner,
        employeeId: employee.id,
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
        targetEmployeeId: target.id,
        targetSessionId: target.sessionId,
        targetSessionGeneration: target.sessionGeneration,
        goalId: input.goalId,
        goalGeneration: input.generation,
        goalSequence: input.expectedSequence,
        issuedAt: at,
        expiresAt: input.expiresAt,
      };
      state.goalGrants.push(grant);
      return grant;
    });
  }
  async revokeGrant(grantId: string, context?: unknown): Promise<void> {
    parse(id, grantId);
    await this.update(context, (state, principal) => {
      ownerOnly(principal);
      if (!state.goalGrants.some((g) => g.id === grantId && g.owner === principal.owner)) refuse('Unknown owned grant');
      if (!state.goalGrantRevocations.some((g) => g.grantId === grantId))
        state.goalGrantRevocations.push({ grantId, owner: principal.owner, at: this.now() });
    });
  }
  /** Owner-only: authority for one dedicated service principal and epoch, bound to current exact employee bindings
   * (employee-scoped purposes) or configured resource names (resource-scoped purposes). Only configured purposes;
   * never issued automatically; expiry at most 90 days. */
  async issueServiceGrant(raw: unknown, context?: unknown): Promise<ServiceGrant> {
    const input = parse(ServiceGrantInputSchema, raw);
    return this.update(context, (state, principal) => {
      ownerOnly(principal);
      const at = this.now();
      if (input.expiresAt <= at || input.expiresAt > at + SERVICE_GRANT_MAX_MS)
        invalid('Service grant expiry must be within 90 days');
      const scope = servicePurposeScope(this.servicePurposes, input.purpose);
      if (!scope) invalid('Unknown service purpose');
      const wantEmployees = scope !== 'resources',
        wantResources = scope !== 'employees';
      if (!!input.employeeIds.length !== wantEmployees || !!input.resources.length !== wantResources)
        invalid('A service grant names exactly the scope its purpose is configured for');
      if (
        new Set(input.employeeIds).size !== input.employeeIds.length ||
        new Set(input.resources).size !== input.resources.length
      )
        invalid('Service grant scope entries must be unique');
      const employees = input.employeeIds.map((employeeId) => {
        const employee = employeeOf(state, employeeId, principal.owner);
        active(employee);
        return {
          employeeId: employee.id,
          sessionId: employee.sessionId,
          sessionGeneration: employee.sessionGeneration,
        };
      });
      const grant: ServiceGrant = {
        id: randomUUID(),
        purpose: input.purpose,
        owner: principal.owner,
        principal: input.principal,
        epoch: input.epoch,
        employees,
        resources: [...input.resources],
        issuedAt: at,
        expiresAt: input.expiresAt,
      };
      state.serviceGrants.push(grant);
      // Kit AUTH-S1: refuse inside the transaction (nothing is committed) unless every live grant stays revocable.
      if (!serviceAuthorityFits(state)) refuse('Service grant storage budget exhausted');
      return grant;
    });
  }
  async revokeServiceGrant(grantId: string, context?: unknown): Promise<void> {
    parse(id, grantId);
    await this.update(context, (state, principal) => {
      ownerOnly(principal);
      if (!state.serviceGrants.some((g) => g.id === grantId && g.owner === principal.owner))
        refuse('Unknown owned service grant');
      if (!state.serviceGrantRevocations.some((g) => g.grantId === grantId))
        state.serviceGrantRevocations.push({ grantId, owner: principal.owner, at: this.now() });
    });
  }
  async attestUnblocker(raw: unknown, context?: unknown) {
    const input = parse(ProofSchema, raw);
    return this.update(context, (state, principal) => {
      ownerOnly(principal);
      const goal = findGoal(state, input.goalId, principal);
      currentTarget(state, goal);
      checkFence(goal, input);
      const at = this.now();
      if (goal.state !== 'HOLD' || input.blockerDigest !== goalDigest(goal.blocker))
        refuse('Proof does not attest the exact recorded HOLD unblocker');
      if (input.expiresAt <= at || input.expiresAt > at + 3600_000) invalid('Proof expiry must be within one hour');
      const proof = {
        id: randomUUID(),
        owner: principal.owner,
        goalId: goal.id,
        generation: goal.generation,
        sessionId: goal.sessionId,
        sessionGeneration: goal.sessionGeneration,
        holdSequence: goal.transitionSequence,
        blockerDigest: input.blockerDigest,
        evidenceRef: input.evidenceRef,
        issuedAt: at,
        expiresAt: input.expiresAt,
      };
      state.goalUnblockProofs.push(proof);
      return proof;
    });
  }
  async adopt(raw: unknown, context?: unknown) {
    const input = parse(AdoptSchema, raw);
    return this.update(context, (state, principal) => {
      ownerOnly(principal);
      const goal = findGoal(state, input.goalId, principal);
      checkFence(goal, input);
      const employee = employeeOf(state, goal.employeeId, principal.owner);
      active(employee);
      if (employee.sessionId === goal.sessionId && employee.sessionGeneration === goal.sessionGeneration)
        invalid('Goal already has the current binding');
      if (goal.transitions.some((r) => r.transitionId === input.transitionId))
        conflict('Adoption transition ID already exists');
      if (goal.transitions.length >= 256) invalid('Goal receipt budget exhausted');
      const from = goal.state;
      goal.generation++;
      goal.transitionSequence++;
      goal.sessionId = employee.sessionId;
      goal.sessionGeneration = employee.sessionGeneration;
      goal.nextAction = input.nextAction;
      goal.updatedAt = this.now();
      const result = receipt(
        goal,
        input.transitionId,
        goalDigest({ input, principal }),
        from,
        principal,
        goal.updatedAt,
        'ADOPT'
      );
      return atReceipt(goal, result, principal);
    });
  }
  async revokeUnblockProof(proofId: string, context?: unknown): Promise<void> {
    parse(id, proofId);
    await this.update(context, (state, principal) => {
      ownerOnly(principal);
      if (!state.goalUnblockProofs.some((p) => p.id === proofId && p.owner === principal.owner))
        refuse('Unknown owned proof');
      if (!state.goalProofRevocations.some((p) => p.proofId === proofId))
        state.goalProofRevocations.push({ proofId, owner: principal.owner, at: this.now() });
    });
  }
  async transition(raw: unknown, context?: unknown) {
    const input = parse(TransitionSchema, raw);
    return this.update(context, (state, principal, retain) => {
      const goal = findGoal(state, input.goalId, principal);
      currentTarget(state, goal);
      checkFence(goal, input, false);
      const verifier =
        principal.kind === 'employee' && input.verifierGrantId !== undefined
          ? this.grant(state, principal, input.verifierGrantId, 'VERIFY', goal.employeeId, goal, input.expectedSequence)
          : undefined;
      if (verifier)
        retain(() => {
          this.grant(state, principal, verifier.id, 'VERIFY', goal.employeeId, goal, input.expectedSequence);
        });
      if (principal.kind !== 'owner' && !verifier && principal.employeeId !== goal.employeeId)
        refuse('A worker updates only its own Goal');
      const digest = goalDigest({ input, principal });
      const replay = goal.transitions.find((r) => r.transitionId === input.transitionId);
      if (replay) {
        if (replay.generation !== goal.generation) conflict('Receipt belongs to a superseded generation');
        if (replay.requestDigest !== digest)
          throw new GoalLifecycleError('Changed transitionId reuse', 'GOAL_IDEMPOTENCY_REUSE', 409);
        return atReceipt(goal, replay, principal);
      }
      checkFence(goal, input);
      if (principal.kind === 'employee' && !verifier && (goal.state === 'REVIEW' || terminal.has(goal.state)))
        refuse('Worker authority stops at REVIEW');
      if (principal.kind === 'employee' && !verifier && ['DONE', 'NO_GO', 'CANCELLED'].includes(input.to))
        refuse('Worker cannot close or cancel a Goal');
      if (verifier && (goal.state !== 'REVIEW' || !['ACTIVE', 'DONE', 'NO_GO'].includes(input.to)))
        refuse('Verifier authority is only the exact REVIEW decision');
      if (input.to === goal.state ? terminal.has(goal.state) : !edges[goal.state].includes(input.to))
        invalid('Illegal Goal state transition');
      if (terminal.has(goal.state)) ownerOnly(principal);
      if ((input.to === 'HOLD') !== !!input.blocker) invalid('Exactly HOLD requires a typed blocker');
      if (input.blocker && input.blocker.category !== input.blocker.unblocker.kind)
        invalid('Blocker category and typed unblocker disagree');
      if (goal.state === 'HOLD' && input.to === 'ACTIVE') {
        const proof = state.goalUnblockProofs.find((p) => p.id === input.unblockProofId && p.owner === principal.owner);
        if (
          !proof ||
          proof.goalId !== goal.id ||
          proof.generation !== goal.generation ||
          proof.sessionId !== goal.sessionId ||
          proof.sessionGeneration !== goal.sessionGeneration ||
          proof.holdSequence !== goal.transitionSequence ||
          proof.blockerDigest !== goalDigest(goal.blocker) ||
          proof.expiresAt <= this.now() ||
          state.goalProofRevocations.some((p) => p.proofId === proof.id)
        )
          refuse('Current owner-attested exact unblocker proof is required');
        retain(() => {
          if (proof.expiresAt <= this.now()) refuse('Unblocker proof expired before commit');
        });
      } else if (input.unblockProofId !== undefined) invalid('Unblocker proof is only for HOLD resume');
      if (goal.transitions.length >= 256 || goal.evidenceRefs.length + (input.evidenceRefs?.length ?? 0) > 200)
        invalid('Goal evidence/receipt budget exhausted');
      const at = this.now();
      const progressAt = input.semanticProgressAt ?? at;
      if (progressAt < goal.semanticProgressAt || progressAt > at)
        invalid('Semantic progress time must be monotonic and current');
      const from = goal.state;
      if (terminal.has(from)) goal.generation++;
      goal.state = input.to;
      goal.blocker = input.blocker;
      goal.nextAction = input.nextAction;
      if (input.deadlineAt !== undefined) goal.deadlineAt = input.deadlineAt;
      goal.semanticProgressAt = progressAt;
      goal.updatedAt = at;
      goal.transitionSequence++;
      goal.evidenceRefs.push(...(input.evidenceRefs ?? []));
      const result = receipt(
        goal,
        input.transitionId,
        digest,
        from,
        principal,
        at,
        'TRANSITION',
        verifier?.id,
        input.unblockProofId
      );
      return atReceipt(goal, result, principal);
    });
  }
}
