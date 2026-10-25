import { describe, expect, it, vi } from 'vitest';
import { planMoveExecutor, type PlanMoveRuntime } from '../src/plan-move-runtime.js';
import type { Session } from '../src/session.js';
import type { PlanAccount } from '../src/plan-accounts.js';
import type { PlanMoveInput } from '../src/plan-move.js';

const input: PlanMoveInput = {
  id: 'move',
  employeeId: 'casey',
  sessionId: 'old',
  fromAccount: 'first',
  toAccount: 'second',
  forceBusy: false,
  handoff: 'Read the work handoff.',
  model: 'chosen-model',
};
function harness(owner?: string) {
  const pane = (id: string) =>
    ({
      id,
      owner,
      name: 'Casey',
      mode: 'codex',
      pid: 123,
      muxName: id,
      isWorking: false,
      toState: () => ({
        id,
        name: 'Casey',
        mode: 'codex',
        workingDir: '/scratch/casey',
        codexConfig: { reasoningEffort: 'high', resumeSessionId: 'old-private-thread' },
      }),
      writeViaMux: vi.fn(async (_text, options) => {
        options?.onOutcome?.('submitted');
        return true;
      }),
    }) as unknown as Session;
  const sessions = new Map([
    ['old', pane('old')],
    ['new', pane('new')],
  ]);
  const runtime: PlanMoveRuntime = {
    company: { view: vi.fn(() => ({ employees: [{ id: 'casey', sessionId: 'old' }] }) as never), rebind: vi.fn() },
    plans: {
      allocations: vi.fn(async () => ({ generatedAt: 1, accounts: [{ id: 'first', sessionIds: ['old'] }] })),
      account: vi.fn(async (id) => ({ id, provider: 'openai', label: id, profileId: id }) as PlanAccount),
    },
    chat: { rooms: () => [{ id: 'audit', name: 'reverie', owner, members: [] } as never], post: vi.fn(), auditEntry: vi.fn(async () => {}) },
    sessions,
    mux: { getSession: vi.fn(() => ({ pid: 123 }) as never), isPaneDead: vi.fn(() => false) },
    cleanup: vi.fn(async () => {}),
    authorized: vi.fn(() => true),
    request: vi.fn(async (method, path) =>
      method === 'POST' && path === '/api/sessions' ? { success: true, data: { session: { id: 'new' } } } : { data: { wait: { matched: true } } }
    ),
    capture: vi.fn(async () => [{ pid: 123, start: '456' }]),
    survivors: vi.fn(async () => []),
  };
  return { runtime, sessions, executor: planMoveExecutor(runtime, owner) };
}

describe('runtime adapter uses normal creation and interactive paths, never changes live account env', () => {
  it('refuses a bound session belonging to another owner before any launch or cleanup', async () => {
    const test = harness();
    (test.sessions.get('old') as unknown as { owner?: string }).owner = 'another-owner';
    await expect(test.executor.snapshot('casey')).rejects.toThrow('owned session');
    expect(test.runtime.request).not.toHaveBeenCalled();
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('previews the actual current binding and allocation, and refuses expired owner credentials', async () => {
    const test = harness();
    expect(await test.executor.snapshot('casey')).toMatchObject({
      sessionId: 'old',
      account: 'first',
      mode: 'codex',
      working: false,
    });
    test.runtime.authorized = () => false;
    await expect(test.executor.create(input, undefined)).rejects.toThrow('sign-in expired');
    expect(test.runtime.request).not.toHaveBeenCalled();
  });

  it('creates fresh config with the chosen profile and starts only through interactive', async () => {
    const test = harness();
    expect(await test.executor.create(input, undefined)).toBe('new');
    await test.executor.start('new');
    expect(test.runtime.request).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/api/sessions',
      expect.objectContaining({
        employeeId: 'casey',
        subscriptionProfileId: 'second',
        codexConfig: expect.objectContaining({ model: 'chosen-model', reasoningEffort: 'high' }),
      })
    );
    expect(test.runtime.request).toHaveBeenNthCalledWith(2, 'POST', '/api/sessions/new/interactive');
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('refuses a dead candidate before sending handoff or cleaning the old session', async () => {
    const test = harness();
    await test.executor.create(input, undefined);
    test.runtime.mux.isPaneDead = () => true;
    await expect(test.executor.ready('new')).rejects.toThrow('pane exited');
    expect(test.sessions.get('new')?.writeViaMux).not.toHaveBeenCalled();
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('reserves cross-provider metadata through the normal API without starting its CLI', async () => {
    const test = harness();
    test.runtime.plans.account = vi.fn(async (id) => ({ id, provider: 'anthropic', label: id, profileId: id }) as PlanAccount);
    expect(await test.executor.create({ ...input, targetMode: 'claude' }, undefined)).toBe('new');
    expect(test.runtime.request).toHaveBeenCalledWith('POST', '/api/sessions', expect.objectContaining({ mode: 'claude', subscriptionProfileId: 'second', employeeId: 'casey' }));
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
    expect(test.runtime.request).toHaveBeenCalledTimes(1);
    const payload = (test.runtime.request as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(payload.model).toBeUndefined();
    expect(payload.codexConfig).toBeUndefined();
  });

  it('requires a verified submitted handoff after composer readiness', async () => {
    const test = harness();
    await test.executor.create(input, undefined);
    await test.executor.ready('new');
    expect(test.sessions.get('new')?.writeViaMux).toHaveBeenCalledWith(
      input.handoff + '\r',
      expect.objectContaining({ fromUser: true })
    );
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('rechecks owner authority after readiness and before stopping source, but permits safe candidate rollback', async () => {
    const test = harness();
    await test.executor.create(input, undefined);
    test.runtime.request = vi.fn(async () => {
      test.runtime.authorized = () => false;
      return { data: { wait: { matched: true } } };
    });
    await expect(test.executor.ready('new')).rejects.toThrow('sign-in expired');
    expect(test.sessions.get('new')?.writeViaMux).not.toHaveBeenCalled();
    await expect(test.executor.stop('old')).rejects.toThrow('sign-in expired');
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
    await test.executor.stop('new');
    expect(test.runtime.cleanup).toHaveBeenCalledWith('new', true, 'plan_move');
  });

  it('checks captured old process identities after normal cleanup and reports remaining orphans', async () => {
    const test = harness();
    test.runtime.survivors = vi.fn(async () => [123]);
    expect(await test.executor.stop('old')).toEqual([123]);
    expect(test.runtime.capture).toHaveBeenCalledWith([123]);
    expect(test.runtime.cleanup).toHaveBeenCalledWith('old', true, 'plan_move');
    expect(test.runtime.survivors).toHaveBeenCalledWith([{ pid: 123, start: '456' }]);
    expect(test.executor.exists('not-present')).toBe(false);
  });

  it('never cleans up if the source process tree cannot be verified', async () => {
    const test = harness();
    test.runtime.capture = vi.fn(async () => {
      throw new Error('process snapshot unavailable');
    });
    await expect(test.executor.stop('old')).rejects.toThrow('snapshot unavailable');
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('rechecks busy state before stopping, refusing late work unless explicitly forced', async () => {
    const test = harness();
    (test.sessions.get('old') as unknown as { isWorking: boolean }).isWorking = true;
    await expect(test.executor.beforeStop(input)).rejects.toThrow('became busy');
    await expect(test.executor.beforeStop({ ...input, forceBusy: true })).resolves.toBeUndefined();
    expect(test.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('keeps phone delivery paused through the source stop until the replacement handoff is submitted', async () => {
    const test = harness();
    const release = vi.fn();
    test.runtime.chat.delivery = { pauseForMigration: vi.fn(() => release) };
    await test.executor.create(input, undefined);
    await test.executor.beforeStop(input);
    await test.executor.stop('old');
    expect(release).not.toHaveBeenCalled();
    await test.executor.start('new');
    await test.executor.ready('new');
    expect(release).toHaveBeenCalledTimes(2);
    expect(test.sessions.get('new')?.writeViaMux).toHaveBeenCalledTimes(1);
  });

  it('posts actor, employee, source, destination and phase to the owned audit channel', async () => {
    const test = harness();
    await test.executor.audit({ ...input, name: 'Casey', oldSession: 'old', phase: 'completed', at: 1 });
    expect(test.runtime.chat.post).toHaveBeenCalledWith(
      'audit',
      { kind: 'system', name: 'Plans' },
      'AUDIT plan move completed: Owner moved Casey from first to second'
    );
    expect(test.runtime.chat.auditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'plan_move', actor: 'owner', employeeId: 'casey', fromAccount: 'first', toAccount: 'second', phase: 'completed' }));
  });

  it('previews and audits privately when only General exists, without posting or creating a channel', async () => {
    const test = harness('alice');
    test.runtime.chat.rooms = () => [{ id: 'general', name: 'general', owner: 'alice', members: [] } as never];
    await expect(test.executor.snapshot('casey')).resolves.toMatchObject({ account: 'first' });
    await test.executor.audit({ ...input, owner: 'alice', name: 'Casey', oldSession: 'old', phase: 'stopping', at: 1 });
    expect(test.runtime.chat.auditEntry).toHaveBeenCalledWith(expect.objectContaining({ owner: 'alice', actor: 'alice', moveId: 'move' }));
    expect(test.runtime.chat.post).not.toHaveBeenCalled(); expect(test.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('never mirrors into another owner’s channel, a DM, or an archived room', async () => {
    const test = harness('alice');
    test.runtime.chat.rooms = () => [
      { id: 'foreign', name: 'reverie', owner: 'bob', members: [] },
      { id: 'dm', name: 'reverie', owner: 'alice', kind: 'dm', members: [] },
      { id: 'archived', name: 'reverie', owner: 'alice', archivedAt: 1, members: [] },
    ] as never;
    await expect(test.executor.snapshot('casey')).resolves.toMatchObject({ sessionId: 'old' });
    await test.executor.audit({ ...input, owner: 'alice', name: 'Casey', oldSession: 'old', phase: 'completed', at: 1 });
    expect(test.runtime.chat.auditEntry).toHaveBeenCalledTimes(1); expect(test.runtime.chat.post).not.toHaveBeenCalled();
    await expect(test.executor.audit({ ...input, owner: 'bob', name: 'Foreign', oldSession: 'old', phase: 'completed', at: 1 })).rejects.toThrow('another owner');
    expect(test.runtime.chat.auditEntry).toHaveBeenCalledTimes(1);
  });

  it('requires the private durable audit but tolerates a failed optional room mirror', async () => {
    const test = harness();
    const record = { ...input, name: 'Casey', oldSession: 'old', phase: 'stopping' as const, at: 1 };
    vi.mocked(test.runtime.chat.auditEntry).mockRejectedValueOnce(new Error('Audit storage unavailable'));
    await expect(test.executor.audit(record)).rejects.toThrow('Audit storage unavailable');
    expect(test.runtime.chat.post).not.toHaveBeenCalled();
    vi.mocked(test.runtime.chat.post).mockImplementationOnce(() => { throw new Error('Channel read-only'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(test.executor.audit(record)).resolves.toBeUndefined();
    expect(test.runtime.chat.auditEntry).toHaveBeenCalledTimes(2); warning.mockRestore();
  });
});
