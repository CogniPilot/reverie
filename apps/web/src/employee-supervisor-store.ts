/**
 * @fileoverview What the office supervisor remembers between office restarts.
 *
 * One small JSON file: per employee, the problem being worked on, since when, how often each repair step was tried
 * and what the last step did. It is DATA for pacing only. It never authorizes a step: every step is decided again
 * from a fresh observation, and a lost or unreadable file only makes the supervisor start its waits over.
 */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { SupervisorAction, SupervisorHistory } from './employee-supervisor-policy.js';

const ACTIONS = [
  'resend-continuation',
  'start-continuation',
  'continue-move',
  'reconnect-viewer',
  'replace-sign-in',
  'relaunch-provider',
  'abandon-move',
  'rebuild-laptop',
] as const satisfies readonly SupervisorAction[];
const time = z.number().int().nonnegative().safe();
const action = z.enum(ACTIONS);
const History = z
  .object({
    fingerprint: z.string().max(600),
    since: time,
    healthySince: time.optional(),
    transitSince: time.optional(),
    attempts: z.partialRecord(action, z.object({ count: z.number().int().min(0).max(1000), lastAt: time }).strict()),
    rebuilds: z.array(time).max(8),
    lastAction: z
      .object({
        action,
        at: time,
        outcome: z.enum(['issued', 'done', 'refused', 'failed', 'busy']),
        detail: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const File = z
  .object({
    version: z.literal(1),
    purpose: z.literal('employee-supervisor-v1'),
    employees: z.record(z.string().min(1).max(100), History),
  })
  .strict();
const MAX_EMPLOYEES = 512;
const MAX_BYTES = 1024 * 1024;

export class EmployeeSupervisorStore {
  #writing: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  /** Every remembered employee. An absent, oversized or malformed file reads as nothing remembered. */
  load(): Map<string, SupervisorHistory> {
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return new Map();
      const parsed = File.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      return new Map(Object.entries(parsed.employees).slice(0, MAX_EMPLOYEES));
    } catch {
      return new Map();
    }
  }

  /** Replace the file. Writes are serialized; a failed write is reported to the caller and never thrown later. */
  save(histories: ReadonlyMap<string, SupervisorHistory>): Promise<void> {
    const body = JSON.stringify(
      File.parse({
        version: 1,
        purpose: 'employee-supervisor-v1',
        employees: Object.fromEntries([...histories].slice(0, MAX_EMPLOYEES)),
      })
    );
    const write = this.#writing.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.promises.mkdir(dirname(this.file), { recursive: true });
      await fs.promises.writeFile(temporary, body, { mode: 0o600 });
      await fs.promises.rename(temporary, this.file);
    });
    this.#writing = write.catch(() => {});
    return write;
  }
}
