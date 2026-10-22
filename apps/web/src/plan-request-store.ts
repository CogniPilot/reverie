import fs from 'node:fs/promises';
import { z } from 'zod';
import { writeCompanyStateFile } from './company-store.js';
import { PlanRequestSchema, type PlanRequestRecord } from './plan-request.js';
const Records = z
  .array(PlanRequestSchema)
  .max(100)
  .superRefine((records, context) => {
    if (new Set(records.map((record) => record.id)).size !== records.length)
      context.addIssue({ code: 'custom', message: 'Duplicate request identifiers' });
  });

export class PlanRequestStore {
  private chain: Promise<void> = Promise.resolve();
  constructor(readonly file: string) {}
  async load(): Promise<PlanRequestRecord[]> {
    await this.chain;
    try {
      const info = await fs.stat(this.file);
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error('Plan request journal is not a bounded regular file');
      return Records.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async save(records: PlanRequestRecord[]): Promise<void> {
    const text = JSON.stringify(Records.parse(records));
    const pending = this.chain.then(() => writeCompanyStateFile(this.file, text));
    this.chain = pending.catch(() => {});
    return pending;
  }
}
