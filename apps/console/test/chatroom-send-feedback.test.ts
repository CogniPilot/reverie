/**
 * Your own message shows at once: "Sending…" while the request is out, drawn from the server's answer (with no
 * live echo needed), "Not sent" with Retry on a refusal. A send whose answer was lost is "Not confirmed": nothing on
 * the page can prove it was or was not stored (room posts carry no send id), so it is never confirmed by matching
 * text and never resent by a plain Enter, only by an explicit "Send again". Messages are matched by server id only.
 * After the live stream was down (a reconnect, or the page coming back into view), the open room is brought up to
 * date from the last message PROVED complete (never from a send's answer or a live event), across as many pages as
 * that takes, or it says plainly that it could not; late answers are dropped. A quiet room refresh keeps older held
 * messages only when its window reaches that proved point; otherwise it shows the window alone. A send's answer
 * clears the words and reply only if the composer still holds that whole send (words, reply, tray), and only the
 * files it carried ever leave the tray.
 */
import { describe, expect, it } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const A = 'a1111111-0000-4000-8000-000000000001';
const sessions = [{ id: A, name: 'alpha', mode: 'claude' }];
const rooms = () => [room('r1', 'General', [member(A, 'alpha', { role: 'coordinator' })], { messages: [message('m1', 'r1', agent(A, 'alpha'), 'hello', 1000)] })];
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const you = { kind: 'user', name: 'user' };

type H = Awaited<ReturnType<typeof createHarness>>;
type Opts = { method?: string; body?: { text: string } };
type Msg = { id: string; at: number; text: string; from: { kind: string } };
const isPost = (path: string, opts: Opts = {}) => opts.method === 'POST' && /\/api\/chatrooms\/r1\/messages$/.test(new URL(path, 'http://x').pathname);
const sinceOf = (path: string) => new URL(path, 'http://x').searchParams.get('since');

function send(h: H, text: string) {
  const input = h.document.querySelector('.chatroom-input') as HTMLTextAreaElement;
  input.value = text;
  (h.document.querySelector('.chatroom-composer') as HTMLFormElement).requestSubmit();
  return input;
}
const feed = (h: H) => h.document.querySelector('.chatroom-feed')!;
const pendingRows = (h: H) => [...feed(h).querySelectorAll(':scope > .chatroom-pending')] as HTMLElement[];
const pendingRow = (h: H) => pendingRows(h)[0] ?? null;
const mine = (h: H, text: string) => [...feed(h).querySelectorAll('.ca-msg.is-mine')].filter((n) => n.textContent!.includes(text));
const button = (h: H, cls: string) => pendingRow(h)!.querySelector(`.${cls}`) as HTMLButtonElement;
const recovery = (h: H) => feed(h).querySelector(':scope > .chatroom-recovery') as HTMLElement | null;
const ids = (h: H) => h.app._chatRoom.messages.map((m: Msg) => m.id);

/** The server's own `since`/`limit` rule (chatroom-store.ts messages()): after `since` (exclusive), then the newest `limit`. */
function serveSince(h: H, real: H['server']['handle'], log: string[] = []) {
  return async (path: string, opts: Opts = {}) => {
    const url = new URL(path, 'http://x');
    const m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)$/);
    if ((opts.method || 'GET') === 'GET' && m && url.searchParams.has('since')) {
      log.push(url.search);
      const r = h.server.rooms.find((x: { id: string }) => x.id === m[1]);
      const since = Number(url.searchParams.get('since'));
      const limit = Number(url.searchParams.get('limit')) || 200;
      const after = r.messages.filter((x: Msg) => x.at > since);
      const res = await real(`/api/chatrooms/${m[1]}`, {});
      const body = await res.json();
      body.data.messages = structuredClone(after.slice(Math.max(0, after.length - limit)));
      return { ok: true, status: 200, json: async () => body };
    }
    return real(path, opts);
  };
}

describe('sending: your own message shows at once', () => {
  it('shows "Sending…" while the request is out, then the stored message with no live echo, once', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (isPost(path, opts)) await gate;
      return real(path, opts);
    };
    const input = send(h, 'on my way');
    await settle();
    expect(pendingRow(h)?.textContent).toContain('on my way');
    expect(pendingRow(h)?.textContent).toContain('Sending');
    // The attachment tray's own list (chat-media.js) is a different thing and stays an array.
    expect(Array.isArray(h.app._chatPending)).toBe(true);
    release();
    await settle();
    expect(pendingRow(h)).toBeNull();
    expect(input.value).toBe('');
    expect(mine(h, 'on my way')).toHaveLength(1);
    // The live echo arriving afterwards does not draw it twice.
    h.app._onChatroomMessage({ roomId: 'r1', message: h.server.posts[0] });
    await settle();
    expect(mine(h, 'on my way')).toHaveLength(1);
  });

  it('keeps the "Sending…" row through a feed redraw', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (isPost(path, opts)) await gate;
      return real(path, opts);
    };
    send(h, 'still going');
    await settle();
    h.app._renderChatFeed();
    expect(pendingRow(h)?.textContent).toContain('still going');
    h.app._onChatroomMessage({ roomId: 'r1', message: message('n1', 'r1', agent(A, 'alpha'), 'meanwhile', 20_000) });
    await settle();
    expect(feed(h).lastElementChild).toBe(pendingRow(h));
    release();
    await settle();
    expect(pendingRow(h)).toBeNull();
  });

  it('two identical sends in a row are two messages (matched by id, never by text), each drawn once', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    send(h, 'ok');
    await settle();
    send(h, 'ok');
    await settle();
    expect(h.server.posts).toHaveLength(2);
    expect(h.server.posts[0].id).not.toBe(h.server.posts[1].id);
    expect(mine(h, 'ok')).toHaveLength(2);
    // Both live echoes, in either order, draw nothing more.
    h.app._onChatroomMessage({ roomId: 'r1', message: h.server.posts[1] });
    h.app._onChatroomMessage({ roomId: 'r1', message: h.server.posts[0] });
    await settle();
    expect(mine(h, 'ok')).toHaveLength(2);
    expect(pendingRows(h)).toHaveLength(0);
  });
});

describe('sending: a refusal is "Not sent"', () => {
  it('a refusal shows "Not sent" with Retry, keeps the text, and Retry posts it once', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    let refuse = true;
    const gets = () => h.server.calls.filter((c: { method: string; path: string }) => c.method === 'GET' && c.path === '/api/chatrooms/r1').length;
    const getsBefore = gets();
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (isPost(path, opts) && refuse) return { ok: false, status: 400, json: async () => ({ success: false, error: 'Too long', errorCode: 'INVALID_INPUT' }) };
      return real(path, opts);
    };
    const input = send(h, 'try this');
    await settle();
    expect(pendingRow(h)?.classList.contains('is-failed')).toBe(true);
    expect(pendingRow(h)?.textContent).toContain('Not sent: Too long');
    expect(input.value).toBe('try this');
    expect(h.server.posts).toHaveLength(0);
    // A refusal is an answer: no room reload.
    expect(gets()).toBe(getsBefore);
    refuse = false;
    button(h, 'chatroom-pending-retry').click();
    await settle();
    expect(h.server.posts.map((p: { text: string }) => p.text)).toEqual(['try this']);
    expect(pendingRow(h)).toBeNull();
    expect(mine(h, 'try this')).toHaveLength(1);
  });

  it('Retry with other text in the box puts the failed text back instead of sending', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    let postCount = 0;
    h.server.handle = async (path: string, opts: Opts = {}) =>
      isPost(path, opts) ? (postCount++, { ok: false, status: 400, json: async () => ({ success: false, error: 'No', errorCode: 'INVALID_INPUT' }) }) : real(path, opts);
    const input = send(h, 'first words');
    await settle();
    input.value = 'something else';
    button(h, 'chatroom-pending-retry').click();
    await settle();
    expect(input.value).toBe('first words');
    expect(postCount).toBe(1);
  });

  it('only a documented refusal (status and error code together) is "Not sent"; every other answer is "Not confirmed"', async () => {
    const answers: Array<[string, unknown, string]> = [
      ['403 FORBIDDEN', { ok: false, status: 403, json: async () => ({ success: false, error: 'Not a member', errorCode: 'FORBIDDEN' }) }, 'failed'],
      ['404 NOT_FOUND', { ok: false, status: 404, json: async () => ({ success: false, error: 'Gone', errorCode: 'NOT_FOUND' }) }, 'failed'],
      ['409 CONFLICT', { ok: false, status: 409, json: async () => ({ success: false, error: 'Archived', errorCode: 'CONFLICT' }) }, 'failed'],
      ['400 without its code', { ok: false, status: 400, json: async () => ({ success: false, error: 'Bad' }) }, 'unconfirmed'],
      ['400 with another code', { ok: false, status: 400, json: async () => ({ success: false, error: 'Bad', errorCode: 'CONFLICT' }) }, 'unconfirmed'],
      ['400 not JSON', { ok: false, status: 400, json: async () => { throw new Error('html'); } }, 'unconfirmed'],
      ['408 timeout', { ok: false, status: 408, json: async () => ({ success: false, error: 'Timeout', errorCode: 'INVALID_INPUT' }) }, 'unconfirmed'],
      ['422', { ok: false, status: 422, json: async () => ({ success: false, error: 'No', errorCode: 'INVALID_INPUT' }) }, 'unconfirmed'],
      ['429', { ok: false, status: 429, json: async () => ({ success: false, error: 'Slow down' }) }, 'unconfirmed'],
      ['500', { ok: false, status: 500, json: async () => ({ success: false, error: 'Boom', errorCode: 'INVALID_INPUT' }) }, 'unconfirmed'],
      ['200 without the message', { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }, 'unconfirmed'],
      ['200 not JSON', { ok: true, status: 200, json: async () => { throw new Error('html'); } }, 'unconfirmed'],
    ];
    for (const [name, answer, state] of answers) {
      const h = await createHarness({ sessions, rooms: rooms() });
      const real = serveSince(h, h.server.handle);
      h.server.handle = async (path: string, opts: Opts = {}) => (isPost(path, opts) ? answer : real(path, opts));
      const input = send(h, `case ${name}`);
      await settle(60);
      expect(pendingRow(h)?.classList.contains(`is-${state}`), name).toBe(true);
      expect(input.value, name).toBe(`case ${name}`);
      expect(!!button(h, 'chatroom-pending-retry'), name).toBe(state === 'failed');
      expect(!!button(h, 'chatroom-pending-again'), name).toBe(state === 'unconfirmed');
    }
  });
});

describe('sending: a lost answer is "Not confirmed"', () => {
  it('stored but unanswered: stays Not confirmed with the text kept; the catch-up draws it once by id; Enter never resends', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    const since: string[] = [];
    const base = serveSince(h, real, since);
    let lose = true;
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (isPost(path, opts) && lose) {
        await real(path, opts); // stored ...
        return null; // ... but the answer never arrived (the page reads that as "Network error")
      }
      return base(path, opts);
    };
    const input = send(h, 'did it land');
    await settle(80);
    expect(h.server.posts).toHaveLength(1);
    expect(pendingRow(h)?.classList.contains('is-unconfirmed')).toBe(true);
    expect(pendingRow(h)?.textContent).toContain('Not confirmed: Network error');
    expect(input.value).toBe('did it land');
    // The room was brought up to date (after the last message held), so the stored message shows, once.
    expect(since).toHaveLength(1);
    expect(mine(h, 'did it land')).toHaveLength(1);
    // Enter with the same words is not a resend.
    send(h, 'did it land');
    await settle();
    expect(h.server.posts).toHaveLength(1);
    expect(pendingRow(h)?.textContent).toContain('Enter does not send it again');
    // "Send again" is the explicit choice: one more post.
    lose = false;
    button(h, 'chatroom-pending-again').click();
    await settle();
    expect(h.server.posts).toHaveLength(2);
    expect(mine(h, 'did it land')).toHaveLength(2);
    expect(pendingRows(h)).toHaveLength(0);
    expect(input.value).toBe('');
  });

  it('an earlier identical message never confirms it, and a server error (5xx) is not a refusal', async () => {
    const rs = rooms();
    rs[0].messages.push(message('old', 'r1', you, 'ok', 5000));
    const h = await createHarness({ sessions, rooms: rs });
    const real = h.server.handle;
    let posts = 0;
    h.server.handle = serveSince(h, async (path: string, opts: Opts = {}) =>
      isPost(path, opts) ? (posts++, { ok: false, status: 502, json: async () => ({ success: false, error: 'Bad gateway' }) }) : real(path, opts)
    );
    const input = send(h, 'ok');
    await settle(80);
    expect(posts).toBe(1);
    expect(pendingRow(h)?.classList.contains('is-unconfirmed')).toBe(true);
    expect(pendingRow(h)?.textContent).toContain('Not confirmed: Bad gateway');
    expect(input.value).toBe('ok');
    expect(button(h, 'chatroom-pending-retry')).toBeNull();
    // Dismiss is the reader's call; afterwards Enter sends normally.
    button(h, 'chatroom-pending-dismiss').click();
    expect(pendingRows(h)).toHaveLength(0);
    expect(input.value).toBe('ok');
  });

  it('a delayed commit after the catch-up: the late live event draws it once, and nothing is posted again', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    const base = serveSince(h, real);
    h.server.handle = async (path: string, opts: Opts = {}) => (isPost(path, opts) ? null : base(path, opts));
    send(h, 'slow one');
    await settle(80);
    // The catch-up ran before the server committed it: not there yet.
    expect(mine(h, 'slow one')).toHaveLength(0);
    expect(pendingRow(h)?.classList.contains('is-unconfirmed')).toBe(true);
    // It commits now, and its event arrives (twice, as after a reconnect replay): drawn once, by id.
    const late = message('late1', 'r1', you, 'slow one', 90_000);
    h.server.rooms[0].messages.push(late);
    h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(late) });
    h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(late) });
    await settle();
    expect(feed(h).querySelectorAll('[data-msg-id="late1"]')).toHaveLength(1);
    // Its row is still the reader's to settle: same words prove nothing.
    expect(pendingRow(h)?.classList.contains('is-unconfirmed')).toBe(true);
    expect(h.server.posts).toHaveLength(0);
    // A later catch-up does not draw it again.
    await h.app._chatBackfill();
    await settle();
    expect(feed(h).querySelectorAll('[data-msg-id="late1"]')).toHaveLength(1);
  });
});

describe('catching up after the live stream was down', () => {
  it('every time the stream (re)opens, it asks for what came after the last message proved complete and draws it', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const since: string[] = [];
    h.server.handle = serveSince(h, h.server.handle, since);
    // The page was already connected when the chat shell was installed: no memory of earlier opens is needed.
    expect(h.app._connectionStatus).toBe('connected');
    h.app.setConnectionStatus('connecting');
    h.app.setConnectionStatus('connected'); // an open: one small request, nothing missed
    await settle();
    h.app.setConnectionStatus('connected'); // already connected: nothing
    await settle();
    expect(since).toEqual(['?since=999&limit=200']);
    since.length = 0;
    // Posted while the stream was down: no event reaches the page.
    h.app.setConnectionStatus('reconnecting');
    h.server.rooms[0].messages.push(message('missed', 'r1', agent(A, 'alpha'), 'you missed me', 30_000));
    h.app.setConnectionStatus('connecting');
    h.app.setConnectionStatus('connected');
    await settle(80);
    expect(since).toEqual(['?since=999&limit=200']);
    expect(feed(h).querySelectorAll('[data-msg-id="missed"]')).toHaveLength(1);
  });

  it('more than a page missed: widens until it reaches the last message proved complete, with no gap and no duplicate', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const since: string[] = [];
    h.server.handle = serveSince(h, h.server.handle, since);
    for (let i = 0; i < 450; i++) h.server.rooms[0].messages.push(message(`x${i}`, 'r1', agent(A, 'alpha'), `n${i}`, 2000 + i));
    // The newest of them arrived live before the catch-up: that proves nothing about the 449 before it.
    h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(h.server.rooms[0].messages.at(-1)) });
    await settle();
    // So it starts from m1: 450 newer than it, so 200 does not reach it and 800 does.
    expect(await h.app._chatBackfill()).toBe(true);
    await settle();
    expect(since).toEqual(['?since=999&limit=200', '?since=999&limit=800']);
    const got = ids(h);
    expect(got).toEqual(['m1', ...Array.from({ length: 450 }, (_, i) => `x${i}`)]);
    expect(new Set(got).size).toBe(got.length);
    expect(feed(h).querySelectorAll('[data-msg-id="x0"]')).toHaveLength(1);
    expect(feed(h).querySelectorAll('[data-msg-id="x449"]')).toHaveLength(1);
    // The joined catch-up proved everything up to x449: the next one starts there.
    since.length = 0;
    expect(await h.app._chatBackfill()).toBe(true);
    expect(since).toEqual(['?since=2448&limit=200']);
  });

  it('keeps a message drawn live while the catch-up was out, after the missed ones and only once', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = serveSince(h, h.server.handle);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (sinceOf(path)) await gate;
      return real(path, opts);
    };
    h.server.rooms[0].messages.push(message('gap1', 'r1', agent(A, 'alpha'), 'missed one', 3000));
    const run = h.app._chatBackfill();
    await settle();
    const live = message('live1', 'r1', agent(A, 'alpha'), 'just now', 4000);
    h.server.rooms[0].messages.push(live);
    h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(live) });
    release();
    await run;
    await settle();
    expect(h.app._chatRoom.messages.map((m: Msg) => m.id)).toEqual(['m1', 'gap1', 'live1']);
    expect(feed(h).querySelectorAll('[data-msg-id="live1"]')).toHaveLength(1);
  });

  it('drops a late answer: after a room switch, and when a newer catch-up has started', async () => {
    const rs = rooms();
    rs.push(room('r2', 'Other', [member(A, 'alpha')], { messages: [message('o1', 'r2', agent(A, 'alpha'), 'other room', 1500)] }));
    const h = await createHarness({ sessions, rooms: rs });
    const real = serveSince(h, h.server.handle);
    const gates: Array<() => void> = [];
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (sinceOf(path)) await new Promise<void>((r) => gates.push(r));
      return real(path, opts);
    };
    h.server.rooms[0].messages.push(message('late-r1', 'r1', agent(A, 'alpha'), 'for r1 only', 3000));
    // A newer catch-up wins over an older one still out.
    const older = h.app._chatBackfill();
    const newer = h.app._chatBackfill();
    await settle();
    gates[1]();
    expect(await newer).toBe(true);
    gates[0]();
    expect(await older).toBe(false);
    expect(feed(h).querySelectorAll('[data-msg-id="late-r1"]')).toHaveLength(1);
    // A catch-up for r1 that answers after the reader moved to r2 changes nothing there.
    h.server.rooms[0].messages.push(message('late-r1b', 'r1', agent(A, 'alpha'), 'also r1', 3100));
    const stale = h.app._chatBackfill();
    await settle();
    await h.app._loadChatRoom('r2');
    await settle();
    gates[2]();
    expect(await stale).toBe(false);
    expect(h.app._chatRoomId).toBe('r2');
    expect(h.app._chatRoom.messages.map((m: Msg) => m.id)).toEqual(['o1']);
  });

  it('coming back into view: a stream quiet past its heartbeat reconnects; a live one just catches up', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const since: string[] = [];
    h.server.handle = serveSince(h, h.server.handle, since);
    let reconnects = 0;
    h.app.connectSSE = () => {
      reconnects++;
    };
    h.app.setConnectionStatus('connected');
    const show = () => {
      Object.defineProperty(h.document, 'visibilityState', { value: 'visible', configurable: true });
      h.document.dispatchEvent(new h.window.Event('visibilitychange'));
    };
    h.app._sseLastMessageAt = Date.now() - 60_000; // no frame (not even a heartbeat) for a minute
    show();
    await settle();
    expect(reconnects).toBe(1);
    expect(since).toHaveLength(0); // the reconnect brings the room up to date when it connects
    h.app._sseLastMessageAt = Date.now() - 2_000; // heartbeats arriving: the stream is alive
    h.server.rooms[0].messages.push(message('while-away', 'r1', agent(A, 'alpha'), 'while you were away', 5000));
    show();
    await settle(80);
    expect(reconnects).toBe(1);
    expect(since).toHaveLength(1);
    expect(feed(h).querySelectorAll('[data-msg-id="while-away"]')).toHaveLength(1);
  });

  it('missed messages sharing the last held message’s millisecond come back, before and after it, once', async () => {
    const rs = rooms();
    rs[0].messages = [message('s0', 'r1', agent(A, 'alpha'), 'same ms, stored first', 1000), ...rs[0].messages];
    const h = await createHarness({ sessions, rooms: rs });
    h.server.handle = serveSince(h, h.server.handle);
    h.app._chatRoom.messages = h.app._chatRoom.messages.filter((m: Msg) => m.id === 'm1'); // s0 never reached the page
    h.server.rooms[0].messages.push(message('s2', 'r1', agent(A, 'alpha'), 'same ms, stored after', 1000));
    expect(await h.app._chatBackfill()).toBe(true);
    expect(ids(h)).toEqual(['s0', 'm1', 's2']);
    expect(recovery(h)).toBeNull();
  });

  it('messages arriving between widening rounds: no gap, no duplicate, the live ones once', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = serveSince(h, h.server.handle);
    const room1 = h.server.rooms[0];
    for (let i = 0; i < 300; i++) room1.messages.push(message(`a${i}`, 'r1', agent(A, 'alpha'), `a${i}`, 2000 + i));
    let round = 0;
    h.server.handle = async (path: string, opts: Opts = {}) => {
      const res = await real(path, opts);
      if (sinceOf(path) && ++round === 1) {
        // While the first (too narrow) page is on its way back, 60 more arrive; the last 2 also reach the page live.
        for (let i = 0; i < 60; i++) room1.messages.push(message(`b${i}`, 'r1', agent(A, 'alpha'), `b${i}`, 5000 + i));
        for (const m of room1.messages.slice(-2)) h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(m) });
      }
      return res;
    };
    expect(await h.app._chatBackfill()).toBe(true);
    expect(round).toBe(2);
    expect(ids(h)).toEqual(room1.messages.map((m: Msg) => m.id));
    expect(feed(h).querySelectorAll('[data-msg-id="b59"]')).toHaveLength(1);
    expect(recovery(h)).toBeNull();
  });

  it('the last held message is gone from the room: says catching up did not finish, keeps saying so, until Reload room', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    h.server.handle = serveSince(h, h.server.handle);
    h.server.rooms[0].messages = [message('n1', 'r1', agent(A, 'alpha'), 'after a purge', 7000)];
    const before = ids(h);
    expect(await h.app._chatBackfill()).toBe(false);
    expect(ids(h)).toEqual(before); // nothing is joined on as if it followed on
    expect(recovery(h)?.textContent).toContain('Catching up did not finish');
    expect(recovery(h)?.textContent).toContain('may be missing');
    // A redraw, a new live message and a later catch-up do not hide it: the gap is still there.
    h.app._renderChatFeed();
    h.app._onChatroomMessage({ roomId: 'r1', message: message('n2', 'r1', agent(A, 'alpha'), 'new', 8000) });
    await settle();
    expect(recovery(h)).not.toBeNull();
    // Only a fresh reload of the room clears it.
    (recovery(h)!.querySelector('.chatroom-recovery-reload') as HTMLButtonElement).click();
    await settle(80);
    expect(recovery(h)).toBeNull();
    expect(ids(h)).toEqual(['n1']);
  });

  it('a failed catch-up request, and one that makes no progress up to its work bound, say it did not finish', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    const asked: string[] = [];
    let mode = 'fail';
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (!sinceOf(path)) return real(path, opts);
      asked.push(new URL(path, 'http://x').search);
      if (mode === 'fail') return { ok: false, status: 503, json: async () => ({ success: false, error: 'Unavailable' }) };
      // Nonprogress: every page is full, and none reaches back to the last held message.
      const limit = Number(new URL(path, 'http://x').searchParams.get('limit'));
      const body = await (await real('/api/chatrooms/r1', {})).json();
      body.data.messages = Array.from({ length: limit }, (_, i) => message(`f${i}`, 'r1', agent(A, 'alpha'), `f${i}`, 9000 + i));
      return { ok: true, status: 200, json: async () => body };
    };
    const before = ids(h);
    expect(await h.app._chatBackfill()).toBe(false);
    expect(recovery(h)?.textContent).toContain('Unavailable');
    expect(ids(h)).toEqual(before);
    mode = 'full';
    asked.length = 0;
    expect(await h.app._chatBackfill()).toBe(false);
    expect(asked).toEqual(['?since=999&limit=200', '?since=999&limit=800', '?since=999&limit=3200']);
    expect(recovery(h)?.textContent).toContain('too many messages');
    expect(ids(h)).toEqual(before);
  });

  it('drops a catch-up whose room changed owner while it was out, and one for a room the reader left', async () => {
    const rs = rooms();
    rs.push(room('r2', 'Other', [member(A, 'alpha')], { messages: [message('o1', 'r2', agent(A, 'alpha'), 'other room', 1500)] }));
    const h = await createHarness({ sessions, rooms: rs });
    const real = serveSince(h, h.server.handle);
    const gates: Array<() => void> = [];
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (sinceOf(path)) await new Promise<void>((r) => gates.push(r));
      return real(path, opts);
    };
    h.server.rooms[0].messages.push(message('x1', 'r1', agent(A, 'alpha'), 'r1 only', 3000));
    h.app._chatRoom.owner = 'owner-a';
    const run = h.app._chatBackfill();
    await settle();
    h.app._chatRoom.owner = 'owner-b';
    gates[0]();
    expect(await run).toBe(false);
    expect(ids(h)).not.toContain('x1');
    expect(recovery(h)).toBeNull();
    // Failing late for a room the reader has left shows nothing in the room now open.
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (sinceOf(path)) {
        await new Promise<void>((r) => gates.push(r));
        return null;
      }
      return real(path, opts);
    };
    const stale = h.app._chatBackfill();
    await settle();
    await h.app._loadChatRoom('r2');
    await settle();
    gates[1]();
    expect(await stale).toBe(false);
    expect(h.app._chatRoomId).toBe('r2');
    expect(recovery(h)).toBeNull();
    expect(h.app._chatRecovery ?? null).toBeNull();
  });

  it('K1: a confirmed send and a live event shown past an unseen message do not hide it; the catch-up puts it in place', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const since: string[] = [];
    h.server.handle = serveSince(h, h.server.handle, since);
    // The stream is quietly dead: this one is stored, and its event never arrives.
    h.server.rooms[0].messages.push(message('unseen', 'r1', agent(A, 'alpha'), 'never streamed', 2000));
    send(h, 'my post'); // its answer draws it
    await settle();
    const live = message('later', 'r1', agent(A, 'alpha'), 'after mine', 20_000);
    h.server.rooms[0].messages.push(live);
    h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(live) }); // one isolated event gets through
    await settle();
    expect(ids(h)).not.toContain('unseen');
    expect(await h.app._chatBackfill()).toBe(true);
    expect(since).toEqual(['?since=999&limit=200']); // from m1, the last message proved complete
    expect(ids(h)).toEqual(h.server.rooms[0].messages.map((m: Msg) => m.id));
    expect(ids(h)).toEqual(['m1', 'unseen', h.server.posts[0].id, 'later']);
    expect(feed(h).querySelectorAll(`[data-msg-id="${h.server.posts[0].id}"]`)).toHaveLength(1);
    expect(recovery(h)).toBeNull();
  });

  it('K2: a room that was empty catches up from its empty start: the whole room, or says it did not finish', async () => {
    const rs = rooms();
    rs[0].messages = [];
    const h = await createHarness({ sessions, rooms: rs });
    const since: string[] = [];
    h.server.handle = serveSince(h, h.server.handle, since);
    expect(ids(h)).toEqual([]);
    for (let i = 0; i < 120; i++) h.server.rooms[0].messages.push(message(`e${i}`, 'r1', agent(A, 'alpha'), `e${i}`, 2000 + i));
    expect(await h.app._chatBackfill()).toBe(true);
    expect(since).toEqual(['?since=0&limit=200']);
    expect(ids(h)).toEqual(Array.from({ length: 120 }, (_, i) => `e${i}`));
    expect(recovery(h)).toBeNull();
    // Too many from the empty start: widens to the bound, then says so, and nothing is joined on.
    const h2 = await createHarness({ sessions, rooms: (() => { const r = rooms(); r[0].messages = []; return r; })() });
    const since2: string[] = [];
    h2.server.handle = serveSince(h2, h2.server.handle, since2);
    for (let i = 0; i < 3300; i++) h2.server.rooms[0].messages.push(message(`g${i}`, 'r1', agent(A, 'alpha'), `g${i}`, 2000 + i));
    expect(await h2.app._chatBackfill()).toBe(false);
    expect(since2).toEqual(['?since=0&limit=200', '?since=0&limit=800', '?since=0&limit=3200']);
    expect(ids(h2)).toEqual([]);
    expect(recovery(h2)?.textContent).toContain('too many messages');
  });

  it('K3: an answer that arrives after the reader moved on never clears their draft; the send still settles', async () => {
    const rs = rooms();
    rs.push(room('r2', 'Other', [member(A, 'alpha')], { messages: [message('o1', 'r2', agent(A, 'alpha'), 'other room', 1500)] }));
    const h = await createHarness({ sessions, rooms: rs });
    const real = h.server.handle;
    const gates: Array<() => void> = [];
    h.server.handle = async (path: string, opts: Opts = {}) => {
      if (opts.method === 'POST' && /\/api\/chatrooms\/r[12]\/messages$/.test(path)) await new Promise<void>((r) => gates.push(r));
      return real(path, opts);
    };
    // Another room: the draft there survives r1's late answer.
    h.app._chatPending = [{ id: 'f1', state: 'ready' }];
    const input = send(h, 'from r1');
    await settle();
    await h.app._loadChatRoom('r2');
    await settle();
    input.value = 'my r2 draft';
    h.app._chatPending = [...h.app._chatPending, { id: 'f2', state: 'ready' }];
    gates[0]();
    await settle();
    expect(input.value).toBe('my r2 draft');
    expect(h.app._chatPending.map((p: { id: string }) => p.id)).toEqual(['f2']); // only the sent file left the tray
    expect((h.app._chatOwnSends || []).filter((p: { roomId: string }) => p.roomId === 'r1')).toHaveLength(0); // settled
    expect(h.server.posts.map((p: { text: string }) => p.text)).toEqual(['from r1']);
    // Same room, but the box now holds new words: they stay.
    h.app._chatPending = [];
    send(h, 'first r2');
    await settle();
    input.value = 'second thought';
    gates[1]();
    await settle();
    expect(input.value).toBe('second thought');
    expect(mine(h, 'first r2')).toHaveLength(1);
    expect(pendingRows(h)).toHaveLength(0);
    // Unchanged: cleared as before.
    send(h, 'third');
    await settle();
    gates[2]();
    await settle();
    expect(input.value).toBe('');
    expect(h.server.posts.map((p: { text: string }) => p.text)).toEqual(['from r1', 'first r2', 'third']);
  });

  it('K1 (quiet refresh): a window that does not reach the last message proved complete replaces what was held, with no gap', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const since: string[] = [];
    h.server.handle = serveSince(h, h.server.handle, since);
    // 120 stored while the stream was down; only the newest one's event gets through.
    for (let i = 0; i < 120; i++) h.server.rooms[0].messages.push(message(`n${i}`, 'r1', agent(A, 'alpha'), `gap ${i}`, 2000 + i));
    h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(h.server.rooms[0].messages.at(-1)) });
    await settle();
    expect(ids(h)).toEqual(['m1', 'n119']);
    // The newest window (50) holds n119, which was drawn live, but not m1, the last message proved complete:
    // keeping m1 in front of it would hide n0..n69, so only the window stays (older ones load on scroll).
    expect(await h.app._loadChatRoom('r1', { quiet: true })).toBe(true);
    expect(ids(h)).toEqual(Array.from({ length: 50 }, (_, i) => `n${70 + i}`));
    expect(feed(h).querySelector('[data-msg-id="m1"]')).toBeNull();
    expect(h.app._chatSynced.get('r1')).toEqual({ id: 'n119', at: 2119 });
    expect(await h.app._chatBackfill()).toBe(true);
    expect(since).toEqual(['?since=2118&limit=200']);
    expect(ids(h)).toEqual(Array.from({ length: 50 }, (_, i) => `n${70 + i}`));
    expect(recovery(h)).toBeNull();
  });

  it('K1 (quiet refresh): messages scrolled back to stay when the window holds the last message proved complete', async () => {
    const rs = rooms();
    rs[0].messages = Array.from({ length: 100 }, (_, i) => message(`p${i}`, 'r1', agent(A, 'alpha'), `p${i}`, 1000 + i));
    const h = await createHarness({ sessions, rooms: rs });
    expect(ids(h)).toEqual(Array.from({ length: 50 }, (_, i) => `p${50 + i}`));
    await h.app._loadOlderChat();
    expect(ids(h)).toHaveLength(100);
    for (let i = 0; i < 10; i++) h.server.rooms[0].messages.push(message(`q${i}`, 'r1', agent(A, 'alpha'), `q${i}`, 3000 + i));
    expect(await h.app._loadChatRoom('r1', { quiet: true })).toBe(true);
    expect(ids(h)).toEqual(h.server.rooms[0].messages.map((m: Msg) => m.id));
    expect(h.app._chatSynced.get('r1')).toEqual({ id: 'q9', at: 3009 });
  });

  it('K1 (quiet refresh): a rebase with nothing new still takes the dropped messages off the screen', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    // 60 arrive, each drawn live: all are held, but none of them moves the last message proved complete (m1).
    for (let i = 0; i < 60; i++) {
      const m = message(`n${i}`, 'r1', agent(A, 'alpha'), `n${i}`, 2000 + i);
      h.server.rooms[0].messages.push(m);
      h.app._onChatroomMessage({ roomId: 'r1', message: structuredClone(m) });
    }
    await settle();
    expect(feed(h).querySelector('[data-msg-id="m1"]')).not.toBeNull();
    expect(await h.app._loadChatRoom('r1', { quiet: true })).toBe(true);
    expect(ids(h)).toEqual(Array.from({ length: 50 }, (_, i) => `n${10 + i}`));
    expect(feed(h).querySelector('[data-msg-id="m1"]')).toBeNull();
    expect(feed(h).querySelector('[data-msg-id="n9"]')).toBeNull();
    expect(feed(h).querySelectorAll('[data-msg-id="n10"]')).toHaveLength(1);
  });

  it('K3 (whole draft): a file added or removed while the send was out keeps the draft; only the sent files leave the tray', async () => {
    const h = await createHarness({ sessions, rooms: rooms() });
    const real = h.server.handle;
    const gates: Array<() => void> = [];
    const sentFiles: unknown[] = [];
    h.server.handle = async (path: string, opts: Opts & { body?: { attachments?: string[] } } = {}) => {
      if (isPost(path, opts)) {
        sentFiles.push(opts.body?.attachments);
        await new Promise<void>((r) => gates.push(r));
      }
      return real(path, opts);
    };
    // The same words, and a new file added: the words and the new file stay.
    h.app._chatPending = [{ id: 'sent-1', name: 'old.txt', state: 'ready' }];
    const input = send(h, 'same text');
    await settle();
    h.app._chatPending.push({ id: 'new-1', name: 'new.txt', state: 'ready' });
    h.app._renderChatTray();
    gates[0]();
    await settle();
    expect(input.value).toBe('same text');
    expect(h.app._chatPending.map((p: { id: string }) => p.id)).toEqual(['new-1']);
    expect(pendingRows(h)).toHaveLength(0);
    // The same words, and a failed upload removed from the tray: still a different draft, so the words stay.
    const failed = { id: null, name: 'bad.txt', state: 'failed' };
    h.app._chatPending = [{ id: 'sent-2', name: 'a.txt', state: 'ready' }, failed];
    send(h, 'again text');
    await settle();
    h.app._chatPending.splice(1, 1);
    gates[1]();
    await settle();
    expect(input.value).toBe('again text');
    expect(h.app._chatPending).toEqual([]);
    // Unchanged as a whole: the words clear, and an unsent item (the failed upload) stays in the tray.
    h.app._chatPending = [{ id: 'sent-3', name: 'b.txt', state: 'ready' }, failed];
    send(h, 'last text');
    await settle();
    gates[2]();
    await settle();
    expect(input.value).toBe('');
    expect(h.app._chatPending).toEqual([failed]);
    expect(h.server.posts.map((p: { text: string }) => p.text)).toEqual(['same text', 'again text', 'last text']);
    expect(sentFiles).toEqual([['sent-1'], ['sent-2'], ['sent-3']]);
  });
});
