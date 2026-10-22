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
    mux: { isPaneDead: () => false },
    chat: {},
    cleanup: vi.fn(),
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
  it('defaults both capabilities off; rejects titles, temporary agents, stale sessions and another owner', () => {
    expect(EmployeePermissionsSchema.parse({})).toEqual({
      recoverEmployees: false,
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
});
