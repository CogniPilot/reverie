/**
 * The member card's "queued" chip says why the lines are not typed yet, from the server's fixed reason, and marks a member
 * held back by something other than a running turn.
 */
import { afterAll, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
const context = dom.getInternalVMContext();
vm.runInContext('globalThis.ReverieApp = class {}; globalThis.fetch = () => new Promise(() => {});', context);
vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chatroom-ui.js'), 'utf8'), context);
const Proto = vm.runInContext('ReverieApp.prototype', context);
afterAll(() => dom.window.close());

function chip(member: Record<string, unknown>): HTMLElement | null {
  const app = Object.create(Proto);
  app.sessions = new Map();
  app._chatRoom = { id: 'room-1', members: [member], messages: [] };
  const card = app._chatMemberCard({ sessionId: 's-1', name: 'Sam', role: 'agent', goal: '', progress: '', ...member }) as HTMLElement;
  return card.querySelector('.chatroom-queued');
}

describe('queued chip on a member card', () => {
  it('names the reason and how long it has held, and marks a stuck member', () => {
    const since = Date.now() - 23 * 60_000;
    const q = chip({ pendingDeliveries: 3, deliveryWait: { reason: 'dialog_open', text: 'a dialog is open in its terminal', since } })!;
    expect(q.textContent).toBe('3 queued');
    expect(q.title).toBe('Not typed for 23 min: a dialog is open in its terminal');
    expect(q.classList.contains('chatroom-queued-stuck')).toBe(true);
  });

  it('does not mark a member that is only busy with a turn', () => {
    const q = chip({ pendingDeliveries: 1, deliveryWait: { reason: 'working', text: 'busy with a turn', since: Date.now() } })!;
    expect(q.title).toBe('Not typed for under a minute: busy with a turn');
    expect(q.classList.contains('chatroom-queued-stuck')).toBe(false);
  });

  it('falls back to a neutral title without a reason, and shows no chip with nothing queued', () => {
    expect(chip({ pendingDeliveries: 2 })!.title).toBe('Messages waiting to be typed into this session');
    expect(chip({ pendingDeliveries: 0 })).toBeNull();
  });
});
