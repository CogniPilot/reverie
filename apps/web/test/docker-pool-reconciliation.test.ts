/** Real controller, single canonical writer and authenticated API. Only native
 * Docker transport is controlled; no Engine, paid provider or personal data. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {
  fixture as physicalFixture,
  helper,
  policy,
  deployment,
  workerId,
  writer,
  restorer,
} from './helpers/docker-resource-physical.js';
import { DockerResourceRepairJournal } from '../src/docker-resource-repair-journal.js';
import { DockerResourceRevisionStore } from '../src/docker-resource-revisions.js';
import type { DockerContinuationTask } from '../src/docker-continuation-task.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import { DockerPoolReconciliation } from '../src/docker-pool-reconciliation.js';
import { DockerColdPoolJournal } from '../src/docker-cold-pool-journal.js';
import { PackagedDockerEngineCommand, dockerDeadPoolAnchorProven } from '../src/docker-engine-command.js';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import {
  DockerPoolReconciliationReceipt,
  DockerContainedResources,
} from '../src/docker-contained-resource-controller.js';
import { dockerResourceHelperConfiguration } from '../src/docker-resource-helper-inspection.js';
import { dockerPoolMetadataDigest } from '../src/docker-pool-observation-data.js';
import { DockerEmployeeContinuation, dockerContinuationDigest, type DockerContinuationEngine } from '../src/docker-employee-continuation.js';
import { registerDockerEmployeeContinuationRoutes } from '../src/web/routes/docker-employee-continuation-routes.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { ownerFor } from '../src/web/route-helpers.js';
import {
  DockerWorkerIdentityAuthentication,
  DOCKER_WORKER_IDENTITY_HEADER,
  dockerWorkerIdentityOf,
  registerDockerWorkerIdentity,
} from '../src/docker-worker-identity.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

async function restoredPoolFixture(pin = true, revisions?: DockerResourceRevisionStore) {
  const physical = physicalFixture('b'.repeat(64), revisions, revisions ? writer : undefined),
    boxId = 'b'.repeat(64),
    restoreImage = 'sha256:' + '9'.repeat(64);
  await physical.controller.preparePool(physical.row(), physical.current);
  const old = physical.tasks.get('pool-helper')!;
  if (!('containerId' in old)) throw Error('Actual helper required');
  const oldRaw = physical.containers.get(old.containerId)!;
  const seen = JSON.parse(physical.logs.get(old.containerId)!) as Record<string, unknown>;
  const oldArgs = (oldRaw.Config as { Cmd: string[] }).Cmd;
  const args = ['restore-pool', ...oldArgs.slice(1), '--member', `${workerId}:200:20`];
  physical.tasks.delete('pool-helper');
  physical.containers.delete(old.containerId);
  physical.makeWorker();
  const id = '8'.repeat(64),
    name = 'reverie-boxed-pool-helper-' + '7'.repeat(64);
  const parent = (seen.parent as { path: string }).path;
  const config = dockerResourceHelperConfiguration(
    boxId,
    'pool-helper',
    name,
    args,
    { path: parent, target: '/run/reverie-box-pool' },
    restoreImage
  );
  const mounts = (config.HostConfig as { Binds: string[] }).Binds.map((value) => {
    const [Source, Destination, mode] = value.split(':');
    return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
  });
  physical.containers.set(id, {
    Id: id,
    Name: '/' + name,
    Image: restoreImage,
    Config: structuredClone(config),
    HostConfig: structuredClone(config.HostConfig),
    Mounts: mounts,
    State: { Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, ExitCode: 0 },
  });
  const anchor = (seen.anchor as { id: string }).id;
  const member = (
    JSON.parse(await physical.command.run(['exec', anchor, '/bin/reverie-docker-resources', 'probe-worker'])) as {
      worker: unknown;
    }
  ).worker;
  physical.logs.set(
    id,
    JSON.stringify({ version: 1, purpose: 'reverie-boxed-restore-pool-ack-v1', observation: seen, members: [member] })
  );
  const command = {
    ...physical.command,
    run: async (args: readonly string[]) => {
      if (args[0] === 'image' && args[2] === restoreImage)
        return JSON.stringify([
          {
            Id: restoreImage,
            Config: {
              User: '0:0',
              Entrypoint: ['/bin/reverie-docker-resources'],
              Labels: { 'org.reverie.purpose': 'boxed-resource-helper-v1', 'org.reverie.resource.pool-restore': 'v1' },
            },
          },
        ]);
      const output = await physical.command.run(args);
      if (args[0] === 'exec' && args.includes('probe-worker') && args.includes('--worker-id')) {
        const id = args[args.indexOf('--worker-id') + 1]!,
          current = physical.containers.get(id);
        if (!current) throw Error('The actual current fixture worker is missing');
        const seen = JSON.parse(output) as { worker: { id: string; pid: number; path: string; ino: string } };
        seen.worker = {
          ...seen.worker,
          id,
          pid: (current.State as { Pid: number }).Pid,
          path: parent + '/docker-' + id + '.scope',
          ino: id === workerId ? '4' : '5',
        };
        return JSON.stringify(seen);
      }
      return output;
    },
  };
  let members = [workerId];
  let retained: DockerContinuationTask[] = [];
  const controller = new DockerContainedResources(
    command,
    physical.journal,
    {
      boxId,
      deployment,
      helperImageId: helper,
      poolRestoreHelperImageId: pin ? restoreImage : undefined,
      memoryHighHelperImageId: revisions ? writer : undefined,
      selectedWorkerContainerIds: () => members,
      retainedPoolConfigurationTasks: () => retained,
    },
    revisions
  );
  const before = { creates: [...physical.creates], starts: [...physical.starts] };
  return {
    physical,
    controller,
    id,
    restoreImage,
    before,
    config,
    seen,
    setMembers: (ids: string[]) => {
      members = [...ids];
    },
    retainPool: (tasks: DockerContinuationTask[]) => {
      retained = structuredClone(tasks);
    },
  };
}

describe('separately pinned populated-pool restore ACK adoption', () => {
  it.each(['completed', 'start-issued', 'ambiguous'] as const)(
    'checks another valid pool receipt when an older writer is absent and %s',
    async (state) => {
      const f = await restoredPoolFixture();
      const current = (await f.controller.capturePoolObservation(policy.pool, f.physical.current)).snapshot(
        f.physical.current
      ).configuration;
      const removed = 'be'.repeat(32);
      const old: DockerContinuationTask =
        state === 'start-issued'
          ? {
              role: current.role,
              name: current.name,
              imageId: current.imageId,
              configurationDigest: current.configurationDigest,
              phase: 'start-issued',
              containerId: removed,
            }
          : { ...current, containerId: removed };
      f.retainPool([old, current]);
      f.physical.beforeRun((args) => {
        if (args[0] === 'container' && args[1] === 'inspect' && args[2] === removed)
          throw Error('Pool writer inspection failed');
        if (state === 'ambiguous' && args[0] === 'container' && args[1] === 'ls' && args.includes('id=' + removed))
          throw Error('Pool writer census unavailable');
      });
      if (state === 'completed') {
        await expect(f.controller.observePool(f.physical.row())).resolves.toMatchObject({
          policyDigest: expect.any(String),
        });
        f.retainPool([old]);
        await expect(f.controller.observePool(f.physical.row())).rejects.toThrow(
          'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED'
        );
        const receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current);
        expect(receipt.snapshot(f.physical.current).configuration).toEqual(current);
      } else {
        const reason = state === 'ambiguous' ? 'Pool writer census unavailable' : 'Pool writer inspection failed';
        await expect(f.controller.observePool(f.physical.row())).rejects.toThrow(reason);
        await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow(reason);
      }
      expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
    }
  );

  it.each(['retired', 'replaced', 'new-current', 'same-cid-new-pid'] as const)(
    'keeps a genuine historical restore ACK after a member is %s while probing only the current complete scope',
    async (change) => {
      const f = await restoredPoolFixture(),
        old = structuredClone(f.physical.containers.get(workerId)!),
        current = '6'.repeat(64);
      const calls: string[][] = [];
      if (change === 'retired' || change === 'replaced') f.physical.containers.delete(workerId);
      if (change === 'replaced' || change === 'new-current') {
        old.Id = current;
        (old.State as Record<string, unknown>).Pid = 300;
        f.physical.containers.set(current, old);
        f.setMembers(change === 'replaced' ? [current] : [workerId, current]);
      } else if (change === 'retired') f.setMembers([]);
      else (f.physical.containers.get(workerId)!.State as Record<string, unknown>).Pid = 300;
      f.physical.beforeRun((args) => {
        calls.push([...args]);
        if (
          (change === 'retired' || change === 'replaced') &&
          args[0] === 'container' &&
          args[1] === 'inspect' &&
          args[2] === workerId
        )
          throw Error('Historical CID must never be queried');
      });
      const before = {
        creates: [...f.physical.creates],
        starts: [...f.physical.starts],
        tasks: structuredClone([...f.physical.tasks]),
        ack: f.physical.logs.get(f.id),
        configuration: structuredClone(f.physical.containers.get(f.id)),
      };
      const receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current);
      expect(receipt.snapshot(f.physical.current)).toMatchObject({ version: 2, configuration: { containerId: f.id } });
      expect({
        creates: f.physical.creates,
        starts: f.physical.starts,
        tasks: [...f.physical.tasks],
        ack: f.physical.logs.get(f.id),
        configuration: f.physical.containers.get(f.id),
      }).toEqual(before);
      const probes = calls.filter((args) => args[0] === 'exec' && args.includes('probe-pool'));
      expect(probes.length).toBeGreaterThanOrEqual(2);
      if (change === 'replaced' || change === 'new-current')
        expect(probes.every((args) => args.includes(current + ':300:20'))).toBe(true);
      if (change === 'retired') expect(probes.every((args) => !args.includes('--member'))).toBe(true);
      if (change === 'same-cid-new-pid') expect(probes.every((args) => args.includes(workerId + ':300:20'))).toBe(true);
    }
  );
  it('propagates a fresh Rust FOREIGN_CHILD refusal despite a valid historical restore ACK', async () => {
    const f = await restoredPoolFixture();
    let probes = 0;
    f.physical.beforeRun((args) => {
      if (args[0] === 'exec' && args.includes('probe-pool') && ++probes === 2)
        throw Error('BOXED_RESOURCE_FOREIGN_CHILD');
    });
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow(
      'BOXED_RESOURCE_FOREIGN_CHILD'
    );
    expect(probes).toBe(2);
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
  it('keeps v2 pool proof and repaired original16 leaf ACK through approved48 and a later member joining', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'pool-leaf-membership-')),
      revisions = new DockerResourceRevisionStore(join(directory, 'revisions'));
    cleanups.push(async () => {
      revisions.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const f = await restoredPoolFixture(true, revisions),
      receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current);
    const canonical = new CompanyStore(join(directory, 'company.json'));
    await canonical.init();
    expect(
      (
        await canonical.publishDockerPoolObservation(
          receipt,
          dockerPoolMetadataDigest(canonical.snapshot()),
          f.physical.current
        )
      ).state
    ).toBe('committed');
    f.retainPool(canonical.snapshot().dockerPoolObservations!.map((row) => row.configuration));
    f.physical.row().pool = (await f.controller.observePool(f.physical.row()))!;
    await f.controller.configure(f.physical.row(), f.physical.current);
    f.physical.ready();
    const original = f.physical.tasks.get('leaf-helper')!;
    if (original.phase !== 'completed') throw Error('Actual completed helper required');
    const replacement = structuredClone(f.physical.containers.get(original.containerId)!),
      replacementId = 'f'.repeat(64),
      name = 'reverie-boxed-leaf-helper-' + 'e'.repeat(64);
    replacement.Id = replacementId;
    replacement.Name = '/' + name;
    (replacement.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] = name;
    f.physical.containers.set(replacementId, replacement);
    f.physical.logs.set(replacementId, f.physical.logs.get(original.containerId)!);
    f.physical.containers.delete(original.containerId);
    f.physical.logs.delete(original.containerId);
    expect(await f.controller.read(f.physical.row())).toEqual(policy);
    const desired = {
      revision: '44444444-4444-4444-8444-444444444444',
      owner: null,
      scope: 'all-current-and-future' as const,
      memoryHighBytes: 48 * 1024 ** 3,
    };
    await revisions.approve(desired, null, f.physical.current);
    const result = await f.controller.reviseMemoryHigh(f.physical.row(), desired.revision, f.physical.current);
    expect(result).toEqual({ state: 'applied', policy: { ...policy, memoryHighBytes: 48 * 1024 ** 3 } });
    const joined = '6'.repeat(64),
      raw = structuredClone(f.physical.containers.get(workerId)!);
    raw.Id = joined;
    (raw.State as Record<string, unknown>).Pid = 300;
    f.physical.containers.set(joined, raw);
    f.setMembers([workerId, joined]);
    const before = {
      creates: [...f.physical.creates],
      starts: [...f.physical.starts],
      tasks: structuredClone([...f.physical.tasks]),
      row: structuredClone(f.physical.row()),
    };
    expect(await f.controller.read(f.physical.row())).toEqual(result.policy);
    expect(await f.controller.observeMemoryHigh(f.physical.row(), f.physical.current)).toMatchObject({
      approved: true,
      actualMemoryHighBytes: 48 * 1024 ** 3,
    });
    expect({
      creates: f.physical.creates,
      starts: f.physical.starts,
      tasks: [...f.physical.tasks],
      row: f.physical.row(),
    }).toEqual(before);
  });
  it('publishes and reloads strict v2 correlation while the actual anchor retains its old image', async () => {
    const f = await restoredPoolFixture();
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current);
    const directory = await fs.mkdtemp(join(tmpdir(), 'restore-pool-observation-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const result = await store.publishDockerPoolObservation(
      receipt,
      dockerPoolMetadataDigest(store.snapshot()),
      f.physical.current
    );
    expect(result.state).toBe('committed');
    const restarted = new CompanyStore(join(directory, 'company.json'));
    await restarted.init();
    expect(restarted.snapshot().dockerPoolObservations?.[0]).toMatchObject({
      version: 2,
      helperImageId: helper,
      poolRestoreHelperImageId: f.restoreImage,
      anchorTask: { imageId: helper },
      configuration: { imageId: f.restoreImage, containerId: f.id },
    });
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
  it.each([
    'missing-pin',
    'missing-member',
    'missing-member-argument',
    'foreign-member-argument',
    'foreign-member',
    'stale-birth',
    'wrong-purpose',
    'wrong-command',
    'wrong-image',
    'running',
    'extra-mount',
    'epoch-drift',
  ] as const)('refuses %s without any native effects', async (mode) => {
    const f = await restoredPoolFixture(mode !== 'missing-pin');
    const raw = f.physical.containers.get(f.id)!,
      config = raw.Config as { Cmd: string[] },
      ack = JSON.parse(f.physical.logs.get(f.id)!) as {
        purpose: string;
        members: Array<{ id: string; startTicks: string }>;
      };
    if (mode === 'missing-member') ack.members = [];
    if (mode === 'missing-member-argument') config.Cmd.splice(-2);
    if (mode === 'foreign-member-argument') config.Cmd[config.Cmd.length - 1] = `${'6'.repeat(64)}:200:20`;
    if (mode === 'foreign-member') ack.members[0]!.id = '6'.repeat(64);
    if (mode === 'stale-birth') ack.members[0]!.startTicks = '21';
    if (mode === 'wrong-purpose') ack.purpose = 'reverie-boxed-resource-observation-v1';
    if (mode === 'wrong-command') config.Cmd[0] = 'configure-pool';
    if (mode === 'wrong-image') raw.Image = helper;
    if (mode === 'running')
      raw.State = {
        Status: 'running',
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 400,
        ExitCode: 0,
      };
    if (mode === 'extra-mount')
      (raw.Mounts as unknown[]).push({ Type: 'bind', Source: '/foreign', Destination: '/foreign', RW: true });
    if (mode === 'epoch-drift') f.physical.driftEpoch();
    f.physical.logs.set(f.id, JSON.stringify(ack));
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow();
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
  it('holds the original read when authority is revoked across a native observation await', async () => {
    const f = await restoredPoolFixture();
    let revoked = false;
    f.physical.beforeRun((args) => {
      if (!revoked && args[0] === 'container' && args[1] === 'logs' && args[2] === f.id) {
        revoked = true;
        f.physical.revoke();
      }
    });
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow('revoked');
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
  it('a lost v2 publication reply requires fresh original native inspection after reload and never reissues the restore', async () => {
    const f = await restoredPoolFixture(),
      directory = await fs.mkdtemp(join(tmpdir(), 'restore-pool-lost-ack-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'company.json'),
      store = new CompanyStore(file);
    await store.init();
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current),
      rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (a, b) => {
      await rename(a, b);
      throw Error('Lost canonical rename reply');
    });
    expect(
      (
        await store.publishDockerPoolObservation(
          receipt,
          dockerPoolMetadataDigest(store.snapshot()),
          f.physical.current
        )
      ).state
    ).toBe('unconfirmed');
    vi.restoreAllMocks();
    const restarted = new CompanyStore(file);
    await restarted.init();
    expect(restarted.snapshot().dockerPoolObservations?.[0]?.configuration.containerId).toBe(f.id);
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).resolves.toBeInstanceOf(
      DockerPoolReconciliationReceipt
    );
    f.physical.logs.set(f.id, '{}');
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow();
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
});

const actor = '99999999-9999-4999-8999-999999999999',
  actorSid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(options: { recover?: boolean; cold?: boolean; repair?: boolean } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'pool-reconcile-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const repairFile = join(directory, 'docker-resource-repair.jsonl');
  // A published laptop record with its running anchor, as the cold recovery and the in-place repair both need.
  const recorded = options.cold || options.repair;
  const physical = options.repair
    ? physicalFixture('b'.repeat(64), undefined, undefined, undefined, {
        journal: new DockerResourceRepairJournal(repairFile, 'b'.repeat(64)),
        path: repairFile,
        restoreImage: restorer,
      })
    : physicalFixture();
  await physical.controller.preparePool(physical.row(), physical.current);
  const completed = physical.tasks.get('pool-helper')!;
  if (!('containerId' in completed)) throw Error('Actual fixture helper CID required');
  if (recorded) await physical.setPool();
  physical.tasks.delete('pool-helper');
  physical.retain([]);
  const beforeEffects = { creates: [...physical.creates], starts: [...physical.starts] };
  const companyFile = join(directory, 'company.json'),
    coldFile = join(directory, 'cold-pool.jsonl'),
    companyStore = new CompanyStore(companyFile);
  await companyStore.init();
  const sessions = new Map([[actorSid, { id: actorSid, name: 'Scoped coordinator', owner: undefined }]]);
  const deps = {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps;
  const company = new CompanyService(companyStore, deps),
    eid = physical.row().employeeId,
    sid = physical.row().request.sessionId,
    generation = physical.row().request.sessionGeneration;
  await companyStore.update((state) => {
    state.employees = [
      EmployeeSchema.parse({
        id: actor,
        sessionId: actorSid,
        sessionGeneration: 1,
        name: 'Scoped coordinator',
        icon: 'C',
        position: 'Engineer',
        expertise: ['synthetic'],
        createdAt: 1,
        onVacation: false,
        desiredRunning: true,
        permissions: { recoverEmployees: options.recover ?? true, manageOffice: false },
      }),
      EmployeeSchema.parse({
        id: eid,
        sessionId: sid,
        sessionGeneration: generation,
        name: 'Target',
        icon: 'T',
        position: 'Employee',
        expertise: ['synthetic'],
        createdAt: 1,
        onVacation: !recorded,
        desiredRunning: !!recorded,
        dockerResourcePolicy: policy,
      }),
    ];
  });
  const store = new CompanyDockerContinuationStore(company, () => undefined);
  let runtime = true,
    identity = true;
  const runtimeCurrent = () => {
    if (!runtime) throw Error('Synthetic runtime revoked');
  };
  const resources = physical.controllerWith(() =>
    store.retainedPoolConfigurationTasks('reverie-boxed-anchor-' + 'b'.repeat(32), helper, 'b'.repeat(64))
  );
  const anchor = physical.tasks.get('anchor');
  if (anchor?.phase !== 'running') throw Error('Original fixture anchor required');
  const service = new DockerPoolReconciliation(
    company, store, resources, runtimeCurrent, options.cold ? new DockerColdPoolJournal(coldFile) : undefined
  );
  if (recorded) {
    const original = {
      containerId: 'c'.repeat(64), imageId: 'sha256:' + 'd'.repeat(64), deployment, employeeId: eid, sessionId: sid,
      home: { type: 'bind', source: '/synthetic/home', destination: '/home/agent', readWrite: true },
      mountDigest: '1'.repeat(64), storageDigest: '2'.repeat(64), configurationDigest: '3'.repeat(64),
    };
    const source = physical.row();
    const row = DockerEmployeeContinuationRecord.parse({
      version: 1, purpose: 'docker-employee-continuation-v1', employeeId: eid, sourceDigest: '4'.repeat(64),
      original, policy, request: {
        ...source.request, containerId: original.containerId, imageId: original.imageId, expectedPolicyDigest: '5'.repeat(64),
        expectedDestinationImageId: source.workerImage.imageId, enterOffice: false,
      },
      workerImage: { ...source.workerImage, sourceImageId: original.imageId, clientManifestDigest: '6'.repeat(64) },
      credentialId: '44444444-4444-4444-8444-444444444444', phase: 'pool-ready',
      pool: source.pool, tasks: [anchor, completed],
    });
    await companyStore.update((state) => { state.dockerEmployeeContinuations = [row]; });
    const before = await resources.capturePoolObservation(policy.pool, runtimeCurrent);
    expect((await companyStore.publishDockerPoolObservation(
      before, dockerPoolMetadataDigest(companyStore.snapshot()), runtimeCurrent
    )).state).toBe('committed');
    if (options.cold) physical.containers.get(anchor.containerId)!.State = {
      Status: 'exited', Running: false, Restarting: false, Paused: false, Dead: false, Pid: 0,
      OOMKilled: false, Error: '', ExitCode: 255, StartedAt: '2026-11-18T08:00:00Z', FinishedAt: '2026-11-19T09:00:00Z',
    };
  }
  const ownerAuth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const ownerToken = await ownerAuth.setup(
    'synthetic-owner',
    'Synthetic-only-Ocean42!',
    'Synthetic-only-Ocean42!',
    '127.0.0.1'
  );
  const binding = {
    owner: undefined,
    employeeId: actor,
    sessionId: actorSid,
    sessionGeneration: 1,
    containerId: '9'.repeat(64),
    credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const authentication = new DockerWorkerIdentityAuthentication(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    Buffer.alloc(32, 0x53),
    { binding: () => (identity ? binding : undefined), keyCurrent: () => runtime }
  );
  const token = authentication.issue(binding, () => true);
  const app = Fastify();
  await app.register(cookie);
  registerDockerWorkerIdentity(app, authentication, '', { requireMachineProof: true });
  const authState = registerAuthMiddleware(app, false, '', ownerAuth);
  const ctx = { sessions } as unknown as SessionPort;
  registerOwnerPolicy(app, {
    service: ownerAuth,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: (id) => sessions.has(id),
      related: (a, b) => a === b,
      coordinated: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  const forbidden = new Proxy({} as DockerContinuationEngine, {
    get() {
      throw Error('Business Engine port is forbidden');
    },
  });
  const continuation = new DockerEmployeeContinuation(
    store,
    forbidden,
    {
      launch: async () => {
        throw Error('Provider is forbidden');
      },
    },
    {
      issue: () => {
        throw Error('Credential issue is forbidden');
      },
    }
  );
  registerDockerEmployeeContinuationRoutes(
    app,
    company,
    store,
    continuation,
    {
      verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
      owner: ownerFor,
      worker: dockerWorkerIdentityOf,
    },
    undefined,
    service
  );
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    authentication.close();
    for (const timer of Object.values(authState)) timer?.dispose();
  });
  const url = '/api/company/employees/' + eid + '/docker-pool';
  const ownerHeaders = { cookie: 'reverie_owner=' + ownerToken, origin: 'http://localhost', host: 'localhost' };
  const workerHeaders = { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': actorSid };
  const authority = () => {
    const grant = company.recoveryAction(eid, undefined);
    return {
      owner: undefined,
      require: () => grant.require(),
      requireOffice: () => {
        throw Error('Office permission not used');
      },
    };
  };
  const body = (scopeDigest: string) => ({
    sessionId: sid,
    sessionGeneration: generation,
    expectedScopeDigest: scopeDigest,
  });
  const effects = () => expect({ creates: physical.creates, starts: physical.starts }).toEqual(beforeEffects);
  return {
    physical,
    completed,
    anchor,
    coldFile,
    directory,
    companyFile,
    companyStore,
    company,
    store,
    service,
    app,
    url,
    ownerHeaders,
    workerHeaders,
    authority,
    body,
    effects,
    deps,
    eid,
    revokeRuntime: () => {
      runtime = false;
    },
    revokeIdentity: () => {
      identity = false;
    },
  };
}
describe('in-place repair of a running shared pool', () => {
  const other = '8'.repeat(64);
  /** Another laptop runs in the pool, and a reload of the service manager reset the pool's limits. */
  async function reloaded(options: { recover?: boolean; lostOriginal?: boolean } = {}) {
    const f = await fixture({ repair: true, recover: options.recover });
    f.physical.addMember(other, 300);
    if (options.lostOriginal) {
      f.physical.containers.delete(f.completed.containerId);
      f.physical.logs.delete(f.completed.containerId);
    }
    f.physical.reloadServiceManager();
    return f;
  }
  const status = async (f: Awaited<ReturnType<typeof fixture>>, headers = f.ownerHeaders) =>
    (await f.app.inject({ method: 'GET', url: f.url + '/status', headers })).json().data as {
      state: string;
      code?: string;
      scopeDigest?: string;
      allowedActions: string[];
    };
  const repair = (f: Awaited<ReturnType<typeof fixture>>, scopeDigest: string, headers = f.ownerHeaders) =>
    f.app.inject({ method: 'POST', url: f.url + '/repair', headers, payload: f.body(scopeDigest) });
  const restores = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.physical.configurations.filter(({ config }) => (config.Cmd as string[])[0] === 'restore-pool');

  it('offers the repair for a populated pool whose limits changed, and restores them without touching any record', async () => {
    const f = await reloaded();
    const held = await status(f);
    expect(held).toMatchObject({ state: 'held', code: 'DOCKER_POOL_POLICY_CHANGED', allowedActions: ['repair-pool'] });
    f.effects();
    const before = structuredClone(f.companyStore.snapshot());
    // The request confirms the hold the status named; anything else writes nothing.
    const stale = await repair(f, '0'.repeat(64));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('DOCKER_POOL_SCOPE_CHANGED');
    f.effects();
    const result = await repair(f, held.scopeDigest!);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({ state: 'retained', allowedActions: [] });
    expect(restores(f)).toHaveLength(1);
    const args = restores(f)[0]!.config.Cmd as string[];
    expect(args.filter((_value, index) => args[index - 1] === '--member')).toEqual([`${other}:300:20`]);
    // The approved policy, the employee and the laptop record are exactly as they were.
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(await status(f)).toMatchObject({ state: 'retained', allowedActions: [] });
    // Sent again, it finds nothing to do.
    const again = await repair(f, held.scopeDigest!);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ state: 'retained' });
    expect(restores(f)).toHaveLength(1);
  });

  it('records the restore as the pool’s observation when the earlier acknowledgement is gone', async () => {
    const f = await reloaded({ lostOriginal: true });
    const held = await status(f);
    expect(held).toMatchObject({ state: 'held', allowedActions: ['repair-pool'] });
    const before = f.companyStore.snapshot();
    const result = await repair(f, held.scopeDigest!);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({ state: 'retained', allowedActions: [] });
    const after = f.companyStore.snapshot();
    expect(after.dockerPoolObservations).toHaveLength((before.dockerPoolObservations ?? []).length + 1);
    expect(after.dockerPoolObservations!.at(-1)).toMatchObject({ version: 2, poolRestoreHelperImageId: restorer });
    expect(after.employees).toEqual(before.employees);
    expect(after.dockerEmployeeContinuations).toEqual(before.dockerEmployeeContinuations);
  });

  it('re-earns an acknowledgement for intact limits that nothing on record confirms', async () => {
    const f = await fixture({ repair: true });
    f.physical.addMember(other, 300);
    f.physical.containers.delete(f.completed.containerId);
    f.physical.logs.delete(f.completed.containerId);
    const held = await status(f);
    expect(held).toMatchObject({ state: 'held', code: 'DOCKER_POOL_ORIGINAL_ACK_MISSING', allowedActions: ['repair-pool'] });
    const result = await repair(f, held.scopeDigest!);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({ state: 'retained' });
    expect(restores(f)).toHaveLength(1);
  });

  it('takes the same recovery permission as reconcile, and nothing without it', async () => {
    const granted = await reloaded();
    const held = await status(granted, granted.workerHeaders);
    expect(held.allowedActions).toEqual(['repair-pool']);
    const result = await repair(granted, held.scopeDigest!, granted.workerHeaders);
    expect(result.statusCode, result.body).toBe(200);
    const denied = await reloaded({ recover: false });
    const refused = await repair(denied, '0'.repeat(64), denied.workerHeaders);
    expect(refused.statusCode).toBe(403);
    denied.effects();
  });

  it('offers no repair for a hold that re-applying the limits does not settle', async () => {
    const f = await fixture({ repair: true });
    // A writer on record that may still be writing: nothing is issued beside it.
    (f.physical.containers.get(f.completed.containerId)!.State as Record<string, unknown>).Running = true;
    const held = await status(f);
    expect(held.state).toBe('held');
    expect(held.allowedActions).toEqual([]);
    const refused = await repair(f, '0'.repeat(64));
    expect(refused.statusCode, refused.body).toBe(200);
    expect(refused.json().data.allowedActions).toEqual([]);
    f.effects();
  });
});

describe('owner recovery of a stopped shared pool', () => {
  async function preview(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.ownerHeaders });
    expect(result.statusCode, result.body).toBe(200);
    return result.json().data.scopeDigest as string;
  }
  function recover(f: Awaited<ReturnType<typeof fixture>>, expected: string, operationId: string) {
    return f.app.inject({ method: 'POST', url: f.url + '/cold-recover', headers: f.ownerHeaders,
      payload: { ...f.body(expected), operationId } });
  }
  async function latest(f: Awaited<ReturnType<typeof fixture>>) {
    const lines = (await fs.readFile(f.coldFile, 'utf8')).trimEnd().split('\n');
    return JSON.parse(lines.at(-1)!);
  }
  function observeEffects(f: Awaited<ReturnType<typeof fixture>>, operationId: string, lostReply = false) {
    const command = f.physical.command;
    const run = command.run.bind(command);
    const create = command.create.bind(command);
    const effects: string[] = [];
    vi.spyOn(command, 'run').mockImplementation(async (args) => {
      if (args[0] !== 'container' || args[1] !== 'start') return run(args);
      const entry = await latest(f);
      expect(entry.scope.operationId).toBe(operationId);
      if (args[2] === f.anchor.containerId) {
        expect(entry.task).toBeUndefined();
        effects.push('start original anchor');
        const raw = f.physical.containers.get(f.anchor.containerId)!;
        raw.State = { ...raw.State as object, Running: true, Status: 'running', Pid: 100,
          StartedAt: '2026-11-19T09:01:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 };
        f.physical.driftEpoch();
        f.physical.requireConfigure();
        if (lostReply) throw Error('Lost original anchor start reply');
        return args[2];
      }
      expect(entry.task.phase).toBe('start-issued');
      expect(entry.task.containerId).toBe(args[2]);
      f.physical.tasks.set('pool-helper', entry.task);
      effects.push('start pool helper');
      return run(args);
    });
    vi.spyOn(command, 'create').mockImplementation(async (name, configuration, current) => {
      const entry = await latest(f);
      expect(entry.scope.operationId).toBe(operationId);
      expect(entry.task.phase).toBe('create-issued');
      expect(entry.task.name).toBe(name);
      f.physical.tasks.set('pool-helper', entry.task);
      effects.push('create pool helper');
      return create(name, configuration, current);
    });
    return effects;
  }
  it('journals every effect and publishes a fresh native ACK without altering the employee or its launch record', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id);
    const prior = f.companyStore.snapshot();
    const scope = await preview(f);
    const unauthorized = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.workerHeaders });
    expect(unauthorized.statusCode).toBe(403);
    const stale = await recover(f, '0'.repeat(64), id);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('DOCKER_POOL_COLD_SOURCE_CHANGED');
    expect(effects).toEqual([]);
    const result = await recover(f, scope, id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.state).toBe('retained');
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
    const after = f.companyStore.snapshot();
    expect(after.employees).toEqual(prior.employees);
    expect(after.dockerEmployeeContinuations).toEqual(prior.dockerEmployeeContinuations);
    const fresh = after.dockerPoolObservations?.find(record => record.epoch.anchor.startTicks === '999');
    expect(fresh?.anchorTask.containerId).toBe(f.anchor.containerId);
    expect(fresh?.configuration.containerId).not.toBe(f.completed.containerId);
    expect((await latest(f)).observationDigest).toBe(dockerContinuationDigest(fresh));
  });
  it('holds the durable original attempt if its exact anchor START reply is lost', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id, true);
    const scope = await preview(f);
    const result = await recover(f, scope, id);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().error.code).toBe('DOCKER_CONTINUATION_UNCONFIRMED');
    expect(effects).toEqual(['start original anchor']);
    expect((await latest(f)).scope.operationId).toBe(id);
    expect(() => new DockerColdPoolJournal(f.coldFile).requireIdle()).toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
    const status = await f.app.inject({ method: 'GET', url: f.url + '/status', headers: f.ownerHeaders });
    expect(status.json().data).toMatchObject({ state: 'held', code: 'DOCKER_POOL_COLD_ATTEMPT_HELD' });
    const replay = await recover(f, scope, randomUUID());
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('DOCKER_POOL_COLD_ATTEMPT_HELD');
    expect(effects).toEqual(['start original anchor']);
  });

  it('recovers the pool from the record that a rebuild retired, while the employee has no laptop record', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id);
    const row = f.companyStore.snapshot().dockerEmployeeContinuations![0]!;
    const entry = (operationId: string, patch: Record<string, unknown>) => ({
      version: 1, purpose: 'docker-absent-continuation-retirement-v1', retiredAt: 1, operationId,
      employeeId: f.eid, sessionId: row.request.sessionId, sessionGeneration: row.request.sessionGeneration,
      scopeDigest: '7'.repeat(64), templateDigest: '8'.repeat(64),
      template: { user: '1000:1000', scratchRoot: '/host/scratch/laptops', mounts: [] },
      binding: null, session: { phase: 'cleared', containerName: null }, source: { phase: 'pending' },
      ...patch,
    });
    const retiredBy = randomUUID();
    await f.companyStore.update((state) => {
      // What a rebuild leaves: no laptop record, and the retired one in the history.
      state.dockerEmployeeContinuations = [];
      state.retiredDockerEmployeeContinuations = [
        entry(retiredBy, {
          reason: 'recorded-containers-absent', record: row,
          absent: { containerIds: ['c'.repeat(64)], planMoveIds: [] },
        }),
        // The unused source of that rebuild was replaced since: the newest entry retired no record.
        entry(randomUUID(), {
          reason: 'source-replaced', previous: retiredBy,
          removal: { phase: 'removed', name: 'reverie-boxed-source-' + 'a'.repeat(64), containerId: 'd'.repeat(64) },
          absent: { containerIds: [], planMoveIds: [] },
        }),
      ] as never;
    });
    expect(f.store.record(f.eid)).toBeUndefined();
    expect(f.companyStore.snapshot().retiredDockerEmployeeContinuations).toHaveLength(2);
    const result = await recover(f, await preview(f), id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.state).toBe('retained');
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
  });
  // What a host restart can leave behind. Each state has a way forward, or its own code.
  const anchorState = (f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown>) => {
    const raw = f.physical.containers.get(f.anchor.containerId)!;
    raw.State = { ...(raw.State as object), ...patch };
  };
  it.each([
    ['stopped with the host', { ExitCode: 137 }],
    ['killed for memory', { ExitCode: 137, OOMKilled: true }],
    ['left by a start that failed', { ExitCode: 128, Error: 'failed to create task for container: timeout' }],
  ])('starts an anchor that was %s', async (_name, patch) => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id);
    anchorState(f, patch);
    const result = await recover(f, await preview(f), id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.state).toBe('retained');
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
  });
  it.each([
    ['dead', { Status: 'dead', Dead: true }, 'DOCKER_POOL_COLD_ANCHOR_DEAD'],
    ['paused', { Status: 'paused', Paused: true, Running: true, Pid: 7 }, 'DOCKER_POOL_COLD_ANCHOR_NOT_STOPPED'],
    ['restarting', { Status: 'restarting', Restarting: true }, 'DOCKER_POOL_COLD_ANCHOR_NOT_STOPPED'],
  ])('names an anchor that is %s with a code of its own, and starts nothing', async (_name, patch, code) => {
    const f = await fixture({ cold: true }), effects = observeEffects(f, randomUUID());
    anchorState(f, patch);
    const refused = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.ownerHeaders });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe(code);
    expect(effects).toEqual([]);
  });
  const leftover = (f: Awaited<ReturnType<typeof fixture>>, id: string, state: Record<string, unknown>) => {
    const raw = structuredClone(f.physical.containers.get(f.completed.containerId)!);
    raw.Id = id;
    (raw.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] =
      'reverie-boxed-pool-helper-' + id;
    raw.State = { Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, ...state };
    f.physical.containers.set(id, raw);
  };
  // An anchor the Engine failed to remove or stop. It can be neither started nor used again.
  const dead = async () => {
    const f = await fixture({ cold: true });
    anchorState(f, { Status: 'dead', Dead: true });
    const command = f.physical.command,
      removed: string[] = [];
    let engine: Error | undefined;
    // The real port method, over this fixture's Engine.
    command.removeDeadPoolAnchor = (id, proof, current) =>
      PackagedDockerEngineCommand.prototype.removeDeadPoolAnchor.call(command, id, proof, current);
    const run = command.run.bind(command);
    vi.spyOn(command, 'run').mockImplementation(async (args, input) => {
      if (args[0] !== 'container' || args[1] !== 'rm') return run(args, input);
      expect(args).toEqual(['container', 'rm', f.anchor.containerId]);
      if (engine) throw engine;
      removed.push(args[2]!);
      f.physical.containers.delete(args[2]!);
      return args[2]!;
    });
    const remove = () =>
      f.app.inject({ method: 'POST', url: f.url + '/remove-dead-anchor', headers: f.ownerHeaders, payload: {} });
    return { f, removed, remove, refuseWith: (error: Error | undefined) => (engine = error) };
  };
  it('removes a dead anchor through the re-proving removal, and the next laptop set-up creates the pool again', async () => {
    const { f, removed, remove } = await dead();
    const prior = f.companyStore.snapshot();
    const status = await f.app.inject({ method: 'GET', url: f.url + '/status', headers: f.ownerHeaders });
    expect(status.json().data).toMatchObject({ state: 'held', code: 'DOCKER_RESOURCE_CONTAINER_UNKNOWN' });
    const unauthorized = await f.app.inject({
      method: 'POST', url: f.url + '/remove-dead-anchor', headers: f.workerHeaders, payload: {},
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(removed).toEqual([]);
    const result = await remove();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toEqual({ state: 'removed' });
    expect(removed).toEqual([f.anchor.containerId]);
    // No employee, laptop record or pool observation was touched.
    expect(f.companyStore.snapshot()).toEqual(prior);
    // No anchor is left, so no record can stand for a pool any more: nothing is waited for.
    const after = await f.app.inject({ method: 'GET', url: f.url + '/status', headers: f.ownerHeaders });
    expect(after.json().data).toMatchObject({ state: 'held', code: 'DOCKER_POOL_ANCHOR_UNCONFIRMED' });
    const preview = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.ownerHeaders });
    expect(preview.json().error.code).toBe('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    // A laptop set-up that has no anchor of its own yet creates one under the same fixed name and starts it.
    // (This fixture has one laptop operation. A new one has a pool helper of its own name, so the earlier
    // operation's helper container is taken out of the way here.)
    f.physical.tasks.delete('anchor');
    f.physical.tasks.delete('pool-helper');
    f.physical.containers.delete(f.completed.containerId);
    f.physical.driftEpoch();
    f.physical.requireConfigure();
    await f.physical.controller.preparePool(f.physical.row(), f.physical.current);
    const created = f.physical.tasks.get('anchor');
    expect(created?.phase).toBe('running');
    expect((created as { containerId: string }).containerId).not.toBe(f.anchor.containerId);
    expect((f.physical.containers.get((created as { containerId: string }).containerId)!.State as { Running: boolean }).Running).toBe(true);
  });
  it('shows the engine’s own words when it refuses to remove the dead anchor, and changes nothing', async () => {
    const { f, removed, remove, refuseWith } = await dead();
    refuseWith(
      new Error(
        'Command failed: docker container rm ' + f.anchor.containerId +
          '\nError response from daemon: container ' + f.anchor.containerId.slice(0, 12) +
          ': driver "overlay2" failed to remove root filesystem: device or resource busy\n'
      )
    );
    const refused = await remove();
    expect(refused.statusCode, refused.body).toBe(200);
    expect(refused.json().data).toEqual({
      state: 'refused',
      engine:
        'Error response from daemon: container ' + f.anchor.containerId.slice(0, 12) +
        ': driver "overlay2" failed to remove root filesystem: device or resource busy',
    });
    expect(removed).toEqual([]);
    expect(f.physical.containers.has(f.anchor.containerId)).toBe(true);
    // The engine lets go: the same call removes it.
    refuseWith(undefined);
    expect((await remove()).json().data).toEqual({ state: 'removed' });
  });
  it.each([
    ['is only stopped', (f: Awaited<ReturnType<typeof fixture>>) => anchorState(f, { Status: 'exited', Dead: false }), 'DOCKER_POOL_DEAD_ANCHOR_NOT_DEAD'],
    ['runs', (f: Awaited<ReturnType<typeof fixture>>) => anchorState(f, { Status: 'running', Dead: false, Running: true, Pid: 9 }), 'DOCKER_POOL_DEAD_ANCHOR_NOT_DEAD'],
    [
      'stands beside a laptop container of the box that runs',
      (f: Awaited<ReturnType<typeof fixture>>) =>
        f.physical.containers.set('e'.repeat(64), {
          Id: 'e'.repeat(64),
          Image: 'sha256:' + '7'.repeat(64),
          Config: { Labels: { 'reverie.boxed.box': 'b'.repeat(64) } },
          HostConfig: { PidMode: '' },
          State: { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false, Pid: 5 },
        }),
      'DOCKER_POOL_COLD_WORKERS_RUNNING',
    ],
    [
      'stands beside a pool helper that still runs',
      (f: Awaited<ReturnType<typeof fixture>>) => leftover(f, 'f'.repeat(64), { Status: 'running', Running: true, Pid: 9 }),
      'DOCKER_POOL_COLD_WRITER_UNCONFIRMED',
    ],
  ] as const)('removes no anchor that %s', async (_name, arrange, code) => {
    const { f, removed, remove } = await dead();
    arrange(f);
    const refused = await remove();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe(code);
    expect(removed).toEqual([]);
  });
  it('removes no anchor while a cold recovery is unfinished, nor one that another record does not name', async () => {
    const held = await dead();
    await new DockerColdPoolJournal(held.f.coldFile)
      .issue(
        { operationId: randomUUID(), employeeId: held.f.eid, sessionId: held.f.physical.row().request.sessionId,
          sessionGeneration: held.f.physical.row().request.sessionGeneration, scopeDigest: 'a'.repeat(64) },
        () => {},
        async () => { throw Error('lost'); }
      )
      .catch(() => undefined);
    const refused = await held.remove();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('DOCKER_POOL_COLD_ATTEMPT_HELD');
    expect(held.removed).toEqual([]);
    const other = await dead();
    await other.f.companyStore.update((state) => { state.dockerEmployeeContinuations = []; });
    const unnamed = await other.remove();
    expect(unnamed.json().error.code).toBe('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    expect(other.removed).toEqual([]);
  });
  it('proves the container again in the Engine port: exactly this box’s anchor, and dead', () => {
    const box = 'b'.repeat(64), id = 'c'.repeat(64);
    const proof = { name: '/reverie-boxed-anchor-' + 'b'.repeat(32), imageId: 'sha256:' + 'd'.repeat(64), boxId: box };
    const row = (patch: Record<string, unknown> = {}, labels: Record<string, string> = {}) => ({
      Id: id, Name: proof.name, Image: proof.imageId,
      State: { Status: 'dead', Dead: true, Running: false, Paused: false, Restarting: false, Pid: 0 },
      Config: { Labels: {
        'org.reverie.purpose': 'boxed-resource-helper-v1', 'reverie.box.resource.box': box,
        'reverie.box.resource.role': 'anchor', 'reverie.box.resource.name': proof.name.slice(1), ...labels,
      } },
      ...patch,
    });
    expect(dockerDeadPoolAnchorProven(row(), id, proof)).toBe(true);
    const state = (patch: Record<string, unknown>) => ({ State: { ...row().State, ...patch } });
    for (const [index, value] of [
      row({ Id: 'e'.repeat(64) }),
      row({ Name: '/reverie-boxed-anchor-' + 'a'.repeat(32) }),
      row({ Image: 'sha256:' + 'e'.repeat(64) }),
      row({}, { 'reverie.box.resource.box': 'a'.repeat(64) }),
      row({}, { 'reverie.box.resource.role': 'pool-helper' }),
      row({}, { 'org.reverie.purpose': 'other' }),
      row(state({ Status: 'exited', Dead: false })),
      row(state({ Status: 'created', Dead: false })),
      row(state({ Running: true })),
      row(state({ Pid: 12 })),
      row(state({ Restarting: true })),
      null,
    ].entries())
      expect(dockerDeadPoolAnchorProven(value, id, proof), String(index)).toBe(false);
    expect(dockerDeadPoolAnchorProven(row(), id, { ...proof, name: '/reverie-boxed-anchor-' + 'a'.repeat(32) })).toBe(false);
  });
  it('recovers past a pool helper that the interrupted run created and never started', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id);
    leftover(f, 'f'.repeat(64), { Status: 'created' });
    const result = await recover(f, await preview(f), id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.state).toBe('retained');
    // The helper that never ran was read from nowhere and started by nobody.
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
    expect((f.physical.containers.get('f'.repeat(64))!.State as { Status: string }).Status).toBe('created');
  });
  it.each([0, 137, 255])(
    'previews past a pool helper on no record that ended with status %d before the host stopped',
    async (ExitCode) => {
      const f = await fixture({ cold: true });
      leftover(f, 'f'.repeat(64), { Status: 'exited', ExitCode, OOMKilled: false, Error: '' });
      await preview(f);
    }
  );
  it.each([
    ['still runs', { Status: 'running', Running: true, Pid: 9 }],
    ['is being restarted', { Status: 'restarting', Restarting: true }],
    ['is dead', { Status: 'dead', Dead: true }],
  ])('recovers nothing while a pool helper on no record %s', async (_name, state) => {
    const f = await fixture({ cold: true });
    leftover(f, 'f'.repeat(64), state);
    const refused = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.ownerHeaders });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('DOCKER_POOL_COLD_WRITER_UNCONFIRMED');
  });
  it('recovers past a recorded laptop that the Engine positively reports absent', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id);
    // The laptop on record was removed while everything was stopped.
    f.physical.selectWorker();
    f.physical.containers.delete(workerId);
    const result = await recover(f, await preview(f), id);
    expect(result.statusCode, result.body).toBe(200);
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
  });
  it('still refuses when a recorded laptop is there and cannot be read', async () => {
    const f = await fixture({ cold: true }), effects = observeEffects(f, randomUUID());
    f.physical.selectWorker();
    const raw = f.physical.containers.get(workerId) ?? {
      Id: workerId,
      Config: { Labels: { 'reverie.boxed.instance': deployment } },
      HostConfig: { PidMode: '' },
      State: { Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0 },
    };
    f.physical.containers.set(workerId, raw);
    const observed = vi.mocked(f.physical.command.run).getMockImplementation()!;
    vi.mocked(f.physical.command.run).mockImplementation(async (args, input) => {
      if (args[0] === 'container' && args[1] === 'inspect' && args[2] === workerId) throw Error('Engine timed out');
      return observed(args, input);
    });
    // The Engine lists it, so it is not absent: unreadable is unknown, and nothing is recovered beside unknown.
    const refused = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.ownerHeaders });
    expect(refused.statusCode).not.toBe(200);
    expect(effects).toEqual([]);
  });
  it.each([
    ['runs', { Status: 'running', Running: true, Pid: 4242 }],
    ['is paused', { Status: 'paused', Running: true, Paused: true, Pid: 4242 }],
    ['is being restarted', { Status: 'restarting', Running: false, Restarting: true, Pid: 0 }],
  ])('recovers nothing while any container with the laptop label of this box %s, on record or not', async (_name, state) => {
    const f = await fixture({ cold: true }), effects = observeEffects(f, randomUUID());
    const stray = 'e'.repeat(64);
    f.physical.containers.set(stray, {
      Id: stray,
      Image: 'sha256:' + '7'.repeat(64),
      Config: { Labels: { 'reverie.boxed.box': 'b'.repeat(64), 'reverie.boxed.instance': deployment } },
      HostConfig: { PidMode: '' },
      State: { Paused: false, Restarting: false, Dead: false, ...state },
    });
    // No record names it: the office's own list of laptops is empty.
    const refused = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.ownerHeaders });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('DOCKER_POOL_COLD_WORKERS_RUNNING');
    expect(effects).toEqual([]);
    // Stopped, it stands in nobody's way. One of another box never did.
    (f.physical.containers.get(stray)!.State as Record<string, unknown>) = {
      Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0,
    };
    f.physical.containers.set('9'.repeat(64), {
      Id: '9'.repeat(64),
      Image: 'sha256:' + '7'.repeat(64),
      Config: { Labels: { 'reverie.boxed.box': 'a'.repeat(64) } },
      HostConfig: { PidMode: '' },
      State: { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false, Pid: 5 },
    });
    await preview(f);
  });
  it('recovers nothing for an employee who has no laptop record of their own, current or retired', async () => {
    const f = await fixture({ cold: true });
    await f.companyStore.update((state) => { state.dockerEmployeeContinuations = []; });
    const refused = await f.app.inject({ method: 'GET', url: f.url + '/cold-preview', headers: f.ownerHeaders });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
  });
  // A recovery that was issued and did not finish is finished as itself. Nothing it issued is issued again.
  function resume(f: Awaited<ReturnType<typeof fixture>>, headers = f.ownerHeaders) {
    return f.app.inject({ method: 'POST', url: f.url + '/cold-resume', headers, payload: {} });
  }
  const idle = (f: Awaited<ReturnType<typeof fixture>>) => new DockerColdPoolJournal(f.coldFile).requireIdle();
  it('finishes a recovery whose anchor START reply was lost: the anchor is not started again and its helper is issued once', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id, true);
    const scope = await preview(f);
    expect((await recover(f, scope, id)).statusCode).toBe(409);
    expect(() => idle(f)).toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
    expect((await resume(f, f.workerHeaders)).statusCode).toBe(403);
    expect(effects).toEqual(['start original anchor']);
    const result = await resume(f);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.state).toBe('retained');
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
    const last = await latest(f);
    expect(last.scope.operationId).toBe(id);
    expect(last.task.phase).toBe('completed');
    const fresh = f.companyStore.snapshot().dockerPoolObservations?.find(record => record.epoch.anchor.startTicks === '999');
    expect(last.observationDigest).toBe(dockerContinuationDigest(fresh));
    expect(() => idle(f)).not.toThrow();
    // Asked again, there is nothing left to finish: it answers with the pool's status and issues nothing.
    const again = await resume(f);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.state).toBe('retained');
    expect(effects).toHaveLength(3);
  });
  it('runs a recovery as itself when its anchor START never took effect and nothing else changed', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id);
    const observed = vi.mocked(f.physical.command.run).getMockImplementation()!;
    let refused = 0;
    vi.mocked(f.physical.command.run).mockImplementation(async (args, input) => {
      if (args[0] === 'container' && args[1] === 'start' && args[2] === f.anchor.containerId && !refused++)
        throw Error('The Engine did not start the anchor');
      return observed(args, input);
    });
    const scope = await preview(f);
    expect((await recover(f, scope, id)).statusCode).toBe(409);
    expect(effects).toEqual([]);
    expect(() => idle(f)).toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
    const result = await resume(f);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data.state).toBe('retained');
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
    expect((await latest(f)).scope.operationId).toBe(id);
    expect(() => idle(f)).not.toThrow();
  });
  it('ends a recovery whose anchor has stopped again without a helper, and lets a new one be previewed', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id, true);
    const scope = await preview(f);
    expect((await recover(f, scope, id)).statusCode).toBe(409);
    // A second host restart: the anchor that this attempt started is stopped again.
    const raw = f.physical.containers.get(f.anchor.containerId)!;
    raw.State = {
      Status: 'exited', Running: false, Restarting: false, Paused: false, Dead: false, Pid: 0,
      OOMKilled: false, Error: '', ExitCode: 255, StartedAt: '2026-11-19T09:00:30Z', FinishedAt: '2026-11-19T09:00:45Z',
    };
    const result = await resume(f);
    expect(result.statusCode, result.body).toBe(200);
    // It confirmed nothing and can write nothing: it is recorded as ended, and the pool reads as stopped.
    expect(result.json().data).toMatchObject({ state: 'held', code: 'DOCKER_POOL_ANCHOR_UNCONFIRMED' });
    expect(await latest(f)).toMatchObject({ scope: { operationId: id }, ended: true });
    expect((await latest(f)).task).toBeUndefined();
    expect(effects).toEqual(['start original anchor']);
    expect(() => idle(f)).not.toThrow();
    // The next recovery is a new operation from a fresh preview.
    vi.restoreAllMocks();
    const next = randomUUID(), later = observeEffects(f, next);
    const again = await recover(f, await preview(f), next);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.state).toBe('retained');
    expect(later).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
  });
  it('records a helper that exited with an error as failed and ends the recovery instead of holding the pool for good', async () => {
    const f = await fixture({ cold: true }), id = randomUUID(), effects = observeEffects(f, id);
    f.physical.failHelper('pool-helper');
    const scope = await preview(f);
    const failed = await recover(f, scope, id);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('DOCKER_RESOURCE_HELPER_FAILED');
    expect((await latest(f)).task.phase).toBe('start-issued');
    expect(() => idle(f)).toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
    const result = await resume(f);
    expect(result.statusCode, result.body).toBe(200);
    // The helper is observed as itself: neither created nor started a second time.
    expect(effects).toEqual(['start original anchor', 'create pool helper', 'start pool helper']);
    const last = await latest(f);
    expect(last).toMatchObject({ scope: { operationId: id }, ended: true, task: { phase: 'failed', exitCode: 1 } });
    expect(last.observationDigest).toBeUndefined();
    // The anchor runs with no limits written. That is a pool like any other now: no recovery holds it.
    expect(result.json().data.state).toBe('held');
    expect(result.json().data.code).not.toBe('DOCKER_POOL_COLD_ATTEMPT_HELD');
    expect(() => idle(f)).not.toThrow();
  });
  it('keeps a recovery held while its helper cannot be proved to have ended', async () => {
    const f = await fixture({ cold: true }), id = randomUUID();
    observeEffects(f, id);
    f.physical.failHelper('pool-helper');
    expect((await recover(f, await preview(f), id)).statusCode).toBe(409);
    // The helper container is still running: it may yet write.
    const helper = (await latest(f)).task.containerId as string;
    const state = f.physical.containers.get(helper)!.State as Record<string, unknown>;
    f.physical.containers.get(helper)!.State = { ...state, Status: 'running', Running: true, Pid: 321 };
    const observed = vi.mocked(f.physical.command.run).getMockImplementation()!;
    vi.mocked(f.physical.command.run).mockImplementation(async (args, input) => {
      if (args[0] === 'container' && args[1] === 'wait' && args[2] === helper) throw Error('still running');
      return observed(args, input);
    });
    const result = await resume(f);
    expect(result.statusCode).toBe(409);
    expect((await latest(f)).task.phase).toBe('start-issued');
    expect((await latest(f)).ended).toBeUndefined();
    expect(() => idle(f)).toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
  });
});

describe('supported metadata-only recovery of an already lost pool ACK', () => {
  it('accepts a bounded consistent set of original closed ACKs without inventing causality or stranding retained proof', async () => {
    const f = await fixture(),
      id = f.completed.containerId;
    const add = (other: string) => {
      const raw = structuredClone(f.physical.containers.get(id)!);
      raw.Id = other;
      (raw.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] =
        'reverie-boxed-pool-helper-' + other;
      f.physical.containers.set(other, raw);
      f.physical.logs.set(other, f.physical.logs.get(id)!);
    };
    add('f'.repeat(64));
    const status = await f.app.inject({ method: 'GET', url: f.url + '/status', headers: f.ownerHeaders });
    expect(status.json().data.state).toBe('reconciliation-required');
    const result = await f.app.inject({
      method: 'POST',
      url: f.url + '/reconcile',
      headers: f.ownerHeaders,
      payload: f.body(status.json().data.scopeDigest),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.state).toBe('retained');
    const record = f.companyStore.snapshot().dockerPoolObservations![0]!;
    expect(record.configuration.containerId).toBe(id);
    expect(record).not.toHaveProperty('origin');
    const source = {
      policy,
      pool: {
        containerId: record.anchorTask.containerId,
        cgroupParent: record.epoch.parent.path.split('/').at(-1)!,
        policyDigest: dockerContinuationDigest(policy.pool),
        physicalDigest: 'b'.repeat(64),
      },
      tasks: [{ ...record.anchorTask, initPid: record.anchorTask.initPid + 1 }],
    };
    await expect(f.service.requirePlanSourcePool(source, () => {})).resolves.toBeUndefined();
    await expect(f.service.requirePlanSourcePool({
      ...source, pool: { ...source.pool, cgroupParent: 'different-pool.slice' },
    }, () => {})).rejects.toThrow('DOCKER_POOL_SOURCE_RECONCILIATION_REQUIRED');
    // A later matching closed helper must not cause proof churn just because
    // its full ID sorts first. Preference is DATA only: every ACK is re-earned.
    add('0'.repeat(64));
    const before = await fs.readFile(f.companyFile, 'utf8');
    const again = await f.app.inject({ method: 'GET', url: f.url + '/status', headers: f.ownerHeaders });
    expect(again.json().data.state).toBe('retained');
    expect(await fs.readFile(f.companyFile, 'utf8')).toBe(before);
    expect(f.companyStore.snapshot().dockerPoolObservations).toHaveLength(1);
    f.effects();
  });

  it.each(['owner', 'worker'] as const)(
    'real %s repairs missing history without inventing origin or dispatching effects',
    async (caller) => {
      const f = await fixture(),
        headers = caller === 'owner' ? f.ownerHeaders : f.workerHeaders;
      const before = await fs.readFile(f.companyFile, 'utf8');
      const status = await f.app.inject({ method: 'GET', url: f.url + '/status', headers });
      expect(status.statusCode).toBe(200);
      expect(status.json().data).toMatchObject({
        state: 'reconciliation-required',
        allowedActions: ['reconcile-pool'],
      });
      expect(await fs.readFile(f.companyFile, 'utf8')).toBe(before);
      const repaired = await f.app.inject({
        method: 'POST',
        url: f.url + '/reconcile',
        headers,
        payload: f.body(status.json().data.scopeDigest),
      });
      expect(repaired.statusCode).toBe(200);
      expect(repaired.json().data).toMatchObject({ state: 'retained', allowedActions: [] });
      const after = f.companyStore.snapshot();
      expect(after.dockerEmployeeContinuations).toBeUndefined();
      expect(after.dockerSharedPoolLineages).toBeUndefined();
      expect(after.dockerPoolObservations).toHaveLength(1);
      expect(after.dockerPoolObservations![0]).not.toHaveProperty('origin');
      expect(after.version).toBe(2);
      const normalized = { ...after, version: 1 as const };
      delete normalized.dockerPoolObservations;
      expect(normalized).toEqual(JSON.parse(before));
      const controller = f.physical.controllerWith(() =>
        f.store.retainedPoolConfigurationTasks('reverie-boxed-anchor-' + 'b'.repeat(32), helper, 'b'.repeat(64))
      );
      expect(await controller.observePool(f.physical.row())).not.toBeNull();
      const second = await f.app.inject({ method: 'GET', url: f.url + '/status', headers });
      expect(second.json().data.state).toBe('retained');
      f.effects();
      f.physical.logs.set(f.completed.containerId, '{}');
      expect((await f.app.inject({ method: 'GET', url: f.url + '/status', headers })).json().data.state).toBe('held');
      await expect(controller.observePool(f.physical.row())).rejects.toThrow();
      f.effects();
    }
  );
  it('current scoped recovery grant is required; title, parent hint and office permission do not substitute', async () => {
    const f = await fixture({ recover: false });
    for (const headers of [f.workerHeaders, { 'x-reverie-parent-session': actorSid }, {}]) {
      const response = await f.app.inject({ method: 'GET', url: f.url + '/status', headers });
      expect([401, 403]).toContain(response.statusCode);
    }
    expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
    f.effects();
  });
  it.each(['grant', 'identity', 'runtime', 'target'] as const)(
    'revoked %s during native await refuses publication',
    async (change) => {
      const f = await fixture();
      const status = await f.service.status(f.eid, f.authority());
      let once = true;
      f.physical.beforeRun(async (args) => {
        if (!once || !args.includes('probe-pool')) return;
        once = false;
        if (change === 'grant')
          await f.companyStore.update((state) => {
            state.employees[0]!.permissions.recoverEmployees = false;
          });
        else if (change === 'identity') f.revokeIdentity();
        else if (change === 'runtime') f.revokeRuntime();
        else
          await f.companyStore.update((state) => {
            state.employees[1]!.sessionGeneration++;
          });
      });
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/reconcile',
        headers: f.workerHeaders,
        payload: f.body(status.scopeDigest!),
      });
      expect([403, 409]).toContain(response.statusCode);
      expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
      f.effects();
    }
  );
  it('pool metadata CAS refuses a competing genuine observation during native awaits', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    const receipt = await f.physical.controller.capturePoolObservation(policy.pool, () => {});
    const before = dockerPoolMetadataDigest(f.companyStore.snapshot());
    let once = true;
    f.physical.beforeRun(async (args) => {
      if (!once || !args.includes('probe-pool')) return;
      once = false;
      const result = await f.companyStore.publishDockerPoolObservation(receipt, before, () => {});
      expect(result.state).toBe('committed');
    });
    await expect(f.service.reconcile(f.eid, f.body(status.scopeDigest!), f.authority())).rejects.toMatchObject({
      code: 'DOCKER_POOL_CANONICAL_CHANGED',
    });
    expect(f.companyStore.snapshot().dockerPoolObservations).toHaveLength(1);
    f.effects();
  });
  it.each([
    'missing',
    'running',
    'created',
    'foreign',
    'foreign-box',
    'too-many',
    'wrong-policy',
    'wrong-image',
    'changed-epoch',
    'malformed-ack',
    'mixed-ack',
    'duplicate-census',
    'unknown-io',
  ] as const)('%s native evidence remains held with no metadata or effects', async (mode) => {
    const f = await fixture(),
      id = f.completed.containerId;
    const container = f.physical.containers.get(id)!;
    if (mode === 'missing') f.physical.containers.delete(id);
    else if (mode === 'running' || mode === 'created') {
      const state = container.State as Record<string, unknown>;
      state.Status = mode;
      state.Running = mode === 'running';
    } else if (mode === 'foreign') f.physical.foreignMount();
    else if (mode === 'wrong-image') container.Image = 'sha256:' + 'f'.repeat(64);
    else if (mode === 'changed-epoch') f.physical.driftEpoch();
    else if (mode === 'malformed-ack') f.physical.logs.set(id, '{}');
    else if (mode === 'mixed-ack') {
      const other = 'f'.repeat(64),
        raw = structuredClone(container);
      raw.Id = other;
      (raw.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] =
        'reverie-boxed-pool-helper-' + 'f'.repeat(64);
      f.physical.containers.set(other, raw);
      const wrong = JSON.parse(f.physical.logs.get(id)!);
      wrong.resources.cpuWeight = '200';
      f.physical.logs.set(other, JSON.stringify(wrong));
    } else if (mode === 'wrong-policy') {
      await f.companyStore.update((state) => {
        state.employees[1]!.dockerResourcePolicy!.pool.cpuWeight = 200;
      });
    } else if (mode === 'foreign-box') {
      (container.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.box'] = 'c'.repeat(64);
      const run = f.physical.command.run;
      f.physical.command.run = async (args, input) =>
        args.includes('label=reverie.box.resource.role=pool-helper') ? id + String.fromCharCode(10) : run(args, input);
    } else if (mode === 'too-many') {
      const run = f.physical.command.run;
      f.physical.command.run = async (args, input) =>
        args.includes('label=reverie.box.resource.role=pool-helper')
          ? Array.from({ length: 129 }, (_, index) => index.toString(16).padStart(64, '0')).join(
              String.fromCharCode(10)
            )
          : run(args, input);
    } else if (mode === 'duplicate-census') {
      const run = f.physical.command.run;
      f.physical.command.run = async (args, input) =>
        args.includes('label=reverie.box.resource.role=pool-helper')
          ? [id, id, ''].join(String.fromCharCode(10))
          : run(args, input);
    } else
      f.physical.beforeRun(() => {
        throw Error('Sensitive private transport failure');
      });
    const result = await f.service.status(f.eid, f.authority());
    expect(result).toMatchObject({ state: 'held', allowedActions: [] });
    expect(JSON.stringify(result)).not.toContain('Sensitive private');
    expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
    f.effects();
  });
  it('a valid POST preview with an unknown native reply is a typed backend hold, not invalid caller input', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    const before = await fs.readFile(f.companyFile, 'utf8');
    f.physical.logs.set(f.completed.containerId, '{}');
    const response = await f.app.inject({
      method: 'POST',
      url: f.url + '/reconcile',
      headers: f.ownerHeaders,
      payload: f.body(status.scopeDigest!),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DOCKER_POOL_OBSERVATION_UNCONFIRMED');
    expect(await fs.readFile(f.companyFile, 'utf8')).toBe(before);
    f.effects();
  });
  it('strict request schema refuses caller policy, helper ID, foreign SID and stale preview', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    for (const payload of [
      { ...f.body(status.scopeDigest!), helperContainerId: 'f'.repeat(64) },
      { ...f.body(status.scopeDigest!), poolPolicy: { ...policy.pool, memoryMaxBytes: 1 } },
      { ...f.body(status.scopeDigest!), sessionId: actorSid },
      { ...f.body(status.scopeDigest!), expectedScopeDigest: '0'.repeat(64) },
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/reconcile',
        headers: f.ownerHeaders,
        payload,
      });
      expect([400, 409]).toContain(response.statusCode);
    }
    expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
    f.effects();
  });
  it('a forged receipt/private prototype cannot call publication authority or publish raw JSON', async () => {
    const f = await fixture();
    let calls = 0;
    const fake = Object.create(DockerPoolReconciliationReceipt.prototype, {
      claim: {
        value: () => {
          calls++;
        },
      },
    });
    expect(() =>
      f.companyStore.publishDockerPoolObservation(fake, dockerPoolMetadataDigest(f.companyStore.snapshot()), () => {
        calls++;
      })
    ).toThrow();
    expect(calls).toBe(0);
    await expect(
      f.companyStore.update((state) => {
        state.dockerPoolObservations = [];
      })
    ).rejects.toMatchObject({ code: 'DOCKER_POOL_CANONICAL_CHANGED' });
    f.effects();
  });
  it('lost canonical publication reply stays unconfirmed; fresh restart re-earns original native proof', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (a, b) => {
      await rename(a, b);
      throw Error('Synthetic lost rename reply');
    });
    await expect(f.service.reconcile(f.eid, f.body(status.scopeDigest!), f.authority())).rejects.toMatchObject({
      code: 'DOCKER_POOL_PUBLICATION_UNCONFIRMED',
    });
    vi.restoreAllMocks();
    expect(f.companyStore.publicationUnconfirmed).toBe(true);
    expect((await f.service.status(f.eid, f.authority())).code).toBe('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
    const restarted = new CompanyStore(f.companyFile);
    await restarted.init();
    const company = new CompanyService(restarted, f.deps),
      store = new CompanyDockerContinuationStore(company, () => undefined);
    const service = new DockerPoolReconciliation(company, store, f.physical.controller, () => {});
    const grant = company.recoveryAction(f.eid, undefined);
    expect(
      (
        await service.status(f.eid, {
          owner: undefined,
          require: () => grant.require(),
          requireOffice: () => {
            throw Error('unused');
          },
        })
      ).state
    ).toBe('retained');
    expect(f.companyStore.publicationUnconfirmed).toBe(true);
    f.effects();
  });
  it('a crash after native capture but before publication leaves no canonical proof to invent', async () => {
    const f = await fixture();
    await f.physical.controller.capturePoolObservation(policy.pool, () => {});
    const restarted = new CompanyStore(f.companyFile);
    await restarted.init();
    expect(restarted.snapshot().dockerPoolObservations).toBeUndefined();
    expect((await f.service.status(f.eid, f.authority())).state).toBe('reconciliation-required');
    f.effects();
  });
});

describe('the cold recovery journal', () => {
  const scope = (operationId: string, scopeDigest = 'a'.repeat(64)) => ({
    operationId, employeeId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
    sessionGeneration: 1, scopeDigest,
  });
  async function journal() {
    const directory = await fs.mkdtemp(join(tmpdir(), 'cold-journal-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    return new DockerColdPoolJournal(join(directory, 'cold-pool.jsonl'));
  }
  const current = () => {};
  it('holds an attempt until it is confirmed or ended, and resumes exactly that attempt', async () => {
    const cold = await journal(), first = randomUUID();
    expect(cold.held()).toBeUndefined();
    await expect(cold.resume(current, async () => 'never')).rejects.toThrow('DOCKER_POOL_COLD_ATTEMPT_ABSENT');
    await expect(cold.issue(scope(first), current, async () => { throw Error('lost'); })).rejects.toThrow('lost');
    expect(cold.held()).toEqual(scope(first));
    expect(() => cold.requireIdle()).toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
    await expect(cold.issue(scope(randomUUID(), 'b'.repeat(64)), current, async () => 'x')).rejects.toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
    await expect(cold.resume(current, async (attempt) => {
      expect(attempt.scope).toEqual(scope(first));
      attempt.end();
      // An ended attempt takes nothing more.
      expect(() => attempt.end()).toThrow('DOCKER_POOL_COLD_JOURNAL_CHANGED');
      expect(() => attempt.confirm('c'.repeat(64))).toThrow();
      return 'ended';
    })).resolves.toBe('ended');
    expect(cold.held()).toBeUndefined();
    expect(() => cold.requireIdle()).not.toThrow();
  });
  it('lets the scope of an ended attempt be issued again under a new operation, and never the scope of any other', async () => {
    const cold = await journal(), first = randomUUID(), second = randomUUID();
    await expect(cold.issue(scope(first), current, async () => { throw Error('lost'); })).rejects.toThrow('lost');
    await cold.resume(current, async (attempt) => attempt.end());
    // The same operation is never issued twice, ended or not.
    await expect(cold.issue(scope(first), current, async () => 'x')).rejects.toThrow('DOCKER_POOL_COLD_ALREADY_ISSUED');
    await expect(cold.issue(scope(second), current, async () => { throw Error('lost again'); })).rejects.toThrow('lost again');
    expect(cold.held()).toEqual(scope(second));
    // An attempt that is only held has not ended: its scope stays issued.
    await expect(cold.issue(scope(randomUUID()), current, async () => 'x')).rejects.toThrow('DOCKER_POOL_COLD_ATTEMPT_HELD');
  });
});
