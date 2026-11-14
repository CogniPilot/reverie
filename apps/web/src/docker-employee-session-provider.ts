import { DockerEmployeeProviderView } from './docker-employee-engine.js';
/** Existing Session/mux application services own the provider and viewer. No
 * raw docker-exec provider bypass or alternate recipe/account writer.
 */
import { Session } from './session.js';
import { bindInitialLaunchAdmission, captureLaunchProtocolAdmission } from './initial-launch-admission.js';
import { rebootRestoreLaunchConfig } from './utils/native-thread-profile.js';
import { rebootResumeTarget } from './utils/native-thread-profile.js';
import { clampEnvOverridesForOwner } from './session-env-clamp.js';
import { captureDockerEmployeeProviderLaunch } from './docker-employee-provider-launch.js';
import { CompanyDockerContinuationStore, dockerEmployeeSourceDigest } from './docker-employee-store.js';
import type { DockerContinuationProvider } from './docker-employee-continuation.js';
import type { DockerEmployeeBinding, DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { SessionPort, ConfigPort, InfraPort } from './web/ports/index.js';
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
    private readonly apiUrl: string
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
  launch(row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding, current: () => void): Promise<void> {
    return this.#install(row, binding, current, true);
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
      dockerEmployeeSourceDigest(employee, saved) !== row.sourceDigest ||
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
      original.candidate = candidate;
      const currentCandidate = () => {
        current();
        if (!allowed() || this.ctx.sessions.get(binding.sessionId) !== candidate)
          throw Error('Original provider Session changed');
      };
      const admission = () => {
        try {
          current();
          return (
            allowed() &&
            (!this.ctx.sessions.has(binding.sessionId) || this.ctx.sessions.get(binding.sessionId) === candidate)
          );
        } catch {
          return false;
        }
      };
      bindInitialLaunchAdmission(candidate, admission);
      if (first)
        candidate.bindDockerContinuationLaunch(
          captureDockerEmployeeProviderLaunch(candidate, binding, () => {
            current();
            if (!admission()) throw Error('Original Docker launch authorization changed');
          })
        );
      if (!first) {
        if (!view) throw Error('Original Docker provider view required');
        candidate.bindDockerContinuationView(view, this.ctx.mux);
      }
      if (!reused) await this.ctx.addSession(candidate, undefined, admission);
      currentCandidate();
      await this.ctx.reapplyPersistedSessionState(candidate, saved, 'before-spawn');
      currentCandidate();
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
