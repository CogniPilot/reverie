/**
 * Delivery types room text plus Enter into a pane. Only agent CLIs read that as a prompt;
 * a shell would execute it. The guard sits in flush(), the one place that writes.
 */
import { describe, expect, it } from 'vitest';
import { ChatroomDelivery, modePollsChat, paneAcceptsChat, type DeliverySession } from '../src/chatroom-delivery.js';
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
  it('types into agent panes but never into shell or unknown panes, and drops their queue', async () => {
    const sessions = new Map([
      ['agent', pane('agent', 'opencode')],
      ['shell', pane('shell', 'shell')],
      ['odd', pane('odd', 'something-new')],
    ]);
    const delivery = new ChatroomDelivery({ getSession: (id) => sessions.get(id), now: () => 1_000_000 });
    const room = { id: 'r', name: 'Room' };
    for (const id of sessions.keys()) delivery.enqueue(id, room, 'USER: rm -rf ~');
    await delivery.flushAll();
    expect(sessions.get('agent')!.writes).toHaveLength(1);
    expect(sessions.get('shell')!.writes).toEqual([]);
    expect(sessions.get('odd')!.writes).toEqual([]);
    expect(delivery.pendingFor('shell')).toBe(0);
    expect(delivery.pendingFor('odd')).toBe(0);
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

  it('types no control character: a stray DEL in any builder\'s text is turned into a space on the final line, and what does not fit waits', async () => {
    const agent = pane('agent', 'opencode');
    const delivery = new ChatroomDelivery({ getSession: () => agent, now: () => 1_000_000 });
    const room = { id: 'r', name: 'Room' };
    delivery.enqueue('agent', room, `USER -> you: x${String.fromCharCode(0x7f).repeat(5)}y${String.fromCharCode(0x85)}z`);
    for (let i = 1; i <= 6; i++) delivery.enqueue('agent', room, `"alpha" -> you: "${String(i).repeat(600)}"`);
    await delivery.flushAll();
    const first = agent.writes.join('');
    expect(new RegExp('[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f]').test(first.slice(0, -1))).toBe(false);
    expect(first.endsWith('\r')).toBe(true);
    expect(first).not.toContain('more message');
    // the messages that did not fit are still queued for the next delivery
    expect(delivery.pendingFor('agent')).toBeGreaterThan(0);
  });
});
