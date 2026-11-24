import {isMultiUserMode}from'./config/multiuser.js';
import { dockerProviderRuntimeRecipeDigest } from './docker-employee-source-correlation.js';
import { PlanMoveStore } from './plan-move-store.js';
/** Captured request authority for one protected boxed plan operation.
 * This brand is not a native observation or a paid-launch capability. */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CompanyService } from './company-service.js';
import {
  captureDockerWorkerPlanRequestContinuation,
  requireDockerWorkerPlanRequestContinuation,
  DockerWorkerRequestIdentity,
  dockerWorkerIdentityOf,
  dockerWorkerIdentityPresented,
} from './docker-worker-identity.js';
import { authenticatedPlanMover } from './web/plan-move-auth.js';
import { ownerFor } from './web/route-helpers.js';
import type { AuthPort } from './web/ports/auth-port.js';
import type { OwnerAuthService } from './owner-auth/service.js';
import { PlanMoveError, type PlanMoveInput, type PlanMoveRecord } from './plan-move.js';
import type { DockerPlanMoveJournalState } from './docker-plan-move-data.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const targetSchema = z
  .object({
    employeeId: identifier,
    sessionId: z.string().uuid(),
    sessionGeneration: z.number().int().positive().safe().optional(),
    choice: z.object({ moveId: identifier, toAccount: identifier, forceBusy: z.boolean(),
      returnToOffice: z.literal(true).optional() }).strict().optional(),
    purpose: z.enum(['choice', 'original']).default('choice'),
  })
  .strict();
export type DockerPlanMoveRequesterTarget = z.input<typeof targetSchema>;
export interface DockerPlanMoveRequesterScope {
  /** Correlation/audit DATA only; current permissions are checked independently. */
  readonly requester:
    | { readonly kind: 'owner' }
    /** The office supervisor continuing an original held move. Never a new choice. */
    | { readonly kind: 'supervisor' }
    | {
        readonly kind: 'agent';
        readonly employeeId: string;
        readonly sessionId: string;
        readonly sessionGeneration: number;
        readonly containerId: string;
      };
  readonly employeeId: string;
  readonly owner: string | undefined;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly containerId: string;
  readonly purpose: 'choice' | 'original';
  readonly choice?: NonNullable<DockerPlanMoveRequesterTarget['choice']>;
}
const origin = Symbol('actual Docker plan requester');
export class DockerPlanMoveRequester {
  readonly #scope: DockerPlanMoveRequesterScope;
  readonly #source: () => void;
  readonly #current: (record: Readonly<PlanMoveRecord>, state: Readonly<DockerPlanMoveJournalState>) => void;
  constructor(
    token: symbol,
    scope: DockerPlanMoveRequesterScope,
    source: () => void,
    current: (record: Readonly<PlanMoveRecord>, state: Readonly<DockerPlanMoveJournalState>) => void
  ) {
    if (token !== origin) throw new PlanMoveError('Genuine Docker plan requester required', 403);
    this.#scope = Object.freeze({
      ...scope,
      requester: Object.freeze({ ...scope.requester }),
      ...(scope.choice ? { choice: Object.freeze({ ...scope.choice }) } : {}),
    });
    this.#source = source;
    this.#current = current;
    Object.freeze(this);
  }
  source(employeeId: string, owner: string | undefined): DockerPlanMoveRequesterScope {
    this.#source();
    if (employeeId !== this.#scope.employeeId || owner !== this.#scope.owner)
      throw new PlanMoveError('Docker plan requester target changed', 403);
    return structuredClone(this.#scope);
  }
  reservation(input: Readonly<PlanMoveInput>, owner: string | undefined): DockerPlanMoveRequesterScope {
    const scope = this.source(input.employeeId, owner),
      choice = scope.choice;
    if (
      scope.purpose !== 'choice' ||
      !choice ||
      choice.moveId !== input.id ||
      choice.toAccount !== input.toAccount ||
      choice.forceBusy !== input.forceBusy ||
      choice.returnToOffice !== input.returnToOffice ||
      input.sessionId !== scope.sessionId
    )
      throw new PlanMoveError('A new Docker plan choice requires its exact request', 403);
    return scope;
  }
  current(record: Readonly<PlanMoveRecord>, state: Readonly<DockerPlanMoveJournalState>): void {
    this.#current(record, state);
  }
}
Object.freeze(DockerPlanMoveRequester.prototype);
function genuine(proof: unknown): DockerPlanMoveRequester {
  if (!(proof instanceof DockerPlanMoveRequester))
    throw new PlanMoveError('Genuine Docker plan requester required', 403);
  return proof;
}
export function requireDockerPlanMoveRequesterSource(
  proof: unknown,
  employeeId: string,
  owner: string | undefined
): DockerPlanMoveRequesterScope {
  return DockerPlanMoveRequester.prototype.source.call(genuine(proof), employeeId, owner);
}
export function requireDockerPlanMoveRequesterReservation(
  proof: unknown,
  input: Readonly<PlanMoveInput>,
  owner: string | undefined
): DockerPlanMoveRequesterScope {
  return DockerPlanMoveRequester.prototype.reservation.call(genuine(proof), input, owner);
}
export function requireDockerPlanMoveRequesterCurrent(
  proof: unknown,
  record: Readonly<PlanMoveRecord>,
  state: Readonly<DockerPlanMoveJournalState>
): void {
  DockerPlanMoveRequester.prototype.current.call(genuine(proof), record, state);
}
function captureRequester(
  request: FastifyRequest | undefined,
  input: DockerPlanMoveRequesterTarget,
  company: CompanyService,
  auth: Pick<AuthPort, 'authSessions'>,
  ownerAuth: Pick<OwnerAuthService, 'session'> | undefined,
  runtimeCurrent: () => void,
  original?: Readonly<PlanMoveRecord>,
  /** In place of a request: the office supervisor, for the original of a held move only. */
  supervisor?: { readonly owner: string | undefined; current(): boolean }
): DockerPlanMoveRequester {
  if (!(company instanceof CompanyService)) throw new PlanMoveError('Actual company plan authority required', 403);
  const target = targetSchema.parse(input),
    identity = request ? dockerWorkerIdentityOf(request) : undefined,
    owner = request ? ownerFor(request) : supervisor?.owner;
  if (!request && (!supervisor || !original || target.purpose !== 'original' || isMultiUserMode()))
    throw new PlanMoveError('The office supervisor may only continue the original of a held move', 403);
  if (
    request &&
    dockerWorkerIdentityPresented(request) &&
    (!identity || request.headers['x-reverie-parent-session'] !== identity.sessionId)
  )
    throw new PlanMoveError('Current boxed plan identity required', 403);
  // Global subscription accounts have no per-member ownership model. Preserve
  // the existing agentPlanRequestExecution refusal, including presented hints.
  if(request&&isMultiUserMode()&&(identity||dockerWorkerIdentityPresented(request)||request.headers['x-reverie-parent-session']!==undefined))throw new PlanMoveError('Agent plan moves require supported account ownership',403);
  const issuer = identity ? captureDockerWorkerPlanRequestContinuation(identity) : undefined;
  const employees = () => company.registeredEmployees();
  const find = (id: string) => {
    const rows = employees().filter((e) => e.id === id);
    return rows.length === 1 ? rows[0] : undefined;
  };
  const employee = find(target.employeeId),
    caller = identity && find(identity.employeeId);
  if (
    !employee ||
    employee.owner !== owner ||
    !employee.dockerBinding ||
    (!original &&
      (employee.sessionId !== target.sessionId ||
        (target.sessionGeneration !== undefined && target.sessionGeneration !== employee.sessionGeneration))) ||
    (original && (original.owner !== owner || original.employeeId !== employee.id || !original.dockerReplacement))
  )
    throw new PlanMoveError('Exact current Docker plan target required', 403);
  if (
    employee.dockerBinding.sessionId !== employee.sessionId ||
    employee.dockerBinding.sessionGeneration !== employee.sessionGeneration ||
    (identity &&
      (!caller ||
        caller.owner !== identity.owner ||
        caller.sessionId !== identity.sessionId ||
        caller.sessionGeneration !== identity.sessionGeneration ||
        caller.dockerBinding?.containerId !== identity.containerId))
  )
    throw new PlanMoveError('Coherent current Docker plan binding required', 403);
  const sourceBinding = structuredClone(original?.dockerReplacement?.seed.source.binding ?? employee.dockerBinding),
    sourceRecipe = dockerProviderRuntimeRecipeDigest(employee.runtimeRecipe);
  const sourceKey = JSON.stringify([sourceBinding.sessionId, sourceBinding.sessionGeneration, sourceBinding]);
  const callerKey = caller && JSON.stringify([caller.sessionId, caller.sessionGeneration, caller.dockerBinding]);
  const scope: DockerPlanMoveRequesterScope = {
    requester: identity
      ? {
          kind: 'agent',
          employeeId: identity.employeeId,
          sessionId: identity.sessionId,
          sessionGeneration: identity.sessionGeneration,
          containerId: identity.containerId,
        }
      : request
        ? { kind: 'owner' }
        : { kind: 'supervisor' },
    employeeId: employee.id,
    owner,
    sessionId: sourceBinding.sessionId,
    sessionGeneration: sourceBinding.sessionGeneration,
    containerId: sourceBinding.containerId,
    purpose: target.purpose,
    ...(target.choice ? { choice: target.choice } : {}),
  };
  const started = performance.now();
  let revoked = false;
  const refuse = (): never => {
    revoked = true;
    throw new PlanMoveError('The Docker plan requester or permission changed', 403);
  };
  const common = (state?: Readonly<DockerPlanMoveJournalState>) => {
    if (revoked) return refuse();
    try {
      runtimeCurrent();
      const age = performance.now() - started;
      if (!Number.isFinite(age) || age < 0 || age > 30 * 60_000) return refuse();
      const current = find(employee.id);
      if (!current || current.owner !== owner || current.bindingMigration) return refuse();
      const source =
        JSON.stringify([current.sessionId, current.sessionGeneration, current.dockerBinding]) === sourceKey &&
        dockerProviderRuntimeRecipeDigest(current.runtimeRecipe) === sourceRecipe;
      const planned =
        !!state?.paidDispatch &&
        !!state.companyPublication &&
        current.sessionId === state.seed.target.sessionId &&
        current.sessionGeneration === state.seed.target.sessionGeneration &&
        current.dockerBinding?.sessionId === state.seed.target.sessionId &&
        current.dockerBinding.sessionGeneration === state.seed.target.sessionGeneration &&
        current.dockerBinding.operationId === state.seed.target.operationId &&
        current.dockerBinding.credentialId === state.seed.target.credentialId &&
        current.dockerBinding.containerId === state.work?.destination?.containerId &&
        current.dockerBinding.imageId === state.work.destination.imageId &&
        current.dockerBinding.originalDigest === dockerContinuationDigest(state.work.destination) &&
        current.dockerBinding.policyDigest === dockerContinuationDigest(state.work.policy) &&
        dockerProviderRuntimeRecipeDigest(current.runtimeRecipe) === state.seed.target.templateDigest;
      if (!source && !planned) return refuse();
      if (target.choice?.returnToOffice && identity) return refuse();
      if (target.purpose === 'choice') {
        const off = current.onVacation === true && current.desiredRunning === false;
        const inOffice = !current.onVacation && current.desiredRunning === true;
        if (target.choice?.returnToOffice) {
          if (identity || !target.choice.forceBusy || (planned ? !inOffice : !off)) return refuse();
        } else if (!inOffice && (identity || target.choice || !off)) return refuse();
      }
      if (!identity) {
        // No request: the supervisor's own switch and target stand where the owner's sign-in stands, and the
        // employee must still be meant to be running in the office.
        if (
          request
            ? !authenticatedPlanMover(request, auth.authSessions, ownerAuth)
            : !supervisor!.current() || current.onVacation || current.desiredRunning !== true
        )
          return refuse();
        return;
      }
      const delegate = find(identity.employeeId),
        self = identity.employeeId === employee.id;
      if (
        !delegate ||
        delegate.owner !== owner ||
        delegate.onVacation ||
        delegate.desiredRunning !== true ||
        delegate.bindingMigration ||
        !(
          delegate.permissions.managePlans ||
          (self && delegate.permissions.moveOwnPlan) ||
          (target.purpose === 'original' && delegate.permissions.recoverEmployees)
        )
      )
        return refuse();
      requireDockerWorkerPlanRequestContinuation(issuer);
      if (self) {
        // A durable source STOP intent allows only this captured self transition.
        // Native currentness still proves its actual CID closure before any delivery.
        if (!state?.sourceStop) DockerWorkerRequestIdentity.prototype.require.call(identity);
      } else {
        DockerWorkerRequestIdentity.prototype.require.call(identity);
        if (JSON.stringify([delegate.sessionId, delegate.sessionGeneration, delegate.dockerBinding]) !== callerKey)
          return refuse();
      }
    } catch {
      refuse();
    }
  };
  const source = () => common(original?.dockerReplacement);
  const current = (record: Readonly<PlanMoveRecord>, state: Readonly<DockerPlanMoveJournalState>) => {
    if (
      record.id !== state.seed.moveId ||
      record.owner !== owner ||
      record.employeeId !== employee.id ||
      record.oldSession !== scope.sessionId ||
      state.seed.source.binding.sessionId !== scope.sessionId ||
      state.seed.source.binding.sessionGeneration !== scope.sessionGeneration ||
      state.seed.source.binding.containerId !== scope.containerId ||
      dockerContinuationDigest(state.seed.source.binding) !== dockerContinuationDigest(sourceBinding) ||
      state.seed.source.record.owner !== owner ||
      record.newSession !== state.seed.target.sessionId ||
      record.toAccount !== state.seed.target.accountId ||
      (target.choice &&
        (record.id !== target.choice.moveId ||
          record.toAccount !== target.choice.toAccount ||
          state.seed.forceBusy !== target.choice.forceBusy ||
          state.seed.returnToOffice !== target.choice.returnToOffice))
    )
      return refuse();
    common(state);
  };
  source();
  return new DockerPlanMoveRequester(origin, scope, source, current);
}

/** New-choice/preview admission only; callers cannot pass historical row DATA. */
export function captureDockerPlanMoveRequester(
  request: FastifyRequest,
  input: DockerPlanMoveRequesterTarget,
  company: CompanyService,
  auth: Pick<AuthPort, 'authSessions'>,
  ownerAuth: Pick<OwnerAuthService, 'session'> | undefined,
  runtimeCurrent: () => void
): DockerPlanMoveRequester {
  if (input.purpose === 'original')
    throw new PlanMoveError('Original recovery requires the actual retained journal', 403);
  return captureRequester(request, input, company, auth, ownerAuth, runtimeCurrent);
}
/** Frozen original recovery: actual private store lookup, never HTTP row/proof DATA.
 * A new target choice remains unavailable under recoverEmployees. */
export async function captureDockerPlanMoveOriginalRequester(
  request: FastifyRequest,
  id: string,
  store: PlanMoveStore,
  company: CompanyService,
  auth: Pick<AuthPort, 'authSessions'>,
  ownerAuth: Pick<OwnerAuthService, 'session'> | undefined,
  runtimeCurrent: () => void
): Promise<DockerPlanMoveRequester> {
  if (!(store instanceof PlanMoveStore)) throw new PlanMoveError('Actual retained plan journal required', 403);
  identifier.parse(id);
  runtimeCurrent();
  const record = await PlanMoveStore.prototype.dockerRecord.call(store, id),
    state = record.dockerReplacement!;
  runtimeCurrent();
  return captureRequester(
    request,
    {
      employeeId: record.employeeId,
      sessionId: record.oldSession,
      sessionGeneration: state.seed.source.binding.sessionGeneration,
      purpose: 'original',
      choice: {
        moveId: record.id,
        toAccount: record.toAccount,
        forceBusy: state.seed.forceBusy,
        ...(state.seed.returnToOffice ? { returnToOffice: true } : {}),
      },
    },
    company,
    auth,
    ownerAuth,
    runtimeCurrent,
    record
  );
}
/** The office supervisor continuing the ORIGINAL of a held move: the same frozen
 * journal lookup as an owner's recovery, with the supervisor's own switch where
 * the owner's sign-in stands. It carries no request, so it can never reserve,
 * preview or choose a target, and it never settles a restored source: that
 * check asks for the signed-in owner by kind. */
export async function captureDockerPlanMoveSupervisorRequester(
  id: string,
  store: PlanMoveStore,
  company: CompanyService,
  runtimeCurrent: () => void,
  supervisor: { current(): boolean }
): Promise<DockerPlanMoveRequester> {
  if (!(store instanceof PlanMoveStore)) throw new PlanMoveError('Actual retained plan journal required', 403);
  identifier.parse(id);
  runtimeCurrent();
  const record = await PlanMoveStore.prototype.dockerRecord.call(store, id),
    state = record.dockerReplacement!;
  runtimeCurrent();
  if (!supervisor.current()) throw new PlanMoveError('The office supervisor may not continue this move', 403);
  return captureRequester(
    undefined,
    {
      employeeId: record.employeeId,
      sessionId: record.oldSession,
      sessionGeneration: state.seed.source.binding.sessionGeneration,
      purpose: 'original',
      choice: {
        moveId: record.id,
        toAccount: record.toAccount,
        forceBusy: state.seed.forceBusy,
        ...(state.seed.returnToOffice ? { returnToOffice: true } : {}),
      },
    },
    company,
    { authSessions: null },
    undefined,
    runtimeCurrent,
    record,
    { owner: record.owner, current: () => supervisor.current() }
  );
}
