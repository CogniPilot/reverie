import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  requireHelperImage,
  requireContainerSafety,
  requireIdentity,
  requireImageId,
  requireOnlyHighChanged,
  requireOwned,
  runMemoryHighCanary,
  type ResourceObservation,
} from './fixtures/docker-memory-high-canary.js';

const baseline = 'sha256:' + 'a'.repeat(64),
  writer = 'sha256:' + 'b'.repeat(64),
  cid = 'c'.repeat(64),
  box = 'd'.repeat(64);
function image(high = false): Parameters<typeof requireHelperImage>[0] {
  return {
    Id: high ? writer : baseline,
    Os: 'linux',
    Architecture: 'amd64',
    RootFS: { Type: 'layers', Layers: ['sha256:' + 'e'.repeat(64)] },
    Config: {
      User: '0:0',
      WorkingDir: '/',
      Entrypoint: ['/bin/reverie-docker-resources'],
      Cmd: ['anchor'],
      Env: null,
      Labels: {
        'org.reverie.purpose': 'boxed-resource-helper-v1',
        ...(high ? { 'org.reverie.resource.memory-high-only': 'v1' } : {}),
      },
    },
  };
}
function observation(): ResourceObservation {
  return {
    version: 1,
    purpose: 'reverie-boxed-resource-observation-v1',
    boxId: box,
    parent: { path: '/owned/new-box', dev: '22', ino: '10' },
    anchor: {
      id: 'f'.repeat(64),
      pid: 123,
      startTicks: '555',
      path: '/owned/anchor',
      dev: '22',
      ino: '11',
    },
    worker: {
      id: cid,
      pid: 456,
      startTicks: '777',
      path: '/owned/worker',
      dev: '22',
      ino: '12',
    },
    resources: {
      memoryMax: '268435456',
      memoryHigh: '67108864',
      swapMax: '0',
      pidsMax: '32',
      cpuWeight: '217',
      cpuMax: 'max 100000',
      cpusetCpus: '0',
      cpusetCpusEffective: '0',
      cpusetMemsEffective: '0',
    },
  };
}
describe('native helper acceptance guards (not real-kernel success)', () => {
  it('refuses effective privileged, writable, networked or restarting container profiles before start', () => {
    const row: Parameters<typeof requireContainerSafety>[0] = {
      ...image(),
      Image: baseline,
      State: { Status: 'created', Running: false, Pid: 0, ExitCode: 0 },
      HostConfig: {
        ReadonlyRootfs: true,
        Privileged: false,
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        CapAdd: null,
        SecurityOpt: ['no-new-privileges', 'label=disable'],
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      },
    };
    requireContainerSafety(row);
    for (const mutate of [
      (value: typeof row) => {
        value.Config.User = '1000:100';
      },
      (value: typeof row) => {
        value.HostConfig!.ReadonlyRootfs = false;
      },
      (value: typeof row) => {
        value.HostConfig!.Privileged = true;
      },
      (value: typeof row) => {
        value.HostConfig!.NetworkMode = 'host';
      },
      (value: typeof row) => {
        value.HostConfig!.CapDrop = [];
      },
      (value: typeof row) => {
        value.HostConfig!.CapAdd = ['SYS_ADMIN'];
      },
      (value: typeof row) => {
        value.HostConfig!.SecurityOpt = ['seccomp=unconfined'];
      },
      (value: typeof row) => {
        value.HostConfig!.RestartPolicy.Name = 'always';
      },
    ]) {
      const changed = structuredClone(row);
      mutate(changed);
      expect(() => requireContainerSafety(changed)).toThrow();
    }
  });
  it('refuses invalid or identical image selections before evidence creation or Engine effects', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'memory-high-preflight-'));
    const output = join(root, 'not-created');
    try {
      expect(() => runMemoryHighCanary('archive-config-hash', writer, output)).toThrow();
      expect(() => runMemoryHighCanary(baseline, baseline, output)).toThrow();
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
  it('requires actual immutable IDs and a distinct writer capability without adopting a baseline as writer', () => {
    expect(() => requireImageId('archive-config-hash')).toThrow();
    requireHelperImage(image(), baseline, false);
    requireHelperImage(image(true), writer, true);
    expect(() => requireHelperImage(image(), baseline, true)).toThrow();
    expect(() => requireHelperImage(image(true), writer, false)).toThrow();
    for (const mutate of [
      (row: ReturnType<typeof image>) => {
        row.Config.User = '1000:100';
      },
      (row: ReturnType<typeof image>) => {
        row.Config.Entrypoint = ['/bin/sh'];
      },
      (row: ReturnType<typeof image>) => {
        row.Config.Env = ['LD_PRELOAD=/private/evil'];
      },
      (row: ReturnType<typeof image>) => {
        row.Id = baseline;
      },
    ]) {
      const row = image(true);
      mutate(row);
      expect(() => requireHelperImage(row, writer, true)).toThrow();
    }
  });
  it('rejects every non-high resource drift and every worker or parent identity replacement', () => {
    const before = observation(),
      after = structuredClone(before);
    after.resources.memoryHigh = '134217728';
    requireOnlyHighChanged(before, after, '134217728');
    for (const field of [
      'memoryMax',
      'swapMax',
      'pidsMax',
      'cpuWeight',
      'cpuMax',
      'cpusetCpus',
      'cpusetCpusEffective',
      'cpusetMemsEffective',
    ]) {
      const changed = structuredClone(after);
      changed.resources[field] += '-changed';
      expect(() => requireOnlyHighChanged(before, changed, '134217728')).toThrow();
    }
    for (const mutate of [
      (row: ResourceObservation) => {
        row.worker!.pid++;
      },
      (row: ResourceObservation) => {
        row.worker!.startTicks = '778';
      },
      (row: ResourceObservation) => {
        row.worker!.id = '0'.repeat(64);
      },
      (row: ResourceObservation) => {
        row.parent.ino = '13';
      },
      (row: ResourceObservation) => {
        row.anchor.startTicks = '999';
      },
    ]) {
      const changed = structuredClone(after);
      mutate(changed);
      expect(() => requireOnlyHighChanged(before, changed, '134217728')).toThrow();
    }
  });
  it('scopes cleanup to the exact owned image, CID, nonce, role and init birth', () => {
    const expected = { id: cid, image: baseline, role: 'worker' },
      row = {
        ...image(),
        Image: baseline,
        State: { Status: 'created', Running: false, Pid: 0, ExitCode: 0 },
      };
    row.Id = cid;
    row.Config.Labels = {
      'reverie.disposable': box,
      'reverie.task': 'docker-memory-high-canary-v1',
      'reverie.role': 'worker',
    };
    requireOwned(row, expected, box);
    for (const mutate of [
      (value: typeof row) => {
        value.Id = '0'.repeat(64);
      },
      (value: typeof row) => {
        value.Image = writer;
      },
      (value: typeof row) => {
        value.Config.Labels['reverie.disposable'] = 'other';
      },
      (value: typeof row) => {
        value.Config.Labels['reverie.role'] = 'anchor';
      },
      (value: typeof row) => {
        value.Config.Labels['reverie.task'] = 'production';
      },
    ]) {
      const changed = structuredClone(row);
      mutate(changed);
      expect(() => requireOwned(changed, expected, box)).toThrow();
    }
    const original = { id: cid, pid: 456, start: '777' };
    requireIdentity(original, original);
    expect(() => requireIdentity({ ...original, pid: 457 }, original)).toThrow();
    expect(() => requireIdentity({ ...original, start: '778' }, original)).toThrow();
  });
});
