/**
 * A session with unconfirmed (held) deliveries still gets new lines once its pane is idle with a provably empty composer:
 * a pointer line says how many are held, held messages are never typed again, and the hold stays until they are read.
 * Without that proof, or when the write refuses before any key, nothing is typed and nothing new becomes uncertain.
 */
import { describe, expect, it } from 'vitest';
import { ChatroomDelivery, type DeliverySession } from '../src/chatroom-delivery.js';

type Options = Parameters<DeliverySession['writeViaMux']>[1];

function fixture(opts: { provable?: boolean | undefined; refuse?: boolean } = {}) {
  const writes: Array<{ text: string; options: Options }> = [];
  const state = { provable: 'provable' in opts ? opts.provable : true, refuse: opts.refuse ?? false };
  const session: DeliverySession = {
    id: 's', name: 'Agent', mode: 'claude', pid: 42, isWorking: false,
    ...(state.provable === undefined ? {} : { composerProvablyIdle: () => state.provable === true }),
    writeViaMux: async (text, options) => {
      if (state.refuse && options?.requireIdle) {
        options.onIdleRefused?.();
        return false;
      }
      writes.push({ text, options });
      options?.onOutcome?.('submitted');
      return true;
    },
  };
  const uncertain: unknown[] = [];
  const delivery = new ChatroomDelivery({ getSession: () => session, onUncertain: (_s, m) => uncertain.push(...m), now: () => 1_000_000 });
  delivery.holdForInspection('s', [{ roomId: 'office', messageId: 'old-1' }, { roomId: 'office', messageId: 'old-2' }]);
  delivery.enqueue('s', { id: 'break', name: 'break room' }, '@Alex check in please', { messageId: 'new-1' });
  return { delivery, writes, state, uncertain };
}

describe('delivery to a session with unconfirmed earlier lines', () => {
  it('waits while the composer is not provably empty, as before', async () => {
    const f = fixture({ provable: false });
    expect(await f.delivery.flush('s')).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.delivery.pendingFor('s')).toBe(1);
  });

  it('fails closed for a harness that cannot prove its composer empty', async () => {
    const f = fixture({ provable: undefined });
    expect(await f.delivery.flush('s')).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('delivers a new line with a pointer to the held ones, never retypes them, and keeps the hold until read', async () => {
    const f = fixture();
    expect(await f.delivery.flush('s')).toBe(true);
    expect(f.writes).toHaveLength(1);
    const line = f.writes[0]!.text;
    expect(line).toContain('SYSTEM: 2 earlier messages may not have reached you and were not pasted again (read them with reverie agent chat read)');
    expect(line).toContain('@Alex check in please');
    expect(line).not.toContain('old-1');
    expect(f.writes[0]!.options?.requireIdle).toBe(true);
    expect(f.delivery.inspectionFor('s').map((m) => m.messageId).sort()).toEqual(['old-1', 'old-2']);
    f.delivery.acknowledgeRead('s', 'office', ['old-1', 'old-2']);
    expect(f.delivery.inspectionFor('s')).toEqual([]);
  });

  it('requeues, not uncertain, when the write refuses before any key', async () => {
    const f = fixture({ refuse: true });
    expect(await f.delivery.flush('s')).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.uncertain).toEqual([]);
    expect(f.delivery.inspectionFor('s').map((m) => m.messageId).sort()).toEqual(['old-1', 'old-2']);
    expect(f.delivery.queuedMessagesFor('s')).toEqual([{ roomId: 'break', messageId: 'new-1' }]);
    f.state.refuse = false;
    // The spacing guard measures from the refused attempt; a later clock is the next poll.
    (f.delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear();
    expect(await f.delivery.flush('s')).toBe(true);
    expect(f.writes[0]!.text.match(/SYSTEM: 2 earlier/g)).toHaveLength(1);
  });

  it('adds no pointer and no idle requirement when nothing is held', async () => {
    const f = fixture();
    f.delivery.acknowledgeRead('s', 'office', ['old-1', 'old-2']);
    expect(await f.delivery.flush('s')).toBe(true);
    expect(f.writes[0]!.text).not.toContain('may not have reached you');
    expect(f.writes[0]!.options?.requireIdle).toBeUndefined();
  });
});
