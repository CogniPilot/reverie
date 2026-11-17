import { captureDockerPlanSourceRetirement } from './docker-plan-source-retirement.js';
import { captureDockerPlanDisjointGeneration } from './docker-plan-disjoint-generation.js';
import { dockerPlanAccountStatusArguments, DockerPlanAccountStatus } from './docker-plan-account-status.js';
/** The one PlanMoves native actor. Request DATA cannot construct its captured
 * requester, native source observation or provider-dispatch admission. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DockerEmployeeBinding as Binding,
  DockerEmployeeContinuationRecord as Published,
  DockerEmployeePlanReplacementWorkRecord as WorkRecord,
} from './docker-employee-continuation-data.js';
import { dockerEmployeeSourceDigest, dockerEmployeeProviderSourceDigest } from './docker-employee-store.js';
import { DockerEmployeeProviderView } from './docker-employee-engine.js';
import { DockerEmployeeInspect } from './docker-employee-engine-data.js';
import { ephemeralRetainedProjection } from './docker-ephemeral-data.js';
import { DockerPlanMoveWork } from './docker-plan-move-work.js';
import { DockerPlanSourceHolder } from './docker-plan-source-holder.js';
import { dockerPlanMaterial, dockerPlanPayload, dockerPlanAuthDigest } from './docker-plan-material.js';
import { dockerPlanMoveHandoffDigest } from './docker-plan-move-data.js';
import { nativeThreadProfile } from './utils/native-thread-profile.js';
import { submitRecoveryPrompt, recoveryComposerReady } from './company-recovery-prompt.js';
import { getCli } from './config/cli-registry/registry.js';
import type { DockerResourceRevisionStore } from './docker-resource-revisions.js';
import type { RuntimeRecipe } from './expert-runtime-recipe.js';
import { Session } from './session.js';
import type { DockerPlanSourceContext } from './docker-plan-source-data.js';

import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { CompanyService } from './company-service.js';
import type { DockerEmployeeBinding } from './docker-employee-continuation-data.js';
import type { DockerContinuationSubject } from './docker-employee-continuation.js';
import type { RuntimeRefreshPolicy } from './account-replacement-policy.js';
import { resolveClaudeModeForUsername } from './user-store.js';
import { dockerPlanMoveTargetRecipe } from './docker-plan-move-recipe.js';
import { requireDockerPlanProtocol } from './docker-plan-protocol.js';
import type { CompanyEmployee } from './company-types.js';
import type { SessionPort, ConfigPort, InfraPort } from './web/ports/index.js';
import type { ChatroomService } from './chatroom-service.js';
import type { PlanService, PlanAccount } from './plan-accounts.js';
import type { PlanMoveStore } from './plan-move-store.js';
import {
  PlanMoveComposerNotReady,
  PlanMoveError,
  type PlanMoveInput,
  type PlanMoveRecord,
  type PlanMoveSnapshot,
} from './plan-move.js';
import type { PlanMoveDockerActor, PlanMoveDockerJournal } from './plan-move-docker.js';
import { DockerPlanMoveSeed, type DockerPlanMoveJournalState } from './docker-plan-move-data.js';
import {
  requireDockerPlanMoveRequesterSource,
  requireDockerPlanMoveRequesterReservation,
  requireDockerPlanMoveRequesterCurrent,
} from './docker-plan-move-requester.js';
import { requireDockerPlanDecisionScope } from './docker-plan-request-decision.js';
import { DockerPlanSourceReader } from './docker-plan-source.js';
import { DockerPlanAccountSnapshot } from './docker-plan-account.js';
import { dockerProviderRuntimeRecipeDigest } from './docker-employee-source-correlation.js';
import type { DockerEmployeeEngine } from './docker-employee-engine.js';
import type { CompanyDockerContinuationStore } from './docker-employee-store.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { PackagedDockerEngineCommand } from './docker-engine-command.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { DockerEmployeeSessionProvider } from './docker-employee-session-provider.js';
import type { DockerWorkerIdentityAuthentication } from './docker-worker-identity.js';
import type { DockerRuntimeConfiguration } from './docker-employee-runtime.js';

import type { SessionState } from './types.js';
import { accountReplacementProfile } from './utils/account-replacement-profile.js';

type Context = SessionPort &
  ConfigPort &
  Pick<InfraPort, 'mux'> & { retireDockerPlanSource?(proof: unknown): Promise<void> };
export interface DockerPlanMoveComposition {
  readonly company: CompanyService;
  readonly ctx: Context;
  readonly plans: PlanService;
  readonly moves: PlanMoveStore;
  readonly chat: ChatroomService;
  readonly store: CompanyDockerContinuationStore;
  readonly engine: DockerEmployeeEngine;
  readonly provider: DockerEmployeeSessionProvider;
  readonly configuration: Readonly<z.infer<typeof DockerRuntimeConfiguration>>;
  readonly boxId: string;
  readonly authentication: DockerWorkerIdentityAuthentication;
  readonly current: () => void;
  readonly revisions: DockerResourceRevisionStore;
  readonly renewPublishedView?: (row: DockerEmployeeContinuationRecord, session: Session, current: () => void) => Promise<void>;
  readonly retain: (actor: DockerPlanMoveActor) => void;
}
interface SourceSelection {
  scope: ReturnType<typeof requireDockerPlanMoveRequesterSource>;
  employee: CompanyEmployee;
  row: DockerEmployeeContinuationRecord;
  binding: DockerEmployeeBinding;
  saved: SessionState;
  subject: DockerContinuationSubject;
}
function unavailable(message = 'The protected Docker plan transaction is not available'): never {
  throw new PlanMoveError(message, 503);
}
function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}
/** Comparison DATA only. The exact published tuple remains separately earned. */
export function dockerPlanSourceRecordCurrent(
  before: DockerEmployeeContinuationRecord,
  actual: DockerEmployeeContinuationRecord | undefined
): boolean {
  return (
    !!actual &&
    (same(before, actual) ||
      (before.phase === 'provider-issued' &&
        actual.phase === 'ready' &&
        same(before, { ...actual, phase: 'provider-issued' })))
  );
}
function publishedWork(input: unknown): WorkRecord {
  const row = WorkRecord.parse(input);
  Published.parse(row);
  return row;
}
/** Cached login metadata and file digests cannot identify a refreshed OAuth
 * principal. Ordinary moves use the freshly selected canonical account. */
export class DockerPlanAccountPrincipalUnconfirmed extends PlanMoveError {
  readonly code = 'DOCKER_PLAN_ACCOUNT_PRINCIPAL_UNCONFIRMED';
  constructor() {
    super('Refreshed account identity requires verified account and organization proof', 409);
  }
}
function requireCanonicalAccountSource(state: Readonly<DockerPlanMoveJournalState>): void {
  if (state.seed.target.accountSource.kind !== 'canonical') throw new DockerPlanAccountPrincipalUnconfirmed();
}
export class DockerPlanMoveActor implements PlanMoveDockerActor {
  #registered = false;
  readonly #work = new Map<string, DockerPlanMoveWork>();
  readonly #views = new Map<string, { view: DockerEmployeeProviderView; session: Session }>();
  readonly #holders = new Map<string, DockerPlanSourceHolder>();
  readonly #d: DockerPlanMoveComposition;
  readonly #requester: unknown;
  readonly #decision: unknown;
  readonly #command = new PackagedDockerEngineCommand();
  readonly #source: DockerPlanSourceReader;
  constructor(deps: DockerPlanMoveComposition, requester?: unknown, decision?: unknown) {
    this.#d = Object.freeze({
      ...deps,
      configuration: Object.freeze({ ...deps.configuration, sourceImageIds: [...deps.configuration.sourceImageIds] }),
    });
    this.#requester = requester;
    this.#decision = decision;
    this.#source = new DockerPlanSourceReader(
      this.#command,
      deps.configuration.deployment,
      deps.boxId,
      deps.configuration.apiUrl,
      (row, current) => deps.engine.captureProviderView(row, current),
      async (row, current) => {
        await deps.engine.existingPlanSourceImage(row, current);
        current();
      }
    );
    Object.freeze(this);
  }
  withRequesterAuthority(proof: unknown): PlanMoveDockerActor {
    return new DockerPlanMoveActor(this.#d, proof, this.#decision);
  }
  withDecisionAuthority(proof: unknown): PlanMoveDockerActor {
    const scope = requireDockerPlanDecisionScope(proof);
    return new DockerPlanMoveActor(this.#d, this.#requester, new NativeCooperation(scope));
  }
  current(record: Readonly<PlanMoveRecord>, state: Readonly<DockerPlanMoveJournalState>): void {
    this.#d.current();
    if (!this.#requester) unavailable();
    requireDockerPlanMoveRequesterCurrent(this.#requester, record, state);
    const employee = this.#d.company.store.snapshot().employees.find((e) => e.id === record.employeeId);
    if (
      employee &&
      same(employee.dockerBinding, state.seed.source.binding) &&
      !dockerPlanSourceRecordCurrent(state.seed.source.record, this.#d.store.record(record.employeeId))
    )
      throw new PlanMoveError('The original source continuation changed', 409);
    this.#d.current();
  }
  #selection(employeeId: string, owner: string | undefined): SourceSelection {
    this.#d.current();
    if (!this.#requester) unavailable();
    const scope = requireDockerPlanMoveRequesterSource(this.#requester, employeeId, owner),
      state = this.#d.company.store.snapshot(),
      employees = state.employees.filter((e) => e.id === employeeId),
      employee = employees[0],
      rows = state.dockerEmployeeContinuations?.filter((r) => r.employeeId === employeeId) ?? [],
      row = rows[0];
    if (
      employees.length !== 1 ||
      rows.length !== 1 ||
      !employee ||
      !row ||
      employee.owner !== owner ||
      employee.sessionId !== scope.sessionId ||
      employee.sessionGeneration !== scope.sessionGeneration ||
      !employee.dockerBinding ||
      employee.dockerBinding.containerId !== scope.containerId ||
      !row.destination ||
      employee.onVacation ||
      !employee.desiredRunning
    )
      throw new PlanMoveError('The current employee plan binding is unavailable', 409);
    const saved = this.#d.ctx.store.getSession(scope.sessionId);
    if (
      !saved ||
      saved.owner !== owner ||
      saved.id !== scope.sessionId ||
      saved.remote ||
      saved.customModel ||
      !accountReplacementProfile(saved.mode) ||
      !nativeThreadProfile(saved.mode ?? 'claude')
    )
      throw new PlanMoveError('The current native account recipe is unavailable', 409);
    const subject = this.#d.store.existingSubject(employeeId, row);
    const actualSession = this.#d.ctx.sessions.get(saved.id);
    if (
      actualSession &&
      dockerEmployeeProviderSourceDigest(employee, { ...saved, ...actualSession.providerRecipeState() }) !==
        subject?.providerSourceDigest
    )
      throw new PlanMoveError('The actual source permission or recipe changed', 409);
    if (!subject) throw new PlanMoveError('The source recipe changed', 409);
    return {
      scope,
      subject,
      employee: structuredClone(employee),
      row: structuredClone(row),
      binding: structuredClone(employee.dockerBinding),
      saved: structuredClone(saved),
    };
  }
  #sourceCurrent(selection: SourceSelection): () => void {
    return () => {
      this.#d.current();
      const actual = this.#selection(selection.employee.id, selection.employee.owner);
      if (
        !same(actual.binding, selection.binding) ||
        !dockerPlanSourceRecordCurrent(selection.row, actual.row) ||
        actual.subject.providerSourceDigest !== selection.subject.providerSourceDigest
      )
        throw new PlanMoveError('The original Docker source changed', 409);
    };
  }
  async #sourceAccount(saved: SessionState, current: () => void): Promise<PlanAccount> {
    current();
    const account = await this.#d.plans.accountForSavedState(saved);
    current();
    if (!account) throw new PlanMoveError('The original selected account is unavailable', 409);
    return account;
  }
  async admitDisjointGeneration(
    employeeId: string,
    owner: string | undefined,
    rows: readonly Readonly<PlanMoveRecord>[]
  ): Promise<unknown> {
    const selected = this.#selection(employeeId, owner),
      current = this.#sourceCurrent(selected);
    const native = await this.#source.capture(selected.row, selected.binding, current, true);
    return captureDockerPlanDisjointGeneration(this.#requester, native, selected.row, selected.binding, rows, current);
  }
  async snapshot(
    employeeId: string,
    owner: string | undefined,
    purpose?: 'runtime-refresh'
  ): Promise<PlanMoveSnapshot> {
    if (purpose) throw new PlanMoveError('Docker runtime refresh uses its separate resource operation', 409);
    const selected = this.#selection(employeeId, owner),
      current = this.#sourceCurrent(selected),
      account = await this.#sourceAccount(selected.saved, current),
      proof = await this.#source.capture(selected.row, selected.binding, current, true);
    current();
    const observed = proof.observation(selected.row, selected.binding),
      session = this.#d.ctx.sessions.get(selected.saved.id),
      profile = accountReplacementProfile(selected.saved.mode)!;
    const snapshot = {
      backend: 'docker' as const,
      sessionId: selected.saved.id,
      sessionGeneration: selected.binding.sessionGeneration,
      name: selected.saved.name ?? selected.employee.name,
      account: account.id,
      working: observed.kind === 'running' ? (session?.isWorking ?? true) : false,
      mode: selected.saved.mode,
      model: profile.model(selected.saved),
    };
    current();
    return snapshot;
  }
  async reserve(
    originalInput: Readonly<PlanMoveInput>,
    owner: string | undefined,
    requestDigest: string
  ): Promise<DockerPlanMoveSeed> {
    const input = structuredClone(originalInput);
    this.#d.current();
    if (!this.#requester) unavailable();
    requireDockerPlanMoveRequesterReservation(this.#requester, input, owner);
    const selected = this.#selection(input.employeeId, owner),
      current = this.#sourceCurrent(selected),
      account = await this.#d.plans.account(input.toAccount);
    current();
    if (!account) throw new PlanMoveError('The destination plan is unavailable', 404);
    const snapshot = await DockerPlanAccountSnapshot.capture(this.#d.plans, account.id, current);
    try {
      snapshot.selected(account);
      // Immutable target eligibility is setup. Sample the final native source
      // facts after it, retaining the same scope checks and five-second proof.
      const workerImage = await this.#d.engine.replacementTargetImage(selected.row.destination!, current);
      current();
      const native = await this.#source.capture(selected.row, selected.binding, current, input.forceBusy);
      current();
      // The final target recipe is composed by the shared schema renderer before
      // this seed can be returned. There is no effects-bearing placeholder seed.
      return await this.#reserveRecipe(
        input,
        requestDigest,
        selected,
        account,
        snapshot,
        native.observation(selected.row, selected.binding),
        workerImage,
        current
      );
    } finally {
      snapshot.close();
    }
  }
  async #policy(
    source: Pick<SourceSelection, 'employee' | 'saved'>,
    current: () => void
  ): Promise<RuntimeRefreshPolicy> {
    current();
    const session = this.#d.ctx.sessions.get(source.saved.id),
      global = await this.#d.ctx.getClaudeModeConfig();
    current();
    const mode = await resolveClaudeModeForUsername(
      session?.claudeMode ?? source.saved.claudeMode ?? global.claudeMode,
      source.employee.owner
    );
    current();
    return {
      claudeMode: mode,
      allowedTools: session?.allowedTools ?? source.saved.allowedTools,
      niceConfig: session?.niceConfig,
    };
  }
  async #reserveRecipe(
    input: Readonly<PlanMoveInput>,
    requestDigest: string,
    source: SourceSelection,
    account: PlanAccount,
    snapshot: DockerPlanAccountSnapshot,
    observation: DockerPlanMoveSeed['source']['observation'],
    workerImage: DockerEmployeeContinuationRecord['workerImage'],
    current: () => void
  ): Promise<DockerPlanMoveSeed> {
    const sessionId = randomUUID(),
      policy = await this.#policy(source, current),
      target = dockerPlanMoveTargetRecipe(
        source.saved,
        account,
        input,
        { sessionId, owner: source.employee.owner, at: Date.now() },
        policy,
        { kind: 'template' }
      );
    current();
    snapshot.require();
    if (!nativeThreadProfile(target.saved.mode ?? 'claude'))
      throw new PlanMoveError('A qualified stock target protocol is required', 409);
    // Credentials come from the held canonical selection. Source history is
    // resolved independently; it never selects refreshed account material.
    const accountSource = { kind: 'canonical' as const };
    current();
    return DockerPlanMoveSeed.parse({
      version: 1,
      purpose: 'docker-plan-replacement-seed-v1',
      moveId: input.id,
      forceBusy: input.forceBusy,
      handoff: input.handoff,
      source: {
        record: source.row,
        binding: source.binding,
        providerSourceDigest: source.subject.providerSourceDigest,
        observation,
      },
      target: {
        sessionId,
        sessionGeneration: source.binding.sessionGeneration + 1,
        operationId: randomUUID(),
        credentialId: randomUUID(),
        accountId: account.id,
        runtimeNamespace: 'session-v1',
        provider: account.provider,
        model: accountReplacementProfile(target.saved.mode)?.model(target.saved),
        accountSnapshotDigest: snapshot.descriptor.canonicalSnapshotDigest,
        accountSource,
        templateDigest: target.templateDigest,
        workerImage,
      },
      requestDigest,
    });
  }
  async prepare(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void> {
    journal.current();
    requireCanonicalAccountSource(journal.read());
    this.current(record, journal.read());
    const state = journal.read();
    // An already installed, unpaid original keeps its immutable target pair.
    // The current website must validate its own pair, then read that original's
    // actual fixed CLI. This observation grants no paid/effect capability.
    const installedOriginal =
      !state.paidDispatch &&
      state.sourceStop?.phase === 'closed' &&
      state.sourceReader?.phase === 'closed' &&
      state.work?.phase === 'identity-ready' &&
      state.work.destination !== undefined;
    // A retained reservation with no issued native cursor also keeps its exact
    // saved target. Validate it read-only, independently of the current website.
    const unissuedOriginal = !state.paidDispatch && !state.sourceStop && !state.sourceReader && !state.work;
    requireDockerPlanProtocol(
      installedOriginal || unissuedOriginal
        ? this.#d.configuration.clientManifestDigest
        : state.seed.target.workerImage.clientManifestDigest,
      () => journal.current()
    );
    if (!nativeThreadProfile(state.seed.target.provider === 'anthropic' ? 'claude' : 'codex'))
      throw new PlanMoveError('The selected target protocol changed', 409);
    const policy = this.#d.store.newOperationPolicy(record.employeeId);
    if (!same(policy, { ...state.seed.source.record.policy, memoryHighBytes: policy.memoryHighBytes }))
      throw new PlanMoveError('Plan moves cannot change shared pool or other resource limits', 409);
    const pool = await this.#d.engine.observePool(state.seed.source.record);
    journal.current();
    if (!pool || !same(pool, state.seed.source.record.pool))
      throw new PlanMoveError('The original shared pool must be reconciled first', 409);
    const target = await this.#snapshot(record, journal);
    try {
      target.snapshot.selected(target.account);
      const selected = await this.#d.engine.replacementTargetImage(state.seed.source.record.destination!, () =>
        journal.current()
      );
      journal.current();
      if (installedOriginal || unissuedOriginal) {
        if (
          selected.sourceImageId !== state.seed.target.workerImage.sourceImageId ||
          selected.imageId !== this.#d.configuration.workerImageId ||
          selected.clientManifestDigest !== this.#d.configuration.clientManifestDigest
        )
          throw new PlanMoveError('The current default worker/client pair changed', 409);
        if (installedOriginal)
          await this.#workFor(record, journal).engine.inspectPlanReplacementProtocol(state.work!, () =>
            journal.current()
          );
        else
          await this.#d.engine.qualifyPlanReplacementImage(
            state.seed.source.record.destination!,
            state.seed.target.workerImage,
            () => journal.current()
          );
        journal.current();
      } else if (!same(selected, state.seed.target.workerImage))
        throw new PlanMoveError('The selected target image changed', 409);
    } finally {
      target.snapshot.close();
    }
  }
  async idle(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal, signal: AbortSignal): Promise<void> {
    const deadline = performance.now() + 300000;
    for (;;) {
      signal.throwIfAborted();
      journal.current();
      const state = journal.read();
      this.current(record, state);
      if (state.seed.forceBusy) return;
      const scope =
        this.#decision instanceof NativeCooperation
          ? NativeCooperation.prototype.scope.call(this.#decision)
          : requireDockerPlanMoveRequesterSource(this.#requester, record.employeeId, record.owner);
      if (this.#decision instanceof NativeCooperation) {
        if (!('requestId' in scope) || scope.requestId !== record.id)
          throw new PlanMoveError('The cooperative decision changed', 403);
      } else if (!('purpose' in scope) || scope.purpose !== 'original')
        throw new PlanMoveError('A genuine approved original plan choice is required', 403);
      if (
        scope.employeeId !== record.employeeId ||
        scope.sessionId !== state.seed.source.binding.sessionId ||
        scope.sessionGeneration !== state.seed.source.binding.sessionGeneration ||
        scope.containerId !== state.seed.source.binding.containerId
      )
        throw new PlanMoveError('The cooperative source scope changed', 403);
      const session = this.#d.ctx.sessions.get(record.oldSession);
      if (!session) throw new PlanMoveError('The cooperative source viewer is unavailable', 409);
      const proof = await this.#source.capture(
        state.seed.source.record,
        state.seed.source.binding,
        () => journal.current(),
        false
      );
      journal.current();
      proof.require(state.seed.source.record, state.seed.source.binding);
      const mark = getCli(session.mode)?.capabilities.composerReadyMark;
      if (!mark) throw new PlanMoveError('The cooperative source has no protected composer', 409);
      if (session.pid !== null && recoveryComposerReady(session, mark)) return;
      if (performance.now() >= deadline) throw new PlanMoveError('The employee did not yield before the deadline', 409);
      await delay(100, undefined, { signal });
    }
  }
  async stopSource(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void> {
    journal.current();
    requireCanonicalAccountSource(journal.read());
    let state = journal.read();
    this.current(record, state);
    const seed = state.seed,
      source = seed.source.record,
      binding = seed.source.binding;
    const observe = async () => {
      const proof = await this.#source.capture(source, binding, () => journal.current(), true);
      journal.current();
      return proof.observation(source, binding);
    };
    let seen = await observe();
    if (state.sourceStop?.phase === 'closed') {
      if (seen.kind !== 'stopped') throw new PlanMoveError('The original source became live again', 409);
      return;
    }
    if (state.sourceStop) {
      if (seen.kind !== 'stopped') throw new PlanMoveError('The original source STOP outcome is unconfirmed', 409);
    } else if (seen.kind === 'running') {
      if (seed.source.observation.kind !== 'running' || !same(seen.init, seed.source.observation.init))
        throw new PlanMoveError('The source init incarnation changed', 409);
      const next = {
        ...state,
        sourceStop: {
          phase: 'issued' as const,
          epoch: journal.epoch,
          sourceContainerId: binding.containerId,
          sourceConfigurationDigest: source.destination!.configurationDigest,
          sourceInit: seen.init,
        },
      };
      await journal.publish(state, next);
      journal.current();
      state = journal.read();
      // One original exact-CID STOP. Lost replies are observed, never replayed.
      const immediatelyBefore = await observe();
      journal.current();
      if (immediatelyBefore.kind !== 'running' || !same(immediatelyBefore.init, next.sourceStop.sourceInit))
        throw new PlanMoveError('The source changed before its original STOP', 409);
      try {
        await this.#command.run(['container', 'stop', '--time', '5', binding.containerId]);
      } catch {
        journal.current();
        throw new PlanMoveError('The original source STOP reply is unconfirmed', 409);
      }
      journal.current();
      seen = await observe();
      if (seen.kind !== 'stopped') throw new PlanMoveError('The original source is not closed', 409);
    }
    if (seen.kind !== 'stopped') throw new PlanMoveError('The original source closure is unavailable', 409);
    state = journal.read();
    await journal.publish(state, {
      ...state,
      sourceStop: {
        phase: 'closed',
        epoch: state.sourceStop?.epoch ?? journal.epoch,
        sourceContainerId: binding.containerId,
        sourceConfigurationDigest: source.destination!.configurationDigest,
        sourceInit: seed.source.observation.kind === 'running' ? seed.source.observation.init : null,
        terminalStateDigest: seen.terminalStateDigest,
      },
    });
    journal.current();
  }
  /** Retain original work FD custody for the lifetime of published views. */
  close(): void {
    for (const work of this.#work.values()) work.close();
    this.#work.clear();
    this.#views.clear();
    this.#holders.clear();
  }
  #sourceSaved(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): SessionState {
    journal.current();
    const seed = journal.read().seed,
      saved = this.#d.ctx.store.getSession(seed.source.binding.sessionId),
      employee = this.#d.company.store.snapshot().employees.find((e) => e.id === record.employeeId);
    const actualSession = this.#d.ctx.sessions.get(seed.source.binding.sessionId);
    if (
      actualSession &&
      employee &&
      saved &&
      dockerEmployeeProviderSourceDigest(employee, { ...saved, ...actualSession.providerRecipeState() }) !==
        seed.source.providerSourceDigest
    )
      throw new PlanMoveError('The actual source permission or recipe changed', 409);
    if (
      !saved ||
      saved.owner !== record.owner ||
      !employee ||
      !same(employee.dockerBinding, seed.source.binding) ||
      !nativeThreadProfile(saved.mode ?? 'claude') ||
      dockerEmployeeProviderSourceDigest(employee, saved) !== seed.source.providerSourceDigest
    )
      throw new PlanMoveError('The stopped source recipe changed', 409);
    return structuredClone(saved);
  }
  async #snapshot(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal) {
    journal.current();
    const seed = journal.read().seed;
    if (seed.moveId !== record.id) throw new PlanMoveError('The selected operation changed', 409);
    const account = await this.#d.plans.account(seed.target.accountId);
    journal.current();
    if (!account || account.provider !== seed.target.provider)
      throw new PlanMoveError('The selected account changed', 409);
    const snapshot = await DockerPlanAccountSnapshot.capture(this.#d.plans, account.id, () => journal.current());
    if (snapshot.descriptor.canonicalSnapshotDigest !== seed.target.accountSnapshotDigest) {
      snapshot.close();
      throw new PlanMoveError('The selected account material changed after reservation', 409);
    }
    return { account, snapshot };
  }
  #originalRow(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal) {
    journal.current();
    const state = journal.read();
    if (
      record.id !== state.seed.moveId ||
      record.employeeId !== state.seed.source.record.employeeId ||
      record.owner !== state.seed.source.record.owner
    )
      throw new PlanMoveError('Original plan operation changed', 409);
    return state;
  }
  #retain(): void {
    if (!this.#registered) {
      this.#registered = true;
      this.#d.retain(this);
    }
  }
  #workFor(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal) {
    const state = this.#originalRow(record, journal),
      key = record.id + ':' + journal.epoch;
    let work = this.#work.get(key);
    if (!work) {
      this.#retain();
      work = new DockerPlanMoveWork(
        {
          command: this.#command,
          deployment: this.#d.configuration.deployment,
          boxId: this.#d.boxId,
          helperImageId: this.#d.configuration.helperImageId,
          memoryHighHelperImageId: this.#d.configuration.memoryHighHelperImageId,
          poolRestoreHelperImageId: this.#d.configuration.poolRestoreHelperImageId,
          target: {
            imageId: state.seed.target.workerImage.imageId,
            clientManifestDigest: state.seed.target.workerImage.clientManifestDigest,
            sourceImageIds: this.#d.configuration.sourceImageIds,
          },
          canonical: this.#d.store,
          moves: this.#d.moves,
          revisions: this.#d.revisions,
          providerMode: state.seed.target.provider === 'anthropic' ? 'claude' : 'codex',
        },
        journal
      );
      this.#work.set(key, work);
    }
    return work;
  }
  #holder(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal) {
    const key = record.id + ':' + journal.epoch;
    let holder = this.#holders.get(key);
    if (!holder) {
      this.#retain();
      holder = new DockerPlanSourceHolder(this.#command, this.#d.boxId, this.#source, (row, current) =>
        this.#d.engine.planReplacementHome(row, current)
      );
      this.#holders.set(key, holder);
    }
    return holder;
  }
  async #closed(row: DockerEmployeeContinuationRecord, journal: PlanMoveDockerJournal): Promise<void> {
    const binding = this.#binding(row),
      proof = await this.#source.capture(row, binding, () => journal.current(), true);
    journal.current();
    if (proof.observation(row, binding).kind !== 'stopped')
      throw new PlanMoveError('The retained account generation is not closed', 409);
    const home = await this.#d.engine.planReplacementHome(row, () => journal.current());
    journal.current();
    const actual = await this.#d.engine.planReplacementHome(journal.read().seed.source.record, () => journal.current());
    journal.current();
    if (!same(home, actual)) throw new PlanMoveError('The retained account HOME changed', 409);
  }
  #binding(row: DockerEmployeeContinuationRecord): DockerEmployeeBinding {
    if (!row.destination) throw new PlanMoveError('Original target is unavailable', 409);
    return Binding.parse({
      version: 1,
      operationId: row.request.operationId,
      credentialId: row.credentialId,
      sessionId: row.request.sessionId,
      sessionGeneration: row.request.sessionGeneration,
      containerId: row.destination.containerId,
      imageId: row.destination.imageId,
      originalDigest: dockerContinuationDigest(row.destination),
      policyDigest: dockerContinuationDigest(row.policy),
    });
  }
  async #retained(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal) {
    const selected = journal.read().seed.target.accountSource;
    if (selected.kind !== 'retained-generation') return;
    const historical = await this.#d.moves.dockerRecord(selected.moveId);
    journal.current();
    const row = historical.dockerReplacement?.work;
    if (
      !row ||
      row.version !== 3 ||
      row.employeeId !== record.employeeId ||
      row.owner !== record.owner ||
      row.request.operationId !== selected.operationId ||
      row.destination?.containerId !== selected.containerId ||
      row.planReplacement.account.projectionDigest !== selected.projectionDigest
    )
      throw new PlanMoveError('The retained account lineage changed', 409);
    const published = Published.parse(row);
    if (published.version !== 3) throw new PlanMoveError('The retained generation is unavailable', 409);
    await this.#closed(published, journal);
    const initial = await this.#d.engine.planReplacementOriginal(published, () => journal.current());
    journal.current();
    return { row: published, initial };
  }
  async #context(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    source: SessionState,
    holder: DockerPlanSourceHolder
  ): Promise<{
    context: DockerPlanSourceContext;
    contextSource?: string;
    candidateSnapshot?: DockerPlanAccountSnapshot;
  }> {
    const seed = journal.read().seed,
      sameProvider = accountReplacementProfile(source.mode)?.provider === seed.target.provider;
    if (!sameProvider) {
      await holder.open(record, journal);
      return { context: { source: { kind: 'none' as const }, roles: [], conversation: null } };
    }
    const nativeId = nativeThreadProfile(source.mode ?? 'claude')?.read(source);
    if (!nativeId) throw new PlanMoveError('The stopped source native conversation is unconfirmed', 409);
    if (seed.source.record.version === 3) {
      await holder.open(record, journal);
      const initial = await this.#d.engine.planReplacementOriginal(seed.source.record, () => journal.current());
      journal.current();
      return holder.context(record, journal, { kind: 'generation', row: seed.source.record, initial, nativeId });
    }
    const candidate = await this.#candidate(record, journal, source);
    try {
      await holder.open(record, journal, candidate);
      const result = await holder.context(record, journal, {
        kind: candidate ? 'account' : 'legacy',
        provider: seed.target.provider,
        nativeId,
      });
      journal.current();
      const actual = this.#d.ctx.store.getSession(source.id);
      if (!actual || nativeThreadProfile(actual.mode ?? 'claude')?.read(actual) !== nativeId)
        throw new PlanMoveError('The stopped source conversation changed during its read', 409);
      return { ...result, candidateSnapshot: candidate?.snapshot };
    } catch (error) {
      candidate?.snapshot.close();
      throw error;
    }
  }
  async #candidate(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal, source: SessionState) {
    const seed = this.#originalRow(record, journal).seed;
    if (seed.source.record.version === 3 || accountReplacementProfile(source.mode)?.provider !== seed.target.provider)
      return;
    const account = await this.#sourceAccount(source, () => journal.current());
    const text = await this.#command.run(['container', 'inspect', seed.source.binding.containerId]);
    journal.current();
    const raw = z.array(DockerEmployeeInspect).length(1).parse(JSON.parse(text))[0]!,
      key = account.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      entries = raw.Config.Env.filter((e) => e.startsWith(key + '='));
    if (entries.length > 1) throw new PlanMoveError('The source account projection is ambiguous', 409);
    const path =
      entries[0]?.slice(key.length + 1) ?? '/home/agent/' + (account.provider === 'anthropic' ? '.claude' : '.codex');
    const external =
      raw.Mounts.some(
        (m) =>
          m.Type === 'bind' &&
          m.Destination !== '/home/agent' &&
          (path === m.Destination || path.startsWith(m.Destination + '/'))
      ) || !path.startsWith('/home/agent/');
    if (!external) return;
    const snapshot = await DockerPlanAccountSnapshot.capture(this.#d.plans, account.id, () => journal.current());
    return { account, snapshot };
  }
  async #compose(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    source: SessionState,
    account: PlanAccount,
    authDigest: string,
    context: import('./docker-plan-source-data.js').DockerPlanSourceContext
  ) {
    const state = journal.read(),
      seed = state.seed,
      selection = {
        operationId: seed.target.operationId,
        sessionId: seed.target.sessionId,
        provider: seed.target.provider,
        accountId: seed.target.accountId,
        context,
      },
      material = dockerPlanMaterial(selection, authDigest);
    const input: PlanMoveInput = {
      id: record.id,
      employeeId: record.employeeId,
      sessionId: record.oldSession,
      fromAccount: record.fromAccount,
      toAccount: record.toAccount,
      model: seed.target.model,
      forceBusy: seed.forceBusy,
      handoff: seed.handoff,
    };
    const employee = this.#d.company.store.snapshot().employees.find((e) => e.id === record.employeeId);
    if (!employee || !same(employee.dockerBinding, seed.source.binding))
      throw new PlanMoveError('The original employee binding changed', 409);
    const policy = await this.#policy({ employee, saved: source }, () => journal.current()),
      target = dockerPlanMoveTargetRecipe(
        source,
        account,
        input,
        { sessionId: seed.target.sessionId, owner: record.owner, at: record.at },
        policy,
        { kind: 'resolved', nativeId: context.conversation?.nativeId ?? null }
      );
    journal.current();
    if (target.templateDigest !== seed.target.templateDigest)
      throw new PlanMoveError('The selected target recipe changed', 409);
    if (accountReplacementProfile(source.mode)?.provider === seed.target.provider) {
      const actual = this.#d.ctx.store.getSession(source.id);
      if (!actual || nativeThreadProfile(actual.mode ?? 'claude')?.read(actual) !== context.conversation?.nativeId)
        throw new PlanMoveError('The stopped source conversation changed', 409);
    }
    const targetEmployee = {
        ...employee,
        sessionId: seed.target.sessionId,
        sessionGeneration: seed.target.sessionGeneration,
        runtimeRecipe: target.recipe,
      },
      resourcePolicy = this.#d.store.newOperationPolicy(record.employeeId),
      raw = z
        .array(DockerEmployeeInspect)
        .length(1)
        .parse(JSON.parse(await this.#command.run(['container', 'inspect', seed.source.binding.containerId])))[0]!;
    journal.current();
    if (!same(resourcePolicy, { ...seed.source.record.policy, memoryHighBytes: resourcePolicy.memoryHighBytes }))
      throw new PlanMoveError('Plan moves cannot change non-memory resource limits', 409);
    const ephemeral = ephemeralRetainedProjection(raw, seed.source.record.destination!);
    const networkIds = await this.#d.engine.planReplacementNetworkIds(seed.source.record, () => journal.current());
    journal.current();
    const row = WorkRecord.parse({
      version: 3,
      purpose: 'docker-employee-plan-replacement-v3',
      employeeId: record.employeeId,
      ...(record.owner === undefined ? {} : { owner: record.owner }),
      request: {
        operationId: seed.target.operationId,
        sessionId: seed.target.sessionId,
        sessionGeneration: seed.target.sessionGeneration,
        containerId: seed.source.binding.containerId,
        imageId: seed.source.binding.imageId,
        expectedPolicyDigest: dockerContinuationDigest(resourcePolicy),
        expectedDestinationImageId: seed.target.workerImage.imageId,
        enterOffice: false,
      },
      sourceDigest: dockerEmployeeSourceDigest(targetEmployee, target.saved),
      providerSourceDigest: dockerEmployeeProviderSourceDigest(targetEmployee, target.saved),
      original: seed.source.record.destination,
      workerImage: seed.target.workerImage,
      policy: resourcePolicy,
      credentialId: seed.target.credentialId,
      phase: 'staged',
      planReplacement: {
        version: 1,
        purpose: 'docker-plan-replacement-provenance-v1',
        ...(seed.target.runtimeNamespace ? { runtimeNamespace: seed.target.runtimeNamespace } : {}),
        moveId: record.id,
        source: {
          binding: seed.source.binding,
          continuationDigest: dockerContinuationDigest(seed.source.record),
          providerSourceDigest: seed.source.providerSourceDigest,
          ...(ephemeral && ephemeral.layout !== 'employees' ? { ephemeralSessionId: ephemeral.identity } : {}),
          networkIds,
        },
        account: {
          id: account.id,
          provider: account.provider,
          projectionDigest: material.projectionDigest,
          contextDigest: material.contextInputDigest,
        },
      },
    });
    return { row, saved: target.saved, recipe: target.recipe, selection };
  }
  #sameWork(before: WorkRecord, next: WorkRecord): boolean {
    const fixed = ({
      phase: _phase,
      tasks: _tasks,
      pool: _pool,
      destination: _destination,
      ephemeralRestoration: _ephemeral,
      ...rest
    }: WorkRecord) => rest;
    return same(fixed(before), fixed(next));
  }
  async start(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void> {
    journal.current();
    requireCanonicalAccountSource(journal.read());
    let state = this.#originalRow(record, journal);
    if (state.paidDispatch)
      throw new PlanMoveError('The original paid dispatch is issued; inspect without replay', 409);
    if (state.sourceStop?.phase !== 'closed') throw new PlanMoveError('The original source is not closed', 409);
    const source = this.#sourceSaved(record, journal),
      target = await this.#snapshot(record, journal),
      holder = this.#holder(record, journal);
    let candidateSnapshot: DockerPlanAccountSnapshot | undefined;
    try {
      if (state.work?.phase === 'identity-ready' && state.sourceReader?.phase === 'closed') {
        if (!state.material) throw new PlanMoveError('The original resolved material is unavailable', 409);
        const candidate = await this.#candidate(record, journal, source);
        candidateSnapshot = candidate?.snapshot;
        await holder.inspect(record, journal, candidate);
        journal.current();
        const composed = await this.#compose(
          record,
          journal,
          source,
          target.account,
          state.material.authDigest,
          state.material.context
        );
        journal.current();
        if (!this.#sameWork(state.work, composed.row)) throw new PlanMoveError('The held target material changed', 409);
        const transaction = this.#workFor(record, journal);
        await transaction.prepareNative();
        journal.current();
        const row = transaction.row();
        const initial = await transaction.engine.initialPlanReplacementInstallation(row, () => journal.current());
        journal.current();
        if (
          initial.installedAuthDigest !== state.material.authDigest ||
          initial.contextInputDigest !== dockerContinuationDigest(state.material.context)
        )
          throw new PlanMoveError('The installed original material changed', 409);
        await this.#accountProbe(row, () => journal.current(), 'initial');
        journal.current();
        await transaction.engine.initialPlanReplacementInstallation(row, () => journal.current());
        journal.current();
        await this.#dispatch(record, journal, composed, transaction);
        return;
      }
      const selected = await this.#context(record, journal, source, holder);
      candidateSnapshot = selected.candidateSnapshot;
      const retained = await this.#retained(record, journal),
        auth = retained ? (await holder.auth(record, journal, retained)).auth : target.snapshot.authText();
      journal.current();
      target.snapshot.require();
      const authDigest = dockerPlanAuthDigest(auth),
        composed = await this.#compose(record, journal, source, target.account, authDigest, selected.context);
      journal.current();
      state = journal.read();
      if (state.work) {
        if (
          !state.material ||
          !this.#sameWork(state.work, composed.row) ||
          !same(state.material, { context: selected.context, authDigest })
        )
          throw new PlanMoveError('The held target material changed', 409);
      } else
        await journal.publish(state, {
          ...state,
          material: { context: selected.context, authDigest },
          work: composed.row,
        });
      const transaction = this.#workFor(record, journal);
      await transaction.prepareNative();
      journal.current();
      let row = transaction.row();
      if (row.phase === 'resources-ready') {
        await transaction.phase('identity-issued');
        row = transaction.row();
      }
      if (!row.destination) throw new PlanMoveError('The target destination is unavailable', 409);
      const token = this.#d.authentication.issue(
          {
            employeeId: row.employeeId,
            owner: row.owner,
            sessionId: row.request.sessionId,
            sessionGeneration: row.request.sessionGeneration,
            containerId: row.destination.containerId,
            credentialId: row.credentialId,
          },
          () => {
            journal.current();
            return true;
          }
        ),
        payload = dockerPlanPayload(composed.selection, row.destination.containerId, auth, token);
      if (row.phase === 'identity-issued') {
        await transaction.engine.installPlanReplacement(row, payload, selected.contextSource, () => journal.current());
        journal.current();
        await transaction.phase('identity-ready');
      }
      row = transaction.row();
      if (row.phase !== 'identity-ready') throw new PlanMoveError('The original target install is unconfirmed', 409);
      await holder.close(record, journal);
      journal.current();
      await this.#accountProbe(row, () => journal.current(), 'initial');
      journal.current();
      await transaction.engine.observePlanReplacementInstallation(row, payload, selected.contextSource, () =>
        journal.current()
      );
      journal.current();
      await this.#dispatch(record, journal, composed, transaction);
    } finally {
      candidateSnapshot?.close();
      target.snapshot.close();
    }
  }
  async #dispatch(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    composed: { saved: SessionState; recipe: RuntimeRecipe },
    transaction: DockerPlanMoveWork
  ): Promise<void> {
    const row = transaction.row();
    if (row.phase !== 'identity-ready' || journal.read().sourceReader?.phase !== 'closed')
      throw new PlanMoveError('The original target is not ready for dispatch', 409);
    const inert = await transaction.engine.observePlanReplacementWork(row, () => journal.current());
    journal.current();
    if (!inert || inert.provider.kind !== 'absent')
      throw new PlanMoveError('The original target is not positively provider-absent', 409);
    const state = journal.read();
    if (state.paidDispatch) throw new PlanMoveError('The original paid intent already exists', 409);
    const published = publishedWork({ ...row, phase: 'provider-issued' });
    await journal.publish(state, {
      ...state,
      work: published,
      paidDispatch: {
        phase: 'issued',
        epoch: journal.epoch,
        operationId: row.request.operationId,
        sessionId: row.request.sessionId,
        containerId: row.destination!.containerId,
        recipeDigest: row.sourceDigest,
      },
    });
    journal.current();
    await this.#publish(record, journal, composed.saved, composed.recipe);
    journal.current();
    const current = this.#targetCurrent(record, journal),
      admission = new NativePlanDispatch(published, this.#binding(published), () => {
        if (journal.publication === 'failed') throw new PlanMoveError('The target publication failed', 409);
        if (journal.publication === 'admitting') {
          journal.current();
          transaction.engine.assertPreparationCurrent(row);
        }
        current();
      });
    await this.#d.provider.launchPlanReplacement(admission, published, this.#binding(published), () =>
      admission.require(published, this.#binding(published))
    );
    journal.current();
  }
  async #accountProbe(row: WorkRecord, current: () => void, readMode: 'initial' | 'live' = 'live'): Promise<void> {
    current();
    if (!row.destination) throw new PlanMoveError('The selected account target is unavailable', 409);
    const provider = row.planReplacement.account.provider;
    let text: string;
    try {
      text = await this.#command.run(
        dockerPlanAccountStatusArguments({
          operationId: row.request.operationId,
          projectionDigest: row.planReplacement.account.projectionDigest,
          provider,
          containerId: row.destination.containerId,
        }, readMode)
      );
    } catch {
      current();
      throw new PlanMoveError('The target account status is unconfirmed', 409);
    }
    current();
    try {
      const value = DockerPlanAccountStatus.parse(JSON.parse(text));
      if (value.provider !== provider) throw Error();
    } catch {
      throw new PlanMoveError('The selected account is not authenticated', 409);
    }
  }
  async #canonicalAccount(row: WorkRecord, journal: PlanMoveDockerJournal, current: () => void): Promise<void> {
    journal.current();
    const state = journal.read();
    requireCanonicalAccountSource(state);
    if (!state.material) throw new PlanMoveError('The installed canonical account digest is unavailable', 409);
    await this.#d.engine.verifyPlanReplacementCanonicalAccount(publishedWork(row), state.material.authDigest, () => {
      journal.current();
      current();
    });
    journal.current();
    current();
  }
  #targetCurrent(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): () => void {
    const captured = journal.read().work;
    if (!captured?.destination || !['provider-issued', 'ready'].includes(captured.phase))
      throw new PlanMoveError('The original target publication is unavailable', 409);
    return () => {
      this.#d.current();
      if (journal.publication === 'failed') throw new PlanMoveError('The original target publication failed', 409);
      const state = this.#d.company.store.snapshot(),
        employees = state.employees.filter((e) => e.id === record.employeeId),
        employee = employees[0],
        rows = state.dockerEmployeeContinuations?.filter((r) => r.employeeId === record.employeeId) ?? [],
        row = rows[0],
        saved = this.#d.ctx.store.getSession(captured.request.sessionId);
      if (
        employees.length !== 1 ||
        rows.length !== 1 ||
        !employee ||
        !row ||
        !saved ||
        employee.owner !== record.owner ||
        employee.bindingMigration ||
        employee.onVacation ||
        !employee.desiredRunning ||
        !same(employee.dockerBinding, this.#binding(captured)) ||
        !same({ ...row, phase: captured.phase }, captured) ||
        (captured.phase === 'ready' && row.phase !== 'ready') ||
        dockerProviderRuntimeRecipeDigest(employee.runtimeRecipe) !== journal.read().seed.target.templateDigest ||
        dockerEmployeeProviderSourceDigest(employee, saved) !== captured.providerSourceDigest
      )
        throw new PlanMoveError('The original target binding or recipe changed', 409);
    };
  }
  #publicationDigest(state: Readonly<DockerPlanMoveJournalState>): string {
    const row = publishedWork(state.work);
    return dockerContinuationDigest({
      row: { ...row, phase: 'provider-issued' },
      binding: this.#binding(row),
      templateDigest: state.seed.target.templateDigest,
    });
  }
  async #publish(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    saved: SessionState,
    recipe: RuntimeRecipe
  ): Promise<void> {
    let state = journal.read();
    const row = publishedWork(state.work),
      binding = this.#binding(row),
      digest = this.#publicationDigest(state);
    if (dockerProviderRuntimeRecipeDigest(recipe) !== state.seed.target.templateDigest)
      throw new PlanMoveError('The selected publication recipe changed', 409);
    if (state.companyPublication && state.companyPublication.digest !== digest)
      throw new PlanMoveError('The original company publication changed', 409);
    if (!state.companyPublication) {
      await journal.publish(state, { ...state, companyPublication: { phase: 'issued', digest } });
      journal.current();
    }
    const existing = this.#d.ctx.store.getSession(saved.id);
    if (existing && !same(existing, saved)) throw new PlanMoveError('The target saved session already differs', 409);
    if (!existing) {
      this.#d.ctx.store.setSession(saved.id, structuredClone(saved));
      this.#d.ctx.store.saveNow();
      journal.current();
    }
    state = journal.read();
    if (state.companyPublication?.phase === 'published') {
      this.#targetCurrent(record, journal)();
      return;
    }
    const before = this.#d.company.store.snapshot().employees.find((e) => e.id === record.employeeId);
    if (!before || !same(before.dockerBinding, state.seed.source.binding))
      throw new PlanMoveError('The original employee publication changed', 409);
    requireDockerPlanMoveRequesterCurrent(this.#requester, record, state);
    // The journal owns this migration; its current requester supplies authority.
    const by = record.owner ?? 'plan-move';
    await this.#d.chat.replaceSession(record.oldSession, saved.id, by, (room) => room.owner === record.owner);
    journal.current();
    await this.#d.company.store.update(
      (company) => {
        journal.current();
        const employees = company.employees.filter((e) => e.id === record.employeeId),
          employee = employees[0],
          rows = (company.dockerEmployeeContinuations ??= []),
          index = rows.findIndex((r) => r.employeeId === record.employeeId);
        if (
          employees.length !== 1 ||
          !employee ||
          employee.owner !== record.owner ||
          !same(employee.dockerBinding, state.seed.source.binding) ||
          employee.sessionId !== state.seed.source.binding.sessionId ||
          employee.sessionGeneration !== state.seed.source.binding.sessionGeneration ||
          index < 0 ||
          !dockerPlanSourceRecordCurrent(state.seed.source.record, rows[index]) ||
          company.employees.some((e) => e.id !== record.employeeId && e.sessionId === saved.id)
        )
          throw new PlanMoveError('The original company source changed', 409);
        employee.sessionId = saved.id;
        employee.sessionGeneration = row.request.sessionGeneration;
        employee.runtimeRecipe = structuredClone(recipe);
        employee.dockerBinding = structuredClone(binding);
        employee.dockerResourcePolicy = structuredClone(row.policy);
        rows[index] = structuredClone(row);
      },
      () => journal.current()
    );
    journal.current();
    state = journal.read();
    await journal.publish(state, { ...state, companyPublication: { phase: 'published', digest } });
    journal.current();
  }
  async verify(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<() => void> {
    journal.current();
    this.#views.delete(record.id);
    let state = journal.read();
    const row = publishedWork(state.work);
    // Complete only this already-issued ready metadata transition after a lost
    // CompanyStore ACK; it never starts or retypes anything.
    if (row.phase === 'ready') {
      const actual = this.#d.store.record(record.employeeId);
      if (actual?.phase === 'provider-issued' && same({ ...actual, phase: 'ready' }, row)) {
        await this.#d.company.store.update(
          (company) => {
            journal.current();
            const rows = company.dockerEmployeeContinuations ?? [],
              index = rows.findIndex((r) => r.employeeId === record.employeeId);
            if (index < 0 || !same(rows[index], actual))
              throw new PlanMoveError('The original ready metadata changed', 409);
            rows[index] = structuredClone(row);
          },
          () => journal.current()
        );
        journal.current();
      }
    }
    if (state.paidDispatch && state.companyPublication?.phase === 'issued') {
      if (state.companyPublication.digest !== this.#publicationDigest(state))
        throw new PlanMoveError('The original publication digest changed', 409);
      const current = this.#targetCurrent(record, journal);
      current();
      await this.#accountProbe(row, () => {
        journal.current();
        current();
      });
      journal.current();
      const observed = await this.#d.engine.captureProviderView(row, current);
      journal.current();
      const actual = this.#d.ctx.sessions.get(row.request.sessionId);
      if (!actual?.docker) throw new PlanMoveError('The published target viewer is unavailable', 409);
      observed.require(actual.id, actual.docker);
      current();
      const before = journal.read();
      await journal.publish(before, {
        ...before,
        companyPublication: { phase: 'published', digest: state.companyPublication.digest },
      });
      journal.current();
      state = journal.read();
    }
    if (!state.paidDispatch || state.companyPublication?.phase !== 'published')
      throw new PlanMoveError('The target publication is incomplete', 409);
    const current = this.#targetCurrent(record, journal);
    current();
    const view = await this.#d.engine.captureProviderView(row, current);
    journal.current();
    current();
    const session = this.#d.ctx.sessions.get(row.request.sessionId);
    if (!session || !session.docker) throw new PlanMoveError('The target application viewer is unavailable', 409);
    view.require(session.id, session.docker);
    const mark = getCli(session.mode)?.capabilities.composerReadyMark;
    if (!mark) throw new PlanMoveError('The target provider has no protected composer', 409);
    if (!state.handoff && (!recoveryComposerReady(session, mark) || session.pid === null))
      throw new PlanMoveComposerNotReady();
    await this.#accountProbe(row, () => {
      journal.current();
      current();
    });
    journal.current();
    current();
    view.require(session.id, session.docker);
    if (row.phase === 'provider-issued') {
      const before = journal.read();
      await journal.publish(before, { ...before, work: { ...row, phase: 'ready' } });
      journal.current();
      await this.#d.company.store.update(
        (company) => {
          journal.current();
          const index = company.dockerEmployeeContinuations?.findIndex((r) => r.employeeId === record.employeeId) ?? -1;
          if (index < 0 || !same(company.dockerEmployeeContinuations![index], row))
            throw new PlanMoveError('The target ready publication changed', 409);
          company.dockerEmployeeContinuations![index] = publishedWork({ ...row, phase: 'ready' });
        },
        () => journal.current()
      );
      journal.current();
    }
    await this.#canonicalAccount(row, journal, current);
    view.require(session.id, session.docker);
    if (session.providerInputHeld && session.providerDispatchHoldKind === 'loaded-intent') {
      if (!this.#d.renewPublishedView) throw new PlanMoveError('The original published target reader cannot be renewed', 409);
      await this.#d.renewPublishedView(publishedWork(journal.read().work), session, () => {
        journal.current(); current();
        if (this.#d.ctx.sessions.get(session.id) !== session || !session.docker)
          throw new PlanMoveError('The original published target reader changed', 409);
        view.require(session.id, session.docker);
      });
      journal.current(); current();
      view.require(session.id, session.docker);
    }
    this.#views.set(record.id, { view, session });
    return () => {
      current();
      if (this.#d.ctx.sessions.get(session.id) !== session || !session.docker)
        throw new PlanMoveError('The verified target viewer changed', 409);
      view.require(session.id, session.docker);
    };
  }
  async finalize(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void> {
    journal.current();
    let state = journal.read();
    if (state.handoff?.phase === 'submitted') return;
    if (state.handoff)
      throw new PlanMoveError('The original handoff outcome is unconfirmed; it will not be typed again', 409);
    const held = this.#views.get(record.id);
    if (!held || !held.session.docker) throw new PlanMoveError('A fresh target view is required before handoff', 409);
    const current = this.#targetCurrent(record, journal);
    current();
    held.view.require(held.session.id, held.session.docker);
    await this.#canonicalAccount(publishedWork(state.work), journal, current);
    held.view.require(held.session.id, held.session.docker);
    const inputCurrent = () => {
      try {
        journal.current(); current();
        if (this.#d.ctx.sessions.get(held.session.id) !== held.session || !held.session.docker) return false;
        held.view.require(held.session.id, held.session.docker);
        return true;
      } catch { return false; }
    };
    const inputAdmission = Session.prototype.captureInputAdmission.call(held.session, inputCurrent),
      mark = getCli(held.session.mode)?.capabilities.composerReadyMark;
    if (!mark || held.session.pid === null || !inputAdmission() || !recoveryComposerReady(held.session, mark) ||
        !Session.prototype.canAcceptChatInput.call(held.session))
      throw new PlanMoveComposerNotReady();
    await journal.publish(state, {
      ...state,
      handoff: { phase: 'issued', digest: dockerPlanMoveHandoffDigest(state.seed.handoff) },
    });
    journal.current();
    await submitRecoveryPrompt(
      held.session,
      state.seed.handoff,
      inputCurrent,
      undefined,
      { fromUser: true }
    );
    journal.current();
    state = journal.read();
    await journal.publish(state, {
      ...state,
      handoff: { phase: 'submitted', digest: dockerPlanMoveHandoffDigest(state.seed.handoff) },
    });
    journal.current();
  }
  async inspectForContinuation(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<unknown> {
    journal.current();
    let state = journal.read();
    this.current(record, state);
    if (state.paidDispatch) {
      await this.verify(record, journal);
      return new NativeContinuation(this, state, () => journal.current(), true);
    }
    await this.prepare(record, journal);
    if (state.sourceStop?.phase === 'issued') {
      await this.stopSource(record, journal);
      journal.current();
      state = journal.read();
    }
    if (state.sourceStop?.phase === 'closed') await this.#closed(state.seed.source.record, journal);
    if (state.work) {
      await this.#workFor(record, journal).inspect();
      journal.current();
    }
    if (state.sourceReader) {
      const source = this.#sourceSaved(record, journal),
        candidate = await this.#candidate(record, journal, source);
      try {
        await this.#holder(record, journal).inspect(record, journal, candidate);
        journal.current();
      } finally {
        candidate?.snapshot.close();
      }
    }
    return new NativeContinuation(this, journal.read(), () => journal.current(), false);
  }
  /** Core calls only after its checked completed ACK. Failure affects local
   * cleanup status only; no business cursor/provider input is replayed. */
  async retireSource(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void> {
    journal.current();
    if (record.phase !== 'completed' || journal.publication !== 'published' || !this.#d.ctx.retireDockerPlanSource)
      throw new PlanMoveError('Published source-view retirement is unavailable', 409);
    const state = journal.read(),
      row = publishedWork(state.work),
      current = this.#targetCurrent(record, journal),
      target = this.#d.ctx.sessions.get(row.request.sessionId),
      old = this.#d.ctx.sessions.get(record.oldSession);
    if (!target) throw new PlanMoveError('The genuine current target viewer is required', 409);
    const check = () => {
      journal.current();
      current();
      if (
        this.#d.ctx.sessions.get(target.id) !== target ||
        (this.#d.ctx.sessions.get(record.oldSession) !== old &&
          this.#d.ctx.sessions.get(record.oldSession) !== undefined)
      )
        throw new PlanMoveError('The retirement Session references changed', 409);
    };
    const source = await this.#source.capture(state.seed.source.record, state.seed.source.binding, check, true);
    check();
    const view = await this.#d.engine.captureProviderView(row, check);
    check();
    const proof = captureDockerPlanSourceRetirement(record, state, source, view, old, target, check);
    await this.#d.ctx.retireDockerPlanSource(proof);
    // The server deliberately removes the old slot. Only target/runtime/native
    // currency remains relevant after its acknowledged metadata retirement.
    journal.current();
    current();
    if (this.#d.ctx.sessions.get(target.id) !== target)
      throw new PlanMoveError('The completed target Session changed', 409);
  }
  requireContinuation(proof: unknown, state: Readonly<DockerPlanMoveJournalState>): void {
    if (!(proof instanceof NativeContinuation))
      throw new PlanMoveError('A genuine original transaction inspection is required', 409);
    NativeContinuation.prototype.require.call(proof, this, state);
  }
}
/** Initial decision is captured while its short HTTP proof is current. The
 * journal/requester/native checks own every later wait; no stale decision grants
 * another choice or bypasses fresh permissions. */
class NativeCooperation {
  readonly #scope: ReturnType<typeof requireDockerPlanDecisionScope>;
  constructor(scope: ReturnType<typeof requireDockerPlanDecisionScope>) {
    this.#scope = Object.freeze({ ...scope });
    Object.freeze(this);
  }
  scope() {
    return this.#scope;
  }
}
Object.freeze(NativeCooperation.prototype);
class NativePlanDispatch {
  readonly #row: DockerEmployeeContinuationRecord;
  readonly #binding: DockerEmployeeBinding;
  readonly #current: () => void;
  constructor(row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding, current: () => void) {
    this.#row = structuredClone(row);
    this.#binding = structuredClone(binding);
    this.#current = current;
    Object.freeze(this);
  }
  require(row: DockerEmployeeContinuationRecord, binding: DockerEmployeeBinding): void {
    this.#current();
    if (!same(row, this.#row) || !same(binding, this.#binding))
      throw new PlanMoveError('The original paid target changed', 409);
    this.#current();
  }
}
export function requireDockerPlanPaidDispatch(
  proof: unknown,
  row: DockerEmployeeContinuationRecord,
  binding: DockerEmployeeBinding
): void {
  if (!(proof instanceof NativePlanDispatch))
    throw new PlanMoveError('The original native paid-dispatch actor is required', 409);
  NativePlanDispatch.prototype.require.call(proof, row, binding);
}
class NativeContinuation {
  readonly #at = performance.now();
  readonly #actor: DockerPlanMoveActor;
  readonly #digest: string;
  readonly #current: () => void;
  readonly #paid: boolean;
  constructor(
    actor: DockerPlanMoveActor,
    state: Readonly<DockerPlanMoveJournalState>,
    current: () => void,
    paid: boolean
  ) {
    this.#actor = actor;
    this.#digest = dockerContinuationDigest(state);
    this.#current = current;
    this.#paid = paid;
    Object.freeze(this);
  }
  require(actor: DockerPlanMoveActor, state: Readonly<DockerPlanMoveJournalState>): void {
    this.#current();
    const age = performance.now() - this.#at;
    if (
      this.#paid ||
      state.paidDispatch ||
      actor !== this.#actor ||
      age < 0 ||
      age > 5000 ||
      dockerContinuationDigest(state) !== this.#digest
    )
      throw new PlanMoveError('The original pre-paid inspection changed', 409);
  }
}
Object.freeze(NativePlanDispatch.prototype);
Object.freeze(NativeContinuation.prototype);
Object.freeze(DockerPlanMoveActor.prototype);
