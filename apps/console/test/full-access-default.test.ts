/**
 * @fileoverview Reverie agents start with full access inside the fleet container.
 *
 * A codex session created, moved (employee replace) or relaunched without
 * `codexConfig.dangerouslyBypassApprovals` used to start with approval prompts on and stall.
 * Inside the container (`FLEET_CONTAINER=1`) every local launch now fills the unset switch,
 * stores it on the session (so the persisted row carries it), keeps an explicit `false`, and
 * never lifts the clamp for a non-granted owner. Each launch path is checked on the command
 * the pane would really run (`buildCodexCommand` of the options handed to tmux).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/user-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/user-store.js')>()),
  // 'bob' stands for a non-granted owner in multi-user mode; everyone else is granted.
  canUsernameRunPrivilegedCommands: vi.fn(async (username: string | undefined) => username !== 'bob'),
}));

import { Session } from '../src/session.js';
import { TmuxManager, buildCodexCommand } from '../src/tmux-manager.js';
import type { CreateSessionOptions, RespawnPaneOptions } from '../src/mux-interface.js';
import {
  checkFullAccessFlags,
  fullAccessAlertRoom,
  fullAccessFlags,
  isCliProcess,
  missingFullAccessFlags,
  processTreeArgv,
  procTable,
  withFullAccessDefault,
  type ProcessTable,
} from '../src/full-access-default.js';
import { createSessionListeners, attachSessionListeners } from '../src/web/session-listener-wiring.js';

const FLAG = '--dangerously-bypass-approvals-and-sandbox';
const CLAUDE_FLAG = '--dangerously-skip-permissions';
const CONTAINER = { FLEET_CONTAINER: '1' } as NodeJS.ProcessEnv;

describe('withFullAccessDefault', () => {
  it('fills the codex bypass switch inside the container', async () => {
    expect(await withFullAccessDefault('codex', undefined, undefined, CONTAINER)).toEqual({ dangerouslyBypassApprovals: true });
    expect(await withFullAccessDefault('codex', { reasoningEffort: 'high' }, undefined, CONTAINER)).toEqual({
      reasoningEffort: 'high',
      dangerouslyBypassApprovals: true,
    });
  });

  it('changes nothing outside the container', async () => {
    expect(await withFullAccessDefault('codex', undefined, undefined, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('keeps an explicit false', async () => {
    expect(await withFullAccessDefault('codex', { dangerouslyBypassApprovals: false }, undefined, CONTAINER)).toBeUndefined();
  });

  it('gives a non-granted owner nothing', async () => {
    expect(await withFullAccessDefault('codex', undefined, 'bob', CONTAINER)).toBeUndefined();
  });

  it('leaves claude alone (its bypass is claudeMode, defaulted elsewhere)', async () => {
    expect(await withFullAccessDefault('claude', undefined, undefined, CONTAINER)).toBeUndefined();
  });

  it('turns on opencode autoAllowTools, but keeps an explicit false and an owner permission policy', async () => {
    expect(await withFullAccessDefault('opencode', undefined, undefined, CONTAINER)).toEqual({ autoAllowTools: true });
    expect(await withFullAccessDefault('opencode', { autoAllowTools: false }, undefined, CONTAINER)).toBeUndefined();
    const policy = { configContent: JSON.stringify({ permission: { bash: 'ask' } }) };
    expect(await withFullAccessDefault('opencode', policy, undefined, CONTAINER)).toBeUndefined();
    const other = { configContent: JSON.stringify({ default_agent: 'chat' }) };
    expect(await withFullAccessDefault('opencode', other, undefined, CONTAINER)).toEqual({ ...other, autoAllowTools: true });
    expect(await withFullAccessDefault('opencode', undefined, 'bob', CONTAINER)).toBeUndefined();
  });
});

/** A fake process table: `[pid, ppid, ...argv]` rows. */
function table(...rows: Array<[number, number, ...string[]]>): ProcessTable {
  const byPid = new Map(rows.map(([pid, ppid, ...argv]) => [pid, { ppid, argv }]));
  return {
    pids: () => [...byPid.keys()],
    ppid: (pid) => byPid.get(pid)?.ppid,
    argv: (pid) => {
      const row = byPid.get(pid);
      if (!row) throw new Error('ENOENT');
      return row.argv;
    },
  };
}

// Pane trees shaped like the launch audit (audit.json 939543ad), with its pids.
const CODEX_WRAPPED = table([657885, 1, 'node', '/usr/local/bin/codex', FLAG], [657898, 657885, '/usr/local/lib/codex/codex', FLAG]);
const BARE_BASH = table([940181, 1, 'bash']);
const CLAUDE_PANE = table([68, 1, 'bash', '-c', `claude ${CLAUDE_FLAG}`], [70, 68, 'claude', CLAUDE_FLAG]);

describe('missingFullAccessFlags', () => {
  it('names the codex flag, and none for a switch set to false', () => {
    expect(fullAccessFlags('codex')).toEqual([FLAG]);
    expect(fullAccessFlags('codex', { dangerouslyBypassApprovals: false })).toEqual([]);
    expect(fullAccessFlags('opencode')).toEqual([]);
  });

  it('expects the claude flag only for the bypass claudeMode', () => {
    expect(fullAccessFlags('claude', undefined, 'dangerously-skip-permissions')).toEqual([CLAUDE_FLAG]);
    expect(fullAccessFlags('claude', undefined, 'normal')).toEqual([]);
    expect(fullAccessFlags('claude')).toEqual([]);
  });

  it('recognises the CLI binary and its node wrapper, nothing else', () => {
    expect(isCliProcess(['codex', FLAG], ['codex'])).toBe(true);
    expect(isCliProcess(['/usr/local/lib/codex/codex'], ['codex'])).toBe(true);
    expect(isCliProcess(['node', '/usr/local/bin/codex'], ['codex'])).toBe(true);
    expect(isCliProcess(['node', '/tmp/helper.js', FLAG], ['codex'])).toBe(false);
    expect(isCliProcess(['/usr/bin/printf', '%s', FLAG], ['codex'])).toBe(false);
    expect(isCliProcess(['bash', '-c', `codex ${FLAG}`], ['codex'])).toBe(false);
  });

  it('finds the flag on the codex process below the node wrapper (audit afca6fbb)', () => {
    expect(checkFullAccessFlags('codex', 657885, undefined, CODEX_WRAPPED)).toEqual({ missing: [], reason: 'ok' });
    expect(processTreeArgv(657885, CODEX_WRAPPED)).toHaveLength(2);
  });

  it('positive control: a flag on the actual CLI child verifies', () => {
    expect(missingFullAccessFlags('codex', 100, undefined, table([100, 1, 'bash'], [101, 100, 'codex', FLAG]))).toEqual([]);
  });

  it('a bare bash pane with no CLI below it fails closed as no-cli, account defaults notwithstanding (audit f6511f77)', () => {
    // recovery-account-defaults.json (e8ea0158): config.toml approval_policy=never is not read here; only argv counts.
    expect(checkFullAccessFlags('codex', 940181, undefined, BARE_BASH)).toEqual({ missing: [FLAG], reason: 'no-cli' });
    expect(missingFullAccessFlags('codex', 940181, undefined, BARE_BASH)).toEqual([FLAG]);
  });

  it('a flag only inside the launcher\'s bash -c string does not count; the CLI process must carry it', () => {
    const launcherOnly = table([500, 1, 'bash', '-c', `codex ${FLAG}`], [501, 500, 'codex']);
    expect(checkFullAccessFlags('codex', 500, undefined, launcherOnly)).toEqual({ missing: [FLAG], reason: 'flags' });
  });

  it('a sibling helper carrying the flag does not stand in for a bare codex', () => {
    const sibling = table([100, 1, 'bash'], [101, 100, 'codex'], [102, 100, 'node', '/tmp/helper.js', FLAG]);
    expect(missingFullAccessFlags('codex', 100, undefined, sibling)).toEqual([FLAG]);
  });

  it('does not verify a bare CLI using a flag on an unrelated child command', () => {
    const child = table([100, 1, 'bash'], [101, 100, 'codex'], [102, 101, '/usr/bin/printf', '%s', FLAG]);
    expect(missingFullAccessFlags('codex', 100, undefined, child)).toEqual([FLAG]);
  });

  it('a helper with the flag and no CLI at all is no-cli', () => {
    const helperOnly = table([100, 1, 'bash'], [102, 100, 'node', '/tmp/helper.js', FLAG]);
    expect(checkFullAccessFlags('codex', 100, undefined, helperOnly)).toEqual({ missing: [FLAG], reason: 'no-cli' });
  });

  it('a claude pane carries its flag on the claude process; a flagless one is missing it', () => {
    expect(missingFullAccessFlags('claude', 68, undefined, CLAUDE_PANE, 'dangerously-skip-permissions')).toEqual([]);
    expect(missingFullAccessFlags('claude', 68, undefined, CLAUDE_PANE)).toEqual([]);
    const bare = table([68, 1, 'bash', '-c', `claude ${CLAUDE_FLAG}`], [70, 68, 'claude']);
    expect(missingFullAccessFlags('claude', 68, undefined, bare, 'dangerously-skip-permissions')).toEqual([CLAUDE_FLAG]);
    expect(missingFullAccessFlags('claude', 68, undefined, bare, 'normal')).toEqual([]);
  });

  it('a gone pane says nothing', () => {
    expect(checkFullAccessFlags('codex', 999, undefined, table())).toEqual({ missing: [], reason: 'gone' });
  });
});

describe('codex sessions launch with full access in the container', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'full-access-default');
  const sessions: Session[] = [];
  let created: CreateSessionOptions[];
  let respawned: RespawnPaneOptions[];
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.FLEET_CONTAINER;
    process.env.FLEET_CONTAINER = '1';
    Session.fullAccessCheckDelayMs = 0;
    mkdirSync(workingDir, { recursive: true });
    created = [];
    respawned = [];
    const create = TmuxManager.prototype.createSession;
    vi.spyOn(TmuxManager.prototype, 'createSession').mockImplementation(function (this: TmuxManager, options) {
      created.push(options);
      return create.call(this, options);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const s of sessions.splice(0)) s.stop();
    rmSync(workingDir, { recursive: true, force: true });
    Session.fullAccessCheckDelayMs = 5000;
    Session.fullAccessCheckRetries = 5;
    if (previous === undefined) delete process.env.FLEET_CONTAINER;
    else process.env.FLEET_CONTAINER = previous;
  });

  /** Serve the pane's process tree from a fake table instead of /proc. */
  function useTable(fake: ProcessTable): void {
    vi.spyOn(procTable, 'pids').mockImplementation(fake.pids);
    vi.spyOn(procTable, 'ppid').mockImplementation(fake.ppid);
    vi.spyOn(procTable, 'argv').mockImplementation(fake.argv);
  }

  function make(options: Partial<ConstructorParameters<typeof Session>[0]> = {}): Session {
    const session = new Session({ workingDir, mode: 'codex', mux: new TmuxManager(), useMux: true, ...options });
    sessions.push(session);
    return session;
  }

  it('create (audit requiredRegression 1, f6511f77 savedCodexBypass null): a session sent without codexConfig starts with the flag and persists it', async () => {
    const session = make();
    await session.startInteractive();
    expect(buildCodexCommand(created.at(-1)?.codexConfig)).toContain(FLAG);
    expect(session.toState().codexConfig?.dangerouslyBypassApprovals).toBe(true);
  });

  it('move (audit requiredRegression 1-2): the replacement launch gets the flag and keeps its identity and thread', async () => {
    // The replace spawn hands the clamped body config to `new Session`; for codex it is absent when not sent.
    const session = make({ name: 'Ada', codexConfig: { reasoningEffort: 'high' }, resumeSessionId: 'thread-f6511f77' });
    const id = session.id;
    await session.startInteractive();
    const options = created.at(-1);
    const command = buildCodexCommand(options?.codexConfig);
    expect(command).toContain(FLAG);
    expect(command).toContain('model_reasoning_effort=high');
    expect(options?.resumeSessionId).toBe('thread-f6511f77');
    expect(session.id).toBe(id);
    expect(session.name).toBe('Ada');
  });

  it('relaunch (audit requiredRegression 2-3): restart adds the flag and the argv check passes on the real CLI', async () => {
    const session = make({ muxSession: { sessionId: 'x', muxName: 'codeman-fullaccess', pid: 4242 } as never });
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockImplementation(async (options) => {
      respawned.push(options);
      return 4343;
    });
    useTable(table([4343, 1, 'bash'], [4344, 4343, 'node', '/usr/local/bin/codex', FLAG]));
    const missing = vi.fn();
    session.on('fullAccessMissing', missing);
    expect(await session.restartCli()).toBe(true);
    expect(buildCodexCommand(respawned.at(-1)?.codexConfig)).toContain(FLAG);
    expect(session.toState().codexConfig?.dangerouslyBypassApprovals).toBe(true);
    expect(await session.fullAccessCheck).toEqual([]);
    expect(missing).not.toHaveBeenCalled();
  });

  it('relaunch whose CLI came up without the flag is reported as full_access_missing', async () => {
    const session = make({ muxSession: { sessionId: 'x', muxName: 'codeman-fullaccess', pid: 4242 } as never });
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockResolvedValue(4343);
    useTable(table([4343, 1, 'bash', '-c', `codex ${FLAG}`], [4344, 4343, 'codex']));
    const missing = vi.fn();
    session.on('fullAccessMissing', missing);
    await session.restartCli();
    expect(await session.fullAccessCheck).toEqual([FLAG]);
    expect(missing).toHaveBeenCalledWith({ pid: 4343, missing: [FLAG], reason: 'flags' });
  });

  it('a pane whose CLI never starts is looked at again, then reported as no-cli and alerted', async () => {
    Session.fullAccessCheckRetries = 2;
    const session = make({ muxSession: { sessionId: 'x', muxName: 'codeman-fullaccess', pid: 4242 } as never });
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockResolvedValue(4343);
    useTable(table([4343, 1, 'bash']));
    const argv = vi.spyOn(procTable, 'argv');
    const alert = vi.fn();
    attachSessionListeners(session, createSessionListeners(session, { alertFullAccessMissing: alert } as never));
    await session.restartCli();
    expect(await session.fullAccessCheck).toEqual([FLAG]);
    expect(argv).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledExactlyOnceWith(session, { pid: 4343, missing: [FLAG], reason: 'no-cli' });
  });

  it('a CLI that starts on a later look passes and raises nothing', async () => {
    Session.fullAccessCheckRetries = 2;
    const session = make({ muxSession: { sessionId: 'x', muxName: 'codeman-fullaccess', pid: 4242 } as never });
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockResolvedValue(4343);
    const early = table([4343, 1, 'bash']);
    const late = table([4343, 1, 'bash'], [4344, 4343, 'codex', FLAG]);
    let looks = 0;
    vi.spyOn(procTable, 'pids').mockImplementation(() => (looks++ === 0 ? early : late).pids());
    vi.spyOn(procTable, 'ppid').mockImplementation(late.ppid);
    vi.spyOn(procTable, 'argv').mockImplementation(late.argv);
    const alert = vi.fn();
    attachSessionListeners(session, createSessionListeners(session, { alertFullAccessMissing: alert } as never));
    await session.restartCli();
    expect(await session.fullAccessCheck).toEqual([]);
    expect(looks).toBe(2);
    expect(alert).not.toHaveBeenCalled();
  });

  it('a missing flag reaches the owner/room alert dependency', async () => {
    const session = make({ muxSession: { sessionId: 'x', muxName: 'codeman-fullaccess', pid: 4242 } as never });
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockResolvedValue(4343);
    useTable(table([4343, 1, 'codex']));
    const alert = vi.fn();
    attachSessionListeners(session, createSessionListeners(session, { alertFullAccessMissing: alert } as never));
    await session.restartCli();
    expect(await session.fullAccessCheck).toEqual([FLAG]);
    expect(alert).toHaveBeenCalledExactlyOnceWith(session, { pid: 4343, missing: [FLAG], reason: 'flags' });
  });

  it('audit requiredRegression 4: the check is per session, so a stale same-name session is not confused with the bound one', async () => {
    useTable(table([700, 1, 'bash'], [701, 700, 'codex', FLAG], [800, 1, 'bash']));
    const bound = make({ name: 'Ada', muxSession: { sessionId: 'a', muxName: 'codeman-ada-a', pid: 1 } as never });
    const stale = make({ name: 'Ada', muxSession: { sessionId: 'b', muxName: 'codeman-ada-b', pid: 2 } as never });
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    const pids = [700, 800];
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockImplementation(async () => pids.shift() as number);
    const events: string[] = [];
    bound.on('fullAccessMissing', () => events.push(bound.id));
    stale.on('fullAccessMissing', () => events.push(stale.id));
    await bound.restartCli();
    await stale.restartCli();
    expect(await bound.fullAccessCheck).toEqual([]);
    expect(await stale.fullAccessCheck).toEqual([FLAG]);
    expect(events).toEqual([stale.id]);
  });

  it('a persisted config survives a console restart', async () => {
    const first = make();
    await first.startInteractive();
    const state = first.toState();
    const second = make({ codexConfig: state.codexConfig });
    await second.startInteractive();
    expect(buildCodexCommand(created.at(-1)?.codexConfig)).toContain(FLAG);
  });

  it('keeps an explicit false from the owner, and does not report its flagless relaunch', async () => {
    const session = make({ codexConfig: { dangerouslyBypassApprovals: false } });
    await session.startInteractive();
    expect(buildCodexCommand(created.at(-1)?.codexConfig)).not.toContain(FLAG);
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockResolvedValue(900);
    useTable(table([900, 1, 'codex']));
    const relaunched = make({
      codexConfig: { dangerouslyBypassApprovals: false },
      muxSession: { sessionId: 'f', muxName: 'codeman-false', pid: 1 } as never,
    });
    expect(await relaunched.restartCli()).toBe(true);
    expect(await relaunched.fullAccessCheck).toEqual([]);
  });

  it('a non-granted owner stays clamped, and is not reported', async () => {
    const session = make({ owner: 'bob' });
    await session.startInteractive();
    expect(buildCodexCommand(created.at(-1)?.codexConfig)).not.toContain(FLAG);
    expect(session.toState().codexConfig?.dangerouslyBypassApprovals).toBeUndefined();
    vi.spyOn(TmuxManager.prototype, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(TmuxManager.prototype, 'respawnPane').mockResolvedValue(901);
    useTable(table([901, 1, 'codex']));
    const relaunched = make({ owner: 'bob', muxSession: { sessionId: 'b', muxName: 'codeman-bob', pid: 1 } as never });
    expect(await relaunched.restartCli()).toBe(true);
    expect(relaunched.toState().codexConfig?.dangerouslyBypassApprovals).toBeUndefined();
    expect(await relaunched.fullAccessCheck).toEqual([]);
  });

  it('an opencode session starts with autoAllowTools on and persists it', async () => {
    const session = make({ mode: 'opencode' });
    await session.startInteractive();
    expect(created.at(-1)?.openCodeConfig?.autoAllowTools).toBe(true);
    expect(session.toState().openCodeConfig?.autoAllowTools).toBe(true);
  });

  it('outside the container nothing is added', async () => {
    delete process.env.FLEET_CONTAINER;
    const session = make();
    await session.startInteractive();
    expect(buildCodexCommand(created.at(-1)?.codexConfig)).not.toContain(FLAG);
  });
});

describe('fullAccessAlertRoom (Inspector r2 security delta: owner scope)', () => {
  const rooms = [
    { id: 'a-reverie', kind: 'group', name: 'reverie', owner: 'ownerA' },
    { id: 'b-dm', kind: 'dm', name: 'reverie', owner: 'ownerB' },
    { id: 'b-reverie', kind: 'group', name: ' Reverie ', owner: 'ownerB' },
    { id: 'single', kind: 'group', name: 'reverie' },
  ];

  it("two owners: ownerB's session goes to ownerB's #reverie even when ownerA's is listed first", () => {
    expect(fullAccessAlertRoom(rooms, 'ownerB')?.id).toBe('b-reverie');
    expect(fullAccessAlertRoom(rooms, 'ownerA')?.id).toBe('a-reverie');
  });

  it("no match: an owner without a #reverie room gets none, never another owner's", () => {
    expect(fullAccessAlertRoom(rooms, 'ownerC')).toBeUndefined();
    expect(fullAccessAlertRoom(rooms.slice(0, 2), 'ownerB')).toBeUndefined();
    expect(fullAccessAlertRoom([], 'ownerA')).toBeUndefined();
  });

  it('single-user: an ownerless session uses only the ownerless room', () => {
    expect(fullAccessAlertRoom(rooms, undefined)?.id).toBe('single');
    expect(fullAccessAlertRoom(rooms.slice(0, 3), undefined)).toBeUndefined();
  });
});
