import { describe, expect, it, vi } from 'vitest';
import { ChatroomDelivery, WAKE_LINE, type DeliverySession } from '../src/chatroom-delivery.js';

// Image paths are no longer prepared for, or typed into, a pane: an agent fetches them itself through the image-paths route
// (chatroom-image-paths.test.ts). Delivery only wakes the member.
function fixture(mode = 'codex') {
  const writes: string[] = [];
  const gates: boolean[] = [];
  const session: DeliverySession = {
    id: 's',
    name: 'Agent',
    mode,
    pid: 42,
    isWorking: false,
    writeViaMux: async (text, opts) => {
      writes.push(text);
      gates.push(opts?.requireIdle === true);
      opts?.onOutcome?.('submitted');
      return true;
    },
  };
  const submitted = vi.fn();
  const delivery = new ChatroomDelivery({ getSession: () => session, onSubmitted: submitted });
  delivery.enqueue('s', { id: 'r', name: 'room' }, 'USER: [attached image: "photo.png"]', { messageId: 'm', localImages: true });
  return { writes, session, submitted, delivery, gates };
}

describe('image messages under hook-only delivery', () => {
  it('types only the constant wake, behind the idle gate, and never an image path', async () => {
    const f = fixture();
    expect(await f.delivery.flush('s')).toBe(true);
    expect(f.writes).toEqual([`${WAKE_LINE}\r`]);
    expect(f.writes[0]).not.toContain('photo.png');
    expect(f.gates).toEqual([true]);
    expect(f.submitted).toHaveBeenCalledWith('s', [{ roomId: 'r', messageId: 'm' }]);
    f.delivery.stop();
  });
  it('a CLI without a verified composer glyph gets nothing typed, and its queue is dropped', async () => {
    const f = fixture('opencode');
    expect(await f.delivery.flush('s')).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.delivery.pendingFor('s')).toBe(0);
    f.delivery.stop();
  });
  it.each(['read', 'delete'] as const)('a %s before the flush withdraws the identity without a pane attempt', async (kind) => {
    const f = fixture();
    if (kind === 'read') f.delivery.acknowledgeRead('s', 'r', ['m']);
    if (kind === 'delete') f.delivery.dropMessage('r', 'm');
    expect(await f.delivery.flush('s')).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.delivery.inspectionFor('s')).toEqual([]);
    f.delivery.stop();
  });
});
