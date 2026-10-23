import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanRequestCapabilities, planRequestCapabilityFile } from '../src/plan-request-capability.js';
import { PlanRequestStore } from '../src/plan-request-store.js';
import { agentPlanRequest, agentRequestPlanMove, agentPendingPlanMoves } from '../src/cli-plan-request.js';
import type { AgentDeps } from '../src/cli-agent.js';

const directories: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'plan-cap-'));
  directories.push(root);
  const capabilities = new PlanRequestCapabilities(join(root, 'private'));
  const value = { requestId: 'request', sessionId: 'source', nonce: 'a'.repeat(64) };
  return { root, capabilities, value, file: planRequestCapabilityFile('source', 'request', capabilities.root) };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe('private plan approval files and CLI', () => {
  it('requests a selected company employee through the scoped API without creating a session or approving it', async () => {
    const deps: AgentDeps = { ctx: { selfId: 'manager', apiUrl: 'http://fixture' }, json: true,
      io: { out: vi.fn(), err: vi.fn() },
      request: vi.fn(async (_ctx, request) => request.method === 'GET'
        ? { status: 200, text: '', json: { success: true, data: { employees: [{ id: 'expert', sessionId: 'source' }] } } }
        : { status: 202, text: '', json: { success: true, data: { phase: 'pending' } } }),
    };
    expect(await agentRequestPlanMove(deps, { id: 'request', employeeId: 'expert', toAccount: 'target' })).toBe(0);
    expect(deps.request).toHaveBeenLastCalledWith(deps.ctx, { method: 'POST', path: '/api/plans/agent-requests',
      body: { id: 'request', employeeId: 'expert', sessionId: 'source', toAccount: 'target' } });
    expect(deps.request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(deps.io.out).mock.calls[0][0])).toEqual({ success: true, id: 'request', phase: 'pending' });
  });
  it('uses private directories, exclusive files, exact identity, no traversal, and revocation', async () => {
    const h = await fixture();
    await h.capabilities.write(h.value);
    expect((await fs.stat(h.capabilities.root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(h.file)).mode & 0o777).toBe(0o600);
    expect(await h.capabilities.read('source', 'request')).toEqual(h.value);
    await expect(h.capabilities.write(h.value)).rejects.toThrow();
    await expect(h.capabilities.read('other', 'request')).rejects.toThrow();
    await expect(h.capabilities.read('source', '../request')).rejects.toThrow();
    await fs.writeFile(h.file, JSON.stringify({ ...h.value, sessionId: 'other' }));
    await expect(h.capabilities.read('source', 'request')).rejects.toThrow('another');
    await h.capabilities.remove('source', 'request');
    await expect(h.capabilities.read('source', 'request')).rejects.toThrow();
  });
  it('refuses symlinks, public permissions, oversized files and unsafe directory permissions', async () => {
    const h = await fixture();
    await h.capabilities.write(h.value);
    await fs.chmod(h.file, 0o644);
    await expect(h.capabilities.read('source', 'request')).rejects.toThrow('private');
    await fs.chmod(h.file, 0o600);
    await fs.writeFile(h.file, 'x'.repeat(4097));
    await expect(h.capabilities.read('source', 'request')).rejects.toThrow();
    await fs.unlink(h.file);
    await fs.symlink(join(h.root, 'target'), h.file);
    await expect(h.capabilities.read('source', 'request')).rejects.toThrow();
    await fs.chmod(h.capabilities.root, 0o755);
    await expect(h.capabilities.read('source', 'request')).rejects.toThrow('private');
  });
  it('sends the nonce only in the exact request body and never echoes credentials or handoffs', async () => {
    const h = await fixture();
    await h.capabilities.write(h.value);
    const handoffFile = join(h.root, 'handoff');
    await fs.writeFile(handoffFile, 'Finish the private work.');
    const deps: AgentDeps = {
      ctx: { selfId: 'source', apiUrl: 'http://fixture' },
      json: true,
      request: vi.fn(async () => ({ status: 202, json: { success: true, data: { phase: 'executing' } }, text: '' })),
      io: { out: vi.fn(), err: vi.fn() },
    };
    expect(await agentPlanRequest(deps, { id: 'request', decision: 'approve', handoffFile }, h.capabilities)).toBe(0);
    expect(deps.request).toHaveBeenCalledWith(deps.ctx, {
      method: 'POST',
      path: '/api/plans/requests/request/approve',
      body: { nonce: h.value.nonce, handoff: 'Finish the private work.' },
    });
    expect(JSON.stringify([vi.mocked(deps.io.out).mock.calls, vi.mocked(deps.io.err).mock.calls])).not.toContain(
      h.value.nonce
    );
    vi.mocked(deps.request).mockResolvedValue({ status: 403, json: { error: h.value.nonce }, text: h.value.nonce });
    expect(await agentPlanRequest(deps, { id: 'request', decision: 'reject' }, h.capabilities)).toBe(1);
    expect(JSON.stringify(vi.mocked(deps.io.err).mock.calls)).not.toContain(h.value.nonce);
    deps.ctx.selfId = 'other';
    vi.mocked(deps.request).mockClear();
    expect(await agentPlanRequest(deps, { id: 'request', decision: 'reject' }, h.capabilities)).toBe(1);
    expect(deps.request).not.toHaveBeenCalled();
  });
  it('durably saves a bounded private request journal with no raw approval secret', async () => {
    const h = await fixture();
    const store = new PlanRequestStore(join(h.root, 'requests.json'));
    expect(await store.load()).toEqual([]);
    const record = {
      id: 'request',
      employeeId: 'alex',
      sessionId: 'source',
      name: 'Alex',
      fromAccount: 'first',
      toAccount: 'second',
      mode: 'codex',
      phase: 'pending' as const,
      createdAt: 1,
      expiresAt: 10,
      notified: false,
      nonceHash: 'b'.repeat(64),
    };
    await store.save([record]);
    expect(await store.load()).toEqual([record]);
    expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600);
    await expect(store.save([{ ...record, nonce: h.value.nonce } as typeof record])).rejects.toThrow();
    await expect(store.save([record, record])).rejects.toThrow();
    expect(await store.load()).toEqual([record]);
  });
});

it('lists own pending requests using no target override and strips credential-like response extras', async () => {
  const deps: AgentDeps = { ctx: { selfId: 'source', apiUrl: 'http://fixture' }, json: true,
    io: { out: vi.fn(), err: vi.fn() }, request: vi.fn(async () => ({ status: 200, text: '', json: { success: true, data: [{
      id: 'request', phase: 'pending', toAccount: 'second', expiresAt: 1_800_000, notified: false, nonceHash: 'private',
    }] } })) };
  expect(await agentPendingPlanMoves(deps)).toBe(0);
  expect(deps.request).toHaveBeenCalledWith(deps.ctx, { method: 'POST', path: '/api/plans/agent-requests/pending', body: {} });
  expect(String(vi.mocked(deps.io.out).mock.calls[0][0])).not.toContain('private');
  vi.mocked(deps.request).mockRejectedValue(new Error('private'));
  expect(await agentPendingPlanMoves(deps)).toBe(1);
  expect(JSON.stringify(vi.mocked(deps.io.err).mock.calls)).not.toContain('private');
});
