import { displayTime } from './display-time.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatroomService } from './chatroom-service.js';
import type { PlanRequestView } from './plan-request.js';

export type PlanRequestMessages = Pick<ChatroomService, 'openDm' | 'post' | 'lastSeen' | 'deleteMessage'> & { displayTimeZone?(owner?: string): string };

/** A nonce-free DM is readable immediately; the existing chat queue handles busy panes. */
export async function deliverPlanRequest(
  record: PlanRequestView,
  messages: PlanRequestMessages,
  allowed: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => delay(ms, undefined, { ref: false })
): Promise<void> {
  if (!allowed()) throw new Error('The plan request is no longer authorized');
  const harness = record.targetMode ? ` The destination uses the ${record.targetMode === 'codex' ? 'Codex' : 'Claude'} harness${record.targetMode !== record.mode ? ' with that provider’s model and effort defaults' : ''}.` : '';
  const action = record.purpose === 'runtime-refresh'
    ? `a runtime refresh ${record.id} on the current account ${JSON.stringify(record.fromAccount)}, preserving the selected runtime settings`
    : `plan move ${record.id} for this expert, from ${JSON.stringify(record.fromAccount)} to ${JSON.stringify(record.toAccount)}`;
  const text = `${record.requestedBy ? 'An owner-authorized expert' : 'The owner'} requested ${action}.${harness} This is a request, not an immediate switch. Finish a safe handoff for your current work, then run reverie agent plan-move approve ${record.id} --handoff-file <your-handoff-file>. The CLI reads your private one-time approval credential itself; never print or copy it. If the request is unsuitable, run reverie agent plan-move reject ${record.id}. Approval reserves the replacement, verifies source cleanup, then starts and checks the fresh destination before delivering your handoff. Use this approval command rather than calling the owner-only session creation API directly. Do not interrupt unfinished work or approve a different expert's request.`;

  const room = messages.openDm(record.sessionId, record.owner);
  const message = messages.post(room.id, { kind: 'system', name: 'Plans' },
    text + ` This request expires at ${displayTime(record.expiresAt, messages.displayTimeZone?.(record.owner))}. Use reverie agent plan-move list to inspect your pending requests.`,
    [record.sessionId]);
  const received = () => {
    const seen = messages.lastSeen(record.sessionId, room.id);
    return !!seen && (seen.messageId === message.id || seen.at > message.at);
  };
  while (allowed()) {
    if (received()) return;
    await sleep(1000);
  }
  // Drop only this notice; its expired/revoked credential already prevents any move.
  if (!received()) await messages.deleteMessage(room.id, message.id, 'Plans').catch(() => {});
  throw new Error('The plan request is no longer authorized');
}
