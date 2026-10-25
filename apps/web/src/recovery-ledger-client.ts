/** Fixed local child transport; constructor paths are trusted installed configuration only. */
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { FixedResumeBinding } from './fixed-resume-message.js';
import type { RecoveryLedger, RecoveryReceipt } from './recovery-transaction.js';

function binding(value: FixedResumeBinding) {
  return {
    employee_id: value.employeeId,
    goal_id: value.goalId,
    goal_generation: value.goalGeneration,
    session_id: value.sessionId,
    session_generation: value.sessionGeneration,
    transition_sequence: value.transitionSequence,
  };
}
export class RecoveryLedgerClient implements RecoveryLedger {
  constructor(
    readonly ownerId: string,
    private readonly python: string,
    private readonly worker: string,
    private readonly file: string
  ) {
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(ownerId) || /[\r\n]/.test(ownerId))
      throw new Error('LEDGER_UNAVAILABLE');
    if (
      ![python, worker, file].every(
        (path) => typeof path === 'string' && isAbsolute(path) && path.length <= 4096 && !/[\0\r\n]/.test(path)
      )
    )
      throw new Error('LEDGER_UNAVAILABLE');
  }
  private async call(command: Record<string, unknown>): Promise<unknown> {
    const input = JSON.stringify(command);
    if (Buffer.byteLength(input) > 8192) throw new Error('LEDGER_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.python,
        ['-I', '-B', this.worker, this.file],
        {
          env: { LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
          timeout: 4000,
          killSignal: 'SIGKILL',
          maxBuffer: 262144,
          windowsHide: true,
        },
        (error, stdout) => {
          try {
            if (error) throw error;
            const value: unknown = JSON.parse(stdout);
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.keys(value).sort().join(',') !== 'ok,result' ||
              (value as { ok: unknown }).ok !== true
            )
              throw new Error();
            resolve((value as { result: unknown }).result);
          } catch {
            reject(new Error('LEDGER_UNAVAILABLE'));
          }
        }
      );
      child.stdin?.on('error', () => {}); // process error callback owns the fixed refusal
      child.stdin?.end(input);
    });
  }
  async reconcileRestart(now: number): Promise<unknown> {
    return this.call({ op: 'restart', now });
  }
  private receipt(value: unknown): { replayed: boolean; receipt: RecoveryReceipt } {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'receipt,replayed'
    )
      throw new Error('LEDGER_UNAVAILABLE');
    const item = value as { replayed: unknown; receipt: RecoveryReceipt };
    if (
      typeof item.replayed !== 'boolean' ||
      !item.receipt ||
      item.receipt.automaticAction !== 'NONE' ||
      !['RESUME_ATTEMPT', 'RESUME_BUDGET_REFUSED'].includes(item.receipt.receiptType)
    )
      throw new Error('LEDGER_UNAVAILABLE');
    return { replayed: item.replayed, receipt: Object.freeze(item.receipt) };
  }
  async reserve(value: FixedResumeBinding, key: string, now: number) {
    return this.receipt(await this.call({ op: 'reserve', binding: binding(value), key, now }));
  }
  async advance(
    value: FixedResumeBinding,
    attempt: string,
    sequence: number,
    expected: string,
    state: string,
    reason: string,
    key: string,
    now: number
  ) {
    return this.receipt(
      await this.call({ op: 'advance', binding: binding(value), attempt, sequence, expected, state, reason, key, now })
    );
  }
}
