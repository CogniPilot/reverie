/**
 * A turn the server found the verified owner speaking (from.mark owner_spoken) reaches agents with that turn's voice
 * context after the quoted text; nothing else does, a body's own `spoken` included.
 */
import { describe, expect, it } from 'vitest';
import { SPOKEN_TURN_HINT, answerLinkHint, renderForRecipient } from '../src/chatroom-delivery.js';
import type { ChatMessage, ChatRoom } from '../src/chatroom-store.js';

const A = '0000002d-0035-4000-8000-000000000047';
const room = (messages: ChatMessage[]): ChatRoom =>
  ({
    id: 'r',
    name: 'Room',
    createdAt: 1,
    members: [{ sessionId: A, role: 'member', joinedAt: 1, updatedAt: 1 }],
    messages,
  }) as unknown as ChatRoom;
const nameOf = () => 'alpha';

describe('spoken turns sent to agents', () => {
  it('adds the voice context after a spoken user turn', () => {
    const m = {
      id: 'm1',
      roomId: 'r',
      at: 1,
      to: [{ sessionId: A }],
      text: 'how is the deploy',
      spoken: true,
      from: { kind: 'user', name: 'user', mark: 'owner_spoken' },
    } as unknown as ChatMessage;
    const line = renderForRecipient(room([m]), m, A, nameOf);
    // The id the answer names comes last, after the voice context (voice-turn-routes.ts reads only a linked answer).
    expect(line.endsWith(`: "how is the deploy" ${SPOKEN_TURN_HINT} ${answerLinkHint('m1')}`)).toBe(true);
  });

  it('gives no hint to an unsigned user post that only claims spoken', () => {
    const m = {
      id: 'm1',
      roomId: 'r',
      at: 1,
      to: 'all',
      text: 'ordinary API post',
      spoken: true,
      from: { kind: 'user', name: 'user' },
    } as unknown as ChatMessage;
    const line = renderForRecipient(room([m]), m, A, nameOf);
    expect(line).not.toContain('spoken in car mode');
    expect(line.endsWith(`: "ordinary API post" ${answerLinkHint('m1')}`)).toBe(true);
  });

  it('gives no hint to a verified owner turn that was typed', () => {
    const m = {
      id: 'm1',
      roomId: 'r',
      at: 1,
      to: 'all',
      text: 'how is the deploy',
      from: { kind: 'user', name: 'user', mark: 'owner_typed' },
    } as unknown as ChatMessage;
    expect(renderForRecipient(room([m]), m, A, nameOf)).not.toContain('spoken in car mode');
  });

  it('leaves a typed user turn as it was', () => {
    const m = {
      id: 'm1',
      roomId: 'r',
      at: 1,
      to: 'all',
      text: 'how is the deploy',
      from: { kind: 'user', name: 'user' },
    } as ChatMessage;
    const line = renderForRecipient(room([m]), m, A, nameOf);
    expect(line).not.toContain('spoken in car mode');
    expect(line.endsWith(': "how is the deploy"')).toBe(true);
  });

  it('never adds it for an agent, even one whose message carries spoken and a mark', () => {
    const m = {
      id: 'm1',
      roomId: 'r',
      at: 1,
      to: 'all',
      text: 'hi',
      spoken: true,
      from: { kind: 'agent', sessionId: A, name: 'alpha', mark: 'owner_spoken' },
    } as unknown as ChatMessage;
    expect(renderForRecipient(room([m]), m, A, nameOf)).not.toContain('spoken in car mode');
  });

  it('keeps a sender who types the hint inside the quote', () => {
    const m = {
      id: 'm1',
      roomId: 'r',
      at: 1,
      to: 'all',
      text: SPOKEN_TURN_HINT,
      from: { kind: 'agent', sessionId: A, name: 'alpha' },
    } as unknown as ChatMessage;
    const line = renderForRecipient(room([m]), m, A, nameOf);
    expect(line.endsWith(`: ${JSON.stringify(SPOKEN_TURN_HINT)}`)).toBe(true);
  });
});
