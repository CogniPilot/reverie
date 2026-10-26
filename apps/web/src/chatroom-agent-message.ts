import type { ChatMessage } from './chatroom-store.js';
import { isOwnerMark } from './owner-auth/marks.js';

/** Read-only server evidence for bounded agent tasks; never stored or accepted from a caller. */
export function agentMessage(
  message: ChatMessage,
  phoneWake: boolean,
  currentOwner: (humanId: string | undefined) => boolean
) {
  const authenticatedOwner = message.from.kind === 'user' && isOwnerMark(message.from.mark) &&
    currentOwner(message.from.humanId);
  return { ...message, from: { ...message.from, authenticatedOwner }, phoneWake };
}
