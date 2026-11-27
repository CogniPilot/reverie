/**
 * @fileoverview Per-employee disk budget: the pure rules.
 *
 * Owner rule (2026-11-21): every employee gets a fixed budget for their case
 * folder. Case folders hold git clones only; useful work is pushed to GitHub,
 * and anything kept permanently needs the owner's approval and lives on the
 * shared company drive. The shared Nix store does not count.
 *
 * No I/O here: measuring and delivery live in employee-disk-budget-service.ts.
 *
 * @module employee-disk-budget
 */

const GIB = 1024 ** 3;

/** Default budget for one employee's case folder: 20 GiB. */
export const DEFAULT_EMPLOYEE_DISK_BUDGET_BYTES = 20 * GIB;
/** At most one notice per employee in this window while it stays over budget. */
export const DISK_BUDGET_NOTICE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type DiskBudgetState = 'ok' | 'over';

export interface DiskBudgetMeasurement {
  usedBytes: number;
  budgetBytes: number;
}

/** Exactly at the budget is still within it. */
export function classifyDiskBudget({ usedBytes, budgetBytes }: DiskBudgetMeasurement): DiskBudgetState {
  return usedBytes > budgetBytes ? 'over' : 'ok';
}

export interface DiskBudgetNoticeDecision {
  state: DiskBudgetState;
  /** A notice was already delivered since the folder last measured within budget. */
  notifiedSinceOver: boolean;
  /** When the last notice was delivered (ms), or null when none was. */
  lastNotifiedAt: number | null;
  now: number;
}

/**
 * Notify when over budget and either this crossing has not been told yet (a
 * fresh notice each time the folder newly goes over) or the last notice is at
 * least {@link DISK_BUDGET_NOTICE_INTERVAL_MS} old.
 */
export function shouldNotifyDiskBudget(decision: DiskBudgetNoticeDecision): boolean {
  if (decision.state !== 'over') return false;
  if (!decision.notifiedSinceOver || decision.lastNotifiedAt === null) return true;
  return decision.now - decision.lastNotifiedAt >= DISK_BUDGET_NOTICE_INTERVAL_MS;
}

/** GiB with at most one decimal and no trailing ".0" ("20", "37.2"). */
export function formatGiB(bytes: number): string {
  return String(Math.round((bytes / GIB) * 10) / 10);
}

/**
 * Usage for a notice: one decimal, rounded UP, so a folder just over its budget
 * never reads as exactly the budget.
 */
function formatUsedGiB(bytes: number): string {
  return (Math.ceil((bytes / GIB) * 10) / 10).toFixed(1);
}

/** The notice typed into the employee's session. One line, plain ASCII (writeViaMux/Ink constraint). */
export function diskBudgetNotice({ usedBytes, budgetBytes }: DiskBudgetMeasurement): string {
  return (
    `Disk budget notice from the office: your case folder uses ${formatUsedGiB(usedBytes)} GiB of your ` +
    `${formatGiB(budgetBytes)} GiB budget. Clean up now: delete build outputs and old run/work folders, ` +
    'keep only git clones, push useful work to GitHub, and ask the owner for approval before keeping anything ' +
    'permanently (approved items go on the shared company drive). The shared Nix store does not count.'
  );
}
