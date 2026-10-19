/**
 * A jsdom page that runs the REAL chatroom-ui.js, chat-media.js and chat-app.js against a small
 * in-memory chat server, so the conversation shell is exercised end to end without a browser.
 *
 * `createHarness()` returns { window, document, app, shell, server, flush }. The fake server speaks
 * the same JSON envelope as the real routes for the endpoints the shell uses.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC = resolve(import.meta.dirname, '../../src/web/public');
const read = (name) => readFileSync(resolve(PUBLIC, name), 'utf8');

export function member(sessionId, name, extra = {}) {
  return {
    sessionId,
    name,
    role: 'agent',
    goal: '',
    progress: '',
    joinedAt: 1,
    updatedAt: 1,
    alive: true,
    working: false,
    pendingDeliveries: 0,
    hue: 200,
    mode: 'claude',
    ...extra,
  };
}

export function room(id, name, members, extra = {}) {
  return {
    id,
    name,
    createdAt: 1,
    members,
    messages: [],
    messageCount: 0,
    userReadAt: 0,
    unread: 0,
    mentions: 0,
    ...extra,
  };
}

export function message(id, roomId, from, text, at, extra = {}) {
  return { id, roomId, at, from, to: 'all', text, ...extra };
}

export const agent = (sessionId, name) => ({ kind: 'agent', sessionId, name });
export const user = { kind: 'user', name: 'user' };

/** The fake server: rooms by id, with the handful of routes the shell calls. */
export function createServer(rooms, { features = { unread: true, dms: true, placement: true, replies: true, deletes: true, reports: true, topics: true, edits: true, pins: true, order: true, notify: true, replace: true } } = {}) {
  const state = { rooms: [...rooms], features, calls: [], posts: [], reads: [], clock: 10_000 };
  const find = (id) => state.rooms.find((r) => r.id === id);
  const summary = (r) => ({
    ...r,
    lastMessage: r.messages.at(-1) ?? null,
    lastMessageAt: r.messages.at(-1)?.at,
    messages: undefined,
  });
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  const fail = (status, error) => ({ ok: false, status, json: async () => ({ success: false, error }) });
  state.handle = async (path, opts = {}) => {
    const method = opts.method || 'GET';
    const url = new URL(path, 'http://localhost');
    state.calls.push({ method, path: url.pathname, body: opts.body, search: url.search });
    let m;
    if (url.pathname === '/api/chatrooms/retired' && method === 'GET') {
      return ok({ retired: structuredClone(state.retired || []) });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/retired\/([^/]+)(\/restore)?$/)) && (method === 'POST' || method === 'DELETE')) {
      const id = decodeURIComponent(m[1]);
      (state.retiredCalls ||= []).push({ id, method, restore: !!m[2] });
      state.retired = (state.retired || []).filter((r) => r.sessionId !== id);
      return ok(m[2] ? { rooms: [{ id: 'r1', name: 'General' }] } : { sessionId: id });
    }
    if (method === 'GET' && url.pathname === '/api/chatrooms') {
      return ok(structuredClone({ self: null, ...(state.features ? { features: state.features } : {}), retired: (state.retired || []).map((r) => r.sessionId), rooms: state.rooms.map(summary) }));
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)$/)) && method === 'GET') {
      const r = find(decodeURIComponent(m[1]));
      const limit = Number(url.searchParams.get('limit')) || undefined;
      return r
        ? ok(structuredClone({
            ...r,
            messages: limit ? r.messages.slice(-limit) : r.messages,
            messageCount: r.messages.length,
            coordinatorId: r.members.find((x) => x.role === 'coordinator')?.sessionId,
          }))
        : fail(404, 'No such room');
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages$/)) && method === 'POST') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      state.clock += 10;
      const msg = message(`m${state.clock}`, r.id, user, opts.body.text, state.clock, {
        to: opts.body.to ? opts.body.to : 'all',
        ...(opts.body.replyTo ? { replyTo: opts.body.replyTo } : {}),
      });
      r.messages.push(msg);
      state.posts.push(msg);
      return ok({ message: structuredClone(msg) });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages\/([^/]+)$/)) && method === 'DELETE') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      const at = r.messages.findIndex((x) => x.id === decodeURIComponent(m[2]));
      if (at < 0) return fail(404, 'No such message');
      (state.audit ||= []).push(r.messages[at]);
      const o = r.messages[at];
      r.messages[at] = { id: o.id, roomId: o.roomId, at: o.at, from: o.from, to: o.to, text: '', deleted: { at: 1, by: 'user' } };
      return ok({ id: m[2], deleted: true });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages\/([^/]+)$/)) && method === 'PUT') {
      const r = find(decodeURIComponent(m[1]));
      const o = r?.messages.find((x) => x.id === decodeURIComponent(m[2]));
      if (!o) return fail(404, 'No such message');
      if (state.editError) return fail(400, state.editError);
      (state.edits ||= []).push({ id: o.id, text: opts.body.text });
      o.text = opts.body.text;
      o.edited = { at: state.clock };
      return ok({ id: o.id, text: o.text, edited: o.edited });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages\/([^/]+)\/pin$/)) && (method === 'POST' || method === 'DELETE')) {
      const r = find(decodeURIComponent(m[1]));
      const o = r?.messages.find((x) => x.id === decodeURIComponent(m[2]));
      if (!o) return fail(404, 'No such message');
      (state.pinCalls ||= []).push({ id: o.id, method });
      if (method === 'POST') o.pinned = { at: (state.clock += 10), by: 'user', kind: 'user' };
      else delete o.pinned;
      return ok({ id: o.id, pinned: o.pinned ?? null });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/pins$/)) && method === 'GET') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      return ok({ pins: structuredClone(r.messages.filter((x) => x.pinned && !x.deleted).sort((a, b) => b.pinned.at - a.pinned.at)) });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages\/([^/]+)\/restore$/)) && method === 'POST') {
      const r = find(decodeURIComponent(m[1]));
      const at = r.messages.findIndex((x) => x.id === decodeURIComponent(m[2]));
      const orig = (state.audit || []).find((x) => x.id === decodeURIComponent(m[2]));
      if (at < 0 || !orig) return fail(404, 'No such message');
      r.messages[at] = orig;
      return ok({ id: m[2], deleted: false });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages\/([^/]+)\/report$/)) && method === 'POST') {
      (state.reports ||= []).push({ id: decodeURIComponent(m[2]), body: opts.body });
      return ok({ message: { id: 'rep' } });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/polls$/)) && method === 'POST') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      (state.pollCreates ||= []).push(opts.body);
      if (state.pollCreateError) return fail(400, state.pollCreateError);
      state.clock += 10;
      const msg = message(`m${state.clock}`, r.id, user, opts.body.question, state.clock, {
        poll: {
          question: opts.body.question,
          options: opts.body.options.map((label, i) => ({ id: `o${i + 1}`, label })),
          ...(opts.body.multi ? { multi: true } : {}),
          ...(opts.body.recommended ? { recommended: `o${opts.body.options.indexOf(opts.body.recommended) + 1}` } : {}),
          ...(opts.body.closesAt ? { closesAt: opts.body.closesAt } : {}),
          votes: {},
        },
      });
      r.messages.push(msg);
      return ok({ message: structuredClone(msg) });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages\/([^/]+)\/poll\/(vote|close)$/)) && method === 'POST') {
      const r = find(decodeURIComponent(m[1]));
      const msg = r?.messages.find((x) => x.id === decodeURIComponent(m[2]));
      if (!msg?.poll) return fail(404, 'No such poll');
      (state.pollCalls ||= []).push({ kind: m[3], id: msg.id, body: opts.body });
      if (state.pollError) return fail(409, state.pollError);
      if (m[3] === 'close') msg.poll.closed = { at: 1, by: 'user' };
      else if (opts.body.options.length) msg.poll.votes.user = opts.body.options.map((x) => (/^\d+$/.test(x) ? msg.poll.options[Number(x) - 1].id : x));
      else delete msg.poll.votes.user;
      return ok({ poll: structuredClone(msg.poll) });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/read$/)) && method === 'POST') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      const newest = r.messages.at(-1)?.at ?? r.createdAt;
      r.userReadAt = Math.max(r.userReadAt, Math.min(opts.body?.at ?? newest, newest));
      r.unread = r.messages.filter((x) => x.at > r.userReadAt && x.from.kind === 'agent').length;
      r.mentions = r.messages.filter((x) => x.at > r.userReadAt && x.from.kind === 'agent' && Array.isArray(x.to) && x.to.includes('user')).length;
      state.reads.push({ id: r.id, at: opts.body?.at });
      return ok({ userReadAt: r.userReadAt, unread: r.unread, mentions: r.mentions });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/emotes$/)) && method === 'GET') return ok({ emotes: [] });
    if (url.pathname === '/api/chatrooms' && method === 'POST') {
      const made = room(`new-${state.rooms.length}`, opts.body.name, (opts.body.members || []).map((x) => member(x.sessionId, state.agentName?.(x.sessionId) ?? 'agent', x.voice ? { voice: true } : {})), {});
      state.rooms.push(made);
      state.created = (state.created || []).concat(opts.body);
      return ok(structuredClone(made));
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/members$/)) && method === 'POST') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      (state.invited ||= []).push({ id: r.id, sessionId: opts.body.sessionId });
      r.members.push(member(opts.body.sessionId, state.agentName?.(opts.body.sessionId) ?? 'agent'));
      return ok({ sessionId: opts.body.sessionId });
    }
    if (url.pathname === '/api/chatrooms/order' && method === 'PUT') {
      (state.orderCalls ||= []).push(opts.body.ids);
      opts.body.ids.forEach((id, i) => {
        const r = find(id);
        if (r) r.position = i + 1;
      });
      return ok({ placed: opts.body.ids.length });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/wake$/)) && method === 'PUT') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      (state.wakeCalls ||= []).push(opts.body.mode);
      if (opts.body.mode === 'default') delete r.wake;
      else r.wake = opts.body.mode;
      return ok(structuredClone(r));
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/members\/([^/]+)\/notify$/)) && method === 'PUT') {
      const r = find(decodeURIComponent(m[1]));
      const mem = r?.members.find((x) => x.sessionId === decodeURIComponent(m[2]));
      if (!mem) return fail(404, 'No such member');
      (state.notifyCalls ||= []).push({ id: mem.sessionId, mode: opts.body.mode });
      if (opts.body.mode === 'mentions') mem.notify = 'mentions';
      else delete mem.notify;
      return ok({ member: structuredClone(mem) });
    }
    if (url.pathname === '/api/chatrooms/members/replace' && method === 'POST') {
      (state.replaceCalls ||= []).push(opts.body);
      const moved = state.rooms.filter((r) => r.members.some((x) => x.sessionId === opts.body.from));
      for (const r of moved) for (const x of r.members) if (x.sessionId === opts.body.from) x.sessionId = opts.body.to;
      return ok({ rooms: moved.map((r) => ({ id: r.id, name: r.name })) });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/visibility$/)) && method === 'PUT') {
      const room = state.rooms.find((r) => r.id === m[1]);
      if (!room) return fail(404, 'No chatroom');
      room.visibility = opts.body?.visibility === 'public' ? 'public' : 'private';
      return ok(room);
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)$/)) && method === 'PUT') {
      const r = find(decodeURIComponent(m[1]));
      if (!r) return fail(404, 'No such room');
      if (opts.body.name !== undefined) r.name = opts.body.name;
      if (opts.body.topic !== undefined) r.topic = opts.body.topic || undefined;
      return ok({ ...r });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)$/)) && method === 'DELETE') {
      const at = state.rooms.findIndex((r) => r.id === decodeURIComponent(m[1]));
      if (at < 0) return fail(404, 'No such room');
      state.rooms.splice(at, 1);
      return ok({});
    }
    if ((m = url.pathname.match(/^\/api\/agents\/([^/]+)\/profile$/)) && method === 'GET') {
      const p = state.profiles?.[decodeURIComponent(m[1])];
      return p ? ok(structuredClone(p)) : fail(503, 'The fleet runtime policy is not configured yet');
    }
    if (url.pathname === '/api/workspace-icons' && method === 'GET') return ok({ icons: structuredClone(state.wsIcons || {}) });
    if (url.pathname === '/api/workspace-icons/image' && method === 'PUT') {
      (state.wsIconCalls ||= []).push({ kind: 'put', name: url.searchParams.get('name'), type: opts.headers?.['Content-Type'], size: opts.body?.length });
      if (state.wsIconRefuse) return fail(403, 'Only the owner sets workspace pictures');
      (state.wsIcons ||= {})[url.searchParams.get('name')] = `/api/workspace-icons/${'a'.repeat(32)}?v=${state.clock++}`;
      return ok({ url: state.wsIcons[url.searchParams.get('name')] });
    }
    if (url.pathname === '/api/workspace-icons' && method === 'DELETE') {
      (state.wsIconCalls ||= []).push({ kind: 'delete', name: url.searchParams.get('name') });
      if (state.wsIconRefuse) return fail(403, 'Only the owner sets workspace pictures');
      delete (state.wsIcons ||= {})[url.searchParams.get('name')];
      return ok({});
    }
    if (url.pathname === '/api/workspace-icons/rename' && method === 'POST') {
      (state.wsIconCalls ||= []).push({ kind: 'rename', ...opts.body });
      if (state.wsIconRenameRefuse) return fail(403, 'Only the owner sets workspace pictures');
      const icons = (state.wsIcons ||= {});
      if (icons[opts.body.from] && !icons[opts.body.to]) {
        icons[opts.body.to] = icons[opts.body.from];
        delete icons[opts.body.from];
      }
      return ok({ url: icons[opts.body.to] ?? null });
    }
    if (url.pathname === '/api/company/owner/avatar' && (method === 'POST' || method === 'DELETE')) {
      (state.ownerAvatarCalls ||= []).push({ kind: method === 'POST' ? 'put' : 'delete', type: opts.headers?.['Content-Type'], size: opts.body?.length });
      if (state.ownerAvatarRefuse) return fail(403, 'Only the company owner may configure employees or research');
      state.company = { employees: [], settings: {}, ...(state.company || {}) };
      state.company.settings = { ...state.company.settings };
      if (method === 'POST') state.company.settings.ownerAvatar = `/api/owner-avatar/${'9'.repeat(32)}?v=${state.clock++}`;
      else delete state.company.settings.ownerAvatar;
      return ok({ settings: structuredClone(state.company.settings) });
    }
    if (url.pathname === '/api/company/temporary/prune' && method === 'POST') {
      (state.pruneCalls ||= []).push(true);
      if (state.pruneRefuse) return fail(403, 'Only the company owner may configure employees or research');
      const before = state.company?.temporaryAgents?.length ?? 0;
      if (state.company) state.company.temporaryAgents = (state.company.temporaryAgents || []).filter((t) => !t.gone);
      return ok({ removed: before - (state.company?.temporaryAgents?.length ?? 0) });
    }
    if (url.pathname === '/api/system/stats' && method === 'GET') return ok(structuredClone(state.sysStats || { cpu: 12, memory: { usedMB: 17704, totalMB: 64204, percent: 28 } }));
    if (url.pathname === '/api/system/gpu' && method === 'GET') return ok(structuredClone(state.gpu || { available: false, utilization: null, memoryUsedMb: null, memoryTotalMb: null }));
    if (url.pathname === '/api/plans' && method === 'GET') return ok({ accounts: [], gpu: structuredClone(state.gpu || { available: false, utilization: null, memoryUsedMb: null, memoryTotalMb: null }) });
    if (url.pathname === '/api/company/settings' && method === 'PUT') {
      state.company = { ...(state.company || { employees: [] }), settings: { ...opts.body } };
      return ok({ settings: state.company.settings });
    }
    if (url.pathname === '/api/company' && method === 'GET') return ok(structuredClone(state.company || { employees: [], settings: {} }));
    if (url.pathname === '/api/chatrooms/dms' && method === 'POST') {
      let dm = state.rooms.find((r) => r.kind === 'dm' && r.members.some((x) => x.sessionId === opts.body.sessionId));
      if (!dm) {
        dm = room(`dm-${opts.body.sessionId}`, '', [member(opts.body.sessionId, state.agentName?.(opts.body.sessionId) ?? 'agent')], {
          kind: 'dm',
          dm: ['user', opts.body.sessionId],
        });
        state.rooms.push(dm);
      }
      return ok({ ...dm });
    }
    if ((m = url.pathname.match(/^\/api\/chatrooms\/([^/]+)\/placement$/)) && method === 'PUT') {
      const r = find(decodeURIComponent(m[1]));
      Object.assign(r, opts.body);
      return ok({ ...r });
    }
    return fail(404, `no route ${method} ${url.pathname}`);
  };
  return state;
}

export async function createHarness({
  rooms = [],
  sessions = [],
  features,
  stored = {},
  sessionStored = {},
  hash = '',
  narrow = false,
  loadShell = true,
  approvals = false,
  company,
  viewport,
} = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div class="app" id="legacy"><header id="legacyHeader"><span id="chatroomBadge" hidden>0</span></header><main id="legacyMain">legacy</main><div class="modal" id="appSettingsModal" style="display:block">settings</div></div></body></html>',
    { url: `http://localhost/${hash}`, pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  const { window } = dom;
  const { document } = window;
  for (const [k, v] of Object.entries(stored)) window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(sessionStored)) window.sessionStorage.setItem(k, v);
  window.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  window.HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new window.Event('close'));
  };
  window.Element.prototype.scrollIntoView = () => {};
  window.fetch = () => Promise.resolve({ ok: true });
  window.matchMedia = (q) => ({
    matches: narrow && (q === '(max-width: 767px)' || q === '(max-width: 899px)'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  });
  // The page's own link helper, as constants.js defines it.
  window.CodemanUrlSession = {
    sessionIdFromFragment(h) {
      const id = new URLSearchParams(String(h || '').replace(/^#/, '')).get('session');
      return id && id.trim() ? id.trim() : null;
    },
  };
  // setTimeout is wrapped so a test can run the loader's watchdog without waiting 5 seconds.
  const realSetTimeout = window.setTimeout.bind(window);
  window.__watchdogs = [];
  window.setTimeout = (fn, ms, ...rest) => {
    if (ms === 5000 || ms === 20000) {
      window.__watchdogs.push({ ms, fn });
      return 0;
    }
    return realSetTimeout(fn, ms, ...rest);
  };

  const server = createServer(rooms, { features: features === undefined ? undefined : features });
  if (features === undefined) server.features = { unread: true, dms: true, placement: true, replies: true, deletes: true, reports: true, topics: true, edits: true, pins: true, order: true, notify: true, replace: true };
  if (company) server.company = company;
  window.__server = server;
  // The page's own raw requests (picture uploads) go to the same fake server.
  window.fetch = (path, init = {}) =>
    String(path).startsWith('/api/workspace-icons') || String(path).startsWith('/api/company/owner/avatar')
      ? server.handle(path, { method: init.method, body: init.body, headers: init.headers })
      : Promise.resolve({ ok: true });
  // A phone's visual viewport (jsdom has none): { height, offsetTop } plus resize/scroll listeners the test can fire.
  if (viewport) {
    const vv = new window.EventTarget();
    window.visualViewport = Object.assign(vv, { height: 800, offsetTop: 0 }, viewport);
  }
  window.__approvals = approvals;
  window.eval(`
    class CodemanApp {
      constructor() {
        this.sessions = new Map();
        this.toasts = [];
        this.selected = [];
        this.approvalsToggled = 0;
        this._connectionStatus = 'connected';
        // The app takes a #session= link out of the address bar as it starts.
        this._urlSessionId = window.CodemanUrlSession.sessionIdFromFragment(location.hash);
        if (this._urlSessionId) history.replaceState(null, '', location.pathname);
        this.approvals = new Map();
        this.pendingHooks = new Map();
      }
      // The real app's hook and session-update entry points, reduced to their effect on state; the chat shell wraps these.
      setPendingHook(sessionId, hookType) {
        if (!this.pendingHooks.has(sessionId)) this.pendingHooks.set(sessionId, new Set());
        this.pendingHooks.get(sessionId).add(hookType);
      }
      clearPendingHooks(sessionId, hookType = null) {
        const hooks = this.pendingHooks.get(sessionId);
        if (!hooks) return;
        if (hookType) hooks.delete(hookType);
        else hooks.clear();
        if (hooks.size === 0) this.pendingHooks.delete(sessionId);
      }
      _onSessionUpdated(data) {
        const session = data && data.session;
        if (session && session.id) this.sessions.set(session.id, { ...(this.sessions.get(session.id) || {}), ...session });
      }
      _api(path, opts) { return window.__server.handle(path, opts); }
      showToast(text, kind) { this.toasts.push({ text, kind }); }
      selectSession(id) { this.selected.push(id); }
      openAppSettings() { this.settingsOpened = (this.settingsOpened || 0) + 1; }
      getSessionName(s) { return s.name; }
      setConnectionStatus(s) { this._connectionStatus = s; }
      _chatVoiceTarget() { return null; }
      _bindChatMic() {}
      approvalsInboxEnabled() { return window.__approvals === true; }
      pendingApprovalsCount() { return this.approvals.size; }
      renderApprovals() {}
      toggleApprovalsInbox() { this.approvalsToggled++; }
      handleNotificationAction(action, approvalId, sessionId) {
        // Mirrors approvals-ui.js: a notification opens the drawer, it never answers.
        if (approvalId && this.approvalsInboxEnabled()) {
          this.toggleApprovalsInbox();
          return;
        }
        if (sessionId && this.sessions.has(sessionId)) this.selectSession(sessionId);
      }
      _selectUrlSession() {
        const id = this._urlSessionId;
        if (!id) return false;
        if (!this.sessions.has(id)) return false;
        this.selectSession(id);
        return true;
      }
    }
    window.CodemanApp = CodemanApp;
  `);
  for (const f of ['chatroom-ui.js', 'chat-media.js']) window.eval(read(f));
  window.app = new window.CodemanApp();
  for (const s of sessions) window.app.sessions.set(s.id, s);
  const startShell = async () => {
    window.eval(read('chat-app.js'));
    // caBoot polls for window.app, then starts the shell.
    const deadline = Date.now() + 3000;
    while (!window.reverieChat?.built && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    return window.reverieChat;
  };
  let shell;
  if (loadShell) shell = await startShell();
  const flush = async (ms = 30) => {
    await new Promise((r) => setTimeout(r, ms));
  };
  await flush(80);
  return { window, document, app: window.app, shell, server, flush, dom, startShell };
}
