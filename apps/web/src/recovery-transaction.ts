/** Closed outer resume transaction. No registered route, principal mint, scheduler or live adapter. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildFixedResumeMessage, type FixedResumeBinding, type FixedResumeMessage } from './fixed-resume-message.js';

export interface RecoveryReceipt {
  readonly receiptType: 'RESUME_ATTEMPT' | 'RESUME_BUDGET_REFUSED';
  readonly attemptId?: string;
  readonly sequence?: number;
  readonly state?: string;
  readonly automaticAction: 'NONE';
}
export interface RecoveryLedger {
  readonly ownerId: string;
  /** The exact accepted ledger owns custody, restart uncertainty and immutable 3/30 limits. */
  reconcileRestart(now: number): Promise<unknown>;
  reserve(
    binding: FixedResumeBinding,
    key: string,
    now: number
  ): Promise<{ replayed: boolean; receipt: RecoveryReceipt }>;
  advance(
    binding: FixedResumeBinding,
    attempt: string,
    sequence: number,
    expected: string,
    next: string,
    reason: string,
    key: string,
    now: number
  ): Promise<{ replayed: boolean; receipt: RecoveryReceipt }>;
}
/** Created only by the same-store authenticated canonical/FROZEN adapter, never request JSON.
 * current() must synchronously revalidate owner+grant epoch, exact canonical tuple,
 * active goal/state, real attested FROZEN proof, dialog/input/jobs and off/sleep/vacation.
 * Missing evidence, stale proof or revocation returns false. No content/prompt is exposed.
 */
export interface RecoveryPermit {
  readonly ownerId: string;
  readonly binding: FixedResumeBinding;
  readonly current: () => boolean;
}
export interface RecoveryAuthority {
  prepare(context: unknown, employeeId: string): Promise<RecoveryPermit | null>;
}

/** One shared lock domain for recovery and subsequent launch/compute writers.
 * This in-process lock does NOT replace an exclusive authenticated service lease
 * or cross-process effect fencing; bootstrap must supply those in permit.current.
 */
export class RecoveryEffectLocks {
  private readonly held = new Set<string>();
  acquire(owner: string, binding: FixedResumeBinding): { current(): boolean; release(): void } | null {
    const keys = [
      ['employee', binding.employeeId],
      ['goal', binding.goalId],
      ['session', binding.sessionId],
    ].map(([kind, id]) => JSON.stringify([owner, kind, id]));
    if (this.held.size + keys.length > 384 || keys.some((key) => this.held.has(key))) return null;
    keys.forEach((key) => this.held.add(key));
    let live = true;
    return {
      current: () => live,
      release: () => {
        if (live) {
          live = false;
          keys.forEach((key) => this.held.delete(key));
        }
      },
    };
  }
}
/** Owned exclusive service-writer lease from bootstrap, not a configuration boolean. */
export interface RecoveryRuntimeLease {
  current(): boolean;
}
export type RecoverySendResult = 'SUBMITTED' | 'NOT_SENT' | 'UNKNOWN';
export interface RecoverySender {
  /** May await preparation, but may perform an effect ONLY inside commit.
   * commit rechecks current authority synchronously immediately before begin().
   * No pane paste/input/interrupt/wake or caller-selected text is a supported adapter.
   * begin must enter the conditional provider submission synchronously; any provider
   * await before its actual write must enforce the same generation/revocation fence.
   */
  submit(
    message: FixedResumeMessage,
    commit: (begin: (current: () => boolean) => Promise<RecoverySendResult>) => Promise<RecoverySendResult>
  ): Promise<RecoverySendResult>;
}
export type RecoveryResult = Readonly<{ code: string; receipt?: RecoveryReceipt }>;
const MAX_MS = 5000;
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('UNAVAILABLE')), Math.max(1, milliseconds));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const result = (code: string, receipt?: RecoveryReceipt): RecoveryResult =>
  Object.freeze({ code, ...(receipt ? { receipt } : {}) });

function command(input: unknown): { employeeId: string; key: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('employeeId') || !keys.includes('key')) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (!['employeeId', 'key'].every((k) => Object.hasOwn(descriptors[k]!, 'value'))) return null;
  const employeeId: unknown = descriptors.employeeId!.value,
    key: unknown = descriptors.key!.value;
  if (
    typeof employeeId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,100}$/.test(employeeId) ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(key) ||
    /[\r\n]/.test(employeeId + key)
  )
    return null;
  return { employeeId, key };
}

export class RecoveryTransaction {
  private phase: 'NEW' | 'STARTING' | 'READY' | 'UNAVAILABLE' = 'NEW';
  private busy = 0;
  private uncertain = false;
  private clockFailed = false;
  private wallFloor = -1;
  private monotonicFloor = -1;
  constructor(
    private readonly ledger?: RecoveryLedger,
    private readonly authority?: RecoveryAuthority,
    private readonly sender?: RecoverySender,
    private readonly locks?: RecoveryEffectLocks,
    private readonly clock: () => number = Date.now,
    private readonly runtime?: RecoveryRuntimeLease,
    private readonly monotonic: () => number = () => performance.now()
  ) {}

  private runtimeCurrent(): boolean {
    try {
      return this.runtime?.current() === true;
    } catch {
      return false;
    }
  }

  private now(): number {
    const value = this.clock();
    if (this.clockFailed || !Number.isSafeInteger(value) || value < 0 || value < this.wallFloor) {
      this.clockFailed = true;
      throw new Error('CLOCK_UNAVAILABLE');
    }
    this.wallFloor = value;
    return value;
  }

  private monotonicNow(): number {
    const value = this.monotonic();
    if (this.clockFailed || !Number.isFinite(value) || value < 0 || value < this.monotonicFloor) {
      this.clockFailed = true;
      throw new Error('CLOCK_UNAVAILABLE');
    }
    this.monotonicFloor = value;
    return value;
  }

  /** Startup only, under an externally established exclusive service lease.
   * Never run restart reconciliation concurrently with an existing effect writer.
   */
  async initialize(): Promise<RecoveryResult> {
    if (this.phase !== 'NEW') return result('UNAVAILABLE');
    this.phase = 'STARTING';
    if (!this.ledger || !this.authority || !this.sender || !this.locks || !this.runtimeCurrent()) {
      this.phase = 'UNAVAILABLE';
      return result('UNAVAILABLE');
    }
    try {
      await bounded(this.ledger.reconcileRestart(this.now()), MAX_MS);
      if (!this.runtimeCurrent()) throw new Error('UNAVAILABLE');
      this.phase = 'READY';
      return result('READY');
    } catch {
      this.phase = 'UNAVAILABLE';
      return result('UNAVAILABLE');
    }
  }

  async resume(context: unknown, input: unknown): Promise<RecoveryResult> {
    let request;
    try {
      request = command(input);
    } catch {
      return result('INPUT_INVALID');
    }
    if (!request) return result('INPUT_INVALID');
    if (
      this.phase !== 'READY' ||
      this.uncertain ||
      this.clockFailed ||
      !this.runtimeCurrent() ||
      !this.ledger ||
      !this.authority ||
      !this.sender ||
      !this.locks
    )
      return result('UNAVAILABLE');
    if (this.busy >= 128) return result('BUSY');
    this.busy++;
    let lease: ReturnType<RecoveryEffectLocks['acquire']> = null;
    let queued: RecoveryReceipt | undefined;
    let permit: RecoveryPermit | null = null;
    let message: FixedResumeMessage | undefined;
    let invoked = false,
      commitClosed = false,
      settled = false;
    let actual: RecoverySendResult | undefined;
    let ownerId: string | undefined;
    let startedWall: number, startedMonotonic: number;
    try {
      startedWall = this.now();
      startedMonotonic = this.monotonicNow();
    } catch {
      this.busy--;
      return result('UNAVAILABLE');
    }
    let expired = false;
    // One operation timer: no later phase, stalled wall clock or wait can renew it.
    const expiry = setTimeout(() => {
      expired = true;
    }, MAX_MS);
    const remaining = () => {
      if (expired || this.clockFailed) throw new Error('CLOCK_UNAVAILABLE');
      const elapsed = Math.max(this.now() - startedWall, this.monotonicNow() - startedMonotonic);
      const left = MAX_MS - elapsed;
      if (left <= 0) {
        expired = true;
        throw new Error('EXPIRED');
      }
      return Math.min(MAX_MS, left);
    };
    const wait = <T>(work: Promise<T>) => bounded(work, remaining());
    const current = () => {
      try {
        return (
          !!permit &&
          !!message &&
          permit.ownerId === ownerId &&
          Object.keys(message.binding).every(
            (key) =>
              permit!.binding[key as keyof FixedResumeBinding] === message!.binding[key as keyof FixedResumeBinding]
          ) &&
          remaining() > 0 &&
          this.runtimeCurrent() &&
          !!lease?.current() &&
          !this.uncertain &&
          permit.current() === true &&
          remaining() > 0
        );
      } catch {
        return false;
      }
    };
    const advance = async (state: string, reason: string) => {
      const receipt = (
        await bounded(
          this.ledger!.advance(
            message!.binding,
            queued!.attemptId!,
            queued!.sequence!,
            'QUEUED',
            state,
            reason,
            randomUUID().replaceAll('-', ''),
            this.now()
          ),
          MAX_MS
        )
      ).receipt;
      return receipt;
    };
    try {
      permit = await wait(this.authority.prepare(context, request.employeeId));
      if (
        !permit ||
        typeof permit.ownerId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,100}$/.test(permit.ownerId) ||
        /[\r\n]/.test(permit.ownerId)
      )
        return result('REFUSED');
      if (permit.ownerId !== this.ledger.ownerId) return result('REFUSED');
      ownerId = permit.ownerId;
      message = buildFixedResumeMessage(permit.binding); // Only server-owned fixed text.
      if (message.binding.employeeId !== request.employeeId) return result('REFUSED');
      lease = this.locks.acquire(permit.ownerId, message.binding);
      if (!lease) return result('BUSY');
      if (!current()) return result('REFUSED');
      const reserved = await wait(this.ledger.reserve(message.binding, request.key, this.now()));
      // Replays and budget reports are evidence, NEVER permission to send.
      if (reserved.replayed || reserved.receipt.receiptType !== 'RESUME_ATTEMPT')
        return result('REPLAY_OR_BUDGET', reserved.receipt);
      queued = reserved.receipt;
      if (queued.state !== 'QUEUED' || !queued.attemptId || queued.sequence !== 1) {
        this.uncertain = true;
        return result('UNAVAILABLE');
      }
      if (!current()) return result('REFUSED', await advance('REFUSED', 'POLICY_REFUSED'));
      const send = await wait(
        this.sender.submit(message, async (begin) => {
          if (commitClosed || invoked || !current()) return 'NOT_SENT';
          invoked = true; // Before begin: throwing/lost acknowledgement is uncertain.
          try {
            actual = await begin(() => !commitClosed && current());
          } catch {
            actual = 'UNKNOWN';
          }
          settled = true;
          return actual;
        })
      );
      commitClosed = true; // Late callbacks can never submit after this operation ends.
      if (!invoked) return result('REFUSED', await advance('REFUSED', 'POLICY_REFUSED'));
      // A stale/revoked binding after provider await cannot be reported as a current success.
      if (!current() || !settled || send !== actual || !['SUBMITTED', 'NOT_SENT'].includes(send))
        return result('UNCERTAIN', await advance('UNCERTAIN', 'SEND_UNCERTAIN'));
      return send === 'SUBMITTED'
        ? result('SUBMITTED', await advance('SUBMITTED', 'SUBMISSION_CONFIRMED'))
        : result('NOT_SENT', await advance('FAILED', 'SUBMISSION_FAILED'));
    } catch {
      if (queued && message) {
        try {
          return result(
            invoked ? 'UNCERTAIN' : 'REFUSED',
            await advance(invoked ? 'UNCERTAIN' : 'REFUSED', invoked ? 'SEND_UNCERTAIN' : 'POLICY_REFUSED')
          );
        } catch {
          /* Durable QUEUED remains unresolved; startup reconciliation never resends it. */
        }
      }
      // A commit may have succeeded despite an exception; never assume no durable reservation.
      this.uncertain = true;
      return result('UNAVAILABLE');
    } finally {
      clearTimeout(expiry);
      commitClosed = true;
      lease?.release();
      this.busy--;
    }
  }
}
