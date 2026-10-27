/**
 * The conversation shell end to end in jsdom: the real chatroom-ui.js, chat-media.js and chat-app.js
 * against a small in-memory chat server. Covers the default view, sidebar and unread, selecting,
 * sending and receiving, grouping, members and presence, the quick switcher, the Debug terminal and
 * the way back, reload, and the server-dependent controls that must stay hidden on an older server.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { agent, createHarness, member, message, room, user } from './helpers/chat-app-harness.mjs';

const A = '00000026-002d-4000-8000-00000000003c';
const B = '00000035-0040-4000-8000-00000000005c';
const sessions = [
  { id: A, name: 'alpha', mode: 'claude' },
  { id: B, name: 'bravo', mode: 'opencode' },
];

const fixtureRooms = () => [
  room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo', { alive: false })], {
    category: 'Build',
    userReadAt: 1000,
    messages: [message('m1', 'r1', agent(A, 'alpha'), 'hello', 1000)],
  }),
  room('r2', 'Ops', [member(A, 'alpha')], {
    category: 'Build',
    unread: 2,
    mentions: 1,
    userReadAt: 1500,
    messages: [
      message('m5', 'r2', agent(A, 'alpha'), 'for you', 2000, { to: ['user'] }),
      message('m6', 'r2', agent(A, 'alpha'), 'and more', 2100),
    ],
  }),
  room('r3', 'Side', [member(B, 'bravo')], { category: 'Misc' }),
];

const labels = (nodes: Iterable<Element>) => [...nodes].map((n) => n.getAttribute('aria-label'));
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the default view', () => {
  it('exposes the full terminal interface only through the explicit legacy flag', async () => {
    const legacy = await createHarness({ sessions, rooms: fixtureRooms(), hash: '?legacy=1' });
    expect(legacy.shell.view).toBe('debug');
    expect(legacy.document.documentElement.hasAttribute('data-reverie-legacy')).toBe(true);
    const ordinary = await createHarness({ sessions, rooms: fixtureRooms(), hash: '?legacy=0' });
    expect(ordinary.shell.view).toBe('chat');
    expect(ordinary.document.documentElement.hasAttribute('data-reverie-legacy')).toBe(false);
  });

  it('opens as a full-height conversation, with the terminal UI kept out of sight', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const { document } = h;
    expect(document.documentElement.getAttribute('data-reverie-view')).toBe('chat');
    const root = document.getElementById('chatApp')!;
    expect(root.hidden).toBe(false);
    expect(document.querySelector('.ca-rail')).not.toBeNull();
    expect(document.querySelector('.ca-side')).not.toBeNull();
    expect(document.querySelector('.ca-members')).not.toBeNull();
    expect(document.querySelector('.ca-user')).not.toBeNull();
    // The conversation is already loaded: the first room is open with its feed and composer.
    expect(document.querySelector('.ca-head-title')!.textContent).toBe('#General');
    expect(document.querySelector('.chatroom-feed')!.textContent).toContain('hello');
    expect((document.querySelector('.chatroom-input') as HTMLTextAreaElement).placeholder).toBe('Message #General');
  });

  it('reloads into the conversation, and a terminal that was asked for stays a terminal', async () => {
    expect(
      (await createHarness({ rooms: fixtureRooms() })).document.documentElement.getAttribute('data-reverie-view')
    ).toBe('chat');
    const kept = await createHarness({ rooms: fixtureRooms(), sessionStored: { 'reverie:view': 'debug' } });
    expect(kept.document.documentElement.getAttribute('data-reverie-view')).toBe('debug');
    expect(kept.document.getElementById('chatApp')!.hidden).toBe(true);
    expect(kept.document.querySelector('.ca-back')).not.toBeNull();
  });

  it('opens a #session= link in the terminal even though the app has already taken the link out of the address bar', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), hash: '#session=abc' });
    expect(h.window.location.hash).toBe('');
    expect(h.app._urlSessionId).toBe('abc');
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('debug');
    expect(h.document.getElementById('chatApp')!.hidden).toBe(true);
    expect(h.shell.view).toBe('debug');
  });

  it('a link that arrives while chatting switches to the terminal, before the session even exists', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    expect(h.shell.view).toBe('chat');
    h.app._urlSessionId = 'later';
    h.app._selectUrlSession();
    expect(h.shell.view).toBe('debug');
    expect(h.document.getElementById('chatApp')!.hidden).toBe(true);
  });

  it('a notification that opens a session opens its terminal, but an approval opens the drawer in chat', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), approvals: true });
    const toggled = h.app.approvalsToggled;
    h.app.handleNotificationAction('approve', 'ap1', A);
    expect(h.shell.view).toBe('chat');
    expect(h.app.answered).toBeUndefined();
    expect(h.app.approvalsToggled).toBe(toggled + 1);
    h.app.handleNotificationAction('review', 'ap1', A);                      // what sw.js now sends
    expect(h.shell.view).toBe('chat');
    expect(h.app.approvalsToggled).toBe(toggled + 2);
    h.app.handleNotificationAction('open', undefined, A);
    expect(h.shell.view).toBe('debug');
    expect(h.app.selected).toEqual([A]);
  });

  it('shows the real rooms in categories, uncluttered by terminals', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const side = labels(h.document.querySelectorAll('.ca-side-scroll button:not(.ca-item-act)'));
    expect(side).toEqual([
      'Build category, 1 mention',
      'Channel General',
      'Channel Ops, 1 mention',
      'Misc category',
      'Channel Side',
      // The harness has no embassy API: the failure stays visible with a retry.
      'Retry loading embassies',
    ]);
    expect(h.document.querySelector('.ca-item[aria-current]')!.textContent).toContain('General');
  });
});

describe('unread, hierarchically', () => {
  it('rolls room mentions up to the category, the workspace rail and the Home-less total', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const rail = labels(h.document.querySelectorAll('.ca-rail-btn'));
    expect(rail).toContain('Reverie, 1 mention');
  });

  it('opening a room with unread clears it on the server, and the badges follow', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    [...h.document.querySelectorAll<HTMLButtonElement>('.ca-item')]
      .find((b) => b.textContent!.includes('Ops'))!
      .click();
    await settle(600);
    expect(h.server.reads).toEqual([{ id: 'r2', at: 2100 }]);
    expect(labels(h.document.querySelectorAll('.ca-side-scroll button'))).not.toContain('Channel Ops, 1 mention');
    expect(labels(h.document.querySelectorAll('.ca-rail-btn'))).toContain('Reverie');
  });

  it('shows the NEW divider where the unread begins, and keeps it until the room is left', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    [...h.document.querySelectorAll<HTMLButtonElement>('.ca-item')]
      .find((b) => b.textContent!.includes('Ops'))!
      .click();
    await settle(100);
    const kinds = [...h.document.querySelectorAll('.chatroom-feed > *')].map((n) => n.className.split(' ')[0]);
    expect(kinds).toEqual(['ca-day', 'ca-new', 'ca-msg', 'ca-msg']);
  });

  it('a message in another room adds a dot, and one addressed to the user a number', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.app._onChatroomMessage({
      roomId: 'r3',
      message: message('x1', 'r3', agent(B, 'bravo'), 'fyi', h.server.clock + 5),
    });
    await settle();
    const side = () => labels(h.document.querySelectorAll('.ca-side-scroll button'));
    expect(side()).toContain('Channel Side, unread');
    h.app._onChatroomMessage({
      roomId: 'r3',
      message: message('x2', 'r3', agent(B, 'bravo'), 'you there?', h.server.clock + 6, { to: ['user'] }),
    });
    await settle();
    expect(side()).toContain('Channel Side, 1 mention');
  });

  it('a message that @names the owner (or the whole room) in another room is a mention; a plain one is not', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.app._chatOwnerNames = ['Pat'];
    const side = () => labels(h.document.querySelectorAll('.ca-side-scroll button'));
    h.app._onChatroomMessage({
      roomId: 'r3',
      message: message('y1', 'r3', agent(B, 'bravo'), 'fyi, nothing for you', h.server.clock + 5),
    });
    await settle();
    expect(side()).toContain('Channel Side, unread');
    h.app._onChatroomMessage({
      roomId: 'r3',
      message: message('y2', 'r3', agent(B, 'bravo'), '@Pat can you look?', h.server.clock + 6),
    });
    h.app._onChatroomMessage({
      roomId: 'r3',
      message: message('y3', 'r3', agent(B, 'bravo'), '@everyone standup', h.server.clock + 7),
    });
    await settle();
    expect(side()).toContain('Channel Side, 2 mentions');
  });

  it('a folded category still shows what is unread and the open room, and remembers it was folded', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    [...h.document.querySelectorAll<HTMLButtonElement>('.ca-cat')]
      .find((b) => b.textContent!.includes('Build'))!
      .click();
    await settle();
    expect(h.window.localStorage.getItem('reverie:chat:collapsed')).toContain('"cat:/Build":true');
    const side = labels(h.document.querySelectorAll('.ca-side-scroll button'));
    expect(side).toContain('Channel General'); // the open room
    expect(side).toContain('Channel Ops, 1 mention'); // unread
  });

  it('draws no badges or dots when the server does not send unread counts yet', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), features: null });
    expect(h.document.querySelectorAll('.ca-count:not(.ca-approvals-count), .ca-dot')).toHaveLength(0);
    expect(labels(h.document.querySelectorAll('.ca-side-scroll button')).every((l) => !/mention|unread/.test(l!))).toBe(
      true
    );
    // And no direct-message control that would do nothing.
    h.shell.selectWorkspace('home');
    expect(h.document.querySelector('.ca-side-title [aria-label="Start a direct message"]')).toBeNull();
  });
});

describe('talking', () => {
  it('sends from the composer and shows what arrives, grouped under one name', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    input.value = 'hi there';
    (h.document.querySelector('.chatroom-composer') as HTMLFormElement).requestSubmit();
    await settle(60);
    expect(h.server.posts.map((p: { text: string }) => p.text)).toEqual(['hi there']);
    expect(input.value).toBe('');
    h.app._onChatroomMessage({ roomId: 'r1', message: h.server.posts[0] });
    h.app._onChatroomMessage({
      roomId: 'r1',
      message: message('n1', 'r1', agent(A, 'alpha'), 'on it', h.server.clock + 1),
    });
    h.app._onChatroomMessage({
      roomId: 'r1',
      message: message('n2', 'r1', agent(A, 'alpha'), 'and done', h.server.clock + 2),
    });
    await settle();
    const rows = [...h.document.querySelectorAll('.chatroom-feed > .ca-msg')];
    expect(rows.slice(-3).map((r) => r.classList.contains('is-head'))).toEqual([true, true, false]);
    expect(rows.at(-3)!.classList.contains('is-mine')).toBe(true);
    expect(rows.at(-2)!.querySelector('.ca-msg-from')!.textContent).toContain('alpha');
  });

  it('puts a date divider between days and does not duplicate a message it already has', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const feed = h.document.querySelector('.chatroom-feed')!;
    expect(feed.querySelectorAll('.ca-day')).toHaveLength(1);
    const again = message('m1', 'r1', agent(A, 'alpha'), 'hello', 1000);
    h.app._onChatroomMessage({ roomId: 'r1', message: again });
    await settle();
    expect(feed.querySelectorAll('[data-msg-id="m1"]')).toHaveLength(1);
    h.app._onChatroomMessage({
      roomId: 'r1',
      message: message('later', 'r1', agent(A, 'alpha'), 'next day', 1000 + 36 * 3600 * 1000),
    });
    await settle();
    expect(feed.querySelectorAll('.ca-day')).toHaveLength(2);
  });

  it('opens another room from the sidebar and updates the header, members and composer hint', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    [...h.document.querySelectorAll<HTMLButtonElement>('.ca-item')]
      .find((b) => b.textContent!.includes('Side'))!
      .click();
    await settle(80);
    expect(h.document.querySelector('.ca-head-title')!.textContent).toBe('#Side');
    expect(h.document.querySelector('.ca-head-topic')!.textContent).toContain('1 member');
    expect((h.document.querySelector('.chatroom-input') as HTMLTextAreaElement).placeholder).toBe('Message #Side');
    expect(h.document.querySelector('.ca-item[aria-current]')!.textContent).toContain('Side');
  });
});

describe('members and presence', () => {
  it('lists real agents under coordinator, online and offline with role and status', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const heads = [...h.document.querySelectorAll('.ca-members-head')].map((n) => n.textContent);
    expect(heads).toEqual(['Admin — 1', 'Offline — 1']);
    const rows = labels(h.document.querySelectorAll('.ca-member'));
    expect(rows).toEqual(['alpha, admin, idle', 'bravo, member, offline']);
  });

  const dotOf = (h: Awaited<ReturnType<typeof createHarness>>, name: string) =>
    (h.document.querySelector(`.ca-member[aria-label^="${name},"] .chatroom-dot`) as HTMLElement).className.replace(
      'chatroom-dot ',
      ''
    );
  const frame = () => settle(60);

  it('shows a restored expert online from session events without reloading the browser', async () => {
    const h = await createHarness({ sessions: [{ id: A, name: 'alpha', pid: 10, status: 'idle' }],
      rooms: [room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo', { alive: false })])] });
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--gone');
    // The harness substitutes the upstream app's session map, which session:created populates.
    const restored = { id: B, name: 'bravo', pid: 20, status: 'idle', paneExit: null };
    h.app.sessions.set(B, restored);
    h.app._onSessionCreated(restored);
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--idle');
    h.app._onSessionUpdated({ session: { id: B, pid: null, status: 'stopped' } });
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--gone');
    h.app._onSessionUpdated({ session: { id: B, pid: 21, status: 'idle', paneExit: null } });
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--idle');
  });

  it('follows the app through the REAL entry points: a hook arriving or clearing and a session update move the dot, the words and the label', async () => {
    const rooms = [
      room(
        'r1',
        'General',
        [
          member(A, 'alpha', { role: 'coordinator' }),
          member(B, 'bravo', { working: false }),
          member('0000003b-0049-4000-8000-00000000006a', 'carol', { alive: false }),
        ],
        {}
      ),
    ];
    const h = await createHarness({ sessions, rooms });
    const label = (name: string) =>
      h.document.querySelector(`.ca-member[aria-label^="${name},"]`)!.getAttribute('aria-label');
    const sub = (name: string) =>
      h.document.querySelector(`.ca-member[aria-label^="${name},"] .ca-member-sub`)?.textContent;
    expect(dotOf(h, 'alpha')).toBe('chatroom-dot--idle');
    expect(dotOf(h, 'carol')).toBe('chatroom-dot--gone');
    // working (a status update)
    h.app._onSessionUpdated({ session: { id: B, status: 'busy' } });
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--working');
    expect(sub('bravo')).toBe('Working…');
    // finished and waiting for input: the idle_prompt hook arrives
    h.app._onSessionUpdated({ session: { id: B, status: 'idle' } });
    h.app.setPendingHook(B, 'idle_prompt');
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--waiting');
    expect(label('bravo')).toBe('bravo, member, waiting for input');
    expect(sub('bravo')).toBe('Waiting for input');
    // a permission outranks it
    h.app.setPendingHook(B, 'permission_prompt');
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--needs');
    expect(label('bravo')).toBe('bravo, member, needs your approval');
    expect(sub('bravo')).toBe('Needs your approval');
    // answered: the permission clears and the idle_prompt shows again; then everything clears
    h.app.clearPendingHooks(B, 'permission_prompt');
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--waiting');
    h.app.clearPendingHooks(B);
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--idle');
    // an errored session
    h.app._onSessionUpdated({ session: { id: B, status: 'error' } });
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--error');
    expect(label('bravo')).toBe('bravo, member, error');
    // the profile card names the state too
    (h.document.querySelector('.ca-member[aria-label^="alpha,"]') as HTMLElement).click();
    expect(h.document.querySelector('.ca-profile .ca-profile-sub')!.textContent).toContain('idle');
  });

  it('redraws only when a state changes: a token count or a timestamp changing keeps the very same buttons', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {})],
    });
    await frame();
    const button = h.document.querySelector('.ca-member[aria-label^="bravo,"]');
    h.app._onSessionUpdated({ session: { id: B, inputTokens: 10 } });
    h.app._onSessionUpdated({ session: { id: B, inputTokens: 20, lastActivityAt: 5 } });
    await frame();
    expect(h.document.querySelector('.ca-member[aria-label^="bravo,"]') === button).toBe(true);
    // a real change does redraw
    h.app.setPendingHook(B, 'idle_prompt');
    await frame();
    expect(h.document.querySelector('.ca-member[aria-label^="bravo,"]') === button).toBe(false);
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--waiting');
  });

  it('uses the terminal UI\u2019s own classifier when the app has it, so the two can never rank differently', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {})],
    });
    let seen: unknown[] = [];
    h.app._mobileOverviewState = (session: unknown, hooks: unknown) => {
      seen = [session, hooks];
      return 'needs';
    };
    h.app.setPendingHook(B, 'idle_prompt');
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--needs');
    expect((seen[0] as { id: string }).id).toBeDefined();
    h.app._mobileOverviewState = () => 'done';
    h.app.setPendingHook(B, 'x');
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--gone');
    // a member whose session is gone stays gone whatever the classifier says
    h.app._mobileOverviewState = () => 'working';
    h.app.setPendingHook(B, 'y');
    await frame();
    expect(dotOf(h, 'bravo')).toBe('chatroom-dot--working');
  });

  it('a direct message says the state in words and in its label, not only by the dot', async () => {
    const dm = room('dm1', '', [member(A, 'alpha')], { kind: 'dm', dm: ['user', A] });
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha')], {}), dm] });
    h.shell.selectWorkspace('home');
    const row = () => h.document.querySelector('.ca-item--dm') as HTMLElement;
    expect(row().getAttribute('aria-label')).toContain('idle');
    expect(row().querySelector('.ca-dm-state')).toBeNull();
    h.app.setPendingHook(A, 'idle_prompt');
    await frame();
    expect(row().getAttribute('aria-label')).toContain('waiting for input');
    expect(row().querySelector('.ca-dm-state')!.textContent).toBe('Waiting for input');
    expect(row().querySelector('.chatroom-dot--waiting')).not.toBeNull();
    h.app.setPendingHook(A, 'permission_prompt');
    await frame();
    expect(row().getAttribute('aria-label')).toContain('needs your approval');
    expect(row().querySelector('.ca-dm-state')!.textContent).toBe('Needs your approval');
  });

  it("opens a compact profile and uses the member action menu to reach its Debug terminal and back", async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    (h.document.querySelector('.ca-member') as HTMLButtonElement).click();
    const card = h.document.querySelector('.ca-profile')!;
    expect(card).not.toBeNull();
    const actions = [...card.querySelectorAll('.ca-btn')].map((b) => b.textContent);
    expect(actions).not.toContain('Debug terminal');
    expect(actions).toContain('Message');
    (h.document.querySelector('.ca-member') as HTMLElement).dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...h.document.querySelectorAll<HTMLButtonElement>('.ca-member-menu button')].find((b) => b.textContent === 'Debug terminal')!.click();
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('debug');
    expect(h.document.getElementById('chatApp')!.hidden).toBe(true);
    expect(h.app.selected).toEqual([A]);
    expect(h.window.sessionStorage.getItem('reverie:view')).toBe('debug');
    expect(h.window.sessionStorage.getItem('reverie:debug-session')).toBe(A);
    const back = h.document.querySelector<HTMLButtonElement>('.ca-back')!;
    expect(back.getAttribute('aria-label')).toBe('Back to chat');
    expect(back.parentElement).toBe(h.document.body);
    back.click();
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('chat');
    expect(h.document.getElementById('chatApp')!.hidden).toBe(false);
    expect(h.window.sessionStorage.getItem('reverie:view')).toBeNull();
    expect(h.window.sessionStorage.getItem('reverie:debug-session')).toBeNull();
  });

  it('says so, and stays in chat, when an agent has no terminal session to open', async () => {
    const h = await createHarness({ sessions: [], rooms: fixtureRooms() });
    h.shell.showDebug('nobody');
    expect(h.app.toasts.at(-1).text).toContain('no open terminal');
    expect(h.shell.view).toBe('chat');
  });

  it('the profile bar shows the connection and opens settings without a general terminals button', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    expect(h.document.querySelector('.ca-user-status')!.textContent).toBe('Online');
    h.app.setConnectionStatus('reconnecting');
    expect(h.document.querySelector('.ca-user-status')!.textContent).toBe('Reconnecting…');
    (h.document.querySelector('.ca-rail [aria-label="Office settings"]') as HTMLButtonElement).click();
    await settle(40);
    expect(h.shell.embed).toBeNull();
    expect((h.document.querySelector('.ca-office-pane') as HTMLElement).hidden).toBe(false);
    (h.document.querySelector('.ca-office-gear') as HTMLButtonElement).click(); await settle(40);
    expect((h.document.querySelector('.ca-office-pane') as HTMLElement).hidden).toBe(true);
    expect(h.app.settingsOpened).toBeUndefined();
    expect(h.document.querySelector('[aria-label="Debug terminals"]')).toBeNull();
  });
});

describe('finding and starting conversations', () => {
  const press = (h: Awaited<ReturnType<typeof createHarness>>, key: string, extra = {}) =>
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));

  it('Ctrl+K opens the switcher, narrows as you type and opens the room on Enter', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    press(h, 'k', { ctrlKey: true });
    const dialog = h.document.querySelector('.ca-switcher')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    const input = dialog.querySelector('input')!;
    input.value = 'side';
    input.dispatchEvent(new h.window.Event('input'));
    expect([...dialog.querySelectorAll('.ca-switcher-item')].map((n) => n.textContent)).toEqual(['#SideMisc']);
    expect([...dialog.querySelectorAll('.ca-switcher-head')].map((n) => n.textContent)).toEqual(['Channels']);
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(80);
    expect(h.document.querySelector('.ca-head-title')!.textContent).toBe('#Side');
    expect(h.document.querySelector('.ca-switcher')).toBeNull();
  });

  it('starts a direct message with an agent that has none and lists it under Direct Messages', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.server.agentName = (id: string) => (id === B ? 'bravo' : 'alpha');
    press(h, 'k', { ctrlKey: true });
    const input = h.document.querySelector('.ca-switcher input') as HTMLInputElement;
    input.value = 'bravo';
    input.dispatchEvent(new h.window.Event('input'));
    const item = h.document.querySelector<HTMLButtonElement>('.ca-switcher-item')!;
    expect(h.document.querySelector('.ca-switcher-head')!.textContent).toBe('Start a conversation');
    item.click();
    await settle(120);
    expect(
      h.server.calls.some(
        (c: { path: string; body?: { sessionId?: string } }) =>
          c.path === '/api/chatrooms/dms' && c.body?.sessionId === B
      )
    ).toBe(true);
    expect(h.document.querySelector('.ca-head-title')!.textContent).toBe('@bravo');
    expect(h.document.querySelector('.ca-side-name')!.textContent).toBe('Direct Messages');
    expect(h.document.querySelector('.ca-item--dm')!.textContent).toContain('bravo');
  });

  it("keeps the terminal UI's palette for the debug view only", async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.shell.showDebug();
    let reached = false;
    h.document.addEventListener('keydown', () => (reached = true));
    press(h, 'k', { ctrlKey: true });
    expect(reached).toBe(true);
    expect(h.document.querySelector('.ca-switcher')).toBeNull();
  });
});

describe('narrow screens', () => {
  it('opens the channel list as a drawer from the header and closes it when a room is chosen or Escape is pressed', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const root = h.document.getElementById('chatApp')!;
    (h.document.querySelector('[aria-label="Open channels"]') as HTMLButtonElement).click();
    expect(root.dataset.drawer).toBe('channels');
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.dataset.drawer).toBe('');
    (h.document.querySelector('[aria-label="Open channels"]') as HTMLButtonElement).click();
    [...h.document.querySelectorAll<HTMLButtonElement>('.ca-item')]
      .find((b) => b.textContent!.includes('Side'))!
      .click();
    await settle(60);
    expect(root.dataset.drawer).toBe('');
  });

  it('keeps every control reachable by keyboard with an accessible name', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const unnamed = [...h.document.querySelectorAll<HTMLElement>('#chatApp button')].filter(
      (b) => !(b.getAttribute('aria-label') || b.textContent!.trim())
    );
    expect(unnamed).toEqual([]);
    for (const nav of h.document.querySelectorAll('#chatApp nav, #chatApp aside, #chatApp main')) {
      expect(nav.tagName === 'MAIN' || nav.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

describe("the terminal UI's own chat button", () => {
  it('opens the conversation instead of a floating panel', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.shell.showDebug();
    h.app.toggleChatroom();
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('chat');
    expect(h.app.isChatroomOpen()).toBe(true);
    h.shell.showDebug();
    expect(h.app.isChatroomOpen()).toBe(false);
  });

  it('counts messages that arrive while in the terminal view as unread', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.shell.showDebug();
    h.app._onChatroomMessage({
      roomId: 'r1',
      message: message('z1', 'r1', agent(A, 'alpha'), 'psst', h.server.clock + 3, { to: ['user'] }),
    });
    await settle();
    h.shell.showChat();
    expect(labels(h.document.querySelectorAll('.ca-side-scroll button'))).toContain('Channel General, 1 mention');
    void user;
  });
});

describe('never a blank page', () => {
  const watchdog = (h: Awaited<ReturnType<typeof createHarness>>, ms: number) =>
    h.window.__watchdogs.find((w: { ms: number }) => w.ms === ms);

  it('falls back to the terminal view when a script that never arrives has not built after the long limit', async () => {
    const h = await createHarness({ rooms: fixtureRooms(), loadShell: false });
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('chat');
    watchdog(h, 20000).fn();
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('debug');
    expect(h.document.documentElement.getAttribute('data-reverie-fallback')).toBe('1');
  });

  it('counts the short limit from when the script has loaded, not from when the loader began', async () => {
    const h = await createHarness({ rooms: fixtureRooms(), loadShell: false });
    expect(watchdog(h, 5000)).toBeUndefined();
    const css = h.document.querySelector('link[href="chat-app.css"]') as HTMLLinkElement | null;
    expect(css).not.toBeNull();
    (css as unknown as { onload: () => void }).onload();
    const script = h.document.querySelector('script[src="chat-app.js"]') as unknown as { onload: () => void };
    expect(script).not.toBeNull();
    script.onload();
    expect(watchdog(h, 5000)).toBeDefined();
    watchdog(h, 5000).fn();
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('debug');
  });

  it('a slow but healthy load ends in the conversation: the fallback is ignored, cleared and not remembered', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), loadShell: false });
    watchdog(h, 20000).fn(); // the watchdog fires before the shell is up
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('debug');
    const shell = await h.startShell();
    await settle(80);
    expect(shell.view).toBe('chat');
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('chat');
    expect(h.document.documentElement.getAttribute('data-reverie-fallback')).toBeNull();
    expect(h.document.getElementById('chatApp')!.hidden).toBe(false);
    expect(h.window.sessionStorage.getItem('reverie:view')).toBeNull();
    expect(h.document.querySelector('.ca-head-title')!.textContent).toBe('#General');
    // And a reload after that opens the conversation again.
    const again = await createHarness({ rooms: fixtureRooms() });
    expect(again.shell.view).toBe('chat');
  });

  it('a real choice of the terminal is still remembered, and a fresh start into one is not written back', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), hash: '#session=abc' });
    expect(h.shell.view).toBe('debug');
    expect(h.window.sessionStorage.getItem('reverie:view')).toBeNull();
    h.shell.showChat();
    h.shell.showDebug();
    expect(h.window.sessionStorage.getItem('reverie:view')).toBe('debug');
  });

  it('leaves a shell that did build alone', async () => {
    const h = await createHarness({ rooms: fixtureRooms() });
    watchdog(h, 20000).fn();
    expect(h.document.documentElement.getAttribute('data-reverie-view')).toBe('chat');
    expect(h.document.documentElement.getAttribute('data-reverie-fallback')).toBeNull();
  });

  it("keeps the terminal UI's dialogs reachable from chat, hiding only its screens", async () => {
    const h = await createHarness({ rooms: fixtureRooms() });
    const css = h.document.getElementById('reverie-view-guard')!.textContent!;
    expect(css).toContain(':not(.modal)');
    const view = h.window.getComputedStyle.bind(h.window);
    expect(view(h.document.getElementById('legacyMain')!).display).toBe('none');
    expect(view(h.document.getElementById('legacyHeader')!).display).toBe('none');
    expect(view(h.document.getElementById('appSettingsModal')!).display).toBe('block');
  });

  it('the gear reaches terminal settings through the owner Company tools menu', async () => {
    const h = await createHarness({ rooms: fixtureRooms(), company: { employees: [], settings: {}, canManage: true } });
    const api = h.app._chatApi.bind(h.app);
    h.app._chatApi = (path: string, options: unknown) => path === '/api/chatrooms/phone-status'
      ? Promise.resolve({ ok: true, data: { self: 'owner', canSetOwn: true } })
      : api(path, options);
    (h.document.querySelector('.ca-rail [aria-label="Office settings"]') as HTMLButtonElement).click();
    await settle(40);
    expect(h.app.settingsOpened).toBeUndefined();
    expect((h.document.querySelector('.ca-office-pane') as HTMLElement).hidden).toBe(false);
    ([...h.document.querySelectorAll('.ca-office-pane button')].find(button => button.textContent === 'Company') as HTMLButtonElement).click();
    await settle(80);
    (h.document.querySelector('[aria-label="Company tools"]') as HTMLButtonElement).click();
    await settle(40);
    ([...h.document.querySelectorAll('.ca-popmenu button')].find(button => button.textContent === 'Terminal settings') as HTMLButtonElement).click();
    expect(h.app.settingsOpened).toBe(1);
    expect(h.shell.view).toBe('chat');
  });
});

describe('what the live server does not have yet', () => {
  const menuLabels = (h: Awaited<ReturnType<typeof createHarness>>, id = 'r1') => {
    (h.document.querySelector(`[data-key="room:${id}"]`) as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
    );
    const labels = [...h.document.querySelectorAll('.ca-popmenu button')].map((b) => b.textContent);
    h.document.querySelector('.ca-popmenu')?.remove();
    return labels;
  };
  it('offers Archive only when the server reports it can do it', async () => {
    const without = await createHarness({ sessions, rooms: fixtureRooms(), features: { unread: true, dms: true } });
    expect(menuLabels(without)).not.toContain('Archive channel');
    const withFlag = await createHarness({ sessions, rooms: fixtureRooms() });
    expect(menuLabels(withFlag)).toContain('Archive channel');
  });

  it("keeps the terminal UI's own unread count going when the server sends no counts", async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), features: null });
    const badge = h.document.getElementById('chatroomBadge')!;
    h.app._onChatroomMessage({
      roomId: 'r3',
      message: message('q1', 'r3', agent(B, 'bravo'), 'one', h.server.clock + 1),
    });
    h.app._onChatroomMessage({
      roomId: 'r3',
      message: message('q2', 'r3', agent(B, 'bravo'), 'two', h.server.clock + 2),
    });
    await settle();
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
    h.shell.showDebug();
    h.shell.showChat();
    expect(badge.hidden).toBe(true);
  });
});

describe('approvals in the shell', () => {
  it('shows how many are waiting, hides when none or the inbox is off, and opens the inbox', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), approvals: true });
    const btn = h.document.querySelector('.ca-approvals') as HTMLButtonElement;
    expect(btn.hidden).toBe(true);
    h.app.approvals.set('a1', {});
    h.app.approvals.set('a2', {});
    h.app.renderApprovals();
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('2 approvals waiting on you');
    btn.click();
    expect(h.app.approvalsToggled).toBe(1);
    h.window.__approvals = false;
    h.app.renderApprovals();
    expect(btn.hidden).toBe(true);
  });
});

describe('timers that must not cancel each other', () => {
  it('a message in an unknown room and a room change both get their reload', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.server.calls.length = 0;
    h.shell.handleChanged({ roomId: 'r1', action: 'status' });
    h.app._onChatroomMessage({
      roomId: 'new-room',
      message: message('n1', 'new-room', agent(A, 'alpha'), 'hi', h.server.clock + 1),
    });
    await settle(500);
    const paths = h.server.calls.map((c: { path: string }) => c.path);
    expect(paths).toContain('/api/chatrooms/r1'); // the changed room was reloaded
    expect(paths.filter((p: string) => p === '/api/chatrooms').length).toBeGreaterThanOrEqual(2); // and the list was fetched for the new one
  });
});

describe('keyboard on a narrow screen', () => {
  it('keeps closed drawers out of the tab order and lets the open one take focus', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), narrow: true });
    for (const sel of ['.ca-rail', '.ca-side', '.ca-user', '.ca-members']) {
      expect(h.document.querySelector(sel)!.hasAttribute('inert')).toBe(true);
    }
    (h.document.querySelector('[aria-label="Open channels"]') as HTMLButtonElement).click();
    for (const sel of ['.ca-rail', '.ca-side', '.ca-user']) {
      expect(h.document.querySelector(sel)!.hasAttribute('inert')).toBe(false);
    }
    expect(h.document.querySelector('.ca-members')!.hasAttribute('inert')).toBe(true);
    expect(h.document.activeElement?.closest('.ca-side')).not.toBeNull();
  });

  it('is never inert on a wide screen', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    expect(h.document.querySelectorAll('#chatApp [inert]')).toHaveLength(0);
  });
});

describe('the profile card', () => {
  const tab = (h: Awaited<ReturnType<typeof createHarness>>, shiftKey = false) => {
    const e = new h.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    h.document.dispatchEvent(e);
    return e;
  };
  it('keeps Tab and Shift+Tab inside the card, and Escape returns focus to the member', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const member = h.document.querySelector('.ca-member') as HTMLButtonElement;
    member.click();
    const buttons = [...h.document.querySelectorAll<HTMLButtonElement>('.ca-profile button')];
    expect(h.document.activeElement).toBe(buttons[0]);
    buttons.at(-1)!.focus();
    // The final collapsed technical summary now follows the action buttons.
    expect(tab(h).defaultPrevented).toBe(false);
    const technical = h.document.querySelector('.ca-profile-technical > summary') as HTMLElement;
    technical.focus();
    expect(tab(h).defaultPrevented).toBe(true);
    expect(h.document.activeElement).toBe(buttons[0]);
    expect(tab(h, true).defaultPrevented).toBe(true);
    expect(h.document.activeElement).toBe(technical);
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.document.querySelector('.ca-profile')).toBeNull();
    expect(h.document.activeElement).toBe(member);
  });
  it('keeps only the conversation action in the compact profile and management in its context menu', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const anchor = h.document.querySelector('.ca-member') as HTMLButtonElement;
    anchor.click();
    expect([...h.document.querySelectorAll('.ca-profile-actions button')].map(button => button.textContent)).toEqual(['Message']);
    expect(h.document.querySelector('.ca-tips-toggle')).toBeNull();
    h.shell.openMemberMenu(h.shell.room.members[0], anchor);
    const labels = [...h.document.querySelectorAll('.ca-member-menu button')].map(button => button.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Debug terminal', 'Make voice', 'Remove from channel']));
  });

  it('keeps the touch profile concise without an extra explanations toggle', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    (h.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = q => ({ matches: q === '(hover: none)' });
    (h.document.querySelector('.ca-member') as HTMLButtonElement).click();
    const card = h.document.querySelector('.ca-profile') as HTMLElement;
    expect(card.querySelector('.ca-tips-toggle')).toBeNull();
    expect([...card.querySelectorAll('.ca-profile-actions button')].map(button => button.textContent)).toEqual(['Message']);
    expect(card.querySelectorAll('.ca-tip')).toHaveLength(0);
    expect(card.querySelector<HTMLDetailsElement>('.ca-profile-technical')!.open).toBe(false);
  });

});

describe('@mentions in the composer', () => {
  const type = (h: Awaited<ReturnType<typeof createHarness>>, text: string) => {
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    return input;
  };
  const key = (h: Awaited<ReturnType<typeof createHarness>>, input: HTMLElement, k: string) =>
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const names = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-mention-item .ca-mention-name')].map((e) => e.textContent);

  it('offers the channel members and @everyone as you type, and completes with Tab', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const input = type(h, 'ping @');
    expect(names(h)).toEqual(['alpha', 'bravo', '@everyone']);
    expect(h.document.querySelector('.ca-mention-head')?.textContent).toBe('Members');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    type(h, 'ping @br');
    expect(names(h)).toEqual(['bravo']);
    key(h, input, 'Tab');
    expect(input.value).toBe('ping @bravo ');
    expect((h.document.querySelector('.ca-mention') as HTMLElement).hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves with the arrows, accepts with Enter without sending, and closes on Escape', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const input = type(h, '@');
    key(h, input, 'ArrowDown');
    expect(h.document.querySelector('.ca-mention-item.is-active .ca-mention-name')?.textContent).toBe('bravo');
    key(h, input, 'Enter');
    expect(input.value).toBe('@bravo ');
    expect(h.server.posts).toEqual([]);
    type(h, '@a');
    key(h, input, 'Escape');
    expect((h.document.querySelector('.ca-mention') as HTMLElement).hidden).toBe(true);
  });

  it('never narrows delivery: a mention is highlighted, only the To choice addresses', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const form = h.document.querySelector('.chatroom-composer') as HTMLFormElement;
    type(h, 'thanks @bravo, @everyone carry on');
    form.requestSubmit();
    await settle(60);
    const posts = h.server.calls.filter(
      (c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages')
    );
    expect(posts.map((c: { body: { to?: string[] } }) => c.body.to)).toEqual([undefined]);
  });

  it('completes only the @ the caret is still in (no duplicated text), and Shift+Enter is a newline', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const input = type(h, 'hello @al');
    input.setSelectionRange(0, 0);
    key(h, input, 'Enter');
    expect(input.value).toBe('hello @al');
    expect((h.document.querySelector('.ca-mention') as HTMLElement).hidden).toBe(true);
    type(h, 'hi @al');
    const shift = new h.window.KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(shift);
    expect(shift.defaultPrevented).toBe(false);
    expect(input.value).toBe('hi @al');
    expect(input.getAttribute('role')).toBe('combobox');
    key(h, input, 'Escape');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('highlights mentions in rendered messages but not inside an address', async () => {
    const h = await createHarness({
      sessions,
      rooms: [
        room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {
          messages: [message('m1', 'r1', agent(A, 'alpha'), 'hey @bravo and @everyone, mail a@bravo.io', 1000)],
        }),
      ],
    });
    const tags = [...h.document.querySelectorAll('.ca-msg .ca-mention-tag')].map((e) => e.textContent);
    expect(tags).toEqual(['@bravo', '@everyone']);
  });

  it('leaves @all and @here as plain text: only @everyone reaches the whole room', async () => {
    const h = await createHarness({
      sessions,
      rooms: [
        room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {
          messages: [message('m1', 'r1', agent(A, 'alpha'), '@all and @here, also email@all.io and @allies, then @everyone', 1000)],
        }),
      ],
    });
    expect([...h.document.querySelectorAll('.ca-msg .ca-mention-tag')].map((e) => e.textContent)).toEqual(['@everyone']);
  });
});

describe('the two plus buttons', () => {
  const click = (el: Element | null) => (el as HTMLElement).click();

  it('the rail plus creates a workspace, the sidebar plus a channel in the open workspace', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const rail = h.document.querySelector('.ca-rail-add') as HTMLElement;
    expect(rail.getAttribute('aria-label')).toBe('Create a workspace');
    const side = [...h.document.querySelectorAll('.ca-side-title button')].find(
      (b) => b.getAttribute('aria-label') === 'New channel'
    );
    expect(side).toBeTruthy();

    click(rail);
    const dlg = h.document.querySelector('.ca-workspace') as HTMLDialogElement;
    expect(dlg.hasAttribute('open')).toBe(true);
    const name = dlg.querySelector('input') as HTMLInputElement;
    name.value = 'Home';
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    expect(dlg.querySelector('.ca-form-error')?.textContent).toMatch(/not Home/);
    name.value = 'Acme  Labs';
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(30);
    expect(h.document.querySelector('.ca-create .ca-dialog-note')?.textContent).toBe(
      'New workspace Acme Labs: its first channel'
    );
    (h.document.querySelector('.ca-create-name') as HTMLInputElement).value = 'general';
    (h.document.querySelector('.ca-create form') as HTMLFormElement).requestSubmit();
    await settle(80);
    const calls = h.server.calls
      .filter((c: { method: string }) => c.method !== 'GET')
      .map((c: { method: string; path: string; body: unknown }) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`);
    expect(calls[0]).toMatch(/^POST \/api\/chatrooms /);
    expect(calls[1]).toMatch(/^PUT \/api\/chatrooms\/new-\d+\/placement \{"workspace":"Acme Labs","category":""\}$/);
  });

  it('the sidebar plus inside a workspace places the new channel there; cancelling forgets it', async () => {
    const rooms = [
      room('r1', 'General', [member(A, 'alpha')], { workspace: 'Acme' }),
      room('r2', 'Other', [member(A, 'alpha')]),
    ];
    const h = await createHarness({ sessions, rooms });
    click(h.document.querySelector('[data-key="ws:Acme"]'));
    await settle(30);
    click(
      [...h.document.querySelectorAll('.ca-side-title button')].find(
        (b) => b.getAttribute('aria-label') === 'New channel'
      ) ?? null
    );
    expect(h.document.querySelector('.ca-create .ca-dialog-note')?.textContent).toBe('in Acme');
    (h.document.querySelector('.ca-create-name') as HTMLInputElement).value = 'ops';
    (h.document.querySelector('.ca-create form') as HTMLFormElement).requestSubmit();
    await settle(80);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string; body: { workspace?: string } }) =>
          c.method === 'PUT' && c.path.endsWith('/placement') && c.body.workspace === 'Acme'
      )
    ).toBe(true);
  });

  it('has no workspace plus on a server without placement', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), features: null });
    expect(h.document.querySelector('.ca-rail-add')).toBeNull();
  });
});

describe('replies', () => {
  const rooms = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {
      messages: [
        message('m1', 'r1', agent(A, 'alpha'), 'the plan is ready', 1000),
        message('m2', 'r1', agent(A, 'alpha'), 'and a second line', 1100),
        message('m3', 'r1', agent(B, 'bravo'), 'seen', 1200, { replyTo: 'm1' }),
        message('m4', 'r1', agent(B, 'bravo'), 'ghost', 1300, { replyTo: 'gone' }),
      ],
    }),
    room('r2', 'Ops', [member(A, 'alpha')], {}),
  ];
  const reply = (h: Awaited<ReturnType<typeof createHarness>>, id: string) =>
    (h.document.querySelector(`[data-msg-id="${id}"] .ca-act-reply`) as HTMLElement).click();

  it('quotes the original above a reply (and says when it is gone), and jumps to it', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const refs = [...h.document.querySelectorAll('.ca-reply-ref')];
    expect(refs[0].textContent).toContain('alpha');
    expect(refs[0].textContent).toContain('the plan is ready');
    expect(refs[1].textContent).toContain('no longer available');
    expect(h.document.querySelector('[data-msg-id="m3"]')?.classList.contains('is-head')).toBe(true);
    (refs[0] as HTMLElement).click();
    expect(h.document.querySelector('[data-msg-id="m1"]')?.classList.contains('is-flash')).toBe(true);
  });

  it('replies from the Reply button, shows the bar, and clears after sending', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    reply(h, 'm2');
    const bar = h.document.querySelector('.ca-reply-bar') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Replying to alpha');
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    input.value = 'go ahead';
    (h.document.querySelector('.chatroom-composer') as HTMLFormElement).requestSubmit();
    await settle(60);
    const call = h.server.calls.find(
      (c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages')
    );
    expect(call.body).toMatchObject({ text: 'go ahead', replyTo: 'm2' });
    expect(call.body.to).toBeUndefined();
    expect(bar.hidden).toBe(true);
  });

  it('Escape or the close button cancels, and a reply does not follow you to another room', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    reply(h, 'm1');
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect((h.document.querySelector('.ca-reply-bar') as HTMLElement).hidden).toBe(true);
    reply(h, 'm1');
    await h.shell.selectRoom('r2');
    expect((h.document.querySelector('.ca-reply-bar') as HTMLElement).hidden).toBe(true);
    input.value = 'hi';
    (h.document.querySelector('.chatroom-composer') as HTMLFormElement).requestSubmit();
    await settle(60);
    const call = h.server.calls
      .filter((c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages'))
      .at(-1);
    expect(call.body.replyTo).toBeUndefined();
  });

  it('has a compact hover toolbar like Discord: quick reactions, add reaction, reply, more', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const bar = h.document.querySelector('[data-msg-id="m2"] .ca-msg-actions') as HTMLElement;
    expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'React with \u{1F44D}',
      'React with \u{1F602}',
      'Add reaction',
      'Reply',
      'More',
    ]);
    (bar.querySelector('button') as HTMLElement).click();
    await settle(30);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages/m2/reactions')
      )
    ).toBe(true);
    (bar.querySelector('[aria-label="More"]') as HTMLElement).click();
    expect([...h.document.querySelectorAll('.ca-msg-menu button')].map((b) => b.textContent)).toEqual([
      'Reply',
      'Copy text',
      'Pin message',
      'Delete message',
    ]);
  });

  it('highlights the message being answered and sends the reply to whoever the To choice says', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    reply(h, 'm2');
    expect(h.document.querySelector('[data-msg-id="m2"]')?.classList.contains('is-replying')).toBe(true);
    expect(h.document.querySelector('.ca-reply-ping')).toBeNull();
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    input.value = 'to all';
    (h.document.querySelector('.chatroom-composer') as HTMLFormElement).requestSubmit();
    await settle(60);
    const call = h.server.calls.find(
      (c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages')
    );
    expect(call.body.replyTo).toBe('m2');
    expect(call.body.to).toBeUndefined();
    expect(h.document.querySelector('[data-msg-id="m2"]')?.classList.contains('is-replying')).toBe(false);
  });

  it('deletes a message after confirming, and reports one to the coordinator', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const more = (id: string) =>
      (h.document.querySelector(`[data-msg-id="${id}"] [aria-label="More"]`) as HTMLElement).click();
    const menuItem = (label: string) =>
      [...h.document.querySelectorAll('.ca-msg-menu button')].find((b) => b.textContent === label) as HTMLElement;
    // bravo's message m3: report goes to alpha (the coordinator), as a reply
    more('m3');
    menuItem('Report message').click();
    const dlg = h.document.querySelector('.ca-report') as HTMLDialogElement;
    expect(dlg.textContent).toContain('alpha');
    (dlg.querySelector('textarea') as HTMLTextAreaElement).value = 'rude';
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(60);
    // the server composes and logs the report; the page only sends the reason
    expect(h.server.reports).toEqual([{ id: 'm3', body: { reason: 'rude' } }]);
    expect(dlg.textContent).toContain('direct message with them');
    expect(
      h.server.calls.some((c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages'))
    ).toBe(false);
    expect(h.document.querySelector('.ca-report')).toBeNull();
    // delete: declined, then confirmed
    h.window.confirm = () => false;
    more('m2');
    menuItem('Delete message').click();
    await settle(20);
    expect(h.server.calls.some((c: { method: string }) => c.method === 'DELETE')).toBe(false);
    h.window.confirm = () => true;
    more('m2');
    menuItem('Delete message').click();
    await settle(60);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string }) => c.method === 'DELETE' && c.path.endsWith('/messages/m2')
      )
    ).toBe(true);
    // a tombstone stays, with Restore; the content is gone from the page
    const tomb = h.document.querySelector('[data-msg-id="m2"]') as HTMLElement;
    expect(tomb.classList.contains('is-deleted')).toBe(true);
    expect(tomb.textContent).not.toContain('and a second line');
    expect(tomb.textContent).toContain('was deleted');
    (tomb.querySelector('.ca-restore') as HTMLElement).click();
    await settle(60);
    expect(h.document.querySelector('[data-msg-id="m2"]')?.classList.contains('is-deleted')).toBe(false);
    expect(h.document.querySelector('[data-msg-id="m2"]')?.textContent).toContain('and a second line');
  });

  it('offers no Reply on a server that cannot store replies', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), features: { unread: true, dms: true, placement: true } });
    expect(h.document.querySelector('.ca-msg-actions')).toBeNull();
    expect(h.document.querySelector('.ca-reply-ref')).toBeNull();
  });
});

describe('your profile', () => {
  const rooms = () => [
    room('r1', 'General', [member(A, 'alpha')], {
      messages: [message('m1', 'r1', user, 'hello from me', 1000)],
    }),
  ];

  it('opens a card from your name, edits it, and shows it on your messages and bar', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    expect(h.document.querySelector('.ca-user-name')?.textContent).toBe('You');
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    const card = h.document.querySelector('.ca-me-card') as HTMLElement;
    expect(card.textContent).toContain('Edit profile');
    (card.querySelector('button') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-profile-edit') as HTMLDialogElement;
    const [name, pronouns, status] = [
      ...dlg.querySelectorAll('input:not([type=checkbox]):not([type=file])'),
    ] as HTMLInputElement[];
    name.value = 'Sam';
    pronouns.value = 'they/them';
    status.value = 'shipping';
    (dlg.querySelector('[data-hue="160"]') as HTMLElement).click();
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    expect(h.document.querySelector('.ca-profile-edit')).toBeNull();
    expect(h.document.querySelector('.ca-user-name')?.textContent).toBe('Sam');
    expect(h.document.querySelector('.ca-msg-from')?.textContent).toBe('Sam');
    expect(h.document.querySelector('.ca-msg .chatroom-avatar-glyph')?.textContent).toBe('S');
    expect(h.window.localStorage.getItem('reverie:chat:profile')).toContain('"pronouns":"they/them"');
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    expect(h.document.querySelector('.ca-me-card')?.textContent).toContain('shipping');
    expect(h.document.querySelector('.ca-me-card')?.textContent).toContain('they/them');
  });

  it('remembers the profile on reload, and Reset puts you back', async () => {
    const stored = { 'reverie:chat:profile': JSON.stringify({ name: 'Sam', icon: '\u{1F980}', hue: 45 }) };
    const h = await createHarness({ sessions, rooms: rooms(), stored });
    expect(h.document.querySelector('.ca-user-name')?.textContent).toBe('Sam');
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    (h.document.querySelector('.ca-me-card .ca-profile-actions button') as HTMLElement).click();
    const reset = [...h.document.querySelectorAll('.ca-profile-edit .ca-btn')].find(
      (b) => b.textContent === 'Reset'
    ) as HTMLElement;
    reset.click();
    expect(h.document.querySelector('.ca-user-name')?.textContent).toBe('You');
    expect(h.window.localStorage.getItem('reverie:chat:profile')).toBeNull();
  });
});

describe('agent profile details', () => {
  it('shows backend, model, effort and usage from the session, and nothing it does not know', async () => {
    const s = [
      {
        id: A,
        name: 'alpha',
        mode: 'codex',
        codexConfig: { model: 'gpt-5', reasoningEffort: 'high' },
        inputTokens: 2000,
        totalCost: 0.5,
        createdAt: 1000,
      },
    ];
    const h = await createHarness({ sessions: s, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    (h.document.querySelector('.ca-member') as HTMLElement).click();
    const card = h.document.querySelector('.ca-profile') as HTMLElement;
    const text = card.textContent || '';
    for (const want of [
      'Runtime',
      'Harness',
      'Codex',
      'gpt-5',
      'Effort',
      'high',
      'Usage',
      'Input tokens',
      '2.0k',
      '$0.50',
    ])
      expect(text).toContain(want);
    expect(text).not.toContain('Output tokens');
  });

  it('keeps model and effort in collapsed technical details after the primary profile and actions', async () => {
    const s = [
      {
        id: A,
        name: 'alpha',
        mode: 'claude',
        model: 'opus',
        displayModel: { model: 'Opus 5.5', source: 'statusline' },
        effort: 'high',
      },
    ];
    const h = await createHarness({
      sessions: s,
      rooms: [room('r1', 'General', [member(A, 'alpha', { goal: 'ship it' })], {})],
    });
    (h.document.querySelector('.ca-member') as HTMLElement).click();
    const rows = () =>
      [...h.document.querySelectorAll('.ca-profile > .ca-kv')].map(
        (r) => `${r.querySelector('.ca-k')?.textContent}=${r.querySelector('.ca-v')?.textContent}`
      );
    expect(rows()).toEqual([]);
    const technical = h.document.querySelector('.ca-profile-technical') as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(technical.querySelector('summary')?.textContent).toBe('Technical details');
    expect([...technical.querySelectorAll(':scope > .ca-kv')].map(r => r.textContent)).toEqual(['ModelOpus 5.5', 'Efforthigh', 'Goalship it', 'Wakes onWhat the room says']);
    expect(technical.previousElementSibling?.classList.contains('ca-profile-actions')).toBe(true);
    // a Claude session with no launch effort says so, and one that only has its launch model says that too
    const bare = await createHarness({
      sessions: [{ id: A, name: 'alpha', mode: 'opencode', displayModel: { model: 'local/qwen', source: 'launch' } }],
      rooms: [room('r1', 'General', [member(A, 'alpha')], {})],
    });
    (bare.document.querySelector('.ca-member') as HTMLElement).click();
    expect((bare.document.querySelector('.ca-profile') as HTMLElement).textContent).toContain(
      'local/qwen (set at launch)'
    );
    expect((bare.document.querySelector('.ca-profile') as HTMLElement).textContent).not.toContain('Effort');
  });
});

describe('workspace "+" review fixes', () => {
  it('keeps the pending workspace when a create is refused, and moves the sidebar to the new workspace', async () => {
    const rooms = [
      room('r1', 'General', [member(A, 'alpha')], { workspace: 'Acme' }),
      room('r2', 'Other', [member(A, 'alpha')]),
    ];
    const h = await createHarness({ sessions, rooms });
    (h.document.querySelector('[data-key="ws:Acme"]') as HTMLElement).click();
    await settle(30);
    (h.document.querySelector('.ca-rail-add') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-workspace') as HTMLDialogElement;
    (dlg.querySelector('input') as HTMLInputElement).value = 'Zeta';
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(30);
    // a refused first attempt
    const real = h.server.handle;
    let refuse = true;
    h.server.handle = async (path: string, opts: { method?: string } = {}) =>
      refuse && opts.method === 'POST' && path === '/api/chatrooms'
        ? { ok: false, status: 400, json: async () => ({ success: false, error: 'nope' }) }
        : real(path, opts);
    (h.document.querySelector('.ca-create-name') as HTMLInputElement).value = 'general';
    (h.document.querySelector('.ca-create form') as HTMLFormElement).requestSubmit();
    await settle(60);
    expect(h.document.querySelector('.ca-create .ca-form-error')?.textContent).toBe('nope');
    refuse = false;
    (h.document.querySelector('.ca-create form') as HTMLFormElement).requestSubmit();
    await settle(100);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string; body: { workspace?: string } }) =>
          c.method === 'PUT' && c.path.endsWith('/placement') && c.body.workspace === 'Zeta'
      )
    ).toBe(true);
    expect(h.document.querySelector('.ca-side-name')?.textContent).toBe('Zeta');
  });
});

describe('org chart: connected-worker projection without teardown', () => {
  it('renders the reporting tree and live temps; hides disconnected pinned temps without mutation or API teardown', async () => {
    const live = { id: B, name: 'live-temp', mode: 'codex', pid: 123 };
    const disconnected = { id: '97329593', name: 'old', pid: null, pinned: true };
    const company = {
      settings: { ownerName: 'Pat', coordinatorEmployeeId: 'chief' },
      employees: [
        { id: 'chief', name: 'Chief', position: 'CTO', sessionId: A, reportsTo: 'owner' },
        { id: 'lead', name: 'Lead', position: 'Tech lead', sessionId: 'lead-offline', available: false, reportsTo: 'chief' },
        { id: 'report', name: 'Report', position: 'Engineer', sessionId: 'report-offline', available: false, reportsTo: 'lead' },
      ],
      temporaryAgents: [
        { sessionId: B, name: 'live-temp', icon: '🦉' },
        { sessionId: '97329593', name: 'stale-pinned-one', kept: true },
        { sessionId: '2e9d2da3', name: 'stale-pinned-two', kept: true },
        { sessionId: 'gone', name: 'gone-unpinned' },
      ],
    };
    const original = JSON.stringify(company);
    const h = await createHarness({ sessions: [{ id: A, name: 'chief', pid: null }, live, disconnected], rooms: [], company });
    const beforeSessions = [...h.app.sessions.entries()];
    await h.shell.openOrg();
    await settle(70);
    const panel = h.document.querySelector('.ca-org')!;
    expect(panel.textContent).toContain('Chief');
    expect(panel.textContent).toContain('Lead');
    expect(panel.textContent).toContain('Report');
    expect(panel.textContent).toContain('live-temp');
    expect(panel.textContent).not.toContain('stale-pinned');
    expect(panel.textContent).not.toContain('gone-unpinned');
    expect(panel.querySelector('.ca-org-former, .ca-org-clean')).toBeNull();
    expect(panel.querySelector('.ca-org-item[data-org-key="employee:report"]')?.getAttribute('data-parent-id')).toBe('employee:lead');
    expect(panel.querySelector('.ca-company-map-links path[data-parent-id="employee:lead"][data-child-id="employee:report"]')).not.toBeNull();
    expect(JSON.stringify(company)).toBe(original);
    expect([...h.app.sessions.entries()]).toEqual(beforeSessions);
    expect(h.server.calls.some((call: { method: string; path: string }) => call.method !== 'GET')).toBe(false);
  });
});

describe('org chart', () => {
  const company = {
    settings: { ownerName: 'Pat', coordinatorEmployeeId: 'c' },
    employees: [
      { id: 'c', name: 'Chief', position: 'CTO', sessionId: A, icon: '\u{1F9ED}' },
      { id: 'w', name: 'Wren', position: 'Engineer', sessionId: 'gone', reportsTo: 'c', available: false },
    ],
  };

  it('draws the org tree as text, messages someone, and closes with Escape', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    h.server.company = company;
    await h.shell.openOrg();
    await settle(40);
    const panel = h.document.querySelector('.ca-org') as HTMLElement;
    expect(panel.hidden).toBe(false);
    const text = panel.textContent || '';
    for (const want of ['Pat', 'Chief', 'CTO', 'Wren', 'Engineer', 'disconnected']) expect(text).toContain(want);
    expect(panel.querySelectorAll('.ca-org-item').length).toBe(3);
    expect(panel.querySelector('[role="tree"]')).toBeNull();
    // only people with a live session can be messaged
    expect(panel.querySelectorAll('button.ca-org-node').length).toBe(1);
    h.document
      .querySelector('.ca-org')
      ?.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect((h.document.querySelector('.ca-org') as HTMLElement).hidden).toBe(true);
    expect(h.document.activeElement?.getAttribute('aria-label')).toBe('Office settings');
    await h.shell.openOrg();
    await settle(40);
    (h.document.querySelector('button.ca-org-node') as HTMLElement).click();
    await settle(60);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string }) => c.method === 'POST' && c.path === '/api/chatrooms/dms'
      )
    ).toBe(true);
    expect((h.document.querySelector('.ca-org') as HTMLElement).hidden).toBe(true);
  });

  it('never injects names or titles as HTML', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    h.server.company = {
      settings: {},
      employees: [{ id: 'x', name: '<img src=x onerror=alert(1)>', position: '<b>boss</b>' }],
    };
    await h.shell.openOrg();
    await settle(40);
    expect(h.document.querySelector('.ca-org img, .ca-org b')).toBeNull();
    expect(h.document.querySelector('.ca-org')?.textContent).toContain('<img src=x');
  });
});

describe('invite to channel', () => {
  const S = [
    { id: A, name: 'alpha', mode: 'claude' },
    { id: B, name: 'bravo', mode: 'codex' },
    { id: '0000003b-0049-4000-8000-00000000006a', name: 'carol', mode: 'opencode' },
    { id: '00000040-0050-4000-8000-000000000077', name: 'term', mode: 'shell' },
  ];

  it('keeps channel settings and the member-list add control without a duplicate row invite', async () => {
    const h = await createHarness({
      sessions: S,
      rooms: [
        room('r1', 'General', [member(A, 'alpha')], {}),
        room('dm1', '', [member(B, 'bravo')], { kind: 'dm', dm: ['user', B] }),
      ],
    });
    expect(h.document.querySelector('.ca-side [data-key="invite:r1"]')).toBeNull();
    expect(h.document.querySelector('.ca-side [data-key="edit:r1"]')).not.toBeNull();
    expect(h.document.querySelector('.ca-add-button')?.getAttribute('aria-label')).toBe('Add an agent');
    (h.document.querySelector('.ca-head-invite') as HTMLButtonElement).click();
    const dlg = h.document.querySelector('.ca-invite') as HTMLDialogElement;
    expect(dlg.textContent).toContain('Invite agents to #General');
    const names = () => [...dlg.querySelectorAll('.ca-invite-row strong')].map((e) => e.textContent);
    // alpha is already in, the terminal is not an agent
    expect(names()).toEqual(['bravo', 'carol']);
    const search = dlg.querySelector('input') as HTMLInputElement;
    search.value = 'car';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(names()).toEqual(['carol']);
    search.value = 'zzz';
    search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(dlg.textContent).toContain('No agent matches');
  });

  it('invites an agent: posts it to that room and shows it as invited', async () => {
    const h = await createHarness({ sessions: S, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    (h.document.querySelector('.ca-head-invite') as HTMLButtonElement).click();
    const dlg = h.document.querySelector('.ca-invite') as HTMLDialogElement;
    (
      [...dlg.querySelectorAll('.ca-invite-row button')].find(
        (b) => b.getAttribute('aria-label') === 'Invite bravo'
      ) as HTMLElement
    ).click();
    await settle(40);
    expect(h.server.invited).toEqual([{ id: 'r1', sessionId: B }]);
    expect([...dlg.querySelectorAll('.ca-invite-row strong')].map((e) => e.textContent)).toEqual(['carol']);
    (dlg.querySelector('.ca-icon-btn') as HTMLElement).click();
    expect(h.document.querySelector('.ca-invite')).toBeNull();
  });
});

describe('review fixes for replies, delete/report and keyboard', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {
      messages: [
        message('m1', 'r1', agent(A, 'alpha'), 'from the lead', 1000),
        message('m2', 'r1', agent(B, 'bravo'), 'from a member', 1100),
      ],
    }),
  ];
  const menuLabels = (h: Awaited<ReturnType<typeof createHarness>>, id: string) => {
    (h.document.querySelector(`[data-msg-id="${id}"] [aria-label="More"]`) as HTMLElement).click();
    return [...h.document.querySelectorAll('.ca-msg-menu button')].map((b) => b.textContent);
  };

  it("does not offer Report on the coordinator's own message", async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    expect(menuLabels(h, 'm1')).not.toContain('Report message');
    h.document.querySelector('.ca-msg-menu')?.remove();
    expect(menuLabels(h, 'm2')).toContain('Report message');
  });

  it('puts each message in the tab order, moves in the menu with the arrows, and gives focus back', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    expect((h.document.querySelector('[data-msg-id="m2"]') as HTMLElement).tabIndex).toBe(0);
    const more = h.document.querySelector('[data-msg-id="m2"] [aria-label="More"]') as HTMLElement;
    more.click();
    const items = [...h.document.querySelectorAll('.ca-msg-menu button')] as HTMLElement[];
    expect(h.document.activeElement).toBe(items[0]);
    const menu = h.document.querySelector('.ca-msg-menu') as HTMLElement;
    menu.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(h.document.activeElement).toBe(items[1]);
    menu.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(h.document.activeElement).toBe(items.at(-1));
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
    expect(h.document.activeElement).toBe(more);
  });

  it('replaces the whole word when a mention is accepted mid-word', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    input.value = 'hi @alpha';
    input.setSelectionRange(6, 6);
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(input.value).toBe('hi @alpha ');
  });

  it('shows an odd backend name as plain text', async () => {
    const s = [{ id: A, name: 'alpha', mode: '__proto__' }];
    const h = await createHarness({ sessions: s, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    (h.document.querySelector('.ca-member') as HTMLElement).click();
    expect(h.document.querySelector('.ca-profile')?.textContent).toContain('__proto__');
    expect(h.document.querySelector('.ca-profile')?.textContent).not.toContain('[object Object]');
  });
});

describe('edit channel', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {
      workspace: 'Acme',
      category: 'Build',
      topic: 'old topic',
    }),
    room('r2', 'Ops', [member(A, 'alpha')], {}),
  ];
  const open = async (h: Awaited<ReturnType<typeof createHarness>>, id = 'r1') => {
    (h.document.querySelector(`[data-key="edit:${id}"]`) as HTMLElement).click();
    await settle(60);
    return h.document.querySelector('.ca-settings') as HTMLElement;
  };
  const input = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(label))!
      .querySelector('input,textarea') as HTMLInputElement;

  it('opens from the gear on a channel row, shows its fields, and offers Save only after a change', async () => {
    const h = await createHarness({ sessions, rooms: rs(), stored: { 'reverie:chatroom': 'r1' } });
    (h.document.querySelector('[data-key="ws:Acme"]') as HTMLElement).click();
    await settle(30);
    const root = await open(h);
    expect(root.getAttribute('aria-label')).toBe('Edit channel General');
    expect(input(root, 'Channel name').value).toBe('General');
    expect(input(root, 'Channel topic').value).toBe('old topic');
    expect(input(root, 'Category').value).toBe('Build');
    const bar = root.querySelector('.ca-savebar') as HTMLElement;
    expect(bar.hidden).toBe(true);
    const name = input(root, 'Channel name');
    name.value = 'Core';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(bar.hidden).toBe(false);
    const topic = input(root, 'Channel topic');
    topic.value = 'new topic';
    topic.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    const cat = input(root, 'Category');
    cat.value = 'Ship';
    cat.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    ([...bar.querySelectorAll('button')].find((b) => b.textContent === 'Save changes') as HTMLElement).click();
    await settle(80);
    const puts = h.server.calls
      .filter((c: { method: string }) => c.method === 'PUT')
      .map((c: { path: string; body: unknown }) => [c.path, c.body]);
    expect(puts).toEqual([
      ['/api/chatrooms/r1', { name: 'Core', topic: 'new topic' }],
      ['/api/chatrooms/r1/placement', { workspace: 'Acme', category: 'Ship' }],
    ]);
    expect(bar.hidden).toBe(true);
  });

  it('Escape closes it (asking first when there are unsaved changes), and Reset undoes them', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const root = await open(h);
    const name = input(root, 'Channel name');
    name.value = 'x';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    h.window.confirm = () => false;
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.document.querySelector('.ca-settings')).not.toBeNull();
    ([...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Reset') as HTMLElement).click();
    expect(input(root, 'Channel name').value).toBe('General');
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.document.querySelector('.ca-settings')).toBeNull();
  });

  it('lists members with Invite, and deletes the channel after confirming', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const root = await open(h);
    ([...root.querySelectorAll('.ca-settings-tab')].find((b) => b.textContent === 'Members') as HTMLElement).click();
    expect(root.textContent).toContain('alpha');
    expect(root.textContent).toContain('bravo');
    expect(root.textContent).toContain('Admin');
    ([...root.querySelectorAll('button')].find((b) => b.textContent === 'Invite agents') as HTMLElement).click();
    expect(h.document.querySelector('.ca-invite')).not.toBeNull();
    h.document.querySelector('.ca-invite')?.remove();
    h.window.confirm = () => true;
    (
      [...root.querySelectorAll('.ca-settings-tab')].find((b) => b.textContent === 'Delete channel') as HTMLElement
    ).click();
    await settle(60);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string }) => c.method === 'DELETE' && c.path === '/api/chatrooms/r1'
      )
    ).toBe(true);
    expect(h.document.querySelector('.ca-settings')).toBeNull();
  });

  it('has no topic field on a server without topics, and none for direct messages', async () => {
    const h = await createHarness({ sessions, rooms: rs(), features: { unread: true, dms: true, placement: true } });
    const root = await open(h);
    expect([...root.querySelectorAll('label')].some((l) => l.textContent?.includes('topic'))).toBe(false);
  });
});

describe('create channel', () => {
  const S = [
    { id: A, name: 'alpha', mode: 'claude' },
    { id: B, name: 'bravo', mode: 'codex' },
    { id: '00000040-0050-4000-8000-000000000077', name: 'term', mode: 'shell' },
  ];
  const rs = () => [room('r1', 'General', [member(A, 'alpha')], { category: 'Build' })];
  const created = (h: Awaited<ReturnType<typeof createHarness>>) =>
    (h.server.created ?? []) as {
      name: string;
      members: { sessionId: string; voice?: boolean }[];
      coordinatorSessionId?: string;
    }[];
  const submit = (h: Awaited<ReturnType<typeof createHarness>>) =>
    (h.document.querySelector('.ca-create form') as HTMLFormElement).requestSubmit();

  it('the category "+" opens it in that category, with text and voice types and only real agents', async () => {
    const h = await createHarness({ sessions: S, rooms: rs() });
    (h.document.querySelector('.ca-cat-add') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-create') as HTMLDialogElement;
    expect(dlg.querySelector('.ca-dialog-note')?.textContent).toBe('in Build');
    expect((dlg.querySelector('[list="ca-create-cats"]') as HTMLInputElement).value).toBe('Build');
    expect([...dlg.querySelectorAll('input[type=radio]')].map((r) => (r as HTMLInputElement).value)).toEqual([
      'text',
      'voice',
    ]);
    expect([...dlg.querySelectorAll('.ca-create-member .ca-name')].map((e) => e.textContent)).toEqual([
      'alpha',
      'bravo',
    ]);
  });

  it('creates a text channel with members and a coordinator, placed in its category', async () => {
    const h = await createHarness({ sessions: S, rooms: rs() });
    (h.document.querySelector('.ca-cat-add') as HTMLElement).click();
    (h.document.querySelector('.ca-create-name') as HTMLInputElement).value = 'ops';
    for (const box of h.document.querySelectorAll('.ca-create-member input')) {
      (box as HTMLInputElement).checked = true;
      box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    }
    const coord = h.document.querySelector('.ca-create select') as HTMLSelectElement;
    coord.value = B;
    submit(h);
    await settle(100);
    expect(created(h)).toEqual([{ name: 'ops', members: [{ sessionId: A }], coordinatorSessionId: B }]);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string; body: { category?: string } }) =>
          c.method === 'PUT' && c.path.endsWith('/placement') && c.body.category === 'Build'
      )
    ).toBe(true);
    expect(h.document.querySelector('.ca-create')).toBeNull();
  });

  it('a voice channel needs a voice agent among its members, and marks it', async () => {
    const h = await createHarness({ sessions: S, rooms: rs() });
    (h.document.querySelector('.ca-side-title button[aria-label="New channel"]') as HTMLElement).click();
    (h.document.querySelector('.ca-create input[value="voice"]') as HTMLInputElement).click();
    (h.document.querySelector('.ca-create-name') as HTMLInputElement).value = 'standup';
    const [box] = [...h.document.querySelectorAll('.ca-create-member input')] as HTMLInputElement[];
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    submit(h);
    await settle(40);
    expect(h.document.querySelector('.ca-create .ca-form-error')?.textContent).toMatch(/voice agent/);
    expect(created(h)).toEqual([]);
    const selects = [...h.document.querySelectorAll('.ca-create select')] as HTMLSelectElement[];
    selects[1].value = A;
    submit(h);
    await settle(100);
    expect(created(h)).toEqual([{ name: 'standup', members: [{ sessionId: A, voice: true }] }]);
  });
});

describe('the owner name', () => {
  const settings = {
    ownerName: 'Pat',
    ownerTitle: 'Owner',
    timeZone: 'UTC',
    nightHour: 1,
    morningHour: 8,
    enabled: false,
    coordinatorEmployeeId: 'c',
    owner: 'x',
  };
  const rs = () => [room('r1', 'General', [member(A, 'alpha')], { messages: [message('m1', 'r1', user, 'hi', 1000)] })];

  it('is how you are called until you choose another name, and "You" is the fallback', async () => {
    const h = await createHarness({ sessions, rooms: rs(), company: { employees: [], settings } });
    await settle(60);
    expect(h.document.querySelector('.ca-user-name')?.textContent).toBe('Pat');
    expect(h.document.querySelector('.ca-msg-from')?.textContent).toBe('Pat');
    const none = await createHarness({ sessions, rooms: rs() });
    await settle(60);
    expect(none.document.querySelector('.ca-user-name')?.textContent).toBe('You');
  });

  it('a name saved in the profile wins; ticking the box sets the instance owner name without touching other settings', async () => {
    const h = await createHarness({
      sessions,
      rooms: rs(),
      company: { employees: [], settings: { ...settings, ownerName: '' } },
    });
    await settle(60);
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    (h.document.querySelector('.ca-me-card .ca-profile-actions button') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-profile-edit') as HTMLDialogElement;
    (dlg.querySelector('input') as HTMLInputElement).value = 'Pat';
    (dlg.querySelector('input[type=checkbox]') as HTMLInputElement).checked = true;
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(80);
    const put = h.server.calls.find(
      (c: { method: string; path: string }) => c.method === 'PUT' && c.path === '/api/company/settings'
    );
    expect(put.body).toEqual({
      ownerName: 'Pat',
      ownerTitle: 'Owner',
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      enabled: false,
      coordinatorEmployeeId: 'c',
    });
    expect(h.document.querySelector('.ca-user-name')?.textContent).toBe('Pat');
  });

  it('without the box only this browser gets the name', async () => {
    const h = await createHarness({ sessions, rooms: rs(), company: { employees: [], settings } });
    await settle(60);
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    (h.document.querySelector('.ca-me-card .ca-profile-actions button') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-profile-edit') as HTMLDialogElement;
    (dlg.querySelector('input') as HTMLInputElement).value = 'Jim';
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(60);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string }) => c.method === 'PUT' && c.path === '/api/company/settings'
      )
    ).toBe(false);
    expect(h.document.querySelector('.ca-user-name')?.textContent).toBe('Jim');
  });
});

describe('the message box', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {}),
    room('r2', 'Standup', [member(A, 'alpha', { voice: true })], {}),
    room('dm1', '', [member(B, 'bravo')], { kind: 'dm', dm: ['user', B] }),
  ];

  it('has no To picker, names the channel in its placeholder, and sends to everyone', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    expect(input.placeholder).toBe('Message #General');
    expect((h.document.querySelector('.chatroom-to') as HTMLElement).hidden).toBe(true);
    input.value = 'hello team';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (h.document.querySelector('.chatroom-composer') as HTMLFormElement).requestSubmit();
    await settle(60);
    const call = h.server.calls.find(
      (c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages')
    );
    expect(call.body.to).toBeUndefined();
    await h.shell.selectRoom('dm1');
    expect(input.placeholder).toBe('Message @bravo');
  });

  it('has "+" to upload, no dead GIF or sticker buttons, and Send only with something to send', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const plus = h.document.querySelector('.ca-plus') as HTMLElement;
    expect(plus.getAttribute('aria-label')).toBe('Add to the message');
    expect(h.document.querySelectorAll('.ca-dim')).toHaveLength(0);
    expect(h.document.querySelector('[aria-label="Insert emoji"]')).not.toBeNull();
    const send = h.document.querySelector('.chatroom-send') as HTMLElement;
    expect(send.classList.contains('has-text')).toBe(false);
    const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
    input.value = 'x';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(send.classList.contains('has-text')).toBe(true);
  });

  it('keeps voice to voice channels: the mic and the speaker mark; read aloud is in every channel menu', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    Object.assign(h.app, { _speakRepliesMode: () => 'off', _setSpeakReplies: () => {}, openCarMode: () => {} });
    const mic = h.document.querySelector('.chatroom-mic') as HTMLElement;
    expect(mic.hidden).toBe(true);
    const marks = [...h.document.querySelectorAll('.ca-item-wrap .ca-hash')].map(
      (e) => (e as HTMLElement).dataset.glyph
    );
    expect(marks).toEqual(['text', 'voice']);
    const menu = (id: string) => {
      (h.document.querySelector(`[data-key="room:${id}"]`) as HTMLElement).dispatchEvent(
        new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
      );
      const labels = [...h.document.querySelectorAll('.ca-popmenu button')].map((b) =>
        (b.textContent || '').replace(/›$/, '')
      );
      h.document.querySelector('.ca-popmenu')?.remove();
      return labels;
    };
    expect(menu('r1').filter((l) => /read aloud|car mode/i.test(l))).toEqual(['Read aloud']);
    await h.shell.selectRoom('r2');
    expect(mic.hidden).toBe(false);
    expect((h.document.querySelector('.ca-head-name')?.previousElementSibling as HTMLElement).dataset.glyph).toBe(
      'voice'
    );
    expect(menu('r2').filter((l) => /read aloud|car mode/i.test(l))).toEqual(['Read aloud', 'Car mode']);
  });
});

describe("agent profile: the runtime's full profile", () => {
  const s = [{ id: A, name: 'alpha', mode: 'claude', cliModel: 'local-fallback' }];
  const rs = () => [room('r1', 'General', [member(A, 'alpha')], {})];
  const open = async (h: Awaited<ReturnType<typeof createHarness>>) => {
    (h.document.querySelector('.ca-member') as HTMLElement).click();
    await settle(60);
    return h.document.querySelector('.ca-profile') as HTMLElement;
  };

  it("shows persona, usage and a DISABLED backend switch with the runtime's reason", async () => {
    const h = await createHarness({ sessions: s, rooms: rs() });
    h.server.profiles = {
      [A]: {
        backend: { mode: 'claude', display_model: 'Opus 5.5' },
        usage: { input_tokens: 4000, messages: 3, scope: 'this session' },
        runtime: {
          backend: 'claude',
          backends: [
            { name: 'claude', model: 'opus', enabled: true },
            { name: 'local', model: 'qwen', enabled: true },
          ],
          switch: { available: false, reason: 'Owner authentication is not set up yet.' },
        },
        persona: { agent_name: 'Alpha', role: 'Planner', kind: 'expert', persona: 'Careful and curious.', source: 'x' },
      },
    };
    const card = await open(h);
    const text = card.textContent || '';
    for (const want of [
      'About',
      'Alpha \u00B7 Planner \u00B7 expert',
      'Careful and curious.',
      'Opus 5.5',
      '4.0k',
      'Switch harness',
      'Owner authentication is not set up yet.',
    ])
      expect(text).toContain(want);
    expect((card.querySelector('.ca-switch select') as HTMLSelectElement).disabled).toBe(true);
    expect((card.querySelector('.ca-switch button') as HTMLButtonElement).disabled).toBe(true);
    // the page's own copy of the same facts is replaced, not repeated
    expect(card.querySelector('.ca-profile-local')).toBeNull();
    expect(h.server.calls.some((c: { path: string }) => c.path === `/api/agents/${A}/profile`)).toBe(true);
  });

  it("keeps the page's own facts and says why when the runtime profile is not available", async () => {
    const h = await createHarness({ sessions: s, rooms: rs() });
    const card = await open(h);
    expect(card.textContent).toContain(
      'The technical profile is unavailable.'
    );
    expect(card.textContent).not.toContain('REVERIE_RUNTIME_POLICY');
    expect(card.querySelector('.ca-profile-technical .ca-profile-full')).not.toBeNull();
    expect(card.textContent).toContain('local-fallback');
    expect(card.querySelector('.ca-switch')).toBeNull();
  });

  it('never injects persona text as HTML', async () => {
    const h = await createHarness({ sessions: s, rooms: rs() });
    h.server.profiles = {
      [A]: { persona: { agent_name: '<b>x</b>', persona: '<img src=x onerror=alert(1)>', source: 's' } },
    };
    const card = await open(h);
    expect(card.querySelector('img, b')).toBeNull();
    expect(card.textContent).toContain('<img src=x');
  });
});

describe('Discord-style menus', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {
      unread: 2,
      mentions: 1,
      userReadAt: 100,
      messages: [message('m1', 'r1', agent(A, 'alpha'), 'hi', 500)],
    }),
    room('r2', 'Ops', [member(A, 'alpha')], {}),
  ];
  const ctx = (h: Awaited<ReturnType<typeof createHarness>>, id: string) =>
    (h.document.querySelector(`[data-key="room:${id}"]`) as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
    );
  const labels = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-popmenu button')].map((b) => b.textContent);
  const click = (h: Awaited<ReturnType<typeof createHarness>>, text: string) =>
    (
      [...h.document.querySelectorAll('.ca-popmenu button')].find((b) => b.textContent?.startsWith(text)) as HTMLElement
    ).click();

  it('has no Room actions button; actions live on the channel (right-click), the workspace name and the rows', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    expect(
      h.document.querySelector('.ca-head [aria-label="Room actions"], .ca-head [aria-label="Channel actions"]')
    ).toBeNull();
    ctx(h, 'r2');
    expect(labels(h)).toEqual([
      'Mark channel as read',
      'Invite agents',
      'Mute channel\u203A',
      'Notification settings\u203A',
      'Edit channel',
      'Re-brief members',
      'Archive channel',
      'Delete channel',
    ]);
    expect((h.document.querySelector('.ca-popmenu button.is-danger') as HTMLElement).textContent).toBe(
      'Delete channel'
    );
    expect((h.document.querySelector('.ca-popmenu button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks a channel read from its menu, and Escape closes the menu and returns focus', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    ctx(h, 'r1');
    click(h, 'Mark channel as read');
    await settle(60);
    expect(h.server.reads.some((r: { id: string }) => r.id === 'r1')).toBe(true);
    ctx(h, 'r2');
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.document.querySelector('.ca-popmenu')).toBeNull();
  });

  it('opens Edit channel and Delete channel from the menu, on the channel it was opened for', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    ctx(h, 'r2');
    click(h, 'Edit channel');
    await settle(80);
    expect(h.document.querySelector('.ca-settings')?.getAttribute('aria-label')).toBe('Edit channel Ops');
    h.document.querySelector('.ca-settings')?.remove();
    h.window.confirm = () => true;
    ctx(h, 'r2');
    click(h, 'Delete channel');
    await settle(60);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string }) => c.method === 'DELETE' && c.path === '/api/chatrooms/r2'
      )
    ).toBe(true);
  });

  it('the workspace name is a dropdown with Create channel and Mark all as read', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    (h.document.querySelector('.ca-side-name-btn') as HTMLElement).click();
    expect(labels(h)).toEqual([
      'Mark all as read',
      'Mute workspace\u203A',
      'Notification settings\u203A',
      'Hide muted channels',
      'Workspace settings',
      'Create channel',
    ]);
    click(h, 'Create channel');
    expect(h.document.querySelector('.ca-create')).not.toBeNull();
  });

  it('moves with the arrow keys and uses the word channel, not room, in what it shows', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    ctx(h, 'r1');
    const menu = h.document.querySelector('.ca-popmenu') as HTMLElement;
    const first = h.document.activeElement;
    h.document.dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    );
    expect(h.document.activeElement).not.toBe(first);
    expect(menu.textContent).not.toMatch(/\broom\b/i);
    expect(h.document.querySelector('.ca-feed-empty')?.textContent ?? 'channel').not.toMatch(/\bTo menu\b/);
  });
});

describe('notification settings', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha')], {
      unread: 3,
      mentions: 1,
      userReadAt: 100,
      messages: [message('m1', 'r1', agent(A, 'alpha'), 'hi', 500)],
    }),
    room('r2', 'Ops', [member(A, 'alpha')], {
      unread: 2,
      mentions: 0,
      userReadAt: 100,
      messages: [message('m2', 'r2', agent(A, 'alpha'), 'yo', 600)],
    }),
  ];
  const row = (h: Awaited<ReturnType<typeof createHarness>>, id: string) =>
    h.document.querySelector(`.ca-item[data-key="room:${id}"]`) as HTMLElement;
  const entry = (h: Awaited<ReturnType<typeof createHarness>>, text: string) =>
    [...h.document.querySelectorAll('.ca-popmenu button')].find((b) => b.textContent?.startsWith(text)) as HTMLElement;
  const stored = (h: Awaited<ReturnType<typeof createHarness>>) =>
    JSON.parse(h.window.localStorage.getItem('reverie:chat:notify') || '{}');

  it('the channel context menu exposes the notification levels and changes sidebar counts', async () => {
    const h = await createHarness({ sessions, rooms: rs(), stored: { 'reverie:chatroom': 'r1' } });
    // r2 has 2 unread: a dot/count shows; choose "Nothing" for it by selecting it first
    await h.shell.selectRoom('r2');
    row(h, 'r2').dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    entry(h, 'Notification settings').click();
    const labels = [...h.document.querySelectorAll('.ca-popmenu button')].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Use defaultAll messages', 'All messages', 'Only @mentions', 'Nothing']));
    expect(entry(h, 'Use default').getAttribute('aria-checked')).toBe('true');
    entry(h, 'Only @mentions').click();
    expect(stored(h)).toEqual({ r2: { level: 'mentions', until: 0 } });
    row(h, 'r2').dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    entry(h, 'Notification settings').click();
    expect(entry(h, 'Only @mentions').getAttribute('aria-checked')).toBe('true');
  });

  it('muting dims the channel, hides its unread, and Unmute brings it back', async () => {
    const h = await createHarness({ sessions, rooms: rs(), stored: { 'reverie:chatroom': 'r2' } });
    expect(row(h, 'r1').className).toContain('is-unread');
    row(h, 'r1').dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })
    );
    entry(h, 'Mute channel').click();
    const subs = [...h.document.querySelectorAll('.ca-popmenu')].at(-1)!.querySelectorAll('button');
    expect([...subs].map((b) => b.textContent)).toEqual([
      'For 15 minutes',
      'For 1 hour',
      'For 3 hours',
      'For 8 hours',
      'For 24 hours',
      'Until I turn it back on',
    ]);
    (subs[1] as HTMLElement).click();
    expect(row(h, 'r1').className).toContain('is-muted');
    expect(row(h, 'r1').className).not.toContain('is-unread');
    expect(stored(h).r1.until).toBeGreaterThan(Date.now());
    expect(h.document.querySelector('.ca-head-bell')).toBeNull();
    expect(row(h, 'r1').querySelector('.ca-muted-badge')?.textContent).toBe('Muted');
    row(h, 'r1').dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })
    );
    entry(h, 'Unmute channel').click();
    expect(row(h, 'r1').className).not.toContain('is-muted');
    expect(row(h, 'r1').className).toContain('is-unread');
  });

  it('the channel menu has the same notification settings, and "Nothing" removes the badges for that channel only', async () => {
    const h = await createHarness({ sessions, rooms: rs(), stored: { 'reverie:chatroom': 'r2' } });
    expect(row(h, 'r1').querySelector('.ca-count')).not.toBeNull();
    row(h, 'r1').dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })
    );
    entry(h, 'Notification settings').click();
    entry(h, 'Nothing').click();
    expect(row(h, 'r1').querySelector('.ca-count')).toBeNull();
    expect(row(h, 'r1').className).not.toContain('is-unread');
    // the server's counts are untouched and a reload keeps the choice
    expect(h.app._chatRooms.find((r: { id: string }) => r.id === 'r1').unread).toBe(3);
    const again = await createHarness({
      sessions,
      rooms: rs(),
      stored: { 'reverie:chatroom': 'r2', 'reverie:chat:notify': JSON.stringify({ r1: { level: 'none', until: 0 } }) },
    });
    expect(row(again, 'r1').querySelector('.ca-count')).toBeNull();
  });
});

describe('review fixes for deleting and reporting', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {
      messages: [
        message('m1', 'r1', agent(B, 'bravo'), 'from an agent', 1000),
        message('m2', 'r1', { kind: 'external', provider: 'slack', userId: 'U1', name: 'Eve' }, 'from outside', 1100),
      ],
    }),
  ];
  it("offers Report on an agent's message but not on an external one", async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const labels = (id: string) => {
      (h.document.querySelector(`[data-msg-id="${id}"] [aria-label="More"]`) as HTMLElement).click();
      const out = [...h.document.querySelectorAll('.ca-msg-menu button')].map((b) => b.textContent);
      h.document.querySelector('.ca-msg-menu')?.remove();
      return out;
    };
    expect(labels('m1')).toContain('Report message');
    expect(labels('m2')).not.toContain('Report message');
  });

  it('traps focus and makes the page inert while the channel settings are open, and gives both back', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    (h.document.querySelector('[data-key="edit:r1"]') as HTMLElement).click();
    await settle(60);
    const app = h.document.getElementById('chatApp') as HTMLElement;
    expect((app as unknown as { inert: boolean }).inert).toBe(true);
    h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect((app as unknown as { inert: boolean }).inert).toBe(false);
  });
});

describe('phone: message sheet and member-only terminal access', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {
      messages: [message('m1', 'r1', agent(B, 'bravo'), 'from an agent', 1000)],
    }),
  ];

  it('opens the sheet with quick reactions on right-click, and a reaction posts', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    (h.document.querySelector('[data-msg-id="m1"]') as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })
    );
    const menu = h.document.querySelector('.ca-msg-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect([...menu.querySelectorAll('.ca-menu-row button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'React with \u{1F44D}',
      'React with \u2764\uFE0F',
      'React with \u{1F602}',
      'React with \u{1F389}',
      'React with \u{1F440}',
    ]);
    expect([...menu.querySelectorAll(':scope > button')].map((b) => b.textContent)).toEqual([
      'Add reaction',
      'Reply',
      'Copy text',
      'Select text',
      'Pin message',
      'Delete message',
      'Report message',
    ]);
    (menu.querySelector('.ca-menu-row button') as HTMLElement).click();
    await settle(40);
    expect(
      h.server.calls.some(
        (c: { method: string; path: string }) => c.method === 'POST' && c.path.endsWith('/messages/m1/reactions')
      )
    ).toBe(true);
    expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
  });

  it('a long press opens the same sheet, and moving the finger cancels it', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const el = h.document.querySelector('[data-msg-id="m1"]') as HTMLElement;
    const touch = (type: string, x: number, y: number) => {
      const ev = new h.window.Event(type, { bubbles: true, cancelable: true }) as Event & { touches?: unknown[] };
      ev.touches = [{ clientX: x, clientY: y }];
      el.dispatchEvent(ev);
    };
    touch('touchstart', 20, 20);
    touch('touchmove', 80, 80);
    await settle(520);
    expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
    touch('touchstart', 20, 20);
    await settle(520);
    expect(h.document.querySelector('.ca-msg-menu')).not.toBeNull();
  });

  it('Select text closes the sheet and the next long press leaves the native selection alone', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const el = h.document.querySelector('[data-msg-id="m1"]') as HTMLElement;
    el.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    const select = [...h.document.querySelectorAll('.ca-msg-menu > button')].find((b) => b.textContent === 'Select text') as HTMLElement;
    select.click();
    await settle(40);
    expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
    expect(el.classList.contains('is-selectable')).toBe(true);
    const ev = new h.window.Event('touchstart', { bubbles: true, cancelable: true }) as Event & { touches?: unknown[] };
    ev.touches = [{ clientX: 20, clientY: 20 }];
    el.dispatchEvent(ev);
    await settle(520);
    expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
    h.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
    expect(el.classList.contains('is-selectable')).toBe(false);
  });

  it('an inline code span selects its own text when the clipboard is unavailable', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], { messages: [message('m1', 'r1', agent(B, 'bravo'), 'run `npm test` now', 1000)] })],
    });
    const span = h.document.querySelector('.chatroom-inline-code') as HTMLElement;
    expect(span.textContent).toBe('npm test');
    span.click();
    await settle(40);
    expect(span.classList.contains('is-copy-failed') || span.classList.contains('is-copied')).toBe(true);
    if (span.classList.contains('is-copy-failed')) expect(h.window.getSelection()?.toString()).toBe('npm test');
  });

  it('has no general Debug terminals button on phones', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha')], {})], narrow: true });
    expect(h.document.querySelectorAll('[aria-label="Debug terminals"]')).toHaveLength(0);
    expect(h.document.querySelector('.ca-user [aria-label="Debug terminals"]')).toBeNull();
    expect(h.document.querySelector('.ca-rail [aria-label="Debug terminals"]')).toBeNull();
  });

  it('removes the duplicate footer org shortcut while keeping settings and Company navigation', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    const bar = [...h.document.querySelectorAll('.ca-user > button')].map((b) => b.getAttribute('aria-label'));
    expect(bar).not.toContain('Office settings');
    expect(h.document.querySelectorAll('.ca-user [aria-label="Office settings"]')).toHaveLength(0);
    expect(h.document.querySelectorAll('.ca-rail [aria-label="Office settings"]')).toHaveLength(1);
    expect(h.document.querySelector('.ca-rail [aria-label="Org chart"]')).toBeNull();
    expect(h.document.querySelector('.ca-rail [aria-label="Debug terminals"]')).toBeNull();
    expect(h.document.querySelector('.ca-user-org')).toBeNull();
    expect(h.document.querySelectorAll('.ca-office-nav')).toHaveLength(0);
  });
});

describe('workspace menu and settings', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha')], {
      workspace: 'Acme',
      category: 'Build',
      unread: 2,
      mentions: 0,
      userReadAt: 10,
      messages: [message('m1', 'r1', agent(A, 'alpha'), 'hi', 500)],
    }),
    room('r2', 'Ops', [member(A, 'alpha'), member(B, 'bravo')], { workspace: 'Acme' }),
    room('r3', 'Misc', [member(A, 'alpha')], {}),
  ];
  const entry = (h: Awaited<ReturnType<typeof createHarness>>, text: string) =>
    [...h.document.querySelectorAll('.ca-popmenu button')].find((b) => b.textContent?.startsWith(text)) as HTMLElement;
  const railMenu = (h: Awaited<ReturnType<typeof createHarness>>, key: string) =>
    (h.document.querySelector(`.ca-rail [data-key="ws:${key}"]`) as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })
    );

  it('right-click on a workspace icon opens its menu (not on Home)', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    railMenu(h, 'Acme');
    expect([...h.document.querySelectorAll('.ca-popmenu button')].map((b) => b.textContent)).toEqual([
      'Mark all as read',
      'Mute workspace\u203A',
      'Notification settings\u203A',
      'Hide muted channels',
      'Workspace settings',
      'Create channel',
    ]);
    h.document.querySelector('.ca-popmenu')?.remove();
    railMenu(h, 'home');
    expect(h.document.querySelector('.ca-popmenu')).toBeNull();
  });

  it('a workspace-level choice applies to its channels, and "Hide muted channels" hides the muted ones', async () => {
    const h = await createHarness({ sessions, rooms: rs(), stored: { 'reverie:chatroom': 'r2' } });
    (h.document.querySelector('.ca-rail [data-key="ws:Acme"]') as HTMLElement).click();
    expect(h.document.querySelector('.ca-item[data-key="room:r1"]')!.className).toContain('is-unread');
    railMenu(h, 'Acme');
    entry(h, 'Mute workspace').click();
    ([...h.document.querySelectorAll('.ca-popmenu')].at(-1)!.querySelectorAll('button')[0] as HTMLElement).click();
    expect(h.document.querySelector('.ca-item[data-key="room:r1"]')!.className).toContain('is-muted');
    railMenu(h, 'Acme');
    entry(h, 'Hide muted channels').click();
    expect(h.document.querySelector('.ca-item[data-key="room:r1"]')).toBeNull();
    // the open channel stays, so you are never left looking at nothing
    expect(h.document.querySelector('.ca-item[data-key="room:r2"]')).not.toBeNull();
  });

  it('Workspace settings renames by moving its channels, and keeps icon and colour with the new name', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    railMenu(h, 'Acme');
    entry(h, 'Workspace settings').click();
    const root = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    expect(root.getAttribute('aria-label')).toBe('Workspace settings: Acme');
    expect(root.textContent).toContain('2 channels');
    const [name, icon] = [...root.querySelectorAll('input')] as HTMLInputElement[];
    name.value = 'Acme Labs';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    icon.value = '\u{1F680}';
    icon.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (root.querySelector('[data-hue="160"]') as HTMLElement).click();
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(120);
    const puts = h.server.calls
      .filter((c: { method: string; path: string }) => c.method === 'PUT' && c.path.endsWith('/placement'))
      .map((c: { path: string; body: unknown }) => [c.path, c.body]);
    expect(puts).toEqual([
      ['/api/chatrooms/r1/placement', { workspace: 'Acme Labs', category: 'Build' }],
      ['/api/chatrooms/r2/placement', { workspace: 'Acme Labs', category: '' }],
    ]);
    const meta = JSON.parse(h.window.localStorage.getItem('reverie:chat:wsmeta') || '{}');
    expect(meta['Acme Labs']).toEqual({ icon: '\u{1F680}', hue: 160 });
    expect(meta.Acme).toBeUndefined();
    const btn = h.document.querySelector('.ca-rail [data-key="ws:Acme Labs"]') as HTMLElement;
    expect(btn.textContent).toContain('\u{1F680}');
    expect(btn.classList.contains('has-hue')).toBe(true);
  });

  it('saves the default workspace through the canonical instance name without moving channels', async () => {
    const h = await createHarness({ sessions, rooms: [room('default-room', 'General', [], {}), ...rs()] });
    let displayName = 'Reverie';
    let settings = { displayName, language: 'fr', showCost: true };
    (h.window as any).ReverieI18n = { get displayName() { return displayName; }, configure(options: any) { displayName = options.displayName; } };
    (h.app as any).loadAppSettingsFromStorage = () => settings;
    (h.app as any).saveAppSettingsToStorage = (next: typeof settings) => { settings = next; };
    const api = h.app._chatApi.bind(h.app);
    const writes: any[] = [];
    h.app._chatApi = async (path: string, options: any) => {
      if (path === '/api/settings') { writes.push(options); return { ok: true, data: {} }; }
      return api(path, options);
    };
    h.shell.openWorkspaceSettings('');
    const root = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    expect(root.textContent).not.toContain('Settings, display name');
    const name = root.querySelector('input') as HTMLInputElement;
    expect(name.disabled).toBe(false); name.value = 'Flight Lab';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    ([...root.querySelectorAll('button')].find(button => button.textContent === 'Save changes') as HTMLButtonElement).click();
    await settle(80);
    expect(writes).toEqual([{ method: 'PUT', body: { displayName: 'Flight Lab' } }]);
    expect(settings).toEqual({ displayName: 'Flight Lab', language: 'fr', showCost: true });
    expect(h.shell.defaultWorkspaceName()).toBe('Flight Lab');
    expect(h.document.querySelector('.ca-rail [data-key="ws:"]')?.getAttribute('aria-label')).toContain('Flight Lab');
    expect(h.server.calls.some((call: any) => call.path.endsWith('/placement'))).toBe(false);
    expect(h.server.rooms.find((r: any) => r.id === 'default-room')?.workspace).toBeUndefined();
    h.shell.openWorkspaceSettings('');
    expect((h.document.querySelector('.ca-ws-settings input') as HTMLInputElement).value).toBe('Flight Lab');
  });

  it('keeps a failed default workspace rename unsaved instead of applying a device-only name', async () => {
    const h = await createHarness({ sessions, rooms: [room('default-room', 'General', [], {})] });
    h.app._chatApi = async () => ({ ok: false, error: 'Only the owner may rename the instance' });
    h.shell.openWorkspaceSettings('');
    const root = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    const name = root.querySelector('input') as HTMLInputElement; name.value = 'Flight Lab';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    const save = [...root.querySelectorAll('button')].find(button => button.textContent === 'Save changes') as HTMLButtonElement;
    save.click(); await settle(60);
    expect(h.shell.defaultWorkspaceName()).toBe('Reverie');
    expect((root.querySelector('.ca-savebar') as HTMLElement).hidden).toBe(false);
    expect(root.querySelector('.ca-settings-title')?.textContent).toBe('Reverie');
    expect(save.disabled).toBe(false);
    expect(h.app.toasts.at(-1)?.text).toContain('Only the owner');
  });

  it('refuses a name that is Home, the default workspace or another workspace', async () => {
    const h = await createHarness({
      sessions,
      rooms: [...rs(), room('r4', 'Other', [member(A, 'alpha')], { workspace: 'Zed' })],
    });
    railMenu(h, 'Acme');
    entry(h, 'Workspace settings').click();
    const root = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    const name = root.querySelector('input') as HTMLInputElement;
    name.value = 'zed';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(60);
    expect(h.server.calls.some((c: { method: string }) => c.method === 'PUT')).toBe(false);
    root.remove();
    (h.app as unknown as { _chatApp: { openWorkspaceSettings(k: string): void } })._chatApp.openWorkspaceSettings('');
    expect((h.document.querySelector('.ca-ws-settings input') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('the owner name write-back', () => {
  it('sends the settings as they are now, not as they were when the page started', async () => {
    const start = {
      ownerName: '',
      ownerTitle: 'Owner',
      timeZone: 'UTC',
      nightHour: 1,
      morningHour: 8,
      enabled: false,
      coordinatorEmployeeId: 'c',
    };
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'General', [member(A, 'alpha')], {})],
      company: { employees: [], settings: start },
    });
    await settle(60);
    // someone changes the company settings after the page loaded
    h.server.company = { employees: [], settings: { ...start, nightHour: 3, enabled: true } };
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    (h.document.querySelector('.ca-me-card .ca-profile-actions button') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-profile-edit') as HTMLDialogElement;
    (dlg.querySelector('input') as HTMLInputElement).value = 'Pat';
    (dlg.querySelector('input[type=checkbox]') as HTMLInputElement).checked = true;
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(100);
    const put = h.server.calls.find(
      (c: { method: string; path: string }) => c.method === 'PUT' && c.path === '/api/company/settings'
    );
    expect(put.body).toMatchObject({ ownerName: 'Pat', nightHour: 3, enabled: true });
  });
});

describe('Find or start a conversation', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha')], { category: 'Build' }),
    room('r2', 'Standup', [member(A, 'alpha', { voice: true })], {}),
    room('dm1', '', [member(B, 'bravo')], { kind: 'dm', dm: ['user', B] }),
  ];
  it('groups results under headings, with avatars for people and category hints for channels', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    h.server.agentName = (id: string) => (id === B ? 'bravo' : 'alpha');
    (h.document.querySelector('.ca-find') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-switcher') as HTMLElement;
    expect([...dlg.querySelectorAll('.ca-switcher-head')].map((n) => n.textContent)).toEqual([
      'Channels',
      'Direct messages',
      'Start a conversation',
    ]);
    const items = [...dlg.querySelectorAll('.ca-switcher-item')].map((n) => n.textContent);
    expect(items).toEqual(['#GeneralBuild', 'Standup', 'Bbravo', 'Aalpha']);
    expect(dlg.querySelectorAll('.ca-switcher-item .chatroom-avatar').length).toBe(2);
    // the headings are not options: the cursor still walks the four results
    expect(dlg.querySelectorAll('[role="option"]').length).toBe(4);
  });
});

describe('Close DM', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha')], {}),
    room('dm1', '', [member(A, 'alpha')], {
      kind: 'dm',
      dm: ['user', A],
      lastMessageAt: 100,
      messages: [message('d1', 'dm1', agent(A, 'alpha'), 'hi', 100)],
    }),
    room('dm2', '', [member(B, 'bravo')], {
      kind: 'dm',
      dm: ['user', B],
      lastMessageAt: 90,
      messages: [message('d2', 'dm2', agent(B, 'bravo'), 'yo', 90)],
    }),
  ];
  const dmRows = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-item--dm')].map((n) => n.textContent);
  const stored = (h: Awaited<ReturnType<typeof createHarness>>) =>
    JSON.parse(h.window.localStorage.getItem('reverie:chat:closedDms') || '{}');

  it('the DM menu has Close DM, which hides the row and keeps the conversation', async () => {
    const h = await createHarness({ sessions, rooms: rs(), stored: { 'reverie:chatroom': 'r1' } });
    h.shell.selectWorkspace('home');
    expect(dmRows(h).length).toBe(2);
    (h.document.querySelector('[data-key="room:dm2"]') as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
    const labels = [...h.document.querySelectorAll('.ca-popmenu button')].map((b) => b.textContent);
    expect(labels).toContain('Close DM');
    (
      [...h.document.querySelectorAll('.ca-popmenu button')].find((b) => b.textContent === 'Close DM') as HTMLElement
    ).click();
    await settle(40);
    expect(dmRows(h).length).toBe(1);
    expect(Object.keys(stored(h))).toEqual(['dm2']);
    // nothing was deleted
    expect(h.server.calls.some((c: { method: string }) => c.method === 'DELETE')).toBe(false);
    expect(h.app._chatRooms.some((r: { id: string }) => r.id === 'dm2')).toBe(true);
  });

  it('the hover x closes it too, and closing the open DM moves you to another conversation', async () => {
    const h = await createHarness({ sessions, rooms: rs(), stored: { 'reverie:chatroom': 'dm1' } });
    h.shell.selectWorkspace('home');
    expect(h.document.querySelector('.ca-head-name')?.textContent).toBe('alpha');
    (h.document.querySelector('[data-key="close:dm1"]') as HTMLElement).click();
    await settle(80);
    expect(dmRows(h).length).toBe(1);
    expect(h.document.querySelector('.ca-head-name')?.textContent).not.toBe('alpha');
  });

  it('opening it from the switcher, or a new message from the agent, brings it back', async () => {
    const h = await createHarness({
      sessions,
      rooms: rs(),
      stored: {
        'reverie:chatroom': 'r1',
        'reverie:chat:closedDms': JSON.stringify({ dm2: Date.now(), dm1: Date.now() }),
      },
    });
    h.shell.selectWorkspace('home');
    expect(dmRows(h).length).toBe(0);
    h.app._onChatroomMessage({
      roomId: 'dm1',
      message: message('d9', 'dm1', agent(A, 'alpha'), 'back', Date.now() + 5),
    });
    expect(dmRows(h).length).toBe(1);
    expect(Object.keys(stored(h))).toEqual(['dm2']);
    (h.document.querySelector('.ca-find') as HTMLElement).click();
    const item = [...h.document.querySelectorAll('.ca-switcher-item')].find((n) =>
      n.textContent?.includes('bravo')
    ) as HTMLElement;
    item.click();
    await settle(80);
    expect(dmRows(h).length).toBe(2);
    expect(stored(h)).toEqual({});
  });
});

describe('Admin, not coordinator, in what the page shows', () => {
  const rs = () => [room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {})];
  it('the member list, its card, the menus, the create dialog and the settings say Admin', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    const seen = () =>
      [
        h.document.querySelector('.ca-root'),
        h.document.querySelector('.ca-popmenu'),
        h.document.querySelector('.ca-profile'),
        h.document.querySelector('.ca-create'),
        h.document.querySelector('.ca-settings'),
      ]
        .filter(Boolean)
        .map(
          (n) =>
            `${(n as HTMLElement).textContent} ${[...(n as HTMLElement).querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' ')}`
        )
        .join(' ');
    expect(seen()).not.toMatch(/coordinator/i);
    expect(h.document.querySelector('.ca-members')?.textContent).toContain('Admin');
    (h.document.querySelector('.ca-member') as HTMLElement).click();
    expect(seen()).not.toMatch(/coordinator/i);
    h.document.querySelector('.ca-profile')?.remove();
    (h.document.querySelector('.ca-side-name-btn') as HTMLElement).click();
    [...h.document.querySelectorAll('.ca-popmenu button')]
      .find((b) => b.textContent === 'Create channel')!
      .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    expect(seen()).not.toMatch(/coordinator/i);
    expect(h.document.querySelector('.ca-create')?.textContent).toContain('No admin (I direct them)');
  });
});

describe('one profile icon across channels and workspaces', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { icon: '\u{1F642}' })], {
      messages: [message('m1', 'r1', agent(A, 'alpha'), 'hi', 1000)],
    }),
    room('r2', 'Ops', [member(A, 'alpha', { icon: '\u{1F600}' })], {
      workspace: 'Acme',
      messages: [message('m2', 'r2', agent(A, 'alpha'), 'yo', 1100)],
    }),
  ];
  const glyphs = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-msg .chatroom-avatar-glyph, .ca-member .chatroom-avatar-glyph')].map(
      (n) => n.textContent
    );

  it('shows the icon the agent chose for itself instead of the per-room one, everywhere it appears', async () => {
    const company = {
      employees: [],
      temporaryAgents: [{ sessionId: A, name: 'alpha', icon: '\u{1F989}' }],
      settings: {},
    };
    const h = await createHarness({ sessions, rooms: rs(), company });
    await settle(80);
    expect(glyphs(h)).toEqual(['\u{1F989}', '\u{1F989}']);
    await h.shell.selectRoom('r2');
    await settle(40);
    expect(glyphs(h)).toEqual(['\u{1F989}', '\u{1F989}']);
  });

  it('falls back to the room icon for an agent with no profile icon, and follows a later change', async () => {
    const h = await createHarness({ sessions, rooms: rs(), company: { employees: [], settings: {} } });
    await settle(80);
    expect(glyphs(h)).toEqual(['\u{1F642}', '\u{1F642}']);
    h.server.company = { employees: [{ id: 'e', name: 'alpha', sessionId: A, icon: '\u{1F985}' }], settings: {} };
    h.shell.handleChanged({ action: 'updated', roomId: 'r1' });
    await settle(500);
    expect(glyphs(h)).toEqual(['\u{1F985}', '\u{1F985}']);
  });
});

describe('picture icons', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { icon: '\u{1F642}' })], {
      workspace: 'Acme',
      messages: [message('m1', 'r1', agent(A, 'alpha'), 'hi', 1000), message('m2', 'r1', user, 'me', 1100)],
    }),
  ];

  it('an agent whose icon is an image shows the picture everywhere, and an unsafe one shows the letter', async () => {
    const company = {
      employees: [],
      temporaryAgents: [{ sessionId: A, name: 'alpha', icon: 'img:/api/v1/avatars/a1' }],
      settings: {},
    };
    const h = await createHarness({ sessions, rooms: rs(), company });
    await settle(80);
    const imgs = [
      ...h.document.querySelectorAll('.ca-msg .chatroom-avatar-img, .ca-member .chatroom-avatar-img'),
    ] as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/v1/avatars/a1', '/api/v1/avatars/a1']);
    h.server.company = {
      employees: [{ id: 'e', name: 'alpha', sessionId: A, icon: 'http://evil/x.png' }],
      settings: {},
    };
    h.shell.handleChanged({ action: 'updated', roomId: 'r1' });
    await settle(500);
    expect(h.document.querySelector('.ca-msg .chatroom-avatar-img')).toBeNull();
    // the unsafe profile icon is ignored, so the room's own icon is what shows
    expect(h.document.querySelector('.ca-msg .chatroom-avatar-glyph')?.textContent).toBe('\u{1F642}');
  });

  it('you can choose a picture for your own profile, and it shows on your messages and bar', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    h.shell.imageToIcon = async () => PNG;
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    (h.document.querySelector('.ca-me-card .ca-profile-actions button') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-profile-edit') as HTMLDialogElement;
    const file = dlg.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(file, 'files', { value: [new h.window.File(['x'], 'a.png', { type: 'image/png' })] });
    file.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(30);
    expect(dlg.querySelector('.ca-picture-preview img')?.getAttribute('src')).toBe(PNG);
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(30);
    // the picture went to the server (so everyone sees it) and this browser keeps no copy
    expect(h.server.ownerAvatarCalls).toEqual([{ kind: 'put', type: 'image/png', size: expect.any(Number) }]);
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:profile') || '{}').image || '').toBe('');
    expect(h.document.querySelector('.ca-user .chatroom-avatar-img')?.getAttribute('src')).toMatch(
      /^\/api\/owner-avatar\/9{32}\?v=\d+$/
    );
  });

  it('a workspace can have its own icon picture, shown in the rail, and Remove brings the letter back', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    h.shell.imageToIcon = async () => PNG;
    (h.document.querySelector('.ca-rail [data-key="ws:Acme"]') as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
    (
      [...h.document.querySelectorAll('.ca-popmenu button')].find(
        (b) => b.textContent === 'Workspace settings'
      ) as HTMLElement
    ).click();
    const root = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    const file = root.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(file, 'files', { value: [new h.window.File(['x'], 'a.png', { type: 'image/png' })] });
    file.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(30);
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(60);
    // the picture went to the server (not this browser) and the rail draws the server's link
    expect(h.server.wsIconCalls).toEqual([{ kind: 'put', name: 'Acme', type: 'image/png', size: expect.any(Number) }]);
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:wsmeta') || '{}').Acme?.image).toBeUndefined();
    expect(h.document.querySelector('.ca-rail [data-key="ws:Acme"] img.ca-rail-img')?.getAttribute('src')).toMatch(
      /^\/api\/workspace-icons\/a{32}\?v=\d+$/
    );
    ([...root.querySelectorAll('.ca-picture button')].find((b) => b.textContent === 'Remove') as HTMLElement).click();
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(60);
    expect(h.server.wsIconCalls.at(-1)).toEqual({ kind: 'delete', name: 'Acme' });
    expect(h.document.querySelector('.ca-rail [data-key="ws:Acme"] img')).toBeNull();
    expect(h.document.querySelector('.ca-rail [data-key="ws:Acme"] .ca-rail-letter')?.textContent).toBe('A');
  });

  it('refuses a file that is not a picture, and tells you', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    (h.document.querySelector('.ca-me-card .ca-profile-actions button') as HTMLElement).click();
    const dlg = h.document.querySelector('.ca-profile-edit') as HTMLDialogElement;
    const file = dlg.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(file, 'files', {
      value: [new h.window.File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })],
    });
    file.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(30);
    expect(dlg.querySelector('.ca-picture [role=status]:not([hidden])')?.textContent).toMatch(/png, jpeg, webp or gif/);
    expect(dlg.querySelector('.ca-picture-preview img')).toBeNull();
  });
});

describe('server-stored agent avatars', () => {
  const rs = () => [
    room('r1', 'General', [member(A, 'alpha', { icon: '\u{1F642}', avatar: '/api/avatars/' + A + '?v=1' })], {
      messages: [message('m1', 'r1', agent(A, 'alpha'), 'hi', 1000)],
    }),
  ];
  const srcs = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-msg .chatroom-avatar-img, .ca-member .chatroom-avatar-img')].map((i) =>
      i.getAttribute('src')
    );
  it("shows the room membership's avatar, the company record's newer one over it, and the emoji when there is none", async () => {
    const h = await createHarness({ sessions, rooms: rs(), company: { employees: [], settings: {} } });
    await settle(80);
    expect(srcs(h)).toEqual([`/api/avatars/${A}?v=1`, `/api/avatars/${A}?v=1`]);
    h.server.company = {
      employees: [{ id: 'e', name: 'alpha', sessionId: A, avatar: `/api/avatars/${A}?v=2` }],
      settings: {},
    };
    h.shell.handleChanged({ action: 'updated', roomId: 'r1' });
    await settle(500);
    expect(srcs(h)).toEqual([`/api/avatars/${A}?v=2`, `/api/avatars/${A}?v=2`]);
    const bare = await createHarness({
      sessions,
      rooms: [
        room('r1', 'General', [member(A, 'alpha', { icon: '\u{1F642}', avatar: 'http://evil/x.png' })], {
          messages: [message('m1', 'r1', agent(A, 'alpha'), 'hi', 1000)],
        }),
      ],
    });
    await settle(60);
    expect(bare.document.querySelector('.ca-msg .chatroom-avatar-img')).toBeNull();
    expect(bare.document.querySelector('.ca-msg .chatroom-avatar-glyph')?.textContent).toBe('\u{1F642}');
  });
});

describe('review leftovers: rename keeps notifications, car mode opens the right channel', () => {
  it('renaming a workspace moves its notification choice with it', async () => {
    const rooms = [room('r1', 'General', [member(A, 'alpha')], { workspace: 'Acme' })];
    const h = await createHarness({
      sessions,
      rooms,
      stored: { 'reverie:chat:notify': JSON.stringify({ 'ws:Acme': { level: 'mentions', until: 0 } }) },
    });
    (h.document.querySelector('.ca-rail [data-key="ws:Acme"]') as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
    (
      [...h.document.querySelectorAll('.ca-popmenu button')].find(
        (b) => b.textContent === 'Workspace settings'
      ) as HTMLElement
    ).click();
    const root = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    const name = root.querySelector('input') as HTMLInputElement;
    name.value = 'Acme Labs';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(120);
    const notify = JSON.parse(h.window.localStorage.getItem('reverie:chat:notify') || '{}');
    expect(notify['ws:Acme Labs']).toEqual({ level: 'mentions', until: 0 });
    expect(notify['ws:Acme']).toBeUndefined();
  });

  it("Car mode from another voice channel's menu opens that channel first", async () => {
    const rooms = [
      room('r1', 'General', [member(A, 'alpha')], {}),
      room('r2', 'Standup', [member(A, 'alpha', { voice: true })], {}),
    ];
    const h = await createHarness({ sessions, rooms, stored: { 'reverie:chatroom': 'r1' } });
    let openedIn = '';
    h.app.openCarMode = () => {
      openedIn = h.shell.roomId;
    };
    (h.document.querySelector('[data-key="room:r2"]') as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
    (
      [...h.document.querySelectorAll('.ca-popmenu button')].find((b) => b.textContent === 'Car mode') as HTMLElement
    ).click();
    await settle(120);
    expect(openedIn).toBe('r2');
  });

  it('the workspace settings keep Tab inside', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'General', [member(A, 'alpha')], { workspace: 'Acme' })],
    });
    h.shell.openWorkspaceSettings('Acme');
    const root = h.document.querySelector('.ca-ws-settings') as HTMLElement;
    const last = [...root.querySelectorAll('button:not(:disabled), input, textarea, select')]
      .filter((x) => !x.closest('[hidden]'))
      .at(-1) as HTMLElement;
    last.focus();
    const ev = new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('CPU / memory / GPU readout', () => {
  const rs = () => [room('r1', 'General', [member(A, 'alpha')], {})];
  it('shows machine load once, in the sidebar, and the GPU only when the host publishes a fresh reading', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    await settle(120);
    const text = (sel: string) =>
      [...h.document.querySelectorAll(`${sel} .ca-stat`)].map((n) => n.getAttribute('aria-label'));
    expect(text('.ca-stats')).toEqual(['CPU load 12%', 'Memory 28% (17.3 GB of 62.7 GB)']);
    // one place is enough: nothing in the channel header
    expect(h.document.querySelector('.ca-head-stats')).toBeNull();
    expect(h.document.querySelectorAll('.ca-stats')).toHaveLength(1);
    h.server.gpu = { available: true, utilization: 63, memoryUsedMb: 4096, memoryTotalMb: 24576 };
    h.server.sysStats = { cpu: 93, memory: { usedMB: 1, totalMB: 2, percent: 50 } };
    h.shell.startStats();
    await settle(120);
    expect(text('.ca-stats')).toEqual([
      'CPU load 93%',
      'Memory 50% (0.0 GB of 0.0 GB)',
      'GPU 63%, memory 4.0 GB of 24.0 GB',
    ]);
    expect(h.document.querySelector('.ca-stats .ca-stat.is-high')?.getAttribute('aria-label')).toBe('CPU load 93%');
    // a host reading that goes stale (the route says so) hides the GPU chip again, and /api/plans is not polled for it
    h.server.gpu = { available: false, utilization: null, memoryUsedMb: null, memoryTotalMb: null };
    h.shell.startStats();
    await settle(120);
    expect(text('.ca-stats')).toEqual(['CPU load 93%', 'Memory 50% (0.0 GB of 0.0 GB)']);
    expect(h.server.calls.some((c: { path: string }) => c.path === '/api/plans')).toBe(false);
    h.shell.stopStats();
  });

  it('hides the readout when the server cannot say, and polls again every few seconds', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    h.shell.stopStats();
    h.server.handle = async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'x' }) });
    h.shell.stats = {};
    h.shell.renderStats();
    expect((h.document.querySelector('.ca-stats') as HTMLElement).hidden).toBe(true);
    expect(h.shell._statsTimer).toBe(0);
  });
});

describe('polls', () => {
  const poll = (extra: Record<string, unknown> = {}) => ({
    question: 'Ship it?',
    options: [
      { id: 'o1', label: 'Approve' },
      { id: 'o2', label: 'Reject <b>x</b>' },
      { id: 'o3', label: 'Later' },
    ],
    recommended: 'o1',
    votes: { [A]: ['o1'] },
    ...extra,
  });
  const rs = (p: unknown) => [
    room('r1', 'General', [member(A, 'alpha')], {
      messages: [message('p1', 'r1', agent(A, 'alpha'), 'Ship it?', 2000, { poll: p })],
    }),
  ];
  const opts = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-poll-opt')] as HTMLButtonElement[];

  it('draws the card: the question, a radio button per option with its count, the recommendation tag, and no HTML from a label', async () => {
    const h = await createHarness({ sessions, rooms: rs(poll()) });
    await settle(120);
    const card = h.document.querySelector('.ca-poll')!;
    expect(card.getAttribute('aria-label')).toBe('Poll: Ship it?');
    expect(card.querySelector('.ca-poll-q')!.textContent).toBe('Ship it?');
    expect(opts(h).map((b) => b.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
    expect(labels(opts(h))).toEqual([
      'Approve, recommended, 1 vote, 100 percent',
      'Reject <b>x</b>, 0 votes, 0 percent',
      'Later, 0 votes, 0 percent',
    ]);
    expect(card.querySelector('.ca-poll-rec')!.textContent).toBe('rec');
    expect(card.querySelector('b')).toBeNull();
    expect(card.querySelector('.ca-poll-voters')!.textContent).toBe('alpha');
    expect(card.querySelector('.ca-poll-total')!.textContent).toBe('1 vote');
    // the question is drawn once, inside the card, not again as a plain message
    expect(h.document.querySelector('.chatroom-feed')!.textContent!.match(/Ship it\?/g)).toHaveLength(1);
  });

  it('a tap votes, marks your choice, moves it on a second tap, and withdraws it on the same option', async () => {
    const h = await createHarness({ sessions, rooms: rs(poll()) });
    await settle(120);
    opts(h)[1].click();
    await settle(60);
    expect(h.server.pollCalls).toEqual([{ kind: 'vote', id: 'p1', body: { options: ['o2'] } }]);
    expect(opts(h).map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(opts(h)[1].classList.contains('is-mine')).toBe(true);
    expect(h.document.querySelector('.ca-poll-total')!.textContent).toBe('2 votes');
    opts(h)[2].click();
    await settle(60);
    expect(h.server.pollCalls.at(-1).body).toEqual({ options: ['o3'] });
    opts(h)[2].click();
    await settle(60);
    expect(h.server.pollCalls.at(-1).body).toEqual({ options: [] });
    expect(opts(h).map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
  });

  it('a multiple-choice poll uses checkboxes and sends the whole set', async () => {
    const h = await createHarness({ sessions, rooms: rs(poll({ multi: true, votes: {} })) });
    await settle(120);
    expect(opts(h).map((b) => b.getAttribute('role'))).toEqual(['checkbox', 'checkbox', 'checkbox']);
    opts(h)[0].click();
    await settle(60);
    opts(h)[2].click();
    await settle(60);
    expect(h.server.pollCalls.at(-1).body).toEqual({ options: ['o1', 'o3'] });
    expect(opts(h).map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
  });

  it('picking an option leaves the feed where it was scrolled', async () => {
    const h = await createHarness({ sessions, rooms: rs(poll({ multi: true, votes: {} })) });
    await settle(120);
    const card = h.document.querySelector('.ca-poll') as HTMLElement;
    const feed = card.closest('.chatroom-feed') as HTMLElement;
    let top = 120;
    Object.defineProperty(feed, 'scrollTop', { get: () => top, set: (v) => { top = v; }, configurable: true });
    // A browser may jump to the bottom when the card is swapped; the page must put the feed back.
    const swap = card.replaceWith.bind(card);
    card.replaceWith = (...nodes: (string | Node)[]) => { swap(...nodes); top = 5000; };
    opts(h)[0].click();
    await settle(60);
    expect(h.server.pollCalls.at(-1).body).toEqual({ options: ['o1'] });
    expect(top).toBe(120);
  });

  it('a vote\'s room event redraws the feed without moving the reader', async () => {
    const h = await createHarness({ sessions, rooms: rs(poll({ multi: true, votes: {} })) });
    await settle(120);
    const feed = h.document.querySelector('.chatroom-feed') as HTMLElement;
    let top = 120;
    Object.defineProperty(feed, 'scrollTop', { get: () => top, set: (v) => { top = v; }, configurable: true });
    Object.defineProperty(feed, 'scrollHeight', { get: () => 5000, configurable: true });
    h.shell.handleChanged({ roomId: 'r1', action: 'status' });
    await settle(1200);
    expect(top).toBe(120);
    // opening a room still lands on the newest message
    h.shell.renderFeed();
    expect(top).toBe(5000);
    // a reader sitting at the bottom keeps following: the redraw leaves them at the newest message
    top = 4980;
    h.shell.renderFeed({ keepScroll: true });
    expect(top).toBe(5000);
  });

  it('says whether one or several can be picked, with a square box for several and a round dot for one, and keeps earlier picks drawn', async () => {
    const multi = await createHarness({ sessions, rooms: rs(poll({ multi: true, votes: {} })) });
    await settle(120);
    expect(multi.document.querySelector('.ca-poll-hint')!.textContent).toBe('Pick as many as you like');
    const marks = () => [...multi.document.querySelectorAll('.ca-poll-mark')] as HTMLElement[];
    expect(marks().every((m) => m.classList.contains('is-box'))).toBe(true);
    opts(multi)[0].click();
    await settle(60);
    opts(multi)[1].click();
    await settle(60);
    expect(marks().map((m) => m.textContent)).toEqual(['\u2713', '\u2713', '']);
    expect(multi.document.querySelector('.ca-poll-hint')!.textContent).toBe('Pick as many as you like');
    const single = await createHarness({ sessions, rooms: rs(poll()) });
    await settle(120);
    expect(single.document.querySelector('.ca-poll-hint')!.textContent).toBe('Pick one');
    expect([...single.document.querySelectorAll('.ca-poll-mark')].every((m) => m.classList.contains('is-dot'))).toBe(true);
    const closed = await createHarness({ sessions, rooms: rs(poll({ multi: true, closed: { at: 1, by: 'user' } })) });
    await settle(120);
    expect(closed.document.querySelector('.ca-poll-hint')).toBeNull();
  });

  it('is keyboard-operable: every option is a button in the tab order', async () => {
    const h = await createHarness({ sessions, rooms: rs(poll()) });
    await settle(120);
    for (const b of opts(h)) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.tabIndex).toBe(0);
    }
    expect(h.document.querySelector('.ca-poll-options')!.getAttribute('role')).toBe('radiogroup');
  });

  it('a closed poll cannot be voted on and shows its result; closing asks first and then closes', async () => {
    const closed = await createHarness({ sessions, rooms: rs(poll({ closed: { at: 1, by: 'user' } })) });
    await settle(120);
    expect(opts(closed).every((b) => b.disabled)).toBe(true);
    expect(closed.document.querySelector('.ca-poll-status')!.textContent).toBe('Closed');
    expect(closed.document.querySelector('.ca-poll-close')).toBeNull();
    expect(closed.document.querySelector('.is-winner')?.textContent).toContain('Approve');

    const h = await createHarness({ sessions, rooms: rs(poll()) });
    await settle(120);
    h.window.confirm = () => false;
    (h.document.querySelector('.ca-poll-close') as HTMLButtonElement).click();
    await settle(60);
    expect(h.server.pollCalls).toBeUndefined();
    h.window.confirm = () => true;
    (h.document.querySelector('.ca-poll-close') as HTMLButtonElement).click();
    await settle(60);
    expect(h.server.pollCalls).toEqual([{ kind: 'close', id: 'p1', body: {} }]);
    expect(opts(h).every((b) => b.disabled)).toBe(true);
  });

  it('shows the server’s refusal and leaves the card as it was', async () => {
    const h = await createHarness({ sessions, rooms: rs(poll()) });
    await settle(120);
    h.server.pollError = 'This poll is closed';
    opts(h)[1].click();
    await settle(60);
    expect(opts(h).map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    expect(h.app.toasts.at(-1).text).toContain('This poll is closed');
  });
});

describe('the "+" menu and Create Poll', () => {
  const rs = () => [room('r1', 'General', [member(A, 'alpha')], { messages: [] })];
  const plus = (h: Awaited<ReturnType<typeof createHarness>>) =>
    h.document.querySelector('.chatroom-composer-row .ca-plus, .ca-plus') as HTMLButtonElement;
  const menuItems = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-plus-menu button')] as HTMLButtonElement[];
  const text = (b: Element) => b.querySelector('.ca-menu-label')!.textContent;

  it('opens Discord’s menu: Upload a File and Create Poll work, Create Thread and Use Apps are listed but off', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    await settle(120);
    expect(plus(h).getAttribute('aria-haspopup')).toBe('menu');
    plus(h).click();
    const items = menuItems(h);
    expect(items.map(text)).toEqual(['Upload a File', 'Create Thread', 'Create Poll', 'Use Apps']);
    expect(items.map((b) => b.disabled)).toEqual([false, true, false, true]);
    expect(h.document.querySelector('.ca-plus-menu')!.getAttribute('role')).toBe('menu');
    // Upload a File opens the file chooser the paperclip used to open
    const picker = h.document.querySelector('.chatroom-composer input[type="file"]') as HTMLInputElement;
    let chosen = 0;
    picker.click = () => void (chosen += 1);
    items[0].click();
    expect(chosen).toBe(1);
    expect(h.document.querySelector('.ca-plus-menu')).toBeNull();
  });

  it('Create Poll: needs a question and two different options, adds and removes options, and posts the poll', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    await settle(120);
    plus(h).click();
    menuItems(h)[2].click();
    const dlg = h.document.querySelector('.ca-poll-dialog') as HTMLElement;
    expect(dlg).not.toBeNull();
    const inputs = () => [...dlg.querySelectorAll('.ca-poll-form-row input')] as HTMLInputElement[];
    const submit = () =>
      (dlg.querySelector('form') as HTMLFormElement).dispatchEvent(
        new h.window.Event('submit', { cancelable: true, bubbles: true })
      );
    const err = () => dlg.querySelector('.ca-form-error')!.textContent;
    expect(inputs()).toHaveLength(2);
    expect((dlg.querySelector('select.ca-poll-duration') as HTMLSelectElement).value).toBe('24');

    const q = dlg.querySelector('input.ca-field') as HTMLInputElement;
    submit();
    await settle(20);
    expect(err()).toBe('Write a question.');
    q.value = 'Lunch?';
    inputs()[0].value = 'Pizza';
    submit();
    await settle(20);
    expect(err()).toBe('Give at least two options.');
    inputs()[1].value = 'pizza';
    submit();
    await settle(20);
    expect(err()).toBe('Two options are the same.');
    expect(h.server.pollCreates).toBeUndefined();

    // Enter on the last option adds another (and does not submit); the remove button drops one
    inputs()[1].value = 'Tacos';
    inputs()[1].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(inputs()).toHaveLength(3);
    expect(h.server.pollCreates).toBeUndefined();
    inputs()[2].value = 'Salad';
    (dlg.querySelectorAll('.ca-poll-remove')[1] as HTMLButtonElement).click();
    expect(inputs().map((i) => i.value)).toEqual(['Pizza', 'Salad']);
    (dlg.querySelector('.ca-poll-multi input') as HTMLInputElement).checked = true;
    (dlg.querySelector('select.ca-poll-duration') as HTMLSelectElement).value = '1';
    const before = Date.now();
    submit();
    await settle(60);
    const sent = h.server.pollCreates[0];
    expect(sent).toMatchObject({ question: 'Lunch?', options: ['Pizza', 'Salad'], multi: true });
    expect(sent.closesAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(sent.closesAt).toBeLessThan(Date.now() + 3_600_001);
    expect(h.document.querySelector('.ca-poll-dialog')).toBeNull();
  });

  it('an optional recommendation picks one of the typed options, follows edits and removal, and shows as the rec tag', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    await settle(120);
    plus(h).click();
    menuItems(h)[2].click();
    const dlg = h.document.querySelector('.ca-poll-dialog') as HTMLElement;
    const inputs = () => [...dlg.querySelectorAll('.ca-poll-form-row input')] as HTMLInputElement[];
    const rec = dlg.querySelector('.ca-poll-rec-pick select') as HTMLSelectElement;
    const choices = () => [...rec.options].map((o) => o.value);
    expect(choices()).toEqual(['']);
    const type = (i: number, v: string) => {
      inputs()[i].value = v;
      inputs()[i].dispatchEvent(new h.window.Event('input', { bubbles: true }));
    };
    type(0, 'Yes');
    type(1, 'No');
    expect(choices()).toEqual(['', 'Yes', 'No']);
    rec.value = 'No';
    // renaming the recommended option drops the choice rather than pointing at a stale label
    type(1, 'Nope');
    expect(rec.value).toBe('');
    rec.value = 'Yes';
    type(1, 'No');
    expect(rec.value).toBe('Yes');
    (dlg.querySelector('input.ca-field') as HTMLInputElement).value = 'Ship?';
    (dlg.querySelector('form') as HTMLFormElement).dispatchEvent(
      new h.window.Event('submit', { cancelable: true, bubbles: true })
    );
    await settle(60);
    expect(h.server.pollCreates[0]).toMatchObject({ question: 'Ship?', options: ['Yes', 'No'], recommended: 'Yes' });
    h.shell.renderFeed();
    await h.shell.app._loadChatRoom('r1', { quiet: true });
    h.shell.renderFeed();
    expect(h.document.querySelector('.ca-poll .ca-poll-rec')!.textContent).toBe('rec');
  });

  it('No limit sends no closing time, and a refusal stays in the dialog', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    await settle(120);
    plus(h).click();
    menuItems(h)[2].click();
    const dlg = h.document.querySelector('.ca-poll-dialog') as HTMLElement;
    const inputs = [...dlg.querySelectorAll('.ca-poll-form-row input')] as HTMLInputElement[];
    (dlg.querySelector('input.ca-field') as HTMLInputElement).value = 'Ok?';
    inputs[0].value = 'Yes';
    inputs[1].value = 'No';
    (dlg.querySelector('select.ca-poll-duration') as HTMLSelectElement).value = '0';
    h.server.pollCreateError = 'The question is at most 300 characters';
    (dlg.querySelector('form') as HTMLFormElement).dispatchEvent(
      new h.window.Event('submit', { cancelable: true, bubbles: true })
    );
    await settle(60);
    expect(h.server.pollCreates[0]).toEqual({ question: 'Ok?', options: ['Yes', 'No'] });
    expect(dlg.isConnected).toBe(true);
    expect(dlg.querySelector('.ca-form-error')!.textContent).toBe('The question is at most 300 characters');
  });

  it('the new poll appears in the feed as a card and can be voted on', async () => {
    const h = await createHarness({ sessions, rooms: rs() });
    await settle(120);
    plus(h).click();
    menuItems(h)[2].click();
    const dlg = h.document.querySelector('.ca-poll-dialog') as HTMLElement;
    const inputs = [...dlg.querySelectorAll('.ca-poll-form-row input')] as HTMLInputElement[];
    (dlg.querySelector('input.ca-field') as HTMLInputElement).value = 'Ship?';
    inputs[0].value = 'Yes';
    inputs[1].value = 'No';
    (dlg.querySelector('form') as HTMLFormElement).dispatchEvent(
      new h.window.Event('submit', { cancelable: true, bubbles: true })
    );
    await settle(200);
    h.shell.handleMessage?.({ roomId: 'r1', message: h.server.rooms?.[0]?.messages?.at(-1) });
    await h.shell.app._loadChatRoom('r1', { quiet: true });
    h.shell.renderFeed();
    expect(h.document.querySelector('.ca-poll .ca-poll-q')!.textContent).toBe('Ship?');
  });
});

describe('workspace pictures on the server', () => {
  const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';
  const wsRooms = () => [room('r1', 'General', [member(A, 'alpha')], { workspace: 'Acme' })];
  const railImg = (h: Awaited<ReturnType<typeof createHarness>>, name: string) =>
    h.document.querySelector(`.ca-rail [data-key="ws:${name}"] img`) as HTMLImageElement | null;
  const openSettings = (h: Awaited<ReturnType<typeof createHarness>>, name: string) => {
    (h.document.querySelector(`.ca-rail [data-key="ws:${name}"]`) as HTMLElement).dispatchEvent(
      new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
    (
      [...h.document.querySelectorAll('.ca-popmenu button')].find(
        (b) => b.textContent === 'Workspace settings'
      ) as HTMLElement
    ).click();
    return h.document.querySelector('.ca-ws-settings') as HTMLElement;
  };

  it('draws the server\u2019s picture on the rail, whatever this browser holds, and ignores a link that is not a workspace picture', async () => {
    const url = `/api/workspace-icons/${'b'.repeat(32)}?v=7`;
    const h = await createHarness({
      sessions,
      rooms: wsRooms(),
      stored: { 'reverie:chat:wsmeta': JSON.stringify({ Acme: { image: PIXEL, hue: 120 } }) },
    });
    h.server.wsIcons = { Acme: url };
    await h.shell.loadOwner();
    await settle(60);
    expect(railImg(h, 'Acme')?.getAttribute('src')).toBe(url);
    h.server.wsIcons = { Acme: 'http://evil/x.png' };
    await h.shell.loadOwner();
    await settle(60);
    // the server's bad link is dropped; the browser's own picture shows again
    expect(railImg(h, 'Acme')?.getAttribute('src')).toBe(PIXEL);
  });

  it('saving a chosen picture sends the bytes to the server, drops the browser copy, and shows the server\u2019s', async () => {
    const h = await createHarness({ sessions, rooms: wsRooms() });
    await settle(60);
    expect(await h.shell.saveWsPicture('Acme', PIXEL)).toBe(true);
    expect(h.server.wsIconCalls).toEqual([{ kind: 'put', name: 'Acme', type: 'image/png', size: 8 }]);
    expect(h.shell.wsIcons.Acme).toMatch(/^\/api\/workspace-icons\/a{32}\?v=\d+$/);
    expect(await h.shell.saveWsPicture('Acme', '')).toBe(true);
    expect(h.server.wsIconCalls.at(-1)).toEqual({ kind: 'delete', name: 'Acme' });
    expect(h.shell.wsIcons.Acme).toBeUndefined();
    // anything but a small raster data URL is not sent
    expect(await h.shell.saveWsPicture('Acme', 'data:image/svg+xml;base64,PHN2Zy8+')).toBe(false);
    expect(h.server.wsIconCalls).toHaveLength(2);
  });

  it('a server that refuses (not the owner, or too old) leaves the picture in this browser with a note', async () => {
    const h = await createHarness({ sessions, rooms: wsRooms() });
    await settle(60);
    h.server.wsIconRefuse = true;
    expect(await h.shell.saveWsPicture('Acme', PIXEL)).toBe(false);
    // through the settings screen: the browser keeps the picture, and says so
    h.shell.imageToIcon = async () => PIXEL;
    const root = openSettings(h, 'Acme');
    const file = root.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(file, 'files', { value: [new h.window.File(['x'], 'a.png', { type: 'image/png' })] });
    file.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(30);
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(80);
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:wsmeta') || '{}').Acme.image).toBe(PIXEL);
    expect(h.app.toasts.some((t: { text: string }) => t.text.includes('kept on this device only'))).toBe(true);
    expect(railImg(h, 'Acme')?.getAttribute('src')).toBe(PIXEL);
  });

  it('saving the settings with the picture untouched never writes the server link into this browser', async () => {
    const url = `/api/workspace-icons/${'d'.repeat(32)}?v=9`;
    const h = await createHarness({ sessions, rooms: wsRooms() });
    h.server.wsIcons = { Acme: url };
    await h.shell.loadOwner();
    const root = openSettings(h, 'Acme');
    // change something else (the colour) so Save is available
    (root.querySelector('.ca-swatches button:not(.is-none)') as HTMLElement).click();
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(120);
    const stored = JSON.parse(h.window.localStorage.getItem('reverie:chat:wsmeta') || '{}');
    expect(stored.Acme?.image).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('workspace-icons');
    expect(h.server.wsIconCalls ?? []).toEqual([]);
    expect(railImg(h, 'Acme')?.getAttribute('src')).toBe(url);
  });

  it('a rename the server refuses says so', async () => {
    const url = `/api/workspace-icons/${'e'.repeat(32)}?v=4`;
    const h = await createHarness({ sessions, rooms: wsRooms() });
    h.server.wsIcons = { Acme: url };
    await h.shell.loadOwner();
    h.server.wsIconRenameRefuse = true;
    const root = openSettings(h, 'Acme');
    const name = root.querySelector('input') as HTMLInputElement;
    name.value = 'Acme Labs';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(200);
    expect(h.app.toasts.some((t: { text: string }) => t.text.includes('its picture could not be moved'))).toBe(true);
  });

  it('a removal the server refuses is reported as that, and the server\u2019s picture keeps showing', async () => {
    const url = `/api/workspace-icons/${'e'.repeat(32)}?v=4`;
    const h = await createHarness({ sessions, rooms: wsRooms() });
    h.server.wsIcons = { Acme: url };
    await h.shell.loadOwner();
    h.server.wsIconRefuse = true;
    const root = openSettings(h, 'Acme');
    ([...root.querySelectorAll('.ca-picture button')].find((b) => b.textContent === 'Remove') as HTMLElement).click();
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(200);
    expect(h.server.wsIconCalls).toEqual([{ kind: 'delete', name: 'Acme' }]);
    expect(h.app.toasts.some((t: { text: string }) => t.text.includes('could not be removed on the server'))).toBe(
      true
    );
    expect(railImg(h, 'Acme')?.getAttribute('src')).toBe(url);
  });

  it('a picture the server holds under one spelling shows for every spelling in use', async () => {
    const url = `/api/workspace-icons/${'f'.repeat(32)}?v=2`;
    const rooms = [room('r1', 'General', [member(A, 'alpha')], { workspace: 'acme' })];
    const h = await createHarness({ sessions, rooms });
    h.server.wsIcons = { Acme: url };
    await h.shell.loadOwner();
    await settle(60);
    expect(railImg(h, 'acme')?.getAttribute('src')).toBe(url);
  });

  it('renaming a workspace asks the server to move its picture', async () => {
    const h = await createHarness({ sessions, rooms: wsRooms() });
    h.server.wsIcons = { Acme: `/api/workspace-icons/${'c'.repeat(32)}?v=3` };
    await h.shell.loadOwner();
    const root = openSettings(h, 'Acme');
    const name = root.querySelector('input') as HTMLInputElement;
    name.value = 'Acme Labs';
    name.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (
      [...root.querySelectorAll('.ca-savebar button')].find((b) => b.textContent === 'Save changes') as HTMLElement
    ).click();
    await settle(200);
    expect(h.server.wsIconCalls).toContainEqual({ kind: 'rename', from: 'Acme', to: 'Acme Labs' });
    expect(Object.keys(h.shell.wsIcons)).toEqual(['Acme Labs']);
  });
});

describe('reloading profiles after a change elsewhere', () => {
  it('a reload asked for inside the quiet window is not lost: one trailing reload runs when the window ends', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'General', [member(A, 'alpha')], {})] });
    await settle(60);
    let loads = 0;
    h.shell.loadOwner = async () => void (loads += 1);
    h.shell.profileRefreshMs = 120;
    h.shell._profilesAt = 0;
    h.shell.refreshProfiles();
    expect(loads).toBe(1);
    h.shell.refreshProfiles();
    h.shell.refreshProfiles();
    h.shell.refreshProfiles();
    expect(loads).toBe(1);
    await settle(200);
    expect(loads).toBe(2);
    // and nothing keeps firing afterwards
    await settle(200);
    expect(loads).toBe(2);
    // outside the window it is immediate again
    h.shell.refreshProfiles();
    expect(loads).toBe(3);
  });
});

describe('the owner\u2019s picture on the server', () => {
  const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';
  const url = `/api/owner-avatar/${'a'.repeat(32)}?v=5`;
  const mine = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-msg .chatroom-avatar-img, .ca-user .chatroom-avatar-img')].map((i) =>
      i.getAttribute('src')
    );
  const rooms = () => [
    room('r1', 'General', [member(A, 'alpha')], {
      messages: [message('m1', 'r1', { kind: 'user', name: 'user' }, 'hello', 1000)],
    }),
  ];
  const openEditor = (h: Awaited<ReturnType<typeof createHarness>>) => {
    (h.document.querySelector('.ca-user-btn') as HTMLElement).click();
    (h.document.querySelector('.ca-me-card .ca-profile-actions button') as HTMLElement).click();
    return h.document.querySelector('.ca-profile-edit') as HTMLDialogElement;
  };

  it('draws the server\u2019s picture on your messages and your panel, from the company settings, and ignores a link of another shape', async () => {
    const h = await createHarness({
      sessions,
      rooms: rooms(),
      company: { employees: [], settings: { ownerAvatar: url } },
    });
    await settle(120);
    expect(mine(h)).toEqual([url, url]);
    const bad = await createHarness({
      sessions,
      rooms: rooms(),
      company: { employees: [], settings: { ownerAvatar: 'http://evil/x.png' } },
    });
    await settle(120);
    expect(mine(bad)).toEqual([]);
    // the browser's own picture is the fallback when the server has none
    const local = await createHarness({
      sessions,
      rooms: rooms(),
      stored: { 'reverie:chat:profile': JSON.stringify({ image: PIXEL }) },
    });
    await settle(120);
    expect(mine(local)).toEqual([PIXEL, PIXEL]);
  });

  it('saving a chosen picture uploads it, drops the browser copy, and then shows the server\u2019s link', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    h.shell.imageToIcon = async () => PIXEL;
    await settle(60);
    const dlg = openEditor(h);
    const file = dlg.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(file, 'files', { value: [new h.window.File(['x'], 'a.png', { type: 'image/png' })] });
    file.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(30);
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(120);
    expect(h.server.ownerAvatarCalls).toEqual([{ kind: 'put', type: 'image/png', size: 8 }]);
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:profile') || '{}').image || '').toBe('');
    expect(mine(h).every((s) => /^\/api\/owner-avatar\/9{32}\?v=\d+$/.test(s || ''))).toBe(true);
    expect(mine(h).length).toBeGreaterThan(0);
  });

  it('saving the profile without touching the picture sends nothing and keeps no server link locally', async () => {
    const h = await createHarness({
      sessions,
      rooms: rooms(),
      company: { employees: [], settings: { ownerAvatar: url } },
    });
    await settle(120);
    const dlg = openEditor(h);
    const status = dlg.querySelector('input[maxlength="60"]') as HTMLInputElement;
    status.value = 'busy';
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(120);
    expect(h.server.ownerAvatarCalls).toBeUndefined();
    const stored = JSON.parse(h.window.localStorage.getItem('reverie:chat:profile') || '{}');
    expect(stored.status).toBe('busy');
    expect(JSON.stringify(stored)).not.toContain('owner-avatar');
  });

  it('a refusal keeps the picture in this browser with a note; a refused removal says so', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    h.shell.imageToIcon = async () => PIXEL;
    await settle(60);
    h.server.ownerAvatarRefuse = true;
    const dlg = openEditor(h);
    const file = dlg.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(file, 'files', { value: [new h.window.File(['x'], 'a.png', { type: 'image/png' })] });
    file.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(30);
    (dlg.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(120);
    expect(JSON.parse(h.window.localStorage.getItem('reverie:chat:profile') || '{}').image).toBe(PIXEL);
    expect(h.app.toasts.some((t: { text: string }) => t.text.includes('kept on this device only'))).toBe(true);

    const h2 = await createHarness({
      sessions,
      rooms: rooms(),
      company: { employees: [], settings: { ownerAvatar: url } },
    });
    await settle(120);
    h2.server.ownerAvatarRefuse = true;
    const dlg2 = openEditor(h2);
    ([...dlg2.querySelectorAll('.ca-picture button')].find((b) => b.textContent === 'Use initials') as HTMLElement).click();
    (dlg2.querySelector('form') as HTMLFormElement).requestSubmit();
    await settle(120);
    expect(h2.app.toasts.some((t: { text: string }) => t.text.includes('could not be removed on the server'))).toBe(
      true
    );
    expect(mine(h2).every((s) => s === url)).toBe(true);
  });
});

describe('web links in messages', () => {
  const withText = async (text: string) => {
    const h = await createHarness({
      sessions,
      rooms: [
        room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {
          messages: [message('m1', 'r1', agent(A, 'alpha'), text, 1000)],
        }),
      ],
    });
    return h;
  };

  it('makes http and https addresses clickable links that open in a new tab, and leaves the words as written', async () => {
    const h = await withText('see https://example.com/a?b=1, and (http://localhost:3000/x). thanks');
    const links = [...h.document.querySelectorAll('.ca-msg a.chatroom-link')] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'http://localhost:3000/x']);
    expect(links.map((a) => a.textContent)).toEqual(['https://example.com/a?b=1', 'http://localhost:3000/x']);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    }
    expect(h.document.querySelector('.ca-msg .chatroom-msg-text')!.textContent).toBe(
      'see https://example.com/a?b=1, and (http://localhost:3000/x). thanks'
    );
  });

  it('never links a script, data or file address, an address with a password, or markup in the text', async () => {
    const h = await withText(
      'javascript:alert(1) data:text/html,x file:///etc/passwd https://u:p@evil.example/ <a href="https://x.io">hi</a>'
    );
    const links = [...h.document.querySelectorAll('.ca-msg a')] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://x.io/']);
    expect(links.map((a) => a.textContent)).toEqual(['https://x.io']);
    expect(h.document.querySelectorAll('.ca-msg .chatroom-msg-text a').length).toBe(1);
    expect(h.document.querySelector('.ca-msg .chatroom-msg-text')!.textContent).toContain('<a href="');
  });

  it('does not link a lookalike host: the text must name the host that opens', async () => {
    const h = await withText(
      'pay at http://p\u0430ypal.com/x or http://good.com\u2215evil.example/ or http://2130706433/ and real http://example.com/ok'
    );
    const links = [...h.document.querySelectorAll('.ca-msg a')] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['http://example.com/ok']);
  });

  it('keeps an @name inside an address from becoming a mention, and still marks one outside it', async () => {
    const h = await withText('@bravo look at https://social.example/@bravo/post');
    expect([...h.document.querySelectorAll('.ca-msg .ca-mention-tag')].map((e) => e.textContent)).toEqual(['@bravo']);
    expect(h.document.querySelector('.ca-msg a.chatroom-link')!.textContent).toBe('https://social.example/@bravo/post');
  });

  it('a click on a link does not open the message menu', async () => {
    const h = await withText('go https://example.com/');
    const a = h.document.querySelector('.ca-msg a.chatroom-link') as HTMLAnchorElement;
    a.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
  });
});

describe('the "is typing" line', () => {
  const lineOf = (h: Awaited<ReturnType<typeof createHarness>>) =>
    h.document.querySelector('.ca-typing') as HTMLElement;
  const turn = (h: Awaited<ReturnType<typeof createHarness>>, sessionId: string, roomId = 'r1') =>
    h.app._onChatroomTurn({ owner: '@single', roomId, sessionId, at: Date.now() });
  const twoRooms = () => [
    room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {}),
    room('r2', 'Other', [member(A, 'alpha'), member(B, 'bravo')], {}),
  ];

  it('shows who is typing, with moving dots hidden from a screen reader, only in the room that woke it', async () => {
    const h = await createHarness({ sessions, rooms: twoRooms(), stored: { 'reverie:chatroom': 'r1' } });
    expect(lineOf(h).hidden).toBe(true);
    turn(h, B);
    expect(lineOf(h).hidden).toBe(false);
    expect(lineOf(h).textContent).toBe('bravo is typing\u2026');
    expect(lineOf(h).getAttribute('role')).toBe('status');
    expect(lineOf(h).getAttribute('aria-live')).toBe('polite');
    expect(lineOf(h).querySelector('.ca-typing-dots')!.getAttribute('aria-hidden')).toBe('true');
    // another room does not show it, and coming back does
    (h.document.querySelector('[data-key="room:r2"]') as HTMLElement).click();
    await settle(60);
    expect(lineOf(h).hidden).toBe(true);
    (h.document.querySelector('[data-key="room:r1"]') as HTMLElement).click();
    await settle(60);
    expect(lineOf(h).textContent).toBe('bravo is typing\u2026');
  });

  it('ends when the turn ends (busy, then not), but not before it has started', async () => {
    const h = await createHarness({ sessions, rooms: twoRooms(), stored: { 'reverie:chatroom': 'r1' } });
    turn(h, B);
    // the pane was idle when the line was typed: still thinking, the turn has not shown as busy yet
    h.app._onSessionUpdated({ session: { id: B, status: 'idle' } });
    await settle(60);
    expect(lineOf(h).hidden).toBe(false);
    h.app._onSessionUpdated({ session: { id: B, status: 'busy' } });
    await settle(60);
    expect(lineOf(h).hidden).toBe(false);
    h.app._onSessionUpdated({ session: { id: B, status: 'idle' } });
    await settle(60);
    expect(lineOf(h).hidden).toBe(true);
    expect(h.app._chatApp.turns.size).toBe(0);
  });

  it('ends when the member posts in that room, and a post in another room does not end it', async () => {
    const h = await createHarness({ sessions, rooms: twoRooms(), stored: { 'reverie:chatroom': 'r1' } });
    turn(h, B);
    h.app._onChatroomMessage({
      roomId: 'r2',
      message: message('x1', 'r2', agent(B, 'bravo'), 'elsewhere', Date.now()),
    });
    await settle(30);
    expect(lineOf(h).hidden).toBe(false);
    h.app._onChatroomMessage({
      roomId: 'r1',
      message: message('x2', 'r1', agent(B, 'bravo'), 'here is my answer', Date.now()),
    });
    await settle(30);
    expect(lineOf(h).hidden).toBe(true);
  });

  it('expires on its own: never started, or never seen to end', async () => {
    const h = await createHarness({ sessions, rooms: twoRooms(), stored: { 'reverie:chatroom': 'r1' } });
    turn(h, B);
    const key = `r1|${B}`;
    h.app._chatApp.turns.get(key).at -= 46_000;
    h.app._chatApp.syncTurns();
    expect(lineOf(h).hidden).toBe(true);
    turn(h, B);
    h.app._onSessionUpdated({ session: { id: B, status: 'busy' } });
    await settle(60);
    h.app._chatApp.turns.get(key).at -= 241_000;
    h.app._chatApp.syncTurns();
    expect(lineOf(h).hidden).toBe(true);
    expect(h.app._chatApp.turns.size).toBe(0);
  });

  it('arms two safety timers (45 s without starting, 4 min at most) that really end the line, and clears them when it ends sooner', async () => {
    const h = await createHarness({ sessions, rooms: twoRooms(), stored: { 'reverie:chatroom': 'r1' } });
    const armed: Array<{ fn: () => void; ms: number; id: number; cleared: boolean }> = [];
    const view = h.window as unknown as {
      setTimeout: (fn: () => void, ms: number) => number;
      clearTimeout: (id: number) => void;
    };
    const realSet = view.setTimeout;
    const realClear = view.clearTimeout;
    view.setTimeout = (fn, ms) => {
      if (ms < 40_000 || ms > 300_000) return realSet.call(view, fn, ms);
      const t = { fn, ms, id: armed.length + 1000, cleared: false };
      armed.push(t);
      return t.id;
    };
    view.clearTimeout = (id) => {
      const t = armed.find((x) => x.id === id);
      if (t) t.cleared = true;
      else realClear.call(view, id);
    };
    // the page runs in the window, with the window's own Date
    const pageDate = (h.window as unknown as { Date: { now: () => number } }).Date;
    const realNow = pageDate.now;
    let clock = realNow();
    pageDate.now = () => clock;
    try {
      turn(h, B);
      expect(armed.map((t) => t.ms)).toEqual([45_050, 240_050]);
      // the first timer fires when it never started: the line goes
      clock += 46_000;
      armed[0].fn();
      expect(lineOf(h).hidden).toBe(true);
      expect(armed.every((t) => t.cleared)).toBe(true); // dropping it cleared both
      // a turn that did start is held until the long cap
      armed.length = 0;
      clock = realNow();
      turn(h, B);
      h.app._onSessionUpdated({ session: { id: B, status: 'busy' } });
      await settle(60);
      clock += 100_000;
      armed[0].fn();
      expect(lineOf(h).hidden).toBe(false); // busy, within the cap: still thinking
      clock += 141_000;
      armed[1].fn();
      expect(lineOf(h).hidden).toBe(true);
      expect(h.app._chatApp.turns.size).toBe(0);
      // a second turn for the same member replaces the first one's timers
      armed.length = 0;
      turn(h, B);
      const first = [...armed];
      turn(h, B);
      expect(first.every((t) => t.cleared)).toBe(true);
    } finally {
      pageDate.now = realNow;
      view.setTimeout = realSet;
      view.clearTimeout = realClear;
    }
  });

  it('names two and three at once, and drops one that is gone', async () => {
    const C = '0000003b-0049-4000-8000-00000000006a';
    const rooms = [
      room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo'), member(C, 'carol', { alive: false })], {}),
    ];
    const h = await createHarness({ sessions, rooms, stored: { 'reverie:chatroom': 'r1' } });
    turn(h, A);
    turn(h, B);
    expect(lineOf(h).textContent).toBe('alpha and bravo are typing\u2026');
    turn(h, C);
    // a member that is gone never shows
    expect(lineOf(h).textContent).toBe('alpha and bravo are typing\u2026');
  });
});

describe('the profile card on a phone', () => {
  const open = async (width: number) => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {})],
      stored: { 'reverie:chatroom': 'r1' },
    });
    Object.defineProperty(h.window, 'innerWidth', { value: width, configurable: true });
    (h.document.querySelector('.ca-member[aria-label^="bravo,"]') as HTMLElement).click();
    return { h, card: h.document.querySelector('.ca-profile') as HTMLElement };
  };

  it('is a bottom sheet at phone width, with no position that could put it off the screen', async () => {
    for (const width of [320, 360, 412, 767]) {
      const { card } = await open(width);
      expect(card, String(width)).not.toBeNull();
      expect(card.classList.contains('ca-profile--sheet'), String(width)).toBe(true);
      // the sheet's place comes from the CSS (left and right 8px, bottom), never from the row it was opened from
      expect(card.style.top).toBe('');
      expect(card.style.right).toBe('');
      expect(card.style.left).toBe('');
    }
  });

  it('beside the row on a wider window, but never past the left edge of it', async () => {
    for (const width of [768, 900, 1280]) {
      const { card } = await open(width);
      expect(card.classList.contains('ca-profile--sheet'), String(width)).toBe(false);
      const right = parseFloat(card.style.right);
      // its left edge (window width minus right minus the 280px card) is inside the window
      expect(width - right - 280, String(width)).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('private channels have a lock, and the owner decides who can join', () => {
  const rooms = () => [
    { ...room('r1', 'General', [member(A, 'alpha')], {}), visibility: 'public' },
    { ...room('r2', 'general', [member(A, 'alpha')], {}), visibility: 'private' },
  ];
  const row = (h: Awaited<ReturnType<typeof createHarness>>, key: string) =>
    h.document.querySelector(`[data-key="room:${key}"]`) as HTMLElement;

  it('a private channel shows a # with a small lock, says private in words, and a public one keeps the #', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'r1' } });
    expect((row(h, 'r2').querySelector('.ca-hash') as HTMLElement).dataset.glyph).toBe('private');
    expect(row(h, 'r2').getAttribute('aria-label')).toContain('private');
    expect(row(h, 'r1').querySelector('.ca-hash')!.textContent).toBe('#');
    expect(row(h, 'r1').getAttribute('aria-label')).not.toContain('private');
    // the header of the open private channel says so too
    (row(h, 'r2') as HTMLElement).click();
    await settle(80);
    const mark = h.document.querySelector('.ca-head .ca-hash')!;
    expect((mark as HTMLElement).dataset.glyph).toBe('private');
    expect(mark.getAttribute('aria-label')).toBe('Private channel');
  });

  it('draws the marks like Discord: a # with a lock, a speaker, a speaker with a lock; monochrome SVG, no emoji', async () => {
    const mixed = [
      { ...room('r1', 'General', [member(A, 'alpha')], {}), visibility: 'public' },
      { ...room('r2', 'general', [member(A, 'alpha')], {}), visibility: 'private' },
      { ...room('r3', 'Standup', [{ ...member(A, 'alpha'), voice: true }], {}), visibility: 'public' },
      { ...room('r4', 'Briefing', [{ ...member(A, 'alpha'), voice: true }], {}), visibility: 'private' },
    ];
    const h = await createHarness({ sessions, rooms: mixed, stored: { 'reverie:chatroom': 'r1' } });
    const mark = (id: string) => row(h, id).querySelector('.ca-hash') as HTMLElement;
    expect(['r1', 'r2', 'r3', 'r4'].map((id) => mark(id).dataset.glyph)).toEqual([
      'text',
      'private',
      'voice',
      'voice-private',
    ]);
    expect(mark('r1').querySelector('svg')).toBeNull();
    expect(mark('r1').textContent).toBe('#');
    for (const id of ['r2', 'r3', 'r4']) {
      const svg = mark(id).querySelector('svg')!;
      expect(svg, id).not.toBeNull();
      expect(mark(id).textContent, id).toBe('');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
    // the lock badge is in both private marks and in neither of the public ones
    const lock = (id: string) => mark(id).querySelectorAll('rect').length;
    expect([lock('r1'), lock('r2'), lock('r3'), lock('r4')]).toEqual([0, 1, 0, 1]);
    // a private voice channel is private in words and in its header
    expect(row(h, 'r4').getAttribute('aria-label')).toContain('private');
    (row(h, 'r4') as HTMLElement).click();
    await settle(80);
    expect(h.document.querySelector('.ca-head .ca-hash')!.getAttribute('aria-label')).toBe('Private voice channel');
  });

  it('a server that does not say gets no lock (nothing is called private by guesswork)', async () => {
    const plain = [room('r1', 'General', [member(A, 'alpha')], {}), room('r2', 'general', [member(A, 'alpha')], {})];
    const h = await createHarness({ sessions, rooms: plain, stored: { 'reverie:chatroom': 'r1' } });
    expect(row(h, 'r2').querySelector('.ca-hash')!.textContent).toBe('#');
  });

  it('the channel settings let the owner switch between private and public, and say what each means', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'r2' } });
    await h.app._chatApp.openChannelSettings('r2');
    const radios = [...h.document.querySelectorAll('.ca-visibility:not(.ca-wake) input[type="radio"]')] as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['private', true],
      ['public', false],
    ]);
    expect(h.document.querySelector('.ca-visibility:not(.ca-wake) .ca-hint')!.textContent).toContain('Private');
    radios[1].checked = true;
    radios[1].dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(80);
    const put = h.server.calls.find(
      (c: { path: string; method?: string; body?: { visibility?: string } }) =>
        c.path === '/api/chatrooms/r2/visibility'
    );
    expect(put).toBeTruthy();
    expect(put.body).toEqual({ visibility: 'public' });
    expect(h.document.querySelector('.ca-visibility:not(.ca-wake) .ca-hint')!.textContent).toContain('every agent');
  });

  it('computed styles on the real settings markup: 44px tiles and 20px radios', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'r2' } });
    await h.app._chatApp.openChannelSettings('r2');
    const style = h.document.createElement('style');
    style.textContent = readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.css'), 'utf8');
    h.document.head.append(style);
    const tile = h.document.querySelector('.ca-visibility .ca-radio') as HTMLElement;
    const radio = tile.querySelector('input') as HTMLElement;
    const tileStyle = h.window.getComputedStyle(tile);
    expect(tileStyle.minHeight).toBe('44px');
    expect(tileStyle.display).toBe('flex');
    const radioStyle = h.window.getComputedStyle(radio);
    expect([radioStyle.width, radioStyle.height]).toEqual(['20px', '20px']);
  });

  it('the visibility styles reach the real settings markup, which is portaled outside .ca-root', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'r2' } });
    await h.app._chatApp.openChannelSettings('r2');
    const fieldset = h.document.querySelector('.ca-visibility')!;
    expect(fieldset.closest('.ca-root')).toBeNull();
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.css'), 'utf8');
    const rules: string[] = [];
    postcss.parse(css).walkRules((r) => {
      for (const sel of r.selectors) if (sel.includes('.ca-visibility') && !/:hover|:has/.test(sel)) rules.push(sel);
    });
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const sel of rules) expect(h.document.querySelector(sel), sel).not.toBeNull();
  });
});

describe('Add people is easy to find and tap', () => {
  const S = [
    { id: A, name: 'alpha', mode: 'claude' },
    { id: B, name: 'bravo', mode: 'codex' },
  ];
  const mk = () => [
    room('r1', 'General', [member(A, 'alpha')], {}),
    room('r2', 'Other', [member(A, 'alpha')], {}),
    room('dm1', '', [member(B, 'bravo')], { kind: 'dm', dm: ['user', B] }),
  ];
  const headBtn = (h: Awaited<ReturnType<typeof createHarness>>) =>
    h.document.querySelector('.ca-head .ca-head-invite') as HTMLButtonElement;

  it('the open channel has an always-visible Add people button right beside its name, with a label and a tooltip', async () => {
    const h = await createHarness({ sessions: S, rooms: mk(), stored: { 'reverie:chatroom': 'r1' } });
    const btn = headBtn(h);
    expect(btn).not.toBeNull();
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Add people to General');
    expect(btn.title).toBe('Add people to this channel');
    expect(btn.querySelector('svg')).not.toBeNull(); // an icon, not only text
    // The compact mute indicator sits between the name and the visible invite control.
    const badge = h.document.querySelector('.ca-head-title')!.nextElementSibling!;
    expect(badge.classList.contains('ca-muted-badge')).toBe(true);
    expect(badge.nextElementSibling).toBe(btn);
    btn.click();
    expect((h.document.querySelector('.ca-invite') as HTMLElement).textContent).toContain('Invite agents to #General');
  });

  it('follows the open channel, and is not there for a direct message', async () => {
    const h = await createHarness({ sessions: S, rooms: mk(), stored: { 'reverie:chatroom': 'r1' } });
    (h.document.querySelector('[data-key="room:r2"]') as HTMLElement).click();
    await settle(80);
    expect(headBtn(h).getAttribute('aria-label')).toBe('Add people to Other');
    h.shell.selectWorkspace('home');
    (h.document.querySelector('[data-key="room:dm1"]') as HTMLElement).click();
    await settle(80);
    expect(headBtn(h).hidden).toBe(true);
  });

  it('the open channel\u2019s row is marked so its Add people and Edit icons stay visible without hovering; the others are not', async () => {
    const h = await createHarness({ sessions: S, rooms: mk(), stored: { 'reverie:chatroom': 'r1' } });
    const wrap = (key: string) =>
      (h.document.querySelector(`[data-key="room:${key}"]`) as HTMLElement).closest('.ca-item-wrap') as HTMLElement;
    expect(wrap('r1').classList.contains('is-active')).toBe(true);
    expect(wrap('r2').classList.contains('is-active')).toBe(false);
  });
});

describe('editing your own messages and pinning', () => {
  const rooms = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo')], {
      messages: [
        message('m1', 'r1', user, 'deploy X tonight', 1000),
        message('m2', 'r1', agent(A, 'alpha'), 'on it', 1100),
        message('m3', 'r1', user, 'Rule: never push to main', 1200),
        message('m4', 'r1', agent(B, 'bravo'), 'pinned by the coordinator', 1300, { pinned: { at: 2000, by: 'alpha', kind: 'agent' } }),
        message('m5', 'r1', user, 'already changed once', 1400, { edited: { at: 1500 } }),
      ],
    }),
  ];
  const menu = (h: Awaited<ReturnType<typeof createHarness>>, id: string) => {
    (h.document.querySelector(`[data-msg-id="${id}"] [aria-label="More"]`) as HTMLElement).click();
    return [...h.document.querySelectorAll('.ca-msg-menu button')] as HTMLElement[];
  };
  const item = (h: Awaited<ReturnType<typeof createHarness>>, id: string, label: string) =>
    menu(h, id).find((b) => b.textContent === label) as HTMLElement;

  it('offers Edit only on the user\'s own text messages, and Pin / Unpin on any channel message', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    expect(menu(h, 'm1').map((b) => b.textContent)).toEqual(['Reply', 'Copy text', 'Edit message', 'Pin message', 'Delete message']);
    h.document.querySelector('.ca-msg-menu')?.remove();
    expect(menu(h, 'm2').map((b) => b.textContent)).toEqual(['Reply', 'Copy text', 'Pin message', 'Delete message']);
    h.document.querySelector('.ca-msg-menu')?.remove();
    expect(menu(h, 'm4').map((b) => b.textContent)).toContain('Unpin message');
  });

  it('without the server\'s edits and pins features there are no such entries', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), features: { unread: true, dms: true, replies: true, deletes: true } });
    const labels = menu(h, 'm1').map((b) => b.textContent);
    expect(labels).not.toContain('Edit message');
    expect(labels).not.toContain('Pin message');
    expect((h.document.querySelector('.ca-head-pins') as HTMLElement).hidden).toBe(true);
  });

  it('edits in place: Enter saves, the server gets the new text, and the message says edited', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    item(h, 'm1', 'Edit message').click();
    const box = h.document.querySelector('[data-msg-id="m1"] .ca-edit-input') as HTMLTextAreaElement;
    expect(box.value).toBe('deploy X tonight');
    box.value = 'actually, do not deploy X';
    box.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    box.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(80);
    expect(h.server.edits).toEqual([{ id: 'm1', text: 'actually, do not deploy X' }]);
    const el = h.document.querySelector('[data-msg-id="m1"]') as HTMLElement;
    expect(h.document.querySelector('.ca-edit-input')).toBeNull();
    expect(el.textContent).toContain('actually, do not deploy X');
    expect(el.querySelector('.ca-edited')?.textContent).toBe('(edited)');
    expect((h.document.querySelector('[data-msg-id="m5"] .ca-edited') as HTMLElement).textContent).toBe('(edited)');
  });

  it('Escape cancels, an unchanged text sends nothing, an empty one is refused, and the draft survives a redraw', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    item(h, 'm1', 'Edit message').click();
    let box = h.document.querySelector('[data-msg-id="m1"] .ca-edit-input') as HTMLTextAreaElement;
    box.value = 'half a thought';
    box.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    h.app._chatApp.renderFeed(); // e.g. a new message arrives
    box = h.document.querySelector('[data-msg-id="m1"] .ca-edit-input') as HTMLTextAreaElement;
    expect(box.value).toBe('half a thought');
    box.value = '   ';
    box.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (h.document.querySelector('.ca-edit-save') as HTMLElement).click();
    await settle(40);
    expect(h.server.edits).toBeUndefined();
    expect(h.document.querySelector('.ca-edit-input')).not.toBeNull();
    box.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(h.document.querySelector('.ca-edit-input')).toBeNull();
    expect(h.document.querySelector('[data-msg-id="m1"]')!.textContent).toContain('deploy X tonight');
    item(h, 'm1', 'Edit message').click();
    (h.document.querySelector('.ca-edit-save') as HTMLElement).click();
    await settle(40);
    expect(h.server.edits).toBeUndefined();
  });

  it('shows a server refusal and keeps the editor open', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    h.server.editError = 'Only your own messages can be edited';
    item(h, 'm3', 'Edit message').click();
    const box = h.document.querySelector('[data-msg-id="m3"] .ca-edit-input') as HTMLTextAreaElement;
    box.value = 'new rule';
    box.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    (h.document.querySelector('.ca-edit-save') as HTMLElement).click();
    await settle(60);
    expect(h.app.toasts.at(-1)?.text ?? h.app.toasts.at(-1)).toContain('Only your own messages');
    expect(h.document.querySelector('[data-msg-id="m3"] .ca-edit-input')).not.toBeNull();
  });

  it('pins and unpins from the menu; a pinned message says who pinned it, and the header lists the pins', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    expect(h.document.querySelector('[data-msg-id="m4"] .ca-pin-mark')!.textContent).toContain('alpha (coordinator)');
    expect(h.document.querySelector('[data-msg-id="m4"]')!.classList.contains('is-pinned')).toBe(true);
    expect(h.document.querySelector('[data-msg-id="m3"] .ca-pin-mark')).toBeNull();
    item(h, 'm3', 'Pin message').click();
    await settle(80);
    expect(h.server.pinCalls).toEqual([{ id: 'm3', method: 'POST' }]);
    expect(h.document.querySelector('[data-msg-id="m3"] .ca-pin-mark')!.textContent).toContain('Pinned by you');
    const pinsBtn = h.document.querySelector('.ca-head-pins') as HTMLElement;
    expect(pinsBtn.hidden).toBe(false);
    expect(pinsBtn.getAttribute('aria-label')).toBe('Pinned messages (2)');
    pinsBtn.click();
    await settle(60);
    const rows = [...h.document.querySelectorAll('.ca-pins .ca-pins-row')];
    expect(rows.map((r) => r.querySelector('.ca-pins-snippet')?.textContent)).toEqual(['Rule: never push to main', 'pinned by the coordinator']);
    // the owner can unpin anything, the coordinator's pin included
    (rows[1].querySelectorAll('button')[1] as HTMLElement).click();
    await settle(100);
    expect(h.server.pinCalls.at(-1)).toEqual({ id: 'm4', method: 'DELETE' });
    expect(h.document.querySelectorAll('.ca-pins .ca-pins-row').length).toBe(1);
    expect(h.document.querySelector('[data-msg-id="m4"] .ca-pin-mark')).toBeNull();
  });

  it('a direct message has no pins button or Pin entry', async () => {
    const dm = { ...room('d1', '', [member(A, 'alpha')], {}), kind: 'dm', dm: ['user', A], messages: [message('d1m1', 'd1', user, 'hi', 1000)] };
    const h = await createHarness({ sessions, rooms: [dm], stored: { 'reverie:chatroom': 'd1' } });
    expect((h.document.querySelector('.ca-head-pins') as HTMLElement).hidden).toBe(true);
    expect(menu(h, 'd1m1').map((b) => b.textContent)).not.toContain('Pin message');
  });
});

describe('putting channels in your own order', () => {
  const rooms = () => [
    room('r1', 'General', [member(A, 'alpha')], {}),
    room('r2', 'Ops', [member(A, 'alpha')], {}),
    room('r3', 'Dev', [member(A, 'alpha')], {}),
    room('r4', 'Design', [member(A, 'alpha')], { category: 'Eng' }),
    room('r5', 'Build', [member(A, 'alpha')], { category: 'Eng' }),
  ];
  const order = (h: Awaited<ReturnType<typeof createHarness>>) =>
    [...h.document.querySelectorAll('.ca-list [data-key^="room:"]')].map((n) => (n as HTMLElement).dataset.key!.slice(5));
  const wrapOf = (h: Awaited<ReturnType<typeof createHarness>>, id: string) =>
    (h.document.querySelector(`.ca-list [data-key="room:${id}"]`) as HTMLElement).closest('.ca-item-wrap') as HTMLElement;
  const key = (h: Awaited<ReturnType<typeof createHarness>>, k: string) => h.document.querySelector(`[data-key="${k}"]`) as HTMLButtonElement;
  const drag = (h: Awaited<ReturnType<typeof createHarness>>, from: string, to: string) => {
    const ev = (type: string) => new h.window.Event(type, { bubbles: true, cancelable: true });
    wrapOf(h, from).dispatchEvent(ev('dragstart'));
    wrapOf(h, to).dispatchEvent(ev('dragover'));
    wrapOf(h, to).dispatchEvent(ev('drop'));
  };

  it('Edit order shows a handle and Up / Down on each channel; Cancel throws the changes away', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    expect(order(h)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    (h.document.querySelector('.ca-order-edit') as HTMLElement).click();
    expect(h.document.querySelector('.ca-order-done')).not.toBeNull();
    expect(h.document.querySelector('.ca-order-edit')).toBeNull();
    expect(h.document.querySelectorAll('.ca-order-handle').length).toBe(5);
    expect(key(h, 'up:r1').disabled).toBe(true);
    expect(key(h, 'down:r3').disabled).toBe(true); // last of the uncategorised ones: it cannot cross into a category
    expect(key(h, 'up:r4').disabled).toBe(true);
    key(h, 'up:r3').click();
    expect(order(h)).toEqual(['r1', 'r3', 'r2', 'r4', 'r5']);
    (h.document.querySelector('.ca-order-cancel') as HTMLElement).click();
    expect(order(h)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(h.server.orderCalls).toBeUndefined();
  });

  it('Up and Down are laid out one after the other, not stacked on the row\'s right edge', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const style = h.document.createElement('style');
    style.textContent = readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.css'), 'utf8');
    h.document.head.append(style);
    (h.document.querySelector('.ca-order-edit') as HTMLElement).click();
    for (const k of ['up:r2', 'down:r2']) {
      const cs = h.window.getComputedStyle(key(h, k));
      expect(cs.position, k).toBe('static');
      expect(cs.transform, k).toBe('none');
    }
    // the row is a flex line: handle, channel, Up, Down in that order, with a gap (jsdom has no layout to measure, so this is the rule that keeps them apart)
    const wrap = wrapOf(h, 'r2');
    const rowStyle = h.window.getComputedStyle(wrap);
    expect(rowStyle.display).toBe('flex');
    expect(parseFloat(rowStyle.gap)).toBeGreaterThanOrEqual(4);
    expect([...wrap.children].map((c) => (c as HTMLElement).className.split(' ')[0] || c.tagName)).toEqual(['ca-order-handle', 'ca-item', 'ca-item-act', 'ca-item-act']);
    expect(key(h, 'up:r2').nextElementSibling).toBe(key(h, 'down:r2'));
    expect(h.window.getComputedStyle(key(h, 'up:r2')).width).toBe('36px');
    expect(wrap.querySelectorAll('.ca-order-btn').length).toBe(2);
    expect(wrap.querySelector('.ca-item-edit')).toBeNull();
  });

  it('Done saves the whole order on the server, and a new channel goes below the placed ones', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    (h.document.querySelector('.ca-order-edit') as HTMLElement).click();
    key(h, 'down:r1').click();
    key(h, 'down:r4').click();
    expect(order(h)).toEqual(['r2', 'r1', 'r3', 'r5', 'r4']);
    (h.document.querySelector('.ca-order-done') as HTMLElement).click();
    await settle(60);
    expect(h.server.orderCalls).toEqual([['r2', 'r1', 'r3', 'r5', 'r4']]);
    expect(h.document.querySelector('.ca-order-done')).toBeNull();
    expect(order(h)).toEqual(['r2', 'r1', 'r3', 'r5', 'r4']);
    // a channel nobody placed comes after the placed ones of its category
    h.app._chatRooms.push({ ...room('r6', 'Fresh', [member(A, 'alpha')], {}), createdAt: 99 });
    h.app._chatApp.renderSidebar();
    expect(order(h)).toEqual(['r2', 'r1', 'r3', 'r6', 'r5', 'r4']);
  });

  it('a server refusal keeps you in Edit order with the draft', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    h.server.fail = undefined;
    (h.document.querySelector('.ca-order-edit') as HTMLElement).click();
    key(h, 'down:r1').click();
    h.app._chatApi = async () => ({ ok: false, error: 'nope' });
    (h.document.querySelector('.ca-order-done') as HTMLElement).click();
    await settle(40);
    expect(h.document.querySelector('.ca-order-done')).not.toBeNull();
    expect(order(h)).toEqual(['r2', 'r1', 'r3', 'r4', 'r5']);
    expect(h.app.toasts.at(-1)?.text).toContain('nope');
  });

  it('dragging a channel onto another saves the new order at once, but not across categories', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    expect(wrapOf(h, 'r3').draggable).toBe(true);
    drag(h, 'r3', 'r1');
    await settle(60);
    expect(h.server.orderCalls).toEqual([['r3', 'r1', 'r2', 'r4', 'r5']]);
    expect(order(h)).toEqual(['r3', 'r1', 'r2', 'r4', 'r5']);
    drag(h, 'r1', 'r4'); // r4 is in a category
    await settle(40);
    expect(h.server.orderCalls.length).toBe(1);
  });

  it('is absent on a server without it, and on a touch screen the rows are not draggable (Edit order has buttons)', async () => {
    const old = await createHarness({ sessions, rooms: rooms(), features: { unread: true, dms: true, replies: true } });
    expect(old.document.querySelector('.ca-order-edit')).toBeNull();
    expect(wrapOf(old, 'r1').draggable).toBe(false);
    const touch = await createHarness({ sessions, rooms: rooms() });
    (touch.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = () => ({ matches: true });
    touch.app._chatApp.renderSidebar();
    expect(wrapOf(touch, 'r1').draggable).toBe(false);
    expect(touch.document.querySelector('.ca-order-edit')).not.toBeNull();
  });
});

describe('who a message wakes', () => {
  const rooms = (extra: object = {}) => [
    { ...room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(B, 'bravo', { notify: 'mentions' })], {}), ...extra },
  ];

  it('channel settings let the owner pick the room\'s wake mode, with what each means', async () => {
    const h = await createHarness({ sessions, rooms: rooms({ wake: 'mentions' }), stored: { 'reverie:chatroom': 'r1' } });
    await h.app._chatApp.openChannelSettings('r1');
    const radios = [...h.document.querySelectorAll('.ca-wake input[type="radio"]')] as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([['default', false], ['all', false], ['mentions', true]]);
    expect(h.document.querySelector('.ca-wake .ca-hint')!.textContent).toContain('@names');
    radios[1].checked = true;
    radios[1].dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await settle(60);
    expect(h.server.wakeCalls).toEqual(['all']);
    expect(h.document.querySelector('.ca-wake .ca-hint')!.textContent).toContain('costs every agent a turn');
  });

  it('shows what wakes each member without duplicating the cell status controls', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'r1' } });
    const members = [...h.document.querySelectorAll('.ca-member')] as HTMLButtonElement[];
    const bravo = members.find((b) => b.textContent!.includes('bravo'))!;
    bravo.click();
    const card = h.document.querySelector('.ca-profile') as HTMLElement;
    expect(card.textContent).toContain('Only @mentions, replies and you');
    expect([...card.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Wake on '))).toBe(false);
    (members.find((b) => b.textContent!.includes('alpha')) as HTMLButtonElement).click();
    expect([...h.document.querySelectorAll('.ca-profile button')].some((b) => b.textContent?.startsWith('Wake on '))).toBe(false);
    expect(h.server.notifyCalls || []).toEqual([]);
  });

  it('is absent on a server that does not have it', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), features: { unread: true, dms: true, replies: true }, stored: { 'reverie:chatroom': 'r1' } });
    await h.app._chatApp.openChannelSettings('r1');
    expect(h.document.querySelector('.ca-wake')).toBeNull();
    ([...h.document.querySelectorAll('.ca-member')][0] as HTMLButtonElement).click();
    expect(h.document.querySelector('.ca-profile')!.textContent).not.toContain('Wakes on');
  });
});

describe('moving an agent to its new session, and retired sessions', () => {
  const OLD = '00000046-0058-4000-8000-000000000084';
  const rooms = () => [
    room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' }), member(OLD, 'Pat', { alive: false, goal: 'runtime' })], {}),
  ];

  it('an offline member\'s context menu offers Move to new session; the new one is picked from the open sessions, same name first', async () => {
    const S = [...sessions, { id: B, name: 'Pat', mode: 'claude' }, { id: '00000048-005c-4000-8000-00000000008d', name: 'zed', mode: 'claude' }];
    const h = await createHarness({ sessions: S, rooms: rooms(), stored: { 'reverie:chatroom': 'r1' } });
    const offline = ([...h.document.querySelectorAll('.ca-member')] as HTMLButtonElement[]).find((b) => b.textContent!.includes('Pat'))!;
    offline.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const move = [...h.document.querySelectorAll('.ca-member-menu button')].find((b) => b.textContent === 'Move to new session') as HTMLElement;
    expect(move).toBeTruthy();
    move.click();
    const names = [...h.document.querySelectorAll('.ca-replace .ca-invite-row strong')].map((n) => n.textContent);
    expect(names[0]).toBe('Pat');
    expect(names).toContain('zed');
    const first = h.document.querySelector('.ca-replace .ca-invite-row .ca-btn') as HTMLElement;
    first.click();
    await settle(80);
    expect(h.server.replaceCalls).toEqual([{ from: OLD, to: B }]);
    expect(h.document.querySelector('.ca-replace')).toBeNull();
  });

  it('a running member has no such button, and an older server shows none', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'r1' } });
    const online = ([...h.document.querySelectorAll('.ca-member')] as HTMLButtonElement[]).find((b) => b.textContent!.includes('alpha'))!;
    online.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect([...h.document.querySelectorAll('.ca-member-menu button')].some((b) => b.textContent === 'Move to new session')).toBe(false);
    const old = await createHarness({ sessions, rooms: rooms(), features: { unread: true, dms: true, replies: true }, stored: { 'reverie:chatroom': 'r1' } });
    ([...old.document.querySelectorAll('.ca-member')] as HTMLButtonElement[]).find((b) => b.textContent!.includes('Pat'))!.dispatchEvent(new old.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect([...old.document.querySelectorAll('.ca-member-menu button')].some((b) => b.textContent === 'Move to new session')).toBe(false);
  });

  it('retired sessions are hidden from the pickers, listed in the Office tools, and can be restored or deleted', async () => {
    const h = await createHarness({ sessions: [...sessions, { id: OLD, name: 'Pat', mode: 'claude' }], rooms: rooms(), stored: { 'reverie:chatroom': 'r1' } });
    h.server.retired = [{ sessionId: OLD, name: 'Pat', successorId: B, at: 5000, rooms: [{ id: 'r1', name: 'General' }], restorable: true }];
    await h.app._loadChatRooms('r1');
    expect(h.app._chatCandidateSessions(new Set()).some((s: { id: string }) => s.id === OLD)).toBe(false);
    const entries = h.app._chatApp.officeToolEntries() as Array<{ label?: string; run?: () => void }>;
    const retiredEntry = entries.find((e) => e.label === 'Retired sessions')!;
    expect(retiredEntry).toBeTruthy();
    retiredEntry.run!();
    await settle(60);
    const row = h.document.querySelector('.ca-retired .ca-invite-row') as HTMLElement;
    expect(row.textContent).toContain('Pat');
    expect(row.textContent).toContain('General');
    h.window.confirm = () => true;
    (row.querySelectorAll('button')[0] as HTMLElement).click();
    await settle(100);
    expect(h.server.retiredCalls).toEqual([{ id: OLD, method: 'POST', restore: true }]);
    expect(h.document.querySelector('.ca-retired .ca-invite-empty')!.textContent).toContain('No retired sessions');
  });

  it('Delete asks first, and the menu entry is absent when nothing is retired', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), stored: { 'reverie:chatroom': 'r1' } });
    expect((h.app._chatApp.officeToolEntries() as Array<{ label?: string }>).some((e) => e.label === 'Retired sessions')).toBe(false);
    h.server.retired = [{ sessionId: OLD, name: 'Pat', successorId: B, at: 5000, rooms: [], restorable: false }];
    await h.app._chatApp.openRetiredDialog();
    const buttons = [...h.document.querySelectorAll('.ca-retired .ca-invite-row button')] as HTMLButtonElement[];
    expect(buttons[0].disabled).toBe(true); // nothing to restore
    h.window.confirm = () => false;
    buttons[1].click();
    await settle(30);
    expect(h.server.retiredCalls).toBeUndefined();
    h.window.confirm = () => true;
    buttons[1].click();
    await settle(80);
    expect(h.server.retiredCalls).toEqual([{ id: OLD, method: 'DELETE', restore: false }]);
  });
});

describe('the Board entry', () => {
  const entry = (h: { document: Document }, kind: string) => h.document.querySelector<HTMLButtonElement>(`.ca-item[data-key="page:${kind}"]`)!;

  it('leaves channel navigation free of duplicate management entries', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    const scroll = h.document.querySelector('.ca-side-scroll')!;
    expect(scroll.querySelector('.ca-pages')).toBeNull();
    expect(scroll.querySelector('.ca-item--room')).not.toBeNull();
    expect(h.document.querySelector('.ca-office-gear')).not.toBeNull();
    expect(h.document.querySelector('.ca-page')).toBeNull();
  });

  it('opens Board in place of chat, highlights it, and restores it through browser Back', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.shell.openPage('board');
    const frame = h.document.querySelector<HTMLIFrameElement>('.ca-page-frame')!;
    expect(frame.getAttribute('src')).toBe('/board');
    expect(h.document.querySelector<HTMLElement>('.ca-page')!.hidden).toBe(false);
    expect(h.document.querySelector('.ca-head-title')!.textContent).toBe('Board');
    expect(h.document.querySelector('.ca-office-gear')!.getAttribute('aria-current')).toBe('page');
    expect(h.document.querySelector('.ca-item--room.is-active')).toBeNull();
    expect((h.document.querySelector('.ca-chat') as HTMLElement & { inert: boolean }).inert).toBe(true);
    expect(h.window.location.hash).toBe('#board');
    h.window.history.back();
    await settle(60);
    expect(h.shell.embed).toBeNull();
    h.window.history.forward();
    await settle(60);
    expect(h.window.location.hash).toBe('#board');
    expect(frame.getAttribute('src')).toBe('/board');
  });

  it('does not offer Plans or open the removed #plans page', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), hash: '#plans' });
    expect(entry(h, 'plans')).toBeNull();
    expect(h.shell.embed).toBeNull();
    h.shell.openPage('plans');
    expect(h.document.querySelector('.ca-page')).toBeNull();
    expect(h.server.calls.some((call: { path: string }) => call.path === '/plans')).toBe(false);
  });

  it('a room click, or a link to another room, brings the conversation back', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    h.shell.openPage('board');
    [...h.document.querySelectorAll<HTMLButtonElement>('.ca-item--room')].find((b) => b.textContent!.includes('Side'))!.click();
    await settle(80);
    expect(h.document.querySelector<HTMLElement>('.ca-page')!.hidden).toBe(true);
    expect(h.document.querySelector('.ca-head-title')!.textContent).toBe('#Side');
    expect(h.window.location.hash).toBe('');
    expect((h.document.querySelector('.ca-chat') as HTMLElement & { inert: boolean }).inert).toBe(false);
    expect(h.document.querySelector('.ca-office-gear')!.classList.contains('is-active')).toBe(false);
  });

  it('a #board link opens the page when the app loads', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms(), hash: '#board' });
    await settle(60);
    expect(h.document.querySelector<HTMLElement>('.ca-page')!.hidden).toBe(false);
    expect(h.document.querySelector('.ca-page-frame')!.getAttribute('src')).toBe('/board');
    expect(h.document.querySelector('.ca-office-gear')!.classList.contains('is-active')).toBe(true);
  });
});



describe('visible mobile voice controls', () => {
  it('shows labelled header actions only in a voice room and toggles read aloud', async () => {
    const rooms = fixtureRooms();
    rooms[0].members[0].voice = true;
    const h = await createHarness({ sessions, rooms });
    const modes = new Map<string, string>();
    let cars = 0;
    Object.assign(h.app, {
      _speakRepliesMode: (id: string) => modes.get(id) || 'off',
      _speakRepliesIn: (id: string) => modes.has(id),
      _setSpeakReplies: (id: string, mode: string) => {
        if (mode === 'off') modes.delete(id);
        else modes.set(id, mode);
      },
      openCarMode: () => {
        cars++;
      },
    });
    h.shell.renderHeader();
    const speak = h.document.querySelector('.ca-head-speak') as HTMLButtonElement;
    expect(h.document.querySelector('.ca-head-car')).toBeNull();
    expect(speak.hidden).toBe(false);
    expect(speak.title).toBe('Enable spoken replies in this room');
    speak.click();
    expect([...modes]).toEqual([[rooms[0].id, 'mine']]); // only this room, starting at "Replies to me"
    expect(speak.getAttribute('aria-pressed')).toBe('true');
    expect(speak.title).toBe('Disable spoken replies in this room (now: replies to you)');
    expect(speak.getAttribute('aria-label')).toBe('Disable spoken replies in this room (now: replies to you)');
    modes.set(rooms[0].id, 'all');
    h.shell.renderHeader();
    expect(speak.title).toBe('Disable spoken replies in this room (now: everyone)');
    speak.click();
    expect(modes.size).toBe(0);
    expect(speak.title).toBe('Enable spoken replies in this room');
    expect(cars).toBe(0); // Voice replaces the competing Car header button.
    // The channel menu chooses who is read: Off, Replies to me, Everyone.
    const menu = h.shell.channelEntries(rooms[0]).find((e: { label?: string }) => e.label === 'Read aloud');
    expect(menu.sub.map((e: { label: string; checked: boolean }) => [e.label, e.checked])).toEqual([
      ['Off', true],
      ['Replies to me', false],
      ['Everyone', false],
    ]);
    menu.sub[2].run();
    expect(modes.get(rooms[0].id)).toBe('all');
    expect(speak.title).toBe('Disable spoken replies in this room (now: everyone)');
    modes.clear();
    // Read aloud is any room's choice; car mode needs a voice member.
    await h.shell.selectRoom('r3');
    expect(speak.hidden).toBe(false);
    expect(h.document.querySelector('.ca-head-car')).toBeNull();
  });
});

describe('consolidated Voice on phones', () => {
  it('offers real browser dictation without a voice member or reachable server, with one Voice control', async () => {
    const h = await createHarness({ sessions, rooms: fixtureRooms() });
    Object.defineProperty(h.window.navigator, 'maxTouchPoints', { configurable: true, value: 2 });
    Object.defineProperty(h.window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 Android Mobile Chrome',
    });
    let started = 0;
    h.window.SpeechRecognition = class {
      start() {
        started++;
      }
    };
    for (const file of ['voice-chat.js', 'car-mode.js', 'hands-free.js'])
      h.window.eval(readFileSync(resolve(import.meta.dirname, `../src/web/public/${file}`), 'utf8'));
    const api = h.app._chatApi.bind(h.app);
    h.app._chatApi = async (path: string, opts: unknown) =>
      path === '/api/voice/status'
        ? { ok: true, data: { available: false, message: 'Whisper/Piper at 127.0.0.1:8090 unavailable' } }
        : api(path, opts);
    h.app._buildHandsFree(h.app._chatEls.mic);
    h.window.clearInterval(h.app._hfTimer);
    h.app._syncChatMic();
    await h.flush();
    const control = h.document.querySelector('.chatroom-voice-control') as HTMLSelectElement;
    expect(control).not.toBeNull();
    expect(control.hidden).toBe(false);
    expect(control.value).toBe('off');
    expect(h.app._chatEls.mic.hidden).toBe(false);
    expect(h.app._chatEls.mic.title).toContain('127.0.0.1:8090');
    expect(h.document.querySelector('.ca-head-car')).toBeNull();
    expect(h.document.querySelector('.chatroom-car-btn')).toBeNull();
    expect(control.textContent).not.toContain('Car screen');
    control.value = 'dictate';
    control.dispatchEvent(new h.window.Event('change'));
    expect(started).toBe(1);
    expect(h.app._voiceEngineInfo().engine).toBe('speech');
  });
});

it('updates offline members immediately when their session restarts, and updates them again on exit', async () => {
  const h = await createHarness({ sessions: [{ id: B, name: 'bravo', status: 'stopped', pid: null }], rooms: [room('r1', 'Office', [member(B, 'bravo', { alive: false })])] });
  const label = () => h.document.querySelector('.ca-member')!.getAttribute('aria-label');
  expect(label()).toContain('offline');
  h.app._onSessionUpdated({ session: { id: B, name: 'bravo', status: 'idle', pid: 42 } });
  await settle(60);
  expect(label()).toContain('idle');
  expect(h.document.querySelector('.ca-members-head')!.textContent).toBe('Online — 1');
  h.app._onSessionUpdated({ session: { id: B, status: 'stopped', pid: null } });
  await settle(60);
  expect(label()).toContain('offline');
  h.dom.window.close();
});


it('revalidates channel changes missed in the terminal when Back to chat is pressed, preserving the draft', async () => {
  const h = await createHarness({ sessions, rooms: fixtureRooms() });
  h.app._chatEls.input.value = 'unfinished message';
  h.shell.showDebug(A);
  h.server.rooms.push(room('new-room', 'New team channel', [member(A, 'alpha')]));
  h.document.querySelector('.ca-back').click();
  await settle(100);
  expect(h.shell.rooms.some(room => room.id === 'new-room')).toBe(true);
  expect(h.document.querySelector('.ca-side').textContent).toContain('New team channel');
  expect(h.app._chatEls.input.value).toBe('unfinished message');
  expect(h.shell.view).toBe('chat');
  h.dom.window.close();
});

it('browser Back returns from a debug session to the full conversation shell', async () => {
  const h = await createHarness({ sessions, rooms: fixtureRooms() });
  h.shell.showDebug(A);
  h.window.history.replaceState({}, '', '/');
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  await settle(100);
  expect(h.shell.view).toBe('chat');
  expect(h.document.querySelector('#chatApp').hidden).toBe(false);
  expect(h.document.querySelector('.ca-side').textContent).toContain('General');
  h.dom.window.close();
});

it('previews shared workspace artifacts on ordinary click with a download fallback, including inline code but excluding fenced code', async () => {
  const path = '/reverie_workspace/projects/example/clip.mp4';
  const h = await createHarness({ sessions, rooms: [room('r1', 'Office', [member(A, 'alpha')], { messages: [message('video', 'r1', agent(A, 'alpha'), 'Video: `' + path + '`\n```\n' + path + '\n```', 1000)] })] });
  const links = [...h.document.querySelectorAll('.ca-workspace-download')];
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute('href')).toBe('/api/filesystem/download?path=' + encodeURIComponent(path));
  const preview = vi.fn(async () => {});
  h.app.openWorkspaceFilePreview = preview;
  h.app.activeSessionId = B;
  const click = new h.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
  links[0].dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(preview).toHaveBeenCalledExactlyOnceWith(path, links[0]);
  expect(h.document.querySelector('pre .ca-workspace-download')).toBeNull();
  h.dom.window.close();
});
