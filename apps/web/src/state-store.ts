/**
 * @fileoverview Persistent JSON state storage for Reverie.
 *
 * Persists application state with debounced writes (500ms) to prevent excessive disk I/O.
 * State is split into two files:
 * - `~/.reverie/state.json` — main app state (sessions, tasks, config, global stats)
 * - `~/.reverie/state-inner.json` — Ralph loop state per session (changes rapidly)
 *
 * Key exports:
 * - `StateStore` class — singleton store with circuit breaker for save failures
 * - `getStore(filePath?)` — factory/singleton accessor
 *
 * Key methods: `getState()`, `getSessions()`, `setSession()`, `getConfig()`,
 * `setConfig()`, `getGlobalStats()`, `getAggregateStats()`, `getTokenStats()`,
 * `getDailyStats()`, `getRalphState()`, `setRalphState()`, `save()`, `saveNow()`
 *
 * Reverie uses its own state directory and leaves historical installations untouched.
 *
 * @dependencies types (AppState, RalphSessionState, GlobalStats, TokenStats),
 *   utils (Debouncer, MAX_SESSION_TOKENS)
 * @consumedby session-manager, ralph-loop, web/server, respawn-controller,
 *   hooks-config, and most subsystems
 *
 * @module state-store
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, copyFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { rename, unlink, copyFile, access, open as openAsync, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AppState,
  createInitialState,
  RalphSessionState,
  createInitialRalphSessionState,
  GlobalStats,
  createInitialGlobalStats,
  TokenStats,
  TokenUsageEntry,
} from './types.js';
import { Debouncer, MAX_SESSION_TOKENS } from './utils/index.js';
import { dataPath } from './config/instance.js';
import { normalizeSessionOrder } from './session-order.js';
import { validateTabLayout, type TabLayout } from './tab-layout.js';
import { Session } from './session.js';
import { EmployeeRecoveryAttempt } from './employee-recovery-attempt.js';
import { PROVIDER_LAUNCH_DISK_KEY, decodeProviderLaunchIntents, stageProviderLaunch, type ProviderLaunchSource, type ProviderLaunchIntent, ProviderLaunchPublication } from './provider-launch-publication.js';

/** Debounce delay for batching state writes (ms) */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Persistent JSON state storage with debounced writes.
 *
 * State is automatically loaded on construction and saved with 500ms
 * debouncing to batch rapid updates into single disk writes.
 *
 * @example
 * ```typescript
 * const store = new StateStore();
 *
 * // Read state
 * const sessions = store.getState().sessions;
 *
 * // Modify and save
 * store.getState().sessions[id] = sessionState;
 * store.save();  // Debounced - won't write immediately
 *
 * // Force immediate write
 * store.saveNow();
 * ```
 */
/** Maximum consecutive save failures before circuit breaker opens */
const MAX_CONSECUTIVE_FAILURES = 3;

/** A main-state publication may have reached disk. Retrying this cached writer is unsafe. */
export class StatePublicationUnconfirmedError extends Error {
  readonly code = 'STATE_PUBLICATION_UNCONFIRMED';
  readonly #evidence: unknown;
  constructor(evidence?: unknown) {
    super('State publication is unconfirmed; this writer is held for reconciliation.');
    this.#evidence = evidence;
    this.name = 'StatePublicationUnconfirmedError';
  }
  /** Trusted backend inspection only. Private state must never enter an API response or automatic error log. */
  getPrivateEvidenceForReconciliation(): unknown { return this.#evidence; }
}

/** Acknowledgement authority stays in this canonical writer module. */
const providerAcknowledgements = new WeakMap<object, {
  operation: ProviderLaunchPublication; subject: object; row: ProviderLaunchIntent;
  phase: 'issued' | 'prepared' | 'consumed' | 'retired-unused'; current(): boolean;
}>();
/** Read/consume only: no exported mint exists, and caller data cannot register an entry. */
export function verifyProviderLaunchAcknowledgement(ack: unknown, operation: ProviderLaunchPublication,
  subject: object, row: ProviderLaunchIntent, stage: 'prepare' | 'claim' | 'unused' | 'retire-unused'): boolean {
  if (!ack || typeof ack !== 'object') return false;
  const entry = providerAcknowledgements.get(ack);
  if (!entry || entry.operation !== operation || entry.subject !== subject || entry.row !== row) return false;
  if (stage === 'unused') return entry.phase === 'prepared';
  if (stage === 'retire-unused' && entry.phase === 'prepared') { entry.phase = 'retired-unused'; return true; }
  if (!entry.current()) return false;
  if (stage === 'prepare' && entry.phase === 'issued') { entry.phase = 'prepared'; return true; }
  if (stage === 'claim' && entry.phase === 'prepared') { entry.phase = 'consumed'; return true; }
  return false;
}

/** Serialized state/effect evidence is never an ordinary Error cause or enumerable field. */
export class AcknowledgedStateWriteError extends Error {
  readonly #evidence: unknown;
  constructor(message: string, evidence: unknown) {
    super(message);
    this.name = 'AcknowledgedStateWriteError';
    this.#evidence = evidence;
  }
  getPrivateEvidenceForReconciliation(): unknown { return this.#evidence; }
}
/** Diagnostic only: no-hold-observed is not disk health or permission to retry. */
export type StatePublicationStatus = Readonly<{
  version: 1;
  kind: 'unconfirmed' | 'no-hold-observed';
}>;

/** Explicit Config patches preserve the schema's nested respawn partial-update contract. */
export type ConfigPatch = Omit<Partial<AppState['config']>, 'respawn'> & {
  respawn?: Partial<AppState['config']['respawn']>;
};
interface StoppedProviderWrite {
  owner: EmployeeRecoveryAttempt;
  session: Session;
  row: ProviderLaunchIntent | undefined;
  publication: ProviderLaunchPublication | undefined;
  acknowledged: boolean;
  beforeCaptured: boolean;
  before: string | undefined;
  attempted: string | undefined;
  uncertainty: StatePublicationUnconfirmedError | undefined;
  snapshot: import('./types.js').SessionState | undefined;
}

export class StateStore {
  #stoppedProviderWrites = new WeakMap<EmployeeRecoveryAttempt, StoppedProviderWrite>();
  #stoppedProviderRetirements = new WeakMap<
    Session,
    {
      owner: EmployeeRecoveryAttempt;
      row: ProviderLaunchIntent | undefined;
      publication: ProviderLaunchPublication | undefined;
    }
  >();
  private stoppedDiskBytes(): string | undefined {
    try {
      return readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  private assertStoppedDisk(plan: StoppedProviderWrite): void {
    const disk = this.stoppedDiskBytes();
    if (plan.beforeCaptured && disk !== plan.before && disk !== plan.attempted)
      throw Error('The original stopped writer revision changed; preserve newer state');
  }
  private assertStoppedDiskIntent(session: Session, row: ProviderLaunchIntent | undefined): void {
    const raw = this.stoppedDiskBytes();
    const value =
      raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>)[PROVIDER_LAUNCH_DISK_KEY];
    let diskRow: ProviderLaunchIntent | undefined;
    if (value !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Invalid original native intent file');
      const record = value as Record<string, unknown>;
      if (
        record.version !== 1 ||
        record.kind !== 'observed' ||
        Object.keys(record).sort().join(',') !== 'kind,rows,version'
      )
        throw Error('Unconfirmed original native intent file');
      diskRow = decodeProviderLaunchIntents(record.rows)[session.id];
    }
    if (JSON.stringify(diskRow) !== JSON.stringify(row)) throw Error('The current native intent file changed');
  }
  captureStoppedProviderRetirement(session: Session, attempt: EmployeeRecoveryAttempt): void {
    EmployeeRecoveryAttempt.prototype.assertCurrent.call(attempt);
    if (!Session.usesProviderLaunchStore(session, this)) throw Error('Original stopped state-store custody required');
    const root = EmployeeRecoveryAttempt.prototype.stoppedMetadataOwner.call(attempt);
    const publication = Session.prototype.retainedStoppedProviderPublication.call(session, attempt, this);
    const approval = EmployeeRecoveryAttempt.prototype.stoppedApproval.call(attempt);
    const previous = this.#stoppedProviderWrites.get(root),
      row = this.#providerLaunchIntents[session.id];
    if (this.#publicationUncertainty && previous?.uncertainty !== this.#publicationUncertainty)
      throw this.#publicationUncertainty;
    if (previous) {
      if (
        previous.session !== session ||
        previous.publication !== publication ||
        (previous.acknowledged
          ? row !== undefined || this.#stoppedProviderRetirements.get(session)?.owner !== root
          : row !== previous.row)
      )
        throw Error('Original stopped main intent changed');
      if (previous.acknowledged) this.assertStoppedDiskIntent(session, undefined);
      else if (previous.uncertainty === this.#publicationUncertainty && previous.uncertainty)
        this.assertStoppedDisk(previous);
      else if (!this.#mainDiskRevisionKnown || this.stoppedDiskBytes() !== this.#mainDiskRevision)
        throw Error('Original main writer revision changed');
      return;
    }
    if (!this.#mainDiskRevisionKnown || this.stoppedDiskBytes() !== this.#mainDiskRevision)
      throw Error('Original main writer revision changed');
    this.assertStoppedDiskIntent(session, row);
    if (this.#providerLaunchHistory !== 'observed') throw Error('Unconfirmed native launch history cannot be retired');
    if (row) {
      if (
        row.transport !== 'native-ordinary' ||
        row.attemptId !== approval.originalAttemptId ||
        row.owner !== (session.owner ?? null) ||
        row.mode !== session.mode ||
        this.#providerLaunchOwners.get(session.id)?.deref() !== publication ||
        (publication && ProviderLaunchPublication.prototype.retainedDenial.call(publication, session) !== row)
      )
        throw Error('The stopped proof does not match the current native intent');
      if (!publication && !EmployeeRecoveryAttempt.prototype.loadedObservationOnly.call(attempt))
        throw Error('Original live publication owner is unavailable');
    } else if (
      publication ||
      (approval.originalAttemptId !== null &&
        (!EmployeeRecoveryAttempt.prototype.loadedObservationOnly.call(attempt) || !attempt.row?.application))
    )
      throw Error('An absent row cannot stand in for an unrelated native intent');
    this.#stoppedProviderWrites.set(root, {
      owner: root,
      session,
      row,
      publication,
      acknowledged: false,
      beforeCaptured: false,
      before: undefined,
      attempted: undefined,
      uncertainty: undefined,
      snapshot: undefined,
    });
  }
  stoppedProviderRetirementKnown(session: Session, attempt: EmployeeRecoveryAttempt): boolean {
    const root = EmployeeRecoveryAttempt.prototype.stoppedMetadataOwner.call(attempt),
      plan = this.#stoppedProviderWrites.get(root);
    return (
      !!plan &&
      plan.session === session &&
      plan.acknowledged &&
      this.#providerLaunchIntents[session.id] === undefined &&
      this.#providerLaunchOwners.get(session.id)?.deref() === undefined &&
      this.#stoppedProviderRetirements.get(session)?.owner === root
    );
  }
  retireStoppedProviderLaunch(session: Session, attempt: EmployeeRecoveryAttempt): Promise<void> {
    return this.serializeWrite(() => {
      this.captureStoppedProviderRetirement(session, attempt);
      const root = EmployeeRecoveryAttempt.prototype.stoppedMetadataOwner.call(attempt),
        plan = this.#stoppedProviderWrites.get(root)!;
      if (plan.acknowledged) return;
      const validate = () => {
        EmployeeRecoveryAttempt.prototype.assertCurrent.call(attempt);
        Session.prototype.retainedStoppedProviderPublication.call(session, attempt, this);
        if (
          this.#providerLaunchHistory !== 'observed' ||
          this.#providerLaunchIntents[session.id] !== plan.row ||
          this.#providerLaunchOwners.get(session.id)?.deref() !== plan.publication
        )
          throw Error('Original native intent changed');
        this.assertStoppedDisk(plan);
      };
      // The strict writer performs the queued-entry authority check after
      // this private projection, and again before publication/after close.
      // Retained bytes establish the exact prior writer revision only.
      // Reconciliation projects CURRENT owned observations, never replays an
      // old whole-file snapshot over newer in-memory observations.
      plan.before = this.stoppedDiskBytes();
      if (plan.row && plan.before === undefined) throw Error('Original native intent file is unavailable');
      plan.beforeCaptured = true;
      plan.attempted = undefined;
      plan.snapshot = Session.prototype.stoppedEmployeeSnapshot.call(session, attempt);
      this.acknowledgeMainState(
        () => {},
        validate,
        () => {},
        'recovery-stopped',
        () => {
          const serialized = this.serializeState();
          if (serialized === null) return null;
          const projected = JSON.parse(serialized) as AppState & Record<string, unknown>;
          const rows = { ...this.#providerLaunchIntents };
          delete rows[session.id];
          projected[PROVIDER_LAUNCH_DISK_KEY] = { version: 1, kind: this.#providerLaunchHistory, rows };
          projected.sessions[session.id] = plan.snapshot!;
          plan.attempted = JSON.stringify(projected);
          return plan.attempted;
        },
        plan
      );
      plan.acknowledged = true;
      delete this.#providerLaunchIntents[session.id];
      this.#providerLaunchOwners.delete(session.id);
      this.#stoppedProviderRetirements.set(session, { owner: root, row: plan.row, publication: plan.publication });
      if (plan.uncertainty && this.#publicationUncertainty === plan.uncertainty)
        this.#publicationUncertainty = undefined;
      this.state.sessions[session.id] = plan.snapshot!;
      this.cachedSessionJsons.set(session.id, JSON.stringify(plan.snapshot));
      this.dirtySessions.delete(session.id);
      this.dirty = this.serializeState() !== plan.attempted;
      if (plan.publication)
        ProviderLaunchPublication.prototype.consumeStoppedRetirement.call(plan.publication, session, attempt);
    });
  }

  private state: AppState;
  #mainDiskRevision: string | undefined;
  #mainDiskRevisionKnown = false;
  private filePath: string;
  private saveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
  private dirty: boolean = false;
  private dirtySessions = new Set<string>();
  private cachedSessionJsons = new Map<string, string>();

  // Inner state storage (separate from main state to reduce write frequency)
  private ralphStates: Map<string, RalphSessionState> = new Map();
  private ralphStatePath: string;
  private ralphStateSaveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
  private ralphStateDirty: boolean = false;

  // Circuit breaker for save failures (prevents hammering disk on persistent errors)
  private consecutiveSaveFailures: number = 0;
  private circuitBreakerOpen: boolean = false;

  // Guard against concurrent saveNowAsync() calls (debounce can race with in-flight write)
  private _saveInFlight: Promise<unknown> | null = null;
  // Separate from the retryable circuit breaker. No reset, backup or successful write clears it.
  #publicationUncertainty?: StatePublicationUnconfirmedError;
  // Serialized in the SAME main file, kept out of public AppState and DTOs.
  #providerLaunchIntents: Record<string, ProviderLaunchIntent> = Object.create(null) as Record<string, ProviderLaunchIntent>;
  #providerLaunchHistory: 'observed' | 'unconfirmed' = 'observed';
  #providerLaunchOwners = new Map<string, WeakRef<ProviderLaunchPublication>>();
  #providerLaunchStaged = new WeakMap<ProviderLaunchPublication, Session>();
  #unusedProviderRetirements = new WeakMap<ProviderLaunchPublication, {
    original: ProviderLaunchIntent; replacement?: ProviderLaunchIntent; owner?: ProviderLaunchPublication;
  }>();
  /** Saved selector DATA only: it supplies no publication/dispatch acknowledgement. */
  providerLaunchDenialSelector(
    session: Session
  ): Readonly<{ attemptId: string; transport: ProviderLaunchIntent['transport'] }> | undefined {
    if (!Session.usesProviderLaunchStore(session, this)) throw Error('Original Session store custody required');
    const row = this.#providerLaunchIntents[session.id];
    return row && row.owner === (session.owner ?? null) && row.mode === session.mode
      ? Object.freeze({ attemptId: row.attemptId, transport: row.transport })
      : undefined;
  }
  providerLaunchHeldFor(session: Session): boolean {
    if (!Session.usesProviderLaunchStore(session, this)) throw new Error('Original Session state-store custody required');
    return this.#providerLaunchHistory === 'unconfirmed' ||
      !!this.#providerLaunchIntents[session.id] && !this.#providerLaunchOwners.get(session.id)?.deref()?.owns(session);
  }

  /** Only the actual live Session is bound; saved IDs and false fields are never receipts. */
  stageProviderLaunch(session: Session, source: Omit<ProviderLaunchSource, 'subject' | 'sessionId' | 'owner' | 'mode' | 'workingDir'>): ProviderLaunchPublication {
    if (!Session.usesProviderLaunchStore(session, this)) throw new Error('Original Session state-store custody required');
    const owner = session.owner, mode = session.mode;
    const publication = stageProviderLaunch({ ...source, subject: session, sessionId: session.id, owner: owner ?? null, mode, workingDir: session.workingDir,
      current: () => !this.statePublicationHeld && this.#providerLaunchHistory === 'observed' && session.owner === owner && session.mode === mode && source.current() },
    (operation, row) => this.commitProviderLaunch(session, operation, row));
    this.#providerLaunchStaged.set(publication, session);
    Session.retainProviderLaunchPublication(session, this, publication);
    return publication;
  }

  ownsProviderLaunchDenial(session: Session, publication: ProviderLaunchPublication): boolean {
    return Session.usesProviderLaunchStore(session, this) && !!this.#providerLaunchIntents[session.id] &&
      this.#providerLaunchOwners.get(session.id)?.deref() === publication;
  }
  ownsProviderLaunchStaging(session: Session, publication: ProviderLaunchPublication): boolean {
    return Session.usesProviderLaunchStore(session, this) && this.#providerLaunchStaged.get(publication) === session;
  }
  unusedProviderIntentRetired(session: Session, publication: ProviderLaunchPublication): boolean {
    if (!Session.usesProviderLaunchStore(session, this))
      throw new Error('Original Session state-store custody required');
    return this.#unusedProviderRetirements.has(publication) && publication.owns(session);
  }
  /** Original private row/object join, deliberately independent of old execution currentness. */
  captureProviderLaunchRetention(session: Session): () => boolean {
    if (!Session.usesProviderLaunchStore(session, this))
      throw new Error('Original Session state-store custody required');
    const row = this.#providerLaunchIntents[session.id];
    const publication = this.#providerLaunchOwners.get(session.id)?.deref();
    return () => {
      const replacement = publication && this.#unusedProviderRetirements.get(publication);
      const stopped = this.#stoppedProviderRetirements.get(session);
      const stoppedRow = stopped && stopped.row === row && stopped.publication === publication;
      const expectedRow = stoppedRow
        ? undefined
        : replacement && replacement.original === row
          ? replacement.replacement
          : row;
      const expectedOwner = stoppedRow
        ? undefined
        : replacement && replacement.original === row
          ? replacement.owner
          : publication;
      return (
        this.#providerLaunchIntents[session.id] === expectedRow &&
        this.#providerLaunchOwners.get(session.id)?.deref() === expectedOwner &&
        (expectedRow ? expectedOwner?.owns(session) === true : expectedOwner === undefined)
      );
    };
  }
  /** Loaded denial continuity for read-only recovery. Saved rows never supply
   * a publication owner, execution acknowledgement or retirement permission. */
  captureLoadedProviderLaunchDenial(session: Session): () => boolean {
    if (!Session.usesProviderLaunchStore(session, this))
      throw new Error('Original Session state-store custody required');
    const row = this.#providerLaunchIntents[session.id],
      history = this.#providerLaunchHistory;
    if (this.#providerLaunchOwners.get(session.id)?.deref())
      throw new Error('Loaded provider denial requires no live publication owner');
    return () =>
      Session.usesProviderLaunchStore(session, this) &&
      this.#providerLaunchIntents[session.id] ===
        (this.#stoppedProviderRetirements.get(session)?.row === row ? undefined : row) &&
      this.#providerLaunchHistory === history &&
      this.#providerLaunchOwners.get(session.id)?.deref() === undefined;
  }

  /** Retire ONLY the original genuinely acknowledged but never-claimed intent.
   * The older provider row is restored as a denial, not execution authority. */
  retireUnusedProviderLaunch(session: Session, attempt: import('./employee-recovery-attempt.js').EmployeeRecoveryAttempt,
    pending: ProviderLaunchPublication, last?: ProviderLaunchPublication): Promise<void> {
    return this.serializeWrite(() => {
      const original = ProviderLaunchPublication.prototype.retainedDenial.call(pending,session);
      const replacement = last ? ProviderLaunchPublication.prototype.retainedDenial.call(last,session) : undefined;
      const validate = () => {
        Session.prototype.assertUnusedProviderRetirement.call(session, attempt, this, pending, last);
        if (this.#providerLaunchHistory !== 'observed' || !this.ownsProviderLaunchStaging(session,pending) ||
          !ProviderLaunchPublication.prototype.acknowledgedNeverClaimed.call(pending,session) || this.#providerLaunchIntents[session.id] !== original ||
          this.#providerLaunchOwners.get(session.id)?.deref() !== pending ||
          (last && (last === pending || !this.ownsProviderLaunchStaging(session,last))))
          throw new Error('Original unused provider intent changed');
      };
      validate();
      // Keep all live identity checks on the original state until the actual
      // writer acknowledges the projected replacement, including consuming close.
      this.acknowledgeMainState(() => {}, validate, () => {}, 'provider', () => {
        const serialized = this.serializeState();
        if (serialized === null) return null;
        const state = JSON.parse(serialized) as Record<string,unknown>;
        const rows = {...this.#providerLaunchIntents};
        if (replacement) rows[session.id] = replacement; else delete rows[session.id];
        state[PROVIDER_LAUNCH_DISK_KEY] = {version:1,kind:this.#providerLaunchHistory,rows};
        return JSON.stringify(state);
      });
      ProviderLaunchPublication.prototype.consumeUnusedRetirement.call(pending,session);
      if (replacement && last) {
        this.#providerLaunchIntents[session.id] = replacement;
        this.#providerLaunchOwners.set(session.id,new WeakRef(last));
      } else {
        delete this.#providerLaunchIntents[session.id];
        this.#providerLaunchOwners.delete(session.id);
      }
      this.#unusedProviderRetirements.set(pending,{original,replacement,owner:last});
    });
  }

  private commitProviderLaunch(session: Session, operation: ProviderLaunchPublication, row: ProviderLaunchIntent): Promise<object> {
    return this.serializeWrite(() => {
      const validate = () => {
        if (!Session.ownsPendingProviderLaunch(session, this, operation))
          throw new Error('An earlier provider launch intent remains unresolved');
        operation.assertCurrent();
        if (!operation.owns(session) || this.#providerLaunchHistory !== 'observed')
          throw new Error('Original provider publication owner is unavailable');
      };
      validate();
      const old = this.#providerLaunchIntents[session.id];
      if (old && (old.owner !== row.owner || !this.#providerLaunchOwners.get(session.id)?.deref()?.permitsNextLocal(session)))
        throw new Error('An earlier provider launch intent remains unresolved');
      this.acknowledgeMainState(() => {
        validate();
        this.#providerLaunchIntents[session.id] = row;
        this.#providerLaunchOwners.set(session.id, new WeakRef(operation));
        this.setSessionFromOwner(session, operation.snapshot(), 'preserve');
      }, validate, () => { /* The conservative denial/candidate must not roll back. */ }, 'provider');
      // This is the only mint: every write/fsync/consuming close and final guard above succeeded.
      const acknowledgement = Object.freeze({});
      providerAcknowledgements.set(acknowledgement, { operation, subject: session, row, phase: 'issued',
        current: () => !this.statePublicationHeld && this.#providerLaunchHistory === 'observed' &&
          this.#providerLaunchIntents[session.id] === row && this.#providerLaunchOwners.get(session.id)?.deref() === operation &&
          (session.owner ?? null) === row.owner && session.mode === row.mode });
      return acknowledgement;
    });
  }

  private privateProviderState(): unknown {
    return { version: 1, kind: this.#providerLaunchHistory, rows: this.#providerLaunchIntents };
  }

  private loadProviderState(parsed: unknown, backup: boolean): void {
    try {
      const value = (parsed as Record<string, unknown>)[PROVIDER_LAUNCH_DISK_KEY];
      if (value !== undefined) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider launch history');
        const record = value as Record<string, unknown>;
        if (Object.keys(record).sort().join(',') !== 'kind,rows,version' || record.version !== 1 ||
          (record.kind !== 'observed' && record.kind !== 'unconfirmed')) throw new Error('Invalid provider launch history');
        const rows = decodeProviderLaunchIntents(record.rows);
        for (const [id, row] of Object.entries(rows)) {
          const original = this.#providerLaunchIntents[id];
          if (original && JSON.stringify(original) !== JSON.stringify(row)) this.#providerLaunchHistory = 'unconfirmed';
          else this.#providerLaunchIntents[id] = row;
        }
        if (record.kind === 'unconfirmed') this.#providerLaunchHistory = 'unconfirmed';
      }
    } catch {
      this.#providerLaunchHistory = 'unconfirmed';
    }
    if (backup) this.#providerLaunchHistory = 'unconfirmed';
  }


  #publicationSubscribers = new Set<(status: StatePublicationStatus) => void>();

  get statePublicationHeld(): boolean { return this.#publicationUncertainty !== undefined; }

  getStatePublicationStatus(): StatePublicationStatus {
    return Object.freeze({ version: 1, kind: this.statePublicationHeld ? 'unconfirmed' : 'no-hold-observed' });
  }

  onStatePublicationHold(listener: (status: StatePublicationStatus) => void): () => void {
    this.#publicationSubscribers.add(listener);
    return () => {
      this.#publicationSubscribers.delete(listener);
    };
  }

  private assertMainPublication(): void {
    if (this.#publicationUncertainty) throw this.#publicationUncertainty;
  }
  private holdMainPublication(cause: unknown): StatePublicationUnconfirmedError {
    if (!this.#publicationUncertainty) {
      this.#publicationUncertainty = new StatePublicationUnconfirmedError(cause);
      this.saveDeb.cancel();
      const diagnostic = (message: string) => {
        // A failed diagnostic cannot replace the original private evidence or skip notices.
        try {
          console.error(message);
        } catch {
          /* original failure retained */
        }
      };
      diagnostic('[StateStore] STATE_PUBLICATION_UNCONFIRMED: main-state writes held; reconciliation required');
      const status = this.getStatePublicationStatus();
      const observerFailed = () => diagnostic('[StateStore] Publication-hold observer failed');
      for (const listener of [...this.#publicationSubscribers]) {
        try {
          void Promise.resolve(listener(status)).catch(observerFailed);
        } catch {
          observerFailed();
        }
      }
    }
    return this.#publicationUncertainty;
  }
  constructor(filePath?: string) {
    // Reverie never relocates or adopts another product's state automatically.
    this.filePath = filePath || dataPath('state.json');
    this.ralphStatePath = this.filePath.endsWith('.json')
      ? this.filePath.slice(0, -5) + '-inner.json'
      : this.filePath + '-inner.json';
    this.state = this.load();
    this.state.config.stateFilePath = this.filePath;
    // Pre-populate session cache for loaded state
    for (const [id, session] of Object.entries(this.state.sessions)) {
      this.cachedSessionJsons.set(id, JSON.stringify(session));
    }
    this.loadRalphStates();
  }

  private _mergeWithInitialState(parsed: Partial<AppState>): AppState {
    const initial = createInitialState();
    const publicState = { ...parsed };
    Reflect.deleteProperty(publicState, PROVIDER_LAUNCH_DISK_KEY);
    return {
      ...initial,
      ...publicState,
      sessions: { ...parsed.sessions },
      tasks: { ...parsed.tasks },
      ralphLoop: { ...initial.ralphLoop, ...parsed.ralphLoop },
      config: { ...initial.config, ...parsed.config },
    };
  }

  private _resetCircuitBreaker(): void {
    this.consecutiveSaveFailures = 0;
    if (this.circuitBreakerOpen) {
      console.log('[StateStore] Circuit breaker CLOSED - save succeeded');
      this.circuitBreakerOpen = false;
    }
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      // Use restrictive permissions (0o700) - owner only can read/write/traverse
      // State files may contain sensitive session data
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private load(): AppState {
    // Try main file first, then .bak fallback
    for (const path of [this.filePath, this.filePath + '.bak']) {
      try {
        let data: string;
        try {
          data = readFileSync(path, 'utf-8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (path === this.filePath) this.#mainDiskRevisionKnown = true;
          continue;
        }
        const parsed = JSON.parse(data) as Partial<AppState>;
        this.loadProviderState(parsed, path !== this.filePath);
        const result = this._mergeWithInitialState(parsed);
        // The parsed state and owned disk revision must come from the SAME read.
        // A later read could accidentally authorize old memory over a newer writer.
        if (path === this.filePath) {
          this.#mainDiskRevision = data;
          this.#mainDiskRevisionKnown = true;
        }
        if (path !== this.filePath) {
          console.warn(`[StateStore] Recovered state from backup: ${path}`);
          this.fenceBackupCronJobs(result);
        }
        return result;
      } catch (err) {
        this.#providerLaunchHistory = 'unconfirmed';
        console.error(`Failed to load state from ${path}:`, err);
      }
    }
    return createInitialState();
  }

  /** Every backup restoration is uncertain. Keep current jobs/run evidence even if the backup omits them. */
  private fenceBackupCronJobs(recovered: AppState, retained?: AppState): void {
    for (const job of Object.values(retained?.cronJobs ?? {})) {
      recovered.cronJobs ??= {};
      recovered.cronJobs[job.id] = { ...job };
      for (const run of Object.values(retained?.cronJobRuns ?? {})) {
        if (run.cronJobId !== job.id) continue;
        recovered.cronJobRuns ??= {};
        recovered.cronJobRuns[run.id] = run;
      }
    }
    for (const job of Object.values(recovered.cronJobs ?? {})) {
      job.enabled = false;
      job.nextRunAt = null;
      job.recoveryUncertain = true;
      delete job.watchGeneration;
    }
  }

  /**
   * Schedules a debounced save.
   * Multiple calls within 500ms are batched into a single disk write.
   * Uses async I/O to avoid blocking the event loop.
   */
  save(): void {
    this.dirty = true;
    if (this.#publicationUncertainty) return;
    if (this.saveDeb.isPending) return; // Already scheduled
    this.saveDeb.schedule(() => {
      this.saveNowAsync().catch((err) => {
        console.error('[StateStore] Async save failed:', err);
      });
    });
  }

  /**
   * Async version of saveNow — used by the debounced save() path.
   * Uses non-blocking fs.promises to avoid blocking the event loop during
   * the debounced write cycle. For synchronous shutdown flush, use saveNow().
   *
   * Guards against concurrent execution: if a save is already in flight,
   * waits for it to complete then re-checks dirty flag before starting another.
   */
  async saveNowAsync(): Promise<void> {
    return this.serializeWrite(() => this._doSaveAsync());
  }

  /** All main-state writers share this queue, including acknowledged watcher intents. */
  private async serializeWrite<T>(write: () => T | Promise<T>): Promise<T> {
    const task = (this._saveInFlight ?? Promise.resolve()).catch(() => undefined).then(write);
    this._saveInFlight = task;
    try { return await task; }
    finally { if (this._saveInFlight === task) this._saveInFlight = null; }
  }
  /** Existing state file, not a second ledger. The callback fences current job generation at commit. */
  async commitCronWatch(mutate: () => void): Promise<void> {
    return this.serializeWrite(() =>
      this.acknowledgeMainState(
        mutate,
        () => {},
        (before) => {
          const previous = JSON.parse(before) as AppState;
          this.state.cronJobs = previous.cronJobs;
          this.state.cronJobRuns = previous.cronJobRuns;
        },
        'watcher'
      )
    );
  }
  /** Sole strict acknowledged writer, under the existing main-state queue. */
  private acknowledgeMainState(
    mutate: () => void,
    validate: () => void,
    restore: (before: string) => void,
    purpose: 'watcher' | 'provider' | 'config' | 'recovery-stopped',
    projection?: () => string | null,
    recovery?: StoppedProviderWrite
  ): void {
    if (this.#publicationUncertainty) {
      if (!recovery || recovery.uncertainty !== this.#publicationUncertainty) throw this.#publicationUncertainty;
      this.assertStoppedDisk(recovery);
    } else this.assertMainPublication();
    if (this.circuitBreakerOpen) throw new Error('Acknowledged state publication unavailable');
    validate();
    this.saveDeb.cancel();
    const before = this.serializeState();
    if (before === null) throw new Error('Acknowledged state publication unavailable');
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.${purpose}.tmp`;
    let fd: number | undefined;
    let renameIssued = false;
    let temporaryOwned = false;
    let attempted: string | null = null;
    const close = () => {
      const owned = fd;
      fd = undefined;
      if (owned !== undefined) closeSync(owned);
    };
    try {
      mutate();
      this.saveDeb.cancel();
      this.dirty = true;
      this.ensureDir();
      const json = projection ? projection() : this.serializeState();
      if (json === null) throw new Error('Acknowledged state publication unavailable');
      attempted = json;
      fd = openSync(temp, 'wx', 0o600);
      temporaryOwned = true;
      writeFileSync(fd, json, 'utf8');
      fsyncSync(fd);
      close();
      validate();
      renameIssued = true;
      renameSync(temp, this.filePath);
      fd = openSync(dirname(this.filePath), 'r');
      fsyncSync(fd);
      close();
      validate();
      this.dirty = false;
      this.#mainDiskRevision = attempted;
      this.#mainDiskRevisionKnown = true;
      this._resetCircuitBreaker();
    } catch (error) {
      restore(before);
      this.dirty = true;
      const cleanupErrors: unknown[] = [];
      if (fd !== undefined) {
        try {
          close();
        } catch (cleanup) {
          cleanupErrors.push(cleanup);
        }
      }
      if (temporaryOwned)
        try {
          unlinkSync(temp);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException)?.code !== 'ENOENT') cleanupErrors.push(cleanup);
        }
      const cause = Object.freeze({
        error,
        cleanupErrors: Object.freeze(cleanupErrors),
        [purpose + 'Publication']: Object.freeze({ before, attempted }),
      });
      if (renameIssued) {
        const held = this.holdMainPublication(cause);
        if (recovery) recovery.uncertainty ??= held;
        throw held;
      }
      const message =
        purpose === 'watcher'
          ? 'Watcher state commit unconfirmed; delivery held'
          : purpose === 'provider'
            ? 'Provider launch publication unconfirmed; dispatch refused'
            : 'Configuration publication unconfirmed; save not acknowledged';
      throw new AcknowledgedStateWriteError(message, cause);
    }
  }

  /**
   * Assemble JSON string with incremental per-session caching.
   * Only dirty sessions are re-serialized; clean sessions use cached JSON fragments.
   */
  private assembleStateJson(): string {
    this.updateDirtySessionCache();

    // Build sessions object from cached fragments
    const sessionParts: string[] = [];
    for (const [id, session] of Object.entries(this.state.sessions)) {
      let json = this.cachedSessionJsons.get(id);
      if (!json) {
        // Session not in cache (loaded from disk or set via direct state mutation)
        json = JSON.stringify(session);
        this.cachedSessionJsons.set(id, json);
      }
      sessionParts.push(`${JSON.stringify(id)}:${json}`);
    }

    this.pruneStaleCacheEntries();

    return this.buildPartialJson(sessionParts);
  }

  private updateDirtySessionCache(): void {
    // Re-serialize dirty sessions and update cache
    for (const id of this.dirtySessions) {
      const session = this.state.sessions[id];
      if (session) {
        this.cachedSessionJsons.set(id, JSON.stringify(session));
      } else {
        this.cachedSessionJsons.delete(id);
      }
    }
    this.dirtySessions.clear();
  }

  private pruneStaleCacheEntries(): void {
    // Prune stale cache entries (sessions removed via direct state mutation)
    if (this.cachedSessionJsons.size > Object.keys(this.state.sessions).length) {
      for (const cachedId of this.cachedSessionJsons.keys()) {
        if (!(cachedId in this.state.sessions)) {
          this.cachedSessionJsons.delete(cachedId);
        }
      }
    }
  }

  private buildPartialJson(sessionParts: string[]): string {
    // Build final JSON: sessions from cache, everything else re-serialized (tiny)
    const sessionsJson = `{${sessionParts.join(',')}}`;

    // Serialize non-session fields individually (they're small)
    const parts: string[] = [
      `"sessions":${sessionsJson}`,
      `"tasks":${JSON.stringify(this.state.tasks)}`,
      `"ralphLoop":${JSON.stringify(this.state.ralphLoop)}`,
      `"config":${JSON.stringify(this.state.config)}`,
      `${JSON.stringify(PROVIDER_LAUNCH_DISK_KEY)}:${JSON.stringify(this.privateProviderState())}`,
    ];

    // Optional fields
    if (this.state.globalStats) {
      parts.push(`"globalStats":${JSON.stringify(this.state.globalStats)}`);
    }
    if (this.state.tokenStats) {
      parts.push(`"tokenStats":${JSON.stringify(this.state.tokenStats)}`);
    }
    if (this.state.cronJobs) {
      parts.push(`"cronJobs":${JSON.stringify(this.state.cronJobs)}`);
    }
    if (this.state.cronJobRuns) {
      parts.push(`"cronJobRuns":${JSON.stringify(this.state.cronJobRuns)}`);
    }
    if (this.state.sessionOrder) {
      parts.push(`"sessionOrder":${JSON.stringify(this.state.sessionOrder)}`);
    }
    if (this.state.tabLayouts !== undefined) {
      parts.push(`"tabLayouts":${JSON.stringify(this.state.tabLayouts)}`);
    }

    return `{${parts.join(',')}}`;
  }
  private serializeState(): string | null {
    try {
      return this.assembleStateJson();
    } catch (assembleErr) {
      // Fallback to full serialization if incremental assembly fails
      console.warn('[StateStore] assembleStateJson failed, falling back to full serialize:', assembleErr);
      this.cachedSessionJsons.clear();
      this.dirtySessions.clear();
      try {
        return JSON.stringify({ ...this.state, [PROVIDER_LAUNCH_DISK_KEY]: this.privateProviderState() });
      } catch (err) {
        console.error('[StateStore] Failed to serialize state (circular reference or invalid data):', err);
        this.consecutiveSaveFailures++;
        if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error('[StateStore] Circuit breaker OPEN - serialization failing repeatedly');
          this.circuitBreakerOpen = true;
        }
        return null;
      }
    }
  }
  private async _doSaveAsync(): Promise<void> {
    this.assertMainPublication();
    this.saveDeb.cancel();
    if (!this.dirty) {
      return;
    }

    // Circuit breaker: stop attempting writes after too many failures
    if (this.circuitBreakerOpen) {
      console.warn('[StateStore] Circuit breaker open - skipping save (too many consecutive failures)');
      return;
    }

    this.ensureDir();

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const backupPath = this.filePath + '.bak';

    // Step 1: Serialize state (validates it's JSON-safe)
    const json = this.serializeState();
    if (json === null) return;

    // Clear dirty flag BEFORE async I/O so mutations during write re-set it.
    // The state snapshot is already captured in `json` above.
    this.dirty = false;

    // Step 2: Create backup via file copy (async, no read+parse+write)
    try {
      await access(this.filePath);
      await copyFile(this.filePath, backupPath);
    } catch {
      // Backup failed or file doesn't exist yet - continue with write
    }

    // Every replacement preserves the durability of previously acknowledged intents.
    let renameIssued = false;
    let file: FileHandle | undefined;
    const close = async () => {
      const original = file;
      file = undefined; // consuming close; an error never permits a reused-FD retry.
      if (original) await original.close();
    };
    try {
      file = await openAsync(tempPath, 'wx', 0o600);
      await file.writeFile(json, 'utf8');
      await file.sync();
      await close();
      renameIssued = true;
      await rename(tempPath, this.filePath);
      file = await openAsync(dirname(this.filePath), 'r');
      await file.sync();
      await close();
      this.#mainDiskRevision = json;
      this.#mainDiskRevisionKnown = true;

      this._resetCircuitBreaker();
    } catch (err) {
      try {
        console.error('[StateStore] Failed to write state file:', err);
      } catch {
        /* Logging cannot replace the original write outcome. */
      }
      // Re-mark dirty so the data is retried on the next save cycle
      this.dirty = true;
      this.consecutiveSaveFailures++;

      // Cleanup never retries a consumed descriptor or replaces the original uncertainty.
      let cleanupError: unknown;
      if (file) {
        try {
          await close();
        } catch (cause) {
          cleanupError = cause;
        }
      }
      try {
        await unlink(tempPath);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException)?.code !== 'ENOENT')
          cleanupError = cleanupError === undefined ? cleanup : { close: cleanupError, unlink: cleanup };
      }

      if (renameIssued) throw this.holdMainPublication(Object.freeze({ error: err, cleanupError }));

      // Check circuit breaker threshold
      if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.circuitBreakerOpen = true;
        try {
          console.error('[StateStore] Circuit breaker OPEN - writes failing repeatedly');
        } catch {
          /* Denial remains installed. */
        }
      }
    }
  }
  /**
   * Synchronous immediate write to disk using atomic write pattern.
   * Used by flushAll() during shutdown when async is not appropriate.
   * Prefer saveNowAsync() for normal operation.
   */
  saveNow(): void {
    this.assertMainPublication();
    // A synchronous shutdown/save must not overtake an older asynchronous snapshot.
    if (this._saveInFlight) {
      this.save();
      return;
    }
    this.saveDeb.cancel();
    if (!this.dirty) {
      return;
    }

    if (this.circuitBreakerOpen) {
      console.warn('[StateStore] Circuit breaker open - skipping save (too many consecutive failures)');
      return;
    }

    this.ensureDir();

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const backupPath = this.filePath + '.bak';

    const json = this.serializeState();
    if (json === null) return;

    // Backup via atomic copy (avoids reading entire file into memory)
    try {
      if (existsSync(this.filePath)) {
        copyFileSync(this.filePath, backupPath);
      }
    } catch {
      // Backup failed - continue with write
    }

    let renameIssued = false;
    let fd: number | undefined;
    const close = () => {
      const owned = fd;
      fd = undefined;
      if (owned !== undefined) closeSync(owned);
    };
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeFileSync(fd, json, 'utf8');
      fsyncSync(fd);
      close();
      renameIssued = true;
      renameSync(tempPath, this.filePath);
      fd = openSync(dirname(this.filePath), 'r');
      fsyncSync(fd);
      close();
      // Clear dirty flag only AFTER successful write
      this.dirty = false;
      this.#mainDiskRevision = json;
      this.#mainDiskRevisionKnown = true;
      this._resetCircuitBreaker();
    } catch (err) {
      try {
        console.error('[StateStore] Failed to write state file:', err);
      } catch {
        /* Logging cannot replace the original write outcome. */
      }
      this.consecutiveSaveFailures++;
      let cleanupError: unknown;
      if (fd !== undefined) {
        try {
          close();
        } catch (cause) {
          cleanupError = cause;
        }
      }
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch (cleanup) {
        cleanupError = cleanupError === undefined ? cleanup : { close: cleanupError, unlink: cleanup };
      }
      if (renameIssued) throw this.holdMainPublication(Object.freeze({ error: err, cleanupError }));
      if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.circuitBreakerOpen = true;
        try {
          console.error('[StateStore] Circuit breaker OPEN - writes failing repeatedly');
        } catch {
          /* Denial remains installed. */
        }
      }
    }
  }

  /**
   * Attempt to recover state from backup file.
   * Call this if main state file is corrupt.
   */
  recoverFromBackup(): boolean {
    // This synchronous API cannot await the shared writer. Refuse rather than let an old snapshot
    // or a queued intent race the restore. A later explicit retry uses the same fence below.
    if (this._saveInFlight || this.#publicationUncertainty) return false;
    const backupPath = this.filePath + '.bak';
    try {
      if (existsSync(backupPath)) {
        const backupContent = readFileSync(backupPath, 'utf-8');
        const parsed = JSON.parse(backupContent) as Partial<AppState>;
        this.loadProviderState(parsed, true);
        const recovered = this._mergeWithInitialState(parsed);
        this.fenceBackupCronJobs(recovered, this.state);
        recovered.config.stateFilePath = this.filePath;
        this.saveDeb.cancel();
        this.state = recovered;
        this.cachedSessionJsons.clear();
        this.dirtySessions.clear();
        console.log('[StateStore] Successfully recovered state from backup');
        // Reset circuit breaker after successful recovery
        this.circuitBreakerOpen = false;
        this.consecutiveSaveFailures = 0;
        this.save();
        return true;
      }
    } catch (err) {
      console.error('[StateStore] Failed to recover from backup:', err);
    }
    return false;
  }

  /**
   * Reset the circuit breaker (for manual intervention).
   */
  resetCircuitBreaker(): void {
    this.assertMainPublication();
    this.circuitBreakerOpen = false;
    this.consecutiveSaveFailures = 0;
    console.log('[StateStore] Circuit breaker manually reset');
  }

  /** Flushes any pending main state save. Call before shutdown. */
  flush(): void {
    this.saveNow();
  }

  /** Returns the full application state object. */
  getState(): AppState {
    return this.state;
  }

  /** Returns all session states keyed by session ID. */
  getSessions() {
    return this.state.sessions;
  }

  /** Returns a session state by ID, or null if not found. */
  getSession(id: string) {
    return this.state.sessions[id] ?? null;
  }

  /** Preserve ONLY separately owned respawn metadata, never stale Session private fields. */
  setSessionFromOwner(session: Session, snapshot: AppState['sessions'][string], respawn: 'preserve' | 'authoritative'): void {
    if (snapshot.id !== session.id || snapshot.owner !== session.owner) throw new Error('Original persisted Session changed');
    const next = { ...snapshot };
    const previous = this.state.sessions[session.id];
    if (respawn === 'preserve' && previous) {
      if (!Object.hasOwn(snapshot, 'respawnConfig') && previous.respawnConfig !== undefined) next.respawnConfig = previous.respawnConfig;
      if (!Object.hasOwn(snapshot, 'respawnEnabled') && previous.respawnEnabled !== undefined) next.respawnEnabled = previous.respawnEnabled;
    }
    this.setSession(session.id, next);
  }

  /** Sets a session state and triggers a debounced save. */
  setSession(id: string, session: AppState['sessions'][string]) {
    this.state.sessions[id] = session;
    this.dirtySessions.add(id);
    this.save();
  }

  /** Removes a session state and triggers a debounced save. */
  removeSession(id: string) {
    delete this.state.sessions[id];
    this.cachedSessionJsons.delete(id);
    this.dirtySessions.delete(id);
    this.save();
  }

  /**
   * COD-142: Remove a session's persisted record on kill UNLESS it is pinned.
   * A pinned session is demoted to a lightweight `stopped` record (pin retained)
   * so it stays visible in the session-manager pinned group and survives restart.
   * Unpinned sessions are fully removed (unchanged behavior).
   * @returns 'preserved' if demoted to stopped+pinned, 'removed' if deleted, 'absent' if no record existed.
   */
  demoteOrRemoveSession(id: string): 'preserved' | 'removed' | 'absent' {
    const existing = this.state.sessions[id];
    if (!existing) return 'absent';
    if (existing.pinned === true) {
      // Demote in place: keep identity/resume fields + pin, mark stopped, clear live runtime.
      this.setSession(id, { ...existing, status: 'stopped', pid: null });
      return 'preserved';
    }
    this.removeSession(id);
    return 'removed';
  }

  /**
   * Cleans up stale sessions from state that don't have corresponding active sessions.
   * @param activeSessionIds - Set of currently active session IDs
   * @returns Number of sessions cleaned up
   */
  cleanupStaleSessions(activeSessionIds: Set<string>): {
    count: number;
    cleaned: Array<{ id: string; name?: string; owner?: string }>;
  } {
    const staleIds = new Set(Object.keys(this.state.sessions).filter((sessionId) => !activeSessionIds.has(sessionId)));
    return this.cleanupSessionsByIds(staleIds);
  }

  /** Deletes only confirmed stale session IDs, retaining records pinned after confirmation. */
  cleanupSessionsByIds(sessionIds: ReadonlySet<string>): {
    count: number;
    cleaned: Array<{ id: string; name?: string; owner?: string }>;
  } {
    const cleaned: Array<{ id: string; name?: string; owner?: string }> = [];

    for (const sessionId of sessionIds) {
      const session = this.state.sessions[sessionId];
      if (!session || session.pinned === true) continue; // COD-142: pinned records persist even with no live session
      cleaned.push({ id: sessionId, name: session.name, owner: session.owner });
      delete this.state.sessions[sessionId];
      this.cachedSessionJsons.delete(sessionId);
      this.dirtySessions.delete(sessionId);
      // Also clean up Ralph state for this session
      this.ralphStates.delete(sessionId);
    }

    if (cleaned.length > 0) {
      console.log(`[StateStore] Cleaned up ${cleaned.length} stale session(s) from state`);
      this.save();
    }

    return { count: cleaned.length, cleaned };
  }

  /** Returns all task states keyed by task ID. */
  getTasks() {
    return this.state.tasks;
  }

  /** Returns a task state by ID, or null if not found. */
  getTask(id: string) {
    return this.state.tasks[id] ?? null;
  }

  /** Sets a task state and triggers a debounced save. */
  setTask(id: string, task: AppState['tasks'][string]) {
    this.state.tasks[id] = task;
    this.save();
  }

  /** Removes a task state and triggers a debounced save. */
  removeTask(id: string) {
    delete this.state.tasks[id];
    this.save();
  }

  /** Returns the Ralph Loop state. */
  getRalphLoopState() {
    return this.state.ralphLoop;
  }

  /** Updates Ralph Loop state (partial merge) and triggers a debounced save. */
  setRalphLoopState(ralphLoop: Partial<AppState['ralphLoop']>) {
    this.state.ralphLoop = { ...this.state.ralphLoop, ...ralphLoop };
    this.save();
  }

  // ========== Orchestrator Loop State Methods ==========

  /** Returns the orchestrator loop state, or null if never initialized. */
  getOrchestratorState() {
    return this.state.orchestrator ?? null;
  }

  /** Updates orchestrator loop state (partial merge) and triggers a debounced save. */
  setOrchestratorState(orchestrator: Partial<NonNullable<AppState['orchestrator']>>) {
    if (this.state.orchestrator) {
      this.state.orchestrator = { ...this.state.orchestrator, ...orchestrator };
    } else {
      // First initialization — caller must provide full state
      this.state.orchestrator = orchestrator as NonNullable<AppState['orchestrator']>;
    }
    this.save();
  }

  /** Clears orchestrator state and triggers a debounced save. */
  clearOrchestratorState() {
    this.state.orchestrator = undefined;
    this.save();
  }

  // ========== Cron Job Methods ==========

  /** Returns all scheduled jobs keyed by job ID. */
  getCronJobs(): Record<string, import('./types/cron.js').CronJob> {
    if (!this.state.cronJobs) this.state.cronJobs = {};
    return this.state.cronJobs;
  }

  /** Returns a scheduled job by ID, or null if not found. */
  getCronJob(id: string): import('./types/cron.js').CronJob | null {
    return this.state.cronJobs?.[id] ?? null;
  }

  /** Sets a scheduled job and triggers a debounced save. */
  setCronJob(id: string, job: import('./types/cron.js').CronJob): void {
    if (!this.state.cronJobs) this.state.cronJobs = {};
    this.state.cronJobs[id] = job;
    this.save();
  }

  /** Removes a scheduled job and triggers a debounced save. */
  removeCronJob(id: string): void {
    if (this.state.cronJobs) delete this.state.cronJobs[id];
    this.save();
  }

  /** Returns all scheduled job runs keyed by run ID. */
  getCronJobRuns(): Record<string, import('./types/cron.js').CronJobRun> {
    if (!this.state.cronJobRuns) this.state.cronJobRuns = {};
    return this.state.cronJobRuns;
  }

  /** Sets a scheduled job run (history record) and triggers a debounced save. */
  setCronJobRun(id: string, run: import('./types/cron.js').CronJobRun): void {
    if (!this.state.cronJobRuns) this.state.cronJobRuns = {};
    this.state.cronJobRuns[id] = run;
    this.save();
  }

  /** Removes a scheduled job run and triggers a debounced save. */
  removeCronJobRun(id: string): void {
    if (this.state.cronJobRuns) delete this.state.cronJobRuns[id];
    this.save();
  }

  /** Returns the application configuration. */
  getConfig() {
    return this.state.config;
  }

  /** Explicit configuration saves join the canonical writer and acknowledge only checked publication. */
  commitConfig(config: ConfigPatch): Promise<AppState['config']> {
    const patch = structuredClone(config);
    return this.serializeWrite(() => {
      const previous = this.state.config;
      const { respawn, ...update } = patch;
      this.acknowledgeMainState(
        () => {
          this.state.config = {
            ...previous,
            ...update,
            ...(respawn ? { respawn: { ...previous.respawn, ...respawn } } : {}),
          };
        },
        () => {},
        () => {
          this.state.config = previous;
        },
        'config'
      );
      // A later observer/configuration update cannot alter this acknowledgement.
      return structuredClone(this.state.config);
    });
  }

  /** Updates configuration (partial merge) and triggers a debounced save. */
  setConfig(config: Partial<AppState['config']>) {
    this.state.config = { ...this.state.config, ...config };
    this.save();
  }

  /** Returns the global tab order (ordered sessionIds), [] if unset. COD-131. */
  getSessionOrder(): string[] {
    return this.state.sessionOrder ?? [];
  }

  /** Persists the global tab order (ordered sessionIds) and triggers a debounced save. COD-131. */
  setSessionOrder(order: string[]): void {
    this.state.sessionOrder = order;
    this.save();
  }

  /** Returns an owner layout, or null before that owner has been migrated. */
  getTabLayout(owner: string): TabLayout | null {
    const layouts = this.state.tabLayouts;
    return layouts && Object.hasOwn(layouts, owner) ? layouts[owner] : null;
  }

  /** Returns a defensive snapshot of every stored owner layout. */
  getTabLayouts(): Record<string, TabLayout> {
    return structuredClone(this.state.tabLayouts ?? {});
  }

  /** Validates and atomically persists one owner layout. */
  setTabLayout(owner: string, layout: TabLayout): void {
    const validated = validateTabLayout(layout);
    this.state.tabLayouts = { ...(this.state.tabLayouts ?? {}), [owner]: validated };
    this.save();
  }

  /** Atomically publishes validated owner layouts and their latest global compatibility projection. */
  commitTabLayoutProjection(
    layouts: Readonly<Record<string, TabLayout>>,
    projectOrder: (latest: readonly string[]) => readonly string[]
  ): { layouts: Record<string, TabLayout>; sessionOrder: string[] } {
    const validated = Object.fromEntries(
      Object.entries(layouts).map(([owner, layout]) => [owner, validateTabLayout(layout)])
    );
    const sessionOrder = normalizeSessionOrder(projectOrder([...(this.state.sessionOrder ?? [])]));
    const nextLayouts = { ...(this.state.tabLayouts ?? {}), ...validated };

    this.state.tabLayouts = nextLayouts;
    this.state.sessionOrder = sessionOrder;
    this.save();
    return { layouts: structuredClone(validated), sessionOrder: [...sessionOrder] };
  }

  /** Resets all state to initial values and saves immediately. */
  reset(): void {
    this.assertMainPublication();
    if (this._saveInFlight) throw new Error('State write is in progress; reset refused');
    this.state = createInitialState();
    this.state.config.stateFilePath = this.filePath;
    this.ralphStates.clear();
    this.cachedSessionJsons.clear();
    this.dirtySessions.clear();
    this.dirty = true;
    this.saveNow(); // Immediate save for reset operations
    this.saveRalphStatesNow();
  }

  // ========== Global Stats Methods ==========

  /** Returns global stats, creating initial stats if needed. */
  getGlobalStats(): GlobalStats {
    if (!this.state.globalStats) {
      this.state.globalStats = createInitialGlobalStats();
    }
    return this.state.globalStats;
  }

  /**
   * Adds tokens and cost to global stats.
   * Call when a session is deleted to preserve its usage in lifetime stats.
   */
  addToGlobalStats(inputTokens: number, outputTokens: number, cost: number): void {
    // Sanity check: reject absurdly large values
    if (inputTokens > MAX_SESSION_TOKENS || outputTokens > MAX_SESSION_TOKENS) {
      console.warn(`[StateStore] Rejected absurd global stats: input=${inputTokens}, output=${outputTokens}`);
      return;
    }
    // Reject negative values
    if (inputTokens < 0 || outputTokens < 0 || cost < 0) {
      console.warn(
        `[StateStore] Rejected negative global stats: input=${inputTokens}, output=${outputTokens}, cost=${cost}`
      );
      return;
    }

    const stats = this.getGlobalStats();
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    stats.totalCost += cost;
    stats.lastUpdatedAt = Date.now();
    this.save();
  }

  /** Increments the total sessions created counter. */
  incrementSessionsCreated(): void {
    const stats = this.getGlobalStats();
    stats.totalSessionsCreated += 1;
    stats.lastUpdatedAt = Date.now();
    this.save();
  }

  /**
   * Returns aggregate stats combining global (deleted sessions) + active sessions.
   * @param activeSessions Map of active session states
   */
  getAggregateStats(
    activeSessions: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }>
  ): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    totalSessionsCreated: number;
    activeSessionsCount: number;
  } {
    const global = this.getGlobalStats();
    let activeInput = 0;
    let activeOutput = 0;
    let activeCost = 0;
    let activeCount = 0;

    for (const session of Object.values(activeSessions)) {
      activeInput += session.inputTokens ?? 0;
      activeOutput += session.outputTokens ?? 0;
      activeCost += session.totalCost ?? 0;
      activeCount++;
    }

    return {
      totalInputTokens: global.totalInputTokens + activeInput,
      totalOutputTokens: global.totalOutputTokens + activeOutput,
      totalCost: global.totalCost + activeCost,
      totalSessionsCreated: global.totalSessionsCreated,
      activeSessionsCount: activeCount,
    };
  }

  // ========== Token Stats Methods (Daily Tracking) ==========

  /** Maximum days to keep in daily history */
  private static readonly MAX_DAILY_HISTORY = 30;

  /**
   * Get or initialize token stats from state.
   */
  getTokenStats(): TokenStats {
    if (!this.state.tokenStats) {
      this.state.tokenStats = {
        daily: [],
        lastUpdated: Date.now(),
      };
    }
    return this.state.tokenStats;
  }

  /**
   * Get today's date string in YYYY-MM-DD format.
   */
  private getTodayDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  /**
   * Calculate estimated cost from tokens using Claude Opus pricing.
   * Input: $15/M tokens, Output: $75/M tokens
   */
  private calculateEstimatedCost(inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1000000) * 15;
    const outputCost = (outputTokens / 1000000) * 75;
    return inputCost + outputCost;
  }

  // Track unique sessions per day for accurate session count
  private dailySessionIds: Set<string> = new Set();
  private dailySessionDate: string = '';

  /**
   * Record token usage for today.
   * Accumulates tokens to today's entry, creating it if needed.
   * @param inputTokens Input tokens to add
   * @param outputTokens Output tokens to add
   * @param sessionId Optional session ID for unique session counting
   */
  recordDailyUsage(inputTokens: number, outputTokens: number, sessionId?: string): void {
    if (inputTokens <= 0 && outputTokens <= 0) return;

    // Sanity check: reject absurdly large values (max 1M tokens per recording)
    // Claude's context window is ~200k, so 1M per recording is already very generous
    const MAX_TOKENS_PER_RECORDING = 1_000_000;
    if (inputTokens > MAX_TOKENS_PER_RECORDING || outputTokens > MAX_TOKENS_PER_RECORDING) {
      console.warn(`[StateStore] Rejected absurd token values: input=${inputTokens}, output=${outputTokens}`);
      return;
    }

    const stats = this.getTokenStats();
    const today = this.getTodayDateString();

    // Reset daily session tracking on date change
    if (this.dailySessionDate !== today) {
      this.dailySessionIds.clear();
      this.dailySessionDate = today;
    }

    // Find or create today's entry
    let todayEntry = stats.daily.find((e) => e.date === today);
    if (!todayEntry) {
      todayEntry = {
        date: today,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        sessions: 0,
      };
      stats.daily.unshift(todayEntry); // Add to front (most recent first)
    }

    // Accumulate tokens
    todayEntry.inputTokens += inputTokens;
    todayEntry.outputTokens += outputTokens;
    todayEntry.estimatedCost = this.calculateEstimatedCost(todayEntry.inputTokens, todayEntry.outputTokens);

    // Only increment session count for unique sessions
    if (sessionId && !this.dailySessionIds.has(sessionId)) {
      this.dailySessionIds.add(sessionId);
      todayEntry.sessions = this.dailySessionIds.size;
    }

    // Prune old entries (keep last 30 days)
    if (stats.daily.length > StateStore.MAX_DAILY_HISTORY) {
      stats.daily = stats.daily.slice(0, StateStore.MAX_DAILY_HISTORY);
    }

    stats.lastUpdated = Date.now();
    this.save();
  }

  /**
   * Get daily stats for display.
   * @param days Number of days to return (default: 30)
   * @returns Array of daily entries, most recent first
   */
  getDailyStats(days: number = 30): TokenUsageEntry[] {
    const stats = this.getTokenStats();
    return stats.daily.slice(0, days);
  }

  // ========== Inner State Methods (Ralph Loop tracking) ==========

  private loadRalphStates(): void {
    try {
      if (existsSync(this.ralphStatePath)) {
        const data = readFileSync(this.ralphStatePath, 'utf-8');
        const parsed = JSON.parse(data) as Record<string, RalphSessionState>;
        for (const [sessionId, state] of Object.entries(parsed)) {
          this.ralphStates.set(sessionId, state);
        }
      }
    } catch (err) {
      console.error('Failed to load inner states:', err);
    }
  }

  // Debounced save for inner states
  private saveRalphStates(): void {
    this.ralphStateDirty = true;
    if (this.ralphStateSaveDeb.isPending) return; // Already scheduled
    this.ralphStateSaveDeb.schedule(() => {
      this.saveRalphStatesNow();
    });
  }

  /**
   * Immediate save for inner states using atomic write pattern.
   * Writes to temp file first, then renames to prevent corruption on crash.
   */
  private saveRalphStatesNow(): void {
    this.ralphStateSaveDeb.cancel();
    if (!this.ralphStateDirty) {
      return;
    }
    // Clear dirty flag only on success to enable retry on failure
    this.ensureDir();
    const data = Object.fromEntries(this.ralphStates);
    // Atomic write: write to temp file, then rename (atomic on POSIX)
    const tempPath = this.ralphStatePath + '.tmp';
    let json: string;
    try {
      json = JSON.stringify(data);
    } catch (err) {
      console.error('[StateStore] Failed to serialize Ralph state (circular reference or invalid data):', err);
      // Keep dirty flag true for retry - don't throw, let caller continue
      return;
    }
    try {
      writeFileSync(tempPath, json, 'utf-8');
      renameSync(tempPath, this.ralphStatePath);
      // Success - clear dirty flag
      this.ralphStateDirty = false;
    } catch (err) {
      console.error('[StateStore] Failed to write Ralph state file:', err);
      // Keep dirty flag true for retry on next save
      // Try to clean up temp file on error
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch (cleanupErr) {
        console.warn('[StateStore] Failed to cleanup temp file during Ralph state save error:', cleanupErr);
      }
      // Don't throw - let caller continue, retry on next save
    }
  }

  /** Returns inner state for a session, or null if not found. */
  getRalphState(sessionId: string): RalphSessionState | null {
    return this.ralphStates.get(sessionId) ?? null;
  }

  /** Sets inner state for a session and triggers a debounced save. */
  setRalphState(sessionId: string, state: RalphSessionState): void {
    this.ralphStates.set(sessionId, state);
    this.saveRalphStates();
  }

  /**
   * Updates inner state for a session (partial merge).
   * Creates initial state if none exists.
   * @returns The updated inner state.
   */
  updateRalphState(sessionId: string, updates: Partial<RalphSessionState>): RalphSessionState {
    let state = this.ralphStates.get(sessionId);
    if (!state) {
      state = createInitialRalphSessionState(sessionId);
    }
    state = { ...state, ...updates, lastUpdated: Date.now() };
    this.ralphStates.set(sessionId, state);
    this.saveRalphStates();
    return state;
  }

  /** Removes inner state for a session and triggers a debounced save. */
  removeRalphState(sessionId: string): void {
    if (this.ralphStates.has(sessionId)) {
      this.ralphStates.delete(sessionId);
      this.saveRalphStates();
    }
  }

  /** Returns a copy of all inner states as a Map. */
  getAllRalphStates(): Map<string, RalphSessionState> {
    return new Map(this.ralphStates);
  }

  /** Flushes all pending saves (main and inner state). Call before shutdown. */
  flushAll(): void {
    // Save both states, catching errors to ensure both are attempted
    let mainError: unknown = null;
    let ralphError: unknown = null;

    try {
      this.saveNow();
    } catch (err) {
      mainError = err;
      console.error('[StateStore] Error flushing main state:', err);
    }

    try {
      this.saveRalphStatesNow();
    } catch (err) {
      ralphError = err;
      console.error('[StateStore] Error flushing Ralph state:', err);
    }

    // Log summary if any errors occurred
    if (mainError || ralphError) {
      console.warn('[StateStore] flushAll completed with errors - some state may not be persisted');
    }
  }
}

// Singleton instance
let storeInstance: StateStore | null = null;

/**
 * Gets or creates the singleton StateStore instance.
 * @param filePath Optional custom file path (only used on first call).
 */
export function getStore(filePath?: string): StateStore {
  if (!storeInstance) {
    storeInstance = new StateStore(filePath);
  }
  return storeInstance;
}
