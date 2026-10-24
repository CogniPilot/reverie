import { afterEach, expect, it } from 'vitest';
import { createHarness, member, room, message } from './helpers/chat-app-harness.mjs';
const opened: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.window.close();
});
const humans = [
  { id: 'owner', name: 'Original Owner', role: 'owner', online: true },
  { id: 'second-human', name: 'River', role: 'limited', avatar: '/assets/avatars/pack-151.png', online: false },
];
async function fixture() {
  const h = await createHarness({
    rooms: [room('shared', 'Shared', [member('agent', 'Agent')])],
    sessions: [{ id: 'agent', name: 'Agent' }],
  });
  opened.push(h);
  h.shell.humanSelf = { id: 'owner', name: 'Original Owner', role: 'owner', primary: true };
  h.shell.humanRoomId = h.shell.roomId;
  h.shell.humans = humans;
  h.shell.company = { settings: { ownerName: 'Original Owner' } };
  return h;
}
it('shows humans with roles, avatars and live presence without adding agent seats or action menus', async () => {
  const h = await fixture();
  h.shell.renderMembers();
  expect(h.document.querySelector('.ca-members').textContent).toContain('People — 2');
  expect(h.document.querySelector('[data-human-id="owner"]').getAttribute('aria-label')).toBe(
    'Original Owner, Owner, online'
  );
  expect(h.document.querySelector('[data-human-id="second-human"] img').getAttribute('src')).toBe(
    '/assets/avatars/pack-151.png'
  );
  expect(h.document.querySelector('[data-human-id="second-human"]').tagName).toBe('DIV');
  expect(h.shell.room.members).toHaveLength(1);
  expect(h.shell.els.membersBtn.getAttribute('aria-label')).toContain('3 members');
});
it('keeps message identity, avatars and mine styling separate when a different human signs in', async () => {
  const h = await fixture();
  h.shell.humanSelf = {
    id: 'second-human',
    name: 'River',
    role: 'owner',
    primary: false,
    avatar: '/assets/avatars/pack-151.png',
  };
  h.shell.profile.name = 'Old browser owner profile';
  expect(h.shell.userName()).toBe('River');
  expect(h.shell.authorOf({ kind: 'user', name: 'user' })).toBe('Original Owner');
  expect(h.shell.authorOf({ kind: 'user', humanId: 'second-human', name: 'River' })).toBe('River');
  expect(h.shell.isHumanMessageMine({ kind: 'user', humanId: 'owner', name: 'Original Owner' })).toBe(false);
  expect(h.shell.isHumanMessageMine({ kind: 'user', humanId: 'second-human', name: 'River' })).toBe(true);
  expect(h.shell.userAvatar().querySelector('img').getAttribute('src')).toBe('/assets/avatars/pack-151.png');
  h.shell.openProfileEditor();
  expect(h.shell.embed).toBe('people');
  expect(h.document.querySelector('.ca-profile-edit')).toBeNull();
});
it('does not show stale humans from another channel or expose humans as agent invitations', async () => {
  const h = await fixture();
  h.shell.humanRoomId = 'other-room';
  h.shell.renderMembers();
  expect(h.document.querySelector('[data-human-id]')).toBeNull();
  expect(h.shell.room.members.map((m) => m.sessionId)).toEqual(['agent']);
});
it('loads authenticated presence and refreshes it without a browser reload', async () => {
  const h = await fixture();
  let online = false;
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: object) => {
    if (path === '/api/office/me')
      return { ok: true, data: { person: { id: 'owner', name: 'Original Owner', role: 'owner', primary: true } } };
    if (path === '/api/office/presence') return { ok: true, data: { present: true } };
    if (path.startsWith('/api/office/presence?'))
      return { ok: true, data: { people: humans.map((p) => ({ ...p, online })) } };
    return original(path, options);
  };
  await h.shell.startHumanPresence();
  expect(h.document.querySelector('[data-human-id="owner"]').getAttribute('aria-label')).toContain('offline');
  online = true;
  await h.shell._humanPulse();
  expect(h.document.querySelector('[data-human-id="owner"]').getAttribute('aria-label')).toContain('online');
});
it('counts another human as unread without counting the current human’s own messages', async () => {
  const h = await fixture();
  const roomView = h.shell.room;
  roomView.unread = 0;
  roomView.mentions = 0;
  h.shell.countMessage(
    {
      roomId: roomView.id,
      message: message(
        'human-other',
        roomView.id,
        { kind: 'user', humanId: 'second-human', name: 'River' },
        'Hello',
        Date.now()
      ),
    },
    roomView
  );
  expect(roomView.unread).toBe(1);
  h.shell.countMessage(
    {
      roomId: roomView.id,
      message: message(
        'human-own',
        roomView.id,
        { kind: 'user', humanId: 'owner', name: 'Original Owner' },
        'Reply',
        Date.now() + 1
      ),
    },
    roomView
  );
  expect(roomView.unread).toBe(1);
});

it('keeps identical display names in separate message groups and displays the human access badge', async () => {
  const h = await fixture();
  h.shell.humans = humans.map((p) => ({ ...p, name: 'Same name' }));
  h.shell.room.messages = [
    message(
      'first-person',
      h.shell.roomId,
      { kind: 'user', humanId: 'owner', name: 'Same name' },
      'Owner message',
      100
    ),
    message(
      'second-person',
      h.shell.roomId,
      { kind: 'human', humanId: 'second-human', access: 'limited', name: 'Same name' },
      'Limited message',
      101
    ),
  ];
  h.shell.renderFeed();
  const heads = h.document.querySelectorAll('.ca-msg.is-head');
  expect(heads).toHaveLength(2);
  expect(heads[0].querySelector('.ca-tag')!.textContent).toBe('Owner');
  expect(heads[1].querySelector('.ca-tag')!.textContent).toBe('Limited');
});

it('returns from the embedded People page only for its own same-origin back message', async () => {
  const h = await fixture();
  h.shell.openPage('people');
  const frame = h.shell.els.page.querySelector('iframe');
  h.window.dispatchEvent(
    new h.window.MessageEvent('message', {
      origin: 'https://outside.test',
      source: frame.contentWindow,
      data: { type: 'office-back-to-chat' },
    })
  );
  expect(h.shell.embed).toBe('people');
  h.window.dispatchEvent(
    new h.window.MessageEvent('message', {
      origin: h.window.location.origin,
      source: frame.contentWindow,
      data: { type: 'office-back-to-chat' },
    })
  );
  expect(h.shell.embed).toBeNull();
});
