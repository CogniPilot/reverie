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
    purpose: z.literal('runtime-refresh').optional(),
    runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    resourceIntent: z.object({
      operationId: z.string().uuid().regex(/^[0-9a-f-]+$/),
      reservationId: z.string().uuid().regex(/^[0-9a-f-]+$/),
      profileVersion: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).refine(value =>
        /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n),
      profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
      previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().optional(),
    resourceOwnerScope: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    resourcePhase: z.enum(['reserved', 'preparing', 'prepared', 'verifying', 'verified']).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.purpose === 'runtime-refresh'
      ? record.fromAccount !== record.toAccount || !record.runtimeDigest
      : record.runtimeDigest !== undefined)
      context.addIssue({ code: 'custom', message: 'A refresh journal must bind its unchanged account and runtime' });
    if (record.resourceIntent ? record.purpose !== 'runtime-refresh' : record.resourcePhase !== undefined)
      context.addIssue({ code: 'custom', message: 'Resource state requires its same-account refresh intent' });
    if (record.resourceOwnerScope !== undefined && !record.resourceIntent)
      context.addIssue({code: 'custom', message: 'A private resource owner scope requires resource intent'});
    if (record.resourceIntent && !record.owner && !record.resourceOwnerScope)
      context.addIssue({ code: 'custom', message: 'Resource intent requires its explicit owner scope' });
    if (record.resourceIntent && record.phase === 'failed')
      context.addIssue({ code: 'custom', message: 'Resource failures retain recovery until their separate actor reconciles them' });
    if (record.resourcePhase !== undefined && !record.newSession)
      context.addIssue({ code: 'custom', message: 'Resource preparation requires the durable candidate SID' });
    if (record.resourceIntent && record.phase === 'completed' && record.resourcePhase !== 'verified')
      context.addIssue({ code: 'custom', message: 'Resource completion requires verified replacement evidence' });
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

const ResourceAttempt = z.object({operationId: z.string().uuid().regex(/^[0-9a-f-]+$/),
  employeeId: z.string().uuid().regex(/^[0-9a-f-]+$/), owner: z.string().min(1).max(200).nullable(),
  phase: z.enum(['preparing', 'dispatching', 'not-started'])}).strict();
type ResourceAttemptRecord = z.infer<typeof ResourceAttempt>;
const ResourceAttempts = z.array(ResourceAttempt).max(100).refine(rows =>
  new Set(rows.map(row => row.operationId)).size === rows.length);

export class PlanMoveStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  /** Private live actor inspection only. Unlike load(), this does not turn a
   * current completed record into restart recovery. It grants no execution or
   * native completion authority; the caller must retain its current binding.
   */
  async resourceRecord(id: string): Promise<Readonly<PlanMoveRecord>> {
    await this.chain;
    const handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({bigint: true});
      if (!before.isFile() || before.nlink !== 1n || before.size > 1024n * 1024n ||
        (before.mode & 0o777n) !== 0o600n || (process.getuid && before.uid !== BigInt(process.getuid())))
        throw new Error('Private resource move journal is unavailable');
      const raw = Buffer.alloc(Number(before.size) + 1); let offset = 0;
      while (offset < raw.length) {
        const {bytesRead} = await handle.read(raw, offset, raw.length - offset, null);
        if (!bytesRead) break; offset += bytesRead;
      }
      const after = await handle.stat({bigint: true}), named = await fs.lstat(this.file, {bigint: true});
      const stamp = (value: typeof before) => [value.dev, value.ino, value.mode, value.uid, value.nlink,
        value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
      if (offset !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(named))
        throw new Error('Private resource move journal changed');
      const bytes = raw.subarray(0, offset), text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      const decoded: unknown = JSON.parse(text);
      if (JSON.stringify(decoded) !== text) throw new Error('Noncanonical private move journal');
      const records = JournalSchema.parse(decoded), matches = records.filter(record => record.id === id);
      if (matches.length !== 1 || !matches[0].resourceIntent || !matches[0].resourceOwnerScope)
        throw new Error('Current private resource move is unavailable');
      return Object.freeze(structuredClone(matches[0]));
    } finally {await handle.close();}
  }

  /** Discovery only: these receipts never authorize native work or completion. */
  private async readResourceAttempts(): Promise<ResourceAttemptRecord[]> {
    const file = this.file + '.resource-attempts.json';
    let handle;
    try {handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    try {
      const before = await handle.stat({bigint: true});
      if (!before.isFile() || before.nlink !== 1n || before.size > 65536n ||
          (before.mode & 0o777n) !== 0o600n || (process.getuid && before.uid !== BigInt(process.getuid())))
        throw new Error('Private resource attempts unavailable');
      const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!result.bytesRead) break; offset += result.bytesRead;
      }
      const after = await handle.stat({bigint: true}), named = await fs.lstat(file, {bigint: true});
      const stamp = (info: typeof before) => [info.dev, info.ino, info.mode, info.uid, info.nlink,
        info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
      if (offset !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(named))
        throw new Error('Private resource attempts changed');
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, offset));
      const value = ResourceAttempts.parse(JSON.parse(text));
      if (JSON.stringify(value) !== text) throw new Error('Noncanonical resource attempts');
      return value;
    } finally {await handle.close();}
  }

  async resourceAttempts(owner: string | undefined): Promise<ResourceAttemptRecord[]> {
    await this.chain;
    return (await this.readResourceAttempts()).filter(row => row.owner === (owner ?? null));
  }

  resourceAttemptStart(operationId: string, employeeId: string, owner: string | undefined,
    completed: string[]): Promise<void> {
    const next = ResourceAttempt.parse({operationId, employeeId, owner: owner ?? null, phase: 'preparing'});
    const write = this.chain.then(async () => {
      // Only definitive no-dispatch or already verified completion may age out.
      // Keep no-dispatch history until the 100-record bound, including across
      // unrelated new attempts whose replies may also be lost.
      // Unknown receipts are never discarded to make room for another request.
      const rows = (await this.readResourceAttempts()).filter(row =>
        !completed.includes(row.operationId));
      if (rows.some(row => row.operationId === operationId ||
          row.employeeId === employeeId && row.owner === next.owner && row.phase !== 'not-started'))
        throw new Error('A resource attempt still requires inspection');
      if (rows.length >= 100) {
        const settled = rows.findIndex(row => row.phase === 'not-started');
        if (settled < 0) throw new Error('Resource attempt history requires inspection');
        rows.splice(settled, 1);
      }
      rows.push(next);
      await writeCompanyStateFile(this.file + '.resource-attempts.json', JSON.stringify(ResourceAttempts.parse(rows)));
    });
    this.chain = write.catch(() => {}); return write;
  }

  resourceAttemptPhase(operationId: string, owner: string | undefined,
    phase: 'dispatching' | 'not-started'): Promise<void> {
    const write = this.chain.then(async () => {
      const rows = await this.readResourceAttempts();
      const row = rows.find(item => item.operationId === operationId && item.owner === (owner ?? null));
      if (!row || row.phase !== 'preparing') throw new Error('Resource dispatch boundary changed');
      row.phase = phase;
      await writeCompanyStateFile(this.file + '.resource-attempts.json', JSON.stringify(ResourceAttempts.parse(rows)));
    });
    this.chain = write.catch(() => {}); return write;
  }

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
        if (record.resourceIntent && record.phase === 'completed') {
          // The journal is historical evidence, not a fresh host observation.
          // Also covers a lost recovery write after a completed ACK/drift race.
          record.phase = 'recovery-required';
          record.error ??= 'Resource transactions require fresh native reconciliation after restart';
        }
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
