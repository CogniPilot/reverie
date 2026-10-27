import { describe, expect, it } from 'vitest';
import { agentContext, agentContextReceipt } from '../src/cli-agent-context.js';
import { buildEmployeeContext, ManagedEmployeeContextStore } from '../src/employee-context.js';
import { EmployeeSchema } from '../src/company-types.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';

const employee = EmployeeSchema.parse({ id: 'employee', name: 'Alex', icon: 'A', position: 'Engineer', expertise: ['Testing'],
  sessionId: 'self-session', sessionGeneration: 1, createdAt: 1 });
function fixture() {
  let value: unknown = new ManagedEmployeeContextStore().issue(undefined, buildEmployeeContext(employee));
  const output: string[] = [], calls: RequestOptions[] = [];
  const deps: AgentDeps = { ctx: { selfId: 'self-session', apiUrl: 'http://synthetic.test' }, json: true,
    io: { out: text => output.push(text), err: text => output.push(text) }, request: async (_ctx, request) => {
      calls.push(request); return { status: 200, text: '', json: { success: true, data: value } };
    } };
  return { deps, output, calls, set: (next: unknown) => { value = next; }, get: () => value as any };
}
describe('scoped context CLI', () => {
  it('returns only bounded current self context and refuses swapped identity or extra private fields', async () => {
    const f = fixture(); expect(await agentContext(f.deps)).toBe(0);
    expect(JSON.parse(f.output[0]!).data.sessionId).toBe('self-session');
    expect(f.calls.map(call => call.path)).toEqual(['/api/agent/context']);
    f.set({ ...f.get(), sessionId: 'another' }); expect(await agentContext(f.deps)).toBe(4);
    const g = fixture(); g.set({ ...g.get(), env: 'synthetic-private-value' });
    expect(await agentContext(g.deps)).toBe(4); expect(g.output.join('')).not.toContain('synthetic-private-value');
  });
  it('does not refetch before posting an exact digest-only receipt', async () => {
    const f = fixture(); const digest = f.get().digest;
    f.set({ employeeId: 'employee', sessionId: 'self-session', sessionGeneration: 1, digest,
      stage: 'model-request', reportedAt: 1000, assurance: 'harness-reported-input', retention: 'website-process-lifetime' });
    expect(await agentContextReceipt(f.deps, digest, 'model-request')).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/api/agent/context/receipt', body: { digest, stage: 'model-request' } });
    expect(JSON.parse(f.output[0]!).data.assurance).toBe('harness-reported-input');
    expect(await agentContextReceipt(f.deps, digest, 'pretend-model-read')).toBe(4);
    expect(f.calls).toHaveLength(1);
  });
});
