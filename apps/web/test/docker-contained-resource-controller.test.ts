import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { retainedDockerPoolTasks } from '../src/docker-shared-pool-lineage.js';
import { DockerEmployeeContinuationRecord as ContinuationRecord } from '../src/docker-employee-continuation-data.js';
import type { DockerContinuationTaskRole } from '../src/docker-continuation-task.js';
import { fixture, helper, policy, deployment } from './helpers/docker-resource-physical.js';

describe('fixed Docker resource orchestration', () => {
  it('a real canonical owner-row archival/reload leaves the native pool proof available to another employee', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const directory = await mkdtemp(join(tmpdir(), 'pool-canonical-native-'));
    try {
      const file = join(directory, 'company.json'),
        canonical = new CompanyStore(file);
      await canonical.init();
      const request = f.row().request;
      const original = {
        containerId: 'c'.repeat(64),
        imageId: 'sha256:' + 'd'.repeat(64),
        deployment,
        employeeId: f.row().employeeId,
        sessionId: request.sessionId,
        home: { type: 'bind', source: '/synthetic/home', destination: '/home/agent', readWrite: true },
        mountDigest: '1'.repeat(64),
        storageDigest: '2'.repeat(64),
        configurationDigest: '3'.repeat(64),
      };
      const row = ContinuationRecord.parse({
        version: 1,
        purpose: 'docker-employee-continuation-v1',
        employeeId: f.row().employeeId,
        sourceDigest: '4'.repeat(64),
        original,
        policy,
        request: {
          ...request,
          containerId: original.containerId,
          imageId: original.imageId,
          expectedPolicyDigest: '5'.repeat(64),
          expectedDestinationImageId: f.row().workerImage.imageId,
          enterOffice: false,
        },
        workerImage: { ...f.row().workerImage, sourceImageId: original.imageId, clientManifestDigest: '6'.repeat(64) },
        credentialId: '44444444-4444-4444-8444-444444444444',
        phase: 'pool-issued',
        tasks: [...f.tasks.values()],
      });
      await canonical.update((state) => {
        state.dockerEmployeeContinuations = [row];
      });
      await canonical.update((state) => {
        delete state.dockerEmployeeContinuations;
      });
      const restarted = new CompanyStore(file);
      await restarted.init();
      f.tasks.delete('pool-helper');
      // The old current-employee-only callback is now empty: the same fresh
      // native kernel values cannot supply the forgotten execution ACK.
      await expect(f.controller.observePool(f.row())).rejects.toThrow('POOL_HELPER_UNACKNOWLEDGED');
      f.retain(retainedDockerPoolTasks(restarted.snapshot(), 'reverie-boxed-anchor-' + 'b'.repeat(32), helper));
      f.row().employeeId = '77777777-7777-4777-8777-777777777777';
      f.row().request.operationId = '88888888-8888-4888-8888-888888888888';
      const before = { creates: [...f.creates], starts: [...f.starts] };
      expect(await f.controller.observePool(f.row())).not.toBeNull();
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
      f.changeHelper('pool-helper', 'restart');
      await expect(f.controller.observePool(f.row())).rejects.toThrow();
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('changed native epoch never adopts an old ACK or replays the anchor START', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    f.retain([f.tasks.get('pool-helper')!]);
    f.tasks.delete('pool-helper');
    const before = { creates: [...f.creates], starts: [...f.starts] };
    f.driftEpoch();
    await expect(f.controller.observePool(f.row())).rejects.toThrow('ANCHOR_REPLACED');
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
  });
  it('another unresolved writer blocks new configuration before CREATE or START', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const pending = f.tasks.get('pool-helper')!;
    if (!('containerId' in pending)) throw Error('fixture requires CID');
    (f.containers.get(pending.containerId)!.State as Record<string, unknown>).Running = true;
    f.retain([pending]);
    f.tasks.delete('pool-helper');
    f.requireConfigure();
    const before = { creates: [...f.creates], starts: [...f.starts] };
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('WRITER_UNCONFIRMED');
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
  });

  it('reuses a retired owner ACK only after fresh native proof and without effects', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const completed = f.tasks.get('pool-helper')!;
    f.retain([completed]);
    f.tasks.delete('pool-helper');
    const before = { creates: [...f.creates], starts: [...f.starts] };
    expect(await f.controller.observePool(f.row())).toMatchObject({
      policyDigest: expect.any(String),
    });
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    f.logs.set(('containerId' in completed && completed.containerId) || '', '{}');
    await expect(f.controller.observePool(f.row())).rejects.toThrow();
    expect({ creates: f.creates, starts: f.starts }).toEqual(before);
  });
  it.each(['running', 'missing', 'failed', 'stale-ack'] as const)(
    'retained %s writer cannot be hidden behind another completed ACK',
    async (mode) => {
      const f = fixture();
      await f.controller.preparePool(f.row(), f.current);
      const good = f.tasks.get('pool-helper')!;
      if (!('containerId' in good)) throw Error('fixture requires actual CID');
      const original = f.containers.get(good.containerId)!;
      const otherId = 'f'.repeat(64);
      f.containers.set(otherId, { ...structuredClone(original), Id: otherId });
      const { role, name, imageId, configurationDigest } = good;
      const other = {
        role,
        name,
        imageId,
        configurationDigest,
        containerId: otherId,
        phase: 'start-issued' as const,
      };
      if (mode === 'running') (f.containers.get(otherId)!.State as Record<string, unknown>).Running = true;
      else if (mode === 'missing') f.containers.delete(otherId);
      else if (mode === 'failed') (f.containers.get(otherId)!.State as Record<string, unknown>).ExitCode = 1;
      else f.logs.set(good.containerId, '{}');
      f.retain([good, other]);
      const before = { creates: [...f.creates], starts: [...f.starts] };
      if (mode === 'failed') expect(await f.controller.observePool(f.row())).not.toBeNull();
      else await expect(f.controller.observePool(f.row())).rejects.toThrow();
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    }
  );

  it('isolates helper names when two instances receive the same public operation ID', async () => {
    const first = fixture('b'.repeat(64)),
      second = fixture('c'.repeat(64));
    await first.controller.preparePool(first.row(), first.current);
    await second.controller.preparePool(second.row(), second.current);
    expect(first.row().request.operationId).toBe(second.row().request.operationId);
    expect(first.names[1]).not.toBe(second.names[1]);
  });
  it.each(['restart', 'parent'] as const)(
    'a changed helper %s cannot acknowledge successful resource enforcement',
    async (field) => {
      const f = fixture();
      await f.controller.preparePool(f.row(), f.current);
      await f.setPool();
      f.makeWorker();
      await f.controller.configure(f.row(), f.current);
      const before = [...f.starts];
      f.changeHelper('leaf-helper', field);
      await expect(f.controller.read(f.row())).rejects.toThrow('HELPER');
      expect(f.starts).toEqual(before);
    }
  );
  it.each(['pool-helper', 'leaf-helper'])(
    'matching kernel values cannot replace the original %s success acknowledgement',
    async (role) => {
      const f = fixture();
      if (role === 'pool-helper') {
        f.failHelper(role);
        await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('HELPER_FAILED');
        await expect(f.controller.observePool(f.row())).rejects.toThrow('UNACKNOWLEDGED');
      } else {
        await f.controller.preparePool(f.row(), f.current);
        await f.setPool();
        f.makeWorker();
        f.failHelper(role);
        await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('HELPER_FAILED');
        await expect(f.controller.read(f.row())).rejects.toThrow('UNACKNOWLEDGED');
      }
      const starts = [...f.starts];
      expect(f.tasks.get(role as DockerContinuationTaskRole)?.phase).toBe('start-issued');
      expect(f.starts).toEqual(starts);
    }
  );
  it('records every effect first and confirms real scalar readbacks before returning policy', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    await f.setPool();
    f.makeWorker();
    await f.controller.configure(f.row(), f.current);
    expect(await f.controller.read(f.row())).toEqual(policy);
    expect(f.creates).toEqual(['anchor', 'pool-helper', 'leaf-helper']);
    expect(f.starts).toEqual(f.creates);
    expect(f.tasks.get('pool-helper')?.phase).toBe('completed');
    expect(f.tasks.get('leaf-helper')?.phase).toBe('completed');
    f.driftWeight();
    expect(await f.controller.read(f.row())).toBeNull();
  });
  it.each(['create', 'start'] as const)(
    'a lost %s reply stays retained and status never replays an effect',
    async (phase) => {
      const f = fixture();
      if (phase === 'create') f.loseCreate();
      else f.loseStart();
      await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('lost ' + phase);
      const before = { creates: [...f.creates], starts: [...f.starts] };
      await f.controller.observePool(f.row());
      expect({ creates: f.creates, starts: f.starts }).toEqual(before);
    }
  );
  it('refuses revoked authority before creating anything', async () => {
    const f = fixture();
    f.revoke();
    await expect(f.controller.preparePool(f.row(), f.current)).rejects.toThrow('revoked');
    expect(f.creates).toEqual([]);
    expect(f.starts).toEqual([]);
  });
  it('refuses an extra mount on a retained helper without issuing another start', async () => {
    const f = fixture();
    await f.controller.preparePool(f.row(), f.current);
    const before = [...f.starts];
    f.foreignMount();
    await expect(f.controller.observePool(f.row())).rejects.toThrow('MOUNTS_CHANGED');
    expect(f.starts).toEqual(before);
  });
});
