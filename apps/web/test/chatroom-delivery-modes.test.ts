/**
 * Delivery types room text plus Enter into a pane. Only agent CLIs read that as a prompt;
 * a shell would execute it. The guard sits in flush(), the one place that writes.
 */
import { describe, expect, it } from 'vitest';
import { ChatroomDelivery, WAKE_LINE, modePollsChat, paneAcceptsChat, paneWakes, type DeliverySession } from '../src/chatroom-delivery.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

function pane(id: string, mode: string): DeliverySession & { writes: string[] } {
  const writes: string[] = [];
  return {
    id,
    name: id,
    mode,
    isWorking: false,
    pid: 42,
    writes,
    writeViaMux: async (data: string) => {
      writes.push(data);
      return true;
    },
  };
}

describe('chatroom delivery by session mode', () => {
  it('retains queued chat until a migration releases its composer', async () => {
    const session = pane('agent', 'codex');
    const delivery = new ChatroomDelivery({getSession: () => session, now: () => 1_000_000});
    const release = delivery.pauseForMigration('agent');
    delivery.enqueue('agent', {id: 'room', name: 'Room'}, 'USER: after migration');
    expect(await delivery.flush('agent')).toBe(false);
    expect(session.writes).toEqual([]);
    expect(delivery.pendingFor('agent')).toBe(1);
    release(); release();
    await delivery.flush('agent');
    expect(session.writes).toHaveLength(1);
  });
  it('wakes only a verified-composer agent pane, never with the text; other agents, shells and unknown panes get nothing', async () => {
    const sessions = new Map([
      ['agent', pane('agent', 'claude')],
      ['unverified', pane('unverified', 'opencode')],
      ['shell', pane('shell', 'shell')],
      ['odd', pane('odd', 'something-new')],
    ]);
    const delivery = new ChatroomDelivery({ getSession: (id) => sessions.get(id), now: () => 1_000_000 });
    const room = { id: 'r', name: 'Room' };
    for (const id of sessions.keys()) delivery.enqueue(id, room, 'USER: rm -rf ~');
    await delivery.flushAll();
    expect(sessions.get('agent')!.writes).toEqual([`${WAKE_LINE}\r`]);
    for (const id of ['unverified', 'shell', 'odd']) {
      expect(sessions.get(id)!.writes).toEqual([]);
      expect(delivery.pendingFor(id)).toBe(0);
    }
    expect(paneWakes('claude')).toBe(true);
    expect(paneWakes('codex')).toBe(true);
    expect(paneWakes('opencode')).toBe(false);
    expect(paneWakes('shell')).toBe(false);
  });

  it('uses the shipped kind for stock CLIs; shells and unknown modes never', () => {
    expect(paneAcceptsChat('shell')).toBe(false);
    expect(paneAcceptsChat(undefined)).toBe(false);
    expect(paneAcceptsChat('toString')).toBe(false);
    expect(paneAcceptsChat('claude')).toBe(true);
    for (const cli of STOCK_CLIS) {
      expect(modePollsChat(cli.id as string)).toBe(cli.kind === 'agent' && cli.capabilities.chatDelivery === 'poll');
      expect(paneAcceptsChat(cli.id as string)).toBe(cli.kind === 'agent' && cli.capabilities.chatDelivery !== 'poll');
    }
  });

  it('never injects room text into a stock polling harness pane', async () => {
    const hands = pane('hands-member', 'hands');
    const delivery = new ChatroomDelivery({ getSession: () => hands, now: () => 1_000_000 });
    delivery.enqueue(hands.id, { id: 'r', name: 'Room' }, 'USER: room turn');
    await delivery.flushAll();
    expect(modePollsChat('hands')).toBe(true);
    expect(paneAcceptsChat('hands')).toBe(false);
    expect(hands.writes).toEqual([]);
    expect(delivery.pendingFor(hands.id)).toBe(0);
  });

  it('types only the constant wake, whatever the queued text holds, and one wake covers the whole batch', async () => {
    const agent = pane('agent', 'claude');
    const delivery = new ChatroomDelivery({ getSession: () => agent, now: () => 1_000_000 });
    const room = { id: 'r', name: 'Room' };
    delivery.enqueue('agent', room, `USER -> you: x${String.fromCharCode(0x7f).repeat(5)}y${String.fromCharCode(0x85)}z`);
    for (let i = 1; i <= 6; i++) delivery.enqueue('agent', room, `"alpha" -> you: "${String(i).repeat(600)}"`);
    await delivery.flushAll();
    expect(agent.writes).toEqual([`${WAKE_LINE}\r`]);
    expect(delivery.pendingFor('agent')).toBe(0);
  });
});
