/**
 * @fileoverview The rolling hourly post count of each routine author, kept in a small file of its own.
 *
 * Deleting a routine removes its runs and the run history is pruned, so neither can hold a quota. This file survives both and a
 * restart. It holds only employee ids and post times, and it is instance data (never committed).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuthorQuotaStore {
  load(): Record<string, number[]>;
  save(posts: Record<string, number[]>): void;
}

export class AuthorQuotaFile implements AuthorQuotaStore {
  constructor(private readonly file: string) {}

  load(): Record<string, number[]> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      const out: Record<string, number[]> = {};
      if (raw && typeof raw === 'object') {
        for (const [id, times] of Object.entries(raw)) {
          if (Array.isArray(times)) out[id] = times.filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  save(posts: Record<string, number[]>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(posts), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[cron] could not save the routine post counts:', err instanceof Error ? err.message : String(err));
    }
  }
}
