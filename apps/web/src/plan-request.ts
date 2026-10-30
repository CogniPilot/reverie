import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PlanMoveError, type PlanMoveExecutor, type PlanMoves, type PlanMoveSnapshot } from './plan-move.js';
import { PlanRequestId } from './plan-request-capability.js';

export const PlanRequestSchema = z
  .object({
    id: PlanRequestId,
    owner: z.string().optional(),
    requestedBy: PlanRequestId.optional(),
    employeeId: PlanRequestId,
    sessionId: PlanRequestId,
    name: z.string().max(100),
    fromAccount: PlanRequestId,
    toAccount: PlanRequestId,
    mode: z.string(),
    targetMode: z.enum(['codex', 'claude']).optional(),
    model: z.string().optional(),
    purpose: z.literal('runtime-refresh').optional(),
    runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    phase: z.enum([
      'pending',
      'reauthorize-required',
      'executing',
      'completed',
      'failed',
      'recovery-required',
      'rejected',
      'cancelled',
      'expired',
    ]),
    createdAt: z.number().finite(),
    expiresAt: z.number().finite(),
    notified: z.boolean(),
    nonceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    error: z.string().max(4000).optional(),
    newSession: PlanRequestId.optional(),
    movePhase: z.string().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.purpose === 'runtime-refresh'
      ? record.fromAccount !== record.toAccount || !record.runtimeDigest
      : record.runtimeDigest !== undefined)
      context.addIssue({ code: 'custom', message: 'A refresh request must bind its unchanged account and runtime' });
  });
export type PlanRequestRecord = z.infer<typeof PlanRequestSchema>;
export type PlanRequestView = Omit<PlanRequestRecord, 'nonceHash'>;
export interface PlanRequestExecution {
  executor: PlanMoveExecutor;
  authorized(): boolean;
  requestedBy?: string;
}
export interface PlanRequestPort {
  load(): Promise<PlanRequestRecord[]>;
  save(records: PlanRequestRecord[]): Promise<void>;
  moves: Pick<PlanMoves, 'begin' | 'get' | 'cancel'>;
  binding(employeeId: string, owner?: string): string | undefined;
  validateTarget(snapshot: PlanMoveSnapshot, target: string, owner?: string): Promise<{ mode: 'codex' | 'claude' } | void>;
  capability: {
    write(value: { requestId: string; sessionId: string; nonce: string }): Promise<string>;
    remove(sessionId: string, id: string): Promise<void>;
  };
  notify(record: PlanRequestView, file: string, allowed: () => boolean): Promise<void>;
  audit(entry: Record<string, unknown>): Promise<void>;
  now?(): number;
}
const active = (phase: PlanRequestRecord['phase']) =>
  ['pending', 'reauthorize-required', 'executing', 'recovery-required'].includes(phase);
const hash = (nonce: string) => createHash('sha256').update(nonce).digest('hex');
const view = (record: PlanRequestRecord): PlanRequestView => {
  const { nonceHash: _nonceHash, ...safe } = record;
  return { ...safe };
};

/** Owner intent is durable; only the exact current expert holding its private one-time credential may execute it. */
export class PlanMoveRequests {
  private records = new Map<string, PlanRequestRecord>();
  private executions = new Map<string, PlanRequestExecution>();
  private initialized?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly port: PlanRequestPort) {}
  private now() {
    return (this.port.now ?? Date.now)();
  }
  private save() {
    return this.port.save([...this.records.values()].map((record) => ({ ...record })));
  }
  private async init() {
    this.initialized ??= (async () => {
      let changed = false;
      for (const raw of await this.port.load()) {
        const record = PlanRequestSchema.parse(raw);
        if (record.phase === 'pending' || record.phase === 'reauthorize-required') {
          record.phase = 'reauthorize-required';
          delete record.nonceHash;
          record.error =
            'The server restarted. The owner must reauthorize this request before the expert can approve it.';
          changed = true;
          await this.port.capability.remove(record.sessionId, record.id).catch(() => {});
        }
        this.records.set(record.id, record);
      }
      if (changed) await this.save();
    })();
    await this.initialized;
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    await this.init();
    const pending = this.chain.then(work);
    this.chain = pending.catch(() => {});
    return pending;
  }
  private owned(id: string, owner?: string) {
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new PlanMoveError('Unknown plan request', 404);
    return record;
  }
  private async revoke(record: PlanRequestRecord) {
    delete record.nonceHash;
    this.executions.delete(record.id);
    await this.port.capability.remove(record.sessionId, record.id).catch(() => {});
  }
  private async current(record: PlanRequestRecord): Promise<void> {
    if (record.phase === 'pending' || record.phase === 'reauthorize-required') {
      if (this.now() >= record.expiresAt) {
        record.phase = 'expired';
        record.error = 'The request expired. Create a new request when ready.';
        await this.revoke(record);
        await this.save();
      } else if (this.port.binding(record.employeeId, record.owner) !== record.sessionId) {
        record.phase = 'failed';
        record.error = 'The expert’s session changed. Create a new request for the current session.';
        await this.revoke(record);
        await this.save();
      } else if (record.phase === 'pending' && !this.executions.get(record.id)?.authorized()) {
        record.phase = 'reauthorize-required';
        record.error = 'Owner authorization ended. Sign in and reauthorize the request.';
        await this.revoke(record);
        await this.save();
      }
    }
    if (record.phase === 'executing') {
      const move = await this.port.moves.get(record.id, record.owner);
      if (move) {
        const changed =
          record.movePhase !== move.phase || record.newSession !== move.newSession || record.error !== move.error;
        record.movePhase = move.phase;
        record.newSession = move.newSession;
        record.error = move.error;
        if (['completed', 'failed', 'recovery-required'].includes(move.phase))
          record.phase = move.phase as PlanRequestRecord['phase'];
        if (changed) await this.save();
      } else {
        record.phase = 'failed';
        record.error = 'Execution did not start. Inspect the current session before requesting again.';
        await this.save();
      }
    }
  }
  private audit(record: PlanRequestRecord, event: string) {
    return this.port.audit({
      event,
      owner: record.owner,
      actor:
        event === 'plan_request_approved' || event === 'plan_request_rejected'
          ? record.sessionId
          : (record.requestedBy ?? record.owner ?? 'owner'),
      requestId: record.id,
      employeeId: record.employeeId,
      sessionId: record.sessionId,
      fromAccount: record.fromAccount,
      toAccount: record.toAccount,
      phase: record.phase,
      ...(record.purpose ? { purpose: record.purpose } : {}),
    });
  }
  private async issue(record: PlanRequestRecord, execution: PlanRequestExecution): Promise<void> {
    const nonce = randomBytes(32).toString('hex');
    record.nonceHash = hash(nonce);
    record.phase = 'pending';
    record.notified = false;
    delete record.error;
    record.expiresAt = this.now() + 30 * 60_000;
    this.executions.set(record.id, execution);
    await this.save();
    try {
      await this.port.capability.remove(record.sessionId, record.id);
      const file = await this.port.capability.write({ requestId: record.id, sessionId: record.sessionId, nonce });
      await this.audit(record, 'plan_request_created');
      // Delivery waits for the source composer. It never interrupts a working expert or starts a replacement.
      const allowed = () =>
        record.phase === 'pending' &&
        this.executions.get(record.id) === execution &&
        execution.authorized() &&
        this.port.binding(record.employeeId, record.owner) === record.sessionId &&
        this.now() < record.expiresAt;
      void this.port
        .notify(view(record), file, allowed)
        .then(
          () =>
            this.serial(async () => {
              if (allowed()) {
                record.notified = true;
                await this.save();
              }
            }),
          () =>
            this.serial(async () => {
              await this.current(record);
              if (record.phase === 'pending' && this.executions.get(record.id) === execution) {
                record.phase = 'reauthorize-required';
                record.error =
                  'The expert could not be notified safely. Reauthorize this request when idle, or cancel it.';
                await this.revoke(record);
                await this.save();
              }
            })
        )
        .catch(() => {});
    } catch {
      record.phase = 'failed';
      record.error = 'The expert’s private approval request could not be prepared. No session was switched.';
      await this.revoke(record);
      await this.save();
    }
  }
  async create(
    input: { id: string; employeeId: string; sessionId: string; toAccount: string; purpose?: 'runtime-refresh' },
    owner: string | undefined,
    execution: PlanRequestExecution
  ): Promise<PlanRequestView> {
    return this.serial(async () => {
      if (!execution.authorized()) throw new PlanMoveError('Sign in as the owner to request a plan move', 403);
      const existing = this.records.get(input.id);
      if (existing) {
        if (
          existing.owner !== owner ||
          existing.employeeId !== input.employeeId ||
          existing.sessionId !== input.sessionId ||
          existing.toAccount !== input.toAccount
          || existing.purpose !== input.purpose
        )
          throw new PlanMoveError('That request identifier is already in use');
        await this.current(existing);
        return view(existing);
      }
      for (const record of this.records.values())
        if (record.owner === owner && record.employeeId === input.employeeId) {
          await this.current(record);
          if (active(record.phase))
            throw new PlanMoveError('This expert already has a pending move request or execution');
        }
      const snapshot = await execution.executor.snapshot(input.employeeId, owner, input.purpose);
      if (snapshot.sessionId !== input.sessionId || (input.purpose === 'runtime-refresh'
        ? snapshot.account !== input.toAccount || !snapshot.runtimeDigest
        : snapshot.account === input.toAccount))
        throw new PlanMoveError('The expert or plan changed. Refresh before requesting a move.');
      const target = await this.port.validateTarget(snapshot, input.toAccount, owner);
      if (input.purpose === 'runtime-refresh' &&
          (!['codex', 'claude'].includes(snapshot.mode ?? '') || target?.mode !== snapshot.mode))
        throw new PlanMoveError('Runtime refresh requires the unchanged supported harness');
      if (this.records.size >= 100) {
        const old = [...this.records.values()].find((record) => !active(record.phase));
        if (!old) throw new PlanMoveError('Resolve pending requests before creating more');
        this.records.delete(old.id);
      }
      const record: PlanRequestRecord = {
        ...input,
        owner,
        ...(execution.requestedBy ? { requestedBy: execution.requestedBy } : {}),
        name: snapshot.name,
        fromAccount: snapshot.account,
        mode: snapshot.mode || '',
        ...(target ? { targetMode: target.mode } : {}),
        model: snapshot.model,
        ...(input.purpose ? { runtimeDigest: snapshot.runtimeDigest } : {}),
        phase: 'pending',
        createdAt: this.now(),
        expiresAt: this.now() + 30 * 60_000,
        notified: false,
      };
      PlanRequestSchema.parse(record);
      this.records.set(record.id, record);
      await this.issue(record, execution);
      return view(record);
    });
  }
  async list(owner?: string): Promise<PlanRequestView[]> {
    return this.serial(async () => {
      const result: PlanRequestView[] = [];
      for (const record of this.records.values())
        if (record.owner === owner) {
          await this.current(record);
          result.unshift(view(record));
        }
      return result;
    });
  }
  async pendingForSession(sessionId: string, owner?: string): Promise<PlanRequestView[]> {
    return this.serial(async () => {
      const result: PlanRequestView[] = [];
      for (const record of this.records.values()) {
        if (record.owner !== owner || record.sessionId !== sessionId) continue;
        await this.current(record);
        if (['pending', 'reauthorize-required'].includes(record.phase) &&
            this.port.binding(record.employeeId, owner) === sessionId) result.push(view(record));
      }
      return result;
    });
  }
  async get(id: string, owner?: string): Promise<PlanRequestView> {
    return this.serial(async () => {
      const record = this.owned(id, owner);
      await this.current(record);
      return view(record);
    });
  }
  async cancel(id: string, owner?: string): Promise<PlanRequestView> {
    return this.serial(async () => {
      const record = this.owned(id, owner);
      await this.current(record);
      if (record.phase === 'executing') await this.port.moves.cancel(record.id, owner);
      else if (record.phase !== 'pending' && record.phase !== 'reauthorize-required')
        throw new PlanMoveError('Only a pending request or waiting execution can be cancelled');
      record.phase = 'cancelled';
      await this.revoke(record);
      await this.save();
      await this.audit(record, 'plan_request_cancelled');
      return view(record);
    });
  }
  async reauthorize(id: string, owner: string | undefined, execution: PlanRequestExecution): Promise<PlanRequestView> {
    return this.serial(async () => {
      const record = this.owned(id, owner);
      await this.current(record);
      if (!execution.authorized()) throw new PlanMoveError('Owner authorization is required', 403);
      if (!['pending', 'reauthorize-required'].includes(record.phase))
        throw new PlanMoveError('This request is no longer pending');
      const snapshot = await execution.executor.snapshot(record.employeeId, owner, record.purpose);
      if (
        snapshot.sessionId !== record.sessionId ||
        snapshot.account !== record.fromAccount ||
        snapshot.mode !== record.mode ||
        snapshot.model !== record.model ||
        (record.purpose === 'runtime-refresh' && snapshot.runtimeDigest !== record.runtimeDigest)
      )
        throw new PlanMoveError('The expert’s runtime changed. Cancel this request and create a new one.');
      const target = await this.port.validateTarget(snapshot, record.toAccount, owner);
      if (record.targetMode && record.targetMode !== target?.mode)
        throw new PlanMoveError('The destination harness changed. Cancel this request and create a new one.');
      await this.issue(record, execution);
      return view(record);
    });
  }
  async decide(
    id: string,
    sessionId: string,
    nonce: string,
    decision: 'approve' | 'reject',
    handoff = '',
    actorOwner?: string
  ): Promise<PlanRequestView> {
    return this.serial(async () => {
      const record = this.records.get(id);
      if (!record || record.sessionId !== sessionId || record.owner !== actorOwner)
        throw new PlanMoveError('Unknown approval request', 403);
      await this.current(record);
      const expected = record.nonceHash;
      if (
        record.phase !== 'pending' ||
        !expected ||
        !/^[a-f0-9]{64}$/.test(nonce) ||
        !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash(nonce), 'hex'))
      )
        throw new PlanMoveError('Approval is invalid, expired, or already used', 403);
      const execution = this.executions.get(id);
      if (!execution?.authorized())
        throw new PlanMoveError('Owner authorization ended; ask the owner to reauthorize', 403);
      if (this.port.binding(record.employeeId, record.owner) !== sessionId)
        throw new PlanMoveError('Only the expert’s current session may decide this request', 403);
      if (decision === 'reject') {
        record.phase = 'rejected';
        await this.revoke(record);
        await this.save();
        await this.audit(record, 'plan_request_rejected');
        return view(record);
      }
      if (!handoff.trim() || handoff.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(handoff))
        throw new PlanMoveError('Provide a work-safe handoff of 1–12000 characters');
      const snapshot = await execution.executor.snapshot(record.employeeId, record.owner, record.purpose);
      if (
        snapshot.sessionId !== record.sessionId ||
        snapshot.account !== record.fromAccount ||
        snapshot.mode !== record.mode ||
        snapshot.model !== record.model ||
        (record.purpose === 'runtime-refresh' && snapshot.runtimeDigest !== record.runtimeDigest)
      )
        throw new PlanMoveError('The expert’s runtime changed; ask the owner for a new request');
      const target = await this.port.validateTarget(snapshot, record.toAccount, record.owner);
      if (record.targetMode && record.targetMode !== target?.mode)
        throw new PlanMoveError('The destination harness changed; ask the owner for a new request');
      await this.current(record);
      if (record.phase !== 'pending') throw new PlanMoveError('Approval expired or authorization ended', 403);
      record.phase = 'executing';
      await this.revoke(record);
      await this.save();
      try {
        await this.audit(record, 'plan_request_approved');
        const move = await this.port.moves.begin(
          {
            id: record.id,
            employeeId: record.employeeId,
            sessionId: record.sessionId,
            fromAccount: record.fromAccount,
            toAccount: record.toAccount,
            forceBusy: false,
            handoff: handoff.trim().replace(/[\r\n]+/g, ' '),
            ...(record.model ? { model: record.model } : {}),
            ...(record.targetMode ? { targetMode: record.targetMode } : {}),
            ...(record.purpose ? { purpose: record.purpose, runtimeDigest: record.runtimeDigest } : {}),
          },
          record.owner,
          execution.executor
        );
        record.movePhase = move.phase;
        record.newSession = move.newSession;
        await this.save();
      } catch (error) {
        record.phase = 'failed';
        // A refusal's own text (a lock, a changed account, an existing plan) is written for the expert; anything else
        // stays generic for them and goes to the log, so the reason is never lost.
        const reason = error instanceof PlanMoveError ? ` ${error.message.replace(/[.\s]+$/, '')}.` : '';
        record.error = `The approved move could not start.${reason} Inspect the current session before requesting again.`;
        console.warn(`[plans] approved move ${record.id} could not start:`, error instanceof Error ? error.message : error);
        await this.save();
      }
      return view(record);
    });
  }
}
