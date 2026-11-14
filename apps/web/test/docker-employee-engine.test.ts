import { DOCKER_CODEX_WORKSPACE_PROGRAM } from '../src/docker-employee-codex-workspace.js';
import { encodeDockerProviderPlacement } from '../src/web/public/docker-provider-health-placement.js';
import { DockerProviderHealth } from '../src/docker-provider-health.js';
import { providerHealthBinding } from '../src/worker-provider-health.js';
import { EmployeeSchema } from '../src/company-types.js';
import type { CompanyEmployee } from '../src/company-types.js';
import { DockerEmployeeProviderHealthProof } from '../src/docker-employee-engine.js';
import { describe, it, expect, vi } from 'vitest';
import {
  DockerEmployeeEngine,
  DockerEmployeeProviderView,
  requireDockerEmployeeProviderView,
  type DockerContainedResourceController,
} from '../src/docker-employee-engine.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from '../src/docker-employee-provider-view-native.js';
import type { SessionDocker } from '../src/types.js';
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
async function providerViewFixture() {
  const f = await dockerEncodedDestination();
  f.observed.State.Running = true;
  f.row.destination = boxedOriginal(f.observed, subject, 'fixture', true);
  f.row.phase = 'ready';
  const pane = { paneId: '%1', panePid: 42, paneStartTicks: '987654', hookGeneration: 'synthetic.current:1' };
  const original = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.run).mockImplementation(async (args, input) => {
    if (args[0] === 'exec' && args.includes(DOCKER_PROVIDER_VIEW_PROGRAM)) return JSON.stringify(pane) + '\n';
    return original(args, input);
  });
  const docker: SessionDocker = {
    hostId: 'boxed-runtime',
    label: 'Docker-contained employee',
    engine: 'docker',
    image: target,
    containerName: dest,
    hostWorkspacePath: '/',
    containerWorkdir: '/workspace',
    network: 'bridge',
    mountCredentials: false,
    hooksEnabled: false,
    resumeOnStart: true,
    owned: false,
    daemonHost: 'unix:///run/reverie-engine/docker.sock',
    continuation: {
      operationId: oid,
      employeeId: eid,
      sessionGeneration: 3,
      clientManifestDigest: '4'.repeat(64),
      apiUrl: 'http://reverie:3000',
    },
  };
  return { ...f, pane, docker };
}
describe('Engine-owned existing Docker provider view', () => {
  it('captures full native placement and two matching PID births without any provider effect', async () => {
    const f = await providerViewFixture();
    vi.mocked(f.command.run).mockClear();
    const view = await f.engine.captureProviderView(f.row, () => {});
    requireDockerEmployeeProviderView(view, sid, f.docker);
    expect(view.descriptor).toMatchObject({
      ...f.pane,
      containerId: dest,
      imageId: target,
      operationId: oid,
      sessionId: sid,
      sessionGeneration: 3,
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.descriptor)).toBe(true);
    const calls = vi.mocked(f.command.run).mock.calls.map(([args]) => args);
    expect(calls.filter((args) => args[0] === 'exec')).toHaveLength(2);
    expect(
      calls.every(
        (args) =>
          (args[0] === 'container' && ['ls', 'inspect'].includes(args[1]!)) ||
          (args[0] === 'exec' && args.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && args.at(-3) === 'observe')
      )
    ).toBe(true);
  });
  it('cannot mint or impersonate an original view, even through its public prototype', async () => {
    const f = await providerViewFixture();
    const current = vi.fn();
    expect(() => new DockerEmployeeProviderView(Symbol('forged'), {} as never, current)).toThrow('Original Engine');
    const forged = Object.create(DockerEmployeeProviderView.prototype, {
      require: { value: current },
      current: { value: current },
    });
    expect(() => requireDockerEmployeeProviderView(forged, sid, f.docker)).toThrow();
    expect(() => requireDockerEmployeeProviderView({}, sid, f.docker)).toThrow();
    expect(current).not.toHaveBeenCalled();
  });
  it.each(['stopped', 'phase', 'pid', 'birth', 'generation'] as const)(
    'refuses changed %s observations before granting a view',
    async (kind) => {
      const f = await providerViewFixture();
      if (kind === 'stopped') f.observed.State.Running = false;
      if (kind === 'phase') f.row.phase = 'provider-issued';
      if (['pid', 'birth', 'generation'].includes(kind)) {
        const original = vi.mocked(f.command.run).getMockImplementation()!;
        let reads = 0;
        vi.mocked(f.command.run).mockImplementation(async (args, input) => {
          if (args[0] === 'exec' && args.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && ++reads === 2)
            return JSON.stringify({
              ...f.pane,
              ...(kind === 'pid'
                ? { panePid: 43 }
                : kind === 'birth'
                  ? { paneStartTicks: '987655' }
                  : { hookGeneration: 'changed' }),
            });
          return original(args, input);
        });
      }
      await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow();
    }
  );
  it('refuses foreign placement and permanently revokes a captured view on currency loss', async () => {
    const f = await providerViewFixture();
    let current = true;
    const view = await f.engine.captureProviderView(f.row, () => {
      if (!current) throw Error('revoked');
    });
    expect(() => requireDockerEmployeeProviderView(view, sid, { ...f.docker, image })).toThrow();
    expect(() =>
      requireDockerEmployeeProviderView(view, sid, {
        ...f.docker,
        continuation: { ...f.docker.continuation!, sessionGeneration: 4 },
      })
    ).toThrow();
    current = false;
    expect(() => requireDockerEmployeeProviderView(view, sid, f.docker)).toThrow();
    current = true;
    expect(() => requireDockerEmployeeProviderView(view, sid, f.docker)).toThrow();
  });
  it.each(['/opt', '/opt/reverie-worker-tools', '/opt/reverie-worker-tools/bin/tmux', '/opt/reverie-worker-client'])(
    'refuses readonly capsule shadow %s before creating a worker',
    async (path) => {
      const f = fixture();
      f.source.Mounts.push({ Type: 'bind', Source: '/synthetic/shadow', Destination: path, RW: false });
      f.row.original = boxedOriginal(f.source, subject, 'fixture');
      await expect(f.engine.createDestination(f.row, () => {})).rejects.toMatchObject({
        code: 'DOCKER_CONTINUATION_CAPSULE_MOUNT_SHADOW',
      });
      expect(f.command.create).not.toHaveBeenCalled();
    }
  );
});
describe('new boxed Docker destination', () => {
  it('tightens only the NEW worker no-new-privileges setting and preserves exact seccomp and source', async () => {
    const f = fixture();
    const seccomp = 'seccomp={"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}';
    f.source.HostConfig.SecurityOpt = [seccomp, 'no-new-privileges=false'];
    f.row.original = boxedOriginal(f.source, subject, 'fixture');
    await f.engine.createDestination(f.row, () => {});
    expect((f.created()!.HostConfig as Record<string, unknown>).SecurityOpt).toEqual([seccomp, 'no-new-privileges']);
    expect(f.source.HostConfig.SecurityOpt).toEqual([seccomp, 'no-new-privileges=false']);
  });
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
      'TERMINFO=/opt/reverie-worker-tools/share/terminfo',
      'TERMINFO_DIRS=/opt/reverie-worker-tools/share/terminfo',
      'LOCALE_ARCHIVE=/opt/reverie-worker-tools/share/locale/locale-archive',
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

describe('Engine-owned first-launch Codex workspace observation', () => {
  async function workspaceFixture() {
    const f = await dockerEncodedDestination();
    f.observed.State.Running = true;
    f.row.destination = boxedOriginal(f.observed, subject, 'fixture', true);
    f.row.phase = 'provider-issued';
    const run = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      if (args.includes(DOCKER_CODEX_WORKSPACE_PROGRAM))
        return JSON.stringify({ realPath: '/workspace/case', dev: '7', ino: '8', hooksText: null });
      return run(args, input);
    });
    return f;
  }
  it('brackets fixed protected-Node read with actual producer configuration and selects its covering mount', async () => {
    const f = await workspaceFixture();
    vi.mocked(f.command.run).mockClear();
    expect(await f.engine.observeCodexWorkspace(f.row, '/workspace/case', () => {})).toEqual({
      realPath: '/workspace/case',
      dev: '7',
      ino: '8',
      hooksText: null,
    });
    const calls = vi.mocked(f.command.run).mock.calls.map(([a]) => a);
    const native = calls.filter((a) => a.includes(DOCKER_CODEX_WORKSPACE_PROGRAM));
    expect(native).toHaveLength(1);
    expect(native[0]!.slice(-4)).toEqual(['--', 'observe', '/workspace/case', '/workspace']);
    expect(native[0]).toContain('NODE_OPTIONS=');
    expect(calls.filter((a) => a[0] === 'container' && a[1] === 'inspect' && a[2] === dest)).toHaveLength(2);
    expect(f.command.create).toHaveBeenCalledTimes(1); // only fixture's inert creation
  });
  it.each(['outside', 'changed-config', 'revoked', 'wrong-phase', 'escape-readback'])(
    'refuses %s without a provider mutation',
    async (kind) => {
      const f = await workspaceFixture();
      if (kind === 'changed-config') f.observed.Config.Env.push('CHANGED=1');
      if (kind === 'wrong-phase') f.row.phase = 'ready';
      if (kind === 'escape-readback') {
        const run = vi.mocked(f.command.run).getMockImplementation()!;
        vi.mocked(f.command.run).mockImplementation((a, i) =>
          a.includes(DOCKER_CODEX_WORKSPACE_PROGRAM)
            ? Promise.resolve(JSON.stringify({ realPath: '/other', dev: '7', ino: '8', hooksText: null }))
            : run(a, i)
        );
      }
      await expect(
        f.engine.observeCodexWorkspace(f.row, kind === 'outside' ? '/other' : '/workspace/case', () => {
          if (kind === 'revoked') throw Error('revoked');
        })
      ).rejects.toThrow();
      expect(f.command.create).toHaveBeenCalledTimes(1);
    }
  );
  it('refuses a native read whose exact committed destination changes before final observation', async () => {
    const f = await workspaceFixture();
    const run = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (a, i) => {
      const value = await run(a, i);
      if (a.includes(DOCKER_CODEX_WORKSPACE_PROGRAM)) f.observed.Config.Env.push('CHANGED=1');
      return value;
    });
    await expect(f.engine.observeCodexWorkspace(f.row, '/workspace/case', () => {})).rejects.toThrow();
    expect(f.command.create).toHaveBeenCalledTimes(1);
  });
});

async function healthFixture() {
  const f = await providerViewFixture();
  f.observed.State.Pid = 42;
  const binding = {
    version: 1 as const,
    operationId: oid,
    credentialId: f.row.credentialId,
    sessionId: sid,
    sessionGeneration: 3,
    containerId: dest,
    imageId: target,
    originalDigest: dockerContinuationDigest(f.row.destination),
    policyDigest: dockerContinuationDigest(f.row.policy),
  };
  const employee = EmployeeSchema.parse({
    id: eid,
    sessionId: sid,
    sessionGeneration: 3,
    name: 'Health fixture',
    icon: 'F',
    position: 'Expert',
    expertise: ['systems'],
    createdAt: 1,
    desiredRunning: true,
    onVacation: false,
    dockerBinding: binding,
  });
  let mode: 'live' | 'absent' | 'error' | 'mixed' = 'live',
    calls = 0;
  const original = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.run).mockImplementation(async (args, input) => {
    if (args.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && args.includes('presence')) {
      calls++;
      if (mode === 'error') throw Error('private transport cause');
      if (mode === 'absent' || (mode === 'mixed' && calls % 2 === 1)) return 'ABSENT\n';
      return JSON.stringify(f.pane);
    }
    return original(args, input);
  });
  let rows = [employee],
    epoch = 10_000,
    mono = 100,
    active = true;
  const changed = vi.fn(),
    observe = vi.fn((_e: CompanyEmployee, current: () => void) =>
      f.engine.captureProviderHealth(f.row, binding, current)
    );
  const health = new DockerProviderHealth({
    employees: () => rows,
    active: () => active,
    observe,
    changed,
    now: () => epoch,
    monotonic: () => mono,
  });
  return {
    ...f,
    employee,
    binding,
    health,
    observe,
    changed,
    setMode: (m: typeof mode) => {
      mode = m;
      calls = 0;
    },
    rows: (v: CompanyEmployee[]) => {
      rows = v;
    },
    advance: (n: number) => {
      epoch += n;
      mono += n;
    },
    epoch: (n: number) => {
      epoch = n;
    },
    mono: (n: number) => {
      mono = n;
    },
    active: (v: boolean) => {
      active = v;
    },
  };
}
describe('read-only Docker provider health', () => {
  it('earns live health from actual Engine/private native-view proof without resources, credentials or viewer input', async () => {
    const f = await healthFixture();
    vi.mocked(f.resources.read).mockClear();
    vi.mocked(f.resources.observePool).mockClear();
    vi.mocked(f.command.run).mockClear();
    await f.health.refresh();
    expect(f.health.read(f.employee)).toEqual({
      binding: providerHealthBinding(f.employee),
      employeeId: eid,
      sessionId: sid,
      sessionGeneration: 3,
      state: 'healthy',
      observedAtEpochMs: 10_000,
      reason: 'LIVE_NATIVE_COMMAND',
      dockerPlacement: encodeDockerProviderPlacement(f.employee.dockerBinding),
    });
    expect(f.health.read(sid, { owner: 'foreign' })).toBeUndefined();
    expect(f.resources.read).not.toHaveBeenCalled();
    expect(f.resources.observePool).not.toHaveBeenCalled();
    const calls = vi.mocked(f.command.run).mock.calls.map(([a]) => a);
    expect(calls.filter((a) => a[0] === 'exec')).toHaveLength(2);
    expect(
      calls
        .filter((a) => a[0] === 'exec')
        .every((a) => a.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && a.includes('presence'))
    ).toBe(true);
    expect(f.health.read(f.employee)?.dockerPlacement).toBe(encodeDockerProviderPlacement(f.binding));
    expect(f.health.read(f.employee)).not.toHaveProperty('panePid');
    expect(f.health.read(f.employee)).not.toHaveProperty('view');
    expect(f.command.create).toHaveBeenCalledTimes(1); // only fixture's inert producer setup
  });
  it('missing canonical provider is unknown before any live observation, including pending initial dispatch', async () => {
    const f = await healthFixture();
    f.setMode('absent');
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('unknown');
    f.row.phase = 'provider-issued';
    f.advance(1);
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('unknown');
  });
  it('classifies fresh double absence as dead only after a genuine live proof of the same private binding', async () => {
    const f = await healthFixture();
    await f.health.refresh();
    f.setMode('absent');
    f.advance(1);
    await f.health.refresh();
    expect(f.health.read(f.employee)).toMatchObject({ state: 'dead', reason: 'COMMAND_EXITED' });
  });
  it('uses twice-observed exact stopped PID0 without inventing provider or init PID proof', async () => {
    const f = await healthFixture();
    f.observed.State.Running = false;
    f.observed.State.Pid = 0;
    await f.health.refresh();
    expect(f.health.read(f.employee)).toMatchObject({ state: 'dead', reason: 'CONTAINER_STOPPED' });
    f.observed.State.Pid = 9;
    f.advance(1);
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('unknown');
  });
  it.each(['error', 'mixed'] as const)('turns %s into visible unknown rather than retaining healthy', async (mode) => {
    const f = await healthFixture();
    await f.health.refresh();
    f.setMode(mode);
    f.advance(1);
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('unknown');
    expect(JSON.stringify(f.health.read(f.employee))).not.toContain('private transport cause');
  });
  it.each([
    'owner',
    'generation',
    'CID',
    'operation',
    'permissions',
    'recipe',
    'vacation',
    'desired',
    'migration',
    'removed',
  ] as const)('refuses late physical proof after %s CAS swap and cannot revive its old cache', async (change) => {
    const f = await healthFixture();
    await f.health.refresh();
    let release!: (value: DockerEmployeeProviderHealthProof) => void;
    const genuine = await f.engine.captureProviderHealth(f.row, f.binding, () => {});
    f.observe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = f.health.refresh(),
      changed = structuredClone(f.employee);
    if (change === 'owner') changed.owner = 'foreign';
    if (change === 'generation') changed.sessionGeneration++;
    if (change === 'CID') changed.dockerBinding!.containerId = '8'.repeat(64);
    if (change === 'operation') changed.dockerBinding!.operationId = '80000000-0000-4000-8000-000000000008';
    if (change === 'permissions') changed.permissions.recoverEmployees = !changed.permissions.recoverEmployees;
    if (change === 'recipe') changed.runtimeRecipe = { cwd: '/different' } as never;
    if (change === 'vacation') changed.onVacation = true;
    if (change === 'desired') changed.desiredRunning = false;
    if (change === 'migration') changed.bindingMigration = {} as never;
    f.rows(change === 'removed' ? [] : [changed]);
    release(genuine);
    await pending;
    expect(f.health.read(changed)).toBeUndefined();
    f.rows([f.employee]);
    expect(f.health.read(f.employee)).toBeUndefined();
  });
  it('does not accept a forged/prototype foreign proof or an old genuine view from another bound employee', async () => {
    const f = await healthFixture();
    const foreign = await f.engine.captureProviderHealth(f.row, f.binding, () => {});
    const callback = vi.fn(() => 'live');
    f.observe.mockResolvedValueOnce({ require: callback } as never);
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('unknown');
    expect(callback).not.toHaveBeenCalled();
    f.advance(1);
    f.observe.mockResolvedValueOnce(Object.create(DockerEmployeeProviderHealthProof.prototype));
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('unknown');
    const changed = structuredClone(f.employee);
    changed.dockerBinding!.containerId = '9'.repeat(64);
    f.rows([changed]);
    f.advance(1);
    f.observe.mockResolvedValueOnce(foreign);
    await f.health.refresh();
    expect(f.health.read(changed)?.state).toBe('unknown');
  });
  it('expires monotonically and invalidates wall-clock rollback, runtime closure, and close without reviving old health', async () => {
    const f = await healthFixture();
    await f.health.refresh();
    f.advance(25_001);
    expect(f.health.read(f.employee)).toBeUndefined();
    f.epoch(9999);
    expect(f.health.read(f.employee)).toBeUndefined();
    f.epoch(10_000);
    await f.health.refresh();
    expect(f.health.read(f.employee)).toBeUndefined();
    f.epoch(40_000);
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('healthy');
    f.active(false);
    expect(f.health.read(f.employee)).toBeUndefined();
    f.active(true);
    expect(f.health.read(f.employee)).toBeUndefined();
    f.health.close();
    await f.health.refresh();
    expect(f.health.read(f.employee)).toBeUndefined();
  });
  it('coalesces callers, limits two workers, refuses over64 and suppresses late publication after close', async () => {
    const f = await healthFixture();
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0,
      maximum = 0;
    f.rows(
      Array.from({ length: 6 }, (_, i) => ({
        ...structuredClone(f.employee),
        id: `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000001`,
        sessionId: `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000002`,
      }))
    );
    f.observe.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await pause;
      active--;
      throw Error('read only');
    });
    const first = f.health.refresh();
    expect(f.health.refresh()).toBe(first);
    expect(f.observe).toHaveBeenCalledTimes(2);
    f.health.close();
    release();
    await first;
    expect(maximum).toBe(2);
    expect(f.observe).toHaveBeenCalledTimes(2);
    expect(f.changed).not.toHaveBeenCalled();
    const g = await healthFixture();
    g.rows(Array.from({ length: 65 }, () => structuredClone(g.employee)));
    await g.health.refresh();
    expect(g.observe).not.toHaveBeenCalled();
  });
  it('publishes a completed native fact without waiting for an unrelated slow worker', async () => {
    const f = await healthFixture(),
      other = {
        ...structuredClone(f.employee),
        id: '80000000-0000-4000-8000-000000000008',
        sessionId: '90000000-0000-4000-8000-000000000009',
      };
    f.rows([f.employee, other]);
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.observe.mockImplementation(async (employee, current) => {
      if (employee.id === other.id) {
        await pause;
        throw Error('unconfirmed');
      }
      return f.engine.captureProviderHealth(f.row, f.binding, current);
    });
    const pending = f.health.refresh();
    await vi.waitFor(() => {
      expect(f.health.read(f.employee)?.state).toBe('healthy');
      expect(f.changed).toHaveBeenCalled();
    });
    f.health.close();
    release();
    await pending;
  });
});
