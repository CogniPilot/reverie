/** Native command availability is independent of the disposable terminal viewer.
 * This projection grants no API/launch/restart authority and reads no terminal text.
 */
import { z } from 'zod';
import type { CompanyEmployee } from './company-types.js';
export const PROVIDER_HEALTH_MAX_AGE_MS = 25_000;
import type { ProviderHealth } from './types/provider-health.js';
export type { ProviderHealth } from './types/provider-health.js';
const Row = z
  .object({
    observedBinding: z.array(z.unknown()).length(9),
    employeeId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sessionGeneration: z.number().int().positive().safe(),
    state: z.enum(['healthy', 'dead', 'unknown']),
    observedAtEpochMs: z.number().int().nonnegative(),
    reason: z.enum(['LIVE_NATIVE_COMMAND', 'COMMAND_EXITED', 'OFFICE_PANE_EXITED', 'CONTAINER_STOPPED', 'UNCONFIRMED']),
    proofKind: z.enum(['live-container', 'stopped-container']).optional(),
    containerId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    initPID: z.number().int().positive().optional(),
    initStartTick: z.number().int().positive().optional(),
  })
  .strict();
const Snapshot = z
  .object({ version: z.literal(1), purpose: z.literal('worker-provider-health-v1'), providers: z.array(Row).max(64) })
  .strict();
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
const fingerprint = (e: CompanyEmployee) =>
  canonical([
    e.id,
    e.owner,
    e.sessionId,
    e.sessionGeneration,
    e.desiredRunning,
    e.onVacation,
    e.bindingMigration,
    e.runtimeRecipe,
    e.permissions,
  ]);
export function viewerHealth(
  session:
    | {
        pid?: number | null;
        runtimeHealth?: string;
        runtimeHealthScope?: string;
        paneExit?: unknown;
        viewerInputHeld?: boolean;
      }
    | undefined,
  workerConfigured = false
): 'connected' | 'disconnected' | 'unknown' {
  if (!session) return workerConfigured ? 'disconnected' : 'unknown';
  if (session.viewerInputHeld) return 'disconnected';
  if (
    session.runtimeHealthScope === 'terminal' &&
    (session.runtimeHealth === 'disconnected' || session.paneExit || session.pid === null)
  )
    return 'disconnected';
  return typeof session.pid === 'number' && session.pid > 0 && !session.paneExit ? 'connected' : 'unknown';
}
export class WorkerProviderHealth {
  private entries = new Map<string, { binding: string; until: number; value: ProviderHealth }>();
  // Receipt deadlines survive unavailable/empty snapshots so retries cannot
  // renew the same native observation after partial wall-clock rollback.
  private receipts = new Map<string, { epoch: number; binding: string; until: number }>();
  private flight = false;
  private closed = false;
  private controller?: AbortController;
  constructor(
    private readonly deps: {
      employees(): CompanyEmployee[];
      query(signal?: AbortSignal): Promise<Record<string, unknown>>;
      changed(): void;
      now?(): number;
      monotonic?(): number;
    }
  ) {}
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private monotonic() {
    return (this.deps.monotonic ?? (() => performance.now()))();
  }
  /** Current employee rows come from a synchronous canonical view with unique
   * session bindings. Reuse that row instead of reloading the company per item.
   * SID-only callers retain the independent current-registry/owner check.
   */
  read(current: CompanyEmployee | string, expected?: { owner?: string }): ProviderHealth | undefined {
    if (this.closed) return;
    const rows = typeof current === 'string' ? this.deps.employees().filter((e) => e.sessionId === current) : [current];
    if (rows.length !== 1) return;
    if (expected && rows[0].owner !== expected.owner) return;
    const employee = rows[0],
      sid = employee.sessionId,
      entry = this.entries.get(sid),
      age = entry ? this.now() - entry.value.observedAtEpochMs : -1;
    if (
      !entry ||
      employee.desiredRunning !== true ||
      employee.onVacation ||
      employee.bindingMigration ||
      entry.binding !== fingerprint(employee) ||
      age < 0 ||
      age > PROVIDER_HEALTH_MAX_AGE_MS ||
      this.monotonic() > entry.until
    )
      return;
    return { ...entry.value };
  }
  async refresh(): Promise<void> {
    if (this.flight || this.closed) return;
    this.flight = true;
    this.controller = new AbortController();
    const before = new Map(this.deps.employees().map((e) => [e.sessionId, fingerprint(e)]));
    try {
      const raw = await this.deps.query(this.controller.signal);
      if (this.closed) return;
      const parsed = Snapshot.safeParse(raw.providerHealth);
      const entries = new Map<string, { binding: string; until: number; value: ProviderHealth }>();
      if (parsed.success) {
        const rows = parsed.data.providers;
        if (
          new Set(rows.map((r) => r.sessionId)).size !== rows.length ||
          new Set(rows.map((r) => r.employeeId)).size !== rows.length
        )
          throw Error('Ambiguous native provider health');
        // One fresh census after the async query, independent of response size.
        const employees = this.deps.employees();
        for (const row of rows) {
          const current = employees.filter(
            (e) =>
              e.id === row.employeeId && e.sessionId === row.sessionId && e.sessionGeneration === row.sessionGeneration
          );
          if (
            current.length !== 1 ||
            before.get(row.sessionId) !== fingerprint(current[0]) ||
            canonical(row.observedBinding) !== fingerprint(current[0])
          )
            continue;
          const age = this.now() - row.observedAtEpochMs;
          if (age < 0 || age > PROVIDER_HEALTH_MAX_AGE_MS) continue;
          if (
            row.state !== 'unknown' &&
            ((row.reason === 'CONTAINER_STOPPED') !== (row.proofKind === 'stopped-container') ||
              !row.containerId ||
              (row.proofKind === 'stopped-container'
                ? row.state !== 'dead' ||
                  row.reason !== 'CONTAINER_STOPPED' ||
                  row.initPID !== undefined ||
                  row.initStartTick !== undefined
                : row.proofKind !== 'live-container' || !row.initPID || !row.initStartTick))
          )
            continue;
          if (
            (row.state === 'healthy' && row.reason !== 'LIVE_NATIVE_COMMAND') ||
            (row.state === 'dead' &&
              !['COMMAND_EXITED', 'OFFICE_PANE_EXITED', 'CONTAINER_STOPPED'].includes(row.reason)) ||
            (row.state === 'unknown' && row.reason !== 'UNCONFIRMED')
          )
            continue;
          const binding = fingerprint(current[0]);
          const previous = this.receipts.get(row.employeeId);
          const deadline = this.monotonic() + PROVIDER_HEALTH_MAX_AGE_MS - age;
          if (
            previous &&
            (row.observedAtEpochMs < previous.epoch ||
              (row.observedAtEpochMs === previous.epoch && binding !== previous.binding))
          )
            continue;
          if (!previous && this.receipts.size >= 4096) continue;
          const until = previous?.epoch === row.observedAtEpochMs ? Math.min(previous.until, deadline) : deadline;
          this.receipts.set(row.employeeId, { epoch: row.observedAtEpochMs, binding, until });
          if (this.monotonic() > until) continue;
          entries.set(row.sessionId, {
            binding: fingerprint(current[0]),
            until,
            value: {
              binding: fingerprint(current[0]),
              employeeId: row.employeeId,
              sessionId: row.sessionId,
              sessionGeneration: row.sessionGeneration,
              state: row.state,
              observedAtEpochMs: row.observedAtEpochMs,
              reason: row.reason,
            },
          });
        }
      }
      this.entries = entries;
      this.deps.changed();
    } catch {
      if (!this.closed) {
        this.entries.clear();
        this.deps.changed();
      }
    } finally {
      this.flight = false;
      this.controller = undefined;
    }
  }
  close() {
    this.closed = true;
    this.controller?.abort();
    this.entries.clear();
  }
}
