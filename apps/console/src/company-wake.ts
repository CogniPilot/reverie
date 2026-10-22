/** Recover only the owner-selected crash expert. Never hires or changes identities. */
import type { CompanyEmployee, CompanyState } from './company-types.js';
import type { SessionState } from './types.js';
import { planRebootRestore, type RebootRestoreEntry } from './reboot-restore.js';

export interface CompanyWakeDeps {
  company(): CompanyState;
  saved(sessionId: string): SessionState | undefined;
  live(sessionId: string): boolean;
  closing(sessionId: string): boolean;
  noteRunning(sessionId: string): Promise<void>;
  claim(employeeId: string, sessionId: string, now: number, automatic: boolean): Promise<boolean>;
  wake(entry: RebootRestoreEntry, allowed: () => boolean): Promise<boolean>;
  now?(): number;
  kickoff?(employee: CompanyEmployee, allowed: () => boolean): Promise<void>;
}
export interface CompanyWakeReport {
  awakened: string[];
  skipped: Array<{ employeeId: string; reason: string }>;
}

/** Stable breadth-first organization order; invalid/cyclic/foreign reporting lines never launch. */
export function companyWakeOrder(state: CompanyState): { employees: CompanyEmployee[]; blocked: CompanyEmployee[] } {
  const byId = new Map(state.employees.map((e) => [e.id, e]));
  const depths = new Map<string, number | null>();
  const depth = (employee: CompanyEmployee, seen = new Set<string>()): number | null => {
    if (depths.has(employee.id)) return depths.get(employee.id)!;
    if (seen.has(employee.id)) return null;
    const next = new Set(seen);
    next.add(employee.id);
    const coordinator = state.settings.find((s) => s.owner === employee.owner)?.coordinatorEmployeeId;
    const parentId = employee.reportsTo ?? (employee.id === coordinator ? 'owner' : coordinator);
    let value: number | null = 0;
    if (parentId && parentId !== 'owner') {
      const parent = byId.get(parentId);
      const parentDepth = parent && parent.owner === employee.owner ? depth(parent, next) : null;
      value = parentDepth === null ? null : parentDepth + 1;
    }
    depths.set(employee.id, value);
    return value;
  };
  for (const employee of state.employees) depth(employee);
  return {
    employees: state.employees
      .filter((e) => depths.get(e.id) === 0)
      .sort((a, b) => depths.get(a.id)! - depths.get(b.id)! || a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    blocked: state.employees.filter((e) => depths.get(e.id) === null),
  };
}

export class CompanyWake {
  private flight?: Promise<CompanyWakeReport>;
  constructor(private readonly deps: CompanyWakeDeps) {}

  /** Startup and timer passes share one flight, including all awaited process starts. */
  tick(): Promise<CompanyWakeReport> {
    if (this.flight) return this.flight;
    const flight = this.run();
    this.flight = flight;
    void flight
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
      })
      .catch(() => {});
    return flight;
  }

  private isSelected(id: string, owner: string | undefined): boolean {
    const state = this.deps.company();
    const settings = state.settings.find((s) => s.owner === owner);
    if (settings?.crashWakeEmployeeId) return settings.crashWakeEmployeeId === id;
    const roots = companyWakeOrder(state).employees.filter((e) => e.owner === owner);
    return roots.length === 1 && roots[0].id === id;
  }

  async wakeOne(employeeId: string): Promise<CompanyWakeReport> {
    if (this.flight) return { awakened: [], skipped: [{ employeeId, reason: 'recovery-in-progress' }] };
    const flight = this.run(employeeId);
    this.flight = flight;
    try {
      return await flight;
    } finally {
      if (this.flight === flight) this.flight = undefined;
    }
  }

  private async run(manualId?: string): Promise<CompanyWakeReport> {
    const report: CompanyWakeReport = { awakened: [], skipped: [] };
    const snapshot = this.deps.company();
    const order = companyWakeOrder(snapshot);
    const selected = new Set<string>();
    const owners = new Set(snapshot.employees.map((e) => e.owner));
    for (const owner of owners) {
      const settings = snapshot.settings.find((s) => s.owner === owner);
      if (settings?.autoWakeEnabled === false) continue;
      if (settings?.crashWakeEmployeeId) {
        const explicit = snapshot.employees.find((e) => e.id === settings.crashWakeEmployeeId && e.owner === owner);
        if (explicit) selected.add(explicit.id);
      } else {
        const roots = order.employees.filter((e) => e.owner === owner);
        if (roots.length === 1) selected.add(roots[0].id);
      }
    }
    const targets = snapshot.employees
      .filter((e) => (manualId ? e.id === manualId : selected.has(e.id)))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const planned of targets) {
      const current = () =>
        this.deps
          .company()
          .employees.find((e) => e.id === planned.id && e.sessionId === planned.sessionId && e.owner === planned.owner);
      const allowed = () => {
        const employee = current();
        return (
          !!employee &&
          employee.desiredRunning !== false &&
          !this.deps.closing(employee.sessionId) &&
          (!!manualId ||
            this.deps.company().settings.find((s) => s.owner === employee.owner)?.autoWakeEnabled !== false) &&
          (!!manualId || this.isSelected(employee.id, employee.owner))
        );
      };
      const skip = (reason: string) => report.skipped.push({ employeeId: planned.id, reason });
      const employee = current();
      if (!employee || this.deps.closing(planned.sessionId)) {
        skip('changed-or-stopping');
        continue;
      }
      const settings = this.deps.company().settings.find((s) => s.owner === employee.owner);
      if (!manualId && settings?.autoWakeEnabled === false) {
        skip('disabled');
        continue;
      }
      if (employee.desiredRunning === false) {
        skip('not-desired');
        continue;
      }
      if (this.deps.live(employee.sessionId)) {
        await this.deps.noteRunning(employee.sessionId);
        continue;
      }
      if (!allowed()) {
        skip('not-desired');
        continue;
      }
      const saved = this.deps.saved(employee.sessionId);
      if (!saved || saved.owner !== employee.owner) {
        skip('no-owned-session-record');
        continue;
      }
      if (employee.desiredRunning !== true && (saved.pid === null || saved.pid === undefined)) {
        skip('not-previously-running');
        continue;
      }
      const plan = planRebootRestore([employee.sessionId], { [employee.sessionId]: saved }, () => true, {
        allowMissingPid: employee.desiredRunning === true,
      });
      const entry = plan.restore[0];
      if (!entry) {
        skip(plan.skipped[0]?.reason ?? 'ineligible');
        continue;
      }
      try {
        if (!(await this.deps.claim(employee.id, employee.sessionId, (this.deps.now ?? Date.now)(), !manualId))) {
          skip('disabled-or-retry-limited');
          continue;
        }
        if (!allowed()) {
          skip('changed-or-stopping');
          continue;
        }
        if (this.deps.live(employee.sessionId)) {
          await this.deps.noteRunning(employee.sessionId);
          continue;
        }
        if (await this.deps.wake(entry, allowed)) {
          report.awakened.push(employee.id);
          if (!manualId && allowed()) {
            try {
              await this.deps.kickoff?.(employee, allowed);
            } catch {
              skip('kickoff-failed');
            }
          }
        } else skip('wake-failed');
      } catch {
        skip('wake-failed');
      }
    }
    return report;
  }
}
