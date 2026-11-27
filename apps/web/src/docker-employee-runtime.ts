import type { DockerWakeOutcome } from './company-wake.js';
import { employeeStartupOrder, heldFirstNotice } from './employee-startup-order.js';
import { renewExistingDockerProviderView } from './docker-existing-view-renewal.js';
import {dockerPlanWorkerContainerIds}from'./docker-plan-worker-inventory.js';
import {DockerPlanMoveActor}from'./docker-plan-move-actor.js';
import type{PlanService}from'./plan-accounts.js';
import {PlanMoveStore}from'./plan-move-store.js';
import type{ChatroomService}from'./chatroom-service.js';
import {DockerPoolReconciliation} from './docker-pool-reconciliation.js';
import { DockerLaptopLimitUpkeep } from './docker-laptop-limit-upkeep.js';
import {
  DockerAbsentReprovision,
  type DockerAbsentReprovisionPlanMoves,
  type DockerAbsentReprovisionSeatAccounts,
} from './docker-absent-reprovision.js';
import { DockerPlanAccountSnapshot } from './docker-plan-account.js';
import { DockerSupervisorLaptops } from './docker-employee-supervisor-laptops.js';
import { DockerLaptopSignInHolder } from './docker-signin-holder.js';
import { laptopSignInHolderId } from './plan-signin-reconciler.js';
import { clampEnvOverridesForOwner } from './session-env-clamp.js';
import { DockerColdPoolJournal } from './docker-cold-pool-journal.js';
import { DockerStorageIdentityJournal } from './docker-storage-identity-journal.js';
import type { DockerVerifierCapability } from './docker-worker-reattach-helper.js';
import { DockerPoolCpuCeiling } from './docker-pool-cpu-ceiling.js';
import { DockerPoolCpuCeilingStore } from './docker-pool-cpu-ceiling-store.js';
import { registerDockerPoolCpuCeilingRoutes } from './web/routes/docker-pool-cpu-ceiling-routes.js';
import { DockerCpuReservation } from './docker-cpu-reservation.js';
import { registerDockerCpuReservationRoutes } from './web/routes/docker-cpu-reservation-routes.js';
import { DockerLeftoverCleanup } from './docker-leftover-cleanup.js';
import { registerDockerLeftoverCleanupRoutes } from './web/routes/docker-leftover-cleanup-routes.js';
import { dockerProviderModeReader } from './docker-employee-provider-hooks.js';
import { DockerProviderHealth } from './docker-provider-health.js';
import { providerHealthBinding } from './worker-provider-health.js';
import { PlanMoveError, type PlanMoveRecord } from './plan-move.js';
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
import { DockerWorkerGpu } from './docker-worker-gpu.js';
import { DockerContainedResources } from './docker-contained-resource-controller.js';
import { DockerResourceRepairJournal } from './docker-resource-repair-journal.js';
import { PackagedDockerEngineCommand } from './docker-engine-command.js';
import { DockerWorkerReattachHelper } from './docker-worker-reattach-helper.js';
import type { DockerEmployeeBinding, DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
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
    /** New `configure-high` leaf writers only. Never the anchor, storage or pool pin. */
    leafWriterHelperImageId: sha.optional(),
    recoveryHelperImageId: sha.optional(),
    apiUrl: z.string().url().max(2048),
    workerGpu: DockerWorkerGpu.optional(),
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
  limits: DockerLaptopLimitUpkeep;
  repairs: DockerResourceRepairJournal;
  resourceRevisions: DockerResourceRevisionService;
  cpuCeiling: DockerPoolCpuCeiling;
  cpuReservation: DockerCpuReservation;
  leftovers: DockerLeftoverCleanup;
  recoveryHelper?: DockerWorkerReattachHelper;
  absent: DockerAbsentReprovision;
  command: PackagedDockerEngineCommand;
}
function config(): {
  value: z.infer<typeof DockerRuntimeConfiguration>;
  current: () => boolean;
  /** Changes whenever the configuration file changes on disk. A name for a state, never an authority. */
  stamp: () => string;
  close: () => void;
} {
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
      stamp() {
        try {
          return stamp(fs.lstatSync(path));
        } catch {
          return 'unreadable';
        }
      },
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
        | 'DOCKER_CONTINUATION_DESTINATION_STOPPED'
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
  #absentPlanMoves?: DockerAbsentReprovisionPlanMoves;
  #seatPlans?: Pick<PlanService, 'account'>;
  #restorationReports: readonly DockerExistingViewRestoration[] = [];
  readonly #restorationFailures = new Map<string, unknown>();
  #restoring?: Promise<readonly DockerExistingViewRestoration[]>;
  #resourceConvergence?: ReturnType<DockerResourceRevisionService['convergeAll']>;
  #resourceTimer?: ReturnType<typeof setInterval>;
  #resourceTick?: Promise<void>;
  #tick = 0;
  /** Timer firings to skip after a pass that changed nothing. */
  #quietSkips = 0;
  #viewerRetries = new WeakMap<DockerExistingViewRestoration, { delay: number; due: number }>();

  get restorationReports(): readonly DockerExistingViewRestoration[] {
    const attached = this.#attached;
    if (!attached || !this.current()) return [];
    const employees = attached.company.store.view().employees;
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
  /**
   * For the office's own restart (office-self-restart.ts), which is what settles a runtime that is no longer
   * current. `identityStamp` changes whenever the configuration or the key changes on disk.
   * `restartWouldKeepIdentity` says whether a new office process would accept the configuration that is in place
   * and read the same instance key; with another key every laptop's credential would be out of use, and that is
   * never restarted into. Both read only, and neither makes this runtime current again.
   */
  identityStamp(): string {
    return this.selected.stamp() + '|' + this.#key.stamp();
  }
  restartWouldKeepIdentity(): boolean {
    try {
      config().close();
    } catch {
      return false;
    }
    return this.#key.sameOnDisk();
  }
  /** One read-only Engine command for the office's own use, where no laptop is involved. */
  engineRead(args: readonly string[]): Promise<string> {
    const attached = this.#attached;
    if (!attached) return Promise.reject(Error('Boxed runtime is not attached'));
    return attached.command.run(args, undefined, 10_000);
  }
  #binding(employeeId: string): DockerWorkerIdentityBinding | undefined {
    const attached = this.#attached;
    if (!attached || !this.current()) return;
    const employee = attached.company.store.view().employees.find((e) => e.id === employeeId),
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
      boxId = dockerContinuationDigest({ instanceId: this.#key.instanceId, deployment: configuration.deployment }),
      cpuReservation = new DockerCpuReservation(
        company,
        join(dirname(company.store.file), 'docker-cpu-reservation.jsonl'),
        boxId,
        () => {
          if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
        }
      ),
      // Owner-approved defaults for NEW laptop operations only: the soft memory
      // revision, then the CPUs kept free for the owner's own system.
      store = new CompanyDockerContinuationStore(company, (id) => ctx.store.getSession(id), (owner, policy) => {
        const desired = revisions.desired(owner);
        return cpuReservation.policy(desired ? dockerRevisedPolicy(policy, desired) : policy);
      });
    const inventory = () => store.resourceInventory();
    const coldPool = new DockerColdPoolJournal(join(dirname(company.store.file), 'docker-pool-cold-recovery.jsonl'));
    const cpuCeilings = new DockerPoolCpuCeilingStore(
      join(dirname(company.store.file), 'docker-pool-cpu-ceiling.jsonl'),
      boxId
    );
    // The office's own in-place repairs of limits that a reload of the host's
    // service manager reset. One private journal beside the company store.
    const repairs = new DockerResourceRepairJournal(
      join(dirname(company.store.file), 'docker-resource-repair.jsonl'),
      boxId
    );
    const command = new PackagedDockerEngineCommand(),
      resources = new DockerContainedResources(command, store, {
        boxId,
        deployment: configuration.deployment,
        helperImageId: configuration.helperImageId,
        memoryHighHelperImageId: configuration.memoryHighHelperImageId,
        poolRestoreHelperImageId: configuration.poolRestoreHelperImageId,
        leafWriterHelperImageId: configuration.leafWriterHelperImageId,
        requireColdPoolIdle: () => coldPool.requireIdle(),
        repairs,
        approvedPoolCpuMax: () => cpuCeilings.acceptedCpuMax(),
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
        ...(configuration.workerGpu ? { workerGpu: configuration.workerGpu } : {}),
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
    }, coldPool);
    const resourceRevisions = new DockerResourceRevisionService(company, store, revisions, resources, engine);
    const cpuCeiling = new DockerPoolCpuCeiling(company, cpuCeilings, resources, boxId, () => {
      if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
    });
    // What the office itself has seen of the filesystem each employee's directories are on, and the owner's
    // standing answer for a device renumbering that this record cannot prove.
    const storageIdentity = new DockerStorageIdentityJournal(
      join(dirname(company.store.file), 'docker-storage-identity.jsonl')
    );
    const recoveryHelper = configuration.recoveryHelperImageId
      ? new DockerWorkerReattachHelper(
          command,
          configuration.recoveryHelperImageId,
          () => ({
            instanceId: this.#key.instanceId,
            key: this.#key.key.toString('hex'),
          }),
          {
            granted: (owner) => company.view(owner).settings.acceptStorageRenumbering === true,
            identity: storageIdentity,
          }
        )
      : undefined;
    // The in-place repair of a finished laptop's own limits that does not ask where its employee is. It stands
    // aside for every set-up step and rebuild of that employee, and they stand aside for it.
    const limits: DockerLaptopLimitUpkeep = new DockerLaptopLimitUpkeep({
      store,
      engine,
      busy: (employeeId): boolean => service.flightActive(employeeId) || absent.flightActive(employeeId),
    });
    const absent: DockerAbsentReprovision = new DockerAbsentReprovision(
      company,
      store,
      command,
      {
        deployment: configuration.deployment,
        boxId,
        apiUrl: configuration.apiUrl,
        workerImageId: configuration.workerImageId,
        sourceImageIds: configuration.sourceImageIds,
      },
      {
        saved: (id) => ctx.store.getSession(id) ?? undefined,
        live: (id) => {
          const session = ctx.sessions.get(id);
          return session
            ? {
                inert: session.pid === null && session.runningTaskCount === 0 && !session.paneLifecycleInFlight,
                ...(session.docker?.continuation ? { container: session.docker.containerName } : {}),
              }
            : undefined;
        },
        // Only a viewer that is not starting or attaching can be the one a rebuild discards.
        blocked: (id, owner, discardingViewer) => {
          const viewer = discardingViewer ? ctx.sessions.get(id) : undefined;
          return ctx.store.dockerAbsentReprovisionBlocker(
            id,
            owner,
            viewer?.docker?.continuation && !viewer.paneLifecycleInFlight ? viewer : undefined
          );
        },
        viewerLaunchOwned: (id) => {
          const viewer = ctx.sessions.get(id);
          return !!viewer?.docker?.continuation && ctx.store.absentLaptopViewOwnsLaunch(viewer);
        },
        overrides: async (id) => {
          const saved = ctx.store.getSession(id);
          return saved
            ? clampEnvOverridesForOwner(
                saved.owner,
                (saved as { __envOverrides?: Record<string, string> }).__envOverrides
              )
            : undefined;
        },
        discard: (id) => ctx.discardPartiallyBuiltSession(id),
        ...(ctx.discardAbsentLaptopView
          ? { discardView: (id, absent) => ctx.discardAbsentLaptopView!(id, absent) }
          : {}),
        clear: (proof) => ctx.store.commitDockerAbsentReprovision(proof),
      },
      () => this.#absentPlanMoves,
      (employeeId) => service.flightActive(employeeId) || limits.flightActive(employeeId),
      () => {
        if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
      },
      Date.now,
      () => this.#seatAccounts()
    );
    // The owner's cleanup of superseded helpers and laptop images. It reads the same records and
    // removes only through the same Engine port as every laptop workflow above.
    const leftovers = new DockerLeftoverCleanup(
      command,
      {
        deployment: configuration.deployment,
        boxId,
        workerImageId: configuration.workerImageId,
        sourceImageIds: configuration.sourceImageIds,
        helperImageIds: [
          configuration.helperImageId,
          configuration.memoryHighHelperImageId,
          configuration.poolRestoreHelperImageId,
          configuration.leafWriterHelperImageId,
          configuration.recoveryHelperImageId,
        ].filter((id): id is string => id !== undefined),
      },
      {
        records: () => company.store.view(),
        inFlight: (employeeId) =>
          service.flightActive(employeeId) || absent.flightActive(employeeId) || limits.flightActive(employeeId),
        planMoves: () => this.#absentPlanMoves,
        runtimeCurrent: () => {
          if (!this.current() || company.store.publicationUnconfirmed)
            throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
        },
      }
    );
    this.#attached = {
      company,
      ctx,
      store,
      engine,
      provider,
      service,
      pool,
      limits,
      repairs,
      resourceRevisions,
      cpuCeiling,
      cpuReservation,
      leftovers,
      recoveryHelper,
      absent,
      command,
    };
  }
  /** Server composition only: the in-memory owner of the private move journal.
   * Until it is bound, an absent-laptop reprovision is refused. */
  bindPlanMoves(moves: DockerAbsentReprovisionPlanMoves): void {
    if (this.#absentPlanMoves && this.#absentPlanMoves !== moves) throw Error('Original plan move owner required');
    this.#absentPlanMoves = moves;
  }
  /** Server composition only: the plan account catalogue a plan move reads.
   * Until it is bound, a rebuilt laptop gets its seat folder and no sign-in. */
  bindSeatAccounts(plans: Pick<PlanService, 'account'>): void {
    if (this.#seatPlans && this.#seatPlans !== plans) throw Error('Original plan account service required');
    this.#seatPlans = plans;
  }
  /** The office's signed-in copy of one plan account, captured exactly as a
   * plan move captures its target: held private files, re-verified on use.
   * An account that cannot be read that way is reported as not signed in. */
  #seatAccounts(): DockerAbsentReprovisionSeatAccounts | undefined {
    const plans = this.#seatPlans;
    if (!plans) return undefined;
    return {
      capture: async (profileId, provider, current) => {
        let snapshot: DockerPlanAccountSnapshot;
        try {
          snapshot = await DockerPlanAccountSnapshot.capture(plans, profileId, current);
        } catch (error) {
          current();
          if (error instanceof DockerEmployeeContinuationError && error.code === 'DOCKER_PLAN_ACCOUNT_UNCONFIRMED')
            return undefined;
          throw error;
        }
        if (snapshot.descriptor.provider !== provider) {
          snapshot.close();
          return undefined;
        }
        return snapshot;
      },
    };
  }
  /** Server composition only: one employee's running laptop as a holder of its plan's sign-in. The laptop is the
   * recorded destination of a finished set-up; the holder stops answering once that record names another
   * container or the runtime is no longer current. Nothing is read or written until the reconciler asks. */
  signInHolder(employeeId: string, label: string, profileId: string): DockerLaptopSignInHolder | undefined {
    const a = this.#attached;
    if (!a || !this.current()) return undefined;
    const row = a.store.record(employeeId),
      containerId = row?.destination?.containerId;
    if (!row || !containerId || !['provider-issued', 'ready'].includes(row.phase)) return undefined;
    return new DockerLaptopSignInHolder(
      a.command,
      { id: laptopSignInHolderId(employeeId), label, containerId, profileId },
      () =>
        this.current() &&
        this.#attached === a &&
        a.store.record(employeeId)?.destination?.containerId === containerId
    );
  }
  /** Server composition only: the office supervisor's laptop reads and steps. Each one is a call to the same
   * service the owner's route for that step calls, under the authority `DockerSupervisorLaptops` documents. */
  supervisorLaptops(): DockerSupervisorLaptops | undefined {
    const a = this.#attached;
    if (!a) return undefined;
    // Once, at office start: what the office can check of a stopped laptop's stored home with the recovery helper
    // image it is configured with. The same is shown on every employee (`supervisor.storedHomeCheck`).
    const said = (capability: 'none' | DockerVerifierCapability) =>
      console.log('[supervisor] stored home check: ' + DOCKER_STORED_HOME_CHECKS[capability]);
    if (a.recoveryHelper)
      void a.recoveryHelper
        .probe()
        .then(said)
        .catch(() => said('unknown'));
    else said('none');
    return new DockerSupervisorLaptops({
      company: a.company,
      store: a.store,
      engine: a.engine,
      service: a.service,
      pool: a.pool,
      limits: a.limits,
      absent: a.absent,
      storage: {
        stopped: (row, current) => a.engine.stoppedStorage(row, a.recoveryHelper, current),
        capability: () => a.recoveryHelper?.capability() ?? 'none',
        ...(a.recoveryHelper
          ? {
              remember: (row: DockerEmployeeContinuationRecord, current: () => void) =>
                a.engine.rememberStorage(row, a.recoveryHelper!, current),
            }
          : {}),
      },
      moves: () => this.#absentPlanMoves,
      sessions: a.ctx.sessions,
      inputHeldOnRecord: (id) => a.ctx.store.getSession(id)?.terminalInputHeld === true,
      current: () => this.current() && this.#attached === a,
    });
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
    registerDockerPoolCpuCeilingRoutes(
      app,
      a.cpuCeiling,
      guardDockerRuntimeOrigin({ ...auth, worker: dockerWorkerIdentityOf }, requireCurrent)
    );
    registerDockerCpuReservationRoutes(
      app,
      a.cpuReservation,
      guardDockerRuntimeOrigin({ ...auth, worker: dockerWorkerIdentityOf }, requireCurrent)
    );
    registerDockerLeftoverCleanupRoutes(
      app,
      a.leftovers,
      guardDockerRuntimeOrigin({ ...auth, worker: dockerWorkerIdentityOf }, requireCurrent)
    );
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
      a.pool,
      a.recoveryHelper,
      a.absent,
      a.limits
    );
  }
  /** Server composition only. Inert until the API supplies its genuine captured
   * requester; no request body selects Engine, paths, accounts or commands. */
  planMoveActor(plans:PlanService,moves:PlanMoveStore,chat:ChatroomService):DockerPlanMoveActor|undefined{
    const a=this.#attached;if(!a||!this.current())return;
    if(!(moves instanceof PlanMoveStore)||(this.#planMoves&&this.#planMoves!==moves))throw Error('Original private plan journal required');this.#planMoves=moves;
    const current=()=>{if(!this.current()||this.#attached!==a||a.company.store.publicationUnconfirmed)throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');};
    return new DockerPlanMoveActor({company:a.company,ctx:a.ctx,plans,moves,chat,store:a.store,engine:a.engine,provider:a.provider,configuration:this.selected.value,boxId:dockerContinuationDigest({instanceId:this.#key.instanceId,deployment:this.selected.value.deployment}),authentication:this.authentication,revisions:a.resourceRevisions.revisions,repairs:a.repairs,current,renewPublishedView:(row,session,admitted)=>this.#renewPublishedPlanView(row,session,admitted),
      requireReconciledSourcePool: (row, admitted) => a.pool.requirePlanSourcePool(row, admitted),
      recoveryHelper: a.recoveryHelper,
      recoverPublishedPlanView: async (row, authDigest, admitted) => {
        const check = () => {
          admitted();
          current();
          if (row.version !== 3 || !a.store.existingSubject(row.employeeId, row))
            throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_PROVIDER_VIEW_CHANGED');
        };
        check();
        if (!a.recoveryHelper) return;
        const policy = a.store.policy(row.employeeId);
        const policyDigest = dockerContinuationDigest(policy);
        const view = await a.engine.captureReattachedProviderView(row, policy, a.recoveryHelper, () => {
          check();
          if (dockerContinuationDigest(a.store.policy(row.employeeId)) !== policyDigest)
            throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_REATTACH_POLICY_UNCONFIRMED');
        }, authDigest);
        return view === 'stopped' ? undefined : view;
      },
      retain:actor=>this.#planActors.add(actor)});
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
  async #observeRunningProviderView(
    a: Attached, row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding, current: () => void
  ) {
    const observed = await this.#observeProvider(a, row, binding, current);
    return observed === 'stopped' ? undefined : observed;
  }
  async #observeProvider(
    a: Attached,
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    current: () => void
  ) {
    current();
    try {
      const seen = await a.engine.observeDestination(row);
      current();
      if (seen?.state === 'stopped' && seen.original?.containerId === binding.containerId) return 'stopped' as const;
      if (seen?.state === 'running' && seen.provider.kind === 'running' &&
        seen.provider.operationId === binding.operationId && seen.provider.sessionId === binding.sessionId &&
        a.engine.existingResourcePolicyCurrent(row, seen.resources))
        return await a.engine.captureProviderView(row, current);
    } catch (cause) {
      current();
      if (!a.recoveryHelper) throw cause;
    }
    if (!a.recoveryHelper) return;
    const policy = a.store.policy(row.employeeId), policyDigest = dockerContinuationDigest(policy);
    const policyCurrent = () => {
      current();
      if (dockerContinuationDigest(a.store.policy(row.employeeId)) !== policyDigest)
        throw Error('Boxed recovery resource policy changed');
    };
    return a.engine.captureReattachedProviderView(row, policy, a.recoveryHelper, policyCurrent);
  }
  /** Reobserve the current boxed destination of an already-stopped legacy move.
   * This supplies only the live view fence for journal settlement. */
  async verifyBoxedLegacyTarget(record: Readonly<PlanMoveRecord>, authorized: () => void): Promise<() => void> {
    authorized();
    const a = this.#attached;
    const employee = a?.company.employeeForSession(record.newSession ?? '', record.owner);
    const row = employee && a?.store.record(employee.id);
    const binding = employee?.dockerBinding;
    const session = employee && a?.ctx.sessions.get(employee.sessionId);
    if (
      !a || !employee || !row || !binding || !session?.docker?.continuation ||
      record.dockerReplacement || record.resourceIntent || record.purpose ||
      !record.sourceStopRequested || record.sourceCleanupVerified !== true ||
      record.phase !== 'recovery-required' || record.newSession === record.oldSession ||
      employee.id !== record.employeeId || session.subscriptionProfile?.id !== record.toAccount
    ) throw new PlanMoveError('The original boxed destination is unavailable', 409);
    const bindingDigest = dockerContinuationDigest(binding);
    const current = () => {
      authorized();
      const live = a.company.employeeForSession(session.id, record.owner);
      const subject = a.store.existingSubject(employee.id, row);
      if (
        this.#attached !== a || !this.current() || a.company.store.publicationUnconfirmed ||
        !live || live.id !== employee.id || live.onVacation || !live.desiredRunning || live.bindingMigration ||
        !subject || subject.sessionGeneration !== binding.sessionGeneration ||
        dockerContinuationDigest(live.dockerBinding ?? null) !== bindingDigest ||
        a.ctx.sessions.get(session.id) !== session || session.pid === null || session.paneExit ||
        session.providerInputHeld || session.terminalInputHeld ||
        !session.dockerContinuationViewCurrent || session.subscriptionProfile?.id !== record.toAccount
      ) throw new PlanMoveError('The original boxed destination changed', 409);
    };
    current();
    const view = await this.#observeRunningProviderView(a, row, binding, current);
    if (!view) throw new PlanMoveError('The original boxed destination is unconfirmed', 409);
    const fence = () => {
      current();
      view.require(session.id, session.docker!);
      current();
    };
    fence();
    return fence;
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
      const view = await this.#observeRunningProviderView(a, row, binding, current);
      current();
      if (!view) throw Error('Original Docker provider is unconfirmed');
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
  /** Server-private read renewal; a request cannot choose an Engine or a fallback effect. */
  async #renewPublishedPlanView(row: DockerEmployeeContinuationRecord, session: Session, admitted: () => void): Promise<void> {
    const a = this.#attached;
    if (!a || row.version !== 3 || row.phase !== 'ready') throw Error('Original published plan reader required');
    await renewExistingDockerProviderView({
      company: a.company, store: a.store, engine: a.engine, sessions: a.ctx.sessions,
      saved: id => a.ctx.store.getSession(id),
      runtimeCurrent: () => {
        if (!this.current() || this.#attached !== a) throw Error('Boxed runtime changed');
      },
      observeRunningView: (observedRow, observedBinding, current) =>
        this.#observeRunningProviderView(a, observedRow, observedBinding, current),
    }, row, session, () => {admitted(); return true;});
    admitted();
  }
  /** Normal wake attaches only an actually matching already-running provider.
   * Missing containers/provider ACKs remain explicitly held; no local/native fallback. */
  async wake(employee: CompanyEmployee, allowed: () => boolean): Promise<boolean> {
    return (await this.attachExistingEmployee(employee, allowed)) === 'attached';
  }
  /** A current terminal on the running provider of this binding: an Engine-observed view, or the pane through which
   * this office process launched exactly this binding's provider (a continuation leaves no separate view to renew). */
  #currentViewer(actual: unknown, binding: DockerEmployeeBinding): boolean {
    return actual instanceof Session &&
      (actual.dockerContinuationViewCurrent || actual.dockerContinuationLaunchedFor(binding)) &&
      actual.pid != null && !actual.paneExit && !actual.providerInputHeld &&
      !actual.terminalInputHeld && actual.docker?.containerName === binding.containerId;
  }
  async attachExistingEmployee(employee: CompanyEmployee, allowed: () => boolean): Promise<DockerWakeOutcome> {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    const row = a.store.record(employee.id),
      binding = employee.dockerBinding;
    if (!row || !binding || !['ready', 'provider-issued'].includes(row.phase)) return 'unconfirmed';
    let publication: 'preparing' | 'published' | 'failed' = 'preparing';
    const current = () => {
      const subject = a.store.existingSubject(employee.id, row);
      const live = a.company.store.view().employees.find((value) => value.id === employee.id);
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
    const actual = a.ctx.sessions.get(employee.sessionId);
    if (this.#currentViewer(actual, binding)) { publication = 'published'; return 'attached'; }
    if (actual instanceof Session && actual.pid !== null && !actual.dockerContinuationViewCurrent) {
      await renewExistingDockerProviderView({
        company: a.company, store: a.store, engine: a.engine, sessions: a.ctx.sessions,
        saved: id => a.ctx.store.getSession(id),
        runtimeCurrent: () => {
          if (!this.current() || this.#attached !== a) throw Error('Boxed runtime changed');
        },
        observeRunningView: (observedRow, observedBinding, admitted) =>
          this.#observeRunningProviderView(a, observedRow, observedBinding, admitted),
      }, row, actual, () => {current(); return true;}, () => {publication = 'published';});
      publication = 'published';
      return 'attached';
    }
    const view = await this.#observeProvider(a, row, binding, current);
    current();
    if (!view || view === 'stopped') { publication = 'failed'; return view ?? 'unconfirmed'; }
    await a.provider.attach(row, binding, current, view);
    current();
    publication = 'published';
    return 'attached';
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
      if (this.#quietSkips > 0) { this.#quietSkips--; return; }
      this.#resourceTick = this.#reconcileTick().catch(() => {
        // A failed observation grants no authority. The next tick reads fresh state.
      }).finally(() => { this.#resourceTick = undefined; });
    }, 10_000);
    this.#resourceTimer.unref();
  }
  async #reconcileTick(): Promise<void> {
    const a = this.#attached;
    if (!a) return;
    const reports = new Map(this.restorationReports.map(report => [report.employeeId, report]));
    this.#tick++;
    let converged = true;
    const results = await this.#convergeResources().catch((error: unknown) => {
      if (!this.current()) throw error;
      converged = false;
      return [];
    });
    const changed = new Set(results.flatMap(result => result.status === 'fulfilled' &&
      (result.value.state === 'observed' || result.value.state === 'applied') ? [result.value.employeeId] : []));
    const keep = new Map<string, DockerExistingViewRestoration>();
    for (const employee of a.company.store.view().employees) {
      const report = reports.get(employee.id);
      if (!employee.dockerBinding || !report || changed.has(employee.id)) continue;
      if (report.state === 'attached') {
        if (this.#currentViewer(a.ctx.sessions.get(employee.sessionId), employee.dockerBinding))
          keep.set(employee.id, report);
      } else if (report.code === 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING') {
        const phase = a.store.record(employee.id)?.phase;
        if (phase !== 'ready' && phase !== 'provider-issued') keep.set(employee.id, report);
      } else if ((this.#viewerRetries.get(report)?.due ?? 0) > this.#tick) keep.set(employee.id, report);
    }
    const after = await this.#restore(keep);
    // Each pass inspects every laptop against every other one. When a pass changed nothing and every wanted
    // viewer is attached, wait three intervals before the next instead of repeating it every ten seconds.
    this.#quietSkips = converged && changed.size === 0 && results.every(result => result.status === 'fulfilled') &&
      after.every(report => report.state === 'attached') ? 2 : 0;
  }
  restoreExistingViews(): Promise<readonly DockerExistingViewRestoration[]> {
    return this.#restore();
  }
  #restore(keep?: ReadonlyMap<string, DockerExistingViewRestoration>): Promise<readonly DockerExistingViewRestoration[]> {
    if (this.#restoring) return this.#restoring;
    const work = this.#restoreExistingViews(keep).then((reports) => {
      this.#restoring = undefined; this.#startResourceConvergence(); return reports;
    }, (cause: unknown) => { this.#restoring = undefined; throw cause; });
    this.#restoring = work; return work;
  }
  async #restoreExistingViews(keep?: ReadonlyMap<string, DockerExistingViewRestoration>): Promise<readonly DockerExistingViewRestoration[]> {
    const a = this.#attached;
    if (!a) throw Error('Boxed runtime is not attached');
    try { if (!keep) await this.#convergeResources(); }
    catch { if (!this.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED'); }
    const reports: DockerExistingViewRestoration[] = [];
    const previous = new Map(this.restorationReports.map(report => [report.employeeId, report]));
    // Order only (employee-startup-order.ts): each employee below is still attached or held on its own.
    for (const employee of employeeStartupOrder(a.company.store.view().employees)) {
      if (!employee.dockerBinding || employee.onVacation || employee.desiredRunning !== true) continue;
      const retained = keep?.get(employee.id);
      if (retained && retained === previous.get(employee.id)) {
        reports.push(retained);
        continue;
      }
      const base = {
        employeeId: employee.id,
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
        operationId: employee.dockerBinding.operationId,
        bindingDigest: dockerContinuationDigest(employee.dockerBinding),
      };
      const allowed = () => {
        const live = a.company.store.view().employees.find((value) => value.id === employee.id);
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
        const attached = await this.attachExistingEmployee(employee, allowed);
        reports.push(
          Object.freeze(
            attached === 'attached'
              ? { ...base, state: 'attached' }
              : { ...base, state: 'held', code: attached === 'stopped'
                ? 'DOCKER_CONTINUATION_DESTINATION_STOPPED' : 'DOCKER_CONTINUATION_EXISTING_PROVIDER_UNCONFIRMED' }
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
      } finally {
        const notice = heldFirstNotice(employee, reports.at(-1), previous.get(employee.id));
        if (notice) console.warn('[docker-employee-continuation] ' + notice);
      }
    }
    for (const report of reports) {
      if (report.state !== 'held' || report.code === 'DOCKER_CONTINUATION_ORIGINAL_ATTEMPT_PENDING' ||
          this.#viewerRetries.has(report)) continue;
      const prior = previous.get(report.employeeId);
      const delay = prior?.state === 'held' && prior.code === report.code
        ? Math.min(12, (this.#viewerRetries.get(prior)?.delay ?? 1) * 2) : 1;
      this.#viewerRetries.set(report, { delay, due: this.#tick + delay });
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
/** What the office checks of a stopped laptop's stored home, by what its recovery helper image can do. */
export const DOCKER_STORED_HOME_CHECKS: Readonly<Record<'none' | DockerVerifierCapability, string>> = {
  none:
    'no recovery helper image is configured (recoveryHelperImageId), so nothing is checked: a stopped laptop is ' +
    'rebuilt by its recorded home path, as before this check existed.',
  full:
    'the recovery helper image reads what is mounted. A stopped laptop is rebuilt only on a confirmed home; a new ' +
    'device number is told from another directory, and the filesystem of each running laptop is recorded.',
  'compare-only':
    'the recovery helper image was built before the read of what is mounted existed. An unchanged home is ' +
    'confirmed. A changed one cannot be told apart (new device number or another directory) and is never rebuilt ' +
    'on, and no record of a filesystem is made. Configure an image built from this office’s source.',
  'image-missing':
    'the configured recovery helper image is not in the container engine. Nothing can be confirmed, so no stopped ' +
    'laptop is rebuilt until the image is loaded.',
  unknown:
    'the recovery helper image did not answer the probe. What it can do is found out at the first read; until a ' +
    'home is confirmed no stopped laptop is rebuilt.',
};
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
