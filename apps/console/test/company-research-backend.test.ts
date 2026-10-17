import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DurableCompanyResearchBackend,
  parseResearchReport,
  type CompanyResearchRuntime,
} from '../src/company-research-backend.js';
import type { CompanyCycle, CompanyEmployee } from '../src/company-types.js';

describe('durable tool-capable company research backend', () => {
  let directory: string;
  let file: string;
  let backend: DurableCompanyResearchBackend;
  let runtime: CompanyResearchRuntime;
  let cycle: CompanyCycle;
  let employee: CompanyEmployee;
  let runtimeState: Awaited<ReturnType<CompanyResearchRuntime['inspect']>>;
  const now = Date.parse('2026-10-15T01:00:00Z');
  const createBackend = () =>
    new DurableCompanyResearchBackend({ file, workspaceRoot: join(directory, 'workspaces'), runtime, now: () => now });
  const start = () =>
    backend.start({ cycle, employee, prompt: 'Use tools to explore an interesting systems question.' });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fleet-company-backend-'));
    file = join(directory, 'bindings.json');
    employee = {
      id: randomUUID(),
      name: 'Ada',
      icon: '🔭',
      position: 'Scientist',
      expertise: ['systems'],
      sessionId: 'employee-main',
      researchEnabled: true,
      createdAt: now,
    };
    cycle = {
      id: randomUUID(),
      employeeId: employee.id,
      kind: 'research',
      date: '2026-10-15',
      state: 'claimed',
      claimedAt: now,
      deadlineAt: now + 3600000,
    };
    runtimeState = { state: 'running' };
    runtime = { launch: vi.fn(async () => {}), inspect: vi.fn(async () => runtimeState), stop: vi.fn(async () => {}) };
    backend = createBackend();
    await backend.init();
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists a unique dedicated session binding before real launch and never relaunches it', async () => {
    runtime.launch = vi.fn(async ({ binding, env }) => {
      const persisted = JSON.parse(await readFile(file, 'utf8'))[0];
      expect(persisted.sessionId).toBe(binding.sessionId);
      expect(persisted.phase).toBe('launching');
      expect(binding.sessionId).not.toBe(employee.sessionId);
      expect(binding.workingDir).toBe(join(directory, 'workspaces', cycle.id));
      expect(env.FLEET_RESEARCH_CYCLE_ID).toBe(cycle.id);
      expect(await readFile(join(binding.workingDir, 'RESEARCH_TASK.md'), 'utf8')).toContain('Use tools');
    });
    const first = await start();
    const second = await start();
    expect(second.sessionId).toBe(first.sessionId);
    expect(runtime.launch).toHaveBeenCalledTimes(1);
    backend = createBackend();
    await backend.init();
    expect((await start()).sessionId).toBe(first.sessionId);
    expect(runtime.launch).toHaveBeenCalledTimes(1);
  });

  it('serializes racing starts without duplicate launch', async () => {
    const results = await Promise.all([start(), start(), start()]);
    expect(new Set(results.map((h) => h.sessionId)).size).toBe(1);
    expect(runtime.launch).toHaveBeenCalledTimes(1);
  });

  it('reads actual response and tool evidence, persists completion and recovers after restart', async () => {
    await start();
    runtimeState = {
      state: 'completed',
      response: JSON.stringify({
        summary: 'Ran experiment',
        findings: [{ text: 'Experiment passed', status: 'observed', evidence: ['tool: test.log 12 cases passed'] }],
      }),
      evidence: ['tool: test.log 12 cases passed'],
    };
    const report = await backend.inspect(cycle.id);
    expect(report?.state).toBe('completed');
    expect(report?.result?.findings[0].status).toBe('observed');
    backend = createBackend();
    await backend.init();
    vi.mocked(runtime.inspect).mockClear();
    expect((await backend.inspect(cycle.id))?.result).toEqual(report?.result);
    expect(runtime.inspect).not.toHaveBeenCalled();
  });

  it('never accepts model-invented verification as an observed finding', () => {
    const response = JSON.stringify({
      summary: 'Agent report',
      findings: [{ text: 'Everything is proven', status: 'observed', evidence: ['invented: all tests pass'] }],
    });
    expect(parseResearchReport(response).findings[0]).toEqual({
      text: 'Everything is proven',
      status: 'hypothesis',
      evidence: [],
    });
  });

  it('fails missing sessions after uncertain launch without repeating their actions', async () => {
    runtime.launch = vi.fn(async () => {
      throw new Error('crash after possible launch');
    });
    await expect(start()).rejects.toThrow('crash');
    backend = createBackend();
    await backend.init();
    runtimeState = { state: 'missing' };
    expect((await start()).state).toBe('failed');
    expect(runtime.launch).toHaveBeenCalledTimes(1);
    expect((await backend.inspect(cycle.id))?.error).toContain('not replayed');
  });

  it('reattaches a live session after uncertain launch rather than starting another', async () => {
    runtime.launch = vi.fn(async () => {
      throw new Error('lost launch acknowledgement');
    });
    await expect(start()).rejects.toThrow('acknowledgement');
    backend = createBackend();
    await backend.init();
    expect((await backend.inspect(cycle.id))?.state).toBe('running');
    expect(runtime.launch).toHaveBeenCalledTimes(1);
  });

  it('stops only exact durable owned research bindings, never arbitrary or main sessions', async () => {
    const handle = await start();
    await backend.stop(employee.sessionId);
    await backend.stop('unknown');
    expect(runtime.stop).not.toHaveBeenCalled();
    await backend.stop(cycle.id);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.stop).mock.calls[0][0].sessionId).toBe(handle.sessionId);
    await backend.stop(cycle.id);
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('rejects oversized and malformed output honestly', async () => {
    expect(() => parseResearchReport('x'.repeat(256 * 1024 + 1))).toThrow('256 KiB');
    expect(() => parseResearchReport('A fictional breakthrough happened.')).toThrow();
    await start();
    runtimeState = { state: 'completed', response: 'A fictional breakthrough happened.' };
    const report = await backend.inspect(cycle.id);
    expect(report?.state).toBe('failed');
    expect(report?.result).toBeUndefined();
  });

  it('rejects owner mismatch, elapsed budgets and symlink-redirection before launch', async () => {
    await expect(backend.start({ cycle: { ...cycle, owner: 'other' }, employee, prompt: 'x' })).rejects.toThrow(
      'ownership'
    );
    await expect(backend.start({ cycle: { ...cycle, deadlineAt: now }, employee, prompt: 'x' })).rejects.toThrow(
      'elapsed'
    );
    const root = join(directory, 'workspaces');
    const outside = join(directory, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, cycle.id));
    await expect(start()).rejects.toThrow('symlink');
    expect(runtime.launch).not.toHaveBeenCalled();
  });

  async function invalidateWorkspace(kind: string): Promise<void> {
    const workspace = join(directory, 'workspaces', cycle.id);
    await rm(workspace, { recursive: true });
    if (kind === 'symlinked') {
      const outside = join(directory, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'RESEARCH_REPORT.json'), 'Untrusted replacement report');
      await symlink(outside, workspace);
    } else if (kind === 'replaced') await writeFile(workspace, 'This is no longer a directory');
  }

  it.each(['deleted', 'symlinked', 'replaced'])(
    'stops the exact bound session and persists failure when its workspace is %s',
    async (kind) => {
      const handle = await start();
      await invalidateWorkspace(kind);
      const result = await backend.inspect(cycle.id);
      expect(result?.state).toBe('failed');
      expect(result?.error).toContain('workspace is missing or invalid');
      expect(result?.result).toBeUndefined();
      expect(runtime.stop).toHaveBeenCalledOnce();
      expect(vi.mocked(runtime.stop).mock.calls[0][0]).toMatchObject({
        cycleId: cycle.id,
        employeeId: employee.id,
        sessionId: handle.sessionId,
        workingDir: join(directory, 'workspaces', cycle.id),
      });
      expect(runtime.inspect).not.toHaveBeenCalled();
      backend = createBackend();
      await backend.init();
      expect((await backend.inspect(cycle.id))?.state).toBe('failed');
      expect((await start()).state).toBe('failed');
      expect(runtime.launch).toHaveBeenCalledOnce();
      expect(runtime.stop).toHaveBeenCalledOnce();
    }
  );

  it.each(['deleted', 'symlinked', 'replaced'])(
    'allows deadline cleanup of the exact owned binding after its workspace is %s',
    async (kind) => {
      const handle = await start();
      await invalidateWorkspace(kind);
      await backend.stop(cycle.id);
      expect(runtime.stop).toHaveBeenCalledOnce();
      expect(vi.mocked(runtime.stop).mock.calls[0][0].sessionId).toBe(handle.sessionId);
      expect((await backend.inspect(cycle.id))?.state).toBe('failed');
      expect(JSON.parse(await readFile(file, 'utf8'))[0].phase).toBe('stopped');
      expect(runtime.inspect).not.toHaveBeenCalled();
      await backend.stop(cycle.id);
      expect(runtime.stop).toHaveBeenCalledOnce();
    }
  );

  it('preserves the runtime ownership guard during cleanup of an invalid workspace', async () => {
    await start();
    await invalidateWorkspace('deleted');
    runtime.stop = vi.fn(async () => {
      throw new Error('Research session ownership mismatch');
    });
    await expect(backend.inspect(cycle.id)).rejects.toThrow('ownership mismatch');
    await expect(backend.stop(cycle.id)).rejects.toThrow('ownership mismatch');
    expect(JSON.parse(await readFile(file, 'utf8'))[0].phase).toBe('running');
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(runtime.launch).toHaveBeenCalledOnce();
  });

  it('refuses corrupted bindings instead of silently resetting ownership state', async () => {
    await writeFile(file, '{broken');
    await expect(createBackend().init()).rejects.toThrow();
  });
});
