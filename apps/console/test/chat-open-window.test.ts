/**
 * Opening a room draws only its newest messages and fetches older ones as the reader scrolls up; coming back to a room
 * draws it from memory at once. Real chatroom-ui.js / chat-app.js against the in-memory chat server.
 */
import { describe, expect, it } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const A = '00000026-002d-4000-8000-00000000003c';
const sessions = [{ id: A, name: 'alpha', mode: 'claude' }];
const many = (id: string, n: number) =>
  Array.from({ length: n }, (_, i) => message(`${id}-m${i}`, id, agent(A, 'alpha'), `text ${i}`, 1000 + i));
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const roomGets = (h: { window: { __server: { calls: Array<{ method: string; path: string; search?: string }> } } }, id: string) =>
  h.window.__server.calls.filter((c) => c.method === 'GET' && c.path === `/api/chatrooms/${id}`).map((c) => c.search);

describe('opening a room', () => {
  it('asks for the newest 50 only and draws just those', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'Big', [member(A, 'alpha')], { messages: many('r1', 180) })] });
    await settle();
    expect(roomGets(h, 'r1')[0]).toBe('?limit=50');
    const drawn = h.document.querySelectorAll('[data-msg-id]').length;
    expect(drawn).toBe(50);
    expect(h.document.body.textContent).toContain('text 179');
    expect(h.document.body.textContent).not.toContain('text 100');
  });

  it('asks for the emotes at the same time as the room, not after it', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'One', [member(A, 'alpha')]), room('r2', 'Two', [member(A, 'alpha')])],
    });
    await settle();
    const app = h.window.app ?? h.app;
    const server = h.window.__server;
    server.calls.length = 0;
    const open = app._chatApp.selectRoom('r2');
    // Both requests are out before either answers.
    const early = server.calls.map((c: { path: string }) => c.path);
    await open;
    expect(early).toContain('/api/chatrooms/r2');
    expect(early).toContain('/api/chatrooms/r2/emotes');
  });
});

describe('scrolling back', () => {
  it('fetches 50 more when the reader reaches the top, and stops at the beginning of the room', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'Big', [member(A, 'alpha')], { messages: many('r1', 120) })] });
    await settle();
    const app = h.window.app ?? h.app;
    await app._loadOlderChat();
    expect(app._chatRoom.messages.length).toBe(100);
    expect(roomGets(h, 'r1')).toContain('?limit=100');
    expect(h.document.querySelectorAll('[data-msg-id]').length).toBe(100);
    await app._loadOlderChat();
    expect(app._chatRoom.messages.length).toBe(120);
    const before = roomGets(h, 'r1').length;
    await app._loadOlderChat();
    expect(roomGets(h, 'r1').length).toBe(before);
  });

  it('never marks the room read', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'Big', [member(A, 'alpha')], { unread: 3, messages: many('r1', 120) })],
    });
    await settle();
    const app = h.window.app ?? h.app;
    await settle(400);
    // jsdom has no layout: put the reader well above the bottom, as a scroll-up leaves them.
    const feed = app._chatEls.feed;
    Object.defineProperty(feed, 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(feed, 'scrollTop', { value: 100, writable: true, configurable: true });
    h.window.__server.calls.length = 0;
    await app._loadOlderChat();
    await settle(400);
    expect(h.window.__server.calls.filter((c: { path: string }) => c.path.endsWith('/read'))).toEqual([]);
  });

  it('a background refresh keeps the older messages the reader already loaded', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'Big', [member(A, 'alpha')], { messages: many('r1', 120) })] });
    await settle();
    const app = h.window.app ?? h.app;
    await app._loadOlderChat();
    await app._loadChatRoom('r1', { quiet: true });
    expect(app._chatRoom.messages.length).toBe(100);
    expect(app._chatRoom.messages[0].id).toBe('r1-m20');
  });

  it('after more than a window arrived, a refresh leaves no gap: only the fresh window stays', async () => {
    const h = await createHarness({ sessions, rooms: [room('r1', 'Big', [member(A, 'alpha')], { messages: many('r1', 120) })] });
    await settle();
    const app = h.window.app ?? h.app;
    await app._loadOlderChat();
    expect(app._chatRoom.messages.length).toBe(100);
    const server = h.window.__server;
    const r1 = server.rooms.find((r: { id: string }) => r.id === 'r1');
    r1.messages.push(...Array.from({ length: 120 }, (_, i) => message(`r1-n${i}`, 'r1', agent(A, 'alpha'), `new ${i}`, 5000 + i)));
    await app._loadChatRoom('r1', { quiet: true });
    const ids = app._chatRoom.messages.map((m: { id: string }) => m.id);
    expect(ids).toEqual(r1.messages.slice(-50).map((m: { id: string }) => m.id));
    expect(app._chatRoom.messageCount).toBe(240);
  });

  it('a few new messages keep what was loaded, joined by id even when timestamps tie at the boundary', async () => {
    const tied = Array.from({ length: 120 }, (_, i) => message(`r1-m${i}`, 'r1', agent(A, 'alpha'), `text ${i}`, 1000 + Math.floor(i / 10)));
    const h = await createHarness({ sessions, rooms: [room('r1', 'Big', [member(A, 'alpha')], { messages: tied })] });
    await settle();
    const app = h.window.app ?? h.app;
    await app._loadOlderChat();
    const server = h.window.__server;
    const r1 = server.rooms.find((r: { id: string }) => r.id === 'r1');
    r1.messages.push(message('r1-x1', 'r1', agent(A, 'alpha'), 'one more', 1011));
    await app._loadChatRoom('r1', { quiet: true });
    const ids = app._chatRoom.messages.map((m: { id: string }) => m.id);
    expect(ids).toEqual(r1.messages.slice(-101).map((m: { id: string }) => m.id));
  });
});

describe('coming back to a room', () => {
  it('a slow refresh of the room you left does not bring you back to it', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'One', [member(A, 'alpha')], { messages: many('r1', 5) }), room('r2', 'Two', [member(A, 'alpha')], { messages: many('r2', 5) })],
    });
    await settle();
    const app = h.window.app ?? h.app;
    await app._chatApp.selectRoom('r2');
    const server = h.window.__server;
    const handle = server.handle;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.handle = async (path: string, opts: unknown) => {
      if (String(path).startsWith('/api/chatrooms/r2?')) await gate;
      return handle(path, opts);
    };
    const refresh = app._loadChatRoom('r2', { quiet: true });
    await app._chatApp.selectRoom('r1');
    release();
    await refresh;
    await settle();
    expect(app._chatRoomId).toBe('r1');
  });

  it('draws it from memory before the refresh answers', async () => {
    const h = await createHarness({
      sessions,
      rooms: [room('r1', 'One', [member(A, 'alpha')], { messages: many('r1', 5) }), room('r2', 'Two', [member(A, 'alpha')], { messages: many('r2', 5) })],
    });
    await settle();
    const app = h.window.app ?? h.app;
    await app._chatApp.selectRoom('r2');
    await app._chatApp.selectRoom('r1');
    const server = h.window.__server;
    server.calls.length = 0;
    const handle = server.handle;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.handle = async (path: string, opts: unknown) => {
      if (String(path).startsWith('/api/chatrooms/r2')) await gate;
      return handle(path, opts);
    };
    h.window.__server.handle = server.handle;
    const back = app._chatApp.selectRoom('r2');
    await settle(20);
    expect(app._chatRoomId).toBe('r2');
    expect(h.document.querySelector('.ca-feed, [data-msg-id]')).not.toBeNull();
    release();
    await back;
  });
});
