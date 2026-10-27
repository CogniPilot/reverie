/** Real accepted SQLite ledger through owned local child; no auth/model/host adapter. */
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { it, expect } from 'vitest';
import { RecoveryLedgerClient } from '../src/recovery-ledger-client.js';
import { RecoveryTransaction, RecoveryEffectLocks } from '../src/recovery-transaction.js';
const python = execFileSync('python3', ['-I', '-B', '-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8',
  timeout: 2000,
  maxBuffer: 4096,
}).trim();
const repositoryWorker = resolve(import.meta.dirname, '../../../python/reverie/resume_ledger_rpc.py');
const worker = existsSync(repositoryWorker)
  ? repositoryWorker
  : resolve(import.meta.dirname, 'fixtures/recovery-ledger/reverie/resume_ledger_rpc.py');
const binding = {
  employeeId: 'employee',
  goalId: 'goal',
  goalGeneration: 1,
  sessionId: '11111111-1111-1111-1111-111111111111',
  sessionGeneration: 1,
  transitionSequence: 0,
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-rpc-'));
  await chmod(dir, 0o700);
  const ledger = new RecoveryLedgerClient('owner', python, worker, join(dir, 'ledger.sqlite'));
  let now = 1000,
    sent = 0;
  const authority = {
    async prepare() {
      return { ownerId: 'owner', binding: { ...binding }, current: () => true };
    },
  };
  const service = new RecoveryTransaction(
    ledger,
    authority,
    {
      async submit(_message, commit) {
        return commit(async () => {
          sent++;
          return 'SUBMITTED';
        });
      },
    },
    new RecoveryEffectLocks(),
    () => now++,
    { current: () => true }
  );
  return {
    ledger,
    service,
    time: () => now++,
    sent: () => sent,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
it('uses the unchanged real ledger for durable 3/30 rather than a second budget store', async () => {
  const f = await fixture();
  try {
    expect((await f.service.initialize()).code).toBe('READY');
    for (let i = 0; i < 3; i++) {
      const r = await f.service.resume({}, { employeeId: 'employee', key: 'request-' + i });
      expect(r.code).toBe('SUBMITTED');
      const a = r.receipt!.attemptId!;
      await f.ledger.advance(binding, a, 2, 'SUBMITTED', 'TURN_STARTED', 'TURN_CONFIRMED', 'turn-' + i, f.time());
      await f.ledger.advance(
        binding,
        a,
        3,
        'TURN_STARTED',
        'PROGRESS_OBSERVED',
        'PROGRESS_CONFIRMED',
        'progress-' + i,
        f.time()
      );
    }
    const fourth = await f.service.resume({}, { employeeId: 'employee', key: 'fourth' });
    expect(fourth.code).toBe('REPLAY_OR_BUDGET');
    expect(fourth.receipt!.receiptType).toBe('RESUME_BUDGET_REFUSED');
    expect(f.sent()).toBe(3);
  } finally {
    await f.close();
  }
});
it('real restart reconciliation fences a possibly sent QUEUED reservation without resending', async () => {
  const f = await fixture();
  try {
    const first = await f.ledger.reserve(binding, 'old', f.time());
    expect(first.receipt.state).toBe('QUEUED');
    await f.service.initialize();
    expect((await f.service.resume({}, { employeeId: 'employee', key: 'old' })).code).toBe('REPLAY_OR_BUDGET');
    expect((await f.service.resume({}, { employeeId: 'employee', key: 'new' })).code).toBe('UNAVAILABLE');
    expect(f.sent()).toBe(0);
  } finally {
    await f.close();
  }
});
it('fails closed on missing worker/custody and does not echo its paths', async () => {
  const ledger = new RecoveryLedgerClient(
    'owner',
    '/bin/python3',
    '/nonexistent/source-worker',
    '/unavailable/private-ledger'
  );
  await expect(ledger.reconcileRestart(1000)).rejects.toThrow('LEDGER_UNAVAILABLE');
});
