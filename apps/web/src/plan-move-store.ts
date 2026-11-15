import { dockerPlanMaximumRecord } from './docker-plan-move-capacity.js';
import type { DockerEmployeePlanReplacementWorkRecord } from './docker-employee-continuation-data.js';
import { DockerPlanMoveJournalState, assertDockerPlanMoveTransition } from './docker-plan-move-data.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { withCanonicalStateLock } from './canonical-state-lock.js';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, lstatSync, readSync, closeSync } from 'node:fs';
import { z } from 'zod';
import { writeCompanyStateFile } from './company-store.js';
import type { PlanMoveRecord } from './plan-move.js';

const RecordSchema = z
  .object({
    dockerReplacement: DockerPlanMoveJournalState.optional(),
    dockerSettlementBudget: z
      .object({
        version: z.literal(1),
        purpose: z.literal('docker-plan-settlement-budget-v1'),
        maxRecordBytes: z
          .number()
          .int()
          .positive()
          .safe()
          .max(8 * 1024 * 1024),
      })
      .strict()
      .optional(),
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
    runtimeDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    resourceIntent: z
      .object({
        operationId: z
          .string()
          .uuid()
          .regex(/^[0-9a-f-]+$/),
        reservationId: z
          .string()
          .uuid()
          .regex(/^[0-9a-f-]+$/),
        profileVersion: z
          .string()
          .regex(/^(?:0|[1-9][0-9]{0,19})$/)
          .refine((value) => /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n),
        profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
        previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    resourceOwnerScope: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    resourcePhase: z.enum(['reserved', 'preparing', 'prepared', 'verifying', 'verified']).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const docker = record.dockerReplacement;
    if (record.dockerSettlementBudget && !docker)
      context.addIssue({ code: 'custom', message: 'Native settlement reserve requires its original Docker journal' });
    if (
      docker &&
      (!Number.isSafeInteger(record.at) ||
        (record.recoveredAt !== undefined && !Number.isSafeInteger(record.recoveredAt)))
    )
      context.addIssue({ code: 'custom', message: 'Native timestamps require safe integers' });
    if (
      docker &&
      (record.resourceIntent ||
        record.purpose ||
        docker.seed.moveId !== record.id ||
        docker.seed.source.record.employeeId !== record.employeeId ||
        docker.seed.source.record.owner !== record.owner ||
        docker.seed.source.binding.sessionId !== record.oldSession ||
        docker.seed.target.accountId !== record.toAccount ||
        docker.seed.requestDigest !== record.requestDigest ||
        record.newSession !== docker.seed.target.sessionId)
    )
      context.addIssue({ code: 'custom', message: 'Docker plan journal must bind its original request and target' });
    if (docker && record.phase === 'failed' && (docker.sourceStop || docker.work || docker.paidDispatch))
      context.addIssue({ code: 'custom', message: 'Issued Docker plan work retains recovery' });
    if (
      docker &&
      record.phase === 'completed' &&
      (docker.sourceStop?.phase !== 'closed' ||
        !docker.paidDispatch ||
        docker.companyPublication?.phase !== 'published' ||
        docker.handoff?.phase !== 'submitted' ||
        docker.work?.phase !== 'ready')
    )
      context.addIssue({
        code: 'custom',
        message: 'Docker plan completion requires its native target and published handoff',
      });

    if (
      record.purpose === 'runtime-refresh'
        ? record.fromAccount !== record.toAccount || !record.runtimeDigest
        : record.runtimeDigest !== undefined
    )
      context.addIssue({ code: 'custom', message: 'A refresh journal must bind its unchanged account and runtime' });
    if (record.resourceIntent ? record.purpose !== 'runtime-refresh' : record.resourcePhase !== undefined)
      context.addIssue({ code: 'custom', message: 'Resource state requires its same-account refresh intent' });
    if (record.resourceOwnerScope !== undefined && !record.resourceIntent)
      context.addIssue({ code: 'custom', message: 'A private resource owner scope requires resource intent' });
    if (record.resourceIntent && !record.owner && !record.resourceOwnerScope)
      context.addIssue({ code: 'custom', message: 'Resource intent requires its explicit owner scope' });
    if (record.resourceIntent && record.phase === 'failed')
      context.addIssue({
        code: 'custom',
        message: 'Resource failures retain recovery until their separate actor reconciles them',
      });
    if (record.resourcePhase !== undefined && !record.newSession)
      context.addIssue({ code: 'custom', message: 'Resource preparation requires the durable candidate SID' });
    if (record.resourceIntent && record.phase === 'completed' && record.resourcePhase !== 'verified')
      context.addIssue({ code: 'custom', message: 'Resource completion requires verified replacement evidence' });
    if (record.sourceCleanupVerified && (!record.sourceStopRequested || !record.newSession))
      context.addIssue({
        code: 'custom',
        message: 'Source cleanup proof requires its stopped-source candidate binding',
      });
    if (
      (record.recoveryAction !== undefined || record.recoveredAt !== undefined) &&
      (!['completed', 'recovery-required'].includes(record.phase) ||
        record.recoveryAction !== 'adopt-existing' ||
        record.recoveredAt === undefined ||
        !record.sourceCleanupVerified)
    )
      context.addIssue({
        code: 'custom',
        message: 'Recovery completion requires verified cleanup and its terminal receipt',
      });
  });
const JournalSchema = z
  .array(RecordSchema)
  .max(100)
  .superRefine((records, context) => {
    if (new Set(records.map((record) => record.id)).size !== records.length)
      context.addIssue({ code: 'custom', message: 'Duplicate move identifiers' });
  });

const ResourceAttempt = z
  .object({
    operationId: z
      .string()
      .uuid()
      .regex(/^[0-9a-f-]+$/),
    employeeId: z
      .string()
      .uuid()
      .regex(/^[0-9a-f-]+$/),
    owner: z.string().min(1).max(200).nullable(),
    phase: z.enum(['preparing', 'dispatching', 'not-started']),
  })
  .strict();
type ResourceAttemptRecord = z.infer<typeof ResourceAttempt>;
const ResourceAttempts = z
  .array(ResourceAttempt)
  .max(100)
  .refine((rows) => new Set(rows.map((row) => row.operationId)).size === rows.length);
/** A not-started receipt that aged out of the attempt history. It is written before the row is removed, so the positive
 * no-dispatch outcome survives the bound; it never authorizes native work. */
const SETTLED_LIMIT = 4096;
const SettledAttempt = ResourceAttempt.extend({ phase: z.literal('not-started') }).strict();
const SettledAttempts = z
  .array(SettledAttempt)
  .max(SETTLED_LIMIT)
  .refine((rows) => new Set(rows.map((row) => row.operationId)).size === rows.length);

export interface DockerPlanMoveNotIssuedReceipt {
  readonly version: 1;
  readonly purpose: 'docker-plan-move-not-issued-v1';
  readonly code: 'CAPACITY';
  readonly action: 'begin';
  readonly publication: 'not-issued';
  readonly id: string;
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly toAccount: string;
  readonly requestDigest: string;
}
const notIssued = new WeakMap<object, DockerPlanMoveNotIssuedReceipt>();
class SettlementCapacityLimit extends Error {
  constructor() {
    super('Plan move settlement capacity is unavailable');
  }
}
class NativeMoveNotIssued extends Error {
  constructor(record: PlanMoveRecord) {
    super('Plan move settlement capacity is unavailable; no move was published');
    const receipt: DockerPlanMoveNotIssuedReceipt = {
      version: 1,
      purpose: 'docker-plan-move-not-issued-v1',
      code: 'CAPACITY',
      action: 'begin',
      publication: 'not-issued',
      id: record.id,
      employeeId: record.employeeId,
      sessionId: record.oldSession,
      sessionGeneration: record.dockerReplacement!.seed.source.binding.sessionGeneration,
      toAccount: record.toAccount,
      requestDigest: record.requestDigest!,
    };
    notIssued.set(this, Object.freeze(receipt));
    Object.freeze(this);
  }
}
/** Origin-only: never inspect arbitrary status/message/cause/JSON fields. */
export function dockerPlanMoveNotIssuedOf(error: unknown): DockerPlanMoveNotIssuedReceipt | undefined {
  return error && typeof error === 'object' && notIssued.has(error)
    ? structuredClone(notIssued.get(error)!)
    : undefined;
}
export class PlanMoveStore {
  private chain: Promise<void> = Promise.resolve();
  private readonly settlementBounds = new Map<string, number>();

  constructor(readonly file: string) {}

  /** Private live actor inspection only. Unlike load(), this does not turn a
   * current completed record into restart recovery. It grants no execution or
   * native completion authority; the caller must retain its current binding.
   */
  async resourceRecord(id: string): Promise<Readonly<PlanMoveRecord>> {
    await this.chain;
    const handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > 8n * 1024n * 1024n ||
        (before.mode & 0o777n) !== 0o600n ||
        (process.getuid && before.uid !== BigInt(process.getuid()))
      )
        throw new Error('Private resource move journal is unavailable');
      const raw = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < raw.length) {
        const { bytesRead } = await handle.read(raw, offset, raw.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true }),
        named = await fs.lstat(this.file, { bigint: true });
      const stamp = (value: typeof before) =>
        [value.dev, value.ino, value.mode, value.uid, value.nlink, value.size, value.mtimeNs, value.ctimeNs]
          .map(String)
          .join(':');
      if (offset !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(named))
        throw new Error('Private resource move journal changed');
      const bytes = raw.subarray(0, offset),
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const decoded: unknown = JSON.parse(text);
      if (JSON.stringify(decoded) !== text) throw new Error('Noncanonical private move journal');
      const records = JournalSchema.parse(decoded),
        matches = records.filter((record) => record.id === id);
      if (matches.length !== 1 || !matches[0].resourceIntent || !matches[0].resourceOwnerScope)
        throw new Error('Current private resource move is unavailable');
      return Object.freeze(structuredClone(matches[0]));
    } finally {
      await handle.close();
    }
  }

  /** Discovery only: these receipts never authorize native work or completion. */
  private readResourceAttempts(): Promise<ResourceAttemptRecord[]> {
    return this.readPrivateList(this.file + '.resource-attempts.json', 65536, ResourceAttempts);
  }

  private readSettledAttempts(): Promise<z.infer<typeof SettledAttempts>> {
    return this.readPrivateList(this.file + '.resource-settled.json', 1024 * 1024, SettledAttempts);
  }

  private async readPrivateList<T>(file: string, limit: number, schema: z.ZodType<T[]>): Promise<T[]> {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(limit) ||
        (before.mode & 0o777n) !== 0o600n ||
        (process.getuid && before.uid !== BigInt(process.getuid()))
      )
        throw new Error('Private resource attempts unavailable');
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true }),
        named = await fs.lstat(file, { bigint: true });
      const stamp = (info: typeof before) =>
        [info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs]
          .map(String)
          .join(':');
      if (offset !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(named))
        throw new Error('Private resource attempts changed');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
      const value = schema.parse(JSON.parse(text));
      if (JSON.stringify(value) !== text) throw new Error('Noncanonical resource attempts');
      return value;
    } finally {
      await handle.close();
    }
  }

  async resourceAttempts(owner: string | undefined): Promise<ResourceAttemptRecord[]> {
    await this.chain;
    return (await this.readResourceAttempts()).filter((row) => row.owner === (owner ?? null));
  }

  /** This owner's not-started receipt for an operation that aged out of the attempt history, if one was kept. */
  async settledResourceAttempt(
    operationId: string,
    owner: string | undefined
  ): Promise<ResourceAttemptRecord | undefined> {
    await this.chain;
    return (await this.readSettledAttempts()).find(
      (row) => row.operationId === operationId && row.owner === (owner ?? null)
    );
  }

  resourceAttemptStart(
    operationId: string,
    employeeId: string,
    owner: string | undefined,
    completed: string[]
  ): Promise<void> {
    const next = ResourceAttempt.parse({ operationId, employeeId, owner: owner ?? null, phase: 'preparing' });
    const write = this.chain.then(async () => {
      // Only definitive no-dispatch or already verified completion may age out.
      // Keep no-dispatch history until the 100-record bound, including across
      // unrelated new attempts whose replies may also be lost.
      // Unknown receipts are never discarded to make room for another request.
      const rows = (await this.readResourceAttempts()).filter((row) => !completed.includes(row.operationId));
      if (
        rows.some(
          (row) =>
            row.operationId === operationId ||
            (row.employeeId === employeeId && row.owner === next.owner && row.phase !== 'not-started')
        )
      )
        throw new Error('A resource attempt still requires inspection');
      if ((await this.readSettledAttempts()).some((row) => row.operationId === operationId))
        throw new Error('A resource attempt still requires inspection');
      if (rows.length >= 100) {
        const index = rows.findIndex((row) => row.phase === 'not-started');
        if (index < 0) throw new Error('Resource attempt history requires inspection');
        // Keep the evicted receipt's positive outcome first: a crash after this write leaves both copies, never neither.
        // A full settled history refuses the new attempt rather than dropping a receipt a browser may still track.
        const settled = await this.readSettledAttempts();
        if (!settled.some((row) => row.operationId === rows[index].operationId)) {
          if (settled.length >= SETTLED_LIMIT) throw new Error('Resource attempt history requires inspection');
          settled.push(SettledAttempt.parse(rows[index]));
          await writeCompanyStateFile(
            this.file + '.resource-settled.json',
            JSON.stringify(SettledAttempts.parse(settled))
          );
        }
        rows.splice(index, 1);
      }
      rows.push(next);
      await writeCompanyStateFile(this.file + '.resource-attempts.json', JSON.stringify(ResourceAttempts.parse(rows)));
    });
    this.chain = write.catch(() => {});
    return write;
  }

  resourceAttemptPhase(
    operationId: string,
    owner: string | undefined,
    phase: 'dispatching' | 'not-started'
  ): Promise<void> {
    const write = this.chain.then(async () => {
      const rows = await this.readResourceAttempts();
      const row = rows.find((item) => item.operationId === operationId && item.owner === (owner ?? null));
      if (!row || row.phase !== 'preparing') throw new Error('Resource dispatch boundary changed');
      row.phase = phase;
      await writeCompanyStateFile(this.file + '.resource-attempts.json', JSON.stringify(ResourceAttempts.parse(rows)));
    });
    this.chain = write.catch(() => {});
    return write;
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
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 4096 ||
          (info.mode & 0o777) !== 0o600 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new Error('Invalid private recovery receipt');
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096 || bytesRead !== info.size) throw new Error('Recovery receipt exceeds its read bound');
        const bytes = buffer.subarray(0, bytesRead),
          raw = bytes.toString('utf8');
        if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new Error('Invalid recovery receipt encoding');
        const after = await handle.stat(),
          named = await fs.lstat(file);
        if (
          Buffer.byteLength(raw) !== info.size ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs ||
          named.dev !== info.dev ||
          named.ino !== info.ino
        )
          throw new Error('Recovery receipt changed during read');
        const schema =
          kind === 'pending'
            ? z.object({ version: z.literal(1), id: z.literal(id) }).strict()
            : z
                .object({ version: z.literal(1), id: z.literal(id), recordDigest: z.string().regex(/^[a-f0-9]{64}$/) })
                .strict();
        const value = schema.parse(JSON.parse(raw));
        if (JSON.stringify(value) !== raw) throw new Error('Noncanonical or duplicate-key recovery receipt');
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private recordDigest(record: Readonly<PlanMoveRecord>): string {
    return createHash('sha256')
      .update(JSON.stringify(RecordSchema.parse(record)))
      .digest('hex');
  }

  async recoveryPending(record: Readonly<PlanMoveRecord>): Promise<void> {
    await this.chain;
    if (await this.recoveryRead(record.id, 'pending')) return;
    if (await this.recoveryRead(record.id, 'verified')) throw new Error('Orphan recovery acknowledgement');
    await writeCompanyStateFile(this.recoveryFile(record.id, 'pending'), JSON.stringify({ version: 1, id: record.id }));
  }

  async recoveryConfirmed(record: Readonly<PlanMoveRecord>): Promise<void> {
    await this.chain;
    if (
      !(await this.recoveryRead(record.id, 'pending')) ||
      record.phase !== 'completed' ||
      record.recoveryAction !== 'adopt-existing'
    )
      throw new Error('Missing pending native recovery transaction');
    const proof = { version: 1, id: record.id, recordDigest: this.recordDigest(record) };
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
      if (stat.size > 8 * 1024 * 1024) throw new Error('Plan move journal exceeds its size bound');
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
          if (pending && verified && 'recordDigest' in verified && verified.recordDigest === this.recordDigest(record))
            continue;
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

  /** Private read for the SAME native journal owner. No physical credit. */
  async dockerReserve(input: Readonly<PlanMoveRecord>, current: () => void): Promise<Readonly<PlanMoveRecord>> {
    const record = structuredClone(input),
      state = record.dockerReplacement;
    if (
      !state ||
      record.phase !== 'waiting' ||
      state.sourceStop ||
      state.sourceReader ||
      state.work ||
      state.paidDispatch ||
      state.companyPublication ||
      state.handoff
    )
      throw Error('A fresh Docker reservation cannot contain effects');
    this.nativeSettlement(record);
    RecordSchema.parse(record);
    let result: Readonly<PlanMoveRecord> | undefined, capacity: unknown;
    const write = this.chain.then(() =>
      withCanonicalStateLock(
        this.file,
        async () => {
          current();
          const disk = await this.readPrivateList(this.file, 8 * 1024 * 1024, JournalSchema);
          current();
          if (
            disk.some(
              (row) =>
                row.id === record.id ||
                (row.employeeId === record.employeeId && !['completed', 'failed'].includes(row.phase))
            )
          )
            throw Error('The employee already has an original plan reservation');
          if (disk.length >= 100) {
            const error = new SettlementCapacityLimit();
            capacity = error;
            throw error;
          }
          let data: string;
          try {
            data = this.encode([...disk, record]);
          } catch (error) {
            if (error instanceof SettlementCapacityLimit) capacity = error;
            throw error;
          }
          current();
          await writeCompanyStateFile(this.file, data);
          current();
          result = Object.freeze(structuredClone(record));
        },
        (handle) => this.inspectLock(handle)
      )
    );
    const outcome = write.catch((error) => {
      if (capacity !== undefined && capacity === error) throw new NativeMoveNotIssued(record);
      throw error;
    });
    this.chain = outcome.catch(() => {});
    await outcome;
    return result!;
  }
  async dockerRecord(id: string): Promise<Readonly<PlanMoveRecord>> {
    await this.chain;
    return this.requireDockerRecord(await this.readPrivateList(this.file, 8 * 1024 * 1024, JournalSchema), id);
  }

  /** Fixed Runtime composition only: canonical staged destinations supplement
   * bound workers during their handoff. Every physical member remains subject to
   * the native controller's independent CID/label/PID/cgroup checks. */
  async stagedDockerResourceInventory(): Promise<readonly DockerEmployeePlanReplacementWorkRecord[]> {
    await this.chain;
    const records = await this.readPrivateList(this.file, 8 * 1024 * 1024, JournalSchema);
    const work = records
      .filter(
        (record) =>
          !['completed', 'failed'].includes(record.phase) &&
          record.dockerReplacement?.sourceStop?.phase === 'closed' &&
          record.dockerReplacement.work?.destination
      )
      .map((record) => record.dockerReplacement!.work!);
    if (work.length > 64) throw Error('Staged Docker plan member inventory exceeds its bound');
    return structuredClone(work);
  }

  private requireDockerRecord(records: PlanMoveRecord[], id: string): Readonly<PlanMoveRecord> {
    const record = records.find((item) => item.id === id);
    if (!record?.dockerReplacement) throw Error('Original Docker plan move is unavailable');
    return Object.freeze(structuredClone(record));
  }

  /** Called immediately before every native effect/publication. Old epochs and
   * late callbacks lose authority even if another process performed takeover. */
  dockerCurrent(id: string, epoch: string, seedDigest: string): void {
    this.dockerCurrency(id, epoch, seedDigest, false);
  }
  dockerReadCurrent(id: string, epoch: string, seedDigest: string): void {
    this.dockerCurrency(id, epoch, seedDigest, true);
  }
  private dockerCurrency(id: string, epoch: string, seedDigest: string, readonlyTerminal: boolean): void {
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > 8n * 1024n * 1024n ||
        (before.mode & 0o777n) !== 0o600n ||
        (process.getuid && before.uid !== BigInt(process.getuid()))
      )
        throw Error('Private Docker plan move journal is unavailable');
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (!count) break;
        offset += count;
      }
      const stamp = (value: typeof before) =>
        [value.dev, value.ino, value.uid, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs]
          .map(String)
          .join(':');
      if (
        offset !== Number(before.size) ||
        stamp(before) !== stamp(fstatSync(fd, { bigint: true })) ||
        stamp(before) !== stamp(lstatSync(this.file, { bigint: true }))
      )
        throw Error('Private Docker plan move journal changed');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
      const records = JournalSchema.parse(JSON.parse(text));
      if (JSON.stringify(records) !== text) throw Error('Noncanonical Docker plan move journal');
      const record = this.requireDockerRecord(records, id),
        state = record.dockerReplacement!;
      if (['completed', 'failed'].includes(record.phase) && !(readonlyTerminal && record.phase === 'completed'))
        throw Error('Terminal native plan history cannot dispatch');
      const checked = structuredClone(record);
      this.nativeSettlement(checked);
      if (
        !record.dockerSettlementBudget ||
        dockerContinuationDigest(record.dockerSettlementBudget) !==
          dockerContinuationDigest(checked.dockerSettlementBudget)
      )
        throw Error('Native settlement reserve must be published before dispatch');
      if (state.epoch !== epoch || dockerContinuationDigest(state.seed) !== seedDigest)
        throw Error('Original Docker plan move actor is no longer current');
    } finally {
      closeSync(fd);
    }
  }

  private async dockerTransaction(
    id: string,
    before: Readonly<DockerPlanMoveJournalState>,
    current: () => void,
    change: (record: PlanMoveRecord) => void
  ): Promise<Readonly<PlanMoveRecord>> {
    let result: Readonly<PlanMoveRecord> | undefined;
    const write = this.chain.then(() =>
      withCanonicalStateLock(
        this.file,
        async () => {
          current();
          const records = await this.readPrivateList(this.file, 8 * 1024 * 1024, JournalSchema);
          current();
          const record = records.find((item) => item.id === id);
          if (record?.dockerReplacement && ['completed', 'failed'].includes(record.phase))
            throw Error('Terminal native plan history is immutable');
          if (
            !record?.dockerReplacement ||
            dockerContinuationDigest(record.dockerReplacement) !== dockerContinuationDigest(before)
          )
            throw Error('Original Docker plan move cursor changed');
          change(record);
          const data = this.encode(records);
          await writeCompanyStateFile(this.file, data, current);
          current(); // authority only: the old cursor deliberately changed
          const actual = await this.readPrivateList(this.file, 8 * 1024 * 1024, JournalSchema);
          if (JSON.stringify(actual) !== data) throw Error('Docker plan move publication is unconfirmed');
          current();
          result = this.requireDockerRecord(actual, id);
        },
        (handle) => this.inspectLock(handle)
      )
    );
    this.chain = write.catch(() => {});
    await write;
    return result!;
  }

  dockerPhase(
    id: string,
    before: Readonly<DockerPlanMoveJournalState>,
    status: { phase: PlanMoveRecord['phase']; error?: string },
    current: () => void
  ): Promise<Readonly<PlanMoveRecord>> {
    const captured = DockerPlanMoveJournalState.parse(before);
    const checked = z
      .object({
        phase: z.enum([
          'waiting',
          'creating',
          'stopping',
          'starting',
          'checking',
          'completed',
          'failed',
          'recovery-required',
        ]),
        error: z.string().max(4000).optional(),
      })
      .strict()
      .parse(status);
    return this.dockerTransaction(id, captured, current, (record) => {
      record.phase = checked.phase;
      if (checked.error === undefined) delete record.error;
      else record.error = checked.error;
    });
  }

  dockerPublish(
    id: string,
    before: Readonly<DockerPlanMoveJournalState>,
    next: Readonly<DockerPlanMoveJournalState>,
    current: () => void
  ): Promise<Readonly<PlanMoveRecord>> {
    const original = DockerPlanMoveJournalState.parse(before);
    const checked = DockerPlanMoveJournalState.parse(next);
    assertDockerPlanMoveTransition(original, checked);
    return this.dockerTransaction(id, original, current, (record) => {
      record.dockerReplacement = checked;
      if (checked.sourceStop) record.sourceStopRequested = true;
      if (checked.sourceStop?.phase === 'closed') record.sourceCleanupVerified = true;
    });
  }

  /** A fresh native proof must settle EVERY prior effect before a new epoch can
   * own pre-paid work. Neither DATA nor this CAS permits replaying an old START. */
  dockerClaim(
    id: string,
    before: Readonly<DockerPlanMoveJournalState>,
    epoch: string,
    requireNative: () => void,
    current: () => void
  ): Promise<Readonly<PlanMoveRecord>> {
    const original = DockerPlanMoveJournalState.parse(before);
    if (original.paidDispatch || original.companyPublication || epoch === original.epoch)
      return Promise.reject(Error('Issued Docker provider dispatch cannot be resumed'));
    const next = DockerPlanMoveJournalState.parse({ ...original, epoch });
    return this.dockerTransaction(id, original, current, (record) => {
      requireNative();
      record.dockerReplacement = next;
    });
  }

  private async inspectLock(handle: import('node:fs/promises').FileHandle): Promise<void> {
    const value = await handle.stat({ bigint: true });
    const named = await fs.lstat(this.file + '.lock', { bigint: true });
    if (
      !value.isFile() ||
      value.nlink !== 1n ||
      (value.mode & 0o777n) !== 0o600n ||
      (process.getuid && value.uid !== BigInt(process.getuid())) ||
      value.dev !== named.dev ||
      value.ino !== named.ino
    )
      throw Error('Private Docker plan move lock is unavailable');
  }

  private nativeSettlement(record: PlanMoveRecord): void {
    const state = record.dockerReplacement;
    if (!state) {
      if (record.dockerSettlementBudget) throw Error('Native capacity requires its Docker journal');
      return;
    }
    if (
      !Number.isSafeInteger(record.at) ||
      (record.recoveredAt !== undefined && !Number.isSafeInteger(record.recoveredAt))
    )
      throw Error('Native plan timestamps require safe integers');
    const key = dockerContinuationDigest(state.seed);
    let maximum = this.settlementBounds.get(key);
    if (maximum === undefined) {
      const budget = { version: 1 as const, purpose: 'docker-plan-settlement-budget-v1' as const, maxRecordBytes: 1 };
      const witness = dockerPlanMaximumRecord({ ...record, dockerSettlementBudget: budget });
      for (let pass = 0; pass < 8; pass++) {
        const value = Buffer.byteLength(JSON.stringify(RecordSchema.parse(witness)));
        if (value === budget.maxRecordBytes) break;
        budget.maxRecordBytes = value;
      }
      maximum = Buffer.byteLength(JSON.stringify(RecordSchema.parse(witness)));
      if (maximum !== budget.maxRecordBytes) throw Error('Native capacity bound did not converge');
      if (this.settlementBounds.size >= 100) this.settlementBounds.delete(this.settlementBounds.keys().next().value!);
      this.settlementBounds.set(key, maximum);
    }
    record.dockerSettlementBudget = {
      version: 1,
      purpose: 'docker-plan-settlement-budget-v1',
      maxRecordBytes: maximum,
    };
  }

  private encode(records: PlanMoveRecord[]): string {
    for (const record of records) this.nativeSettlement(record);
    const checked = JournalSchema.parse(records),
      data = JSON.stringify(checked);
    const reserved =
      2 +
      checked.reduce(
        (total, record, index) =>
          total +
          (index ? 1 : 0) +
          (record.dockerReplacement && !['completed', 'failed'].includes(record.phase)
            ? record.dockerSettlementBudget!.maxRecordBytes
            : Buffer.byteLength(JSON.stringify(record))),
        0
      );
    if (Buffer.byteLength(data) > 8 * 1024 * 1024 || reserved > 8 * 1024 * 1024) throw new SettlementCapacityLimit();
    return data;
  }

  save(records: PlanMoveRecord[]): Promise<void> {
    const supplied = structuredClone(records);
    for (const record of supplied) this.nativeSettlement(record);
    JournalSchema.parse(supplied); // synchronous DATA rejection, not a capacity-outcome claim
    let candidate: { error: unknown; record: PlanMoveRecord } | undefined;
    const write = this.chain.then(() =>
      withCanonicalStateLock(
        this.file,
        async () => {
          const disk = await this.readPrivateList(this.file, 8 * 1024 * 1024, JournalSchema);
          for (const original of disk) {
            if (!original.dockerReplacement) continue;
            const next = supplied.find((item) => item.id === original.id);
            if (
              !next?.dockerReplacement ||
              dockerContinuationDigest(original.dockerReplacement) !== dockerContinuationDigest(next.dockerReplacement)
            )
              throw Error('Native Docker plan cursor requires its original CAS writer');
            if (
              ['completed', 'failed'].includes(original.phase) &&
              dockerContinuationDigest(original) !== dockerContinuationDigest(next)
            )
              throw Error('Terminal native plan history is immutable');
          }
          for (const record of supplied) {
            if (!record.dockerReplacement || disk.some((item) => item.id === record.id)) continue;
            const state = record.dockerReplacement;
            if (state.sourceStop || state.work || state.paidDispatch || state.companyPublication)
              throw Error('Docker plan native effects require a previously reserved journal');
          }
          let data: string;
          try {
            data = this.encode(supplied);
          } catch (error) {
            const fresh = supplied.filter(
              (record) => record.dockerReplacement && !disk.some((old) => old.id === record.id)
            );
            if (error instanceof SettlementCapacityLimit && fresh.length === 1) {
              const state = fresh[0]!.dockerReplacement!;
              if (!state.sourceStop && !state.work && !state.paidDispatch && !state.companyPublication)
                candidate = { error, record: fresh[0]! };
            }
            throw error;
          }
          await writeCompanyStateFile(this.file, data);
        },
        (handle) => this.inspectLock(handle)
      )
    );
    const outcome = write.catch((error) => {
      // This catch is AFTER withCanonicalStateLock's consuming close. Any close,
      // publication or aggregate failure is a different error and stays unknown.
      if (candidate && candidate.error === error) throw new NativeMoveNotIssued(candidate.record);
      throw error;
    });
    this.chain = outcome.catch(() => {});
    return outcome;
  }
}
