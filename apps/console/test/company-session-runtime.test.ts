import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const harness = vi.hoisted(() => ({
  configs: [] as any[],
  buffer: 'shift+tab',
  startupError: false,
  sendResult: true,
  capacity: false,
  start: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../src/session.js', () => ({
  Session: class {
    id: string;
    workingDir: string;
    owner?: string;
    mode: string;
    config: any;
    constructor(config: any) {
      this.config = config;
      this.id = config.id;
      this.workingDir = config.workingDir;
      this.owner = config.owner;
      this.mode = config.mode;
      harness.configs.push(config);
    }
    getEnvOverridesForPersist() {
      return this.config.envOverrides;
    }
    getTerminalBuffer() {
      return harness.buffer;
    }
    isRunning() {
      return true;
    }
    async startInteractive() {
      harness.start();
      if (harness.startupError) throw new Error('mock launch failed');
    }
    async writeViaMux(value: string) {
      harness.send(value);
      return harness.sendResult;
    }
  },
}));
vi.mock('../src/config/cli-registry/registry.js', () => ({
  getCli: () => ({ kind: 'agent', capabilities: { composerReadyMark: 'shift+tab', workDetect: { promptGlyph: '❯' } } }),
}));
vi.mock('../src/subscription-profiles.js', () => ({
  selectedSubscription: vi.fn(async () => ({ env: {}, selection: undefined })),
}));
vi.mock('../src/user-store.js', () => ({
  resolveClaudeModeForUsername: vi.fn(async () => 'auto'),
  canUsernameRunPrivilegedCommands: vi.fn(async () => true),
}));
vi.mock('../src/session-config-clamp.js', () => ({
  clampExternalCliBypassForOwner: vi.fn(async (_owner, configs) => configs),
}));
vi.mock('../src/session-env-clamp.js', () => ({ clampEnvOverridesForOwner: vi.fn(async (_owner, env) => env) }));
vi.mock('../src/web/route-helpers.js', () => ({
  sessionCapacityState: () => ({ atGlobalCap: harness.capacity, atUserCap: false }),
}));
vi.mock('../src/hooks-config.js', () => ({ applyWorkspaceHooks: vi.fn(async () => {}) }));

import { companySessionRuntime, freshResearchConfig } from '../src/company-session-runtime.js';
import type { CompanyResearchBinding } from '../src/company-research-backend.js';
import type { CompanyEmployee } from '../src/company-types.js';

describe('real company session adapter with isolated mocked CLI IO', () => {
  let directory: string;
  let binding: CompanyResearchBinding;
  let employee: CompanyEmployee;
  let ctx: any;
  let main: any;
  let runtime: ReturnType<typeof companySessionRuntime>;
  const report = JSON.stringify({ summary: 'Actual agent-written report', findings: [] });
  const launch = () =>
    runtime.launch({
      binding,
      employee,
      prompt: 'Explore with real tools',
      env: { FLEET_RESEARCH_CYCLE_ID: binding.cycleId, FLEET_EMPLOYEE_ID: employee.id },
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fleet-company-runtime-'));
    harness.configs = [];
    harness.buffer = 'shift+tab';
    harness.startupError = false;
    harness.sendResult = true;
    harness.capacity = false;
    binding = {
      cycleId: randomUUID(),
      employeeId: 'ada',
      sessionId: randomUUID(),
      workingDir: directory,
      owner: 'owner',
      deadlineAt: Date.now() + 60000,
      phase: 'launching',
    };
    employee = {
      id: 'ada',
      owner: 'owner',
      name: 'Ada',
      icon: '🔭',
      position: 'Scientist',
      expertise: ['systems'],
      sessionId: 'main-session',
      researchEnabled: true,
      createdAt: Date.now(),
    };
    main = {
      id: employee.sessionId,
      workingDir: join(directory, 'main'),
      mode: 'claude',
      owner: 'owner',
      claudeMode: 'auto',
      allowedTools: 'Read,Write,Bash',
      getEnvOverridesForPersist: () => ({ CLAUDE_CONFIG_DIR: '/owned-account' }),
      toState: () => ({
        model: 'model-choice',
        effort: 'high',
        codexConfig: { model: 'codex-model', resumeSessionId: 'private-main-thread', bypass: true },
        geminiConfig: { model: 'gemini-model', resumeSession: 'private-gemini' },
        antigravityConfig: { resumeConversationId: 'private-agy' },
      }),
    };
    ctx = {
      testMode: false,
      sessions: new Map([[main.id, main]]),
      mux: {},
      addSession: vi.fn(async (session: any) => {
        ctx.sessions.set(session.id, session);
      }),
      cleanupSession: vi.fn(async (id: string) => {
        ctx.sessions.delete(id);
      }),
      persistSessionStateNow: vi.fn(),
      setupSessionListeners: vi.fn(async () => {}),
      broadcast: vi.fn(),
      getSessionStateWithRespawn: vi.fn(() => ({})),
      getWorkspaceHooksEnabled: vi.fn(async () => false),
    };
    runtime = companySessionRuntime(ctx);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('strips every provider continuation selector without modifying the main config', () => {
    const config = {
      model: 'chosen',
      resumeSessionId: 'a',
      continueSession: true,
      resumeSession: 'b',
      resumeConversationId: 'c',
      sessionId: 'd',
      session: 'e',
    };
    expect(freshResearchConfig(config)).toEqual({ model: 'chosen' });
    expect(config.resumeSessionId).toBe('a');
  });

  it('launches only the exact dedicated id/workspace, preserving explicit provider model and identity', async () => {
    await launch();
    const config = harness.configs[0];
    expect(config.id).toBe(binding.sessionId);
    expect(config.workingDir).toBe(directory);
    expect(config.parentSessionId).toBe(employee.sessionId);
    expect(config.model).toBe('model-choice');
    expect(config.codexConfig.resumeSessionId).toBeUndefined();
    expect(config.geminiConfig.resumeSession).toBeUndefined();
    expect(config.antigravityConfig.resumeConversationId).toBeUndefined();
    expect(config.envOverrides.FLEET_RESEARCH_CYCLE_ID).toBe(binding.cycleId);
    expect(harness.send).toHaveBeenCalledOnce();
    expect(ctx.sessions.get(main.id)).toBe(main);
    expect(ctx.cleanupSession).not.toHaveBeenCalledWith(main.id, expect.anything(), expect.anything());
  });

  it('does not mistake a trust-dialog prompt glyph for a composer readiness marker', async () => {
    harness.buffer = 'Do you trust this directory? ❯';
    binding.deadlineAt = Date.now() - 1;
    await expect(launch()).rejects.toThrow('ready');
    expect(harness.send).not.toHaveBeenCalled();
    expect(ctx.cleanupSession).toHaveBeenCalledWith(binding.sessionId, true, expect.any(String));
  });

  it('cleans only its own dedicated launch on failure and disables autonomous launches in test servers', async () => {
    harness.startupError = true;
    await expect(launch()).rejects.toThrow('mock launch failed');
    expect(ctx.cleanupSession).toHaveBeenCalledWith(binding.sessionId, true, expect.any(String));
    expect(ctx.sessions.has(main.id)).toBe(true);
    ctx.testMode = true;
    await expect(launch()).rejects.toThrow('test mode');
  });

  it('refuses to stop a session unless owner, working directory and cycle identity all match', async () => {
    await launch();
    const dedicated = ctx.sessions.get(binding.sessionId);
    for (const forged of [
      { ...binding, owner: 'other' },
      { ...binding, workingDir: join(directory, 'other') },
      { ...binding, cycleId: randomUUID() },
    ]) {
      await expect(runtime.stop(forged)).rejects.toThrow('ownership');
    }
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.sessions.get(binding.sessionId)).toBe(dedicated);
    await runtime.stop(binding);
    expect(ctx.cleanupSession).toHaveBeenCalledOnce();
    expect(ctx.sessions.has(main.id)).toBe(true);
  });

  it('recovers an actual on-time report after restart even if the dedicated session is gone', async () => {
    await writeFile(join(directory, 'RESEARCH_REPORT.json'), report);
    const result = await runtime.inspect(binding);
    expect(result).toEqual({ state: 'completed', response: report, evidence: [] });
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect((await runtime.inspect({ ...binding, workingDir: join(directory, 'missing') })).state).toBe('missing');
  });

  it('rejects late, oversized and symlink report files without accepting fabricated completion', async () => {
    const path = join(directory, 'RESEARCH_REPORT.json');
    await writeFile(path, report);
    const late = new Date(binding.deadlineAt + 10000);
    await utimes(path, late, late);
    expect((await runtime.inspect(binding)).state).toBe('failed');
    await writeFile(path, 'x'.repeat(256 * 1024 + 1));
    expect((await runtime.inspect(binding)).state).toBe('failed');
    await rm(path);
    const outside = join(directory, 'outside.json');
    await writeFile(outside, report);
    await symlink(outside, path);
    expect((await runtime.inspect(binding)).state).toBe('failed');
  });
});
