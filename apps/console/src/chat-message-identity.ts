import type { ChatMessage, ChatSender } from './chatroom-store.js';

export interface ChatIdentityLookup {
  getSession(sessionId: string): { readonly owner?: string } | undefined;
  employeeOf?: (sessionId: string) => string | undefined;
  retired: ReadonlyArray<{ sessionId: string; successorId: string; owner?: string }>;
}

export function stampEmployeeSender(from: ChatSender, owner: string | undefined, lookup: ChatIdentityLookup): ChatSender {
  if (from.kind !== 'agent') return from;
  const session = lookup.getSession(from.sessionId);
  const employeeId = session && session.owner === owner ? lookup.employeeOf?.(from.sessionId) : undefined;
  return { kind: 'agent', sessionId: from.sessionId, name: from.name, ...(employeeId ? { employeeId } : {}) };
}

export function messageWithEmployeeIdentity(message: ChatMessage, owner: string | undefined, lookup: ChatIdentityLookup): ChatMessage {
  if (message.from.kind !== 'agent' || message.from.employeeId) return message;
  const visited = new Set<string>();
  let sessionId = message.from.sessionId;
  while (visited.size < 256 && !visited.has(sessionId)) {
    visited.add(sessionId);
    const session = lookup.getSession(sessionId);
    if (session && session.owner !== owner) return message;
    const retired = lookup.retired.filter((entry) => entry.sessionId === sessionId);
    if (retired.length) {
      if (retired.length !== 1 || retired[0].owner !== owner || !retired[0].successorId) return message;
      sessionId = retired[0].successorId;
      continue;
    }
    const employeeId = session ? lookup.employeeOf?.(sessionId) : undefined;
    return employeeId ? { ...message, from: { ...message.from, employeeId } } : message;
  }
  return message;
}
