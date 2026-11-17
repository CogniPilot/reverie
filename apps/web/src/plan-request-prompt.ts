import { displayTime } from './display-time.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatroomService } from './chatroom-service.js';
import type { PlanRequestView } from './plan-request.js';
import type { CompanyEmployee } from './company-types.js';

export type PlanRequestMessages = Pick<ChatroomService, 'openDm' | 'post' | 'lastSeen' | 'deleteMessage'> & { displayTimeZone?(owner?: string): string };

/** Instruction compatibility DATA only, never decision authorization. */
export function planRequestWorkerRouting(
  record: Pick<PlanRequestView, 'employeeId' | 'owner' | 'sessionId'>,
  employees: readonly Pick<CompanyEmployee, 'id' | 'owner' | 'sessionId' | 'sessionGeneration' | 'dockerBinding'>[]
): boolean {
  const matches = employees.filter(employee => employee.id === record.employeeId), employee = matches[0];
  const binding = employee?.dockerBinding;
  return matches.length === 1 && employee?.owner === record.owner && employee.sessionId === record.sessionId &&
    Number.isSafeInteger(employee.sessionGeneration) && employee.sessionGeneration > 0 &&
    binding?.sessionId === record.sessionId && binding.sessionGeneration === employee.sessionGeneration;
}

/** A nonce-free DM is readable immediately; the existing chat queue handles busy panes. */
export async function deliverPlanRequest(
  record: PlanRequestView,
  messages: PlanRequestMessages,
  allowed: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => delay(ms, undefined, { ref: false }),
  options: {
    /** Legacy installed-client routing only; genuine worker/session/grant checks remain mandatory. */
    workerRouting?: boolean;
    /** True only when the request ran out of time while otherwise still valid (from its owner; see PlanRequestPort.notify). */
    expiredUnseen?: () => boolean;
    /** Tells the owner once when the request expired before the expert saw it; the credential's lifetime is unchanged. */
    ownerAlert?: (text: string, owner?: string) => Promise<unknown> | unknown;
  } = {}
): Promise<void> {
  if (!allowed()) throw new Error('The plan request is no longer authorized');
  const command = options.workerRouting === true ? 'REVERIE_WORKER=1 reverie agent plan-move' : 'reverie agent plan-move';
  const harness = record.targetMode ? ` The destination uses the ${record.targetMode === 'codex' ? 'Codex' : 'Claude'} harness${record.targetMode !== record.mode ? ' with that provider’s model and effort defaults' : ''}.` : '';
  const action = record.purpose === 'runtime-refresh'
    ? `a runtime refresh ${record.id} on the current account ${JSON.stringify(record.fromAccount)}, preserving the selected runtime settings`
    : `plan move ${record.id} for this expert, from ${JSON.stringify(record.fromAccount)} to ${JSON.stringify(record.toAccount)}`;
  const text = `${record.requestedBy ? 'An owner-authorized expert' : 'The owner'} requested ${action}.${harness} This is a request, not an immediate switch. Finish a safe handoff for your current work, then run ${command} approve ${record.id} --handoff-file <your-handoff-file>. The CLI reads your private one-time approval credential itself; never print or copy it. If the request is unsuitable, run ${command} reject ${record.id}. Approval reserves the replacement, verifies source cleanup, then starts and checks the fresh destination before delivering your handoff. Use this approval command rather than calling the owner-only session creation API directly. Do not interrupt unfinished work or approve a different expert's request.`;

  const room = messages.openDm(record.sessionId, record.owner);
  const message = messages.post(room.id, { kind: 'system', name: 'Plans' },
    text + ` This request expires at ${displayTime(record.expiresAt, messages.displayTimeZone?.(record.owner))}. Use ${command} list to inspect your pending requests.`,
    [record.sessionId]);
  const received = () => {
    const seen = messages.lastSeen(record.sessionId, room.id);
    return !!seen && (seen.messageId === message.id || seen.at > message.at);
  };
  while (allowed()) {
    if (received()) return;
    await sleep(1000);
  }
  // Decided now, before any cleanup await, so time passing during cleanup cannot turn another ending into "expired".
  const expired = !received() && options.expiredUnseen?.() === true;
  // Drop only this notice; its expired/revoked credential already prevents any move.
  if (!received()) {
    await messages.deleteMessage(room.id, message.id, 'Plans').catch(() => {});
    // The expert was busy the whole window: say so instead of leaving a silent state change on the Plans page.
    // The instruction comes first and the name is bounded, so the whole alert fits a push body.
    if (expired)
      await Promise.resolve()
        .then(() => options.ownerAlert?.(`Reauthorize on Plans when idle: the move for ${(record.name || 'an expert').slice(0, 60)} expired unseen. Nothing was switched.`, record.owner))
        .catch(() => {});
  }
  throw new Error('The plan request is no longer authorized');
}
