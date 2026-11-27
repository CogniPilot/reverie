import type { PlanMoveDockerActor, PlanMoveDockerJournalStore } from './plan-move-docker.js';
import { dockerPlanMoveNotIssuedOf } from './plan-move-store.js';
import {
  requireDockerPlanDisjointGeneration,
  requireDockerPlanDisjointHistoryData,
} from './docker-plan-disjoint-generation.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { dockerPlanMoveHandoffDigest, type DockerPlanMoveJournalState } from './docker-plan-move-data.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertResourceOperation, type ResourceOwnerBinding } from './resource-owner-authority.js';
import { ResourceHistoricalSettlement } from './resource-native-client.js';
import { accountReplacementProfile } from './utils/account-replacement-profile.js';
import { reserveDockerPlanMove, runDockerPlanMove } from './plan-move-docker-runner.js';
import { describeStartupScreen, type StartupScreenStatus } from './session-first-run-screens.js';

export type PlanMovePhase =
  | 'waiting'
  | 'creating'
  | 'starting'
  | 'checking'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'recovery-required';

/** Server-private references to a separately admitted resource transaction.
 * These references confer no authority and must never come from the move route.
 */
export interface PlanMoveResourceIntent {
  readonly operationId: string;
  readonly reservationId: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly previewDigest: string;
}

export type PlanMoveResourcePhase = 'reserved' | 'preparing' | 'prepared' | 'verifying' | 'verified';

function resourceIntent(value: PlanMoveResourceIntent): Readonly<PlanMoveResourceIntent> {
  const keys = ['operationId', 'reservationId', 'profileVersion', 'profileDigest', 'previewDigest'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    ![value.operationId, value.reservationId].every((id) => typeof id === 'string' && uuid.test(id)) ||
    typeof value.profileVersion !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(value.profileVersion) ||
    BigInt(value.profileVersion) > 18446744073709551615n ||
    ![value.profileDigest, value.previewDigest].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
  )
    throw new PlanMoveError('Invalid resource transaction references');
  return Object.freeze({
    operationId: value.operationId,
    reservationId: value.reservationId,
    profileVersion: value.profileVersion,
    profileDigest: value.profileDigest,
    previewDigest: value.previewDigest,
  });
}

export interface PlanMoveInput {
  id: string;
  employeeId: string;
  sessionId: string;
  sessionGeneration?: number;
  fromAccount: string;
  toAccount: string;
  forceBusy: boolean;
  returnToOffice?: true;
  handoff: string;
  model?: string;
  targetMode?: 'codex' | 'claude';
  /** Explicit same-account replacement, admitted through the ordinary request/approval flow. */
  purpose?: 'runtime-refresh';
  runtimeDigest?: string;
  resourceIntent?: PlanMoveResourceIntent;
  /** Private owner-session scope reference; not data ownership or authority. */
  resourceOwnerScope?: string;
}

export interface PlanMoveRecord {
  /** Public view DATA only. Never persisted as effect authority. */
  backend?: 'docker';
  /** Next steps for this move. `abandon` is the signed-in owner's only. */
  allowedActions?: readonly ('continue-original' | 'abandon')[];
  /** Public diagnostic only; never stored as native effect credit. */
  sourceViewRetirement?: PlanMoveSourceViewRetirement;
  /** Public view DATA only, for a laptop move that has switched the employee to the new session: whether its
   * handoff was typed there. `owed`: not typed. `unconfirmed`: typed, outcome unknown. `delivered`: confirmed. */
  handoffState?: 'owed' | 'unconfirmed' | 'delivered';
  /** PRIVATE mutable native journal; never serialize through public views. */
  dockerReplacement?: DockerPlanMoveJournalState;
  dockerSettlementBudget?: { version: 1; purpose: 'docker-plan-settlement-budget-v1'; maxRecordBytes: number };
  /** Terminal closure: the Engine reported every recorded container absent, or
   * the signed-in owner abandoned a held move (its own containers are recorded
   * for the owner's laptop rebuild). */
  dockerAbandonment?: PlanMoveAbsentAbandonment | PlanMoveOwnerAbandonment;
  id: string;
  owner?: string;
  employeeId: string;
  name: string;
  oldSession: string;
  newSession?: string;
  fromAccount: string;
  toAccount: string;
  phase: PlanMovePhase;
  at: number;
  error?: string;
  requestDigest?: string;
  sourceStopRequested?: boolean;
  sourceCleanupVerified?: boolean;
  restoredSource?: { pid: number; startTicks: string };
  recoveryAction?: 'adopt-existing';
  recoveredAt?: number;
  purpose?: 'runtime-refresh';
  runtimeDigest?: string;
  resourceIntent?: PlanMoveResourceIntent;
  resourceOwnerScope?: string;
  resourcePhase?: PlanMoveResourcePhase;
}
export interface PlanMoveAbsentAbandonment {
  version: 1;
  reason: 'recorded-containers-absent';
  operationId: string;
  at: number;
}
export interface PlanMoveOwnerAbandonment {
  version: 1;
  reason: 'owner-abandoned';
  at: number;
  containers: {
    source: string;
    target?: string;
    sourceHolder?: string;
    helpers: { role: 'storage-holder' | 'leaf-helper' | 'identity-helper'; containerId: string }[];
  };
}
/** The handoff of a closed laptop move that switched its employee to the new session and never confirmed typing it
 * there. DATA only: it types nothing and proves nothing about the session. */
export interface PlanMoveOwedHandoff {
  readonly moveId: string;
  readonly employeeId: string;
  /** The session the move switched the employee to. */
  readonly sessionId: string;
  /** The text the move would have typed, and the digest of the exact bytes. */
  readonly text: string;
  readonly digest: string;
  /** The move had begun to type it and never confirmed it. It must not be typed again. */
  readonly typed: boolean;
  /** When the move was closed. */
  readonly closedAt: number;
}
export interface PlanMoveSourceViewRetirement {
  state: 'pending' | 'completed' | 'unconfirmed';
  error?: string;
}

export interface PlanMoveSnapshot {
  backend?: 'docker';
  sessionGeneration?: number;
  sessionId: string;
  name: string;
  account: string;
  working: boolean;
  mode?: string;
  model?: string;
  runtimeDigest?: string;
}

export interface PlanMovePort {
  dockerReplacement?: PlanMoveDockerActor;
  dockerJournal?: PlanMoveDockerJournalStore;
  /** Checked local metadata acknowledgement, never native effect authority. */
  sourceViewRetirementComplete?(record: Readonly<PlanMoveRecord>): boolean;
  /** Server-private boxed actor consumes the genuine cooperation proof and must
   * retain current permissions through its journal-scoped planned transition. */
  withDecisionAuthority?(proof: unknown): PlanMoveExecutor;
  load(): Promise<PlanMoveRecord[]>;
  save(records: PlanMoveRecord[]): Promise<void>;
  snapshot(employeeId: string, owner?: string, purpose?: 'runtime-refresh'): Promise<PlanMoveSnapshot>;
  idle(sessionId: string, signal: AbortSignal): Promise<void>;
  create(input: PlanMoveInput, owner: string | undefined): Promise<string>;
  start(sessionId: string): Promise<void>;
  ready(sessionId: string): Promise<void>;
  beforeStop(input: PlanMoveInput): Promise<void>;
  binding(employeeId: string, owner?: string): string | undefined;
  exists(sessionId: string): boolean;
  rebind(employeeId: string, sessionId: string, owner?: string): Promise<void>;
  stop(sessionId: string): Promise<number[]>;
  audit(record: PlanMoveRecord): Promise<void>;
  /** Read-only native inspection; returned fence rechecks live owner/bindings immediately before journal commit. */
  verifyRecovery?(record: Readonly<PlanMoveRecord>): Promise<() => void>;
  /** Same current destination/account/source checks, without requiring its disposable viewer alive. */
  verifyViewerRepair?(record: Readonly<PlanMoveRecord>): Promise<() => void>;
  recoveryPending?(record: Readonly<PlanMoveRecord>): Promise<void>;
  recoveryConfirmed?(record: Readonly<PlanMoveRecord>): Promise<void>;
  /** Fixed server actor only. Called after the new SID and intent are durable.
   * Must recheck owner/profile/capacity and serialize exact config projection/reload.
   * Any exception is an uncertain resource outcome; no generic rollback/release.
   */
  prepareResources?(record: Readonly<PlanMoveRecord>): Promise<void>;
  /** Real replacement/cgroup/roots verification; returns a synchronous, repeatable
   * read-only fence whose result must be undefined. Promise/other results refuse.
   * Missing native observation or settlement must refuse, never return a no-op.
   */
  verifyResources?(record: Readonly<PlanMoveRecord>): Promise<() => unknown>;
  /** Actual protected native final settlement after durable completion/audit.
   * The private owner-purpose actor must provide it; no ACK hash is credit.
   */
  completeResources?(record: Readonly<PlanMoveRecord>): Promise<void>;
}

export type PlanMoveExecutor = Omit<
  PlanMovePort,
  'load' | 'save' | 'recoveryPending' | 'recoveryConfirmed' | 'dockerJournal'
>;

export interface PlanViewerReconnectLease {
  (): boolean;
  revalidate(): Promise<boolean>;
  close(): void;
}

/** Names the hold a refusal hit. An id is given only to its own owner; other holds are typed without one. */
export type PlanMoveBlocker =
  | { id: string; action: 'inspect-existing' }
  | { action: 'inspect-journal'; scope: 'other-owner' | 'unrecorded' };

export class PlanMoveError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly blocker?: PlanMoveBlocker
  ) {
    super(message);
  }
}

/** A fresh, checked account snapshot differs from the immutable reservation. */
export class PlanMoveAccountSnapshotChanged extends PlanMoveError {
  constructor() { super('The selected account material changed after reservation', 409); }
}

/** Deny-only: an uncertain operation never authorizes rollback, cleanup or another launch. */
export class PlanMoveUnconfirmed extends PlanMoveError {}

/** A step of a laptop move was given up by the step watch (`PLAN_MOVE_STEP_LIMITS`). What it had done is not known. */
export class PlanMoveStepTimedOut extends PlanMoveUnconfirmed {}

/**
 * How long one step of a laptop move is waited for before the move is held instead.
 *
 * A step is a chain of short waits, each with its own limit: a container engine command ends after thirty seconds,
 * the journal lock after five, the wait for an employee to yield after five minutes, a read of the new session's
 * composer after three. Between them the step passes a checkpoint (it asks whether it is still the move's flight),
 * so a healthy step passes one at least every thirty seconds, and every second while it waits for a composer. What
 * has no limit of its own is a wait on the office itself: an audit entry, a company record, a terminal, the launch.
 *
 * - `stallMs`: no checkpoint for this long means one such wait never returned. Ten minutes is twenty times the
 *   longest wait that has a limit.
 * - `phaseMs`: a backstop for a step that keeps passing checkpoints and never ends. Waiting for the employee
 *   ends by its own five-minute limit, and checking the target and stopping the source are a handful of waits;
 *   they get fifteen minutes. Building and starting the new laptop, and checking it (up to three composer reads,
 *   the handoff and the completion), are dozens of waits, by a count of the steps some twenty minutes if every
 *   one ran to its limit; they get forty-five. The counts are estimates from reading the steps, not measurements.
 *   A phase that is not listed gets the longest.
 * - `graceMs`: how long a step that was told to stop is given to stop by itself before the move is taken from it.
 * - `checkMs`: how often a step is looked at.
 */
export interface PlanMoveStepLimits {
  readonly stallMs: number;
  readonly phaseMs: Readonly<Partial<Record<PlanMovePhase, number>>>;
  readonly graceMs: number;
  readonly checkMs: number;
}
export const PLAN_MOVE_STEP_LIMITS: PlanMoveStepLimits = {
  stallMs: 10 * 60_000,
  phaseMs: {
    waiting: 15 * 60_000,
    creating: 15 * 60_000,
    stopping: 15 * 60_000,
    starting: 45 * 60_000,
    checking: 45 * 60_000,
  },
  graceMs: 60_000,
  checkMs: 15_000,
};

/** The sentence a move is held with once the step watch gave its step up. It says what is and is not known. */
function stepTimedOutMessage(phase: PlanMovePhase, stalledMs: number | undefined, lastedMs: number): string {
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000)),
    step =
      phase === 'recovery-required'
        ? 'while it was being continued'
        : phase === 'completed'
          ? 'while the old terminal of the finished move was being retired'
          : `in its “${phase}” step`;
  return (
    `The office stopped waiting for this move ${step}: ` +
    (stalledMs !== undefined
      ? `nothing came back from it for ${minutes(stalledMs)} minutes. `
      : `that had lasted ${minutes(lastedMs)} minutes. `) +
    'How far that step got is not known. The move is held as an office restart would leave it; nothing was repeated.'
  );
}

/** What a candidate that is short of its composer was showing instead, when that is a screen the office can name. */
export interface PlanMoveWaitingAt extends Pick<StartupScreenStatus, 'label' | 'kind' | 'answering'> {
  /** The owner-facing name of the session, e.g. "Stan's new session". */
  readonly who: string;
}

/** Only a supported, currently observed composer that is not yet ready is retryable.
 * Unknown capability, account, binding and source-cleanup failures remain ordinary refusals.
 *
 * `waitingAt` is description only. It names the provider start-up screen the candidate was read on (a first-run screen
 * the office is answering, or a sign-in it never answers), so a wait that runs out says where the session is stuck
 * instead of only that it is not at its composer. It grants nothing and never makes a refusal retryable.
 */
export class PlanMoveComposerNotReady extends PlanMoveError {
  constructor(readonly waitingAt?: Readonly<PlanMoveWaitingAt>) {
    super(waitingAt ? describeStartupScreen(waitingAt.who, waitingAt) : 'The existing candidate is not at its verified composer');
    this.name = 'PlanMoveComposerNotReady';
  }
}

/** How long a candidate's composer is waited for before the move asks for the owner. */
export const PLAN_MOVE_COMPOSER_WAIT_MS = 120_000;
/** How much longer it is waited for while the office is verifiably still answering a first-run screen. */
export const PLAN_MOVE_FIRST_RUN_GRACE_MS = 60_000;

/**
 * Whether a composer that was not ready may be read again, `elapsedMs` into the wait.
 *
 * A candidate on a first-run screen the office is still answering is still starting, not failed: it gets a bounded
 * grace past the ordinary deadline. Anything else, a sign-in prompt and a screen the office gave up on included, ends
 * at the ordinary deadline, and the error that ends it names the screen.
 */
export function planMoveComposerWaitContinues(error: PlanMoveComposerNotReady, elapsedMs: number): boolean {
  if (elapsedMs < PLAN_MOVE_COMPOSER_WAIT_MS) return true;
  return error.waitingAt?.answering === true && elapsedMs < PLAN_MOVE_COMPOSER_WAIT_MS + PLAN_MOVE_FIRST_RUN_GRACE_MS;
}

export class PlanMoves {
  readonly #recoveryOwner = true;
  private records = new Map<string, PlanMoveRecord>();
  private locked = new Set<string>();
  private intents = new Set<string>();
  private preparing = new Map<string, string>();
  private coldLegacy = new Map<string, { raw: PlanMoveRecord; loaded: string }>();
  private aborts = new Map<string, AbortController>();
  private sourceRetirements = new Map<string, PlanMoveSourceViewRetirement>();
  /** Actual original move owner only. This is a denial lease, never permission
   * to stop/start, complete a held move, or reconstruct a native owner. */
  async employeeRecoveryGuard(
    employeeId: string,
    owner: string | undefined,
    access: 'effect' | 'observe'
  ): Promise<PlanViewerReconnectLease> {
    if (!this.#recoveryOwner) throw new PlanMoveError('Original move owner is unavailable');
    if (access === 'observe') return PlanMoves.prototype.viewerInspectionGuard.call(this, employeeId, owner);
    await this.init();
    const end = performance.now() + 10_000;
    let closed = false;
    const current = () => !closed && performance.now() < end && !this.locked.has(employeeId);
    return Object.assign(current, {
      revalidate: async () => current(),
      close: () => {
        closed = true;
      },
    });
  }
  private loaded: Promise<void> | undefined;

  constructor(
    private readonly port: PlanMovePort,
    private readonly stepLimits: PlanMoveStepLimits = PLAN_MOVE_STEP_LIMITS
  ) {}

  private init(): Promise<void> {
    this.loaded ??= (async () => {
      for (const saved of await this.port.load()) {
        const record = {
          ...saved,
          ...(saved.resourceIntent ? { resourceIntent: resourceIntent(saved.resourceIntent) } : {}),
        };
        if (record.resourceIntent || !['completed', 'failed'].includes(record.phase)) {
          record.phase = 'recovery-required';
          record.error ??= record.resourceIntent
            ? 'Resource transactions require fresh native reconciliation after restart'
            : 'The server restarted during this move; inspect both sessions before retrying';
          this.locked.add(record.employeeId);
        }
        this.coldLegacy.set(record.id, { raw: structuredClone(saved), loaded: dockerContinuationDigest(record) });
        this.records.set(record.id, record);
      }
    })();
    return this.loaded;
  }

  private save(): Promise<void> {
    return this.port.save([...this.records.values()].map((record) => ({ ...record })));
  }

  private sourceRetirement(source: PlanMoveRecord): PlanMoveSourceViewRetirement | undefined {
    if (!source.dockerReplacement || source.phase !== 'completed') return undefined;
    const observed = this.sourceRetirements.get(source.id);
    if (observed) return { ...observed };
    if (!this.port.sourceViewRetirementComplete) return undefined;
    try {
      return { state: this.port.sourceViewRetirementComplete(source) ? 'completed' : 'pending' };
    } catch {
      return { state: 'unconfirmed', error: 'Previous terminal cleanup status is unavailable' };
    }
  }

  private view(source: PlanMoveRecord): PlanMoveRecord {
    const {
      dockerReplacement: _privateDockerJournal,
      dockerSettlementBudget: _privateSettlementBudget,
      restoredSource: _privateRestoredSource,
      ...record
    } = source;
    delete record.sourceViewRetirement;
    delete record.handoffState;
    if (source.dockerReplacement) {
      record.backend = 'docker';
      const { companyPublication, handoff } = source.dockerReplacement;
      if (companyPublication)
        record.handoffState = handoff?.phase === 'submitted' ? 'delivered' : handoff ? 'unconfirmed' : 'owed';
      const retirement = this.sourceRetirement(source);
      if (retirement) record.sourceViewRetirement = retirement;
      const idle = !this.aborts.has(record.id) && !this.intents.has(record.id);
      record.allowedActions =
        (record.phase === 'recovery-required' ||
          (record.phase === 'completed' && retirement !== undefined && retirement.state !== 'completed')) &&
        idle
          ? // A held move can always be given up by its owner, whatever stopped it.
            record.phase === 'recovery-required' && !record.resourceIntent && this.port.dockerJournal?.abandonOwner
            ? ['continue-original', 'abandon']
            : ['continue-original']
          : [];
    }
    // A completion journal write is provisional while final native/audit fences
    // are still pending. Readers must not turn that window into successful Apply.
    if (record.phase === 'completed' && (this.aborts.has(record.id) || this.intents.has(record.id))) {
      if (source.dockerReplacement) return { ...record, phase: 'checking' };
      if (record.resourceIntent) return { ...record, phase: 'checking', resourcePhase: 'verifying' };
      if (record.recoveryAction === 'adopt-existing') return { ...record, phase: 'checking' };
    }
    // An adoption keeps the held phase while its inspection and audit run: report it as checking, so a status read
    // never offers a recovery that is already in flight.
    if (
      record.phase === 'recovery-required' &&
      !record.resourceIntent &&
      (this.aborts.has(record.id) || this.intents.has(record.id))
    )
      return { ...record, phase: 'checking' };
    return { ...record };
  }

  /** A viewer flight never completes/unlocks a move or permits provider creation. */
  async viewerReconnectGuard(
    employeeId: string,
    destination?: { owner?: string; sessionId: string; executor: Pick<PlanMoveExecutor, 'verifyViewerRepair'> }
  ): Promise<PlanViewerReconnectLease> {
    await this.init();
    let closed = false;
    const simple = (check: () => boolean) =>
      Object.assign(() => !closed && check(), {
        revalidate: async () => !closed && check(),
        close: () => {
          closed = true;
        },
      });
    if (!this.locked.has(employeeId)) return simple(() => !this.locked.has(employeeId));
    const unresolved = [...this.records.values()].filter(
      (record) => record.employeeId === employeeId && !['completed', 'failed'].includes(record.phase)
    );
    const record = unresolved[0];
    if (
      !destination?.executor.verifyViewerRepair ||
      unresolved.length !== 1 ||
      !record ||
      record.owner !== destination.owner ||
      record.phase !== 'recovery-required' ||
      record.resourceIntent ||
      !record.newSession ||
      record.newSession === record.oldSession ||
      record.newSession !== destination.sessionId ||
      record.sourceStopRequested !== true ||
      record.sourceCleanupVerified !== true ||
      this.intents.has(record.id) ||
      this.aborts.has(record.id)
    )
      return simple(() => false);
    const fingerprint = JSON.stringify(record),
      id = record.id;
    const journalCurrent = () =>
      !closed &&
      this.intents.has(id) &&
      !this.aborts.has(id) &&
      this.records.get(id) === record &&
      JSON.stringify(record) === fingerprint &&
      this.locked.has(employeeId) &&
      [...this.records.values()].filter(
        (row) => row.employeeId === employeeId && !['completed', 'failed'].includes(row.phase)
      ).length === 1;
    // Existing transaction single-flight excludes adoption while the original journal remains held.
    this.intents.add(id);
    let runtimeCurrent: () => void,
      invalid = false;
    const close = () => {
      if (!closed) {
        closed = true;
        this.intents.delete(id);
      }
    };
    const current = () => {
      if (invalid || !journalCurrent()) return false;
      try {
        runtimeCurrent();
        return true;
      } catch {
        return false;
      }
    };
    try {
      runtimeCurrent = await destination.executor.verifyViewerRepair({ ...record });
      if (!current()) {
        close();
        return simple(() => false);
      }
    } catch {
      close();
      return simple(() => false);
    }
    return Object.assign(current, {
      close,
      revalidate: async () => {
        if (!current()) return false;
        try {
          const fresh = await destination.executor.verifyViewerRepair!({ ...record });
          if (!current()) return false;
          fresh();
          runtimeCurrent = fresh;
          return current();
        } catch {
          invalid = true;
          return false;
        }
      },
    });
  }

  /** Read-only terminal inspection excludes move effects without resolving a held journal. */
  async viewerInspectionGuard(employeeId: string, owner?: string): Promise<PlanViewerReconnectLease> {
    const end = performance.now() + 10_000;
    await this.init();
    let closed = false;
    const simple = (check: () => boolean) =>
      Object.assign(() => !closed && performance.now() < end && check(), {
        revalidate: async () => !closed && performance.now() < end && check(),
        close: () => {
          closed = true;
        },
      });
    if (!this.locked.has(employeeId)) return simple(() => !this.locked.has(employeeId));
    const unresolved = () =>
      [...this.records.values()].filter(
        (record) => record.employeeId === employeeId && !['completed', 'failed'].includes(record.phase)
      );
    const records = unresolved(),
      record = records[0];
    if (
      records.length !== 1 ||
      !record ||
      record.owner !== owner ||
      record.phase !== 'recovery-required' ||
      this.intents.has(record.id) ||
      this.aborts.has(record.id) ||
      performance.now() >= end
    )
      return simple(() => false);
    const fingerprint = JSON.stringify(record),
      id = record.id;
    this.intents.add(id);
    const current = () =>
      !closed &&
      performance.now() < end &&
      this.intents.has(id) &&
      !this.aborts.has(id) &&
      this.locked.has(employeeId) &&
      this.records.get(id) === record &&
      JSON.stringify(record) === fingerprint &&
      unresolved().length === 1;
    return Object.assign(current, {
      revalidate: async () => current(),
      close: () => {
        if (!closed) {
          closed = true;
          this.intents.delete(id);
        }
      },
    });
  }

  async get(id: string, owner?: string): Promise<PlanMoveRecord | undefined> {
    await this.init();
    const record = this.records.get(id);
    return record && record.owner === owner ? this.view(record) : undefined;
  }

  async list(owner?: string): Promise<PlanMoveRecord[]> {
    await this.init();
    return [...this.records.values()]
      .filter((record) => record.owner === owner)
      .map((record) => this.view(record))
      .reverse();
  }

  /** Discovery never releases a journal hold or grants recovery authority. */
  async assertAvailable(employeeId: string, owner?: string, executor: PlanMoveExecutor = this.port): Promise<void> {
    await this.init();
    await this.disjointAdmission(employeeId, owner, executor);
  }

  private coldRows(employeeId: string, owner: string | undefined, ownId?: string): PlanMoveRecord[] {
    if (
      (this.preparing.has(employeeId) && this.preparing.get(employeeId) !== ownId) ||
      [...this.aborts.keys()].some((id) => this.records.get(id)?.employeeId === employeeId)
    )
      this.assertUnlocked(employeeId, owner);
    const rows = [...this.records.values()].filter(
      (row) => row.employeeId === employeeId && row.id !== ownId && !['completed', 'failed'].includes(row.phase)
    );
    if (
      !rows.length ||
      rows.some(
        (row) =>
          !this.coldLegacy.has(row.id) ||
          this.intents.has(row.id) ||
          this.coldLegacy.get(row.id)!.loaded !== dockerContinuationDigest(row)
      )
    )
      this.assertUnlocked(employeeId, owner);
    return rows.map((row) => structuredClone(this.coldLegacy.get(row.id)!.raw));
  }
  private async disjointAdmission(
    employeeId: string,
    owner: string | undefined,
    executor: PlanMoveExecutor,
    ownId?: string
  ): Promise<unknown> {
    if (!this.locked.has(employeeId)) return undefined;
    const rows = this.coldRows(employeeId, owner, ownId);
    if (!executor.dockerReplacement?.admitDisjointGeneration) this.assertUnlocked(employeeId, owner);
    const proof = await executor.dockerReplacement!.admitDisjointGeneration!(employeeId, owner, rows);
    requireDockerPlanDisjointGeneration(proof, this.coldRows(employeeId, owner, ownId), employeeId, owner);
    return proof;
  }
  /** Open moves an absent-laptop reprovision would have to close. DATA only. */
  async openMoves(
    employeeId: string,
    owner: string | undefined
  ): Promise<readonly { id: string; docker: boolean; busy: boolean }[]> {
    await this.init();
    return (
      [...this.records.values()]
        .filter((row) => row.employeeId === employeeId && !['completed', 'failed'].includes(row.phase))
        // A held move of the retired native runtime has no Docker effect to close
        // and never gated a boxed continuation. It keeps its own recovery record.
        .filter(
          (row) =>
            row.dockerReplacement ||
            row.phase !== 'recovery-required' ||
            this.aborts.has(row.id) ||
            this.intents.has(row.id)
        )
        .map((row) => ({
          id: row.id,
          docker: !!row.dockerReplacement && row.owner === owner && !row.resourceIntent,
          busy: this.aborts.has(row.id) || this.intents.has(row.id),
        }))
    );
  }
  /** Close every open native move of one employee as abandoned. The caller holds
   * fresh positive Engine proof of absence and retains it through `current`.
   * The private journal is kept verbatim; no native effect is issued here. */
  async abandonAbsentDockerMoves(
    employeeId: string,
    owner: string | undefined,
    abandonment: PlanMoveAbsentAbandonment,
    current: () => void
  ): Promise<readonly string[]> {
    current();
    const store = this.port.dockerJournal;
    const open = await this.openMoves(employeeId, owner);
    if (!open.length) return [];
    if (!store?.abandonAbsent || open.some((row) => !row.docker || row.busy))
      throw new PlanMoveError('An open move for this employee requires its own recovery', 409);
    const closed: string[] = [];
    for (const { id } of open) {
      const record = this.records.get(id)!;
      current();
      const disk = await store.record(id);
      current();
      if (this.records.get(id) !== record || this.aborts.has(id) || this.intents.has(id) || !disk.dockerReplacement)
        throw new PlanMoveError('The original Docker move flight changed', 409);
      const saved = await store.abandonAbsent(id, disk.dockerReplacement, abandonment, current);
      record.phase = saved.phase;
      record.error = saved.error;
      record.dockerReplacement = saved.dockerReplacement;
      record.dockerSettlementBudget = saved.dockerSettlementBudget;
      record.dockerAbandonment = saved.dockerAbandonment;
      closed.push(id);
    }
    this.releaseLock(employeeId);
    return closed;
  }
  private releaseLock(employeeId: string): void {
    if (
      ![...this.records.values()].some(
        (row) => row.employeeId === employeeId && !['completed', 'failed'].includes(row.phase)
      )
    )
      this.locked.delete(employeeId);
  }

  private assertUnlocked(employeeId: string, owner?: string): void {
    if (!this.locked.has(employeeId)) return;
    const open = [...this.records.values()].filter(
      (row) => row.employeeId === employeeId && !['completed', 'failed'].includes(row.phase)
    );
    const record = open.find((row) => row.owner === owner);
    if (record)
      throw new PlanMoveError(
        'This employee already has a move in progress or requiring recovery; inspect its existing move',
        409,
        { id: record.id, action: 'inspect-existing' }
      );
    if (open.length)
      throw new PlanMoveError(
        'This employee already has a move in progress or requiring recovery under another owner; ' +
          'that owner must inspect it',
        409,
        { action: 'inspect-journal', scope: 'other-owner' }
      );
    // Also briefly true while a new move is being prepared, before its journal record exists.
    throw new PlanMoveError(
      'This employee has a move being prepared or a hold without an open journal record; ' +
        'the owner must inspect the move journal before another move',
      409,
      { action: 'inspect-journal', scope: 'unrecorded' }
    );
  }

  async begin(
    input: PlanMoveInput,
    owner?: string,
    executor: PlanMoveExecutor = this.port,
    ownerAuthority?: ResourceOwnerBinding
  ): Promise<PlanMoveRecord> {
    // Capture references before the first await. No caller mutation may redirect
    // a queued transaction or silently turn a resource refresh into a plain one.
    input = {
      ...input,
      ...(input.resourceIntent !== undefined ? { resourceIntent: resourceIntent(input.resourceIntent) } : {}),
    };
    const checkOwnerScope = () => {
      if (input.resourceOwnerScope !== undefined) {
        try {
          if (
            !input.resourceIntent ||
            !/^[a-f0-9]{64}$/.test(input.resourceOwnerScope) ||
            !ownerAuthority ||
            assertResourceOperation(ownerAuthority, owner, input) !== input.resourceOwnerScope
          )
            throw new Error('missing private scope');
        } catch {
          throw new PlanMoveError('Resource refresh requires its current private owner context', 403);
        }
      } else if (input.resourceIntent && (typeof owner !== 'string' || !owner || owner.length > 200))
        throw new PlanMoveError('Resource refresh requires an explicit verified owner scope', 403);
    };
    checkOwnerScope();
    if (
      input.resourceIntent &&
      (input.purpose !== 'runtime-refresh' ||
        typeof executor.prepareResources !== 'function' ||
        typeof executor.verifyResources !== 'function' ||
        (input.resourceOwnerScope !== undefined && typeof executor.completeResources !== 'function'))
    )
      throw new PlanMoveError('Resource refresh requires its fixed preparation and native verification actor', 503);
    if (
      (input.purpose !== undefined && input.purpose !== 'runtime-refresh') ||
      (!input.purpose && input.runtimeDigest !== undefined)
    )
      throw new PlanMoveError('Unknown plan move purpose');
    await this.init();
    checkOwnerScope();
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify([
          input.forceBusy,
          ...(input.returnToOffice ? ['return-to-office'] : []),
          input.handoff,
          input.model ?? '',
          input.targetMode ?? '',
          ...(input.sessionGeneration === undefined ? [] : ['session-generation', input.sessionGeneration]),
          ...(input.purpose ? [input.purpose, input.runtimeDigest] : []),
          ...(input.resourceIntent
            ? [
                'resources-v1',
                input.resourceIntent.operationId,
                input.resourceIntent.reservationId,
                input.resourceIntent.profileVersion,
                input.resourceIntent.profileDigest,
                input.resourceIntent.previewDigest,
                ...(input.resourceOwnerScope === undefined ? [] : [input.resourceOwnerScope]),
              ]
            : []),
        ])
      )
      .digest('hex');
    const existing = this.records.get(input.id);
    if (existing) {
      if (
        existing.owner !== owner ||
        existing.employeeId !== input.employeeId ||
        existing.oldSession !== input.sessionId ||
        existing.toAccount !== input.toAccount ||
        existing.fromAccount !== input.fromAccount ||
        existing.purpose !== input.purpose ||
        existing.requestDigest !== requestDigest
      )
        throw new PlanMoveError('That move identifier belongs to another request');
      return this.view(existing);
    }
    if (this.intents.has(input.id)) throw new PlanMoveError('That move identifier is already being prepared');
    let disjoint = await this.disjointAdmission(input.employeeId, owner, executor);
    if (!disjoint) this.assertUnlocked(input.employeeId, owner);
    if (disjoint)
      requireDockerPlanDisjointGeneration(disjoint, this.coldRows(input.employeeId, owner), input.employeeId, owner);
    this.locked.add(input.employeeId);
    this.preparing.set(input.employeeId, input.id);
    this.intents.add(input.id);
    try {
      const snapshot = await executor.snapshot(input.employeeId, owner, input.purpose);
      checkOwnerScope();
      if (snapshot.sessionId !== input.sessionId || snapshot.account !== input.fromAccount)
        throw new PlanMoveError('The employee or account changed; refresh before moving');
      if (
        snapshot.backend === 'docker' &&
        input.sessionGeneration !== undefined &&
        input.sessionGeneration !== snapshot.sessionGeneration
      )
        throw new PlanMoveError('The employee generation changed; refresh before moving');
      if (input.purpose === 'runtime-refresh') {
        if (
          input.fromAccount !== input.toAccount ||
          input.forceBusy ||
          !input.handoff.trim() ||
          !accountReplacementProfile(snapshot.mode) ||
          (input.model !== undefined && input.model !== snapshot.model) ||
          (input.targetMode !== undefined && input.targetMode !== snapshot.mode) ||
          !input.runtimeDigest ||
          !/^[a-f0-9]{64}$/.test(input.runtimeDigest) ||
          snapshot.runtimeDigest !== input.runtimeDigest
        )
          throw new PlanMoveError('A runtime refresh requires the unchanged current plan, runtime and a safe handoff');
      } else if (
        input.fromAccount === input.toAccount &&
        !(input.forceBusy && snapshot.backend === 'docker' && !snapshot.working)
      ) {
        throw new PlanMoveError('The employee is already on that plan');
      }
      if (this.records.size >= 100) {
        const oldest = [...this.records.values()].find(
          (record) =>
            ['completed', 'failed'].includes(record.phase) &&
            !record.dockerReplacement &&
            !this.intents.has(record.id) &&
            !this.aborts.has(record.id)
        );
        if (!oldest) throw new PlanMoveError('The move registry is full; resolve outstanding moves first');
        this.records.delete(oldest.id);
      }
      const record: PlanMoveRecord = {
        id: input.id,
        owner,
        employeeId: input.employeeId,
        name: snapshot.name,
        oldSession: input.sessionId,
        fromAccount: input.fromAccount,
        toAccount: input.toAccount,
        phase: 'waiting',
        at: Date.now(),
        requestDigest,
        ...(input.purpose ? { purpose: input.purpose, runtimeDigest: input.runtimeDigest } : {}),
        ...(input.resourceIntent ? { resourceIntent: input.resourceIntent } : {}),
        ...(input.resourceOwnerScope === undefined ? {} : { resourceOwnerScope: input.resourceOwnerScope }),
      };
      if (snapshot.backend === 'docker') await reserveDockerPlanMove(record, input, executor, this.port.dockerJournal);
      if (disjoint) {
        if (!record.dockerReplacement)
          throw new PlanMoveError('Current native generation admission requires Docker', 409);
        disjoint = await this.disjointAdmission(input.employeeId, owner, executor, input.id);
      }
      this.records.set(record.id, record);
      if (record.dockerReplacement) {
        const saved = await this.port.dockerJournal!.reserve(
          record,
          () => {
            executor.dockerReplacement!.current(record, record.dockerReplacement!);
            if (disjoint)
              requireDockerPlanDisjointHistoryData(
                disjoint,
                this.coldRows(input.employeeId, owner, input.id),
                input.employeeId,
                owner
              );
          },
          disjoint
        );
        Object.assign(record, structuredClone(saved));
      } else await this.save();
      checkOwnerScope();
      if (record.dockerReplacement) void this.runDocker(record, executor);
      else void this.run(record, input, executor);
      return this.view(record);
    } catch (error) {
      const uncertain = this.records.get(input.id),
        notIssued = dockerPlanMoveNotIssuedOf(error);
      const exactNotIssued =
        !!notIssued &&
        !!uncertain?.dockerReplacement &&
        notIssued.id === uncertain.id &&
        notIssued.employeeId === uncertain.employeeId &&
        notIssued.sessionId === uncertain.oldSession &&
        notIssued.sessionGeneration === uncertain.dockerReplacement.seed.source.binding.sessionGeneration &&
        notIssued.toAccount === uncertain.toAccount &&
        notIssued.requestDigest === uncertain.requestDigest;
      if ((uncertain?.dockerReplacement && !exactNotIssued) || (input.resourceIntent && uncertain)) {
        // save() can lose its acknowledgement after durable rename/fsync. Keep
        // both the in-memory fence and any persisted intent for reconciliation.
        uncertain!.phase = 'recovery-required';
        uncertain!.error = uncertain!.dockerReplacement
          ? 'Docker plan reservation outcome requires inspection'
          : 'Resource intent journal outcome requires inspection';
        try {
          await this.save();
        } catch {
          /* retain the lock even if storage stays unavailable */
        }
      } else {
        this.records.delete(input.id);
        this.releaseLock(input.employeeId);
      }
      throw error;
    } finally {
      this.intents.delete(input.id);
      if (this.preparing.get(input.employeeId) === input.id) this.preparing.delete(input.employeeId);
    }
  }

  async cancel(id: string, owner?: string, authorized: () => boolean = () => true): Promise<void> {
    const record = await this.get(id, owner);
    if (!authorized()) throw new PlanMoveError('The move cancellation permission changed', 403);
    if (!record) throw new PlanMoveError('Unknown move', 404);
    if (record.phase !== 'waiting' || !this.aborts.has(id))
      throw new PlanMoveError('Only a move still waiting for idle can be cancelled');
    this.aborts.get(id)!.abort(new PlanMoveError('Move cancelled by the owner'));
  }

  /** The signed-in owner gives up one move that is held for recovery. It is
   * closed as terminally failed, the employee's move lock is released and the
   * containers the move's own journal named are recorded for the owner's laptop
   * rebuild. Journal DATA only: nothing is started, stopped or removed, and no
   * other employee's record is read or written. A move that is still working
   * (or only waiting for idle, which `cancel` covers) is refused.
   *
   * The office supervisor calls the same method on the owner's standing rule
   * (company setting `supervisorAutoRepair`), with its own guard as
   * `authorized` and a `note` that says so and why; the note becomes the
   * closed record's sentence. It needs no executor and no requester: nothing
   * here can issue, repeat or inspect a provider launch, so a move whose paid
   * dispatch is on record is closed with that record kept as it is. */
  async abandonHeldDockerMove(
    id: string,
    employeeId: string,
    owner: string | undefined,
    authorized: () => void = () => {},
    note?: string
  ): Promise<PlanMoveRecord> {
    await this.init();
    authorized();
    const record = this.records.get(id);
    if (!record || record.owner !== owner || record.employeeId !== employeeId)
      throw new PlanMoveError('Unknown move', 404);
    // Replaying a finished abandonment answers with the same closed record.
    if (record.phase === 'failed' && record.dockerAbandonment?.reason === 'owner-abandoned') return this.view(record);
    const store = this.port.dockerJournal;
    if (!record.dockerReplacement || record.resourceIntent || !store?.abandonOwner)
      throw new PlanMoveError(
        'Only a held laptop plan move can be abandoned here; this move keeps its own recovery action',
        409
      );
    if (this.intents.has(id) || this.aborts.has(id))
      throw new PlanMoveError(
        record.phase === 'waiting'
          ? 'This move is still waiting for the employee to be idle; cancel it instead'
          : 'This move is still working on a step; wait until it is held for recovery, then abandon it',
        409
      );
    if (record.phase !== 'recovery-required')
      throw new PlanMoveError(
        ['completed', 'failed'].includes(record.phase)
          ? 'This move has already finished; there is nothing to abandon'
          : 'Only a move that is held for recovery can be abandoned',
        409
      );
    this.intents.add(id);
    try {
      const current = () => {
        authorized();
        if (this.records.get(id) !== record || !this.intents.has(id) || this.aborts.has(id))
          throw new PlanMoveError('The held move changed while it was being abandoned; refresh and retry', 409);
      };
      let saved: Readonly<PlanMoveRecord>;
      try {
        const disk = await store.record(id);
        current();
        if (
          disk.id !== id ||
          disk.owner !== owner ||
          disk.employeeId !== employeeId ||
          disk.requestDigest !== record.requestDigest ||
          !disk.dockerReplacement
        )
          throw new PlanMoveError('The original move journal changed; refresh and retry', 409);
        // An earlier attempt whose acknowledgement was lost is settled by the durable record.
        saved =
          disk.phase === 'failed' && disk.dockerAbandonment?.reason === 'owner-abandoned'
            ? disk
            : await store.abandonOwner(id, disk.dockerReplacement, Date.now(), current, note);
      } catch (error) {
        if (error instanceof PlanMoveError) throw error;
        throw new PlanMoveError(
          'The move journal did not confirm the abandonment, so the move is still held. Retry abandoning it.',
          409
        );
      }
      if (saved.phase !== 'failed' || saved.dockerAbandonment?.reason !== 'owner-abandoned')
        throw new PlanMoveError('The move journal did not record the abandonment; the move is still held', 409);
      record.phase = saved.phase;
      record.error = saved.error;
      record.dockerReplacement = saved.dockerReplacement;
      record.dockerSettlementBudget = saved.dockerSettlementBudget;
      record.dockerAbandonment = saved.dockerAbandonment;
      this.releaseLock(record.employeeId);
      this.intents.delete(id);
      return this.view(record);
    } finally {
      this.intents.delete(id);
    }
  }
  /** Containers recorded by the owner-abandoned moves of one employee. DATA
   * only: the rebuild still proves each one by its Engine labels. */
  async ownerAbandonedContainers(
    employeeId: string,
    owner: string | undefined
  ): Promise<readonly { moveId: string; containers: PlanMoveOwnerAbandonment['containers'] }[]> {
    await this.init();
    return [...this.records.values()].flatMap((row) =>
      row.employeeId === employeeId &&
      row.owner === owner &&
      row.phase === 'failed' &&
      row.dockerAbandonment?.reason === 'owner-abandoned'
        ? [{ moveId: row.id, containers: structuredClone(row.dockerAbandonment.containers) }]
        : []
    );
  }

  /** The handoffs that closed laptop moves of one owner never confirmed typing, oldest first. A move counts once
   * it has begun to switch its employee to the new session: from then on the employee may be on a session that was
   * never told anything. Whether the employee is on that session, and whether the office has typed the handoff
   * since, is the caller's to find out (`PlanMoveOwedHandoffs`). DATA only. */
  async owedHandoffs(owner: string | undefined): Promise<readonly PlanMoveOwedHandoff[]> {
    await this.init();
    return [...this.records.values()].flatMap((row) => {
      const state = row.dockerReplacement;
      if (row.owner !== owner || row.phase !== 'failed' || !state?.companyPublication) return [];
      if (state.handoff?.phase === 'submitted' || this.aborts.has(row.id) || this.intents.has(row.id)) return [];
      return [
        {
          moveId: row.id,
          employeeId: row.employeeId,
          sessionId: state.seed.target.sessionId,
          text: state.seed.handoff,
          digest: dockerPlanMoveHandoffDigest(state.seed.handoff),
          typed: state.handoff !== undefined,
          closedAt: row.dockerAbandonment?.at ?? row.at,
        },
      ];
    });
  }

  /** The candidate laptop that each abandoned Docker move of one employee had created, exactly as that move's
   * journal kept its record. DATA only: this journal proves nothing about a container. A caller that wants to know
   * whether such a laptop is empty reads the laptop itself. A move that never created a candidate names none. */
  async abandonedCandidateRecords(
    employeeId: string,
    owner: string | undefined
  ): Promise<readonly { moveId: string; record: DockerEmployeeContinuationRecord }[]> {
    await this.init();
    return [...this.records.values()].flatMap((row) =>
      row.employeeId === employeeId &&
      row.owner === owner &&
      row.phase === 'failed' &&
      row.dockerAbandonment?.reason === 'owner-abandoned' &&
      row.dockerReplacement?.work?.destination
        ? [{ moveId: row.id, record: structuredClone(row.dockerReplacement.work) }]
        : []
    );
  }

  /** The office closes one held move of the retired runtime: a record with no laptop journal and no resource
   * transaction. Under the laptop runtime such a record gates no laptop and owns no session; it only keeps its
   * employee locked against every later plan move and viewer repair. The standing rule is to keep the employee
   * where they work now: the record is closed as failed with its reason and the lock is released. Journal DATA
   * only: no session is started, stopped, rebound or adopted, and no other record is changed.
   *
   * `authorized` is the caller's guard, checked again before the write. It must also hold that the employee works
   * in a laptop of the laptop runtime: under the retired runtime a held move may still own a session that has to
   * be inspected, and this method is not for that. A move that has already finished is answered with its record,
   * so a repeat changes nothing. A resource transaction keeps its own recovery actor and is refused. */
  async settleRetiredMove(
    id: string,
    employeeId: string,
    owner: string | undefined,
    authorized: () => void,
    note: string
  ): Promise<PlanMoveRecord> {
    await this.init();
    authorized();
    const record = this.records.get(id);
    if (!record || record.owner !== owner || record.employeeId !== employeeId)
      throw new PlanMoveError('Unknown move', 404);
    if (record.dockerReplacement)
      throw new PlanMoveError('A laptop plan move is abandoned through its own journal', 409);
    if (record.resourceIntent || record.resourcePhase || record.resourceOwnerScope !== undefined || record.purpose)
      throw new PlanMoveError('Resource transactions require their own verified recovery actor', 409);
    if (this.intents.has(id) || this.aborts.has(id))
      throw new PlanMoveError('This move is still working on a step; wait until it is held for recovery', 409);
    if (['completed', 'failed'].includes(record.phase)) return this.view(record);
    if (record.phase !== 'recovery-required')
      throw new PlanMoveError('Only a move that is held for recovery can be closed', 409);
    this.intents.add(id);
    const held = { phase: record.phase, error: record.error };
    try {
      authorized();
      record.phase = 'failed';
      record.error = note.slice(0, 1000);
      try {
        await this.save();
      } catch {
        // Whatever reached the disk, this process keeps the hold; a restart reads the durable record.
        record.phase = held.phase;
        if (held.error === undefined) delete record.error;
        else record.error = held.error;
        throw new PlanMoveError('The move journal did not confirm the closure, so the move is still held', 409);
      }
      this.releaseLock(employeeId);
      this.intents.delete(id);
      return this.view(record);
    } finally {
      this.intents.delete(id);
    }
  }

  /** The laptop record that each finished Docker move of one employee replaced, exactly as that move's seed kept
   * it. DATA only: this journal proves nothing about a container. The laptop rebuild binds a record to the
   * employee's own laptop history by its digest before it reads anything from it. A move that is still open, or
   * whose completion is still being fenced, is not finished. */
  async replacedSourceRecords(
    employeeId: string,
    owner: string | undefined
  ): Promise<readonly { moveId: string; record: DockerEmployeeContinuationRecord }[]> {
    await this.init();
    return [...this.records.values()].flatMap((row) =>
      row.employeeId === employeeId &&
      row.owner === owner &&
      ['completed', 'failed'].includes(row.phase) &&
      row.dockerReplacement &&
      !this.aborts.has(row.id) &&
      !this.intents.has(row.id)
        ? [{ moveId: row.id, record: structuredClone(row.dockerReplacement.seed.source.record) }]
        : []
    );
  }

  async closeRestoredDockerMove(id: string, owner: string | undefined, executor: PlanMoveExecutor) {
    await this.init();
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new PlanMoveError('Unknown move', 404);
    const actor = executor.dockerReplacement;
    const store = this.port.dockerJournal;
    const before = record.dockerReplacement;
    if (!actor?.verifyRestoredSource || !store?.closeRestored || !before || record.phase !== 'recovery-required' ||
        this.intents.has(id) || this.aborts.has(id))
      throw new PlanMoveError('The held move is unavailable for restored-source settlement');
    this.intents.add(id);
    try {
      const proof = await actor.verifyRestoredSource(record);
      const current = () => {
        if (this.records.get(id) !== record || !this.intents.has(id))
          throw new PlanMoveError('The held move changed');
        proof.current();
      };
      const saved = await store.closeRestored(id, before, proof.init, current);
      Object.assign(record, saved);
      this.releaseLock(record.employeeId);
      return this.view(record);
    } finally {
      this.intents.delete(id);
    }
  }

  /** Recognize a historical settlement through the fixed live host producer.
   * Metadata only: no executor, old handle, launch, stop, handoff or credit.
   * Every new website process still starts these records in recovery.
   */
  async reconcileResourceCompletion(
    id: string,
    proof: ResourceHistoricalSettlement,
    owner?: string
  ): Promise<PlanMoveRecord> {
    await this.init();
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new PlanMoveError('Unknown move', 404);
    if (
      !(proof instanceof ResourceHistoricalSettlement) ||
      !record.resourceIntent ||
      record.phase !== 'recovery-required' ||
      this.intents.has(id) ||
      this.aborts.has(id) ||
      [...this.records.values()].some(
        (row) => row.id !== id && row.employeeId === record.employeeId && !['completed', 'failed'].includes(row.phase)
      )
    )
      throw new PlanMoveError('Resource completion requires unambiguous fresh native inspection', 503);
    proof.assertRecord(record);
    this.intents.add(id);
    const before = { ...record };
    try {
      record.phase = 'completed';
      delete record.error;
      await this.save();
      await proof.recheck({ ...record });
      proof.assertRecord(record);
      this.releaseLock(record.employeeId);
      // Both native reads and the durable write are acknowledged. Finish this
      // request's provisional view before returning its completed DTO.
      this.intents.delete(id);
      return this.view(record);
    } catch (error) {
      Object.assign(record, before, {
        phase: 'recovery-required',
        error: 'Historical resource settlement remains unconfirmed',
      });
      this.locked.add(record.employeeId);
      try {
        await this.save();
      } catch {
        /* Keep in-memory fence; restart also requalifies. */
      }
      throw error;
    } finally {
      this.intents.delete(id);
    }
  }

  /** Resolve a stopped-source move by adopting its existing verified destination. Never launches or replays a handoff. */
  async resolve(
    id: string,
    expected: { oldSession: string; newSession: string; toAccount: string },
    owner?: string,
    executor: PlanMoveExecutor = this.port
  ): Promise<PlanMoveRecord> {
    await this.init();
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new PlanMoveError('Unknown move', 404);
    if (record.resourceIntent)
      throw new PlanMoveError('Resource transactions require their own verified recovery actor');
    if (record.dockerReplacement)
      throw new PlanMoveError('Use the original Docker recovery action; legacy adoption cannot recover this move');
    if (
      record.oldSession !== expected.oldSession ||
      record.newSession !== expected.newSession ||
      record.toAccount !== expected.toAccount
    )
      throw new PlanMoveError('The recovery target changed; refresh its status');
    if (this.intents.has(id) || this.aborts.has(id))
      throw new PlanMoveError('The move is still active; wait before recovery');
    if (record.phase === 'completed' && record.recoveryAction === 'adopt-existing') return this.view(record);
    if (record.phase !== 'recovery-required' || !record.sourceStopRequested || record.sourceCleanupVerified !== true)
      throw new PlanMoveError(
        'Recovery requires durable source-cleanup proof; inspect both sessions without clearing the journal'
      );
    if (
      [...this.records.values()].filter(
        (row) => row.employeeId === record.employeeId && !['completed', 'failed'].includes(row.phase)
      ).length !== 1
    )
      throw new PlanMoveError('Multiple unresolved moves name this employee; inspect the journal before recovery');
    if (!executor.verifyRecovery || !this.port.recoveryPending || !this.port.recoveryConfirmed)
      throw new PlanMoveError('Native recovery inspection or durable acknowledgement storage is unavailable', 503);
    this.intents.add(id);
    const before = { ...record };
    try {
      await executor.verifyRecovery({ ...record });
      await this.port.recoveryPending({ ...record });
      await executor.audit({ ...record, recoveryAction: 'adopt-existing' });
      const current = await executor.verifyRecovery({ ...record });
      current(); // Fresh authority and exact candidate binding after all slow inspection/audit work.
      record.phase = 'completed';
      record.recoveryAction = 'adopt-existing';
      record.recoveredAt = Date.now();
      try {
        await this.save();
        current();
        await this.port.recoveryConfirmed({ ...record });
      } catch (error) {
        Object.assign(record, before, { phase: 'recovery-required' });
        if (before.recoveryAction === undefined) delete record.recoveryAction;
        if (before.recoveredAt === undefined) delete record.recoveredAt;
        try {
          await this.save();
        } catch {
          /* Keep the in-memory hold; durable outcome requires inspection. */
        }
        throw error;
      }
      if (
        ![...this.records.values()].some(
          (row) => row.employeeId === record.employeeId && !['completed', 'failed'].includes(row.phase)
        )
      )
        this.releaseLock(record.employeeId);
      // All final settlement acknowledgements succeeded. End this request's
      // provisional view before rendering the completed, private-data-free DTO.
      this.intents.delete(id);
      return this.view(record);
    } finally {
      this.intents.delete(id);
    }
  }

  private async phase(record: PlanMoveRecord, phase: PlanMovePhase): Promise<void> {
    record.phase = phase;
    await this.save();
  }

  private async run(record: PlanMoveRecord, input: PlanMoveInput, executor: PlanMoveExecutor): Promise<void> {
    let stopping = false;
    const abort = new AbortController();
    this.aborts.set(record.id, abort);
    try {
      if (!input.forceBusy) await executor.idle(record.oldSession, abort.signal);
      const snapshot = await executor.snapshot(record.employeeId, record.owner, input.purpose);
      abort.signal.throwIfAborted();
      if (
        snapshot.sessionId !== record.oldSession ||
        snapshot.account !== record.fromAccount ||
        (snapshot.working && !input.forceBusy) ||
        (input.purpose === 'runtime-refresh' && snapshot.runtimeDigest !== input.runtimeDigest)
      )
        throw new PlanMoveError('The employee changed or became busy before launch; nothing was moved');
      await this.phase(record, 'creating');
      record.newSession = await executor.create(input, record.owner);
      if (record.resourceIntent) {
        // The existing create operation is metadata-only. Resource effects belong
        // here, never in a create wrapper that can throw before returning its SID.
        record.resourcePhase = 'reserved';
        await this.save();
        await executor.beforeStop(input);
        if (
          executor.binding(record.employeeId, record.owner) !== record.newSession ||
          !executor.exists(record.oldSession)
        )
          throw new PlanMoveError('The resource target or source changed before preparation');
        record.resourcePhase = 'preparing';
        await this.save();
        await executor.prepareResources!(Object.freeze({ ...record }));
        record.resourcePhase = 'prepared';
        await this.save();
      }
      // Creation reserves metadata and the employee binding; it must not launch a CLI.
      // Both sessions use the employee's permanent home and Nix store, so release the
      // old laptop before starting its replacement. The broker also fences actual writers.
      await executor.beforeStop(input);
      if (
        executor.binding(record.employeeId, record.owner) !== record.newSession ||
        !executor.exists(record.oldSession)
      )
        throw new PlanMoveError('The employee binding or source session changed before stopping');
      await executor.audit({ ...record, phase: 'stopping' });
      await executor.beforeStop(input);
      if (
        executor.binding(record.employeeId, record.owner) !== record.newSession ||
        !executor.exists(record.oldSession)
      )
        throw new PlanMoveError('The employee binding or source changed while recording the stop audit');
      // Publishing stopping also authorizes the broker to stop the detached old
      // laptop. Treat an uncertain save as past the rollback boundary.
      stopping = true;
      record.sourceStopRequested = true;
      await this.phase(record, 'stopping');
      const orphans = await executor.stop(record.oldSession);
      if (orphans.length)
        throw new PlanMoveError(`Old session cleanup left ${orphans.length} process(es); inspect before another move`);
      if (executor.binding(record.employeeId, record.owner) !== record.newSession)
        throw new PlanMoveError('The employee binding changed after stopping the source');
      record.sourceCleanupVerified = true;
      await this.phase(record, 'starting');
      await executor.start(record.newSession);
      await this.phase(record, 'checking');
      await executor.ready(record.newSession);
      let resourceFence: (() => unknown) | undefined;
      if (record.resourceIntent) {
        record.resourcePhase = 'verifying';
        await this.save();
        resourceFence = await executor.verifyResources!(Object.freeze({ ...record }));
        if (typeof resourceFence !== 'function') throw new PlanMoveError('Missing resource verification fence');
      }
      if (
        executor.binding(record.employeeId, record.owner) !== record.newSession ||
        !executor.exists(record.newSession)
      )
        throw new PlanMoveError('The employee binding or replacement changed before commit');
      const recheckResources = () => {
        if (!record.resourceIntent) return;
        if (
          executor.binding(record.employeeId, record.owner) !== record.newSession ||
          !executor.exists(record.newSession!)
        )
          throw new PlanMoveError('The resource replacement changed during completion');
        const outcome = resourceFence!();
        if (outcome !== undefined) {
          // Never await a fence: asynchronous work is not synchronous evidence.
          // Observe a rejected Promise only to avoid an unhandled rejection;
          // no eventual fulfillment can authorize this completion.
          if (outcome instanceof Promise) void outcome.catch(() => {});
          throw new PlanMoveError('Resource verification fence must return synchronous undefined');
        }
      };
      recheckResources();
      if (record.resourceIntent) record.resourcePhase = 'verified';
      await this.phase(record, 'completed');
      recheckResources();
      await executor.audit({ ...record });
      recheckResources();
      if (record.resourceOwnerScope !== undefined) {
        if (!executor.completeResources) throw new PlanMoveError('Protected native resource settlement is unavailable');
        await executor.completeResources(Object.freeze({ ...record }));
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : 'Move failed';
      const unconfirmed = error instanceof PlanMoveUnconfirmed;
      let recovered =
        !unconfirmed && !record.newSession && executor.binding(record.employeeId, record.owner) === record.oldSession;
      if (
        !unconfirmed &&
        !record.resourceIntent &&
        !stopping &&
        record.newSession &&
        executor.exists(record.oldSession) &&
        executor.binding(record.employeeId, record.owner) === record.newSession
      ) {
        try {
          await executor.rebind(record.employeeId, record.oldSession, record.owner);
          recovered = (await executor.stop(record.newSession)).length === 0;
        } catch (rollbackError) {
          record.error += `; rollback requires inspection: ${rollbackError instanceof Error ? rollbackError.message : 'failed'}`;
        }
      }
      if (!unconfirmed && stopping && record.newSession) {
        // Once the old stop began, its process and transport may be gone. Clean only
        // this move's candidate and retain recovery-required; never revive an old SID
        // or restore a stale copy of the employee's persistent data.
        try {
          const orphans = await executor.stop(record.newSession);
          if (orphans.length) record.error += `; candidate cleanup left ${orphans.length} process(es)`;
        } catch (cleanupError) {
          record.error += `; candidate cleanup requires inspection: ${cleanupError instanceof Error ? cleanupError.message : 'failed'}`;
        }
      }
      // A resource reservation is owned by its separate durable transaction.
      // Even pre-stop errors/cancel/lost acknowledgements must retain recovery;
      // generic rebind/cleanup success is never evidence that capacity is free.
      record.phase = recovered && !stopping && !record.resourceIntent ? 'failed' : 'recovery-required';
      try {
        await this.save();
      } catch {
        record.phase = 'recovery-required';
      }
      try {
        await executor.audit({ ...record });
      } catch {
        console.warn(`[plans] move ${record.id} could not post its failure audit; inspect the journal`);
      }
    } finally {
      this.aborts.delete(record.id);
      if (['completed', 'failed'].includes(record.phase)) this.releaseLock(record.employeeId);
    }
  }
  async continueDocker(
    id: string,
    expected: { oldSession: string; newSession: string; toAccount: string },
    owner: string | undefined,
    executor: PlanMoveExecutor
  ): Promise<PlanMoveRecord> {
    await this.init();
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new PlanMoveError('Unknown move', 404);
    const retirement = this.sourceRetirement(record);
    const completedRetirement =
      record.phase === 'completed' && retirement !== undefined && retirement.state !== 'completed';
    if (
      !record.dockerReplacement ||
      (record.phase !== 'recovery-required' && !completedRetirement) ||
      !this.port.dockerJournal ||
      !executor.dockerReplacement
    )
      throw new PlanMoveError('Original Docker recovery is unavailable', 409);
    if (
      record.oldSession !== expected.oldSession ||
      record.newSession !== expected.newSession ||
      record.toAccount !== expected.toAccount
    )
      throw new PlanMoveError('The original recovery target changed');
    if (this.intents.has(id) || this.aborts.has(id)) throw new PlanMoveError('The move is still active');
    this.intents.add(id);
    try {
      const actual = await this.port.dockerJournal.record(id);
      if (
        actual.owner !== owner ||
        actual.id !== id ||
        actual.oldSession !== record.oldSession ||
        actual.newSession !== record.newSession ||
        actual.requestDigest !== record.requestDigest ||
        !actual.dockerReplacement
      )
        throw new PlanMoveError('The original Docker journal changed');
      if (completedRetirement && actual.phase !== 'completed')
        throw new PlanMoveError('Completed Docker history changed');
      Object.assign(record, structuredClone(actual), {
        phase: completedRetirement ? 'completed' : 'recovery-required',
      });
      void this.runDocker(
        record,
        executor,
        actual.phase === 'completed' ? 'reconcile' : actual.dockerReplacement.paidDispatch ? 'adopt' : 'continue'
      );
      return this.view(record);
    } finally {
      this.intents.delete(id);
    }
  }
  /**
   * Watch one flight of a laptop move (`PLAN_MOVE_STEP_LIMITS`). A step that passes no checkpoint for too long, or a
   * phase that lasts too long, is first told to stop through the flight's own abort signal: a step that is waiting
   * in a loop ends there and the runner holds the move in its usual way. A step that does not end within the grace
   * is stuck in a wait that never returns, and the move is taken from it (`releaseStuckStep`).
   */
  private watchStep(
    record: PlanMoveRecord,
    abort: AbortController,
    executor: PlanMoveExecutor
  ): { progress(): void; released(): boolean; stop(): void } {
    const limits = this.stepLimits;
    let progressAt = performance.now(),
      phase = record.phase,
      phaseAt = progressAt,
      toldAt: number | undefined,
      released = false,
      reason = '';
    const look = () => {
      const now = performance.now();
      if (this.aborts.get(record.id) !== abort) return clearInterval(timer);
      if (record.phase !== phase) [phase, phaseAt] = [record.phase, now];
      if (toldAt === undefined) {
        const stalled = now - progressAt >= limits.stallMs,
          bound = limits.phaseMs[phase] ?? Math.max(...Object.values(limits.phaseMs));
        if (!stalled && now - phaseAt < bound) return;
        reason = stepTimedOutMessage(phase, stalled ? now - progressAt : undefined, now - phaseAt);
        toldAt = now;
        console.warn(`[plans] move ${record.id}: ${reason}`);
        return abort.abort(new PlanMoveStepTimedOut(reason));
      }
      if (now - toldAt < limits.graceMs) return;
      released = true;
      clearInterval(timer);
      void this.releaseStuckStep(record, abort, executor, reason);
    };
    const timer = setInterval(look, limits.checkMs);
    timer.unref?.();
    return {
      progress: () => {
        progressAt = performance.now();
      },
      released: () => released,
      stop: () => clearInterval(timer),
    };
  }

  /**
   * Take a move from a step that is stuck in a wait which never returns, and leave it as an office restart would:
   * held, with whatever its journal last recorded, and nothing repeated. The stuck step can do nothing more
   * afterwards: every checkpoint it would pass refuses (`runDocker`), each effect and each journal write is behind
   * one, and a continue takes the journal over under a new epoch before it issues anything. A provider launch whose
   * intent is in the journal stays there, so a continue of such a move only reads and verifies and never launches
   * again. The sentence the move is held with says that the step's outcome is not known.
   *
   * A move that had already completed keeps that: only the retirement of its old terminal is left unconfirmed.
   */
  private async releaseStuckStep(
    record: PlanMoveRecord,
    abort: AbortController,
    executor: PlanMoveExecutor,
    reason: string
  ): Promise<void> {
    const id = record.id;
    if (this.aborts.get(id) !== abort) return;
    // The move reads as working until the hold is written, so nothing continues or abandons it meanwhile.
    this.intents.add(id);
    this.aborts.delete(id);
    try {
      if (record.phase === 'completed') {
        this.sourceRetirements.set(id, { state: 'unconfirmed', error: reason });
        return;
      }
      record.phase = 'recovery-required';
      record.error = reason;
      // The journal may be what the step is stuck on. The write is given the same grace and no more; the hold in
      // memory does not depend on it.
      await Promise.race([
        this.recordStuckStep(record, reason),
        delay(this.stepLimits.graceMs, undefined, { ref: false }),
      ]);
      // The audit is one of the waits that can itself be stuck, so it is not waited for.
      void Promise.resolve()
        .then(() => executor.audit({ ...record }))
        .catch(() => console.warn(`[plans] move ${id} could not post the audit of its stopped step`));
    } finally {
      this.intents.delete(id);
      if (['completed', 'failed'].includes(record.phase)) this.releaseLock(record.employeeId);
    }
  }

  /** Write the hold of a stuck step to the journal, or take over what the journal already settled. Best effort:
   * when it cannot be written, this process holds the move in memory and a restart reads the journal as it is. */
  private async recordStuckStep(record: PlanMoveRecord, reason: string): Promise<void> {
    const store = this.port.dockerJournal,
      id = record.id;
    try {
      const disk = await store!.record(id);
      if (this.records.get(id) !== record || this.aborts.has(id) || !disk.dockerReplacement) return;
      // The step had written its last word before it got stuck: that outcome stands.
      const settled = ['completed', 'failed'].includes(disk.phase);
      const saved = settled
        ? disk
        : await store!.phase(id, disk.dockerReplacement, { phase: 'recovery-required', error: reason }, () => {
            if (this.records.get(id) !== record || this.aborts.has(id))
              throw new PlanMoveError('The held move changed');
          });
      // A write that came back late must not reach into a continue that has started meanwhile.
      if (this.records.get(id) !== record || this.aborts.has(id)) return;
      Object.assign(record, structuredClone(saved));
      if (saved.error === undefined) delete record.error;
    } catch {
      /* the hold stays in memory */
    }
  }

  private async runDocker(
    record: PlanMoveRecord,
    executor: PlanMoveExecutor,
    mode: 'new' | 'continue' | 'adopt' | 'reconcile' = 'new'
  ): Promise<void> {
    const abort = new AbortController();
    const completedBefore = record.phase === 'completed';
    this.aborts.set(record.id, abort);
    const watch = this.watchStep(record, abort, executor);
    try {
      if (!this.port.dockerJournal) throw new PlanMoveError('The private Docker journal is unavailable', 503);
      const retirement = await runDockerPlanMove(
        record,
        executor,
        this.port.dockerJournal,
        {
          signal: abort.signal,
          released: () => watch.released(),
          current: () => {
            if (
              watch.released() ||
              this.records.get(record.id) !== record ||
              (record.phase !== 'completed' && this.aborts.get(record.id) !== abort)
            )
              throw new PlanMoveError('The original Docker move flight changed');
            watch.progress();
          },
        },
        mode
      );
      if (retirement && !watch.released()) this.sourceRetirements.set(record.id, retirement);
    } catch (error) {
      // A step the move was taken from has no say about the record any more.
      if (watch.released()) return;
      if (completedBefore && mode === 'reconcile')
        this.sourceRetirements.set(record.id, {
          state: 'unconfirmed',
          error: (error instanceof Error ? error.message : 'Previous terminal cleanup unavailable').slice(0, 4000),
        });
      else {
        record.phase = 'recovery-required';
        record.error = error instanceof Error ? error.message : 'Docker move unavailable';
      }
    } finally {
      watch.stop();
      if (this.aborts.get(record.id) === abort) this.aborts.delete(record.id);
      if (record.phase === 'completed' || record.phase === 'failed') this.releaseLock(record.employeeId);
    }
  }
}
