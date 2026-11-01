/** Own journal recovery grants no launch, stop, cancellation or account-edit authority. */
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { FastifyRequest } from 'fastify';
import { isMultiUserMode } from './config/multiuser.js';
import { PlanMoveError, PlanMoveComposerNotReady, type PlanMoveExecutor, type PlanMoveRecord, type PlanMoves } from './plan-move.js';
import { planMoveExecutor, type PlanMoveRuntime } from './plan-move-runtime.js';
import { ownerFor, resolveParentSessionId } from './web/route-helpers.js';

export interface OwnPlanRecovery {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly owner?: string;
  assertCurrent(): void;
  readonly executor: PlanMoveExecutor;
}
export function ownPlanRecovery(request: FastifyRequest,
  runtime: Omit<PlanMoveRuntime, 'authorized' | 'request'>): OwnPlanRecovery | undefined {
  if (isMultiUserMode()) return undefined;
  const owner = ownerFor(request);
  const id = resolveParentSessionId({ sessions: runtime.sessions }, request, undefined, owner);
  if (!id || request.headers['x-reverie-parent-session'] !== id) return undefined;
  const session = runtime.sessions.get(id);
  const employee = runtime.company.view(owner).employees.find(row => row.sessionId === id);
  if (!session || session.owner !== owner || !employee || employee.owner !== owner) return undefined;
  const eid = employee.id, generation = employee.sessionGeneration;
  if (!Number.isSafeInteger(generation) || generation < 1) return undefined;
  const authorized = () => {
    const current = runtime.company.view(owner).employees.find(row => row.id === eid);
    return runtime.sessions.get(id) === session && session.owner === owner && !!current &&
      current.owner === owner && current.sessionId === id && current.sessionGeneration === generation &&
      !current.onVacation && current.desiredRunning !== false && !current.bindingMigration &&
      (current.permissions.moveOwnPlan || current.permissions.managePlans);
  };
  if (!authorized()) return undefined;
  const assertCurrent = () => {
    if (!authorized()) throw new PlanMoveError('The current employee binding or plan permission changed', 403);
  };
  const executor = planMoveExecutor({ ...runtime, authorized, actor: id,
    request: async () => { throw new PlanMoveError('Recovery cannot launch or replay a move', 403); },
  }, owner);
  const verify = executor.verifyRecovery!;
  executor.verifyRecovery = async record => {
    assertCurrent();
    if (record.owner !== owner || record.employeeId !== eid || record.newSession !== id || record.resourceIntent)
      throw new PlanMoveError('Recovery is outside your exact current move', 403);
    return verify(record);
  };
  return { employeeId: eid, sessionId: id, owner, assertCurrent, executor };
}

/** Abort only read-only waits. Never race a journal mutation or its durable ACK. */
async function readBeforeAbort<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  let aborted!: () => void;
  const stop = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
  try { return await Promise.race([read, stop]); }
  finally { signal.removeEventListener('abort', aborted); }
}

export interface OwnRecoveryStatus {
  state: 'waiting-for-idle' | 'verifying' | 'completed' | 'refused';
  error?: string;
}
/** One explicitly requested flight per move; no persisted/restarted automatic work.
 * A self tool call must return before its caller can become idle at the composer.
 */
export class OwnPlanRecoveries {
  private readonly jobs = new Map<string, { tuple: string; employeeId: string; status: OwnRecoveryStatus;
    abort: AbortController; done: Promise<void> }>();
  private closed = false;
  constructor(private readonly moves: Pick<PlanMoves, 'resolve'>) {}
  status(id: string, employeeId: string): OwnRecoveryStatus | undefined {
    const job = this.jobs.get(id);
    return job?.employeeId === employeeId ? { ...job.status } : undefined;
  }
  enqueue(record: PlanMoveRecord, expected: { oldSession: string; newSession: string; toAccount: string }, actor: OwnPlanRecovery): OwnRecoveryStatus {
    actor.assertCurrent();
    if (this.closed) throw new PlanMoveError('Recovery service is closing', 503);
    if (record.employeeId !== actor.employeeId || record.owner !== actor.owner || record.newSession !== actor.sessionId ||
      record.oldSession !== expected.oldSession || record.newSession !== expected.newSession || record.toAccount !== expected.toAccount)
      throw new PlanMoveError('The recovery target changed; refresh its status');
    const target = Object.freeze({ ...expected }), moveId = record.id;
    const tuple = JSON.stringify([target.oldSession, target.newSession, target.toAccount]);
    const previous = this.jobs.get(record.id);
    if (previous && previous.employeeId === actor.employeeId && previous.tuple === tuple &&
      ['waiting-for-idle', 'verifying'].includes(previous.status.state)) return { ...previous.status };
    if (previous && previous.tuple !== tuple) throw new PlanMoveError('Another recovery tuple already names this move');
    if (record.resourceIntent || record.phase !== 'recovery-required' || record.sourceStopRequested !== true || record.sourceCleanupVerified !== true)
      throw new PlanMoveError('Recovery requires durable source-cleanup proof and an existing destination; retain the journal hold');
    for (const [id, job] of this.jobs) if (['completed', 'refused'].includes(job.status.state)) this.jobs.delete(id);
    if (this.jobs.size >= 100) throw new PlanMoveError('Recovery waiters are full', 503);
    const recoveryRecord = Object.freeze({ ...record });
    const abort = new AbortController();
    const deadlineAt = performance.now() + 5 * 60_000;
    // One deadline includes the initial cached-idle wait AND native readiness.
    // It never resets for another probe, duplicate enqueue, or core verification.
    const expire = () => abort.abort(new PlanMoveError(
      'Verified composer readiness timed out after five minutes; the existing move remains held'
    ));
    const deadline = setTimeout(expire, 5 * 60_000);
    deadline.unref();
    const job = { tuple, employeeId: actor.employeeId, status: { state: 'waiting-for-idle' } as OwnRecoveryStatus,
      abort, done: Promise.resolve() };
    this.jobs.set(record.id, job);
    const assertWaiting = () => {
      // A synchronous native observation can delay timer delivery. The monotonic
      // fence still prevents entering a mutation after the original deadline.
      if (performance.now() >= deadlineAt && !abort.signal.aborted) expire();
      abort.signal.throwIfAborted(); actor.assertCurrent();
    };
    const executor = { ...actor.executor, verifyRecovery: async (row: Readonly<PlanMoveRecord>) => {
      assertWaiting();
      const fence = await readBeforeAbort(actor.executor.verifyRecovery!(row), abort.signal);
      assertWaiting();
      return () => { assertWaiting(); fence(); };
    } };
    job.done = (async () => {
      try {
        // isWorking can be false during an SDK/tool turn. Wait read-only for
        // the actual verified composer, while retaining the one overall deadline.
        await readBeforeAbort(actor.executor.idle(actor.sessionId, abort.signal), abort.signal);
        while (true) {
          assertWaiting();
          try {
            const ready = await executor.verifyRecovery(recoveryRecord);
            assertWaiting(); ready();
            break;
          } catch (error) {
            assertWaiting();
            if (!(error instanceof PlanMoveComposerNotReady)) throw error;
          }
          await delay(500, undefined, { signal: abort.signal });
        }
        assertWaiting();
        job.status = { state: 'verifying' };
        // Exactly one mutation attempt. A later refusal/uncertain ACK is never
        // fed back into the readiness loop, even if it has the readiness type.
        await this.moves.resolve(moveId, target, actor.owner, executor);
        // Successful durable ACK is the commitpoint; no post-ACK rollback.
        job.status = { state: 'completed' };
      } catch (error) {
        job.status = { state: 'refused', error: error instanceof PlanMoveError ? error.message : 'Recovery was not confirmed; inspect the existing move before any further action' };
      } finally { clearTimeout(deadline); }
    })();
    return { state: 'waiting-for-idle' };
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.abort.abort();
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}
