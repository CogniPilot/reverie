/**
 * @fileoverview Plans: a time card per subscription account (and the local GPU) showing
 * how far through its week it is against how much of it is used, so it is clear at a
 * glance which agents should work harder or ease off.
 *
 * Opened from the header usage dropdown ("Plans..."). Reads `GET /api/plans` (pacing is
 * computed server-side, plan-pace.ts) every 30 s while open. Also keeps a session-to-
 * account map (`_sessionAccountLabel`) that the sessions dropdown and the chat member
 * cards use to show which account each session runs on. All text via textContent.
 *
 * Sign in (`signInAccount`, also used by the header account dropdown): starts the
 * provider's login on the server (`POST /api/plans/accounts/:id/login`) and shows its link
 * (open here, copy, or a QR code for another device), Codex's one-time code, or a field
 * for the code Claude shows after signing in, polling until it settles.
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency app.js, api-client.js (_api), chatroom-ui.js (_chatApi)
 * @loadorder 12.13 (after car-mode.js)
 */

const PLAN_REFRESH_MS = 30_000;
const PLAN_ACCOUNT_MAP_TTL_MS = 60_000;

const PLAN_RECOMMENDATION = {
  push: { label: 'Push', hint: 'Well behind an even burn: give its agents more work' },
  steady: { label: 'Steady', hint: 'On pace' },
  ease: { label: 'Ease off', hint: 'Ahead of an even burn: move work elsewhere' },
  stop: { label: 'Stop', hint: '5-hour window nearly full or the week used up' },
  login: { label: 'Sign in', hint: 'Not logged in' },
  unknown: { label: 'No data', hint: 'The provider gave no usage reading' },
};

Object.assign(ReverieApp.prototype, {
  async openPlans() {
    this.closeAccountMenu?.();
    this._buildPlans();
    this._plansScreen.hidden = false;
    document.documentElement.classList.add('plans-open');
    await this._loadPlans();
    clearInterval(this._plansTimer);
    this._plansTimer = setInterval(() => {
      if (!this._plansScreen.hidden) this._loadPlans();
    }, PLAN_REFRESH_MS);
  },

  /** Safe when closed (the global Escape handler calls every close method). */
  closePlans() {
    if (!this._plansScreen || this._plansScreen.hidden) return;
    this._plansScreen.hidden = true;
    document.documentElement.classList.remove('plans-open');
    clearInterval(this._plansTimer);
    this._plansTimer = null;
  },

  _buildPlans() {
    if (this._plansScreen) return;
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const screen = el('div', 'plans-screen');
    screen.id = 'plansScreen';
    screen.hidden = true;
    screen.setAttribute('role', 'dialog');
    screen.setAttribute('aria-label', 'Plans');
    screen.setAttribute('data-i18n-skip', '');
    const head = el('div', 'plans-head');
    const title = el('h2', 'plans-title', 'Plans');
    const updated = el('span', 'plans-updated');
    const refresh = el('button', 'plans-btn', 'Refresh');
    refresh.type = 'button';
    refresh.onclick = () => this._loadPlans();
    const signInAll = el('button', 'plans-btn plans-btn--primary', 'Sign in all');
    signInAll.type = 'button';
    signInAll.onclick = () => this.signInAll();
    const close = el('button', 'plans-btn', 'Close');
    close.type = 'button';
    close.onclick = () => this.closePlans();
    head.append(title, updated, signInAll, refresh, close);
    const legend = el(
      'p',
      'plans-legend',
      'Each card: the grey bar is how far through its week the account is, the coloured bar how much of the week it has used. Pace is used minus elapsed: negative means headroom.'
    );
    const grid = el('div', 'plans-grid');
    screen.append(head, legend, grid);
    document.body.append(screen);
    this._plansScreen = screen;
    this._plansEls = { grid, updated, el };
  },

  async _loadPlans() {
    const res = await this._chatApi('/api/plans');
    const { grid, updated, el } = this._plansEls;
    if (!res.ok) {
      grid.replaceChildren(el('p', 'plans-error', `Plans unavailable: ${res.error}`));
      return;
    }
    this._notePlanAccounts(res.data.accounts);
    updated.textContent = `updated ${new Date(res.data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const cards = res.data.accounts.map((a) => this._planCard(a));
    cards.push(this._gpuCard(res.data.gpu));
    grid.replaceChildren(...cards);
  },

  _planBar(label, pct, cls, title) {
    const { el } = this._plansEls;
    const row = el('div', 'plans-bar-row');
    row.title = title || '';
    const bar = el('div', `plans-bar ${cls}`);
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, pct ?? 0))}%`;
    bar.append(fill);
    row.append(
      el('span', 'plans-bar-label', label),
      bar,
      el('span', 'plans-bar-value', pct === null ? '-' : `${Math.round(pct)}%`)
    );
    return row;
  },

  _planCard(a) {
    const { el } = this._plansEls;
    const p = a.pace;
    const rec = PLAN_RECOMMENDATION[p.recommendation] || PLAN_RECOMMENDATION.unknown;
    const card = el('article', `plans-card plans-card--${p.recommendation}`);
    const top = el('div', 'plans-card-top');
    top.append(
      el('span', 'plans-provider', a.provider === 'anthropic' ? 'Claude' : 'Codex'),
      el('span', 'plans-label', a.label)
    );
    if (a.isDefault) top.append(el('span', 'plans-tag', 'default'));
    if (a.orchestrator) {
      const o = el('span', 'plans-tag plans-tag--orch', '\u{1F9ED} orchestrator');
      o.title = "The orchestrator's own account";
      top.append(o);
    }
    const chip = el('span', `plans-rec plans-rec--${p.recommendation}`, rec.label);
    chip.title = rec.hint;
    top.append(chip);
    card.append(top);
    const signIn = (text, cls) => {
      const b = el('button', cls, text);
      b.type = 'button';
      b.onclick = () => this.signInAccount(a.id, `${a.provider === 'anthropic' ? 'Claude' : 'Codex'} · ${a.label}`);
      return b;
    };
    if (!a.signedIn) {
      card.append(el('p', 'plans-note', 'Not logged in.'), signIn('Sign in', 'plans-btn plans-btn--primary'));
      if (a.acctName) {
        const cmd =
          a.provider === 'anthropic' ? `acct claude ${a.acctName}   (then /login)` : `acct codex ${a.acctName} login`;
        const more = el('details', 'plans-terminal');
        more.append(el('summary', '', 'or in a terminal'), el('code', 'plans-cmd', cmd));
        card.append(more);
      }
      return card;
    }
    const reset = p.weekReset ? new Date(p.weekReset) : null;
    card.append(
      this._planBar('week', p.elapsed, 'plans-bar--time', reset ? `Week resets ${reset.toLocaleString()}` : ''),
      this._planBar('used', p.weekly, `plans-bar--${p.recommendation}`, 'Weekly usage'),
      this._planBar('5 h', p.fiveHour, 'plans-bar--five', '5-hour window')
    );
    const facts = el('div', 'plans-facts');
    const fact = (k, v) => {
      const f = el('span', 'plans-fact');
      f.append(el('b', '', k), document.createTextNode(` ${v}`));
      facts.append(f);
    };
    fact('pace', p.pace === null ? '-' : `${p.pace > 0 ? '+' : ''}${p.pace}`);
    fact('burn', p.burnPerHour === null ? '-' : `${p.burnPerHour}%/h`);
    if (p.runsOutAt) {
      fact('runs out', new Date(p.runsOutAt).toLocaleString([], { weekday: 'short', hour: 'numeric' }));
    } else {
      fact('at reset', p.projected === null ? '-' : `${Math.round(p.projected)}%`);
    }
    if (a.usageSource === 'statusline' || a.usageSource === 'history') {
      const asOf = new Date(a.usageAsOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      fact(a.usageStale ? 'stale, as of' : 'as of', asOf);
    } else if (a.provider === 'anthropic' && p.weekly === null && p.fiveHour === null) {
      fact('usage', 'no report yet');
    }
    if (reset) fact('resets', reset.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }));
    card.append(facts);
    if (a.usageError) card.append(el('p', 'plans-note', a.usageError));
    card.append(this._planResets(a));
    const sessions = el('div', 'plans-sessions');
    if (!a.sessions.length) sessions.append(el('span', 'plans-none', 'no sessions'));
    for (const s of a.sessions) {
      const chip = el('button', `plans-session plans-session--${s.status}`, s.name);
      chip.type = 'button';
      chip.title = `${s.mode} · ${s.status}: open it`;
      chip.onclick = () => {
        if (this.sessions?.has(s.id)) {
          this.closePlans();
          this.selectSession(s.id);
        }
      };
      sessions.append(chip);
    }
    card.append(sessions);
    const again = signIn('Sign in again', 'plans-link');
    again.title = 'Signed in to the wrong account, or the login expired';
    card.append(again);
    return card;
  },

  /** "Usage resets": used %, reset and run-out in ET, projected %, and (Codex) banked resets. Read-only: no redeem control. */
  _planResets(a) {
    const { el } = this._plansEls;
    const p = a.pace;
    const et = (ms) =>
      ms
        ? new Date(ms).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit',
          }) + ' ET'
        : '-';
    const pct = (n) => (n === null || n === undefined ? '-' : `${Math.round(n)}%`);
    const box = el('div', 'plans-resets');
    box.append(el('b', 'plans-resets-title', 'Usage resets'));
    const line = (k, v) => {
      const f = el('span', 'plans-fact');
      f.append(el('b', '', k), document.createTextNode(` ${v}`));
      box.append(f);
    };
    line('used', pct(p.weekly));
    line('resets', et(p.weekReset));
    line('projected', pct(p.projected));
    line('runs out', p.runsOutAt ? et(p.runsOutAt) : '-');
    if (a.provider === 'openai') {
      const b = a.bankedResets;
      const text = !b
        ? 'unknown'
        : `${b.availableCount}${b.earliestExpiresAt ? ` (earliest expiry ${et(b.earliestExpiresAt)})` : ''}`;
      line('banked resets', text);
    }
    return box;
  },

  _gpuCard(g) {
    const { el } = this._plansEls;
    const card = el('article', 'plans-card plans-card--gpu');
    const top = el('div', 'plans-card-top');
    top.append(el('span', 'plans-provider', 'GPU'), el('span', 'plans-label', 'Local GPU'));
    card.append(top);
    if (!g?.available) {
      card.append(el('p', 'plans-note', 'No GPU reading (nvidia-smi unavailable).'));
      return card;
    }
    card.append(
      this._planBar('busy', g.utilization, 'plans-bar--five', 'GPU utilization'),
      this._planBar(
        'mem',
        g.memoryTotalMb ? (g.memoryUsedMb / g.memoryTotalMb) * 100 : null,
        'plans-bar--time',
        `${g.memoryUsedMb} of ${g.memoryTotalMb} MB`
      )
    );
    const facts = el('div', 'plans-facts');
    const fact = (k, v) => {
      const f = el('span', 'plans-fact');
      f.append(el('b', '', k), document.createTextNode(` ${v}`));
      facts.append(f);
    };
    fact('model', g.models.length ? g.models.join(', ') : 'none loaded');
    fact('last holder', g.lastHolder ? `${g.lastHolder.role}, ${g.lastHolder.ageS}s ago` : '-');
    card.append(facts);
    return card;
  },

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
        if (this._plansScreen && !this._plansScreen.hidden) this._loadPlans();
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
    const el = this._plansEls.el;
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
    const el = this._plansEls.el;
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
          if (this._plansScreen && !this._plansScreen.hidden) this._loadPlans();
        }
      }
    }
    const el = this._plansEls.el;
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
    if (!this._sessionAccountsAt || Date.now() - this._sessionAccountsAt > PLAN_ACCOUNT_MAP_TTL_MS) {
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
