/**
 * Which room(s) the last prompt written to a session came from: what `chat say` with no --room replies to.
 */
import { describe, expect, it } from 'vitest';
import { ChatroomDelivery, LAST_DELIVERY_WINDOW_MS, type DeliverySession } from '../src/chatroom-delivery.js';

function pane(): DeliverySession & { writes: string[]; ok: boolean } {
  const writes: string[] = [];
  const p = {
    id: 'p',
    name: 'p',
    mode: 'claude',
    isWorking: false,
    pid: 1,
    writes,
    ok: true,
    writeViaMux: async (data: string) => {
      if (!p.ok) return false;
      writes.push(data);
      return true;
    },
  };
  return p;
}
const R1 = { id: 'room-1', name: 'One' };
const R2 = { id: 'room-2', name: 'Two' };

describe('rooms of the last delivery', () => {
  it('is nothing before anything is delivered, one room for a single-room prompt, and each room once for a bundle', async () => {
    let clock = 1_000_000;
    const s = pane();
    const delivery = new ChatroomDelivery({ getSession: () => s, now: () => clock });
    expect(delivery.lastDeliveryRooms('p')).toBeUndefined();
    delivery.enqueue('p', R1, '"a" -> everyone: "one"', { messageId: 'm' });
    delivery.enqueue('p', R1, '"a" -> everyone: "again"', { messageId: 'm' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')).toEqual({ roomIds: ['room-1'], at: 1_000_000 });
    clock += 60_000;
    delivery.enqueue('p', R1, '"a" -> everyone: "x"', { messageId: 'm' });
    delivery.enqueue('p', R2, '"b" -> everyone: "y"', { messageId: 'm' });
    delivery.enqueue('p', R1, '"a" -> everyone: "z"', { messageId: 'm' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-1', 'room-2']);
    // the next prompt is about one room again: the default follows it
    clock += 60_000;
    delivery.enqueue('p', R2, '"b" -> everyone: "only two"', { messageId: 'm' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')).toEqual({ roomIds: ['room-2'], at: 1_120_000 });
  });

  it('counts only a line that was written: a failed write keeps the previous answer, and forgetting clears it', async () => {
    let clock = 1_000_000;
    const s = pane();
    const delivery = new ChatroomDelivery({ getSession: () => s, now: () => clock });
    delivery.enqueue('p', R1, '"a" -> everyone: "one"', { messageId: 'm' });
    await delivery.flushAll();
    clock += 60_000;
    s.ok = false;
    delivery.enqueue('p', R2, '"b" -> everyone: "lost for now"', { messageId: 'm' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-1']);
    delivery.forget('p');
    expect(delivery.lastDeliveryRooms('p')).toBeUndefined();
  });

  it('counts only the rooms of the fragments that fitted in the line, not of those left for the next one', async () => {
    let clock = 1_000_000;
    const s = pane();
    const delivery = new ChatroomDelivery({ getSession: () => s, now: () => clock });
    delivery.enqueue('p', R1, `"a" -> everyone: "${'x'.repeat(2000)}"`, { messageId: 'm' });
    delivery.enqueue('p', R2, `"b" -> everyone: "${'y'.repeat(2000)}"`, { messageId: 'm' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-1']);
    clock += 60_000;
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-2']);
  });

  it('a re-briefing or a system notice about another room never moves the default room', async () => {
    let clock = 1_000_000;
    const s = pane();
    const delivery = new ChatroomDelivery({ getSession: () => s, now: () => clock });
    delivery.enqueue('p', R1, '"a" -> everyone: "real message"', { messageId: 'm1' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-1']);
    clock += 60_000;
    delivery.enqueue('p', R2, () => 'You are a member of Two. Briefing.', { brief: true });
    delivery.enqueue('p', R2, 'SYSTEM -> you: someone joined the room');
    await delivery.flushAll();
    expect(s.writes).toHaveLength(2); // both were really written
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-1']);
    // a line that mixes a notice from room two with a message from room one is about room one
    clock += 60_000;
    delivery.enqueue('p', R2, 'SYSTEM -> everyone: someone is now the coordinator');
    delivery.enqueue('p', R1, '"a" -> everyone: "second"', { messageId: 'm2' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-1']);
    // and a member with only notices so far has no default at all
    const fresh = pane();
    const other = new ChatroomDelivery({ getSession: () => fresh, now: () => clock });
    other.enqueue('p', R2, () => 'Briefing', { brief: true });
    await other.flushAll();
    expect(other.lastDeliveryRooms('p')).toBeUndefined();
  });

  it('the default expires: an old delivery gives no room, a new one gives it again', async () => {
    let clock = 1_000_000;
    const s = pane();
    const delivery = new ChatroomDelivery({ getSession: () => s, now: () => clock });
    delivery.enqueue('p', R1, '"a" -> everyone: "hi"', { messageId: 'm1' });
    await delivery.flushAll();
    // the window itself is pinned to its value (30 minutes), so a changed constant cannot slip through a test that reads it back
    expect(LAST_DELIVERY_WINDOW_MS).toBe(30 * 60 * 1000);
    clock += 30 * 60 * 1000;
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-1']); // exactly at the edge still counts
    clock += 1;
    expect(delivery.lastDeliveryRooms('p')).toBeUndefined();
    clock += 60_000;
    delivery.enqueue('p', R2, '"b" -> everyone: "again"', { messageId: 'm2' });
    await delivery.flushAll();
    expect(delivery.lastDeliveryRooms('p')?.roomIds).toEqual(['room-2']);
  });
});
