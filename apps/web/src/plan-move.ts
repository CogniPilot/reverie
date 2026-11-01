import { createHash } from 'node:crypto';
import {assertResourceOperation, type ResourceOwnerBinding} from './resource-owner-authority.js';
import {ResourceHistoricalSettlement} from './resource-native-client.js';

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
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) ||
      ![value.operationId, value.reservationId].every(id => typeof id === 'string' && uuid.test(id)) ||
      typeof value.profileVersion !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value.profileVersion) ||
      BigInt(value.profileVersion) > 18446744073709551615n ||
      ![value.profileDigest, value.previewDigest].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))
    throw new PlanMoveError('Invalid resource transaction references');
  return Object.freeze({ operationId: value.operationId, reservationId: value.reservationId,
    profileVersion: value.profileVersion, profileDigest: value.profileDigest, previewDigest: value.previewDigest });
}

export interface PlanMoveInput {
  id: string;
  employeeId: string;
  sessionId: string;
  fromAccount: string;
  toAccount: string;
  forceBusy: boolean;
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
  recoveryAction?: 'adopt-existing';
  recoveredAt?: number;
  purpose?: 'runtime-refresh';
  runtimeDigest?: string;
  resourceIntent?: PlanMoveResourceIntent;
  resourceOwnerScope?: string;
  resourcePhase?: PlanMoveResourcePhase;
}

export interface PlanMoveSnapshot {
  sessionId: string;
  name: string;
  account: string;
  working: boolean;
  mode?: string;
  model?: string;
  runtimeDigest?: string;
}

export interface PlanMovePort {
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

export type PlanMoveExecutor = Omit<PlanMovePort, 'load' | 'save' | 'recoveryPending' | 'recoveryConfirmed'>;

export class PlanMoveError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly blocker?: { id: string; action: 'inspect-existing' }
  ) {
    super(message);
  }
}

export class PlanMoves {
  private records = new Map<string, PlanMoveRecord>();
  private locked = new Set<string>();
  private intents = new Set<string>();
  private aborts = new Map<string, AbortController>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly port: PlanMovePort) {}

  private init(): Promise<void> {
    this.loaded ??= (async () => {
      for (const saved of await this.port.load()) {
        const record = { ...saved, ...(saved.resourceIntent ? { resourceIntent: resourceIntent(saved.resourceIntent) } : {}) };
        if (record.resourceIntent || !['completed', 'failed'].includes(record.phase)) {
          record.phase = 'recovery-required';
          record.error ??= record.resourceIntent
            ? 'Resource transactions require fresh native reconciliation after restart'
            : 'The server restarted during this move; inspect both sessions before retrying';
          this.locked.add(record.employeeId);
        }
        this.records.set(record.id, record);
      }
    })();
    return this.loaded;
  }

  private save(): Promise<void> {
    return this.port.save([...this.records.values()].map((record) => ({ ...record })));
  }

  private view(record: PlanMoveRecord): PlanMoveRecord {
    // A completion journal write is provisional while final native/audit fences
    // are still pending. Readers must not turn that window into successful Apply.
    if (record.phase === 'completed' && (this.aborts.has(record.id) || this.intents.has(record.id))) {
      if (record.resourceIntent) return { ...record, phase: 'checking', resourcePhase: 'verifying' };
      if (record.recoveryAction === 'adopt-existing') return { ...record, phase: 'checking' };
    }
    return { ...record };
  }

  /** Read-only flight guard shared with non-destructive viewer reconnection. */
  async viewerReconnectGuard(employeeId: string): Promise<() => boolean> {
    await this.init();
    return () => !this.locked.has(employeeId);
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
  async assertAvailable(employeeId: string, owner?: string): Promise<void> {
    await this.init();
    this.assertUnlocked(employeeId, owner);
  }

  private assertUnlocked(employeeId: string, owner?: string): void {
    if (!this.locked.has(employeeId)) return;
    const record = [...this.records.values()].find(row => row.employeeId === employeeId &&
      row.owner === owner && !['completed', 'failed'].includes(row.phase));
    throw new PlanMoveError('This employee already has a move in progress or requiring recovery; inspect its existing move',
      409, record ? { id: record.id, action: 'inspect-existing' } : undefined);
  }

  async begin(input: PlanMoveInput, owner?: string, executor: PlanMoveExecutor = this.port,
    ownerAuthority?: ResourceOwnerBinding): Promise<PlanMoveRecord> {
    // Capture references before the first await. No caller mutation may redirect
    // a queued transaction or silently turn a resource refresh into a plain one.
    input = { ...input, ...(input.resourceIntent !== undefined ? { resourceIntent: resourceIntent(input.resourceIntent) } : {}) };
    const checkOwnerScope = () => {
      if (input.resourceOwnerScope !== undefined) {
        try {
          if (!input.resourceIntent || !/^[a-f0-9]{64}$/.test(input.resourceOwnerScope) || !ownerAuthority ||
              assertResourceOperation(ownerAuthority, owner, input) !== input.resourceOwnerScope)
            throw new Error('missing private scope');
        } catch { throw new PlanMoveError('Resource refresh requires its current private owner context', 403); }
      } else if (input.resourceIntent && (typeof owner !== 'string' || !owner || owner.length > 200))
        throw new PlanMoveError('Resource refresh requires an explicit verified owner scope', 403);
    };
    checkOwnerScope();
    if (input.resourceIntent && (input.purpose !== 'runtime-refresh' ||
        typeof executor.prepareResources !== 'function' || typeof executor.verifyResources !== 'function' ||
        input.resourceOwnerScope !== undefined && typeof executor.completeResources !== 'function'))
      throw new PlanMoveError('Resource refresh requires its fixed preparation and native verification actor', 503);
    if ((input.purpose !== undefined && input.purpose !== 'runtime-refresh') ||
        (!input.purpose && input.runtimeDigest !== undefined))
      throw new PlanMoveError('Unknown plan move purpose');
    await this.init();
    checkOwnerScope();
    const requestDigest = createHash('sha256')
      .update(JSON.stringify([input.forceBusy, input.handoff, input.model ?? '', input.targetMode ?? '',
        ...(input.purpose ? [input.purpose, input.runtimeDigest] : []),
        ...(input.resourceIntent ? ['resources-v1', input.resourceIntent.operationId, input.resourceIntent.reservationId,
          input.resourceIntent.profileVersion, input.resourceIntent.profileDigest, input.resourceIntent.previewDigest,
          ...(input.resourceOwnerScope === undefined ? [] : [input.resourceOwnerScope])] : [])]))
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
    this.assertUnlocked(input.employeeId, owner);
    this.locked.add(input.employeeId);
    this.intents.add(input.id);
    try {
      const snapshot = await executor.snapshot(input.employeeId, owner, input.purpose);
      checkOwnerScope();
      if (snapshot.sessionId !== input.sessionId || snapshot.account !== input.fromAccount)
        throw new PlanMoveError('The employee or account changed; refresh before moving');
      if (input.purpose === 'runtime-refresh') {
        if (input.fromAccount !== input.toAccount || input.forceBusy || !input.handoff.trim() ||
            !['codex', 'claude'].includes(snapshot.mode ?? '') ||
            (input.model !== undefined && input.model !== snapshot.model) ||
            (input.targetMode !== undefined && input.targetMode !== snapshot.mode) ||
            !input.runtimeDigest || !/^[a-f0-9]{64}$/.test(input.runtimeDigest) || snapshot.runtimeDigest !== input.runtimeDigest)
          throw new PlanMoveError('A runtime refresh requires the unchanged current plan, runtime and a safe handoff');
      } else if (input.fromAccount === input.toAccount) throw new PlanMoveError('The employee is already on that plan');
      if (this.records.size >= 100) {
        const oldest = [...this.records.values()].find((record) => ['completed', 'failed'].includes(record.phase) &&
          !this.intents.has(record.id) && !this.aborts.has(record.id));
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
        ...(input.resourceOwnerScope === undefined ? {} : {resourceOwnerScope: input.resourceOwnerScope}),
      };
      this.records.set(record.id, record);
      await this.save();
      checkOwnerScope();
      void this.run(record, input, executor);
      return { ...record };
    } catch (error) {
      const uncertain = this.records.get(input.id);
      if (input.resourceIntent && uncertain) {
        // save() can lose its acknowledgement after durable rename/fsync. Keep
        // both the in-memory fence and any persisted intent for reconciliation.
        uncertain.phase = 'recovery-required';
        uncertain.error = 'Resource intent journal outcome requires inspection';
        try { await this.save(); } catch { /* retain the lock even if storage stays unavailable */ }
      } else {
        this.records.delete(input.id);
        this.locked.delete(input.employeeId);
      }
      throw error;
    } finally {
      this.intents.delete(input.id);
    }
  }

  async cancel(id: string, owner?: string): Promise<void> {
    const record = await this.get(id, owner);
    if (!record) throw new PlanMoveError('Unknown move', 404);
    if (record.phase !== 'waiting' || !this.aborts.has(id))
      throw new PlanMoveError('Only a move still waiting for idle can be cancelled');
    this.aborts.get(id)!.abort(new PlanMoveError('Move cancelled by the owner'));
  }

  /** Recognize a historical settlement through the fixed live host producer.
   * Metadata only: no executor, old handle, launch, stop, handoff or credit.
   * Every new website process still starts these records in recovery.
   */
  async reconcileResourceCompletion(id: string, proof: ResourceHistoricalSettlement,
    owner?: string): Promise<PlanMoveRecord> {
    await this.init();
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new PlanMoveError('Unknown move', 404);
    if (!(proof instanceof ResourceHistoricalSettlement) || !record.resourceIntent ||
      record.phase !== 'recovery-required' || this.intents.has(id) || this.aborts.has(id) ||
      [...this.records.values()].some(row => row.id !== id && row.employeeId === record.employeeId &&
        !['completed','failed'].includes(row.phase)))
      throw new PlanMoveError('Resource completion requires unambiguous fresh native inspection', 503);
    proof.assertRecord(record); this.intents.add(id);
    const before = {...record};
    try {
      record.phase = 'completed'; delete record.error;
      await this.save();
      await proof.recheck({...record});
      proof.assertRecord(record);
      this.locked.delete(record.employeeId);
      return {...record};
    } catch (error) {
      Object.assign(record, before, {phase: 'recovery-required', error: 'Historical resource settlement remains unconfirmed'});
      this.locked.add(record.employeeId);
      try {await this.save();} catch { /* Keep in-memory fence; restart also requalifies. */ }
      throw error;
    } finally {this.intents.delete(id);}
  }

  /** Resolve a stopped-source move by adopting its existing verified destination. Never launches or replays a handoff. */
  async resolve(id: string, expected: { oldSession: string; newSession: string; toAccount: string }, owner?: string,
    executor: PlanMoveExecutor = this.port): Promise<PlanMoveRecord> {
    await this.init();
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new PlanMoveError('Unknown move', 404);
    if (record.resourceIntent) throw new PlanMoveError('Resource transactions require their own verified recovery actor');
    if (record.oldSession !== expected.oldSession || record.newSession !== expected.newSession || record.toAccount !== expected.toAccount)
      throw new PlanMoveError('The recovery target changed; refresh its status');
    if (this.intents.has(id) || this.aborts.has(id)) throw new PlanMoveError('The move is still active; wait before recovery');
    if (record.phase === 'completed' && record.recoveryAction === 'adopt-existing') return { ...record };
    if (record.phase !== 'recovery-required' || !record.sourceStopRequested || record.sourceCleanupVerified !== true)
      throw new PlanMoveError('Recovery requires durable source-cleanup proof; inspect both sessions without clearing the journal');
    if ([...this.records.values()].filter(row => row.employeeId === record.employeeId && !['completed', 'failed'].includes(row.phase)).length !== 1)
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
      record.phase = 'completed'; record.recoveryAction = 'adopt-existing'; record.recoveredAt = Date.now();
      try {
        await this.save();
        current();
        await this.port.recoveryConfirmed({ ...record });
      } catch (error) {
        Object.assign(record, before, { phase: 'recovery-required' });
        if (before.recoveryAction === undefined) delete record.recoveryAction;
        if (before.recoveredAt === undefined) delete record.recoveredAt;
        try { await this.save(); } catch { /* Keep the in-memory hold; durable outcome requires inspection. */ }
        throw error;
      }
      if (![...this.records.values()].some(row => row.employeeId === record.employeeId && !['completed', 'failed'].includes(row.phase)))
        this.locked.delete(record.employeeId);
      return { ...record };
    } finally { this.intents.delete(id); }
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
        if (executor.binding(record.employeeId, record.owner) !== record.newSession || !executor.exists(record.oldSession))
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
      if (executor.binding(record.employeeId, record.owner) !== record.newSession || !executor.exists(record.oldSession))
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
        if (executor.binding(record.employeeId, record.owner) !== record.newSession || !executor.exists(record.newSession!))
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
        await executor.completeResources(Object.freeze({...record}));
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : 'Move failed';
      let recovered = !record.newSession && executor.binding(record.employeeId, record.owner) === record.oldSession;
      if (
        !record.resourceIntent && !stopping &&
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
      if (stopping && record.newSession) {
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
      if (['completed', 'failed'].includes(record.phase)) this.locked.delete(record.employeeId);
    }
  }
}
