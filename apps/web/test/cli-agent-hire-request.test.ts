import { describe, expect, it } from 'vitest';
import { agentHireRequest, agentHireRequestList, agentHireRequestWithdraw } from '../src/cli-agent-hire-request.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';

function fixture(json: boolean, reply: { status: number; json: Record<string, unknown> } | Error) {
  const output: string[] = [], errors: string[] = [], calls: RequestOptions[] = [];
  const deps: AgentDeps = { ctx: { selfId: 'self-session', apiUrl: 'http://synthetic.test' }, json,
    io: { out: text => output.push(text), err: text => errors.push(text) },
    request: async (_ctx, request) => {
      calls.push(request);
      if (reply instanceof Error) throw reply;
      return { status: reply.status, text: '', json: reply.json as never };
    } };
  return { deps, output, errors, calls };
}
const request = { id: 'req-1', templateId: 'alpha', templateSha256: 'a'.repeat(64), fields: { workingDir: '/w', reason: 'Need help', name: 'Parsa' },
  requestedBy: 'agent:self-session', requestedAt: Date.parse('2026-10-31T01:00:00Z'), status: 'pending' };

describe('hire-request CLI', () => {
  it('sends the full hire, mapping flags to the server fields, and says nothing is hired yet', async () => {
    const f = fixture(false, { status: 200, json: { success: true, data: { request } } });
    expect(await agentHireRequest(f.deps, 'alpha', { workingDir: '/w', reason: 'Need help', mode: 'codex', account: 'plan-b', name: 'Parsa',
      position: 'Parser reviewer', reportsTo: 'emp-1', room: ['r1', 'r2'], budgetPlan: 'plan-b', budgetPercent: '80' })).toBe(0);
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/api/experts/alpha/hire-requests', body: { workingDir: '/w', reason: 'Need help',
      mode: 'codex', accountProfileId: 'plan-b', name: 'Parsa', position: 'Parser reviewer', reportsTo: 'emp-1', rooms: ['r1', 'r2'],
      budgetStop: { planId: 'plan-b', weeklyPercent: 80 } } });
    expect(f.output[0]).toContain('Nothing is hired until the owner approves it in Company');
  });

  it('refuses half a budget stop without asking, and prints the server refusal', async () => {
    const half = fixture(false, { status: 200, json: { success: true } });
    expect(await agentHireRequest(half.deps, 'alpha', { workingDir: '/w', reason: 'why', budgetPlan: 'p' })).toBe(4);
    expect(half.calls).toHaveLength(0);
    const refused = fixture(true, { status: 403, json: { success: false, error: 'This session may not hire or retire experts; the owner lists delegates' } });
    expect(await agentHireRequest(refused.deps, 'alpha', { workingDir: '/w', reason: 'why' })).toBe(4);
    expect(JSON.parse(refused.output[0])).toEqual({ success: false, error: 'This session may not hire or retire experts; the owner lists delegates' });
  });

  it('calls a lost answer unknown and points at list instead of asking again', async () => {
    const lost = fixture(false, new Error('socket hang up'));
    expect(await agentHireRequest(lost.deps, 'alpha', { workingDir: '/w', reason: 'why' })).toBe(4);
    expect(lost.errors[0]).toContain('outcome unknown; check `reverie agent hire-request list`');
  });

  it('lists and withdraws the caller\'s own requests', async () => {
    const list = fixture(false, { status: 200, json: { success: true, data: { requests: [request] } } });
    expect(await agentHireRequestList(list.deps)).toBe(0);
    expect(list.output[0]).toBe('req-1 pending template alpha as Parsa (2026-10-31T01:00:00.000Z)');
    const withdraw = fixture(false, { status: 200, json: { success: true, data: { request: { ...request, status: 'withdrawn' } } } });
    expect(await agentHireRequestWithdraw(withdraw.deps, 'req-1')).toBe(0);
    expect(withdraw.calls[0]).toMatchObject({ method: 'POST', path: '/api/experts-hire-requests/req-1/withdraw' });
  });
});
