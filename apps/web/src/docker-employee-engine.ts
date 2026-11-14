import { DockerEmployeeCredentialInstaller } from './docker-employee-credential-installer.js';
/** Fixed adapter for a new boxed destination; the old laptop is read-only.
 * Resource helpers earn fresh original FD/cgroup proof inside their owning port.
 */
import { parseWorkerCredentialReadback } from './worker-client-manifest.js';
import { DockerEmployeeStorage } from './docker-employee-storage.js';
import type { DockerContinuationTaskJournal } from './docker-continuation-task.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
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
  boxedMountConfiguration,
  boxedStorageMounts,
  dockerEngineRefuse as refuse,
} from './docker-employee-engine-data.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import type { SessionDocker } from './types.js';
import { DOCKER_PROVIDER_VIEW_ENV, DOCKER_PROVIDER_VIEW_PROGRAM } from './docker-employee-provider-view-native.js';
export { PackagedDockerEngineCommand, type DockerEngineCommand } from './docker-engine-command.js';
export interface DockerContainedResourceController {
  validate(original: DockerEmployeeOriginal, policy: DockerEmployeeResourcePolicy): Promise<void>;
  preparePool(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
  observePool(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeePool | null>;
  read(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeResourcePolicy | null>;
  configure(row: DockerEmployeeContinuationRecord, requireCurrent: () => void): Promise<void>;
}
export interface DockerEmployeeImageConfiguration {
  readonly imageId: string;
  readonly clientManifestDigest: string;
  /** Accepted actual source base image IDs. No runtime request can add a base. */
  readonly sourceImageIds: readonly string[];
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const providerViewOrigin = Symbol('original Engine-observed Docker provider view');
const providerPane = z
  .object({
    paneId: z.string().regex(/^%[0-9]{1,10}$/),
    panePid: z.number().int().positive().max(2147483647),
    paneStartTicks: z.string().regex(/^[1-9][0-9]{0,19}$/),
    hookGeneration: z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/),
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
  readonly hookGeneration: string;
  readonly clientManifestDigest: string;
}
/** A private observer admission. It grants no provider creation or relaunch. */
export class DockerEmployeeProviderView {
  readonly #descriptor: Readonly<DockerEmployeeProviderViewDescriptor>;
  readonly #current: () => void;
  constructor(origin: symbol, descriptor: DockerEmployeeProviderViewDescriptor, current: () => void) {
    if (origin !== providerViewOrigin) throw Error('Original Engine provider view required');
    this.#descriptor = Object.freeze({ ...descriptor });
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
function rowSubject(row: DockerEmployeeContinuationRecord): DockerContinuationSubject {
  return {
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    owner: row.owner,
    sourceDigest: row.sourceDigest,
    onVacation: false,
    desiredRunning: true,
  };
}
export class DockerEmployeeEngine implements DockerContinuationEngine {
  readonly #storage: DockerEmployeeStorage;
  readonly #credentials: DockerEmployeeCredentialInstaller;
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly deployment: string,
    private readonly resources: DockerContainedResourceController,
    private readonly workerImage: DockerEmployeeImageConfiguration,
    journal: DockerContinuationTaskJournal,
    helperImageId: string,
    private readonly boxId: string
  ) {
    this.#storage = new DockerEmployeeStorage(command, journal, helperImageId, (row) => this.#source(row), boxId);
    this.#credentials = new DockerEmployeeCredentialInstaller(
      command,
      journal,
      (row) => this.#storage.credentialHome(row),
      boxId
    );
    if (!/^[a-f0-9]{64}$/.test(boxId)) throw Error('Fixed boxed namespace required');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(deployment)) throw Error('Registered deployment required');
    if (!/^sha256:[a-f0-9]{64}$/.test(workerImage.imageId) || !/^[a-f0-9]{64}$/.test(workerImage.clientManifestDigest))
      throw Error('Fixed qualified worker image required');
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
    const raw = await this.#inspect(row.original.containerId);
    if (raw.State.Running || !isDeepStrictEqual(boxedOriginal(raw, rowSubject(row), this.deployment), row.original))
      refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
    return raw;
  }
  #requireCapsuleMounts(raw: DockerEmployeeInspect): void {
    for (const mount of raw.Mounts) {
      for (const prefix of ['/opt/reverie-worker-tools', '/opt/reverie-worker-client']) {
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
    const rows = z
      .array(
        z.object({
          Id: z.string(),
          RootFS: z.object({ Layers: z.array(z.string()) }),
          Config: z.object({
            Entrypoint: z.array(z.string()).nullable(),
            Cmd: z.array(z.string()).nullable(),
            Labels: z.record(z.string(), z.string()).nullable(),
          }),
        })
      )
      .length(1);
    const source = rows.parse(JSON.parse(await this.command.run(['image', 'inspect', original.imageId])))[0]!;
    const target = rows.parse(JSON.parse(await this.command.run(['image', 'inspect', this.workerImage.imageId])))[0]!;
    if (
      source.Id !== original.imageId ||
      target.Id !== this.workerImage.imageId ||
      source.RootFS.Layers.some((layer, index) => target.RootFS.Layers[index] !== layer) ||
      target.Config.Labels?.['org.reverie.worker-client.manifest'] !== this.workerImage.clientManifestDigest
    )
      refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
    return DockerEmployeeWorkerImage.parse({
      imageId: target.Id,
      sourceImageId: source.Id,
      clientManifestDigest: this.workerImage.clientManifestDigest,
    });
  }
  async observeSource(subject: DockerContinuationSubject, containerId?: string) {
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
    const raw = await this.#inspect(cid),
      original = boxedOriginal(raw, subject, this.deployment);
    return { original, state: raw.State.Running ? ('running' as const) : ('stopped' as const) };
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
  prepareStorage(row: DockerEmployeeContinuationRecord, current: () => void) {
    return this.#storage.prepare(row, current);
  }
  observeStorage(row: DockerEmployeeContinuationRecord) {
    return this.#storage.observe(row);
  }
  preparePool(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    return this.resources.preparePool(row, current);
  }
  observePool(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeePool | null> {
    return this.resources.observePool(row);
  }
  #configuration(row: DockerEmployeeContinuationRecord, source: DockerEmployeeInspect): Record<string, unknown> {
    this.#requireCapsuleMounts(source);
    if (!row.pool) refuse('DOCKER_CONTINUATION_POOL_UNCONFIRMED');
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
    Object.assign(host, {
      Privileged: false,
      AutoRemove: false,
      RestartPolicy: { Name: 'no' },
      Mounts: boxedMountConfiguration(source),
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
    return {
      Image: row.workerImage.imageId,
      User: source.Config.User,
      Entrypoint: ['/opt/reverie/perf/bin/reverie-worker-init'],
      Cmd: [],
      Env: environment,
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
      },
      HostConfig: host,
    };
  }
  async createDestination(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const source = await this.#source(row);
    await this.image(row.original);
    current();
    const pool = await this.resources.observePool(row);
    current();
    if (!pool || !isDeepStrictEqual(pool, row.pool)) refuse('DOCKER_CONTINUATION_POOL_CHANGED');
    const config = this.#configuration(row, source);
    current();
    await this.command.create(
      'reverie-boxed-' + dockerContinuationDigest([this.boxId, 'destination', row.request.operationId]),
      config,
      current
    );
  }
  async #destination(row: DockerEmployeeContinuationRecord): Promise<DockerEmployeeInspect | null> {
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
    if (selected.trim() === '') return null;
    if (!/^[a-f0-9]{64}$/.test(selected.trim())) refuse('DOCKER_CONTINUATION_DESTINATION_AMBIGUOUS');
    const raw = await this.#inspect(selected.trim()),
      source = await this.#source(row),
      desired = this.#configuration(row, source);
    const labels = raw.Config.Labels;
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
      !isDeepStrictEqual(raw.HostConfig.Mounts, (desired.HostConfig as Record<string, unknown>).Mounts) ||
      dockerContinuationDigest(boxedStorageMounts(raw)) !== row.original.storageDigest
    )
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    if (row.destination && raw.Id !== row.destination.containerId) refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    return raw;
  }
  async observeDestination(row: DockerEmployeeContinuationRecord): Promise<DockerContainerObservation | null> {
    const raw = await this.#destination(row);
    if (!raw) return null;
    const original = boxedOriginal(raw, rowSubject(row), this.deployment, true);
    if (row.destination && !isDeepStrictEqual(original, row.destination))
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED');
    const provider = raw.State.Running ? await this.#provider(original) : { kind: 'absent' as const };
    let credentialDigest: string | null = null;
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
      if (['identity-issued', 'identity-ready', 'provider-issued', 'ready'].includes(row.phase)) {
        const installed = await this.#credentials.observe(row);
        if (installed !== null) {
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
          if (readback.tokenDigest !== installed) refuse('DOCKER_CONTINUATION_IDENTITY_READBACK_CHANGED');
          credentialDigest = readback.tokenDigest;
        }
      }
      if (row.destination) await this.#storage.verifyDestination(row);
    }
    const resources = raw.State.Running ? await this.resources.read(row) : null;
    const after = await this.#destination(row);
    if (!after || after.State.Running !== raw.State.Running)
      refuse('DOCKER_CONTINUATION_DESTINATION_CHANGED_DURING_READ');
    return { original, state: raw.State.Running ? 'running' : 'stopped', provider, resources, credentialDigest };
  }
  async start(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const raw = await this.#destination(row);
    current();
    if (!raw || !row.destination || raw.State.Running) refuse('DOCKER_CONTINUATION_STOPPED_DESTINATION_REQUIRED');
    await this.command.run(['container', 'start', raw.Id]);
  }
  async captureProviderView(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<DockerEmployeeProviderView> {
    const checked = DockerEmployeeContinuationRecord.parse(row);
    const digest = dockerContinuationDigest(checked);
    let revoked = false;
    const requireCurrent = () => {
      if (revoked) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      try {
        current();
        if (dockerContinuationDigest(row) !== digest) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      } catch (cause) {
        revoked = true;
        throw cause;
      }
    };
    requireCurrent();
    if (checked.phase !== 'ready' || !checked.destination) refuse('DOCKER_CONTINUATION_READY_PROVIDER_REQUIRED');
    const inspect = async () => {
      requireCurrent();
      const raw = await this.#destination(checked);
      requireCurrent();
      if (
        !raw?.State.Running ||
        !isDeepStrictEqual(boxedOriginal(raw, rowSubject(checked), this.deployment, true), checked.destination)
      )
        refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
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
        'inspect',
        checked.request.sessionId,
        checked.request.operationId,
      ]);
      requireCurrent();
      if (Buffer.byteLength(raw) > 1024) refuse('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
      return providerPane.parse(JSON.parse(raw));
    };
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
        employeeId: checked.employeeId,
        containerId: checked.destination.containerId,
        imageId: checked.workerImage.imageId,
        operationId: checked.request.operationId,
        sessionId: checked.request.sessionId,
        sessionGeneration: checked.request.sessionGeneration,
        clientManifestDigest: checked.workerImage.clientManifestDigest,
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
  async provisionIdentity(row: DockerEmployeeContinuationRecord, token: string, current: () => void): Promise<void> {
    const raw = await this.#destination(row);
    current();
    if (!raw?.State.Running) refuse('DOCKER_CONTINUATION_CONTAINER_STOPPED');
    if (token.length > 2048 || /[\r\n\0]/.test(token)) refuse('DOCKER_CONTINUATION_IDENTITY_INVALID');
    await this.#credentials.provision(row, token, current);
  }

  async #provider(original: DockerEmployeeOriginal): Promise<DockerContainerObservation['provider']> {
    const name = 'reverie-dkr-' + original.sessionId;
    const output = await this.command.run([
      'exec',
      original.containerId,
      'sh',
      '-c',
      'command -v tmux >/dev/null || exit 45; if tmux -L reverie-docker has-session -t =' +
        name +
        ' 2>/dev/null; then ' +
        'tmux -L reverie-docker display-message -p -t =' +
        name +
        ' "#{pane_dead} #{pane_pid}"; ' +
        'tmux -L reverie-docker show-environment -t =' +
        name +
        ' REVERIE_DOCKER_OPERATION_ID; ' +
        'tmux -L reverie-docker show-environment -t =' +
        name +
        ' REVERIE_SESSION_ID; else printf ABSENT; fi',
    ]);
    if (output === 'ABSENT') return { kind: 'absent' };
    const match = new RegExp(
      '^0 [1-9][0-9]*\nREVERIE_DOCKER_OPERATION_ID=(' + uuid + ')\nREVERIE_SESSION_ID=(' + uuid + ')\n$'
    ).exec(output);
    return match ? { kind: 'running', operationId: match[1]!, sessionId: match[2]! } : { kind: 'unknown' };
  }
}
