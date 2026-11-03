/**
 * `reverie agent plan-move list --employee <id|name>`: a name resolves through the company roster to one employee id,
 * the listing asks for that employee, and a refusal or an unknown name is reported, never guessed around.
 */
import { describe, expect, it } from 'vitest';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';
import { agentPendingPlanMoves } from '../src/cli-plan-request.js';

const TARGET = '0000004a-0050-4000-8000-000000000071';

function deps(pending: { status: number; json: unknown } = { status: 200, json: { success: true, data: [] } }) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://x', selfId: 'self' },
    json: false,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.path === '/api/company')
        return {
          status: 200,
          text: '',
          json: {
            success: true,
            data: {
              employees: [
                { id: TARGET, name: 'Builder' },
                { id: 'x1', name: 'Twin' },
                { id: 'x2', name: 'twin' },
              ],
            },
          },
        };
      return { status: pending.status, text: '', json: pending.json as never };
    },
  };
  return { d, calls, out, err };
}

describe('plan-move list --employee', () => {
  it('resolves a name to the employee id and lists that expert’s requests', async () => {
    const pending = {
      status: 200,
      json: {
        success: true,
        data: [{ id: 'req-1', phase: 'pending', toAccount: 'acct', expiresAt: 0, notified: true }],
      },
    };
    const { d, calls, out } = deps(pending);
    expect(await agentPendingPlanMoves(d, 'builder')).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/plans/agent-requests/pending',
      body: { employeeId: TARGET },
    });
    expect(out[0]).toContain('req-1: pending');
    expect(out[0]).toContain('That expert prepares the handoff');
  });

  it('sends an id without reading the roster, and keeps the own listing unchanged without --employee', async () => {
    const a = deps();
    expect(await agentPendingPlanMoves(a.d, TARGET)).toBe(0);
    expect(a.calls.map((c) => c.path)).toEqual(['/api/plans/agent-requests/pending']);
    const b = deps();
    expect(await agentPendingPlanMoves(b.d)).toBe(0);
    expect(b.calls[0].body).toEqual({});
    expect(b.out).toEqual(['No pending plan requests for this session.']);
  });

  it('reports an unknown or ambiguous name, and a refusal, without guessing', async () => {
    for (const name of ['Nobody', 'Twin']) {
      const { d, calls, err } = deps();
      expect(await agentPendingPlanMoves(d, name)).toBe(1);
      expect(calls.some((c) => c.path === '/api/plans/agent-requests/pending')).toBe(false);
      expect(err[0]).toMatch(/No expert is called|names 2 experts/);
    }
    const refused = deps({
      status: 403,
      json: { success: false, error: "Listing another expert's plan requests needs Manage team plans" },
    });
    expect(await agentPendingPlanMoves(refused.d, TARGET)).toBe(4);
    expect(refused.err[0]).toContain('Manage team plans');
  });
});
