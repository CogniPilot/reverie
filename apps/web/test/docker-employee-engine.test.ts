import { DockerPlanInitialReceipt } from '../src/docker-plan-install-data.js';
import { DockerEphemeralRestoration } from '../src/docker-ephemeral-restoration.js';
import { dockerPlanDestinationEnvironment } from '../src/docker-plan-install-data.js';
import type { EphemeralJournal } from '../src/docker-ephemeral-data.js';
import * as cliRegistry from '../src/config/cli-registry/registry.js';
import { DOCKER_CODEX_WORKSPACE_PROGRAM } from '../src/docker-employee-codex-workspace.js';
import { encodeDockerProviderPlacement } from '../src/docker-provider-health-placement.js';
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
import {
  DOCKER_PROVIDER_VIEW_PROGRAM,
  dockerProviderRuntimeArguments,
  dockerProviderSocketLabel,
  dockerPlanProviderSelection,
} from '../src/docker-employee-provider-view-native.js';
import { runInNewContext } from 'node:vm';
import { dockerPlanRetirementFixture } from './helpers/docker-plan-retirement-fixture.js';
import type { SessionDocker } from '../src/types.js';
import {
  DockerEmployeePlanReplacementWorkRecord,
  DockerEmployeeResourcePolicy,
  DockerEmployeeContinuationRecord,
} from '../src/docker-employee-continuation-data.js';
import {
  DockerEmployeeInspect,
  boxedOriginal,
  boxedMountConfiguration,
  boxedStorageMounts,
} from '../src/docker-employee-engine-data.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import { allowedDockerTaskTransition, type DockerContinuationTaskJournal } from '../src/docker-continuation-task.js';
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
  providerSourceDigest: 'e'.repeat(64),
  onVacation: false,
  desiredRunning: true,
};
/** Execute the actual fixed native program over controlled read-only syscall
 * ports. No tmux/Docker process is launched and no private proof is fabricated. */
function namespaceNative(mode: 'presence' | 'observe' | 'attach', runtimeNamespace?: 'session-v1', badPrefix?: string) {
  const legacy = '/tmp/tmux-1000/reverie-docker',
    calls: string[][] = [],
    paths: string[] = [];
  let stdout = '',
    exit: number | undefined;
  const stopped = new Error('bounded native exit');
  const directory = (uid: number) => ({
    uid,
    mode: 0o40700,
    isDirectory: () => true,
    isFile: () => false,
    isSocket: () => false,
  });
  const fsPort = {
    lstatSync(p: string) {
      paths.push(p);
      if (p === '/opt/reverie-worker-tools/bin/tmux') return { uid: 0, mode: 0o100555, isFile: () => true };
      if (p === '/tmp/tmux-1000') return directory(1000);
      if (p === legacy) return { uid: 1000, isSocket: () => true };
      if (p.startsWith('/tmp/tmux-1000/')) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return directory(0);
    },
    statfsSync: () => ({ type: 0x9fa0 }),
    statSync: () => ({ uid: 1000 }),
    readFileSync(p: string) {
      return p === '/proc/self/status'
        ? 'NoNewPrivs: 1\nCapInh: 0\nCapPrm: 0\nCapEff: 0\nCapAmb: 0\n'
        : '42 (fixed) S ' + Array(18).fill('0').join(' ') + ' 123';
    },
  };
  const args = [badPrefix ?? dockerProviderRuntimeArguments(runtimeNamespace)[0], mode, sid, oid, 'none'].filter(
    (x) => x !== undefined
  );
  if (mode === 'attach') args.push('%1', '42', '123', '');
  const processPort = {
    argv: ['node', ...args],
    getuid: () => 1000,
    env: {},
    stdout: {
      write: (s: string) => {
        stdout += s;
      },
    },
    exit: (code: number) => {
      exit = code;
      throw stopped;
    },
  };
  const child = {
    spawnSync(_program: string, argv: string[]) {
      calls.push(argv);
      const label = argv[argv.indexOf('-L') + 1];
      if (label === 'reverie-docker') return { status: 1, stdout: '', stderr: 'no server running' };
      if (argv.includes('display-message')) return { status: 0, stdout: '%1 0 42\n' };
      if (argv.includes('show-environment'))
        return {
          status: 0,
          stdout:
            argv.at(-1) === 'REVERIE_SESSION_ID'
              ? 'REVERIE_SESSION_ID=' + sid + '\n'
              : 'REVERIE_DOCKER_OPERATION_ID=' + oid + '\n',
        };
      return { status: 0, stdout: '' };
    },
  };
  try {
    runInNewContext(
      DOCKER_PROVIDER_VIEW_PROGRAM,
      { require: (name: string) => (name === 'node:fs' ? fsPort : child), process: processPort },
      { timeout: 1000 }
    );
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return { stdout, exit, calls, paths };
}
describe('fixed Docker provider runtime namespace', () => {
  it('leaves a stale legacy socket untouched and proves only the new scoped socket absent', () => {
    expect(() => namespaceNative('presence')).toThrow('Existing Docker provider view unavailable');
    const result = namespaceNative('presence', 'session-v1');
    expect(result.stdout).toBe('ABSENT\n');
    expect(result.exit).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.paths).toContain('/tmp/tmux-1000/' + dockerProviderSocketLabel(sid, 'session-v1'));
    expect(result.paths).not.toContain('/tmp/tmux-1000/reverie-docker');
  });
  it.each(['observe', 'attach'] as const)('uses only the exact new SID label for %s', (mode) => {
    const result = namespaceNative(mode, 'session-v1');
    expect(result.calls.length).toBeGreaterThan(1);
    expect(
      result.calls.every((args) => args[args.indexOf('-L') + 1] === dockerProviderSocketLabel(sid, 'session-v1'))
    ).toBe(true);
    if (mode === 'observe') expect(JSON.parse(result.stdout).paneStartTicks).toBe('123');
    else expect(result.exit).toBe(0);
  });
  it('refuses unknown scope selectors and malformed SIDs without falling back', () => {
    expect(() => namespaceNative('presence', undefined, '--runtime-namespace=unknown')).toThrow();
    expect(() => dockerProviderSocketLabel('../arbitrary', 'session-v1')).toThrow();
    expect(() => dockerProviderSocketLabel(sid, 'unknown' as never)).toThrow();
    expect(() => dockerProviderRuntimeArguments('unknown' as never)).toThrow();
  });
  it('keeps old unmarked v3 projection byte shape after JSON reload', () => {
    const selected = dockerPlanProviderSelection({
      account: { provider: 'anthropic', projectionDigest: '8'.repeat(64) },
    });
    expect(Object.hasOwn(selected, 'runtimeNamespace')).toBe(false);
    expect(JSON.parse(JSON.stringify(selected))).toEqual(selected);
    expect(dockerProviderSocketLabel(sid)).toBe('reverie-docker');
  });
  it('binds scoped native reads and the genuine Engine view to the exact reloaded Session descriptor', async () => {
    const f = await dockerPlanRetirementFixture({ runtimeNamespace: 'session-v1' }),
      docker = f.target.docker!;
    const view = await f.engine.captureProviderView(f.state.work!, () => {});
    expect(view.descriptor.planReplacement?.runtimeNamespace).toBe('session-v1');
    view.require(f.target.id, JSON.parse(JSON.stringify(docker)));
    const changed = structuredClone(docker);
    delete changed.continuation!.planReplacement!.runtimeNamespace;
    expect(() => view.require(f.target.id, changed)).toThrow('PROVIDER_VIEW_CHANGED');
    expect(() => view.require(oid, docker)).toThrow('PROVIDER_VIEW_CHANGED');
    const reads = vi
      .mocked(f.command.run)
      .mock.calls.map(([args]) => args)
      .filter((a) => a.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && a.includes(f.target.id));
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((a) => a.includes('--runtime-namespace=session-v1'))).toBe(true);
    f.engine.close();
  });
});
function fixture(boxId = '7'.repeat(64), ephemeral = false, mode = 'claude') {
  const policy = DockerEmployeeResourcePolicy.parse({
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
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
      Labels: {
        'reverie.worker': 'fixture',
        'reverie.employee': eid,
        'reverie.session': sid,
      },
    },
    Mounts: [
      {
        Type: 'bind',
        Source: '/synthetic/home',
        Destination: '/home/agent',
        RW: true,
        Propagation: 'rprivate',
      },
      {
        Type: 'bind',
        Source: '/synthetic/nix',
        Destination: '/nix',
        RW: true,
        Propagation: 'rprivate',
      },
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
    workerImage: {
      imageId: target,
      sourceImageId: image,
      clientManifestDigest: '4'.repeat(64),
    },
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
  const journal: DockerContinuationTaskJournal & Partial<EphemeralJournal> = {
    read: () => undefined,
    publish: async () => {
      throw Error('Unexpected holder mutation');
    },
  };
  if (ephemeral)
    Object.assign(journal, {
      readEphemeral: () => undefined,
      publishEphemeral: async () => {
        throw Error('Unexpected metadata mutation');
      },
    });
  const engine = new DockerEmployeeEngine(
    command,
    'fixture',
    resources,
    {
      imageId: target,
      clientManifestDigest: '4'.repeat(64),
      sourceImageIds: [image],
    },
    journal,
    helper,
    boxId,
    () => mode
  );
  return {
    source,
    row,
    engine,
    command,
    resources,
    policy,
    journal,
    created: () => created,
  };
}
async function dockerEncodedDestination(ephemeral = false, mode = 'claude') {
  const f = fixture('7'.repeat(64), ephemeral, mode);
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
        {
          Type: 'bind',
          Source: '/synthetic/home',
          Target: '/home/agent',
          BindOptions: { Propagation: 'rprivate' },
        },
        {
          Type: 'bind',
          Source: '/synthetic/nix',
          Target: '/nix',
          BindOptions: { Propagation: 'rprivate' },
        },
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
async function providerViewFixture(ephemeral = false, mode = 'claude') {
  const f = await dockerEncodedDestination(ephemeral, mode);
  f.observed.State.Running = true;
  f.observed.State.Pid = 123;
  f.observed.State.StartedAt = '2026-11-16T10:00:00.000000000Z';
  f.row.destination = boxedOriginal(f.observed, subject, 'fixture', true);
  f.row.phase = 'ready';
  const pane = {
    paneId: '%1',
    panePid: 42,
    paneStartTicks: '987654',
    hooks: mode === 'codex' ? { kind: 'none' } : { kind: 'generation', generation: 'synthetic.current:1' },
  };
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
/** Earn the real retained Storage cursor before deleting the historical source.
 * Only Docker syscall replies are controlled; no Engine/Storage method is mocked. */
async function retainedStoppedFixture(version: 1 | 2 = 2) {
  const f = await providerViewFixture(),
    holderId = '6'.repeat(64),
    network = '5'.repeat(64);
  const storage = {
    version: 1,
    purpose: 'reverie-boxed-storage-observation-v1',
    holderStartTicks: '123',
    home: { dev: '4', ino: '5', uid: 1000, gid: 100, mode: 16832 },
    nix: { dev: '4', ino: '6', uid: 1000, gid: 100, mode: 16832 },
  };
  let holder: Record<string, unknown> | undefined;
  f.journal.read = (_row, role) => f.row.tasks?.find((t) => t.role === role);
  f.journal.publish = async (_row, before, next, current) => {
    current();
    expect(f.row.tasks?.find((t) => t.role === next.role)).toEqual(before);
    expect(allowedDockerTaskTransition(before, next)).toBe(true);
    f.row.tasks = [...(f.row.tasks ?? []).filter((t) => t.role !== next.role), structuredClone(next)];
    return f.row;
  };
  const original = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.create).mockImplementation(async (_name, config, current) => {
    current();
    expect(config.Cmd).toEqual(['hold-storage']);
    const host = config.HostConfig as Record<string, unknown>;
    holder = {
      Id: holderId,
      Image: config.Image,
      Config: { User: config.User, Entrypoint: config.Entrypoint, Cmd: config.Cmd, Labels: config.Labels },
      HostConfig: structuredClone(host),
      Mounts: (host.Mounts as Array<{ Source: string; Target: string }>).map((m) => ({
        Source: m.Source,
        Destination: m.Target,
        RW: false,
      })),
      State: { Running: false, Status: 'created', Pid: 0 },
    };
    return holderId;
  });
  vi.mocked(f.command.run).mockImplementation(async (args, input) => {
    if (args[0] === 'container' && args[1] === 'ls' && args.some((a) => a.startsWith('label=reverie.box.storage.')))
      return holder ? holderId : '';
    if (args[0] === 'container' && args[1] === 'inspect' && args[2] === holderId) return JSON.stringify([holder]);
    if (args[0] === 'container' && args[1] === 'start' && args[2] === holderId) {
      holder!.State = { Running: true, Status: 'running', Pid: 987 };
      return holderId;
    }
    if (args[0] === 'logs' && args[1] === holderId) return JSON.stringify(storage);
    if (args[0] === 'exec' && args[1] === holderId && args.includes('storage-status')) return JSON.stringify(storage);
    return original(args, input);
  });
  await f.engine.prepareStorage(f.row, () => {});
  expect(f.row.tasks?.[0]).toMatchObject({ phase: 'running', initPid: 987, initStartTicks: '123' });
  if (version === 2)
    Object.assign(f.row, {
      version: 2,
      purpose: 'docker-employee-continuation-v2',
      providerSourceDigest: subject.providerSourceDigest,
    });
  DockerEmployeeContinuationRecord.parse(f.row);
  f.observed.State = { ...f.observed.State, Running: false, Status: 'exited', Pid: 0 };
  f.observed.NetworkSettings = { Networks: { 'retained-net': { NetworkID: network } } };
  const retainedRun = vi.mocked(f.command.run).getMockImplementation()!;
  vi.mocked(f.command.run).mockImplementation(async (args, input) => {
    if (
      (args[0] === 'container' && args[1] === 'inspect' && args[2] === cid) ||
      (args[0] === 'image' && args[2] === image)
    )
      throw Error('Historical source genuinely absent');
    return retainedRun(args, input);
  });
  vi.mocked(f.command.run).mockClear();
  vi.mocked(f.command.create).mockClear();
  return { ...f, storage, holder: () => holder!, network };
}
describe('retained published plan source after historical source deletion', () => {
  const read = (
    f: Awaited<ReturnType<typeof retainedStoppedFixture>>,
    kind: 'HOME' | 'networks',
    current = () => {}
  ) =>
    kind === 'HOME' ? f.engine.planReplacementHome(f.row, current) : f.engine.planReplacementNetworkIds(f.row, current);
  it.each([1, 2] as const)('reads v%s stopped HOME with genuine held storage and no ancestor', async (version) => {
    const f = await retainedStoppedFixture(version);
    await expect(f.engine.planReplacementHome(f.row, () => {})).resolves.toEqual({
      source: '/synthetic/home',
      user: '1000:100',
      dev: '4',
      ino: '5',
    });
    expect(f.command.create).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.command.run).mock.calls.some(([a]) => a[2] === cid || a[0] === 'image' || a[1] === 'start')
    ).toBe(false);
  });
  it.each([1, 2] as const)('reads v%s exact stopped networks without its historical source', async (version) => {
    const f = await retainedStoppedFixture(version);
    await expect(f.engine.planReplacementNetworkIds(f.row, () => {})).resolves.toEqual([f.network]);
    expect(f.command.create).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.command.run).mock.calls.every(([a]) => a[0] === 'container' && a[1] === 'inspect' && a[2] === dest)
    ).toBe(true);
  });
  it.each(['HOME', 'networks'] as const)('refuses changed current %s fingerprint without effects', async (kind) => {
    const f = await retainedStoppedFixture();
    f.observed.Config.Env.push('FOREIGN_CONFIGURATION=1');
    await expect(read(f, kind)).rejects.toThrow('DESTINATION_CHANGED');
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it.each(['HOME', 'networks'] as const)('brackets %s with the same stopped native incarnation', async (kind) => {
    const f = await retainedStoppedFixture(),
      original = vi.mocked(f.command.run).getMockImplementation()!;
    let changed = false;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const reply = await original(args, input);
      if (!changed && args[0] === 'container' && args[1] === 'inspect' && args[2] === dest) {
        changed = true;
        f.observed.State.StartedAt = '2026-11-16T11:00:00.000000000Z';
      }
      return reply;
    });
    await expect(read(f, kind)).rejects.toThrow(kind === 'HOME' ? 'HOME_CHANGED' : 'NETWORK_SOURCE_CHANGED');
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it.each(['HOME', 'networks'] as const)('rechecks revoked requester after awaited %s native read', async (kind) => {
    const f = await retainedStoppedFixture(),
      original = vi.mocked(f.command.run).getMockImplementation()!;
    let active = true;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const reply = await original(args, input);
      active = false;
      return reply;
    });
    await expect(
      read(f, kind, () => {
        if (!active) throw Error('requester revoked');
      })
    ).rejects.toThrow('requester revoked');
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it.each(['HOME', 'networks'] as const)('rejects changing retained row during %s native read', async (kind) => {
    const f = await retainedStoppedFixture(),
      original = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const reply = await original(args, input);
      f.row.request.sessionGeneration++;
      return reply;
    });
    await expect(read(f, kind)).rejects.toThrow(kind === 'HOME' ? 'HOME_CHANGED' : 'NETWORK_SOURCE_CHANGED');
  });
  it.each(['HOME', 'networks'] as const)(
    'refuses prepublication %s instead of adopting current metadata',
    async (kind) => {
      const f = await retainedStoppedFixture();
      f.row.phase = 'pool-ready';
      await expect(read(f, kind)).rejects.toThrow();
      expect(f.command.run).not.toHaveBeenCalled();
      expect(f.command.create).not.toHaveBeenCalled();
    }
  );
  it.each(['missing', 'PID', 'start', 'mount', 'native-FD'] as const)(
    'refuses %s retained HOME holder',
    async (kind) => {
      const f = await retainedStoppedFixture();
      if (kind === 'missing') f.row.tasks = [];
      if (kind === 'PID') f.holder().State = { Running: true, Status: 'running', Pid: 988 };
      if (kind === 'start') f.storage.holderStartTicks = '124';
      if (kind === 'mount') (f.holder().Mounts as Array<{ Source: string }>)[0]!.Source = '/foreign/home';
      if (kind === 'native-FD') {
        const original = vi.mocked(f.command.run).getMockImplementation()!;
        vi.mocked(f.command.run).mockImplementation(async (args, input) => {
          if (args[0] === 'exec' && args.includes('storage-status'))
            return JSON.stringify({ ...f.storage, home: { ...f.storage.home, ino: '99' } });
          return original(args, input);
        });
      }
      await expect(read(f, 'HOME')).rejects.toThrow('STORAGE_');
      expect(f.command.create).not.toHaveBeenCalled();
    }
  );
  it('refuses changed current networks between exact stopped observations', async () => {
    const f = await retainedStoppedFixture(),
      original = vi.mocked(f.command.run).getMockImplementation()!;
    let changed = false;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const reply = await original(args, input);
      if (!changed && args[0] === 'container' && args[1] === 'inspect' && args[2] === dest) {
        changed = true;
        f.observed.NetworkSettings = { Networks: { 'foreign-net': { NetworkID: '8'.repeat(64) } } };
      }
      return reply;
    });
    await expect(read(f, 'networks')).rejects.toThrow('NETWORK_SOURCE_CHANGED');
    expect(f.command.create).not.toHaveBeenCalled();
  });
  it('keeps source-dependent preparation and CREATE strict after read-only success', async () => {
    const f = await retainedStoppedFixture();
    await read(f, 'HOME');
    await read(f, 'networks');
    await expect(f.engine.prepareStorage(f.row, () => {})).rejects.toThrow('Historical source genuinely absent');
    await expect(f.engine.createDestination(f.row, () => {})).rejects.toThrow('Historical source genuinely absent');
    expect(f.command.create).not.toHaveBeenCalled();
    expect(vi.mocked(f.command.run).mock.calls.some(([a]) => a[1] === 'start')).toBe(false);
  });
});
describe('Engine-owned existing Docker provider view', () => {
  it('accepts Docker 29.8 omitted empty Cmd with the same canonical old descriptor and image proof', async () => {
    const f = fixture();
    const wire = {
      ...f.source,
      Config: Object.fromEntries(Object.entries(f.source.Config).filter(([key]) => key !== 'Cmd')),
    };
    const parsed = DockerEmployeeInspect.parse(wire);
    expect(parsed.Config.Cmd).toBeNull();
    expect(boxedOriginal(parsed, subject, 'fixture')).toEqual(f.row.original);
    const originalRun = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (args, options) => {
      const output = await originalRun(args, options);
      if (args[0] === 'image') {
        const rows = JSON.parse(output) as Array<{
          Config: Record<string, unknown>;
        }>;
        for (const row of rows) delete row.Config.Cmd;
        return JSON.stringify(rows);
      }
      return output;
    });
    await expect(f.engine.image(f.row.original)).resolves.toEqual(f.row.workerImage);
    const changed = DockerEmployeeInspect.parse({
      ...wire,
      Config: { ...wire.Config, Cmd: ['unexpected-program'] },
    });
    expect(boxedOriginal(changed, subject, 'fixture').configurationDigest).not.toBe(f.row.original.configurationDigest);
    for (const value of ['', true, {}])
      expect(() =>
        DockerEmployeeInspect.parse({
          ...wire,
          Config: { ...wire.Config, Cmd: value },
        })
      ).toThrow();
  });
  it('keeps a published image readable while selecting an independently built replacement', async () => {
    const f = await providerViewFixture(),
      next = 'sha256:' + '9'.repeat(64);
    const originalRun = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (args, options) => {
      if (args[0] === 'image' && args[2] === next)
        return JSON.stringify([
          {
            Id: next,
            RootFS: { Layers: ['independently-built'] },
            Config: {
              Entrypoint: f.source.Config.Entrypoint,
              Cmd: null,
              Labels: { 'org.reverie.worker-client.manifest': '5'.repeat(64) },
            },
          },
        ]);
      return originalRun(args, options);
    });
    const upgraded = new DockerEmployeeEngine(
      f.command,
      'fixture',
      f.resources,
      {
        imageId: next,
        clientManifestDigest: '5'.repeat(64),
        sourceImageIds: [image, target],
      },
      f.journal,
      helper,
      '7'.repeat(64),
      () => 'claude'
    );
    await expect(upgraded.existingImage(f.row, () => {})).resolves.toEqual(f.row.workerImage);
    const view = await upgraded.captureProviderView(f.row, () => {});
    requireDockerEmployeeProviderView(view, sid, f.docker);
    expect(view.descriptor.containerId).toBe(dest);
    await expect(upgraded.replacementTargetImage(f.row.destination!, () => {})).resolves.toEqual({
      imageId: next,
      sourceImageId: target,
      clientManifestDigest: '5'.repeat(64),
    });
    await expect(upgraded.image(f.row.original)).rejects.toThrow('WORKER_IMAGE_CHANGED');
    expect(f.command.create).toHaveBeenCalledTimes(1); // fixture construction only
  });
  it('does not accept changed published manifest metadata or use pending image rows as history', async () => {
    const f = await providerViewFixture();
    f.row.workerImage.clientManifestDigest = '5'.repeat(64);
    await expect(f.engine.existingImage(f.row, () => {})).rejects.toThrow('WORKER_IMAGE_CHANGED');
    f.row.phase = 'destination-issued';
    await expect(f.engine.existingImage(f.row, () => {})).rejects.toThrow('READY_PROVIDER_REQUIRED');
  });
  it.each([1, 2] as const)('reads published v%s without the historical container or image', async (version) => {
    const f = await providerViewFixture();
    const row = DockerEmployeeContinuationRecord.parse({
      ...f.row,
      version,
      purpose: 'docker-employee-continuation-v' + version,
      ...(version === 2 ? { providerSourceDigest: subject.providerSourceDigest } : {}),
    });
    const before = structuredClone(row);
    const original = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      if ((args[0] === 'container' && args[1] === 'ls') || args[2] === cid || args[2] === image)
        throw Error('Historical source/discovery unavailable');
      return original(args, input);
    });
    vi.mocked(f.command.run).mockClear();
    await expect(f.engine.existingImage(row, () => {})).resolves.toEqual(row.workerImage);
    const view = await f.engine.captureProviderView(row, () => {});
    requireDockerEmployeeProviderView(view, sid, f.docker);
    expect(view.descriptor.containerId).toBe(dest);
    expect(row).toEqual(before);
    expect(f.command.create).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(f.command.run).mock.calls.every(([args]) => args[0] !== 'container' || args[1] === 'inspect')
    ).toBe(true);
    // Published read qualification cannot authorize the existing effect paths.
    for (const effect of [
      () => f.engine.start(row, () => {}),
      () => f.engine.configureResources(row, () => {}),
      () => f.engine.provisionIdentity(row, 'synthetic-token', () => {}),
      () => f.engine.prepareStorage(row, () => {}),
    ])
      await expect(effect()).rejects.toThrow('Historical source/discovery unavailable');
    expect(f.resources.configure).not.toHaveBeenCalled();
    expect(f.command.create).toHaveBeenCalledTimes(1);
  });
  it.each(['Config', 'HostConfig', 'Mounts', 'CID', 'generation', 'operation', 'box', 'image'] as const)(
    'denies published %s drift with the historical source unavailable',
    async (change) => {
      const f = await providerViewFixture();
      const original = vi.mocked(f.command.run).getMockImplementation()!;
      vi.mocked(f.command.run).mockImplementation(async (args, input) => {
        if (args[2] === cid || args[2] === image) throw Error('Historical source unavailable');
        return original(args, input);
      });
      if (change === 'Config') f.observed.Config.WorkingDir = '/foreign';
      if (change === 'HostConfig') f.observed.HostConfig.NetworkMode = 'host';
      if (change === 'Mounts') f.observed.Mounts[0]!.Source = '/foreign';
      if (change === 'CID') f.observed.Id = 'f'.repeat(64);
      if (change === 'generation') f.observed.Config.Labels!['reverie.boxed.generation'] = '4';
      if (change === 'operation')
        f.observed.Config.Labels!['reverie.boxed.operation'] = '40000000-0000-4000-8000-000000000004';
      if (change === 'box') f.observed.Config.Labels!['reverie.boxed.box'] = 'f'.repeat(64);
      if (change === 'image') f.observed.Image = image;
      await expect(f.engine.existingImage(f.row, () => {})).rejects.toThrow();
      await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow();
      expect(f.command.create).toHaveBeenCalledTimes(1);
      expect(f.resources.configure).not.toHaveBeenCalled();
    }
  );
  it('rechecks revocation and destination metadata after the published image await', async () => {
    const f = await providerViewFixture();
    const original = vi.mocked(f.command.run).getMockImplementation()!;
    let current = true;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const result = await original(args, input);
      if (args[0] === 'image') current = false;
      return result;
    });
    await expect(
      f.engine.existingImage(f.row, () => {
        if (!current) throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const result = await original(args, input);
      if (args[0] === 'image') f.observed.Config.WorkingDir = '/changed-during-await';
      return result;
    });
    await expect(f.engine.existingImage(f.row, () => {})).rejects.toThrow('DESTINATION_CHANGED');
  });
  it.each(['Pid', 'StartedAt'] as const)(
    'denies a changed host %s between native provider observations',
    async (field) => {
      const f = await providerViewFixture();
      f.observed.State.Pid = 123;
      f.observed.State.StartedAt = '2026-11-16T10:00:00.000000000Z';
      const original = vi.mocked(f.command.run).getMockImplementation()!;
      vi.mocked(f.command.run).mockImplementation(async (args, input) => {
        const result = await original(args, input);
        if (args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))
          f.observed.State[field] = field === 'Pid' ? 124 : '2026-11-16T10:01:00.000000000Z';
        return result;
      });
      await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow('PROVIDER_VIEW_CHANGED');
    }
  );
  it('allows HEALTHCHECK history progress within the same observed host incarnation', async () => {
    const f = await providerViewFixture();
    f.observed.State.Pid = 123;
    f.observed.State.StartedAt = '2026-11-16T10:00:00.000000000Z';
    f.observed.State.Health = { Status: 'healthy', FailingStreak: 0, Log: [] };
    const original = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const result = await original(args, input);
      if (args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))
        f.observed.State.Health = { Status: 'healthy', FailingStreak: 0, Log: [{ Output: 'new read-only history' }] };
      return result;
    });
    const view = await f.engine.captureProviderView(f.row, () => {});
    requireDockerEmployeeProviderView(view, sid, f.docker);
    expect(f.command.create).toHaveBeenCalledTimes(1);
  });
  it.each([
    'missing-pid',
    'zero-running-pid',
    'negative-pid',
    'fractional-pid',
    'oversized-pid',
    'string-pid',
    'missing-start',
    'invalid-start',
  ] as const)('refuses a published destination with %s', async (field) => {
    const f = await providerViewFixture();
    if (field === 'missing-pid') delete f.observed.State.Pid;
    if (field === 'zero-running-pid') f.observed.State.Pid = 0;
    if (field === 'negative-pid') f.observed.State.Pid = -1;
    if (field === 'fractional-pid') f.observed.State.Pid = 1.5;
    if (field === 'oversized-pid') f.observed.State.Pid = 2147483648;
    if (field === 'string-pid') f.observed.State.Pid = '123';
    if (field === 'missing-start') delete f.observed.State.StartedAt;
    if (field === 'invalid-start') f.observed.State.StartedAt = 'not-a-native-epoch';
    await expect(f.engine.existingImage(f.row, () => {})).rejects.toThrow('DESTINATION_STATE_UNKNOWN');
    await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow('DESTINATION_STATE_UNKNOWN');
    expect(f.command.create).toHaveBeenCalledTimes(1);
  });
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
          (args[0] === 'exec' && args.includes(DOCKER_PROVIDER_VIEW_PROGRAM) && args.at(-4) === 'observe')
      )
    ).toBe(true);
  });
  it('captures declared NONE without a historical hook generation and keeps the mode in private evidence', async () => {
    const f = await providerViewFixture(false, 'codex');
    const view = await f.engine.captureProviderView(f.row, () => {});
    requireDockerEmployeeProviderView(view, sid, f.docker);
    expect(view.descriptor.hooks).toEqual({ kind: 'none', mode: 'codex' });
    expect(Object.isFrozen(view.descriptor.hooks)).toBe(true);
    expect(Reflect.set(view.descriptor.hooks, 'kind', 'generation')).toBe(false);
    expect(
      vi
        .mocked(f.command.run)
        .mock.calls.filter(([a]) => a.includes(DOCKER_PROVIDER_VIEW_PROGRAM))
        .every(([a]) => a.at(-1) === 'none')
    ).toBe(true);
    expect(f.command.create).toHaveBeenCalledTimes(1); // Fixture destination construction only.
  });
  it('refuses a native NONE response when the canonical mode requires generation evidence', async () => {
    const f = await providerViewFixture();
    const original = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (args, input) =>
      args.includes(DOCKER_PROVIDER_VIEW_PROGRAM)
        ? JSON.stringify({ ...f.pane, hooks: { kind: 'none' } })
        : original(args, input)
    );
    await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow(
      'DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED'
    );
  });
  it('permanently revokes NONE evidence after the canonical provider mode changes', async () => {
    const f = await providerViewFixture(false, 'codex');
    const mode = vi.spyOn(f.engine as unknown as { providerMode(row: unknown): string }, 'providerMode');
    const view = await f.engine.captureProviderView(f.row, () => {});
    mode.mockReturnValue('claude');
    expect(() => requireDockerEmployeeProviderView(view, sid, f.docker)).toThrow();
    mode.mockReturnValue('codex');
    expect(() => requireDockerEmployeeProviderView(view, sid, f.docker)).toThrow();
  });
  it('refuses unknown canonical modes instead of inferring NONE', async () => {
    const f = await providerViewFixture(false, 'unregistered-mode');
    await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow(
      'DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED'
    );
  });
  it('keeps custom NONE declarations on the prior generation-required path', async () => {
    const custom = {
      ...cliRegistry.getCli('codex')!,
      id: cliRegistry.asCliId('custom-none'),
      stock: false,
    };
    const registry = vi.spyOn(cliRegistry, 'getCli').mockReturnValue(custom);
    try {
      const f = await providerViewFixture(false, 'custom-none');
      const original = vi.mocked(f.command.run).getMockImplementation()!;
      vi.mocked(f.command.run).mockImplementation(async (args, input) =>
        args.includes(DOCKER_PROVIDER_VIEW_PROGRAM)
          ? JSON.stringify({ ...f.pane, hooks: { kind: 'none' } })
          : original(args, input)
      );
      await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow(
        'DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED'
      );
    } finally {
      registry.mockRestore();
    }
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
      if (kind === 'stopped') {
        f.observed.State.Running = false;
        f.observed.State.Pid = 0;
      }
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
                  : { hooks: { kind: 'generation', generation: 'changed' } }),
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
    expect(() =>
      requireDockerEmployeeProviderView(view, sid, {
        ...f.docker,
        continuation: {
          ...f.docker.continuation!,
          planReplacement: {
            provider: 'anthropic',
            projectionDigest: '8'.repeat(64),
          },
        },
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
      f.source.Mounts.push({
        Type: 'bind',
        Source: '/synthetic/shadow',
        Destination: path,
        RW: false,
      });
      f.row.original = boxedOriginal(f.source, subject, 'fixture');
      await expect(f.engine.createDestination(f.row, () => {})).rejects.toMatchObject({
        code: 'DOCKER_CONTINUATION_CAPSULE_MOUNT_SHADOW',
      });
      expect(f.command.create).not.toHaveBeenCalled();
    }
  );
});
describe('new boxed Docker destination', () => {
  it('rechecks current grant after the preparation await before issuing destination START', async () => {
    const f = await dockerEncodedDestination();
    f.row.destination = boxedOriginal(f.observed, subject, 'fixture', true);
    let revoked = false;
    const current = () => {
      if (revoked) throw Error('revoked after preparation await');
      queueMicrotask(() => {
        revoked = true;
      });
    };
    await expect(f.engine.start(f.row, current)).rejects.toThrow('revoked after preparation await');
    expect(f.command.run).not.toHaveBeenCalledWith(['container', 'start', dest]);
  });

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
    f.source.Mounts.push({
      ...f.source.Mounts[1]!,
      Source: '/synthetic/second-nix',
    });
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
    vi.mocked(f.resources.observePool).mockResolvedValue({
      ...f.row.pool!,
      physicalDigest: '9'.repeat(64),
    });
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
          {
            Id: target,
            RootFS: { Layers: ['foreign'] },
            Config: { Entrypoint: null, Cmd: null, Labels: {} },
          },
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
    expect(
      DockerEmployeeResourcePolicy.safeParse({
        ...f.policy,
        memoryHighBytes: 0,
      }).success
    ).toBe(false);
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
        return JSON.stringify({
          realPath: '/workspace/case',
          dev: '7',
          ino: '8',
          hooksText: null,
        });
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
            ? Promise.resolve(
                JSON.stringify({
                  realPath: '/other',
                  dev: '7',
                  ino: '8',
                  hooksText: null,
                })
              )
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

async function healthFixture(ephemeral = false) {
  const f = await providerViewFixture(ephemeral);
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
    f.row.phase = 'provider-issued';
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
    expect(f.health.read(f.employee)).toMatchObject({
      state: 'dead',
      reason: 'COMMAND_EXITED',
    });
  });
  it('uses twice-observed exact stopped PID0 without inventing provider or init PID proof', async () => {
    const f = await healthFixture();
    f.observed.State.Running = false;
    f.observed.State.Pid = 0;
    await f.health.refresh();
    expect(f.health.read(f.employee)).toMatchObject({
      state: 'dead',
      reason: 'CONTAINER_STOPPED',
    });
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
  it('observes provider-issued live command without settling its lost completion acknowledgement', async () => {
    const f = await healthFixture();
    f.row.phase = 'provider-issued';
    const before = structuredClone(f.row);
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('healthy');
    expect(f.row).toEqual(before);
    expect(f.command.create).toHaveBeenCalledTimes(1);
  });
  it('refuses a changed record digest during provider-issued native observation and all earlier phases', async () => {
    const f = await healthFixture();
    f.row.phase = 'provider-issued';
    const run = vi.mocked(f.command.run).getMockImplementation()!;
    vi.mocked(f.command.run).mockImplementation(async (a, i) => {
      const value = await run(a, i);
      if (a.includes(DOCKER_PROVIDER_VIEW_PROGRAM)) f.row.sourceDigest = '8'.repeat(64);
      return value;
    });
    await f.health.refresh();
    expect(f.health.read(f.employee)?.state).toBe('unknown');
    const g = await healthFixture();
    g.row.phase = 'identity-ready';
    vi.mocked(g.command.run).mockClear();
    await g.health.refresh();
    expect(g.health.read(g.employee)?.state).toBe('unknown');
    expect(g.command.run).not.toHaveBeenCalled();
  });
});

describe('ephemeral health boundary integration', () => {
  // Only denials are injected at the metadata boundary. Every successful proof
  // still comes from the actual Engine/private Native-view owner above.
  it('failed ephemeral re-earn cannot mint LIVE health or issue a repair', async () => {
    const f = await healthFixture(true),
      before = vi.mocked(f.command.create).mock.calls.length;
    const verify = vi
      .spyOn(DockerEphemeralRestoration.prototype, 'verifyDestination')
      .mockRejectedValueOnce(Error('directory custody unavailable'));
    try {
      await f.health.refresh();
      expect(f.health.read(f.employee)?.state).toBe('unknown');
      expect(verify).toHaveBeenCalledOnce();
      expect(f.command.create).toHaveBeenCalledTimes(before);
    } finally {
      verify.mockRestore();
    }
  });
  it('an Engine-minted LIVE proof revokes when retained ephemeral custody fails', async () => {
    const f = await healthFixture(true),
      proof = await f.engine.captureProviderHealth(f.row, f.binding, () => {});
    expect(proof.require(f.employee)).toBe('live');
    const current = vi.spyOn(DockerEphemeralRestoration.prototype, 'assertCurrent').mockImplementation(() => {
      throw Error('lost retained directory');
    });
    try {
      expect(() => proof.require(f.employee)).toThrow();
    } finally {
      current.mockRestore();
    }
    expect(() => proof.require(f.employee)).toThrow();
  });
  it('a provider disappearing during the metadata await cannot mint stale LIVE health', async () => {
    const f = await healthFixture(true);
    const verify = vi
      .spyOn(DockerEphemeralRestoration.prototype, 'verifyDestination')
      .mockImplementationOnce(async () => {
        f.setMode('absent');
      });
    try {
      await f.health.refresh();
      expect(f.health.read(f.employee)?.state).toBe('unknown');
    } finally {
      verify.mockRestore();
    }
  });
  it.each(['stopped', 'absent'] as const)(
    'preserves read-only %s semantics without ephemeral repairs',
    async (mode) => {
      const f = await healthFixture(true);
      if (mode === 'stopped') {
        f.observed.State.Running = false;
        f.observed.State.Pid = 0;
      } else f.setMode('absent');
      const verify = vi
        .spyOn(DockerEphemeralRestoration.prototype, 'verifyDestination')
        .mockRejectedValue(Error('No directory authority'));
      try {
        const proof = await f.engine.captureProviderHealth(f.row, f.binding, () => {});
        expect(proof.require(f.employee)).toBe(mode);
        expect(verify).not.toHaveBeenCalled();
      } finally {
        verify.mockRestore();
      }
    }
  );
});

describe('resource revision observation boundary', () => {
  /** Controlled Engine replies test only cross-SID metadata correlation. They do
   * not claim native account custody, actual process closure or paid admission. */
  async function planReplacementMetadata() {
    const f = await providerViewFixture();
    f.source.State.Pid = 0;
    f.source.HostConfig.RestartPolicy = { Name: 'no' };
    f.source.Config.Labels = {
      'reverie.boxed.instance': 'fixture',
      'reverie.boxed.employee': eid,
      'reverie.boxed.session': sid,
      'reverie.boxed.operation': oid,
      'reverie.boxed.generation': '3',
      'reverie.boxed.box': '7'.repeat(64),
    };
    const original = boxedOriginal(f.source, subject, 'fixture', true),
      nextSid = '60000000-0000-4000-8000-000000000006',
      nextOperation = '70000000-0000-4000-8000-000000000007';
    Object.assign(f.observed.Config.Labels!, {
      'reverie.boxed.session': nextSid,
      'reverie.boxed.operation': nextOperation,
      'reverie.boxed.generation': '4',
    });
    f.observed.Config.Env = [
      ...dockerPlanDestinationEnvironment(f.observed.Config.Env, {
        operationId: nextOperation,
        provider: 'anthropic',
        projectionDigest: '8'.repeat(64),
      }),
    ];
    const row = DockerEmployeeContinuationRecord.parse({
      ...f.row,
      version: 3,
      purpose: 'docker-employee-plan-replacement-v3',
      request: {
        ...f.row.request,
        sessionId: nextSid,
        sessionGeneration: 4,
        operationId: nextOperation,
      },
      original,
      destination: boxedOriginal(f.observed, { ...subject, sessionId: nextSid }, 'fixture', true),
      credentialId: '80000000-0000-4000-8000-000000000008',
      providerSourceDigest: '9'.repeat(64),
      tasks: (['storage-holder', 'leaf-helper', 'identity-helper'] as const).map((role, i) => ({
        role,
        name: 'reverie-boxed-synthetic-' + role,
        imageId: helper,
        configurationDigest: String(i + 1).repeat(64),
        containerId: String(i + 4).repeat(64),
        ...(role === 'storage-holder'
          ? { phase: 'running', initPid: 123, initStartTicks: '456' }
          : { phase: 'completed', resultDigest: '7'.repeat(64) }),
      })),
      planReplacement: {
        version: 1,
        purpose: 'docker-plan-replacement-provenance-v1',
        moveId: 'synthetic-move',
        source: {
          binding: {
            version: 1,
            operationId: oid,
            credentialId: f.row.credentialId,
            sessionId: sid,
            sessionGeneration: 3,
            containerId: cid,
            imageId: image,
            originalDigest: dockerContinuationDigest(original),
            policyDigest: dockerContinuationDigest(f.policy),
          },
          continuationDigest: dockerContinuationDigest(f.row),
          providerSourceDigest: subject.providerSourceDigest,
        },
        account: {
          id: 'synthetic-account',
          provider: 'anthropic',
          projectionDigest: '8'.repeat(64),
          contextDigest: '6'.repeat(64),
        },
      },
    });
    return { ...f, row, nextSid };
  }

  describe('exact network membership for plan replacement', () => {
    const first = '1'.repeat(64),
      second = '2'.repeat(64),
      third = '3'.repeat(64);
    const members = (ids: readonly string[]) => ({
      Networks: Object.fromEntries(
        ids.map((NetworkID, index) => [
          'lan-' + index,
          {
            NetworkID,
            IPAddress: '172.28.0.' + (index + 2),
            Aliases: ['DO_NOT_COPY_ALIAS'],
          },
        ])
      ),
    });
    async function stoppedPublished() {
      const f = await providerViewFixture();
      f.observed.State = {
        ...f.observed.State,
        Running: false,
        Pid: 0,
        Status: 'exited',
      };
      f.observed.NetworkSettings = members([second, first]);
      return f;
    }
    function select(f: Awaited<ReturnType<typeof planReplacementMetadata>>, ids = [first, second]) {
      if (f.row.version !== 3) throw Error('v3 fixture required');
      f.source.State.Status = 'exited';
      f.source.HostConfig.AutoRemove = false;
      f.source.HostConfig.NetworkMode = first;
      f.source.NetworkSettings = members(ids);
      f.row.original = boxedOriginal(f.source, subject, 'fixture', true);
      f.row.planReplacement.source.binding.originalDigest = dockerContinuationDigest(f.row.original);
      f.row.planReplacement.source.networkIds = [...ids].sort();
      f.observed.HostConfig.NetworkMode = first;
      f.observed.NetworkSettings = members(ids);
      return f.row;
    }
    it('earns sorted unique current P networks through read-only double stopped brackets', async () => {
      const f = await stoppedPublished();
      vi.mocked(f.command.run).mockClear();
      vi.mocked(f.command.create).mockClear();
      expect(await f.engine.planReplacementNetworkIds(f.row, () => {})).toEqual([first, second]);
      expect(f.command.create).not.toHaveBeenCalled();
      expect(
        vi.mocked(f.command.run).mock.calls.every(([a]) => a[0] === 'container' && ['ls', 'inspect'].includes(a[1]!))
      ).toBe(true);
    });
    it.each(['empty', 'missing', 'malformed', 'duplicate', 'too-many', 'empty-id-after-stop'] as const)(
      'refuses %s actual source network metadata without effects',
      async (kind) => {
        const f = await stoppedPublished();
        vi.mocked(f.command.create).mockClear();
        if (kind === 'empty') f.observed.NetworkSettings = { Networks: {} };
        if (kind === 'missing') delete f.observed.NetworkSettings;
        if (kind === 'malformed')
          f.observed.NetworkSettings = {
            Networks: { lan: { NetworkID: 'tag:latest' } },
          };
        if (kind === 'duplicate') f.observed.NetworkSettings = members([first, first]);
        if (kind === 'too-many')
          f.observed.NetworkSettings = members(Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(64, '0')));
        if (kind === 'empty-id-after-stop') f.observed.NetworkSettings = { Networks: { lan: { NetworkID: '' } } };
        await expect(f.engine.planReplacementNetworkIds(f.row, () => {})).rejects.toThrow('NETWORKS_UNCONFIRMED');
        expect(f.command.create).not.toHaveBeenCalled();
      }
    );
    it('refuses a membership change between the two actual source observations', async () => {
      const f = await stoppedPublished(),
        original = vi.mocked(f.command.run).getMockImplementation()!;
      let changed = false;
      vi.mocked(f.command.run).mockImplementation(async (args, input) => {
        const value = await original(args, input);
        if (!changed && args[0] === 'container' && args[1] === 'inspect' && args[2] === dest) {
          changed = true;
          f.observed.NetworkSettings = members([first, third]);
        }
        return value;
      });
      await expect(f.engine.planReplacementNetworkIds(f.row, () => {})).rejects.toThrow('NETWORK_SOURCE_CHANGED');
    });
    it.each(['running', 'PID', 'restart', 'owner'] as const)('refuses changed %s source scope', async (kind) => {
      const f = await stoppedPublished();
      let current = true;
      if (kind === 'running') f.observed.State.Running = true;
      if (kind === 'PID') f.observed.State.Pid = 123;
      if (kind === 'restart') {
        f.observed.HostConfig.RestartPolicy = { Name: 'always' };
        f.row.destination = boxedOriginal(f.observed, subject, 'fixture', true);
      }
      if (kind === 'owner') {
        const original = vi.mocked(f.command.run).getMockImplementation()!;
        vi.mocked(f.command.run).mockImplementation(async (a, b) => {
          const out = await original(a, b);
          current = false;
          return out;
        });
      }
      await expect(
        f.engine.planReplacementNetworkIds(f.row, () => {
          if (!current) throw Error('owner revoked');
        })
      ).rejects.toThrow();
    });
    it('requires persisted network IDs for a new v3 CREATE while old published v3 metadata stays readable', async () => {
      const f = await planReplacementMetadata();
      vi.mocked(f.command.create).mockClear();
      await expect(f.engine.verifyResourceDestination(f.row, () => {})).resolves.toBeUndefined();
      await expect(
        f.engine.createPlanReplacementDestination(
          DockerEmployeePlanReplacementWorkRecord.parse({
            ...f.row,
            phase: 'destination-issued',
            destination: undefined,
          }),
          () => {}
        )
      ).rejects.toThrow('NETWORKS_REQUIRED');
      expect(f.command.create).not.toHaveBeenCalled();
    });
    it('copies both current source networks by immutable ID and omits IP/alias data', async () => {
      const f = await planReplacementMetadata(),
        row = select(f);
      vi.mocked(f.command.create).mockClear();
      await f.engine.createPlanReplacementDestination(
        DockerEmployeePlanReplacementWorkRecord.parse({ ...row, phase: 'destination-issued', destination: undefined }),
        () => {}
      );
      const body = f.created()!;
      expect(body.NetworkingConfig).toEqual({
        EndpointsConfig: { [first]: {}, [second]: {} },
      });
      expect((body.HostConfig as Record<string, unknown>).NetworkMode).toBe(first);
      expect(JSON.stringify(body)).not.toContain('DO_NOT_COPY_ALIAS');
      expect(JSON.stringify(body)).not.toContain('172.28.0.');
      expect(f.command.create).toHaveBeenCalledTimes(1);
    });
    it('refuses changed source membership at CREATE and changed target membership at observation', async () => {
      const f = await planReplacementMetadata(),
        row = select(f);
      f.source.NetworkSettings = members([first, third]);
      vi.mocked(f.command.create).mockClear();
      await expect(
        f.engine.createPlanReplacementDestination(
          DockerEmployeePlanReplacementWorkRecord.parse({
            ...row,
            phase: 'destination-issued',
            destination: undefined,
          }),
          () => {}
        )
      ).rejects.toThrow('NETWORK_SOURCE_CHANGED');
      expect(f.command.create).not.toHaveBeenCalled();
      f.source.NetworkSettings = members([first, second]);
      f.observed.NetworkSettings = members([first, third]);
      await expect(f.engine.verifyResourceDestination(row, () => {})).rejects.toThrow('NETWORK_DESTINATION_CHANGED');
    });
    it.each(['destination-ready', 'start-issued'] as const)(
      'resolves exact Created endpoint selectors through actual network metadata at %s before START',
      async (phase) => {
        const f = await planReplacementMetadata(),
          row = select(f);
        const work = { ...row, phase };
        f.observed.State = {
          ...f.observed.State,
          Running: false,
          Status: 'created',
          Pid: 0,
        };
        f.observed.NetworkSettings = {
          Networks: {
            'declared-one': { NetworkID: '' },
            'declared-two': { NetworkID: '' },
          },
        };
        const original = vi.mocked(f.command.run).getMockImplementation()!;
        vi.mocked(f.command.create).mockClear();
        vi.mocked(f.command.run).mockImplementation(async (a, b) =>
          a[0] === 'network'
            ? JSON.stringify([
                { Id: first, Name: 'declared-one' },
                { Id: second, Name: 'declared-two' },
              ])
            : original(a, b)
        );
        // The existing observation API returns stopped metadata without provider,
        // credential or resource effects. It does not claim a connected endpoint.
        await expect(f.engine.observeDestination({ ...work, destination: undefined })).resolves.toMatchObject({
          state: 'stopped',
        });
        expect(f.command.create).not.toHaveBeenCalled();
        expect(vi.mocked(f.command.run).mock.calls.some(([a]) => a[0] === 'network' && a[1] === 'inspect')).toBe(true);
      }
    );
    async function createdResolutionFixture() {
      const f = await planReplacementMetadata(),
        row = select(f);
      f.observed.State = { ...f.observed.State, Running: false, Status: 'created', Pid: 0 };
      f.observed.NetworkSettings = {
        Networks: {
          'declared-one': { NetworkID: '' },
          'declared-two': { NetworkID: '' },
        },
      };
      const original = vi.mocked(f.command.run).getMockImplementation()!;
      let mutate = () => {};
      vi.mocked(f.command.run).mockImplementation(async (args, input) => {
        if (args[0] !== 'network') return original(args, input);
        mutate();
        return JSON.stringify([
          { Id: first, Name: 'declared-one' },
          { Id: second, Name: 'declared-two' },
        ]);
      });
      vi.mocked(f.command.create).mockClear();
      vi.mocked(f.command.run).mockClear();
      return {
        ...f,
        row,
        change: (callback: () => void) => {
          mutate = callback;
        },
      };
    }
    it.each(['destination-issued', 'destination-ready', 'start-issued'] as const)(
      'accepts only a full-mount permutation during Created network resolution at %s',
      async (phase) => {
        const f = await createdResolutionFixture();
        f.change(() => f.observed.Mounts.reverse());
        await expect(f.engine.observeDestination({ ...f.row, phase, destination: undefined })).resolves.toMatchObject({
          state: 'stopped',
        });
        expect(f.command.create).not.toHaveBeenCalled();
        expect(
          vi
            .mocked(f.command.run)
            .mock.calls.every(
              ([a]) => a[0] === 'network' || (a[0] === 'container' && ['ls', 'inspect'].includes(a[1]!))
            )
        ).toBe(true);
      }
    );
    it.each(['Source', 'Destination', 'Type', 'RW', 'Name', 'Mode', 'Propagation', 'opaque'] as const)(
      'refuses changed full mount field %s across Created network resolution',
      async (key) => {
        const f = await createdResolutionFixture();
        f.change(() => {
          const mount = f.observed.Mounts.find((m) => m.Destination === '/workspace')!;
          if (key === 'RW') mount.RW = !mount.RW;
          else if (key === 'Type') mount.Type = 'volume';
          else if (key === 'Destination') mount.Destination = '/foreign/workspace';
          else mount[key] = 'changed';
          f.observed.Mounts.reverse();
        });
        await expect(
          f.engine.observeDestination({ ...f.row, phase: 'destination-issued', destination: undefined })
        ).rejects.toThrow('NETWORK_DESTINATION_CHANGED');
        expect(f.command.create).not.toHaveBeenCalled();
      }
    );
    it.each(['before', 'during'] as const)('refuses duplicate mount destinations %s resolution', async (when) => {
      const f = await createdResolutionFixture();
      const duplicate = () =>
        f.observed.Mounts.push(structuredClone(f.observed.Mounts.find((m) => m.Destination === '/workspace')!));
      if (when === 'before') duplicate();
      else f.change(duplicate);
      await expect(
        f.engine.observeDestination({ ...f.row, phase: 'destination-issued', destination: undefined })
      ).rejects.toThrow('DUPLICATE_MOUNT_DESTINATION');
      expect(f.command.create).not.toHaveBeenCalled();
    });
    it.each(['Config', 'HostConfig', 'State', 'NetworkSettings'] as const)(
      'keeps the %s Created network bracket exact',
      async (key) => {
        const f = await createdResolutionFixture();
        f.change(() => {
          const part = f.observed[key];
          if (!part || typeof part !== 'object' || Array.isArray(part)) throw Error('Expected fixture object');
          (part as Record<string, unknown>).UnexpectedDrift = true;
        });
        await expect(
          f.engine.observeDestination({ ...f.row, phase: 'destination-issued', destination: undefined })
        ).rejects.toThrow('NETWORK_DESTINATION_CHANGED');
        expect(f.command.create).not.toHaveBeenCalled();
      }
    );
    it('does not accept empty or foreign resolved network IDs after the target starts', async () => {
      const f = await planReplacementMetadata(),
        row = select(f);
      f.observed.NetworkSettings = {
        Networks: {
          'declared-one': { NetworkID: '' },
          'declared-two': { NetworkID: '' },
        },
      };
      await expect(f.engine.verifyResourceDestination(row, () => {})).rejects.toThrow('NETWORKS_UNCONFIRMED');
      expect(vi.mocked(f.command.run).mock.calls.some(([a]) => a[0] === 'network')).toBe(false);
    });
    it('rejects a Created name resolving to a new/foreign ID instead of inferring identity from its label', async () => {
      const f = await planReplacementMetadata(),
        row = select(f);
      const work = {
        ...row,
        phase: 'destination-ready' as const,
        destination: undefined,
      };
      f.observed.State = {
        ...f.observed.State,
        Running: false,
        Status: 'created',
        Pid: 0,
      };
      f.observed.NetworkSettings = {
        Networks: {
          'declared-one': { NetworkID: '' },
          'declared-two': { NetworkID: '' },
        },
      };
      const original = vi.mocked(f.command.run).getMockImplementation()!;
      vi.mocked(f.command.run).mockImplementation(async (a, b) =>
        a[0] === 'network'
          ? JSON.stringify([
              { Id: first, Name: 'declared-one' },
              { Id: third, Name: 'declared-two' },
            ])
          : original(a, b)
      );
      await expect(f.engine.observeDestination(work)).rejects.toThrow('NETWORK_DESTINATION_CHANGED');
    });

    it('rechecks source networks after slow pool observation instead of using the earlier inspect snapshot', async () => {
      const f = await planReplacementMetadata(),
        row = select(f);
      vi.mocked(f.command.create).mockClear();
      vi.mocked(f.resources.observePool).mockImplementation(async () => {
        f.source.NetworkSettings = members([first, third]);
        return row.pool!;
      });
      await expect(
        f.engine.createPlanReplacementDestination(
          DockerEmployeePlanReplacementWorkRecord.parse({
            ...row,
            phase: 'destination-issued',
            destination: undefined,
          }),
          () => {}
        )
      ).rejects.toThrow('NETWORK_SOURCE_CHANGED');
      expect(f.command.create).not.toHaveBeenCalled();
    });
    it('refuses a Created selector mutation across the readonly name resolution await', async () => {
      const f = await planReplacementMetadata(),
        row = select(f),
        work = {
          ...row,
          phase: 'destination-ready' as const,
          destination: undefined,
        };
      f.observed.State = {
        ...f.observed.State,
        Running: false,
        Status: 'created',
        Pid: 0,
      };
      f.observed.NetworkSettings = {
        Networks: {
          'declared-one': { NetworkID: '' },
          'declared-two': { NetworkID: '' },
        },
      };
      const original = vi.mocked(f.command.run).getMockImplementation()!;
      vi.mocked(f.command.run).mockImplementation(async (a, b) => {
        if (a[0] !== 'network') return original(a, b);
        f.observed.NetworkSettings = {
          Networks: {
            'declared-one': { NetworkID: '' },
            foreign: { NetworkID: '' },
          },
        };
        return JSON.stringify([
          { Id: first, Name: 'declared-one' },
          { Id: second, Name: 'declared-two' },
        ]);
      });
      await expect(f.engine.observeDestination(work)).rejects.toThrow('NETWORK_DESTINATION_CHANGED');
    });
  });
  it('requires retained installation evidence before admitting a replacement provider view', async () => {
    const f = await planReplacementMetadata();
    vi.mocked(f.command.run).mockClear();
    await expect(f.engine.captureProviderView(f.row, () => {})).rejects.toThrow();
    expect(vi.mocked(f.command.run).mock.calls.some(([args]) => args.includes('credential-status'))).toBe(false);
    expect(vi.mocked(f.command.run).mock.calls.some(([args]) => args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))).toBe(
      false
    );
  });
  it('requires a stopped original with restart disabled for replacement source observation', async () => {
    const f = await planReplacementMetadata();
    await expect(f.engine.observePlanReplacementSource(f.row, () => {})).resolves.toMatchObject({ state: 'stopped' });
    f.source.State.Pid = 123;
    await expect(f.engine.observePlanReplacementSource(f.row, () => {})).rejects.toThrow('ORIGINAL_CHANGED');
    f.source.State.Pid = 0;
    f.source.HostConfig.RestartPolicy = { Name: 'always' };
    await expect(f.engine.observePlanReplacementSource(f.row, () => {})).rejects.toThrow('ORIGINAL_CHANGED');
  });
  it('cannot obtain replacement HOME from a running destination', async () => {
    const f = await providerViewFixture();
    await expect(f.engine.planReplacementHome(f.row, () => {})).rejects.toThrow('HOME_CHANGED');
    expect(vi.mocked(f.command.run).mock.calls.some(([args]) => args[0] === 'exec')).toBe(false);
  });
  it.each(['operation', 'generation', 'box'] as const)(
    'checks the retained %s provenance against the actual source labels',
    async (kind) => {
      const f = await planReplacementMetadata();
      if (f.row.version !== 3) throw Error('Replacement fixture required');
      if (kind === 'operation')
        f.row.planReplacement.source.binding.operationId = '90000000-0000-4000-8000-000000000009';
      if (kind === 'generation') {
        f.row.planReplacement.source.binding.sessionGeneration = 2;
        f.row.request.sessionGeneration = 3;
        f.observed.Config.Labels!['reverie.boxed.generation'] = '3';
        f.row.destination = boxedOriginal(f.observed, { ...subject, sessionId: f.nextSid }, 'fixture', true);
      }
      if (kind === 'box') {
        f.source.Config.Labels!['reverie.boxed.box'] = '6'.repeat(64);
        f.row.original = boxedOriginal(f.source, subject, 'fixture', true);
        f.row.planReplacement.source.binding.originalDigest = dockerContinuationDigest(f.row.original);
      }
      const checked = DockerEmployeeContinuationRecord.parse(f.row);
      await expect(f.engine.verifyResourceDestination(checked, () => {})).rejects.toThrow('ORIGINAL_CHANGED');
    }
  );
  it('reads old and target metadata under their exact distinct session identities without an effect', async () => {
    const f = await planReplacementMetadata();
    vi.mocked(f.command.run).mockClear();
    vi.mocked(f.command.create).mockClear();
    await expect(f.engine.verifyResourceDestination(f.row, () => {})).resolves.toBeUndefined();
    expect(f.command.create).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.command.run).mock.calls.every(([a]) => a[0] === 'container' && ['ls', 'inspect'].includes(a[1]!))
    ).toBe(true);
  });
  it.each(['source', 'target'] as const)(
    'rejects a replacement whose %s placement was relabeled to the other SID',
    async (which) => {
      const f = await planReplacementMetadata();
      if (which === 'source') f.source.Config.Labels!['reverie.boxed.session'] = f.nextSid;
      else f.observed.Config.Labels!['reverie.boxed.session'] = sid;
      await expect(f.engine.verifyResourceDestination(f.row, () => {})).rejects.toThrow();
    }
  );
  it('fixed metadata verification accepts only the exact current running original', async () => {
    const f = await providerViewFixture();
    await expect(f.engine.verifyResourceDestination(f.row, () => {})).resolves.toBeUndefined();
    f.observed.Config.Env!.push('UNAPPROVED_CONFIGURATION=changed');
    await expect(f.engine.verifyResourceDestination(f.row, () => {})).rejects.toThrow('DESTINATION_CHANGED');
  });
  it('checks canonical authority again after a real physical-port await', async () => {
    const f = await providerViewFixture(),
      original = f.command.run;
    let current = true;
    f.command.run = async (...args) => {
      const result = await original(...args);
      current = false;
      return result;
    };
    await expect(
      f.engine.verifyResourceDestination(f.row, () => {
        if (!current) throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
  });
  it('a matching policy DATA object or forged require method cannot mint a revision proof', () => {
    const f = fixture();
    let called = false;
    f.resources.existingPolicy = () => ({
      require() {
        called = true;
      },
    });
    const effective = { ...f.policy, memoryHighBytes: 48 * 1024 ** 3 };
    expect(f.engine.existingResourcePolicyCurrent(f.row, f.policy)).toBe(true);
    expect(() => f.engine.existingResourcePolicyCurrent(f.row, effective)).toThrow();
    expect(called).toBe(false);
    expect(f.engine.existingResourcePolicyCurrent(f.row, null)).toBe(false);
  });
});

describe('installed original protocol observation', () => {
  const protocol = JSON.stringify({
    version: 1,
    purpose: 'reverie-plan-protocol-v1',
    protocol: 1,
    receiptFields: Object.keys(DockerPlanInitialReceipt.shape),
  });
  async function installed() {
    const f = await dockerPlanRetirementFixture();
    const row = DockerEmployeePlanReplacementWorkRecord.parse({ ...f.state.work, phase: 'identity-ready' });
    const command = vi.mocked(f.command.run),
      run = command.getMockImplementation()!;
    let reply = protocol,
      after: ((raw: Record<string, unknown>) => void) | undefined;
    let issued = false,
      before = false;
    command.mockImplementation(async (args, input) => {
      if (args.includes('plan-protocol')) {
        expect(args).toEqual([
          'exec',
          row.destination!.containerId,
          '/opt/reverie-worker-client/bin/reverie',
          'worker-client',
          'plan-protocol',
          '--expected-digest',
          row.workerImage.clientManifestDigest,
        ]);
        issued = true;
        return reply;
      }
      const value = await run(args, input);
      if (
        (issued || before) &&
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === row.destination!.containerId &&
        after
      ) {
        const raw = JSON.parse(value) as Array<Record<string, unknown>>;
        after(raw[0]!);
        return JSON.stringify(raw);
      }
      return value;
    });
    vi.mocked(f.command.create).mockClear();
    command.mockClear();
    return {
      ...f,
      row,
      reply: (value: string) => {
        reply = value;
      },
      after: (change: typeof after) => {
        after = change;
      },
      before: () => {
        before = true;
      },
    };
  }
  it('reads the exact original fixed CLI 19-field protocol without resource/helper/provider writes', async () => {
    const f = await installed();
    try {
      await expect(f.strictEngine.inspectPlanReplacementProtocol(f.row, () => {})).resolves.toBeUndefined();
      expect(f.command.create).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(f.command.run)
          .mock.calls.every(
            ([a]) =>
              a[0] === 'image' ||
              (a[0] === 'container' && ['inspect', 'ls'].includes(a[1]!)) ||
              a.includes('plan-protocol')
          )
      ).toBe(true);
    } finally {
      f.engine.close();
      f.strictEngine.close();
    }
  });
  it.each(['unknown-field', 'missing-field', 'duplicate-field', 'wrong-version', 'non-json'])(
    'rejects %s protocol output',
    async (mode) => {
      const f = await installed(),
        value = JSON.parse(protocol);
      if (mode === 'unknown-field') value.extra = true;
      if (mode === 'missing-field') value.receiptFields.pop();
      if (mode === 'duplicate-field') value.receiptFields[0] = value.receiptFields[1];
      if (mode === 'wrong-version') value.protocol = 2;
      f.reply(mode === 'non-json' ? 'unknown' : JSON.stringify(value));
      try {
        await expect(f.strictEngine.inspectPlanReplacementProtocol(f.row, () => {})).rejects.toThrow();
      } finally {
        f.engine.close();
        f.strictEngine.close();
      }
    }
  );
  it.each([
    'pid',
    'start',
    'missing-pid',
    'missing-start',
    'malformed-pid',
    'malformed-start',
    'zero-start',
    'paused',
    'restarting',
    'dead',
    'cid',
    'image',
    'config',
  ])('rejects original %s drift after the CLI read', async (mode) => {
    const f = await installed();
    f.after((raw) => {
      const state = raw.State as Record<string, unknown>;
      if (mode === 'pid') state.Pid = 223;
      if (mode === 'start') state.StartedAt = '2026-11-16T00:01:00.000000000Z';
      if (mode === 'missing-pid') delete state.Pid;
      if (mode === 'missing-start') delete state.StartedAt;
      if (mode === 'malformed-pid') state.Pid = '222';
      if (mode === 'malformed-start') state.StartedAt = 'unknown';
      if (mode === 'zero-start') state.StartedAt = '0001-01-01T00:00:00Z';
      if (mode === 'paused') state.Paused = true;
      if (mode === 'restarting') state.Restarting = true;
      if (mode === 'dead') state.Dead = true;
      if (mode === 'cid') raw.Id = 'e'.repeat(64);
      if (mode === 'image') raw.Image = 'sha256:' + '0'.repeat(64);
      if (mode === 'config') (raw.Config as Record<string, unknown>).Env = ['PATH=/foreign'];
    });
    try {
      await expect(f.strictEngine.inspectPlanReplacementProtocol(f.row, () => {})).rejects.toThrow();
    } finally {
      f.engine.close();
      f.strictEngine.close();
    }
  });
  it.each(['missing-pid', 'zero-pid', 'zero-start', 'missing-start'])(
    'refuses initial %s before the CLI read',
    async (mode) => {
      const f = await installed();
      f.before();
      f.after((raw) => {
        const state = raw.State as Record<string, unknown>;
        if (mode === 'missing-pid') delete state.Pid;
        if (mode === 'zero-pid') state.Pid = 0;
        if (mode === 'zero-start') state.StartedAt = '0001-01-01T00:00:00Z';
        if (mode === 'missing-start') delete state.StartedAt;
      });
      try {
        await expect(f.strictEngine.inspectPlanReplacementProtocol(f.row, () => {})).rejects.toThrow();
        expect(vi.mocked(f.command.run).mock.calls.some(([a]) => a.includes('plan-protocol'))).toBe(false);
      } finally {
        f.engine.close();
        f.strictEngine.close();
      }
    }
  );
  it('rechecks revocation after original CLI await', async () => {
    const f = await installed(),
      run = vi.mocked(f.command.run).getMockImplementation()!;
    let revoked = false;
    vi.mocked(f.command.run).mockImplementation(async (args, input) => {
      const result = await run(args, input);
      if (args.includes('plan-protocol')) revoked = true;
      return result;
    });
    try {
      await expect(
        f.strictEngine.inspectPlanReplacementProtocol(f.row, () => {
          if (revoked) throw Error('revoked');
        })
      ).rejects.toThrow('revoked');
    } finally {
      f.engine.close();
      f.strictEngine.close();
    }
  });
  it.each(['identity-issued', 'provider-issued', 'ready'] as const)(
    'refuses %s without CLI dispatch',
    async (phase) => {
      const f = await installed();
      try {
        await expect(f.strictEngine.inspectPlanReplacementProtocol({ ...f.row, phase }, () => {})).rejects.toThrow();
        expect(f.command.run).not.toHaveBeenCalled();
      } finally {
        f.engine.close();
        f.strictEngine.close();
      }
    }
  );
});
