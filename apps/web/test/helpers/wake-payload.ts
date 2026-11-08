import { WAKE_LINE, pollSummary } from '../../src/chatroom-delivery.js';
import type { ChatroomService } from '../../src/chatroom-service.js';
import type { DeliverySession } from '../../src/chatroom-delivery.js';

/**
 * What one wake stood for, as the member's own hook payload shows it. Delivery only ever types WAKE_LINE; while that write
 * is in flight, its carried batch is held in the member's turn summary as delivery-unconfirmed. Each carried message is one
 * `<messageId> <excerpt>` line. Anything other than the wake line reaching the pane throws.
 */
export function wakePayload(service: ChatroomService | undefined, sessionId: string, typed: string): string {
  if (typed !== `${WAKE_LINE}\r`) throw new Error(`message content typed into a pane: ${typed}`);
  return (service?.turnSummary(sessionId).messages ?? [])
    .filter((m) => m.transport === 'delivery-unconfirmed')
    .map((m) => `${m.messageId} ${m.excerpt}`)
    .join('\n');
}

/**
 * Wraps a mock session's pane write so that each wake records the batch it carried for that member: the messages delivery
 * holds for it during the write, in batch order, one `sender: text [(replying to id)] [reply hint]` line each, with the reply
 * hint the member's hook gives that message. The pane itself still receives only the wake line. Returns the per-wake records,
 * oldest first.
 */
export function recordCarried(
  session: { id: string; writeViaMux: DeliverySession['writeViaMux'] },
  service: () => ChatroomService | undefined
): string[] {
  const carried: string[] = [];
  const seen = new Set<string>();
  const write = session.writeViaMux.bind(session);
  session.writeViaMux = async (text, options) => {
    if (text !== `${WAKE_LINE}\r`) throw new Error(`message content typed into a pane: ${text}`);
    const chat = service();
    const hints = new Map((chat?.turnSummary(session.id).messages ?? []).map((m) => [m.messageId, m.replyHint]));
    const fresh = (chat?.delivery.inspectionFor(session.id) ?? []).filter(({ roomId, messageId }) => !seen.has(`${roomId}\0${messageId}`));
    for (const { roomId, messageId } of fresh) seen.add(`${roomId}\0${messageId}`);
    carried.push(
      fresh
        .map(({ roomId, messageId }) => {
          const m = chat?.room(roomId)?.messages.find((x) => x.id === messageId);
          const hint = hints.get(messageId);
          return m ? `${m.from.name}: ${m.poll ? pollSummary(m) : m.text}${m.replyTo ? ` (replying to ${m.replyTo})` : ''}${hint ? ` ${hint}` : ''}` : messageId;
        })
        .join('\n')
    );
    return write(text, options);
  };
  return carried;
}

/** A member's still-pending room briefings, which reach it through its hook payload rather than its pane. */
export function pendingBriefings(service: ChatroomService, sessionId: string): string {
  return service.delivery.pendingBriefs(sessionId).map((b) => b.text).join('\n');
}

/** A member's still-pending Reverie notices, which also reach it only through its hook payload. */
export function pendingNotices(service: ChatroomService, sessionId: string): string {
  return service.delivery.pendingNotices(sessionId).map((n) => n.text).join('\n');
}
