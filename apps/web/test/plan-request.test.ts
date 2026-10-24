import { describe, expect, it, vi } from 'vitest';
import { PlanMoveRequests, type PlanRequestRecord, type PlanRequestPort } from '../src/plan-request.js';
import { PlanMoveError, type PlanMoveExecutor, type PlanMoveRecord } from '../src/plan-move.js';

export function requestHarness(seed: PlanRequestRecord[] = []) {
  let now = 100,
    authorized = true,
    bound = 'source',
    records = seed,
    nonce = '',
    move: PlanMoveRecord | undefined;
  const executor = {
    snapshot: vi.fn(async () => ({
      sessionId: 'source',
      name: 'Alex',
      account: 'first',
      working: false,
      mode: 'codex',
    })),
  } as unknown as PlanMoveExecutor;
  const execution = { executor, authorized: () => authorized };
  const port: PlanRequestPort = {
    load: async () => records,
    save: vi.fn(async (value) => {
      records = structuredClone(value);
    }),
    moves: {
      begin: vi.fn(async (input) => {
        move = {
          id: input.id,
          employeeId: input.employeeId,
          oldSession: input.sessionId,
          name: 'Alex',
          fromAccount: input.fromAccount,
          toAccount: input.toAccount,
          phase: 'waiting',
          at: now,
        };
        return move;
      }),
      get: vi.fn(async () => move),
      cancel: vi.fn(async () => {}),
    },
    binding: () => bound,
    validateTarget: vi.fn(async (_snapshot, target) => {
      if (target !== 'second') throw new PlanMoveError('Unknown destination');
    }),
    capability: {
      write: vi.fn(async (value) => {
        nonce = value.nonce;
        return '/private/request.json';
      }),
      remove: vi.fn(async () => {}),
    },
    notify: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    now: () => now,
  };
  const service = new PlanMoveRequests(port);
  const input = { id: 'request', employeeId: 'alex', sessionId: 'source', toAccount: 'second' };
  return {
    service,
    port,
    input,
    execution,
    executor,
    nonce: () => nonce,
    records: () => records,
    authorize: (value: boolean) => {
      authorized = value;
    },
    bind: (value: string) => {
      bound = value;
    },
    clock: (value: number) => {
      now = value;
    },
    move: (value: PlanMoveRecord) => {
      move = value;
    },
  };
}

describe('expert-approved plan requests', () => {
  it('binds cross-provider approval to the destination harness and refuses a changed target', async () => {
    const h = requestHarness();
    h.port.validateTarget = vi.fn(async () => ({ mode: 'claude' as const }));
    const record = await h.service.create(h.input, 'owner', h.execution);
    expect(record.targetMode).toBe('claude');
    expect(h.port.moves.begin).not.toHaveBeenCalled();
    h.port.validateTarget = vi.fn(async () => ({ mode: 'codex' as const }));
    await expect(h.service.decide('request', 'source', h.nonce(), 'approve', 'Use the work handoff', 'owner')).rejects.toThrow('destination harness changed');
    expect(h.port.moves.begin).not.toHaveBeenCalled();
    h.port.validateTarget = vi.fn(async () => ({ mode: 'claude' as const }));
    await h.service.decide('request', 'source', h.nonce(), 'approve', 'Use the work handoff', 'owner');
    expect(h.port.moves.begin).toHaveBeenCalledWith(expect.objectContaining({ targetMode: 'claude', handoff: 'Use the work handoff' }), 'owner', h.executor);
  });
  it('persists only a nonce hash, exposes no credential, and does nothing before exact expert approval', async () => {
    const h = requestHarness();
    const record = await h.service.create(h.input, 'owner', h.execution);
    expect(record.phase).toBe('pending');
    expect(record).not.toHaveProperty('nonceHash');
    expect(h.records()[0].nonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(h.records())).not.toContain(h.nonce());
    expect(h.port.moves.begin).not.toHaveBeenCalled();
    const approved = await h.service.decide(
      'request',
      'source',
      h.nonce(),
      'approve',
      'Finish the report.\nContinue tests.',
      'owner'
    );
    expect(approved.phase).toBe('executing');
    expect(h.port.moves.begin).toHaveBeenCalledWith(
      expect.objectContaining({ toAccount: 'second', forceBusy: false, handoff: 'Finish the report. Continue tests.' }),
      'owner',
      h.executor
    );
    expect(h.records()[0]).not.toHaveProperty('nonceHash');
    await expect(h.service.decide('request', 'source', h.nonce(), 'approve', 'Again', 'owner')).rejects.toThrow(
      'already used'
    );
    expect(h.port.moves.begin).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong session, owner, nonce, unsafe handoff, and changed source before any execution', async () => {
    const h = requestHarness();
    await h.service.create(h.input, 'owner', h.execution);
    for (const [session, token, owner] of [
      ['other', h.nonce(), 'owner'],
      ['source', '0'.repeat(64), 'owner'],
      ['source', h.nonce(), 'other'],
    ])
      await expect(h.service.decide('request', session, token, 'approve', 'Handoff', owner)).rejects.toThrow();
    await expect(h.service.decide('request', 'source', h.nonce(), 'approve', '\x1b[2J', 'owner')).rejects.toThrow(
      'work-safe'
    );
    h.bind('different');
    await expect(h.service.decide('request', 'source', h.nonce(), 'approve', 'Handoff', 'owner')).rejects.toThrow();
    expect(h.port.moves.begin).not.toHaveBeenCalled();
    expect((await h.service.get('request', 'owner')).phase).toBe('failed');
  });
  it('rejects arbitrary destinations, stale IDs, competing requests, and foreign history', async () => {
    const h = requestHarness();
    await expect(h.service.create({ ...h.input, toAccount: 'foreign' }, 'owner', h.execution)).rejects.toThrow(
      'destination'
    );
    await h.service.create(h.input, 'owner', h.execution);
    await expect(h.service.create({ ...h.input, id: 'another' }, 'owner', h.execution)).rejects.toThrow('pending');
    await expect(h.service.create({ ...h.input, toAccount: 'foreign' }, 'owner', h.execution)).rejects.toThrow(
      'identifier'
    );
    expect(await h.service.list('another-owner')).toEqual([]);
    await expect(h.service.get('request', 'another-owner')).rejects.toThrow('Unknown');
  });
  it('cancellation and rejection consume approval and remove the destination ghost state', async () => {
    const h = requestHarness();
    await h.service.create(h.input, 'owner', h.execution);
    expect((await h.service.cancel('request', 'owner')).phase).toBe('cancelled');
    await expect(h.service.decide('request', 'source', h.nonce(), 'approve', 'Handoff', 'owner')).rejects.toThrow();
    const next = await h.service.create({ ...h.input, id: 'next' }, 'owner', h.execution);
    expect((await h.service.decide(next.id, 'source', h.nonce(), 'reject', '', 'owner')).phase).toBe('rejected');
    expect(h.port.moves.begin).not.toHaveBeenCalled();
  });
  it('revoked authorization fails closed, and reauthorization rotates the nonce without changing target', async () => {
    const h = requestHarness();
    await h.service.create(h.input, 'owner', h.execution);
    const old = h.nonce();
    h.authorize(false);
    await expect(h.service.decide('request', 'source', old, 'approve', 'Handoff', 'owner')).rejects.toThrow();
    expect((await h.service.get('request', 'owner')).phase).toBe('reauthorize-required');
    h.authorize(true);
    await h.service.reauthorize('request', 'owner', h.execution);
    expect(h.nonce()).not.toBe(old);
    await expect(h.service.decide('request', 'source', old, 'approve', 'Handoff', 'owner')).rejects.toThrow();
    expect((await h.service.get('request', 'owner')).toAccount).toBe('second');
    expect(h.port.moves.begin).not.toHaveBeenCalled();
  });
  it('server restart requires reauthorization and never replays pending execution', async () => {
    const h = requestHarness();
    await h.service.create(h.input, 'owner', h.execution);
    const restarted = requestHarness(structuredClone(h.records()));
    expect((await restarted.service.get('request', 'owner')).phase).toBe('reauthorize-required');
    expect(restarted.port.moves.begin).not.toHaveBeenCalled();
    expect(restarted.records()[0]).not.toHaveProperty('nonceHash');
    expect(restarted.port.capability.remove).toHaveBeenCalledWith('source', 'request');
  });
  it('expiry, delivery failure, and private audit failure cannot switch a session', async () => {
    const h = requestHarness();
    await h.service.create(h.input, 'owner', h.execution);
    h.clock(2_000_000);
    expect((await h.service.get('request', 'owner')).phase).toBe('expired');
    const failed = requestHarness();
    vi.mocked(failed.port.audit).mockRejectedValue(new Error('disk full'));
    expect((await failed.service.create(failed.input, 'owner', failed.execution)).phase).toBe('failed');
    expect(failed.port.moves.begin).not.toHaveBeenCalled();
    const delivery = requestHarness();
    vi.mocked(delivery.port.notify).mockRejectedValue(new Error('not ready'));
    await delivery.service.create(delivery.input, 'owner', delivery.execution);
    await vi.waitFor(async () =>
      expect((await delivery.service.get('request', 'owner')).phase).toBe('reauthorize-required')
    );
  });
  it('requires a durable approval audit before beginning and consumes simultaneous duplicate approvals once', async () => {
    const h = requestHarness();
    await h.service.create(h.input, 'owner', h.execution);
    vi.mocked(h.port.audit).mockRejectedValue(new Error('disk full'));
    expect((await h.service.decide('request', 'source', h.nonce(), 'approve', 'Handoff', 'owner')).phase).toBe(
      'failed'
    );
    expect(h.port.moves.begin).not.toHaveBeenCalled();
    const concurrent = requestHarness();
    await concurrent.service.create(concurrent.input, 'owner', concurrent.execution);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        concurrent.service.decide('request', 'source', concurrent.nonce(), 'approve', 'Handoff', 'owner')
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.port.moves.begin).toHaveBeenCalledTimes(1);
  });
  it('tracks completion and retains recovery-required holds for owner inspection', async () => {
    const h = requestHarness();
    await h.service.create(h.input, 'owner', h.execution);
    await h.service.decide('request', 'source', h.nonce(), 'approve', 'Handoff', 'owner');
    h.move({
      id: 'request',
      employeeId: 'alex',
      oldSession: 'source',
      newSession: 'candidate',
      name: 'Alex',
      fromAccount: 'first',
      toAccount: 'second',
      phase: 'completed',
      at: 1,
    });
    expect(await h.service.get('request', 'owner')).toMatchObject({ phase: 'completed', newSession: 'candidate' });
  });
});

describe('self-service pending discovery', () => {
  it('lists the exact current session without credentials and drops expired requests', async () => {
    const h = requestHarness(); await h.service.create(h.input, 'owner', h.execution);
    const own = await h.service.pendingForSession('source', 'owner');
    expect(own).toHaveLength(1); expect(own[0]).not.toHaveProperty('nonceHash');
    expect(await h.service.pendingForSession('other', 'owner')).toEqual([]);
    expect(await h.service.pendingForSession('source', 'other-owner')).toEqual([]);
    h.clock(1_800_100);
    expect(await h.service.pendingForSession('source', 'owner')).toEqual([]);
    expect((await h.service.get('request', 'owner')).phase).toBe('expired');
    await expect(h.service.decide('request', 'source', h.nonce(), 'approve', 'handoff', 'owner')).rejects.toThrow();
    expect(h.port.moves.begin).not.toHaveBeenCalled();
  });
});

it('expires a queued notification when its authorization predicate reaches the deadline', async () => {
  const h = requestHarness(); let fail: (error: Error) => void;
  h.port.notify = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const r = await h.service.create(h.input, 'owner', h.execution);
  h.clock(r.expiresAt); fail!(new Error('expired delivery'));
  await vi.waitFor(() => expect(h.records()[0].phase).toBe('expired'));
  expect(h.port.moves.begin).not.toHaveBeenCalled();
});
it('rechecks expiry after asynchronous approval preparation, before consuming the credential', async () => {
  const h = requestHarness(); let checks = 0;
  h.port.validateTarget = vi.fn(async () => { if (++checks === 2) h.clock(1_800_100); });
  await h.service.create(h.input, 'owner', h.execution);
  await expect(h.service.decide('request', 'source', h.nonce(), 'approve', 'handoff', 'owner')).rejects.toThrow('expired');
  expect(h.port.moves.begin).not.toHaveBeenCalled();
  expect((await h.service.get('request', 'owner')).phase).toBe('expired');
});
