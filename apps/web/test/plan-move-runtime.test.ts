import { describe, expect, it, vi } from 'vitest';
import { planMoveExecutor, type PlanMoveRuntime } from '../src/plan-move-runtime.js';
import type { Session } from '../src/session.js';
import type { PlanAccount } from '../src/plan-accounts.js';
import { composerReadyMark } from '../src/cli-agent.js';
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
  async function refreshHarness() {
    const h = harness();
    const source = h.sessions.get('old')!, candidate = h.sessions.get('new')!;
    const saved = source.toState();
    candidate.toState = () => ({ ...saved, id: 'new', codexConfig: { ...saved.codexConfig, resumeSessionId: undefined } });
    const snapshot = await h.executor.snapshot('casey', undefined, 'runtime-refresh');
    const refresh: PlanMoveInput = { ...input, model: undefined, toAccount: 'first',
      purpose: 'runtime-refresh', runtimeDigest: snapshot.runtimeDigest };
    return { ...h, source, candidate, saved, refresh };
  }

  it('refreshes through normal metadata creation while preserving selected policy and clearing provider linkage', async () => {
    const h = await refreshHarness();
    expect(await h.executor.create(h.refresh, undefined)).toBe('new');
    await h.executor.beforeStop(h.refresh);
    expect(h.runtime.request).toHaveBeenCalledWith('POST', '/api/sessions', expect.objectContaining({
      subscriptionProfileId: 'first', codexConfig: { reasoningEffort: 'high', renderMode: 'hybrid' }, workingDir: '/scratch/casey' }));
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
  });

  it('rejects source setting changes while creating and candidate policy drift before stopping', async () => {
    for (const drift of ['source', 'candidate', 'resume'] as const) {
      const h = await refreshHarness();
      await h.executor.create(h.refresh, undefined);
      const target = drift === 'source' ? h.source : h.candidate;
      target.toState = () => ({ ...h.saved, id: drift === 'source' ? 'old' : 'new', codexConfig: {
        ...h.saved.codexConfig, resumeSessionId: drift === 'resume' ? 'old-thread' : undefined,
        reasoningEffort: drift === 'resume' ? 'high' : 'low',
      } });
      await expect(h.executor.beforeStop(h.refresh)).rejects.toThrow();
      expect(h.runtime.cleanup).not.toHaveBeenCalled();
      expect(h.runtime.request).toHaveBeenCalledTimes(1);
    }
  });
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


describe('read-only owner inspection of an interrupted move destination', () => {
  const record = {id: 'move', employeeId: 'casey', name: 'Casey', oldSession: 'old', newSession: 'new',
    fromAccount: 'first', toAccount: 'second', phase: 'recovery-required' as const, at: 1,
    sourceStopRequested: true, sourceCleanupVerified: true};
  function recovery() {
    const test = harness(); test.sessions.delete('old');
    test.runtime.company.view = vi.fn(() => ({employees: [{id: 'casey', sessionId: 'new', sessionGeneration: 2, desiredRunning: true, onVacation: false}]}) as never);
    test.runtime.plans.allocations = vi.fn(async () => ({generatedAt: 1, accounts: [{id: 'second', sessionIds: ['new']}]}));
    test.runtime.mux.capturePaneText = vi.fn(() => composerReadyMark('codex')!);
    return test;
  }
  it('verifies current binding, actual target allocation and composer without submitting a handoff or touching sessions', async () => {
    const test = recovery(); const fence = await test.executor.verifyRecovery!(record); fence();
    expect(test.runtime.request).not.toHaveBeenCalled(); expect(test.runtime.cleanup).not.toHaveBeenCalled();
    expect(test.sessions.get('new')!.writeViaMux).not.toHaveBeenCalled();
  });
  it('does not infer source cleanup from a missing source session or journal stop request', async () => {
    const test = recovery(); await expect(test.executor.verifyRecovery!({...record, sourceCleanupVerified: undefined})).rejects.toThrow('durably confirmed');
    expect(test.runtime.plans.allocations).not.toHaveBeenCalled();
  });
  it('refuses an alive source, wrong account, absent composer and busy destination', async () => {
    for (const failure of ['source', 'account', 'composer', 'busy']) {
      const test = recovery();
      if (failure === 'source') test.sessions.set('old', {...test.sessions.get('new')!, id: 'old'} as never);
      if (failure === 'account') test.runtime.plans.allocations = vi.fn(async () => ({generatedAt: 1, accounts: [{id: 'first', sessionIds: ['new']}]}));
      if (failure === 'composer') test.runtime.mux.capturePaneText = () => '';
      if (failure === 'busy') (test.sessions.get('new') as unknown as {isWorking: boolean}).isWorking = true;
      await expect(test.executor.verifyRecovery!(record)).rejects.toThrow();
      expect(test.runtime.cleanup).not.toHaveBeenCalled(); expect(test.runtime.request).not.toHaveBeenCalled();
    }
  });
  it('the final fence notices revoked owner authority and changed employee intent', async () => {
    for (const failure of ['authority', 'intent', 'generation', 'selection']) {
      const test = recovery(); const fence = await test.executor.verifyRecovery!(record);
      if (failure === 'authority') test.runtime.authorized = () => false;
      if (failure === 'intent') test.runtime.company.view = () => ({employees: [{id: 'casey', sessionId: 'new', sessionGeneration: 2, desiredRunning: false}]}) as never;
      if (failure === 'generation') test.runtime.company.view = () => ({employees: [{id: 'casey', sessionId: 'new', sessionGeneration: 3, desiredRunning: true}]}) as never;
      if (failure === 'selection') (test.sessions.get('new') as unknown as {subscriptionProfile: unknown}).subscriptionProfile = {id: 'changed'};
      expect(fence).toThrow();
    }
  });
  it('refuses already-unsupported remote, nested-container and custom-model candidates', async () => {
    for (const change of [{remote: {host: 'remote'}}, {docker: {containerName: 'nested'}}, {customModel: {modelId: 'local'}}]) {
      const test = recovery(), candidate = test.sessions.get('new')!, saved = candidate.toState();
      candidate.toState = () => ({...saved, ...change}) as never;
      await expect(test.executor.verifyRecovery!(record)).rejects.toThrow('cannot be adopted');
      expect(test.runtime.cleanup).not.toHaveBeenCalled(); expect(test.runtime.request).not.toHaveBeenCalled();
    }
  });

});


describe('normal replacement composer uses the strict Claude task footer', () => {
  const hud = [
    'Goal active · generic task', '──────────────────── generic-worker ─', '❯\u00a0',
    '────────────────────────────────────', 'Generic model · usage 12%',
    '⏵⏵ bypass permissions on · 1 shell · 1 feedback draft',
  ].join('\n');
  it('verifies the new Claude composer then submits the original handoff once through normal guarded input', async () => {
    const h = harness(), candidate = h.sessions.get('new')!;
    Object.defineProperty(candidate, 'mode', { value: 'claude', configurable: true });
    h.runtime.plans.account = vi.fn(async id => ({ id, provider: 'anthropic', label: id, profileId: id }) as PlanAccount);
    h.runtime.mux.capturePaneText = vi.fn(() => hud);
    await h.executor.create({ ...input, targetMode: 'claude' }, undefined);
    await h.executor.ready('new');
    expect(h.runtime.mux.capturePaneText).toHaveBeenCalledWith('new');
    expect(candidate.writeViaMux).toHaveBeenCalledTimes(1);
    expect(candidate.writeViaMux).toHaveBeenCalledWith(input.handoff + '\r', expect.objectContaining({ requireEmptyComposer: true, fromUser: true }));
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
  });
  it.each(['draft', 'dialog', 'busy', 'codex'] as const)('does not submit a handoff for %s even with the task footer', async kind => {
    const h = harness(), candidate = h.sessions.get('new')!;
    Object.defineProperty(candidate, 'mode', { value: kind === 'codex' ? 'codex' : 'claude', configurable: true });
    h.runtime.plans.account = vi.fn(async id => ({ id, provider: kind === 'codex' ? 'openai' : 'anthropic', label: id, profileId: id }) as PlanAccount);
    h.runtime.mux.capturePaneText = vi.fn(() => kind === 'draft' ? hud.replace('❯\u00a0', '❯ unsent draft') : hud);
    if (kind === 'dialog') Object.defineProperty(candidate, 'paneDialog', { value: 'trust', configurable: true });
    if (kind === 'busy') Object.defineProperty(candidate, 'isWorking', { value: true, configurable: true });
    await h.executor.create({ ...input, targetMode: kind === 'codex' ? 'codex' : 'claude' }, undefined);
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(90_001);
    try { await expect(h.executor.ready('new')).rejects.toThrow('composer before the deadline'); }
    finally { clock.mockRestore(); }
    expect(candidate.writeViaMux).not.toHaveBeenCalled();
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
  });
});
