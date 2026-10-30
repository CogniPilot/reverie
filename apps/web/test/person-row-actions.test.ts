/**
 * Person rows (Owner or Guest) act like agent rows: a click opens a card, the context menu (or its keys) lists the same
 * actions. Every action is a composer insert, a copy, or navigation; which ones appear depends only on server roles,
 * and "Manage account" needs a verified owner.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const opened: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.close(); vi.restoreAllMocks(); });
const guest = { id: 'human-rowan', name: 'Rowan', role: 'limited', online: true };
const otherGuest = { id: 'human-sage', name: 'Sage', role: 'limited', online: false };
const owner = { id: 'owner', name: 'Primary Owner', role: 'owner', primary: true, online: true };

async function fixture(self: typeof owner | typeof guest, verified: boolean) {
  const h = await createHarness({
    rooms: [room('shared', 'Shared', [member('agent-a', 'Alpha')])],
    sessions: [{ id: 'agent-a', name: 'Alpha' }],
    stored: { 'reverie:chatroom': 'shared' },
  });
  opened.push(h);
  h.shell.humans = [owner, guest, otherGuest];
  h.shell.humanRoomId = h.shell.roomId;
  h.shell.humanSelf = self;
  h.shell.phoneStatus = verified ? { self: 'owner', canSetOwn: true } : { self: 'owner', canSetOwn: false };
  h.shell.renderMembers();
  return h;
}
const row = (h: any, id: string) => h.document.querySelector(`[data-human-id="${id}"]`) as HTMLButtonElement;
const cardButtons = (h: any) => [...h.document.querySelectorAll('.ca-profile--person .ca-profile-actions button')].map((b: any) => b.textContent);
function menu(h: any, id: string) {
  row(h, id).dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const items = [...h.document.querySelectorAll('.ca-member-menu [role="menuitem"]')].map((b: any) => b.textContent);
  h.shell.closeMenus();
  return items;
}

it('a click opens the person card with role and presence, not a mention', async () => {
  const h = await fixture(owner, true);
  const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
  input.value = 'Draft';
  row(h, guest.id).click();
  expect(input.value).toBe('Draft');
  const card = h.document.querySelector('.ca-profile--person')!;
  expect(card.getAttribute('aria-label')).toBe('Rowan profile');
  expect(card.querySelector('.ca-profile-sub')!.textContent).toBe('Guest · Online');
  expect(cardButtons(h)).toEqual(['Mention', 'Copy name', 'Manage account']);
});

it('offers Manage account on a Guest only to a verified owner, and never on an Owner', async () => {
  expect(menu(await fixture(owner, true), guest.id)).toEqual(['Mention', 'Copy name', 'Manage account']);
  expect(menu(await fixture(owner, false), guest.id)).toEqual(['Mention', 'Copy name']);
  expect(menu(await fixture(owner, true), owner.id)).toEqual(['Mention', 'Copy name', 'Edit my profile']);
  const asGuest = await fixture(guest, true);
  expect(menu(asGuest, otherGuest.id)).toEqual(['Mention', 'Copy name']);
  expect(menu(asGuest, owner.id)).toEqual(['Mention', 'Copy name']);
  expect(menu(asGuest, guest.id)).toEqual(['Mention', 'Copy name', 'Edit my profile']);
});

it('opens the menu from the keyboard too', async () => {
  const h = await fixture(owner, true);
  for (const init of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    row(h, guest.id).dispatchEvent(new h.window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
    expect(h.document.querySelector('.ca-member-menu')?.getAttribute('aria-label')).toBe('Rowan actions');
    h.shell.closeMenus();
  }
});

it('actions only navigate: Accounts for account changes, Company settings for the original owner', async () => {
  const h = await fixture(owner, true);
  const openPage = vi.spyOn(h.shell, 'openPage').mockImplementation(() => {});
  const openCompanySettings = vi.spyOn(h.shell, 'openCompanySettings').mockImplementation(async () => {});
  const before = h.server.calls.length;
  row(h, guest.id).click();
  ([...h.document.querySelectorAll('.ca-profile--person .ca-profile-actions button')].find((b: any) => b.textContent === 'Manage account') as HTMLButtonElement).click();
  expect(openPage).toHaveBeenCalledWith('people');
  expect(h.document.querySelector('.ca-profile--person')).toBeNull();
  row(h, owner.id).click();
  ([...h.document.querySelectorAll('.ca-profile--person .ca-profile-actions button')].find((b: any) => b.textContent === 'Edit my profile') as HTMLButtonElement).click();
  expect(openCompanySettings).toHaveBeenCalledTimes(1);
  const asGuest = await fixture(guest, false);
  const guestPage = vi.spyOn(asGuest.shell, 'openPage').mockImplementation(() => {});
  row(asGuest, guest.id).click();
  ([...asGuest.document.querySelectorAll('.ca-profile--person .ca-profile-actions button')].find((b: any) => b.textContent === 'Edit my profile') as HTMLButtonElement).click();
  expect(guestPage).toHaveBeenCalledWith('people');
  expect(h.server.calls.slice(before).filter((c: any) => c.method && c.method !== 'GET')).toEqual([]);
});

it('copies the name', async () => {
  const h = await fixture(guest, false);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(h.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
  row(h, otherGuest.id).click();
  ([...h.document.querySelectorAll('.ca-profile--person .ca-profile-actions button')].find((b: any) => b.textContent === 'Copy name') as HTMLButtonElement).click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith('Sage');
});
