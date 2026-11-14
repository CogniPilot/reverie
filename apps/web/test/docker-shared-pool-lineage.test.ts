/** Actual canonical writer and lifecycle; all container descriptors are synthetic
 * DATA. Native acceptance is tested independently by the resource controller. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile as writeCompanyFixture } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema, CompanyStateSchema } from '../src/company-types.js';
import { z } from 'zod';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { retainedDockerPoolTasks, captureDockerSharedPoolLineages } from '../src/docker-shared-pool-lineage.js';
import type { DockerContinuationTask } from '../src/docker-continuation-task.js';

const eid = '11111111-1111-4111-8111-111111111111',
  sid = '22222222-2222-4222-8222-222222222222',
  op = '33333333-3333-4333-8333-333333333333',
  helper = 'sha256:' + 'a'.repeat(64),
  anchorName = 'reverie-boxed-anchor-' + 'b'.repeat(32);
function record(operationId = op): DockerEmployeeContinuationRecord {
  const image = 'sha256:' + 'd'.repeat(64),
    destinationImage = 'sha256:' + 'e'.repeat(64);
  const task = (role: 'anchor' | 'pool-helper'): DockerContinuationTask => ({
    role,
    name: role === 'anchor' ? anchorName : 'reverie-boxed-pool-' + operationId,
    imageId: helper,
    configurationDigest: 'f'.repeat(64),
    ...(role === 'anchor'
      ? {
          phase: 'running' as const,
          containerId: '1'.repeat(64),
          initPid: 101,
          initStartTicks: '202',
        }
      : {
          phase: 'completed' as const,
          containerId: '2'.repeat(64),
          resultDigest: '3'.repeat(64),
        }),
  });
  return DockerEmployeeContinuationRecord.parse({
    version: 1,
    purpose: 'docker-employee-continuation-v1',
    employeeId: eid,
    owner: 'owner',
    request: {
      operationId,
      sessionId: sid,
      sessionGeneration: 9,
      containerId: 'c'.repeat(64),
      imageId: image,
      expectedPolicyDigest: '4'.repeat(64),
      expectedDestinationImageId: destinationImage,
      enterOffice: false,
    },
    sourceDigest: '5'.repeat(64),
    original: {
      containerId: 'c'.repeat(64),
      imageId: image,
      employeeId: eid,
      sessionId: sid,
      deployment: 'synthetic',
      home: {
        type: 'bind',
        source: '/synthetic/home',
        destination: '/home/agent',
        readWrite: true,
      },
      mountDigest: '6'.repeat(64),
      storageDigest: '7'.repeat(64),
      configurationDigest: '8'.repeat(64),
    },
    workerImage: {
      imageId: destinationImage,
      sourceImageId: image,
      clientManifestDigest: '9'.repeat(64),
    },
    policy: {
      memoryMaxBytes: 16 * 1024 ** 3,
      memoryHighBytes: 8 * 1024 ** 3,
      swapMaxBytes: 0,
      pidsMax: 512,
      cpuWeight: 100,
      allowedCpus: [0, 1],
      pool: {
        memoryMaxBytes: 48 * 1024 ** 3,
        swapMaxBytes: 0,
        pidsMax: 8192,
        cpuWeight: 100,
        allowedCpus: [0, 1],
      },
    },
    credentialId: '44444444-4444-4444-8444-444444444444',
    phase: 'pool-issued',
    tasks: [task('anchor'), task('pool-helper')],
  });
}
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'shared-pool-'));
  directories.push(directory);
  const file = join(directory, 'company.json'),
    store = new CompanyStore(file);
  await store.init();
  const row = record();
  await store.update((state) => {
    state.employees.push(
      EmployeeSchema.parse({
        id: eid,
        sessionId: sid,
        sessionGeneration: 9,
        owner: 'owner',
        name: 'Synthetic',
        icon: 'S',
        position: 'Engineer',
        expertise: ['testing'],
        createdAt: 1,
        onVacation: true,
        desiredRunning: false,
      })
    );
    state.dockerEmployeeContinuations = [row];
  });
  const company = new CompanyService(store, {
    getSession: () => undefined,
    chatrooms: { rooms: () => [], removeMember: async () => {} },
    research: {},
    stopSession: async () => {},
  } as unknown as CompanyServiceDeps);
  return { store, file, company, row };
}
describe('canonical shared pool intent survives its original owner', () => {
  it('imports empty format1, atomically upgrades retained metadata to2 and refuses an old literal1 reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pool-format-'));
    directories.push(directory);
    const file = join(directory, 'company.json'),
      store = new CompanyStore(file);
    await store.init();
    await store.update(() => {});
    const before = store.snapshot();
    expect(before.version).toBe(1);
    const staleReader = new CompanyStore(file);
    await staleReader.init();
    const original = record();
    await store.update((state) => {
      state.dockerEmployeeContinuations = [original];
    });
    const current = store.snapshot();
    expect(current.version).toBe(2);
    expect(current.dockerEmployeeContinuations).toEqual([original]);
    const imported = new CompanyStore(file);
    await imported.init();
    expect(imported.snapshot()).toEqual(current);
    // Exact literal-1 envelope gate used by older complete readers, rather
    // than a second implementation of the current company reader.
    const oldVersionGate = z.object({ version: z.literal(1) }).passthrough();
    expect(oldVersionGate.safeParse(before).success).toBe(true);
    expect(oldVersionGate.safeParse(current).success).toBe(false);
    expect(CompanyStateSchema.safeParse({ ...current, version: 1 }).success).toBe(false);
    await staleReader.update((state) => {
      state.memories = [];
    });
    expect(staleReader.snapshot().version).toBe(2);
    const bytes = await readFile(file, 'utf8');
    await expect(
      staleReader.update((state) => {
        state.version = 1;
      })
    ).rejects.toMatchObject({ code: 'DOCKER_COMPANY_FORMAT_DOWNGRADE_REFUSED' });
    expect(await readFile(file, 'utf8')).toBe(bytes);
    const invalid = JSON.stringify({ ...current, version: 1 });
    await writeCompanyFixture(file, invalid, { mode: 0o600 });
    await expect(new CompanyStore(file).init()).rejects.toThrow('Company format 2');
    expect(await readFile(file, 'utf8')).toBe(invalid);
  });
  it('never silently downgrades format2 even when the global metadata arrays are empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pool-format-empty-'));
    directories.push(directory);
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    await store.update((state) => {
      state.version = 2;
    });
    const before = store.snapshot();
    await expect(
      store.update((state) => {
        state.version = 1;
      })
    ).rejects.toMatchObject({ code: 'DOCKER_COMPANY_FORMAT_DOWNGRADE_REFUSED' });
    expect(store.snapshot()).toEqual(before);
  });

  it('serializes different employee configure START intents under the real canonical lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pool-writer-race-'));
    directories.push(directory);
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const first = record(),
      second = record('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    second.employeeId = second.original.employeeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    second.request.sessionId = second.original.sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    for (const [index, row] of [first, second].entries()) {
      const { role, name, imageId, configurationDigest } = row.tasks![1]!;
      row.tasks![1] = {
        role,
        name,
        imageId,
        configurationDigest,
        phase: 'created',
        containerId: (index === 0 ? '1' : '2').repeat(64),
      };
    }
    await store.update((state) => {
      state.dockerEmployeeContinuations = [first, second];
    });
    const results = await Promise.allSettled(
      [first, second].map((original) =>
        store.update((state) => {
          const row = state.dockerEmployeeContinuations!.find(
            (value) => value.request.operationId === original.request.operationId
          )!;
          const before = row.tasks![1]!;
          if (!('containerId' in before)) throw Error('fixture requires CID');
          row.tasks![1] = { ...before, phase: 'start-issued' };
        })
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'DOCKER_SHARED_POOL_WRITER_UNCONFIRMED' },
    });
    expect(
      store
        .snapshot()
        .dockerSharedPoolLineages!.map((value) => value.configuration.phase)
        .sort()
    ).toEqual(['created', 'start-issued']);
    const started = store
      .snapshot()
      .dockerEmployeeContinuations!.find((row) => row.tasks![1]!.phase === 'start-issued')!;
    await store.update((state) => {
      const row = state.dockerEmployeeContinuations!.find(
        (value) => value.request.operationId === started.request.operationId
      )!;
      const task = row.tasks![1]!;
      if (!('containerId' in task)) throw Error('fixture requires CID');
      row.tasks![1] = { ...task, phase: 'completed', resultDigest: 'f'.repeat(64) };
    });
    await store.update((state) => {
      const row = state.dockerEmployeeContinuations!.find(
        (value) => value.request.operationId !== started.request.operationId
      )!;
      row.tasks![1] = { ...row.tasks![1]!, phase: 'start-issued' } as DockerContinuationTask;
    });
    expect(
      store
        .snapshot()
        .dockerSharedPoolLineages!.map((value) => value.configuration.phase)
        .sort()
    ).toEqual(['completed', 'start-issued']);
  });

  it('does not silently hide an unscoped possibly-started legacy writer', () => {
    const row = record();
    row.tasks = [row.tasks![1]!];
    const state = { dockerEmployeeContinuations: [row] };
    expect(captureDockerSharedPoolLineages(state)).toHaveLength(1);
    expect(() => retainedDockerPoolTasks(state, anchorName, helper)).toThrow('SCOPE_UNCONFIRMED');
  });

  it('retains a legacy canonical row atomically BEFORE row deletion and reload', async () => {
    const f = await fixture();
    // Exercise old accepted bytes with no ledger, rather than relying on a prior
    // metadata write to have migrated them.
    const raw = JSON.parse(await readFile(f.file, 'utf8'));
    delete raw.dockerSharedPoolLineages;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(f.file, JSON.stringify(raw), { mode: 0o600 });
    const loaded = new CompanyStore(f.file);
    await loaded.init();
    const before = loaded.snapshot().dockerEmployeeContinuations;
    await loaded.update((state) => {
      delete state.dockerEmployeeContinuations;
      state.employees = [];
    });
    const restarted = new CompanyStore(f.file);
    await restarted.init();
    expect(restarted.snapshot().dockerEmployeeContinuations).toBeUndefined();
    expect(retainedDockerPoolTasks(restarted.snapshot(), anchorName, helper)).toEqual([before![0]!.tasks![1]]);
    expect(restarted.snapshot().dockerSharedPoolLineages![0]!.origin).toEqual({
      operationId: op,
      employeeId: eid,
      sessionId: sid,
      sessionGeneration: 9,
      owner: 'owner',
    });
  });
  it('real retirement preserves the canonical ACK reference without exposing it as company/API data', async () => {
    const f = await fixture();
    await f.company.retire(eid, 'owner', () => {});
    expect(f.store.snapshot().employees).toHaveLength(0);
    expect(f.store.snapshot().retired).toHaveLength(1);
    expect(retainedDockerPoolTasks(f.store.snapshot(), anchorName, helper)).toEqual([f.row.tasks![1]]);
    expect(f.company.view('owner')).not.toHaveProperty('dockerSharedPoolLineages');
    expect(retainedDockerPoolTasks(f.store.snapshot(), anchorName, 'sha256:' + 'b'.repeat(64))).toEqual([
      f.row.tasks![1],
    ]);
    expect(retainedDockerPoolTasks(f.store.snapshot(), anchorName + 'x', helper)).toEqual([]);
  });
  it.each(['session', 'generation', 'owner', 'binding-migration'] as const)(
    'canonical %s change cannot discard shared ownership',
    async (change) => {
      const f = await fixture();
      await f.store.update((state) => {
        const employee = state.employees[0]!;
        if (change === 'session') employee.sessionId = '55555555-5555-4555-8555-555555555555';
        else if (change === 'generation') employee.sessionGeneration++;
        else if (change === 'owner') employee.owner = 'new-owner';
        else {
          delete state.dockerEmployeeContinuations;
        }
      });
      expect(retainedDockerPoolTasks(f.store.snapshot(), anchorName, helper)).toEqual([f.row.tasks![1]]);
    }
  );
  it('revoked canonical authority cannot retire or publish retention metadata', async () => {
    const f = await fixture(),
      before = await readFile(f.file, 'utf8');
    await expect(
      f.company.retire(eid, 'owner', () => {
        throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
    expect(await readFile(f.file, 'utf8')).toBe(before);
  });
  it.each(['rewrite', 'regress', 'identity', 'policy'] as const)(
    'refuses %s lineage conflicts before the whole canonical transaction',
    async (mode) => {
      const f = await fixture(),
        before = await readFile(f.file, 'utf8');
      await expect(
        f.store.update((state) => {
          const row = state.dockerEmployeeContinuations![0]!;
          if (mode === 'rewrite') state.dockerSharedPoolLineages = [];
          else if (mode === 'regress') {
            const { role, name, imageId, configurationDigest } = row.tasks![1]!;
            row.tasks![1] = {
              role,
              name,
              imageId,
              configurationDigest,
              phase: 'create-issued',
            };
          } else if (mode === 'identity') row.request.sessionGeneration++;
          else row.policy.pool.cpuWeight++;
          state.employees = [];
        })
      ).rejects.toThrow('DOCKER_SHARED_POOL_LINEAGE_CHANGED');
      expect(await readFile(f.file, 'utf8')).toBe(before);
    }
  );
  it('retains unresolved START as unresolved and coalesces duplicates without promotion', () => {
    const row = record();
    const { role, name, imageId, configurationDigest } = row.tasks![1]!;
    row.tasks![1] = {
      role,
      name,
      imageId,
      configurationDigest,
      phase: 'start-issued',
      containerId: '2'.repeat(64),
    };
    const state = { dockerEmployeeContinuations: [row] };
    const retained = captureDockerSharedPoolLineages(state);
    expect(retained[0]!.configuration.phase).toBe('start-issued');
    expect(
      captureDockerSharedPoolLineages({
        ...state,
        dockerSharedPoolLineages: retained,
      })
    ).toEqual(retained);
  });
  it('budget exhaustion aborts row retirement without evicting unknown or completed proofs', async () => {
    const f = await fixture();
    for (let index = 1; index < 128; index++) {
      const operation = '33333333-3333-4333-8333-' + index.toString(16).padStart(12, '0');
      await f.store.update((state) => {
        state.dockerEmployeeContinuations = [record(operation)];
      });
    }
    const before = await readFile(f.file, 'utf8');
    await expect(
      f.store.update((state) => {
        state.dockerEmployeeContinuations = [record('ffffffff-ffff-4fff-8fff-ffffffffffff')];
        state.employees = [];
      })
    ).rejects.toThrow('DOCKER_SHARED_POOL_LINEAGE_LIMIT');
    expect(await readFile(f.file, 'utf8')).toBe(before);
    expect(f.store.snapshot().dockerSharedPoolLineages).toHaveLength(128);
  });
});
