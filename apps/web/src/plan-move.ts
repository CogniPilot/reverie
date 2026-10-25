import { createHash } from 'node:crypto';

export type PlanMovePhase =
  | 'waiting'
  | 'creating'
  | 'starting'
  | 'checking'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'recovery-required';

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
}

export interface PlanMoveSnapshot {
  sessionId: string;
  name: string;
  account: string;
  working: boolean;
  mode?: string;
  model?: string;
}

export interface PlanMovePort {
  load(): Promise<PlanMoveRecord[]>;
  save(records: PlanMoveRecord[]): Promise<void>;
  snapshot(employeeId: string, owner?: string): Promise<PlanMoveSnapshot>;
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
}

export type PlanMoveExecutor = Omit<PlanMovePort, 'load' | 'save'>;

export class PlanMoveError extends Error {
  constructor(
    message: string,
    readonly status = 409
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
      for (const record of await this.port.load()) {
        if (!['completed', 'failed'].includes(record.phase)) {
          record.phase = 'recovery-required';
          record.error = 'The server restarted during this move; inspect both sessions before retrying';
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

  async get(id: string, owner?: string): Promise<PlanMoveRecord | undefined> {
    await this.init();
    const record = this.records.get(id);
    return record && record.owner === owner ? { ...record } : undefined;
  }

  async list(owner?: string): Promise<PlanMoveRecord[]> {
    await this.init();
    return [...this.records.values()]
      .filter((record) => record.owner === owner)
      .map((record) => ({ ...record }))
      .reverse();
  }

  async begin(input: PlanMoveInput, owner?: string, executor: PlanMoveExecutor = this.port): Promise<PlanMoveRecord> {
    await this.init();
    const requestDigest = createHash('sha256')
      .update(JSON.stringify([input.forceBusy, input.handoff, input.model ?? '', input.targetMode ?? '']))
      .digest('hex');
    const existing = this.records.get(input.id);
    if (existing) {
      if (
        existing.owner !== owner ||
        existing.employeeId !== input.employeeId ||
        existing.oldSession !== input.sessionId ||
        existing.toAccount !== input.toAccount ||
        existing.fromAccount !== input.fromAccount ||
        existing.requestDigest !== requestDigest
      )
        throw new PlanMoveError('That move identifier belongs to another request');
      return { ...existing };
    }
    if (this.intents.has(input.id)) throw new PlanMoveError('That move identifier is already being prepared');
    if (this.locked.has(input.employeeId))
      throw new PlanMoveError('This employee already has a move in progress or requiring recovery');
    this.locked.add(input.employeeId);
    this.intents.add(input.id);
    try {
      const snapshot = await executor.snapshot(input.employeeId, owner);
      if (snapshot.sessionId !== input.sessionId || snapshot.account !== input.fromAccount)
        throw new PlanMoveError('The employee or account changed; refresh before moving');
      if (input.fromAccount === input.toAccount) throw new PlanMoveError('The employee is already on that plan');
      if (this.records.size >= 100) {
        const oldest = [...this.records.values()].find((record) => ['completed', 'failed'].includes(record.phase));
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
      };
      this.records.set(record.id, record);
      await this.save();
      void this.run(record, input, executor);
      return { ...record };
    } catch (error) {
      this.records.delete(input.id);
      this.locked.delete(input.employeeId);
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
      const snapshot = await executor.snapshot(record.employeeId, record.owner);
      abort.signal.throwIfAborted();
      if (
        snapshot.sessionId !== record.oldSession ||
        snapshot.account !== record.fromAccount ||
        (snapshot.working && !input.forceBusy)
      )
        throw new PlanMoveError('The employee changed or became busy before launch; nothing was moved');
      await this.phase(record, 'creating');
      record.newSession = await executor.create(input, record.owner);
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
      await this.phase(record, 'starting');
      await executor.start(record.newSession);
      await this.phase(record, 'checking');
      await executor.ready(record.newSession);
      if (
        executor.binding(record.employeeId, record.owner) !== record.newSession ||
        !executor.exists(record.newSession)
      )
        throw new PlanMoveError('The employee binding or replacement changed before commit');
      await this.phase(record, 'completed');
      await executor.audit({ ...record });
    } catch (error) {
      record.error = error instanceof Error ? error.message : 'Move failed';
      let recovered = !record.newSession && executor.binding(record.employeeId, record.owner) === record.oldSession;
      if (
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
      record.phase = recovered && !stopping ? 'failed' : 'recovery-required';
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
