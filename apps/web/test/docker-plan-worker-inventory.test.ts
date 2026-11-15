import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { DockerPlanMoveJournalState } from '../src/docker-plan-move-data.js';
import { dockerPlanWorkerContainerIds } from '../src/docker-plan-worker-inventory.js';
import {
  dockerPlanSourceRetirementSubject,
  requireDockerPlanSourceRetirement,
} from '../src/docker-plan-source-retirement.js';
const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
async function fixture() {
  const f = dockerPlanJournalFixture(),
    dir = fs.mkdtempSync(join(tmpdir(), 'plan-members-'));
  fs.chmodSync(dir, 0o700);
  paths.push(dir);
  const moves = new PlanMoveStore(join(dir, 'moves.json')),
    destination = {
      ...f.work.original,
      containerId: '0'.repeat(64),
      sessionId: f.work.request.sessionId,
      imageId: f.work.workerImage.imageId,
    };
  const state = DockerPlanMoveJournalState.parse({
    ...f.closed,
    material: f.material,
    work: { ...f.work, phase: 'destination-ready', destination },
  });
  await moves.save([f.record]);
  await moves.dockerPublish(f.record.id, f.state, f.closed, () => {});
  await moves.dockerPublish(f.record.id, f.closed, state, () => {});
  return { ...f, dir, moves, state, destination };
}
describe('logical staged members join the same protected private journal', () => {
  it('includes staged target and excludes only its exact already-closed source binding', async () => {
    const f = await fixture();
    expect(
      await dockerPlanWorkerContainerIds(
        () => [f.state.seed.source.record],
        f.moves,
        () => {}
      )
    ).toEqual([f.destination.containerId]);
  });
  it('keeps a different current operation instead of hiding a source CID by name alone', async () => {
    const f = await fixture(),
      changed = { ...f.state.seed.source.record, credentialId: 'f0000000-0000-4000-8000-00000000000f' };
    expect(
      await dockerPlanWorkerContainerIds(
        () => [changed],
        f.moves,
        () => {}
      )
    ).toEqual([changed.destination!.containerId, f.destination.containerId]);
  });
  it('deduplicates a now-published target while preserving unrelated canonical members', async () => {
    const f = await fixture(),
      other = {
        ...f.state.seed.source.record,
        employeeId: 'f0000000-0000-4000-8000-00000000000f',
        destination: { ...f.destination, containerId: 'e'.repeat(64) },
      };
    expect(
      await dockerPlanWorkerContainerIds(
        () => [f.state.work!, other],
        f.moves,
        () => {}
      )
    ).toEqual([f.destination.containerId, other.destination.containerId]);
  });
  it('requires actual private-store custody and never turns corrupt journal data into an empty inventory', async () => {
    const f = await fixture();
    await expect(
      dockerPlanWorkerContainerIds(
        () => [],
        {} as PlanMoveStore,
        () => {}
      )
    ).rejects.toThrow('private plan journal');
    fs.writeFileSync(f.moves.file, 'not canonical JSON', { mode: 0o600 });
    await expect(
      dockerPlanWorkerContainerIds(
        () => [],
        f.moves,
        () => {}
      )
    ).rejects.toThrow();
  });
  it('revalidates current runtime around the awaited journal read', async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      dockerPlanWorkerContainerIds(
        () => [],
        f.moves,
        () => {
          if (++calls >= 2) throw Error('runtime changed');
        }
      )
    ).rejects.toThrow('runtime changed');
  });
  it('has no authority without the actual native source-retirement brand', () => {
    expect(() => dockerPlanSourceRetirementSubject({ moveId: 'data' })).toThrow('proof');
    expect(() => requireDockerPlanSourceRetirement({ require: () => true }, undefined)).toThrow('proof');
  });
});
