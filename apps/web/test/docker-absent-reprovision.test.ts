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
  DockerEmployeeContinuationError,
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
import { DockerAbsentReprovision, dockerReprovisionHoldDetail } from '../src/docker-absent-reprovision.js';
import { dockerLaptopContainerProven, type DockerLaptopContainerProof } from '../src/docker-engine-command.js';
import { absentLaptopViewRefusal } from '../src/absent-laptop-view.js';
import { dockerRecoveryGuidance } from '../src/docker-recovery-guidance.js';
import {
  DockerLaptopTemplate,
  allowedReprovisionTransition,
  reprovisionHeads,
  unusedReprovisionSource,
} from '../src/docker-absent-reprovision-data.js';
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
  createOutcome: 'ok' | 'lost-reply' | 'not-sent' | 'config-rejected' | 'bind-missing' = 'ok';
  #next = 1;
  image(id: string, env: string[] = ['PATH=/opt/reverie/bin:/usr/bin', 'LANG=C.UTF-8']) {
    this.images.set(id, {
      Id: id,
      RootFS: { Layers: ['sha256:' + '1'.repeat(64)] },
      Config: { Entrypoint: null, Cmd: null, Env: env, Labels: { 'org.reverie.worker-client.manifest': manifest } },
    });
  }
  container(id: string, labels: Record<string, string>, running = false, name = '/synthetic-' + id.slice(0, 8)) {
    this.containers.set(id, {
      Id: id,
      Name: name,
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
          if (filter.startsWith('name=')) return String(row.Name).includes(filter.slice(5));
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
    // What the packaged port makes of a complete HTTP 400.
    if (this.createOutcome === 'config-rejected')
      throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED');
    if (this.createOutcome === 'bind-missing')
      throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_CREATE_BIND_SOURCE_MISSING', 409, {
        cause: { missingMountTarget: '/reverie_workspace' },
      });
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
      State: {
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        Status: 'created',
        Pid: 0,
        StartedAt: '0001-01-01T00:00:00Z',
      },
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
  readonly prepared: Array<{ name: string; spec: Json; sources: number }> = [];
  prepareOutcome: 'ok' | 'failed' = 'ok';
  /** The image's own helper; the fake records the request and the inventory it ran against. */
  async prepareWorkerStore(name: string, spec: Json, current: () => void): Promise<void> {
    current();
    const sources = [...this.containers.values()].filter((row) => String(row.Name).startsWith('/reverie-boxed-source-'));
    this.prepared.push({ name, spec: structuredClone(spec), sources: sources.length });
    if (this.prepareOutcome === 'failed') throw Error('synthetic preparation failure');
  }
  readonly seats: Array<{ name: string; spec: Json; auth: string | undefined; sources: number; containers: number }> = [];
  /** What the employee's own seat holds: no sign-in file, or one of its own. */
  seatCredential: 'absent' | 'present' = 'absent';
  seatOutcome: 'ok' | 'failed' | 'foreign' = 'ok';
  /** The fixed helper; the fake records the request and answers as the program does. */
  async prepareSeatDirectory(name: string, spec: Json, current: () => void, auth?: string) {
    current();
    const sources = [...this.containers.values()].filter((row) => String(row.Name).startsWith('/reverie-boxed-source-'));
    this.seats.push({ name, spec: structuredClone(spec), auth, sources: sources.length, containers: this.containers.size });
    if (this.seatOutcome === 'failed') throw Error('synthetic seat helper failure');
    if (this.seatOutcome === 'foreign')
      throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN');
    const credential = auth ? (this.seatCredential === 'present' ? 'refreshed' : 'installed') : this.seatCredential;
    if (auth) this.seatCredential = 'present';
    return {
      version: 1 as const,
      purpose: 'reverie-seat-directory-ready-v1' as const,
      profile: spec.profileId as string,
      provider: spec.provider as 'anthropic' | 'openai',
      created: [],
      tightened: [],
      credential: credential as 'installed' | 'refreshed' | 'present' | 'absent',
      home: { dev: '64', ino: '10' },
      seat: { dev: '64', ino: '12' },
    };
  }
  readonly tenants = new Set<string>();
  readonly discarded: string[] = [];
  /** Same guard as the packaged command: nothing beyond the container's init. */
  async removeIdleLaptop(id: string, current: () => void): Promise<void> {
    current();
    if (!this.containers.has(id)) throw Error('No such object');
    if (this.tenants.has(id)) throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_LAPTOP_NOT_REMOVABLE');
    this.discarded.push(id);
    this.containers.delete(id);
  }
  readonly stopped: string[] = [];
  readonly rebuilt: string[] = [];
  discardOutcome: 'ok' | 'failed' = 'ok';
  /** Same guard as the packaged command: the proof is re-read, then stop and remove without force. */
  async discardLaptopContainer(id: string, proof: DockerLaptopContainerProof, current: () => void): Promise<void> {
    current();
    const row = this.containers.get(id);
    if (!row || !dockerLaptopContainerProven(row as never, proof))
      throw new DockerEmployeeContinuationError('DOCKER_REBUILD_CONTAINER_NOT_REMOVABLE');
    if (this.discardOutcome === 'failed') throw Error('synthetic Engine stop failure');
    if ((row.State as Json).Running) this.stopped.push(id);
    this.rebuilt.push(id);
    this.containers.delete(id);
    // A removed container leaves every network it was attached to.
    for (const network of this.networks.values()) delete (network.Containers as Json)[id];
  }
  readonly removed: string[] = [];
  removeOutcome: 'ok' | 'lost-reply' | 'not-sent' = 'ok';
  /** Same guard as the packaged command: the named, never-started source only. */
  async removeCreatedSource(name: string, id: string, current: () => void): Promise<void> {
    current();
    const row = this.containers.get(id),
      state = row?.State as Json | undefined;
    if (!/^reverie-boxed-source-[a-f0-9]{64}$/.test(name) || row?.Name !== '/' + name || state?.Status !== 'created')
      throw Error('synthetic removal refused');
    this.removed.push(id);
    if (this.removeOutcome === 'not-sent') throw Error('synthetic removal transport failure');
    this.containers.delete(id);
    if (this.removeOutcome === 'lost-reply') throw Error('synthetic lost removal reply');
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
  /** The employee's current subscription profile ID and saved launch overrides. */
  profile?: string;
  /** The profile's provider and the saved session's mode; a Claude seat by default. */
  provider?: 'anthropic' | 'openai';
  mode?: string;
  overrides?: Record<string, string>;
  moves?: {
    openMoves: unknown;
    abandonAbsentDockerMoves: unknown;
    ownerAbandonedContainers?: unknown;
    replacedSourceRecords?: unknown;
  } | null;
  /** Whether the state service can forget the viewer of a removed laptop. */
  discardView?: boolean;
  /** Whether the office's own copy of the employee's plan account is signed in. */
  office?: 'signed-in' | 'signed-out';
}
/** Synthetic text standing in for the office's signed-in copy of a plan account. */
const officeSignIn = JSON.stringify({ claudeAiOauth: { accessToken: 'SYNTHETIC_OFFICE_SIGN_IN' } });
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
        runtimeRecipe: {
          mode: options.mode ?? 'claude',
          workingDir: '/reverie_workspace/cases/demo',
          ...(options.profile
            ? {
                subscriptionProfile: {
                  id: options.profile,
                  label: 'Synthetic seat',
                  provider: options.provider ?? 'anthropic',
                },
              }
            : {}),
        },
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
    mode: options.mode ?? 'claude',
    workingDir: '/reverie_workspace/cases/demo',
    status: 'idle',
    pid: 4242,
    ...conversation,
    ...(options.overrides ? { __envOverrides: options.overrides } : {}),
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
    live: { inert: boolean; container?: string } | undefined;
  // A launch this office process made and still holds in memory: none, the live viewer's own, or another one.
  const viewerLaunch = {
    owner: 'none' as 'none' | 'viewer' | 'foreign',
    fail: undefined as undefined | 'stop' | 'layout',
  };
  const discarded: string[] = [],
    forgotten: string[] = [];
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
  // The office's plan account service: unbound, as before it existed, unless a test says otherwise.
  const officePlans = {
    state: options.office ?? ('unbound' as 'unbound' | 'signed-in' | 'signed-out'),
    asked: [] as Array<{ profileId: string; provider: string }>,
    held: 0,
  };
  const service = new DockerAbsentReprovision(
    company,
    store,
    engine,
    { deployment, boxId, apiUrl: 'http://synthetic-office:3000', workerImageId: workerImage, sourceImageIds: [legacyImage] },
    {
      saved: (id) => state.getSession(id) ?? undefined,
      live: () => live,
      // The state store's rule: a live launch blocks unless it is the launch of the very viewer a rebuild discards.
      blocked: (id, owner, discardingViewer) =>
        state.dockerAbsentReprovisionBlocker(id, owner) ??
        (viewerLaunch.owner === 'foreign' ||
        (viewerLaunch.owner === 'viewer' && !(discardingViewer && live?.container !== undefined))
          ? 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN'
          : undefined),
      viewerLaunchOwned: () => viewerLaunch.owner === 'viewer' && live?.container !== undefined,
      overrides: async (id) =>
        (state.getSession(id) as { __envOverrides?: Record<string, string> } | null)?.__envOverrides,
      discard: async (id) => {
        // The real guarded discard refuses a boxed viewer and a live pane.
        if (live?.container !== undefined || live?.inert === false) throw Error('synthetic stop authority unavailable');
        discarded.push(id);
        live = undefined;
      },
      ...(options.discardView === false
        ? {}
        : {
            // Same admission as the server: only once the viewer's own container is positively absent.
            discardView: async (id: string, absent: (containerId: string) => Promise<boolean>) => {
              if (!live?.container || !(await absent(live.container))) throw Error('synthetic laptop still exists');
              // The server stops the viewer first (which can fail), then releases its launch and
              // forgets it in one step, then publishes the tab layout (which can also fail).
              if (viewerLaunch.fail === 'stop') {
                viewerLaunch.fail = undefined;
                throw Error('synthetic viewer stop failure');
              }
              if (viewerLaunch.owner === 'foreign') throw Error('synthetic foreign launch');
              viewerLaunch.owner = 'none';
              forgotten.push(id);
              live = undefined;
              if (viewerLaunch.fail === 'layout') {
                viewerLaunch.fail = undefined;
                throw Error('synthetic layout publication failure');
              }
            },
          }),
      clear: (proof) => state.commitDockerAbsentReprovision(proof),
    },
    () => moves as never,
    () => busy,
    () => {},
    () => 1234,
    () =>
      officePlans.state === 'unbound'
        ? undefined
        : {
            capture: async (profileId: string, provider: 'anthropic' | 'openai', current: () => void) => {
              current();
              officePlans.asked.push({ profileId, provider });
              if (officePlans.state === 'signed-out') return undefined;
              officePlans.held += 1;
              return { authText: () => officeSignIn, close: () => void (officePlans.held -= 1) };
            },
          }
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
    conversation, request, discarded, forgotten, officePlans,
    setLive: (value: { inert: boolean; container?: string } | undefined) => { live = value; },
    viewerLaunch,
    setBusy: (value: boolean) => { busy = value; },
    revoke: () => { authorized = false; },
    snapshot: () => companyStore.snapshot(),
    entry: () => companyStore.snapshot().retiredDockerEmployeeContinuations?.[0],
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** The existing continuation over the REAL Engine adapter for source reads. */
const continuations = new WeakMap<Fixture, ReturnType<typeof newContinuation>>();
function continuation(f: Fixture) {
  if (!continuations.has(f)) continuations.set(f, newContinuation(f));
  return continuations.get(f)!;
}
function newContinuation(f: Fixture, sourceImageIds: string[] = [legacyImage]) {
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
    { imageId: workerImage, clientManifestDigest: manifest, sourceImageIds },
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
async function beginsAgain(f: Fixture, sourceContainerId: string, nextOperation = '77777777-7777-4777-8777-777777777777') {
  const { service, effects } = continuation(f);
  effects.length = 0;
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
      nixSource: `/synthetic-state/nix`,
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
    if (_name.startsWith('the recorded')) {
      // A recorded container is offered for discard; the stale confirmation still changes nothing.
      expect(preview).toMatchObject({ allowedActions: ['reprovision'], discard: preview.present });
      await expect(f.service.reprovision(employeeId, input, f.authority)).rejects.toMatchObject({
        code: 'DOCKER_REPROVISION_SCOPE_CHANGED',
      });
      expect(f.engine.discarded).toEqual([]);
    } else {
      expect(preview).toMatchObject({ allowedActions: [], code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT' });
      await expect(f.service.reprovision(employeeId, input, f.authority)).rejects.toMatchObject({
        code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT',
      });
      await expect(
        f.service.reprovision(employeeId, { ...input, expectedScopeDigest: preview.scopeDigest }, f.authority)
      ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT' });
    }
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
            bind(`/synthetic-state/nix`, '/nix'),
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
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_SCOPE_CHANGED' });
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

const seat = 'anthropic-26494e93';
const seatPath = '/instances/default/console/accounts/' + seat;
const seatFixture = (options: Options = {}) =>
  fixture({ profile: seat, overrides: { CLAUDE_CONFIG_DIR: seatPath, CLAUDE_CODE_EFFORT: 'high' }, ...options });
const mountsOf = (f: Fixture, index = 0) =>
  ((f.engine.created[index]!.configuration.HostConfig as Json).Mounts as Json[]).filter((mount) =>
    String(mount.Target).startsWith('/instances/default/console/accounts')
  );
const envOf = (f: Fixture, index = 0) =>
  (f.engine.created[index]!.configuration.Env as string[]).filter((value) => /^(CLAUDE_CONFIG_DIR|CODEX_HOME)=/.test(value));

describe('provider account routing', () => {
  it('mounts the employee seat that the saved launch override selects', async () => {
    const f = await seatFixture();
    const account = {
      kind: 'seat-mount',
      key: 'CLAUDE_CONFIG_DIR',
      path: seatPath,
      source: `${homeSource}/.reverie/seat-auth/${seat}`,
    };
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview.account).toEqual(account);
    const result = await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(result.state).toBe('ready');
    expect(f.entry()!.account).toEqual(account);
    // One read-write bind at the exact path; the launch supplies the variable.
    expect(mountsOf(f)).toEqual([
      { Type: 'bind', Source: account.source, Target: seatPath, BindOptions: { Propagation: 'rprivate' } },
    ]);
    expect(envOf(f)).toEqual([]);
    // The destination builder keeps it and the capsule guard admits it.
    const raw = DockerEmployeeInspect.parse(f.engine.containers.get(result.sourceContainerId!));
    expect(boxedMountConfiguration(raw)).toContainEqual({
      Type: 'bind',
      Source: account.source,
      Target: seatPath,
      BindOptions: { Propagation: 'rprivate' },
    });
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('routes a codex seat and an explicitly supplied seat directory', async () => {
    const id = 'openai-ed0348c4',
      path = '/instances/default/console/accounts/' + id;
    const f = await fixture({ profile: id, overrides: { CODEX_HOME: path } });
    expect((await f.service.preview(employeeId, template, f.authority)).account).toEqual({
      kind: 'seat-mount',
      key: 'CODEX_HOME',
      path,
      source: `${homeSource}/.reverie/seat-auth/${id}`,
    });
    const explicit = { ...template, accountSource: '/synthetic-seats/' + id };
    const preview = await f.service.preview(employeeId, explicit, f.authority);
    expect(preview.account).toMatchObject({ kind: 'seat-mount', source: '/synthetic-seats/' + id });
    expect(preview.scopeDigest).not.toBe((await f.service.preview(employeeId, template, f.authority)).scopeDigest);
    await f.service.reprovision(employeeId, await f.request(retireOperation, explicit), f.authority);
    expect(mountsOf(f)).toEqual([
      { Type: 'bind', Source: '/synthetic-seats/' + id, Target: path, BindOptions: { Propagation: 'rprivate' } },
    ]);
  });
  it.each([
    ['another profile', { profile: 'anthropic-00000000', overrides: { CLAUDE_CONFIG_DIR: seatPath } }, template],
    ['no current profile', { overrides: { CLAUDE_CONFIG_DIR: seatPath } }, template],
    [
      'a nested account path',
      { profile: seat, overrides: { CLAUDE_CONFIG_DIR: seatPath + '/inner' } },
      template,
    ],
    [
      'two seat overrides',
      { profile: seat, overrides: { CLAUDE_CONFIG_DIR: seatPath, CODEX_HOME: seatPath } },
      template,
    ],
  ])('refuses a seat override for %s', async (_name, options, body) => {
    const f = await fixture(options as Options);
    await expect(f.service.preview(employeeId, body, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_ACCOUNT_PROFILE_MISMATCH',
    });
  });
  it('refuses a seat directory with another name, inside scratch, or with nothing to route', async () => {
    const f = await seatFixture();
    await expect(
      f.service.preview(employeeId, { ...template, accountSource: '/synthetic-seats/other' }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_ACCOUNT_SOURCE_MISMATCH' });
    await expect(
      f.service.preview(employeeId, { ...template, accountSource: '/synthetic-scratch/laptops/' + seat }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_TEMPLATE_STORAGE_OVERLAP' });
    const none = await fixture();
    await expect(
      none.service.preview(employeeId, { ...template, accountSource: '/synthetic-seats/' + seat }, none.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_ACCOUNT_SOURCE_UNUSED' });
    // The accounts root is never template data.
    for (const destination of [seatPath, '/instances/default/console/accounts'])
      expect(
        DockerLaptopTemplate.safeParse({
          ...template,
          mounts: [...template.mounts, { source: '/synthetic-seats/' + seat, destination, readOnly: false }],
        }).success
      ).toBe(false);
    expect(DockerLaptopTemplate.safeParse({ ...template, accountSource: 'relative/' + seat }).success).toBe(false);
  });
  it('derives the seat from the subscription profile when no launch override names one', async () => {
    // The profile is set but the saved session carries no account override.
    const f = await fixture({ profile: seat, overrides: { CLAUDE_CODE_EFFORT: 'high' } });
    const account = {
      kind: 'seat-mount',
      key: 'CLAUDE_CONFIG_DIR',
      path: seatPath,
      source: `${homeSource}/.reverie/seat-auth/${seat}`,
      env: true,
    };
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview.account).toEqual(account);
    const result = await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(result.state).toBe('ready');
    expect(f.entry()!.account).toEqual(account);
    expect(mountsOf(f)).toEqual([
      { Type: 'bind', Source: account.source, Target: seatPath, BindOptions: { Propagation: 'rprivate' } },
    ]);
    // Nothing in the launch supplies the variable, so the laptop itself carries it.
    expect(envOf(f)).toEqual(['CLAUDE_CONFIG_DIR=' + seatPath]);
    expect(f.state.getSession(sid)).not.toHaveProperty('__envOverrides.CLAUDE_CONFIG_DIR');
    // The ordinary continuation accepts the source and copies its environment.
    await beginsAgain(f, result.sourceContainerId!);
    // A later replacement of the unused source derives the same seat again.
    const bare = await fixture({ profile: seat });
    expect((await bare.service.preview(employeeId, template, bare.authority)).account).toEqual(account);
  });
  it('derives a Codex seat and honours an explicitly supplied seat directory', async () => {
    const id = 'openai-ed0348c4',
      path = '/instances/default/console/accounts/' + id;
    const f = await fixture({ profile: id, provider: 'openai', mode: 'codex' });
    expect((await f.service.preview(employeeId, template, f.authority)).account).toEqual({
      kind: 'seat-mount',
      key: 'CODEX_HOME',
      path,
      source: `${homeSource}/.reverie/seat-auth/${id}`,
      env: true,
    });
    const explicit = { ...template, accountSource: '/synthetic-seats/' + id };
    await f.service.reprovision(employeeId, await f.request(retireOperation, explicit), f.authority);
    expect(mountsOf(f)).toEqual([
      { Type: 'bind', Source: '/synthetic-seats/' + id, Target: path, BindOptions: { Propagation: 'rprivate' } },
    ]);
    expect(envOf(f)).toEqual(['CODEX_HOME=' + path]);
  });
  it.each([
    ['a Claude plan on a Codex session', { profile: seat, provider: 'anthropic', mode: 'codex' }],
    ['a Codex plan on a Claude session', { profile: 'openai-ed0348c4', provider: 'openai', mode: 'claude' }],
    ['a Codex plan that OpenCode only proxies', { profile: 'openai-ed0348c4', provider: 'openai', mode: 'opencode' }],
    ['a shell session', { profile: seat, provider: 'anthropic', mode: 'shell' }],
  ])('derives nothing for %s', async (_name, options) => {
    const f = await fixture(options as Options);
    expect((await f.service.preview(employeeId, template, f.authority)).account).toEqual({ kind: 'none' });
  });
  it('still refuses a launch override that disagrees with the profile', async () => {
    // The override wins the derivation and must name the profile's own seat.
    const f = await fixture({ profile: 'anthropic-00000000', overrides: { CLAUDE_CONFIG_DIR: seatPath } });
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_ACCOUNT_PROFILE_MISMATCH',
    });
    // A seat override for the other provider's variable is not replaced by a derived one.
    const crossed = await fixture({ profile: seat, overrides: { CODEX_HOME: seatPath + '-other' } });
    await expect(crossed.service.preview(employeeId, template, crossed.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_ACCOUNT_PROFILE_MISMATCH',
    });
  });
  it('adds nothing when the launch override names a directory that is not a seat', async () => {
    const f = await fixture({ profile: seat, overrides: { CLAUDE_CONFIG_DIR: '/home/agent/.claude-alternate' } });
    expect((await f.service.preview(employeeId, template, f.authority)).account).toEqual({ kind: 'none' });
    await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(mountsOf(f)).toEqual([]);
    expect(envOf(f)).toEqual([]);
    expect(f.entry()!.account).toEqual({ kind: 'none' });
  });
  it('keeps a retired plan replacement on its in-home account generation', async () => {
    const f = await fixture({ row: v3Row() });
    const account = {
      kind: 'generation-env',
      key: 'CLAUDE_CONFIG_DIR',
      path: `/home/agent/.reverie/plan-moves/${priorOperation}/generation-${'1'.repeat(64)}/claude`,
    };
    expect((await f.service.preview(employeeId, template, f.authority)).account).toEqual(account);
    await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(envOf(f)).toEqual(['CLAUDE_CONFIG_DIR=' + account.path]);
    expect(mountsOf(f)).toEqual([]);
    expect(f.entry()!.account).toEqual(account);
    const codex = v3Row();
    const row = DockerEmployeeContinuationRecord.parse({
      ...codex,
      planReplacement: { ...(codex as { planReplacement: Json }).planReplacement, account: { id: 'synthetic-account', provider: 'openai', projectionDigest: '1'.repeat(64), contextDigest: '2'.repeat(64) } },
    });
    const openai = await fixture({ row });
    expect((await openai.service.preview(employeeId, template, openai.authority)).account).toEqual({
      kind: 'generation-env',
      key: 'CODEX_HOME',
      path: `/home/agent/.reverie/plan-moves/${priorOperation}/generation-${'1'.repeat(64)}/codex`,
    });
  });
});

const replaceOperation = '88888888-8888-4888-8888-888888888888';
const thirdOperation = '99999999-9999-4999-8999-999999999999';
/** An employee already reprovisioned by the first release: a source without routing. */
async function reprovisioned(options: Options = {}) {
  const f = await fixture(options);
  // Entries written before routing existed carry no account field.
  const body = await f.request();
  const first = await f.service.reprovision(employeeId, body, f.authority);
  await f.companyStore.update((state) => {
    delete state.retiredDockerEmployeeContinuations![0]!.account;
  });
  const replace = async (operationId = replaceOperation, bodyTemplate: Record<string, unknown> = template) => ({
    operationId,
    sessionId: sid,
    sessionGeneration: 9,
    expectedScopeDigest: (await f.service.preview(employeeId, bodyTemplate, f.authority)).scopeDigest,
    template: bodyTemplate,
  });
  return { f, first, replace, entries: () => f.snapshot().retiredDockerEmployeeContinuations! };
}

describe('replace an unused source', () => {
  it('removes the never-started source and creates a routed one under a new operation', async () => {
    const { f, first, replace, entries } = await reprovisioned({
      profile: seat,
      overrides: { CLAUDE_CONFIG_DIR: seatPath },
    });
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      mode: 'replace-source',
      reason: 'source-replaced',
      record: null,
      previous: { operationId: retireOperation, sourceContainerId: first.sourceContainerId },
      absent: [],
      present: [],
      helpers: [],
      account: { kind: 'seat-mount', path: seatPath },
      allowedActions: ['reprovision'],
    });
    const body = await replace();
    const result = await f.service.reprovision(employeeId, body, f.authority);
    expect(result).toEqual({
      operationId: replaceOperation,
      state: 'ready',
      sourceContainerId: '2'.repeat(64),
      sourceImageId: workerImage,
    });
    expect(f.engine.removed).toEqual([first.sourceContainerId]);
    expect(f.engine.containers.has(first.sourceContainerId!)).toBe(false);
    expect(entries()).toHaveLength(2);
    expect(entries()[0]).toMatchObject({ operationId: retireOperation, source: { phase: 'created' } });
    expect(entries()[1]).toMatchObject({
      operationId: replaceOperation,
      reason: 'source-replaced',
      previous: retireOperation,
      absent: { containerIds: [], planMoveIds: [] },
      account: { kind: 'seat-mount', path: seatPath },
      removal: { phase: 'removed', name: reprovisionSourceName(boxId, retireOperation), containerId: first.sourceContainerId },
      binding: null,
      session: { phase: 'cleared', containerName: null },
      source: { phase: 'created', name: reprovisionSourceName(boxId, replaceOperation), containerId: '2'.repeat(64) },
    });
    expect(entries()[1]!.record).toBeUndefined();
    expect(f.engine.created[1]!.configuration.Labels).toMatchObject({
      'reverie.reprovision.operation': replaceOperation,
      'reverie.session': sid,
    });
    expect(mountsOf(f, 1)).toHaveLength(1);
    // Replay returns the recorded result; the ordinary flow then accepts the new source.
    f.engine.failLists = true;
    expect(await f.service.reprovision(employeeId, body, f.authority)).toEqual(result);
    f.engine.failLists = false;
    await beginsAgain(f, '2'.repeat(64));
  });
  it('replaces again from the newest entry and keeps the plan replacement basis', async () => {
    const { f, replace, entries } = await reprovisioned({ row: v3Row() });
    await f.service.reprovision(employeeId, await replace(), f.authority);
    const result = await f.service.reprovision(employeeId, await replace(thirdOperation), f.authority);
    expect(result).toMatchObject({ state: 'ready', sourceContainerId: '3'.repeat(64) });
    expect(entries().map((entry) => [entry.reason, entry.previous])).toEqual([
      ['recorded-containers-absent', undefined],
      ['source-replaced', retireOperation],
      ['source-replaced', replaceOperation],
    ]);
    expect(envOf(f, 2)).toEqual([
      `CLAUDE_CONFIG_DIR=/home/agent/.reverie/plan-moves/${priorOperation}/generation-${'1'.repeat(64)}/claude`,
    ]);
    expect([...f.engine.containers.keys()].filter((id) => /^[123]{64}$/.test(id))).toEqual(['3'.repeat(64)]);
  });
  it.each([
    ['running', { Running: true, Status: 'running', Pid: 4242, StartedAt: '2026-11-21T00:00:00Z' }],
    ['exited after a start', { Running: false, Status: 'exited', Pid: 0, StartedAt: '2026-11-21T00:00:00Z' }],
    ['created with a start time', { Running: false, Status: 'created', Pid: 0, StartedAt: '2026-11-21T00:00:00Z' }],
  ])('refuses a source that is %s', async (_name, state) => {
    const { f, first, replace } = await reprovisioned();
    const body = await replace();
    Object.assign(f.engine.containers.get(first.sourceContainerId!)!.State as Json, state);
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SOURCE_STARTED',
    });
    await expect(f.service.reprovision(employeeId, body, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SOURCE_STARTED',
    });
    expect(f.engine.removed).toEqual([]);
    expect(f.snapshot().retiredDockerEmployeeContinuations).toHaveLength(1);
  });
  it('refuses a changed, missing or accompanied source and a foreign storage holder', async () => {
    const changed = await reprovisioned();
    ((changed.f.engine.containers.get('1'.repeat(64))!.Config as Json).Labels as Json)['reverie.reprovision.operation'] =
      thirdOperation;
    await expect(changed.f.service.preview(employeeId, template, changed.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SOURCE_CHANGED',
    });
    const missing = await reprovisioned();
    missing.f.engine.containers.delete('1'.repeat(64));
    await expect(missing.f.service.preview(employeeId, template, missing.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SOURCE_ABSENT',
    });
    const extra = await reprovisioned();
    const body = await extra.replace();
    extra.f.engine.container('4'.repeat(64), { 'reverie.boxed.employee': employeeId, 'reverie.boxed.instance': deployment });
    expect(await extra.f.service.preview(employeeId, template, extra.f.authority)).toMatchObject({
      present: ['4'.repeat(64)],
      allowedActions: [],
    });
    await expect(extra.f.service.reprovision(employeeId, body, extra.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT',
    });
    expect(extra.f.engine.removed).toEqual([]);
    const holder = await reprovisioned();
    holder.f.engine.container('5'.repeat(64), {
      'reverie.box.storage.employee': employeeId,
      'reverie.box.storage.box': boxId,
    });
    await expect(holder.f.service.preview(employeeId, template, holder.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_HELPER_FOREIGN',
    });
  });
  it('observes a removal whose reply was lost', async () => {
    const { f, replace, entries } = await reprovisioned();
    const body = await replace();
    f.engine.removeOutcome = 'lost-reply';
    expect(await f.service.reprovision(employeeId, body, f.authority)).toEqual({
      operationId: replaceOperation,
      state: 'held',
      code: 'DOCKER_REPROVISION_EFFECT_UNCONFIRMED',
    });
    expect(entries()[1]).toMatchObject({ removal: { phase: 'issued' }, source: { phase: 'pending' } });
    f.engine.removeOutcome = 'ok';
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({
      state: 'ready',
      sourceContainerId: '2'.repeat(64),
    });
    expect(f.engine.removed).toHaveLength(1);
    expect(f.engine.created).toHaveLength(2);
  });
  it('re-issues a removal only while the Engine still lists the unused source', async () => {
    const { f, replace, entries } = await reprovisioned();
    const body = await replace();
    f.engine.removeOutcome = 'not-sent';
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({ state: 'held' });
    f.engine.failLists = true;
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({
      state: 'held',
      code: 'DOCKER_REPROVISION_ABSENCE_UNCONFIRMED',
    });
    expect(f.engine.removed).toHaveLength(1);
    f.engine.failLists = false;
    // Started in the meantime: never removed, the operation stays held.
    Object.assign(f.engine.containers.get('1'.repeat(64))!.State as Json, { Status: 'exited', StartedAt: '2026-11-21T00:00:00Z' });
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({
      state: 'held',
      code: 'DOCKER_REPROVISION_SOURCE_STARTED',
    });
    expect(f.engine.removed).toHaveLength(1);
    Object.assign(f.engine.containers.get('1'.repeat(64))!.State as Json, { Status: 'created', StartedAt: '0001-01-01T00:00:00Z' });
    f.engine.removeOutcome = 'ok';
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({ state: 'ready' });
    expect(f.engine.removed).toHaveLength(2);
    expect(entries()[1]).toMatchObject({ removal: { phase: 'removed' }, source: { phase: 'created' } });
  });
  it('observes a create whose reply was lost after the removal', async () => {
    const { f, replace } = await reprovisioned();
    const body = await replace();
    f.engine.createOutcome = 'lost-reply';
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({ state: 'held' });
    f.engine.createOutcome = 'ok';
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({
      state: 'ready',
      sourceContainerId: '2'.repeat(64),
    });
    expect(f.engine.created).toHaveLength(2);
    expect(f.engine.removed).toHaveLength(1);
    await beginsAgain(f, '2'.repeat(64));
  });
  it('requires an unfinished earlier operation to be resumed first', async () => {
    const f = await fixture();
    const body = await f.request();
    f.engine.createOutcome = 'not-sent';
    await f.service.reprovision(employeeId, body, f.authority);
    f.engine.createOutcome = 'ok';
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_RECORD_REQUIRED',
    });
    expect(await f.service.reprovision(employeeId, body, f.authority)).toMatchObject({ state: 'ready' });
  });
});

describe('a continuation that never requested its destination', () => {
  /** A fresh version 2 record parked at pool-issued on a source without routing. */
  async function parked(options: Options = { row: v3Row() }) {
    const r = await reprovisioned(options);
    await beginsAgain(r.f, r.first.sourceContainerId!);
    const row = r.f.store.record(employeeId)!;
    const holder = {
      role: 'storage-holder',
      name: 'reverie-boxed-storage-' + 'a'.repeat(64),
      imageId: helperImage,
      configurationDigest: 'b'.repeat(64),
      phase: 'running',
      containerId: '6'.repeat(64),
      initPid: 42,
      initStartTicks: '1234',
    };
    await r.f.companyStore.update((state) => {
      state.dockerEmployeeContinuations![0] = DockerEmployeeContinuationRecord.parse({ ...row, tasks: [holder] });
    });
    r.f.engine.container('6'.repeat(64), {
      'reverie.box.storage.employee': employeeId,
      'reverie.box.storage.box': boxId,
      'reverie.box.storage.operation': row.request.operationId,
    }, true);
    return { ...r, row: r.f.store.record(employeeId)! };
  }
  it('supersedes the record, replaces its source and leaves its helpers in place', async () => {
    const { f, first, replace, entries, row } = await parked();
    expect(row).toMatchObject({ version: 2, phase: 'pool-issued', original: { containerId: first.sourceContainerId } });
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      mode: 'retire',
      reason: 'source-superseded',
      record: { version: 2, phase: 'pool-issued', operationId: nextOperation },
      previous: { operationId: retireOperation, sourceContainerId: first.sourceContainerId },
      present: [],
      helpers: ['6'.repeat(64)],
      account: { kind: 'generation-env', key: 'CLAUDE_CONFIG_DIR' },
    });
    const result = await f.service.reprovision(employeeId, await replace(), f.authority);
    expect(result).toMatchObject({ state: 'ready', sourceContainerId: '2'.repeat(64) });
    expect(f.store.record(employeeId)).toBeUndefined();
    expect(f.snapshot().employees[0]!.dockerBinding).toBeUndefined();
    expect(entries()[1]).toMatchObject({
      reason: 'source-superseded',
      previous: retireOperation,
      record: row,
      removal: { phase: 'removed', containerId: first.sourceContainerId },
      source: { phase: 'created' },
    });
    // The routing still derives from the original plan replacement, not the superseded row.
    expect(envOf(f, 1)).toEqual([
      `CLAUDE_CONFIG_DIR=/home/agent/.reverie/plan-moves/${priorOperation}/generation-${'1'.repeat(64)}/claude`,
    ]);
    // The storage holder is left running; no other container was removed.
    expect(f.engine.removed).toEqual([first.sourceContainerId]);
    expect(f.engine.containers.has('6'.repeat(64))).toBe(true);
    await beginsAgain(f, '2'.repeat(64), thirdOperation);
    // A later replacement still accounts for the retired record's holder.
    expect(f.store.record(employeeId)).toMatchObject({ request: { operationId: thirdOperation } });
  });
  it.each(['destination-issued', 'destination-ready', 'identity-ready', 'ready'] as const)(
    'refuses a record at %s',
    async (phase) => {
      const { f, row } = await parked();
      await f.companyStore.update((state) => {
        state.dockerEmployeeContinuations![0] = DockerEmployeeContinuationRecord.parse({
          ...row,
          phase,
          pool: { containerId: '9'.repeat(64), cgroupParent: 'synthetic.slice', policyDigest: dockerContinuationDigest(policy.pool), physicalDigest: 'f'.repeat(64) },
          ...(phase === 'destination-issued' ? {} : { destination: { ...row.original, containerId: destinationCid } }),
        });
      });
      // A record with a destination is retired as a whole, and only once its
      // recorded containers are gone; the surviving source offers no action.
      // An issued CREATE with no labelled container may be superseded like an unrequested one.
      if (phase === 'destination-issued')
        await expect(f.service.preview(employeeId, template, f.authority)).resolves.toMatchObject({
          mode: 'retire',
          reason: 'source-superseded',
          present: [],
          allowedActions: ['reprovision'],
        });
      // The preview offers to discard the recorded containers, and changes nothing.
      else
        await expect(f.service.preview(employeeId, template, f.authority)).resolves.toMatchObject({
          mode: 'retire',
          reason: 'recorded-containers-absent',
          allowedActions: ['reprovision'],
        });
      expect(f.engine.removed).toEqual([]);
      expect(f.engine.discarded).toEqual([]);
    }
  );
  it('refuses a foreign container, a foreign holder, a later helper and a busy continuation', async () => {
    const foreign = await parked();
    const body = await foreign.replace();
    foreign.f.engine.container('4'.repeat(64), { 'reverie.employee': employeeId, 'reverie.worker': deployment });
    await expect(foreign.f.service.reprovision(employeeId, body, foreign.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT',
    });
    expect(foreign.f.store.record(employeeId)).toEqual(foreign.row);
    const holder = await parked();
    holder.f.engine.container('5'.repeat(64), { 'reverie.box.storage.employee': employeeId, 'reverie.box.storage.box': boxId });
    await expect(holder.f.service.preview(employeeId, template, holder.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_HELPER_FOREIGN',
    });
    const helper = await parked();
    await helper.f.companyStore.update((state) => {
      const current = state.dockerEmployeeContinuations![0]!;
      state.dockerEmployeeContinuations![0] = DockerEmployeeContinuationRecord.parse({
        ...current,
        tasks: [...current.tasks!, { ...current.tasks![0], role: 'leaf-helper', name: 'reverie-boxed-leaf-helper-x' }],
      });
    });
    await expect(helper.f.service.preview(employeeId, template, helper.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_CONTINUATION_ADVANCED',
    });
    const busy = await parked();
    busy.f.setBusy(true);
    await expect(busy.f.service.preview(employeeId, template, busy.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_BUSY',
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
    // An issued intent is fixed. Only the workflow's own re-issue may give it another configuration, and nothing else.
    const other = { ...issued, source: { ...issued.source, configurationDigest: '7'.repeat(64) } };
    expect(allowedReprovisionTransition(issued as never, other as never)).toBe(false);
    expect(allowedReprovisionTransition(issued as never, other as never, true)).toBe(true);
    expect(
      allowedReprovisionTransition(issued as never, { ...other, source: { ...other.source, imageId: 'sha256:' + '6'.repeat(64) } } as never, true)
    ).toBe(false);
    expect(allowedReprovisionTransition(issued as never, { ...other, retiredAt: 5 } as never, true)).toBe(false);
    expect(
      allowedReprovisionTransition(done, { ...done, source: { ...done.source, configurationDigest: '7'.repeat(64) } } as never, true)
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
  it('names the laptop record a finished move replaced, and nothing while the move is open', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'absent-move-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const fx = dockerPlanJournalFixture(),
      store = new PlanMoveStore(join(directory, 'moves.json'));
    await store.save([fx.record]);
    await store.dockerPublish(fx.record.id, fx.state, fx.closed, () => {});
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
    // An open move may still need the laptop it started from.
    expect(await moves.replacedSourceRecords(employee, owner)).toEqual([]);
    const abandonment = { version: 1 as const, reason: 'recorded-containers-absent' as const, operationId: retireOperation, at: 7 };
    await moves.abandonAbsentDockerMoves(employee, owner, abandonment, () => {});
    const listed = await moves.replacedSourceRecords(employee, owner);
    expect(listed).toEqual([{ moveId: fx.record.id, record: fx.state.seed.source.record }]);
    // The digest a plan replacement records for the record it replaced is the digest of exactly this copy.
    expect(dockerContinuationDigest(listed[0]!.record)).toBe(fx.work.planReplacement.source.continuationDigest);
    expect(await moves.replacedSourceRecords(employee, 'someone-else')).toEqual([]);
    expect(await moves.replacedSourceRecords(employeeId, owner)).toEqual([]);
  });
});

describe('worker store preparation', () => {
  it('imports the worker image into the private store before the source exists', async () => {
    const f = await fixture();
    f.setLive({ inert: true });
    await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(f.engine.prepared).toEqual([
      {
        name: 'reverie-boxed-nix-prepare-' + retireOperation.replaceAll('-', ''),
        spec: { imageId: workerImage, user: template.user, nixSource: f.engine.prepared[0]!.spec.nixSource },
        sources: 0,
      },
    ]);
    expect(String(f.engine.prepared[0]!.spec.nixSource)).toMatch(/\/nix$/);
    expect(f.engine.created).toHaveLength(1);
  });
  it('creates no source after an unconfirmed preparation and repeats it on the same operation', async () => {
    const f = await fixture();
    f.setLive({ inert: true });
    const request = await f.request();
    f.engine.prepareOutcome = 'failed';
    await expect(f.service.reprovision(employeeId, request, f.authority)).resolves.toMatchObject({
      state: 'held',
      code: 'DOCKER_REPROVISION_STORE_PREPARATION_UNCONFIRMED',
    });
    expect(f.engine.created).toHaveLength(0);
    expect(f.entry()).toMatchObject({ source: { phase: 'issued' } });
    f.engine.prepareOutcome = 'ok';
    await expect(f.service.reprovision(employeeId, request, f.authority)).resolves.toMatchObject({ state: 'ready' });
    expect(f.engine.prepared).toHaveLength(2);
    expect(f.engine.created).toHaveLength(1);
  });
});
describe('a laptop whose provider never started', () => {
  const issued = () => DockerEmployeeContinuationRecord.parse({ ...v2Row('ready'), phase: 'provider-issued' });
  const present = (f: Fixture, running = true) => {
    f.engine.container(originalCid, {});
    f.engine.container(destinationCid, {}, running);
  };
  it('discards the idle recorded containers and reprovisions', async () => {
    const f = await fixture({ row: issued() });
    present(f);
    f.setLive({ inert: true });
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      mode: 'retire',
      present: [destinationCid, originalCid].sort(),
      discard: [destinationCid, originalCid].sort(),
      allowedActions: ['reprovision'],
    });
    expect(preview).not.toHaveProperty('code');
    const result = await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(result).toMatchObject({ state: 'ready' });
    expect(f.engine.discarded.sort()).toEqual([destinationCid, originalCid].sort());
    expect(f.engine.prepared).toHaveLength(1);
    expect(f.snapshot().dockerEmployeeContinuations).toEqual([]);
  });
  it('retires a record begun from an earlier reprovisioned source and keeps one history', async () => {
    const f = await fixture();
    f.setLive({ inert: true });
    const first = await f.service.reprovision(employeeId, await f.request(), f.authority);
    const source = first.sourceContainerId!;
    const next = '77777777-7777-4777-8777-777777777777';
    const row = DockerEmployeeContinuationRecord.parse({
      ...v2Row('ready'),
      phase: 'provider-issued',
      request: { ...v2Row('ready').request, operationId: next, containerId: source, imageId: workerImage },
      original: { ...original(source), imageId: workerImage },
      workerImage: { imageId: workerImage, sourceImageId: workerImage, clientManifestDigest: manifest },
    });
    await f.companyStore.update((state) => {
      state.dockerEmployeeContinuations = [structuredClone(row)];
      state.employees[0]!.dockerBinding = {
        ...f.binding,
        operationId: next,
        originalDigest: dockerContinuationDigest(row.destination),
      };
    });
    f.engine.container(destinationCid, {}, true);
    // The running laptop is still attached to the employee's office bridge.
    const bridge = f.engine.networks.get('b'.repeat(64))!;
    (bridge.Containers as Json)[destinationCid] = { Name: 'synthetic-laptop' };
    const removeIdle = f.engine.removeIdleLaptop.bind(f.engine);
    f.engine.removeIdleLaptop = async (id, current) => {
      await removeIdle(id, current);
      delete (bridge.Containers as Json)[id];
    };
    const again = '88888888-8888-4888-8888-888888888888';
    const preview = await f.service.preview(employeeId, template, f.authority);
    expect(preview).toMatchObject({ mode: 'retire', discard: [source, destinationCid].sort(), allowedActions: ['reprovision'] });
    const result = await f.service.reprovision(employeeId, await f.request(again), f.authority);
    expect(result).toMatchObject({ operationId: again, state: 'ready' });
    const entries = f.snapshot().retiredDockerEmployeeContinuations!;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ operationId: again, previous: retireOperation, source: { phase: 'created' } });
    expect(f.snapshot().employees[0]!.dockerBinding).toBeUndefined();
    await expect(f.service.preview(employeeId, template, f.authority)).resolves.toMatchObject({ mode: 'replace-source' });
  });
  it('makes the next source for the current session when the history began under an earlier one', async () => {
    // A plan move replaces an employee's session. Every later source derives from the FIRST record of the history,
    // which names the session of its own day. A source labelled with that session failed the proof that follows its
    // creation (DOCKER_CONTINUATION_CONTAINER_BINDING_CHANGED) on every retry, after the laptop was already gone.
    const f = await fixture();
    f.setLive({ inert: true });
    const first = await f.service.reprovision(employeeId, await f.request(), f.authority);
    const source = first.sourceContainerId!;
    const earlier = 'aaaaaaaa-9999-4999-8999-999999999999';
    // The first operation, as it reads once the employee has since been given another session.
    await f.companyStore.update((state) => {
      const history = state.retiredDockerEmployeeContinuations!;
      history[0] = JSON.parse(JSON.stringify(history[0]).replaceAll(sid, earlier)) as (typeof history)[number];
    });
    const next = '77777777-7777-4777-8777-777777777777';
    const row = DockerEmployeeContinuationRecord.parse({
      ...v2Row('ready'),
      phase: 'provider-issued',
      request: { ...v2Row('ready').request, operationId: next, containerId: source, imageId: workerImage },
      original: { ...original(source), imageId: workerImage },
      workerImage: { imageId: workerImage, sourceImageId: workerImage, clientManifestDigest: manifest },
    });
    await f.companyStore.update((state) => {
      state.dockerEmployeeContinuations = [structuredClone(row)];
      state.employees[0]!.dockerBinding = {
        ...f.binding,
        operationId: next,
        originalDigest: dockerContinuationDigest(row.destination),
      };
    });
    f.engine.container(destinationCid, {}, true);
    const bridge = f.engine.networks.get('b'.repeat(64))!;
    (bridge.Containers as Json)[destinationCid] = { Name: 'synthetic-laptop' };
    const removeIdle = f.engine.removeIdleLaptop.bind(f.engine);
    f.engine.removeIdleLaptop = async (id, current) => {
      await removeIdle(id, current);
      delete (bridge.Containers as Json)[id];
    };
    const again = '88888888-8888-4888-8888-888888888888';
    const result = await f.service.reprovision(employeeId, await f.request(again), f.authority);
    expect(result).toMatchObject({ operationId: again, state: 'ready' });
    const entries = f.snapshot().retiredDockerEmployeeContinuations!;
    expect(entries[0]).toMatchObject({ sessionId: earlier });
    expect(entries[1]).toMatchObject({ operationId: again, previous: retireOperation, sessionId: sid, source: { phase: 'created' } });
    const created = f.engine.created.at(-1)!.configuration as { Labels: Record<string, string> };
    expect(created.Labels['reverie.session']).toBe(sid);
  });
  it('keeps a laptop with a tenant, a ready laptop and an unrecorded container', async () => {
    const tenant = await fixture({ row: issued() });
    present(tenant);
    tenant.setLive({ inert: true });
    tenant.engine.tenants.add(destinationCid);
    const request = await tenant.request();
    await expect(tenant.service.reprovision(employeeId, request, tenant.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_LAPTOP_NOT_REMOVABLE',
    });
    expect(tenant.engine.containers.has(destinationCid)).toBe(true);
    expect(tenant.snapshot().dockerEmployeeContinuations).toHaveLength(1);

    // A ready laptop with a live provider is refused by the same idle proof.
    const ready = await fixture();
    present(ready);
    ready.setLive({ inert: true });
    ready.engine.tenants.add(destinationCid);
    await expect(
      ready.service.reprovision(employeeId, await ready.request(), ready.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_LAPTOP_NOT_REMOVABLE' });
    expect(ready.snapshot().dockerEmployeeContinuations).toHaveLength(1);

    const foreign = await fixture({ row: issued() });
    present(foreign);
    foreign.engine.container('7'.repeat(64), {
      'reverie.boxed.employee': employeeId,
      'reverie.boxed.instance': deployment,
    });
    await expect(foreign.service.preview(employeeId, template, foreign.authority)).resolves.toMatchObject({
      allowedActions: [],
      code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT',
    });
  });
});

const moveId = 'synthetic-move';
const laptopLabels = {
  'reverie.boxed.employee': employeeId,
  'reverie.boxed.instance': deployment,
  'reverie.boxed.box': boxId,
};
const laptopName = (id: string) => '/reverie-boxed-' + id;
const helperName = (kind: string, fill: string) => '/reverie-boxed-' + kind + '-' + fill.repeat(64);
const holderLabels = (move = moveId, employee = employeeId) => ({
  'reverie.box.plan-source.employee': employee,
  'reverie.box.plan-source.box': boxId,
  'reverie.box.plan-source.move': move,
  'reverie.box.plan-source.container': destinationCid,
});
const storageLabels = (employee = employeeId) => ({
  'reverie.box.storage.employee': employee,
  'reverie.box.storage.box': boxId,
  'reverie.box.storage.operation': nextOperation,
});
const leafLabels = { 'reverie.box.resource.box': boxId, 'reverie.box.resource.role': 'leaf-helper' };
/** No open move; `containers` is what a move the owner abandoned named in its journal. */
const abandonedMove = (containers: Json | null, open: Json[] = []) => ({
  openMoves: async () => open,
  abandonAbsentDockerMoves: async () => [],
  ownerAbandonedContainers: async () => (containers ? [{ moveId, containers }] : []),
});
const rebuildRequest = async (f: Fixture, operationId = retireOperation, extra: Json = {}) => ({
  operationId,
  sessionId: sid,
  sessionGeneration: 9,
  expectedScopeDigest: (await f.service.previewRebuild(employeeId, template, f.authority)).scopeDigest,
  template,
  ...extra,
});
const candidateCid = '4'.repeat(64),
  storageCid = '5'.repeat(64),
  leafCid = '6'.repeat(64);

describe('rebuild laptop', () => {
  it('rebuilds an out-of-office employee whose move stopped the old laptop and left a holder', async () => {
    // The held move was abandoned: old laptop exited, source holder running, dead viewer still live.
    const f = await fixture({
      employee: { onVacation: true, desiredRunning: false },
      moves: abandonedMove({ source: destinationCid, sourceHolder: candidateCid, helpers: [] }),
    });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    f.engine.container(candidateCid, holderLabels(), true, laptopName('e'.repeat(64)));
    f.setLive({ inert: false, container: destinationCid });
    // Every existing exit is closed to this state.
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE',
    });
    const before = fs.readFileSync(f.companyStore.file, 'utf8');
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      action: 'rebuild',
      mode: 'retire',
      employeeId,
      sessionId: sid,
      sessionGeneration: 9,
      outOfOffice: true,
      record: { version: 2, phase: 'ready', operationId: priorOperation },
      discard: [
        { containerId: candidateCid, role: 'source-holder', running: true },
        { containerId: destinationCid, role: 'laptop', running: false },
      ],
      runningLaptops: [],
      requiresConfirmation: false,
      foreign: [],
      viewer: { live: true, container: destinationCid },
      planMoves: { open: [], abandoned: [moveId] },
      kept: {
        home: f.row.original.home,
        nixSource: '/synthetic-state/nix',
        scratchSource: `/synthetic-scratch/laptops/employees/${employeeId}`,
      },
      allowedActions: ['rebuild'],
    });
    expect(preview).not.toHaveProperty('code');
    expect(preview.lost).toContain('conversation');
    // The preview is read-only.
    expect(fs.readFileSync(f.companyStore.file, 'utf8')).toBe(before);
    expect(f.engine.rebuilt).toEqual([]);
    expect(f.forgotten).toEqual([]);
    const result = await f.service.rebuild(employeeId, await rebuildRequest(f), f.authority);
    expect(result).toMatchObject({ operationId: retireOperation, state: 'ready' });
    // The laptop goes first so its viewer ends; only the running holder needed a stop.
    expect(f.engine.rebuilt).toEqual([destinationCid, candidateCid]);
    expect(f.engine.stopped).toEqual([candidateCid]);
    expect(f.forgotten).toEqual([sid]);
    // The employee, their identity, intent and conversation are untouched; the laptop record is retired.
    expect(f.snapshot().employees[0]).toMatchObject({
      id: employeeId,
      sessionId: sid,
      sessionGeneration: 9,
      name: 'Ada Lovelace',
      onVacation: true,
      desiredRunning: false,
    });
    expect(f.snapshot().employees[0]!.dockerBinding).toBeUndefined();
    expect(f.snapshot().dockerEmployeeContinuations).toEqual([]);
    expect(f.entry()).toMatchObject({
      reason: 'recorded-containers-absent',
      record: f.row,
      binding: f.binding,
      session: { phase: 'cleared', containerName: destinationCid },
      source: { phase: 'created', containerId: result.sourceContainerId },
    });
    const saved = f.state.getSession(sid)!;
    expect(saved.docker).toBeUndefined();
    expect(saved).toMatchObject(f.conversation);
    // One inert source on the employee's private home; nothing was started.
    expect(f.engine.created).toHaveLength(1);
    expect((f.engine.containers.get(result.sourceContainerId!)!.State as Json).Status).toBe('created');
    // The same request replays its recorded result without another effect.
    const again = await f.service.rebuild(
      employeeId,
      { operationId: retireOperation, sessionId: sid, sessionGeneration: 9, expectedScopeDigest: '0'.repeat(64), template },
      f.authority
    );
    expect(again).toEqual(result);
    expect(f.engine.rebuilt).toHaveLength(2);
    expect(f.engine.created).toHaveLength(1);
  });
  it('requires an explicit confirmation before it stops a running laptop, then discards the candidate and its helpers', async () => {
    // A move that created and started the new laptop before its resource helper failed.
    const anchor = '9'.repeat(64);
    const f = await fixture({
      moves: abandonedMove({
        source: destinationCid,
        target: candidateCid,
        helpers: [
          { role: 'storage-holder', containerId: storageCid },
          { role: 'leaf-helper', containerId: leafCid },
        ],
      }),
    });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    f.engine.container(candidateCid, laptopLabels, true, laptopName(candidateCid));
    f.engine.container(storageCid, storageLabels(), true, helperName('storage', 'a'));
    f.engine.container(leafCid, leafLabels, false, helperName('leaf-helper', 'b'));
    // The shared pool anchor belongs to every laptop and is named by no abandonment.
    f.engine.container(anchor, { 'reverie.box.resource.box': boxId, 'reverie.box.resource.role': 'anchor' }, true);
    // The running candidate is still attached to the employee's office bridge.
    (f.engine.networks.get('b'.repeat(64))!.Containers as Json)[candidateCid] = { Name: 'synthetic-candidate' };
    f.setLive({ inert: false, container: destinationCid });
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SESSION_ACTIVE',
    });
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      discard: [
        { containerId: candidateCid, role: 'laptop', running: true },
        { containerId: storageCid, role: 'storage-holder', running: true },
        { containerId: leafCid, role: 'leaf-helper', running: false },
        { containerId: destinationCid, role: 'laptop', running: false },
      ],
      runningLaptops: [candidateCid],
      requiresConfirmation: true,
      allowedActions: ['rebuild'],
    });
    const request = await rebuildRequest(f);
    await expect(f.service.rebuild(employeeId, request, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_RUNNING_CONFIRMATION_REQUIRED',
    });
    // Refused before any effect.
    expect(f.engine.rebuilt).toEqual([]);
    expect(f.forgotten).toEqual([]);
    expect(f.store.record(employeeId)).toEqual(f.row);
    expect(f.entry()).toBeUndefined();
    // The caller is given the last word after every check of the rebuild and before the first stop. A caller that
    // withdraws there leaves everything as it was.
    await expect(
      f.service.rebuild(
        employeeId,
        { ...request, confirmDiscardRunning: true },
        {
          ...f.authority,
          discarding: () => {
            throw new Error('a turn began');
          },
        }
      )
    ).rejects.toThrow('a turn began');
    expect([f.engine.rebuilt, f.engine.stopped, f.forgotten]).toEqual([[], [], []]);
    expect(f.store.record(employeeId)).toEqual(f.row);
    const order: string[] = [];
    const discardOne = f.engine.discardLaptopContainer.bind(f.engine);
    f.engine.discardLaptopContainer = async (id, proof, current) => {
      order.push('stop');
      return discardOne(id, proof, current);
    };
    const result = await f.service.rebuild(
      employeeId,
      { ...request, confirmDiscardRunning: true },
      { ...f.authority, discarding: () => void order.push('last word') }
    );
    f.engine.discardLaptopContainer = discardOne;
    expect(order.slice(0, 2)).toEqual(['last word', 'stop']);
    expect(order.filter((step) => step === 'last word')).toHaveLength(1);
    expect(result.state).toBe('ready');
    expect(f.engine.rebuilt).toEqual([candidateCid, destinationCid, storageCid, leafCid]);
    expect(f.engine.stopped).toEqual([candidateCid, storageCid]);
    expect(f.engine.containers.has(anchor)).toBe(true);
    expect(f.forgotten).toEqual([sid]);
    // The ordinary continuation owns the fresh source from here.
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('rebuilds a laptop whose provider exited and left another process behind', async () => {
    const row = DockerEmployeeContinuationRecord.parse({ ...v2Row('ready'), phase: 'provider-issued' });
    const f = await fixture({ row, moves: abandonedMove(null) });
    f.engine.container(destinationCid, laptopLabels, true, laptopName(destinationCid));
    f.engine.tenants.add(destinationCid);
    // The idle-only discard of the absent workflow refuses it.
    f.setLive({ inert: true });
    await expect(f.service.reprovision(employeeId, await f.request(), f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_LAPTOP_NOT_REMOVABLE',
    });
    f.setLive({ inert: false, container: destinationCid });
    expect(await f.service.previewRebuild(employeeId, template, f.authority)).toMatchObject({
      record: { phase: 'provider-issued' },
      runningLaptops: [destinationCid],
      requiresConfirmation: true,
    });
    const result = await f.service.rebuild(
      employeeId,
      await rebuildRequest(f, retireOperation, { confirmDiscardRunning: true }),
      f.authority
    );
    expect(result.state).toBe('ready');
    expect(f.engine.stopped).toEqual([destinationCid]);
    expect(f.forgotten).toEqual([sid]);
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('sends the owner to abandon a held move first and waits for a working one', async () => {
    const held = await fixture({ moves: abandonedMove(null, [{ id: 'm', docker: true, busy: false }]) });
    held.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    expect(await held.service.previewRebuild(employeeId, template, held.authority)).toMatchObject({
      code: 'DOCKER_REBUILD_PLAN_MOVE_HELD',
      allowedActions: ['abandon'],
      planMoves: { open: ['m'], abandoned: [] },
    });
    await expect(held.service.rebuild(employeeId, await rebuildRequest(held), held.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_PLAN_MOVE_HELD',
    });
    expect(held.engine.rebuilt).toEqual([]);
    expect(held.store.record(employeeId)).toEqual(held.row);
    for (const move of [
      { id: 'm', docker: true, busy: true },
      { id: 'm', docker: false, busy: false },
    ]) {
      const f = await fixture({ moves: abandonedMove(null, [move]) });
      expect(await f.service.previewRebuild(employeeId, template, f.authority)).toMatchObject({
        code: 'DOCKER_REBUILD_PLAN_MOVE_ACTIVE',
        allowedActions: ['observe'],
      });
    }
    const unbound = await fixture({ moves: null });
    await expect(unbound.service.previewRebuild(employeeId, template, unbound.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_PLAN_JOURNAL_UNAVAILABLE',
    });
  });
  it('never removes a container that is not provably this employee’s own', async () => {
    const other = '33333333-3333-4333-8333-333333333333',
      strangerCid = '7'.repeat(64);
    const f = await fixture({
      moves: abandonedMove({
        source: destinationCid,
        // A move record can only point; the labels decide.
        target: strangerCid,
        sourceHolder: candidateCid,
        helpers: [{ role: 'storage-holder', containerId: storageCid }],
      }),
    });
    // Recorded, but neither labelled for the employee nor under the boxed laptop name.
    f.engine.container(destinationCid, {});
    // Another employee's laptop, holder and storage holder.
    f.engine.container(strangerCid, { ...laptopLabels, 'reverie.boxed.employee': other }, true, laptopName(strangerCid));
    f.engine.container(candidateCid, holderLabels(moveId, other), true);
    f.engine.container(storageCid, storageLabels(other), true);
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      discard: [],
      foreign: [candidateCid, storageCid, destinationCid],
      code: 'DOCKER_REBUILD_CONTAINER_FOREIGN',
      allowedActions: [],
    });
    // Another employee's laptop is not even listed: a move record never selects a laptop.
    expect(JSON.stringify(preview)).not.toContain(strangerCid);
    await expect(
      f.service.rebuild(employeeId, await rebuildRequest(f, retireOperation, { confirmDiscardRunning: true }), f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REBUILD_CONTAINER_FOREIGN' });
    expect(f.engine.rebuilt).toEqual([]);
    expect(f.engine.containers.size).toBe(4);
    // A laptop of this employee under another box of the same deployment is not this office's.
    const boxed = await fixture({ moves: abandonedMove(null) });
    boxed.engine.container(
      candidateCid,
      { ...laptopLabels, 'reverie.boxed.box': '1'.repeat(64) },
      false,
      laptopName(candidateCid)
    );
    expect(await boxed.service.previewRebuild(employeeId, template, boxed.authority)).toMatchObject({
      discard: [],
      foreign: [candidateCid],
    });
    // A holder labelled for another move of this employee is not the abandoned move's.
    const moved = await fixture({
      moves: abandonedMove({ source: destinationCid, sourceHolder: candidateCid, helpers: [] }),
    });
    moved.engine.container(candidateCid, holderLabels('another-move'), true);
    expect((await moved.service.previewRebuild(employeeId, template, moved.authority)).foreign).toEqual([candidateCid]);
  });
  it('refuses a stale preview, a changed inventory, a revoked owner and an unknown Engine', async () => {
    const f = await fixture({ moves: abandonedMove(null) });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    const request = await rebuildRequest(f);
    await expect(
      f.service.rebuild(employeeId, { ...request, expectedScopeDigest: '0'.repeat(64) }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_SCOPE_CHANGED' });
    await expect(f.service.rebuild(employeeId, { ...request, sessionGeneration: 10 }, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_TARGET_CHANGED',
    });
    // The absent workflow's digest is never a rebuild confirmation, and the other way round.
    const absent = await f.request();
    expect(absent.expectedScopeDigest).not.toBe(request.expectedScopeDigest);
    await expect(f.service.rebuild(employeeId, absent, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SCOPE_CHANGED',
    });
    await expect(f.service.reprovision(employeeId, request, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SCOPE_CHANGED',
    });
    // The absent workflow's request cannot carry the rebuild's confirmation at all.
    await expect(
      f.service.reprovision(employeeId, { ...absent, confirmDiscardRunning: true }, f.authority)
    ).rejects.toThrow();
    // A laptop that started after the preview is a different scope.
    f.engine.container(candidateCid, laptopLabels, true, laptopName(candidateCid));
    await expect(
      f.service.rebuild(employeeId, { ...request, confirmDiscardRunning: true }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_SCOPE_CHANGED' });
    f.engine.failLists = true;
    await expect(f.service.previewRebuild(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_ABSENCE_UNCONFIRMED',
    });
    f.engine.failLists = false;
    f.revoke();
    await expect(f.service.previewRebuild(employeeId, template, f.authority)).rejects.toThrow('synthetic revoked owner');
    await expect(f.service.rebuild(employeeId, request, f.authority)).rejects.toThrow('synthetic revoked owner');
    expect(f.engine.rebuilt).toEqual([]);
    expect(f.store.record(employeeId)).toEqual(f.row);
  });
  it('records nothing when a removal is not confirmed and converges from a fresh preview', async () => {
    const f = await fixture({
      moves: abandonedMove({ source: destinationCid, sourceHolder: candidateCid, helpers: [] }),
    });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    f.engine.container(candidateCid, holderLabels(), true);
    f.setLive({ inert: false, container: destinationCid });
    const first = await rebuildRequest(f);
    // The laptop is removed, then the Engine fails on the holder.
    const discard = f.engine.discardLaptopContainer.bind(f.engine);
    f.engine.discardLaptopContainer = async (id, proof, current) => {
      if (id === candidateCid) throw Error('synthetic Engine stop failure');
      return discard(id, proof, current);
    };
    await expect(f.service.rebuild(employeeId, first, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_REMOVAL_UNCONFIRMED',
    });
    expect(f.engine.rebuilt).toEqual([destinationCid]);
    // Nothing canonical moved and the viewer is still there.
    expect(f.store.record(employeeId)).toEqual(f.row);
    expect(f.snapshot().employees[0]!.dockerBinding).toEqual(f.binding);
    expect(f.entry()).toBeUndefined();
    expect(f.forgotten).toEqual([]);
    // The stale confirmation no longer matches what exists.
    f.engine.discardLaptopContainer = discard;
    await expect(f.service.rebuild(employeeId, first, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SCOPE_CHANGED',
    });
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview.discard).toEqual([{ containerId: candidateCid, role: 'source-holder', running: true }]);
    const result = await f.service.rebuild(employeeId, await rebuildRequest(f), f.authority);
    expect(result.state).toBe('ready');
    expect(f.engine.rebuilt).toEqual([destinationCid, candidateCid]);
    expect(f.forgotten).toEqual([sid]);
  });
  it('decides about the live viewer before it removes anything', async () => {
    // A viewer of a container the employee's records do not name.
    const foreign = await fixture({ moves: abandonedMove(null) });
    foreign.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    foreign.setLive({ inert: false, container: 'f'.repeat(64) });
    expect(await foreign.service.previewRebuild(employeeId, template, foreign.authority)).toMatchObject({
      code: 'DOCKER_REPROVISION_SESSION_VIEW_FOREIGN',
      allowedActions: [],
    });
    await expect(
      foreign.service.rebuild(employeeId, await rebuildRequest(foreign), foreign.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_SESSION_VIEW_FOREIGN' });
    expect(foreign.engine.rebuilt).toEqual([]);
    // An office that cannot forget a boxed viewer.
    const old = await fixture({ moves: abandonedMove(null), discardView: false });
    old.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    old.setLive({ inert: true, container: destinationCid });
    await expect(old.service.rebuild(employeeId, await rebuildRequest(old), old.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_VIEWER_DISCARD_UNAVAILABLE',
    });
    expect(old.engine.rebuilt).toEqual([]);
    // A live local session that is not a laptop viewer and is still working.
    const local = await fixture({ moves: abandonedMove(null) });
    local.setLive({ inert: false });
    await expect(local.service.rebuild(employeeId, await rebuildRequest(local), local.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SESSION_ACTIVE',
    });
    // An inert local session object is discarded the way the absent workflow discards it.
    const inert = await fixture({ moves: abandonedMove(null) });
    inert.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    inert.setLive({ inert: true });
    await expect(
      inert.service.rebuild(employeeId, await rebuildRequest(inert), inert.authority)
    ).resolves.toMatchObject({ state: 'ready' });
    expect(inert.discarded).toEqual([sid]);
    expect(inert.forgotten).toEqual([]);
  });
  it('keeps a viewer whose laptop the Engine still lists', async () => {
    // The removal reports success, yet a listing still shows the laptop.
    const f = await fixture({ moves: abandonedMove(null) });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    f.setLive({ inert: false, container: destinationCid });
    const request = await rebuildRequest(f);
    f.engine.discardLaptopContainer = async () => {};
    await expect(f.service.rebuild(employeeId, request, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_REMOVAL_UNCONFIRMED',
    });
    expect(f.forgotten).toEqual([]);
    expect(f.store.record(employeeId)).toEqual(f.row);
  });
  it('rebuilds over an unused source that an earlier operation created', async () => {
    const f = await fixture({ moves: abandonedMove(null) });
    const first = await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(first.state).toBe('ready');
    // A stray laptop of this employee appears beside the never-started source.
    f.engine.container(candidateCid, laptopLabels, true, laptopName(candidateCid));
    (f.engine.networks.get('b'.repeat(64))!.Containers as Json)[candidateCid] = {};
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      mode: 'replace-source',
      record: null,
      discard: [{ containerId: candidateCid, role: 'laptop', running: true }],
      requiresConfirmation: true,
    });
    const result = await f.service.rebuild(
      employeeId,
      await rebuildRequest(f, replaceOperation, { confirmDiscardRunning: true }),
      f.authority
    );
    expect(result).toMatchObject({ operationId: replaceOperation, state: 'ready' });
    expect(f.engine.rebuilt).toEqual([candidateCid]);
    // The unused source was replaced by its own workflow, with its never-started proof.
    expect(f.engine.removed).toEqual([first.sourceContainerId]);
    const entries = f.snapshot().retiredDockerEmployeeContinuations!;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ reason: 'source-replaced', previous: retireOperation, source: { phase: 'created' } });
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('finishes an unfinished rebuild by repeating its own request', async () => {
    const f = await fixture({ moves: abandonedMove(null) });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    const request = await rebuildRequest(f);
    f.engine.prepareOutcome = 'failed';
    await expect(f.service.rebuild(employeeId, request, f.authority)).resolves.toMatchObject({
      state: 'held',
      code: 'DOCKER_REPROVISION_STORE_PREPARATION_UNCONFIRMED',
    });
    expect(f.engine.rebuilt).toEqual([destinationCid]);
    expect(f.entry()).toMatchObject({ source: { phase: 'issued' } });
    // A new preview names the operation to finish instead of starting another one.
    const pending = await f.service.previewRebuild(employeeId, template, f.authority).catch((error) => error);
    expect(pending).toMatchObject({ code: 'DOCKER_REPROVISION_OPERATION_PENDING' });
    expect(pending.cause).toEqual({ pendingOperationId: retireOperation });
    f.engine.prepareOutcome = 'ok';
    await expect(f.service.rebuild(employeeId, request, f.authority)).resolves.toMatchObject({ state: 'ready' });
    expect(f.engine.created).toHaveLength(1);
  });
  it('still requires what a discarded laptop does not make moot', async () => {
    const busy = await fixture({ moves: abandonedMove(null) });
    busy.setBusy(true);
    await expect(busy.service.previewRebuild(employeeId, template, busy.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_BUSY',
    });
    const foreignLaunch = await fixture({ moves: abandonedMove(null), launchTransport: 'native-ordinary' });
    await expect(
      foreignLaunch.service.previewRebuild(employeeId, template, foreignLaunch.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN' });
    const none = await fixture({ moves: abandonedMove(null) });
    await none.companyStore.update((state) => {
      state.dockerEmployeeContinuations = [];
    });
    await expect(none.service.previewRebuild(employeeId, template, none.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_RECORD_REQUIRED',
    });
    // The absent workflow itself still refuses an out-of-office employee and a live viewer.
    const away = await fixture({ employee: { onVacation: true, desiredRunning: false } });
    await expect(away.service.reprovision(employeeId, {
      operationId: retireOperation, sessionId: sid, sessionGeneration: 9, expectedScopeDigest: '0'.repeat(64), template,
    }, away.authority)).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE' });
  });
  it('derives the sign-in seat of the rebuilt laptop from the profile', async () => {
    const f = await fixture({ profile: seat, moves: abandonedMove(null) });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    const account = {
      kind: 'seat-mount',
      key: 'CLAUDE_CONFIG_DIR',
      path: seatPath,
      source: `${homeSource}/.reverie/seat-auth/${seat}`,
      env: true,
    };
    expect((await f.service.previewRebuild(employeeId, template, f.authority)).account).toEqual(account);
    await f.service.rebuild(employeeId, await rebuildRequest(f), f.authority);
    expect(mountsOf(f)).toHaveLength(1);
    expect(envOf(f)).toEqual(['CLAUDE_CONFIG_DIR=' + seatPath]);
    expect(f.entry()!.account).toEqual(account);
  });
});

const movedFromOperation = '44444444-4444-4444-8444-444444444444';
const laterOperation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const openaiSeat = 'openai-ed0348c4';
const orphanCid = 'e1'.repeat(32),
  strayCid = 'e2'.repeat(32);
const generation = (operationId: string, provider: 'claude' | 'codex') => ({
  kind: 'generation-env',
  key: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
  path: `/home/agent/.reverie/plan-moves/${operationId}/generation-${'1'.repeat(64)}/${provider}`,
});
const selectPlan = (f: Fixture, id: string, provider: 'anthropic' | 'openai') =>
  f.companyStore.update((state) => {
    const employee = state.employees[0]!;
    employee.runtimeRecipe = {
      ...employee.runtimeRecipe!,
      subscriptionProfile: { id, label: 'Synthetic seat', provider },
    };
  });
/**
 * The history of an employee who changed plan twice. A plan move put them on a Codex plan; that laptop was
 * reprovisioned under the session of that day (the FIRST record of the history). A second plan move, under a new
 * session, put them on a Claude plan, and the owner rebuilt that laptop too. What is left is the unused source of
 * the second rebuild, and the selected plan is the Claude one.
 */
async function switchedPlan() {
  const codex = v3Row() as Extract<DockerEmployeeContinuationRecord, { version: 3 }>;
  // The laptop record that the second plan move replaced. From then on only that move's journal holds it, and
  // with it the storage holder of the laptop the move started from.
  const replaced = DockerEmployeeContinuationRecord.parse({
    ...v2Row('ready'),
    request: {
      ...v2Row('ready').request,
      operationId: movedFromOperation,
      sessionId: oldSid,
      sessionGeneration: 8,
      containerId: 'f'.repeat(64),
    },
    original: original('f'.repeat(64), oldSid),
    destination: { ...original(originalCid, oldSid), imageId: workerImage },
    tasks: [
      {
        role: 'storage-holder',
        name: 'reverie-boxed-storage-' + 'a'.repeat(64),
        imageId: helperImage,
        configurationDigest: 'b'.repeat(64),
        phase: 'running',
        containerId: orphanCid,
        initPid: 42,
        initStartTicks: '1234',
      },
    ],
  });
  /** What the plan-move journal answers; a test may replace its content. */
  const journal: { moveId: string; record: unknown }[] = [{ moveId, record: replaced }];
  const first = DockerEmployeeContinuationRecord.parse({
    ...codex,
    planReplacement: {
      ...codex.planReplacement,
      account: { ...codex.planReplacement.account, id: openaiSeat, provider: 'openai' },
    },
  });
  const f = await fixture({
    row: first,
    profile: openaiSeat,
    provider: 'openai',
    mode: 'codex',
    moves: {
      openMoves: async () => [],
      abandonAbsentDockerMoves: async () => [],
      replacedSourceRecords: async (employee: string, owner: string | undefined) =>
        employee === employeeId && owner === undefined ? structuredClone(journal) : [],
    },
  });
  const one = await f.service.reprovision(employeeId, await f.request(), f.authority);
  expect(f.entry()!.account).toEqual(generation(priorOperation, 'codex'));
  const earlier = 'aaaaaaaa-9999-4999-8999-999999999999';
  // The second plan move: a new session, a new plan and a plan replacement record of its own.
  const claude = DockerEmployeeContinuationRecord.parse({
    ...codex,
    request: { ...codex.request, operationId: nextOperation },
    planReplacement: {
      ...codex.planReplacement,
      account: { ...codex.planReplacement.account, id: seat },
      source: {
        ...codex.planReplacement.source,
        binding: { ...codex.planReplacement.source.binding, operationId: movedFromOperation },
        continuationDigest: dockerContinuationDigest(replaced),
      },
    },
  });
  await f.companyStore.update((state) => {
    const history = state.retiredDockerEmployeeContinuations!;
    history[0] = JSON.parse(JSON.stringify(history[0]).replaceAll(sid, earlier)) as (typeof history)[number];
    state.dockerEmployeeContinuations = [structuredClone(claude)];
    state.employees[0]!.dockerBinding = {
      ...f.binding,
      operationId: nextOperation,
      originalDigest: dockerContinuationDigest(claude.destination),
    };
  });
  await selectPlan(f, seat, 'anthropic');
  f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
  const two = await f.service.rebuild(employeeId, await rebuildRequest(f, replaceOperation), f.authority);
  expect(two).toMatchObject({ operationId: replaceOperation, state: 'ready' });
  // The rebuild discarded the old laptop and the unused source of the first operation.
  expect(f.engine.rebuilt.sort()).toEqual([one.sourceContainerId!, destinationCid].sort());
  const entries = () => f.snapshot().retiredDockerEmployeeContinuations!;
  expect(entries().map((entry) => [entry.sessionId, entry.record?.version, entry.previous])).toEqual([
    [earlier, 3, undefined],
    [sid, 3, retireOperation],
  ]);
  return { f, entries, source: two.sourceContainerId!, claude, replaced, journal };
}

describe('an employee who changed plan', () => {
  const claudeFolder = generation(nextOperation, 'claude');
  it('gives the next source the sign-in folder of the newest plan move, not of the first', async () => {
    // The laptop built from a source that named the first move's folder came up on the other provider's variable:
    // signed out and with no history, while the sign-in and every conversation sat in the newest move's folder.
    const { f, entries, source } = await switchedPlan();
    expect(entries()[1]!.account).toEqual(claudeFolder);
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({ mode: 'replace-source', record: null, account: claudeFolder });
    expect((await f.service.preview(employeeId, template, f.authority)).account).toEqual(claudeFolder);
    const result = await f.service.rebuild(employeeId, await rebuildRequest(f, thirdOperation), f.authority);
    expect(result).toMatchObject({ operationId: thirdOperation, state: 'ready' });
    expect(f.engine.removed).toEqual([source]);
    expect(entries()[2]).toMatchObject({ reason: 'source-replaced', previous: replaceOperation, account: claudeFolder });
    expect(envOf(f, 2)).toEqual(['CLAUDE_CONFIG_DIR=' + claudeFolder.path]);
    expect(mountsOf(f, 2)).toEqual([]);
    // The private home is still the one the first record names.
    expect(f.engine.created[2]!.configuration.Labels).toMatchObject({ 'reverie.session': sid });
  });
  it.each([
    [
      'the seat of the selected plan',
      { kind: 'seat-mount', key: 'CLAUDE_CONFIG_DIR', path: seatPath, source: `${homeSource}/.reverie/seat-auth/${seat}`, env: true },
      seat,
    ],
    ['nothing', { kind: 'none' }, undefined],
  ])('does not send a laptop back to a plan move’s folder once a rebuild has routed it to %s', async (_name, routed, profile) => {
    // An earlier release routed the rebuilt laptop of a plan replacement by the selected plan's own rules. The
    // employee has used that folder since; the move's folder is one they left.
    const f = await fixture({ row: v3Row(), ...(profile ? { profile } : {}) });
    f.setLive({ inert: true });
    const first = await f.service.reprovision(employeeId, await f.request(), f.authority);
    expect(f.entry()!.account).toEqual(generation(priorOperation, 'claude'));
    const begin = async (source: string, operationId: string) => {
      const row = DockerEmployeeContinuationRecord.parse({
        ...v2Row('ready'),
        request: { ...v2Row('ready').request, operationId, containerId: source, imageId: workerImage },
        original: { ...original(source), imageId: workerImage },
        workerImage: { imageId: workerImage, sourceImageId: workerImage, clientManifestDigest: manifest },
      });
      await f.companyStore.update((state) => {
        state.dockerEmployeeContinuations = [structuredClone(row)];
        state.employees[0]!.dockerBinding = {
          ...f.binding,
          operationId,
          originalDigest: dockerContinuationDigest(row.destination),
        };
      });
    };
    await begin(first.sourceContainerId!, nextOperation);
    const second = await f.service.reprovision(employeeId, await f.request(replaceOperation), f.authority);
    expect(second).toMatchObject({ operationId: replaceOperation, state: 'ready' });
    const entries = () => f.snapshot().retiredDockerEmployeeContinuations!;
    // Until something else decides, the laptop stays on the folder of its plan move.
    expect(entries()[1]).toMatchObject({ record: { version: 2 }, account: generation(priorOperation, 'claude') });
    await f.companyStore.update((state) => {
      state.retiredDockerEmployeeContinuations![1]!.account = routed as never;
    });
    // Replacing the unused source used to return to the first record's folder.
    const replace = await f.service.preview(employeeId, template, f.authority);
    expect(replace).toMatchObject({ mode: 'replace-source', account: routed });
    const third = await f.service.reprovision(
      employeeId,
      {
        operationId: thirdOperation,
        sessionId: sid,
        sessionGeneration: 9,
        expectedScopeDigest: replace.scopeDigest,
        template,
      },
      f.authority
    );
    expect(third).toMatchObject({ operationId: thirdOperation, state: 'ready' });
    expect(entries()[2]).toMatchObject({ reason: 'source-replaced', account: routed });
    expect(envOf(f, 2)).toEqual(profile ? ['CLAUDE_CONFIG_DIR=' + seatPath] : []);
    // And so does the laptop that is built from that source and rebuilt later.
    await begin(third.sourceContainerId!, laterOperation);
    expect(await f.service.preview(employeeId, template, f.authority)).toMatchObject({ mode: 'retire', account: routed });
  });
  it('keeps that folder when the laptop built from the source is rebuilt later', async () => {
    const { f, entries, source } = await switchedPlan();
    // An ordinary laptop record begun from the source: it names no plan of its own.
    const begun = DockerEmployeeContinuationRecord.parse({
      ...v2Row('ready'),
      request: { ...v2Row('ready').request, operationId: laterOperation, containerId: source, imageId: workerImage },
      original: { ...original(source), imageId: workerImage },
      workerImage: { imageId: workerImage, sourceImageId: workerImage, clientManifestDigest: manifest },
    });
    await f.companyStore.update((state) => {
      state.dockerEmployeeContinuations = [structuredClone(begun)];
      state.employees[0]!.dockerBinding = {
        ...f.binding,
        operationId: laterOperation,
        originalDigest: dockerContinuationDigest(begun.destination),
      };
    });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({ mode: 'retire', record: { version: 2 }, account: claudeFolder });
    const result = await f.service.rebuild(employeeId, await rebuildRequest(f, thirdOperation), f.authority);
    expect(result).toMatchObject({ operationId: thirdOperation, state: 'ready' });
    expect(entries()[2]).toMatchObject({ reason: 'recorded-containers-absent', account: claudeFolder });
    expect(envOf(f, 2)).toEqual(['CLAUDE_CONFIG_DIR=' + claudeFolder.path]);
  });
  it('refuses, before it discards anything, when the selected plan is on another provider than the newest move', async () => {
    // The plan was changed since by something that is not a plan move: no record says where the sign-in is.
    const { f, entries, source } = await switchedPlan();
    await selectPlan(f, openaiSeat, 'openai');
    const refused = { code: 'DOCKER_REPROVISION_ACCOUNT_PLAN_MISMATCH' };
    await expect(f.service.previewRebuild(employeeId, template, f.authority)).rejects.toMatchObject(refused);
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject(refused);
    const stale = { operationId: thirdOperation, sessionId: sid, sessionGeneration: 9, expectedScopeDigest: '0'.repeat(64), template };
    await expect(f.service.rebuild(employeeId, stale, f.authority)).rejects.toMatchObject(refused);
    expect(f.engine.removed).toEqual([]);
    expect(f.engine.containers.has(source)).toBe(true);
    expect(entries()).toHaveLength(2);
    // The same holds for a laptop that still has its record and its containers.
    const recorded = await fixture({ row: v3Row(), profile: openaiSeat, provider: 'openai', mode: 'codex' });
    recorded.engine.container(destinationCid, laptopLabels, true, laptopName(destinationCid));
    await expect(recorded.service.previewRebuild(employeeId, template, recorded.authority)).rejects.toMatchObject(refused);
    await expect(
      recorded.service.rebuild(employeeId, { ...stale, confirmDiscardRunning: true }, recorded.authority)
    ).rejects.toMatchObject(refused);
    expect(recorded.engine.rebuilt).toEqual([]);
    expect(recorded.snapshot().dockerEmployeeContinuations).toHaveLength(1);
    expect(recorded.snapshot().retiredDockerEmployeeContinuations ?? []).toEqual([]);
    const guidance = dockerRecoveryGuidance(refused.code)!;
    expect(guidance.allowedActions).toEqual(['rebuild-preview']);
    expect(guidance.message).toMatch(/^[A-Z].*[.]$/s);
    expect(guidance.message).not.toMatch(/DOCKER_|undefined/);
    // Selecting the plan of that move again is accepted as before.
    await selectPlan(f, seat, 'anthropic');
    expect((await f.service.previewRebuild(employeeId, template, f.authority)).account).toEqual(claudeFolder);
  });
  /** The storage holder of the laptop the second plan move started from, still running after that move finished. */
  const orphan = (f: Fixture, id = orphanCid, operation = movedFromOperation) =>
    f.engine.container(
      id,
      {
        'reverie.box.storage.employee': employeeId,
        'reverie.box.storage.box': boxId,
        'reverie.box.storage.operation': operation,
      },
      true,
      '/reverie-boxed-storage-' + id
    );
  it('accounts for the storage holder of the laptop record that a finished plan move replaced', async () => {
    // No record of the company names that holder: the record it was made for exists in the move's journal only.
    // It refused every later replacement of the unused source, although its laptop had long been discarded.
    const { f, entries, source } = await switchedPlan();
    orphan(f);
    expect(JSON.stringify(f.snapshot())).not.toContain(orphanCid);
    expect(JSON.stringify(f.snapshot())).toContain('1'.repeat(64));
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({ mode: 'replace-source', discard: [], foreign: [], allowedActions: ['rebuild'] });
    expect(await f.service.preview(employeeId, template, f.authority)).toMatchObject({
      mode: 'replace-source',
      helpers: [orphanCid],
    });
    const result = await f.service.rebuild(employeeId, await rebuildRequest(f, thirdOperation), f.authority);
    expect(result).toMatchObject({ operationId: thirdOperation, state: 'ready' });
    expect(entries()[2]).toMatchObject({ reason: 'source-replaced', source: { phase: 'created' } });
    // Accounted for, and left exactly where it was: only the unused source was removed.
    expect(f.engine.removed).toEqual([source]);
    expect(f.engine.containers.has(orphanCid)).toBe(true);
    expect((f.engine.containers.get(orphanCid)!.State as Json).Running).toBe(true);
    // The helpers are part of what the confirmation binds.
    const again = await f.service.preview(employeeId, template, f.authority);
    f.engine.containers.delete(orphanCid);
    expect((await f.service.preview(employeeId, template, f.authority)).scopeDigest).not.toBe(again.scopeDigest);
  });
  it('still refuses a holder that nothing accounts for, before it discards anything', async () => {
    const refused = { code: 'DOCKER_REPROVISION_HELPER_FOREIGN' };
    const stale = { operationId: thirdOperation, sessionId: sid, sessionGeneration: 9, expectedScopeDigest: '0'.repeat(64), template };
    const untouched = async (s: Awaited<ReturnType<typeof switchedPlan>>, holder = orphanCid) => {
      await expect(s.f.service.previewRebuild(employeeId, template, s.f.authority)).rejects.toMatchObject({
        ...refused,
        cause: { foreignHelpers: [holder] },
      });
      await expect(s.f.service.preview(employeeId, template, s.f.authority)).rejects.toMatchObject(refused);
      await expect(s.f.service.rebuild(employeeId, stale, s.f.authority)).rejects.toMatchObject(refused);
      expect(s.f.engine.removed).toEqual([]);
      expect(s.f.engine.containers.has(s.source)).toBe(true);
      expect(s.entries()).toHaveLength(2);
    };
    // A holder that neither the company nor a plan move recorded.
    const unknown = await switchedPlan();
    orphan(unknown.f);
    orphan(unknown.f, strayCid, laterOperation);
    await untouched(unknown, strayCid);
    // A journal that does not hold the record the history names: another record of the same move.
    const other = await switchedPlan();
    orphan(other.f);
    other.journal[0] = {
      moveId,
      record: DockerEmployeeContinuationRecord.parse({
        ...other.replaced,
        request: { ...other.replaced.request, sessionGeneration: 7 },
      }),
    };
    await untouched(other);
    // The right record under a move that the history does not name.
    const move = await switchedPlan();
    orphan(move.f);
    move.journal[0] = { moveId: 'another-move', record: move.replaced };
    await untouched(move);
    // Nothing in the journal, text that is no record, and a record of another employee.
    const empty = await switchedPlan();
    orphan(empty.f);
    empty.journal.length = 0;
    await untouched(empty);
    empty.journal.push({ moveId, record: { tasks: [{ role: 'storage-holder', containerId: orphanCid }] } });
    await untouched(empty);
    // An employee whose history retired no plan replacement: the journal on its own accounts for nothing.
    const live = await fixture({
      moves: {
        openMoves: async () => [],
        abandonAbsentDockerMoves: async () => [],
        replacedSourceRecords: async () => [{ moveId, record: unknown.replaced }],
      },
    });
    const first = await live.service.reprovision(employeeId, await live.request(), live.authority);
    orphan(live);
    await expect(live.service.previewRebuild(employeeId, template, live.authority)).rejects.toMatchObject(refused);
    expect(live.engine.containers.has(first.sourceContainerId!)).toBe(true);
    const guidance = dockerRecoveryGuidance(refused.code)!;
    expect(guidance.allowedActions).toEqual(['rebuild-preview']);
    expect(guidance.message).toMatch(/^[A-Z].*[.]$/s);
    expect(guidance.message).not.toMatch(/DOCKER_|undefined/);
  });
});

describe('a laptop source that was never started, after the office was given another laptop image', () => {
  const earlierImage = 'sha256:' + '6'.repeat(64);
  const outdatedCode = { code: 'DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED' };
  /** The unused source of a finished rebuild, as an office reads it whose laptop image was built since: the
   * source's image is the one of its day, and its layers are not the beginning of today's. */
  async function outdated() {
    const f = await fixture();
    const first = await f.service.reprovision(employeeId, await f.request(), f.authority);
    const source = first.sourceContainerId!;
    f.engine.image(earlierImage);
    (f.engine.images.get(earlierImage)!.RootFS as Json).Layers = ['sha256:' + '2'.repeat(64)];
    f.engine.containers.get(source)!.Image = earlierImage;
    await f.companyStore.update((state) => {
      const head = state.retiredDockerEmployeeContinuations![0]!;
      if (head.source.phase === 'created') head.source.imageId = earlierImage;
    });
    return { f, source };
  }
  const startFrom = (source: string, imageId = earlierImage) => ({
    operationId: nextOperation,
    sessionId: sid,
    sessionGeneration: 9,
    containerId: source,
    imageId,
    expectedPolicyDigest: dockerContinuationDigest(policy),
    expectedDestinationImageId: workerImage,
    enterOffice: false,
  });
  it('says that the unused laptop has to be rebuilt, instead of only naming an image', async () => {
    // The policy read answered DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED and nothing else. The laptop could not be
    // started, a rebuild was the one step that helped, and nothing said so.
    const { f, source } = await outdated();
    // The earlier image is still an accepted source image, but today's image does not descend from it.
    const accepted = newContinuation(f, [legacyImage, earlierImage]);
    await expect(accepted.service.selection(employeeId, f.authority)).rejects.toMatchObject(outdatedCode);
    // The earlier image is no longer an accepted source image at all.
    const dropped = newContinuation(f);
    await expect(dropped.service.selection(employeeId, f.authority)).rejects.toMatchObject(outdatedCode);
    // A start request that still names it is refused the same way and records nothing.
    await expect(accepted.service.begin(employeeId, startFrom(source), f.authority)).rejects.toMatchObject(outdatedCode);
    expect(f.store.record(employeeId)).toBeUndefined();
    expect(accepted.effects).toEqual([]);
    const guidance = dockerRecoveryGuidance(outdatedCode.code)!;
    expect(guidance.allowedActions).toEqual(['rebuild-preview']);
    expect(guidance.message).toMatch(/^[A-Z].*[.]$/s);
    expect(guidance.message).not.toMatch(/DOCKER_|undefined/);
    expect(guidance.message).toMatch(/docker-rebuild\/preview.*docker-rebuild\/apply/s);
    // The step it names works: the rebuild replaces the never-started source with one made from today's image.
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({ mode: 'replace-source', discard: [], sourceImageId: workerImage, allowedActions: ['rebuild'] });
    const result = await f.service.rebuild(employeeId, await rebuildRequest(f, replaceOperation), f.authority);
    expect(result).toMatchObject({ state: 'ready', sourceImageId: workerImage });
    expect(f.engine.removed).toEqual([source]);
    await beginsAgain(f, result.sourceContainerId!);
  });
  it('keeps the image rule itself, and its own refusal for every laptop that is not that unused source', async () => {
    // A source whose image today's image descends from was always accepted, and still is.
    const descends = await outdated();
    (descends.f.engine.images.get(earlierImage)!.RootFS as Json).Layers = ['sha256:' + '1'.repeat(64)];
    await expect(
      newContinuation(descends.f, [legacyImage, earlierImage]).service.selection(employeeId, descends.f.authority)
    ).resolves.toMatchObject({ state: 'stopped', imageId: earlierImage, destinationImageId: workerImage });
    // No finished rebuild on record names the container: the refusal is the image rule's own.
    const unrecorded = await outdated();
    await unrecorded.f.companyStore.update((state) => {
      state.retiredDockerEmployeeContinuations = [];
    });
    const later = newContinuation(unrecorded.f, [legacyImage, earlierImage]);
    await expect(later.service.selection(employeeId, unrecorded.f.authority)).rejects.toMatchObject({
      code: 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED',
    });
    await expect(
      later.service.begin(employeeId, startFrom(unrecorded.source), unrecorded.f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED' });
    await expect(
      newContinuation(unrecorded.f).service.selection(employeeId, unrecorded.f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_CONTINUATION_SOURCE_IMAGE_UNSUPPORTED' });
  });
  it('recognizes the unused source of the newest finished operation only', async () => {
    const f = await fixture();
    const first = await f.service.reprovision(employeeId, await f.request(), f.authority);
    const source = first.sourceContainerId!;
    const read = () => unusedReprovisionSource(f.snapshot(), employeeId);
    expect(read()).toMatchObject({ phase: 'created', containerId: source });
    expect(f.store.unusedSource(employeeId)).toEqual({ containerId: source });
    expect(unusedReprovisionSource(f.snapshot(), '33333333-3333-4333-8333-333333333333')).toBeUndefined();
    // A laptop set-up begun from it that has not requested its destination leaves it unused.
    await beginsAgain(f, source);
    expect(read()).toMatchObject({ containerId: source });
    const begun = f.store.record(employeeId)!;
    const put = (row: Json) =>
      f.companyStore.update((state) => {
        state.dockerEmployeeContinuations = [DockerEmployeeContinuationRecord.parse(row)];
      });
    // Once it has a destination, the laptop is retired as a whole instead.
    await put({ ...begun, destination: { ...begun.original, containerId: destinationCid } });
    expect(read()).toBeUndefined();
    // A record begun from another container says nothing about this source.
    const elsewhere = { ...begun.original, containerId: candidateCid };
    await put({ ...begun, request: { ...begun.request, containerId: candidateCid }, original: elsewhere });
    expect(read()).toBeUndefined();
    await put(begun);
    // A history with two heads, or a head whose source is not finished, names no source.
    const [head] = f.snapshot().retiredDockerEmployeeContinuations!;
    const twin = { ...head!, operationId: thirdOperation };
    expect(reprovisionHeads([head!, twin], employeeId)).toHaveLength(2);
    expect(unusedReprovisionSource({ ...f.snapshot(), retiredDockerEmployeeContinuations: [head!, twin] }, employeeId)).toBeUndefined();
    const pending = { ...head!, source: { phase: 'pending' as const } };
    expect(unusedReprovisionSource({ ...f.snapshot(), retiredDockerEmployeeContinuations: [pending] }, employeeId)).toBeUndefined();
    expect(reprovisionHeads(undefined, employeeId)).toEqual([]);
  });
});

describe('rebuild proofs and guidance', () => {
  it('binds a container by its creator labels or by the recorded laptop name', () => {
    const row = { Name: laptopName(candidateCid), Config: { Labels: laptopLabels } };
    expect(dockerLaptopContainerProven(row, { kind: 'labels', labels: laptopLabels })).toBe(true);
    expect(dockerLaptopContainerProven(row, { kind: 'recorded' })).toBe(true);
    expect(
      dockerLaptopContainerProven({ ...row, Name: '/reverie-boxed-source-' + candidateCid }, { kind: 'recorded' })
    ).toBe(true);
    for (const proof of [
      { kind: 'labels', labels: {} },
      { kind: 'labels', labels: { ...laptopLabels, 'reverie.boxed.employee': '33333333-3333-4333-8333-333333333333' } },
      { kind: 'labels', labels: { 'reverie.boxed.employee': '' } },
      { kind: 'labels', labels: { 'com.example.employee': employeeId } },
    ] as DockerLaptopContainerProof[])
      expect(dockerLaptopContainerProven(row, proof)).toBe(false);
    expect(dockerLaptopContainerProven({ Name: '/reverie', Config: { Labels: null } }, { kind: 'recorded' })).toBe(false);
    expect(
      dockerLaptopContainerProven({ Name: '/reverie-boxed-anchor-' + 'a'.repeat(32), Config: null }, { kind: 'recorded' })
    ).toBe(false);
    expect(
      dockerLaptopContainerProven({ Name: laptopName(candidateCid), Config: null }, { kind: 'labels', labels: laptopLabels })
    ).toBe(false);
  });
  it('lets only a boxed laptop viewer be forgotten', () => {
    const viewer = {
      id: sid,
      docker: {
        hostId: 'boxed-runtime',
        engine: 'docker',
        owned: false,
        containerName: destinationCid,
        continuation: { operationId: priorOperation },
      },
    };
    expect(absentLaptopViewRefusal(viewer, sid, false)).toBeUndefined();
    for (const [subject, cleaning] of [
      [{ ...viewer, id: oldSid }, false],
      [{ ...viewer, remote: {} }, false],
      [{ id: sid }, false],
      [{ ...viewer, docker: { ...viewer.docker, continuation: undefined } }, false],
      [{ ...viewer, docker: { ...viewer.docker, owned: true } }, false],
      [{ ...viewer, docker: { ...viewer.docker, hostId: 'case-host' } }, false],
      [{ ...viewer, docker: { ...viewer.docker, containerName: 'named-container' } }, false],
      [{ ...viewer, paneLifecycleInFlight: true }, false],
      [viewer, true],
    ] as const)
      expect(absentLaptopViewRefusal(subject as never, sid, cleaning)).toEqual(expect.any(String));
  });
  it('explains every rebuild refusal and names the next step', () => {
    for (const code of [
      'DOCKER_REBUILD_PLAN_MOVE_HELD',
      'DOCKER_REBUILD_PLAN_MOVE_ACTIVE',
      'DOCKER_REBUILD_CONTAINER_FOREIGN',
      'DOCKER_REBUILD_RUNNING_CONFIRMATION_REQUIRED',
      'DOCKER_REBUILD_CONTAINER_NOT_REMOVABLE',
      'DOCKER_REBUILD_REMOVAL_UNCONFIRMED',
      'DOCKER_REBUILD_REMOVAL_UNAVAILABLE',
      'DOCKER_REBUILD_VIEWER_DISCARD_UNAVAILABLE',
      'DOCKER_REBUILD_VIEWER_DISCARD_UNCONFIRMED',
      'DOCKER_REPROVISION_SESSION_ACTIVE',
      'DOCKER_REPROVISION_SESSION_VIEW_FOREIGN',
      'DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE',
      'DOCKER_REPROVISION_CONTAINERS_PRESENT',
      'DOCKER_REPROVISION_LAPTOP_NOT_REMOVABLE',
      'DOCKER_REPROVISION_PLAN_MOVE_ACTIVE',
      'DOCKER_REPROVISION_SCOPE_CHANGED',
      'DOCKER_REPROVISION_OFFICE_NETWORK_AMBIGUOUS',
    ]) {
      const guidance = dockerRecoveryGuidance(code)!;
      expect(guidance.message, code).toMatch(/^[A-Z].*[.]$/s);
      expect(guidance.message).not.toMatch(/DOCKER_|undefined/);
      expect(Array.isArray(guidance.allowedActions)).toBe(true);
    }
    expect(dockerRecoveryGuidance('DOCKER_REBUILD_PLAN_MOVE_HELD')!.allowedActions).toEqual(['abandon']);
    expect(dockerRecoveryGuidance('DOCKER_REBUILD_RUNNING_CONFIRMATION_REQUIRED')!.allowedActions).toEqual(['rebuild']);
    expect(dockerRecoveryGuidance('DOCKER_REPROVISION_SESSION_ACTIVE')!.allowedActions).toEqual(['rebuild-preview']);
    expect(dockerRecoveryGuidance('toString')).toBeUndefined();
    expect(dockerRecoveryGuidance('DOCKER_CONTINUATION_UNKNOWN')).toBeUndefined();
  });
});

describe('the sign-in seat of a new laptop', () => {
  const seatSpec = { imageId: workerImage, user: template.user, homeSource, profileId: seat, provider: 'anthropic' };
  const helper = 'reverie-boxed-seat-prepare-' + retireOperation.replaceAll('-', '');
  const rebuilt = async (options: Options = {}) => {
    const f = await fixture({ profile: seat, moves: abandonedMove(null), ...options });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    return f;
  };
  it('rebuilds a laptop that comes up signed in from the office plan account, with no owner sign-in', async () => {
    const f = await rebuilt({ office: 'signed-in' });
    await expect(f.service.rebuild(employeeId, await rebuildRequest(f), f.authority)).resolves.toMatchObject({
      state: 'ready',
    });
    // Once before the old laptop is discarded, and again before the source is created.
    expect(f.engine.seats).toEqual([
      { name: helper, spec: seatSpec, auth: officeSignIn, sources: 0, containers: 1 },
      { name: helper, spec: seatSpec, auth: officeSignIn, sources: 0, containers: 0 },
    ]);
    expect(f.officePlans.asked).toEqual([
      { profileId: seat, provider: 'anthropic' },
      { profileId: seat, provider: 'anthropic' },
    ]);
    // The office's held copy is released after each use, and never reaches the Engine configuration.
    expect(f.officePlans.held).toBe(0);
    expect(JSON.stringify(f.engine.created)).not.toContain('SYNTHETIC_OFFICE_SIGN_IN');
    expect(JSON.stringify(f.snapshot())).not.toContain('SYNTHETIC_OFFICE_SIGN_IN');
    expect(mountsOf(f)).toHaveLength(1);
    expect(envOf(f)).toEqual(['CLAUDE_CONFIG_DIR=' + seatPath]);
  });
  it('builds nothing and discards nothing when neither the office nor the employee is signed in', async () => {
    const f = await rebuilt({ office: 'signed-out' });
    const request = await rebuildRequest(f);
    const refused = await f.service.rebuild(employeeId, request, f.authority).catch((error) => error);
    expect(refused).toMatchObject({ code: 'DOCKER_REPROVISION_SEAT_ACCOUNT_SIGNED_OUT' });
    expect(dockerReprovisionHoldDetail(refused)).toEqual({ seatProfile: { id: seat, label: 'Synthetic seat' } });
    expect(f.engine.containers.has(destinationCid)).toBe(true);
    expect(f.engine.rebuilt).toEqual([]);
    expect(f.engine.created).toHaveLength(0);
    expect(f.entry()).toBeUndefined();
    expect(f.snapshot().dockerEmployeeContinuations).toHaveLength(1);
    expect(f.engine.seats).toHaveLength(1);
    expect(f.engine.seats[0]!.auth).toBeUndefined();
    // The owner signs in on the Plans page and sends the same request again.
    f.officePlans.state = 'signed-in';
    await expect(f.service.rebuild(employeeId, request, f.authority)).resolves.toMatchObject({ state: 'ready' });
    expect(f.engine.rebuilt).toEqual([destinationCid]);
    expect(f.engine.seats.at(-1)!.auth).toBe(officeSignIn);
  });
  it('builds for an employee who already has a sign-in, refreshed when the office holds one', async () => {
    for (const office of ['signed-in', 'signed-out'] as const) {
      const f = await rebuilt({ office });
      f.engine.seatCredential = 'present';
      await expect(f.service.rebuild(employeeId, await rebuildRequest(f), f.authority)).resolves.toMatchObject({
        state: 'ready',
      });
      expect(f.engine.created).toHaveLength(1);
      expect(f.officePlans.held).toBe(0);
    }
  });
  it('still makes the folder when no plan account service is bound, and leaves an owner-named seat alone', async () => {
    const unbound = await rebuilt();
    await expect(
      unbound.service.rebuild(employeeId, await rebuildRequest(unbound), unbound.authority)
    ).resolves.toMatchObject({ state: 'ready' });
    expect(unbound.engine.seats.map((call) => call.auth)).toEqual([undefined, undefined]);
    // The owner's own directory is neither created nor written by the office.
    const named = await fixture({ profile: seat, office: 'signed-in' });
    const body = { ...template, accountSource: '/synthetic-seats/' + seat };
    await expect(
      named.service.reprovision(employeeId, await named.request(retireOperation, body), named.authority)
    ).resolves.toMatchObject({ state: 'ready' });
    expect(named.engine.seats).toEqual([]);
    expect(named.officePlans.asked).toEqual([]);
    // An employee without a plan has no seat at all.
    const none = await fixture({ office: 'signed-in' });
    none.setLive({ inert: true });
    await none.service.reprovision(employeeId, await none.request(), none.authority);
    expect(none.engine.seats).toEqual([]);
  });
  it('refuses a seat it may not use before anything is retired, and converges once that is fixed', async () => {
    const f = await seatFixture({ office: 'signed-in' });
    const request = await f.request();
    f.engine.seatOutcome = 'foreign';
    await expect(f.service.reprovision(employeeId, request, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN',
    });
    expect(f.entry()).toBeUndefined();
    expect(f.engine.created).toHaveLength(0);
    expect(f.officePlans.held).toBe(0);
    f.engine.seatOutcome = 'failed';
    await expect(f.service.reprovision(employeeId, request, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED',
    });
    expect(f.officePlans.held).toBe(0);
    f.engine.seatOutcome = 'ok';
    await expect(f.service.reprovision(employeeId, request, f.authority)).resolves.toMatchObject({ state: 'ready' });
    expect(f.engine.created).toHaveLength(1);
  });
  it('finishes an operation that an earlier office left held on a refused create', async () => {
    // The seat folder did not exist, the Engine answered 400 and the operation stayed issued.
    const f = await seatFixture({ office: 'signed-in' });
    const request = await f.request();
    f.engine.createOutcome = 'config-rejected';
    const held = await f.service.reprovision(employeeId, request, f.authority);
    expect(held).toMatchObject({ state: 'held', code: 'DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED' });
    expect(dockerRecoveryGuidance(held.code!)!.allowedActions).toEqual(['retry']);
    expect(f.entry()).toMatchObject({ source: { phase: 'issued' } });
    const before = f.engine.seats.length;
    f.engine.createOutcome = 'ok';
    // The same request again: the seat is prepared before the create is repeated.
    await expect(f.service.reprovision(employeeId, request, f.authority)).resolves.toMatchObject({ state: 'ready' });
    expect(f.engine.seats).toHaveLength(before + 1);
    expect(f.engine.seats.at(-1)).toMatchObject({ name: helper, sources: 0 });
  });
  it('names the mount whose host folder is missing when the Engine says which', async () => {
    const f = await fixture();
    f.setLive({ inert: true });
    const request = await f.request();
    f.engine.createOutcome = 'bind-missing';
    const held = await f.service.reprovision(employeeId, request, f.authority);
    expect(held).toMatchObject({
      state: 'held',
      code: 'DOCKER_CONTINUATION_CREATE_BIND_SOURCE_MISSING',
      missingMountTarget: '/reverie_workspace',
    });
    expect(dockerRecoveryGuidance(held.code!)!.message).toContain('missingMountTarget');
    f.engine.createOutcome = 'ok';
    const done = await f.service.reprovision(employeeId, request, f.authority);
    expect(done).toMatchObject({ state: 'ready' });
    expect(done.missingMountTarget).toBeUndefined();
  });
});

describe('rebuilding the laptop of a session this office process launched', () => {
  /** A healthy running laptop, its live viewer, and the launch that viewer still owns in memory. */
  const launched = async (owner: 'viewer' | 'foreign' = 'viewer') => {
    const f = await fixture({ moves: abandonedMove(null) });
    f.engine.container(destinationCid, laptopLabels, true, laptopName(destinationCid));
    f.setLive({ inert: false, container: destinationCid });
    f.viewerLaunch.owner = owner;
    return f;
  };
  const confirmed = (f: Fixture) => rebuildRequest(f, retireOperation, { confirmDiscardRunning: true });
  it('previews, asks for the owner’s word and rebuilds without an office restart', async () => {
    const f = await launched();
    // The absent-laptop workflow still refuses a live terminal, and a live launch behind an idle one.
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SESSION_ACTIVE',
    });
    f.setLive({ inert: true, container: destinationCid });
    await expect(f.service.preview(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN',
    });
    f.setLive({ inert: false, container: destinationCid });
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({
      runningLaptops: [destinationCid],
      requiresConfirmation: true,
      viewer: { live: true, container: destinationCid, ownsLaunch: true },
      allowedActions: ['rebuild'],
    });
    await expect(f.service.rebuild(employeeId, await rebuildRequest(f), f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_RUNNING_CONFIRMATION_REQUIRED',
    });
    expect(f.engine.rebuilt).toEqual([]);
    expect(f.viewerLaunch.owner).toBe('viewer');
    await expect(f.service.rebuild(employeeId, await confirmed(f), f.authority)).resolves.toMatchObject({
      state: 'ready',
    });
    // Containers first, then the viewer together with its launch, then the ordinary retirement.
    expect(f.engine.stopped).toEqual([destinationCid]);
    expect(f.engine.rebuilt).toEqual([destinationCid]);
    expect(f.forgotten).toEqual([sid]);
    expect(f.viewerLaunch.owner).toBe('none');
    expect(f.entry()).toMatchObject({ session: { phase: 'cleared' }, source: { phase: 'created' } });
  });
  it('needs the owner’s word for a held launch even when the laptop itself is already stopped', async () => {
    const f = await fixture({ moves: abandonedMove(null) });
    f.engine.container(destinationCid, laptopLabels, false, laptopName(destinationCid));
    f.setLive({ inert: false, container: destinationCid });
    f.viewerLaunch.owner = 'viewer';
    expect(await f.service.previewRebuild(employeeId, template, f.authority)).toMatchObject({
      runningLaptops: [],
      requiresConfirmation: true,
    });
    await expect(f.service.rebuild(employeeId, await rebuildRequest(f), f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_RUNNING_CONFIRMATION_REQUIRED',
    });
    expect(f.engine.rebuilt).toEqual([]);
  });
  it('keeps refusing a launch that is not the viewer’s own, before anything is touched', async () => {
    const f = await launched('foreign');
    await expect(f.service.previewRebuild(employeeId, template, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN',
    });
    // Also a launch with no live viewer to discard, and an office that cannot discard viewers.
    const orphan = await launched();
    orphan.setLive(undefined);
    await expect(orphan.service.previewRebuild(employeeId, template, orphan.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN',
    });
    const unable = await fixture({ moves: abandonedMove(null), discardView: false });
    unable.engine.container(destinationCid, laptopLabels, true, laptopName(destinationCid));
    unable.setLive({ inert: false, container: destinationCid });
    unable.viewerLaunch.owner = 'viewer';
    await expect(unable.service.previewRebuild(employeeId, template, unable.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN',
    });
    for (const each of [f, orphan, unable]) {
      expect(each.engine.rebuilt).toEqual([]);
      expect(each.engine.containers.has(destinationCid)).toBe(true);
      expect(each.entry()).toBeUndefined();
    }
  });
  it('completes from a fresh preview after a failure between the container discard and the launch release', async () => {
    const f = await launched();
    f.viewerLaunch.fail = 'stop';
    await expect(f.service.rebuild(employeeId, await confirmed(f), f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_VIEWER_DISCARD_UNCONFIRMED',
    });
    // The laptop is gone, the viewer and its launch are both still there, nothing is recorded.
    expect(f.engine.containers.has(destinationCid)).toBe(false);
    expect(f.viewerLaunch.owner).toBe('viewer');
    expect(f.forgotten).toEqual([]);
    expect(f.entry()).toBeUndefined();
    // The request as it was sent no longer matches what exists.
    const stale = { ...(await confirmed(f)), expectedScopeDigest: '0'.repeat(64) };
    await expect(f.service.rebuild(employeeId, stale, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SCOPE_CHANGED',
    });
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({ discard: [], requiresConfirmation: true, allowedActions: ['rebuild'] });
    await expect(f.service.rebuild(employeeId, await confirmed(f), f.authority)).resolves.toMatchObject({
      state: 'ready',
    });
    expect(f.forgotten).toEqual([sid]);
    expect(f.viewerLaunch.owner).toBe('none');
  });
  it('completes from a fresh preview after a failure that follows the launch release', async () => {
    const f = await launched();
    f.viewerLaunch.fail = 'layout';
    await expect(f.service.rebuild(employeeId, await confirmed(f), f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REBUILD_VIEWER_DISCARD_UNCONFIRMED',
    });
    // Laptop gone, viewer gone, launch released: the state the absent-laptop workflow already handles.
    expect(f.engine.containers.has(destinationCid)).toBe(false);
    expect(f.viewerLaunch.owner).toBe('none');
    expect(f.entry()).toBeUndefined();
    const absent = await f.service.preview(employeeId, template, f.authority);
    expect(absent.allowedActions).toEqual(['reprovision']);
    const preview = await f.service.previewRebuild(employeeId, template, f.authority);
    expect(preview).toMatchObject({ discard: [], requiresConfirmation: false, viewer: { live: false } });
    await expect(f.service.rebuild(employeeId, await confirmed(f), f.authority)).resolves.toMatchObject({
      state: 'ready',
    });
  });
});

describe('a rebuild that has not returned when another is asked for', () => {
  it('refuses the second as busy while the first runs, and the first finishes as itself', async () => {
    const f = await fixture();
    const request = await rebuildRequest(f);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const prepare = f.engine.prepareWorkerStore.bind(f.engine);
    let waiting = false;
    f.engine.prepareWorkerStore = async (...args) => {
      waiting = true;
      await gate;
      return prepare(...args);
    };
    // The first rebuild waits, part-way, in a helper of its own that does not return.
    const first = f.service.rebuild(employeeId, request, f.authority);
    for (let tries = 0; tries < 100 && !waiting; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(waiting).toBe(true);
    expect(f.service.flightActive(employeeId)).toBe(true);
    // A second rebuild of the same laptop, as the supervisor asks once it took the first for interrupted.
    await expect(
      f.service.rebuild(employeeId, { ...request, operationId: '99999999-9999-4999-8999-999999999999' }, f.authority)
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_BUSY' });
    // Asked again with the first one's own request, it is refused all the same: one flight per employee.
    await expect(f.service.rebuild(employeeId, request, f.authority)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_BUSY',
    });
    release();
    await expect(first).resolves.toMatchObject({ state: 'ready' });
    expect(f.engine.created).toHaveLength(1);
    // After it, a preview names nothing pending, and a request made before the first finished is out of date.
    expect(f.service.flightActive(employeeId)).toBe(false);
    await expect(
      f.service.rebuild(employeeId, { ...request, operationId: '99999999-9999-4999-8999-999999999999' }, f.authority)
    ).rejects.toMatchObject({ code: expect.stringMatching(/^DOCKER_RE/) });
    expect(f.engine.created).toHaveLength(1);
  });
});
