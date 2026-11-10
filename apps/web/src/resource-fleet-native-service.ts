/** Thin HTTP custody for the original native Q; no native rollout decisions. */
import type { FastifyRequest } from 'fastify';
import { isDeepStrictEqual } from 'node:util';
import {
  FleetRecoveryHistory,
  FleetRecoveryRequest,
  PoolAbsenceData,
  requireFreshPoolAbsence,
} from './resource-fleet-recovery.js';
import type { CompanyService } from './company-service.js';
import type { CompanyWakeReport } from './company-wake.js';
import { FleetOperationStore } from './resource-fleet-operation-store.js';
import {
  FleetOperationData,
  advanceFleetOperation,
  fleetOperationBlocks,
  fleetOperationFailure,
  type FleetOperation,
  type FleetOperationFailureCode,
  type FleetRestoreOutcome,
} from './resource-fleet-operation.js';
import type { CompanyEmployee } from './company-types.js';
import type { ProviderHealth } from './types/provider-health.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { ownerFor } from './web/route-helpers.js';
import { ResourceOwnerAuthority, ResourceOwnerAuthorizationError } from './resource-owner-authority.js';
import { FleetNativeClient, NativeFleetMigrationFailureError } from './resource-fleet-native-client.js';
import {
  NativeFleetPreviewRequest,
  NativeFleetApplyRequest,
  NativeFleetResultRequest,
  type NativeFleetPreview,
} from './resource-fleet-native-data.js';

export type FleetWakeEmployee = (
  id: string,
  options: { explicitStart: true; stillCurrent: () => boolean }
) => Promise<CompanyWakeReport>;
export interface FleetEmployeeRecovery {
  wakeEmployee: FleetWakeEmployee;
  refreshHealth(): Promise<void>;
  providerHealth(employee: CompanyEmployee): ProviderHealth | undefined;
  observeUninstalledPool?(): Promise<unknown>;
}
type Entry = {
  client: FleetNativeClient;
  operation: FleetOperation;
  failure?: unknown;
};
export class FleetNativeService {
  readonly #authority: ResourceOwnerAuthority;
  readonly #entries = new Map<string, Entry>();
  readonly #records = new Map<string, FleetOperation>();
  #loading?: Promise<void>;
  #loadFailure?: unknown;
  #opening = false;
  #reconciling = false;
  #closed = false;
  constructor(
    private readonly company: CompanyService,
    auth: OwnerAuthService,
    private readonly socket: string | undefined,
    private readonly recovery?: FleetEmployeeRecovery,
    private readonly history?: FleetRecoveryHistory,
    private readonly operations?: FleetOperationStore
  ) {
    this.#authority = new ResourceOwnerAuthority(auth);
  }
  async #load(): Promise<void> {
    if (!this.operations) throw new Error('Durable native fleet operation storage is unavailable');
    this.#loading ??= (async () => {
      const rows = await this.operations!.list();
      for (const row of rows) this.#records.set(row.operationId, row);
      for (const row of rows) {
        if (
          row.phase === 'completed' ||
          (row.phase === 'unknown' && !row.restore.some((item) => item.state === 'pending'))
        )
          continue;
        const next = advanceFleetOperation(row, 'unknown', {
          failure: row.failure ?? fleetOperationFailure('WEB_PROCESS_RESTARTED'),
          restore: row.restore.map((item) =>
            item.state === 'pending' ? { ...item, state: 'unknown' as const } : item
          ),
        });
        // This records loss of the original process, not renewed consent or a
        // launch permission. No stored data is ever used to reopen native Q.
        this.#records.set(row.operationId, next);
        await this.operations!.advance(row, next, () => {});
      }
    })().catch((error) => {
      this.#loadFailure = error;
      throw error;
    });
    return this.#loading;
  }
  #assertRecord(request: FastifyRequest, operation: FleetOperation): void {
    const viewer = this.#authority.captureFleetViewer(request);
    if (
      viewer.owner !== (operation.owner ?? undefined) ||
      viewer.principal.accountId !== operation.principal.accountId ||
      viewer.principal.personId !== operation.principal.personId
    )
      throw new ResourceOwnerAuthorizationError('Original fleet operation belongs to another owner scope');
    this.#authority.assertContext(viewer);
  }
  #assertEffectsAvailable(): void {
    if (this.#closed || this.#loadFailure !== undefined || this.operations?.failed())
      throw new Error('Original fleet operation custody is unavailable; no effect was dispatched');
  }
  async preview(request: FastifyRequest): Promise<NativeFleetPreview> {
    this.#authority.captureFleetViewer(request);
    NativeFleetPreviewRequest.parse(request.body);
    await this.#load();
    this.#assertEffectsAvailable();
    if (!this.socket || !this.recovery)
      throw new Error('The native migration service and ordinary employee recovery must be configured');
    if (this.#reconciling || this.#opening)
      throw new Error('An original fleet migration is pending or unconfirmed; inspect its result');
    for (const entry of this.#entries.values()) {
      if (entry.operation.phase !== 'prepared') continue;
      entry.client.assertSession(request);
      try {
        entry.client.assertViewing(request);
        return entry.operation.preview;
      } catch (error) {
        await this.#unknown(entry, 'ORIGINAL_PREVIEW_UNAVAILABLE', error);
        entry.client.close();
      }
    }
    if ([...this.#records.values()].some(fleetOperationBlocks))
      throw new Error('An original fleet migration is pending or unconfirmed; inspect its result');
    if (this.#records.size >= 256) throw new Error('Original fleet history is full; no migration was opened');
    this.#opening = true;
    let client: FleetNativeClient | undefined;
    try {
      client = await FleetNativeClient.open(this.socket, this.#authority, request);
      const preview = await client.preview();
      const binding = client.ownerBinding();
      const at = Date.now();
      const operation = FleetOperationData.parse({
        version: 1,
        purpose: 'fleet-migration-operation-v1',
        operationId: preview.approval.operationId,
        ownerScopeDigest: binding.ownerScopeDigest,
        principal: binding.principal,
        owner: binding.owner ?? null,
        preview,
        phase: 'prepared',
        sequence: 0,
        createdAtEpochMs: at,
        updatedAtEpochMs: at,
        originalBindings: this.company.view(ownerFor(request)).employees.map((employee) => ({
          employeeId: employee.id,
          sessionId: employee.sessionId,
          generation: employee.sessionGeneration,
        })),
        native: null,
        nativeFailure: null,
        restore: [],
        failure: null,
        reconciledAsUnconfirmed: null,
      });
      if (
        this.#records.has(operation.operationId) ||
        [...this.#records.values()].some((row) => row.preview.approval.previewId === preview.approval.previewId)
      )
        throw new Error('The host repeated an original migration reference; no consent is allowed');
      const entry: Entry = { client, operation };
      this.#entries.set(operation.operationId, entry); // Retain actual Q before fallible persistence.
      try {
        const saved = await this.operations!.create(operation, () => {
          this.#assertEffectsAvailable();
          entry.client.assertViewing(request);
        });
        entry.operation = saved;
        this.#records.set(saved.operationId, saved);
      } catch (error) {
        entry.failure = error;
        entry.operation = advanceFleetOperation(operation, 'unknown', {
          failure: fleetOperationFailure('OPERATION_STORE_UNCONFIRMED'),
        });
        this.#records.set(operation.operationId, entry.operation);
        throw error;
      }
      try {
        entry.client.assertViewing(request);
      } catch (error) {
        await this.#unknown(entry, 'OWNER_AUTHORIZATION_CHANGED', error);
        throw error;
      }
      return preview;
    } catch (error) {
      client?.close();
      throw error;
    } finally {
      this.#opening = false;
    }
  }
  async #commit(entry: Entry, next: FleetOperation, current: () => void = () => {}): Promise<void> {
    const previous = entry.operation;
    // Claim the next one-shot phase synchronously before persistence yields.
    // No native/wake call may use it until the exact commit returns known.
    entry.operation = next;
    this.#records.set(next.operationId, next);
    try {
      const saved = await this.operations!.advance(previous, next, current);
      entry.operation = saved;
      this.#records.set(saved.operationId, saved);
    } catch (error) {
      entry.failure ??= error;
      entry.operation = advanceFleetOperation(previous, 'unknown', {
        native: next.native,
        nativeFailure: next.nativeFailure,
        restore: next.restore.map((row) => (row.state === 'pending' ? { ...row, state: 'unknown' as const } : row)),
        failure: previous.failure ?? fleetOperationFailure('OPERATION_STORE_UNCONFIRMED'),
      });
      this.#records.set(previous.operationId, entry.operation);
      throw error;
    }
  }
  async #unknown(entry: Entry, code: FleetOperationFailureCode, cause: unknown): Promise<void> {
    entry.failure ??= cause;
    const next = advanceFleetOperation(entry.operation, 'unknown', {
      failure: entry.operation.failure ?? fleetOperationFailure(code),
      nativeFailure:
        entry.operation.nativeFailure ?? (cause instanceof NativeFleetMigrationFailureError ? cause.diagnostic : null),
    });
    await this.#commit(entry, next);
  }
  async apply(request: FastifyRequest) {
    this.#authority.captureFleetViewer(request);
    const selected = NativeFleetApplyRequest.parse(request.body);
    await this.#load();
    this.#assertEffectsAvailable();
    if (this.#reconciling) throw new Error('Fleet recovery is in progress');
    const entry = [...this.#entries.values()].find(
      (value) => value.operation.preview.approval.previewId === selected.previewId
    );
    if (!entry) throw new Error('Original native preview is unavailable; no consent was reconstructed');
    entry.client.assertViewing(request);
    if (
      entry.operation.phase !== 'prepared' ||
      selected.expectedRevision !== entry.operation.preview.approval.revisionDigest
    )
      throw new Error('Migration consent was already attempted or its revision changed');
    try {
      await this.#commit(entry, advanceFleetOperation(entry.operation, 'issued'), () => {
        this.#assertEffectsAvailable();
        entry.client.assertViewing(request);
      });
      this.#assertEffectsAvailable();
      entry.client.assertViewing(request);
      const native = await entry.client.migrate(request);
      await this.#commit(entry, advanceFleetOperation(entry.operation, 'native-confirmed', { native }));
      await this.#restore(entry, request);
    } catch (error) {
      if (!['unknown'].includes(entry.operation.phase)) {
        const code =
          error instanceof ResourceOwnerAuthorizationError
            ? 'OWNER_AUTHORIZATION_CHANGED'
            : 'NATIVE_OUTCOME_UNCONFIRMED';
        await this.#unknown(entry, code, error);
      }
      throw error;
    }
    return this.#result(entry.operation);
  }
  async result(request: FastifyRequest) {
    this.#authority.captureFleetViewer(request);
    const selected = NativeFleetResultRequest.parse(request.body);
    try {
      await this.#load();
    } catch {
      /* Existing original metadata may still explain the uncertainty. */
    }
    let operation = this.#records.get(selected.operationId);
    if (!operation) throw new Error('Original migration result is unavailable; absence never proves completion');
    this.#assertRecord(request, operation);
    const entry = this.#entries.get(operation.operationId);
    if (entry && !['completed', 'unknown'].includes(entry.operation.phase)) {
      try {
        entry.client.assertOwnerCurrent();
      } catch (error) {
        await this.#unknown(entry, 'OWNER_AUTHORIZATION_CHANGED', error);
        operation = entry.operation;
      }
    }
    return this.#result(operation);
  }
  async operationHistory(request: FastifyRequest) {
    const viewer = this.#authority.captureFleetViewer(request);
    NativeFleetPreviewRequest.parse(request.body);
    try {
      await this.#load();
    } catch {
      /* Never turn unavailable history into an empty-success claim. */
    }
    this.#authority.assertContext(viewer);
    const records = [...this.#records.values()].filter(
      (row) =>
        row.owner === (viewer.owner ?? null) &&
        row.principal.accountId === viewer.principal.accountId &&
        row.principal.personId === viewer.principal.personId
    );
    const available = !!this.operations && this.#loadFailure === undefined && !this.operations.failed();
    return {
      available,
      blocksFurtherChanges: !available || records.some(fleetOperationBlocks),
      operations: records.map((row) => this.#result(row)),
    };
  }
  #result(operation: FleetOperation) {
    const state =
      operation.phase === 'prepared'
        ? 'previewed'
        : operation.phase === 'completed'
          ? 'pool-configured'
          : operation.phase === 'unknown'
            ? 'unknown'
            : 'pending';
    return structuredClone({
      operationId: operation.operationId,
      state,
      phase: operation.phase,
      blocksFurtherChanges: fleetOperationBlocks(operation),
      native: operation.native,
      restore: operation.restore.map((row) => ({ ...row })),
      failure: operation.failure,
      nativeFailure: operation.nativeFailure,
    });
  }
  async reconcile(request: FastifyRequest) {
    const viewer = this.#authority.captureFleetViewer(request);
    const selected = FleetRecoveryRequest.parse(request.body);
    if (this.operations) await this.#load();
    if (this.#closed || this.#opening || this.#reconciling || !this.recovery?.observeUninstalledPool || !this.history)
      throw new Error('Failed setup recovery is unavailable or already in progress');
    if (
      [...this.#entries.values()].some((entry) =>
        ['issued', 'native-confirmed', 'restoring'].includes(entry.operation.phase)
      )
    )
      throw new Error('An original fleet operation is still active; no negative reconciliation was recorded');
    const stored = this.#records.get(selected.operationId);
    if (stored) {
      this.#assertRecord(request, stored);
      if (stored.phase !== 'unknown') throw new Error('Only an original unknown operation can be reconciled');
    }
    this.#reconciling = true;
    try {
      const evidence = PoolAbsenceData.parse(await this.recovery.observeUninstalledPool());
      const current = () => {
        if (this.#closed) throw new Error('Fleet service closed during recovery');
        this.#authority.assertContext(viewer);
        this.#authority.assertFleetSession(request, viewer);
        if (!isDeepStrictEqual(evidence.principal, viewer.principal))
          throw new Error('Current host nomination belongs to another owner session');
      };
      current();
      requireFreshPoolAbsence(evidence);
      const record = await this.history.record(selected.operationId, viewer.ownerScopeDigest, evidence, current);
      current();
      requireFreshPoolAbsence(evidence);
      if (stored) {
        const next = advanceFleetOperation(stored, 'unknown', { reconciledAsUnconfirmed: evidence.nonce });
        await this.operations!.advance(stored, next, current);
        this.#records.set(next.operationId, next);
      }
      const prior = this.#entries.get(selected.operationId);
      if (prior) {
        this.#assertRecord(request, prior.operation);
        if (stored) prior.operation = this.#records.get(stored.operationId)!;
        prior.client.close();
      }
      return {
        operationId: selected.operationId,
        priorOutcome: 'unconfirmed' as const,
        currentState: 'pool-uninstalled' as const,
        historyRecorded: true as const,
        evidenceDigest: record.evidenceDigest,
        observationNonce: evidence.nonce,
        activationAuthorized: false as const,
        startsAuthorized: false as const,
      };
    } finally {
      this.#reconciling = false;
    }
  }
  async #restore(entry: Entry, request: FastifyRequest): Promise<void> {
    const result = entry.operation.native;
    if (!result || !this.recovery) throw new Error('Original recovery is unavailable');
    await this.#commit(entry, advanceFleetOperation(entry.operation, 'restoring'));
    for (const original of result.restore) {
      const before = entry.operation.originalBindings.find((row) => row.employeeId === original.employeeId);
      const current = () => {
        this.#assertEffectsAvailable();
        entry.client.assertOwnerCurrent();
        entry.client.assertSession(request);
        const employee = this.company
          .view(ownerFor(request))
          .employees.find((value) => value.id === original.employeeId);
        return (
          !!employee &&
          before?.sessionId === original.sessionId &&
          employee.sessionId === original.sessionId &&
          employee.sessionGeneration === before?.generation &&
          !employee.onVacation &&
          employee.desiredRunning !== false
        );
      };
      const outcome: FleetRestoreOutcome = { ...original, state: 'pending', report: null };
      await this.#commit(
        entry,
        advanceFleetOperation(entry.operation, 'restoring', {
          restore: [...entry.operation.restore, outcome],
        }),
        () => {
          this.#assertEffectsAvailable();
          entry.client.assertOwnerCurrent();
          entry.client.assertSession(request);
        }
      );
      try {
        if (!current()) outcome.state = 'skipped-current-intent';
        else {
          await this.recovery.refreshHealth();
          if (!current()) outcome.state = 'skipped-current-intent';
          else {
            outcome.report = await this.recovery.wakeEmployee(original.employeeId, {
              explicitStart: true,
              stillCurrent: current,
            });
            await this.recovery.refreshHealth();
            const employee = this.company
              .view(ownerFor(request))
              .employees.find((value) => value.id === original.employeeId);
            outcome.state =
              current() &&
              employee &&
              this.recovery.providerHealth(employee)?.state === 'healthy' &&
              (outcome.report.awakened.includes(original.employeeId) || outcome.report.skipped.length === 0)
                ? 'wake-confirmed'
                : 'unknown';
          }
        }
      } catch (error) {
        entry.failure ??= error;
        outcome.state = 'unknown';
      }
      await this.#commit(
        entry,
        advanceFleetOperation(entry.operation, 'restoring', {
          restore: entry.operation.restore.map((row) => (row.employeeId === outcome.employeeId ? outcome : row)),
        })
      );
    }
    if (entry.operation.restore.some((row) => row.state === 'unknown'))
      await this.#unknown(entry, 'RESTORE_OUTCOME_UNCONFIRMED', entry.failure);
    else await this.#commit(entry, advanceFleetOperation(entry.operation, 'completed'));
  }
  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) entry.client.close();
    this.#authority.close();
  }
}
