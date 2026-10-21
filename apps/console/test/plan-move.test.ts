import { describe, expect, it, vi } from 'vitest';
import { PlanMoves, type PlanMoveInput, type PlanMovePort, type PlanMoveRecord } from '../src/plan-move.js';

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
    }),
    ready: vi.fn(async () => {
      events.push('ready');
      expect(sessions.has('old')).toBe(true);
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
  it('writes intent, creates, starts and checks readiness before stopping the old session', async () => {
    const test = harness();
    await test.moves.begin(input);
    await flush();
    expect(test.events).toEqual(['create', 'start', 'ready', 'audit:stopping', 'stop:old', 'audit:completed']);
    expect(test.binding()).toBe('new');
    expect(test.sessions.has('old')).toBe(false);
    expect((await test.moves.get(input.id))?.phase).toBe('completed');
    expect(test.saved()[0].phase).toBe('completed');
  });

  it.each(['start', 'ready'] as const)('rolls back a failed %s and stops only the candidate', async (stage) => {
    const test = harness();
    test.port[stage] = vi.fn(async () => {
      throw new Error('dead pane');
    });
    await test.moves.begin(input);
    await flush();
    expect(test.events).toContain('rebind:old');
    expect(test.events).toContain('stop:new');
    expect(test.events).not.toContain('stop:old');
    expect(test.sessions.has('old')).toBe(true);
    expect(test.binding()).toBe('old');
    expect(await test.moves.get(input.id)).toMatchObject({ phase: 'failed', error: 'dead pane' });
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
    expect((await test.moves.get(input.id))?.phase).toBe('recovery-required');
    await expect(test.moves.begin({ ...input, id: 'second' })).rejects.toThrow('requiring recovery');
  });

  it('does not overwrite a concurrently changed binding on rollback', async () => {
    const test = harness();
    test.port.ready = vi.fn(async () => {
      test.port.binding = () => 'some-other-session';
    });
    await test.moves.begin(input);
    await flush();
    expect(test.port.rebind).not.toHaveBeenCalled();
    expect(test.port.stop).not.toHaveBeenCalled();
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
