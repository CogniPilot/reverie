import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanMoveStore } from '../src/plan-move-store.js';
import type { PlanMoveRecord } from '../src/plan-move.js';

describe('private bounded durable plan move journal', () => {
  let directory: string;
  let store: PlanMoveStore;
  const record: PlanMoveRecord = {
    id: 'move',
    employeeId: 'casey',
    name: 'Casey',
    oldSession: 'old',
    fromAccount: 'first',
    toAccount: 'second',
    phase: 'waiting',
    at: 1,
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'plan-move-store-'));
    store = new PlanMoveStore(join(directory, 'moves.json'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('starts empty only when absent, and writes private atomically replaced state', async () => {
    expect(await store.load()).toEqual([]);
    await store.save([record]);
    expect(await new PlanMoveStore(store.file).load()).toEqual([record]);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent phase writes without reverting the latest phase', async () => {
    await Promise.all([
      store.save([record]),
      store.save([{ ...record, phase: 'starting' }]),
      store.save([{ ...record, phase: 'completed' }]),
    ]);
    expect((await store.load())[0].phase).toBe('completed');
  });

  it('retains the explicit same-account runtime binding across reopen and refuses incomplete refresh journals', async () => {
    const refresh = { ...record, toAccount: 'first', purpose: 'runtime-refresh' as const, runtimeDigest: 'a'.repeat(64) };
    await store.save([refresh]);
    expect(await new PlanMoveStore(store.file).load()).toEqual([refresh]);
    for (const change of [{ runtimeDigest: undefined }, { toAccount: 'second' }, { purpose: undefined }])
      expect(() => store.save([{ ...refresh, ...change }])).toThrow('refresh journal');
    expect(await store.load()).toEqual([refresh]);
  });

  it('retains the exact boolean source stop request across durable phase transitions and reopen', async () => {
    for (const phase of ['stopping', 'starting', 'checking', 'recovery-required', 'completed'] as const) {
      await store.save([{ ...record, phase, sourceStopRequested: true }]);
      expect(await new PlanMoveStore(store.file).load()).toEqual([{ ...record, phase, sourceStopRequested: true }]);
    }
    expect(() => store.save([{ ...record, sourceStopRequested: 'true' } as unknown as PlanMoveRecord])).toThrow();
    expect((await store.load())[0].sourceStopRequested).toBe(true);
  });

  it('fails closed on corruption, duplicate ids, unknown fields and oversized journals', async () => {
    await writeFile(store.file, '{broken');
    await expect(store.load()).rejects.toThrow();
    await writeFile(store.file, JSON.stringify([record, record]));
    await expect(store.load()).rejects.toThrow('Duplicate');
    expect(() => store.save([{ ...record, cookie: 'never persist' } as PlanMoveRecord])).toThrow();
    expect(() => store.save(Array.from({ length: 101 }, (_, index) => ({ ...record, id: String(index) })))).toThrow();
    await writeFile(store.file, ' '.repeat(1024 * 1024 + 1));
    await expect(store.load()).rejects.toThrow('size bound');
  });

  it('validates before replacing a good journal', async () => {
    await store.save([record]);
    const before = await readFile(store.file, 'utf8');
    expect(() => store.save([{ ...record, phase: 'unknown' } as unknown as PlanMoveRecord])).toThrow();
    expect(await readFile(store.file, 'utf8')).toBe(before);
  });
  it('persists verified cleanup and terminal owner adoption across restart with private mode', async () => {
    const adopted = {...record, newSession: 'new', phase: 'completed' as const, sourceStopRequested: true,
      sourceCleanupVerified: true, recoveryAction: 'adopt-existing' as const, recoveredAt: 2};
    await store.recoveryPending(adopted); await store.save([adopted]); await store.recoveryConfirmed(adopted);
    expect(await new PlanMoveStore(store.file).load()).toEqual([adopted]);
    expect(() => store.save([{...record, sourceCleanupVerified: true}])).toThrow('cleanup proof');
    expect(() => store.save([{...adopted, phase: 'waiting'}])).toThrow('terminal receipt');
  });

  it('never treats terminal recovery journal bytes alone as verified completion', async () => {
    const adopted = {...record, newSession: 'new', phase: 'completed' as const, sourceStopRequested: true,
      sourceCleanupVerified: true, recoveryAction: 'adopt-existing' as const, recoveredAt: 2};
    await store.recoveryPending(adopted); await store.save([adopted]);
    expect((await new PlanMoveStore(store.file).load())[0].phase).toBe('recovery-required');
    await store.recoveryConfirmed(adopted); expect((await new PlanMoveStore(store.file).load())[0].phase).toBe('completed');
    await writeFile(store.file, JSON.stringify([{...adopted, toAccount: 'other'}]));
    await expect(new PlanMoveStore(store.file).load()).rejects.toThrow('differs from terminal');
  });
  it('hashes even legacy path-like identifiers and refuses malformed or duplicate-key private receipts', async () => {
    const id = '../legacy/move', legacy = {...record, id}; await store.save([legacy]); await store.recoveryPending(legacy);
    const pending = (await readdir(directory)).find(name => name.endsWith('.pending.json'))!;
    expect(pending).toMatch(/^moves.json[.]recovery-[0-9a-f]{64}[.]pending[.]json$/);
    await writeFile(join(directory, pending), JSON.stringify({version: 1, id, unknown: true}));
    await expect(store.load()).rejects.toThrow();
    await writeFile(join(directory, pending), '{"version":0,"version":1,"id":"../legacy/move"}');
    await expect(store.load()).rejects.toThrow('Noncanonical');
  });

});
