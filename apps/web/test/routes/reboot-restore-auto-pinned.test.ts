/**
 * Boot-time auto-restore of pinned sessions (autoRestorePinnedSessions): same ids, the
 * OpenCode native thread carried through its own config, unpinned entries left on offer,
 * duplicates refused, and no interleaving with a click already restoring.
 * `Session` is mocked to record its construction, as in the rebuild-failure test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const built: Array<Record<string, unknown>> = [];

vi.mock('../../src/session.js', () => ({
  Session: class {
    id: string;
    mode: string;
    name?: string;
    workingDir: string;
    owner?: string;
    claudeSessionId: string | null = null;
    constructor(config: Record<string, unknown> & { id: string; workingDir: string }) {
      built.push(config);
      this.id = config.id;
      this.mode = (config.mode as string) ?? 'claude';
      this.name = config.name as string | undefined;
      this.workingDir = config.workingDir;
      this.owner = config.owner as string | undefined;
    }
    async startInteractive() {}
    toState() {
      return { id: this.id, mode: this.mode, name: this.name, workingDir: this.workingDir, owner: this.owner };
    }
  },
}));

const { autoRestorePinnedSessions, autoRestorePinnedIfEnabled } = await import('../../src/web/routes/reboot-restore-routes.js');
const { rebootRestoreRegistry } = await import('../../src/web/reboot-restore-registry.js');
const { planRebootRestore } = await import('../../src/reboot-restore.js');
const { createMockRouteContext } = await import('../mocks/index.js');
type SessionState = import('../../src/types.js').SessionState;

const WORKSPACE = process.cwd();

function record(overrides: Partial<SessionState> & { id: string }): SessionState {
  return {
    pid: 4242,
    status: 'busy',
    workingDir: WORKSPACE,
    currentTaskId: null,
    createdAt: 1_760_000_000_000,
    lastActivityAt: 1_760_000_000_000,
    mode: 'claude',
    ...overrides,
  } as SessionState;
}

/** Plan the way the boot pass does, then put the plan on offer. */
function offer(records: SessionState[]): void {
  const persisted = Object.fromEntries(records.map((r) => [r.id, r]));
  rebootRestoreRegistry.set(planRebootRestore(Object.keys(persisted), persisted, () => true).restore);
}

afterEach(() => {
  rebootRestoreRegistry.reset();
  built.length = 0;
});

describe('autoRestorePinnedSessions', () => {
  it('rebuilds pinned sessions under their saved ids and leaves unpinned ones on offer', async () => {
    const ctx = createMockRouteContext();
    offer([
      record({ id: 'agent-a', pinned: true, claudeSessionChain: ['conv-a'] }),
      record({
        id: 'agent-b',
        pinned: true,
        mode: 'opencode',
        openCodeConfig: { model: 'local/model', continueSession: 'ses_native' },
      }),
      record({ id: 'worker-c' }),
    ]);
    const result = await autoRestorePinnedSessions(ctx as never);
    expect(result.restored.sort()).toEqual(['agent-a', 'agent-b']);
    expect(built.map((c) => c.id).sort()).toEqual(['agent-a', 'agent-b']);
    const claude = built.find((c) => c.id === 'agent-a')!;
    expect(claude.resumeSessionId).toBe('conv-a');
    const opencode = built.find((c) => c.id === 'agent-b')!;
    expect(opencode.resumeSessionId).toBeUndefined();
    expect(opencode.openCodeConfig).toEqual({ model: 'local/model', continueSession: 'ses_native' });
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual(['worker-c']);
  });

  it('never duplicates: a live id or a live OpenCode thread is skipped, not rebuilt', async () => {
    const ctx = createMockRouteContext();
    ctx.sessions.set('agent-a', { id: 'agent-a', claudeSessionId: null } as never);
    ctx.sessions.set('other', { id: 'other', claudeSessionId: null } as never);
    ctx.store.getSession.mockImplementation((id: string) =>
      id === 'other' ? record({ id: 'other', mode: 'opencode', openCodeConfig: { continueSession: 'ses_native' } }) : undefined
    );
    offer([
      record({ id: 'agent-a', pinned: true }),
      record({ id: 'agent-b', pinned: true, mode: 'opencode', openCodeConfig: { continueSession: 'ses_native' } }),
    ]);
    const result = await autoRestorePinnedSessions(ctx as never);
    expect(result.restored).toEqual([]);
    expect(result.skipped.map((s) => [s.sessionId, s.reason]).sort()).toEqual([
      ['agent-a', 'already-live'],
      ['agent-b', 'already-live'],
    ]);
    expect(built).toEqual([]);
  });

  it('does not interleave with a restore click already running for that owner', async () => {
    const ctx = createMockRouteContext();
    offer([record({ id: 'agent-a', pinned: true })]);
    expect(rebootRestoreRegistry.beginSpending(undefined)).toBe(true); // the click holds the flight
    const result = await autoRestorePinnedSessions(ctx as never);
    rebootRestoreRegistry.endSpending(undefined);
    expect(result.restored).toEqual([]);
    expect(built).toEqual([]);
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual(['agent-a']); // still on offer
  });

  it('is off unless the owner set rebootRestoreAutoPinned to exactly true', async () => {
    for (const settings of [{}, { rebootRestoreAutoPinned: false }, { rebootRestoreAutoPinned: 'true' }]) {
      offer([record({ id: 'agent-a', pinned: true })]);
      expect(await autoRestorePinnedIfEnabled(settings, createMockRouteContext() as never)).toBeNull();
      expect(built).toEqual([]);
      expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual(['agent-a']);
      rebootRestoreRegistry.reset();
    }
    offer([record({ id: 'agent-a', pinned: true })]);
    const on = await autoRestorePinnedIfEnabled({ rebootRestoreAutoPinned: true }, createMockRouteContext() as never);
    expect(on?.restored).toEqual(['agent-a']);
  });

  it("keeps restoring other owners when one owner's pass throws, returning its entries to the offer", async () => {
    const ctx = createMockRouteContext();
    let calls = 0;
    ctx.getWorkspaceHooksEnabled = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('settings unreadable');
      return false;
    }) as never;
    offer([record({ id: 'first', pinned: true, owner: 'alice' }), record({ id: 'second', pinned: true, owner: 'bob' })]);
    const result = await autoRestorePinnedSessions(ctx as never);
    expect(result.restored).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('rebuild-failed');
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual([result.skipped[0].sessionId]);
  });
});

describe('a session switched off OpenCode (POST /api/sessions/:id/mode)', () => {
  it('keeps its OpenCode config through a restore, so switching back resumes the same thread', async () => {
    const ctx = createMockRouteContext();
    offer([record({ id: 'switched', pinned: true, mode: 'claude', openCodeConfig: { continueSession: 'ses_kept' } })]);
    const result = await autoRestorePinnedSessions(ctx as never);
    expect(result.restored).toEqual(['switched']);
    const built0 = built.find((c) => c.id === 'switched')!;
    expect(built0.mode).toBe('claude');
    expect(built0.openCodeConfig).toEqual({ continueSession: 'ses_kept' });
  });
});
