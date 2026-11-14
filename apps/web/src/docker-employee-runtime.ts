import { isMultiUserMode } from './config/multiuser.js';
/** Explicit Docker-only application composition. Config and journal are DATA;
 * only actual Engine/helper observations and current Company actions permit effects. */
import fs from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CompanyService } from './company-service.js';
import type { CompanyEmployee } from './company-types.js';
import type { SessionPort, ConfigPort, InfraPort } from './web/ports/index.js';
import { DockerRuntimeKey } from './docker-runtime-key.js';
import {
  DockerWorkerIdentityAuthentication,
  dockerWorkerIdentityOf,
  type DockerWorkerIdentityBinding,
} from './docker-worker-identity.js';
import { DockerEmployeeContinuation, dockerContinuationDigest } from './docker-employee-continuation.js';
import { CompanyDockerContinuationStore } from './docker-employee-store.js';
import { DockerEmployeeEngine } from './docker-employee-engine.js';
import { DockerContainedResources } from './docker-contained-resource-controller.js';
import { PackagedDockerEngineCommand } from './docker-engine-command.js';
import { DockerEmployeeSessionProvider } from './docker-employee-session-provider.js';
import { readLegacyDockerPolicyProposal, parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
import { registerDockerEmployeeContinuationRoutes } from './web/routes/docker-employee-continuation-routes.js';
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DockerRuntimeConfiguration = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-runtime-v1'),
    deployment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    workerImageId: sha,
    clientManifestDigest: digest,
    sourceImageIds: z.array(sha).min(1).max(32),
    helperImageId: sha,
    apiUrl: z.string().url().max(2048),
  })
  .strict();
type Context = SessionPort & ConfigPort & Pick<InfraPort, 'mux'>;
interface Attached {
  company: CompanyService;
  ctx: Context;
  store: CompanyDockerContinuationStore;
  engine: DockerEmployeeEngine;
  provider: DockerEmployeeSessionProvider;
  service: DockerEmployeeContinuation;
}
function config(): { value: z.infer<typeof DockerRuntimeConfiguration>; current: () => boolean; close: () => void } {
  const path = '/etc/reverie/boxed-runtime.json',
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let closed = false;
  let closeState: { kind: 'open' | 'closing' | 'closed' } | { kind: 'failed'; cause: unknown } = { kind: 'open' };
  const stamp = (s: fs.Stats) => [s.dev, s.ino, s.uid, s.gid, s.mode, s.size, s.nlink, s.mtimeMs, s.ctimeMs].join(':');
  try {
    const before = fs.fstatSync(fd),
      identity = stamp(before);
    if (
      !before.isFile() ||
      before.size > 16384 ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      ![0, process.getuid?.()].includes(before.uid) ||
      identity !== stamp(fs.lstatSync(path))
    )
      throw Error('Boxed runtime configuration custody refused');
    const bytes = fs.readFileSync(fd),
      text = bytes.toString('utf8'),
      value = DockerRuntimeConfiguration.parse(parseBoxedConfigurationJson(text));
    const selectedApiUrl = process.env.REVERIE_API_URL;
    const apiUrl = z
      .string()
      .url()
      .max(2048)
      .parse(selectedApiUrl ?? value.apiUrl);
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error('Fixed boxed API URL required');
    if (!Buffer.from(text).equals(bytes)) throw Error('Boxed runtime configuration encoding refused');
    const current = () => {
      if (closed) return false;
      if (process.env.REVERIE_API_URL !== selectedApiUrl) {
        closed = true;
        return false;
      }
      try {
        if (identity === stamp(fs.fstatSync(fd)) && identity === stamp(fs.lstatSync(path))) return true;
      } catch {
        closed = true;
        return false;
      }
      closed = true;
      return false;
    };
    if (!current()) throw Error('Boxed runtime configuration changed');
    return {
      value: { ...value, apiUrl },
      current,
      close() {
        if (closeState.kind === 'closed') return;
        if (closeState.kind === 'failed') throw closeState.cause;
        if (closeState.kind === 'closing') throw Error('Original boxed configuration close is in progress');
        closeState = { kind: 'closing' };
        closed = true;
        try {
          fs.closeSync(fd);
          closeState = { kind: 'closed' };
        } catch (cause) {
          closeState = { kind: 'failed', cause };
          throw cause;
        }
      },
    };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch (close) {
      throw new AggregateError([error, close], 'Boxed configuration close failed');
    }
    throw error;
  }
}
const runtimeOrigin = Symbol('actual boxed runtime configuration');
export class DockerEmployeeRuntime {
  readonly authentication: DockerWorkerIdentityAuthentication;
  readonly #key: DockerRuntimeKey;
  #attached?: Attached;
  constructor(
    origin: typeof runtimeOrigin,
    private readonly selected: ReturnType<typeof config>,
    directory: string
  ) {
    if (origin !== runtimeOrigin) throw Error('Original boxed runtime configuration required');
    this.#key = new DockerRuntimeKey(directory);
    this.authentication = new DockerWorkerIdentityAuthentication(this.#key.instanceId, this.#key.key, {
      keyCurrent: () => this.current(),
      binding: (id) => this.#binding(id),
    });
  }
  current(): boolean {
    return this.selected.current() && this.#key.current();
  }
  #binding(employeeId: string): DockerWorkerIdentityBinding | undefined {
    const attached = this.#attached;
    if (!attached || !this.current()) return;
    const employee = attached.company.store.snapshot().employees.find((e) => e.id === employeeId),
      binding = employee?.dockerBinding;
    if (
      !employee ||
      !binding ||
      employee.owner !== undefined ||
      employee.onVacation ||
      employee.desiredRunning !== true ||
      employee.bindingMigration
    )
      return;
    const subject = attached.store.subject(employeeId),
      row = attached.store.record(employeeId),
      session = attached.ctx.sessions.get(employee.sessionId);
    if (
      !subject ||
      !row ||
      row.sourceDigest !== subject.sourceDigest ||
      row.credentialId !== binding.credentialId ||
      row.destination?.containerId !== binding.containerId ||
      row.request.sessionId !== employee.sessionId ||
      row.request.sessionGeneration !== employee.sessionGeneration ||
      !session ||
      session.owner !== employee.owner ||
      session.docker?.containerName !== binding.containerId ||
      session.docker?.continuation?.operationId !== binding.operationId ||
      session.providerDispatchHeld ||
      session.terminalInputHeld ||
      session.paneExit ||
      (!attached.provider.ownsPreparing(session, row) && !(session.pid !== null && session.status !== 'stopped'))
    )
      return;
    return {
      employeeId,
      owner: employee.owner,
      sessionId: binding.sessionId,
      sessionGeneration: binding.sessionGeneration,
      containerId: binding.containerId,
      credentialId: binding.credentialId,
    };
  }
  attach(company: CompanyService, ctx: Context): void {
    if (this.#attached || !this.current()) throw Error('Boxed runtime composition is not current');
    const configuration = this.selected.value,
      store = new CompanyDockerContinuationStore(company, (id) => ctx.store.getSession(id));
    const eligible = () =>
      company.store.snapshot().dockerEmployeeContinuations?.filter((row) => {
        const subject = store.subject(row.employeeId);
        return (
          subject &&
          subject.owner === row.owner &&
          subject.sessionId === row.request.sessionId &&
          subject.sessionGeneration === row.request.sessionGeneration &&
          subject.sourceDigest === row.sourceDigest
        );
      }) ?? [];
    const boxId = dockerContinuationDigest({ instanceId: this.#key.instanceId, deployment: configuration.deployment });
    const command = new PackagedDockerEngineCommand(),
      resources = new DockerContainedResources(command, store, {
        boxId,
        deployment: configuration.deployment,
        helperImageId: configuration.helperImageId,
        selectedWorkerContainerIds: () => [
          ...new Set(eligible().flatMap((row) => (row.destination ? [row.destination.containerId] : []))),
        ],
        retainedPoolConfigurationTasks: () =>
          eligible().flatMap((row) => row.tasks?.filter((task) => task.role === 'pool-helper') ?? []),
      });
    const engine = new DockerEmployeeEngine(
      command,
      configuration.deployment,
      resources,
      {
        imageId: configuration.workerImageId,
        clientManifestDigest: configuration.clientManifestDigest,
        sourceImageIds: configuration.sourceImageIds,
      },
      store,
      configuration.helperImageId,
      boxId
    );
    const provider = new DockerEmployeeSessionProvider(store, ctx, configuration.apiUrl);
    const service = new DockerEmployeeContinuation(store, engine, provider, {
      issue: (row, current) => {
        current();
        if (!this.current() || !row.destination) throw Error('Boxed identity custody changed');
        return this.authentication.issue(
          {
            employeeId: row.employeeId,
            owner: row.owner,
            sessionId: row.request.sessionId,
            sessionGeneration: row.request.sessionGeneration,
            containerId: row.destination.containerId,
            credentialId: row.credentialId,
          },
          () => {
            current();
            return this.current();
          }
        );
      },
    });
    this.#attached = { company, ctx, store, engine, provider, service };
  }
  registerRoutes(
    app: FastifyInstance,
    auth: { verifiedOwner(request: FastifyRequest): boolean; owner(request: FastifyRequest): string | undefined }
  ): void {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    registerDockerEmployeeContinuationRoutes(
      app,
      a.company,
      a.store,
      a.service,
      { ...auth, worker: dockerWorkerIdentityOf },
      readLegacyDockerPolicyProposal
    );
  }
  /** Normal wake attaches only an actually matching already-running provider.
   * Missing containers/provider ACKs remain explicitly held; no local/native fallback. */
  async wake(employee: CompanyEmployee, allowed: () => boolean): Promise<boolean> {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    const row = a.store.record(employee.id),
      binding = employee.dockerBinding;
    if (!row || !binding || row.phase !== 'ready') return false;
    const current = () => {
      const subject = a.store.subject(employee.id);
      if (
        !this.current() ||
        !allowed() ||
        !subject ||
        subject.onVacation ||
        subject.desiredRunning !== true ||
        subject.sourceDigest !== row.sourceDigest ||
        subject.sessionId !== binding.sessionId ||
        subject.sessionGeneration !== binding.sessionGeneration
      )
        throw Error('Boxed wake binding changed');
    };
    current();
    const seen = await a.engine.observeDestination(row);
    current();
    if (
      !seen ||
      seen.state !== 'running' ||
      seen.provider.kind !== 'running' ||
      seen.provider.operationId !== binding.operationId ||
      seen.provider.sessionId !== binding.sessionId ||
      dockerContinuationDigest(seen.resources) !== dockerContinuationDigest(row.policy)
    )
      return false;
    const actual = a.ctx.sessions.get(employee.sessionId);
    if (
      actual?.pid !== null &&
      actual?.pid !== undefined &&
      !actual.paneExit &&
      actual.docker?.containerName === binding.containerId
    )
      return true;
    await a.provider.attach(row, binding, current);
    current();
    return true;
  }
  close(): void {
    this.authentication.close();
    const errors = [];
    try {
      this.#key.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.selected.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'Boxed runtime close is unconfirmed');
  }
}
export function openDockerEmployeeRuntime(directory: string): DockerEmployeeRuntime | undefined {
  const mode = process.env.REVERIE_RUNTIME_BACKEND;
  if (mode === undefined) return;
  if (mode !== 'boxed-docker-v1') throw Error('Unsupported explicit runtime backend');
  if (isMultiUserMode()) throw Error('Boxed worker identity currently requires single-user mode');
  if (process.env.REVERIE_WORKER_SOCKET !== undefined || process.env.REVERIE_WORKER_VIEWER_SOCKET !== undefined)
    throw Error('Boxed runtime cannot combine native worker sockets');
  const selected = config();
  try {
    return new DockerEmployeeRuntime(runtimeOrigin, selected, directory);
  } catch (error) {
    try {
      selected.close();
    } catch (close) {
      throw new AggregateError([error, close], 'Boxed runtime acquisition failed');
    }
    throw error;
  }
}
