/** One canonical private metadata writer. No stored record is effect authority. */
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants, lstatSync, type BigIntStats } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { writeCompanyStateFile } from './company-store.js';
import {
  FleetOperationData,
  fleetOperationBlocks,
  assertFleetOperationSuccessor,
  type FleetOperation,
} from './resource-fleet-operation.js';

const LIMIT = 16 * 1024 * 1024;
const Records = z
  .array(FleetOperationData)
  .max(256)
  .refine(
    (rows) =>
      new Set(rows.map((row) => row.operationId)).size === rows.length &&
      new Set(rows.map((row) => row.preview.approval.previewId)).size === rows.length
  );
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');

export class FleetOperationStore {
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown;
  private readonly retainedReads: FileHandle[] = [];
  constructor(private readonly file: string) {}
  failed(): boolean {
    return this.failure !== undefined;
  }
  async list(): Promise<FleetOperation[]> {
    await this.chain;
    try {
      return (await this.read()).rows;
    } catch (error) {
      this.failure ??= error;
      throw error;
    }
  }
  async create(value: FleetOperation, current: () => void): Promise<FleetOperation> {
    if (value.phase !== 'prepared' || value.sequence !== 0)
      throw new Error('Only an original prepared operation can be recorded');
    return this.write(undefined, FleetOperationData.parse(value), current);
  }
  async advance(previous: FleetOperation, next: FleetOperation, current: () => void): Promise<FleetOperation> {
    assertFleetOperationSuccessor(previous, next);
    return this.write(previous, FleetOperationData.parse(next), current);
  }
  private async write(
    previous: FleetOperation | undefined,
    value: FleetOperation,
    current: () => void
  ): Promise<FleetOperation> {
    const task = this.chain.then(async () => {
      if (this.failed()) throw new Error('Original fleet operation store is unconfirmed');
      const { rows, identity } = await this.read();
      const index = rows.findIndex((row) => row.operationId === value.operationId);
      if (previous ? index < 0 || !isDeepStrictEqual(rows[index], previous) : index >= 0)
        throw new Error('Original fleet operation changed');
      const newAttempt =
        !previous ||
        value.phase === 'issued' ||
        value.restore.some(
          (row) =>
            row.state === 'pending' && !previous.restore.some((original) => original.employeeId === row.employeeId)
        );
      if (newAttempt && rows.some((row) => row.operationId !== value.operationId && fleetOperationBlocks(row)))
        throw new Error('Another original fleet operation remains blocked');
      const selected = rows.slice();
      if (index >= 0) selected[index] = value;
      else selected.push(value);
      const text = JSON.stringify(Records.parse(selected));
      if (Buffer.byteLength(text) > LIMIT) throw new Error('Fleet operation history is full');
      current();
      await writeCompanyStateFile(this.file, text, () => {
        current();
        let named: string | undefined;
        try {
          named = stamp(lstatSync(this.file, { bigint: true }));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (identity !== named) throw new Error('Fleet operation history changed before commit');
      });
    });
    // Any uncertain prefix freezes this same writer. A later read is allowed,
    // but neither a fresh write nor an effect may turn that error into replay.
    this.chain = task.catch((error) => {
      this.failure ??= error;
    });
    await task;
    return structuredClone(value);
  }
  private async read(): Promise<{ rows: FleetOperation[]; identity?: string }> {
    let handle;
    try {
      handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [] };
      throw error;
    }
    let result: { rows: FleetOperation[]; identity: string } | undefined;
    let primary: unknown;
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(LIMIT) ||
        (before.mode & 0o7777n) !== 0o600n ||
        !process.getuid ||
        before.uid !== BigInt(process.getuid())
      )
        throw new Error('Private fleet operation history is unavailable');
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < bytes.length) {
        const result = await handle.read(bytes, used, bytes.length - used, null);
        if (!result.bytesRead) break;
        used += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true }),
        named = await fs.lstat(this.file, { bigint: true });
      if (used !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(named))
        throw new Error('Private fleet operation history changed');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
      const parsed: unknown = JSON.parse(text);
      if (JSON.stringify(parsed) !== text) throw new Error('Private fleet operation history is not canonical');
      result = { rows: Records.parse(parsed), identity: stamp(before) };
    } catch (error) {
      primary = error;
    }
    try {
      await handle.close();
    } catch (cleanup) {
      this.retainedReads.push(handle);
      throw primary === undefined
        ? cleanup
        : new AggregateError([primary, cleanup], 'Fleet metadata read and close failed');
    }
    if (primary !== undefined) throw primary;
    return result!;
  }
}
