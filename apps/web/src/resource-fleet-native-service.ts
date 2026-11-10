/** Thin HTTP custody for the original native Q; no native rollout decisions. */
import type { FastifyRequest } from 'fastify';
import type { CompanyService } from './company-service.js';
import type { CompanyWakeReport } from './company-wake.js';
import type { CompanyEmployee } from './company-types.js';
import type { ProviderHealth } from './types/provider-health.js';
import { OwnerAuthService } from './owner-auth/service.js';
import { ownerFor } from './web/route-helpers.js';
import { ResourceOwnerAuthority } from './resource-owner-authority.js';
import { FleetNativeClient } from './resource-fleet-native-client.js';
import {
  NativeFleetPreviewRequest,
  NativeFleetApplyRequest,
  NativeFleetResultRequest,
  type NativeFleetPreview,
  type NativeFleetMigration,
} from './resource-fleet-native-data.js';

export type FleetWakeEmployee = (
  id: string,
  options: { explicitStart: true; stillCurrent: () => boolean }
) => Promise<CompanyWakeReport>;
export interface FleetEmployeeRecovery {
  wakeEmployee: FleetWakeEmployee;
  refreshHealth(): Promise<void>;
  providerHealth(employee: CompanyEmployee): ProviderHealth | undefined;
}
type RestoreOutcome = {
  employeeId: string;
  sessionId: string;
  state: 'wake-confirmed' | 'skipped-current-intent' | 'unknown';
  report: CompanyWakeReport | null;
};
type Entry = {
  client: FleetNativeClient;
  preview: NativeFleetPreview;
  attempted: boolean;
  state: 'previewed' | 'pending' | 'pool-configured' | 'unknown';
  native: NativeFleetMigration | null;
  restore: RestoreOutcome[];
  originalBindings: ReadonlyMap<string, { sessionId: string; generation: number }>;
};
export class FleetNativeService {
  readonly #authority: ResourceOwnerAuthority;
  readonly #entries = new Map<string, Entry>();
  #opening = false;
  constructor(
    private readonly company: CompanyService,
    auth: OwnerAuthService,
    private readonly socket: string | undefined,
    private readonly recovery?: FleetEmployeeRecovery
  ) {
    this.#authority = new ResourceOwnerAuthority(auth);
  }
  async preview(request: FastifyRequest): Promise<NativeFleetPreview> {
    this.#authority.captureFleetViewer(request);
    NativeFleetPreviewRequest.parse(request.body);
    if (!this.socket || !this.recovery)
      throw new Error('The native migration service and ordinary employee recovery must be configured');
    if (this.#opening || [...this.#entries.values()].some((entry) => this.#blocks(entry)))
      throw new Error('An original fleet migration is pending or unconfirmed; inspect its result');
    for (const [id, entry] of this.#entries) {
      if (!entry.attempted && Date.now() < entry.preview.expiresAtEpochMs) {
        entry.client.assertViewing(request);
        return entry.preview;
      }
      if (!entry.attempted) {
        entry.client.close();
        this.#entries.delete(id);
      }
    }
    if (this.#entries.size >= 16) throw new Error('Original fleet history is full; no new migration was opened');
    this.#opening = true;
    let client: FleetNativeClient | undefined;
    try {
      client = await FleetNativeClient.open(this.socket, this.#authority, request);
      const preview = await client.preview();
      if (
        this.#entries.has(preview.approval.operationId) ||
        [...this.#entries.values()].some((entry) => entry.preview.approval.previewId === preview.approval.previewId)
      )
        throw new Error('The host repeated an original migration reference; no new consent is allowed');
      this.#entries.set(preview.approval.operationId, {
        client,
        preview,
        attempted: false,
        state: 'previewed',
        native: null,
        restore: [],
        originalBindings: new Map(
          this.company
            .view(ownerFor(request))
            .employees.map((employee) => [
              employee.id,
              { sessionId: employee.sessionId, generation: employee.sessionGeneration },
            ])
        ),
      });
      return preview;
    } catch (error) {
      client?.close();
      throw error;
    } finally {
      this.#opening = false;
    }
  }
  async apply(request: FastifyRequest) {
    this.#authority.captureFleetViewer(request);
    const selected = NativeFleetApplyRequest.parse(request.body);
    const entry = [...this.#entries.values()].find((value) => value.preview.approval.previewId === selected.previewId);
    if (!entry) throw new Error('Original native preview is unavailable; no consent was sent');
    entry.client.assertViewing(request);
    if (entry.attempted || selected.expectedRevision !== entry.preview.approval.revisionDigest)
      throw new Error('Migration consent was already attempted or its revision changed');
    entry.attempted = true;
    entry.state = 'pending'; // Retained before the one possible native dispatch.
    try {
      entry.native = await entry.client.migrate(request);
      await this.#restore(entry, request);
      entry.state = entry.restore.some((value) => value.state === 'unknown') ? 'unknown' : 'pool-configured';
    } catch (error) {
      entry.state = 'unknown';
      throw error;
    }
    return this.#result(entry);
  }
  result(request: FastifyRequest) {
    this.#authority.captureFleetViewer(request);
    const selected = NativeFleetResultRequest.parse(request.body);
    const entry = this.#entries.get(selected.operationId);
    if (!entry) throw new Error('Original migration result is unavailable; absence does not prove completion');
    entry.client.assertSession(request);
    return this.#result(entry);
  }
  #result(entry: Entry) {
    return {
      operationId: entry.preview.approval.operationId,
      state: entry.state,
      blocksFurtherChanges: this.#blocks(entry),
      native: entry.native,
      restore: entry.restore.map((row) => ({ ...row })),
    };
  }
  #blocks(entry: Entry): boolean {
    return entry.attempted && (entry.state === 'pending' || entry.state === 'unknown');
  }
  async #restore(entry: Entry, request: FastifyRequest): Promise<void> {
    const result = entry.native;
    if (!result || !this.recovery) throw new Error('The native restore cohort or ordinary recovery is unavailable');
    for (const original of result.restore) {
      const before = entry.originalBindings.get(original.employeeId);
      const current = () => {
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
      const outcome: RestoreOutcome = { ...original, state: 'unknown', report: null };
      entry.restore.push(outcome); // Own the attempt before any recovery call.
      try {
        if (!current()) {
          outcome.state = 'skipped-current-intent';
          continue;
        }
        await this.recovery.refreshHealth();
        if (!current()) {
          outcome.state = 'skipped-current-intent';
          continue;
        }
        const report = await this.recovery.wakeEmployee(original.employeeId, {
          explicitStart: true,
          stillCurrent: current,
        });
        outcome.report = report;
        await this.recovery.refreshHealth();
        const employee = this.company
          .view(ownerFor(request))
          .employees.find((value) => value.id === original.employeeId);
        if (
          current() &&
          employee &&
          this.recovery.providerHealth(employee)?.state === 'healthy' &&
          (report.awakened.includes(original.employeeId) || report.skipped.length === 0)
        )
          outcome.state = 'wake-confirmed';
      } catch {
        /* Same original attempt stays unknown and is never replayed. */
      }
    }
  }
  close(): void {
    for (const entry of this.#entries.values()) entry.client.close();
    this.#authority.close();
  }
}
