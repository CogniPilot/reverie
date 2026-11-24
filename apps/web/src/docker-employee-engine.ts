import { requireDockerEffectiveResourceProof } from './docker-contained-resource-controller.js';
import { dockerPlanDestinationEnvironment, DockerPlanInitialReceipt, DockerPlanLiveReceipt } from './docker-plan-install-data.js';
import {parseDockerPlanProtocol}from'./docker-plan-protocol.js';
import { parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
import type { DockerWorkerReattachHelper } from './docker-worker-reattach-helper.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import { DockerPlanInstaller } from './docker-plan-installer.js';
import { dockerProviderHookPolicy } from './docker-employee-provider-hooks.js';
import { DOCKER_CODEX_WORKSPACE_PROGRAM, type DockerCodexWorkspace } from './docker-employee-codex-workspace.js';
import type { CompanyEmployee } from './company-types.js';
import { DockerEphemeralRestoration } from './docker-ephemeral-restoration.js';
import { ephemeralContinuationProjection, ephemeralPublishedProjection, type EphemeralJournal } from './docker-ephemeral-data.js';
import {
  DockerEmployeeCredentialInstaller,
  type DockerCredentialHome,
} from './docker-employee-credential-installer.js';
/** Fixed adapter for a new boxed destination; the old laptop is read-only.
 * Resource helpers earn fresh original FD/cgroup proof inside their owning port.
 */
import { parseWorkerCredentialReadback } from './worker-client-manifest.js';
import { DockerEmployeeStorage, type DockerEmployeeStorageObservation } from './docker-employee-storage.js';
import type { DockerContinuationTaskJournal } from './docker-continuation-task.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DockerEmployeePlanReplacementWorkRecord,
  DockerEmployeeBinding,
  DockerPlanReplacementNetworkIds,
  DockerEmployeeOriginal,
  DockerEmployeeResourcePolicy,
  DockerEmployeeWorkerImage,
  DockerEmployeeContinuationRecord,
  type DockerEmployeePool,
} from './docker-employee-continuation-data.js';
import {
  dockerContinuationDigest,
  type DockerContinuationEngine,
  type DockerContinuationSubject,
  type DockerContainerObservation,
} from './docker-employee-continuation.js';
import {
  DockerEmployeeInspect,
  boxedOriginal,
  historicalBoxedInspect,
  boxedMountConfiguration,
  boxedStorageMounts,
  dockerEngineRefuse as refuse,
} from './docker-employee-engine-data.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { gpuHostConfig, gpuWorkerEnvironment, workerGpuLabel, type DockerWorkerGpu } from './docker-worker-gpu.js';
import type { SessionDocker } from './types.js';
import { DOCKER_PROVIDER_VIEW_ENV, DOCKER_PROVIDER_VIEW_PROGRAM, dockerProviderRuntimeArguments, dockerPlanProviderSelection } from './docker-employee-provider-view-native.js';
export { PackagedDockerEngineCommand, type DockerEngineCommand } from './docker-engine-command.js';
export interface DockerContainedResourceController {
  validate(original: DockerEmployeeOriginal, policy: DockerEmployeeResourcePolicy): Promise<void>;
  preparePool(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  observePool(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeePool | null>;
  read(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeResourcePolicy | null>;
  configure(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  /** Records a started leaf writer that is proved terminal and failed. No effect. */
  settleFailedWriter?(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  existingPolicy?(row: DockerEmployeeContinuationRecord, actual: DockerEmployeeResourcePolicy): unknown;
  readExistingAfterHostRestart?(
    row: DockerEmployeeContinuationRecord,
    policy: DockerEmployeeResourcePolicy,
    current: () => void
  ): Promise<DockerEmployeeResourcePolicy>;
}
export interface DockerEmployeeImageConfiguration {
  readonly workerGpu?: DockerWorkerGpu;
  readonly imageId: string;
  readonly clientManifestDigest: string;
  /** Accepted actual source base image IDs. No runtime request can add a base. */
  readonly sourceImageIds: readonly string[];
}
const providerViewOrigin = Symbol('original Engine-observed Docker provider view');
const providerPane = z
  .object({
    paneId: z.string().regex(/^%[0-9]{1,10}$/),
    panePid: z.number().int().positive().max(2147483647),
    paneStartTicks: z.string().regex(/^[1-9][0-9]{0,19}$/),
    hooks: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }).strict(),
      z
        .object({
          kind: z.literal('generation'),
          generation: z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/),
        })
        .strict(),
    ]),
  })
  .strict();
export interface DockerEmployeeProviderViewDescriptor {
  readonly employeeId: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly paneId: string;
  readonly panePid: number;
  readonly paneStartTicks: string;
  readonly mode: string;
  readonly hooks:
    | { readonly kind: 'none'; readonly mode: string }
    | { readonly kind: 'generation'; readonly generation: string };
  readonly clientManifestDigest: string;
  readonly planReplacement?: Readonly<{
    provider: 'anthropic' | 'openai';
    projectionDigest: string;
    runtimeNamespace?: 'session-v1';
  }>;
}
/** A private observer admission. It grants no provider creation or relaunch. */
export class DockerEmployeeProviderView {
  readonly #descriptor: Readonly<DockerEmployeeProviderViewDescriptor>;
  readonly #current: () => void;
  constructor(origin: symbol, descriptor: DockerEmployeeProviderViewDescriptor, current: () => void) {
    if (origin !== providerViewOrigin) throw Error('Original Engine provider view required');
    this.#descriptor = Object.freeze({
      ...descriptor,
      hooks: Object.freeze({ ...descriptor.hooks }),
      ...(descriptor.planReplacement ? { planReplacement: Object.freeze({ ...descriptor.planReplacement }) } : {}),
    });
    this.#current = current;
    Object.freeze(this);
  }
  get descriptor(): Readonly<DockerEmployeeProviderViewDescriptor> {
    return this.#descriptor;
  }
  require(sessionId: string, docker: SessionDocker): void {
    const value = this.#descriptor;
    this.#current();
    if (
      sessionId !== value.sessionId ||
      docker.containerName !== value.containerId ||
      docker.image !== value.imageId ||
      docker.owned !== false ||
      docker.engine !== 'docker' ||
      docker.context !== undefined ||
      docker.daemonHost !== 'unix:///run/reverie-engine/docker.sock' ||
      docker.continuation?.operationId !== value.operationId ||
      docker.continuation.sessionGeneration !== value.sessionGeneration ||
      docker.continuation.employeeId !== value.employeeId ||
      docker.continuation.clientManifestDigest !== value.clientManifestDigest ||
      !isDeepStrictEqual(docker.continuation.planReplacement, value.planReplacement) ||
      docker.extraExecArgs !== undefined ||
      docker.extraCreateArgs !== undefined ||
      docker.commands !== undefined
    )
      refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
    this.#current();
  }
}
Object.freeze(DockerEmployeeProviderView.prototype);
/** Use the original branded method, never a caller-supplied lookalike method. */
export function requireDockerEmployeeProviderView(view: unknown, sessionId: string, docker: SessionDocker): void {
  DockerEmployeeProviderView.prototype.require.call(view as DockerEmployeeProviderView, sessionId, docker);
}
const healthOrigin = Symbol('original Engine-observed Docker provider health');
export type DockerProviderObservation = 'live' | 'absent' | 'stopped';
/** Read-only proof: no view, launch, attach or input authority is exposed. */
export class DockerEmployeeProviderHealthProof {
  readonly #binding: DockerEmployeeBinding;
  readonly #view?: DockerEmployeeProviderView;
  constructor(
    origin: symbol,
    binding: DockerEmployeeBinding,
    private readonly employeeId: string,
    private readonly owner: string | undefined,
    private readonly observation: DockerProviderObservation,
    private readonly current: () => void,
    view?: DockerEmployeeProviderView
  ) {
    if (origin !== healthOrigin) throw Error('Original Docker provider health proof required');
    this.#binding = Object.freeze(structuredClone(binding));
    this.#view = view;
    Object.freeze(this);
  }
  require(employee: CompanyEmployee): DockerProviderObservation {
    this.current();
    const b = this.#binding;
    if (
      employee.id !== this.employeeId ||
      employee.owner !== this.owner ||
      employee.sessionId !== b.sessionId ||
      employee.sessionGeneration !== b.sessionGeneration ||
      dockerContinuationDigest(employee.dockerBinding) !== dockerContinuationDigest(b)
    )
      refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
    if (this.observation === 'live') {
      DockerEmployeeProviderView.prototype.require.call(this.#view, b.sessionId, {
        engine: 'docker',
        containerName: b.containerId,
        image: b.imageId,
        owned: false,
        daemonHost: 'unix:///run/reverie-engine/docker.sock',
        continuation: {
          operationId: b.operationId,
          employeeId: this.employeeId,
          sessionGeneration: b.sessionGeneration,
          clientManifestDigest: this.#view!.descriptor.clientManifestDigest,
          ...(this.#view!.descriptor.planReplacement
            ? { planReplacement: this.#view!.descriptor.planReplacement }
            : {}),
        },
      } as SessionDocker);
    }
    this.current();
    return this.observation;
  }
}
Object.freeze(DockerEmployeeProviderHealthProof.prototype);
function rowSubject(row: DockerEmployeeContinuationRecord): DockerContinuationSubject {
  return {
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    owner: row.owner,
    sourceDigest: row.sourceDigest,
    providerSourceDigest: row.version === 1 ? row.sourceDigest : row.providerSourceDigest,
    onVacation: false,
    desiredRunning: true,
  };
}
/** A replacement reads its retained old placement under the old SID. The target
 * subject above is used only for the new destination; neither is launch authority. */
function sourceSubject(row: DockerEmployeeContinuationRecord): DockerContinuationSubject {
  if (row.version !== 3) return rowSubject(row);
  const source = row.planReplacement.source;
  return {
    ...rowSubject(row),
    sessionId: source.binding.sessionId,
    sessionGeneration: source.binding.sessionGeneration,
    providerSourceDigest: source.providerSourceDigest,
  };
}
function networkEntries(raw: DockerEmployeeInspect): Array<readonly [string, string]> {
  try {
    const value = z
      .object({
        Networks: z.record(
          z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/),
          z.object({ NetworkID: z.string().regex(/^(?:[a-f0-9]{64})?$/) }).passthrough()
        ),
      })
      .parse(raw.NetworkSettings);
    const entries = Object.entries(value.Networks).map(([name, endpoint]) => [name, endpoint.NetworkID] as const);
    if (entries.length < 1 || entries.length > 16) refuse('DOCKER_PLAN_NETWORKS_UNCONFIRMED');
    return entries;
  } catch {
    return refuse('DOCKER_PLAN_NETWORKS_UNCONFIRMED');
  }
}
function networkStopped(raw: DockerEmployeeInspect | null): DockerEmployeeInspect {
  if (
    !raw ||
    raw.State.Running ||
    raw.State.Pid !== 0 ||
    !['created', 'exited'].includes(String(raw.State.Status)) ||
    raw.HostConfig.AutoRemove !== false ||
    (!isDeepStrictEqual(raw.HostConfig.RestartPolicy, {
      Name: 'no',
      MaximumRetryCount: 0,
    }) &&
      !isDeepStrictEqual(raw.HostConfig.RestartPolicy, { Name: 'no' }))
  )
    refuse('DOCKER_PLAN_NETWORK_SOURCE_CHANGED');
  return raw;
}
/** Incarnation/status fields, excluding mutable Docker HEALTHCHECK history. */
function containerReadState(raw: DockerEmployeeInspect) {
  const state = raw.State;
  return {
    Running: state.Running,
    Paused: state.Paused,
    Restarting: state.Restarting,
    Dead: state.Dead,
    Pid: state.Pid,
    StartedAt: state.StartedAt,
    FinishedAt: state.FinishedAt,
    ExitCode: state.ExitCode,
    OOMKilled: state.OOMKilled,
  };
}
function boundDestinationMatches(
  raw: DockerEmployeeInspect,
  row: DockerEmployeeContinuationRecord,
  deployment: string,
  afterRestart = false
): boolean {
  const subject = rowSubject(row);
  const selected = afterRestart && row.destination
    ? historicalBoxedInspect(raw, subject, deployment, row.destination)
    : raw;
  return isDeepStrictEqual(boxedOriginal(selected, subject, deployment, true), row.destination);
}
export class DockerEmployeeEngine implements DockerContinuationEngine {
  readonly #storage: DockerEmployeeStorage;
  readonly #credentials: DockerEmployeeCredentialInstaller;
  readonly #planInstaller: DockerPlanInstaller;
  readonly #ephemeral: DockerEphemeralRestoration | undefined;
  readonly #reattached = new Map<string, { row: string; state: ReturnType<typeof containerReadState> }>();
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly deployment: string,
    private readonly resources: DockerContainedResourceController,
    private readonly workerImage: DockerEmployeeImageConfiguration,
    private readonly journal: DockerContinuationTaskJournal,
    helperImageId: string,
    private readonly boxId: string,
    private readonly providerMode: (row: DockerEmployeeContinuationRecord) => string = () => 'claude',
    /** Existing original credential verification only; never used by installation or launch. */
    private readonly verifyExistingCredential?: (row: DockerEmployeeContinuationRecord, digest: string) => boolean,
    /** Denial-only canonical READY currency, composed only by the main runtime. */
    private readonly requirePublishedV3Read?: (row: DockerEmployeeContinuationRecord) => void
  ) {
    this.#storage = new DockerEmployeeStorage(
      command,
      journal,
      helperImageId,
      (row) => this.#source(row),
      boxId,
      (row) => this.#readSource(row)
    );
    this.#credentials = new DockerEmployeeCredentialInstaller(
      command,
      journal,
      (row) => this.#storage.credentialHome(row),
      boxId,
      (row) => this.#storage.observedCredentialHome(row)
    );
    this.#planInstaller = new DockerPlanInstaller(
      command,
      journal,
      (row) => this.#storage.credentialHome(row),
      boxId,
      (row) => this.#storage.observedCredentialHome(row)
    );
    const ephemeralJournal = journal as DockerContinuationTaskJournal & Partial<EphemeralJournal>;
    if (ephemeralJournal.readEphemeral && ephemeralJournal.publishEphemeral)
      this.#ephemeral = new DockerEphemeralRestoration(
        command,
        ephemeralJournal as EphemeralJournal,
        boxId,
        workerImage.imageId,
        (row) => this.#source(row),
        (row) => this.#destination(row, () => {}, true),
        (row) => this.#storage.protectedDirectories(row),
        (row) => this.#readSource(row),
        (row, current) => this.#boundDestination(row, current, true)
      );
    if (!/^[a-f0-9]{64}$/.test(boxId)) throw Error('Fixed boxed namespace required');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(deployment)) throw Error('Registered deployment required');
    if (!/^sha256:[a-f0-9]{64}$/.test(workerImage.imageId) || !/^[a-f0-9]{64}$/.test(workerImage.clientManifestDigest))
      throw Error('Fixed qualified worker image required');
  }
  async #networkIds(raw: DockerEmployeeInspect, current: () => void, allowCreated = false): Promise<readonly string[]> {
    current();
    const entries = networkEntries(raw);
    if (entries.every(([, id]) => id !== '')) {
      try {
        return Object.freeze(DockerPlanReplacementNetworkIds.parse(entries.map(([, id]) => id).sort()));
      } catch {
        return refuse('DOCKER_PLAN_NETWORKS_UNCONFIRMED');
      }
    }
    if (!allowCreated || raw.State.Running || raw.State.Status !== 'created' || raw.State.Pid !== 0)
      refuse('DOCKER_PLAN_NETWORKS_UNCONFIRMED');
    // Created endpoints can contain names and empty IDs. Resolve those exact
    // Engine selectors read-only; an empty value never supplies identity.
    let resolved: Array<{ Id: string; Name: string }>;
    try {
      const text = await this.command.run(['network', 'inspect', '--', ...entries.map(([name]) => name)]);
      current();
      resolved = z
        .array(
          z.object({
            Id: z.string().regex(/^[a-f0-9]{64}$/),
            Name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/),
          })
        )
        .length(entries.length)
        .max(16)
        .parse(JSON.parse(text));
    } catch {
      current();
      return refuse('DOCKER_PLAN_NETWORKS_UNCONFIRMED');
    }
    const ids = entries.map(([selector, id]) => {
      const matches = resolved.filter((network) => network.Id === selector || network.Name === selector);
      if (matches.length !== 1 || (id !== '' && id !== matches[0]!.Id)) refuse('DOCKER_PLAN_NETWORKS_UNCONFIRMED');
      return matches[0]!.Id;
    });
    try {
      return Object.freeze(DockerPlanReplacementNetworkIds.parse(ids.sort()));
    } catch {
      return refuse('DOCKER_PLAN_NETWORKS_UNCONFIRMED');
    }
  }
  async #inspect(cid: string): Promise<DockerEmployeeInspect> {
    if (!/^[a-f0-9]{64}$/.test(cid)) refuse('DOCKER_CONTINUATION_CONTAINER_ID_INVALID');
    const rows = z
        .array(DockerEmployeeInspect)
        .length(1)
        .parse(JSON.parse(await this.command.run(['container', 'inspect', cid]))),
      row = rows[0]!;
    if (row.Id !== cid || row.State.Paused || row.State.Restarting || row.State.Dead)
      refuse('DOCKER_CONTINUATION_CONTAINER_STATE_UNKNOWN');
    return row;
  }
  async #source(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeInspect> {
    const inspected = await this.#inspect(row.original.containerId);
    const raw = historicalBoxedInspect(inspected, sourceSubject(row), this.deployment, row.original, row.version === 3);
    if (
      raw.State.Running ||
      (row.version === 3 &&
        (raw.Config.Labels?.['reverie.boxed.operation'] !== row.planReplacement.source.binding.operationId ||
          raw.Config.Labels?.['reverie.boxed.generation'] !==
            String(row.planReplacement.source.binding.sessionGeneration) ||
          raw.Config.Labels?.['reverie.boxed.box'] !== this.boxId)) ||
      !isDeepStrictEqual(boxedOriginal(raw, sourceSubject(row), this.deployment, row.version === 3), row.original)
    )
      refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    return raw;
  }
  #publishedRead(row: DockerEmployeeContinuationRecord): boolean {
    if (row.version !== 3) return ['provider-issued', 'ready'].includes(row.phase);
    if (row.phase !== 'ready' || !this.requirePublishedV3Read) return false;
    this.requirePublishedV3Read(row);
    return true;
  }
  #readCurrent(row: DockerEmployeeContinuationRecord, current: () => void): () => void {
    return () => {
      current();
      this.#publishedRead(row);
    };
  }
  async #observePlanInstaller(row: DockerEmployeeContinuationRecord, current: () => void, auth?: string) {
    const check = this.#readCurrent(row, current);
    return this.#publishedRead(row)
      ? this.#planInstaller.observePublished(row, check, auth)
      : this.#planInstaller.observe(row, current, auth);
  }
  /** Published fingerprints qualify reads only; effect paths retain #source. */
  async #publishedDestination(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<DockerEmployeeInspect> {
    current();
    if (!this.#publishedRead(row) || !row.destination) refuse('DOCKER_CONTINUATION_READY_PROVIDER_REQUIRED');
    return this.#boundDestination(row, this.#readCurrent(row, current), true);
  }
  /** The caller retains the canonical binding across each read. */
  async #boundDestination(
    row: DockerEmployeeContinuationRecord,
    current: () => void,
    afterRestart = false
  ): Promise<DockerEmployeeInspect> {
    current();
    if (!row.destination) refuse('DOCKER_CONTINUATION_READY_PROVIDER_REQUIRED');
    const inspected = await this.#inspect(row.destination.containerId);
    const raw = afterRestart
      ? historicalBoxedInspect(inspected, rowSubject(row), this.deployment, row.destination)
      : inspected;
    current();
    const epoch = z
      .object({
        Pid: z.number().int().min(0).max(2147483647),
        StartedAt: z.string().datetime(),
      })
      .safeParse(raw.State);
    if (!epoch.success || (raw.State.Running ? epoch.data.Pid === 0 : epoch.data.Pid !== 0))
      refuse('DOCKER_CONTINUATION_DESTINATION_STATE_UNKNOWN');
    this.#requireCapsuleMounts(raw);
    if (
      !boundDestinationMatches(raw, row, this.deployment, afterRestart) ||
      raw.Image !== row.workerImage.imageId ||
      raw.Config.Labels?.['reverie.boxed.box'] !== this.boxId ||
      raw.Config.Labels?.['reverie.boxed.operation'] !== row.request.operationId ||
      raw.Config.Labels?.['reverie.boxed.source'] !== row.original.containerId ||
      raw.Config.Labels?.['reverie.boxed.generation'] !== String(row.request.sessionGeneration)
    )
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    return raw;
  }
  async #readSource(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeInspect> {
    return this.#publishedRead(row) ? this.#publishedDestination(row, () => {}) : this.#source(row);
  }
  #requireCapsuleMounts(raw: DockerEmployeeInspect): void {
    if (Number(raw.Config.User.split(':')[0]) === 0) refuse('DOCKER_CONTINUATION_UNPRIVILEGED_WORKER_REQUIRED');
    for (const mount of raw.Mounts) {
      for (const prefix of ['/opt/reverie-worker-tools', '/opt/reverie-worker-client', '/proc']) {
        if (
          mount.Destination === '/' ||
          mount.Destination === prefix ||
          prefix.startsWith(mount.Destination + '/') ||
          mount.Destination.startsWith(prefix + '/')
        )
          refuse('DOCKER_CONTINUATION_CAPSULE_MOUNT_SHADOW');
      }
    }
  }
  async image(original: DockerEmployeeOriginal): Promise<DockerEmployeeWorkerImage> {
    if (!this.workerImage.sourceImageIds.includes(original.imageId) && original.imageId !== this.workerImage.imageId)
      refuse('DOCKER_CONTINUATION_SOURCE_IMAGE_UNSUPPORTED');
    return this.#imagePair(original, this.workerImage, true);
  }
  /** Resume an existing identity installation on the currently selected worker
   * image. The old source image was admitted when this destination was created.
   * Fresh placement continues to require today's source allowlist. */
  async preparedIdentityImage(input: DockerEmployeeContinuationRecord, current: () => void): Promise<DockerEmployeeWorkerImage> {
    const row = DockerEmployeeContinuationRecord.parse(input);
    const check = () => {
      current();
      if (!isDeepStrictEqual(row, input)) refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    };
    check();
    if (row.version === 3 || !['identity-ready', 'identity-issued'].includes(row.phase) ||
      !row.destination || row.workerImage.imageId !== this.workerImage.imageId ||
      row.workerImage.clientManifestDigest !== this.workerImage.clientManifestDigest)
      refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
    const before = await this.#boundDestination(row, check, true);
    const actual = await this.#imagePair(row.original, this.workerImage, true);
    check();
    if (!isDeepStrictEqual(actual, row.workerImage)) refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
    const after = await this.#boundDestination(row, check, true);
    if (!isDeepStrictEqual(containerReadState(before), containerReadState(after)))
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
    return actual;
  }
  /** Select the current qualified replacement without assuming independently
   * built images have a Docker layer ancestry relationship. */
  async replacementTargetImage(
    original: DockerEmployeeOriginal,
    current: () => void
  ): Promise<DockerEmployeeWorkerImage> {
    current();
    if (!this.workerImage.sourceImageIds.includes(original.imageId) && original.imageId !== this.workerImage.imageId)
      refuse('DOCKER_CONTINUATION_SOURCE_IMAGE_UNSUPPORTED');
    const result = await this.#imagePair(original, this.workerImage, false);
    current();
    return result;
  }
  /** Read-only compatibility of an immutable, already captured target pair.
   * This supplies no source view, task admission or launch capability. */
  async qualifyPlanReplacementImage(
    original: DockerEmployeeOriginal,
    expected: DockerEmployeeWorkerImage,
    current: () => void
  ): Promise<void> {
    current();
    const source = DockerEmployeeOriginal.parse(original),
      saved = DockerEmployeeWorkerImage.parse(expected);
    if (
      saved.sourceImageId !== source.imageId ||
      (!this.workerImage.sourceImageIds.includes(source.imageId) && source.imageId !== this.workerImage.imageId) ||
      (!this.workerImage.sourceImageIds.includes(saved.imageId) && saved.imageId !== this.workerImage.imageId)
    )
      refuse('DOCKER_CONTINUATION_SOURCE_IMAGE_UNSUPPORTED');
    const actual = await this.#imagePair(source, saved, false);
    current();
    if (!isDeepStrictEqual(actual, saved)) refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
  }
  /** Read DATA only. The owning core separately checks the exact canonical
   * published binding, source closure and native destination/provider facts. */
  async existingImage(input: DockerEmployeeContinuationRecord, current: () => void): Promise<DockerEmployeeWorkerImage> {
    return this.#existingImage(input, current, true);
  }
  /** Historical source DATA only. The SourceReader separately owns the exact
   * stopped source/requester proof; this cannot mint a provider view or launch. */
  async existingPlanSourceImage(
    input: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<DockerEmployeeWorkerImage> {
    try {
      return await this.#existingImage(input, current, false);
    } catch (error) {
      current();
      const row = DockerEmployeeContinuationRecord.parse(input);
      if (row.version !== 3) throw error;
      try {
        if (!this.#publishedRead(row)) throw error;
      } catch {
        throw error;
      }
      const digest = dockerContinuationDigest(row);
      const check = () => {
        current();
        if (dockerContinuationDigest(input) !== digest) refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
        this.#publishedRead(row);
      };
      if (!(await this.#historicalPlanContainerAbsent(row, check))) throw error;
      const image = await this.#existingImage(row, check, true);
      if (!(await this.#historicalPlanContainerAbsent(row, check)))
        refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
      return image;
    }
  }
  /** A failed inspect conveys no absence. Confirm the full immutable ID in
   * the same Docker engine's inventory before and after reading the binding. */
  async #historicalPlanContainerAbsent(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<boolean> {
    current();
    const listed = await this.command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'id=' + row.original.containerId,
      '--format',
      '{{.ID}}',
    ]);
    current();
    return listed.trim() === '';
  }
  async #existingImage(
    input: DockerEmployeeContinuationRecord,
    current: () => void,
    publishedV3Read: boolean
  ): Promise<DockerEmployeeWorkerImage> {
    current();
    const row = DockerEmployeeContinuationRecord.parse(input),
      digest = dockerContinuationDigest(row);
    const check = () => {
      current();
      if (dockerContinuationDigest(input) !== digest) refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    };
    if (!['provider-issued', 'ready'].includes(row.phase)) refuse('DOCKER_CONTINUATION_READY_PROVIDER_REQUIRED');
    if ((row.version !== 3 || publishedV3Read) && this.#publishedRead(row)) {
      const before = await this.#publishedDestination(row, check);
      const images = z
        .array(
          z.object({
            Id: z.literal(row.workerImage.imageId),
            Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
          })
        )
        .length(1)
        .parse(JSON.parse(await this.command.run(['image', 'inspect', row.workerImage.imageId])));
      check();
      if (images[0]!.Config.Labels?.['org.reverie.worker-client.manifest'] !== row.workerImage.clientManifestDigest)
        refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
      const after = await this.#publishedDestination(row, check);
      if (!isDeepStrictEqual(containerReadState(before), containerReadState(after)))
        refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
      return DockerEmployeeWorkerImage.parse(row.workerImage);
    }
    await this.#source(row);
    check();
    const result = await this.#imagePair(row.original, row.workerImage, false);
    check();
    return result;
  }
  async #imagePair(
    original: DockerEmployeeOriginal,
    selected: Pick<DockerEmployeeWorkerImage, 'imageId' | 'clientManifestDigest'>,
    requireAncestor: boolean
  ): Promise<DockerEmployeeWorkerImage> {
    const rows = z
      .array(
        z.object({
          Id: z.string(),
          RootFS: z.object({ Layers: z.array(z.string()) }),
          Config: z.object({
            Entrypoint: z.array(z.string()).nullable(),
            Cmd: z.array(z.string()).nullable().default(null),
            Labels: z.record(z.string(), z.string()).nullable(),
          }),
        })
      )
      .length(1);
    const source = rows.parse(JSON.parse(await this.command.run(['image', 'inspect', original.imageId])))[0]!;
    const target = rows.parse(JSON.parse(await this.command.run(['image', 'inspect', selected.imageId])))[0]!;
    if (
      source.Id !== original.imageId ||
      target.Id !== selected.imageId ||
      (requireAncestor && source.RootFS.Layers.some((layer, index) => target.RootFS.Layers[index] !== layer)) ||
      target.Config.Labels?.['org.reverie.worker-client.manifest'] !== selected.clientManifestDigest
    )
      refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
    return DockerEmployeeWorkerImage.parse({
      imageId: target.Id,
      sourceImageId: source.Id,
      clientManifestDigest: selected.clientManifestDigest,
    });
  }
  async observePlanReplacementSource(row: DockerEmployeeContinuationRecord, current: () => void) {
    current();
    if (row.version !== 3) refuse('DOCKER_PLAN_INSTALL_PROTOCOL_REQUIRED');
    const raw = await this.#source(row);
    current();
    const restart = z
      .object({ Name: z.literal('no') })
      .passthrough()
      .safeParse(raw.HostConfig.RestartPolicy);
    if (raw.State.Pid !== 0 || !restart.success) refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    return {
      original: boxedOriginal(raw, sourceSubject(row), this.deployment, true),
      state: 'stopped' as const,
    };
  }
  /** Retained HOME identity only. The actor must independently retain its
   * genuine source-stop/request grant; this read cannot authorize a new helper. */
  async planReplacementHome(
    input: DockerEmployeeContinuationRecord,
    current: () => void,
    placement: 'running' | 'stopped' = 'stopped',
    retained?: {
      readonly helper: DockerWorkerReattachHelper;
      observed?: DockerEmployeeStorageObservation;
    }
  ): Promise<DockerCredentialHome> {
    const row = DockerEmployeeContinuationRecord.parse(input),
      key = dockerContinuationDigest(row);
    const check = () => {
      current();
      if (dockerContinuationDigest(input) !== key) refuse('DOCKER_PLAN_INSTALL_HOME_CHANGED');
    };
    check();
    if (!row.destination || !['provider-issued', 'ready'].includes(row.phase))
      refuse('DOCKER_PLAN_INSTALL_HOME_CHANGED');
    // Published fingerprints qualify only this retained read. New Storage,
    // credential and provider effects continue to require the original source.
    const before = await this.#destination(row, check, true);
    check();
    if (
      !before ||
      before.State.Running !== (placement === 'running') ||
      (placement === 'running'
        ? !z.number().int().positive().safeParse(before.State.Pid).success
        : before.State.Pid !== 0) ||
      before.State.Paused ||
      before.State.Restarting ||
      before.State.Dead ||
      !z
        .object({ Name: z.literal('no') })
        .passthrough()
        .safeParse(before.HostConfig.RestartPolicy).success
    )
      refuse('DOCKER_PLAN_INSTALL_HOME_CHANGED');
    let home: DockerCredentialHome | undefined;
    try {
      home = await this.#storage.observedCredentialHome(row);
    } catch (error) {
      check();
      if (!(error instanceof DockerEmployeeContinuationError) || error.code !== 'DOCKER_STORAGE_HOLDER_UNCONFIRMED' ||
          !retained) throw error;
      let observed: DockerEmployeeStorageObservation | undefined;
      home = await this.#storage.readExistingReference(row, before, (destination, seen, filesystemId) => {
        observed = seen;
        return retained.helper.storage(destination, seen, check, filesystemId);
      }, check, placement === 'stopped' ? retained.observed ?? 'original-reference' : undefined,
      original => retained.helper.stoppedReference(row, original));
      check();
      if (!home || !observed) throw error;
      if (placement === 'running') retained.observed = observed;
    }
    check();
    const after = await this.#destination(row, check, true);
    check();
    if (!after || !isDeepStrictEqual(containerReadState(before), containerReadState(after)))
      refuse('DOCKER_PLAN_INSTALL_HOME_CHANGED');
    return Object.freeze({ ...home });
  }
  /** Read-only current stopped worker membership, separate from requester/effect
   * authority. The caller must retain the original binding across every await. */
  async planReplacementNetworkIds(
    input: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<readonly string[]> {
    current();
    const row = DockerEmployeeContinuationRecord.parse(input),
      key = dockerContinuationDigest(row);
    if (!row.destination || !['provider-issued', 'ready'].includes(row.phase))
      refuse('DOCKER_PLAN_NETWORK_SOURCE_CHANGED');
    const check = () => {
      current();
      if (dockerContinuationDigest(input) !== key) refuse('DOCKER_PLAN_NETWORK_SOURCE_CHANGED');
    };
    const first = networkStopped(await this.#destination(row, check, true));
    check();
    const ids = await this.#networkIds(first, check, true);
    check();
    const last = networkStopped(await this.#destination(row, check, true));
    check();
    const afterIds = await this.#networkIds(last, check, true);
    check();
    if (!isDeepStrictEqual(containerReadState(first), containerReadState(last)) || !isDeepStrictEqual(ids, afterIds))
      refuse('DOCKER_PLAN_NETWORK_SOURCE_CHANGED');
    check();
    return Object.freeze([...ids]);
  }
  /** Original completed installer ACK only; no guest execution or live grant. */
  async planReplacementOriginal(row: DockerEmployeeContinuationRecord, current: () => void) {
    return this.#planInstaller.original(row, current);
  }
  async observeSource(subject: DockerContinuationSubject, containerId?: string, expected?: DockerEmployeeOriginal) {
    const selected = await this.command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'label=reverie.worker=' + this.deployment,
      '--filter',
      'label=reverie.employee=' + subject.employeeId,
      '--filter',
      'label=reverie.session=' + subject.sessionId,
      '--format',
      '{{.ID}}',
    ]);
    const cid = selected.trim();
    if (!/^[a-f0-9]{64}$/.test(cid) || (containerId !== undefined && cid !== containerId))
      refuse('DOCKER_CONTINUATION_UNIQUE_ORIGINAL_REQUIRED');
    const inspected = await this.#inspect(cid);
    const raw = expected ? historicalBoxedInspect(inspected, subject, this.deployment, expected, false) : inspected;
    const original = boxedOriginal(raw, subject, this.deployment);
    return {
      original,
      state: raw.State.Running ? ('running' as const) : ('stopped' as const),
    };
  }
  async validateCapabilities(original: DockerEmployeeOriginal, policy: DockerEmployeeResourcePolicy): Promise<void> {
    const raw = await this.#inspect(original.containerId);
    this.#requireCapsuleMounts(raw);
    if (
      raw.State.Running ||
      raw.Config.Entrypoint?.length !== 1 ||
      raw.Config.Entrypoint[0] !== '/opt/reverie/perf/bin/reverie-worker-init' ||
      (raw.Config.Cmd?.length ?? 0) !== 0
    )
      refuse('DOCKER_CONTINUATION_INERT_ORIGINAL_REQUIRED');
    if (
      raw.Config.Env.some((value) =>
        /^REVERIE_(USERNAME|PASSWORD|HOOK_SECRET|SERVICE_TOKEN|RECOVERY_[A-Z_]+)=/.test(value)
      )
    )
      refuse('DOCKER_CONTINUATION_SHARED_CREDENTIAL_ENV_DENIED');
    if (raw.Config.Env.filter((value) => value.startsWith('PATH=')).length !== 1)
      refuse('DOCKER_CONTINUATION_SOURCE_PATH_UNKNOWN');
    await this.image(original);
    await this.resources.validate(original, policy);
  }
  async prepareStorage(row: DockerEmployeeContinuationRecord, current: () => void) {
    await this.#storage.prepare(row, current);
    current();
    if (!this.#ephemeral && ephemeralContinuationProjection(await this.#source(row), row))
      refuse('DOCKER_EPHEMERAL_JOURNAL_REQUIRED');
    await this.#ephemeral?.prepare(row, current);
    current();
  }
  async observeStorage(
    row: DockerEmployeeContinuationRecord
  ): Promise<'ready' | 'unissued' | 'unknown' | 'ephemeral-unissued'> {
    const storage = await this.#storage.observe(row);
    if (storage !== 'ready') return storage;
    if (!this.#ephemeral && ephemeralPublishedProjection(await this.#readSource(row), row))
      refuse('DOCKER_EPHEMERAL_JOURNAL_REQUIRED');
    return (await this.#ephemeral?.observe(row)) === 'unissued' ? 'ephemeral-unissued' : 'ready';
  }
  assertPreparationCurrent(row: DockerEmployeeContinuationRecord): void {
    this.#ephemeral?.assertCurrent(row);
  }
  close(): void {
    this.#ephemeral?.close();
  }

  preparePool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    return this.resources.preparePool(row, current);
  }
  observePool(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeePool | null> {
    return this.resources.observePool(row);
  }
  #configuration(
    row: DockerEmployeeContinuationRecord,
    source: DockerEmployeeInspect,
    existingRead = false,
    sourceNetworks?: readonly string[],
    withGpuProfile = true
  ): Record<string, unknown> {
    this.#requireCapsuleMounts(source);
    if (!row.pool) refuse('DOCKER_CONTINUATION_POOL_UNCONFIRMED');
    let networks: Record<string, Record<string, never>> | undefined;
    if (row.version === 3) {
      const expected = row.planReplacement.source.networkIds;
      if (!expected) {
        if (!existingRead || !row.destination || !['provider-issued', 'ready'].includes(row.phase))
          refuse('DOCKER_PLAN_NETWORKS_REQUIRED');
      } else {
        if (!existingRead && !isDeepStrictEqual(DockerPlanReplacementNetworkIds.parse(expected), sourceNetworks))
          refuse('DOCKER_PLAN_NETWORK_SOURCE_CHANGED');
        networks = Object.fromEntries(expected.map((id) => [id, {}]));
      }
    }
    const sourceHost = source.HostConfig;
    const host: Record<string, unknown> = {};
    for (const key of [
      'ReadonlyRootfs',
      'Init',
      'CapAdd',
      'CapDrop',
      'SecurityOpt',
      'Devices',
      'DeviceRequests',
      'Tmpfs',
      'MaskedPaths',
      'ReadonlyPaths',
      'ShmSize',
      'Ulimits',
      'NetworkMode',
      'Dns',
      'DnsOptions',
      'DnsSearch',
      'ExtraHosts',
    ])
      if (sourceHost[key] !== undefined) host[key] = structuredClone(sourceHost[key]);
    const sourceSecurity = sourceHost.SecurityOpt ?? [];
    if (!Array.isArray(sourceSecurity) || sourceSecurity.some((value) => typeof value !== 'string'))
      refuse('DOCKER_CONTINUATION_SECURITY_OPTIONS_UNKNOWN');
    host.SecurityOpt = [
      ...sourceSecurity.filter((value) => !/^no-new-privileges(?:[=:].*)?$/.test(value)),
      'no-new-privileges',
    ];
    const gpu = withGpuProfile ? this.workerImage.workerGpu : undefined;
    const mounts = boxedMountConfiguration(source);
    if (gpu) {
      const projection = gpuHostConfig(gpu);
      if (mounts.length + projection.Mounts.length > 128 ||
        projection.Mounts.some((driver) => mounts.some((mount) => mount.Target === driver.Target)))
        refuse('DOCKER_CONTINUATION_GPU_MOUNT_CONFLICT');
      host.DeviceRequests = projection.DeviceRequests;
      mounts.push(...projection.Mounts);
    }
    Object.assign(host, {
      Privileged: false,
      AutoRemove: false,
      RestartPolicy: { Name: 'no' },
      Mounts: mounts,
      CgroupParent: row.pool.cgroupParent,
      Memory: row.policy.memoryMaxBytes,
      MemorySwap: row.policy.memoryMaxBytes + row.policy.swapMaxBytes,
      PidsLimit: row.policy.pidsMax,
      CpuShares: 0,
      CpusetCpus: row.policy.allowedCpus.join(','),
    });
    const environment = source.Config.Env.filter(
      (value) => !value.startsWith('REVERIE_WORKER_SOCKET=') && !value.startsWith('REVERIE_WORKER_VIEWER_SOCKET=')
    ).map((value) =>
      value.startsWith('PATH=')
        ? 'PATH=/opt/reverie-worker-client/bin:' +
          value
            .slice(5)
            .split(':')
            .filter((part) => part !== '/opt/reverie-worker-client/bin')
            .join(':')
        : value.startsWith('REVERIE_CLI=')
          ? 'REVERIE_CLI=/opt/reverie-worker-client/bin/reverie'
          : value
    );
    if (!environment.some((value) => value.startsWith('REVERIE_CLI=')))
      environment.push('REVERIE_CLI=/opt/reverie-worker-client/bin/reverie');
    for (const entry of [
      'TERMINFO=/opt/reverie-worker-tools/share/terminfo',
      'TERMINFO_DIRS=/opt/reverie-worker-tools/share/terminfo',
      'LOCALE_ARCHIVE=/opt/reverie-worker-tools/share/locale/locale-archive',
    ]) {
      const name = entry.slice(0, entry.indexOf('=') + 1);
      if (!environment.some((value) => value.startsWith(name))) environment.push(entry);
    }
    const runtimeEnvironment = gpu ? gpuWorkerEnvironment(environment, gpu) : environment;
    return {
      Image: row.workerImage.imageId,
      User: source.Config.User,
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: [],
      Env:
        row.version === 3
          ? dockerPlanDestinationEnvironment(runtimeEnvironment, {
              operationId: row.request.operationId,
              provider: row.planReplacement.account.provider,
              projectionDigest: row.planReplacement.account.projectionDigest,
            })
          : runtimeEnvironment,
      WorkingDir: source.Config.WorkingDir ?? '/',
      Hostname: source.Config.Hostname,
      Labels: {
        'reverie.boxed.instance': this.deployment,
        'reverie.boxed.box': this.boxId,
        'reverie.boxed.employee': row.employeeId,
        'reverie.boxed.session': row.request.sessionId,
        'reverie.boxed.generation': String(row.request.sessionGeneration),
        'reverie.boxed.operation': row.request.operationId,
        'reverie.boxed.source': row.original.containerId,
        'org.reverie.worker-client.manifest': row.workerImage.clientManifestDigest,
        ...(gpu ? { [workerGpuLabel]: dockerContinuationDigest(gpu) } : {}),
      },
      ...(networks ? { NetworkingConfig: { EndpointsConfig: networks } } : {}),
      HostConfig: host,
    };
  }
  /** The normal continuation never obtains v3 paid/work authority. */
  async createDestination(row:DockerEmployeeContinuationRecord,current:()=>void):Promise<void>{if(row.version===3)refuse('DOCKER_PLAN_REPLACEMENT_ACTOR_REQUIRED');return this.#createDestination(row,current,false);}
  async createPlanReplacementDestination(input:DockerEmployeePlanReplacementWorkRecord,current:()=>void):Promise<void>{const row=DockerEmployeePlanReplacementWorkRecord.parse(input);current();if(row.phase!=='destination-issued'||row.destination)refuse('DOCKER_PLAN_REPLACEMENT_ACTOR_REQUIRED');return this.#createDestination(row,current,true);}
  async validatePlanReplacement(input:DockerEmployeePlanReplacementWorkRecord,current:()=>void):Promise<void>{
    const row=DockerEmployeePlanReplacementWorkRecord.parse(input);current();const source=await this.#source(row);current();this.#requireCapsuleMounts(source);
    if(source.Config.Entrypoint?.length!==1||source.Config.Entrypoint[0]!=='/opt/reverie/perf/bin/reverie-worker-init'||(source.Config.Cmd?.length??0)!==0||source.Config.Env.filter(v=>v.startsWith('PATH=')).length!==1||source.Config.Env.some(v=>/^REVERIE_(USERNAME|PASSWORD|HOOK_SECRET|SERVICE_TOKEN|RECOVERY_[A-Z_]+)=/.test(v)))refuse('DOCKER_CONTINUATION_INERT_ORIGINAL_REQUIRED');
    const selected=await this.replacementTargetImage(row.original,current);current();if(!isDeepStrictEqual(selected,row.workerImage))refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');await this.resources.validate(row.original,row.policy);current();
  }
  async settlePlanReplacementStorage(input:DockerEmployeePlanReplacementWorkRecord,current:()=>void):Promise<void>{const row=DockerEmployeePlanReplacementWorkRecord.parse(input);await this.#storage.settleObserved(row,current);current();}
  /** Read-only compatibility of one already installed original. The owning
   * actor retains every grant/journal fence; this returns no launch authority. */
  async inspectPlanReplacementProtocol(
    input: DockerEmployeePlanReplacementWorkRecord,
    current: () => void
  ): Promise<void> {
    const row = DockerEmployeePlanReplacementWorkRecord.parse(input);
    current();
    if (row.phase !== 'identity-ready' || !row.destination) refuse('DOCKER_PLAN_REPLACEMENT_ACTOR_REQUIRED');
    const observe = async () => {
      const raw = await this.#destination(row, current);
      current();
      if (!raw?.State.Running) refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
      const epoch = z
        .object({
          Pid: z.number().int().positive().max(2147483647),
          StartedAt: z
            .string()
            .datetime()
            .refine((value) => Date.parse(value) > 0),
        })
        .safeParse(raw.State);
      if (!epoch.success) refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
      if (!isDeepStrictEqual(boxedOriginal(raw, rowSubject(row), this.deployment, true), row.destination))
        refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
      return containerReadState(raw);
    };
    const before = await observe();
    current();
    parseDockerPlanProtocol(
      await this.command.run([
        'exec',
        row.destination.containerId,
        '/opt/reverie-worker-client/bin/reverie',
        'worker-client',
        'plan-protocol',
        '--expected-digest',
        row.workerImage.clientManifestDigest,
      ])
    );
    current();
    const after = await observe();
    current();
    if (!isDeepStrictEqual(before, after)) refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
  }
  /** Inert target observation never consults legacy global identity or claims
   * that a provider exists. Canonical paid views remain a separate reader. */
  async observePlanReplacementWork(input:DockerEmployeePlanReplacementWorkRecord,current:()=>void):Promise<DockerContainerObservation|null>{
    const row=DockerEmployeePlanReplacementWorkRecord.parse(input);current();const raw=await this.#destination(row,current);current();if(!raw)return null;
    const original=boxedOriginal(raw,rowSubject(row),this.deployment,true);if(row.destination&&!isDeepStrictEqual(original,row.destination))refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');let resources:DockerEmployeeResourcePolicy|null=null;let provider:DockerContainerObservation['provider']={kind:'unknown'};
    if(raw.State.Running){parseDockerPlanProtocol(await this.command.run(['exec',raw.Id,'/opt/reverie-worker-client/bin/reverie','worker-client','plan-protocol','--expected-digest',row.workerImage.clientManifestDigest]));current();await this.#storage.verifyDestination(row);current();await this.#ephemeral?.verifyDestination(row);current();if(row.tasks?.some(t=>t.role==='leaf-helper'&&t.phase==='completed')){resources=await this.resources.read(row);current();}}
    if(raw.State.Running){provider=await this.#provider(original,row);current();}
    const after=await this.#destination(row,current);current();if(!after||!isDeepStrictEqual(raw.State,after.State)||!isDeepStrictEqual(boxedOriginal(after,rowSubject(row),this.deployment,true),original))refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');return{original,state:raw.State.Running?'running':'stopped',provider,resources,credentialDigest:null};
  }
  async installPlanReplacement(input:DockerEmployeePlanReplacementWorkRecord,payload:string,contextSource:string|undefined,current:()=>void):Promise<DockerPlanInitialReceipt>{
    const row=DockerEmployeePlanReplacementWorkRecord.parse(input);current();if(row.phase!=='identity-issued')refuse('DOCKER_PLAN_REPLACEMENT_ACTOR_REQUIRED');const raw=await this.#destination(row,current);current();if(!raw?.State.Running)refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');return this.#planInstaller.provision(row,payload,contextSource,current);
  }
  /** Ordinary completion only; generic live views keep historical and observed auth distinct. */
  async verifyPlanReplacementCanonicalAccount(input:DockerEmployeeContinuationRecord,canonicalAuthDigest:string,current:()=>void):Promise<void>{
    const row=DockerEmployeeContinuationRecord.parse(input);current();if(row.version!==3)refuse('DOCKER_PLAN_REPLACEMENT_ACTOR_REQUIRED');
    const raw=await this.#destination(row,current,true);current();if(!raw?.State.Running)refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    await this.#observePlanInstaller(row,current,canonicalAuthDigest);current();
  }
  async initialPlanReplacementInstallation(input:DockerEmployeePlanReplacementWorkRecord,current:()=>void):Promise<Readonly<DockerPlanInitialReceipt>>{const row=DockerEmployeePlanReplacementWorkRecord.parse(input);current();if(row.phase!=='identity-ready')refuse('DOCKER_PLAN_REPLACEMENT_ACTOR_REQUIRED');const raw=await this.#destination(row,current);current();if(!raw?.State.Running)refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');await this.#storage.verifyDestination(row);current();await this.#ephemeral?.verifyDestination(row);current();return this.#planInstaller.initialWork(row,current);}
  /** Re-read the exact completed initial install immediately before admitting
   * paid dispatch. A completed cursor cannot create or START a helper. */
  async observePlanReplacementInstallation(input:DockerEmployeePlanReplacementWorkRecord,payload:string,contextSource:string|undefined,current:()=>void):Promise<DockerPlanInitialReceipt>{
    const row=DockerEmployeePlanReplacementWorkRecord.parse(input);current();if(row.phase!=='identity-ready'||row.tasks?.find(t=>t.role==='identity-helper')?.phase!=='completed')refuse('DOCKER_PLAN_REPLACEMENT_ACTOR_REQUIRED');const raw=await this.#destination(row,current);current();if(!raw?.State.Running)refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');return this.#planInstaller.provision(row,payload,contextSource,current);
  }
  async #createDestination(row: DockerEmployeeContinuationRecord, current: () => void, plan:boolean): Promise<void> {
    if (row.version === 3 && !row.planReplacement.source.networkIds) refuse('DOCKER_PLAN_NETWORKS_REQUIRED');
    const source = await this.#source(row);
    if(plan){const selected=await this.replacementTargetImage(row.original,current);current();if(!isDeepStrictEqual(selected,row.workerImage))refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');}else await this.image(row.original);
    current();
    const pool = await this.resources.observePool(row);
    current();
    if (!pool || !isDeepStrictEqual(pool, row.pool)) refuse('DOCKER_CONTINUATION_POOL_CHANGED');
    let actualSource = source,
      sourceNetworks: readonly string[] | undefined;
    if (row.version === 3) {
      actualSource = networkStopped(await this.#source(row));
      current();
      sourceNetworks = await this.#networkIds(actualSource, current, true);
      current();
      const after = networkStopped(await this.#source(row));
      current();
      const afterNetworks = await this.#networkIds(after, current, true);
      current();
      if (!isDeepStrictEqual(actualSource.State, after.State) || !isDeepStrictEqual(sourceNetworks, afterNetworks))
        refuse('DOCKER_PLAN_NETWORK_SOURCE_CHANGED');
    }
    const config = this.#configuration(row, actualSource, false, sourceNetworks);
    await this.#ephemeral?.require(row);
    current();
    if (row.version === 3) {
      const latest = networkStopped(await this.#source(row));
      current();
      const ids = await this.#networkIds(latest, current, true);
      current();
      if (!isDeepStrictEqual(ids, row.planReplacement.source.networkIds)) refuse('DOCKER_PLAN_NETWORK_SOURCE_CHANGED');
    }
    await this.command.create(
      'reverie-boxed-' + dockerContinuationDigest([this.boxId, 'destination', row.request.operationId]),
      config,
      current
    );
  }
  async #destination(
    row: DockerEmployeeContinuationRecord,
    current: () => void = () => {},
    publishedRead = false
  ): Promise<DockerEmployeeInspect | null> {
    current();
    if (publishedRead && this.#publishedRead(row))
      return this.#publishedDestination(row, current);
    const selected = await this.command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'label=reverie.boxed.instance=' + this.deployment,
      '--filter',
      'label=reverie.boxed.operation=' + row.request.operationId,
      '--filter',
      'label=reverie.boxed.box=' + this.boxId,
      '--format',
      '{{.ID}}',
    ]);
    current();
    if (selected.trim() === '') return null;
    if (!/^[a-f0-9]{64}$/.test(selected.trim())) refuse('DOCKER_CONTINUATION_DESTINATION_AMBIGUOUS');
    const inspected = await this.#inspect(selected.trim());
    const raw = row.destination
      ? historicalBoxedInspect(inspected, rowSubject(row), this.deployment, row.destination)
      : inspected;
    current();
    const source = await this.#source(row);
    current();
    const labels = raw.Config.Labels;
    const gpuProfile = labels?.[workerGpuLabel];
    if (gpuProfile !== undefined &&
      (!this.workerImage.workerGpu || gpuProfile !== dockerContinuationDigest(this.workerImage.workerGpu)))
      refuse('DOCKER_CONTINUATION_GPU_PROFILE_CHANGED');
    const desired = this.#configuration(row, source, true, undefined, gpuProfile !== undefined);
    if (row.version === 3 && row.planReplacement.source.networkIds) {
      const pending = ['destination-issued', 'destination-ready', 'start-issued'].includes(row.phase);
      const actual = await this.#networkIds(raw, current, pending);
      current();
      if (
        !isDeepStrictEqual(actual, row.planReplacement.source.networkIds) ||
        raw.HostConfig.NetworkMode !== (desired.HostConfig as Record<string, unknown>).NetworkMode
      )
        refuse('DOCKER_PLAN_NETWORK_DESTINATION_CHANGED');
      if (networkEntries(raw).some(([, id]) => id === '')) {
        const after = await this.#inspect(raw.Id);
        current();
        if (
          !isDeepStrictEqual(raw.Config, after.Config) ||
          !isDeepStrictEqual(raw.HostConfig, after.HostConfig) ||
          // Inspect enumerates mounts from a map. Reuse the full canonical
          // mount fingerprint, including duplicate-destination refusal.
          boxedOriginal(raw, rowSubject(row), this.deployment, true).mountDigest !==
            boxedOriginal(after, rowSubject(row), this.deployment, true).mountDigest ||
          !isDeepStrictEqual(raw.State, after.State) ||
          !isDeepStrictEqual(raw.NetworkSettings, after.NetworkSettings)
        )
          refuse('DOCKER_PLAN_NETWORK_DESTINATION_CHANGED');
      }
    }
    this.#requireCapsuleMounts(raw);
    if (
      raw.Image !== row.workerImage.imageId ||
      labels?.['reverie.boxed.box'] !== this.boxId ||
      raw.Config.User !== source.Config.User ||
      !isDeepStrictEqual(raw.Config.Env, desired.Env) ||
      labels?.['reverie.boxed.source'] !== row.original.containerId ||
      labels['reverie.boxed.generation'] !== String(row.request.sessionGeneration) ||
      !isDeepStrictEqual(raw.Config.Entrypoint, desired.Entrypoint) ||
      (raw.Config.Cmd?.length ?? 0) !== 0 ||
      raw.HostConfig.Memory !== row.policy.memoryMaxBytes ||
      raw.HostConfig.MemorySwap !== row.policy.memoryMaxBytes + row.policy.swapMaxBytes ||
      raw.HostConfig.PidsLimit !== row.policy.pidsMax ||
      raw.HostConfig.CgroupParent !== row.pool?.cgroupParent ||
      (gpuProfile !== undefined &&
        !isDeepStrictEqual(raw.HostConfig.DeviceRequests, (desired.HostConfig as Record<string, unknown>).DeviceRequests)) ||
      !isDeepStrictEqual(raw.HostConfig.Mounts, (desired.HostConfig as Record<string, unknown>).Mounts) ||
      dockerContinuationDigest(boxedStorageMounts(raw)) !== row.original.storageDigest
    )
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    if (row.destination && raw.Id !== row.destination.containerId) refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    return raw;
  }
  /** Fixed metadata bracket for owner leaf revisions, not provider/paid admission. */
  async verifyResourceDestination(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    current();
    if (!row.destination || !['provider-issued', 'ready'].includes(row.phase))
      refuse('DOCKER_RESOURCE_REVISION_CHANGED');
    const raw = await this.#destination(row, () => {}, true);
    current();
    if (
      !raw?.State.Running ||
      !isDeepStrictEqual(boxedOriginal(raw, rowSubject(row), this.deployment, true), row.destination)
    )
      refuse('DOCKER_RESOURCE_REVISION_DESTINATION_CHANGED');
  }
  async observeDestination(row: DockerEmployeeContinuationRecord): Promise<DockerContainerObservation | null> {
    const raw = await this.#destination(row, () => {}, true);
    if (!raw) return null;
    const original = boxedOriginal(raw, rowSubject(row), this.deployment, true);
    if (row.destination && !isDeepStrictEqual(original, row.destination))
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    const provider = raw.State.Running ? await this.#provider(original, row) : { kind: 'absent' as const };
    let credentialDigest: string | null = null;
    let recoveredCredential = false;
    if (raw.State.Running) {
      // Read-only self verification of the fixed capsule outside private /nix.
      // This is not a provider launch, native grant or callback readiness claim.
      await this.command.run([
        'exec',
        raw.Id,
        '/opt/reverie-worker-client/bin/reverie',
        'worker-client',
        'status',
        '--expected-digest',
        row.workerImage.clientManifestDigest,
      ]);
      if (row.version === 3) {
        // Initial installation belongs to the private PlanMoves actor. Existing
        // provider observations re-earn its retained helper and guest receipt;
        // the old global credential file is never a replacement fallback.
        if (['provider-issued', 'ready'].includes(row.phase)) {
          const digest = dockerContinuationDigest(row);
          const current = () => {
            if (dockerContinuationDigest(row) !== digest) refuse('DOCKER_PLAN_INSTALL_BINDING_CHANGED');
          };
          credentialDigest = (await this.#observePlanInstaller(row, current)).live.tokenDigest;
        }
      } else if (['identity-issued', 'identity-ready', 'provider-issued', 'ready'].includes(row.phase)) {
        const retainedRead =
          ['provider-issued', 'ready'].includes(row.phase) &&
          !!this.verifyExistingCredential && await this.#credentials.originalInstallerAbsent(row);
        const installed = retainedRead ? null : await this.#credentials.observe(row);
        if (installed !== null || retainedRead) {
          const readback = parseWorkerCredentialReadback(
            await this.command.run([
              'exec',
              '--env',
              'REVERIE_SESSION_ID=' + row.request.sessionId,
              '--env',
              'REVERIE_WORKER_IDENTITY_FILE=/home/agent/.reverie/docker-worker-identity',
              raw.Id,
              '/opt/reverie-worker-client/bin/reverie',
              'worker-client',
              'credential-status',
              '--expected-digest',
              row.workerImage.clientManifestDigest,
            ]),
            row.workerImage.clientManifestDigest,
            row.request.sessionId
          );
          if (retainedRead) {
            if (!this.verifyExistingCredential!(row, readback.tokenDigest) ||
              !await this.#credentials.originalInstallerAbsent(row))
              refuse('DOCKER_CONTINUATION_IDENTITY_READBACK_CHANGED');
          } else if (readback.tokenDigest !== installed) refuse('DOCKER_CONTINUATION_IDENTITY_READBACK_CHANGED');
          credentialDigest = readback.tokenDigest;
          recoveredCredential = retainedRead;
        }
      }
      if (row.destination) {
        await this.#storage.verifyDestination(row);
        await this.#ephemeral?.verifyDestination(row);
      }
    }
    const resources = raw.State.Running ? await this.resources.read(row) : null;
    const after = await this.#destination(row, () => {}, true);
    if (!after || !isDeepStrictEqual(containerReadState(after), containerReadState(raw)))
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
    if (recoveredCredential && (!await this.#credentials.originalInstallerAbsent(row) ||
      !this.verifyExistingCredential!(row, credentialDigest!)))
      refuse('DOCKER_CONTINUATION_IDENTITY_READBACK_CHANGED');
    return {
      original,
      state: raw.State.Running ? 'running' : 'stopped',
      provider,
      resources,
      credentialDigest,
    };
  }
  async start(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const raw = await this.#destination(row);
    current();
    if (!raw || !row.destination || raw.State.Running) refuse('DOCKER_CONTINUATION_STOPPED_DESTINATION_REQUIRED');
    await this.#ephemeral?.require(row);
    current();
    this.assertPreparationCurrent(row);
    await this.command.run(['container', 'start', raw.Id]);
  }
  async observeCodexWorkspace(
    row: DockerEmployeeContinuationRecord,
    workingDir: string,
    current: () => void
  ): Promise<DockerCodexWorkspace> {
    if (
      !workingDir.startsWith('/') ||
      /[\0\r\n]/.test(workingDir) ||
      workingDir.split('/').includes('..') ||
      workingDir.length > 4096
    )
      refuse('DOCKER_CONTINUATION_WORKSPACE_CHANGED');
    const checked = DockerEmployeeContinuationRecord.parse(row),
      digest = dockerContinuationDigest(checked);
    const inspect = async () => {
      current();
      if (dockerContinuationDigest(row) !== digest || checked.phase !== 'provider-issued' || !checked.destination)
        refuse('DOCKER_CONTINUATION_WORKSPACE_CHANGED');
      const raw = await this.#destination(checked);
      current();
      if (
        !raw?.State.Running ||
        !isDeepStrictEqual(boxedOriginal(raw, rowSubject(checked), this.deployment, true), checked.destination)
      )
        refuse('DOCKER_CONTINUATION_WORKSPACE_CHANGED');
      return raw;
    };
    const before = await inspect();
    const mounts = before.Mounts.filter(
      (m) => workingDir === m.Destination || workingDir.startsWith(m.Destination + '/')
    ).sort((a, b) => b.Destination.length - a.Destination.length);
    const mount = mounts[0];
    if (
      !mount ||
      mount.Type !== 'bind' ||
      !mount.Source ||
      mount.Destination === '/' ||
      mount.Destination.startsWith('/proc')
    )
      refuse('DOCKER_CONTINUATION_WORKSPACE_MOUNT_REQUIRED');
    current();
    const text = await this.command.run([
      'exec',
      ...DOCKER_PROVIDER_VIEW_ENV,
      checked.destination!.containerId,
      '/opt/reverie-worker-client/bin/node',
      '--input-type=commonjs',
      '-e',
      DOCKER_CODEX_WORKSPACE_PROGRAM,
      '--',
      'observe',
      workingDir,
      mount.Destination,
    ]);
    current();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) refuse('DOCKER_CONTINUATION_WORKSPACE_CHANGED');
    const result = z
      .object({
        realPath: z.string().max(4096),
        dev: z.string().regex(/^[0-9]{1,20}$/),
        ino: z.string().regex(/^[1-9][0-9]{0,19}$/),
        hooksText: z
          .string()
          .max(1024 * 1024)
          .nullable(),
      })
      .strict()
      .parse(JSON.parse(text));
    if (
      !(result.realPath === mount.Destination || result.realPath.startsWith(mount.Destination + '/')) ||
      /[\0\r\n]/.test(result.realPath)
    )
      refuse('DOCKER_CONTINUATION_WORKSPACE_CHANGED');
    await inspect();
    current();
    return Object.freeze(result);
  }
  /** Metadata/kernel reads only: no resources, credentials, helpers or provider effects. */
  async captureProviderHealth(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    current: () => void
  ): Promise<DockerEmployeeProviderHealthProof> {
    const checked = DockerEmployeeContinuationRecord.parse(row),
      b = DockerEmployeeBinding.parse(binding),
      digest = dockerContinuationDigest(checked),
      hooks = this.providerHooks(checked);
    let revoked = false,
      livePreparation = false;
    const requireCurrent = () => {
      if (revoked) refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      try {
        current();
        this.#publishedRead(checked);
        if (livePreparation) this.assertPreparationCurrent(checked);
        if (dockerContinuationDigest(row) !== digest || !isDeepStrictEqual(this.providerHooks(checked), hooks))
          refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      } catch (error) {
        revoked = true;
        throw error;
      }
    };
    requireCurrent();
    if (
      !checked.destination ||
      b.containerId !== checked.destination.containerId ||
      b.imageId !== checked.workerImage.imageId ||
      b.operationId !== checked.request.operationId ||
      b.sessionId !== checked.request.sessionId ||
      b.sessionGeneration !== checked.request.sessionGeneration ||
      b.credentialId !== checked.credentialId ||
      b.originalDigest !== dockerContinuationDigest(checked.destination) ||
      b.policyDigest !== dockerContinuationDigest(checked.policy)
    )
      refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
    if (checked.phase !== 'provider-issued' && checked.phase !== 'ready')
      refuse('DOCKER_CONTINUATION_READY_PROVIDER_REQUIRED');
    const sameRow = this.#reattached.get(checked.employeeId);
    const reattached = sameRow?.row === digest ? sameRow : undefined;
    let initialState: ReturnType<typeof containerReadState> | undefined;
    const inspect = async () => {
      requireCurrent();
      const raw = reattached
        ? await this.#boundDestination(checked, requireCurrent, true)
        : await this.#destination(checked, requireCurrent, true);
      requireCurrent();
      if (
        !raw ||
        !boundDestinationMatches(raw, checked, this.deployment, !!reattached) ||
        raw.State.Paused ||
        raw.State.Restarting ||
        raw.State.Dead
      )
        refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      if (initialState && !isDeepStrictEqual(initialState, containerReadState(raw)))
        refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      initialState ??= containerReadState(raw);
      if (reattached && raw.State.Running && !isDeepStrictEqual(initialState, reattached.state))
        refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      return raw;
    };
    const firstContainer = await inspect();
    if (!firstContainer.State.Running) {
      const second = await inspect();
      if (second.State.Running || firstContainer.State.Pid !== 0 || second.State.Pid !== 0)
        refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      return new DockerEmployeeProviderHealthProof(
        healthOrigin,
        b,
        checked.employeeId,
        checked.owner,
        'stopped',
        requireCurrent
      );
    }
    const pane = async () => {
      requireCurrent();
      const text = await this.command.run([
        'exec',
        ...DOCKER_PROVIDER_VIEW_ENV,
        b.containerId,
        '/opt/reverie-worker-client/bin/node',
        '--input-type=commonjs',
        '-e',
        DOCKER_PROVIDER_VIEW_PROGRAM,
        '--',
        ...dockerProviderRuntimeArguments(checked.version === 3 ? checked.planReplacement.runtimeNamespace : undefined),
        'presence',
        b.sessionId,
        b.operationId,
        hooks.kind,
      ]);
      requireCurrent();
      if (text === 'ABSENT\n') return null;
      if (Buffer.byteLength(text) > 1024) refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      const value = providerPane.parse(JSON.parse(text));
      if (value.hooks.kind !== hooks.kind) refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
      return value;
    };
    const first = await pane(),
      middle = await inspect();
    if (!middle.State.Running) refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
    const second = await pane(),
      last = await inspect();
    if (!last.State.Running || !isDeepStrictEqual(first, second)) refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
    requireCurrent();
    if (first === null)
      return new DockerEmployeeProviderHealthProof(
        healthOrigin,
        b,
        checked.employeeId,
        checked.owner,
        'absent',
        requireCurrent
      );
    if (reattached) {
      await this.#ephemeral!.verifyExistingDestination(checked, last, requireCurrent);
      requireCurrent();
    } else if (this.#ephemeral) {
      // LIVE may expose a retained private view. Re-earn actual leaf custody
      // read-only after restart; no preparation or helper effect is allowed.
      await this.#ephemeral.verifyDestination(checked);
      livePreparation = true;
      requireCurrent();
    }
    if (checked.version === 3 && !reattached) {
      await this.#observePlanInstaller(checked, requireCurrent);
      requireCurrent();
    }
    if (this.#ephemeral || checked.version === 3) {
      // The added metadata await must not turn an earlier Native observation
      // into a stale live proof. Bind the same current provider again.
      const confirmed = await pane(),
        container = await inspect();
      requireCurrent();
      if (!container.State.Running || !isDeepStrictEqual(first, confirmed))
        refuse('DOCKER_CONTINUATION_PROVIDER_HEALTH_CHANGED');
    }
    const view = new DockerEmployeeProviderView(
      providerViewOrigin,
      {
        ...first,
        mode: hooks.mode,
        hooks: first.hooks.kind === 'none' ? { kind: 'none', mode: hooks.mode } : first.hooks,
        employeeId: checked.employeeId,
        containerId: b.containerId,
        imageId: b.imageId,
        operationId: b.operationId,
        sessionId: b.sessionId,
        sessionGeneration: b.sessionGeneration,
        clientManifestDigest: checked.workerImage.clientManifestDigest,
        ...(checked.version === 3
          ? {
              planReplacement: dockerPlanProviderSelection(checked.planReplacement),
            }
          : {}),
      },
      requireCurrent
    );
    return new DockerEmployeeProviderHealthProof(
      healthOrigin,
      b,
      checked.employeeId,
      checked.owner,
      'live',
      requireCurrent,
      view
    );
  }
  /** Existing provider reads only. Never configure, begin, identity or paid launch authority. */
  existingResourcePolicyCurrent(
    row: DockerEmployeeContinuationRecord,
    actual: DockerEmployeeResourcePolicy | null
  ): boolean {
    if (!actual) return false;
    if (isDeepStrictEqual(actual, row.policy)) return true;
    requireDockerEffectiveResourceProof(this.resources.existingPolicy?.(row, actual), row, actual);
    return true;
  }
  /** Canonical mode chooses only the hook requirement; it grants no native/view authority. */
  private providerHooks(row: DockerEmployeeContinuationRecord): {
    mode: string;
    kind: 'none' | 'generation';
    capability: 'none' | 'always' | 'supervised';
  } {
    const policy = dockerProviderHookPolicy(this.providerMode(row));
    if (!policy) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
    return policy;
  }
  async #reattachCredential(
    row: DockerEmployeeContinuationRecord,
    home: DockerCredentialHome & { readonly originalHomeDev: string },
    current: () => void,
    canonicalAuthDigest?: string
  ): Promise<string> {
    const task = this.journal.read(row, 'identity-helper');
    if (!row.destination || task?.phase !== 'completed' || task.imageId !== row.workerImage.imageId ||
      task.name !== 'reverie-boxed-identity-' + dockerContinuationDigest([this.boxId, 'identity-helper', row.request.operationId]))
      refuse('DOCKER_CONTINUATION_REATTACH_IDENTITY_UNCONFIRMED');
    const cid = row.destination.containerId, manifest = row.workerImage.clientManifestDigest;
    const client = ['/opt/reverie-worker-client/bin/reverie', 'worker-client'];
    current();
    await this.command.run(['exec', cid, ...client, 'status', '--expected-digest', manifest]);
    current();
    if (row.version === 3) {
      const account = row.planReplacement.account;
      const body = await this.command.run([
        'exec', cid, ...client, 'plan-status', '--expected-digest', manifest,
        '--projection-digest', account.projectionDigest, '--operation', row.request.operationId,
        '--container-id', cid, '--read-mode', 'live', '--home-dev', home.dev, '--home-ino', home.ino,
      ]);
      current();
      if (Buffer.byteLength(body) > 8192) refuse('DOCKER_CONTINUATION_REATTACH_IDENTITY_UNCONFIRMED');
      const live = DockerPlanLiveReceipt.parse(parseBoxedConfigurationJson(body));
      if (live.operationId !== row.request.operationId || live.sessionId !== row.request.sessionId ||
        live.containerId !== cid || live.projectionDigest !== account.projectionDigest ||
        live.accountId !== account.id || live.provider !== account.provider ||
        live.contextInputDigest !== account.contextDigest || live.homeDev !== home.dev ||
        live.homeIno !== home.ino || live.configDev !== home.dev)
        refuse('DOCKER_CONTINUATION_REATTACH_IDENTITY_UNCONFIRMED');
      // The installer ran on the held HOME filesystem. Recover its exact
      // recorded digest from the current capsule metadata and original device.
      const initial = DockerPlanInitialReceipt.parse({
        ...live, purpose: 'reverie-plan-installed-v1', readMode: 'initial',
        homeDev: home.originalHomeDev, configDev: home.originalHomeDev,
        observedAuthDigest: live.installedAuthDigest, observedContextDigest: live.contextDigest,
      });
      if (task.resultDigest !== dockerContinuationDigest(initial))
        refuse('DOCKER_CONTINUATION_REATTACH_IDENTITY_UNCONFIRMED');
      if (canonicalAuthDigest !== undefined &&
          (live.installedAuthDigest !== canonicalAuthDigest || live.observedAuthDigest !== canonicalAuthDigest))
        refuse('DOCKER_PLAN_ACCOUNT_AUTH_CHANGED');
      return live.tokenDigest;
    }
    const live = parseWorkerCredentialReadback(await this.command.run([
      'exec', '--env', 'REVERIE_SESSION_ID=' + row.request.sessionId,
      '--env', 'REVERIE_WORKER_IDENTITY_FILE=/home/agent/.reverie/docker-worker-identity',
      cid, ...client, 'credential-status', '--expected-digest', manifest,
    ]), manifest, row.request.sessionId);
    current();
    if (task.resultDigest !== dockerContinuationDigest({
      version: 1, purpose: 'reverie-worker-credential-installed-v1',
      manifestDigest: manifest, sessionId: row.request.sessionId, tokenDigest: live.tokenDigest,
      homeDev: home.originalHomeDev, homeIno: home.ino,
    })) refuse('DOCKER_CONTINUATION_REATTACH_IDENTITY_UNCONFIRMED');
    return live.tokenDigest;
  }
  /** Reobserve one canonically bound, already running pane after a lost
   * storage-holder process. This never resolves or replays a prior effect. */
  async captureReattachedProviderView(
    row: DockerEmployeeContinuationRecord,
    policy: DockerEmployeeResourcePolicy,
    helper: DockerWorkerReattachHelper,
    current: () => void,
    canonicalAuthDigest?: string
  ): Promise<DockerEmployeeProviderView | 'stopped' | undefined> {
    current();
    const checked = DockerEmployeeContinuationRecord.parse(row);
    if (!checked.destination || !['ready', 'provider-issued'].includes(checked.phase)) return;
    const raw = await this.#boundDestination(checked, current, true);
    if (!raw.State.Running) {
      current();
      return raw.State.Status === 'exited' && raw.State.Pid === 0 &&
        !raw.State.Restarting && !raw.State.Paused && !raw.State.Dead ? 'stopped' : undefined;
    }
    const state = containerReadState(raw);
    const home = await this.#storage.readExistingReference(checked, raw, (destination, seen) =>
      helper.storage(destination, seen, current), current);
    if (!home) return;
    if (!this.resources.readExistingAfterHostRestart || !this.#ephemeral ||
      this.journal.read(checked, 'leaf-helper')?.phase !== 'completed')
      refuse('DOCKER_CONTINUATION_REATTACH_POLICY_UNCONFIRMED');
    const tokenDigest = await this.#reattachCredential(checked, home, current, canonicalAuthDigest);
    await helper.credential(checked, tokenDigest, current);
    await this.#ephemeral.verifyExistingDestination(checked, raw, current);
    current();
    const limits = await this.resources.readExistingAfterHostRestart(checked, policy, current);
    current();
    if (!isDeepStrictEqual(limits, policy)) refuse('DOCKER_CONTINUATION_REATTACH_POLICY_UNCONFIRMED');
    const view = await this.#captureProviderView(row, current, state);
    current();
    this.#reattached.set(checked.employeeId, { row: dockerContinuationDigest(checked), state });
    return view;
  }
  captureProviderView(row: DockerEmployeeContinuationRecord, current: () => void): Promise<DockerEmployeeProviderView> {
    return this.#captureProviderView(row, current);
  }
  async #captureProviderView(
    row: DockerEmployeeContinuationRecord,
    current: () => void,
    reattached?: ReturnType<typeof containerReadState>
  ): Promise<DockerEmployeeProviderView> {
    const checked = DockerEmployeeContinuationRecord.parse(row);
    const digest = dockerContinuationDigest(checked),
      hooks = this.providerHooks(checked);
    let revoked = false;
    const requireCurrent = () => {
      if (revoked) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      try {
        current();
        this.#publishedRead(checked);
        this.assertPreparationCurrent(checked);
        if (dockerContinuationDigest(row) !== digest || !isDeepStrictEqual(this.providerHooks(checked), hooks))
          refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      } catch (cause) {
        revoked = true;
        throw cause;
      }
    };
    requireCurrent();
    if (!['ready', 'provider-issued'].includes(checked.phase) || !checked.destination)
      refuse('DOCKER_CONTINUATION_READY_PROVIDER_REQUIRED');
    if (!reattached && checked.version === 3) {
      await this.#observePlanInstaller(checked, requireCurrent);
      requireCurrent();
    }
    if (!reattached && checked.phase === 'provider-issued') {
      // A retained dispatch fence grants no attachment. Earn every original
      // storage/credential/resource observation before the private native view.
      const seen = await DockerEmployeeEngine.prototype.observeDestination.call(this, checked);
      requireCurrent();
      if (
        !seen ||
        seen.state !== 'running' ||
        seen.provider.kind !== 'running' ||
        seen.provider.sessionId !== checked.request.sessionId ||
        seen.provider.operationId !== checked.request.operationId ||
        !this.existingResourcePolicyCurrent(checked, seen.resources) ||
        !/^[a-f0-9]{64}$/.test(seen.credentialDigest ?? '')
      )
        refuse('DOCKER_CONTINUATION_EXISTING_PROVIDER_UNCONFIRMED');
    }
    let initialState = reattached;
    const inspect = async () => {
      requireCurrent();
      const raw = reattached
        ? await this.#boundDestination(checked, requireCurrent, true)
        : await this.#destination(checked, requireCurrent, true);
      requireCurrent();
      if (
        !raw?.State.Running ||
        !boundDestinationMatches(raw, checked, this.deployment, !!reattached)
      )
        refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      if (initialState && !isDeepStrictEqual(initialState, containerReadState(raw)))
        refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      initialState ??= containerReadState(raw);
      return raw;
    };
    const pane = async () => {
      requireCurrent();
      const raw = await this.command.run([
        'exec',
        ...DOCKER_PROVIDER_VIEW_ENV,
        checked.destination!.containerId,
        '/opt/reverie-worker-client/bin/node',
        '--input-type=commonjs',
        '-e',
        DOCKER_PROVIDER_VIEW_PROGRAM,
        '--',
        ...dockerProviderRuntimeArguments(checked.version === 3 ? checked.planReplacement.runtimeNamespace : undefined),
        'observe',
        checked.request.sessionId,
        checked.request.operationId,
        hooks.kind,
      ]);
      requireCurrent();
      if (Buffer.byteLength(raw) > 1024) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      const value = providerPane.parse(JSON.parse(raw));
      if (value.hooks.kind !== hooks.kind) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      return value;
    };
    if (!reattached) await this.#ephemeral?.verifyDestination(checked);
    requireCurrent();
    await inspect();
    const first = await pane();
    await inspect();
    const second = await pane();
    await inspect();
    requireCurrent();
    if (!isDeepStrictEqual(first, second)) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
    return new DockerEmployeeProviderView(
      providerViewOrigin,
      {
        ...first,
        mode: hooks.mode,
        hooks: first.hooks.kind === 'none' ? { kind: 'none', mode: hooks.mode } : first.hooks,
        employeeId: checked.employeeId,
        containerId: checked.destination.containerId,
        imageId: checked.workerImage.imageId,
        operationId: checked.request.operationId,
        sessionId: checked.request.sessionId,
        sessionGeneration: checked.request.sessionGeneration,
        clientManifestDigest: checked.workerImage.clientManifestDigest,
        ...(checked.version === 3
          ? {
              planReplacement: dockerPlanProviderSelection(checked.planReplacement),
            }
          : {}),
      },
      requireCurrent
    );
  }
  async configureResources(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const raw = await this.#destination(row);
    current();
    if (!raw?.State.Running) refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    await this.resources.configure(row, current);
  }
  /** Journal metadata only: a started resource writer proved terminal and failed. */
  async settleResourceWriter(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const raw = await this.#destination(row);
    current();
    if (!raw?.State.Running) refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    await this.resources.settleFailedWriter?.(row, current);
  }
  async provisionIdentity(row: DockerEmployeeContinuationRecord, token: string, current: () => void): Promise<void> {
    const raw = await this.#destination(row);
    current();
    if (!raw?.State.Running) refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    if (token.length > 2048 || /[\r\n\0]/.test(token)) refuse('DOCKER_CONTINUATION_IDENTITY_INVALID');
    await this.#credentials.provision(row, token, current);
  }

  async #provider(
    original: DockerEmployeeOriginal,
    row: DockerEmployeeContinuationRecord
  ): Promise<DockerContainerObservation['provider']> {
    const hooks = this.providerHooks(row);
    const output = await this.command.run([
      'exec',
      ...DOCKER_PROVIDER_VIEW_ENV,
      original.containerId,
      '/opt/reverie-worker-client/bin/node',
      '--input-type=commonjs',
      '-e',
      DOCKER_PROVIDER_VIEW_PROGRAM,
      '--',
      ...dockerProviderRuntimeArguments(row.version === 3 ? row.planReplacement.runtimeNamespace : undefined),
      'presence',
      original.sessionId,
      row.request.operationId,
      hooks.kind,
    ]);
    if (!isDeepStrictEqual(this.providerHooks(row), hooks)) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
    if (output === 'ABSENT\n') return { kind: 'absent' };
    if (Buffer.byteLength(output) > 1024) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
    if (providerPane.parse(JSON.parse(output)).hooks.kind !== hooks.kind)
      refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
    return {
      kind: 'running',
      operationId: row.request.operationId,
      sessionId: original.sessionId,
    };
  }
}
