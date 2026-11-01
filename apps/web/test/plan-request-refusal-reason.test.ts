/**
 * A refused plan-move request says why: the server's own error, on one bounded line, instead of only a generic hint. Approval
 * keeps its generic message, since its request carries a credential and a handoff.
 */
import { describe, expect, it, vi } from 'vitest';
import { agentPlanMoveAction, agentPlanRequest, agentRequestPlanMove, agentPlanRecovery, serverReason } from '../src/cli-plan-request.js';
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


describe('own existing move CLI', () => {
  const existing = { id: 'held', phase: 'recovery-required', oldSession: 'old', newSession: 'source', toAccount: 'target',
    sourceStopRequested: true, sourceCleanupVerified: true };
  it('inspects once and explicitly adopts the identical tuple without submitting any move', async () => {
    const d = deps({ status: 200, json: { success: true, data: existing } });
    vi.mocked(d.request).mockResolvedValueOnce({ status: 200, text: '', json: { success: true, data: existing } })
      .mockResolvedValueOnce({ status: 200, text: '', json: { success: true, data: { ...existing, phase: 'completed', recoveryAction: 'adopt-existing' } } });
    expect(await agentPlanRecovery(d, 'held', true)).toBe(0);
    expect(d.request).toHaveBeenCalledTimes(2);
    expect(vi.mocked(d.request).mock.calls[1][1]).toEqual({ method: 'POST', path: '/api/plans/agent-moves/held/resolve',
      body: { action: 'adopt-existing', oldSession: 'old', newSession: 'source', toAccount: 'target' } });
  });
  it.each([{ sourceCleanupVerified: false }, { newSession: 'someone-else' }, { resourceIntent: {} }, { phase: 'waiting' }])('does not resolve an ineligible status %j', async delta => {
    const d = deps({ status: 200, json: { success: true, data: { ...existing, ...delta } } });
    expect(await agentPlanRecovery(d, 'held', true)).toBe(1);
    expect(d.request).toHaveBeenCalledTimes(1);
  });
  it('never retries an uncertain adoption and names structured blocker IDs on a refused new request', async () => {
    const d = deps({ status: 409, json: { success: false, error: 'Held', blocker: { id: 'held', action: 'inspect-existing' } } });
    expect(await agentRequestPlanMove(d, { toAccount: 'target', id: 'new' })).toBe(1);
    expect(err(d)).toContain('recovery-status held');
    vi.mocked(d.request).mockReset().mockResolvedValueOnce({ status: 200, text: '', json: { success: true, data: existing } })
      .mockRejectedValueOnce(new Error('transport lost'));
    expect(await agentPlanRecovery(d, 'held', true)).toBe(1);
    expect(d.request).toHaveBeenCalledTimes(2);
  });
});


describe('self recovery accepted is not completion', () => {
  it('reports queued explicitly so the busy caller can finish its turn, without polling or another move', async () => {
    const existing = { id: 'held', phase: 'recovery-required', oldSession: 'old', newSession: 'source', toAccount: 'target', sourceStopRequested: true, sourceCleanupVerified: true };
    const d = deps({ status: 200, json: { success: true, data: existing } });
    vi.mocked(d.request).mockResolvedValueOnce({ status: 200, text: '', json: { success: true, data: existing } })
      .mockResolvedValueOnce({ status: 202, text: '', json: { success: true, data: existing, recovery: { state: 'waiting-for-idle' } } });
    expect(await agentPlanRecovery(d, 'held', true)).toBe(0);
    expect(d.request).toHaveBeenCalledTimes(2);
    expect(vi.mocked(d.io.out).mock.calls[0][0]).toContain('queued, not completed');
    expect(vi.mocked(d.io.out).mock.calls[0][0]).toContain('Finish this turn');
  });
});
