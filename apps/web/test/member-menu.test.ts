import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const A = '00000026-002d-4000-8000-00000000003c';
const B = '00000035-0040-4000-8000-00000000005c';
const sessions = [{ id: A, name: 'Maple', mode: 'claude' }, { id: B, name: 'River', mode: 'claude' }];
const rooms = () => [room('r1', 'General', [member(A, 'Maple'), member(B, 'River', { role: 'coordinator' })])];
type Harness = Awaited<ReturnType<typeof createHarness>>;
const opened: Harness[] = [];
const setup = async () => {
  const h = await createHarness({ sessions, rooms: rooms() });
  opened.push(h);
  return h;
};
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
  vi.restoreAllMocks();
});
const row = (h: Harness, id = A) => h.document.querySelector(`[data-key="member:${id}"]`) as HTMLButtonElement;
const open = (h: Harness, id = A) => {
  row(h, id).dispatchEvent(new h.window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 900, clientY: 650,
  }));
  return h.document.querySelector('.ca-member-menu') as HTMLElement;
};
const item = (h: Harness, label: string) => [...h.document.querySelectorAll<HTMLButtonElement>('.ca-member-menu button')]
  .find((b) => b.querySelector('.ca-menu-label')?.firstChild?.textContent === label)!;
const key = (h: Harness, key: string) => h.document.activeElement!.dispatchEvent(
  new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
);

describe('compact member actions', () => {
  it('right click shows only grouped actions and does not fetch the profile', async () => {
    const h = await setup();
    h.server.calls.length = 0;
    const menu = open(h);
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Profile', 'Mention', 'Message', 'Make lead', 'Remove from channel',
      'Debug terminal', 'Copy session id',
    ]);
    expect(menu.querySelectorAll('hr')).toHaveLength(3);
    expect(item(h, 'Remove from channel').classList.contains('is-danger')).toBe(true);
    expect(h.document.querySelector('.ca-profile')).toBeNull();
    expect(h.server.calls).toHaveLength(0);
  });

  it('Profile keeps the headline and folds long details, including many channels', async () => {
    const h = await setup();
    h.server.profiles = { [A]: {
      persona: { agent_name: 'Maple', persona: 'A long profile.' },
      employee: { position: 'Engineer' }, backend: { mode: 'claude' }, usage: { messages: 3 },
      session: { status: 'idle' },
      rooms: Array.from({ length: 12 }, (_, i) => ({ name: `Channel ${i}`, role: 'member' })),
      runtime: { backends: [{ name: 'claude', enabled: true }], switch: { available: false, reason: 'Owner authentication required.' } },
    } };
    open(h);
    item(h, 'Profile').click();
    await h.flush();
    expect(h.document.querySelector('.ca-member-menu')).toBeNull();
    const card = h.document.querySelector('.ca-profile')!;
    const groups = [...card.querySelectorAll<HTMLDetailsElement>('details')];
    expect(groups.map((g) => g.querySelector('summary')!.textContent)).toEqual([
      'About', 'Role', 'Runtime', 'Usage', 'Session', 'Channels · in 12 channels', 'Backend switch',
    ]);
    expect(groups.every((g) => !g.open)).toBe(true);
    const channels = groups.find((g) => g.textContent!.includes('in 12 channels'))!;
    channels.querySelector('summary')!.click();
    expect(channels.open).toBe(true);
    expect(channels.querySelectorAll('.ca-kv')).toHaveLength(12);
  });

  it('arrows and Enter insert a mention into the draft without sending', async () => {
    const h = await setup();
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    input.value = 'Please review';
    input.setSelectionRange(7, 7);
    open(h);
    expect(h.document.activeElement).toBe(item(h, 'Profile'));
    key(h, 'ArrowDown');
    expect(h.document.activeElement).toBe(item(h, 'Mention'));
    key(h, 'Enter');
    expect(input.value).toBe('Please @Maple review');
    expect(h.document.activeElement).toBe(input);
    expect(h.document.querySelector('.ca-member-menu')).toBeNull();
    expect(h.server.posts).toHaveLength(0);
  });

  it('Escape restores focus, outside pointer closes, and the menu key opens it', async () => {
    const h = await setup();
    open(h);
    key(h, 'Escape');
    expect(h.document.querySelector('.ca-member-menu')).toBeNull();
    expect(h.document.activeElement).toBe(row(h));
    row(h).dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    expect(h.document.querySelector('.ca-member-menu')).not.toBeNull();
    h.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
    expect(h.document.querySelector('.ca-member-menu')).toBeNull();
  });

  it('keeps the existing coordinator POST, including removal of the current admin', async () => {
    const h = await setup();
    const api = vi.spyOn(h.app, '_chatApi').mockResolvedValue({ ok: true, data: {} });
    open(h);
    item(h, 'Make lead').click();
    expect(api).toHaveBeenLastCalledWith('/api/chatrooms/r1/coordinator', { method: 'POST', body: { sessionId: A } });
    open(h, B);
    item(h, 'Remove lead').click();
    expect(api).toHaveBeenLastCalledWith('/api/chatrooms/r1/coordinator', { method: 'POST', body: { sessionId: null } });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('requires the existing removal confirmation and deletes once only after acceptance', async () => {
    const h = await setup();
    const api = vi.spyOn(h.app, '_chatApi').mockResolvedValue({ ok: true, data: {} });
    const confirm = vi.spyOn(h.window, 'confirm').mockReturnValue(false);
    open(h);
    item(h, 'Remove from channel').click();
    expect(confirm).toHaveBeenCalledWith('Remove Maple from this room?');
    expect(api).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    open(h);
    item(h, 'Remove from channel').click();
    expect(api).toHaveBeenCalledExactlyOnceWith(`/api/chatrooms/r1/members/${A}`, { method: 'DELETE' });
  });

  it('dispatches Message and Debug terminal while omitting status and re-brief actions', async () => {
    const h = await setup();
    const dm = vi.spyOn(h.shell, 'startDm').mockImplementation(() => {});
    const debug = vi.spyOn(h.shell, 'showDebug').mockImplementation(() => {});
    for (const label of ['Message', 'Debug terminal']) {
      open(h);
      item(h, label).click();
      expect(h.document.querySelector('.ca-member-menu')).toBeNull();
    }
    expect(dm).toHaveBeenCalledExactlyOnceWith(A);
    expect(debug).toHaveBeenCalledExactlyOnceWith(A);
    open(h);
    expect(item(h, 'Edit status')).toBeUndefined();
    expect(item(h, 'Re-brief')).toBeUndefined();
  });

  it('copies the exact session id and reports a clipboard failure', async () => {
    const h = await setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(h.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    open(h);
    item(h, 'Copy session id').click();
    await h.flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(A);
    writeText.mockRejectedValue(new Error('Unavailable'));
    open(h);
    item(h, 'Copy session id').click();
    await h.flush();
    expect(h.app.toasts.at(-1).text).toBe('Could not copy session id');
  });

  it('shows disabled reasons to a member caller and hides owner-only profile controls', async () => {
    const h = await setup();
    h.app._chatSelf = A;
    h.server.profiles = { [B]: { runtime: { backends: [{ name: 'claude' }] } } };
    open(h, B);
    expect(item(h, 'Remove lead').disabled).toBe(true);
    expect(item(h, 'Remove lead').textContent).toContain('Only the owner or a server Admin');
    expect(item(h, 'Remove from channel').disabled).toBe(true);
    expect(item(h, 'Re-brief')).toBeUndefined();
    expect(h.shell.canManageMembers(h.shell.room)).toBe(false);
    item(h, 'Profile').click();
    await h.flush();
    expect(h.document.querySelector('.ca-switch')).toBeNull();
    expect([...h.document.querySelectorAll('.ca-profile button')].some((b) => b.textContent === 'Upload image')).toBe(false);
    open(h);
    expect(item(h, 'Remove from channel').disabled).toBe(false);
    expect(item(h, 'Edit status')).toBeUndefined();
  });

  it('lets the owner manage members through the shared room helper', async () => {
    const h = await setup();
    expect(h.shell.canManageMembers(h.shell.room)).toBe(true);
    expect(h.shell.canAppointLead(h.shell.room)).toBe(true);
    open(h);
    for (const label of ['Make lead', 'Remove from channel']) expect(item(h, label).disabled).toBe(false);
    expect(item(h, 'Make lead').title).toContain('the room coordinator seat');
  });

  it('enables member management for a room lead but keeps appointment owner-only in menu and Profile', async () => {
    const h = await setup();
    h.app._chatSelf = B;
    expect(h.shell.canManageMembers(h.shell.room)).toBe(true);
    open(h);
    expect(item(h, 'Remove from channel').disabled).toBe(false);
    expect(h.shell.canAppointLead(h.shell.room)).toBe(false);
    expect(item(h, 'Make lead').disabled).toBe(true);
    expect(item(h, 'Make lead').title).toBe('Only the owner or a server Admin can change the channel lead');
    item(h, 'Profile').click();
    const buttons = [...h.document.querySelectorAll<HTMLButtonElement>('.ca-profile-actions button')];
    expect(buttons.find((b) => b.textContent === 'Remove from channel')!.disabled).toBe(false);
    expect(buttons.some((b) => b.textContent === 'Re-brief' || b.textContent === 'Edit status')).toBe(false);
    const appoint = buttons.find((b) => b.textContent === 'Make lead')!;
    expect(appoint.disabled).toBe(true);
    expect(appoint.title).toBe('Only the owner or a server Admin can change the channel lead');
    open(h, B);
    expect(item(h, 'Remove lead').disabled).toBe(true);
    expect(item(h, 'Remove lead').title).toBe('Only the owner or a server Admin can change the channel lead');
  });

  it('uses the requested room rather than granting a lead control over every room', async () => {
    const h = await setup();
    h.app._chatSelf = B;
    expect(h.shell.canManageMembers(room('other', 'Other', [member(B, 'River')]))).toBe(false);
    expect(h.shell.canManageMembers(room('dm', '', [member(B, 'River', { role: 'coordinator' })], { kind: 'dm' }))).toBe(false);
  });

  it('uses the shared management and appointment checks without local owner-only variables', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.js'), 'utf8');
    expect(source).not.toMatch(/(?:const|let|var)\s+owner\s*=\s*!this\.app\._chatSelf/);
    expect(source).not.toContain('TODO(i-a3ffe945)');
  });

  it('does not offer channel administration inside a direct message', async () => {
    const h = await setup();
    h.shell.room.kind = 'dm';
    open(h);
    expect(item(h, 'Make lead')).toBeUndefined();
    expect(item(h, 'Remove from channel')).toBeUndefined();
    expect(item(h, 'Re-brief')).toBeUndefined();
    expect(item(h, 'Profile')).toBeDefined();
  });
});
