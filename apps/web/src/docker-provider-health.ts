import { encodeDockerProviderPlacement } from './web/public/docker-provider-health-placement.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
/** Non-authorizing Docker provider projection. No Session/viewer/activity evidence. */
import type { CompanyEmployee } from './company-types.js';
import type { ProviderHealth } from './types/provider-health.js';
import { DockerEmployeeProviderHealthProof } from './docker-employee-engine.js';
import { providerHealthBinding, PROVIDER_HEALTH_MAX_AGE_MS } from './worker-provider-health.js';
const privateBinding = (e: CompanyEmployee) =>
  providerHealthBinding(e) + '\0' + dockerContinuationDigest(e.dockerBinding);
const eligible = (e: CompanyEmployee) =>
  !!e.dockerBinding && e.desiredRunning === true && !e.onVacation && !e.bindingMigration;
interface Entry {
  binding: string;
  until: number;
  value: ProviderHealth;
}
export class DockerProviderHealth {
  private entries = new Map<string, Entry>();
  private receipts = new Map<string, { epoch: number; binding: string; until: number }>();
  private seenLive = new Map<string, string>();
  private flight?: Promise<void>;
  private closed = false;
  private notificationQueued = false;
  private epoch = -1;
  private mono = -1;
  constructor(
    private readonly deps: {
      employees(): CompanyEmployee[];
      active(): boolean;
      observe(employee: CompanyEmployee, current: () => void): Promise<DockerEmployeeProviderHealthProof>;
      changed(): void;
      now?(): number;
      monotonic?(): number;
    }
  ) {}
  private notify(): void {
    if (this.closed || this.notificationQueued) return;
    this.notificationQueued = true;
    queueMicrotask(() => {
      this.notificationQueued = false;
      if (!this.closed) {
        try {
          this.deps.changed();
        } catch {
          /* Reporting never changes health acceptance. */
        }
      }
    });
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private monotonic() {
    return (this.deps.monotonic ?? (() => performance.now()))();
  }
  private clock(): boolean {
    const epoch = this.now(),
      mono = this.monotonic();
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      !Number.isFinite(mono) ||
      mono < 0 ||
      epoch < this.epoch ||
      mono < this.mono
    ) {
      this.entries.clear();
      return false;
    }
    this.epoch = epoch;
    this.mono = mono;
    return true;
  }
  read(current: CompanyEmployee | string, expected?: { owner?: string }): ProviderHealth | undefined {
    try {
      if (this.closed || !this.deps.active() || !this.clock()) {
        this.entries.clear();
        return;
      }
      const rows =
        typeof current === 'string' ? this.deps.employees().filter((e) => e.sessionId === current) : [current];
      if (rows.length !== 1) return;
      const e = rows[0]!;
      if (expected && e.owner !== expected.owner) return;
      const entry = this.entries.get(e.sessionId);
      if (!entry) return;
      const age = this.now() - entry.value.observedAtEpochMs;
      if (
        !eligible(e) ||
        entry.binding !== privateBinding(e) ||
        age < 0 ||
        age > PROVIDER_HEALTH_MAX_AGE_MS ||
        this.monotonic() > entry.until
      ) {
        this.entries.delete(e.sessionId);
        if (entry.binding !== privateBinding(e) || !eligible(e)) this.seenLive.delete(e.id);
        return;
      }
      return { ...entry.value };
    } catch {
      this.entries.clear();
      return;
    }
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) return this.flight;
    const run = this.collect();
    this.flight = run;
    void run.finally(() => {
      if (this.flight === run) this.flight = undefined;
    });
    return run;
  }
  private async collect(): Promise<void> {
    try {
      if (!this.deps.active() || !this.clock()) {
        this.entries.clear();
        this.notify();
        return;
      }
      const census = this.deps.employees(),
        all = census.filter(eligible);
      if (all.length > 64) {
        this.entries.clear();
        this.notify();
        return;
      }
      const selected = all
        .filter(
          (e) =>
            census.filter((v) => v.id === e.id).length === 1 &&
            census.filter((v) => v.sessionId === e.sessionId).length === 1
        )
        .map((e) => structuredClone(e));
      const bySession = new Map(selected.map((e) => [e.sessionId, e]));
      for (const [sid, entry] of this.entries) {
        const e = bySession.get(sid);
        if (!e || privateBinding(e) !== entry.binding) {
          this.entries.delete(sid);
          if (e) this.seenLive.delete(e.id);
        }
      }
      for (const [id, binding] of this.seenLive)
        if (!selected.some((e) => e.id === id && privateBinding(e) === binding)) this.seenLive.delete(id);
      let index = 0;
      const worker = async () => {
        for (;;) {
          const employee = selected[index++];
          if (!employee || this.closed) return;
          const binding = privateBinding(employee),
            start = this.monotonic();
          let revoked = false;
          const current = () => {
            if (revoked) throw Error('Docker provider health observation changed');
            try {
              if (this.closed || !this.deps.active() || !this.clock())
                throw Error('Docker provider health unavailable');
              const rows = this.deps.employees(),
                match = rows.filter((e) => e.id === employee.id && e.sessionId === employee.sessionId);
              if (
                match.length !== 1 ||
                rows.filter((e) => e.sessionId === employee.sessionId).length !== 1 ||
                !eligible(match[0]!) ||
                privateBinding(match[0]!) !== binding
              )
                throw Error('Docker provider health binding changed');
            } catch (error) {
              revoked = true;
              this.seenLive.delete(employee.id);
              throw error;
            }
          };
          let state: ProviderHealth['state'] = 'unknown',
            reason = 'UNCONFIRMED';
          try {
            current();
            const proof = await this.deps.observe(employee, current);
            current();
            const observation = DockerEmployeeProviderHealthProof.prototype.require.call(proof, employee);
            current();
            if (observation === 'live') {
              state = 'healthy';
              reason = 'LIVE_NATIVE_COMMAND';
              this.seenLive.set(employee.id, binding);
            } else if (observation === 'stopped') {
              state = 'dead';
              reason = 'CONTAINER_STOPPED';
            } else if (observation === 'absent' && this.seenLive.get(employee.id) === binding) {
              state = 'dead';
              reason = 'COMMAND_EXITED';
            }
          } catch {
            /* No error, foreign proof or missing provider can invent a positive fact. */
          }
          try {
            current();
            const epoch = this.now(),
              previous = this.receipts.get(employee.id);
            const deadline = Math.min(
              start + PROVIDER_HEALTH_MAX_AGE_MS,
              this.monotonic() + PROVIDER_HEALTH_MAX_AGE_MS
            );
            if (previous && (epoch < previous.epoch || (epoch === previous.epoch && previous.binding !== binding)))
              continue;
            if (!previous && this.receipts.size >= 4096) continue;
            const until = previous?.epoch === epoch ? Math.min(previous.until, deadline) : deadline;
            this.receipts.set(employee.id, { epoch, binding, until });
            if (this.monotonic() > until) continue;
            this.entries.set(employee.sessionId, {
              binding,
              until,
              value: {
                binding: providerHealthBinding(employee),
                employeeId: employee.id,
                sessionId: employee.sessionId,
                sessionGeneration: employee.sessionGeneration,
                state,
                observedAtEpochMs: epoch,
                reason,
                dockerPlacement: encodeDockerProviderPlacement(employee.dockerBinding),
              },
            });
            this.notify();
          } catch {
            this.entries.delete(employee.sessionId);
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (!this.closed) this.notify();
    } catch {
      if (!this.closed) {
        this.entries.clear();
        try {
          this.notify();
        } catch {
          /* Reporting cannot change this projection. */
        }
      }
    }
  }
  close(): void {
    this.closed = true;
    this.entries.clear();
    this.seenLive.clear();
  }
}
