/** What waits on the owner, and the batched owner-alert push for new items. */
import { describe, it, expect, vi } from 'vitest';
import { BATCH_MS, DecisionAlerts, waitingForOwner, type Waiting } from '../src/decision-alert.js';
import { USER_RECIPIENT, type ChatRoom } from '../src/chatroom-store.js';

const poll = (id: string, over: Record<string, unknown> = {}, votes: Record<string, string[]> = {}) => ({
  id,
  at: 1000 + Number(id.replace(/\D/g, '') || 0),
  text: 'q',
  poll: { question: `question ${id}?`, options: [{ id: 'a', label: 'A' }], votes, ...over },
});
const room = (messages: unknown[], over: Record<string, unknown> = {}) => ({ id: 'r1', name: 'reverie', messages, ...over }) as unknown as ChatRoom;
const decision = (id: string, over: Record<string, unknown> = {}) => ({ id, text: `decide ${id}`, where: '', at: 500, ...over });

describe('waitingForOwner', () => {
  it('counts open decisions and open polls the owner has not voted on, and nothing else', () => {
    const rooms = [
      room([
        poll('p1'),
        poll('p2', {}, { [USER_RECIPIENT]: ['a'] }), // voted
        poll('p3', { closed: true }),
        poll('p4', { closesAt: 10 }), // expired
        { ...poll('p5'), deleted: true },
      ]),
      room([poll('p6')], { archivedAt: 5 }),
    ];
    const state = { decisions: [decision('d1'), decision('d2', { clearedAt: 9 })] } as never;
    const w = waitingForOwner(state, rooms, 5000);
    expect(w).toMatchObject({ count: 2, decisions: 1, polls: 1 });
    expect(w.items.map((i) => i.key).sort()).toEqual(['d1', 'r1:p1']);
  });
});

describe('DecisionAlerts', () => {
  const item = (key: string) => ({ kind: 'decision' as const, key, text: `text ${key}`, at: 1 });
  const setup = (initial: string[]) => {
    let keys = initial;
    let clock = 1_000_000;
    const alert = vi.fn(async () => 1);
    const waiting = (): Waiting => ({ count: keys.length, decisions: keys.length, polls: 0, items: keys.map(item) });
    const alerts = new DecisionAlerts({ waiting, alert, now: () => clock });
    return { alerts, alert, set: (k: string[]) => (keys = k), tick: (ms: number) => (clock += ms) };
  };

  it('does not push for what was already waiting at start', async () => {
    const t = setup(['d1', 'd2']);
    expect(await t.alerts.check()).toBe(false);
    t.tick(BATCH_MS * 2);
    expect(await t.alerts.check()).toBe(false);
    expect(t.alert).not.toHaveBeenCalled();
  });

  it('pushes a new item once, then batches a burst into one push per 10 minutes', async () => {
    const t = setup([]);
    await t.alerts.check();
    t.tick(BATCH_MS);
    t.set(['d1']);
    expect(await t.alerts.check()).toBe(true);
    expect(t.alert).toHaveBeenLastCalledWith('Decision waiting for you: text d1');
    t.tick(60_000);
    t.set(['d1', 'd2', 'd3']);
    expect(await t.alerts.check()).toBe(false); // inside the window: held
    expect(t.alert).toHaveBeenCalledTimes(1);
    t.tick(BATCH_MS);
    expect(await t.alerts.check()).toBe(true); // one push for both
    expect(t.alert).toHaveBeenCalledTimes(2);
    expect(t.alert.mock.calls[1]![0]).toContain('2 decisions waiting');
    t.tick(BATCH_MS);
    expect(await t.alerts.check()).toBe(false); // nothing new
  });

  it('a failing push does not throw', async () => {
    const t = setup([]);
    await t.alerts.check();
    t.tick(BATCH_MS);
    t.alert.mockRejectedValueOnce(new Error('boom'));
    t.set(['d1']);
    await expect(t.alerts.check()).resolves.toBe(true);
  });
});
