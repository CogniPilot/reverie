import { describe, it, expect, vi } from 'vitest';
import { reattachLaptops } from '../src/laptop-reconnect.js';
import { EmployeeSchema } from '../src/company-types.js';
import type { SessionState } from '../src/types.js';

function fixture() {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const employee = EmployeeSchema.parse({ id: 'jester', sessionId: sid, name: 'Jester', position: 'Expert', icon: 'J', expertise: ['coding'], createdAt: 1, desiredRunning: true });
  const saved = { id: sid, workingDir: '/workspace', mode: 'hands', status: 'idle', pid: null, __customModel: { endpointId: 'local', model: 'qwen' } } as unknown as SessionState;
  const deps = { inventory: vi.fn(async () => ({ runningSessionIds: [sid] })), employees: () => [employee], saved: () => saved,
    live: () => false, restore: vi.fn(async (_entry, allowed) => allowed()) };
  return { sid, employee, saved, deps };
}

describe('website reconnects existing laptops', () => {
  it('includes Hands with the same identity and private model bookkeeping', async () => {
    const f = fixture();
    expect((await reattachLaptops(f.deps)).connected).toEqual([f.sid]);
    expect(f.deps.restore.mock.calls[0][0].state).toBe(f.saved);
  });
  it('reconnects an employee without a subscription account first, and still tries the others when that one fails', async () => {
    const f = fixture();
    const planSid = '11111111-2222-3333-4444-555555555555';
    const recipe = { mode: 'claude', workingDir: '/workspace' };
    const plan = EmployeeSchema.parse({ ...f.employee, id: 'plan', sessionId: planSid,
      runtimeRecipe: { ...recipe, subscriptionProfile: { id: 'a', label: 'A', provider: 'anthropic' } } });
    const local = EmployeeSchema.parse({ ...f.employee,
      runtimeRecipe: { ...recipe, mode: 'hands', customModel: { endpointId: 'local', modelId: 'qwen' } } });
    const saved = new Map<string, SessionState>([[f.sid, f.saved], [planSid, { ...f.saved, id: planSid, mode: 'claude' }]]);
    const tried: string[] = [];
    const report = await reattachLaptops({
      inventory: async () => ({ runningSessionIds: [planSid, f.sid] }),
      // The subscription employee is first in the company list.
      employees: () => [plan, local],
      saved: (id) => saved.get(id),
      live: () => false,
      restore: async (entry) => { tried.push(entry.sessionId); return entry.sessionId !== f.sid; },
    });
    expect(tried).toEqual([f.sid, planSid]);
    expect(report).toEqual({ connected: [planSid], failed: [f.sid] });
  });
  it('never starts a missing laptop or reconnects a stopped, vacationed, foreign-owned or already-live expert', async () => {
    for (const change of ['missing', 'stopped', 'vacation', 'foreign', 'live', 'intentional-exit']) {
      const f = fixture();
      if (change === 'missing') f.deps.inventory.mockResolvedValue({ runningSessionIds: [] });
      if (change === 'stopped') f.employee.desiredRunning = false;
      if (change === 'vacation') f.employee.onVacation = true;
      if (change === 'foreign') f.saved.owner = 'someone-else';
      if (change === 'live') f.deps.live = () => true;
      if (change === 'intentional-exit') f.saved.status = 'stopped';
      expect((await reattachLaptops(f.deps)).connected).toEqual([]);
      expect(f.deps.restore).not.toHaveBeenCalled();
    }
  });
  it('rechecks owner intent during an awaited attachment before attaching', async () => {
    const f = fixture();
    f.deps.restore.mockImplementation(async (_entry, allowed) => { f.employee.desiredRunning = false; return allowed(); });
    expect((await reattachLaptops(f.deps)).failed).toEqual([f.sid]);
  });
  it('skips a saved record with another session identity', async () => {
    const f = fixture();
    f.saved.id = '11111111-1111-4111-8111-111111111111';
    await reattachLaptops(f.deps);
    expect(f.deps.restore).not.toHaveBeenCalled();
  });
  it.each(['generation', 'migration', 'vacation'])('withdraws pending attachment after a %s change', async (change) => {
    const f = fixture();
    f.deps.restore.mockImplementation(async (_entry, allowed) => {
      if (change === 'generation') f.employee.sessionGeneration++;
      if (change === 'migration') f.employee.bindingMigration = { id: 'move', from: 'first', to: 'second' };
      if (change === 'vacation') f.employee.onVacation = true;
      return allowed();
    });
    expect(await reattachLaptops(f.deps)).toEqual({ connected: [], failed: [f.sid] });
  });
  it('fails closed against old or malformed broker inventories', async () => {
    const f = fixture(); f.deps.inventory.mockResolvedValue({ runningSessionIds: ['--bad'] });
    await expect(reattachLaptops(f.deps)).rejects.toThrow('verified session inventory');
    expect(f.deps.restore).not.toHaveBeenCalled();
  });
});
