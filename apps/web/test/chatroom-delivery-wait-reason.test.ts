/**
 * A member whose queued lines are not typed says why: a fixed reason (never pane or message text) with the time it started,
 * shown in its own delivery status and on the member in the room view. A written line clears it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomDelivery, DELIVERY_WAIT_TEXT, type DeliverySession } from '../src/chatroom-delivery.js';
import { ChatroomService } from '../src/chatroom-service.js';

type Options = Parameters<DeliverySession['writeViaMux']>[1];

function fixture() {
  const clock = { now: 1_000_000 };
  const writes: string[] = [];
  const ready = { value: true };
  const state = { refuse: false };
  const session: DeliverySession & { paneDialog?: unknown; canAcceptChatInput?: () => boolean } = {
    id: 's', name: 'Agent', mode: 'claude', pid: 42, isWorking: false,
    composerProvablyIdle: () => true,
    writeViaMux: async (text: string, options: Options) => {
      if (state.refuse && options?.requireIdle) {
        options.onIdleRefused?.();
        return false;
      }
      writes.push(text);
      options?.onOutcome?.('submitted');
      return true;
    },
  };
  const delivery = new ChatroomDelivery({ getSession: () => session, now: () => clock.now, isReady: () => ready.value });
  delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent please check the build', { messageId: 'm-1' });
  // Each poll is a later clock, so the spacing guard never decides a case.
  const poll = async () => {
    (delivery as unknown as { lastDelivered: Map<string, number> }).lastDelivered.clear();
    return delivery.flush('s');
  };
  return { delivery, session, clock, writes, ready, state, poll };
}

describe('why a queued line is not typed', () => {
  it('names each pane state that holds it back, with the time it started', async () => {
    const f = fixture();
    const cases: Array<[() => void, string]> = [
      [() => { f.session.pid = null; }, 'not_running'],
      [() => { f.session.paneDialog = { kind: 'permission' }; }, 'dialog_open'],
      [() => { f.session.isWorking = true; }, 'working'],
      [() => { f.session.canAcceptChatInput = () => false; }, 'input_closed'],
      [() => { f.ready.value = false; }, 'delivery_unavailable'],
    ];
    for (const [set, reason] of cases) {
      Object.assign(f.session, { pid: 42, isWorking: false, paneDialog: undefined, canAcceptChatInput: undefined });
      f.ready.value = true;
      set();
      f.clock.now += 1000;
      expect(await f.poll()).toBe(false);
      expect(f.delivery.waitingFor('s')).toEqual({ reason, since: f.clock.now });
    }
    expect(f.writes).toEqual([]);
  });

  it('names a plan-move pause, unconfirmed earlier lines and a write refused before any key', async () => {
    const f = fixture();
    const release = f.delivery.pauseForMigration('s');
    expect(await f.poll()).toBe(false);
    expect(f.delivery.waitingFor('s')?.reason).toBe('paused');
    release();
    f.delivery.holdForInspection('s', [{ roomId: 'office', messageId: 'old-1' }]);
    f.session.composerProvablyIdle = () => false;
    expect(await f.poll()).toBe(false);
    expect(f.delivery.waitingFor('s')?.reason).toBe('unconfirmed_unread');
    f.session.composerProvablyIdle = () => true;
    f.state.refuse = true;
    expect(await f.poll()).toBe(false);
    expect(f.delivery.waitingFor('s')?.reason).toBe('not_idle');
    expect(f.writes).toEqual([]);
  });

  it('keeps the start time while the same reason holds and restarts it when the reason changes', async () => {
    const f = fixture();
    f.session.isWorking = true;
    await f.poll();
    const started = f.clock.now;
    f.clock.now += 60_000;
    await f.poll();
    expect(f.delivery.waitingFor('s')).toEqual({ reason: 'working', since: started });
    f.session.isWorking = false;
    f.session.paneDialog = { kind: 'permission' };
    await f.poll();
    expect(f.delivery.waitingFor('s')).toEqual({ reason: 'dialog_open', since: f.clock.now });
  });

  it('clears once the line is written, and reports nothing with no waking line queued', async () => {
    const f = fixture();
    f.session.isWorking = true;
    await f.poll();
    expect(f.delivery.waitingFor('s')?.reason).toBe('working');
    f.session.isWorking = false;
    expect(await f.poll()).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.delivery.waitingFor('s')).toBeUndefined();
    // A read-later fragment alone does not wake the member, so it is not "waiting".
    f.delivery.enqueue('s', { id: 'office', name: 'office' }, 'fyi', { messageId: 'm-2', passive: true });
    f.session.isWorking = true;
    await f.poll();
    expect(f.delivery.waitingFor('s')).toBeUndefined();
  });

  it('does not lend an old wait to a later line once the waking lines were read, deleted or withdrawn with their room', async () => {
    const removals: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
      ['read', (f) => f.delivery.acknowledgeRead('s', 'office', ['m-1'])],
      ['deleted', (f) => f.delivery.dropMessage('office', 'm-1')],
      ['room withdrawn', (f) => f.delivery.dropRoom('office', 's')],
    ];
    for (const [label, remove] of removals) {
      const f = fixture();
      f.session.isWorking = true;
      await f.poll();
      expect(f.delivery.waitingFor('s')?.since, label).toBe(1_000_000);
      remove(f);
      expect(f.delivery.waitingFor('s'), label).toBeUndefined();
      f.clock.now += 3_600_000;
      f.delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent a new question', { messageId: 'm-9' });
      await f.poll();
      expect(f.delivery.waitingFor('s'), label).toEqual({ reason: 'working', since: f.clock.now });
    }
  });

  it('starts timing a pause only once a waking line is queued', async () => {
    const f = fixture();
    f.delivery.acknowledgeRead('s', 'office', ['m-1']);
    const release = f.delivery.pauseForMigration('s');
    await f.poll(); // paused with nothing to type: not a wait
    f.clock.now += 3_600_000;
    f.delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent after the move', { messageId: 'm-9' });
    expect(f.delivery.waitingFor('s')).toBeUndefined();
    await f.poll();
    expect(f.delivery.waitingFor('s')).toEqual({ reason: 'paused', since: f.clock.now });
    release();
  });

  it('is forgotten with the session', async () => {
    const f = fixture();
    f.session.isWorking = true;
    await f.poll();
    f.delivery.forget('s');
    f.delivery.enqueue('s', { id: 'office', name: 'office' }, '@Agent again', { messageId: 'm-3' });
    expect(f.delivery.waitingFor('s')).toBeUndefined();
  });

  it('has fixed plain text for every reason', () => {
    for (const text of Object.values(DELIVERY_WAIT_TEXT)) expect(text).toMatch(/^[a-z][a-z ,']+$/);
  });
});

describe('the wait in the room view and in delivery status', () => {
  const A = '0000002d-0035-4000-8000-000000000047';
  const B = '00000038-0043-4000-8000-000000000060';
  let service: ChatroomService;
  let sessions: Map<string, { id: string; name: string; pid: number; mode: string; status: string; isWorking: boolean; paneDialog?: unknown; writeViaMux: () => Promise<boolean> }>;
  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wait-reason-'));
    sessions = new Map([A, B].map((id) => [id, { id, name: id, pid: 42, mode: 'claude', status: 'idle', isWorking: false, writeViaMux: async () => true }]));
    service = new ChatroomService({ file: join(directory, 'rooms.json'), database: join(directory, 'chat.db'), now: () => 2_000_000,
      getSession: (id) => sessions.get(id), employeeOf: () => undefined, broadcast: () => {} });
    await service.init();
    service.delivery.stop();
  });
  afterEach(async () => { await service.stop(); });

  it('shows the reason and its plain text on the member and in its own status, never the message', async () => {
    const room = service.createRoom('Shared', undefined);
    service.addMember(room.id, A);
    service.addMember(room.id, B);
    sessions.get(A)!.paneDialog = { kind: 'permission' };
    service.post(room.id, { kind: 'agent', sessionId: B, name: 'B' }, `@${A} secret plan detail`, 'all');
    await service.delivery.flush(A);
    const member = service.view(room).members.find((m) => m.sessionId === A)!;
    expect(member.pendingDeliveries).toBeGreaterThan(0);
    expect(member.deliveryWait).toEqual({ reason: 'dialog_open', text: DELIVERY_WAIT_TEXT.dialog_open, since: 2_000_000 });
    expect(JSON.stringify(member.deliveryWait)).not.toContain('secret');
    expect(service.deliveryStatus(A).deliveryWait?.reason).toBe('dialog_open');
    expect(service.view(room).members.find((m) => m.sessionId === B)!.deliveryWait).toBeUndefined();
  });
});
