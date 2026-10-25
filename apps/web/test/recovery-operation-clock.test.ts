/** OR01 witnesses: synthetic authority/provider, owned ledger only, no live effects. */
import { it, expect, vi } from 'vitest';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RecoveryTransaction,
  RecoveryEffectLocks,
  type RecoveryLedger,
  type RecoverySendResult,
} from '../src/recovery-transaction.js';
import { RecoveryLedgerClient } from '../src/recovery-ledger-client.js';
const binding = {
  employeeId: 'employee',
  goalId: 'goal',
  goalGeneration: 1,
  sessionId: '11111111-1111-1111-1111-111111111111',
  sessionGeneration: 1,
  transitionSequence: 0,
};
const request = { employeeId: 'employee', key: 'clock-witness' };
function fixture() {
  let wall = 1000,
    mono = 0,
    effects = 0,
    state = '';
  const ledger: RecoveryLedger = {
    ownerId: 'owner',
    async reconcileRestart() {},
    async reserve() {
      state = 'QUEUED';
      return {
        replayed: false,
        receipt: { receiptType: 'RESUME_ATTEMPT', attemptId: 'attempt', sequence: 1, state, automaticAction: 'NONE' },
      };
    },
    async advance(_b, _a, _s, _e, next) {
      state = next;
      return {
        replayed: false,
        receipt: { receiptType: 'RESUME_ATTEMPT', attemptId: 'attempt', sequence: 2, state, automaticAction: 'NONE' },
      };
    },
  };
  const authority = {
    async prepare() {
      return { ownerId: 'owner', binding: { ...binding }, current: () => true };
    },
  };
  const sender = {
    async submit(
      _m: unknown,
      commit: (begin: (current: () => boolean) => Promise<RecoverySendResult>) => Promise<RecoverySendResult>
    ) {
      return commit(async (current) => {
        if (!current()) return 'NOT_SENT';
        effects++;
        return 'SUBMITTED';
      });
    },
  };
  const locks = new RecoveryEffectLocks();
  const service = new RecoveryTransaction(
    ledger,
    authority,
    sender,
    locks,
    () => wall,
    { current: () => true },
    () => mono
  );
  return {
    ledger,
    authority,
    sender,
    locks,
    service,
    wall: (v: number) => {
      wall = v;
    },
    mono: (v: number) => {
      mono = v;
    },
    state: () => state,
    effects: () => effects,
    write: () => {
      effects++;
    },
  };
}
function released(f: ReturnType<typeof fixture>) {
  const lease = f.locks.acquire('owner', binding);
  expect(lease).not.toBeNull();
  lease!.release();
}
it('OR01: rollback after reservation fences before effect, latches failure and releases only the local lock', async () => {
  const f = fixture();
  const reserve = f.ledger.reserve;
  f.ledger.reserve = async (...args) => {
    const r = await reserve(...args);
    f.wall(900);
    return r;
  };
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
  expect(f.effects()).toBe(0);
  expect(f.state()).toBe('QUEUED');
  released(f);
  f.wall(2000);
  expect((await f.service.resume({}, { ...request, key: 'no-reset' })).code).toBe('UNAVAILABLE');
  expect(f.effects()).toBe(0);
});
it('OR01: rollback during provider preparation never reaches begin and never resends late callbacks', async () => {
  const f = fixture();
  let late: any;
  f.sender.submit = async (_m, commit) => {
    late = commit;
    await Promise.resolve();
    f.wall(900);
    return commit(async () => {
      f.write();
      return 'SUBMITTED';
    });
  };
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
  expect(f.effects()).toBe(0);
  expect(f.state()).toBe('QUEUED');
  released(f);
  f.wall(2000);
  await late(async () => {
    f.write();
    return 'SUBMITTED';
  });
  expect(f.effects()).toBe(0);
});
it('OR01: the supplied provider-after-await fence rejects wall rollback', async () => {
  const f = fixture();
  f.sender.submit = async (_m, commit) =>
    commit(async (current) => {
      await Promise.resolve();
      f.wall(900);
      if (!current()) return 'NOT_SENT';
      f.write();
      return 'SUBMITTED';
    });
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
  expect(f.effects()).toBe(0);
  expect(f.state()).toBe('QUEUED');
  released(f);
});
it('OR01: elapsed expiry with a stalled wall clock blocks a prepared effect', async () => {
  const f = fixture();
  f.sender.submit = async (_m, commit) => {
    await Promise.resolve();
    f.mono(5001);
    return commit(async () => {
      f.write();
      return 'SUBMITTED';
    });
  };
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('REFUSED');
  expect(f.effects()).toBe(0);
  expect(f.state()).toBe('REFUSED');
  released(f);
});
it('OR01: provider-after-await elapsed expiry with stalled wall time retains uncertainty', async () => {
  const f = fixture();
  f.sender.submit = async (_m, commit) =>
    commit(async (current) => {
      await Promise.resolve();
      f.mono(5001);
      if (!current()) return 'NOT_SENT';
      f.write();
      return 'SUBMITTED';
    });
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('UNCERTAIN');
  expect(f.effects()).toBe(0);
  expect(f.state()).toBe('UNCERTAIN');
  released(f);
});
it('OR01: elapsed expiry plus wall regression cannot extend the authority window', async () => {
  const f = fixture();
  f.sender.submit = async (_m, commit) => {
    f.mono(5001);
    f.wall(900);
    return commit(async () => {
      f.write();
      return 'SUBMITTED';
    });
  };
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
  expect(f.effects()).toBe(0);
  released(f);
});
it('OR01: a regressed monotonic source also fails closed without a new window', async () => {
  const f = fixture();
  f.sender.submit = async (_m, commit) => {
    f.mono(-1);
    return commit(async () => {
      f.write();
      return 'SUBMITTED';
    });
  };
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('UNAVAILABLE');
  expect(f.effects()).toBe(0);
  released(f);
});
it('OR01: phase waits use remaining elapsed budget instead of renewing five seconds', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const prepare = f.authority.prepare;
    f.authority.prepare = async () => {
      const p = await prepare();
      f.mono(4500);
      return p;
    };
    f.sender.submit = async () => new Promise(() => {});
    await f.service.initialize();
    let outcome: any;
    const pending = f.service.resume({}, request).then((r) => {
      outcome = r;
    });
    await vi.advanceTimersByTimeAsync(501);
    expect(outcome?.code).toBe('REFUSED');
    expect(f.effects()).toBe(0);
    await pending;
    released(f);
  } finally {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
});
it('OR01: one non-renewable operation timer expires even if both injected clocks stall', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let outcome: any;
    f.sender.submit = async () => new Promise(() => {});
    await f.service.initialize();
    const pending = f.service.resume({}, request).then((r) => {
      outcome = r;
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(outcome?.code).toBe('REFUSED');
    expect(f.effects()).toBe(0);
    await pending;
    released(f);
  } finally {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
});
it('OR01: actual durable QUEUED survives clock failure and reopens UNCERTAIN without repeating a possible write', async () => {
  const python = execFileSync('python3', ['-I', '-B', '-c', 'import sys;print(sys.executable)'], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 4096,
  }).trim();
  const repository = resolve(import.meta.dirname, '../../../python/reverie/resume_ledger_rpc.py');
  const worker = existsSync(repository)
    ? repository
    : resolve(import.meta.dirname, 'fixtures/recovery-ledger/reverie/resume_ledger_rpc.py');
  for (const at of ['reserve', 'possible-write']) {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-clock-'));
    await chmod(dir, 0o700);
    try {
      const actual = new RecoveryLedgerClient('owner', python, worker, join(dir, 'ledger.sqlite'));
      let wall = 1000,
        effects = 0;
      const ledger: RecoveryLedger = {
        ownerId: 'owner',
        reconcileRestart: (now) => actual.reconcileRestart(now),
        advance: (...args) => actual.advance(...args),
        async reserve(...args) {
          const r = await actual.reserve(...args);
          if (at === 'reserve') wall = 900;
          return r;
        },
      };
      const locks = new RecoveryEffectLocks();
      const auth = {
        async prepare() {
          return { ownerId: 'owner', binding: { ...binding }, current: () => true };
        },
      };
      const sender = {
        async submit(_m: any, commit: any) {
          return commit(async () => {
            effects++;
            await Promise.resolve();
            wall = 900;
            return 'SUBMITTED';
          });
        },
      };
      const service = new RecoveryTransaction(ledger, auth, sender, locks, () => wall, { current: () => true });
      await service.initialize();
      expect((await service.resume({}, request)).code).toBe('UNAVAILABLE');
      expect(effects).toBe(at === 'reserve' ? 0 : 1);
      wall = 2000;
      expect((await service.resume({}, { ...request, key: 'same-instance-no-reset' })).code).toBe('UNAVAILABLE');
      const rows = (await actual.reconcileRestart(2000)) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('UNCERTAIN');
      const next = new RecoveryTransaction(actual, auth, sender, locks, () => 2000, { current: () => true });
      await next.initialize();
      expect((await next.resume({}, request)).code).toBe('REPLAY_OR_BUDGET');
      expect((await next.resume({}, { ...request, key: 'new-key' })).code).toBe('UNAVAILABLE');
      expect(effects).toBe(at === 'reserve' ? 0 : 1);
      const lease = locks.acquire('owner', binding);
      expect(lease).not.toBeNull();
      lease!.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('OR01: synchronous authority validation cannot consume the elapsed window then return a send permit', async () => {
  const f = fixture();
  const prepare = f.authority.prepare;
  f.authority.prepare = async () => {
    const p = await prepare();
    let calls = 0;
    return {
      ...p,
      current: () => {
        if (++calls >= 2) f.mono(5001);
        return true;
      },
    };
  };
  await f.service.initialize();
  expect((await f.service.resume({}, request)).code).toBe('REFUSED');
  expect(f.effects()).toBe(0);
  released(f);
});
