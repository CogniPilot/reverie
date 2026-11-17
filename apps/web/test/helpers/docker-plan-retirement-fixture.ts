/** Controlled Docker I/O only. Real SourceReader, Storage, Installer and Engine
 * mint the private proofs; this fixture never constructs or patches a brand. */
import { vi } from 'vitest';
import { DockerEmployeeEngine, type DockerContainedResourceController } from '../../src/docker-employee-engine.js';
import { DockerEmployeePlanReplacementWorkRecord } from '../../src/docker-employee-continuation-data.js';
import { DockerEmployeeInspect, boxedOriginal } from '../../src/docker-employee-engine-data.js';
import { dockerContinuationDigest as digest } from '../../src/docker-employee-continuation.js';
import { DockerPlanMoveJournalState, dockerPlanMoveHandoffDigest } from '../../src/docker-plan-move-data.js';
import { identityHelperConfiguration } from '../../src/docker-identity-helper.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from '../../src/docker-employee-provider-view-native.js';
import { captureDockerPlanSourceRetirement } from '../../src/docker-plan-source-retirement.js';
import type { DockerEngineCommand } from '../../src/docker-engine-command.js';
import {
  dockerPlanProviderSelection,
  type DockerProviderRuntimeNamespace,
} from '../../src/docker-employee-provider-view-native.js';
import type { DockerContinuationTaskJournal } from '../../src/docker-continuation-task.js';
import type { PlanMoveRecord } from '../../src/plan-move.js';
import { Session } from '../../src/session.js';
import type { SessionDocker } from '../../src/types.js';
import { DockerPlanSourceReader } from '../../src/docker-plan-source.js';
import { dockerPlanSourceFixture } from './docker-plan-source-fixture.js';
import { dockerPlanJournalFixture } from './docker-plan-move-fixture.js';
const hex = (s: string) => s.repeat(64);
export async function dockerPlanRetirementFixture(options?: {
  runtimeNamespace?: DockerProviderRuntimeNamespace;
  canonicalRead?(row: DockerEmployeePlanReplacementWorkRecord): Promise<{
    providerSourceDigest: string;
    publish(row: DockerEmployeePlanReplacementWorkRecord): Promise<void>;
    requireCurrent(
      row: import('../../src/docker-employee-continuation-data.js').DockerEmployeeContinuationRecord
    ): void;
  }>;
}) {
  const src = dockerPlanSourceFixture(false),
    f = dockerPlanJournalFixture(),
    box = hex('7'),
    helperImage = 'sha256:' + hex('f'),
    targetId = hex('d'),
    storageId = hex('6'),
    identityId = hex('9'),
    network = hex('5');
  src.raw.Mounts.push({
    Type: 'bind',
    Source: '/synthetic/nix',
    Destination: '/nix',
    RW: true,
    Propagation: 'rprivate',
  });
  src.raw.HostConfig.NetworkMode = network;
  src.raw.NetworkSettings = { Networks: { 'synthetic-lan': { NetworkID: network } } };
  const subject = (sid: string, generation: number) => ({
    employeeId: src.row.employeeId,
    sessionId: sid,
    sessionGeneration: generation,
    owner: src.row.owner,
    sourceDigest: src.row.sourceDigest,
    providerSourceDigest: src.row.sourceDigest,
    onVacation: false,
    desiredRunning: true,
  });
  src.row.destination = boxedOriginal(src.raw, subject(src.row.request.sessionId, 1), 'synthetic', true);
  const legacy = DockerEmployeeInspect.parse({
    ...structuredClone(src.raw),
    Id: src.row.original.containerId,
    Config: {
      ...structuredClone(src.raw.Config),
      Labels: {
        'reverie.worker': 'synthetic',
        'reverie.employee': src.row.employeeId,
        'reverie.session': src.row.request.sessionId,
      },
    },
  });
  src.row.original = boxedOriginal(legacy, subject(src.row.request.sessionId, 1), 'synthetic');
  src.binding.originalDigest = digest(src.row.destination);
  const pool = {
    containerId: hex('1'),
    cgroupParent: '/synthetic-pool',
    policyDigest: digest(src.row.policy.pool),
    physicalDigest: hex('2'),
  };
  let row = DockerEmployeePlanReplacementWorkRecord.parse({
    ...f.work,
    employeeId: src.row.employeeId,
    owner: src.row.owner,
    request: {
      ...f.work.request,
      containerId: src.raw.Id,
      imageId: src.raw.Image,
      expectedDestinationImageId: src.raw.Image,
      expectedPolicyDigest: digest(src.row.policy),
    },
    original: src.row.destination,
    workerImage: src.row.workerImage,
    policy: src.row.policy,
    phase: 'pool-ready',
    pool,
    planReplacement: {
      ...f.work.planReplacement,
      ...(options?.runtimeNamespace ? { runtimeNamespace: options.runtimeNamespace } : {}),
      source: {
        binding: src.binding,
        continuationDigest: digest(src.row),
        providerSourceDigest: src.row.sourceDigest,
        networkIds: [network],
      },
    },
  });
  row = DockerEmployeePlanReplacementWorkRecord.parse(JSON.parse(JSON.stringify(row)));
  const canonical = await options?.canonicalRead?.(row);
  if (canonical)
    row = DockerEmployeePlanReplacementWorkRecord.parse({
      ...row,
      providerSourceDigest: canonical.providerSourceDigest,
    });
  const containers = new Map<string, DockerEmployeeInspect | Record<string, unknown>>([[legacy.Id, legacy]]);
  const storage = {
    version: 1,
    purpose: 'reverie-boxed-storage-observation-v1',
    holderStartTicks: '123',
    home: { dev: '11', ino: '12', uid: 1000, gid: 100, mode: 448 },
    nix: { dev: '11', ino: '13', uid: 1000, gid: 100, mode: 448 },
  };
  const initial = {
    version: 1,
    purpose: 'reverie-plan-installed-v1',
    readMode: 'initial',
    operationId: row.request.operationId,
    sessionId: row.request.sessionId,
    containerId: targetId,
    projectionDigest: row.planReplacement.account.projectionDigest,
    accountId: row.planReplacement.account.id,
    provider: 'anthropic',
    contextInputDigest: row.planReplacement.account.contextDigest,
    installedAuthDigest: f.material.authDigest,
    observedAuthDigest: f.material.authDigest,
    tokenDigest: hex('a'),
    contextDigest: hex('b'),
    observedContextDigest: hex('b'),
    homeDev: '11',
    homeIno: '12',
    configDev: '11',
    configIno: '14',
  };
  const live = { ...initial, purpose: 'reverie-plan-live-observation-v1', readMode: 'live' };
  function encoded(id: string, body: Record<string, unknown>, running: boolean) {
    const { Image, HostConfig, ...config } = structuredClone(body);
    const host = HostConfig as Record<string, unknown>;
    const mounts = host.Mounts as Array<{
      Type: string;
      Source: string;
      Target: string;
      ReadOnly?: boolean;
      BindOptions?: { Propagation?: string };
    }>;
    return {
      Id: id,
      Image,
      Config: { ...config, Volumes: null },
      HostConfig: {
        ...host,
        OomKillDisable: false,
        AutoRemove: false,
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      },
      Mounts: mounts.map((m) => ({
        Type: m.Type,
        Source: m.Source,
        Destination: m.Target,
        RW: m.ReadOnly !== true,
        Propagation: m.BindOptions?.Propagation ?? 'rprivate',
      })),
      State: {
        Running: running,
        Status: running ? 'running' : 'created',
        Pid: running ? 222 : 0,
        StartedAt: running ? '2026-11-16T00:00:00.000000000Z' : '0001-01-01T00:00:00Z',
        Paused: false,
        Restarting: false,
        Dead: false,
        ExitCode: 0,
        OOMKilled: false,
      },
      NetworkSettings: { Networks: { 'synthetic-lan': { NetworkID: network } } },
    };
  }
  const command: DockerEngineCommand = {
    create: vi.fn(async (_name, config, current) => {
      current();
      const id = (config.Cmd as string[] | undefined)?.[0] === 'hold-storage' ? storageId : targetId;
      containers.set(id, encoded(id, config, false));
      return id;
    }),
    run: vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'image')
        return JSON.stringify([
          {
            Id: args[2],
            RootFS: { Layers: ['synthetic-layer'] },
            Config: {
              Env: ['PATH=/bin'],
              Entrypoint: src.raw.Config.Entrypoint,
              Cmd: null,
              Volumes: null,
              Labels: { 'org.reverie.worker-client.manifest': row.workerImage.clientManifestDigest },
            },
          },
        ]);
      if (args[0] === 'container' && args[1] === 'inspect') {
        const raw = args[2] === src.raw.Id ? src.raw : containers.get(args[2]!);
        if (!raw) throw Error('Unknown synthetic container');
        return JSON.stringify([raw]);
      }
      if (args[0] === 'container' && args[1] === 'ls') {
        const requested = args.find((a) => a.startsWith('label=reverie.boxed.operation='));
        return requested?.endsWith(row.request.operationId) ? (containers.has(targetId) ? targetId : '') : '';
      }
      if (args[0] === 'container' && args[1] === 'start' && args[2] === storageId) {
        const raw = containers.get(storageId)! as { State: Record<string, unknown> };
        raw.State = {
          ...raw.State,
          Running: true,
          Status: 'running',
          Pid: 111,
          StartedAt: '2026-11-16T00:00:01.000000000Z',
        };
        return storageId;
      }
      if (args[0] === 'logs') return JSON.stringify(args[1] === storageId ? storage : initial) + '\n';
      if (args[0] === 'exec' && args.includes('probe-storage'))
        return JSON.stringify({ ...storage, holderStartTicks: null });
      if (args[0] === 'exec' && args.includes('status')) return '{}';
      if (args[0] === 'exec' && args.includes('storage-status')) return JSON.stringify(storage);
      if (args[0] === 'exec' && args.includes('plan-status'))
        return JSON.stringify(args.includes('initial') ? initial : live) + '\n';
      if (args[0] === 'exec' && args.includes(DOCKER_PROVIDER_VIEW_PROGRAM))
        return (
          JSON.stringify({
            paneId: '%1',
            panePid: 333,
            paneStartTicks: '456',
            hooks: { kind: 'generation', generation: 'synthetic.target:1' },
          }) + '\n'
        );
      throw Error('Unexpected synthetic Docker I/O: ' + args.slice(0, 2).join(' '));
    }),
  };
  const journal: DockerContinuationTaskJournal = {
    read: (_input, role) => row.tasks?.find((t) => t.role === role),
    publish: async (_input, before, next, current) => {
      current();
      const tasks = row.tasks ?? [];
      if (digest(tasks.find((t) => t.role === next.role) ?? null) !== digest(before ?? null))
        throw Error('Synthetic task CAS changed');
      row = DockerEmployeePlanReplacementWorkRecord.parse({
        ...row,
        tasks: [...tasks.filter((t) => t.role !== next.role), next],
      });
      return row;
    },
  };
  const resources: DockerContainedResourceController = {
    validate: vi.fn(async () => {}),
    preparePool: vi.fn(async () => {
      throw Error('No pool mutation');
    }),
    observePool: vi.fn(async () => pool),
    read: vi.fn(async () => null),
    configure: vi.fn(async () => {
      throw Error('No resource mutation');
    }),
  };
  const makeEngine = (
    requireCurrent?: (
      row: import('../../src/docker-employee-continuation-data.js').DockerEmployeeContinuationRecord
    ) => void
  ) =>
    new DockerEmployeeEngine(
      command,
      'synthetic',
      resources,
      {
        imageId: src.raw.Image,
        clientManifestDigest: src.row.workerImage.clientManifestDigest,
        sourceImageIds: [src.raw.Image],
      },
      journal,
      helperImage,
      box,
      undefined,
      undefined,
      requireCurrent
    );
  const engine = makeEngine();
  await engine.prepareStorage(row, () => {});
  row = DockerEmployeePlanReplacementWorkRecord.parse({ ...row, phase: 'destination-issued' });
  await engine.createPlanReplacementDestination(row, () => {});
  const targetRaw = DockerEmployeeInspect.parse(containers.get(targetId));
  targetRaw.State = {
    ...targetRaw.State,
    Running: true,
    Status: 'running',
    Pid: 222,
    StartedAt: '2026-11-16T00:00:02.000000000Z',
  };
  containers.set(targetId, targetRaw);
  row = DockerEmployeePlanReplacementWorkRecord.parse({
    ...row,
    destination: boxedOriginal(
      targetRaw,
      subject(row.request.sessionId, row.request.sessionGeneration),
      'synthetic',
      true
    ),
  });
  const config = await identityHelperConfiguration(
    command,
    row,
    {
      source: src.row.destination.home.source,
      user: '1000:100',
      dev: '11',
      ino: '12',
    },
    box,
    {
      projectionDigest: row.planReplacement.account.projectionDigest,
      payloadDigest: hex('a'),
      attempt: row.request.operationId,
    }
  );
  const identityRaw = encoded(identityId, config, false);
  identityRaw.State = { ...identityRaw.State, Status: 'exited' };
  containers.set(identityId, identityRaw);
  row = DockerEmployeePlanReplacementWorkRecord.parse({
    ...row,
    phase: 'ready',
    tasks: [
      ...row.tasks!,
      {
        role: 'leaf-helper',
        name: 'reverie-boxed-leaf-synthetic',
        imageId: helperImage,
        configurationDigest: hex('3'),
        containerId: hex('8'),
        phase: 'completed',
        resultDigest: hex('4'),
      },
      {
        role: 'identity-helper',
        name: 'reverie-boxed-identity-' + digest([box, 'identity-helper', row.request.operationId]),
        imageId: row.workerImage.imageId,
        configurationDigest: digest(config),
        containerId: identityId,
        phase: 'completed',
        resultDigest: digest(initial),
      },
    ],
  });
  const sourceReader = new DockerPlanSourceReader(
    command,
    'synthetic',
    box,
    'http://reverie:3000',
    (input, current) => engine.captureProviderView(input, current),
    async (input, current) => {
      await engine.existingImage(input, current);
    }
  );
  const sourceProof = await sourceReader.capture(src.row, src.binding, () => {}, true);
  await canonical?.publish(row);
  const readerEngine = canonical ? makeEngine(canonical.requireCurrent) : engine;
  const view = await readerEngine.captureProviderView(row, () => {});
  const docker = (source = false): SessionDocker => ({
    hostId: 'boxed-runtime',
    engine: 'docker',
    containerName: source ? src.raw.Id : targetId,
    image: src.raw.Image,
    label: 'Synthetic',
    hostWorkspacePath: '/',
    containerWorkdir: '/workspace',
    network: 'bridge',
    mountCredentials: false,
    hooksEnabled: false,
    resumeOnStart: true,
    owned: false,
    daemonHost: 'unix:///run/reverie-engine/docker.sock',
    continuation: {
      employeeId: row.employeeId,
      operationId: source ? src.binding.operationId : row.request.operationId,
      sessionGeneration: source ? 1 : row.request.sessionGeneration,
      clientManifestDigest: row.workerImage.clientManifestDigest,
      apiUrl: 'http://reverie:3000',
      ...(source
        ? {}
        : {
            planReplacement: dockerPlanProviderSelection(row.planReplacement),
          }),
    },
  });
  const old = new Session({ id: src.row.request.sessionId, workingDir: '/synthetic', docker: docker(true) });
  const target = new Session({ id: row.request.sessionId, workingDir: '/synthetic', docker: docker() });
  const seed = {
    ...f.state.seed,
    forceBusy: true,
    source: {
      record: src.row,
      binding: src.binding,
      providerSourceDigest: src.row.sourceDigest,
      observation: { kind: 'stopped' as const, terminalStateDigest: digest(src.raw.State) },
    },
    target: {
      ...f.state.seed.target,
      workerImage: row.workerImage,
      ...(options?.runtimeNamespace ? { runtimeNamespace: options.runtimeNamespace } : {}),
    },
  };
  const state = DockerPlanMoveJournalState.parse({
    ...f.state,
    seed,
    material: f.material,
    sourceStop: {
      phase: 'closed',
      epoch: f.epoch,
      sourceContainerId: src.raw.Id,
      sourceConfigurationDigest: src.row.destination.configurationDigest,
      sourceInit: null,
      terminalStateDigest: digest(src.raw.State),
    },
    work: row,
    paidDispatch: {
      phase: 'issued',
      epoch: f.epoch,
      operationId: row.request.operationId,
      sessionId: row.request.sessionId,
      containerId: targetId,
      recipeDigest: row.sourceDigest,
    },
    companyPublication: { phase: 'published', digest: hex('c') },
    handoff: { phase: 'submitted', digest: dockerPlanMoveHandoffDigest(seed.handoff) },
  });
  const record: PlanMoveRecord = {
    ...f.record,
    employeeId: row.employeeId,
    owner: undefined,
    oldSession: old.id,
    newSession: target.id,
    phase: 'completed',
    dockerReplacement: state,
  };
  const proof = captureDockerPlanSourceRetirement(record, state, sourceProof, view, old, target, () => {});
  return {
    proof,
    old,
    target,
    record,
    state,
    command,
    src,
    engine: readerEngine,
    strictEngine: engine,
    docker,
    async retireSourceView() {
      const freshSource = await sourceReader.capture(src.row, src.binding, () => {}, true);
      const freshView = await readerEngine.captureProviderView(row, () => {});
      const freshRetirement = captureDockerPlanSourceRetirement(
        record,
        state,
        freshSource,
        freshView,
        old,
        target,
        () => {}
      );
      old.retireDockerPlanSourceView(freshRetirement);
    },
  };
}
