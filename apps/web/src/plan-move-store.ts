import fs from 'node:fs/promises';
import { z } from 'zod';
import { writeCompanyStateFile } from './company-store.js';
import type { PlanMoveRecord } from './plan-move.js';

const RecordSchema = z
  .object({
    id: z.string().min(1).max(100),
    owner: z.string().max(200).optional(),
    employeeId: z.string().min(1).max(100),
    name: z.string().max(100),
    oldSession: z.string().min(1).max(100),
    newSession: z.string().min(1).max(100).optional(),
    fromAccount: z.string().min(1).max(100),
    toAccount: z.string().min(1).max(100),
    phase: z.enum([
      'waiting',
      'creating',
      'starting',
      'checking',
      'stopping',
      'completed',
      'failed',
      'recovery-required',
    ]),
    at: z.number().finite().nonnegative(),
    error: z.string().max(4000).optional(),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const JournalSchema = z
  .array(RecordSchema)
  .max(100)
  .superRefine((records, context) => {
    if (new Set(records.map((record) => record.id)).size !== records.length)
      context.addIssue({ code: 'custom', message: 'Duplicate move identifiers' });
  });

export class PlanMoveStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  async load(): Promise<PlanMoveRecord[]> {
    await this.chain;
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 1024 * 1024) throw new Error('Plan move journal exceeds its size bound');
      return JournalSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  save(records: PlanMoveRecord[]): Promise<void> {
    const data = JSON.stringify(JournalSchema.parse(records));
    const write = this.chain.then(() => writeCompanyStateFile(this.file, data));
    this.chain = write.catch(() => {});
    return write;
  }
}
