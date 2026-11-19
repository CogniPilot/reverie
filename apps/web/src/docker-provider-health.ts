import { encodeDockerProviderPlacement } from './docker-provider-health-placement.js';
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
const MAX_ELIGIBLE = 64;
const MAX_CONCURRENT_PROBES = 4;
interface Entry {
  binding: string;
  until: number;
  value: ProviderHealth;
}
interface Probe {
  employee: CompanyEmployee;
  binding: string;
  done: Promise<void>;
  finish(): void;
}
export class DockerProviderHealth {
  private entries = new Map<string, Entry>();
  private receipts = new Map<string, { epoch: number; binding: string; until: number }>();
  private seenLive = new Map<string, string>();
  private queued = new Map<string, Probe>();
  private running = new Map<string, Probe>();
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
  async refresh(): Promise<void> {
    if (this.closed) return;
    try {
      if (!this.deps.active() || !this.clock()) {
        this.entries.clear();
        this.clearQueue();
        this.notify();
        return;
      }
      const census = this.deps.employees(),
        all = census.filter(eligible);
      if (all.length > MAX_ELIGIBLE) {
        this.entries.clear();
        this.clearQueue();
        this.notify();
        return;
      }
      const selected = all.filter(
        (e) =>
          census.filter((v) => v.id === e.id).length === 1 &&
          census.filter((v) => v.sessionId === e.sessionId).length === 1
      );
      const bySession = new Map(selected.map((e) => [e.sessionId, e]));
      const byEmployee = new Map(selected.map((e) => [e.id, privateBinding(e)]));
      for (const [sid, entry] of this.entries) {
        const e = bySession.get(sid);
        if (!e || privateBinding(e) !== entry.binding) {
          this.entries.delete(sid);
          if (e) this.seenLive.delete(e.id);
          this.notify();
        }
      }
      for (const [id, binding] of this.seenLive) if (byEmployee.get(id) !== binding) this.seenLive.delete(id);
      for (const [id, probe] of this.queued) {
        if (byEmployee.get(id) === probe.binding) continue;
        this.queued.delete(id);
        probe.finish();
      }
      const probes = selected.map((employee) => this.enqueue(employee, byEmployee.get(employee.id)!));
      this.drain();
      await Promise.all(probes);
    } catch {
      if (!this.closed) {
        this.entries.clear();
        this.clearQueue();
        this.notify();
      }
    }
  }
  private enqueue(employee: CompanyEmployee, binding: string): Promise<void> {
    const original = this.running.get(employee.id);
    if (original?.binding === binding) return original.done;
    const queued = this.queued.get(employee.id);
    if (queued) return queued.done;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.queued.set(employee.id, { employee: structuredClone(employee), binding, done, finish });
    return done;
  }
  // Each tick can queue completed employees again. An unfinished employee
  // retains its slot or FIFO position without delaying the next refresh tick.
  private drain(): void {
    if (this.closed) return;
    for (const [id, probe] of this.queued) {
      if (this.running.size >= MAX_CONCURRENT_PROBES) return;
      if (this.running.has(id)) continue;
      this.queued.delete(id);
      this.running.set(id, probe);
      void this.run(probe);
    }
  }
  private async run(probe: Probe): Promise<void> {
    try {
      await this.observe(probe.employee, probe.binding);
    } catch {
      const sid = probe.employee.sessionId;
      if (this.entries.get(sid)?.binding === probe.binding) {
        this.entries.delete(sid);
        this.notify();
      }
    } finally {
      this.running.delete(probe.employee.id);
      probe.finish();
      this.drain();
    }
  }
  private clearQueue(): void {
    for (const probe of this.queued.values()) probe.finish();
    this.queued.clear();
  }
  private async observe(employee: CompanyEmployee, binding: string): Promise<void> {
    const start = this.monotonic();
    let revoked = false;
    const current = () => {
      if (revoked) throw Error('Docker provider health observation changed');
      try {
        if (this.closed || !this.deps.active() || !this.clock()) throw Error('Docker provider health unavailable');
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
    current();
    const epoch = this.now(),
      previous = this.receipts.get(employee.id);
    const deadline = Math.min(start + PROVIDER_HEALTH_MAX_AGE_MS, this.monotonic() + PROVIDER_HEALTH_MAX_AGE_MS);
    if (previous && (epoch < previous.epoch || (epoch === previous.epoch && previous.binding !== binding))) return;
    if (!previous && this.receipts.size >= 4096) return;
    const until = previous?.epoch === epoch ? Math.min(previous.until, deadline) : deadline;
    this.receipts.set(employee.id, { epoch, binding, until });
    if (this.monotonic() > until) return;
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
  }
  close(): void {
    this.closed = true;
    this.entries.clear();
    this.seenLive.clear();
    this.clearQueue();
  }
}
