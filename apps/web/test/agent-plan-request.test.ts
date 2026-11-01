import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { agentPlanRequestExecution } from '../src/agent-plan-request.js';
import type { PlanMoveRuntime } from '../src/plan-move-runtime.js';
import { hasDelegatedSessionCreate } from '../src/owner-auth/delegated-session-create.js';
import { EmployeePermissionsSchema } from '../src/company-types.js';

function fixture(manager = false) {
  const pane = (id: string) => ({
    id,
    owner: undefined,
    pid: 12,
    muxName: id,
    isWorking: false,
    name: id,
    toState: () => ({ id, mode: 'codex', workingDir: '/synthetic', name: id }),
  });
  const sessions = new Map<string, any>([
    ['source', pane('source')],
    ['manager-session', pane('manager-session')],
  ]);
  const employees = [
    { id: 'expert', sessionId: 'source', permissions: { moveOwnPlan: !manager, managePlans: false } },
    { id: 'manager', sessionId: 'manager-session', permissions: { moveOwnPlan: false, managePlans: manager } },
  ];
  const runtime: any = {
    sessions,
    company: { view: () => ({ employees }) },
    plans: {
      allocations: async () => ({ accounts: [{ id: 'old-plan', sessionIds: ['source'] }] }),
      account: async () => ({ provider: 'anthropic', id: 'target', profileId: 'target' }),
    },
    mux: { isPaneDead: () => false, getSession: () => ({ pid: 12 }) },
    capture: async () => [{ pid: 12, start: 'fixture' }],
    survivors: async () => [],
    chat: {},
    cleanup: vi.fn(async (id: string) => { sessions.delete(id); }),
  };
  const invoke = vi.fn(async (_method: string, url: string, payload?: any) => {
    expect(hasDelegatedSessionCreate()).toBe(true);
    if (url === '/api/sessions') {
      expect(payload).toMatchObject({
        employeeId: 'expert',
        parentSessionId: 'source',
        mode: 'claude',
        subscriptionProfileId: 'target',
      });
      sessions.set('candidate', pane('candidate'));
      employees[0].sessionId = 'candidate';
      return { success: true, data: { session: { id: 'candidate' } } };
    }
    return { success: true };
  });
  const input = { employeeId: 'expert', sessionId: 'source' };
  const request = {
    headers: { 'x-reverie-parent-session': manager ? 'manager-session' : 'source' },
  } as unknown as FastifyRequest;
  const capture = () => agentPlanRequestExecution(request, input, runtime as PlanMoveRuntime, invoke);
  return { runtime, sessions, employees, invoke, input, request, capture };
}
const move = {
  id: 'move',
  employeeId: 'expert',
  sessionId: 'source',
  fromAccount: 'old-plan',
  toAccount: 'target',
  handoff: 'Finish the report.',
  forceBusy: false,
};
describe('explicit agent plan delegation', () => {
  it('keeps runtime refresh self-only even for a manager and still requires current granted permission', () => {
    const own = fixture();
    expect(agentPlanRequestExecution(own.request, { ...own.input, purpose: 'runtime-refresh' },
      own.runtime as PlanMoveRuntime, own.invoke)).toBeDefined();
    own.employees[0].permissions.moveOwnPlan = false;
    expect(agentPlanRequestExecution(own.request, { ...own.input, purpose: 'runtime-refresh' },
      own.runtime as PlanMoveRuntime, own.invoke)).toBeUndefined();
    const manager = fixture(true);
    expect(agentPlanRequestExecution(manager.request, { ...manager.input, purpose: 'runtime-refresh' },
      manager.runtime as PlanMoveRuntime, manager.invoke)).toBeUndefined();
    expect(manager.invoke).not.toHaveBeenCalled();
  });
  it('defaults both capabilities off; rejects titles, temporary agents, stale sessions and another owner', () => {
    expect(EmployeePermissionsSchema.parse({})).toEqual({
      recoverEmployees: false,
      manageOffice: false,
      moveOwnPlan: false,
      managePlans: false,
    });
    const h = fixture();
    h.employees[0].permissions.moveOwnPlan = false;
    expect(h.capture()).toBeUndefined();
    h.employees[0].permissions.moveOwnPlan = true;
    h.employees[0].sessionId = 'elsewhere';
    expect(h.capture()).toBeUndefined();
    h.employees[0].sessionId = 'source';
    h.sessions.get('source').owner = 'someone-else';
    expect(h.capture()).toBeUndefined();
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it('authorizes own moves only, while a separately granted manager may request the target expert’s move', async () => {
    const own = fixture();
    expect(own.capture()?.requestedBy).toBe('source');
    own.request.headers['x-reverie-parent-session'] = 'manager-session';
    expect(own.capture()).toBeUndefined();
    const h = fixture(true),
      execution = h.capture()!;
    expect(execution.requestedBy).toBe('manager-session');
    expect(await execution.executor.snapshot('expert')).toMatchObject({ sessionId: 'source', account: 'old-plan' });
    expect(await execution.executor.create(move, undefined)).toBe('candidate');
    expect(execution.authorized()).toBe(true); // only our own candidate may replace the source binding
    await execution.executor.start('candidate');
    expect(h.invoke).toHaveBeenNthCalledWith(2, 'POST', '/api/sessions/candidate/interactive', undefined);
    h.employees[1].permissions.managePlans = false;
    expect(execution.authorized()).toBe(false);
    await expect(execution.executor.start('candidate')).rejects.toThrow();
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });
  it('rechecks revocation, session replacement, vacation and unexpected rebinding before a launch', async () => {
    for (const mutate of [
      (h: ReturnType<typeof fixture>) => {
        h.employees[0].permissions.moveOwnPlan = false;
      },
      (h: ReturnType<typeof fixture>) => {
        h.sessions.set('source', { ...h.sessions.get('source') });
      },
      (h: ReturnType<typeof fixture>) => {
        (h.employees[0] as any).onVacation = true;
      },
      (h: ReturnType<typeof fixture>) => {
        h.employees[0].sessionId = 'unrelated';
      },
    ]) {
      const h = fixture(),
        execution = h.capture()!;
      mutate(h);
      expect(execution.authorized()).toBe(false);
      await expect(execution.executor.create(move, undefined)).rejects.toThrow();
      expect(h.invoke).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('retains exact approval after its intentional source stop (manager=%s)', async (manager) => {
    const h = fixture(manager), execution = h.capture()!;
    await execution.executor.create(move, undefined);
    await execution.executor.stop('source');
    expect(h.sessions.has('source')).toBe(false);
    expect(execution.authorized()).toBe(true);
    expect(execution.requestedBy).toBe(manager ? 'manager-session' : 'source');
    await execution.executor.start('candidate');
    expect(h.invoke).toHaveBeenLastCalledWith('POST', '/api/sessions/candidate/interactive', undefined);
  });

  it('never treats an unexpected missing source or failed cleanup as successful source-stop proof', async () => {
    for (const manager of [false, true]) {
      const h = fixture(manager), execution = h.capture()!;
      await execution.executor.create(move, undefined);
      h.sessions.delete('source');
      expect(execution.authorized()).toBe(false);
      await expect(execution.executor.start('candidate')).rejects.toThrow();
      expect(h.invoke).toHaveBeenCalledTimes(1);
      const failed = fixture(manager), pending = failed.capture()!;
      await pending.executor.create(move, undefined);
      failed.runtime.cleanup.mockImplementation(async () => { failed.sessions.delete('source'); throw new Error('cleanup failed'); });
      await expect(pending.executor.stop('source')).rejects.toThrow('cleanup failed');
      expect(pending.authorized()).toBe(false);
      await expect(pending.executor.start('candidate')).rejects.toThrow();
    }
  });

  it('rechecks fresh grants, intent and both captured identities after the approved source stop', async () => {
    const changes = [
      (h: ReturnType<typeof fixture>) => { h.employees[1].permissions.managePlans = false; },
      (h: ReturnType<typeof fixture>) => { (h.employees[0] as any).onVacation = true; },
      (h: ReturnType<typeof fixture>) => { (h.employees[1] as any).desiredRunning = false; },
      (h: ReturnType<typeof fixture>) => { (h.employees[0] as any).desiredRunning = false; },
      (h: ReturnType<typeof fixture>) => { h.sessions.set('source', { ...h.sessions.get('candidate'), id: 'source' }); },
      (h: ReturnType<typeof fixture>) => { h.sessions.set('candidate', { ...h.sessions.get('candidate') }); },
      (h: ReturnType<typeof fixture>) => { h.employees[0].sessionId = 'foreign'; },
      (h: ReturnType<typeof fixture>) => { h.sessions.set('manager-session', { ...h.sessions.get('manager-session') }); },
      (h: ReturnType<typeof fixture>) => { h.sessions.get('manager-session').owner = 'foreign-owner'; },
      (h: ReturnType<typeof fixture>) => { (h.employees[0] as any).owner = 'foreign-owner'; },
    ];
    for (const mutate of changes) {
      const h = fixture(true), execution = h.capture()!;
      await execution.executor.create(move, undefined);
      await execution.executor.stop('source');
      expect(execution.authorized()).toBe(true);
      mutate(h);
      expect(execution.authorized()).toBe(false);
      await expect(execution.executor.start('candidate')).rejects.toThrow();
      expect(h.invoke).toHaveBeenCalledTimes(1);
    }
  });
  it('does not clean a different object that reused the candidate identifier', async () => {
    const h = fixture(true), execution = h.capture()!;
    await execution.executor.create(move, undefined);
    await execution.executor.stop('source');
    const foreign = { ...h.sessions.get('candidate') };
    h.sessions.set('candidate', foreign);
    await expect(execution.executor.stop('candidate')).rejects.toThrow('candidate identity changed');
    expect(h.sessions.get('candidate')).toBe(foreign);
    expect(h.runtime.cleanup).toHaveBeenCalledTimes(1);
  });
  it('never admits a missing candidate, unrelated cleanup or expired post-stop authority', async () => {
    const absent = fixture(true), failed = absent.capture()!;
    absent.invoke.mockResolvedValue({ success: true, data: { session: { id: 'missing' } } });
    await expect(failed.executor.create(move, undefined)).rejects.toThrow('owned candidate');
    const h = fixture(true), execution = h.capture()!;
    await execution.executor.create(move, undefined);
    await expect(execution.executor.stop('manager-session')).rejects.toThrow('outside the approved');
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
    await execution.executor.stop('source');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
    try {
      expect(execution.authorized()).toBe(false);
      await expect(execution.executor.start('candidate')).rejects.toThrow();
      expect(h.invoke).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
});
