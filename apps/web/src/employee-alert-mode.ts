import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AlertMode = 'ring' | 'vibrate' | 'silent';
export interface AlertLease {
  mode: AlertMode;
  until: number;
}
/**
 * A stored lease. `since` orders it against the owner's preference; a lease written without it
 * (by an older console) counts from the earliest time it could have been set.
 */
interface StoredLease extends AlertLease {
  since?: number;
}
/** The owner's lasting choice, and when it was made, which ends every lease set before it. */
interface Preference {
  mode: AlertMode;
  at: number;
}
/** Version of the preferences file, which only this console and later ones read. */
const PREFERENCES_SCHEMA = 1;
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

function leaseStart(lease: StoredLease): number {
  return lease.since ?? lease.until - MAX_ALERT_LEASE_MS;
}

export class EmployeeAlertModes {
  private leases: Record<string, StoredLease> = Object.create(null);
  private preferences: Record<string, Preference> = Object.create(null);
  /**
   * `file` holds the timed leases, as before. The owner's lasting preferences live beside it in
   * `preferencesFile`, so an older console reading `file` still finds only leases.
   *
   * Writing the preferences file is the one commit of an owner's choice: the preference records
   * when it was made, and a lease applies over it only if set later. Removing the superseded lease
   * from `file` afterwards is cleanup, so its failure changes nothing that applies.
   */
  constructor(
    private file: string | undefined,
    private now: () => number = Date.now,
    private preferencesFile?: string
  ) {
    const leases = file ? readRecord(file) : undefined;
    for (const [id, value] of Object.entries(leases ?? {})) {
      const lease = value as StoredLease;
      if (
        !lease ||
        !MODES.includes(lease.mode) ||
        !Number.isFinite(lease.until) ||
        (lease.since !== undefined && !Number.isFinite(lease.since))
      )
        throw new Error('Invalid alert lease');
      if (lease.until > this.now() + MAX_ALERT_LEASE_MS) throw new Error('Alert lease exceeds eight hours');
      this.leases[id] = lease;
    }
    const stored = preferencesFile ? readRecord(preferencesFile) : undefined;
    if (stored) {
      const employees = stored.employees as Record<string, Preference> | undefined;
      if (
        stored.schema !== PREFERENCES_SCHEMA ||
        !employees ||
        typeof employees !== 'object' ||
        Array.isArray(employees)
      )
        throw new Error('Invalid alert preference');
      for (const [id, preference] of Object.entries(employees)) {
        if (!preference || !MODES.includes(preference.mode) || !Number.isFinite(preference.at))
          throw new Error('Invalid alert preference');
        this.preferences[id] = { mode: preference.mode, at: preference.at };
      }
    }
  }
  /** The lease in effect for `id`: live, and not ended by a later owner preference. */
  private live(id: string): StoredLease | undefined {
    const lease = Object.hasOwn(this.leases, id) ? this.leases[id] : undefined;
    if (!lease || lease.until <= this.now()) return undefined;
    const preference = Object.hasOwn(this.preferences, id) ? this.preferences[id] : undefined;
    return preference && leaseStart(lease) <= preference.at ? undefined : lease;
  }
  get(id: string): AlertLease | undefined {
    const lease = this.live(id);
    return lease ? { mode: lease.mode, until: lease.until } : undefined;
  }
  /** The owner's lasting choice for `id`, if any. */
  preference(id: string): AlertMode | undefined {
    return Object.hasOwn(this.preferences, id) ? this.preferences[id].mode : undefined;
  }
  /** A live lease wins, then the owner's preference, then `fallback`. */
  effective(id: string, fallback: AlertMode): AlertState {
    const lasting = this.preference(id);
    const then = lasting ?? fallback;
    const lease = this.get(id);
    if (lease) return { mode: lease.mode, source: 'lease', until: lease.until, then };
    return lasting ? { mode: lasting, source: 'preference' } : { mode: fallback, source: 'default' };
  }
  /**
   * Stores the owner's lasting choice for `id`, which ends any lease it had, so the choice applies
   * now. If the preferences file cannot be written, nothing changes and this throws.
   */
  prefer(id: string, mode: AlertMode): void {
    if (!MODES.includes(mode)) throw new Error('Unknown phone mode');
    const lease = Object.hasOwn(this.leases, id) ? this.leases[id] : undefined;
    // Strictly after the lease it ends, even within the same millisecond.
    const at = lease ? Math.max(this.now(), leaseStart(lease) + 1) : this.now();
    const preferences = { ...this.preferences, [id]: { mode, at } };
    if (this.preferencesFile) writeRecord(this.preferencesFile, { schema: PREFERENCES_SCHEMA, employees: preferences });
    this.preferences = preferences;
    if (!lease) return;
    const leases = { ...this.leases };
    delete leases[id];
    this.leases = leases;
    try {
      if (this.file) writeRecord(this.file, leases);
    } catch (error) {
      // The choice is already committed and the old lease no longer applies; only an older
      // console reading `file` would still see it until it ends.
      console.warn('Phone preference committed; removing its old lease failed', error);
    }
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
    const preference = Object.hasOwn(this.preferences, id) ? this.preferences[id] : undefined;
    // Strictly after any preference, so this lease applies over it.
    const since = preference ? Math.max(this.now(), preference.at + 1) : this.now();
    const next = { ...this.leases, [id]: { mode, until: this.now() + durationMs, since } };
    if (this.file) writeRecord(this.file, next);
    this.leases = next;
    return this.get(id);
  }
}
