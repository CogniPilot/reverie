import { expect, it, vi } from 'vitest';
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
    chat: {
      rooms: () => [{ id: 'audit', name: 'reverie', owner, members: [] } as never],
      post: vi.fn(),
      auditEntry: vi.fn(async () => {}),
    },
    sessions,
    mux: { getSession: vi.fn(() => ({ pid: 123 }) as never), isPaneDead: vi.fn(() => false) },
    cleanup: vi.fn(async () => {}),
    authorized: vi.fn(() => true),
    request: vi.fn(async (method, path) =>
      method === 'POST' && path === '/api/sessions'
        ? { success: true, data: { session: { id: 'new' } } }
        : { data: { wait: { matched: true } } }
    ),
    capture: vi.fn(async () => [{ pid: 123, start: '456' }]),
    survivors: vi.fn(async () => []),
  };
  return { runtime, sessions, executor: planMoveExecutor(runtime, owner) };
}

const newSID = '22222222-2222-4222-8222-222222222222';
const owner = 'owner-a';
const intent = {
  operationId: '33333333-3333-4333-8333-333333333333',
  reservationId: '44444444-4444-4444-8444-444444444444',
  profileVersion: '2',
  profileDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
};
async function resourceHarness() {
  const h = harness(owner);
  const candidate = h.sessions.get('new')!;
  h.sessions.delete('new');
  h.sessions.set(newSID, candidate);
  Object.assign(candidate, { id: newSID, pid: null, muxName: null });
  const saved = h.sessions.get('old')!.toState();
  candidate.toState = () => ({
    ...saved,
    id: newSID,
    codexConfig: { ...saved.codexConfig, resumeSessionId: undefined },
  });
  let binding = 'old';
  h.runtime.company.view = vi.fn(() => ({ employees: [{ id: 'casey', sessionId: binding }] }) as never);
  const key = Object.freeze({});
  const final = vi.fn(() => undefined as unknown);
  const ports = {
    reserve: vi.fn(async () => {
      binding = newSID;
      return { sessionId: newSID, launchKey: key };
    }),
    prepare: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    verify: vi.fn(async () => final),
  };
  h.runtime.resourceReplacement = ports;
  const executor = planMoveExecutor(h.runtime, owner);
  const snapshot = await executor.snapshot('casey', owner, 'runtime-refresh');
  const refresh: PlanMoveInput = {
    ...input,
    model: undefined,
    toAccount: 'first',
    purpose: 'runtime-refresh',
    runtimeDigest: snapshot.runtimeDigest,
    resourceIntent: { ...intent },
  };
  const record = {
    id: refresh.id,
    owner,
    employeeId: refresh.employeeId,
    name: 'Casey',
    oldSession: 'old',
    newSession: newSID,
    fromAccount: 'first',
    toAccount: 'first',
    phase: 'creating' as const,
    at: 1,
    purpose: 'runtime-refresh' as const,
    runtimeDigest: refresh.runtimeDigest,
    resourceIntent: { ...intent },
    resourcePhase: 'preparing' as const,
  };
  return { ...h, executor, ports, key, final, refresh, record, candidate, setBinding: (id: string) => (binding = id) };
}
it('refuses resource creation if any fixed provider is missing, before normal API or cleanup', async () => {
  for (const missing of ['all', 'reserve', 'prepare', 'start', 'verify']) {
    const h = await resourceHarness();
    h.runtime.resourceReplacement = missing === 'all' ? undefined : ({ ...h.ports, [missing]: undefined } as never);
    const executor = planMoveExecutor(h.runtime, owner);
    await expect(executor.create(h.refresh, owner)).rejects.toThrow('unavailable');
    expect(executor.prepareResources).toBeUndefined();
    expect(executor.verifyResources).toBeUndefined();
    expect(h.runtime.request).not.toHaveBeenCalled();
    expect(h.ports.reserve).not.toHaveBeenCalled();
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
  }
});
it('uses only private fenced metadata reservation for resource creation', async () => {
  const h = await resourceHarness();
  expect(await h.executor.create(h.refresh, owner)).toBe(newSID);
  expect(h.ports.reserve).toHaveBeenCalledWith(
    expect.objectContaining({ resourceIntent: intent }),
    owner,
    expect.objectContaining({ employeeId: 'casey', subscriptionProfileId: 'first' })
  );
  expect(h.runtime.request).not.toHaveBeenCalled();
  expect(h.ports.prepare).not.toHaveBeenCalled();
  expect(h.ports.start).not.toHaveBeenCalled();
});
it('refuses wrong owner, cross-account or force-busy resource creation without effects', async () => {
  for (const patch of [
    { requestedOwner: 'other' },
    { purpose: undefined },
    { toAccount: 'second' },
    { forceBusy: true },
  ]) {
    const h = await resourceHarness();
    const { requestedOwner, ...change } = patch;
    await expect(
      h.executor.create({ ...h.refresh, ...change } as PlanMoveInput, requestedOwner ?? owner)
    ).rejects.toThrow();
    expect(h.ports.reserve).not.toHaveBeenCalled();
    expect(h.runtime.request).not.toHaveBeenCalled();
  }
});
it('requires the reserved metadata to be owned, bound and not already running', async () => {
  for (const fault of ['owner', 'running', 'bound', 'identity']) {
    const h = await resourceHarness();
    h.ports.reserve.mockImplementationOnce(async () => {
      h.setBinding(fault === 'bound' ? 'old' : newSID);
      if (fault === 'owner') Object.assign(h.candidate, { owner: 'other' });
      if (fault === 'running') Object.assign(h.candidate, { pid: 99, muxName: 'unexpected-running' });
      return { sessionId: fault === 'identity' ? 'old' : newSID, launchKey: h.key };
    });
    await expect(h.executor.create(h.refresh, owner)).rejects.toThrow();
    expect(h.runtime.request).not.toHaveBeenCalled();
    expect(h.ports.start).not.toHaveBeenCalled();
  }
});
it('never falls through to public create when the reservation reply is lost', async () => {
  const h = await resourceHarness();
  h.ports.reserve.mockRejectedValueOnce(new Error('ACK lost'));
  await expect(h.executor.create(h.refresh, owner)).rejects.toThrow('ACK lost');
  expect(h.runtime.request).not.toHaveBeenCalled();
  expect(h.runtime.cleanup).not.toHaveBeenCalled();
});
it('requires preparation before private start and never uses the generic interactive route', async () => {
  const h = await resourceHarness();
  await h.executor.create(h.refresh, owner);
  await expect(h.executor.start(newSID)).rejects.toThrow('not prepared');
  expect(h.ports.start).not.toHaveBeenCalled();
  await h.executor.prepareResources!(h.record);
  Object.assign(h.sessions.get('old')!, { pid: null });
  await h.executor.start(newSID);
  expect(h.ports.prepare).toHaveBeenCalledWith(h.key, h.record);
  expect(h.ports.start).toHaveBeenCalledWith(h.key, h.record);
  expect(h.runtime.request).not.toHaveBeenCalled();
});
it('checks the exact operation references before prepare, after await and before start', async () => {
  for (const fault of ['operation', 'profile', 'owner', 'binding', 'replaced-object']) {
    const h = await resourceHarness();
    await h.executor.create(h.refresh, owner);
    if (fault === 'operation' || fault === 'profile') {
      const changed = {
        ...h.record,
        resourceIntent: {
          ...intent,
          ...(fault === 'operation' ? { operationId: 'different' } : { profileDigest: 'c'.repeat(64) }),
        },
      };
      await expect(h.executor.prepareResources!(changed)).rejects.toThrow('binding');
      expect(h.ports.prepare).not.toHaveBeenCalled();
    } else {
      h.ports.prepare.mockImplementationOnce(async () => {
        if (fault === 'owner') h.runtime.authorized = () => false;
        if (fault === 'binding') h.setBinding('old');
        if (fault === 'replaced-object') h.sessions.set(newSID, { ...h.candidate } as Session);
      });
      await expect(h.executor.prepareResources!(h.record)).rejects.toThrow();
      await expect(h.executor.start(newSID)).rejects.toThrow();
      expect(h.ports.start).not.toHaveBeenCalled();
    }
  }
});
it('does not mark preparation after an uncertain provider failure', async () => {
  const h = await resourceHarness();
  await h.executor.create(h.refresh, owner);
  h.ports.prepare.mockRejectedValueOnce(new Error('reload response lost'));
  await expect(h.executor.prepareResources!(h.record)).rejects.toThrow('response lost');
  await expect(h.executor.start(newSID)).rejects.toThrow('not prepared');
  expect(h.runtime.request).not.toHaveBeenCalled();
});
it('preserves the final fence return value and checks ownership on each invocation', async () => {
  const h = await resourceHarness();
  await h.executor.create(h.refresh, owner);
  await h.executor.prepareResources!(h.record);
  Object.assign(h.sessions.get('old')!, { pid: null });
  await h.executor.start(newSID);
  const pending = new Promise(() => {});
  h.final.mockReturnValueOnce(pending);
  const fence = await h.executor.verifyResources!(h.record);
  expect(fence()).toBe(pending);
  h.runtime.authorized = () => false;
  expect(() => fence()).toThrow('sign-in expired');
});
it('refuses a missing final fence or post-verify identity drift', async () => {
  for (const fault of ['fence', 'drift']) {
    const h = await resourceHarness();
    await h.executor.create(h.refresh, owner);
    await h.executor.prepareResources!(h.record);
    Object.assign(h.sessions.get('old')!, { pid: null });
    await h.executor.start(newSID);
    h.ports.verify.mockImplementationOnce(async () => {
      if (fault === 'drift') h.setBinding('old');
      return (fault === 'fence' ? undefined : h.final) as never;
    });
    await expect(h.executor.verifyResources!(h.record)).rejects.toThrow();
  }
});
it('captures the provider implementation and intent so later mutation cannot substitute them', async () => {
  const h = await resourceHarness();
  let release!: () => void;
  h.runtime.plans.account = vi.fn(
    () =>
      new Promise<any>((r) => {
        release = () => r({ id: 'first', provider: 'openai', label: 'first', profileId: 'first' });
      })
  );
  const originalReserve = h.ports.reserve;
  const creating = h.executor.create(h.refresh, owner);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  (h.refresh.resourceIntent as { profileDigest: string }).profileDigest = 'c'.repeat(64);
  h.runtime.resourceReplacement!.reserve = vi.fn(async () => {
    throw new Error('substituted');
  });
  release();
  await creating;
  expect(originalReserve).toHaveBeenCalledWith(
    expect.objectContaining({ resourceIntent: intent }),
    owner,
    expect.anything()
  );
});

it('retains attempted preparation on a lost ACK and refuses retry', async () => {
  const h = await resourceHarness();
  await h.executor.create(h.refresh, owner);
  h.ports.prepare.mockRejectedValueOnce(new Error('unknown reload'));
  await expect(h.executor.prepareResources!(h.record)).rejects.toThrow('unknown reload');
  await expect(h.executor.prepareResources!(h.record)).rejects.toThrow('already attempted');
  expect(h.ports.prepare).toHaveBeenCalledOnce();
});
it('refuses start while the source is live and permits only one attempt after local release', async () => {
  const h = await resourceHarness();
  await h.executor.create(h.refresh, owner);
  await h.executor.prepareResources!(h.record);
  await expect(h.executor.start(newSID)).rejects.toThrow('source still appears live');
  expect(h.ports.start).not.toHaveBeenCalled();
  Object.assign(h.sessions.get('old')!, { pid: null });
  await h.executor.start(newSID);
  await expect(h.executor.start(newSID)).rejects.toThrow('already attempted');
  expect(h.ports.start).toHaveBeenCalledOnce();
});
it('holds a lost start acknowledgement and never verifies or repeats that attempt', async () => {
  const h = await resourceHarness();
  await h.executor.create(h.refresh, owner);
  await h.executor.prepareResources!(h.record);
  Object.assign(h.sessions.get('old')!, { pid: null });
  h.ports.start.mockRejectedValueOnce(new Error('start ACK lost'));
  await expect(h.executor.start(newSID)).rejects.toThrow('ACK lost');
  await expect(h.executor.start(newSID)).rejects.toThrow('already attempted');
  await expect(h.executor.verifyResources!(h.record)).rejects.toThrow('not acknowledged');
  expect(h.ports.start).toHaveBeenCalledOnce();
  expect(h.ports.verify).not.toHaveBeenCalled();
  expect(h.runtime.request).not.toHaveBeenCalled();
});

it('rechecks owner and source after awaited account lookup before private reservation', async () => {
  for (const drift of ['owner', 'binding', 'busy']) {
    const h = await resourceHarness();
    h.runtime.plans.account = vi.fn(async () => {
      if (drift === 'owner') h.runtime.authorized = () => false;
      if (drift === 'binding') h.setBinding('different');
      if (drift === 'busy') Object.assign(h.sessions.get('old')!, { isWorking: true });
      return { id: 'first', provider: 'openai', label: 'first', profileId: 'first' } as PlanAccount;
    });
    await expect(h.executor.create(h.refresh, owner)).rejects.toThrow();
    expect(h.ports.reserve).not.toHaveBeenCalled();
    expect(h.runtime.request).not.toHaveBeenCalled();
  }
});
