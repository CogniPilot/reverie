import { describe, it, expect, vi } from 'vitest';
import {
  RecoveryTransaction,
  RecoveryEffectLocks,
  type RecoveryLedger,
  type RecoveryReceipt,
  type RecoveryPermit,
  type RecoverySendResult,
} from '../src/recovery-transaction.js';

const binding = {
  employeeId: 'employee',
  goalId: 'goal',
  goalGeneration: 1,
  sessionId: '11111111-1111-1111-1111-111111111111',
  sessionGeneration: 1,
  transitionSequence: 0,
};
function fixture() {
  const events: string[] = [];
  let valid = true;
  let sent = 0;
  let now = 1000;
  const permit: RecoveryPermit = { ownerId: 'owner', binding: { ...binding }, current: () => valid };
  const ledger: RecoveryLedger = {
    ownerId: 'owner',
    async reconcileRestart() {
      events.push('restart');
    },
    async reserve() {
      events.push('QUEUED');
      return {
        replayed: false,
        receipt: {
          receiptType: 'RESUME_ATTEMPT',
          attemptId: 'attempt',
          sequence: 1,
          state: 'QUEUED',
          automaticAction: 'NONE',
        },
      };
    },
    async advance(_b, _a, _seq, _old, next) {
      events.push(next);
      return {
        replayed: false,
        receipt: {
          receiptType: 'RESUME_ATTEMPT',
          attemptId: 'attempt',
          sequence: 2,
          state: next,
          automaticAction: 'NONE',
        },
      };
    },
  };
  const authority = {
    async prepare(_context: unknown, _employee: string): Promise<RecoveryPermit | null> {
      events.push('prepare');
      return permit;
    },
  };
  const sender = {
    async submit(
      message: any,
      commit: (begin: (current: () => boolean) => Promise<RecoverySendResult>) => Promise<RecoverySendResult>
    ) {
      expect(message.text).toContain('Continue work on your active goal');
      expect(events).toContain('QUEUED');
      return commit(async () => {
        events.push('effect');
        sent++;
        return 'SUBMITTED';
      });
    },
  };
  const locks = new RecoveryEffectLocks();
  let writer = true;
  const runtime = { current: () => writer };
  const service = new RecoveryTransaction(ledger, authority, sender, locks, () => now, runtime);
  return {
    service,
    ledger,
    authority,
    sender,
    locks,
    permit,
    events,
    sent: () => sent,
    loseWriter: () => {
      writer = false;
    },
    revoke: () => {
      valid = false;
    },
    clock: (value: number) => {
      now = value;
    },
  };
}
const request = { employeeId: 'employee', key: 'request-1' };

describe('outer fixed recovery transaction (trusted ports are synthetic only)', () => {
  it('is unavailable by default and before successful exclusive bootstrap', async () => {
    expect(await new RecoveryTransaction().initialize()).toEqual({ code: 'UNAVAILABLE' });
    const f = fixture();
    expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
    expect(f.sent()).toBe(0);
    expect((await f.service.initialize()).code).toBe('READY');
    expect((await f.service.initialize()).code).toBe('UNAVAILABLE');
  });
  it('appends before the single fixed-message effect and records submission afterward', async () => {
    const f = fixture();
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('SUBMITTED');
    expect(f.events).toEqual(['restart', 'prepare', 'QUEUED', 'effect', 'SUBMITTED']);
    expect(f.sent()).toBe(1);
  });
  it('rejects caller text/config and accessors without evaluating or echoing them', async () => {
    const f = fixture();
    await f.service.initialize();
    let read = 0;
    for (const input of [
      { ...request, text: 'private' },
      { ...request, urgent: true },
      Object.defineProperty({ ...request }, 'key', {
        get() {
          read++;
          return 'x';
        },
      }),
    ])
      expect((await f.service.resume({}, input)).code).toBe('INPUT_INVALID');
    expect(read).toBe(0);
    expect(f.sent()).toBe(0);
  });
  it('refuses missing/forged auth or non-FROZEN proof supplied to the trusted adapter', async () => {
    const f = fixture();
    f.authority.prepare = async () => null;
    await f.service.initialize();
    expect((await f.service.resume({ authenticatedOwner: true, FROZEN: true }, request)).code).toBe('REFUSED');
    expect(f.events).toEqual(['restart']);
  });
  it('rechecks revocation after auth await and does not reserve', async () => {
    const f = fixture();
    const prior = f.authority.prepare;
    f.authority.prepare = async (c, e) => {
      const p = await prior(c, e);
      f.revoke();
      return p;
    };
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('REFUSED');
    expect(f.events).not.toContain('QUEUED');
  });
  it('rechecks revocation after durable reserve and records refusal before any effect', async () => {
    const f = fixture();
    const prior = f.ledger.reserve;
    f.ledger.reserve = async (...args) => {
      const r = await prior(...args);
      f.revoke();
      return r;
    };
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('REFUSED');
    expect(f.events.at(-1)).toBe('REFUSED');
    expect(f.sent()).toBe(0);
  });
  it('rechecks immediately at a delayed effect seam', async () => {
    const f = fixture();
    f.sender.submit = async (_m, commit) => {
      await Promise.resolve();
      f.revoke();
      return commit(async () => {
        throw Error('must not send');
      });
    };
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('REFUSED');
    expect(f.sent()).toBe(0);
  });
  it('cannot promote a queued snapshot when any canonical generation changes', async () => {
    for (const key of ['goalGeneration', 'sessionGeneration', 'transitionSequence'] as const) {
      const f = fixture();
      const prior = f.ledger.reserve;
      f.ledger.reserve = async (...args) => {
        const r = await prior(...args);
        (f.permit.binding as any)[key]++;
        return r;
      };
      await f.service.initialize();
      expect((await f.service.resume({}, request)).code).toBe('REFUSED');
      expect(f.sent()).toBe(0);
    }
  });
  it('never sends replayed reservations or deduplicated budget reports', async () => {
    for (const receipt of [
      { receiptType: 'RESUME_ATTEMPT', state: 'QUEUED' },
      { receiptType: 'RESUME_BUDGET_REFUSED' },
    ]) {
      const f = fixture();
      f.ledger.reserve = async () => ({
        replayed: true,
        receipt: { ...receipt, automaticAction: 'NONE' } as RecoveryReceipt,
      });
      await f.service.initialize();
      expect((await f.service.resume({}, request)).code).toBe('REPLAY_OR_BUDGET');
      expect(f.sent()).toBe(0);
    }
  });
  it('retains uncertain sends rather than reporting ordinary failure or blindly retrying', async () => {
    const f = fixture();
    f.sender.submit = async (_m, commit) =>
      commit(async () => {
        throw Error('lost ack private');
      });
    await f.service.initialize();
    const r = await f.service.resume({}, request);
    expect(r.code).toBe('UNCERTAIN');
    expect(f.events.at(-1)).toBe('UNCERTAIN');
    expect(JSON.stringify(r)).not.toContain('private');
  });
  it('cannot report successful submission when authority changes during send await', async () => {
    const f = fixture();
    f.sender.submit = async (_m, commit) =>
      commit(async () => {
        await Promise.resolve();
        f.revoke();
        return 'SUBMITTED';
      });
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('UNCERTAIN');
  });
  it('retains QUEUED and disables the instance if durable post-send recording fails', async () => {
    const f = fixture();
    f.ledger.advance = async () => {
      throw Error('disk');
    };
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
    expect((await f.service.resume({}, { ...request, key: 'later' })).code).toBe('UNAVAILABLE');
    expect(f.sent()).toBe(1);
  });
  it('serializes employee, goal and session targets using the shared later-writer lock seam', async () => {
    const f = fixture();
    await f.service.initialize();
    const lease = f.locks.acquire('owner', binding)!;
    expect((await f.service.resume({}, request)).code).toBe('BUSY');
    expect(f.sent()).toBe(0);
    lease.release();
    expect((await f.service.resume({}, request)).code).toBe('SUBMITTED');
  });
  it('allows a one-use effect commit and fences all late callback attempts', async () => {
    const f = fixture();
    let late: any;
    let effects = 0;
    f.sender.submit = async (_m, commit) => {
      late = commit;
      const r = await commit(async () => {
        effects++;
        return 'SUBMITTED';
      });
      await commit(async () => {
        effects++;
        return 'SUBMITTED';
      });
      return r;
    };
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('SUBMITTED');
    await late(async () => {
      effects++;
      return 'SUBMITTED';
    });
    expect(effects).toBe(1);
  });
  it('treats an early adapter success while its effect is unresolved as uncertain', async () => {
    const f = fixture();
    let finish: any;
    f.sender.submit = async (_m, commit) => {
      void commit(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      return 'SUBMITTED';
    };
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('UNCERTAIN');
    finish('SUBMITTED');
  });
  it('refuses after the fixed deadline rather than extending an authority window', async () => {
    const f = fixture();
    f.sender.submit = async (_m, commit) => {
      f.clock(7000);
      return commit(async () => {
        throw Error('expired');
      });
    };
    await f.service.initialize();
    expect((await f.service.resume({}, request)).code).toBe('REFUSED');
    expect(f.sent()).toBe(0);
  });
});

it('requires a current exclusive writer lease at startup and after reconciliation', async () => {
  const f = fixture();
  const noLease = new RecoveryTransaction(f.ledger, f.authority, f.sender, f.locks);
  expect((await noLease.initialize()).code).toBe('UNAVAILABLE');
  expect(f.events).toEqual([]);
  const before = f.ledger.reconcileRestart;
  f.ledger.reconcileRestart = async (now) => {
    await before(now);
    f.loseWriter();
  };
  expect((await f.service.initialize()).code).toBe('UNAVAILABLE');
  expect(f.sent()).toBe(0);
});
it('fences a lost writer lease during an effect preparation await', async () => {
  const f = fixture();
  f.sender.submit = async (_m, commit) => {
    await Promise.resolve();
    f.loseWriter();
    return commit(async () => {
      throw Error('no effect');
    });
  };
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('REFUSED');
  expect(f.sent()).toBe(0);
});
it('bounds a stuck authority adapter and makes its late completion inert', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let finish: any;
    f.authority.prepare = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await f.service.initialize();
    const call = f.service.resume({}, request);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await call).code).toBe('UNAVAILABLE');
    finish(f.permit);
    await Promise.resolve();
    expect(f.sent()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it('does not leak an invalid trusted clock exception or busy reservation', async () => {
  const f = fixture();
  await f.service.initialize();
  f.clock(Number.NaN);
  expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
  expect(f.sent()).toBe(0);
});

it('supplies the same current fence inside the provider after an internal await', async () => {
  const f = fixture();
  let effects = 0;
  f.sender.submit = async (_m, commit) =>
    commit(async (current) => {
      await Promise.resolve();
      f.revoke();
      if (!current()) return 'NOT_SENT';
      effects++;
      return 'SUBMITTED';
    });
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('UNCERTAIN');
  expect(effects).toBe(0);
});

it('refuses a private ledger bound to another owner before reservation', async () => {
  const f = fixture();
  Object.defineProperty(f.ledger, 'ownerId', { value: 'other' });
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('REFUSED');
  expect(f.events).not.toContain('QUEUED');
  expect(f.sent()).toBe(0);
});
