/** Actual CompanyService+CompanyWake, held synthetic starts; no engine or model. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyWake } from '../src/company-wake.js';
import { EmployeeSchema } from '../src/company-types.js';
import type { CompanyServiceDeps } from '../src/company-service.js';
import type { SessionState } from '../src/types.js';

const { startSession } = vi.hoisted(() => ({ startSession: vi.fn() }));
vi.mock('../src/session.js', () => ({
  Session: class {
    id: string;
    mode: string;
    name?: string;
    workingDir: string;
    owner?: string;
    constructor(config: { id: string; mode: string; name?: string; workingDir: string; owner?: string }) {
      Object.assign(this, config);
      this.id = config.id;
      this.mode = config.mode;
      this.workingDir = config.workingDir;
    }
    async startInteractive() {
      await startSession();
    }
    toState() {
      return { id: this.id, mode: this.mode, name: this.name, workingDir: this.workingDir, owner: this.owner };
    }
  },
}));
const { spendRebootRestore } = await import('../src/web/routes/reboot-restore-routes.js');
const { createMockRouteContext } = await import('./mocks/index.js');
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(running = true) {
  const directory = await mkdtemp(join(tmpdir(), 'lifecycle-fence-'));
  directories.push(directory);
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  await store.update((state) => {
    state.employees.push(
      EmployeeSchema.parse({
        id: 'employee',
        sessionId: 'current-session',
        name: 'Synthetic',
        position: 'Expert',
        expertise: ['systems'],
        icon: 'X',
        reportsTo: 'owner',
        createdAt: 1,
        desiredRunning: running,
      })
    );
  });
  const sessions = new Map([['new-session', { id: 'new-session', name: 'Synthetic', owner: undefined }]]);
  const service = new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    chatrooms: { rooms: () => [], replaceSession: async () => {} },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  } as unknown as CompanyServiceDeps);
  const live = new Set<string>(),
    discard = vi.fn();
  const deps = {
    company: () => store.snapshot(),
    saved: (id: string) =>
      ({
        id,
        name: 'Synthetic',
        pid: null,
        status: 'idle',
        mode: 'claude',
        workingDir: '/synthetic',
        claudeSessionId: 'old-recipe',
      }) as SessionState,
    live: (id: string) => live.has(id),
    closing: () => false,
    noteRunning: (id: string) => service.setDesiredRunning(id, true),
    begin: (id: string, session: string) => service.prepareWake(id, session),
    claim: vi.fn((id: string, session: string, now: number, automatic: boolean) =>
      service.claimWake(id, session, now, automatic)
    ),
    wake: vi.fn(async (_entry: unknown, allowed: () => boolean) => {
      if (!allowed()) return false;
      discard();
      return true;
    }),
    now: () => 1000000,
  };
  return { store, service, deps, recovery: new CompanyWake(deps), live, discard };
}

describe('shared owner restart/recovery in-flight fence', () => {
  it('a stale guarded stop cannot cancel a recovery already waiting on its durable claim', async () => {
    const f = await fixture(), claimed = gate(), release = gate();
    f.deps.claim.mockImplementation(async (...args) => {
      const ok = await f.service.claimWake(...args);
      claimed.resolve(); await release.promise; return ok;
    });
    const flight = f.recovery.tick();
    await claimed.promise;
    await f.service.setDesiredRunning('current-session', false, () => false);
    release.resolve();
    expect((await flight).awakened).toEqual(['employee']);
    expect(f.store.snapshot().employees[0].desiredRunning).toBe(true);
  });
  it('an explicit stop cancels a wake flight even when stopped intent is already durable', async () => {
    const f = await fixture(), flight = f.service.prepareWake('employee', 'current-session')!;
    try {
      await f.store.update(state => { state.employees[0].desiredRunning = false; });
      await f.service.setDesiredRunning('current-session', false);
      await f.store.update(state => { state.employees[0].desiredRunning = true; });
      expect(flight.current()).toBe(false);
    } finally { flight.finish(); }
  });
  it('owner start held before registration blocks automatic/manual old-recipe launch and direct wake claims', async () => {
    const f = await fixture(false),
      intent = f.service.prepareRuntimeRestart('current-session', undefined)!;
    await intent.claim();
    expect(intent.current()).toBe(true);
    expect((await f.recovery.tick()).awakened).toEqual([]);
    expect((await f.recovery.wakeOne('employee')).awakened).toEqual([]);
    expect(await f.service.claimWake('employee', 'current-session', 1000000)).toBe(false);
    expect(f.store.snapshot().employees[0].wakeAttempts).toEqual([]);
    expect(f.deps.wake).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
    f.live.add('current-session');
    intent.finish();
    await f.recovery.tick();
    expect(f.deps.wake).not.toHaveBeenCalled();
  });
  it('wake already past async claim excludes owner restart until registration completes', async () => {
    const f = await fixture(),
      claimed = gate(),
      releaseClaim = gate(),
      started = gate(),
      releaseStart = gate();
    f.deps.claim.mockImplementation(async (...args) => {
      const ok = await f.service.claimWake(...args);
      claimed.resolve();
      await releaseClaim.promise;
      return ok;
    });
    f.deps.wake.mockImplementation(async (_entry, allowed) => {
      started.resolve();
      await releaseStart.promise;
      if (!allowed()) return false;
      f.live.add('current-session');
      return true;
    });
    const flight = f.recovery.tick();
    await claimed.promise;
    expect(() => f.service.prepareRuntimeRestart('current-session', undefined)).toThrow('already restarting');
    releaseClaim.resolve();
    await started.promise;
    expect(() => f.service.prepareRuntimeRestart('current-session', undefined)).toThrow('already restarting');
    releaseStart.resolve();
    expect((await flight).awakened).toEqual(['employee']);
    const intent = f.service.prepareRuntimeRestart('current-session', undefined)!;
    expect(intent.current()).toBe(true);
    intent.finish();
  });
  it.each(['stop', 'vacation', 'rebind'])('%s wins while an actual recovery claim is held', async (kind) => {
    const f = await fixture(),
      claimed = gate(),
      release = gate();
    f.deps.claim.mockImplementation(async (...args) => {
      const ok = await f.service.claimWake(...args);
      claimed.resolve();
      await release.promise;
      return ok;
    });
    const flight = f.recovery.tick();
    await claimed.promise;
    if (kind === 'stop') await f.service.setDesiredRunning('current-session', false);
    else if (kind === 'vacation') await f.service.setVacation('employee', undefined, true);
    else await f.service.rebind('employee', undefined, 'new-session');
    release.resolve();
    expect((await flight).awakened).toEqual([]);
    expect(f.deps.wake).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
  });
  it.each(['stop', 'vacation', 'rebind'])(
    '%s also invalidates an owner start held after its durable claim',
    async (kind) => {
      const f = await fixture(false),
        intent = f.service.prepareRuntimeRestart('current-session', undefined)!;
      await intent.claim();
      if (kind === 'stop') await f.service.setDesiredRunning('current-session', false);
      else if (kind === 'vacation') await f.service.setVacation('employee', undefined, true);
      else await f.service.rebind('employee', undefined, 'new-session');
      expect(intent.current()).toBe(false);
      await intent.rollback();
      intent.finish();
      expect(f.store.snapshot().employees[0].desiredRunning).toBe(kind === 'rebind');
    }
  );
  it('failed claims release the fence without clearing the three-attempt limit', async () => {
    const f = await fixture();
    await f.store.update((s) => {
      s.employees[0].wakeAttempts = [999997, 999998, 999999];
    });
    expect((await f.recovery.tick()).awakened).toEqual([]);
    expect(f.deps.wake).not.toHaveBeenCalled();
    expect(f.store.snapshot().employees[0].wakeAttempts).toHaveLength(3);
    const intent = f.service.prepareRuntimeRestart('current-session', undefined)!;
    intent.finish();
  });
});

describe('real restoration path cancellation after an awaited synthetic start', () => {
  it.each(['stop', 'vacation', 'rebind'])(
    '%s during start cannot restore, persist or announce success',
    async (kind) => {
      const f = await fixture(),
        started = gate(),
        release = gate();
      const ctx = createMockRouteContext({ workspaceHooksEnabled: false, agentSkillEnabled: false });
      startSession.mockImplementation(async () => {
        started.resolve();
        await release.promise;
      });
      f.deps.wake.mockImplementation(async (entry, allowed) => {
        const current = entry as import('../src/reboot-restore.js').RebootRestoreEntry;
        const actual = {
          ...current,
          workingDir: process.cwd(),
          state: { ...current.state, workingDir: process.cwd() },
        };
        const result = await spendRebootRestore(ctx as never, [actual], new Set(), allowed);
        return result.restored.length === 1;
      });
      const flight = f.recovery.tick();
      await started.promise;
      expect(() => f.service.prepareRuntimeRestart('current-session', undefined)).toThrow('already restarting');
      if (kind === 'stop') await f.service.setDesiredRunning('current-session', false);
      else if (kind === 'vacation') await f.service.setVacation('employee', undefined, true);
      else await f.service.rebind('employee', undefined, 'new-session');
      release.resolve();
      expect((await flight).awakened).toEqual([]);
      expect(ctx.reapplyPersistedSessionState).toHaveBeenCalledTimes(1);
      expect(ctx.reapplyPersistedSessionState).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'before-spawn'
      );
      expect(ctx.persistSessionState).not.toHaveBeenCalled();
      expect(ctx.broadcast).not.toHaveBeenCalled();
      expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith('current-session');
      expect(ctx.sessions.has('current-session')).toBe(false);
      expect(f.service.prepareWake('employee', 'current-session')).toBeUndefined();
    }
  );
  it('does not discard a replacement object registered while this start is pending', async () => {
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false, agentSkillEnabled: false });
    const started = gate(),
      release = gate();
    startSession.mockImplementation(async () => {
      started.resolve();
      await release.promise;
    });
    const saved = {
      id: 'same-id',
      name: 'Synthetic',
      mode: 'claude',
      status: 'idle',
      pid: null,
      workingDir: process.cwd(),
    } as SessionState;
    const entry = {
      sessionId: saved.id,
      name: saved.name,
      mode: saved.mode,
      workingDir: saved.workingDir,
      state: saved,
      resumeConversationId: 'synthetic',
    };
    const flight = spendRebootRestore(ctx as never, [entry], new Set(), () => true);
    await started.promise;
    const replacement = { id: 'same-id', toState: () => ({ id: 'same-id' }) };
    ctx.sessions.set('same-id', replacement as never);
    release.resolve();
    expect((await flight).restored).toEqual([]);
    expect(ctx.discardPartiallyBuiltSession).not.toHaveBeenCalled();
    expect(ctx.sessions.get('same-id')).toBe(replacement);
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });
  it('does not trust a stale success returned by a recovery dependency', async () => {
    const f = await fixture();
    f.deps.wake.mockImplementation(async () => {
      await f.service.setDesiredRunning('current-session', false);
      return true;
    });
    expect((await f.recovery.tick()).awakened).toEqual([]);
  });
});
