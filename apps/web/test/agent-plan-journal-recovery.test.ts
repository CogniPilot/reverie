import { expect, it, vi } from 'vitest';
import { agentPlanJournalRecovery } from '../src/agent-plan-journal-recovery.js';
import { PlanMoves, type PlanMoveRecord } from '../src/plan-move.js';
function fixture(self = false) {
  const pane = (id: string) => ({
    id,
    owner: undefined,
    pid: 123,
    muxName: id,
    mode: 'codex',
    workingDir: '/fixture',
    isWorking: false,
    toState: () => ({ mode: 'codex', workingDir: '/fixture' }),
    getCustomModelForPersist: () => undefined,
  });
  const candidate = pane('candidate'),
    manager = pane('manager');
  const sessions = new Map([
    ['candidate', candidate],
    ['manager', manager],
  ]);
  const employees = [
    {
      id: 'expert',
      sessionId: 'candidate',
      sessionGeneration: 2,
      desiredRunning: true,
      permissions: { moveOwnPlan: self, managePlans: false },
    },
    {
      id: 'manager',
      sessionId: 'manager',
      sessionGeneration: 1,
      desiredRunning: true,
      permissions: { moveOwnPlan: false, managePlans: !self },
    },
  ];
  const caller = employees[self ? 0 : 1];
  let issued = true;
  const authority = {
    employeeId: caller.id,
    sessionId: caller.sessionId,
    sessionGeneration: caller.sessionGeneration,
    owner: undefined,
    assertIssued: () => {
      if (!issued) throw Error('issuer revoked');
    },
    assertCurrent: () => {
      if (!issued) throw Error('caller revoked');
    },
  };
  const runtime: any = {
    sessions,
    company: { view: () => ({ employees }) },
    mux: { isPaneDead: () => false, capturePaneText: () => '? for shortcuts\n›' },
    plans: {
      account: vi.fn(async () => ({ provider: 'openai', id: 'plan' })),
      allocations: async () => ({ accounts: [{ id: 'plan', sessionIds: ['candidate'] }] }),
    },
    chat: { auditEntry: vi.fn(async () => {}), rooms: () => [] },
    cleanup: vi.fn(),
  };
  const record = {
    id: 'held',
    employeeId: 'expert',
    owner: undefined,
    oldSession: 'old',
    newSession: 'candidate',
    toAccount: 'plan',
    fromAccount: 'old-plan',
    phase: 'recovery-required',
    error: 'Existing held move',
    sourceStopRequested: true,
    sourceCleanupVerified: true,
  } as PlanMoveRecord;
  return {
    authority,
    runtime,
    record,
    employees,
    sessions,
    candidate,
    revoked: () => {
      issued = false;
    },
    capture: () => agentPlanJournalRecovery(authority, 'expert', runtime),
  };
}
it('a manager adopts only the existing inspected destination without launch, cleanup or provider input', async () => {
  const f = fixture(),
    actor = f.capture()!,
    executor = actor.inspect(f.record);
  const moves = new PlanMoves({
    ...executor,
    load: async () => [f.record],
    save: vi.fn(async () => {}),
    recoveryPending: async () => {},
    recoveryConfirmed: async () => {},
  });
  const row = await moves.resolve(
    'held',
    { oldSession: 'old', newSession: 'candidate', toAccount: 'plan' },
    undefined,
    executor
  );
  expect(row.phase).toBe('completed');
  expect(f.runtime.chat.auditEntry).toHaveBeenCalledOnce();
  expect(f.runtime.cleanup).not.toHaveBeenCalled();
  await expect(executor.start('candidate')).rejects.toThrow('cannot launch');
  await expect(executor.stop('candidate')).rejects.toThrow('cannot launch');
  await expect(executor.rebind('expert', 'other')).rejects.toThrow('cannot launch');
});
it.each(['grant', 'generation', 'recipe', 'candidate', 'issuer'])(
  'retains held recovery when %s changes during inspection',
  async (kind) => {
    const f = fixture(),
      actor = f.capture()!,
      executor = actor.inspect(f.record);
    f.runtime.plans.account.mockImplementationOnce(async () => {
      if (kind === 'grant') f.employees[1].permissions.managePlans = false;
      if (kind === 'generation') f.employees[0].sessionGeneration++;
      if (kind === 'recipe') f.candidate.workingDir = '/changed';
      if (kind === 'candidate') f.sessions.set('candidate', { ...f.candidate });
      if (kind === 'issuer') f.revoked();
      return { provider: 'openai', id: 'plan' };
    });
    const save = vi.fn(async () => {}),
      moves = new PlanMoves({
        ...executor,
        load: async () => [f.record],
        save,
        recoveryPending: async () => {},
        recoveryConfirmed: async () => {},
      });
    await expect(
      moves.resolve('held', { oldSession: 'old', newSession: 'candidate', toAccount: 'plan' }, undefined, executor)
    ).rejects.toThrow();
    expect((await moves.get('held'))?.phase).toBe('recovery-required');
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  }
);
it('status authority survives a missing cleaned candidate but inspection does not invent one', () => {
  const f = fixture();
  f.sessions.delete('candidate');
  const actor = f.capture()!;
  expect(actor).toBeDefined();
  expect(() => actor.inspect(f.record)).toThrow('exact recorded current destination');
  f.employees[1].permissions.managePlans = false;
  expect(() => actor.assertCurrent()).toThrow();
});
it('self permission cannot inspect another employee; same-owner and exact journal tuple remain mandatory', () => {
  const f = fixture();
  f.employees[1].permissions.managePlans = false;
  f.employees[1].permissions.moveOwnPlan = true;
  expect(f.capture()).toBeUndefined();
  f.employees[1].permissions.managePlans = true;
  const actor = f.capture()!;
  expect(() => actor.inspect({ ...f.record, newSession: 'other' })).toThrow();
  expect(() => actor.inspect({ ...f.record, owner: 'other-owner' })).toThrow();
});
