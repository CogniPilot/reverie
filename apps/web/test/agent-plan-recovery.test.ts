import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownPlanRecovery, OwnPlanRecoveries } from '../src/agent-plan-recovery.js';
import { PlanMoves, type PlanMoveRecord } from '../src/plan-move.js';
import { PlanMoveRequests, type PlanRequestRecord } from '../src/plan-request.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import { registerPlanMoveRoutes } from '../src/web/routes/plan-move-routes.js';
import { composerReadyMark } from '../src/cli-agent.js';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
function fixture() {
  const session = { id: 'destination', owner: undefined, pid: 12, muxName: 'pane', mode: 'codex', isWorking: false,
    subscriptionProfile: { id: 'target' }, toState: () => ({ mode: 'codex', workingDir: '/synthetic' }) };
  const employee = { id: 'expert', owner: undefined, sessionId: session.id, sessionGeneration: 6,
    desiredRunning: true, onVacation: false, bindingMigration: undefined, permissions: { moveOwnPlan: true, managePlans: false } };
  const runtime: any = {
    sessions: new Map([[session.id, session]]), company: { view: () => ({ employees: [employee] }) },
    plans: { account: vi.fn(async () => ({ provider: 'openai', id: 'target', profileId: 'target' })),
      allocations: vi.fn(async () => ({ accounts: [{ id: 'target', sessionIds: [session.id] }] })) },
    mux: { isPaneDead: vi.fn(() => false), capturePaneText: vi.fn(() => composerReadyMark('codex')) },
    chat: { rooms: () => [], auditEntry: vi.fn(async () => {}) }, cleanup: vi.fn(),
  };
  const request = { headers: { 'x-reverie-parent-session': session.id } } as unknown as FastifyRequest;
  const record: PlanMoveRecord = { id: 'existing', employeeId: employee.id, name: 'Expert', oldSession: 'source',
    newSession: session.id, fromAccount: 'origin', toAccount: 'target', phase: 'recovery-required', at: 1,
    sourceStopRequested: true, sourceCleanupVerified: true };
  const capture = () => ownPlanRecovery(request, runtime);
  return { session, employee, runtime, request, record, capture };
}
async function journal(h: ReturnType<typeof fixture>) {
  const directory = await mkdtemp(join(tmpdir(), 'own-recovery-')); temporary.push(directory);
  const store = new PlanMoveStore(join(directory, 'moves.json'));
  await store.save([h.record]);
  const actor = h.capture()!;
  const moves = new PlanMoves({ ...actor.executor, load: () => store.load(), save: rows => store.save(rows),
    recoveryPending: row => store.recoveryPending(row), recoveryConfirmed: row => store.recoveryConfirmed(row) });
  return { store, moves, actor, directory };
}
const expected = { oldSession: 'source', newSession: 'destination', toAccount: 'target' };

describe('current holder own existing plan recovery', () => {
  it('uses the real runtime verifier and durable ACK, then remains unlocked after journal reload without launches', async () => {
    const h = fixture(), j = await journal(h);
    await expect(j.moves.assertAvailable('expert')).rejects.toMatchObject({ blocker: { id: 'existing', action: 'inspect-existing' } });
    const completed = await j.moves.resolve('existing', expected, undefined, j.actor.executor);
    expect(completed.phase).toBe('completed');
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
    const files = await readdir(j.directory);
    expect(files.some(name => name.endsWith('.pending.json'))).toBe(true);
    expect(files.some(name => name.endsWith('.verified.json'))).toBe(true);
    const reopened = new PlanMoves({ ...j.actor.executor, load: () => new PlanMoveStore(j.store.file).load(),
      save: rows => j.store.save(rows) });
    await expect(reopened.assertAvailable('expert')).resolves.toBeUndefined();
    expect((await reopened.get('existing'))?.phase).toBe('completed');
    await expect(j.actor.executor.create({} as never, undefined)).rejects.toThrow();
  });
  it.each(['grant', 'sid', 'generation', 'session', 'owner', 'vacation', 'off'] as const)('refuses fresh %s drift at the retained authority fence', async change => {
    const h = fixture(), actor = h.capture()!;
    if (change === 'grant') h.employee.permissions.moveOwnPlan = false;
    if (change === 'sid') h.employee.sessionId = 'elsewhere';
    if (change === 'generation') h.employee.sessionGeneration++;
    if (change === 'session') h.runtime.sessions.set(h.session.id, { ...h.session });
    if (change === 'owner') (h.employee as any).owner = 'other';
    if (change === 'vacation') h.employee.onVacation = true;
    if (change === 'off') h.employee.desiredRunning = false;
    expect(() => actor.assertCurrent()).toThrow('changed');
    await expect(actor.executor.verifyRecovery!(h.record)).rejects.toThrow();
  });
  it('does not infer permission from another employee or an absent/short/foreign caller', () => {
    const h = fixture(); h.employee.permissions.moveOwnPlan = false;
    expect(h.capture()).toBeUndefined();
    h.employee.permissions.moveOwnPlan = true;
    for (const value of [undefined, 'dest', 'someone-else']) {
      (h.request.headers as any)['x-reverie-parent-session'] = value;
      expect(h.capture()).toBeUndefined();
    }
  });
  it.each(['cleanup', 'source-live', 'account', 'composer', 'destination-dead', 'other-employee'] as const)('keeps the hold on %s mismatch without replay', async change => {
    const h = fixture();
    if (change === 'cleanup') h.record.sourceCleanupVerified = false;
    if (change === 'source-live') h.runtime.sessions.set('source', { ...h.session, id: 'source' });
    if (change === 'account') h.runtime.plans.allocations.mockResolvedValue({ accounts: [] });
    if (change === 'composer') h.runtime.mux.capturePaneText.mockReturnValue('not ready');
    if (change === 'destination-dead') h.runtime.mux.isPaneDead.mockReturnValue(true);
    if (change === 'other-employee') h.record.employeeId = 'other';
    // A contradictory cleanup journal is refused by the normal Store, before recovery.
    if (change === 'cleanup') {
      const actor = h.capture()!;
      await expect(actor.executor.verifyRecovery!(h.record)).rejects.toThrow();
      return;
    }
    const j = await journal(h);
    await expect(j.moves.resolve('existing', expected, undefined, j.actor.executor)).rejects.toThrow();
    expect((await j.moves.get('existing'))?.phase).toBe('recovery-required');
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
  });
  it('rechecks grant after awaited allocation inspection and retains the hold', async () => {
    const h = fixture(), j = await journal(h);
    h.runtime.plans.allocations.mockImplementation(async () => {
      h.employee.permissions.moveOwnPlan = false;
      return { accounts: [{ id: 'target', sessionIds: [h.session.id] }] };
    });
    await expect(j.moves.resolve('existing', expected, undefined, j.actor.executor)).rejects.toThrow();
    expect((await j.moves.get('existing'))?.phase).toBe('recovery-required');
  });
  it('retains a hold on revocation before ACK, then permits one fresh authorized adoption without deleting receipts', async () => {
    const h = fixture(), j = await journal(h);
    const original = j.store.save.bind(j.store);
    let revoke = true;
    j.store.save = async rows => {
      await original(rows);
      if (revoke && rows.some(row => row.phase === 'completed')) {
        revoke = false; h.employee.permissions.moveOwnPlan = false;
      }
    };
    await expect(j.moves.resolve('existing', expected, undefined, j.actor.executor)).rejects.toThrow();
    expect((await j.moves.get('existing'))?.phase).toBe('recovery-required');
    expect((await readdir(j.directory)).some(name => name.endsWith('.verified.json'))).toBe(false);
    h.employee.permissions.moveOwnPlan = true;
    const committed = await j.moves.resolve('existing', expected, undefined, h.capture()!.executor);
    expect(committed.phase).toBe('completed');
    expect((await new PlanMoveStore(j.store.file).load())[0]).toEqual(committed);
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
  });
  it('does not roll back or relock verified completion when permission changes after the durable ACK commitpoint', async () => {
    const h = fixture(), j = await journal(h);
    const original = j.store.recoveryConfirmed.bind(j.store);
    j.store.recoveryConfirmed = async row => { await original(row); h.employee.permissions.moveOwnPlan = false; };
    const committed = await j.moves.resolve('existing', expected, undefined, j.actor.executor);
    expect(committed.phase).toBe('completed');
    expect(() => j.actor.assertCurrent()).toThrow();
    await expect(j.moves.assertAvailable('expert')).resolves.toBeUndefined();
    h.employee.permissions.moveOwnPlan = true;
    const fresh = h.capture()!;
    expect(await j.moves.resolve('existing', expected, undefined, fresh.executor)).toEqual(committed);
    const reopened = new PlanMoves({ ...fresh.executor, load: () => new PlanMoveStore(j.store.file).load(), save: rows => j.store.save(rows) });
    expect(await reopened.get('existing')).toEqual(committed);
    await expect(reopened.assertAvailable('expert')).resolves.toBeUndefined();
  });
  it('limits discovery/status to this permanent employee and refuses malformed or stale adoption tuples', async () => {
    const h = fixture(), j = await journal(h), app = Fastify();
    registerPlanMoveRoutes(app, j.moves, { authSessions: null }, undefined, undefined, undefined, req => ownPlanRecovery(req, h.runtime));
    const headers = h.request.headers as Record<string, string>;
    try {
      expect((await app.inject({ method: 'POST', url: '/api/plans/agent-moves/current', headers, payload: {} })).json().data).toHaveLength(1);
      expect((await app.inject({ method: 'POST', url: '/api/plans/agent-moves/missing/status', headers, payload: {} })).statusCode).toBe(404);
      const stale = await app.inject({ method: 'POST', url: '/api/plans/agent-moves/existing/resolve', headers,
        payload: { action: 'adopt-existing', ...expected, toAccount: 'different' } });
      expect(stale.statusCode).toBe(409);
      const success = await app.inject({ method: 'POST', url: '/api/plans/agent-moves/existing/resolve', headers,
        payload: { action: 'adopt-existing', ...expected } });
      expect(success.statusCode).toBe(202); expect(success.json().recovery.state).toBe('waiting-for-idle');
      for (let n = 0; n < 50 && (await j.moves.get('existing'))?.phase !== 'completed'; n++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect((await j.moves.get('existing'))?.phase).toBe('completed');
      expect(h.runtime.cleanup).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});


describe('one explicitly queued busy-self recovery', () => {
  async function settled(queue: OwnPlanRecoveries): Promise<string | undefined> {
    for (let n = 0; n < 100; n++) {
      const state = queue.status('existing', 'expert')?.state;
      if (state === 'completed' || state === 'refused') return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return queue.status('existing', 'expert')?.state;
  }
  it('returns queued while the real caller is working, coalesces duplicates, then adopts only after its turn ends', async () => {
    const h = fixture(), j = await journal(h), queue = new OwnPlanRecoveries(j.moves);
    h.session.isWorking = true;
    const resolve = vi.spyOn(j.moves, 'resolve');
    const input = { ...expected };
    expect(queue.enqueue(h.record, input, j.actor)).toEqual({ state: 'waiting-for-idle' });
    expect(queue.enqueue(h.record, input, j.actor)).toEqual({ state: 'waiting-for-idle' });
    input.toAccount = 'mutated-after-enqueue';
    expect(resolve).not.toHaveBeenCalled();
    expect((await j.moves.get('existing'))?.phase).toBe('recovery-required');
    h.session.isWorking = false; // the tool response released the caller's turn
    expect(await settled(queue)).toBe('completed');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][1]).toEqual(expected);
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
    await queue.close();
  });
  it.each(['grant', 'generation', 'source-cleanup'] as const)('keeps the journal held when %s changes before idle adoption', async change => {
    const h = fixture(), j = await journal(h), queue = new OwnPlanRecoveries(j.moves);
    h.session.isWorking = true;
    if (change === 'source-cleanup') {
      expect(() => queue.enqueue({ ...h.record, sourceCleanupVerified: false }, expected, j.actor)).toThrow('cleanup');
    } else {
      queue.enqueue(h.record, expected, j.actor);
      if (change === 'grant') h.employee.permissions.moveOwnPlan = false;
      else h.employee.sessionGeneration++;
      h.session.isWorking = false;
      expect(await settled(queue)).toBe('refused');
    }
    expect((await j.moves.get('existing'))?.phase).toBe('recovery-required');
    expect(h.runtime.cleanup).not.toHaveBeenCalled();
    await queue.close();
  });
  it('retains the existing five-minute idle deadline and aborts without launch on application close', async () => {
    const h = fixture(), j = await journal(h), queue = new OwnPlanRecoveries(j.moves);
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      h.session.isWorking = true;
      queue.enqueue(h.record, expected, j.actor);
      now = 5 * 60_000 + 1;
      expect(await settled(queue)).toBe('refused');
      expect(queue.status('existing', 'expert')?.error).toContain('five minutes');
      expect((await j.moves.get('existing'))?.phase).toBe('recovery-required');
    } finally { clock.mockRestore(); await queue.close(); }
    const other = fixture(), second = await journal(other), stopping = new OwnPlanRecoveries(second.moves);
    other.session.isWorking = true;
    stopping.enqueue(other.record, expected, second.actor);
    await stopping.close();
    expect(stopping.status('existing', 'expert')?.state).toBe('refused');
    expect((await second.moves.get('existing'))?.phase).toBe('recovery-required');
    expect(other.runtime.cleanup).not.toHaveBeenCalled();
  });
});


describe('request readers cannot publish provisional plain adoption', () => {
  it.each([false, true])('keeps request held before the ACK and handles ACK success=%s without cached false completion', async succeed => {
    const h = fixture(), j = await journal(h);
    let requestRows: PlanRequestRecord[] = [{ id: 'existing', employeeId: 'expert', sessionId: 'source', newSession: 'destination',
      name: 'Expert', fromAccount: 'origin', toAccount: 'target', mode: 'codex', phase: 'recovery-required',
      createdAt: 1, expiresAt: 2, notified: true }];
    const saved: PlanRequestRecord[][] = [];
    const requests = new PlanMoveRequests({ load: async () => requestRows, save: async rows => {
      requestRows = structuredClone(rows); saved.push(structuredClone(rows));
    }, moves: j.moves, binding: () => h.employee.sessionId, validateTarget: async () => {},
    capability: { write: async () => '', remove: async () => {} }, notify: async () => {}, audit: async () => {} });
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = j.store.recoveryConfirmed.bind(j.store);
    j.store.recoveryConfirmed = async row => {
      entered(); await gate;
      if (!succeed) throw new Error('controlled ACK refusal');
      await original(row);
    };
    const resolving = j.moves.resolve('existing', expected, undefined, j.actor.executor);
    const observed = resolving.then(value => ({ value }), error => ({ error }));
    await waiting;
    let provisional: PlanMoveRecord | undefined, requestPhaseBeforeACK: string | undefined;
    let cachedCompletedBeforeACK = false;
    try {
      provisional = await j.moves.get('existing');
      requestPhaseBeforeACK = (await requests.get('existing')).phase;
      cachedCompletedBeforeACK = saved.some(rows => rows.some(row => row.phase === 'completed'));
    } finally { release(); }
    const outcome = await observed; // settle the actor before assertions/fixture cleanup, even for RED
    expect(requestPhaseBeforeACK).toBe('recovery-required');
    expect(provisional?.phase).toBe('checking');
    expect(provisional).not.toHaveProperty('resourcePhase');
    expect(cachedCompletedBeforeACK).toBe(false);
    if (succeed) {
      expect(outcome).toHaveProperty('value.phase', 'completed');
      expect((await requests.get('existing')).phase).toBe('completed');
      expect((await new PlanMoveStore(j.store.file).load())[0].phase).toBe('completed');
    } else {
      expect(outcome).toHaveProperty('error');
      expect((await j.moves.get('existing'))?.phase).toBe('recovery-required');
      expect((await requests.get('existing')).phase).toBe('recovery-required');
      expect(saved.some(rows => rows.some(row => row.phase === 'completed'))).toBe(false);
      expect((await new PlanMoveStore(j.store.file).load())[0].phase).toBe('recovery-required');
    }
  });
});
