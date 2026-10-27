import type { ChatMessage } from './chatroom-store.js';
import { isOwnerMark } from './owner-auth/marks.js';

/** Read-only server evidence for bounded agent tasks; never stored or accepted from a caller. */
export function agentMessage(
  message: ChatMessage,
  phoneWake: boolean,
  currentOwner: (humanId: string | undefined) => boolean
) {
  // Host-only compatibility staging; do not consult owner authority while evidence is withheld.
  const evidenceEnabled = process.env.REVERIE_OWNER_CODING_EVIDENCE === undefined ||
    process.env.REVERIE_OWNER_CODING_EVIDENCE === 'enabled';
  const authenticatedOwner = evidenceEnabled && message.from.kind === 'user' && isOwnerMark(message.from.mark) &&
    currentOwner(message.from.humanId);
  return { ...message, from: { ...message.from, authenticatedOwner }, phoneWake };
}
