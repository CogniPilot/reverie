/** Shared human/Office application recovery owner. Loaded rows are denials;
 * only retained branded attempts join actual auth, writer and native transport.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { lstat } from 'node:fs/promises';
import { CompanyStore } from './company-store.js';
import { CompanyService, CompanyError } from './company-service.js';
import { PlanMoves } from './plan-move.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { RECOVERY_HEADER, WorkerRecoveryAuthentication } from './worker-recovery-auth.js';
import {
  ResourceOwnerAuthority,
  ResourceOwnerAuthorizationError,
  type RamEmployeeRecoveryContext,
} from './resource-owner-authority.js';
import { ResourceNativeClient } from './resource-native-client.js';
import type { ServiceAuthorization } from './service-authorization.js';
import { NativeOwnerId } from './native-owner-data.js';
import {
  EmployeeRecoveryApproval,
  EmployeeRecoveryRequest,
  EmployeeRecoverySelection,
  EmployeeRecoverySelectionRequest,
  recoveryDataDigest,
  type EmployeeRecoveryResult,
  completedStoppedRecovery,
} from './employee-recovery-operation.js';
import { EmployeeRecoveryAttempt, EmployeeRecoveryPreflightError } from './employee-recovery-attempt.js';
import { Session } from './session.js';

const recoveryTransportProofs = new WeakSet<object>();
declare module 'fastify' {
  interface FastifyContextConfig {
    employeeRecoveryTransport?: unknown;
  }
}
/** Transport to the fixed owning handler, never authentication or action
 * authority. Only registration below supplies the opaque route proof. */
export function isEmployeeRecoveryTransport(request: FastifyRequest, _basePath = ''): boolean {
  // WebServer strips its mount prefix in rewriteUrl before route/auth hooks.
  // Match only the registered canonical route and exact post-rewrite target.
  const proof = request.routeOptions.config.employeeRecoveryTransport;
  const route = request.routeOptions.url;
  const path = request.url;
  return (
    typeof proof === 'object' &&
    proof !== null &&
    recoveryTransportProofs.has(proof) &&
    request.method === 'POST' &&
    typeof request.headers[RECOVERY_HEADER] === 'string' &&
    (route === '/api/company/employees/:employeeId/recovery' ||
      route === '/api/company/employees/:employeeId/recovery/observe' ||
      route === '/api/company/employees/:employeeId/recovery-selection') &&
    /^\/api\/company\/employees\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/recovery(?:\/observe|-selection)?$/.test(
      path
    )
  );
}

export class EmployeeRecoveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
function held(): never {
  throw new EmployeeRecoveryError(
    409,
    'EMPLOYEE_RECOVERY_HELD',
    'The original recovery operation requires inspection. Do not submit another operation.'
  );
}
interface OriginalRecovery {
  readonly attempt: EmployeeRecoveryAttempt;
  readonly context: RamEmployeeRecoveryContext;
  flight?: Promise<EmployeeRecoveryResponse>;
  response?: EmployeeRecoveryResult;
  flightState: 'staged' | 'in-flight' | 'terminal';
  intentRetirement: 'not-applicable' | 'known-unused-retired' | 'issued-native-retired' | 'unconfirmed';
  intentRetirementCause?: unknown;
  component?: OriginalRecovery;
  settlement?: Promise<void>;
  application?: 'completed-stopped';
}
interface CapturingRecovery {
  readonly kind: 'capturing';
}
type RecoverySlot = OriginalRecovery | CapturingRecovery;
interface EmployeeRecoveryResponse {
  readonly native: EmployeeRecoveryResult;
  readonly application: Readonly<{
    state: 'recovery-required' | 'completed-stopped';
    intentRetirement: OriginalRecovery['intentRetirement'];
  }>;
}
function response(native: EmployeeRecoveryResult, original: OriginalRecovery): EmployeeRecoveryResponse {
  return Object.freeze({
    native,
    application: Object.freeze({
      state: original.application ?? 'recovery-required',
      intentRetirement: original.intentRetirement,
    }),
  });
}
export class EmployeeRecoveryService {
  readonly #authority: ResourceOwnerAuthority;
  readonly #operations = new Map<string, RecoverySlot>();
  readonly #socket: string | undefined;
  #closed = false;
  constructor(
    private readonly company: CompanyService,
    auth: OwnerAuthService,
    socket: string | undefined,
    private readonly plans: PlanMoves,
    services?: ServiceAuthorization,
    recovery?: WorkerRecoveryAuthentication
  ) {
    if (!(company instanceof CompanyService) || !(auth instanceof OwnerAuthService) || !(plans instanceof PlanMoves))
      throw Error('Recovery requires the actual application owners');
    this.#authority = new ResourceOwnerAuthority(auth, services, recovery);
    this.#socket = socket;
  }
  close(): void {
    this.#closed = true;
    this.#authority.close();
    for (const op of this.#operations.values()) if ('attempt' in op) op.attempt.hold();
  }
  #retained(operationId: string): OriginalRecovery | undefined {
    const slot = this.#operations.get(operationId);
    return slot && 'attempt' in slot ? slot : undefined;
  }
  #publishOriginal(operationId: string, slot: CapturingRecovery, original: OriginalRecovery): void {
    if (this.#operations.get(operationId) !== slot) held();
    this.#operations.set(operationId, original);
  }
  #selectionRows(employeeId: string, owner: string | undefined, session?: Session, generation?: string) {
    const rows =
      this.company.store.snapshot().employeeRecoveryOperations?.filter((row) => row.employeeId === employeeId) ?? [];
    const active = rows.filter((row) => !completedStoppedRecovery(row));
    if (active.length > 1 || active.some((row) => row.owner !== owner)) held();
    if (active.length) return active;
    const intent = session ? Session.prototype.employeeRecoveryIntentSelector.call(session) : null;
    const history = rows.filter(
      (row) =>
        row.owner === owner &&
        !row.application?.supersededByIntent &&
        (!session ||
          (row.approval.sessionId === session.id &&
            row.approval.sessionGeneration === generation &&
            (intent === null || row.approval.originalAttemptId === intent)))
    );
    return history.slice(-1);
  }
  async selection(request: FastifyRequest, employeeId: string): Promise<EmployeeRecoverySelection> {
    NativeOwnerId.parse(employeeId);
    if (request.url !== `/api/company/employees/${employeeId}/recovery-selection`) held();
    const authority = await this.#authority.captureRecoverySelection(request, employeeId, this.company);
    authority.require();
    const retainedRows = this.company.store
      .snapshot()
      .employeeRecoveryOperations?.filter((row) => row.employeeId === employeeId);
    const retainedRow = retainedRows?.find((row) => !completedStoppedRecovery(row)) ?? retainedRows?.at(-1);
    const retainedRead = retainedRow ? this.#retained(retainedRow.approval.operationId) : undefined;
    const employee =
      this.company.store.publicationUnconfirmed && retainedRead
        ? await CompanyStore.prototype.employeeAfterRecoveryObservation.call(
            this.company.store,
            retainedRead.attempt,
            employeeId,
            authority.owner
          )
        : await CompanyStore.prototype.employeeAfterPublications.call(this.company.store, employeeId, authority.owner);
    authority.require();
    if (!employee) throw new CompanyError('Unknown employee recovery selection', 404);
    const subject = CompanyService.prototype.captureEmployeeRecoverySelection.call(
      this.company,
      employeeId,
      authority.owner,
      authority.callerSessionId
    );
    const current = () => {
      authority.require();
      subject.require();
      if (this.#closed) held();
    };
    current();
    let rows = this.#selectionRows(employeeId, authority.owner, subject.session, subject.sessionGeneration);
    if (rows.length > 1) held();
    let row = rows[0];
    let preparing = !row && !this.company.employeeRecoveryAvailable(employeeId, authority.owner);
    const lease = preparing
      ? undefined
      : await PlanMoves.prototype.viewerInspectionGuard.call(this.plans, employeeId, authority.owner);
    try {
      current();
      if (lease && !lease()) held();
      const selectors = subject.session
        ? Session.prototype.employeeRecoverySelectors.call(subject.session)
        : {
            provider: {
              source: 'unavailable' as const,
              originalAttemptId: null,
              providerExecution: 'unproved' as const,
            },
            unusedIntent: 'unconfirmed' as const,
            nativeTarget: false,
          };
      let channel = false;
      if (!preparing && this.#socket)
        try {
          const entry = await lstat(this.#socket, { bigint: true });
          channel = entry.isSocket() && entry.uid === BigInt(process.getuid!()) && (entry.mode & 0o077n) === 0n;
        } catch {
          /* Unavailable is diagnostic DATA, never proof about the provider. */
        }
      if (subject.session && !Session.prototype.employeeRecoveryEndpointCompatible.call(subject.session, this.#socket))
        channel = false;
      current();
      if (lease && !lease()) held();
      rows = this.#selectionRows(employeeId, authority.owner, subject.session, subject.sessionGeneration);
      if (rows.length > 1) held();
      row = rows[0];
      preparing = !row && !this.company.employeeRecoveryAvailable(employeeId, authority.owner);
      let original = row ? this.#retained(row.approval.operationId) : undefined;
      if (original)
        try {
          original.attempt.assertRetainedSelection(this.company, row!);
        } catch {
          original = undefined;
        }
      const recovery: EmployeeRecoverySelection['recovery'] = preparing
        ? { kind: 'preparing' }
        : !row
          ? { kind: 'none' }
          : {
              kind: original ? 'retained' : 'owner-unavailable',
              approval: row.approval,
              componentApproval: row.component?.approval ?? null,
              application: {
                state: original?.application ?? 'recovery-required',
                intentRetirement: original?.intentRetirement ?? 'unconfirmed',
              },
            };
      type Availability = EmployeeRecoverySelection['availability']['stopProvider'];
      const denied = (reason: NonNullable<Availability['reason']>): Availability => ({ state: 'unavailable', reason });
      const available: Availability = { state: 'available', reason: null };
      const base = preparing
        ? denied('recovery-preparing')
        : !subject.session
          ? denied('original-binding-unavailable')
          : !channel
            ? denied('no-native-channel')
            : !selectors.nativeTarget
              ? denied('unsupported-provider')
              : recovery.kind === 'owner-unavailable'
                ? denied('original-owner-unavailable')
                : undefined;
      const effectBase =
        base ??
        (this.company.store.publicationUnconfirmed || original?.attempt.stoppedInProgress()
          ? denied('existing-recovery')
          : undefined);
      const effect = (action: 'reconcile-owned' | 'stop-provider' | 'close-viewer'): Availability => {
        if (effectBase) return effectBase;
        if (authority.delegated && action !== 'reconcile-owned') return denied('action-approval-required');
        if (!row) return available;
        return original?.context.approval.action === action &&
          original.flightState === 'terminal' &&
          original.attempt.continuationAcknowledged()
          ? available
          : denied('existing-recovery');
      };
      const component = original?.component;
      const closeRetainedViewer =
        effectBase ??
        (authority.delegated
          ? denied('action-approval-required')
          : original?.context.approval.action === 'stop-provider' &&
              original.flightState === 'terminal' &&
              original.attempt.continuationAcknowledged() &&
              ((component?.flightState === 'terminal' && component.attempt.continuationAcknowledged()) ||
                (!component && original.response?.outcome === 'provider-stopped-viewer-pending'))
            ? available
            : denied('component-required'));
      const value = EmployeeRecoverySelection.parse({
        version: 1,
        purpose: 'employee-recovery-selection-v1',
        employeeId,
        sessionId: subject.sessionId,
        sessionGeneration: subject.sessionGeneration,
        provider: selectors.provider,
        unusedIntent: selectors.unusedIntent,
        recovery,
        availability: {
          reconcileOwned: effect('reconcile-owned'),
          stopProvider: effect('stop-provider'),
          closeViewer: effect('close-viewer'),
          observeOriginal: preparing
            ? denied('recovery-preparing')
            : original ||
                (row &&
                  row.owner === authority.owner &&
                  row.approval.sessionId === subject.sessionId &&
                  row.approval.sessionGeneration === subject.sessionGeneration &&
                  selectors.nativeTarget)
              ? channel
                ? available
                : denied('no-native-channel')
              : denied(recovery.kind === 'owner-unavailable' ? 'original-owner-unavailable' : 'no-original-operation'),
          closeRetainedViewer,
        },
        readOnly: true,
      });
      current();
      if (lease && !lease()) held();
      return value;
    } finally {
      lease?.close();
    }
  }
  async #select(
    request: FastifyRequest,
    employeeId: string,
    input: EmployeeRecoveryApproval,
    access: 'effect' | 'observe'
  ) {
    NativeOwnerId.parse(employeeId);
    const approval = EmployeeRecoveryApproval.parse(input);
    let context: RamEmployeeRecoveryContext;
    try {
      context =
        request.headers[RECOVERY_HEADER] === undefined
          ? this.#authority.captureEmployeeRecovery(request, employeeId, approval, access)
          : await this.#authority.authenticateEmployeeRecovery(request, employeeId, approval, access);
    } catch (cause) {
      throw new ResourceOwnerAuthorizationError('Current recovery authorization is unavailable', { cause });
    }
    this.#authority.assertRecoveryAuthentication(context);
    if (this.#closed) held();
    return { approval, context };
  }
  /** Effects always retain their original admission; a completed native stop is never replayed here. */
  async submit(
    request: FastifyRequest,
    employeeId: string,
    input: EmployeeRecoveryApproval
  ): Promise<EmployeeRecoveryResponse> {
    const { approval, context } = await this.#select(request, employeeId, input, 'effect');
    const previous = this.#operations.get(approval.operationId);
    if (previous && !('attempt' in previous)) held();
    if (previous) {
      if (previous.settlement || previous.attempt.stoppedInProgress()) held();
      const row = previous.attempt.row;
      if (
        !row ||
        row.employeeId !== employeeId ||
        row.owner !== context.owner ||
        recoveryDataDigest(previous.context.approval) !== recoveryDataDigest(approval)
      )
        held();
      if (previous.context.stage !== 'employee-recovery') held();
      this.#authority.assertRecoveryAuthentication(context);
      if (previous.flightState === 'in-flight') {
        const flight = previous.flight ?? held();
        const joining = await EmployeeRecoveryAttempt.capture(
          this.company,
          this.plans,
          this.#authority,
          context,
          previous.attempt
        );
        try {
          const response = await flight;
          joining.assertCurrent();
          return response;
        } finally {
          joining.closeContinuation();
        }
      }
      return this.#dispatch(previous, context, false);
    }
    if (
      this.company.store
        .snapshot()
        .employeeRecoveryOperations?.some((row) => row.approval.operationId === approval.operationId)
    )
      held();
    // Reserve this operation selector before any capture await. A slot is
    // private correlation, never authentication or dispatch authority.
    const slot: CapturingRecovery = Object.freeze({ kind: 'capturing' });
    this.#operations.set(approval.operationId, slot);
    try {
      if (approval.parentOperationId !== null) {
        const parent = this.#retained(approval.parentOperationId);
        if (
          !parent ||
          parent.settlement ||
          parent.attempt.stoppedInProgress() ||
          parent.context.stage !== 'employee-recovery' ||
          parent.component ||
          parent.flightState !== 'terminal' ||
          parent.context.employeeId !== employeeId ||
          parent.context.owner !== context.owner ||
          parent.context.approval.action !== 'stop-provider'
        )
          held();
        const attempt = await EmployeeRecoveryAttempt.capture(
          this.company,
          this.plans,
          this.#authority,
          context,
          parent.attempt
        );
        // Recheck after the original owning guard's await; a competing child must
        // not replace the first actual component, even before its publication.
        if (parent.component) held();
        const original: OriginalRecovery = {
          attempt,
          context,
          flightState: 'staged',
          intentRetirement: 'not-applicable',
        };
        parent.component = original;
        this.#publishOriginal(approval.operationId, slot, original);
        return this.#dispatch(original, context, true);
      }
      if (!this.#socket)
        throw new EmployeeRecoveryError(503, 'EMPLOYEE_RECOVERY_UNAVAILABLE', 'Native recovery is unavailable.');
      const attempt = await EmployeeRecoveryAttempt.capture(
        this.company,
        this.plans,
        this.#authority,
        context,
        undefined,
        this.#socket
      );
      const original: OriginalRecovery = {
        attempt,
        context,
        flightState: 'staged',
        intentRetirement: 'not-applicable',
      };
      this.#publishOriginal(approval.operationId, slot, original);
      return this.#dispatch(original, context, true);
    } catch (error) {
      // Only a capture that never published its actual original may refund
      // this exact slot. Issued/uncertain originals retain their own cleanup.
      if (this.#operations.get(approval.operationId) === slot) this.#operations.delete(approval.operationId);
      throw error;
    }
  }
  /** Re-enter only the retained operation, never reserve a new resource/op row.
   * The fresh EFFECT context cannot be substituted by a read/reconcile grant. */
  #dispatch(
    original: OriginalRecovery,
    context: RamEmployeeRecoveryContext,
    initial: boolean
  ): Promise<EmployeeRecoveryResponse> {
    if (original.flightState === 'in-flight' || context.stage !== 'employee-recovery' || !this.#socket) held();
    original.flightState = 'in-flight';
    const dispatch = async () => {
      let attempt: EmployeeRecoveryAttempt | undefined;
      try {
        attempt = initial
          ? original.attempt
          : await EmployeeRecoveryAttempt.capture(this.company, this.plans, this.#authority, context, original.attempt);
        if (initial) await attempt.reserve();
        this.#authority.bindEmployeeRecoveryAttempt(context, attempt);
        const client = await ResourceNativeClient.openRam(this.#socket!, this.#authority, context);
        try {
          const value = await client.employeeRecovery();
          await attempt.retainObservation(value);
          attempt.assertCurrent();
          original.response = value;
          return response(value, original);
        } finally {
          client.close();
        }
      } catch (error) {
        if (attempt) {
          let unused = false;
          if (initial)
            try {
              attempt.assertUnissuedRefusal();
              unused = true;
            } catch {
              /* Unknown never refunds the original. */
            }
          if (unused) {
            if (this.#operations.get(context.approval.operationId) === original)
              this.#operations.delete(context.approval.operationId);
            const parentId = context.approval.parentOperationId;
            const parent = parentId === null ? undefined : this.#retained(parentId);
            if (parent?.component === original) parent.component = undefined;
          } else {
            attempt.hold();
            original.attempt.hold();
          }
        }
        throw error;
      } finally {
        original.flightState = 'terminal';
        if (attempt && attempt !== original.attempt) attempt.closeContinuation();
      }
    };
    original.flight = dispatch();
    return original.flight;
  }
  async #loadOriginalObservation(context: RamEmployeeRecoveryContext): Promise<OriginalRecovery> {
    const id = context.approval.operationId;
    if (context.stage !== 'employee-recovery-observe' || this.#operations.has(id)) held();
    const slot: CapturingRecovery = Object.freeze({ kind: 'capturing' });
    this.#operations.set(id, slot);
    try {
      await CompanyStore.prototype.employeeAfterPublications.call(
        this.company.store,
        context.employeeId,
        context.owner
      );
      this.#authority.assertRecoveryAuthentication(context);
      const rows = this.company.store
        .snapshot()
        .employeeRecoveryOperations?.filter(
          (row) => row.employeeId === context.employeeId && row.approval.operationId === context.approval.operationId
        );
      const row = rows?.[0];
      if (
        rows?.length !== 1 ||
        !row ||
        row.owner !== context.owner ||
        recoveryDataDigest(row.approval) !== recoveryDataDigest(context.approval)
      )
        held();
      const attempt = await EmployeeRecoveryAttempt.captureRetainedObservation(
        this.company,
        this.plans,
        this.#authority,
        context,
        row,
        this.#socket
      );
      const original: OriginalRecovery = {
        attempt,
        context,
        flightState: 'terminal',
        intentRetirement: 'unconfirmed',
      };
      this.#publishOriginal(id, slot, original);
      return original;
    } catch (error) {
      if (this.#operations.get(id) === slot) this.#operations.delete(id);
      throw error;
    }
  }
  /** Fresh read authority selects only the retained original Attempt. It does
   * not reauthorize/replay stop or require the old actor's expired assertion. */
  async inspect(
    request: FastifyRequest,
    employeeId: string,
    input: EmployeeRecoveryApproval
  ): Promise<EmployeeRecoveryResponse> {
    const { approval, context } = await this.#select(request, employeeId, input, 'observe');
    const retained = this.#retained(approval.operationId);
    const original = retained ?? (await this.#loadOriginalObservation(context));
    const observer = retained
      ? await EmployeeRecoveryAttempt.capture(this.company, this.plans, this.#authority, context, original.attempt)
      : original.attempt;
    try {
      this.#authority.bindEmployeeRecoveryAttempt(context, observer);
      try {
        if (await Session.prototype.retireUnusedEmployeeLaunch.call(observer.session, observer))
          original.intentRetirement = 'known-unused-retired';
      } catch (cause) {
        original.intentRetirement = 'unconfirmed';
        original.intentRetirementCause ??= cause;
        // A failed metadata completion is not a native read prohibition. The
        // SAME fresh authorization/identity still has to pass before any Q.
        this.#authority.assertRecoveryAuthentication(context);
        observer.assertCurrent();
      }
      if (!this.#socket)
        throw new EmployeeRecoveryError(503, 'EMPLOYEE_RECOVERY_UNAVAILABLE', 'Native recovery is unavailable.');
      const client = await ResourceNativeClient.openRam(this.#socket, this.#authority, context);
      try {
        const observed = await client.observeEmployeeRecoveryOriginal(observer);
        const value = observed.native;
        // The authentic stop receipt's one-use claim performs the fresh join
        // before settlement. Plain observations still require that join here.
        if (observed.stopped && original.application !== 'completed-stopped') {
          if (original.settlement) {
            await original.settlement;
          } else {
            const settling = observer.settleStopped(observed.stopped);
            original.settlement = settling;
            try {
              await settling;
              original.intentRetirement =
                context.approval.originalAttemptId !== null
                  ? 'issued-native-retired'
                  : original.intentRetirement === 'known-unused-retired'
                    ? 'known-unused-retired'
                    : 'not-applicable';
              original.application = 'completed-stopped';
            } finally {
              if (original.settlement === settling) original.settlement = undefined;
            }
          }
          observer.assertCurrent();
        } else observer.assertCurrent();
        original.response = value;
        return response(value, original);
      } finally {
        client.close();
      }
    } finally {
      if (observer === original.attempt) observer.hold();
      else observer.closeContinuation();
    }
  }
}

function recoveryFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof EmployeeRecoveryPreflightError)
    return reply.code(error.reason === 'unsupported-provider' ? 409 : 503).send({
      success: false,
      errorCode:
        error.reason === 'unsupported-provider' ? 'EMPLOYEE_RECOVERY_UNSUPPORTED' : 'EMPLOYEE_RECOVERY_UNAVAILABLE',
      reason: error.reason,
      error: error.message,
    });
  if (error instanceof ResourceOwnerAuthorizationError || (error instanceof CompanyError && error.status === 403))
    return reply.code(403).send({
      success: false,
      errorCode: 'EMPLOYEE_RECOVERY_UNAUTHORIZED',
      error: 'Current recovery authorization is required.',
    });
  if ((error instanceof EmployeeRecoveryError || error instanceof CompanyError) && error.status === 409)
    return reply.code(409).send({
      success: false,
      errorCode: 'EMPLOYEE_RECOVERY_HELD',
      error: 'Inspect the original recovery operation before requesting another action.',
    });
  return reply.code(503).send({
    success: false,
    errorCode: 'EMPLOYEE_RECOVERY_UNCONFIRMED',
    error: 'Recovery was not confirmed. Inspect the original operation; do not repeat the action.',
  });
}

/** Human API and the fixed native Office forwarder share the same real service.
 * SOURCE headers select its actual verifier, never an owner identity. */
export function registerEmployeeRecoveryRoutes(app: FastifyInstance, service: EmployeeRecoveryService): void {
  for (const method of ['GET', 'POST'] as const) {
    const proof = Object.freeze({});
    recoveryTransportProofs.add(proof);
    app.route<{ Params: { employeeId: string } }>({
      method,
      url: '/api/company/employees/:employeeId/recovery-selection',
      bodyLimit: 64 * 1024,
      config: { employeeRecoveryTransport: proof },
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (
          !NativeOwnerId.safeParse(request.params.employeeId).success ||
          (method === 'POST' && !EmployeeRecoverySelectionRequest.safeParse(request.body).success)
        )
          return reply.code(400).send({
            success: false,
            errorCode: 'EMPLOYEE_RECOVERY_INVALID',
            error: 'Invalid recovery selection request.',
          });
        try {
          return { success: true, data: await service.selection(request, request.params.employeeId) };
        } catch (error) {
          return recoveryFailure(reply, error);
        }
      },
    });
  }
  for (const observe of [false, true]) {
    const proof = Object.freeze({});
    recoveryTransportProofs.add(proof);
    app.post<{ Params: { employeeId: string } }>(
      '/api/company/employees/:employeeId/recovery' + (observe ? '/observe' : ''),
      { bodyLimit: 64 * 1024, config: { employeeRecoveryTransport: proof } },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const parsed = EmployeeRecoveryRequest.safeParse(request.body);
        if (!NativeOwnerId.safeParse(request.params.employeeId).success || !parsed.success)
          return reply
            .code(400)
            .send({ success: false, errorCode: 'EMPLOYEE_RECOVERY_INVALID', error: 'Invalid recovery request.' });
        try {
          const data = await (observe
            ? service.inspect(request, request.params.employeeId, parsed.data.approval)
            : service.submit(request, request.params.employeeId, parsed.data.approval));
          return { success: true, data };
        } catch (error) {
          return recoveryFailure(reply, error);
        }
      }
    );
  }
}
