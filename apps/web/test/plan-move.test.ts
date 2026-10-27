import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { describe, expect, it, vi } from 'vitest';
import { PlanMoves, type PlanMoveInput, type PlanMovePort, type PlanMoveRecord } from '../src/plan-move.js';
import { createHash } from 'node:crypto';

const input: PlanMoveInput = {
  id: 'move-one',
  employeeId: 'casey',
  sessionId: 'old',
  fromAccount: 'first',
  toAccount: 'second',
  forceBusy: false,
  handoff: 'Resume the bounded task.',
};
const flush = async () => {
  for (let count = 0; count < 60; count++) await Promise.resolve();
};

function harness(initial: PlanMoveRecord[] = []) {
  const sessions = new Set(['old']);
  let binding = 'old';
  const events: string[] = [];
  let saved = initial;
  const port: PlanMovePort = {
    load: vi.fn(async () => structuredClone(saved)),
    recoveryPending: vi.fn(async () => {}),
    recoveryConfirmed: vi.fn(async () => {}),
    save: vi.fn(async (records) => {
      saved = structuredClone(records);
    }),
    snapshot: vi.fn(async () => ({ sessionId: 'old', name: 'Casey', account: 'first', working: false })),
    idle: vi.fn(async () => {}),
    create: vi.fn(async () => {
      events.push('create');
      sessions.add('new');
      binding = 'new';
      return 'new';
    }),
    start: vi.fn(async () => {
      events.push('start');
      expect(sessions.has('old')).toBe(false);
    }),
    ready: vi.fn(async () => {
      events.push('ready');
      expect(sessions.has('old')).toBe(false);
    }),
    beforeStop: vi.fn(async () => {}),
    binding: () => binding,
    exists: (sessionId) => sessions.has(sessionId),
    rebind: vi.fn(async (_employeeId, sessionId) => {
      events.push('rebind:' + sessionId);
      binding = sessionId;
    }),
    stop: vi.fn(async (sessionId) => {
      events.push('stop:' + sessionId);
      sessions.delete(sessionId);
      return [];
    }),
    audit: vi.fn(async (record) => {
      events.push('audit:' + record.phase);
    }),
  };
  const moves = new PlanMoves(port);
  return { port, moves, sessions, events, binding: () => binding, saved: () => saved };
}

describe('plan move transaction', () => {
  it('refreshes only an explicit same-account request through the unchanged stop-before-start transaction', async () => {
    const h = harness(), runtimeDigest = 'a'.repeat(64);
    h.port.snapshot = vi.fn(async () => ({ sessionId: 'old', name: 'Casey', account: 'first', working: false, mode: 'codex', runtimeDigest }));
    const refresh = { ...input, toAccount: 'first', purpose: 'runtime-refresh' as const, runtimeDigest };
    await h.moves.begin(refresh);
    await flush();
    expect(h.events).toEqual(['create', 'audit:stopping', 'stop:old', 'start', 'ready', 'audit:completed']);
    expect(await h.moves.get(input.id)).toMatchObject({ phase: 'completed', purpose: 'runtime-refresh', runtimeDigest });
    expect((await h.moves.begin(refresh)).id).toBe(input.id);
    await expect(h.moves.begin({ ...refresh, purpose: undefined, runtimeDigest: undefined })).rejects.toThrow('another request');
  });

  it('refuses refresh account, model, force and launch-policy changes before creating anything', async () => {
    for (const change of [{ toAccount: 'second' }, { runtimeDigest: 'b'.repeat(64) }, { forceBusy: true }, { model: 'changed' }]) {
      const h = harness(), runtimeDigest = 'a'.repeat(64);
      h.port.snapshot = vi.fn(async () => ({ sessionId: 'old', name: 'Casey', account: 'first', working: false, mode: 'codex', runtimeDigest }));
      await expect(h.moves.begin({ ...input, toAccount: 'first', purpose: 'runtime-refresh', runtimeDigest, ...change })).rejects.toThrow();
      expect(h.port.create).not.toHaveBeenCalled();
    }
  });

  it('rechecks refresh policy after waiting for idle and preserves absent-purpose legacy digest bytes', async () => {
    const h = harness();
    h.port.idle = vi.fn(() => new Promise(() => {}));
    await h.moves.begin(input);
    expect(h.saved()[0].requestDigest).toBe(createHash('sha256').update(JSON.stringify([input.forceBusy, input.handoff, '', ''])).digest('hex'));
    expect(h.saved()[0]).not.toHaveProperty('purpose');
    expect(h.saved()[0]).not.toHaveProperty('runtimeDigest');
    const refresh = harness(); let runtimeDigest = 'a'.repeat(64);
    refresh.port.snapshot = vi.fn(async () => ({ sessionId: 'old', name: 'Casey', account: 'first', working: false, mode: 'codex', runtimeDigest }));
    refresh.port.idle = vi.fn(async () => { runtimeDigest = 'b'.repeat(64); });
    await refresh.moves.begin({ ...input, toAccount: 'first', purpose: 'runtime-refresh', runtimeDigest });
    await flush();
    expect(refresh.port.create).not.toHaveBeenCalled();
    expect((await refresh.moves.get(input.id))?.phase).toBe('failed');
  });
  it('reserves metadata, audits and stops the old laptop before starting its replacement', async () => {
    const test = harness();
    await test.moves.begin(input);
    await flush();
    expect(test.events).toEqual(['create', 'audit:stopping', 'stop:old', 'start', 'ready', 'audit:completed']);
    expect(test.binding()).toBe('new');
    expect(test.sessions.has('old')).toBe(false);
    expect((await test.moves.get(input.id))?.phase).toBe('completed');
    expect(test.saved()[0].phase).toBe('completed');
    expect(test.saved()[0].sourceStopRequested).toBe(true);
  });

  it.each(['start', 'ready'] as const)('holds a failed %s for recovery without reviving the old SID', async (stage) => {
    const test = harness();
    test.port[stage] = vi.fn(async () => {
      throw new Error('dead pane');
    });
    await test.moves.begin(input);
    await flush();
    expect(test.events).not.toContain('rebind:old');
    expect(test.events).toContain('stop:new');
    expect(test.events).toContain('stop:old');
    expect(test.sessions.has('old')).toBe(false);
    expect(test.sessions.has('new')).toBe(false);
    expect(test.binding()).toBe('new');
    expect(await test.moves.get(input.id)).toMatchObject({ phase: 'recovery-required', error: 'dead pane' });
    expect(test.saved()[0].sourceStopRequested).toBe(true);
    await expect(test.moves.begin({ ...input, id: 'retry' })).rejects.toThrow('requiring recovery');
  });

  it('refuses stale bindings, stale plan allocation and same-plan drops before creating', async () => {
    for (const change of [{ sessionId: 'stale' }, { fromAccount: 'wrong' }, { toAccount: 'first' }]) {
      const test = harness();
      await expect(test.moves.begin({ ...input, ...change })).rejects.toThrow();
      expect(test.port.create).not.toHaveBeenCalled();
    }
  });

  it('is single-flight per person and idempotent per exact request', async () => {
    const test = harness();
    test.port.idle = vi.fn(() => new Promise(() => {}));
    await test.moves.begin(input);
    expect((await test.moves.begin(input)).id).toBe(input.id);
    await expect(test.moves.begin({ ...input, id: 'another-move' })).rejects.toThrow('in progress');
    await expect(test.moves.begin({ ...input, toAccount: 'third' })).rejects.toThrow('another request');
    await expect(test.moves.begin({ ...input, model: 'different-model' })).rejects.toThrow('another request');
    await expect(test.moves.begin({ ...input, forceBusy: true })).rejects.toThrow('another request');
    await expect(test.moves.begin({ ...input, handoff: 'A different task' })).rejects.toThrow('another request');
    expect(await test.moves.get(input.id, 'different-owner')).toBeUndefined();
    expect(test.port.create).not.toHaveBeenCalled();
  });

  it('honors explicit busy override while default moves wait for idle', async () => {
    const test = harness();
    test.port.snapshot = vi.fn(async () => ({ sessionId: 'old', name: 'Casey', account: 'first', working: true }));
    await test.moves.begin({ ...input, forceBusy: true });
    await flush();
    expect(test.port.idle).not.toHaveBeenCalled();
    expect((await test.moves.get(input.id))?.phase).toBe('completed');
  });

  it('reserves an identifier while preflight is awaiting, even for a different employee', async () => {
    const test = harness();
    let release!: () => void;
    test.port.snapshot = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { sessionId: 'old', name: 'Casey', account: 'first', working: false };
    });
    const first = test.moves.begin(input);
    await flush();
    await expect(test.moves.begin({ ...input, employeeId: 'river' })).rejects.toThrow('already being prepared');
    release();
    await first;
  });

  it('lets the owner cancel a move while it waits, without starting or stopping anyone', async () => {
    const test = harness();
    test.port.idle = vi.fn(
      (_sessionId, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    await test.moves.begin(input);
    await expect(test.moves.cancel(input.id, 'other-owner')).rejects.toThrow('Unknown move');
    await test.moves.cancel(input.id);
    await flush();
    expect(test.port.create).not.toHaveBeenCalled();
    expect(test.port.stop).not.toHaveBeenCalled();
    expect(await test.moves.get(input.id)).toMatchObject({ phase: 'failed', error: 'Move cancelled by the owner' });
  });

  it('never launches when durable intent cannot be written', async () => {
    const test = harness();
    test.port.save = vi.fn(async () => {
      throw new Error('ENOSPC');
    });
    await expect(test.moves.begin(input)).rejects.toThrow('ENOSPC');
    expect(test.port.create).not.toHaveBeenCalled();
    expect(test.sessions.has('old')).toBe(true);
  });

  it('rolls back instead of stopping old when its final busy/authorization check fails', async () => {
    const test = harness();
    test.port.beforeStop = vi.fn(async () => {
      throw new Error('became busy');
    });
    await test.moves.begin(input);
    await flush();
    expect(test.binding()).toBe('old');
    expect(test.events).not.toContain('stop:old');
    expect(test.events).toContain('stop:new');
    expect(test.port.start).not.toHaveBeenCalled();
    expect((await test.moves.get(input.id))?.phase).toBe('failed');
  });

  it('rolls back before stopping old when the mandatory commit audit fails', async () => {
    const test = harness();
    test.port.audit = vi.fn(async (record) => {
      if (record.phase === 'stopping') throw new Error('audit unavailable');
    });
    await test.moves.begin(input);
    await flush();
    expect(test.binding()).toBe('old');
    expect(test.events).not.toContain('stop:old');
    expect(test.port.start).not.toHaveBeenCalled();
    expect(test.saved()[0].sourceStopRequested).toBeUndefined();
    expect((await test.moves.get(input.id))?.phase).toBe('failed');
  });

  it('holds for recovery rather than rolling back onto a possibly stopped old process when orphans remain', async () => {
    const test = harness();
    test.port.stop = vi.fn(async (sessionId) => {
      test.events.push('stop:' + sessionId);
      return [123];
    });
    await test.moves.begin(input);
    await flush();
    expect(test.binding()).toBe('new');
    expect(test.events).not.toContain('rebind:old');
    expect(test.port.start).not.toHaveBeenCalled();
    expect((await test.moves.get(input.id))?.phase).toBe('recovery-required');
    await expect(test.moves.begin({ ...input, id: 'second' })).rejects.toThrow('requiring recovery');
  });

  it('does not overwrite a concurrently changed binding on rollback', async () => {
    const test = harness();
    test.port.beforeStop = vi.fn(async () => {
      test.port.binding = () => 'some-other-session';
    });
    await test.moves.begin(input);
    await flush();
    expect(test.port.rebind).not.toHaveBeenCalled();
    expect(test.port.stop).not.toHaveBeenCalled();
    expect((await test.moves.get(input.id))?.phase).toBe('recovery-required');
  });

  it('never starts a replacement if the source stop throws or its durable stop intent fails', async () => {
    for (const failure of ['stop', 'save'] as const) {
      const test = harness();
      if (failure === 'stop') test.port.stop = vi.fn(async () => { throw new Error('stop refused'); });
      else test.port.save = vi.fn(async (records) => {
        if (records[0].phase === 'stopping') throw new Error('ENOSPC');
      });
      await test.moves.begin(input);
      await flush();
      expect(test.port.start).not.toHaveBeenCalled();
      expect(test.port.ready).not.toHaveBeenCalled();
      expect((await test.moves.get(input.id))?.phase).toBe('recovery-required');
      expect(test.port.rebind).not.toHaveBeenCalled();
    }
  });

  it('retains recovery and cleans only the candidate when binding changes after source stop', async () => {
    const test = harness();
    test.port.stop = vi.fn(async (id) => {
      test.events.push('stop:' + id);
      test.sessions.delete(id);
      if (id === 'old') test.port.binding = () => 'another-session';
      return [];
    });
    await test.moves.begin(input);
    await flush();
    expect(test.port.start).not.toHaveBeenCalled();
    expect(test.port.rebind).not.toHaveBeenCalled();
    expect(test.events).toContain('stop:new');
    expect(test.events).not.toContain('stop:another-session');
    expect((await test.moves.get(input.id))?.phase).toBe('recovery-required');
  });

  it('never resumes destructive operations after a server restart with an unfinished journal', async () => {
    const test = harness([
      {
        id: 'old-move',
        employeeId: 'casey',
        name: 'Casey',
        oldSession: 'old',
        newSession: 'new',
        fromAccount: 'first',
        toAccount: 'second',
        phase: 'checking',
        at: 1,
      },
    ]);
    expect(await test.moves.get('old-move')).toMatchObject({ phase: 'recovery-required' });
    await expect(test.moves.begin(input)).rejects.toThrow('requiring recovery');
    expect(test.port.stop).not.toHaveBeenCalled();
    expect(test.port.create).not.toHaveBeenCalled();
  });
});


describe('owner journal recovery after restart', () => {
  const interrupted = (): PlanMoveRecord => ({id: 'interrupted', employeeId: 'casey', name: 'Casey',
    oldSession: 'old', newSession: 'new', fromAccount: 'first', toAccount: 'second', phase: 'checking',
    sourceStopRequested: true, sourceCleanupVerified: true, at: 1, error: 'original diagnostic'});
  const expected = {oldSession: 'old', newSession: 'new', toAccount: 'second'};
  it('adopts only the verified already-running destination without any lifecycle or handoff replay', async () => {
    const test = harness([interrupted()]);
    const fence = vi.fn(); test.port.verifyRecovery = vi.fn(async () => fence);
    const result = await test.moves.resolve('interrupted', expected);
    expect(result).toMatchObject({phase: 'completed', recoveryAction: 'adopt-existing', sourceCleanupVerified: true, error: 'original diagnostic'});
    expect(result.recoveredAt).toEqual(expect.any(Number));
    expect(test.port.verifyRecovery).toHaveBeenCalledTimes(2); expect(fence).toHaveBeenCalledTimes(2);
    for (const operation of [test.port.create, test.port.start, test.port.stop, test.port.ready, test.port.rebind]) expect(operation).not.toHaveBeenCalled();
    expect(await test.moves.resolve('interrupted', expected)).toEqual(result);
  });
  it.each([{sourceCleanupVerified: undefined}, {sourceStopRequested: false}, {phase: 'completed'}] as const)(
    'keeps legacy/unsafe journal held: %j', async change => {
      const test = harness([{...interrupted(), ...change}]); test.port.verifyRecovery = vi.fn(async () => () => {});
      await expect(test.moves.resolve('interrupted', expected)).rejects.toThrow();
      expect(test.port.verifyRecovery).not.toHaveBeenCalled(); expect(test.port.save).not.toHaveBeenCalled();
    });
  it('refuses stale target identifiers and cross-owner access before native inspection', async () => {
    const test = harness([interrupted()]); test.port.verifyRecovery = vi.fn(async () => () => {});
    await expect(test.moves.resolve('interrupted', {...expected, newSession: 'other'})).rejects.toThrow('target changed');
    await expect(test.moves.resolve('interrupted', expected, 'another-owner')).rejects.toThrow('Unknown');
    expect(test.port.verifyRecovery).not.toHaveBeenCalled();
  });
  it('requires a qualified native recovery inspector instead of adopting from journal metadata alone', async () => {
    const test = harness([interrupted()]);
    await expect(test.moves.resolve('interrupted', expected)).rejects.toThrow('unavailable');
    expect(test.port.save).not.toHaveBeenCalled();
  });
  it('rechecks native authority after the slow audit and retains the hold on revocation', async () => {
    const test = harness([interrupted()]); let authorized = true;
    test.port.verifyRecovery = vi.fn(async () => { if (!authorized) throw new Error('revoked'); return () => {}; });
    test.port.audit = vi.fn(async () => { authorized = false; });
    await expect(test.moves.resolve('interrupted', expected)).rejects.toThrow('revoked');
    expect((await test.moves.get('interrupted'))?.phase).toBe('recovery-required');
    expect(test.port.save).not.toHaveBeenCalled();
  });
  it('restores the recovery hold when completion publication is uncertain and does not unlock the employee', async () => {
    const test = harness([interrupted()]); test.port.verifyRecovery = vi.fn(async () => () => {});
    test.port.save = vi.fn(async () => { throw new Error('ENOSPC'); });
    await expect(test.moves.resolve('interrupted', expected)).rejects.toThrow('ENOSPC');
    expect((await test.moves.get('interrupted'))?.phase).toBe('recovery-required');
    await expect(test.moves.begin(input)).rejects.toThrow('requiring recovery');
  });
  it('retains a concurrent recovery lock while native inspection is pending', async () => {
    const test = harness([interrupted()]); let release!: () => void;
    test.port.verifyRecovery = vi.fn(async () => { await new Promise<void>(done => { release = done; }); return () => {}; });
    const first = test.moves.resolve('interrupted', expected); await flush();
    await expect(test.moves.resolve('interrupted', expected)).rejects.toThrow('still active');
    test.port.verifyRecovery = vi.fn(async () => () => {}); release(); await first;
  });
  it('refuses ambiguous multiple unfinished records for the same employee without releasing their shared hold', async () => {
    const test = harness([interrupted(), {...interrupted(), id: 'other'}]); test.port.verifyRecovery = vi.fn(async () => () => {});
    await expect(test.moves.resolve('interrupted', expected)).rejects.toThrow('Multiple unresolved');
    await expect(test.moves.begin(input)).rejects.toThrow('requiring recovery');
    expect(test.port.save).not.toHaveBeenCalled();
  });
  it('a real-store terminal write followed by failure and failed compensation remains held on restart without ACK', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'recover-uncertain-'));
    try {
      const store = new PlanMoveStore(join(directory, 'moves.json')); await store.save([interrupted()]);
      const test = harness(); test.port.load = () => store.load();
      test.port.recoveryPending = record => store.recoveryPending(record);
      test.port.recoveryConfirmed = record => store.recoveryConfirmed(record);
      test.port.verifyRecovery = vi.fn(async () => () => {});
      test.port.save = async records => {
        if (records[0].phase === 'completed') { await store.save(records); throw new Error('FSYNC_UNKNOWN'); }
        throw new Error('compensation failed');
      };
      await expect(test.moves.resolve('interrupted', expected)).rejects.toThrow('FSYNC_UNKNOWN');
      expect((await new PlanMoveStore(store.file).load())[0].phase).toBe('recovery-required');
      const reloaded = new PlanMoves({...test.port, load: () => new PlanMoveStore(store.file).load()});
      await expect(reloaded.begin(input)).rejects.toThrow('requiring recovery');
      expect(test.port.start).not.toHaveBeenCalled(); expect(test.port.stop).not.toHaveBeenCalled();
    } finally { await rm(directory, {recursive: true, force: true}); }
  });
  it('explicit durable verified ACK allows an adopted move to stay completed across a real-store restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'recover-ack-'));
    try {
      const store = new PlanMoveStore(join(directory, 'moves.json')); await store.save([interrupted()]);
      const test = harness(); test.port.load = () => store.load(); test.port.save = rows => store.save(rows);
      test.port.recoveryPending = record => store.recoveryPending(record);
      test.port.recoveryConfirmed = record => store.recoveryConfirmed(record);
      test.port.verifyRecovery = vi.fn(async () => () => {});
      const adopted = await test.moves.resolve('interrupted', expected);
      const reloadedPort = {...test.port, load: () => new PlanMoveStore(store.file).load()};
      const reloaded = new PlanMoves(reloadedPort);
      expect(await reloaded.get('interrupted')).toEqual(adopted);
      reloadedPort.snapshot = vi.fn(async () => { throw new Error('fresh request reached snapshot'); });
      await expect(reloaded.begin(input)).rejects.toThrow('fresh request reached snapshot');
    } finally { await rm(directory, {recursive: true, force: true}); }
  });

  it('does not evict a recovery whose terminal save and acknowledgement are still pending at registry capacity', async () => {
    const records = [interrupted(), ...Array.from({length: 99}, (_, i) => ({...interrupted(), id: `completed-${i}`, employeeId: `other-${i}`, phase: 'completed' as const}))];
    const test = harness(records); let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    test.port.verifyRecovery = vi.fn(async () => () => {});
    test.port.save = vi.fn(async rows => { if (rows.some(r => r.id === 'interrupted' && r.phase === 'completed')) await gate; });
    const resolving = test.moves.resolve('interrupted', expected); await flush();
    const next = test.moves.begin({...input, id: 'other-new', employeeId: 'someone-else'}); await flush();
    expect(await test.moves.get('interrupted')).toBeDefined();
    release(); await resolving; await next; await flush();
    expect(await test.moves.get('interrupted')).toMatchObject({phase: 'completed', recoveryAction: 'adopt-existing'});
  });

});
