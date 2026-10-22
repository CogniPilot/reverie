/**
 * @fileoverview Phone session switcher: the header's session list as a dropdown.
 *
 * Below 600px the horizontal tab strip leaves no room in the header, so it is
 * replaced (CSS, `.session-switcher` + the phone media block in styles.css) by:
 * - a compact button, "Sessions N", that opens a list of every session with its
 *   avatar, name, mode and a status chip (busy / idle / needs help + reason);
 *   choosing one selects it;
 * - beside it, the ONE session that most needs you, as a chip that jumps
 *   straight to it, or nothing when every session is fine.
 *
 * The ranking is the pure `rankSessionsNeedingHelp()` below: a pending
 * permission prompt or question first, then a session waiting for input, then
 * an errored one; within a level the one waiting longest wins. States come from
 * the phone overview's `_mobileOverviewState()` so the two never disagree.
 *
 * The #sessionTabs element is untouched (hidden by CSS only), so every tab-strip
 * behaviour on wider screens is unchanged. Names, modes and reasons are rendered
 * with textContent.
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency app.js, mobile-overview.js (_mobileOverviewState), chatroom-ui.js (_chatAccent, optional)
 * @loadorder 12.565 (after home-sessions.js)
 */

/**
 * Help levels, most urgent first. A session absent from this map is fine.
 * `dialog`: the CLI shows a dialog or full-screen panel (trust dialog, auto-mode
 * setup, a login prompt) while no turn runs; the server reads it off the screen
 * as `session.paneDialog`.
 */
const SESSION_HELP_LEVEL = { needs: 0, dialog: 1, waiting: 2, error: 3 };

/**
 * Pure: the sessions that need the user, most urgent first.
 * @param {Array<{id: string, state: string, hooks?: string[], since?: number}>} rows
 * @returns {Array<{id: string, level: number, reason: string}>}
 */
function rankSessionsNeedingHelp(rows) {
  const out = [];
  for (const row of rows || []) {
    const level = SESSION_HELP_LEVEL[row.state];
    if (level === undefined) continue;
    out.push({ id: row.id, level, reason: sessionHelpReason(row), since: Number(row.since) || 0 });
  }
  // Oldest first within a level: the one that has waited longest; unknown (0) last.
  out.sort((a, b) => a.level - b.level || (a.since || Infinity) - (b.since || Infinity));
  return out.map(({ id, level, reason }) => ({ id, level, reason }));
}

/** Pure: why a session needs help, in a few words. */
function sessionHelpReason(row) {
  const hooks = row.hooks || [];
  if (row.state === 'needs') return hooks.includes('permission_prompt') ? 'permission' : 'question';
  if (row.state === 'dialog') return 'dialog open';
  if (row.state === 'waiting') return 'waiting for input';
  if (row.state === 'error') return 'error';
  return '';
}

const SESSION_SWITCHER_STATUS_LABEL = {
  needs: 'needs help',
  dialog: 'needs help',
  waiting: 'needs help',
  error: 'needs help',
  working: 'busy',
  idle: 'idle',
  done: 'stopped',
};

Object.assign(ReverieApp.prototype, {
  /** Rows for the switcher, in tab order. */
  _sessionSwitcherRows() {
    const ids = this.sessionOrder?.length ? this.sessionOrder : [...(this.sessions?.keys() || [])];
    const rows = [];
    for (const id of ids) {
      const session = this.sessions?.get(id);
      if (!session) continue;
      const hookSet = this.pendingHooks?.get(id);
      let state = this._mobileOverviewState ? this._mobileOverviewState(session, hookSet) : 'idle';
      // A dialog holding a quiet pane outranks everything but a permission prompt.
      if (state !== 'needs' && typeof session.paneDialog === 'string' && session.paneDialog) state = 'dialog';
      rows.push({
        id,
        session,
        state,
        hooks: hookSet ? [...hookSet] : [],
        since: Number(session.lastActivityAt) || 0,
      });
    }
    return rows;
  },

  _sessionSwitcherAvatar(session) {
    const el = document.createElement('span');
    el.className = 'session-switcher-avatar';
    el.setAttribute('aria-hidden', 'true');
    const member = this._chatRoom?.members?.find((m) => m.sessionId === session.id);
    const name = session.name || session.id.slice(0, 8);
    el.textContent = member?.icon || (this._chatInitial ? this._chatInitial(name) : name.slice(0, 1).toUpperCase());
    if (member?.icon) el.classList.add('has-icon');
    const hue = this._chatAccent ? this._chatAccent(session.id) : 200;
    el.style.setProperty('--chat-hue', hue);
    return el;
  },

  /** Batch re-renders: every tab-strip pass and hook change asks, one frame paints. */
  _scheduleSessionSwitcher() {
    if (this._sessionSwitcherFrame) return;
    const run = () => {
      this._sessionSwitcherFrame = null;
      this.renderSessionSwitcher();
      // Desktop strip: fold spawned tabs under their parents (tab-families.js).
      this._applyTabFamilies?.();
    };
    this._sessionSwitcherFrame =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  },

  _ensureSessionSwitcher() {
    if (this._sessionSwitcher) return this._sessionSwitcher;
    const host = document.getElementById('sessionTabsHost');
    if (!host) return null;
    const wrap = document.createElement('div');
    wrap.className = 'session-switcher';
    wrap.id = 'sessionSwitcher';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'session-switcher-toggle';
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => (this._sessionSwitcherMenu ? this.closeSessionSwitcher() : this.openSessionSwitcher());
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'session-switcher-help';
    help.hidden = true;
    help.onclick = () => {
      const id = help.dataset.id;
      if (id && this.sessions?.has(id)) this.selectSession(id);
    };
    wrap.append(toggle, help);
    host.before(wrap);
    this._sessionSwitcher = { wrap, toggle, help };
    return this._sessionSwitcher;
  },

  renderSessionSwitcher() {
    const ui = this._ensureSessionSwitcher();
    if (!ui) return;
    const rows = this._sessionSwitcherRows();
    const active = rows.find((r) => r.id === this.activeSessionId);
    ui.toggle.replaceChildren();
    const label = document.createElement('span');
    label.className = 'session-switcher-label';
    const activeName = active ? active.session.name || active.id.slice(0, 8) : 'Sessions';
    // The button has a few characters to spare: drop the "wN-case: " tab prefix there.
    label.textContent = activeName.split(': ').slice(1).join(': ') || activeName;
    const count = document.createElement('span');
    count.className = 'session-switcher-count';
    count.textContent = String(rows.length);
    const caret = document.createElement('span');
    caret.className = 'session-switcher-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    ui.toggle.append(label, count, caret);
    ui.toggle.title = `${rows.length} session${rows.length === 1 ? '' : 's'}: tap to switch`;
    ui.toggle.setAttribute('aria-label', `Sessions (${rows.length}), current: ${activeName}`);

    const top = rankSessionsNeedingHelp(rows).find((r) => r.id !== this.activeSessionId);
    if (top) {
      const row = rows.find((r) => r.id === top.id);
      const name = row.session.name || row.id.slice(0, 8);
      ui.help.hidden = false;
      ui.help.dataset.id = top.id;
      ui.help.className = `session-switcher-help session-switcher-help--${row.state}`;
      ui.help.replaceChildren(this._sessionSwitcherAvatar(row.session));
      const reason = document.createElement('span');
      reason.className = 'session-switcher-reason';
      reason.textContent = top.reason;
      ui.help.append(reason);
      const footer = row.state === 'dialog' ? `\n${row.session.paneDialog}` : '';
      ui.help.title = `${name} needs you: ${top.reason}${footer}`;
      ui.help.setAttribute('aria-label', `Switch to ${name}, needs you: ${top.reason}`);
    } else {
      ui.help.hidden = true;
      delete ui.help.dataset.id;
    }
    if (this._sessionSwitcherMenu) this._renderSessionSwitcherMenu(rows);
  },

  openSessionSwitcher() {
    const ui = this._ensureSessionSwitcher();
    if (!ui || this._sessionSwitcherMenu) return;
    const menu = document.createElement('div');
    menu.className = 'session-switcher-menu';
    menu.id = 'sessionSwitcherMenu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Sessions');
    menu.setAttribute('data-i18n-skip', '');
    document.body.append(menu);
    this._sessionSwitcherMenu = menu;
    ui.toggle.setAttribute('aria-expanded', 'true');
    this._renderSessionSwitcherMenu(this._sessionSwitcherRows());
    const r = ui.toggle.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    this._sessionSwitcherDismiss = (e) => {
      if (!menu.contains(e.target) && !ui.wrap.contains(e.target)) this.closeSessionSwitcher();
    };
    document.addEventListener('pointerdown', this._sessionSwitcherDismiss, true);
    (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus();
  },

  /** Safe to call when closed (the global Escape handler calls every close method). */
  closeSessionSwitcher({ refocus = false } = {}) {
    if (!this._sessionSwitcherMenu) return;
    this._sessionSwitcherMenu.remove();
    this._sessionSwitcherMenu = null;
    document.removeEventListener('pointerdown', this._sessionSwitcherDismiss, true);
    this._sessionSwitcher?.toggle.setAttribute('aria-expanded', 'false');
    if (refocus) this._sessionSwitcher?.toggle.focus();
  },

  _renderSessionSwitcherMenu(rows) {
    const menu = this._sessionSwitcherMenu;
    if (!menu) return;
    const focusedId = menu.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    menu.replaceChildren();
    const help = new Map(rankSessionsNeedingHelp(rows).map((r) => [r.id, r.reason]));
    for (const row of rows) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'session-switcher-item';
      item.dataset.id = row.id;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(row.id === this.activeSessionId));
      const name = document.createElement('span');
      name.className = 'session-switcher-item-name';
      name.textContent = row.session.name || row.id.slice(0, 8);
      const mode = document.createElement('span');
      mode.className = 'session-switcher-item-mode';
      const account = this._sessionAccountLabel?.(row.id) || '';
      mode.textContent = [row.session.mode, account].filter(Boolean).join(' \u00B7 ');
      const chip = document.createElement('span');
      chip.className = `session-switcher-chip session-switcher-chip--${row.state}`;
      const reason = help.get(row.id);
      chip.textContent = reason
        ? `${SESSION_SWITCHER_STATUS_LABEL[row.state]}: ${reason}`
        : SESSION_SWITCHER_STATUS_LABEL[row.state] || row.state;
      if (row.state === 'dialog') chip.title = row.session.paneDialog;
      item.append(this._sessionSwitcherAvatar(row.session), name, mode, chip);
      item.onclick = () => {
        this.closeSessionSwitcher();
        if (row.id !== this.activeSessionId) this.selectSession(row.id);
      };
      item.onkeydown = (e) => this._sessionSwitcherKey(e);
      menu.append(item);
    }
    if (focusedId) menu.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  },

  _sessionSwitcherKey(e) {
    const items = [...(this._sessionSwitcherMenu?.querySelectorAll('.session-switcher-item') || [])];
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = items[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeSessionSwitcher({ refocus: true });
      return;
    }
    if (next) {
      e.preventDefault();
      next.focus();
    }
  },
});
