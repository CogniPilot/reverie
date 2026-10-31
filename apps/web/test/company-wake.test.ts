import { describe, it, expect, vi } from 'vitest';
import { CompanyWake, companyWakeOrder } from '../src/company-wake.js';
import { CompanyStateSchema, EmployeeSchema, CompanySettingsSchema } from '../src/company-types.js';
import type { SessionState } from '../src/types.js';

function fixture() {
  const employee = (id: string, reportsTo?: string, position = 'Expert') =>
    EmployeeSchema.parse({
      id,
      sessionId: 'session-' + id,
      name: id,
      icon: '🌱',
      position,
      expertise: ['systems'],
      reportsTo,
      createdAt: id.length,
      desiredRunning: true,
    });
  const first = employee('root', 'owner', 'COO');
  const second = employee('report', first.id, 'CTO');
  const state = CompanyStateSchema.parse({
    version: 1,
    employees: [first, second],
    settings: [],
    cycles: [],
    memories: [],
  });
  const [root, report] = state.employees;
  const saved = new Map(
    state.employees.map((e) => [
      e.sessionId,
      {
        id: e.sessionId,
        name: e.name,
        pid: 42,
        status: 'idle',
        workingDir: '/workspace',
        mode: 'claude',
        claudeSessionId: 'thread-' + e.id,
      } as SessionState,
    ])
  );
  const live = new Set<string>();
  const closing = new Set<string>();
  const kickoff = vi.fn(async () => {});
  const wake = vi.fn(async (entry, allowed) => {
    if (!allowed()) return false;
    live.add(entry.sessionId);
    return true;
  });
  const claim = vi.fn(async (id: string, sessionId: string, now: number) => {
    const e = state.employees.find((e) => e.id === id && e.sessionId === sessionId);
    if (!e || e.desiredRunning === false) return false;
    const recent = e.wakeAttempts.filter((at) => at > now - 900000);
    if (recent.length >= 3) return false;
    e.wakeAttempts = [...recent, now];
    return true;
  });
  const deps = {
    company: () => state,
    saved: (id: string) => saved.get(id),
    live: (id: string) => live.has(id),
    closing: (id: string) => closing.has(id),
    noteRunning: vi.fn(async () => {}),
    begin: () => ({ current: () => true, finish: () => {} }),
    claim,
    wake,
    kickoff,
    now: () => 1000000,
  };
  return { state, saved, live, closing, deps, root, report, employee };
}

describe('company crash recovery selection', () => {
  it.each(['hands', 'codex', 'claude'])('an explicit office entry starts a stopped %s report without changing its saved recipe', async (mode) => {
    const f = fixture();
    const saved = f.saved.get(f.report.sessionId)!;
    Object.assign(saved, { mode, status: 'stopped', pid: null, paneExit: { status: 0 }, respawnBlocked: true });
    const original = structuredClone(saved);
    const recovery = new CompanyWake(f.deps);
    expect((await recovery.wakeOne(f.report.id)).awakened).toEqual([]);
    expect((await recovery.wakeOne(f.report.id, { explicitStart: true })).awakened).toEqual([f.report.id]);
    expect(f.deps.claim).toHaveBeenCalledWith(f.report.id, f.report.sessionId, expect.any(Number), false);
    expect(f.deps.wake).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: f.report.sessionId, mode,
      state: expect.objectContaining({ status: 'idle', respawnBlocked: false }),
    }), expect.any(Function));
    expect(saved).toEqual(original);
    expect(f.deps.kickoff).not.toHaveBeenCalled();
  });

  it('an office entry still respects a stop received while the start is being claimed', async () => {
    const f = fixture();
    f.saved.get(f.report.sessionId)!.status = 'stopped';
    f.deps.claim.mockImplementation(async () => { f.report.desiredRunning = false; return true; });
    const result = await new CompanyWake(f.deps).wakeOne(f.report.id, { explicitStart: true });
    expect(result.awakened).toEqual([]);
    expect(f.deps.wake).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual({ employeeId: f.report.id, reason: 'changed-or-stopping' });
  });

  it.each([false, true])('queues an owner office entry behind recovery and rechecks stopped intent (%s)', async (stop) => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.deps.wake.mockImplementationOnce(async () => { await held; return true; });
    const recovery = new CompanyWake(f.deps);
    const first = recovery.wakeOne(f.root.id);
    const queued = recovery.wakeOne(f.report.id, { explicitStart: true });
    if (stop) f.report.desiredRunning = false;
    release();
    await first;
    expect((await queued).awakened).toEqual(stop ? [] : [f.report.id]);
    expect(f.deps.wake).toHaveBeenCalledTimes(stop ? 1 : 2);
  });

  it('never wakes vacationed employees even with stale running intent or a manual request', async () => {
    const f = fixture(); f.root.onVacation = true;
    const recovery = new CompanyWake(f.deps);
    expect((await recovery.tick()).awakened).toEqual([]);
    expect((await recovery.wakeOne(f.root.id)).awakened).toEqual([]);
    expect(f.deps.wake).not.toHaveBeenCalled();
  });

  it('automatically wakes the sole COO root, never its CTO report, and prompts once', async () => {
    const f = fixture();
    const recovery = new CompanyWake(f.deps);
    expect((await recovery.tick()).awakened).toEqual(['root']);
    expect(f.deps.wake).toHaveBeenCalledTimes(1);
    expect(f.deps.kickoff).toHaveBeenCalledWith(f.root, expect.any(Function));
    await recovery.tick();
    expect(f.deps.wake).toHaveBeenCalledTimes(1);
    expect(f.deps.kickoff).toHaveBeenCalledTimes(1);
  });
  it('a crashed pid-null session restarts from persisted intent, but a live stopped-intent expert stays stopped', async () => {
    const f = fixture();
    f.saved.get(f.root.sessionId)!.pid = null;
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual(['root']);
    f.root.desiredRunning = false;
    await new CompanyWake(f.deps).tick();
    expect(f.deps.noteRunning).not.toHaveBeenCalled();
    expect(f.root.desiredRunning).toBe(false);
  });
  it('does not wake a process that became live while its persistent claim was awaited', async () => {
    const f = fixture();
    f.deps.claim.mockImplementation(async () => {
      f.live.add(f.root.sessionId);
      return true;
    });
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
    expect(f.deps.wake).not.toHaveBeenCalled();
  });
  it('multiple roots require owner selection; any active expert may be selected', async () => {
    const f = fixture();
    f.state.employees.push(f.employee('second', 'owner', 'COO'));
    const recovery = new CompanyWake(f.deps);
    expect((await recovery.tick()).awakened).toEqual([]);
    f.state.settings = [CompanySettingsSchema.parse({ crashWakeEmployeeId: 'report' })];
    expect((await recovery.tick()).awakened).toEqual(['report']);
  });
  it('missing or cyclic parents never create accidental default roots', async () => {
    const f = fixture();
    f.root.reportsTo = 'missing';
    expect(companyWakeOrder(f.state).employees).toEqual([]);
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
    f.root.reportsTo = 'report';
    expect(companyWakeOrder(f.state).employees).toEqual([]);
  });
  it('retired or missing explicit selection fails closed without falling back', async () => {
    const f = fixture();
    f.state.settings = [CompanySettingsSchema.parse({ crashWakeEmployeeId: 'retired' })];
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
  });
  it('disabled recovery and intentionally stopped experts stay stopped after restart', async () => {
    const f = fixture();
    f.root.desiredRunning = false;
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
    f.root.desiredRunning = true;
    f.state.settings = [CompanySettingsSchema.parse({ autoWakeEnabled: false })];
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
  });
  it.each([{ status: 'stopped' }, { paneExit: { status: 0 } }, { respawnBlocked: true }])(
    'preserves saved intentional exit and pause guards %j',
    async (override) => {
      const f = fixture();
      Object.assign(f.saved.get(f.root.sessionId)!, override);
      expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
    }
  );
  it('persists a bounded retry budget across coordinator restarts, never wakes reports on failure', async () => {
    const f = fixture();
    f.deps.wake.mockResolvedValue(false);
    for (let i = 0; i < 6; i++) await new CompanyWake(f.deps).tick();
    expect(f.deps.wake).toHaveBeenCalledTimes(3);
    expect(f.deps.kickoff).not.toHaveBeenCalled();
    expect(f.report.wakeAttempts).toEqual([]);
  });
  it('serializes overlapping passes, preserves stable agent IDs and uses current session/model binding', async () => {
    const f = fixture();
    f.state.settings = [CompanySettingsSchema.parse({ crashWakeEmployeeId: f.root.id })];
    const previous = f.saved.get(f.root.sessionId)!;
    f.root.sessionId = 'new-runtime';
    f.saved.set('new-runtime', {
      ...previous,
      id: 'new-runtime',
      mode: 'opencode',
      openCodeConfig: { continueSession: 'ses_new' },
    } as SessionState);
    const recovery = new CompanyWake(f.deps);
    const a = recovery.tick();
    const b = recovery.tick();
    expect(a).toBe(b);
    expect((await a).awakened).toEqual(['root']);
    expect(f.deps.wake.mock.calls[0][0].sessionId).toBe('new-runtime');
    expect(f.deps.wake.mock.calls[0][0].mode).toBe('opencode');
  });
  it('rechecks selection and stop intent after awaiting the persistent claim', async () => {
    const f = fixture();
    f.deps.claim.mockImplementation(async () => {
      f.state.settings = [CompanySettingsSchema.parse({ crashWakeEmployeeId: 'report' })];
      return true;
    });
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
    expect(f.deps.wake).not.toHaveBeenCalled();
    f.state.settings = [];
    f.deps.claim.mockImplementation(async () => {
      f.root.desiredRunning = false;
      return true;
    });
    expect((await new CompanyWake(f.deps).tick()).awakened).toEqual([]);
  });
  it('a wake that throws after it was called is unconfirmed, never "did not start"; a throw before it is wake-failed', async () => {
    const f = fixture();
    const recovery = new CompanyWake(f.deps);
    f.deps.wake.mockRejectedValueOnce(new Error('lost after the session was created'));
    expect(await recovery.wakeOne(f.report.id)).toEqual({ awakened: [], skipped: [{ employeeId: 'report', reason: 'start-unconfirmed' }] });
    expect(f.deps.kickoff).not.toHaveBeenCalled();
    const before = fixture();
    before.deps.claim.mockRejectedValueOnce(new Error('store unavailable'));
    expect(await new CompanyWake(before.deps).wakeOne(before.report.id)).toEqual({ awakened: [], skipped: [{ employeeId: 'report', reason: 'wake-failed' }] });
    expect(before.deps.wake).not.toHaveBeenCalled();
    const refused = fixture();
    refused.deps.wake.mockResolvedValueOnce(false);
    expect((await new CompanyWake(refused.deps).wakeOne(refused.report.id)).skipped).toEqual([{ employeeId: 'report', reason: 'wake-failed' }]);
  });

  it('explicit delegated wake starts a report without another kickoff or duplicate process', async () => {
    const f = fixture();
    const recovery = new CompanyWake(f.deps);
    expect((await recovery.wakeOne(f.report.id)).awakened).toEqual(['report']);
    await recovery.wakeOne(f.report.id);
    expect(f.deps.wake).toHaveBeenCalledTimes(1);
    expect(f.deps.kickoff).not.toHaveBeenCalled();
  });
});
