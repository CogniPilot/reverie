/**
 * @fileoverview Chatroom panel: talk with an appointed coordinator session and the
 * agent sessions it directs, and watch them talk to each other.
 *
 * A right-side drawer built on first open. It shows one room at a time: the
 * member cards (role, live state, goal and progress synopsis), the message feed
 * (room-wide and direct messages alike, so the user sees every exchange), and a
 * composer whose "To" picker sends to everyone, the coordinator, or one agent.
 * The server delivers messages into member panes (chatroom-delivery.ts); this
 * module only reads and posts through `/api/chatrooms`.
 *
 * Everything user- or agent-supplied is rendered with textContent.
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency app.js, api-client.js (_api), constants.js (SSE_EVENTS)
 * @loadorder 12.1 (after session-ui.js)
 */

/** Keyboard dictation owns phone text entry; Car mode remains a separate action.
 * Use device hints rather than viewport width, so rotation keeps the policy and
 * a narrow desktop window retains its microphone. No keyboard-brand detection. */
function chatPhoneComposer(nav) {
  return nav?.userAgentData?.mobile === true || /Android|iPhone|iPod/i.test(nav?.userAgent || '');
}

const CHAT_MIN_WIDTH = 320;
/** Client trace lines kept for "Send diagnostics". */
const CHAT_DIAG_LINES = 300;

/** A room opens on its newest messages only; older ones load as the reader scrolls up, this many more at a time. */
const CHAT_OPEN_LIMIT = 50;
/** Scrolling within this many px of the top asks for older messages. */
const CHAT_OLDER_TRIGGER_PX = 240;
/**
 * Bringing the open room up to date after the live stream was down: messages after the last one held, this many at
 * first. The server answers with the newest `limit` after `since`, so a page that does not reach back to the last
 * held message is widened (x4) until it does, at most this many times; past that the fresh window replaces the feed.
 */
const CHAT_BACKFILL_LIMIT = 200;
const CHAT_BACKFILL_ROUNDS = 3;
/** The server's live stream heartbeats every 15 s: quieter than this when the page comes back means the stream is likely dead. */
const CHAT_STREAM_QUIET_MS = 20000;
/**
 * The only answers to a room post that prove nothing was stored: the status and the error code together. Each is
 * thrown before the message is committed (chatroom-routes.ts POST /api/chatrooms/:id/messages: body validation,
 * roomOrFail, forbid, attachments, /roll; chatroom-store.ts post(): every check comes before messages.push), and
 * nothing after the commit maps to them (delivery throws plain errors, which answer 500; push errors are caught).
 * Anything else (408, 5xx, another 4xx, an answer without its JSON error code, an OK without the stored message)
 * leaves the send "Not confirmed".
 */
const CHAT_SEND_REFUSALS = { 400: 'INVALID_INPUT', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' };

/** A visual viewport this much shorter than the layout viewport means an on-screen keyboard. */
const CHAT_KEYBOARD_MIN_PX = 120;

/**
 * Pure: how many CSS pixels at the bottom of the layout viewport the on-screen keyboard
 * covers. Android Chrome shrinks only the VISUAL viewport for the keyboard, so a
 * `position: fixed; bottom: 0` panel ends up behind it.
 */
function chatKeyboardInset(layoutHeight, viewport) {
  if (!viewport || !Number.isFinite(viewport.height)) return 0;
  const covered = layoutHeight - (viewport.height + (viewport.offsetTop || 0));
  return covered > 0 ? Math.round(covered) : 0;
}
const CHAT_LAYOUTS = ['overlay', 'dock', 'full'];
/** Below this viewport width a docked chat would squeeze the terminal to nothing. */
const CHAT_DOCK_MIN_VIEWPORT = 900;

Object.assign(ReverieApp.prototype, {
  /** fetch + envelope unwrap that keeps the server's error message. */
  async _chatApi(path, opts = {}) {
    const res = await this._api(path, opts);
    if (!res) return { ok: false, error: 'Network error' };
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (res.ok && body?.success !== false) return { ok: true, data: body?.data ?? body };
    return { ok: false, status: res.status, errorCode: body?.errorCode, error: body?.error || `HTTP ${res.status}` };
  },

  _chatEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  },

  _chatAgo(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },

  /** Employees share their profile hue; unbound sessions retain the server's FNV-1a accent. */
  _chatAccent(sessionId) {
    const employees = this._chatApp?.company?.employees;
    const matches = Array.isArray(employees) ? employees.filter(employee => employee?.sessionId === sessionId && typeof employee.id === 'string' && employee.id) : [];
    if (matches.length === 1) return this._chatHue(matches[0].id);
    let h = 2166136261;
    for (let i = 0; i < sessionId.length; i++) {
      h ^= sessionId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 360;
  },

  /** First letter after the "wN-case: " prefix: "w4-testcase: orchestrator" gives "O", "w1-rumoca: PR: 430" gives "P". */
  _chatInitial(name) {
    const parts = String(name || '?').split(': ');
    const label = parts[1] || parts[0];
    const ch = label.match(/[\p{L}\p{N}]/u)?.[0] || '?';
    return ch.toUpperCase();
  },

  _chatMember(sessionId) {
    return sessionId ? this._chatRoom?.members.find((m) => m.sessionId === sessionId) : undefined;
  },

  /**
   * The member's phone-style alert mode as a monochrome phone outline: ring,
   * vibrate (only a direct mention or the owner wakes it), silent (only the owner's @mention or @everyone).
   * The server sends `alertMode: {mode, until}` with unexpired modes only; an absent, unknown
   * or already-expired mode reads as ring, so a stale page never shows a member muted.
   */
  _chatAlertBadge(m, className) {
    const labels = { ring: 'Ring', vibrate: 'Vibrate', silent: 'Silent' };
    const a = m?.alertMode;
    const until = Number(a?.until);
    const live = a && Object.hasOwn(labels, a.mode) && a.mode !== 'ring' && Number.isFinite(until) && until > Date.now();
    const mode = live ? a.mode : 'ring';
    const label = labels[mode];
    let title = label;
    if (live) {
      const et = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: globalThis.ReverieTime?.timeZone || 'UTC', ...opts });
      const day = (t) => et({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
      const time = et({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(until);
      const when = day(until) === day(Date.now()) ? time : `${et({ weekday: 'short' }).format(until)} ${time}`;
      title = `${label} until ${when}${a.mode === 'vibrate' ? ' (wakes on a direct @mention or the owner)' : ' (only an owner @mention or @everyone wakes it)'}`;
    }
    const badge = this._chatEl('span', className);
    badge.style.cssText = 'display:inline-flex;vertical-align:middle;margin-left:4px;color:var(--text-muted,#919aa6);width:16px;height:16px;flex-shrink:0';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const phone = document.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({ x: '8', y: '4', width: '8', height: '16', rx: '2' })) phone.setAttribute(key, value);
    const detail = document.createElementNS(ns, 'path');
    detail.setAttribute('d', mode === 'silent' ? 'M3 3l18 18' : mode === 'vibrate' ? 'M4 6L2 9l2 3-2 3 2 3M20 6l2 3-2 3 2 3-2 3' : 'M4 7a9 9 0 0 0 0 10M20 7a9 9 0 0 1 0 10');
    svg.append(phone, detail);
    badge.append(svg);
    badge.title = title;
    badge.setAttribute('aria-label', title);
    badge.dataset.alertMode = live ? a.mode : 'ring';
    return badge;
  },

  /** Discord-style avatar: the member's icon, else its initial, on its accent colour. */
  _chatAvatar(sessionId, name, { size = 'md', state } = {}) {
    const member = this._chatMember(sessionId);
    const icon = member?.icon;
    const el = this._chatEl('span', `chatroom-avatar chatroom-avatar--${size}${icon ? ' has-icon' : ''}`);
    el.style.setProperty('--chat-hue', sessionId ? this._chatAccent(sessionId) : 200);
    el.setAttribute('aria-hidden', 'true');
    el.append(this._chatEl('span', 'chatroom-avatar-glyph', icon || this._chatInitial(name)));
    if (state) {
      const dot = this._chatEl('span', `chatroom-dot chatroom-dot--${state}`);
      dot.title = { needs: 'needs your approval', waiting: 'waiting for input', gone: 'offline' }[state] || state;
      el.append(dot);
    }
    return el;
  },

  _chatHue(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  },

  isChatroomOpen() {
    return !!this._chatroomPanel && !this._chatroomPanel.hidden;
  },

  toggleChatroom() {
    if (this.isChatroomOpen()) this.closeChatroom();
    else this.openChatroom();
  },

  async openChatroom(roomId) {
    this._buildChatroomPanel();
    this._chatroomPanel.hidden = false;
    const build = this._chatroomPanel.querySelector('.chatroom-build');
    if (build) build.textContent = `build ${(this._pageBuildId || '?').slice(0, 8)}`;
    this._diag('panel:open', { innerHeight: window.innerHeight, vv: window.visualViewport?.height });
    this._applyChatLayout();
    this._fitChatToKeyboard();
    document.querySelector('.btn-chatroom')?.setAttribute('aria-expanded', 'true');
    this._chatUnread = 0;
    this._renderChatBadge();
    await this._loadChatRooms(roomId);
    // Closed while the rooms were loading: no poll to arm.
    if (!this.isChatroomOpen()) return;
    clearInterval(this._chatPoll);
    // Member live state (working / idle) changes without a chatroom event.
    this._chatPoll = setInterval(() => {
      if (this.isChatroomOpen() && this._chatRoomId) this._loadChatRoom(this._chatRoomId, { quiet: true });
    }, 5000);
    this._chatroomPanel.querySelector('.chatroom-input')?.focus();
  },

  /**
   * Lift the panel's bottom edge above the on-screen keyboard and, while it is up, fold
   * away the member list and header extras so the feed, the To menu, the mic and the
   * input share what is left. Docked mode lives in the page flow and needs none of it.
   */
  // ─── Diagnostics (phone bugs only a real device shows) ───────────────────────

  /** Append one timestamped event to the client trace (last CHAT_DIAG_LINES kept). */
  _diag(kind, data) {
    const lines = (this._diagLines ||= []);
    let detail = '';
    try {
      detail = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    } catch {
      detail = ' (unserializable)';
    }
    lines.push(`${(performance.now() / 1000).toFixed(3)} ${kind}${detail}`.slice(0, 1900));
    if (lines.length > CHAT_DIAG_LINES) lines.splice(0, lines.length - CHAT_DIAG_LINES);
  },

  /** The ONE audio element replies play on, created with every media event traced. */
  _chatAudioEl() {
    if (this._chatAudio) return this._chatAudio;
    const audio = new Audio();
    for (const type of [
      'play',
      'playing',
      'pause',
      'ended',
      'error',
      'abort',
      'emptied',
      'stalled',
      'waiting',
      'suspend',
      'loadedmetadata',
    ]) {
      audio.addEventListener(type, () =>
        this._diag(`audio:${type}`, {
          t: Number(audio.currentTime.toFixed(2)),
          dur: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(2)) : null,
          src: String(audio.src).slice(-40),
          err: audio.error ? audio.error.code : undefined,
        })
      );
    }
    this._chatAudio = audio;
    return audio;
  },

  async sendChatDiagnostics() {
    const engine = this._voiceEngineInfo?.();
    if (engine) this.showToast?.(`Voice engine: ${engine.engine}. ${engine.reason}`, 'info');
    const vv = window.visualViewport;
    const meta = {
      buildId: this._pageBuildId || null,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      visualViewport: vv ? { height: vv.height, width: vv.width, offsetTop: vv.offsetTop, scale: vv.scale } : null,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches || false,
      carEngine: this._carEngine || null,
      voiceEngine: this._voiceEngineInfo?.() || null,
      carState: this._car?.state || null,
      speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      voices: (window.speechSynthesis?.getVoices?.() || []).length,
      // English voice names and languages only, so car-mode voice choices can be checked.
      englishVoices: (window.speechSynthesis?.getVoices?.() || [])
        .filter((v) => /^en[-_]/i.test(v.lang || ''))
        .slice(0, 60)
        .map((v) => `${String(v.name).slice(0, 80)} (${String(v.lang).slice(0, 16)})`),
    };
    const res = await this._chatApi('/api/voice/diag', {
      method: 'POST',
      body: { meta, lines: this._diagLines || [] },
    });
    const result = res.ok ? `Diagnostics saved: ${res.data.file}` : `Diagnostics failed: ${res.error}`;
    const text = engine ? `Engine: ${engine.engine}. ${engine.reason}. ${result}` : result;
    this.showToast?.(text, res.ok ? 'success' : 'error');
    this._chatVoiceStatus(text, res.ok ? '' : 'error');
    if (this._carScreen && !this._carScreen.hidden) this._renderCarState?.(this._car?.state || 'paused', text);
    return res.ok ? res.data.file : null;
  },

  _fitChatToKeyboard() {
    const panel = this._chatroomPanel;
    if (!panel || panel.hidden) return;
    const docked = panel.classList.contains('chatroom-panel--dock');
    const vv = window.visualViewport;
    const inset = docked ? 0 : chatKeyboardInset(window.innerHeight, vv);
    const open = inset >= CHAT_KEYBOARD_MIN_PX;
    panel.style.bottom = open ? `${inset}px` : '';
    const reading = `${window.innerHeight}|${vv?.height}|${vv?.offsetTop}|${inset}`;
    if (reading !== this._diagLastViewport) {
      this._diagLastViewport = reading;
      const send = this._chatEls.send.getBoundingClientRect();
      this._diag('viewport', {
        innerHeight: window.innerHeight,
        vvHeight: vv ? Math.round(vv.height) : null,
        vvTop: vv ? Math.round(vv.offsetTop) : null,
        inset,
        keyboard: open,
        sendBottom: Math.round(send.bottom),
        panelBottom: Math.round(panel.getBoundingClientRect().bottom),
      });
    }
    const was = panel.classList.contains('chatroom-panel--keyboard');
    panel.classList.toggle('chatroom-panel--keyboard', open);
    // One line of input while the keyboard is up: the long hint would only wrap.
    this._chatEls.input.placeholder = open ? 'Message' : 'Message the room (Enter to send, Shift+Enter for a new line)';
    if (open && !was) {
      const { feed } = this._chatEls;
      requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
    }
  },

  closeChatroom() {
    if (!this.isChatroomOpen()) return;
    this._chatroomPanel.hidden = true;
    this._chatroomPanel.style.bottom = '';
    this._chatroomPanel.classList.remove('chatroom-panel--keyboard');
    clearInterval(this._chatPoll);
    this._chatPoll = null;
    document.querySelector('.btn-chatroom')?.setAttribute('aria-expanded', 'false');
  },

  _renderChatBadge() {
    const badge = document.getElementById('chatroomBadge');
    if (!badge) return;
    badge.hidden = !this._chatUnread;
    badge.textContent = this._chatUnread > 99 ? '99+' : String(this._chatUnread || 0);
  },

  _buildChatroomPanel() {
    if (this._chatroomPanel) return;
    const panel = this._chatEl('aside', 'chatroom-panel');
    panel.id = 'chatroomPanel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Chatroom');

    const head = this._chatEl('div', 'chatroom-head');
    const title = this._chatEl('span', 'chatroom-title', 'Chat');
    const select = this._chatEl('select', 'chatroom-select');
    select.setAttribute('aria-label', 'Chatroom');
    select.onchange = () => {
      if (select.value === '__new') {
        select.value = this._chatRoomId || '';
        this._showChatCreate();
      } else this._loadChatRoom(select.value);
    };
    const menuBtn = this._chatEl('button', 'chatroom-icon-btn', '⋯');
    menuBtn.type = 'button';
    menuBtn.title = 'Room actions';
    menuBtn.setAttribute('aria-label', 'Room actions');
    menuBtn.onclick = (e) => this._toggleChatRoomMenu(e);
    const close = this._chatEl('button', 'chatroom-icon-btn', '×');
    close.type = 'button';
    close.title = 'Close chat';
    close.setAttribute('aria-label', 'Close chat');
    close.onclick = () => this.closeChatroom();
    const layoutBtn = (mode, glyph, label) => {
      const b = this._chatEl('button', 'chatroom-icon-btn chatroom-layout-btn', glyph);
      b.type = 'button';
      b.dataset.mode = mode;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => this.setChatroomLayout(this._chatLayout === mode ? 'overlay' : mode);
      return b;
    };
    const dock = layoutBtn('dock', '\u21E5', 'Dock beside the terminals (they shrink to fit)');
    const full = layoutBtn('full', '\u26F6', 'Full screen');
    head.append(title, select, dock, full, menuBtn, close);

    const members = this._chatEl('section', 'chatroom-members');
    members.setAttribute('aria-label', 'Members');
    const feed = this._chatEl('div', 'chatroom-feed');
    feed.setAttribute('role', 'log');
    feed.setAttribute('aria-live', 'polite');
    feed.setAttribute('data-i18n-skip', '');

    const composer = this._chatEl('form', 'chatroom-composer');
    const to = this._chatEl('select', 'chatroom-to');
    to.setAttribute('aria-label', 'Send to');
    const input = this._chatEl('textarea', 'chatroom-input');
    input.rows = 2;
    input.placeholder = 'Message the room (Enter to send, Shift+Enter for a new line)';
    input.setAttribute('aria-label', 'Message');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        composer.requestSubmit();
      }
    });
    const send = this._chatEl('button', 'chatroom-send', 'Send');
    send.type = 'submit';
    const row = this._chatEl('div', 'chatroom-composer-row');
    const mic = this._chatEl('button', 'chatroom-mic', '\u{1F3A4}');
    mic.type = 'button';
    mic.hidden = true;
    mic.title = 'Hold to talk (or tap to start, tap again to send)';
    mic.setAttribute('aria-label', 'Push to talk');
    mic.setAttribute('aria-pressed', 'false');
    this._bindChatMic(mic);
    const voiceStatus = this._chatEl('div', 'chatroom-voice-status');
    voiceStatus.setAttribute('role', 'status');
    voiceStatus.hidden = true;
    to.addEventListener('change', () => this._syncChatMic());
    row.append(to, mic, send);
    composer.append(voiceStatus, input, row);
    composer.onsubmit = (e) => {
      e.preventDefault();
      this._sendChatMessage();
    };

    const empty = this._chatEl('div', 'chatroom-empty');
    // Footer: which build this page runs, and the diagnostics upload for phone bugs.
    const foot = this._chatEl('div', 'chatroom-foot');
    const build = this._chatEl('span', 'chatroom-build', `build ${(this._pageBuildId || '?').slice(0, 8)}`);
    build.title = 'The dashboard build this page is running';
    const diag = this._chatEl('button', 'chatroom-link chatroom-diag', 'Send diagnostics');
    diag.type = 'button';
    diag.title = 'Upload the recent voice, audio and keyboard events so the problem can be traced';
    diag.onclick = () => this.sendChatDiagnostics();
    foot.append(build, diag);
    panel.append(head, members, feed, composer, empty, foot);
    panel.prepend(this._chatResizeHandle(panel));
    let saved = 0;
    try {
      saved = Number(localStorage.getItem('reverie:chatroomWidth')) || 0;
    } catch {
      /* per-device convenience only */
    }
    if (saved) this._setChatWidth(panel, saved);
    document.body.append(panel);
    this._chatroomPanel = panel;
    window.addEventListener('resize', () => {
      if (this.isChatroomOpen()) this._applyChatLayout();
    });
    // Keep the composer, the To menu and the mic above an on-screen keyboard.
    const vv = window.visualViewport;
    if (vv) {
      const fit = () => this._fitChatToKeyboard();
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
    }
    this._chatEls = { select, members, feed, composer, to, input, send, empty, mic, voiceStatus };
    // Hands-free listening on a computer (hands-free.js): its toggle sits after the mic.
    this._buildHandsFree?.(mic);
    // Emoji, attachments and their drop/paste handling (chat-media.js).
    this._buildChatMedia?.(panel);
  },

  /**
   * Layout: `overlay` (a drawer over the page), `dock` (a column inside <main>, so
   * the terminal or tile grid beside it shrinks and refits through its own
   * ResizeObserver) or `full` (covers everything below the header). Per device.
   */
  setChatroomLayout(mode) {
    this._chatLayout = CHAT_LAYOUTS.includes(mode) ? mode : 'overlay';
    try {
      localStorage.setItem('reverie:chatroomLayout', this._chatLayout);
    } catch {
      /* per-device convenience only */
    }
    this._applyChatLayout();
  },

  _applyChatLayout() {
    const panel = this._chatroomPanel;
    if (!panel) return;
    if (!this._chatLayout) {
      try {
        this._chatLayout = localStorage.getItem('reverie:chatroomLayout') || 'overlay';
      } catch {
        this._chatLayout = 'overlay';
      }
    }
    let mode = CHAT_LAYOUTS.includes(this._chatLayout) ? this._chatLayout : 'overlay';
    const main = document.querySelector('main.main');
    // Too narrow to share the row: fall back to the drawer.
    if (mode === 'dock' && (!main || window.innerWidth < CHAT_DOCK_MIN_VIEWPORT)) mode = 'overlay';
    panel.classList.toggle('chatroom-panel--dock', mode === 'dock');
    panel.classList.toggle('chatroom-panel--full', mode === 'full');
    const host = mode === 'dock' ? main : document.body;
    if (panel.parentElement !== host) {
      const focused = panel.contains(document.activeElement) ? document.activeElement : null;
      host.append(panel);
      focused?.focus();
    }
    const header = document.querySelector('header.header');
    panel.style.top = mode === 'dock' ? '' : `${Math.round(header?.getBoundingClientRect().bottom ?? 48)}px`;
    for (const b of panel.querySelectorAll('.chatroom-layout-btn')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }
  },

  _setChatWidth(panel, width) {
    const max = Math.max(CHAT_MIN_WIDTH, window.innerWidth - 120);
    const w = Math.round(Math.min(max, Math.max(CHAT_MIN_WIDTH, width)));
    panel.style.width = `min(${w}px, 100vw)`;
    return w;
  },

  /** Left-edge grip: drag (or Left/Right arrows when focused) to resize; the width is remembered per browser. */
  _chatResizeHandle(panel) {
    const grip = this._chatEl('div', 'chatroom-resize');
    grip.tabIndex = 0;
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', 'Resize chat panel');
    grip.title = 'Drag to resize';
    const save = (w) => {
      try {
        localStorage.setItem('reverie:chatroomWidth', String(w));
      } catch {
        /* per-device convenience only */
      }
    };
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      panel.classList.add('is-resizing');
      let width = panel.getBoundingClientRect().width;
      const move = (ev) => {
        width = this._setChatWidth(panel, window.innerWidth - ev.clientX);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        panel.classList.remove('is-resizing');
        save(width);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = e.shiftKey ? 80 : 20;
      const current = panel.getBoundingClientRect().width;
      save(this._setChatWidth(panel, current + (e.key === 'ArrowLeft' ? step : -step)));
    });
    grip.addEventListener('dblclick', () => {
      panel.style.width = '';
      try {
        localStorage.removeItem('reverie:chatroomWidth');
      } catch {
        /* per-device convenience only */
      }
    });
    return grip;
  },

  /** Repopulate the room picker without changing what the panel shows. */
  _fillChatRoomSelect() {
    const { select } = this._chatEls;
    select.replaceChildren();
    for (const r of this._chatRooms) select.append(new Option(`${r.name} (${r.members.length})`, r.id));
    select.append(new Option('+ New room\u2026', '__new'));
    select.value =
      !this._chatCreating && this._chatRooms.some((r) => r.id === this._chatRoomId) ? this._chatRoomId : '__new';
  },

  async _loadChatRooms(preferId) {
    const res = await this._chatApi('/api/chatrooms');
    if (!res.ok) {
      this.showToast?.(`Chat: ${res.error}`, 'error');
      return;
    }
    this._chatRooms = res.data.rooms || [];
    this._chatSelf = res.data.self || null;
    // What the server can do (unread counts, direct messages): the conversation shell shows only that.
    this._chatFeatures = res.data.features || {};
    this._chatOwnerNames = Array.isArray(res.data.ownerNames) ? res.data.ownerNames : [];
    this._chatRetired = Array.isArray(res.data.retired) ? res.data.retired : [];
    const { select } = this._chatEls;
    this._fillChatRoomSelect();
    // The create form is open: refresh the picker only, never replace the form.
    if (this._chatCreating) return;
    let id = preferId || this._chatRoomId;
    if (!this._chatRooms.some((r) => r.id === id)) {
      try {
        id = localStorage.getItem('reverie:chatroom') || '';
      } catch {
        id = '';
      }
    }
    if (!this._chatRooms.some((r) => r.id === id)) id = this._chatRooms[0]?.id;
    if (id) {
      select.value = id;
      await this._loadChatRoom(id);
    } else {
      this._readAloud?.clear();
      this._chatRoomId = null;
      this._chatRoom = null;
      this._showChatCreate();
    }
  },

  async _loadChatRoom(id, { quiet = false } = {}) {
    // Background refreshes must not close the create form while it is being filled in.
    if (quiet && this._chatCreating) return false;
    if (!quiet) this._chatCreating = false;
    const switching = this._chatRoomId !== id;
    // The latest switch wins: an answer for a room the reader has since left must not bring them back to it.
    const seq = quiet ? this._chatLoadSeq : (this._chatLoadSeq = (this._chatLoadSeq || 0) + 1);
    // Coming back to a room: draw what was last seen at once, then bring it up to date behind it.
    const cached = switching && !quiet ? this._chatCache?.get(id) : undefined;
    if (cached) {
      this._chatEmotes = this._chatEmoteCache?.get(id) || [];
      await this._applyChatRoom(id, cached, { quiet: false, switched: true });
      this._loadChatEmotes?.(id).then(() => this._chatRoomId === id && this._renderChatFeed({ keepScroll: true }));
      this._loadChatRoom(id, { quiet: true });
      return true;
    }
    // The room and its emotes are asked for together; a switch used to wait for one before sending the other.
    const emotes = switching ? this._loadChatEmotes?.(id) : null;
    const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(id)}?limit=${CHAT_OPEN_LIMIT}`);
    if (!res.ok) {
      if (!quiet) this.showToast?.(`Chat: ${res.error}`, 'error');
      return false;
    }
    if (quiet && this._chatCreating) return false;
    if (seq !== this._chatLoadSeq || (quiet && this._chatRoomId !== id)) return false;
    // Older messages the reader already scrolled back to stay; the fresh window only replaces the tail.
    const held = this._chatRoomId === id ? this._chatRoom?.messages || [] : [];
    const fresh = res.data.messages || [];
    // They stay only if the fresh window holds the last message proved complete (`_chatSyncedFrom`): everything held
    // up to it has no gap, so joining at the first held message the window also holds leaves none. A join at any other
    // message proves nothing: one drawn by a send's answer or a live event may sit past messages this page never saw.
    // Otherwise (more than a window arrived since the last look, a phone that slept) only the fresh window is kept,
    // and older messages load again on scroll.
    const cursor = this._chatSynced?.get(id);
    const proved = !!cursor?.id && fresh.some((m) => m.id === cursor.id) && held.some((m) => m.id === cursor.id);
    if (held.length && fresh.length && proved) {
      const freshIds = new Set(fresh.map((m) => m.id));
      const overlap = held.findIndex((m) => freshIds.has(m.id));
      if (overlap > 0) res.data.messages = [...held.slice(0, overlap), ...fresh];
    }
    // Held messages left out (the window was rebased) must leave the screen too, which a quiet refresh would not redraw.
    const ids = new Set((res.data.messages || []).map((m) => m.id));
    const rebased = held.some((m) => !ids.has(m.id));
    await emotes;
    return this._applyChatRoom(id, res.data, { quiet, switched: switching, synced: fresh, redraw: rebased });
  },

  /**
   * The last message up to which the open room's history is PROVED complete: the newest message of a fresh room tail
   * (a load, or a catch-up that joined by id), or the empty start of a room that had no messages. Catching up starts
   * here. A send's answer or a live event never moves it: either may follow messages this page never saw.
   */
  _chatSyncedFrom(id, fresh) {
    const last = fresh.at(-1);
    if (last && (typeof last.id !== 'string' || typeof last.at !== 'number')) return;
    (this._chatSynced ||= new Map()).set(id, last ? { id: last.id, at: last.at } : { id: null, at: 0 });
  },

  /** `synced`: the fresh room tail this data was built from, which moves the proved-complete point (`_chatSyncedFrom`). */
  async _applyChatRoom(id, data, { quiet, switched, synced = null, redraw = false }) {
    // A message gone from the loaded window (deleted) needs the feed redrawn, which a quiet refresh skips.
    const before = this._chatRoom?.messages || [];
    const now = data.messages || [];
    const kept = new Set(now.map((m) => m.id));
    const firstAt = now.length ? now[0].at : Infinity;
    const wasDeleted = new Map(before.map((m) => [m.id, !!m.deleted]));
    const known = new Set(before.map((m) => m.id));
    // A message gone, deleted or restored (another tab did it) redraws the feed; so does one the live stream missed.
    const removed =
      !switched &&
      (before.some((m) => m.at >= firstAt && !kept.has(m.id)) ||
        now.some((m) => wasDeleted.has(m.id) && wasDeleted.get(m.id) !== !!m.deleted) ||
        now.some((m) => !known.has(m.id)));
    // What another room's read-aloud queued is not said here.
    if (this._chatRoomId !== id) this._readAloud?.clear();
    this._chatRoomId = id;
    this._chatRoom = data;
    if (synced) this._chatSyncedFrom(id, synced);
    (this._chatCache ||= new Map()).set(id, data);
    try {
      localStorage.setItem('reverie:chatroom', id);
    } catch {
      /* per-device convenience only */
    }
    this._chatEls.select.value = id;
    this._chatEls.empty.hidden = true;
    this._chatEls.members.hidden = false;
    this._chatEls.feed.hidden = false;
    this._chatEls.composer.hidden = false;
    // A quiet refresh must not wipe a form the user is filling in.
    const busy =
      quiet &&
      (this._chatEls.members.contains(document.activeElement) || this._chatEls.members.querySelector('.chatroom-edit'));
    if (!busy) this._renderChatMembers();
    if (!(quiet && document.activeElement === this._chatEls.to)) this._renderChatTo();
    // An icon change redraws the feed so earlier messages show the new avatar.
    const icons = data.members.map((m) => `${m.sessionId}:${m.icon || ''}`).join('|');
    const iconsChanged = icons !== this._chatIconSig;
    this._chatIconSig = icons;
    if (switched || !quiet || iconsChanged || removed || redraw) this._renderChatFeed({ keepScroll: !switched });
    return true;
  },

  /**
   * The reader is near the top of the loaded messages and the room has more: fetch a longer tail and redraw so the
   * message they were looking at stays where it was. One request at a time; never marks anything read.
   */
  async _loadOlderChat() {
    const id = this._chatRoomId;
    const room = this._chatRoom;
    if (!id || !room || this._chatOlderBusy) return;
    const have = room.messages.length;
    if (have >= (room.messageCount ?? 0)) return;
    this._chatOlderBusy = true;
    try {
      const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(id)}?limit=${have + CHAT_OPEN_LIMIT}`);
      if (!res.ok || this._chatRoomId !== id) return;
      const feed = this._chatEls.feed;
      const fromBottom = feed.scrollHeight - feed.scrollTop;
      // Only the messages grow; the member list and synopses already on screen are left alone.
      room.messages = res.data.messages || room.messages;
      room.messageCount = res.data.messageCount ?? room.messageCount;
      this._renderChatFeed({ keepScroll: true });
      feed.scrollTop = feed.scrollHeight - fromBottom;
    } finally {
      this._chatOlderBusy = false;
    }
  },

  /** Wire the feed's scroll once: reaching the top asks for older messages. */
  _watchChatFeedTop(feed) {
    if (feed._chatTopWatch) return;
    feed._chatTopWatch = true;
    feed.addEventListener(
      'scroll',
      () => {
        if (feed.scrollTop < CHAT_OLDER_TRIGGER_PX) this._loadOlderChat();
      },
      { passive: true }
    );
  },

  _showChatCreate() {
    this._chatCreating = true;
    if (this._chatEls?.select) this._chatEls.select.value = '__new';
    const { empty, members, feed, composer } = this._chatEls;
    members.hidden = true;
    feed.hidden = true;
    composer.hidden = true;
    empty.hidden = false;
    empty.replaceChildren();
    const form = this._chatEl('form', 'chatroom-create');
    form.append(
      this._chatEl('h3', '', 'New chatroom'),
      this._chatEl(
        'p',
        'chatroom-hint',
        'Pick the sessions that should talk, and the one that coordinates them. Each one gets a briefing on how to use the room.'
      )
    );
    const name = this._chatEl('input', 'chatroom-field');
    name.required = true;
    name.maxLength = 80;
    name.placeholder = 'Room name, e.g. Release work';
    name.setAttribute('aria-label', 'Room name');
    const list = this._chatEl('div', 'chatroom-create-list');
    const coordinator = this._chatEl('select', 'chatroom-field');
    coordinator.setAttribute('aria-label', 'Admin');
    coordinator.append(new Option('No admin (I direct them)', ''));
    const sessions = this._chatCandidateSessions(new Set());
    if (!sessions.length)
      list.append(this._chatEl('p', 'chatroom-hint', 'No sessions are open yet. Start some first.'));
    for (const s of sessions) {
      const label = this._chatEl('label', 'chatroom-create-item');
      const box = this._chatEl('input');
      box.type = 'checkbox';
      box.value = s.id;
      const goal = this._chatEl('input', 'chatroom-field chatroom-goal-input');
      goal.placeholder = 'Goal (optional)';
      goal.maxLength = 500;
      goal.setAttribute('aria-label', `Goal for ${s.name}`);
      label.append(
        box,
        this._chatEl('span', 'chatroom-create-name', s.name),
        this._chatEl('span', 'chatroom-mode', s.mode || ''),
        goal
      );
      list.append(label);
      coordinator.append(new Option(s.name, s.id));
    }
    const coordRow = this._chatEl('label', 'chatroom-create-coord');
    coordRow.append(this._chatEl('span', '', 'Admin'), coordinator);
    const error = this._chatEl('p', 'chatroom-error');
    error.setAttribute('role', 'alert');
    const create = this._chatEl('button', 'chatroom-send', 'Create room');
    create.type = 'submit';
    const actions = this._chatEl('div', 'chatroom-composer-row');
    actions.append(create);
    if (this._chatRooms?.length) {
      const cancel = this._chatEl('button', 'chatroom-secondary', 'Cancel');
      cancel.type = 'button';
      cancel.onclick = () => {
        const id = this._chatRoomId || this._chatRooms[0].id;
        // Put the picker back at once, not only when the reload answers.
        this._chatCreating = false;
        this._chatEls.select.value = id;
        // The room may have been deleted while the form was open: reload the list,
        // which picks a room that exists (or shows the form again when none does).
        // Quiet: no "No such chatroom" toast for a room that the list reload replaces anyway.
        this._loadChatRoom(id, { quiet: true }).then((ok) => ok || this._loadChatRooms());
      };
      actions.prepend(cancel);
    }
    form.append(name, this._chatEl('div', 'chatroom-section-label', 'Members'), list, coordRow, error, actions);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const members = [...list.querySelectorAll('.chatroom-create-item')]
        .filter((item) => item.querySelector('input[type=checkbox]').checked)
        .map((item) => {
          const goal = item.querySelector('.chatroom-goal-input').value.trim();
          return { sessionId: item.querySelector('input[type=checkbox]').value, ...(goal ? { goal } : {}) };
        });
      create.disabled = true;
      const res = await this._chatApi('/api/chatrooms', {
        method: 'POST',
        body: {
          name: name.value,
          members: members.filter((m) => m.sessionId !== coordinator.value),
          ...(coordinator.value ? { coordinatorSessionId: coordinator.value } : {}),
        },
      });
      create.disabled = false;
      if (!res.ok) {
        error.textContent = res.error;
        return;
      }
      this._chatCreating = false;
      await this._loadChatRooms(res.data.id);
    };
    empty.append(form);
    name.focus();
  },

  /** Open sessions (in tab order) that are not in `exclude`. */
  _chatCandidateSessions(exclude) {
    const ids = this.sessionOrder?.length ? this.sessionOrder : [...(this.sessions?.keys() || [])];
    return ids
      .map((id) => this.sessions?.get(id))
      .filter((s) => s && !exclude.has(s.id) && !(this._chatRetired || []).includes(s.id))
      .map((s) => ({ id: s.id, name: s.name || s.id.slice(0, 8), mode: s.mode }));
  },

  _renderChatMembers() {
    const room = this._chatRoom;
    const { members } = this._chatEls;
    const open = members.querySelector('details')?.open ?? true;
    members.replaceChildren();
    const details = this._chatEl('details', 'chatroom-members-details');
    details.open = open;
    const coordinator = room.members.find((m) => m.role === 'coordinator');
    const summary = this._chatEl(
      'summary',
      'chatroom-section-label',
      `Members (${room.members.length})${coordinator ? ` · admin: ${coordinator.name}` : ''}`
    );
    details.append(summary);
    const list = this._chatEl('div', 'chatroom-member-list');
    const ordered = [...room.members].sort((a, b) =>
      a.role === 'coordinator' ? -1 : b.role === 'coordinator' ? 1 : 0
    );
    // An old session of someone who is back (same name, now live) is folded away instead of listed as a dead twin.
    const { shown, folded } = this._foldGoneMembers(ordered);
    for (const m of shown) list.append(this._chatMemberCard(m));
    if (folded.length) list.append(this._chatFoldedMembers(folded));
    list.append(this._chatAddMemberRow());
    details.append(list);
    members.append(details);
  },

  /** Splits members into those listed and the gone ones replaced by a live member of the same name. */
  _foldGoneMembers(members) {
    const key = (m) => String(m.name || '').trim().toLowerCase();
    const live = new Set(members.filter((m) => m.alive && key(m)).map(key));
    const shown = [];
    const folded = [];
    for (const m of members) (!m.alive && m.role !== 'coordinator' && live.has(key(m)) ? folded : shown).push(m);
    return { shown, folded };
  },

  _chatFoldedMembers(folded) {
    const details = this._chatEl('details', 'chatroom-members-folded');
    details.append(this._chatEl('summary', 'chatroom-section-label', `Earlier sessions (${folded.length})`));
    for (const m of folded) {
      const row = this._chatEl('div', 'chatroom-member chatroom-member-folded');
      const label = this._chatEl('span', 'chatroom-member-name', `${m.name} \u00B7 ${m.sessionId.slice(0, 8)} \u00B7 offline`);
      const remove = this._chatEl('button', 'chatroom-link', 'Remove');
      remove.type = 'button';
      remove.title = 'Remove this offline session from the room (owner only)';
      remove.onclick = () => this._removeChatMember(m);
      row.append(label, remove);
      details.append(row);
    }
    return details;
  },

  _chatMemberCard(m) {
    const card = this._chatEl('div', `chatroom-member${m.role === 'coordinator' ? ' is-coordinator' : ''}`);
    card.style.setProperty('--chat-hue', this._chatAccent(m.sessionId));
    const top = this._chatEl('div', 'chatroom-member-top');
    const state = !m.alive ? 'gone' : m.working ? 'working' : 'idle';
    const name = this._chatEl('button', 'chatroom-member-name', m.name);
    name.type = 'button';
    name.title = 'Open this session';
    name.onclick = () => this.sessions?.has(m.sessionId) && this.selectSession(m.sessionId);
    top.append(this._chatAvatar(m.sessionId, m.name, { state }), name, this._chatAlertBadge(m, 'chatroom-alert'));
    if (m.role === 'coordinator') top.append(this._chatEl('span', 'chatroom-badge', 'admin'));
    if (m.mode) {
      const account = this._sessionAccountLabel?.(m.sessionId) || '';
      top.append(this._chatEl('span', 'chatroom-mode', [m.mode, account].filter(Boolean).join(' \u00B7 ')));
    }
    if (m.voice) {
      const badge = this._chatEl('span', 'chatroom-badge', '\u{1F3A4} voice');
      badge.title = 'Answers push-to-talk from this room';
      top.append(badge);
    }
    if (m.pendingDeliveries) {
      const q = this._chatEl('span', 'chatroom-queued', `${m.pendingDeliveries} queued`);
      q.title = 'Messages waiting for this session to finish its turn';
      top.append(q);
    }
    const actions = this._chatEl('span', 'chatroom-member-actions');
    const act = (label, title, fn) => {
      const b = this._chatEl('button', 'chatroom-link', label);
      b.type = 'button';
      b.title = title;
      b.onclick = fn;
      actions.append(b);
    };
    act('Edit', 'Edit icon, goal and progress', () => this._editChatSynopsis(card, m));
    if (m.role !== 'coordinator') act('Lead', 'Make admin', () => this._appointChatCoordinator(m.sessionId));
    act('Brief', 'Re-send the how-to-talk briefing to this session', () => this._rebriefChatMember(m.sessionId));
    act(
      m.voice ? 'No voice' : 'Voice',
      m.voice ? 'Stop push-to-talk to this member' : 'Let push-to-talk reach this member',
      () => this._setChatMemberVoice(m.sessionId, !m.voice)
    );
    act('Remove', 'Remove from the room', () => this._removeChatMember(m));
    top.append(actions);
    card.append(top);
    const goal = this._chatEl('div', 'chatroom-synopsis');
    goal.append(this._chatEl('span', 'chatroom-synopsis-key', 'Goal'), this._chatEl('span', '', m.goal || '–'));
    const progress = this._chatEl('div', 'chatroom-synopsis');
    progress.append(
      this._chatEl('span', 'chatroom-synopsis-key', 'Progress'),
      this._chatEl('span', '', m.progress || '–'),
      this._chatEl('span', 'chatroom-ago', m.updatedAt ? ` · ${this._chatAgo(m.updatedAt)}` : '')
    );
    card.append(goal, progress);
    card.setAttribute('data-i18n-skip', '');
    return card;
  },

  _chatAddMemberRow() {
    const row = this._chatEl('form', 'chatroom-add');
    const pick = this._chatEl('select', 'chatroom-field');
    pick.setAttribute('aria-label', 'Session to add');
    pick.append(new Option('Add a session…', ''));
    for (const s of this._chatCandidateSessions(new Set(this._chatRoom.members.map((m) => m.sessionId)))) {
      pick.append(new Option(`${s.name}${s.mode ? ` (${s.mode})` : ''}`, s.id));
    }
    const goal = this._chatEl('input', 'chatroom-field');
    goal.placeholder = 'Goal (optional)';
    goal.maxLength = 500;
    goal.setAttribute('aria-label', 'Goal');
    const add = this._chatEl('button', 'chatroom-secondary', 'Add');
    add.type = 'submit';
    row.append(pick, goal, add);
    row.onsubmit = async (e) => {
      e.preventDefault();
      if (!pick.value) return;
      const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/members`, {
        method: 'POST',
        body: { sessionId: pick.value, ...(goal.value.trim() ? { goal: goal.value.trim() } : {}) },
      });
      if (!res.ok) this.showToast?.(`Chat: ${res.error}`, 'error');
    };
    return row;
  },

  _editChatSynopsis(card, m) {
    if (card.querySelector('.chatroom-edit')) return;
    const form = this._chatEl('form', 'chatroom-edit');
    const goal = this._chatEl('input', 'chatroom-field');
    goal.value = m.goal || '';
    goal.maxLength = 500;
    goal.placeholder = 'Goal';
    goal.setAttribute('aria-label', 'Goal');
    const icon = this._chatEl('input', 'chatroom-field chatroom-icon-input');
    icon.value = m.icon || '';
    icon.maxLength = 16;
    icon.placeholder = '\u{1F642}';
    icon.title = 'Icon: one emoji or up to two characters (empty for the initial)';
    icon.setAttribute('aria-label', 'Icon');
    const progress = this._chatEl('input', 'chatroom-field');
    progress.value = m.progress || '';
    progress.maxLength = 500;
    progress.placeholder = 'Progress';
    progress.setAttribute('aria-label', 'Progress');
    const save = this._chatEl('button', 'chatroom-secondary', 'Save');
    save.type = 'submit';
    const cancel = this._chatEl('button', 'chatroom-link', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => form.remove();
    form.append(icon, goal, progress, save, cancel);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const res = await this._chatApi(
        `/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/members/${encodeURIComponent(m.sessionId)}/status`,
        { method: 'POST', body: { icon: icon.value, goal: goal.value, progress: progress.value } }
      );
      if (!res.ok) this.showToast?.(`Chat: ${res.error}`, 'error');
    };
    card.append(form);
    goal.focus();
  },

  async _setChatMemberVoice(sessionId, voice) {
    const res = await this._chatApi(
      `/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/members/${encodeURIComponent(sessionId)}/status`,
      { method: 'POST', body: { voice } }
    );
    if (!res.ok) this.showToast?.(`Chat: ${res.error}`, 'error');
  },

  async _appointChatCoordinator(sessionId) {
    const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/coordinator`, {
      method: 'POST',
      body: { sessionId },
    });
    if (!res.ok) this.showToast?.(`Chat: ${res.error}`, 'error');
  },

  async _rebriefChatMember(sessionId) {
    const res = await this._chatApi(
      `/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/members/${encodeURIComponent(sessionId)}/brief`,
      { method: 'POST', body: {} }
    );
    if (res.ok) this.showToast?.('Briefing queued', 'info');
    else this.showToast?.(`Chat: ${res.error}`, 'error');
  },

  async _removeChatMember(m) {
    if (!confirm(`Remove ${m.name} from this room?`)) return;
    const res = await this._chatApi(
      `/api/chatrooms/${encodeURIComponent(this._chatRoomId)}/members/${encodeURIComponent(m.sessionId)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) this.showToast?.(`Chat: ${res.error}`, 'error');
  },

  _renderChatTo() {
    const { to } = this._chatEls;
    const previous = to.value;
    const room = this._chatRoom;
    to.replaceChildren(new Option('To: everyone', ''));
    const coordinator = room.members.find((m) => m.role === 'coordinator');
    if (coordinator) to.append(new Option(`To: ${coordinator.name} (admin)`, coordinator.sessionId));
    for (const m of room.members) {
      if (m.role !== 'coordinator') to.append(new Option(`To: ${m.name}`, m.sessionId));
    }
    to.value = [...to.options].some((o) => o.value === previous) ? previous : '';
    this._syncChatMic();
  },

  // ─── Push-to-talk (voice-turn-routes.ts) ────────────────────────────────────

  /**
   * The member the mic talks to: the "To" choice, when it is marked as the room's voice
   * (`member.voice`, set by the user or the coordinator). Never guessed from a name: two
   * sessions sharing a name prefix once sent a spoken turn to the wrong one.
   */
  _chatVoiceTarget() {
    const id = this._chatEls?.to.value;
    const member = id && this._chatRoom?.members.find((m) => m.sessionId === id);
    return member && member.voice === true ? member : null;
  },

  _syncChatMic() {
    const { mic } = this._chatEls;
    const target = this._chatVoiceTarget();
    const route = this._chatMicRoute ? this._chatMicRoute() : target ? 'turn' : null;
    mic.hidden = !route;
    mic.title =
      route === 'turn'
        ? `Talk to ${target.name}: hold, or tap to start and tap again to send`
        : `Dictate to ${this._chatToLabel?.() || 'everyone'}: hold, or tap to start and tap again`;
    mic.dataset.voiceBaseTitle = mic.title;
    this._hfTick?.();
  },

  /** Root-absolute dashboard URL, under a reverse-proxy base path when there is one. */
  _chatUrl(path) {
    return typeof ReverieBase !== 'undefined' && ReverieBase.url ? ReverieBase.url(path) : path;
  },

  _chatVoiceStatus(text, kind = '') {
    const { voiceStatus } = this._chatEls;
    // Car mode's server engine shows the same problems on its big screen.
    if (kind === 'error' && this._carScreen && !this._carScreen.hidden) this._renderCarState?.('paused', text);
    voiceStatus.hidden = !text;
    voiceStatus.textContent = text || '';
    voiceStatus.className = `chatroom-voice-status${kind ? ` chatroom-voice-status--${kind}` : ''}`;
  },

  /**
   * Hold to talk, release to send; a short tap toggles instead (tap, speak, tap). The
   * audio element is unlocked on the press itself, because iOS Safari only lets a page
   * start playback from a user gesture and the reply arrives after a network round trip.
   */
  _bindChatMic(mic) {
    let pressedAt = 0;
    mic.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this._unlockChatAudio();
      if (this._chatRecorder?.state === 'recording' || this._chatDictation) {
        this._stopChatRecording();
        pressedAt = 0;
        return;
      }
      pressedAt = Date.now();
      this._startChatRecording();
    });
    const release = () => {
      // Mobile browsers count the RELEASE of a touch, not the press, as the gesture that
      // may start audio, so unlock here too (a phone otherwise needed a tap on Play).
      this._unlockChatAudio();
      if (!pressedAt) return;
      // A long press is push-to-talk; a short tap leaves it recording until the next tap.
      if (Date.now() - pressedAt >= 350) this._stopChatRecording();
      pressedAt = 0;
    };
    mic.addEventListener('pointerup', release);
    mic.addEventListener('pointercancel', release);
    mic.addEventListener('contextmenu', (e) => e.preventDefault());
  },

  _unlockChatAudio() {
    this._chatAudioEl();
    // Never interrupt a reply that is playing; and once unlocked, stay unlocked.
    if (this._chatAudioUnlocked || (this._chatAudio.src && !this._chatAudio.paused)) return;
    // 50 ms of real silence, same-origin: the page's CSP (default-src 'self', no
    // media-src) blocks data: audio, and an empty WAV fails to decode.
    this._chatAudio.src = this._chatUrl('/silence.wav');
    this._chatAudio.play().then(
      () => (this._chatAudioUnlocked = true),
      () => {}
    );
  },

  async _startChatRecording() {
    // The voice member gets the /turn pipeline; anyone else, dictation (voice-chat.js).
    const route = this._chatMicRoute ? this._chatMicRoute() : this._chatVoiceTarget() ? 'turn' : null;
    if (!route || this._chatRecorder || this._chatDictation) return;
    const target = route === 'turn' ? this._chatVoiceTarget() : null;
    // Talking over her stops her: a reply still playing from the speaker would
    // otherwise be recorded, and her own words would come back as the transcript.
    // (Only a reply: the silent clip the same press just started is the audio unlock.)
    if (this._chatAudio && !this._chatAudio.paused && !this._chatAudio.src.endsWith('/silence.wav')) {
      this._chatAudio.pause();
    }
    this._clearChatAudioRetry?.();
    if (route === 'local') {
      this._startLocalDictation();
      return;
    }
    try {
      // A fresh stream per recording, released when it stops (below): an open capture
      // stream keeps Android in call-style audio mode, which ducks or cuts the reply's
      // playback and leaves the microphone "taken".
      this._chatStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._diag('mic:open', { tracks: this._chatStream.getAudioTracks().length });
    } catch (err) {
      this._chatVoiceStatus(
        window.isSecureContext
          ? `Microphone blocked: ${err?.message || err}`
          : 'The microphone needs HTTPS: open the dashboard through its https:// address',
        'error'
      );
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t));
    const recorder = new MediaRecorder(this._chatStream, type ? { mimeType: type } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      this._chatRecorder = null;
      this._releaseChatMic();
      this._setChatRecording(false);
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      if (blob.size < 1000) {
        this._chatVoiceStatus('Too short: hold the mic while you speak', 'error');
        return;
      }
      if (target) this._sendChatVoice(blob, target);
      else this._transcribeOnServer?.(blob);
    };
    this._chatRecorder = recorder;
    recorder.start();
    this._setChatRecording(true);
    this._chatVoiceStatus(
      `\u25CF Recording for ${target ? target.name : this._chatToLabel?.() || 'everyone'}\u2026 release (or tap) to send`,
      'recording'
    );
  },

  _releaseChatMic() {
    const stream = this._chatStream;
    this._chatStream = null;
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    this._diag('mic:released');
  },

  _stopChatRecording() {
    if (this._chatRecorder?.state === 'recording') this._chatRecorder.stop();
    if (this._chatDictation) this._stopLocalDictation?.();
  },

  /** Recording state on the mic button; voice-chat.js also holds read-aloud meanwhile. */
  _setChatRecording(on) {
    this._chatRecording = on;
    this._readAloud?.mute(on);
    const { mic } = this._chatEls;
    mic.classList.toggle('is-recording', on);
    mic.setAttribute('aria-pressed', String(on));
  },

  async _sendChatVoice(blob, target) {
    // The turn plays this member's answer itself: voice-chat.js leaves it out of read-aloud meanwhile.
    this._chatVoiceTurnFor = target.sessionId;
    try {
      return await this._sendChatVoiceTurn(blob, target);
    } finally {
      if (this._chatVoiceTurnFor === target.sessionId) this._chatVoiceTurnFor = null;
    }
  },

  async _sendChatVoiceTurn(blob, target) {
    this._chatVoiceStatus(`${target.name} is typing\u2026`, 'busy');
    const car = () => this._carScreen && !this._carScreen.hidden;
    // The wait for a linked answer can be long: car mode says whom it waits for, and a tap stops it
    // (the server releases the member when the request goes away; the answer still lands in the room).
    if (car()) this._renderCarState?.('thinking', `Waiting for ${target.name}'s answer`);
    const stop = new AbortController();
    this._chatVoiceTurnStop = stop;
    this._chatVoiceTurnName = target.name;
    const q = `room=${encodeURIComponent(this._chatRoomId)}&member=${encodeURIComponent(target.sessionId)}`;
    let res;
    let body = null;
    try {
      res = await fetch(this._chatUrl(`/api/voice/turn?${q}`), {
        method: 'POST',
        headers: { 'Content-Type': blob.type.split(';')[0] || 'audio/webm' },
        body: blob,
        signal: stop.signal,
      });
      try {
        body = await res.json();
      } catch {
        if (stop.signal.aborted) throw stop.signal.reason;
        /* non-JSON error page */
      }
    } catch {
      if (stop.signal.aborted) {
        this._chatVoiceStatus('');
        if (car()) this._renderCarState?.('paused', `Stopped waiting; ${target.name}'s answer will show in the room`);
      } else this._chatVoiceStatus('Network error: the recording was not sent', 'error');
      return false;
    } finally {
      if (this._chatVoiceTurnStop === stop) this._chatVoiceTurnStop = null;
    }
    if (!res.ok || body?.success === false) {
      this._chatVoiceStatus(body?.error || `Voice failed (HTTP ${res.status})`, 'error');
      return false;
    }
    const data = body?.data || {};
    if (!data.heard) {
      this._chatVoiceStatus("Didn't catch that. Try again, a little closer to the mic.", 'error');
      return false;
    }
    this._chatVoiceStatus('');
    if (data.audioUrl) this._playChatAudio(data.audioUrl, target.sessionId);
    // The answer came but its audio did not (the voice service failed or timed out): say so, never go quiet.
    else if (data.reply)
      this._chatVoiceStatus(`Couldn't make audio for ${target.name}'s answer; its text is in the room`, 'error');
    if (this._carScreen && !this._carScreen.hidden) this._renderCarState('paused', data.reply);
    return true;
  },

  /**
   * A spoken turn's transcript is posted to the room before the wait for the answer: show what
   * was heard while waiting, so a mishearing is seen at once, with a way to stop waiting.
   */
  _chatVoiceTurnHeard(data) {
    const m = data?.message;
    const id = this._chatVoiceTurnFor;
    const stop = this._chatVoiceTurnStop;
    if (!id || !stop || !m?.spoken || m.from?.kind !== 'user' || data.roomId !== this._chatRoomId) return;
    if (!Array.isArray(m.to) || !m.to.includes(id)) return;
    const name = this._chatVoiceTurnName || 'the answer';
    const heard = `\u201C${m.text}\u201D`;
    if (this._carScreen && !this._carScreen.hidden) {
      this._renderCarState?.('thinking', `You said ${heard}. Waiting for ${name}`);
      return;
    }
    const { voiceStatus } = this._chatEls;
    this._chatVoiceStatus(`Heard ${heard}. Waiting for ${name}\u2026 `, 'busy');
    const cancel = this._chatEl('button', 'chatroom-replay', 'Stop waiting');
    cancel.type = 'button';
    cancel.onclick = () => stop.abort();
    voiceStatus.append(cancel);
  },

  /**
   * Play a reply on the ONE reusable element the mic press unlocked. If the browser
   * still refuses (no gesture has unlocked it yet), show a prominent Play button and
   * retry on the very next tap or key anywhere on the page, which is a gesture.
   */
  /** Play a reply; `from` is who is speaking (the car screen shows them). */
  _playChatAudio(url, from = null) {
    this._chatAudioFrom = from;
    this._chatAudioEl();
    const src = this._chatUrl(url);
    this._chatAudio.src = src;
    this._chatAudio.play().then(
      () => {
        this._chatAudioUnlocked = true;
        this._clearChatAudioRetry();
        // A retry button left from an earlier refusal no longer means anything.
        if (this._chatEls.voiceStatus.querySelector('.chatroom-replay--prominent')) this._chatVoiceStatus('');
      },
      (err) => {
        // A newer reply replaced this one before it started: nothing to offer for the old one.
        if (err?.name === 'AbortError' || this._chatAudio.src !== new URL(src, location.href).href) return;
        // Only a refusal for want of a gesture is fixed by a tap; a missing or broken file is not.
        if (err?.name === 'NotAllowedError') this._offerChatAudioRetry(url);
        else this._chatVoiceStatus("Couldn't play the reply; its text is in the room", 'error');
      }
    );
  },

  _offerChatAudioRetry(url) {
    const { voiceStatus, mic } = this._chatEls;
    const from = this._chatAudioFrom;
    this._chatVoiceStatus('');
    voiceStatus.hidden = false;
    voiceStatus.className = 'chatroom-voice-status';
    const play = this._chatEl('button', 'chatroom-replay chatroom-replay--prominent', '\u25B6 Tap to hear the reply');
    play.type = 'button';
    voiceStatus.replaceChildren(play);
    this._clearChatAudioRetry();
    // Any next gesture counts (this button, or anywhere else), except the mic's own: a
    // reply that started playing as a recording begins would be recorded.
    this._chatAudioRetry = (event) => {
      if (mic.contains(event.target) || this._chatRecorder?.state === 'recording') return;
      this._clearChatAudioRetry();
      this._chatVoiceStatus('');
      this._playChatAudio(url, from);
    };
    document.addEventListener('pointerup', this._chatAudioRetry, { capture: true });
    document.addEventListener('keydown', this._chatAudioRetry, { capture: true });
  },

  _clearChatAudioRetry() {
    if (!this._chatAudioRetry) return;
    document.removeEventListener('pointerup', this._chatAudioRetry, { capture: true });
    document.removeEventListener('keydown', this._chatAudioRetry, { capture: true });
    this._chatAudioRetry = null;
  },

  _renderChatFeed({ keepScroll = false } = {}) {
    const { feed } = this._chatEls;
    this._watchChatFeedTop(feed);
    const pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    const top = feed.scrollTop;
    feed.replaceChildren();
    const messages = this._chatRoom?.messages || [];
    if (!messages.length) {
      feed.append(
        this._chatEl(
          'p',
          'chatroom-hint',
          'No messages yet. Say hello: everyone in the room receives it, or pick one member in the To menu.'
        )
      );
    }
    for (const m of messages) feed.append(this._chatMessageEl(m));
    this._chatPendingDraw();
    feed.scrollTop = keepScroll && !pinned ? top : feed.scrollHeight;
  },

  _chatNameOf(id) {
    if (id === 'user') return 'you';
    return this._chatRoom?.members.find((m) => m.sessionId === id)?.name || id.slice(0, 8);
  },

  _chatMessageEl(m) {
    if (m.from.kind === 'system') {
      const el = this._chatEl('div', 'chatroom-msg chatroom-msg--system');
      // Join lines carry the member's id; ones written before that field existed
      // are matched by the name they start with.
      const subject =
        m.from.sessionId || this._chatRoom?.members.find((x) => m.text.startsWith(`${x.name} joined`))?.sessionId;
      if (subject) el.append(this._chatAvatar(subject, this._chatNameOf(subject), { size: 'xs' }));
      el.append(this._chatEl('span', '', m.text));
      el.title = (globalThis.ReverieTime?.format(m.at) ?? new Date(m.at).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' }));
      return el;
    }
    const mine = m.from.kind === 'user';
    const el = this._chatEl(
      'div',
      `chatroom-msg${mine ? ' chatroom-msg--mine' : ''}${m.to !== 'all' ? ' chatroom-msg--direct' : ''}`
    );
    el.dataset.msgId = m.id;
    const meta = this._chatEl('div', 'chatroom-msg-meta');
    const fromName = mine ? 'You' : m.from.name;
    const from = this._chatEl('span', 'chatroom-msg-from', fromName);
    from.style.setProperty(
      '--chat-hue',
      m.from.sessionId ? this._chatAccent(m.from.sessionId) : this._chatHue(fromName)
    );
    const coordinatorId = this._chatRoom?.coordinatorId;
    if (m.from.sessionId && m.from.sessionId === coordinatorId)
      from.append(this._chatEl('span', 'chatroom-star', ' ★'));
    if (m.from.kind === 'bot') from.append(this._chatEl('span', 'chatroom-bot-tag', ' BOT'));
    const to = this._chatEl(
      'span',
      'chatroom-msg-to',
      m.to === 'all' ? '→ everyone' : `→ ${m.to.map((r) => this._chatNameOf(r)).join(', ')}`
    );
    const time = this._chatEl(
      'time',
      'chatroom-msg-time',
      (globalThis.ReverieTime?.format(m.at) ?? new Date(m.at).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' }))
    );
    time.dateTime = new Date(m.at).toISOString();
    meta.append(from, to, time);
    el.append(meta);
    if (m.text)
      el.append(this._chatTextEl ? this._chatTextEl(m.text) : this._chatEl('div', 'chatroom-msg-text', m.text));
    const files = this._chatAttachmentsEl?.(m);
    if (files) el.append(files);
    if (this._chatReactionsEl) el.append(this._chatReactionsEl(m));
    if (m.voice) meta.prepend(this._chatEl('span', 'chatroom-voice-mark', '\u{1F3A4}'));
    if (m.audioUrl) {
      const play = this._chatEl('button', 'chatroom-replay', '\u25B6 Play');
      play.type = 'button';
      play.title = 'Play the spoken reply';
      play.onclick = () => this._playChatAudio(m.audioUrl, m.from?.sessionId || null);
      el.append(play);
    }
    if (mine) return el;
    // Agent messages sit beside the sender's avatar, Discord style.
    const row = this._chatEl('div', 'chatroom-msg-row');
    row.append(this._chatAvatar(m.from.sessionId, m.from.name), el);
    return row;
  },

  async _sendChatMessage({ spoken = false, again = false } = {}) {
    // One send at a time: a double tap, or Enter plus the button, would otherwise post the same text again
    // while the first request is still on its way (the box is only emptied once the server answers).
    if (this._chatSending) return;
    const { input, to, send } = this._chatEls;
    const text = input.value.trim();
    const roomId = this._chatRoomId;
    const seq = this._chatLoadSeq;
    const owner = this._chatRoom?.owner;
    // A send whose answer was lost may be stored already. Sending the same words again is only ever the
    // explicit "Send again" on its row, never a plain Enter.
    const unsure = !again && (this._chatOwnSends || []).find((p) => p.state === 'unconfirmed' && p.roomId === roomId && p.text === text);
    if (unsure) {
      unsure.held = true;
      this._chatPendingDraw();
      return;
    }
    const attachments = this._takeChatAttachments ? this._takeChatAttachments() : [];
    if (attachments === null) {
      this.showToast?.('Wait for the upload to finish', 'info');
      return;
    }
    if ((!text && !attachments.length) || !roomId) return;
    // Dictated (possibly edited after the preview) words go out marked as speech.
    const isSpoken = spoken || this._pendingSpoken === true;
    this._pendingSpoken = false;
    // A reply links to the message it answers. @mentions are highlighted for readers and never narrow who
    // gets the message: only the "To" choice does (Discord's rule: a mention notifies, everyone still sees it).
    const reply = this._chatReplyTarget ? this._chatReplyTarget() : null;
    const draft = this._chatDraft();
    // Nothing typed is addressed to one member (everyone in a channel reads it: @mention who it is for); only a spoken turn, the
    // owner speaking to the room's voice member, is aimed.
    const recipients = isSpoken ? [to.value].filter(Boolean) : [];
    // Your own message used to appear only when the live stream echoed it back, so a stale or reconnecting
    // stream left the feed without it until a reload. It shows at once as "Sending…" instead, and the
    // server's answer (which carries the stored message) draws it, whether or not the echo ever comes.
    const own = this._chatPendingShow(roomId, text, attachments.length);
    this._chatSending = true;
    send.disabled = true;
    let res;
    try {
      res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(roomId)}/messages`, {
        method: 'POST',
        body: {
          text,
          ...(recipients.length ? { to: recipients } : {}),
          ...(reply ? { replyTo: reply.id } : {}),
          ...(isSpoken ? { spoken: true } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
      });
    } finally {
      this._chatSending = false;
      send.disabled = false;
    }
    const message = res.ok ? res.data?.message : null;
    if (typeof message?.id !== 'string') {
      // Only a documented refusal says it was not stored. No answer, a timeout, a server error or an answer this page
      // does not recognise may come after the message was stored, and nothing here can tell which (room posts carry
      // no send id), so it stays "Not confirmed" with the text kept, and the room catches up to show what is there.
      const refused = !res.ok && CHAT_SEND_REFUSALS[res.status] !== undefined && CHAT_SEND_REFUSALS[res.status] === res.errorCode;
      const error = res.ok ? 'the answer did not carry the message' : res.error;
      this._chatPendingSet(own, refused ? 'failed' : 'unconfirmed', error);
      this.showToast?.(`Chat: ${refused ? '' : 'not confirmed: '}${error}`, 'error');
      if (!refused) this._chatBackfill?.();
      return;
    }
    // The words and the reply are cleared only if the composer still holds this send as a whole: the same room, load
    // and owner, and the same draft (words, reply target and every file in the tray). A reader who moved on (another
    // room, other words, another reply, a file added or removed) keeps what they have; the send settles either way.
    const here =
      roomId === this._chatRoomId && seq === this._chatLoadSeq && this._chatRoom?.owner === owner && this._chatSameDraft(draft);
    // Only the files this send carried leave the tray, every time: anything else in it is not sent yet.
    if (attachments.length && Array.isArray(this._chatPending)) {
      this._chatPending = this._chatPending.filter((p) => !attachments.includes(p.id));
      this._renderChatTray?.();
    }
    if (here) {
      input.value = '';
      this._chatReplySent?.();
      input.focus();
    }
    // The answer and the live echo are matched by the server's message id only (a known id is never drawn twice).
    if (roomId === this._chatRoomId && this.isChatroomOpen?.()) this._chatShowMessage({ roomId, message });
    this._chatPendingSet(own, null);
  },

  /** The composer's whole draft: its words, the message it replies to, and the files in its tray (the items themselves). */
  _chatDraft() {
    return {
      text: this._chatEls?.input?.value.trim() ?? '',
      reply: (this._chatReplyTarget ? this._chatReplyTarget() : null)?.id ?? null,
      tray: Array.isArray(this._chatPending) ? [...this._chatPending] : [],
    };
  },

  /** The composer still holds exactly this draft: the same words, reply target and tray items in the same order. */
  _chatSameDraft(draft) {
    const now = this._chatDraft();
    return (
      now.text === draft.text &&
      now.reply === draft.reply &&
      now.tray.length === draft.tray.length &&
      now.tray.every((p, i) => p === draft.tray[i])
    );
  },

  /**
   * Your sends this page has not seen settled: "sending", "failed" (refused: not stored) or "unconfirmed" (no
   * answer: it may be stored). Drawn after the feed, and again after every redraw. A new send replaces the
   * room's refused ones (their text was in the box); an unconfirmed one stays until it is dismissed or sent again.
   */
  _chatPendingShow(roomId, text, files = 0) {
    this._chatOwnSendKey = (this._chatOwnSendKey || 0) + 1;
    const own = { key: this._chatOwnSendKey, roomId, text, files, state: 'sending', error: null };
    this._chatOwnSends = [...(this._chatOwnSends || []).filter((p) => !(p.roomId === roomId && p.state === 'failed')), own];
    this._chatPendingDraw();
    return own;
  },

  /** Settle one send: a new state for its row, or null to remove it. */
  _chatPendingSet(own, state, error) {
    if (!own) return;
    const list = (this._chatOwnSends || []).filter((p) => p.key !== own.key);
    this._chatOwnSends = state ? [...list, { ...own, state, error: error || 'not sent' }] : list;
    this._chatPendingDraw();
  },

  /** (Re)draw the rows of this room's unsettled sends at the end of the feed; called after a change and after every feed redraw. */
  _chatPendingDraw() {
    const feed = this._chatEls?.feed;
    if (!feed) return;
    for (const old of feed.querySelectorAll(':scope > .chatroom-pending, :scope > .chatroom-recovery')) old.remove();
    const here = (this._chatOwnSends || []).filter((p) => p.roomId === this._chatRoomId);
    const gap = this._chatRecovery?.roomId === this._chatRoomId ? this._chatRecovery : null;
    if (!here.length && !gap) return;
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    if (gap) feed.append(this._chatRecoveryRow(gap));
    for (const p of here) feed.append(this._chatPendingRow(p));
    if (atBottom || here.some((p) => p.state === 'sending')) feed.scrollTop = feed.scrollHeight;
  },

  _chatPendingRow(p) {
    const row = this._chatEl('div', `chatroom-pending is-${p.state}${p.state === 'sending' ? '' : ' is-failed'}`);
    row.setAttribute('role', 'status');
    row.style.cssText = 'padding:4px 16px;white-space:pre-wrap;word-break:break-word;' + (p.state === 'sending' ? 'opacity:.6;' : 'color:var(--danger,#e5534b);');
    const files = p.files ? `${p.text ? '\n' : ''}(${p.files} file${p.files === 1 ? '' : 's'})` : '';
    row.append(this._chatEl('div', 'chatroom-pending-text', `${p.text}${files}`));
    const words = {
      sending: 'Sending…',
      failed: `Not sent: ${p.error}. Your text is still in the box. `,
      unconfirmed:
        `Not confirmed: ${p.error}. It may or may not have been posted; check the messages above. Your text is still in the box. ` +
        (p.held ? 'Enter does not send it again: use Send again if it is not above. ' : ''),
    }[p.state];
    const state = this._chatEl('div', 'chatroom-pending-state', words);
    state.style.cssText = 'font-size:12px;';
    const button = (cls, label, fn) => {
      const b = this._chatEl('button', cls, label);
      b.type = 'button';
      b.onclick = fn;
      state.append(b);
    };
    // Both resend what is in the box only when it is still these words; otherwise they go back in the box to look at first.
    const resend = (again) => {
      const { input } = this._chatEls;
      if (input.value.trim() !== p.text) {
        input.value = p.text;
        input.focus();
        return;
      }
      if (again) this._chatPendingSet(p, null);
      this._sendChatMessage({ again });
    };
    if (p.state === 'failed') button('chatroom-pending-retry', 'Retry', () => resend(false));
    if (p.state === 'unconfirmed') {
      button('chatroom-pending-again', 'Send again (it may post twice)', () => resend(true));
      button('chatroom-pending-dismiss', 'Dismiss', () => this._chatPendingSet(p, null));
    }
    row.append(state);
    return row;
  },

  /**
   * Catching up did not finish: messages from while the stream was down may be missing, and the feed says so (it
   * is never shown as complete). It stays, through later catch-ups, until the room is reloaded fresh.
   */
  _chatRecoveryRow(gap) {
    const row = this._chatEl('div', 'chatroom-recovery');
    row.setAttribute('role', 'status');
    row.style.cssText = 'padding:4px 16px;font-size:12px;color:var(--danger,#e5534b);';
    row.append(`Catching up did not finish (${gap.reason}): messages from while the connection was down may be missing here. `);
    const reload = this._chatEl('button', 'chatroom-recovery-reload', 'Reload room');
    reload.type = 'button';
    reload.onclick = () => this._chatReloadFresh(gap.roomId);
    row.append(reload);
    return row;
  },

  _chatRecoveryFail(roomId, reason) {
    if (roomId !== this._chatRoomId) return false;
    this._chatRecovery = { roomId, reason };
    this._chatPendingDraw();
    return false;
  },

  /** Drop what is held and show the room's newest messages only (older ones load on scroll): no gap can be kept. */
  async _chatReloadFresh(id) {
    const gen = (this._chatBackfillGen = (this._chatBackfillGen || 0) + 1);
    const seq = this._chatLoadSeq;
    const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(id)}?limit=${CHAT_OPEN_LIMIT}`);
    if (gen !== this._chatBackfillGen || seq !== this._chatLoadSeq || id !== this._chatRoomId) return false;
    if (!res.ok) {
      this.showToast?.(`Chat: ${res.error}`, 'error');
      return false;
    }
    if (this._chatRecovery?.roomId === id) this._chatRecovery = null;
    this._chatCache?.delete(id);
    return this._applyChatRoom(id, res.data, { quiet: false, switched: true, synced: res.data.messages || [] });
  },

  /**
   * Bring the open room up to date after the live stream was down (it does not replay what it missed): everything
   * after the last message proved complete (`_chatSyncedFrom`), joined by id. An answer that comes back after a room switch, a newer room load or
   * a newer backfill, or for a room with another owner, is dropped.
   */
  async _chatBackfill() {
    const id = this._chatRoomId;
    const room = this._chatRoom;
    if (!id || !room || typeof this._chatApi !== 'function') return false;
    // From the last message PROVED complete, not the last one shown: a send's answer or a live event may sit past
    // messages the page never saw. A room that was empty starts from its empty start (since=0: the whole room).
    const anchor = this._chatSynced?.get(id);
    if (!anchor) return this._chatRecoveryFail(id, 'nothing proved to start from');
    const gen = (this._chatBackfillGen = (this._chatBackfillGen || 0) + 1);
    const seq = this._chatLoadSeq;
    const owner = room.owner;
    const current = () => gen === this._chatBackfillGen && seq === this._chatLoadSeq && id === this._chatRoomId && this._chatRoom?.owner === owner;
    const fromStart = anchor.id === null;
    for (let round = 0, limit = CHAT_BACKFILL_LIMIT; round < CHAT_BACKFILL_ROUNDS; round++, limit *= 4) {
      // `since` is exclusive and in ms: one ms back so the anchor (and any message sharing its ms) comes back too.
      const since = fromStart ? 0 : anchor.at - 1;
      const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(id)}?since=${since}&limit=${limit}`);
      if (!current()) return false;
      if (!res.ok || !Array.isArray(res.data?.messages)) return this._chatRecoveryFail(id, res.ok ? 'unrecognised answer' : res.error);
      const fresh = res.data.messages;
      // The page is the newest `limit`. It joins the proved history if it holds the anchor (by id), or, from the
      // empty start, if it holds fewer than asked for (then it is the whole room). A full page that does neither:
      // more arrived than it holds, so ask for a wider one.
      const from = fromStart ? -1 : fresh.findIndex((m) => m.id === anchor.id);
      const joined = fromStart ? fresh.length < limit : from >= 0;
      if (!joined && fresh.length >= limit) continue;
      // A short page without the anchor: it is gone from the room (or the server gave less than asked), so nothing
      // proves the two join.
      if (!joined) return this._chatRecoveryFail(id, 'the last message held is no longer in the room');
      const held = this._chatRoom.messages || [];
      const upTo = fromStart ? -1 : held.findIndex((m) => m.id === anchor.id);
      if (!fromStart && upTo < 0) return this._chatRecoveryFail(id, 'the last message proved complete is no longer shown');
      const byId = new Map(fresh.map((m) => [m.id, m]));
      const heldIds = new Set(held.map((m) => m.id));
      // Held before the anchor (with any newer copy); the page up to the anchor, which adds any missed message sharing
      // the anchor's ms that the server stored before it; the page after it (what the stream missed, in the room's
      // order); then anything the page lacks that was drawn since the request (a live event, a send's answer).
      const messages = [
        ...(fromStart ? [] : held.slice(0, upTo).map((m) => byId.get(m.id) || m)),
        ...fresh.slice(0, from + 1).filter((m) => m.id === anchor.id || !heldIds.has(m.id)),
        ...fresh.slice(from + 1),
        ...held.slice(upTo + 1).filter((m) => !byId.has(m.id)),
      ];
      return this._applyChatRoom(id, { ...res.data, messages }, { quiet: true, switched: false, synced: fresh.length ? fresh : null });
    }
    // Still not joined at the widest page: the work bound.
    return current() ? this._chatRecoveryFail(id, 'too many messages to fetch') : false;
  },

  /**
   * The page is visible again (a phone woke, a background tab came forward). A stream quiet for longer than its
   * heartbeat is likely dead: reconnect it (the reconnect brings the room up to date). Otherwise just catch up.
   */
  _chatOnVisible() {
    if (this._connectionStatus !== 'connected') return;
    const quiet = this._sseLastMessageAt ? Date.now() - this._sseLastMessageAt : 0;
    if (quiet > CHAT_STREAM_QUIET_MS && typeof this.connectSSE === 'function') {
      console.log(`[SSE] page visible after ${quiet}ms without a frame: reconnecting`);
      this.connectSSE();
      return;
    }
    this._chatBackfill();
  },

  _toggleChatRoomMenu(e) {
    const existing = this._chatroomPanel.querySelector('.chatroom-menu');
    if (existing) {
      existing.remove();
      return;
    }
    const menu = this._chatEl('div', 'chatroom-menu');
    menu.setAttribute('role', 'menu');
    const item = (label, fn) => {
      const b = this._chatEl('button', '', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.onclick = () => {
        menu.remove();
        fn();
      };
      menu.append(b);
    };
    item('New room…', () => this._showChatCreate());
    if (this._chatRoomId) {
      item('Rename room…', async () => {
        const name = prompt('Room name', this._chatRoom?.name || '');
        if (!name) return;
        const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(this._chatRoomId)}`, {
          method: 'PUT',
          body: { name },
        });
        if (!res.ok) this.showToast?.(`Chat: ${res.error}`, 'error');
      });
      item('Re-brief everyone', () => this._rebriefChatMember('all'));
      item('Custom emotes\u2026', () => this._openEmoteManager?.());
      const roomId = this._chatRoomId;
      if (roomId && this._speakRepliesMode) {
        const now = this._speakRepliesMode(roomId);
        for (const [mode, label] of [
          ['off', 'Read aloud here: off'],
          ['mine', 'Read aloud here: replies to me'],
          ['all', 'Read aloud here: everyone'],
        ]) {
          item(`${now === mode ? '\u2713 ' : ''}${label}`, () => this._setSpeakReplies(roomId, mode));
        }
      }
      const instant = this._voiceSetting?.('dictationSendNow');
      item(instant ? 'Dictation: preview before sending' : 'Dictation: send without preview', () =>
        this._setVoiceSetting('dictationSendNow', !instant)
      );
      item('Clear admin', () => this._appointChatCoordinator(null));
      item('Delete room…', async () => {
        if (!confirm(`Delete "${this._chatRoom?.name}" and its history?`)) return;
        const res = await this._chatApi(`/api/chatrooms/${encodeURIComponent(this._chatRoomId)}`, {
          method: 'DELETE',
        });
        if (!res.ok) this.showToast?.(`Chat: ${res.error}`, 'error');
      });
    }
    e.currentTarget.after(menu);
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', dismiss, true);
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
  },

  // ─── SSE ────────────────────────────────────────────────────────────────

  _onChatroomMessage(data) {
    // Car mode (car-mode.js) speaks the voice member's answers; read-aloud (voice-chat.js)
    // the replies to the user from everyone else.
    this._carModeOnMessage?.(data);
    this._readAloudOnMessage?.(data);
    this._chatVoiceTurnHeard(data);
    this._chatShowMessage(data);
  },

  /** Put a message into the open feed (once: a known id is skipped). The live echo and the send answer both come here. */
  _chatShowMessage(data) {
    if (!data?.message) return;
    // The conversation shell (chat-app.js) owns the feed and the counts once it is running.
    if (this._chatApp?.handleMessage(data)) return;
    if (this.isChatroomOpen() && data.roomId === this._chatRoomId && this._chatRoom) {
      if (this._chatRoom.messages.some((m) => m.id === data.message.id)) return;
      this._chatRoom.messages.push(data.message);
      const { feed } = this._chatEls;
      const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
      feed.querySelector(':scope > .chatroom-hint')?.remove();
      feed.append(this._chatMessageEl(data.message));
      this._chatPendingDraw();
      if (atBottom || data.message.from.kind === 'user') feed.scrollTop = feed.scrollHeight;
      return;
    }
    if (data.message.from.kind === 'system' || data.message.from.kind === 'user') return;
    this._chatUnread = (this._chatUnread || 0) + 1;
    this._renderChatBadge();
  },

  /** A message woke a member: the conversation shell shows "<name> is typing…" in that room until the turn ends or it posts. */
  _onChatroomTurn(data) {
    this._chatApp?.noteTurn?.(data);
  },

  _onChatroomChanged(data) {
    if (this._chatApp?.handleChanged(data)) return;
    if (!this.isChatroomOpen()) return;
    clearTimeout(this._chatChangedTimer);
    this._chatChangedTimer = setTimeout(() => {
      if (data?.action === 'created' || data?.action === 'deleted' || data?.roomId !== this._chatRoomId) {
        this._loadChatRooms(data?.action === 'deleted' ? undefined : this._chatRoomId);
      } else if (data?.action === 'emotes') {
        this._loadChatEmotes?.().then(() => this._renderChatFeed());
      } else {
        this._loadChatRoom(this._chatRoomId, { quiet: true });
      }
    }, 150);
  },
});

/**
 * Conversation-first shell. chat-app.js and chat-app.css are plain static assets (index.html is
 * read once at server start, so it cannot be edited without a restart): this loader revalidates
 * them, then injects them. The view (`chat` or `debug`) is set on <html> at once; if the shell fails
 * to load, the view falls back to `debug`, which shows the terminal UI again.
 */
(function loadConversationShell() {
  const root = document.documentElement;
  const legacy = new URLSearchParams(location.search).get('legacy') === '1';
  root.toggleAttribute('data-reverie-legacy', legacy);
  const solo = typeof window.__REVERIE_SOLO__ === 'string' && !!window.__REVERIE_SOLO__;
  let link = false;
  let stored = '';
  try {
    link = !!window.ReverieUrlSession?.sessionIdFromFragment?.(location.hash);
    stored = sessionStorage.getItem('reverie:view') || '';
  } catch {
    /* private mode: default view */
  }
  root.setAttribute('data-reverie-view', legacy || solo || link || stored === 'debug' ? 'debug' : 'chat');
  // The terminal UI stays mounted but is kept out of sight while the view is chat (the shell's own
  // CSS, chat-app.css, loads a moment later). Plain rules, so they hold even if the shell never loads.
  const guard = document.createElement('style');
  guard.id = 'reverie-view-guard';
  // The terminal UI's own screens stay mounted but out of sight in the chat view. Its dialogs (settings,
  // session options, case creation...) are direct children of .app: they must stay reachable, so only
  // the other children are hidden.
  guard.textContent = [
    "html[data-reverie-view='chat'] .loading-skeleton { display: none !important; }",
    "html[data-reverie-view='chat'] .app { display: block !important; height: 0 !important; min-height: 0 !important; padding: 0 !important; overflow: visible !important; }",
    "html[data-reverie-view='chat'] .app > :not(.modal):not(.notification-drawer):not(#filePreviewOverlay.visible) { display: none !important; }",
    "html[data-reverie-view='debug']:not([data-reverie-legacy]) body > :not(.app):not(.ca-back):not(script):not(style) { display: none !important; }",
    "html[data-reverie-view='debug']:not([data-reverie-legacy]) .app > :not(.main):not(#filePreviewOverlay.visible) { display: none !important; }",
    "html[data-reverie-view='debug']:not([data-reverie-legacy]) .main > :not(.terminal-wrap) { display: none !important; }",
  ].join('\n');
  document.head.append(guard);
  const fail = () => {
    root.setAttribute('data-reverie-view', 'debug');
    root.setAttribute('data-reverie-fallback', '1');
  };
  // A shell that never builds (a parse error, a stale copy, an app that never started) must not leave a
  // blank page. The check counts from when the script has LOADED, so a slow download is not mistaken for
  // a broken shell; a separate, longer limit covers a script that never arrives at all.
  const checkBuilt = () => {
    if (!window.reverieChat?.built) fail();
  };
  setTimeout(checkBuilt, 20000);
  // cache: 'no-cache' revalidates against the server (a 304 is cheap), so an updated asset is never
  // stuck behind the one-year static cache that these un-versioned URLs would otherwise get.
  const revalidate = (url) => fetch(url, { cache: 'no-cache' }).catch(() => null);
  const assets = window.__REVERIE_CHAT_ASSETS__ || {};
  const cssUrl = assets['chat-app.css'] || 'chat-app.css';
  const scriptUrl = assets['chat-app.js'] || 'chat-app.js';
  Promise.all([revalidate(cssUrl), revalidate(scriptUrl)]).then(() => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = cssUrl;
    css.onerror = fail;
    css.onload = () => {
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.onerror = fail;
      script.onload = () => setTimeout(checkBuilt, 5000);
      document.head.append(script);
    };
    document.head.append(css);
  });
})();
