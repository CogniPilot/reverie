import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
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
    sourceStopRequested: z.boolean().optional(),
    sourceCleanupVerified: z.boolean().optional(),
    recoveryAction: z.literal('adopt-existing').optional(),
    recoveredAt: z.number().finite().nonnegative().optional(),
    error: z.string().max(4000).optional(),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.sourceCleanupVerified && (!record.sourceStopRequested || !record.newSession))
      context.addIssue({ code: 'custom', message: 'Source cleanup proof requires its stopped-source candidate binding' });
    if ((record.recoveryAction !== undefined || record.recoveredAt !== undefined) &&
      (!['completed', 'recovery-required'].includes(record.phase) || record.recoveryAction !== 'adopt-existing' || record.recoveredAt === undefined || !record.sourceCleanupVerified))
      context.addIssue({ code: 'custom', message: 'Recovery completion requires verified cleanup and its terminal receipt' });
  });
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

  private recoveryFile(id: string, kind: 'pending' | 'verified'): string {
    return `${this.file}.recovery-${createHash('sha256').update(id).digest('hex')}.${kind}.json`;
  }

  private async recoveryRead(id: string, kind: 'pending' | 'verified') {
    try {
      const file = this.recoveryFile(id, kind);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o777) !== 0o600 ||
          (process.getuid && info.uid !== process.getuid())) throw new Error('Invalid private recovery receipt');
        const buffer = Buffer.alloc(4097);
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096 || bytesRead !== info.size) throw new Error('Recovery receipt exceeds its read bound');
        const bytes = buffer.subarray(0, bytesRead), raw = bytes.toString('utf8');
        if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new Error('Invalid recovery receipt encoding');
        const after = await handle.stat(), named = await fs.lstat(file);
        if (Buffer.byteLength(raw) !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs || named.dev !== info.dev || named.ino !== info.ino)
          throw new Error('Recovery receipt changed during read');
        const schema = kind === 'pending'
          ? z.object({version: z.literal(1), id: z.literal(id)}).strict()
          : z.object({version: z.literal(1), id: z.literal(id), recordDigest: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
        const value = schema.parse(JSON.parse(raw));
        if (JSON.stringify(value) !== raw) throw new Error('Noncanonical or duplicate-key recovery receipt');
        return value;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private recordDigest(record: Readonly<PlanMoveRecord>): string {
    return createHash('sha256').update(JSON.stringify(RecordSchema.parse(record))).digest('hex');
  }

  async recoveryPending(record: Readonly<PlanMoveRecord>): Promise<void> {
    await this.chain;
    if (await this.recoveryRead(record.id, 'pending')) return;
    if (await this.recoveryRead(record.id, 'verified')) throw new Error('Orphan recovery acknowledgement');
    await writeCompanyStateFile(this.recoveryFile(record.id, 'pending'), JSON.stringify({version: 1, id: record.id}));
  }

  async recoveryConfirmed(record: Readonly<PlanMoveRecord>): Promise<void> {
    await this.chain;
    if (!await this.recoveryRead(record.id, 'pending') || record.phase !== 'completed' || record.recoveryAction !== 'adopt-existing')
      throw new Error('Missing pending native recovery transaction');
    const proof = {version: 1, id: record.id, recordDigest: this.recordDigest(record)};
    const existing = await this.recoveryRead(record.id, 'verified');
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(proof)) throw new Error('Conflicting recovery acknowledgement');
      return;
    }
    await writeCompanyStateFile(this.recoveryFile(record.id, 'verified'), JSON.stringify(proof));
  }


  async load(): Promise<PlanMoveRecord[]> {
    await this.chain;
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 1024 * 1024) throw new Error('Plan move journal exceeds its size bound');
      const records = JournalSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      for (const record of records) {
        const pending = await this.recoveryRead(record.id, 'pending');
        const verified = await this.recoveryRead(record.id, 'verified');
        if (verified && !pending) throw new Error('Orphan recovery acknowledgement');
        if (record.phase === 'completed' && record.recoveryAction === 'adopt-existing') {
          if (pending && verified && 'recordDigest' in verified && verified.recordDigest === this.recordDigest(record)) continue;
          if (verified) throw new Error('Recovery acknowledgement differs from terminal journal');
          record.phase = 'recovery-required';
          record.error = record.error ?? 'Owner recovery was interrupted before its verified acknowledgement';
        }
      }
      return records;
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
