/**
 * A seat whose chat has waited 10 min for anything but a busy turn is reported once to each waiting room's coordinator and
 * the owner, with the fixed reason text. Nothing is typed, cleared or resent, and a stuck seat is never told about itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomDelivery, DELIVERY_WAIT_TEXT, STALLED_ALERT_MS, STALLED_REPEAT_MS, type DeliverySession, type DeliveryStall } from '../src/chatroom-delivery.js';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';

type Options = Parameters<DeliverySession['writeViaMux']>[1];
const MIN = 60_000;

function fixture() {
  const clock = { now: 1_000_000 };
  const writes: string[] = [];
  const stalls: Array<[string, DeliveryStall]> = [];
  const session: DeliverySession & { canAcceptChatInput?: () => boolean } = {
    id: 's', name: 'Agent', mode: 'claude', pid: 42, isWorking: false,
    composerProvablyIdle: () => true,
    writeViaMux: async (text: string, options: Options) => { writes.push(text); options?.onOutcome?.('submitted'); return true; },
  };
  const delivery = new ChatroomDelivery({ getSession: () => session, now: () => clock.now, onStalled: (id, stall) => stalls.push([id, stall]) });
  const poll = async () => {
    (delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear();
    return delivery.flush('s');
  };
  return { delivery, session, clock, writes, stalls, poll };
}

describe('stalled seat detection', () => {
  it('reports once, after 10 min, with the waiting rooms and count', async () => {
    const f = fixture();
    f.session.canAcceptChatInput = () => false;
    f.delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent one', { messageId: 'm-1' });
    f.delivery.enqueue('s', { id: 'dev', name: 'dev' }, '@Agent two', { messageId: 'm-2' });
    await f.poll();
    f.clock.now += STALLED_ALERT_MS - 1; await f.poll();
    expect(f.stalls).toEqual([]);
    f.clock.now += 1; await f.poll();
    expect(f.stalls).toEqual([['s', { reason: 'input_closed', since: 1_000_000, roomIds: ['office', 'dev'], waiting: 2 }]]);
    // The same wait, still unresolved 40 min later, is not reported again.
    for (let i = 0; i < 8; i++) { f.clock.now += 5 * MIN; await f.poll(); }
    expect(f.stalls).toHaveLength(1);
    expect(f.writes).toEqual([]);
  });

  it('never reports a busy turn, however long', async () => {
    const f = fixture();
    f.session.isWorking = true;
    f.delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent one', { messageId: 'm-1' });
    for (let i = 0; i < 12; i++) { f.clock.now += 5 * MIN; await f.poll(); }
    expect(f.stalls).toEqual([]);
  });

  it('a new wait is reported again, but not within 30 min of the last report', async () => {
    const f = fixture();
    f.session.canAcceptChatInput = () => false;
    f.delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent one', { messageId: 'm-1' });
    await f.poll(); f.clock.now += STALLED_ALERT_MS; await f.poll();
    expect(f.stalls).toHaveLength(1);
    f.session.canAcceptChatInput = undefined; await f.poll();
    expect(f.writes).toHaveLength(1);
    f.session.canAcceptChatInput = () => false;
    f.delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent two', { messageId: 'm-2' });
    await f.poll(); f.clock.now += STALLED_ALERT_MS; await f.poll();
    expect(f.stalls).toHaveLength(1);
    f.clock.now += STALLED_REPEAT_MS; await f.poll();
    expect(f.stalls).toHaveLength(2);
    expect(f.stalls[1][1].reason).toBe('input_closed');
  });

  it('does nothing without a waking line', async () => {
    const f = fixture();
    f.session.canAcceptChatInput = () => false;
    for (let i = 0; i < 4; i++) { f.clock.now += 5 * MIN; await f.poll(); }
    expect(f.stalls).toEqual([]);
  });
});

describe('the stalled-seat notice', () => {
  const services: ChatroomService[] = [];
  afterEach(async () => { for (const s of services.splice(0)) await s.stop(); });

  it('goes to the room coordinator and the owner, with the fixed reason, and raises the owner alert', async () => {
    let clock = 1_000_000;
    const alerts: string[] = [];
    const writes: Record<string, string[]> = { stuck: [], lead: [] };
    const sessions = new Map<string, ChatSessionLike & { isWorking: boolean; canAcceptChatInput?: () => boolean }>();
    for (const id of ['stuck', 'lead']) sessions.set(id, {
      id, name: id === 'stuck' ? 'Robin' : 'Lead', status: 'idle', mode: 'claude', pid: 1, isWorking: false,
      writeViaMux: async (text: string, options: Options) => { writes[id].push(text); options?.onOutcome?.('submitted'); return true; },
    });
    sessions.get('stuck')!.canAcceptChatInput = () => false;
    const service = new ChatroomService({ file: join(mkdtempSync(join(tmpdir(), 'stall-')), 'chatrooms.json'),
      getSession: (id) => sessions.get(id), broadcast: () => {}, now: () => clock, alert: (text) => { alerts.push(text); } });
    await service.init(); services.push(service);
    const room = service.createRoom('Office', undefined);
    service.addMember(room.id, 'lead', { role: 'coordinator' });
    service.addMember(room.id, 'stuck', {});
    service.post(room.id, { kind: 'user', name: 'Owner' }, 'please check the build', ['stuck']);
    const flush = async () => { (service.delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear(); await service.delivery.flushAll(); };
    await flush();
    clock += STALLED_ALERT_MS; await flush();
    const notice = service.room(room.id)!.messages.filter((m) => m.from.kind === 'system' && m.text.includes('waiting for'));
    expect(notice).toHaveLength(1);
    // The room briefing queued on joining counts as a waiting line too.
    expect(notice[0].text).toBe(`Robin has had 2 messages waiting for 10 min: ${DELIVERY_WAIT_TEXT.input_closed}.`);
    expect(notice[0].to).toEqual(['lead', 'user']);
    expect(alerts).toContain(notice[0].text);
    expect(notice[0].text).not.toContain('please check the build');
    expect(writes.stuck.filter((w) => w.includes('waiting for'))).toEqual([]);
    // It reaches the coordinator itself: listed in its pending summary as needing action, and typed into its pane through
    // normal delivery. The stuck seat is never told.
    expect(service.turnSummary('lead').messages.find((m) => m.messageId === notice[0].id)?.state).toBe('reply-pending');
    expect(service.turnSummary('stuck').messages.some((m) => m.messageId === notice[0].id)).toBe(false);
    await flush();
    expect(writes.lead.some((w) => w.includes('waiting for 10 min'))).toBe(true);
    // It needs action, so it stays in the coordinator's summary after delivery until the coordinator handles it.
    expect(service.turnSummary('lead').messages.find((m) => m.messageId === notice[0].id)?.state).toBe('reply-pending');
    expect(writes.stuck.filter((w) => w.includes('waiting for'))).toEqual([]);
    // Room-wide system lines stay out of the summary, as before.
    expect(service.turnSummary('lead').messages.every((m) => m.messageId === notice[0].id ||
      service.room(room.id)!.messages.find((x) => x.id === m.messageId)?.from.kind !== 'system')).toBe(true);
  });

  it('without a coordinator, tells only the owner', async () => {
    let clock = 1_000_000;
    const alerts: string[] = [];
    const sessions = new Map<string, ChatSessionLike & { isWorking: boolean; canAcceptChatInput?: () => boolean }>();
    sessions.set('stuck', { id: 'stuck', name: 'Robin', status: 'idle', mode: 'claude', pid: 1, isWorking: false,
      canAcceptChatInput: () => false, writeViaMux: async () => true });
    const service = new ChatroomService({ file: join(mkdtempSync(join(tmpdir(), 'stall-')), 'chatrooms.json'),
      getSession: (id) => sessions.get(id), broadcast: () => {}, now: () => clock, alert: (text) => { alerts.push(text); } });
    await service.init(); services.push(service);
    const room = service.createRoom('Lab', undefined);
    service.addMember(room.id, 'stuck', {});
    service.post(room.id, { kind: 'user', name: 'Owner' }, 'ping', ['stuck']);
    const flush = async () => { (service.delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear(); await service.delivery.flushAll(); };
    await flush(); clock += STALLED_ALERT_MS; await flush();
    const notice = service.room(room.id)!.messages.filter((m) => m.from.kind === 'system' && m.text.includes('waiting for'));
    expect(notice.map((m) => m.to)).toEqual([['user']]);
    expect(alerts).toHaveLength(1);
  });
});
