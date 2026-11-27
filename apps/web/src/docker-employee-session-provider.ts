import {requireDockerPlanPaidDispatch}from'./docker-plan-move-actor.js';
import { DockerEmployeeProviderView } from './docker-employee-engine.js';
import { dockerPlanProviderSelection } from './docker-employee-provider-view-native.js';
/** Existing Session/mux application services own the provider and viewer. No
 * raw docker-exec provider bypass or alternate recipe/account writer.
 */
import { Session } from './session.js';
import { bindInitialLaunchAdmission, captureLaunchProtocolAdmission } from './initial-launch-admission.js';
import { rebootRestoreLaunchConfig } from './utils/native-thread-profile.js';
import { rebootResumeTarget } from './utils/native-thread-profile.js';
import { clampEnvOverridesForOwner } from './session-env-clamp.js';
import { captureDockerEmployeeProviderLaunch } from './docker-employee-provider-launch.js';
import {
  CompanyDockerContinuationStore,
  dockerEmployeeSourceDigest,
  dockerEmployeeProviderSourceDigest,
} from './docker-employee-store.js';
import { legacyDockerProviderSourceMatches } from './docker-employee-source-correlation.js';
import { getCli } from './config/cli-registry/registry.js';
import { getDataDir } from './config/instance.js';
import { readCustomModelHosts, type CustomModelHost } from './custom-model-hosts.js';
import { resolveBoxedLocalModel, type BoxedLocalModelResolution } from './docker-employee-local-model.js';
import type { DockerContinuationProvider, DockerProviderPreflightRefusal } from './docker-employee-continuation.js';
import type { DockerEmployeeBinding, DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { SessionPort, ConfigPort, InfraPort } from './web/ports/index.js';
import type { DockerCodexWorkspace } from './docker-employee-codex-workspace.js';
import type { SessionDocker, SessionState } from './types.js';
interface OriginalSessionAttempt {
  readonly source: Session | undefined;
  readonly saved: SessionState;
  candidate?: Session;
  cause?: unknown;
}
export class DockerEmployeeSessionProvider implements DockerContinuationProvider {
  readonly #originals = new Map<string, OriginalSessionAttempt>();
  constructor(
    private readonly store: CompanyDockerContinuationStore,
    private readonly ctx: SessionPort & ConfigPort & Pick<InfraPort, 'mux'>,
    private readonly apiUrl: string,
    private readonly observeCodexWorkspace?: (
      row: DockerEmployeeContinuationRecord,
      workingDir: string,
      current: () => void
    ) => Promise<DockerCodexWorkspace>,
    /** The office's own endpoint store; a port only so a test needs no data directory. */
    private readonly modelEndpoints: () => Promise<readonly CustomModelHost[]> = () =>
      readCustomModelHosts(getDataDir())
  ) {
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error('Fixed boxed website API origin required');
  }
  #docker(row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding): SessionDocker {
    if (!row.destination) throw Error('Original Docker destination unavailable');
    return {
      hostId: 'boxed-runtime',
      label: 'Docker-contained employee',
      engine: 'docker',
      image: binding.imageId,
      containerName: binding.containerId,
      hostWorkspacePath: '/',
      containerWorkdir: this.ctx.store.getSession(binding.sessionId)!.workingDir,
      network: 'bridge',
      mountCredentials: false,
      hooksEnabled: false,
      resumeOnStart: true,
      owned: false,
      daemonHost: 'unix:///run/reverie-engine/docker.sock',
      continuation: {
        operationId: binding.operationId,
        employeeId: row.employeeId,
        sessionGeneration: binding.sessionGeneration,
        clientManifestDigest: row.workerImage.clientManifestDigest,
        apiUrl: this.apiUrl,
        ...(row.version === 3
          ? {
              planReplacement: dockerPlanProviderSelection(row.planReplacement),
            }
          : {}),
      },
    };
  }
  ownsPreparing(session: Session, row: DockerEmployeeContinuationRecord): boolean {
    const original = this.#originals.get(row.request.operationId);
    return (
      original?.candidate === session &&
      original.cause === undefined &&
      session.pid === null &&
      session.paneLifecycleInFlight
    );
  }
  /** What the saved recipe's local model needs, from the employee's recipe and
   * the endpoint store as they are now. Reads only. */
  async #localModel(
    employeeId: string,
    sessionId: string,
    modelSocketMounted: boolean | undefined
  ): Promise<BoxedLocalModelResolution> {
    const saved = this.ctx.store.getSession(sessionId),
      employee = this.store.company.store.snapshot().employees.find((e) => e.id === employeeId);
    // A changed or missing source is the launch's own refusal, not a model fact.
    if (!saved || !employee) return { kind: 'not-applicable' };
    const entry = getCli(saved.mode ?? 'claude');
    let hosts: readonly CustomModelHost[];
    try {
      hosts = await this.modelEndpoints();
    } catch {
      return {
        kind: 'refused',
        refusal: {
          code: 'DOCKER_CONTINUATION_LOCAL_MODEL_STORE_UNREADABLE',
          message:
            'The office could not read its saved local model endpoints, so nothing was launched. ' +
            'Check the endpoint list in the office, then continue.',
        },
      };
    }
    return resolveBoxedLocalModel({ entry, employee, saved, hosts, modelSocketMounted });
  }
  async preflight(
    row: DockerEmployeeContinuationRecord,
    facts: { readonly modelSocketMounted: boolean | undefined },
    current: () => void
  ): Promise<DockerProviderPreflightRefusal | undefined> {
    current();
    if (row.version === 3) return undefined;
    const model = await this.#localModel(row.employeeId, row.request.sessionId, facts.modelSocketMounted);
    current();
    return model.kind === 'refused' ? model.refusal : undefined;
  }
  launch(row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding, current: () => void): Promise<void> {
    if (row.version === 3) throw Error('A plan replacement requires its original paid-dispatch actor');
    return this.#install(row, binding, current, true);
  }
  /** Only the native actor's original journaled paid intent can enter here.
   * Generic continuation launch remains refused for every v3 row. */
  launchPlanReplacement(proof:unknown,row:DockerEmployeeContinuationRecord,binding:DockerEmployeeBinding,current:()=>void):Promise<void>{
    requireDockerPlanPaidDispatch(proof,row,binding);
    if(row.version!==3||row.phase!=='provider-issued')throw Error('Original plan replacement dispatch required');
    const checked=()=>{current();requireDockerPlanPaidDispatch(proof,row,binding);};
    return this.#install(row,binding,checked,true);
  }
  attach(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    current: () => void,
    view: DockerEmployeeProviderView
  ): Promise<void> {
    return this.#install(row, binding, current, false, view);
  }
  async #install(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    current: () => void,
    first: boolean,
    view?: DockerEmployeeProviderView
  ): Promise<void> {
    current();
    if (this.#originals.has(row.request.operationId)) throw Error('Original provider attempt is retained');
    const saved = this.ctx.store.getSession(binding.sessionId),
      employee = this.store.company.store.snapshot().employees.find((e) => e.id === row.employeeId);
    if (
      !saved ||
      !employee ||
      (first
        ? dockerEmployeeSourceDigest(employee, saved) !== row.sourceDigest
        : row.version === 2 || row.version === 3
          ? dockerEmployeeProviderSourceDigest(employee, saved) !== row.providerSourceDigest
          : !legacyDockerProviderSourceMatches(employee, saved, row.sourceDigest)) ||
      saved.providerDispatchHeld ||
      saved.terminalInputHeld
    )
      throw Error('Original canonical provider recipe is unavailable');
    const original: OriginalSessionAttempt = {
      source: this.ctx.sessions.get(binding.sessionId),
      saved: structuredClone(saved),
    };
    this.#originals.set(row.request.operationId, original);
    try {
      if (original.source) {
        if (
          original.source.pid !== null ||
          original.source.runningTaskCount > 0 ||
          original.source.paneLifecycleInFlight ||
          (first && original.source.providerDispatchHeld) ||
          original.source.terminalInputHeld
        )
          throw Error('Original application Session requires recovery');
        if (first) {
          await this.ctx.discardPartiallyBuiltSession(binding.sessionId);
          current();
          if (this.ctx.sessions.has(binding.sessionId)) throw Error('Original Session cleanup is unconfirmed');
        }
      }
      const allowed = captureLaunchProtocolAdmission(saved.mode ?? 'claude');
      const environment = await clampEnvOverridesForOwner(
        saved.owner,
        (saved as { __envOverrides?: Record<string, string> }).__envOverrides
      );
      current();
      const resume = rebootResumeTarget(saved);
      if (resume === undefined) throw Error('Original conversation cannot be resumed by this provider');
      const launch = rebootRestoreLaunchConfig(saved, resume),
        docker = this.#docker(row, binding);
      const reused = !first ? original.source : undefined;
      const candidate =
        reused ??
        new Session({
          ...saved,
          ...launch,
          useMux: true,
          mux: this.ctx.mux,
          docker,
          remote: undefined,
          envOverrides: environment,
          workerAttachOnly: false,
          providerDispatchHeld: false,
          terminalInputHeld: false,
        });
      if (!reused && (saved.claudeMode !== undefined || saved.allowedTools !== undefined))
        candidate.retainPermissionRecipe();
      original.candidate = candidate;
      if (!reused) {
        // Keep the saved recipe visible to admission. Endpoint values are
        // still rebuilt by the normal before-spawn path after publication.
        const selection = (saved as {
          __customModel?: ReturnType<Session['getCustomModelForPersist']>;
        }).__customModel;
        if (selection) candidate.setCustomModel(selection);
      }
      const providerSource =
        row.version === 1 ? dockerEmployeeProviderSourceDigest(employee, saved) : row.providerSourceDigest;
      const candidateRecipeCurrent = () =>
        candidate.owner === employee.owner &&
        dockerEmployeeProviderSourceDigest(employee, { ...saved, ...candidate.providerRecipeState() }) ===
          providerSource &&
        (!first || dockerEmployeeSourceDigest(employee, candidate.toPersistedState()) === row.sourceDigest);
      const currentCandidate = () => {
        current();
        if (!allowed() || !candidateRecipeCurrent() || this.ctx.sessions.get(binding.sessionId) !== candidate)
          throw Error('Original provider Session changed');
      };
      const admission = () => {
        try {
          current();
          return (
            allowed() &&
            candidateRecipeCurrent() &&
            (!this.ctx.sessions.has(binding.sessionId) || this.ctx.sessions.get(binding.sessionId) === candidate)
          );
        } catch {
          return false;
        }
      };
      bindInitialLaunchAdmission(candidate, admission);
      if (first)
        candidate.bindDockerContinuationLaunch(
          captureDockerEmployeeProviderLaunch(
            candidate,
            binding,
            () => {
              current();
              if (!admission()) throw Error('Original Docker launch authorization changed');
            },
            this.observeCodexWorkspace
              ? (workingDir) => this.observeCodexWorkspace!(row, workingDir, currentCandidate)
              : undefined
          )
        );
      if (!first) {
        if (!view) throw Error('Original Docker provider view required');
        candidate.bindDockerContinuationView(view, this.ctx.mux);
      }
      if (!reused) await this.ctx.addSession(candidate, undefined, admission);
      currentCandidate();
      await this.ctx.reapplyPersistedSessionState(candidate, saved, 'before-spawn');
      currentCandidate();
      if (first) {
        // The endpoint values are never saved, and a rebuilt record may no
        // longer carry the bookkeeping that rebuilds them. Derive them from the
        // employee's recipe and the endpoint store, as environment only: the
        // saved recipe and its launch fingerprint are not touched.
        const model = await this.#localModel(row.employeeId, binding.sessionId, undefined);
        currentCandidate();
        if (model.kind === 'ready') candidate.mergeLaunchEnvironment(model.environment);
        currentCandidate();
      }
      if (!reused) await this.ctx.setupSessionListeners(candidate);
      currentCandidate();
      await candidate.startInteractive();
      currentCandidate();
      await this.ctx.reapplyPersistedSessionState(candidate, saved, 'after-spawn', { rearmAutoResumeSchedule: false });
      currentCandidate();
      this.ctx.persistSessionStateNow(candidate);
      currentCandidate();
    } catch (cause) {
      original.cause = cause;
      throw cause;
    }
  }
}
