import { constants, promises as fs } from 'node:fs';
import type { AgentDeps } from './cli-agent.js';
import { PlanRequestCapabilities, PlanRequestId } from './plan-request-capability.js';

/** The credential is read privately and sent only in the authenticated request body. */
export async function agentPlanRequest(
  deps: AgentDeps,
  input: { id: string; decision: 'approve' | 'reject'; handoffFile?: string },
  capabilities = new PlanRequestCapabilities()
): Promise<number> {
  let nonce: string, handoff: string | undefined;
  try {
    PlanRequestId.parse(input.id);
    nonce = (await capabilities.read(deps.ctx.selfId, input.id)).nonce;
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
      body: { nonce, ...(handoff === undefined ? {} : { handoff }) },
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
