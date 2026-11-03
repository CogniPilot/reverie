import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';
const A = '00000026-002d-4000-8000-00000000003c';
const session = { id: A, name: 'alpha', mode: 'claude' };
const old = message('old', 'dm', agent(A, 'alpha'), 'HIDDEN OLD DM SENTINEL', 1000);
const makeDm = (extra = {}) =>
  room('dm', '', [member(A, 'alpha')], {
    kind: 'dm',
    dm: ['user', A],
    canClearHistory: true,
    historyAfter: 0,
    messages: [old],
    messageCount: 1,
    ...extra,
  });
const pages: any[] = [];
async function fixture(extra = {}) {
  const h = await createHarness({
    sessions: [session],
    rooms: [makeDm(), room('other', 'Other', [member(A, 'alpha')])],
    ...extra,
  });
  pages.push(h);
  await h.shell.selectRoom('dm');
  return h;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of pages.splice(0)) h.window.close();
});
const changed = (extra = {}) => ({
  action: 'history-cleared',
  roomId: 'dm',
  viewerId: 'owner',
  historyAfter: 1000,
  ...extra,
});
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('owner Clear history', () => {
  it('offers the action only on a capable DM; cancel makes no request', async () => {
    const h = await fixture();
    expect(h.shell.channelEntries(h.app._chatRoom).map((x: any) => x.label)).toContain('Clear history…');
    for (const candidate of [makeDm({ canClearHistory: false }), room('room', 'Channel', [])])
      expect(h.shell.channelEntries(candidate).map((x: any) => x.label)).not.toContain('Clear history…');
    h.shell.clearDmHistory('dm');
    const dlg = h.document.querySelector('dialog[aria-label="Clear direct-message history"]');
    expect(dlg.textContent).toContain('on every device');
    expect(dlg.textContent).toContain('agent memory stay intact');
    expect(h.document.activeElement.textContent).toBe('Cancel');
    dlg.querySelector('[aria-label="Cancel"]').click();
    expect(h.server.calls.some((c: any) => c.path.endsWith('/clear-history'))).toBe(false);
    expect(h.document.body.textContent).toContain(old.text);
  });
  it('confirms once, removes visible history and reply context, and preserves the typed draft', async () => {
    const h = await fixture();
    h.app._chatEls.input.value = 'keep my draft';
    h.shell.startReply(old);
    const original = h.app._chatApi.bind(h.app);
    let clears = 0;
    h.app._chatApi = async (url: string, opts: any) => {
      if (url.endsWith('/clear-history')) {
        clears++;
        return { ok: true, data: makeDm({ messages: [], messageCount: 0, historyAfter: 1000 }) };
      }
      return original(url, opts);
    };
    h.shell.clearDmHistory('dm');
    h.document.querySelector('dialog[aria-label="Clear direct-message history"] [aria-label="Clear history"]').click();
    await h.flush(80);
    expect(clears).toBe(1);
    expect(h.app._chatRoom.messages).toEqual([]);
    expect(h.document.body.textContent).not.toContain(old.text);
    expect(h.app._chatEls.input.value).toBe('keep my draft');
    expect(h.shell.replyTarget()).toBeNull();
    expect(h.server.rooms.find((r: any) => r.id === 'dm').messages[0].text).toBe(old.text);
  });
  it('a rejected clear leaves history and draft intact and shows the error', async () => {
    const h = await fixture();
    h.app._chatEls.input.value = 'draft';
    const original = h.app._chatApi.bind(h.app);
    h.app._chatApi = (url: string, opts: any) =>
      url.endsWith('/clear-history')
        ? Promise.resolve({ ok: false, error: 'synthetic disk failure' })
        : original(url, opts);
    h.shell.clearDmHistory('dm');
    h.document.querySelector('dialog [aria-label="Clear history"]').click();
    await h.flush();
    expect(h.app._chatRoom.messages[0].text).toBe(old.text);
    expect(h.app._chatEls.input.value).toBe('draft');
    expect(h.app.toasts.some((t: any) => t.text.includes('could not be cleared'))).toBe(true);
  });
  it('applies another device clear immediately, closes old pins and refuses stale SSE before voice/feed hooks', async () => {
    const h = await fixture();
    const pins = h.document.createElement('dialog');
    pins.className = 'ca-dialog ca-pins';
    pins.dataset.roomId = 'dm';
    pins.textContent = 'old pin';
    h.document.body.append(pins);
    const voice = vi.fn();
    h.app._readAloudOnMessage = voice;
    h.app._onChatroomChanged(changed());
    expect(h.app._chatRoom.messages).toEqual([]);
    expect(h.document.querySelector('.ca-pins')).toBeNull();
    h.app._onChatroomMessage({ roomId: 'dm', message: old });
    expect(voice).not.toHaveBeenCalled();
    expect(h.app._chatRoom.messages).toEqual([]);
    const fresh = message('fresh', 'dm', agent(A, 'alpha'), 'new message', 1001);
    h.app._onChatroomMessage({ roomId: 'dm', message: fresh });
    expect(h.app._chatRoom.messages.map((m: any) => m.id)).toEqual(['fresh']);
    expect(voice).toHaveBeenCalledOnce();
  });
  it('does not apply a clear from another identity, or to a viewer without the capability', async () => {
    const h = await fixture();
    h.app._chatHistoryChanged(changed({ viewerId: 'another-owner' }));
    expect(h.app._chatRoom.messages).toHaveLength(1);
    h.app._chatRooms.find((r: any) => r.id === 'dm').canClearHistory = false;
    h.app._chatHistoryChanged(changed());
    expect(h.app._chatRoom.messages).toHaveLength(1);
  });
  it('fences an older in-flight room response and scrollback response after a clear', async () => {
    const h = await fixture();
    h.app._chatRoom.messageCount = 10;
    const original = h.app._chatApi.bind(h.app),
      load = deferred(),
      older = deferred();
    let requests = 0;
    h.app._chatApi = (url: string, opts: any) =>
      url.startsWith('/api/chatrooms/dm?') ? (++requests === 1 ? load.promise : older.promise) : original(url, opts);
    const refresh = h.app._loadChatRoom('dm', { quiet: true });
    const scrolling = h.app._loadOlderChat();
    h.app._chatHistoryChanged(changed());
    const stale = { ok: true, data: makeDm() };
    load.resolve(stale);
    older.resolve(structuredClone(stale));
    await Promise.all([refresh, scrolling]);
    expect(h.app._chatRoom.messages).toEqual([]);
    expect(h.document.body.textContent).not.toContain(old.text);
  });
  it('revalidates a cached owner DM before drawing it on reopen, including narrow screens', async () => {
    const h = await fixture({ narrow: true });
    await h.shell.selectRoom('other');
    expect(h.app._chatCache.get('dm').messages).toHaveLength(1);
    const response = deferred(),
      original = h.app._chatApi.bind(h.app);
    h.app._chatApi = (url: string, opts: any) =>
      url.startsWith('/api/chatrooms/dm?') ? response.promise : original(url, opts);
    const open = h.shell.selectRoom('dm');
    await h.flush(5);
    expect(h.document.body.textContent).not.toContain(old.text);
    response.resolve({ ok: true, data: makeDm({ messages: [], messageCount: 0, historyAfter: 1000 }) });
    await open;
    expect(h.app._chatRoom.messages).toEqual([]);
    expect(h.document.body.textContent).not.toContain(old.text);
  });
  it('a reconnect learns a missed clear and replaces its old anchor without a recovery loop', async () => {
    const h = await fixture();
    const original = h.app._chatApi.bind(h.app);
    const fresh = message('new', 'dm', agent(A, 'alpha'), 'new after missed clear', 1001);
    h.app._chatApi = (url: string, opts: any) =>
      url.startsWith('/api/chatrooms/dm?since=')
        ? Promise.resolve({ ok: true, data: makeDm({ historyAfter: 1000, messages: [fresh], messageCount: 1 }) })
        : original(url, opts);
    expect(await h.app._chatBackfill()).toBe(true);
    expect(h.app._chatRoom.messages.map((m: any) => m.id)).toEqual(['new']);
    expect(h.app._chatSynced.get('dm').id).toBe('new');
    expect(h.document.body.textContent).not.toContain(old.text);
  });
  it('keeps the local response fence separate for each owner identity', async () => {
    const h = await fixture();
    h.app._chatHistoryChanged(changed());
    const other = h.app._chatFilterHistory(makeDm({ historyViewerId: 'another-owner' }));
    expect(other.messages).toHaveLength(1);
    expect(other.historyAfter).toBe(0);
  });
});
