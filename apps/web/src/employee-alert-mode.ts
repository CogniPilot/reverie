import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AlertMode = 'ring' | 'vibrate' | 'silent';
export interface AlertLease {
  mode: AlertMode;
  until: number;
}
/**
 * The mode in effect and where it comes from. `lease` is a timed choice (an agent's own, a coordinator's,
 * or the owner's own phone), `preference` is the owner's lasting choice for an employee, `default` is
 * neither. `then` is what applies once a lease ends, so a client never has to guess.
 */
export interface AlertState {
  mode: AlertMode;
  source: 'lease' | 'preference' | 'default';
  until?: number;
  then?: AlertMode;
}
export const MAX_ALERT_LEASE_MS = 8 * 60 * 60 * 1000;
/** An employee's phone mode with no lease and no owner preference. */
export const DEFAULT_EMPLOYEE_ALERT_MODE: AlertMode = 'vibrate';
const MODES: readonly string[] = ['ring', 'vibrate', 'silent'];

function readRecord(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid employee alert modes');
  return parsed as Record<string, unknown>;
}

/** Writes `value` durably: a fresh temporary file, fsync, rename, then a best-effort directory flush. */
function writeRecord(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  // Rename is the commit point. A subsequent directory flush failure must
  // not return a refusal after the durable file has already changed.
  try {
    const dir = openSync(dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    console.warn('Alert mode committed; directory flush failed', error);
  }
}

export class EmployeeAlertModes {
  private leases: Record<string, AlertLease> = Object.create(null);
  private preferences: Record<string, AlertMode> = Object.create(null);
  /**
   * `file` holds the timed leases, as before. The owner's lasting preferences live beside it in
   * `preferencesFile`, so an older console reading `file` still finds only leases.
   */
  constructor(
    private file: string | undefined,
    private now: () => number = Date.now,
    private preferencesFile?: string
  ) {
    const leases = file ? readRecord(file) : undefined;
    for (const [id, value] of Object.entries(leases ?? {})) {
      const lease = value as AlertLease;
      if (!lease || !MODES.includes(lease.mode) || !Number.isFinite(lease.until))
        throw new Error('Invalid alert lease');
      if (lease.until > this.now() + MAX_ALERT_LEASE_MS) throw new Error('Alert lease exceeds eight hours');
      this.leases[id] = lease;
    }
    const preferences = preferencesFile ? readRecord(preferencesFile) : undefined;
    for (const [id, mode] of Object.entries(preferences ?? {})) {
      if (typeof mode !== 'string' || !MODES.includes(mode)) throw new Error('Invalid alert preference');
      this.preferences[id] = mode as AlertMode;
    }
  }
  get(id: string): AlertLease | undefined {
    const lease = this.leases[id];
    return lease && lease.until > this.now() ? { ...lease } : undefined;
  }
  /** The owner's lasting choice for `id`, if any. */
  preference(id: string): AlertMode | undefined {
    return Object.hasOwn(this.preferences, id) ? this.preferences[id] : undefined;
  }
  /** A live lease wins, then the owner's preference, then `fallback`. */
  effective(id: string, fallback: AlertMode): AlertState {
    const lasting = this.preference(id);
    const then = lasting ?? fallback;
    const lease = this.get(id);
    if (lease) return { mode: lease.mode, source: 'lease', until: lease.until, then };
    return lasting ? { mode: lasting, source: 'preference' } : { mode: fallback, source: 'default' };
  }
  /** Stores the owner's lasting choice for `id` and ends any lease it had, so the choice applies now. */
  prefer(id: string, mode: AlertMode): void {
    if (!MODES.includes(mode)) throw new Error('Unknown phone mode');
    const preferences = { ...this.preferences, [id]: mode };
    const leases = { ...this.leases };
    delete leases[id];
    if (this.preferencesFile) writeRecord(this.preferencesFile, preferences);
    this.preferences = preferences;
    if (this.file && Object.hasOwn(this.leases, id)) writeRecord(this.file, leases);
    this.leases = leases;
  }
  /**
   * A timed choice of at most eight hours. Every mode is stored, Ring included, because Ring is no
   * longer what applies without one.
   */
  set(id: string, mode: AlertMode, durationMs: number): AlertLease | undefined {
    if (
      !['ring', 'vibrate', 'silent'].includes(mode) ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > MAX_ALERT_LEASE_MS
    )
      throw new Error('Mode requires a duration greater than zero and at most eight hours');
    const next = { ...this.leases, [id]: { mode, until: this.now() + durationMs } };
    if (this.file) writeRecord(this.file, next);
    this.leases = next;
    return this.get(id);
  }
}
