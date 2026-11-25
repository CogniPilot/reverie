/**
 * @fileoverview What the office remembers about each employee's Claude model.
 *
 * One small JSON file (`employee-models.json`, mode 0600): per employee, the recorded model choice
 * (who set it, when) and a fallback in force off a limited model. It is kept apart from company.json
 * on purpose: the employee record and its launch recipe are compared whole by plan approvals and
 * Docker continuation digests, and a model change (an automatic fallback above all) must never fence
 * one of those. Claude itself also keeps a `/model` choice as its default for new sessions, so a lost
 * or unreadable file costs the restore bookkeeping, never the model the employee runs on.
 *
 * DATA only: it authorizes nothing. Every change goes through EmployeeModelService.
 *
 * @module employee-model-store
 */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { SESSION_MODEL_ID_PATTERN } from './types/session.js';
import type { ModelFallbackRecord } from './employee-model-policy.js';

/** Effort levels Claude's in-session `/effort <level>` takes (ultracode rides --settings, never /effort). */
export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];
const time = z.number().int().nonnegative().safe();
const modelId = z.string().max(100).regex(SESSION_MODEL_ID_PATTERN);
const displayName = z.string().min(1).max(64);

const Preference = z
  .object({ model: modelId, effort: z.enum(MODEL_EFFORTS).optional(), setAt: time, by: z.string().min(1).max(120) })
  .strict();
const Fallback = z
  .object({
    from: displayName.optional(),
    family: z.string().min(1).max(20),
    to: modelId,
    restore: modelId.optional(),
    resetAt: time.nullable(),
    at: time,
  })
  .strict();
const Entry = z.object({ preferred: Preference.optional(), fallback: Fallback.optional() }).strict();
const File = z
  .object({
    version: z.literal(1),
    purpose: z.literal('employee-models-v1'),
    employees: z.record(z.string().min(1).max(100), Entry),
  })
  .strict();

export type EmployeeModelPreference = z.infer<typeof Preference>;
export type EmployeeModelEntry = { preferred?: EmployeeModelPreference; fallback?: ModelFallbackRecord };

const MAX_EMPLOYEES = 512;
const MAX_BYTES = 256 * 1024;

export class EmployeeModelStore {
  #entries = new Map<string, EmployeeModelEntry>();
  #writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | undefined) {
    this.#entries = this.load();
  }

  private load(): Map<string, EmployeeModelEntry> {
    if (!this.file) return new Map();
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return new Map();
      const parsed = File.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      return new Map(Object.entries(parsed.employees).slice(0, MAX_EMPLOYEES));
    } catch {
      return new Map();
    }
  }

  get(employeeId: string): EmployeeModelEntry {
    return structuredClone(this.#entries.get(employeeId) ?? {});
  }

  /** Replace one employee's entry (an empty entry removes it) and write the file. */
  set(employeeId: string, entry: EmployeeModelEntry): Promise<void> {
    const parsed = Entry.parse(entry);
    if (!parsed.preferred && !parsed.fallback) this.#entries.delete(employeeId);
    else this.#entries.set(employeeId, parsed);
    return this.save();
  }

  /** Serialized whole-file writes; a failed write is reported to the caller. */
  private save(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const body = JSON.stringify(
      File.parse({
        version: 1,
        purpose: 'employee-models-v1',
        employees: Object.fromEntries([...this.#entries].slice(0, MAX_EMPLOYEES)),
      })
    );
    const write = this.#writing.then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.promises.mkdir(dirname(file), { recursive: true });
      await fs.promises.writeFile(temporary, body, { mode: 0o600 });
      await fs.promises.rename(temporary, file);
    });
    this.#writing = write.catch(() => {});
    return write;
  }
}
