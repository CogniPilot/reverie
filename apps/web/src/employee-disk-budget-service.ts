/**
 * @fileoverview Per-employee disk budget: periodic measurement and notices.
 *
 * Every cycle measures each registered employee's case folder (the saved
 * session's `workingDir`), one at a time, and keeps the latest result in
 * memory. An employee over budget is told in its own session, as a programmatic
 * prompt, at the cadence employee-disk-budget.ts decides.
 *
 * Robustness rules (the disk filling up once took the office down):
 * - measuring never blocks the event loop: `du` is a child process with a
 *   timeout, lowest CPU/IO priority where `nice`/`ionice` exist;
 * - runs never overlap, and one folder is measured at a time;
 * - a folder is measured only when it is a real directory strictly under the
 *   cases dir, probed BOUNDED first; anything else reads `unknown`, which is
 *   never "empty" and never produces a notice;
 * - a notice is only typed into a live, unheld, idle session; a busy session is
 *   retried next cycle without spending the rate limit;
 * - nothing here throws into the caller: failures are logged once per kind.
 *
 * Measurements and notice times are in memory only: after a restart the first
 * cycle measures again and an employee still over budget is told again.
 *
 * @module employee-disk-budget-service
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_EMPLOYEE_DISK_BUDGET_BYTES,
  classifyDiskBudget,
  diskBudgetNotice,
  shouldNotifyDiskBudget,
} from './employee-disk-budget.js';
import { probePathKind } from './utils/bounded-path-probe.js';

/** Time between measurement cycles. */
export const DISK_BUDGET_INTERVAL_MS = 30 * 60 * 1000;
/** Delay before the first cycle after boot, so startup and restore go first. */
export const DISK_BUDGET_FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
/** One folder's `du` is killed after this long and reads `unknown`. */
export const DISK_BUDGET_MEASURE_TIMEOUT_MS = 10 * 60 * 1000;

/** The company fields this service reads. */
export interface DiskBudgetEmployee {
  id: string;
  name: string;
  sessionId: string;
  onVacation: boolean;
  desiredRunning?: boolean;
}

/** The session calls a notice needs, so delivery is testable without a PTY. */
export interface DiskBudgetNoticeTarget {
  readonly pid: number | null;
  readonly isWorking: boolean;
  readonly providerDispatchHeld: boolean;
  readonly terminalInputHeld: boolean;
  readonly paneDialog?: string | null;
  /** A session attached to a remote host is not this office's to prompt about local disk. */
  readonly remote?: unknown;
  canAcceptChatInput?(): boolean;
  writeViaMux(text: string, options: { opencodeGuard: boolean; requireEmptyComposer: boolean }): Promise<boolean>;
}

export interface EmployeeDiskBudgetDeps {
  employees(): readonly DiskBudgetEmployee[];
  /** The saved session's working directory, or undefined when the session is unknown. */
  workingDir(sessionId: string): string | undefined;
  /** The live session, or undefined when it is not running here. */
  session(sessionId: string): DiskBudgetNoticeTarget | undefined;
  /** Bytes used by one case folder, or null when it could not be measured. Must not throw. */
  measure(dir: string, signal: AbortSignal): Promise<number | null>;
  now?(): number;
  budgetBytes?: number;
  warn?(message: string): void;
}

export interface EmployeeDiskBudgetRow {
  id: string;
  name: string;
  usedBytes: number | null;
  measuredAt: number | null;
  state: 'ok' | 'over' | 'unknown';
  lastNotifiedAt: number | null;
}

export interface EmployeeDiskBudgetView {
  budgetBytes: number;
  employees: EmployeeDiskBudgetRow[];
}

interface BudgetRecord {
  usedBytes: number | null;
  measuredAt: number | null;
  state: 'ok' | 'over' | 'unknown';
  lastNotifiedAt: number | null;
  notifiedSinceOver: boolean;
}

const newRecord = (): BudgetRecord => ({
  usedBytes: null,
  measuredAt: null,
  state: 'unknown',
  lastNotifiedAt: null,
  notifiedSinceOver: false,
});

export class EmployeeDiskBudgetService {
  readonly budgetBytes: number;
  private readonly records = new Map<string, BudgetRecord>();
  private readonly warned = new Set<string>();
  private running: Promise<void> | undefined;
  private abort = new AbortController();
  private firstRun: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: EmployeeDiskBudgetDeps) {
    this.budgetBytes = deps.budgetBytes ?? DEFAULT_EMPLOYEE_DISK_BUDGET_BYTES;
  }

  /** Arm the first run and the recurring cycle. Idempotent. */
  start(): void {
    if (this.firstRun || this.interval || this.abort.signal.aborted) return;
    this.firstRun = setTimeout(() => {
      this.firstRun = undefined;
      void this.runOnce();
      this.interval = setInterval(() => void this.runOnce(), DISK_BUDGET_INTERVAL_MS);
      this.interval.unref?.();
    }, DISK_BUDGET_FIRST_RUN_DELAY_MS);
    this.firstRun.unref?.();
  }

  /** Stop the timers and kill a measurement in flight. The service does not run again. */
  stop(): void {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.interval) clearInterval(this.interval);
    this.firstRun = this.interval = undefined;
    this.abort.abort();
  }

  /**
   * Run one cycle. A call made while a cycle is running joins that cycle rather
   * than starting a second one. Never rejects.
   */
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    if (this.abort.signal.aborted) return Promise.resolve();
    const run = this.cycle()
      .catch((err) => this.warnOnce('cycle', `[disk-budget] cycle failed: ${message(err)}`))
      .finally(() => {
        if (this.running === run) this.running = undefined;
      });
    this.running = run;
    return run;
  }

  /** Latest measurements for the given employees (the caller scopes them to the owner). */
  view(employees: readonly Pick<DiskBudgetEmployee, 'id' | 'name'>[]): EmployeeDiskBudgetView {
    return {
      budgetBytes: this.budgetBytes,
      employees: employees.map(({ id, name }) => {
        const record = this.records.get(id) ?? newRecord();
        return {
          id,
          name,
          usedBytes: record.usedBytes,
          measuredAt: record.measuredAt,
          state: record.state,
          lastNotifiedAt: record.lastNotifiedAt,
        };
      }),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async cycle(): Promise<void> {
    const employees = [...this.deps.employees()];
    const live = new Set(employees.map((employee) => employee.id));
    for (const id of this.records.keys()) if (!live.has(id)) this.records.delete(id);
    // Employees sharing one folder cost one measurement per cycle.
    const measured = new Map<string, number | null>();
    for (const employee of employees) {
      if (this.abort.signal.aborted) return;
      const record = this.records.get(employee.id) ?? newRecord();
      this.records.set(employee.id, record);
      const dir = this.deps.workingDir(employee.sessionId);
      let used: number | null = null;
      if (dir) {
        const key = resolve(dir);
        if (!measured.has(key)) measured.set(key, await this.measure(key));
        used = measured.get(key) ?? null;
      }
      if (this.abort.signal.aborted) return;
      record.measuredAt = this.now();
      record.usedBytes = used;
      if (used === null) {
        // Unknown is not "ok": the over-budget episode, if any, stays open.
        record.state = 'unknown';
        continue;
      }
      record.state = classifyDiskBudget({ usedBytes: used, budgetBytes: this.budgetBytes });
      if (record.state === 'ok') {
        record.notifiedSinceOver = false;
        continue;
      }
      await this.notify(employee, record, used);
    }
  }

  private async measure(dir: string): Promise<number | null> {
    try {
      const used = await this.deps.measure(dir, this.abort.signal);
      return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null;
    } catch (err) {
      this.warnOnce('measure', `[disk-budget] measuring a case folder failed: ${message(err)}`);
      return null;
    }
  }

  private async notify(employee: DiskBudgetEmployee, record: BudgetRecord, usedBytes: number): Promise<void> {
    if (employee.onVacation || employee.desiredRunning === false) return;
    const now = this.now();
    const due = shouldNotifyDiskBudget({
      state: 'over',
      notifiedSinceOver: record.notifiedSinceOver,
      lastNotifiedAt: record.lastNotifiedAt,
      now,
    });
    if (!due) return;
    try {
      const session = this.deps.session(employee.sessionId);
      if (!session || !readyForNotice(session)) return; // retried next cycle; the rate limit is not spent
      const sent = await session.writeViaMux(diskBudgetNotice({ usedBytes, budgetBytes: this.budgetBytes }) + '\r', {
        opencodeGuard: true,
        requireEmptyComposer: true,
      });
      if (!sent) return;
      record.lastNotifiedAt = now;
      record.notifiedSinceOver = true;
    } catch (err) {
      this.warnOnce('notify', `[disk-budget] delivering a notice failed: ${message(err)}`);
    }
  }

  private warnOnce(kind: string, text: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    (this.deps.warn ?? console.warn)(text);
  }
}

/** Live here, not held, not mid-turn, no dialog on screen, and a composer that takes text. */
function readyForNotice(session: DiskBudgetNoticeTarget): boolean {
  if (session.pid === null || session.remote) return false;
  if (session.providerDispatchHeld || session.terminalInputHeld) return false;
  if (session.isWorking || session.paneDialog) return false;
  return session.canAcceptChatInput?.() !== false;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The directory to measure for `workingDir`, or null when it must not be
 * measured: not strictly under the cases dir, not answering (`unknown`), not a
 * directory, or reached through a symlink anywhere below the cases dir.
 */
export async function resolveMeasurableCaseDir(workingDir: string, casesDir: string): Promise<string | null> {
  const root = resolve(casesDir);
  const dir = resolve(workingDir);
  if (!dir.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  // Bounded first (#516): an unreachable mount answers `unknown` and nothing below touches it.
  if ((await probePathKind(root)) !== 'directory' || (await probePathKind(dir)) !== 'directory') return null;
  try {
    const realRoot = await fs.realpath(root);
    return (await fs.realpath(dir)) === join(realRoot, relative(root, dir)) ? dir : null;
  } catch {
    return null;
  }
}

async function onPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      await fs.access(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

let lowPriorityPrefix: Promise<string[]> | undefined;
/** `ionice -c3 nice -n 19` as far as those tools exist on this host; looked up once. */
function lowPriority(): Promise<string[]> {
  lowPriorityPrefix ??= (async () => [
    ...((await onPath('ionice')) ? ['ionice', '-c3'] : []),
    ...((await onPath('nice')) ? ['nice', '-n', '19'] : []),
  ])();
  return lowPriorityPrefix;
}

/**
 * `du -skx -- <dir>` as a low-priority child process: one filesystem, symlinks
 * not followed, killed at `timeoutMs` or on `signal`. Resolves the size in
 * bytes, or null on a spawn failure, a kill or unreadable output. `du` exits 1
 * when some entries could not be read and still prints the total of the rest;
 * that total is accepted as a lower bound.
 */
export async function measureDirBytes(
  dir: string,
  signal: AbortSignal,
  timeoutMs = DISK_BUDGET_MEASURE_TIMEOUT_MS
): Promise<number | null> {
  if (signal.aborted) return null;
  const argv = [...(await lowPriority()), 'du', '-skx', '--', dir];
  return new Promise((done) => {
    let out = '';
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      done(value);
    };
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    const kill = () => {
      child.kill('SIGKILL');
      finish(null);
    };
    const timer = setTimeout(kill, timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (out.length < 4096) out += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const kib = /^(\d+)\s/.exec(out);
      finish((code === 0 || code === 1) && kib ? Number(kib[1]) * 1024 : null);
    });
  });
}

/** The production measurer: path rules first, then `du`. */
export function caseFolderMeasurer(casesDir: () => string): EmployeeDiskBudgetDeps['measure'] {
  return async (workingDir, signal) => {
    const dir = await resolveMeasurableCaseDir(workingDir, casesDir());
    return dir ? measureDirBytes(dir, signal) : null;
  };
}
