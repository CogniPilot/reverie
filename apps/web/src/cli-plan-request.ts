import { constants, promises as fs } from 'node:fs';
import type { AgentDeps } from './cli-agent.js';
import { randomUUID } from 'node:crypto';
import { PlanRequestCapabilities, PlanRequestId } from './plan-request-capability.js';

/**
 * The server's own reason for refusing a plan request, as one bounded line, or ''. Only the error string is shown, never the
 * response data; request and status bodies carry no credential or handoff (approval keeps its generic message below).
 */
export function serverReason(body: unknown): string {
  const error = (body as { error?: unknown } | undefined)?.error;
  const raw = typeof error === 'string' ? error : typeof (error as { message?: unknown } | undefined)?.message === 'string' ? (error as { message: string }).message : '';
  // eslint-disable-next-line no-control-regex -- a server message is shown on one terminal line, without control characters.
  return raw.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Request a move through the scoped company API; session creation remains private to the executor. */
export async function agentRequestPlanMove(deps: AgentDeps, input: { toAccount: string; employeeId?: string; id?: string; restart?: boolean }): Promise<number> {
  try {
    const response = await deps.request(deps.ctx, { method: 'GET', path: '/api/company' });
    const company = response.json as { success?: boolean; data?: { employees?: { id: string; sessionId: string }[] } };
    const employee = company?.data?.employees?.find(item => input.employeeId ? item.id === input.employeeId : item.sessionId === deps.ctx.selfId);
    if (response.status >= 400 || !company.success || !employee) throw new Error('Unknown company expert');
    if (input.restart && employee.sessionId !== deps.ctx.selfId)
      throw new Error('A runtime refresh is only available for this exact expert');
    const id = PlanRequestId.parse(input.id ?? randomUUID());
    const result = await deps.request(deps.ctx, { method: 'POST', path: '/api/plans/agent-requests', body: {
      id, employeeId: employee.id, sessionId: employee.sessionId, toAccount: PlanRequestId.parse(input.toAccount),
      ...(input.restart ? { purpose: 'runtime-refresh' } : {}),
    } });
    const body = result.json as { success?: boolean; data?: { phase: string }; error?: string };
    if (result.status >= 400 || !body?.success) {
      const reason = serverReason(body);
      deps.io.err(`Plan move request refused${reason ? `: ${reason}` : ''}. Check the destination ID and owner-granted plan permissions.`);
      return 1;
    }
    deps.io.out(deps.json ? JSON.stringify({ success: true, id, phase: body.data?.phase }) : `Plan request ${id}: ${body.data?.phase}. The affected expert must prepare a handoff and approve.`);
    return 0;
  } catch { deps.io.err('Could not confirm the plan request. Check its status before retrying with the same request ID.'); return 1; }
}

export async function agentPlanMoveAction(deps: AgentDeps, id: string, action: 'status' | 'cancel' | 'reauthorize'): Promise<number> {
  try {
    const result = await deps.request(deps.ctx, { method: 'POST', path: `/api/plans/agent-requests/${PlanRequestId.parse(id)}/${action}` });
    const body = result.json as { success?: boolean; data?: { phase: string; newSession?: string } };
    if (result.status >= 400 || !body?.success) {
      const reason = serverReason(body);
      deps.io.err(`Plan request ${action} refused${reason ? `: ${reason}` : ''}. Check the request ID and current plan permissions.`);
      return 1;
    }
    deps.io.out(deps.json ? JSON.stringify({ success: true, id, ...body.data }) : `Plan request ${id}: ${body.data?.phase}${body.data?.newSession ? ` (${body.data.newSession})` : ''}.`);
    return 0;
  } catch { deps.io.err('Plan request action refused or unavailable. Check the request ID and current plan permissions.'); return 1; }
}

/** The credential is read privately and sent only in the authenticated request body. */
export async function agentPlanRequest(
  deps: AgentDeps,
  input: { id: string; decision: 'approve' | 'reject'; handoffFile?: string },
  capabilities?: PlanRequestCapabilities
): Promise<number> {
  // The fixed-identity office proxy keeps the private credential outside the laptop.
  const office = capabilities === undefined && process.env.REVERIE_WORKER === '1';
  let nonce: string | undefined, handoff: string | undefined;
  try {
    PlanRequestId.parse(input.id);
    if (!office) nonce = (await (capabilities ?? new PlanRequestCapabilities()).read(deps.ctx.selfId, input.id)).nonce;
    if (input.decision === 'approve') {
      if (!input.handoffFile) throw new Error('A handoff file is required');
      const handle = await fs.open(input.handoffFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 48000) throw new Error('Invalid handoff file');
        const bytes = Buffer.alloc(48001),
          read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > 48000) throw new Error('Invalid handoff file');
        handoff = bytes.subarray(0, read.bytesRead).toString('utf8').trim();
        if (!handoff || handoff.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(handoff))
          throw new Error('Invalid handoff text');
      } finally {
        await handle.close();
      }
    }
  } catch {
    deps.io.err(
      'Cannot read a private approval credential for this session and request, or a bounded regular handoff file. Ask the owner to reauthorize if needed.'
    );
    return 1;
  }
  try {
    const response = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/plans/requests/${input.id}/${input.decision}`,
      body: { ...(nonce === undefined ? {} : { nonce }), ...(handoff === undefined ? {} : { handoff }) },
    });
    const result = response.json as { success?: boolean; data?: { phase?: string }; error?: string } | undefined;
    if (response.status >= 400 || !result?.success) {
      // Never echo transport bodies: neither approval credentials nor handoffs belong in terminal history.
      deps.io.err(
        'Plan request was refused. Inspect its status with the owner; it may be expired, cancelled, or require reauthorization.'
      );
      return 1;
    }
    deps.io.out(
      deps.json
        ? JSON.stringify({ success: true, phase: result.data?.phase })
        : `Plan request ${input.decision === 'approve' ? 'approved' : 'rejected'} (${result.data?.phase || 'recorded'}).`
    );
    return 0;
  } catch {
    deps.io.err('Plan request status is uncertain. Check it with the owner before retrying.');
    return 1;
  }
}

/** List only this session's pending owner-authorized requests, never credentials. */
export async function agentPendingPlanMoves(deps: AgentDeps): Promise<number> {
  try {
    const response = await deps.request(deps.ctx, { method: 'POST', path: '/api/plans/agent-requests/pending', body: {} });
    const body = response.json as { success?: boolean; data?: Array<{ id: string; phase: string; toAccount: string; expiresAt: number; notified: boolean }> };
    if (response.status >= 400 || !body?.success || !Array.isArray(body.data)) throw new Error('Refused');
    const requests = body.data.map(({ id, phase, toAccount, expiresAt, notified }) => ({ id, phase, toAccount, expiresAt, notified }));
    if (deps.json) deps.io.out(JSON.stringify({ success: true, requests }));
    else if (!requests.length) deps.io.out('No pending plan requests for this session.');
    else for (const r of requests) deps.io.out(`${r.id}: ${r.phase}, destination ${r.toAccount}, expires ${new Date(r.expiresAt).toISOString()}. Prepare a handoff, then use plan-move approve or reject.`);
    return 0;
  } catch { deps.io.err('Could not read this session’s pending plan requests.'); return 1; }
}
