import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AlertMode = 'ring' | 'vibrate' | 'silent';
export interface AlertLease {
  mode: AlertMode;
  until: number;
}
export const MAX_ALERT_LEASE_MS = 8 * 60 * 60 * 1000;
export class EmployeeAlertModes {
  private leases: Record<string, AlertLease> = Object.create(null);
  constructor(
    private file: string | undefined,
    private now: () => number = Date.now
  ) {
    if (!file) return;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid employee alert modes');
    for (const [id, value] of Object.entries(parsed)) {
      const lease = value as AlertLease;
      if (!lease || !['ring', 'vibrate', 'silent'].includes(lease.mode) || !Number.isFinite(lease.until))
        throw new Error('Invalid alert lease');
      if (lease.until > this.now() + MAX_ALERT_LEASE_MS) throw new Error('Alert lease exceeds eight hours');
      this.leases[id] = lease;
    }
  }
  get(id: string): AlertLease | undefined {
    const lease = this.leases[id];
    return lease && lease.until > this.now() ? { ...lease } : undefined;
  }
  set(id: string, mode: AlertMode, durationMs: number): AlertLease | undefined {
    if (
      !['ring', 'vibrate', 'silent'].includes(mode) ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > MAX_ALERT_LEASE_MS
    )
      throw new Error('Mode requires a duration greater than zero and at most eight hours');
    const next = { ...this.leases };
    if (mode === 'ring') delete next[id];
    else next[id] = { mode, until: this.now() + durationMs };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
      const fd = openSync(tmp, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
      // Rename is the commit point. A subsequent directory flush failure must
      // not return a refusal after the durable file has already changed.
      this.leases = next;
      try {
        const dir = openSync(dirname(this.file), 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      } catch (error) {
        console.warn('Alert mode committed; directory flush failed', error);
      }
    }
    this.leases = next;
    return this.get(id);
  }
}
