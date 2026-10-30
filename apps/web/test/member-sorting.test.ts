import { afterEach, expect, it } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const opened: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); });
const experts = [
  member('tim', 'Tim', { working: true }),
  member('otto', 'Otto', { role: 'coordinator', working: true }),
  member('ada', 'Ada', { alive: false }),
  member('mira', 'Mira'),
];
const humans = [
  { id: 'owner', name: 'James', role: 'owner', online: true },
  { id: 'nova', name: 'Nova', role: 'limited', online: false },
  { id: 'alex', name: 'Alex', role: 'limited', online: true },
];
async function fixture() {
  const h = await createHarness({ rooms: [room('general', 'General', experts)], sessions: experts.map(m => ({ id: m.sessionId, name: m.name })) });
  opened.push(h);
  h.shell.humanRoomId = 'general'; h.shell.humans = humans; h.shell.humanSelf = { id: 'owner' };
  h.shell.renderMembers();
  return h;
}
function sections(h: Awaited<ReturnType<typeof fixture>>) {
  const result: Record<string, string[]> = {}; let group = '';
  for (const row of h.document.querySelector('.ca-members')!.children) {
    if (row.matches('.ca-members-head')) { group = row.textContent!; result[group] = []; }
    else if (row.matches('.ca-member')) result[group].push(row.querySelector('.ca-member-name')!.textContent!.trim());
  }
  return result;
}
it('interleaves accounts and experts in the same role/presence sections and name ordering', async () => {
  const h = await fixture();
  expect(sections(h)).toEqual({ 'Admin — 2': ['James', 'Otto'], 'Online — 3': ['Alex', 'Mira', 'Tim'], 'Offline — 2': ['Ada', 'Nova'] });
  expect(h.document.querySelector('.ca-members')!.textContent).not.toContain('People —');
  expect(h.document.querySelector('[data-human-id="owner"] .ca-tag')!.textContent).toBe('Owner');
  expect(h.document.querySelector('[data-human-id="owner"] .ca-member-sub')!.textContent).toBe('You');
  expect(h.document.querySelector('[data-human-id="nova"] .ca-tag')!.textContent).toBe('Guest');
  expect(h.document.querySelector('[data-human-id="nova"] .ca-member-sub')).toBeNull();
  expect(h.document.querySelector('[data-human-id="nova"]')!.getAttribute('aria-label')).toBe('Nova, Guest, offline');
  expect(h.document.querySelector('[data-key="member:otto"]')!.textContent).toContain('Admin');
  expect(h.document.querySelector('[data-key="member:tim"]')!.getAttribute('aria-label')).toContain('working');
});
it('re-sorts a human presence update without changing account action or permissions', async () => {
  const h = await fixture();
  h.shell.humans = humans.map(person => person.id === 'nova' ? { ...person, online: true } : person);
  h.shell.renderMembers();
  expect(sections(h)['Online — 4']).toEqual(['Alex', 'Mira', 'Nova', 'Tim']);
  const input = h.app._chatEls.input;
  input.value = 'Draft';
  const row = h.document.querySelector<HTMLButtonElement>('[data-human-id="nova"]')!;
  row.click();
  ([...h.document.querySelectorAll('.ca-profile--person .ca-profile-actions button')].find(b => b.textContent === 'Mention') as HTMLButtonElement).click();
  expect(input.value).toBe('Draft @Nova ');
  expect(h.document.querySelector('.ca-member-menu')).toBeNull();
  expect(h.server.calls.filter((c: any) => c.method !== 'GET')).toHaveLength(0);
});
it('keeps alphabetical ordering independent of input order and does not mutate API arrays', async () => {
  const h = await fixture();
  const order = h.shell.room.members.map((m: any) => m.sessionId);
  h.shell.humans = [...humans].reverse(); h.shell.room.members.reverse();
  const reversed = h.shell.room.members.map((m: any) => m.sessionId);
  h.shell.renderMembers();
  expect(sections(h)['Online — 3']).toEqual(['Alex', 'Mira', 'Tim']);
  expect(h.shell.room.members.map((m: any) => m.sessionId)).toEqual(reversed);
  expect(reversed).toEqual([...order].reverse());
});
it('does not leak people from the previous room into a different channel or DM', async () => {
  const h = await fixture();
  h.shell.humanRoomId = 'other'; h.shell.renderMembers();
  expect(h.document.querySelectorAll('[data-human-id]')).toHaveLength(0);
  h.shell.humanRoomId = 'general'; h.shell.room.kind = 'dm'; h.shell.renderMembers();
  expect(h.document.querySelectorAll('[data-human-id]')).toHaveLength(0);
});
