/**
 * Account sign-in dialogs and session account labels shared by Reverie and its terminal.
 * Usage, pacing and reset displays live on the Board.
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency app.js, api-client.js (_api), chatroom-ui.js (_chatApi)
 */
const ACCOUNT_MAP_TTL_MS = 60_000;

function accountUiEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

Object.assign(ReverieApp.prototype, {
  // ─── Sign in ─────────────────────────────────────────────────────────────────

  /** Sign an account in from the dashboard: link, QR, code, poll until it settles. */
  async signInAccount(accountId, title) {
    this.closeAccountMenu?.();
    this._closeSignIn();
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const dialog = el('dialog', 'signin-dialog');
    dialog.setAttribute('data-i18n-skip', '');
    const head = el('div', 'signin-head');
    const close = el('button', 'plans-btn', 'Close');
    close.type = 'button';
    head.append(el('h3', '', `Sign in: ${title}`), close);
    const status = el('p', 'signin-status', 'Starting the sign-in…');
    status.setAttribute('role', 'status');
    const body = el('div', 'signin-body');
    dialog.append(head, status, body);
    document.body.append(dialog);
    const state = { dialog, el, status, body, accountId, title, view: null, timer: null, rendered: '' };
    this._signIn = state;
    close.onclick = () => this._closeSignIn();
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this._closeSignIn();
    });
    dialog.showModal();
    const res = await this._chatApi(`/api/plans/accounts/${encodeURIComponent(accountId)}/login`, { method: 'POST' });
    if (this._signIn !== state) return;
    if (!res.ok) {
      this._renderSignIn({ state: 'failed', message: `Could not start the sign-in: ${res.error}` });
      return;
    }
    this._renderSignIn(res.data);
    state.timer = setInterval(() => this._pollSignIn(), 1500);
  },

  async _pollSignIn() {
    const s = this._signIn;
    if (!s?.view || s.polling) return;
    s.polling = true;
    const res = await this._chatApi(`/api/plans/logins/${encodeURIComponent(s.view.id)}`);
    s.polling = false;
    if (this._signIn !== s) return;
    if (!res.ok) {
      this._renderSignIn({ ...s.view, state: 'failed', message: 'The sign-in helper stopped. Try again.' });
      return;
    }
    this._renderSignIn(res.data);
  },

  _renderSignIn(view) {
    const s = this._signIn;
    if (!s) return;
    const { el, status, body } = s;
    s.view = view.id ? view : s.view && { ...s.view, ...view };
    status.textContent = view.message || '';
    status.className = `signin-status signin-status--${view.state}`;
    const settled = ['signed_in', 'failed', 'timeout', 'cancelled'].includes(view.state);
    if (settled && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
      if (view.state === 'signed_in') {
        this.refreshSubscriptionUsage?.();
      }
    }
    // Rebuild only when what is shown changes, so a half-typed code survives each poll.
    const key = JSON.stringify([view.state, view.url, view.code, view.needsCode]);
    if (key === s.rendered) return;
    s.rendered = key;
    const parts = [];
    if (settled) {
      const row = el('div', 'signin-actions');
      if (view.state === 'signed_in') {
        const done = el('button', 'plans-btn plans-btn--primary', 'Done');
        done.type = 'button';
        done.onclick = () => this._closeSignIn();
        const wrong = el('button', 'plans-link', 'Wrong account? Sign in again');
        wrong.type = 'button';
        wrong.onclick = () => this.signInAccount(s.accountId, s.title);
        row.append(done, wrong);
      } else {
        const retry = el('button', 'plans-btn plans-btn--primary', 'Try again');
        retry.type = 'button';
        retry.onclick = () => this.signInAccount(s.accountId, s.title);
        row.append(retry);
      }
      parts.push(row);
      body.replaceChildren(...parts);
      parts[0].querySelector('button')?.focus();
      return;
    }
    const copyBtn = (text, label) => {
      const b = el('button', 'plans-btn', label);
      b.type = 'button';
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          b.textContent = 'Copied';
        } catch {
          b.textContent = 'Copy failed: select it by hand';
        }
        setTimeout(() => (b.textContent = label), 2000);
      };
      return b;
    };
    if (view.url) {
      const step = el('div', 'signin-step');
      const open = el('a', 'plans-btn plans-btn--primary signin-open', 'Open the sign-in page');
      open.href = view.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      const row = el('div', 'signin-actions');
      row.append(open, copyBtn(view.url, 'Copy link'));
      step.append(el('b', '', '1. Sign in'), row);
      if (view.qrSvg) {
        const other = el('details', 'signin-qr');
        const qr = el('div', 'signin-qr-img');
        qr.innerHTML = view.qrSvg; // server-rendered by the qrcode library from the URL
        other.append(el('summary', '', 'On another device? Scan this'), qr);
        step.append(other);
      }
      parts.push(step);
    }
    if (view.code) {
      const step = el('div', 'signin-step');
      const row = el('div', 'signin-actions');
      row.append(el('code', 'signin-code', view.code), copyBtn(view.code, 'Copy code'));
      step.append(
        el('b', '', '2. Enter this code on that page'),
        row,
        el('p', 'plans-note', 'It expires in 15 minutes.')
      );
      parts.push(step);
    }
    if (view.needsCode) {
      const step = el('form', 'signin-step');
      const input = el('input', 'signin-input');
      input.placeholder = 'Paste the code from the sign-in page';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('aria-label', 'Sign-in code');
      const send = el('button', 'plans-btn plans-btn--primary', 'Sign in');
      send.type = 'submit';
      const row = el('div', 'signin-actions');
      row.append(input, send);
      step.append(el('b', '', '2. Paste the code it shows you'), row);
      step.onsubmit = async (e) => {
        e.preventDefault();
        const code = input.value.trim();
        if (!code || !s.view) return;
        send.disabled = true;
        const res = await this._chatApi(`/api/plans/logins/${encodeURIComponent(s.view.id)}/code`, {
          method: 'POST',
          body: { code },
        });
        send.disabled = false;
        if (this._signIn !== s) return;
        if (!res.ok) {
          status.textContent = res.error;
          status.className = 'signin-status signin-status--failed';
          return;
        }
        this._renderSignIn(res.data);
      };
      parts.push(step);
    }
    if (!parts.length) parts.push(el('p', 'plans-note', 'Waiting for the sign-in page…'));
    const cancel = el('button', 'plans-link', 'Cancel sign-in');
    cancel.type = 'button';
    cancel.onclick = () => this._closeSignIn();
    parts.push(cancel);
    body.replaceChildren(...parts);
  },

  /** Safe when closed (the global Escape handler calls every close method). */
  _closeSignIn() {
    const s = this._signIn;
    if (!s) return;
    this._signIn = null;
    clearInterval(s.timer);
    const running = s.view?.id && !['signed_in', 'failed', 'timeout', 'cancelled'].includes(s.view.state);
    if (running) this._chatApi(`/api/plans/logins/${encodeURIComponent(s.view.id)}`, { method: 'DELETE' });
    s.dialog.close();
    s.dialog.remove();
  },

  // ─── Sign in all (batch) ───────────────────────────────────────────────────

  /** Start every signed-out account at once and show them in a grid. */
  async signInAll() {
    this.closeAccountMenu?.();
    this._closeSignInAll();
    const el = accountUiEl;
    const dialog = el('dialog', 'signin-dialog signin-dialog--all');
    dialog.setAttribute('data-i18n-skip', '');
    const head = el('div', 'signin-head');
    const closeBtn = el('button', 'plans-btn', 'Close');
    closeBtn.type = 'button';
    head.append(el('h3', '', 'Sign in all accounts'), closeBtn);
    const status = el('p', 'signin-status', 'Starting sign-in for all accounts…');
    status.setAttribute('role', 'status');
    const grid = el('div', 'signin-all-grid');
    dialog.append(head, status, grid);
    document.body.append(dialog);
    const state = { dialog, status, grid, panels: new Map(), timer: null };
    this._signInAll = state;
    closeBtn.onclick = () => this._closeSignInAll();
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this._closeSignInAll();
    });
    dialog.showModal();
    const res = await this._chatApi('/api/plans/login-all', { method: 'POST' });
    if (this._signInAll !== state) return;
    if (!res.ok) {
      status.textContent = `Could not start: ${res.error}`;
      status.className = 'signin-status signin-status--failed';
      return;
    }
    const { logins, errors } = res.data;
    if (!logins.length && !errors.length) {
      status.textContent = 'All accounts are already signed in.';
      status.className = 'signin-status signin-status--signed_in';
      return;
    }
    status.textContent = `${logins.length} sign-in${logins.length !== 1 ? 's' : ''} started.`;
    status.className = 'signin-status';
    for (const view of logins) this._addSignInPanel(view, state);
    for (const err of errors) this._addSignInPanel({ state: 'failed', message: err }, state);
    if (logins.length) {
      state.timer = setInterval(() => this._pollSignInAll(), 1500);
      this._pollSignInAll();
    }
  },

  _addSignInPanel(view, state) {
    const el = accountUiEl;
    const panel = el('div', 'signin-panel');
    const title = el('h4', 'signin-panel-title', `${view.provider || ''} · ${view.label || view.accountId || ''}`);
    const body = el('div', 'signin-panel-body');
    panel.append(title, body);
    state.grid.append(panel);
    const p = { el: panel, body, view, rendered: null, settled: false, polling: false };
    if (view.id) state.panels.set(view.id, p);
    this._renderSignInPanel(view, p);
  },

  _renderSignInPanel(view, p) {
    p.view = view;
    const settled = ['signed_in', 'failed', 'timeout', 'cancelled'].includes(view.state);
    if (settled) {
      p.settled = true;
      const all = [...(this._signInAll?.panels.values() || [])].every((x) => x.settled);
      if (all && this._signInAll?.timer) {
        clearInterval(this._signInAll.timer);
        this._signInAll.timer = null;
        if (view.state === 'signed_in') {
          this.refreshSubscriptionUsage?.();
        }
      }
    }
    const el = accountUiEl;
    const parts = [];
    const status = el('p', `signin-status signin-status--${view.state}`, view.message || '');
    parts.push(status);
    if (settled) {
      if (view.state === 'signed_in') parts.push(el('p', 'plans-note', '✓ Signed in'));
    } else {
      if (view.url) {
        const step = el('div', 'signin-step');
        const row = el('div', 'signin-actions');
        const open = el('a', 'plans-btn plans-btn--primary', 'Open');
        open.href = view.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        const copy = el('button', 'plans-btn', 'Copy');
        copy.type = 'button';
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(view.url);
            copy.textContent = '✓';
          } catch {
            copy.textContent = 'Fail';
          }
          setTimeout(() => {
            copy.textContent = 'Copy';
          }, 1500);
        };
        row.append(open, copy);
        step.append(row);
        if (view.qrSvg) {
          const qr = el('div', 'signin-qr-img');
          qr.innerHTML = view.qrSvg;
          step.append(qr);
        }
        parts.push(step);
      }
      if (view.code) {
        const step = el('div', 'signin-step');
        const row = el('div', 'signin-actions');
        row.append(el('code', 'signin-code', view.code));
        const copy = el('button', 'plans-btn', 'Copy');
        copy.type = 'button';
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(view.code);
            copy.textContent = '✓';
          } catch {
            copy.textContent = 'Fail';
          }
          setTimeout(() => {
            copy.textContent = 'Copy';
          }, 1500);
        };
        row.append(copy);
        step.append(row);
        parts.push(step);
      }
      if (view.needsCode) {
        const step = el('form', 'signin-step');
        const input = el('input', 'signin-input');
        input.placeholder = 'Paste code';
        input.autocomplete = 'off';
        input.spellcheck = false;
        const send = el('button', 'plans-btn plans-btn--primary', 'Go');
        send.type = 'submit';
        const row = el('div', 'signin-actions');
        row.append(input, send);
        step.append(row);
        step.onsubmit = async (e) => {
          e.preventDefault();
          const code = input.value.trim();
          if (!code || !p.view?.id) return;
          send.disabled = true;
          const res = await this._chatApi(`/api/plans/logins/${encodeURIComponent(p.view.id)}/code`, {
            method: 'POST',
            body: { code },
          });
          send.disabled = false;
          if (this._signInAll)
            this._renderSignInPanel(res.ok ? res.data : { ...p.view, state: 'failed', message: res.error }, p);
        };
        parts.push(step);
      }
      if (!view.url && !view.code && !view.needsCode) parts.push(el('p', 'plans-note', 'Waiting…'));
    }
    const key = JSON.stringify([view.state, view.url, view.code, view.needsCode, view.message]);
    if (key === p.rendered) return;
    p.rendered = key;
    p.body.replaceChildren(...parts);
  },

  _pollSignInAll() {
    const s = this._signInAll;
    if (!s) return;
    for (const [id, p] of s.panels) {
      if (p.settled || p.polling) continue;
      p.polling = true;
      this._chatApi(`/api/plans/logins/${encodeURIComponent(id)}`).then((res) => {
        p.polling = false;
        if (this._signInAll !== s) return;
        this._renderSignInPanel(
          res.ok ? res.data : { ...p.view, state: 'failed', message: 'Sign-in helper stopped.' },
          p
        );
      });
    }
  },

  _closeSignInAll() {
    const s = this._signInAll;
    if (!s) return;
    this._signInAll = null;
    if (s.timer) clearInterval(s.timer);
    for (const [id, p] of s.panels) {
      if (!p.settled) this._chatApi(`/api/plans/logins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
    s.dialog.close();
    s.dialog.remove();
  },

  // ─── Session -> account labels (sessions dropdown, chat member cards) ──────────

  _notePlanAccounts(accounts) {
    const map = new Map();
    for (const a of accounts || []) for (const s of a.sessions) map.set(s.id, a.label);
    this._sessionAccounts = map;
    this._sessionAccountsAt = Date.now();
  },

  /** The account label a session runs on, or '' (refreshes the map in the background). */
  _sessionAccountLabel(sessionId) {
    if (!this._sessionAccountsAt || Date.now() - this._sessionAccountsAt > ACCOUNT_MAP_TTL_MS) {
      this._sessionAccountsAt = Date.now();
      this._chatApi?.('/api/plans').then((res) => {
        if (!res.ok) return;
        this._notePlanAccounts(res.data.accounts);
        this._scheduleSessionSwitcher?.();
      });
    }
    return this._sessionAccounts?.get(sessionId) || '';
  },
});
