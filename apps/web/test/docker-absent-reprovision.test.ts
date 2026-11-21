/** Absent-laptop reprovision over the canonical CompanyStore, the real state
 * service and the real Engine adapter. The Docker command is an in-memory
 * inventory: no socket, provider, host path or live data is touched. */
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyStateSchema, EmployeeSchema } from '../src/company-types.js';
import { StateStore } from '../src/state-store.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import {
  DockerEmployeeContinuation,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
  type DockerContinuationEngine,
} from '../src/docker-employee-continuation.js';
import { DockerEmployeeContinuationRecord } from '../src/docker-employee-continuation-data.js';
import { DockerEmployeeEngine } from '../src/docker-employee-engine.js';
import { DockerContainedResources } from '../src/docker-contained-resource-controller.js';
import { DockerResourceRevisionStore } from '../src/docker-resource-revisions.js';
import { boxedMountConfiguration, DockerEmployeeInspect } from '../src/docker-employee-engine-data.js';
import { ephemeralProjection } from '../src/docker-ephemeral-data.js';
import { DockerAbsentReprovision } from '../src/docker-absent-reprovision.js';
import { DockerLaptopTemplate, allowedReprovisionTransition } from '../src/docker-absent-reprovision-data.js';
import { reprovisionHostname, reprovisionSourceName } from '../src/docker-absent-reprovision-source.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { PlanMoves, type PlanMovePort } from '../src/plan-move.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';
import type { SessionState } from '../src/types.js';

const employeeId = '22222222-2222-4222-8222-222222222222';
const sid = 'bbbbbbbb-2222-4222-8222-222222222222';
const oldSid = 'cccccccc-3333-4333-8333-333333333333';
const priorOperation = '55555555-5555-4555-8555-555555555555';
const retireOperation = '66666666-6666-4666-8666-666666666666';
const nextOperation = '77777777-7777-4777-8777-777777777777';
const deployment = 'synthetic-office';
const boxId = '7'.repeat(64);
const workerImage = 'sha256:' + 'e'.repeat(64);
const legacyImage = 'sha256:' + 'd'.repeat(64);
const helperImage = 'sha256:' + '8'.repeat(64);
const manifest = '4'.repeat(64);
const originalCid = 'c'.repeat(64),
  destinationCid = 'a'.repeat(64);
const homeSource = `/synthetic-state/employees/${employeeId}/home`;
const networkName = 'reverie-boxed-api-' + employeeId.replaceAll('-', '');
const policy = {
  memoryMaxBytes: 48 * 1024 ** 3,
  memoryHighBytes: 16 * 1024 ** 3,
  swapMaxBytes: 0,
  pidsMax: 512,
  cpuWeight: 100,
  allowedCpus: [0, 1],
  pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
};
const template = {
  user: '1000:1000',
  scratchRoot: '/synthetic-scratch/laptops',
  mounts: [
    { source: '/synthetic-drives/workspace', destination: '/reverie_workspace', readOnly: false },
    { source: '/synthetic-drives/tools', destination: '/instances/default/tools', readOnly: true },
    { source: '/synthetic-drives/demo', destination: '/projects/demo', readOnly: false },
  ],
  workspaceAlias: true,
};
type Json = Record<string, unknown>;
/** In-memory Engine inventory behind the packaged command port. */
class FakeEngine {
  readonly containers = new Map<string, Json>();
  readonly networks = new Map<string, Json>();
  readonly images = new Map<string, Json>();
  readonly created: Array<{ name: string; configuration: Json }> = [];
  failLists = false;
  createOutcome: 'ok' | 'lost-reply' | 'not-sent' = 'ok';
  #next = 1;
  image(id: string, env: string[] = ['PATH=/opt/reverie/bin:/usr/bin', 'LANG=C.UTF-8']) {
    this.images.set(id, {
      Id: id,
      RootFS: { Layers: ['sha256:' + '1'.repeat(64)] },
      Config: { Entrypoint: null, Cmd: null, Env: env, Labels: { 'org.reverie.worker-client.manifest': manifest } },
    });
  }
  container(id: string, labels: Record<string, string>, running = false) {
    this.containers.set(id, {
      Id: id,
      Name: '/synthetic-' + id.slice(0, 8),
      Image: legacyImage,
      State: { Running: running, Paused: false, Restarting: false, Dead: false, Status: 'exited', Pid: 0 },
      Config: { User: '1000:1000', Entrypoint: null, Cmd: null, Env: [], Labels: labels },
      Mounts: [],
      HostConfig: {},
    });
  }
  async run(args: readonly string[]): Promise<string> {
    const [kind, verb] = args;
    if (verb === 'ls') {
      if (this.failLists) throw Error('synthetic Engine outage');
      const filters = args.flatMap((value, index) => (args[index - 1] === '--filter' ? [value] : []));
      const rows = [...(kind === 'network' ? this.networks : this.containers).values()].filter((row) =>
        filters.every((filter) => {
          if (filter.startsWith('id=')) return (row.Id as string).startsWith(filter.slice(3));
          const [key, ...value] = filter.slice('label='.length).split('=');
          const labels = (kind === 'network' ? row.Labels : (row.Config as Json).Labels) as Record<string, string>;
          return labels?.[key!] === value.join('=');
        })
      );
      return rows.map((row) => (kind === 'network' ? `${row.Id} ${row.Name}` : String(row.Id))).join('\n') + '\n';
    }
    if (verb === 'inspect') {
      const id = args[args.length - 1]!;
      const row = (kind === 'image' ? this.images : kind === 'network' ? this.networks : this.containers).get(id);
      if (!row) throw Error('No such object');
      return JSON.stringify([row]);
    }
    throw Error('Unexpected synthetic Engine command: ' + args.join(' '));
  }
  async create(name: string, configuration: Json, current: () => void): Promise<string> {
    if (!/^reverie-boxed-(?:(?:storage|anchor|pool|leaf)-)?[a-z0-9-]{1,100}$/.test(name))
      throw Error('Fixed boxed destination name required');
    current();
    this.created.push({ name, configuration: structuredClone(configuration) });
    if (this.createOutcome === 'not-sent') throw Error('synthetic create transport failure');
    if ([...this.containers.values()].some((row) => row.Name === '/' + name)) throw Error('synthetic name conflict');
    const host = configuration.HostConfig as Json,
      image = this.images.get(configuration.Image as string);
    if (!image) throw Error('synthetic missing image');
    const chosen = configuration.Env as string[],
      keys = new Set(chosen.map((value) => value.split('=')[0]));
    const id = String(this.#next++).repeat(64).slice(0, 64);
    this.containers.set(id, {
      Id: id,
      Name: '/' + name,
      Image: configuration.Image,
      State: { Running: false, Paused: false, Restarting: false, Dead: false, Status: 'created', Pid: 0 },
      Config: {
        User: configuration.User,
        Entrypoint: configuration.Entrypoint,
        Cmd: null,
        Env: [
          ...chosen,
          ...((image.Config as Json).Env as string[]).filter((value) => !keys.has(value.split('=')[0])),
        ],
        Labels: configuration.Labels,
        Hostname: configuration.Hostname,
        WorkingDir: '',
      },
      Mounts: (host.Mounts as Json[]).map((mount) => ({
        Type: mount.Type,
        Source: mount.Type === 'bind' ? mount.Source : '',
        Destination: mount.Target,
        RW: mount.ReadOnly !== true,
        Mode: '',
        Propagation: mount.Type === 'bind' ? 'rprivate' : '',
      })),
      HostConfig: { ...structuredClone(host), OomKillDisable: false, DeviceRequests: null, CapAdd: null },
    });
    if (this.createOutcome === 'lost-reply') throw Error('synthetic lost create reply');
    return id;
  }
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function original(containerId: string, sessionId = sid) {
  return {
    containerId,
    imageId: legacyImage,
    deployment,
    employeeId,
    sessionId,
    home: { type: 'bind', source: homeSource, destination: '/home/agent', readWrite: true },
    mountDigest: '1'.repeat(64),
    storageDigest: '2'.repeat(64),
    configurationDigest: '3'.repeat(64),
  };
}
function v2Row(phase: 'ready' | 'identity-ready') {
  return DockerEmployeeContinuationRecord.parse({
    version: 2,
    purpose: 'docker-employee-continuation-v2',
    employeeId,
    request: {
      operationId: priorOperation,
      sessionId: sid,
      sessionGeneration: 9,
      containerId: originalCid,
      imageId: legacyImage,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: workerImage,
      enterOffice: false,
    },
    sourceDigest: '5'.repeat(64),
    providerSourceDigest: '6'.repeat(64),
    original: original(originalCid),
    workerImage: { imageId: workerImage, sourceImageId: legacyImage, clientManifestDigest: manifest },
    policy,
    credentialId: '33333333-3333-4333-8333-333333333333',
    phase,
    pool: { containerId: '9'.repeat(64), cgroupParent: 'synthetic.slice', policyDigest: dockerContinuationDigest(policy.pool), physicalDigest: 'f'.repeat(64) },
    destination: { ...original(destinationCid), imageId: workerImage },
  });
}
/** A published plan replacement: the original is the OLD session's boxed placement. */
function v3Row() {
  const task = (role: string, phase: 'running' | 'completed', id: string) => ({
    role,
    name: 'reverie-boxed-' + role + '-synthetic',
    imageId: helperImage,
    configurationDigest: 'b'.repeat(64),
    containerId: id.repeat(64),
    ...(phase === 'running' ? { phase, initPid: 42, initStartTicks: '1234' } : { phase, resultDigest: 'c'.repeat(64) }),
  });
  const source = { ...original(originalCid, oldSid), imageId: workerImage };
  return DockerEmployeeContinuationRecord.parse({
    version: 3,
    purpose: 'docker-employee-plan-replacement-v3',
    employeeId,
    request: {
      operationId: priorOperation,
      sessionId: sid,
      sessionGeneration: 9,
      containerId: originalCid,
      imageId: workerImage,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: workerImage,
      enterOffice: false,
    },
    sourceDigest: '5'.repeat(64),
    providerSourceDigest: '6'.repeat(64),
    original: source,
    workerImage: { imageId: workerImage, sourceImageId: workerImage, clientManifestDigest: manifest },
    policy,
    credentialId: '33333333-3333-4333-8333-333333333333',
    phase: 'ready',
    pool: { containerId: '9'.repeat(64), cgroupParent: 'synthetic.slice', policyDigest: dockerContinuationDigest(policy.pool), physicalDigest: 'f'.repeat(64) },
    destination: { ...original(destinationCid), imageId: workerImage },
    tasks: [task('storage-holder', 'running', '1'), task('identity-helper', 'completed', '2'), task('leaf-helper', 'completed', '3')],
    planReplacement: {
      version: 1,
      purpose: 'docker-plan-replacement-provenance-v1',
      moveId: 'synthetic-move',
      source: {
        binding: {
          version: 1,
          operationId: '44444444-4444-4444-8444-444444444444',
          credentialId: '99999999-9999-4999-8999-999999999999',
          sessionId: oldSid,
          sessionGeneration: 8,
          containerId: originalCid,
          imageId: workerImage,
          originalDigest: dockerContinuationDigest(source),
          policyDigest: dockerContinuationDigest(policy),
        },
        continuationDigest: 'd'.repeat(64),
        providerSourceDigest: 'e'.repeat(64),
      },
      account: { id: 'synthetic-account', provider: 'anthropic', projectionDigest: '1'.repeat(64), contextDigest: '2'.repeat(64) },
    },
  });
}
interface Options {
  row?: DockerEmployeeContinuationRecord;
  bound?: boolean;
  savedDocker?: boolean;
  launchIntent?: boolean;
  launchTransport?: string;
  employee?: Record<string, unknown>;
  moves?: { openMoves: unknown; abandonAbsentDockerMoves: unknown } | null;
}
async function fixture(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'absent-laptop-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const row = options.row ?? v2Row('ready');
  const bound = options.bound ?? row.phase !== 'identity-ready';
  const binding = {
    version: 1 as const,
    operationId: row.request.operationId,
    credentialId: row.credentialId,
    sessionId: sid,
    sessionGeneration: 9,
    containerId: row.destination!.containerId,
    imageId: row.destination!.imageId,
    originalDigest: dockerContinuationDigest(row.destination),
    policyDigest: dockerContinuationDigest(row.policy),
  };
  const companyStore = new CompanyStore(join(directory, 'company.json'));
  await companyStore.init();
  const company = new CompanyService(companyStore, {
    getSession: () => undefined,
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  await companyStore.update((state) => {
    state.employees = [
      EmployeeSchema.parse({
        id: employeeId,
        sessionId: sid,
        sessionGeneration: 9,
        name: 'Ada Lovelace',
        icon: 'A',
        position: 'Engineer',
        expertise: ['synthetic testing'],
        createdAt: 1,
        onVacation: false,
        desiredRunning: true,
        runtimeRecipe: { mode: 'claude', workingDir: '/reverie_workspace/cases/demo' },
        dockerResourcePolicy: policy,
        ...(bound ? { dockerBinding: binding } : {}),
        ...options.employee,
      }),
    ];
    state.dockerEmployeeContinuations = [row];
  });
  const conversation = {
    resumeSessionId: 'dddddddd-4444-4444-8444-444444444444',
    claudeSessionChain: ['dddddddd-4444-4444-8444-444444444444'],
    runtimeThreads: { claude: 'synthetic-thread' },
  };
  const saved = {
    id: sid,
    mode: 'claude',
    workingDir: '/reverie_workspace/cases/demo',
    status: 'idle',
    pid: 4242,
    ...conversation,
    ...((options.savedDocker ?? bound)
      ? {
          docker: {
            hostId: 'boxed-runtime',
            label: 'Docker-contained employee',
            engine: 'docker',
            image: workerImage,
            containerName: row.destination!.containerId,
            hostWorkspacePath: '/',
            containerWorkdir: '/reverie_workspace/cases/demo',
            network: 'bridge',
            mountCredentials: false,
            hooksEnabled: false,
            resumeOnStart: true,
            owned: false,
            daemonHost: 'unix:///run/reverie-engine/docker.sock',
            continuation: {
              operationId: row.request.operationId,
              employeeId,
              sessionGeneration: 9,
              clientManifestDigest: manifest,
              apiUrl: 'http://synthetic-office:3000',
            },
          },
        }
      : {}),
  };
  const stateFile = join(directory, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      sessions: { [sid]: saved },
      ...((options.launchIntent ?? bound)
        ? {
            __providerLaunchIntentsV1: {
              version: 1,
              kind: 'observed',
              rows: {
                [sid]: {
                  version: 1,
                  phase: 'dispatch-intent',
                  attemptId: 'eeeeeeee-5555-4555-8555-555555555555',
                  sessionId: sid,
                  owner: null,
                  mode: 'claude',
                  transport: options.launchTransport ?? 'docker',
                  configurationDigest: 'a'.repeat(64),
                },
              },
            },
          }
        : {}),
    }),
    { mode: 0o600 }
  );
  const state = new StateStore(stateFile);
  const store = new CompanyDockerContinuationStore(company, (id) => state.getSession(id) ?? undefined);
  const engine = new FakeEngine();
  engine.image(workerImage);
  engine.image(legacyImage);
  engine.image(helperImage);
  engine.networks.set('b'.repeat(64), {
    Id: 'b'.repeat(64),
    Name: networkName,
    Driver: 'bridge',
    Labels: { 'reverie.boxed.employee': employeeId, 'reverie.box.purpose': 'per-worker-office-api' },
    Containers: { ['0'.repeat(64)]: { Name: deployment } },
  });
  let authorized = true,
    live: { inert: boolean } | undefined;
  const discarded: string[] = [];
  const authority: DockerContinuationAuthority = {
    owner: undefined,
    require() {
      if (!authorized) throw Error('synthetic revoked owner');
    },
    requireOffice() {},
  };
  const moves =
    options.moves === null
      ? undefined
      : (options.moves ?? { openMoves: async () => [], abandonAbsentDockerMoves: async () => [] });
  let busy = false;
  const service = new DockerAbsentReprovision(
    company,
    store,
    engine,
    { deployment, boxId, apiUrl: 'http://synthetic-office:3000', workerImageId: workerImage, sourceImageIds: [legacyImage] },
    {
      saved: (id) => state.getSession(id) ?? undefined,
      live: () => live,
      blocked: (id, owner) => state.dockerAbsentReprovisionBlocker(id, owner),
      discard: async (id) => {
        discarded.push(id);
        live = undefined;
      },
      clear: (proof) => state.commitDockerAbsentReprovision(proof),
    },
    () => moves as never,
    () => busy,
    () => {},
    () => 1234
  );
  const request = async (operationId = retireOperation, body = template) => ({
    operationId,
    sessionId: sid,
    sessionGeneration: 9,
    expectedScopeDigest: (await service.preview(employeeId, body, authority)).scopeDigest,
    template: body,
  });
  return {
    directory, company, companyStore, state, stateFile, store, engine, service, authority, row, binding, saved,
    conversation, request, discarded,
    setLive: (value: { inert: boolean } | undefined) => { live = value; },
    setBusy: (value: boolean) => { busy = value; },
    revoke: () => { authorized = false; },
    snapshot: () => companyStore.snapshot(),
    entry: () => companyStore.snapshot().retiredDockerEmployeeContinuations?.[0],
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** The existing continuation over the REAL Engine adapter for source reads. */
function continuation(f: Fixture) {
  const revisions = new DockerResourceRevisionStore(join(f.directory, 'resource-revisions'));
  cleanups.push(() => revisions.close());
  const resources = new DockerContainedResources(
    f.engine,
    f.store,
    { boxId, deployment, helperImageId: helperImage, selectedWorkerContainerIds: () => [] },
    revisions
  );
  const real = new DockerEmployeeEngine(
    f.engine,
    deployment,
    resources,
    { imageId: workerImage, clientManifestDigest: manifest, sourceImageIds: [legacyImage] },
    f.store,
    helperImage,
    boxId
  );
  const effects: string[] = [];
  const engine = {
    observeSource: (subject, containerId, expected) => real.observeSource(subject, containerId, expected),
    image: (source) => real.image(source),
    validateCapabilities: (source, approved) => real.validateCapabilities(source, approved),
    async preparePool() {
      effects.push('pool');
    },
    async observePool() {
      return null;
    },
    async createDestination() {
      effects.push('destination');
    },
    async observeDestination() {
      return null;
    },
    async start() {},
    async configureResources() {},
    async provisionIdentity() {},
  } satisfies DockerContinuationEngine;
  const service = new DockerEmployeeContinuation(f.store, engine, { async launch() {} }, { issue: () => 'unused' });
  return { service, effects };
}
async function beginsAgain(f: Fixture, sourceContainerId: string) {
  const { service, effects } = continuation(f);
  const selection = await service.selection(employeeId, f.authority);
  expect(selection).toMatchObject({
    state: 'stopped',
    operationId: null,
    operation: null,
    containerId: sourceContainerId,
    imageId: workerImage,
    destinationImageId: workerImage,
    sessionId: sid,
    sessionGeneration: 9,
  });
  const result = await service.begin(
    employeeId,
    {
      operationId: nextOperation,
      sessionId: sid,
      sessionGeneration: 9,
      containerId: selection.containerId,
      imageId: selection.imageId,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: selection.destinationImageId,
      enterOffice: false,
    },
    f.authority
  );
  // Accepted and advanced to the first native effect of the ordinary flow.
  expect(result).toMatchObject({ operationId: nextOperation, phase: 'pool-issued', state: 'held', code: 'DOCKER_CONTINUATION_POOL_UNCONFIRMED' });
  expect(effects).toEqual(['pool']);
  const row = f.store.record(employeeId)!;
  expect(row).toMatchObject({ version: 2, phase: 'pool-issued' });
  expect(row.original).toMatchObject({ containerId: sourceContainerId, employeeId, sessionId: sid, home: f.row.original.home });
}

describe('absence proof', () => {
  it('previews an all-absent laptop without changing anything', async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.companyStore.file, 'utf8');
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      employeeId,
      sessionId: sid,
      sessionGeneration: 9,
      record: { version: 2, phase: 'ready', operationId: priorOperation },
      absent: [destinationCid, originalCid],
      present: [],
      home: f.row.original.home,
      nixSource: `/synthetic-state/employees/${employeeId}/nix`,
      scratchSource: `/synthetic-scratch/laptops/employees/${employeeId}`,
      sourceImageId: workerImage,
      network: { name: networkName, id: 'b'.repeat(64) },
      planMoves: [],
      allowedActions: ['reprovision'],
    });
    expect(preview.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(f.companyStore.file, 'utf8')).toBe(before);
    expect(f.engine.created).toEqual([]);
  });
  it.each([
    ['the recorded original', (f: Fixture) => f.engine.container(originalCid, {})],
    ['the recorded destination while running', (f: Fixture) => f.engine.container(destinationCid, {}, true)],
    [
      'another boxed container of this employee',
      (f: Fixture) =>
        f.engine.container('4'.repeat(64), { 'reverie.boxed.employee': employeeId, 'reverie.boxed.instance': deployment }),
    ],
    [
      'a native laptop of this employee',
      (f: Fixture) => f.engine.container('5'.repeat(64), { 'reverie.employee': employeeId, 'reverie.worker': deployment }),
    ],
  ])('refuses while %s exists', async (_name, add) => {
    const f = await fixture();
    const input = await f.request();
    add(f);
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview.present).toHaveLength(1);
    expect(preview).toMatchObject({ allowedActions: [], code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT' });
    await expect(f.service.reprovision(employeeId, input, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT',
    });
    await expect(
      f.service.reprovision(employeeId, { ...input, expectedScopeDigest: preview.scopeDigest }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT' });
    expect(f.store.record(employeeId)).toEqual(f.row);
    expect(f.entry()).toBeUndefined();
  });
  it('treats an Engine error as unknown, never as absence', async () => {
    const f = await fixture();
    const input = await f.request();
    f.engine.failLists = true;
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_ABSENCE_UNCONFIRMED',
    });
    await expect(f.service.reprovision(employeeId, input, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_ABSENCE_UNCONFIRMED',
    });
    expect(f.store.record(employeeId)).toEqual(f.row);
    expect(f.snapshot().employees[0]!.dockerBinding).toEqual(f.binding);
    expect(f.state.getSession(sid)?.docker).toBeDefined();
  });
  it('refuses foreign listing output', async () => {
    const f = await fixture();
    const run = f.engine.run.bind(f.engine);
    f.engine.run = async (args) => (args[1] === 'ls' && args[0] === 'container' ? 'Error response from daemon\n' : run(args));
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_ABSENCE_UNCONFIRMED',
    });
  });
});

describe('preconditions', () => {
  it.each([
    ['on vacation', { onVacation: true }, 'DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE'],
    ['not desired running', { desiredRunning: false }, 'DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE'],
  ])('refuses an employee %s', async (_name, employee, code) => {
    const f = await fixture({ employee });
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({ code });
  });
  it('refuses during a continuation flight, an active session, a missing journal or a foreign move', async () => {
    const busy = await fixture();
    busy.setBusy(true);
    await expect(busy.service.preview(employeeId, template, busy.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_BUSY',
    });
    const active = await fixture();
    active.setLive({ inert: false });
    await expect(active.service.preview(employeeId, template, active.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SESSION_ACTIVE',
    });
    const unbound = await fixture({ moves: null });
    await expect(unbound.service.preview(employeeId, template, unbound.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_PLAN_JOURNAL_UNAVAILABLE',
    });
    for (const move of [{ id: 'm', docker: false, busy: false }, { id: 'm', docker: true, busy: true }]) {
      const f = await fixture({ moves: { openMoves: async () => [move], abandonAbsentDockerMoves: async () => [] } });
      await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
        code: 'DOCKER_REPROVISION_PLAN_MOVE_ACTIVE',
      });
    }
  });
  it('requires a continuation record and the surviving office network', async () => {
    const f = await fixture();
    f.engine.networks.clear();
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_OFFICE_NETWORK_REQUIRED',
    });
    const shared = await fixture();
    (shared.engine.networks.get('b'.repeat(64))!.Containers as Json)['6'.repeat(64)] = {};
    await expect(shared.service.preview(employeeId, template, shared.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_OFFICE_NETWORK_CHANGED',
    });
    const none = await fixture();
    await none.companyStore.update((state) => {
      state.dockerEmployeeContinuations = [];
    });
    await expect(none.service.preview(employeeId, template, none.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_RECORD_REQUIRED',
    });
  });
  it('requires the owner to choose between several office networks', async () => {
    const f = await fixture();
    const second = 'reverie-boxed-api-' + employeeId.slice(0, 8) + '-move0a1b2c3d';
    f.engine.networks.set('d'.repeat(64), {
      Id: 'd'.repeat(64),
      Name: second,
      Driver: 'bridge',
      Labels: { 'reverie.boxed.employee': employeeId },
      Containers: { ['0'.repeat(64)]: {} },
    });
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_OFFICE_NETWORK_AMBIGUOUS',
    });
    const chosen = await f.service.preview(employeeId, { ...template, network: second }, f.authority);
    expect(chosen).toMatchObject({ network: { name: second, id: 'd'.repeat(64) }, networkCandidates: [networkName, second].sort() });
  });
  it('refuses a stale preview and a revoked owner', async () => {
    const f = await fixture();
    const input = await f.request();
    await expect(
      f.service.reprovision(employeeId, { ...input, expectedScopeDigest: '0'.repeat(64) }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_SCOPE_CHANGED' });
    await expect(
      f.service.reprovision(employeeId, { ...input, template: { ...template, user: '1001:1001' } }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_SCOPE_CHANGED' });
    f.revoke();
    await expect(f.service.reprovision(employeeId, input, f.authority)).rejects.toThrow('synthetic revoked owner');
    expect(f.store.record(employeeId)).toEqual(f.row);
    expect(f.engine.created).toEqual([]);
  });
});

describe('laptop template', () => {
  const mount = (destination: string, readOnly = false, source = '/synthetic-drives/x') => ({
    ...template,
    workspaceAlias: undefined,
    mounts: [{ source, destination, readOnly }],
  });
  it('accepts the supported shared-drive layout', () => {
    expect(DockerLaptopTemplate.parse(template)).toEqual(template);
    expect(DockerLaptopTemplate.safeParse(mount('/projects')).success).toBe(true);
    expect(DockerLaptopTemplate.safeParse(mount('/run/reverie-model', true)).success).toBe(true);
  });
  it.each([
    ['root user', { ...template, user: '0:0' }],
    ['user name', { ...template, user: 'agent' }],
    ['relative scratch root', { ...template, scratchRoot: 'scratch/laptops' }],
    ['parent segment', mount('/projects/demo', false, '/synthetic-drives/../etc')],
    ['control character', mount('/projects/demo', false, '/synthetic-drives/a\nb')],
    ['unknown field', { ...template, privileged: true }],
    ['private home', mount('/home/agent')],
    ['inside private home', mount('/home/agent/.ssh')],
    ['private nix', mount('/nix')],
    ['temporary storage', mount('/tmp')],
    ['scratch storage', mount('/scratch/cache')],
    ['kernel interface', mount('/proc')],
    ['worker tools capsule', mount('/opt/reverie-worker-tools')],
    ['worker client capsule', mount('/opt/reverie-worker-client/bin', true)],
    ['another worker capsule', mount('/opt/reverie-worker-extra', true)],
    ['engine runtime directory', mount('/run/reverie-engine', true)],
    ['engine socket', mount('/var/run/docker.sock', true)],
    ['native office transport', mount('/run/reverie-office', true)],
    ['unsupported target', mount('/etc')],
    ['nested project', mount('/projects/a/b')],
    ['writable published data', mount('/host-published')],
    ['writable tools', mount('/instances/default/tools')],
    ['writable statusline exporter', mount('/instances/default/console/statusline-exporter.sh')],
    ['writable model runtime', mount('/run/reverie-model')],
    [
      'duplicate targets',
      { ...template, workspaceAlias: undefined, mounts: [template.mounts[0], template.mounts[0]] },
    ],
    [
      'overlapping targets',
      {
        ...template,
        workspaceAlias: undefined,
        mounts: [
          { source: '/a', destination: '/projects', readOnly: false },
          { source: '/b', destination: '/projects/demo', readOnly: false },
        ],
      },
    ],
    ['alias without workspace', { ...template, mounts: [template.mounts[1]] }],
    ['alias beside an explicit /workspace', { ...template, mounts: [...template.mounts, { source: '/w', destination: '/workspace', readOnly: false }] }],
    ['foreign network name', { ...template, network: 'bridge' }],
  ])('refuses %s', (_name, value) => {
    expect(DockerLaptopTemplate.safeParse(value).success).toBe(false);
  });
  it.each([
    ['a scratch root outside the ephemeral layout', { ...template, scratchRoot: '/synthetic-scratch/other' }, 'DOCKER_REPROVISION_SCRATCH_LAYOUT_UNSUPPORTED'],
    [
      'a drive inside the private employee directory',
      { ...template, mounts: [{ source: `/synthetic-state/employees/${employeeId}/home/work`, destination: '/reverie_workspace', readOnly: false }] },
      'DOCKER_REPROVISION_TEMPLATE_STORAGE_OVERLAP',
    ],
    [
      'a drive containing the ephemeral root',
      { ...template, mounts: [{ source: '/synthetic-scratch', destination: '/reverie_workspace', readOnly: false }] },
      'DOCKER_REPROVISION_TEMPLATE_STORAGE_OVERLAP',
    ],
  ])('refuses %s', async (_name, value, code) => {
    const f = await fixture();
    await expect(f.service.preview(employeeId, value, f.authority)).rejects.toMatchObject({ code });
  });
  it('requires the recorded private home to be the employee bind', async () => {
    const row = v2Row('ready');
    const volume = DockerEmployeeContinuationRecord.parse({
      ...row,
      original: { ...row.original, home: { ...row.original.home, type: 'volume', source: 'synthetic-volume' } },
      destination: { ...row.destination!, home: { ...row.original.home, type: 'volume', source: 'synthetic-volume' } },
    });
    const f = await fixture({ row: volume });
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_PRIVATE_HOME_UNSUPPORTED',
    });
  });
});

describe('retirement and replacement source', () => {
  it('retires the record, clears the stale view and creates one inert source', async () => {
    const f = await fixture();
    const before = f.store.subject(employeeId);
    expect(before).toBeDefined();
    f.setLive({ inert: true });
    const result = await f.service.reprovision(employeeId, await f.request(), f.authority);
    const name = reprovisionSourceName(boxId, retireOperation);
    expect(result).toEqual({
      operationId: retireOperation,
      state: 'ready',
      sourceContainerId: '1'.repeat(64),
      sourceImageId: workerImage,
    });
    // CompanyStore: verbatim history, no row, no binding, format 2.
    const state = f.snapshot();
    expect(state.version).toBe(2);
    expect(state.dockerEmployeeContinuations).toEqual([]);
    expect(state.employees[0]!.dockerBinding).toBeUndefined();
    expect(state.employees[0]).toMatchObject({ id: employeeId, sessionId: sid, sessionGeneration: 9, dockerResourcePolicy: policy });
    expect(f.entry()).toMatchObject({
      version: 1,
      purpose: 'docker-absent-continuation-retirement-v1',
      retiredAt: 1234,
      operationId: retireOperation,
      reason: 'recorded-containers-absent',
      employeeId,
      sessionId: sid,
      sessionGeneration: 9,
      absent: { containerIds: [destinationCid, originalCid], planMoveIds: [] },
      record: f.row,
      binding: f.binding,
      template,
      templateDigest: dockerContinuationDigest(template),
      session: { phase: 'cleared', containerName: destinationCid },
      source: { phase: 'created', name, imageId: workerImage, network: { name: networkName, id: 'b'.repeat(64) }, containerId: '1'.repeat(64) },
    });
    // Saved session: stale boxed view and launch denial gone, conversation kept.
    expect(f.discarded).toEqual([sid]);
    const saved = f.state.getSession(sid)!;
    expect(saved.docker).toBeUndefined();
    expect(saved).toMatchObject({ ...f.conversation, id: sid, mode: 'claude', status: 'stopped', pid: null });
    const disk = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    expect(disk.sessions[sid]).toMatchObject(f.conversation);
    expect(disk.sessions[sid].docker).toBeUndefined();
    expect(disk.__providerLaunchIntentsV1.rows[sid]).toBeUndefined();
    // The launch and provider correlation digests are unchanged by the cleanup.
    const after = f.store.subject(employeeId)!;
    expect(after).toMatchObject({ sourceDigest: before!.sourceDigest, providerSourceDigest: before!.providerSourceDigest });
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('defines the source exactly', async () => {
    const f = await fixture();
    await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(f.engine.created).toHaveLength(1);
    const bind = (Source: string, Target: string, readOnly = false) => ({
      Type: 'bind',
      Source,
      Target,
      ...(readOnly ? { ReadOnly: true } : {}),
      BindOptions: { Propagation: 'rprivate' },
    });
    const overlay = (Target: string) => ({ Type: 'tmpfs', Target, ReadOnly: true, TmpfsOptions: { SizeBytes: 1048576, Mode: 0o555 } });
    expect(f.engine.created[0]).toEqual({
      name: reprovisionSourceName(boxId, retireOperation),
      configuration: {
        Image: workerImage,
        User: '1000:1000',
        Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
        Cmd: [],
        Env: [
          'PATH=/opt/reverie/bin:/usr/bin',
          'HOME=/home/agent',
          'REVERIE_WORKER=1',
          'REVERIE_INSTALL_CLIS=none',
          'TMPDIR=/tmp',
          'TMP=/tmp',
          'TEMP=/tmp',
          'XDG_CACHE_HOME=/tmp/reverie/cache',
          'PIP_CACHE_DIR=/tmp/reverie/cache/pip',
          'UV_CACHE_DIR=/tmp/reverie/cache/uv',
          'npm_config_cache=/tmp/reverie/cache/npm',
          'CCACHE_DIR=/tmp/reverie/cache/ccache',
          'GOCACHE=/tmp/reverie/cache/go-build',
          'GOMODCACHE=/tmp/reverie/cache/go-mod',
          'XDG_DOWNLOAD_DIR=/tmp/reverie/downloads',
          'REVERIE_API_URL=http://synthetic-office:3000',
        ],
        Hostname: 'ada-lovelace-22222222',
        Labels: {
          'reverie.worker': deployment,
          'reverie.employee': employeeId,
          'reverie.session': sid,
          'reverie.storage': 'employee:' + employeeId,
          'reverie.reprovision.purpose': 'absent-laptop-source-v1',
          'reverie.reprovision.operation': retireOperation,
        },
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          Init: false,
          AutoRemove: false,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          RestartPolicy: { Name: 'no' },
          NetworkMode: networkName,
          Tmpfs: { '/run': 'rw,nosuid,nodev,size=16777216' },
          Mounts: [
            bind(homeSource, '/home/agent'),
            bind(`/synthetic-state/employees/${employeeId}/nix`, '/nix'),
            bind(`/synthetic-scratch/laptops/employees/${employeeId}/tmp`, '/tmp'),
            bind(`/synthetic-scratch/laptops/employees/${employeeId}`, '/scratch'),
            bind('/synthetic-drives/workspace', '/reverie_workspace'),
            bind('/synthetic-drives/tools', '/instances/default/tools', true),
            bind('/synthetic-drives/demo', '/projects/demo'),
            bind('/synthetic-drives/workspace', '/workspace'),
            overlay('/reverie_workspace/attachments'),
            overlay('/workspace/attachments'),
          ],
        },
      },
    });
    // What the destination builder and the ephemeral restoration will read.
    const raw = DockerEmployeeInspect.parse(f.engine.containers.get('1'.repeat(64)));
    expect(raw.State.Running).toBe(false);
    expect(boxedMountConfiguration(raw).filter((mount) => mount.Type === 'tmpfs')).toEqual([
      overlay('/reverie_workspace/attachments'),
      overlay('/workspace/attachments'),
    ]);
    expect(ephemeralProjection(raw, employeeId, sid)).toEqual({
      rootSource: '/synthetic-scratch',
      layout: 'employees',
      identity: employeeId,
      scratchSource: `/synthetic-scratch/laptops/employees/${employeeId}`,
      tmpSource: `/synthetic-scratch/laptops/employees/${employeeId}/tmp`,
    });
    expect(JSON.stringify(f.engine.created)).not.toMatch(/docker\.sock|reverie-engine|reverie-office|DeviceRequests/);
  });
  it('falls back to an accepted source image when the worker image has no single PATH', async () => {
    const f = await fixture();
    f.engine.image(workerImage, ['LANG=C.UTF-8']);
    expect((await f.service.preview(employeeId, template, f.authority)).sourceImageId).toBe(legacyImage);
    f.engine.images.delete(legacyImage);
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SOURCE_IMAGE_UNAVAILABLE',
    });
  });
  it('uses the legacy hostname label rule', () => {
    expect(reprovisionHostname('Ada  Lovelace!', employeeId)).toBe('ada-lovelace-22222222');
    expect(reprovisionHostname('---', employeeId)).toBe('employee-22222222');
    expect(reprovisionHostname('x'.repeat(80), employeeId)).toBe('x'.repeat(48) + '-22222222');
  });
  it('replays the same operation and refuses a different one afterwards', async () => {
    const f = await fixture();
    const input = await f.request();
    const first = await f.service.reprovision(employeeId, input, f.authority);
    const company = fs.readFileSync(f.companyStore.file, 'utf8'),
      state = fs.readFileSync(f.stateFile, 'utf8');
    // Even with the Engine gone, a completed operation returns its recorded result.
    f.engine.failLists = true;
    expect(await f.service.reprovision(employeeId, input, f.authority)).toEqual(first);
    f.engine.failLists = false;
    expect(f.engine.created).toHaveLength(1);
    expect(fs.readFileSync(f.companyStore.file, 'utf8')).toBe(company);
    expect(fs.readFileSync(f.stateFile, 'utf8')).toBe(state);
    await expect(
      f.service.reprovision(employeeId, { ...input, template: { ...template, user: '1001:1001' } }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_OPERATION_CHANGED' });
    await expect(
      f.service.reprovision(employeeId, { ...input, operationId: nextOperation }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_RECORD_REQUIRED' });
    expect(f.snapshot().retiredDockerEmployeeContinuations).toHaveLength(1);
  });
  it('observes a create whose reply was lost instead of repeating it', async () => {
    const f = await fixture();
    const input = await f.request();
    f.engine.createOutcome = 'lost-reply';
    expect(await f.service.reprovision(employeeId, input, f.authority)).toEqual({
      operationId: retireOperation,
      state: 'held',
      code: 'DOCKER_REPROVISION_EFFECT_UNCONFIRMED',
    });
    expect(f.entry()).toMatchObject({ session: { phase: 'cleared' }, source: { phase: 'issued' } });
    expect(f.store.record(employeeId)).toBeUndefined();
    f.engine.createOutcome = 'ok';
    expect(await f.service.reprovision(employeeId, input, f.authority)).toMatchObject({
      state: 'ready',
      sourceContainerId: '1'.repeat(64),
    });
    expect(f.engine.created).toHaveLength(1);
    await beginsAgain(f, '1'.repeat(64));
  });
  it('re-issues only after the Engine positively lists no source', async () => {
    const f = await fixture();
    const input = await f.request();
    f.engine.createOutcome = 'not-sent';
    expect(await f.service.reprovision(employeeId, input, f.authority)).toMatchObject({ state: 'held' });
    f.engine.failLists = true;
    expect(await f.service.reprovision(employeeId, input, f.authority)).toMatchObject({
      state: 'held',
      code: 'DOCKER_REPROVISION_ABSENCE_UNCONFIRMED',
    });
    expect(f.engine.created).toHaveLength(1);
    f.engine.failLists = false;
    f.engine.createOutcome = 'ok';
    expect(await f.service.reprovision(employeeId, input, f.authority)).toMatchObject({ state: 'ready' });
    expect(f.engine.created).toHaveLength(2);
    expect(f.engine.created[1]).toEqual(f.engine.created[0]);
  });
  it('holds when a foreign container occupies the source labels', async () => {
    const f = await fixture();
    const input = await f.request();
    f.engine.createOutcome = 'not-sent';
    await f.service.reprovision(employeeId, input, f.authority);
    f.engine.container('5'.repeat(64), { 'reverie.employee': employeeId, 'reverie.worker': deployment, 'reverie.session': sid });
    f.engine.createOutcome = 'ok';
    expect(await f.service.reprovision(employeeId, input, f.authority)).toMatchObject({
      state: 'held',
      code: 'DOCKER_REPROVISION_SOURCE_CHANGED',
    });
    expect(f.engine.created).toHaveLength(1);
    expect(f.entry()!.source.phase).toBe('issued');
  });
  it('accepts a retired identity-ready record that never published a binding', async () => {
    const f = await fixture({ row: v2Row('identity-ready') });
    expect(f.snapshot().employees[0]!.dockerBinding).toBeUndefined();
    const result = await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(result.state).toBe('ready');
    expect(f.entry()).toMatchObject({ binding: null, session: { phase: 'cleared', containerName: null } });
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('accepts a retired plan replacement record and closes its open move', async () => {
    const abandoned: unknown[] = [];
    const f = await fixture({
      row: v3Row(),
      moves: {
        openMoves: async () => [{ id: 'synthetic-move', docker: true, busy: false }],
        abandonAbsentDockerMoves: async (...args: unknown[]) => {
          abandoned.push(args.slice(0, 3));
          return ['synthetic-move'];
        },
      },
    });
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview).toMatchObject({ record: { version: 3, phase: 'ready' }, planMoves: ['synthetic-move'] });
    const result = await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(result.state).toBe('ready');
    expect(abandoned).toEqual([
      [employeeId, undefined, { version: 1, reason: 'recorded-containers-absent', operationId: retireOperation, at: 1234 }],
    ]);
    expect(f.entry()).toMatchObject({ record: f.row, absent: { planMoveIds: ['synthetic-move'] } });
    // begin() refused a v3 row before; the ordinary v2 flow now owns the laptop.
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('lets only the canonical retirement clear a session and keeps a foreign launch denial', async () => {
    const forged = await fixture();
    await expect(forged.state.commitDockerAbsentReprovision({ sessionId: sid })).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_PROOF_REQUIRED',
    });
    expect(forged.state.getSession(sid)?.docker).toBeDefined();
    const f = await fixture({ launchTransport: 'native-ordinary' });
    // Refused before anything is retired: an unrelated native denial keeps its own recovery.
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN',
    });
    expect(f.store.record(employeeId)).toEqual(f.row);
    expect(f.entry()).toBeUndefined();
    expect(f.state.getSession(sid)?.docker).toBeDefined();
    expect(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).__providerLaunchIntentsV1.rows[sid].transport).toBe(
      'native-ordinary'
    );
    expect(f.engine.created).toEqual([]);
  });
  it('refuses a saved view of a container that was not proven absent', async () => {
    const f = await fixture();
    f.state.setSession(sid, {
      ...f.state.getSession(sid)!,
      docker: { ...f.state.getSession(sid)!.docker!, containerName: '4'.repeat(64) },
    } as SessionState);
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SESSION_VIEW_FOREIGN',
    });
  });
});

describe('canonical formats', () => {
  it('round-trips retirement history and still loads data without it', async () => {
    const f = await fixture();
    const legacy = JSON.parse(fs.readFileSync(f.companyStore.file, 'utf8'));
    expect(legacy.version).toBe(1);
    expect(legacy.retiredDockerEmployeeContinuations).toBeUndefined();
    expect(CompanyStateSchema.parse(legacy).retiredDockerEmployeeContinuations).toBeUndefined();
    await f.service.reprovision(employeeId, await f.request(), f.authority);
    const text = fs.readFileSync(f.companyStore.file, 'utf8'),
      saved = JSON.parse(text);
    expect(saved.version).toBe(2);
    const reloaded = new CompanyStore(f.companyStore.file);
    await reloaded.init();
    expect(reloaded.snapshot().retiredDockerEmployeeContinuations).toEqual(saved.retiredDockerEmployeeContinuations);
    expect(JSON.stringify(CompanyStateSchema.parse(saved).retiredDockerEmployeeContinuations)).toBe(
      JSON.stringify(saved.retiredDockerEmployeeContinuations)
    );
    // Format 1 cannot carry the history, and format 2 is never downgraded.
    expect(CompanyStateSchema.safeParse({ ...saved, version: 1 }).success).toBe(false);
    await expect(
      reloaded.update((state) => {
        state.version = 1;
      })
    ).rejects.toMatchObject({ code: 'DOCKER_COMPANY_FORMAT_DOWNGRADE_REFUSED' });
    // An unrelated later write keeps the history.
    await reloaded.update((state) => {
      state.employees[0]!.position = 'Staff Engineer';
    });
    expect(JSON.parse(fs.readFileSync(f.companyStore.file, 'utf8')).retiredDockerEmployeeContinuations).toEqual(
      saved.retiredDockerEmployeeContinuations
    );
  });
  it('lets a retirement cursor only advance', async () => {
    const f = await fixture();
    await f.service.reprovision(employeeId, await f.request(), f.authority);
    const done = f.entry()!;
    const pending = { ...done, session: { ...done.session, phase: 'pending' as const }, source: { phase: 'pending' as const } };
    const issued = { ...done, source: { ...done.source, phase: 'issued' as const, containerId: undefined } };
    delete (issued.source as { containerId?: string }).containerId;
    expect(allowedReprovisionTransition(pending, { ...pending, session: done.session })).toBe(true);
    expect(allowedReprovisionTransition({ ...pending, session: done.session }, issued as never)).toBe(true);
    expect(allowedReprovisionTransition(issued as never, done)).toBe(true);
    expect(allowedReprovisionTransition(done, issued as never)).toBe(false);
    expect(allowedReprovisionTransition({ ...pending, session: done.session }, done)).toBe(false);
    expect(allowedReprovisionTransition(done, { ...done, retiredAt: 5 })).toBe(false);
    expect(
      allowedReprovisionTransition(done, { ...done, source: { ...done.source, containerId: '9'.repeat(64) } as never })
    ).toBe(false);
  });
});

describe('plan move abandonment', () => {
  it('closes issued native work as an explicit, immutable terminal record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'absent-move-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const fx = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(directory, 'moves.json'));
    await store.save([fx.record]);
    await store.dockerPublish(fx.record.id, fx.state, fx.closed, () => {});
    const abandonment = { version: 1 as const, reason: 'recorded-containers-absent' as const, operationId: retireOperation, at: 7 };
    // The ordinary failed state still refuses issued work.
    await expect(store.dockerPhase(fx.record.id, fx.closed, { phase: 'failed' }, () => {})).rejects.toThrow();
    const moves = new PlanMoves({
      load: () => store.load(),
      save: (records) => store.save(records),
      dockerJournal: {
        record: (id: string) => store.dockerRecord(id),
        abandonAbsent: (...args: Parameters<PlanMoveStore['abandonAbsentDockerMove']>) => store.abandonAbsentDockerMove(...args),
      },
    } as unknown as PlanMovePort);
    const owner = fx.record.owner,
      employee = fx.record.employeeId;
    expect(await moves.openMoves(employee, owner)).toEqual([{ id: fx.record.id, docker: true, busy: false }]);
    expect(await moves.openMoves(employee, 'someone-else')).toEqual([{ id: fx.record.id, docker: false, busy: false }]);
    expect(await moves.abandonAbsentDockerMoves(employee, owner, abandonment, () => {})).toEqual([fx.record.id]);
    expect(await moves.openMoves(employee, owner)).toEqual([]);
    const saved = await new PlanMoveStore(store.file).dockerRecord(fx.record.id);
    expect(saved).toMatchObject({ phase: 'failed', dockerAbandonment: abandonment, dockerReplacement: fx.closed });
    // History is immutable and no longer dispatches.
    await expect(store.abandonAbsentDockerMove(fx.record.id, fx.closed, abandonment, () => {})).rejects.toThrow(
      'Terminal native plan history is immutable'
    );
    expect(() => store.dockerCurrent(fx.record.id, fx.epoch, dockerContinuationDigest(fx.state.seed))).toThrow(
      'Terminal native plan history cannot dispatch'
    );
    expect(await moves.abandonAbsentDockerMoves(employee, owner, abandonment, () => {})).toEqual([]);
  });
});
