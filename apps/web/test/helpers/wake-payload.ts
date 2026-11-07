import { WAKE_LINE } from '../../src/chatroom-delivery.js';
import type { ChatroomService } from '../../src/chatroom-service.js';

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
