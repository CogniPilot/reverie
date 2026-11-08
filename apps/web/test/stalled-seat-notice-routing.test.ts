/** The stalled-seat notice reaches the coordinator itself (pane and pending summary), not only room history. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomDelivery, DELIVERY_WAIT_TEXT, STALLED_ALERT_MS, STALLED_REPEAT_MS, type DeliverySession, type DeliveryStall } from '../src/chatroom-delivery.js';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';
import { wakePayload } from './helpers/wake-payload.js';

type Options = Parameters<DeliverySession['writeViaMux']>[1];
describe('the stalled-seat notice', () => {
  const services: ChatroomService[] = [];
  afterEach(async () => { for (const s of services.splice(0)) await s.stop(); });

  it.each(['pane', 'phone'])('reaches the coordinator through %s, rather than only appearing in room history', async (channel) => {
    let clock = 1_000_000;
    const alerts: string[] = [];
    const writes: Record<string, string[]> = { stuck: [], lead: [] };
    const sessions = new Map<string, ChatSessionLike & { isWorking: boolean; canAcceptChatInput?: () => boolean }>();
    for (const id of ['stuck', 'lead']) sessions.set(id, {
      id, name: id === 'stuck' ? 'Robin' : 'Lead', status: 'idle', mode: 'claude', pid: 1, isWorking: false,
      writeViaMux: async (text: string, options: Options) => { writes[id].push(wakePayload(services.at(-1), id, text)); options?.onOutcome?.('submitted'); return true; },
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
    await flush();
    if (channel === 'pane') expect(writes.lead.some((w) => w.includes('waiting for'))).toBe(true);
    else expect(service.turnSummary('lead').messages.some((m) => m.messageId === notice[0].id)).toBe(true);
  });
});
