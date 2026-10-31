/**
 * A refused plan-move request says why: the server's own error, on one bounded line, instead of only a generic hint. Approval
 * keeps its generic message, since its request carries a credential and a handoff.
 */
import { describe, expect, it, vi } from 'vitest';
import { agentPlanMoveAction, agentPlanRequest, agentRequestPlanMove, serverReason } from '../src/cli-plan-request.js';
import type { AgentDeps } from '../src/cli-agent.js';

function deps(refusal: { status: number; json: unknown }): AgentDeps {
  return {
    ctx: { selfId: 'source', apiUrl: 'http://fixture' },
    json: false,
    io: { out: vi.fn(), err: vi.fn() },
    request: vi.fn(async (_ctx, request) =>
      request.method === 'GET'
        ? { status: 200, text: '', json: { success: true, data: { employees: [{ id: 'expert', sessionId: 'source' }] } } }
        : { status: refusal.status, text: '', json: refusal.json }),
  };
}
const err = (d: AgentDeps) => vi.mocked(d.io.err).mock.calls.map((c) => c[0]).join('\n');

describe('plan-move refusals', () => {
  it('show the server reason for a refused request', async () => {
    const d = deps({ status: 403, json: { success: false, error: 'Destination account is not granted to this employee', errorCode: 'FORBIDDEN' } });
    expect(await agentRequestPlanMove(d, { id: 'request', toAccount: 'openai-ed0348c4' })).toBe(1);
    expect(err(d)).toBe('Plan move request refused: Destination account is not granted to this employee. Check the destination ID and owner-granted plan permissions.');
  });

  it('read both error shapes, keep one bounded line, and fall back to the generic hint', () => {
    expect(serverReason({ error: { message: 'This employee already has a move in progress or requiring recovery' } }))
      .toBe('This employee already has a move in progress or requiring recovery');
    const noisy = serverReason({ error: 'first line\nsecond\tline\u001b[31m red' + 'x'.repeat(500) });
    // eslint-disable-next-line no-control-regex -- the escape character must be gone from the shown line.
    expect(noisy).not.toMatch(/[\n\t\u001b]/);
    expect(noisy.startsWith('first line second line [31m red')).toBe(true);
    expect(noisy.length).toBe(300);
    expect(serverReason(undefined)).toBe('');
    expect(serverReason({ success: false })).toBe('');
    expect(serverReason({ error: 42 })).toBe('');
  });

  it('keep the generic hint alone when the server gives no reason', async () => {
    const d = deps({ status: 500, json: { success: false } });
    expect(await agentRequestPlanMove(d, { id: 'request', toAccount: 'target' })).toBe(1);
    expect(err(d)).toBe('Plan move request refused. Check the destination ID and owner-granted plan permissions.');
  });

  it('name the refused action and its reason for status, cancel and reauthorize', async () => {
    const d = deps({ status: 409, json: { success: false, error: 'No such plan request for this employee' } });
    expect(await agentPlanMoveAction(d, 'request', 'cancel')).toBe(1);
    expect(err(d)).toBe('Plan request cancel refused: No such plan request for this employee. Check the request ID and current plan permissions.');
  });

  it('never echo the server for an approval, whose request carries a credential and a handoff', async () => {
    const d = deps({ status: 403, json: { success: false, error: 'nonce aaaa… does not match' } });
    vi.stubEnv('REVERIE_WORKER', '1');
    expect(await agentPlanRequest(d, { id: 'request', decision: 'reject' })).toBe(1);
    vi.unstubAllEnvs();
    expect(err(d)).not.toContain('nonce');
  });
});
