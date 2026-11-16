import {dockerPlanWorkerContainerIds}from'./docker-plan-worker-inventory.js';
import {DockerPlanMoveActor}from'./docker-plan-move-actor.js';
import type{PlanService}from'./plan-accounts.js';
import {PlanMoveStore}from'./plan-move-store.js';
import type{ChatroomService}from'./chatroom-service.js';
import {DockerPoolReconciliation} from './docker-pool-reconciliation.js';
import { dockerProviderModeReader } from './docker-employee-provider-hooks.js';
import { DockerProviderHealth } from './docker-provider-health.js';
import { providerHealthBinding } from './worker-provider-health.js';
import { isMultiUserMode } from './config/multiuser.js';
/** Explicit Docker-only application composition. Config and journal are DATA;
 * only actual Engine/helper observations and current Company actions permit effects. */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { DockerResourceRevisionStore, dockerRevisedPolicy } from './docker-resource-revisions.js';
import { DockerResourceRevisionService } from './docker-resource-revision-service.js';
import { registerDockerResourceRevisionRoutes } from './web/routes/docker-resource-revision-routes.js';
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
import {
  DockerEmployeeContinuation,
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  dockerContinuationFailureCauses,
} from './docker-employee-continuation.js';
import { Session } from './session.js';
import { CompanyDockerContinuationStore, dockerEmployeeProviderSourceDigest } from './docker-employee-store.js';
import { DockerEmployeeEngine } from './docker-employee-engine.js';
import { DockerContainedResources } from './docker-contained-resource-controller.js';
import { PackagedDockerEngineCommand } from './docker-engine-command.js';
import { DockerOwnerStopDiagnostic, DockerOwnerStopDiagnosticError } from './docker-owner-stop-status.js';
import { registerDockerOwnerStopRoutes } from './web/routes/docker-owner-stop-routes.js';
import { DockerEmployeeSessionProvider } from './docker-employee-session-provider.js';
import { readLegacyDockerPolicyProposal, parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
import {
  registerDockerEmployeeContinuationRoutes,
  type DockerContinuationRouteAuthentication,
} from './web/routes/docker-employee-continuation-routes.js';
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
    memoryHighHelperImageId: sha.optional(),
    poolRestoreHelperImageId: sha.optional(),
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
  pool: DockerPoolReconciliation;
  resourceRevisions: DockerResourceRevisionService;
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
/** Retain runtime currency around every use of the original verified identity ports. */
export function guardDockerRuntimeOrigin(
  auth: DockerContinuationRouteAuthentication,
  requireCurrent: () => void
): DockerContinuationRouteAuthentication {
  return {
    verifiedOwner(request) {
      requireCurrent();
      return auth.verifiedOwner(request);
    },
    worker(request) {
      requireCurrent();
      const worker = auth.worker(request);
      if (!worker) return undefined;
      return {
        owner: worker.owner,
        sessionId: worker.sessionId,
        require() {
          requireCurrent();
          worker.require();
        },
      };
    },
    owner(request) {
      requireCurrent();
      return auth.owner(request);
    },
  };
}
export type DockerExistingViewRestoration = {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly operationId: string;
  readonly bindingDigest: string;
} & (
  | { readonly state: 'attached' }
  | {
      readonly state: 'held';
      readonly code:
        | 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING'
        | 'DOCKER_CONTINUATION_EXISTING_PROVIDER_UNCONFIRMED'
        | 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED';
    }
);
const runtimeOrigin = Symbol('actual boxed runtime configuration');
export class DockerEmployeeRuntime {
  readonly authentication: DockerWorkerIdentityAuthentication;
  readonly #key: DockerRuntimeKey;
  #attached?: Attached;
  readonly #planActors=new Set<DockerPlanMoveActor>();
  #planMoves?:PlanMoveStore;
  #restorationReports: readonly DockerExistingViewRestoration[] = [];
  readonly #restorationFailures = new Map<string, unknown>();
  #restoring?: Promise<readonly DockerExistingViewRestoration[]>;
  #resourceConvergence?: ReturnType<DockerResourceRevisionService['convergeAll']>;
  #resourceTimer?: ReturnType<typeof setInterval>;
  #resourceTick?: Promise<void>;

  get restorationReports(): readonly DockerExistingViewRestoration[] {
    const attached = this.#attached;
    if (!attached || !this.current()) return [];
    const employees = attached.company.store.snapshot().employees;
    return this.#restorationReports.filter((report) =>
      employees.some(
        (employee) =>
          employee.id === report.employeeId &&
          employee.sessionId === report.sessionId &&
          employee.sessionGeneration === report.sessionGeneration &&
          employee.dockerBinding?.operationId === report.operationId &&
          dockerContinuationDigest(employee.dockerBinding) === report.bindingDigest
      )
    );
  }
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
    const row = attached.store.record(employeeId),
      subject = row && attached.store.existingSubject(employeeId, row),
      session = attached.ctx.sessions.get(employee.sessionId);
    if (
      !subject ||
      !row ||
      row.credentialId !== binding.credentialId ||
      row.destination?.containerId !== binding.containerId ||
      row.request.sessionId !== employee.sessionId ||
      row.request.sessionGeneration !== employee.sessionGeneration ||
      !session ||
      session.owner !== employee.owner ||
      session.docker?.containerName !== binding.containerId ||
      session.docker?.continuation?.operationId !== binding.operationId ||
      (session.providerDispatchHeld && !session.dockerContinuationViewCurrent) ||
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
      revisions = new DockerResourceRevisionStore(join(dirname(company.store.file), 'docker-resource-revisions')),
      store = new CompanyDockerContinuationStore(company, (id) => ctx.store.getSession(id), (owner, policy) => {
        const desired = revisions.desired(owner);
        return desired ? dockerRevisedPolicy(policy, desired) : policy;
      });
    const inventory = () => store.resourceInventory();
    const boxId = dockerContinuationDigest({ instanceId: this.#key.instanceId, deployment: configuration.deployment });
    const command = new PackagedDockerEngineCommand(),
      resources = new DockerContainedResources(command, store, {
        boxId,
        deployment: configuration.deployment,
        helperImageId: configuration.helperImageId,
        memoryHighHelperImageId: configuration.memoryHighHelperImageId,
        poolRestoreHelperImageId: configuration.poolRestoreHelperImageId,
        selectedWorkerContainerIds:()=>dockerPlanWorkerContainerIds(inventory,this.#planMoves,()=>{if(!this.current())throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');}),
        retainedPoolConfigurationTasks: () =>
          store.retainedPoolConfigurationTasks(
            'reverie-boxed-anchor-' + boxId.slice(0, 32), configuration.helperImageId, boxId
          ),
      }, revisions);
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
      boxId,
      dockerProviderModeReader(company, ctx.store),
      (row, digest) => {
        const recordDigest = dockerContinuationDigest(row);
        const current = () => {
          if (!this.current() || row.version === 3 || !row.destination ||
            !['provider-issued', 'ready'].includes(row.phase) ||
            dockerContinuationDigest(store.record(row.employeeId)) !== recordDigest ||
            !store.existingSubject(row.employeeId, row))
            throw Error('Original published worker credential binding changed');
          return true;
        };
        current();
        return this.authentication.matchesIssuedDigest({
          employeeId: row.employeeId,
          owner: row.owner,
          sessionId: row.request.sessionId,
          sessionGeneration: row.request.sessionGeneration,
          containerId: row.destination!.containerId,
          credentialId: row.credentialId,
        }, digest, current);
      },
      (row) => {
        if (
          !this.current() ||
          row.version !== 3 ||
          row.phase !== 'ready' ||
          !store.existingSubject(row.employeeId, row)
        )
          throw Error('Canonical published plan replacement changed');
      }
    );
    const provider = new DockerEmployeeSessionProvider(store, ctx, configuration.apiUrl, (row, workingDir, current) =>
      engine.observeCodexWorkspace(row, workingDir, current)
    );
    const service = new DockerEmployeeContinuation(
      store,
      engine,
      provider,
      {
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
      },
      (failure) => console.error('[docker-employee-continuation] recovery held', JSON.stringify(failure))
    );
    const pool = new DockerPoolReconciliation(company,store,resources,()=>{
      if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
    });
    const resourceRevisions = new DockerResourceRevisionService(company, store, revisions, resources, engine);
    this.#attached = { company, ctx, store, engine, provider, service, pool, resourceRevisions };
  }
  registerRoutes(
    app: FastifyInstance,
    auth: { verifiedOwner(request: FastifyRequest): boolean; owner(request: FastifyRequest): string | undefined }
  ): void {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    const requireCurrent = () => {
      if (!this.current()) throw new DockerOwnerStopDiagnosticError('DOCKER_OWNER_STOP_RUNTIME_CHANGED');
    };
    registerDockerResourceRevisionRoutes(app, a.resourceRevisions,
      guardDockerRuntimeOrigin({ ...auth, worker: dockerWorkerIdentityOf }, requireCurrent));
    registerDockerOwnerStopRoutes(
      app,
      new DockerOwnerStopDiagnostic(a.company, requireCurrent),
      guardDockerRuntimeOrigin({ ...auth, worker: dockerWorkerIdentityOf }, requireCurrent)
    );
    registerDockerEmployeeContinuationRoutes(
      app,
      a.company,
      a.store,
      a.service,
      guardDockerRuntimeOrigin({ ...auth, worker: dockerWorkerIdentityOf }, () => {
        if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
      }),
      readLegacyDockerPolicyProposal,
      a.pool
    );
  }
  /** Server composition only. Inert until the API supplies its genuine captured
   * requester; no request body selects Engine, paths, accounts or commands. */
  planMoveActor(plans:PlanService,moves:PlanMoveStore,chat:ChatroomService):DockerPlanMoveActor|undefined{
    const a=this.#attached;if(!a||!this.current())return;
    if(!(moves instanceof PlanMoveStore)||(this.#planMoves&&this.#planMoves!==moves))throw Error('Original private plan journal required');this.#planMoves=moves;
    const current=()=>{if(!this.current()||this.#attached!==a||a.company.store.publicationUnconfirmed)throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');};
    return new DockerPlanMoveActor({company:a.company,ctx:a.ctx,plans,moves,chat,store:a.store,engine:a.engine,provider:a.provider,configuration:this.selected.value,boxId:dockerContinuationDigest({instanceId:this.#key.instanceId,deployment:this.selected.value.deployment}),authentication:this.authentication,revisions:a.resourceRevisions.revisions,current,retain:actor=>this.#planActors.add(actor)});
  }
  /** Separate from wake/restore: only fixed metadata/kernel reads, never a viewer or launch. */
  providerHealthObserver(changed: () => void): DockerProviderHealth {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    return new DockerProviderHealth({
      employees: () => a.company.registeredEmployees(),
      active: () => this.current() && !a.company.store.publicationUnconfirmed,
      changed,
      observe: async (employee, requireHealthCurrent) => {
        const binding = employee.dockerBinding,
          row = a.store.record(employee.id);
        if (!binding || !row) throw Error('Original Docker provider binding unavailable');
        const rowDigest = dockerContinuationDigest(row),
          publicBinding = providerHealthBinding(employee),
          bindingDigest = dockerContinuationDigest(binding);
        let revoked = false;
        const current = () => {
          if (revoked) throw Error('Original Docker provider health changed');
          try {
            requireHealthCurrent();
            const live = a.company.employeeForSession(employee.sessionId, employee.owner),
              subject = a.store.existingSubject(employee.id, row);
            if (
              !this.current() ||
              !live ||
              providerHealthBinding(live) !== publicBinding ||
              dockerContinuationDigest(live.dockerBinding) !== bindingDigest ||
              live.onVacation ||
              live.desiredRunning !== true ||
              live.bindingMigration ||
              !subject ||
              subject.owner !== employee.owner ||
              subject.sessionId !== binding.sessionId ||
              subject.sessionGeneration !== binding.sessionGeneration ||
              dockerContinuationDigest(a.store.record(employee.id)) !== rowDigest
            )
              throw Error('Original Docker provider health changed');
          } catch (error) {
            revoked = true;
            throw error;
          }
        };
        current();
        const proof = await a.engine.captureProviderHealth(row, binding, current);
        current();
        return proof;
      },
    });
  }
  /** Read-only native observation plus one attach-only website client repair.
   * No resource convergence, provider installation or generic wake is admitted. */
  async reconnectViewer(employeeId: string, expected: { sessionId: string; sessionGeneration: number },
    owner: string | undefined, admitted: () => boolean, revalidateMove?: () => Promise<boolean>
  ): Promise<'connected' | 'unconfirmed' | 'unavailable'> {
    const a = this.#attached;
    if (!a || !this.current()) return 'unavailable';
    const employee = a.company.registeredEmployees().find(value => value.id === employeeId && value.owner === owner);
    const row = employee && a.store.record(employee.id), binding = employee?.dockerBinding;
    const session = employee && a.ctx.sessions.get(employee.sessionId);
    if (!employee || !row || !binding || !session || !session.docker?.continuation ||
      employee.sessionId !== expected.sessionId || employee.sessionGeneration !== expected.sessionGeneration ||
      !['ready', 'provider-issued'].includes(row.phase)) return 'unavailable';
    const rowDigest = dockerContinuationDigest(row), bindingDigest = dockerContinuationDigest(binding);
    const saved = a.ctx.store.getSession(employee.sessionId);
    if (!saved) return 'unavailable';
    const source = row.version === 1 ? dockerEmployeeProviderSourceDigest(employee, saved) : row.providerSourceDigest;
    const end = performance.now() + 25_000;
    let publication: 'preparing' | 'published' | 'failed' = 'preparing';
    const published = () => publication === 'published';
    let revoked = false;
    const current = () => {
      if (revoked) throw Error('Original Docker viewer repair changed');
      const live = a.company.registeredEmployees().find(value => value.id === employeeId);
      const subject = a.store.existingSubject(employeeId, row);
      if (publication === 'failed' ||
        (publication === 'preparing' && (!admitted() || performance.now() >= end)) ||
        !this.current() || a.company.store.publicationUnconfirmed ||
        !live || !subject || live.owner !== owner || subject.owner !== owner || live.onVacation ||
        live.desiredRunning !== true || live.bindingMigration || live.sessionId !== expected.sessionId ||
        live.sessionGeneration !== expected.sessionGeneration || subject.sessionId !== expected.sessionId ||
        subject.sessionGeneration !== expected.sessionGeneration || a.ctx.sessions.get(expected.sessionId) !== session ||
        session.owner !== owner || dockerContinuationDigest(live.dockerBinding) !== bindingDigest ||
        dockerContinuationDigest(a.store.record(employeeId)) !== rowDigest ||
        dockerEmployeeProviderSourceDigest(live, { ...saved, ...session.providerRecipeState() }) !== source) {
        revoked = true;
        throw Error('Original Docker viewer repair changed');
      }
    };
    const allowed = () => { try { current(); return true; } catch { return false; } };
    const capture = async () => {
      current();
      if (revalidateMove && !await revalidateMove()) throw Error('Original Docker viewer move hold changed');
      current();
      const seen = await a.engine.observeDestination(row);
      current();
      if (!seen || seen.state !== 'running' || seen.provider.kind !== 'running' ||
        seen.provider.operationId !== binding.operationId || seen.provider.sessionId !== binding.sessionId ||
        !a.engine.existingResourcePolicyCurrent(row, seen.resources)) throw Error('Original Docker provider is unconfirmed');
      const view = await a.engine.captureProviderView(row, current);
      current();
      return view;
    };
    try {
      const view = await capture();
      const repaired = await Session.prototype.reconnectDockerContinuationView.call(session, view, allowed, capture, () => {
        current();
        publication = 'published';
      });
      if (repaired && published() && allowed()) return 'connected';
      publication = 'failed';
      return 'unconfirmed';
    } catch { publication = 'failed'; return 'unconfirmed'; }
  }
  /** Normal wake attaches only an actually matching already-running provider.
   * Missing containers/provider ACKs remain explicitly held; no local/native fallback. */
  async wake(employee: CompanyEmployee, allowed: () => boolean): Promise<boolean> {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    const row = a.store.record(employee.id),
      binding = employee.dockerBinding;
    if (!row || !binding || !['ready', 'provider-issued'].includes(row.phase)) return false;
    let publication: 'preparing' | 'published' | 'failed' = 'preparing';
    const current = () => {
      const subject = a.store.existingSubject(employee.id, row);
      const live = a.company.store.snapshot().employees.find((value) => value.id === employee.id);
      if (
        !this.current() ||
        publication === 'failed' || (publication === 'preparing' && !allowed()) ||
        !live ||
        live.owner !== employee.owner ||
        dockerContinuationDigest(live.dockerBinding) !== dockerContinuationDigest(binding) ||
        dockerContinuationDigest(a.store.record(employee.id)) !== dockerContinuationDigest(row) ||
        !subject ||
        subject.onVacation ||
        subject.desiredRunning !== true ||
        subject.sessionId !== binding.sessionId ||
        subject.sessionGeneration !== binding.sessionGeneration
      )
        throw Error('Boxed wake binding changed');
    };
    try {
    current();
    try { await a.resourceRevisions.converge(employee.id, current); }
    catch { current(); } // A pending desired revision never replaces fresh original/view admission.
    current();
    const seen = await a.engine.observeDestination(row);
    current();
    if (
      !seen ||
      seen.state !== 'running' ||
      seen.provider.kind !== 'running' ||
      seen.provider.operationId !== binding.operationId ||
      seen.provider.sessionId !== binding.sessionId ||
      !a.engine.existingResourcePolicyCurrent(row, seen.resources)
    ) { publication = 'failed'; return false; }
    const actual = a.ctx.sessions.get(employee.sessionId);
    if (
      actual?.pid !== null &&
      actual?.pid !== undefined &&
      !actual.paneExit &&
      !actual.providerInputHeld &&
      !actual.terminalInputHeld &&
      actual.docker?.containerName === binding.containerId
    ) { publication = 'published'; return true; }
    if (actual instanceof Session && actual.pid !== null && !actual.dockerContinuationViewCurrent) {
      const saved = a.ctx.store.getSession(employee.sessionId);
      if (!saved) throw Error('Boxed existing viewer saved recipe missing');
      const providerSource =
        row.version === 1 ? dockerEmployeeProviderSourceDigest(employee, saved) : row.providerSourceDigest;
      const renewalCurrent = () => {
        current();
        if (
          a.ctx.sessions.get(employee.sessionId) !== actual ||
          actual.owner !== employee.owner ||
          dockerEmployeeProviderSourceDigest(employee, { ...saved, ...actual.providerRecipeState() }) !== providerSource
        )
          throw Error('Boxed existing viewer recipe changed');
      };
      renewalCurrent();
      const view = await a.engine.captureProviderView(row, renewalCurrent);
      renewalCurrent();
      Session.prototype.renewDockerContinuationView.call(actual, view, () => {
        renewalCurrent();
        return true;
      });
      renewalCurrent();
      publication = 'published';
      return true;
    }
    const view = await a.engine.captureProviderView(row, current);
    current();
    await a.provider.attach(row, binding, current, view);
    current();
    publication = 'published';
    return true;
    } catch (cause) {
      publication = 'failed';
      throw cause;
    }
  }
  /** Restore a viewer of a current running provider, independently of auto-wake.
   * Ready or retained-issued records are only correlation: fresh physical proof is required.
   * Only a separately approved resource-helper phase may create its leaf writer.
   * No branch creates a destination, launches a provider, or releases a paid disk fence.
   */
  /** Separate resource-default convergence precedes read-only provider attachment. */
  #convergeResources(): ReturnType<DockerResourceRevisionService['convergeAll']> {
    if (this.#resourceConvergence) return this.#resourceConvergence;
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    const current = () => { if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED'); };
    const work = a.resourceRevisions.convergeAll(current).finally(() => { this.#resourceConvergence = undefined; });
    this.#resourceConvergence = work; return work;
  }
  #startResourceConvergence(): void {
    if (this.#resourceTimer || !this.current()) return;
    this.#resourceTimer = setInterval(() => {
      if (this.#resourceTick || this.#restoring || !this.current()) return;
      this.#resourceTick = this.#convergeResources().then(async (results) => {
        if (results.some((result) => result.status === 'fulfilled' &&
            (result.value.state === 'observed' || result.value.state === 'applied')))
          await this.restoreExistingViews();
      }).then(() => {}, () => {}).finally(() => { this.#resourceTick = undefined; });
    }, 10_000);
    this.#resourceTimer.unref();
  }
  restoreExistingViews(): Promise<readonly DockerExistingViewRestoration[]> {
    if (this.#restoring) return this.#restoring;
    const work = this.#restoreExistingViews().then((reports) => {
      this.#restoring = undefined; this.#startResourceConvergence(); return reports;
    }, (cause: unknown) => { this.#restoring = undefined; throw cause; });
    this.#restoring = work; return work;
  }
  async #restoreExistingViews(): Promise<readonly DockerExistingViewRestoration[]> {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    try { await this.#convergeResources(); }
    catch { if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED'); }
    const reports: DockerExistingViewRestoration[] = [];
    for (const employee of a.company.store.snapshot().employees) {
      if (!employee.dockerBinding || employee.onVacation || employee.desiredRunning !== true) continue;
      const base = {
        employeeId: employee.id,
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
        operationId: employee.dockerBinding.operationId,
        bindingDigest: dockerContinuationDigest(employee.dockerBinding),
      };
      const allowed = () => {
        const live = a.company.store.snapshot().employees.find((value) => value.id === employee.id);
        return (
          this.current() &&
          !!live &&
          live.owner === employee.owner &&
          live.sessionId === employee.sessionId &&
          live.sessionGeneration === employee.sessionGeneration &&
          !live.onVacation &&
          live.desiredRunning === true &&
          dockerContinuationDigest(live.dockerBinding) === dockerContinuationDigest(employee.dockerBinding)
        );
      };
      try {
        await a.store.migrateProviderSource(employee.id, () => {
          if (!allowed()) throw Error('Boxed format migration custody changed');
        });
        const row = a.store.record(employee.id);
        if (!row || !['ready', 'provider-issued'].includes(row.phase)) {
          reports.push(Object.freeze({ ...base, state: 'held', code: 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING' }));
          continue;
        }
        const attached = await this.wake(employee, allowed);
        reports.push(
          Object.freeze(
            attached
              ? { ...base, state: 'attached' }
              : { ...base, state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_PROVIDER_UNCONFIRMED' }
          )
        );
      } catch (cause) {
        if (!this.#restorationFailures.has(employee.id) && this.#restorationFailures.size < 64) {
          this.#restorationFailures.set(employee.id, cause);
          try {
            console.error(
              '[docker-employee-continuation] existing viewer held',
              JSON.stringify({ ...base, causes: dockerContinuationFailureCauses(cause) })
            );
          } catch {
            /* Reporting cannot change the held result or another employee's admission. */
          }
        }
        reports.push(Object.freeze({ ...base, state: 'held', code: 'DOCKER_CONTINUATION_EXISTING_VIEW_UNCONFIRMED' }));
      }
    }
    this.#restorationReports = Object.freeze(reports);
    return this.#restorationReports;
  }
  close(): void {
    if (this.#resourceTimer) clearInterval(this.#resourceTimer);
    this.#resourceTimer = undefined;
    const errors:unknown[]=[];
    for(const actor of this.#planActors){try{actor.close();}catch(error){errors.push(error);}}
    this.#planActors.clear();
    this.authentication.close();
    try { this.#attached?.resourceRevisions.revisions.close(); }
    catch (error) { errors.push(error); }
    try {
      this.#attached?.engine.close();
    } catch (error) {
      errors.push(error);
    }
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
