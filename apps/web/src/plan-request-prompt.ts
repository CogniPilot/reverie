import { setTimeout as delay } from 'node:timers/promises';
import { getCli } from './config/cli-registry/registry.js';
import { deliverRecoveryPrompt, type RecoveryPromptSession } from './company-recovery-prompt.js';
import type { PlanRequestView } from './plan-request.js';

/** Queue a nonce-free instruction after current work; never interrupt an active composer. */
export async function deliverPlanRequest(
  record: PlanRequestView,
  current: () => RecoveryPromptSession | undefined,
  allowed: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => delay(ms, undefined, { ref: false })
): Promise<void> {
  while (allowed()) {
    const session = current();
    if (!session || session.pid === null) throw new Error('The source session is unavailable');
    const mark = getCli(session.mode)?.capabilities.composerReadyMark;
    if (!mark) throw new Error('The source has no safe composer marker');
    if (!session.isWorking && !session.paneDialog && session.terminalBuffer.includes(mark)) {
      const harness = record.targetMode ? ` The destination uses the ${record.targetMode === 'codex' ? 'Codex' : 'Claude'} harness${record.targetMode !== record.mode ? ' with that provider’s model and effort defaults' : ''}.` : '';
      const text = `${record.requestedBy ? 'An owner-authorized expert' : 'The owner'} requested plan move ${record.id} for this expert, from ${JSON.stringify(record.fromAccount)} to ${JSON.stringify(record.toAccount)}.${harness} This is a request, not an immediate switch. Finish a safe handoff for your current work, then run reverie agent plan-move approve ${record.id} --handoff-file <your-handoff-file>. The CLI reads your private one-time approval credential itself; never print or copy it. If the move is unsuitable, run reverie agent plan-move reject ${record.id}. Approval starts a fresh destination session with your handoff and stops this source only after the replacement is ready. Use this approval command rather than calling the owner-only session creation API directly. Do not interrupt unfinished work or approve a different expert's request.`;
      await deliverRecoveryPrompt(session, text, () => allowed() && current() === session, sleep);
      return;
    }
    await sleep(1000);
  }
  throw new Error('The plan request is no longer authorized');
}
