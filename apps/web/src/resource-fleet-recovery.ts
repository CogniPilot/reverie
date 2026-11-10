/** Current negative boundary evidence, never an old operation completion or a launch grant. */
import fs from 'node:fs/promises';
import { constants, lstatSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NativeOwnerId, NativeOwnerPrincipal } from './native-owner-data.js';
import { writeCompanyStateFile } from './company-store.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PoolAbsenceData = z.object({
  version: z.literal(1), purpose: z.literal('worker-pool-uninstalled-observation-v1'),
  nonce: NativeOwnerId,
  observedAtEpochMs: z.number().int().nonnegative().safe(),
  expiresAtEpochMs: z.number().int().positive().safe(),
  nominationDigest: Digest, configurationDigest: Digest,
  brokerPid: z.number().int().positive().max(4294967295),
  brokerStart: z.string().regex(/^[0-9]{1,20}$/), brokerProgramDigest: Digest,
  lifecycleGeneration: z.string().regex(/^(0|[1-9][0-9]{0,127})$/),
  principal: NativeOwnerPrincipal,
  websiteContainerId: Digest,
  uninstalled: z.literal(true), oldOperationOutcome: z.literal('unconfirmed'),
  startsAuthorized: z.literal(false), activationAuthorized: z.literal(false),
}).strict().readonly();
export type PoolAbsence = z.infer<typeof PoolAbsenceData>;
export const FleetRecoveryRequest = z.object({
  operationId: NativeOwnerId, preserveUnconfirmedHistory: z.literal(true),
}).strict();
const Record = z.object({
  operationId: NativeOwnerId, ownerScopeDigest: Digest,
  oldOutcome: z.literal('unconfirmed'), evidence: PoolAbsenceData,
  evidenceDigest: Digest, recordedAtEpochMs: z.number().int().nonnegative().safe(),
}).strict();
const Records = z.array(Record).max(4096).refine(rows => new Set(rows.map(row => row.evidence.nonce)).size === rows.length);
type RecoveryRecord = z.infer<typeof Record>;
const LIMIT = 8 * 1024 * 1024;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');

export function requireFreshPoolAbsence(value: PoolAbsence, now = Date.now()): void {
  if (value.observedAtEpochMs > now || now >= value.expiresAtEpochMs ||
      value.expiresAtEpochMs - value.observedAtEpochMs !== 5000)
    throw new Error('Current uninstalled-state observation expired; no prior outcome was changed');
}

/** One web-process writer; no eviction of unknown references or prior evidence. */
export class FleetRecoveryHistory {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async record(operationId: string, ownerScopeDigest: string, evidence: PoolAbsence,
    current: () => void): Promise<RecoveryRecord> {
    const row = Record.parse({operationId, ownerScopeDigest, oldOutcome: 'unconfirmed', evidence,
      evidenceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), recordedAtEpochMs: Date.now()});
    const task = this.chain.then(async () => {
      const {rows, identity} = await this.read();
      if (rows.some(prior => prior.evidence.nonce === evidence.nonce)) throw new Error('Pool observation was already recorded');
      const next = JSON.stringify(Records.parse([...rows, row]));
      if (Buffer.byteLength(next) > LIMIT) throw new Error('Failed setup history is full');
      await writeCompanyStateFile(this.file, next, () => {
        current(); requireFreshPoolAbsence(evidence);
        let named: string | undefined;
        try { named = stamp(lstatSync(this.file, {bigint: true})); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (named !== identity) throw new Error('Failed setup history changed before commit');
      });
      current();
    });
    this.chain = task.catch(() => {});
    await task;
    return row;
  }
  private async read(): Promise<{rows: RecoveryRecord[]; identity?: string}> {
    let handle;
    try { handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {rows: []}; throw error; }
    try {
      const before = await handle.stat({bigint: true});
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(LIMIT) ||
          (before.mode & 0o7777n) !== 0o600n || !process.getuid || before.uid !== BigInt(process.getuid()))
        throw new Error('Private failed setup history is unavailable');
      const bytes = Buffer.alloc(Number(before.size) + 1); let used = 0;
      while (used < bytes.length) {
        const result = await handle.read(bytes, used, bytes.length - used, null);
        if (!result.bytesRead) break;
        used += result.bytesRead;
      }
      const after = await handle.stat({bigint: true}), named = await fs.lstat(this.file, {bigint: true});
      if (used !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(named))
        throw new Error('Private failed setup history changed');
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, used));
      const parsed: unknown = JSON.parse(text);
      if (JSON.stringify(parsed) !== text) throw new Error('Private failed setup history is not canonical');
      return {rows: Records.parse(parsed), identity: stamp(before)};
    } finally { await handle.close(); }
  }
}
