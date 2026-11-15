import { spawn } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { PlanMoves } from '../src/plan-move.js';
import {
  DockerPlanMoveSeed,
  DockerPlanMoveJournalState,
  assertDockerPlanMoveTransition,
} from '../src/docker-plan-move-data.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
describe('same-journal Docker actor publication', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plan-native-journal-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('retains separate source and target identities and explicit refresh lineage', () => {
    const { state } = dockerPlanJournalFixture(),
      seed = state.seed;
    expect(DockerPlanMoveSeed.parse(seed)).toEqual(seed);
    expect(() =>
      DockerPlanMoveSeed.parse({
        ...seed,
        forceBusy: false,
        source: { ...seed.source, observation: { kind: 'stopped', terminalStateDigest: 'a'.repeat(64) } },
      })
    ).toThrow();
    expect(
      DockerPlanMoveSeed.parse({
        ...seed,
        forceBusy: true,
        source: { ...seed.source, observation: { kind: 'stopped', terminalStateDigest: 'a'.repeat(64) } },
      }).forceBusy
    ).toBe(true);
    const retained = {
      kind: 'retained-generation',
      moveId: 'original-A',
      operationId: seed.source.binding.operationId,
      containerId: seed.source.binding.containerId,
      projectionDigest: 'b'.repeat(64),
      originalCanonicalSnapshotDigest: seed.target.accountSnapshotDigest,
    };
    expect(
      DockerPlanMoveSeed.parse({ ...seed, target: { ...seed.target, accountSource: retained } }).target.accountSource
    ).toEqual(retained);
    expect(() =>
      DockerPlanMoveSeed.parse({
        ...seed,
        target: { ...seed.target, accountSource: { ...retained, originalCanonicalSnapshotDigest: 'c'.repeat(64) } },
      })
    ).toThrow();
    expect(() =>
      DockerPlanMoveSeed.parse({
        ...seed,
        target: { ...seed.target, accountSource: { kind: 'canonical', token: 'never' } },
      })
    ).toThrow();
  });
  it('publishes actual canonical state without invalidating its own old cursor after rename', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    await store.save([f.record]);
    const current = vi.fn();
    const actual = await store.dockerPublish(f.record.id, f.state, f.closed, current);
    expect(actual.dockerReplacement).toEqual(f.closed);
    expect((await new PlanMoveStore(store.file).dockerRecord(f.record.id)).dockerReplacement).toEqual(f.closed);
    expect(current.mock.calls.length).toBeGreaterThan(2);
    store.dockerCurrent(f.record.id, f.epoch, dockerContinuationDigest(f.state.seed));
    await expect(store.save([f.record])).rejects.toThrow('original CAS');
    expect((await store.dockerRecord(f.record.id)).dockerReplacement).toEqual(f.closed);
  });
  it('fences old publishers with a fresh epoch under the same kernel lock', async () => {
    const f = dockerPlanJournalFixture(),
      file = join(dir, 'moves.json');
    const old = new PlanMoveStore(file),
      next = new PlanMoveStore(file);
    await old.save([f.record]);
    await old.dockerPublish(f.record.id, f.state, f.closed, () => {});
    const epoch = '90000000-0000-4000-8000-000000000009';
    const proof = vi.fn();
    const claimed = await next.dockerClaim(f.record.id, f.closed, epoch, proof, () => {});
    expect(proof).toHaveBeenCalledTimes(1);
    expect(claimed.dockerReplacement?.sourceStop).toEqual(f.closed.sourceStop);
    expect(() => old.dockerCurrent(f.record.id, f.epoch, dockerContinuationDigest(f.state.seed))).toThrow(
      'no longer current'
    );
    await expect(old.dockerPublish(f.record.id, f.closed, f.closed, () => {})).rejects.toThrow('cursor changed');
    next.dockerCurrent(f.record.id, epoch, dockerContinuationDigest(f.state.seed));
  });

  it('captures original CAS DATA before waiting for the writer queue', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    await store.save([f.record]);
    const before = structuredClone(f.state),
      next = structuredClone(f.closed);
    const publication = store.dockerPublish(f.record.id, before, next, () => {});
    before.epoch = '90000000-0000-4000-8000-000000000009';
    next.seed.target.accountId = 'changed-after-admission';
    expect((await publication).dockerReplacement).toEqual(f.closed);
    const held = structuredClone(f.closed);
    const takeover = store.dockerClaim(
      f.record.id,
      held,
      'a0000000-0000-4000-8000-00000000000a',
      () => {},
      () => {}
    );
    held.seed.handoff = 'changed-after-queued-claim';
    expect((await takeover).dockerReplacement?.seed).toEqual(f.state.seed);
  });
  it('allows exactly one contender and rechecks revoked authority under lock', async () => {
    const f = dockerPlanJournalFixture(),
      file = join(dir, 'moves.json');
    const a = new PlanMoveStore(file),
      b = new PlanMoveStore(file);
    await a.save([f.record]);
    const call = (store: PlanMoveStore, epoch: string) =>
      store.dockerClaim(
        f.record.id,
        f.state,
        epoch,
        () => {},
        () => {}
      );
    const results = await Promise.allSettled([
      call(a, '90000000-0000-4000-8000-000000000009'),
      call(b, 'a0000000-0000-4000-8000-00000000000a'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const prior = (await a.dockerRecord(f.record.id)).dockerReplacement!;
    await expect(
      a.dockerClaim(
        f.record.id,
        prior,
        'b0000000-0000-4000-8000-00000000000b',
        () => {},
        () => {
          throw Error('permission revoked');
        }
      )
    ).rejects.toThrow('permission revoked');
    expect((await b.dockerRecord(f.record.id)).dockerReplacement).toEqual(prior);
  });
  it('serializes separate processes without letting either rewrite an issued cursor', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    await store.save([f.record]);
    const child = (epoch: string) =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(
          process.execPath,
          ['--import', 'tsx', 'test/fixtures/plan-move-docker-cas.ts', store.file, f.record.id, epoch],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }
        );
        let output = '',
          error = '';
        proc.stdout.on('data', (chunk) => {
          output += String(chunk);
        });
        proc.stderr.on('data', (chunk) => {
          error += String(chunk);
        });
        proc.once('error', reject);
        proc.once('close', (code) => (code === 0 ? resolve(output) : reject(Error(error || 'child failed'))));
      });
    expect(
      (
        await Promise.all([
          child('90000000-0000-4000-8000-000000000009'),
          child('a0000000-0000-4000-8000-00000000000a'),
        ])
      ).sort()
    ).toEqual(['claimed\n', 'refused\n']);
  });
  it('holds uncertain finalization after publication and exact reads reveal the committed cursor', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    await store.save([f.record]);
    let calls = 0;
    await expect(
      store.dockerPublish(f.record.id, f.state, f.closed, () => {
        if (++calls === 4) throw Error('authority changed after publication');
      })
    ).rejects.toThrow();
    expect((await store.dockerRecord(f.record.id)).dockerReplacement).toEqual(f.closed);
    await expect(store.dockerPublish(f.record.id, f.state, f.closed, () => {})).rejects.toThrow('cursor changed');
  });
  it('refuses cursor removal, forged seeded effects, and changed task/configuration DATA', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    await expect(store.save([{ ...f.record, dockerReplacement: f.closed }])).rejects.toThrow('previously reserved');
    await store.save([f.record]);
    await expect(store.save([])).rejects.toThrow('original CAS');
    expect(() => assertDockerPlanMoveTransition(f.closed, f.state)).toThrow();
    expect(() =>
      assertDockerPlanMoveTransition(f.state, { ...f.state, epoch: '90000000-0000-4000-8000-000000000009' })
    ).toThrow();
    expect(() =>
      DockerPlanMoveJournalState.parse({
        ...f.state,
        paidDispatch: {
          phase: 'issued',
          epoch: f.epoch,
          operationId: f.targetOp,
          sessionId: f.targetSid,
          containerId: 'f'.repeat(64),
          recipeDigest: 'e'.repeat(64),
        },
      })
    ).toThrow();
  });

  it('retains issued helper identity through takeover and never grants a second paid gate', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    await store.save([f.record]);
    await store.dockerPublish(f.record.id, f.state, f.closed, () => {});
    const staged = DockerPlanMoveJournalState.parse({ ...f.closed, work: f.work });
    await store.dockerPublish(f.record.id, f.closed, staged, () => {});
    const task = {
      role: 'storage-holder',
      name: 'reverie-boxed-storage-synthetic',
      imageId: f.work.workerImage.imageId,
      configurationDigest: 'd'.repeat(64),
      phase: 'create-issued',
    };
    const issued = DockerPlanMoveJournalState.parse({ ...staged, work: { ...f.work, tasks: [task] } });
    await store.dockerPublish(f.record.id, staged, issued, () => {});
    const changed = DockerPlanMoveJournalState.parse({
      ...issued,
      work: { ...issued.work, tasks: [{ ...task, configurationDigest: 'e'.repeat(64) }] },
    });
    expect(() => assertDockerPlanMoveTransition(issued, changed)).toThrow('task changed');
    const claimed = await store.dockerClaim(
      f.record.id,
      issued,
      '90000000-0000-4000-8000-000000000009',
      () => {},
      () => {}
    );
    expect(claimed.dockerReplacement?.work?.tasks).toEqual([task]);
    const prior = claimed.dockerReplacement!;
    let futureProof = false;
    await expect(
      store.dockerClaim(
        f.record.id,
        prior,
        'a0000000-0000-4000-8000-00000000000a',
        () => {
          if (!futureProof) throw Error('unknown native helper');
        },
        () => {}
      )
    ).rejects.toThrow('unknown native helper');
    futureProof = true;
    expect((await store.dockerRecord(f.record.id)).dockerReplacement).toEqual(prior);
  });

  it('refuses takeover and paid intent replacement even when a new actor has native settlement evidence', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    const base = { imageId: f.work.workerImage.imageId, configurationDigest: 'd'.repeat(64) };
    const work = {
      ...f.work,
      phase: 'provider-issued',
      pool: {
        containerId: '1'.repeat(64),
        cgroupParent: '/synthetic-box',
        policyDigest: dockerContinuationDigest(f.work.policy.pool),
        physicalDigest: '2'.repeat(64),
      },
      destination: {
        ...f.work.original,
        containerId: '0'.repeat(64),
        sessionId: f.targetSid,
        imageId: f.work.workerImage.imageId,
      },
      tasks: [
        {
          ...base,
          role: 'storage-holder',
          name: 'reverie-boxed-storage-test',
          phase: 'running',
          containerId: '3'.repeat(64),
          initPid: 42,
          initStartTicks: '1234',
        },
        ...(['leaf-helper', 'identity-helper'] as const).map((role, i) => ({
          ...base,
          role,
          name: 'reverie-boxed-' + role,
          phase: 'completed',
          containerId: String(i + 4).repeat(64),
          resultDigest: 'e'.repeat(64),
        })),
      ],
    };
    const paid = DockerPlanMoveJournalState.parse({
      ...f.closed,
      work,
      paidDispatch: {
        phase: 'issued',
        epoch: f.epoch,
        operationId: f.targetOp,
        sessionId: f.targetSid,
        containerId: '0'.repeat(64),
        recipeDigest: f.work.sourceDigest,
      },
    });
    await expect(
      store.dockerClaim(
        f.record.id,
        paid,
        '90000000-0000-4000-8000-000000000009',
        () => {},
        () => {}
      )
    ).rejects.toThrow();
    expect(() => assertDockerPlanMoveTransition(paid, { ...paid, paidDispatch: undefined })).toThrow();
    expect(() =>
      assertDockerPlanMoveTransition(paid, {
        ...paid,
        paidDispatch: { ...paid.paidDispatch!, recipeDigest: 'f'.repeat(64) },
      })
    ).toThrow();
  });
  it('retains exact staged destinations for private pool inventory before Company publication', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    expect(await store.stagedDockerResourceInventory()).toEqual([]);
    await store.save([f.record]);
    expect(await store.stagedDockerResourceInventory()).toEqual([]);
    await store.dockerPublish(f.record.id, f.state, f.closed, () => {});
    const work = {
      ...f.work,
      phase: 'destination-ready',
      destination: {
        ...f.work.original,
        containerId: '0'.repeat(64),
        sessionId: f.targetSid,
        imageId: f.work.workerImage.imageId,
      },
    };
    const stage = DockerPlanMoveJournalState.parse({ ...f.closed, work });
    await store.dockerPublish(f.record.id, f.closed, stage, () => {});
    expect(await new PlanMoveStore(store.file).stagedDockerResourceInventory()).toEqual([stage.work]);
    await writeFile(store.file, '{unconfirmed', { mode: 0o600 });
    await expect(store.stagedDockerResourceInventory()).rejects.toThrow();
  });
  it('never exposes the private seed, handoff or source descriptor through public move views', async () => {
    const f = dockerPlanJournalFixture();
    const unavailable = async (): Promise<never> => {
      throw Error('No effect admission');
    };
    const moves = new PlanMoves({
      load: async () => [f.record],
      save: async () => {},
      snapshot: unavailable,
      idle: unavailable,
      create: unavailable,
      start: unavailable,
      ready: unavailable,
      beforeStop: unavailable,
      binding: () => undefined,
      exists: () => false,
      rebind: unavailable,
      stop: unavailable,
      audit: unavailable,
    });
    for (const value of [await moves.get(f.record.id, f.record.owner), ...(await moves.list(f.record.owner))]) {
      expect(value).toBeDefined();
      expect(value).not.toHaveProperty('dockerReplacement');
      expect(JSON.stringify(value)).not.toContain(f.state.seed.handoff);
      expect(JSON.stringify(value)).not.toContain('/synthetic-private-home');
    }
  });
  it('documents the literal previous cached writer is NOT fenced by a new-protocol lock', async () => {
    const f = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(dir, 'moves.json'));
    const legacy = {
      id: 'legacy',
      employeeId: 'synthetic',
      name: 'Synthetic',
      oldSession: 'old',
      fromAccount: 'A',
      toAccount: 'B',
      phase: 'waiting',
      at: 1,
    };
    // Exact predecessor writer semantics: validate only its cached records, then
    // atomic write. It never reloads the current journal or takes the new lock.
    const { writeCompanyStateFile } = await import('../src/company-store.js');
    const oldSave = () => writeCompanyStateFile(store.file, JSON.stringify([legacy]));
    await oldSave();
    await store.save([legacy as typeof f.record, f.record]);
    const published = await readFile(store.file, 'utf8');
    expect(published).toContain('dockerReplacement');
    // Literal previous strict decoder refuses the new row on a cold start.
    const { z } = await import('zod');
    const previous = z
      .object({
        id: z.string(),
        employeeId: z.string(),
        name: z.string(),
        oldSession: z.string(),
        fromAccount: z.string(),
        toAccount: z.string(),
        phase: z.string(),
        at: z.number(),
      })
      .strict()
      .array();
    expect(() => previous.parse(JSON.parse(published))).toThrow();
    await oldSave();
    expect(await readFile(store.file, 'utf8')).toBe(JSON.stringify([legacy]));
    // Restore only this test's private fixture. Activation MUST exclude the old
    // runtime before publication; flock is not a fence for an old ignoring writer.
    await writeFile(store.file, published, { mode: 0o600 });
    expect((await store.dockerRecord(f.record.id)).dockerReplacement).toEqual(f.state);
  });
});
