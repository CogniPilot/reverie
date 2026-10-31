import { afterEach, expect, it } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const opened: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.close(); });
const nora = { id: 'human-nora', name: 'Nora', role: 'limited', online: true, avatar: '/assets/avatars/pack-151.png' };
const owner = { id: 'owner', name: 'Primary Owner', role: 'owner', primary: true, online: true };

async function fixture(extraMembers: object[] = []) {
  const h = await createHarness({
    rooms: [room('shared', 'Shared', [member('agent-a', 'Alpha'), ...extraMembers]),
      room('other', 'Other', [member('agent-a', 'Alpha')]),
      room('private', '', [member('agent-a', 'Alpha'), member('user', 'Primary Owner')], { kind: 'dm', dm: ['user', 'agent-a'] })],
    sessions: [{ id: 'agent-a', name: 'Alpha' }],
    stored: { 'reverie:chatroom': 'shared' },
  });
  opened.push(h);
  h.shell.humans = [owner, nora];
  h.shell.humanRoomId = h.shell.roomId;
  return h;
}

function type(h: Awaited<ReturnType<typeof createHarness>>, text: string) {
  const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  return input;
}
function names(h: Awaited<ReturnType<typeof createHarness>>) {
  return [...h.document.querySelectorAll('.ca-mention-item .ca-mention-name')].map(node => node.textContent);
}

it('offers an authorized human with their own avatar and completes the name without sending or creating an agent seat', async () => {
  const h = await fixture();
  const originalMembers = structuredClone(h.shell.room.members);
  const input = type(h, 'Hello @No');
  expect(names(h)).toEqual(['Nora']);
  expect(h.document.querySelector('.ca-mention-item img')!.getAttribute('src')).toBe(nora.avatar);
  expect(h.document.querySelector('.ca-mention-sub')!.textContent).toBe('Person · Guest');
  expect(h.shell.mention.items[0]).toMatchObject({ kind: 'human', human: { id: nora.id } });
  expect(h.shell.mention.items[0].member).toBeUndefined();
  expect(h.shell.mention.items[0].human.sessionId).toBeUndefined();
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(input.value).toBe('Hello @Nora ');
  expect(h.server.posts).toEqual([]);
  expect(h.shell.room.members).toEqual(originalMembers);
});

it('highlights a channel human alongside agent/everyone mentions, leaving addresses, code and links alone', async () => {
  const h = await fixture();
  const el = h.document.createElement('div');
  el.innerHTML = 'Hi @Nora and @Alpha, @everyone. Email a@Nora.test. <code>@Nora</code> <a href="/">@Nora</a>';
  h.shell.decorateMentions(el);
  expect([...el.querySelectorAll('.ca-mention-tag')].map(node => node.textContent)).toEqual(['@Nora', '@Alpha', '@everyone']);
  expect(el.querySelector('code .ca-mention-tag')).toBeNull();
  expect(el.querySelector('a .ca-mention-tag')).toBeNull();
});

it('does not reuse humans from another channel or leak them into a private DM', async () => {
  const h = await fixture();
  h.shell.humanRoomId = 'other';
  type(h, '@No');
  expect(names(h)).toEqual([]);
  const el = h.document.createElement('div'); el.textContent = '@Nora';
  h.shell.decorateMentions(el);
  expect(el.querySelector('.ca-mention-tag')).toBeNull();
  await h.shell.selectRoom('private');
  h.shell.humanRoomId = h.shell.roomId;
  type(h, '@No');
  expect(names(h)).toEqual([]);
  h.shell.renderMembers();
  expect(h.document.querySelector('[data-human-id]')).toBeNull();
});

it('deduplicates the legacy owner and human records and reserves exactly one everyone suggestion', async () => {
  const h = await fixture([member('user', owner.name), member('reserved-agent', 'everyone')]);
  h.shell.humans = [owner, owner, nora, { id: 'reserved-human', name: 'EVERYONE', role: 'limited' }];
  type(h, '@');
  expect(names(h)).toEqual([owner.name, 'Nora', 'Alpha', '@everyone']);
  expect(names(h).filter(name => name === owner.name)).toHaveLength(1);
  expect(names(h).filter(name => name?.toLowerCase() === '@everyone')).toHaveLength(1);
});

it('the person card\'s Mention appends a mention, focuses the composer and preserves even a selected draft', async () => {
  const h = await fixture();
  h.shell.renderMembers();
  const button = h.document.querySelector('[data-human-id="human-nora"]') as HTMLButtonElement;
  expect(button.tagName).toBe('BUTTON');
  const input = type(h, 'Keep this unfinished draft');
  input.setSelectionRange(0, input.value.length);
  const mention = () => {
    button.click(); // Opens the person card, as for an agent row.
    const action = [...h.document.querySelectorAll('.ca-profile--person .ca-profile-actions button')].find(b => b.textContent === 'Mention') as HTMLButtonElement;
    action.click();
  };
  mention();
  expect(input.value).toBe('Keep this unfinished draft @Nora ');
  expect(h.document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(input.value.length);
  expect(h.server.posts).toEqual([]);
  expect(h.document.querySelector('.ca-profile')).toBeNull();
  await h.shell.selectRoom('other');
  const otherInput = type(h, 'Another draft');
  mention(); // An old DOM reference must not mention someone in a different room.
  expect(otherInput.value).toBe('Another draft');
});

it('refreshes an open mention query when authorized human presence arrives', async () => {
  const h = await fixture();
  h.shell.humans = [];
  type(h, '@No');
  expect(names(h)).toEqual([]);
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: object) => {
    if (path === '/api/office/me') return { ok: true, data: { person: owner } };
    if (path === '/api/office/presence') return { ok: true, data: { present: true } };
    if (path.startsWith('/api/office/presence?')) return { ok: true, data: { people: [owner, nora] } };
    return original(path, options);
  };
  await h.shell.startHumanPresence();
  expect(names(h)).toEqual(['Nora']);
});
