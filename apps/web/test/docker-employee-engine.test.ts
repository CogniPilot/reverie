import { describe, it, expect, vi } from 'vitest';
import { DockerEmployeeEngine, type DockerContainedResourceController } from '../src/docker-employee-engine.js';
import {
  DockerEmployeeResourcePolicy,
  type DockerEmployeeContinuationRecord,
} from '../src/docker-employee-continuation-data.js';
import {
  DockerEmployeeInspect,
  boxedOriginal,
  boxedMountConfiguration,
  boxedStorageMounts,
} from '../src/docker-employee-engine-data.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import type { DockerContinuationTaskJournal } from '../src/docker-continuation-task.js';
const cid = 'a'.repeat(64),
  dest = 'd'.repeat(64),
  image = 'sha256:' + 'b'.repeat(64),
  target = 'sha256:' + 'c'.repeat(64),
  helper = 'sha256:' + 'f'.repeat(64);
const eid = '10000000-0000-4000-8000-000000000001',
  sid = '20000000-0000-4000-8000-000000000002',
  oid = '30000000-0000-4000-8000-000000000003';
const subject = {
  employeeId: eid,
  sessionId: sid,
  sessionGeneration: 3,
  owner: undefined,
  sourceDigest: 'e'.repeat(64),
  onVacation: false,
  desiredRunning: true,
};
function fixture(boxId = '7'.repeat(64)) {
  const policy = DockerEmployeeResourcePolicy.parse({
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 512,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  });
  const source = DockerEmployeeInspect.parse({
    Id: cid,
    Image: image,
    State: { Running: false, Paused: false, Restarting: false, Dead: false },
    Config: {
      User: '1000:100',
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: null,
      Env: ['HOME=/home/agent', 'PATH=/bin'],
      WorkingDir: '/workspace',
      Labels: { 'reverie.worker': 'fixture', 'reverie.employee': eid, 'reverie.session': sid },
    },
    Mounts: [
      { Type: 'bind', Source: '/synthetic/home', Destination: '/home/agent', RW: true, Propagation: 'rprivate' },
      { Type: 'bind', Source: '/synthetic/nix', Destination: '/nix', RW: true, Propagation: 'rprivate' },
      {
        Type: 'bind',
        Source: '/synthetic/host-script',
        Destination: '/instances/default/console/statusline-exporter.sh',
        RW: false,
      },
    ],
    HostConfig: {
      Privileged: false,
      OomKillDisable: false,
      Memory: 16 * 1024 ** 3,
      MemorySwap: 16 * 1024 ** 3,
      PidsLimit: 512,
      CgroupParent: 'legacy.slice',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Mounts: [],
    },
  });
  const pool = {
    containerId: '1'.repeat(64),
    cgroupParent: 'reverie-box-fixture.slice',
    policyDigest: dockerContinuationDigest(policy.pool),
    physicalDigest: '2'.repeat(64),
  };
  const original = boxedOriginal(source, subject, 'fixture');
  const row: DockerEmployeeContinuationRecord = {
    version: 1,
    purpose: 'docker-employee-continuation-v1',
    employeeId: eid,
    request: {
      operationId: oid,
      sessionId: sid,
      sessionGeneration: 3,
      containerId: cid,
      imageId: image,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: target,
      enterOffice: false,
    },
    sourceDigest: subject.sourceDigest,
    original,
    workerImage: { imageId: target, sourceImageId: image, clientManifestDigest: '4'.repeat(64) },
    policy,
    credentialId: '50000000-0000-4000-8000-000000000005',
    phase: 'pool-ready',
    pool,
  };
  let created: Record<string, unknown> | undefined;
  const command: DockerEngineCommand = {
    run: vi.fn(async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify([source]);
      if (args[0] === 'container' && args[1] === 'ls') return cid;
      if (args[0] === 'image')
        return JSON.stringify([
          {
            Id: args[2],
            RootFS: { Layers: args[2] === image ? ['old'] : ['old', 'new'] },
            Config: {
              Entrypoint: source.Config.Entrypoint,
              Cmd: null,
              Labels: { 'org.reverie.worker-client.manifest': '4'.repeat(64) },
            },
          },
        ]);
      throw Error('Unexpected command');
    }),
    create: vi.fn(async (_name, config, current) => {
      current();
      created = structuredClone(config);
      return dest;
    }),
  };
  const resources: DockerContainedResourceController = {
    validate: vi.fn(async () => {}),
    preparePool: vi.fn(async () => {}),
    observePool: vi.fn(async () => pool),
    read: vi.fn(async () => null),
    configure: vi.fn(async () => {}),
  };
  const journal: DockerContinuationTaskJournal = {
    read: () => undefined,
    publish: async () => {
      throw Error('Unexpected holder mutation');
    },
  };
  const engine = new DockerEmployeeEngine(
    command,
    'fixture',
    resources,
    { imageId: target, clientManifestDigest: '4'.repeat(64), sourceImageIds: [image] },
    journal,
    helper,
    boxId
  );
  return { source, row, engine, command, resources, policy, created: () => created };
}
async function dockerEncodedDestination() {
  const f = fixture();
  f.source.Mounts.push({
    Type: 'bind',
    Source: '/synthetic/workspace',
    Destination: '/workspace',
    RW: false,
    Propagation: 'rprivate',
  });
  f.row.original = boxedOriginal(f.source, subject, 'fixture');
  await f.engine.createDestination(f.row, () => {});
  const desired = f.created()!;
  const observed = DockerEmployeeInspect.parse({
    ...structuredClone(f.source),
    Id: dest,
    Image: target,
    Config: {
      ...structuredClone(f.source.Config),
      User: desired.User,
      Env: desired.Env,
      Labels: desired.Labels,
      Entrypoint: desired.Entrypoint,
      Cmd: desired.Cmd,
    },
    Mounts: f.source.Mounts.filter((m) => m.Destination !== '/instances/default/console/statusline-exporter.sh'),
    HostConfig: {
      ...(desired.HostConfig as Record<string, unknown>),
      OomKillDisable: false,
      Mounts: [
        { Type: 'bind', Source: '/synthetic/home', Target: '/home/agent', BindOptions: { Propagation: 'rprivate' } },
        { Type: 'bind', Source: '/synthetic/nix', Target: '/nix', BindOptions: { Propagation: 'rprivate' } },
        {
          Type: 'bind',
          Source: '/synthetic/workspace',
          Target: '/workspace',
          ReadOnly: true,
          BindOptions: { Propagation: 'rprivate' },
        },
      ],
    },
  });
  const originalRun = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.run).mockImplementation(async (args, options) => {
    if (args[0] === 'container' && args[1] === 'ls') return dest;
    if (args[0] === 'container' && args[1] === 'inspect' && args[2] === dest) return JSON.stringify([observed]);
    return originalRun(args, options);
  });
  return { ...f, observed };
}
describe('new boxed Docker destination', () => {
  it.each([false, null])('known effective OOM-enabled form %j preserves the original complete descriptor', (value) => {
    const f = fixture();
    f.source.HostConfig.OomKillDisable = value;
    expect(boxedOriginal(f.source, subject, 'fixture')).toEqual(f.row.original);
  });
  it('preserves the created destination when Docker start normalizes false OOM flag to null', async () => {
    const f = await dockerEncodedDestination(),
      before = boxedOriginal(f.observed, subject, 'fixture', true);
    f.observed.State.Running = true;
    f.observed.HostConfig.OomKillDisable = null;
    expect(boxedOriginal(f.observed, subject, 'fixture', true)).toEqual(before);
  });
  it.each([true, undefined, 'false', 0])(
    'refuses missing or unsupported OOM value %j instead of treating it as enabled',
    (value) => {
      const f = fixture();
      if (value === undefined) delete f.source.HostConfig.OomKillDisable;
      else f.source.HostConfig.OomKillDisable = value;
      expect(() => boxedOriginal(f.source, subject, 'fixture')).toThrow();
    }
  );
  it('detects a PID limit change alongside normalized OOM flag', async () => {
    const f = fixture();
    f.source.HostConfig.OomKillDisable = null;
    f.source.HostConfig.PidsLimit = 513;
    await expect(f.engine.createDestination(f.row, () => {})).rejects.toThrow();
    expect(f.command.create).not.toHaveBeenCalled();
  });

  it('accepts the actual Docker wire omission of ReadOnly false while preserving true RO', async () => {
    const f = await dockerEncodedDestination();
    const seen = await f.engine.observeDestination(f.row);
    expect(seen?.state).toBe('stopped');
    expect(seen?.provider.kind).toBe('absent');
    expect(f.command.create).toHaveBeenCalledOnce();
  });
  it.each(['lostRO', 'changedRW', 'source', 'propagation'] as const)(
    'refuses Docker wire %s drift instead of relaxing readback',
    async (fault) => {
      const f = await dockerEncodedDestination(),
        mounts = f.observed.HostConfig.Mounts as Record<string, unknown>[];
      if (fault === 'lostRO') delete mounts[2]!.ReadOnly;
      if (fault === 'changedRW') mounts[0]!.ReadOnly = true;
      if (fault === 'source') mounts[0]!.Source = '/synthetic/replacement';
      if (fault === 'propagation') mounts[0]!.BindOptions = { Propagation: 'shared' };
      await expect(f.engine.observeDestination(f.row)).rejects.toMatchObject({
        code: 'DOCKER_CONTINUATION_DESTINATION_CHANGED',
      });
      expect(f.command.create).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])('canonical original accepts actual mount permutation %j without changing storage', async (...indices) => {
    const f = fixture(),
      mounts = structuredClone(f.source.Mounts);
    f.source.Mounts = indices.map((index) => mounts[index]!);
    const before = structuredClone(f.source.Mounts);
    expect(boxedOriginal(f.source, subject, 'fixture')).toEqual(f.row.original);
    await f.engine.createDestination(f.row, () => {});
    expect(f.command.create).toHaveBeenCalledOnce();
    expect(f.source.Mounts).toEqual(before);
  });
  it.each(['source', 'readWrite', 'propagation', 'mode', 'environment', 'hostConfig'] as const)(
    'canonical original still refuses changed %s before any create',
    async (fault) => {
      const f = fixture();
      f.source.Mounts.reverse();
      const nix = f.source.Mounts.find((m) => m.Destination === '/nix')!;
      if (fault === 'source') nix.Source = '/synthetic/replacement';
      if (fault === 'readWrite') nix.RW = false;
      if (fault === 'propagation') nix.Propagation = 'shared';
      if (fault === 'mode') nix.Mode = 'z';
      if (fault === 'environment') f.source.Config.Env.push('EXTRA=changed');
      if (fault === 'hostConfig') f.source.HostConfig.CpuShares = 2048;
      await expect(f.engine.createDestination(f.row, () => {})).rejects.toThrow();
      expect(f.command.create).not.toHaveBeenCalled();
    }
  );
  it('canonical original rejects duplicate destinations instead of dropping a mount', () => {
    const f = fixture();
    f.source.Mounts.push({ ...f.source.Mounts[1]!, Source: '/synthetic/second-nix' });
    expect(() => boxedOriginal(f.source, subject, 'fixture')).toThrow();
  });

  it('captures original observed home while preserving desired48/high16 separately from old16 drift', async () => {
    const f = fixture(),
      seen = await f.engine.observeSource(subject, cid);
    expect(seen.original.home.source).toBe('/synthetic/home');
    await f.engine.validateCapabilities(seen.original, f.policy);
    expect(f.resources.validate).toHaveBeenCalledWith(seen.original, f.policy);
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('creates only a NEW inert destination with exact hard/noSwap/PIDs and retained storage, without host executor mount', async () => {
    const f = fixture();
    await f.engine.createDestination(f.row, () => {});
    const config = f.created()!;
    expect(config).toMatchObject({
      Image: target,
      User: '1000:100',
      Cmd: [],
      HostConfig: {
        Memory: 48 * 1024 ** 3,
        MemorySwap: 48 * 1024 ** 3,
        PidsLimit: 512,
        CpuShares: 0,
        CgroupParent: 'reverie-box-fixture.slice',
      },
    });
    expect(config).not.toHaveProperty('MemoryReservation');
    expect((config.HostConfig as Record<string, unknown>).Mounts).toEqual(boxedMountConfiguration(f.source));
    expect(config.Env).toEqual([
      'HOME=/home/agent',
      'PATH=/opt/reverie-worker-client/bin:/bin',
      'REVERIE_CLI=/opt/reverie-worker-client/bin/reverie',
    ]);
    expect(JSON.stringify(config)).not.toContain('host-script');
    expect(f.source.State.Running).toBe(false);
  });
  it.each(['running', 'mount', 'identity', 'security'] as const)(
    'refuses original %s drift before create',
    async (fault) => {
      const f = fixture();
      if (fault === 'running') f.source.State.Running = true;
      if (fault === 'mount') f.source.Mounts[0]!.Source = '/replacement';
      if (fault === 'identity') f.source.Config.Labels!['reverie.employee'] = 'foreign';
      if (fault === 'security') f.source.HostConfig.Privileged = true;
      await expect(f.engine.createDestination(f.row, () => {})).rejects.toThrow();
      expect(f.command.create).not.toHaveBeenCalled();
    }
  );
  it('refuses revoked actual authority after asynchronous image inspection', async () => {
    const f = fixture();
    await expect(
      f.engine.createDestination(f.row, () => {
        throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('refuses changed actual pool before create', async () => {
    const f = fixture();
    vi.mocked(f.resources.observePool).mockResolvedValue({ ...f.row.pool!, physicalDigest: '9'.repeat(64) });
    await expect(f.engine.createDestination(f.row, () => {})).rejects.toMatchObject({
      code: 'DOCKER_CONTINUATION_POOL_CHANGED',
    });
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('requires immutable source prefix and actual capsule label', async () => {
    const f = fixture(),
      base = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (a, b) => {
      if (a[0] === 'image' && a[2] === target)
        return JSON.stringify([
          { Id: target, RootFS: { Layers: ['foreign'] }, Config: { Entrypoint: null, Cmd: null, Labels: {} } },
        ]);
      return base(a, b);
    });
    await expect(f.engine.image(f.row.original)).rejects.toThrow();
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('retained mount projection excludes only obsolete host executors, not private storage', () => {
    const f = fixture(),
      mounts = boxedStorageMounts(f.source);
    expect(mounts.map((m) => m.destination)).toEqual(['/home/agent', '/nix']);
  });
  it('rejects zero high at the shared policy boundary and preserves null as unbounded DATA', () => {
    const f = fixture();
    expect(DockerEmployeeResourcePolicy.safeParse({ ...f.policy, memoryHighBytes: 0 }).success).toBe(false);
    expect(DockerEmployeeResourcePolicy.parse({ ...f.policy, memoryHighBytes: null }).memoryHighBytes).toBeNull();
  });
});

it('the same client operation in two private Boxes cannot share a destination name', async () => {
  const a = fixture('7'.repeat(64)),
    b = fixture('8'.repeat(64));
  await a.engine.createDestination(a.row, () => {});
  await b.engine.createDestination(b.row, () => {});
  expect(vi.mocked(a.command.create).mock.calls[0]![0]).not.toBe(vi.mocked(b.command.create).mock.calls[0]![0]);
});
