/**
 * @fileoverview Approvals Inbox UI: cross-session queue of prompts waiting on a human.
 *
 * Everything here is gated on the OPT-IN `approvalsInboxEnabled` setting
 * (synced, default OFF): with it off, no bell, no drawer, no overview strips,
 * no seeding. When on, the header bell renders only while items are pending
 * (count badge), opening a right-side drawer of approval cards; pending items
 * are seeded from `GET /api/approvals` on init/reconnect (so tab alerts
 * survive a reload) and answered in place via `POST /api/approvals/:id/answer`. Cards render
 * buttons from the server-parsed dialog options; without parsed options they
 * fall back to Approve/Deny (permission/question) or a text prompt (idle).
 * Backend: src/web/approval-inbox.ts, design: docs/approvals-inbox-plan.md.
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency app.js (ReverieApp class, this.approvals, setPendingHook/clearPendingHooks, selectSession)
 * @dependency constants.js (escapeHtml)
 * @dependency api-client.js at runtime (this._apiJson; loads later but is only called after init)
 * @loadorder 11.6 of 17, after ultracode-panel.js, before admin-ui.js
 */

/** Map an approval kind to the pendingHooks entry that drives tab alerts. */
function approvalKindToHook(kind) {
  return kind === 'permission' ? 'permission_prompt' : kind === 'question' ? 'elicitation_dialog' : 'idle_prompt';
}

Object.assign(ReverieApp.prototype, {
  /** Synced setting, default OFF, opt-in via App Settings → Panels. */
  approvalsInboxEnabled() {
    return this.loadAppSettingsFromStorage().approvalsInboxEnabled === true;
  },

  /**
   * Seed pending approvals from the server. Called from handleInit, i.e. on
   * every page load AND SSE reconnect; this is what makes pending alerts
   * survive a reload (pre-inbox they lived only in SSE-transient memory).
   */
  async seedApprovals() {
    if (!this.approvals) this.approvals = new Map();
    const revision = (this._approvalSeedRevision || 0) + 1;
    this._approvalSeedRevision = revision;
    const mutationStart = this._approvalMutationRevision || 0;
    this._approvalReading = true;
    // ⚠ Fetch and re-arm the tab-alert state machine REGARDLESS of the inbox
    // setting. The server-side approval store runs unconditionally (only the
    // inbox SURFACES are opt-in), and the red/yellow tab alert predates the
    // inbox: gating the seed on the setting meant that with the inbox off, a
    // reload landed with every alert store empty while a permission dialog sat
    // blocking a session (owner report 2026-08-15: rail said NEEDS YOU from
    // the live SSE event, the reloaded-elsewhere tab showed a plain green
    // dot). Only populating `this.approvals` (bell/drawer/answer strips) stays
    // behind the setting.
    let data;
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(null);
      }, 10000);
    });
    try {
      data = await Promise.race([this._apiJson('/api/approvals', { signal: controller.signal }), deadline]);
    } catch {
      data = null;
    } finally {
      clearTimeout(timer);
    }
    if (revision !== this._approvalSeedRevision) return;
    this._approvalReading = false;
    if (!data || !Array.isArray(data.approvals)) {
      this._approvalReadChanges?.clear();
      this._approvalReadSessions?.clear();
      for (const [id, item] of this.approvals) this.approvals.set(id, {
        ...item, answerState: 'held', heldReason: timedOut
          ? 'Approval refresh timed out. Reopen the inbox to check readiness.'
          : 'Approval readiness could not be refreshed. Reopen the inbox to check again.',
      });
      this.renderApprovals();
      this.showToast(timedOut
        ? 'Approval refresh timed out. Answers remain held. No automatic retry was made.'
        : 'Could not refresh approvals. Answers remain held. No automatic retry was made.', 'warning');
      return;
    }
    const snapshot = new Map();
    for (const item of data.approvals) {
      if ((this._approvalReadChanges?.get(item.id)?.revision || 0) > mutationStart) continue;
      const sessionChanged = (this._approvalReadSessions?.get(item.sessionId) || 0) > mutationStart;
      snapshot.set(item.id, sessionChanged ? {
        ...item, answerState: 'held',
        heldReason: 'This session changed while approvals were refreshed. This item may be stale; reopen the inbox to check readiness. No answer will be replayed automatically.',
      } : item);
    }
    const changes = [...(this._approvalReadChanges?.values() || [])]
      .filter(change => change.revision > mutationStart).sort((left, right) => left.revision - right.revision);
    for (const change of changes) {
      if (!change.item) snapshot.delete(change.id);
      else {
        for (const [id, item] of snapshot) if (item.sessionId === change.item.sessionId) snapshot.delete(id);
        snapshot.set(change.id, change.item);
      }
    }
    this._approvalReadChanges?.clear();
    this._approvalReadSessions?.clear();
    this.approvals.clear();
    const inboxOn = this.approvalsInboxEnabled();
    for (const item of snapshot.values()) {
      if (inboxOn) this.approvals.set(item.id, item);
      // ⚠ Skip items a human already looked at (`acknowledgedAt`, set by
      // markIdleAlertSeen → POST .../viewed). Re-arming those is exactly the
      // bug this flag exists for: clicking a yellow tab cleared the alert in
      // this tab's memory only, so the next reload seeded it right back.
      if (item.acknowledgedAt) continue;
      // Re-arm the tab alert state machine (idempotent set-add).
      this.setPendingHook(item.sessionId, approvalKindToHook(item.kind));
    }
    this.renderApprovals();
  },

  // ─── SSE handlers ────────────────────────────────────────────

  // Reconcile only events that overlap a list read. Resolution tombstones are
  // per approval; a fresh prompt supersedes stale siblings in the same session.
  _noteApprovalReadChange(item, resolved = false) {
    const revision = (this._approvalMutationRevision || 0) + 1;
    this._approvalMutationRevision = revision;
    if (!this._approvalReading) return;
    if (!this._approvalReadChanges) this._approvalReadChanges = new Map();
    if (!this._approvalReadSessions) this._approvalReadSessions = new Map();
    this._approvalReadChanges.set(item.id, { id: item.id, revision, item: resolved ? null : item });
    if (!resolved) this._approvalReadSessions.set(item.sessionId, revision);
  },

  _onApprovalPending(item) {
    if (!item || !item.id) return;
    if (!this.approvals) this.approvals = new Map();
    this._noteApprovalReadChange(item);
    // One active item per session (server invariant): drop any stale sibling.
    for (const [id, existing] of this.approvals) {
      if (existing.sessionId === item.sessionId) {
        if (id !== item.id) this._noteApprovalReadChange(existing, true);
        this.approvals.delete(id);
      }
    }
    this.approvals.set(item.id, item);
    this.renderApprovals();
  },

  _onApprovalUpdated(item) {
    if (!item || !item.id) return;
    this._noteApprovalReadChange(item);
    // Acknowledged elsewhere (this user opened the session on another device):
    // spend the tab alert UNCONDITIONALLY, for the same reason
    // _onApprovalResolved does: with the inbox setting OFF the item was never
    // stored in `this.approvals`, yet seedApprovals armed its alert, so gating
    // this on a map hit would strand a yellow tab on every other device.
    if (item.acknowledgedAt) this.clearPendingHooks(item.sessionId, approvalKindToHook(item.kind));
    if (!this.approvals?.has(item.id) && !this.approvalsInboxEnabled()) return;
    if (!this.approvals) this.approvals = new Map();
    for (const [id, existing] of this.approvals) {
      if (id !== item.id && existing.sessionId === item.sessionId) {
        this._noteApprovalReadChange(existing, true);
        this.approvals.delete(id);
      }
    }
    this.approvals.set(item.id, item);
    this.renderApprovals();
  },

  _onApprovalResolved(info) {
    if (!info || !info.id) return;
    this._noteApprovalReadChange(info, true);
    this._approvalDrafts?.delete(info.id);
    // Clear the matching tab alert UNCONDITIONALLY: the inbox resolves on more
    // signals than the hook handlers do (superseded, expired, answered from
    // another device), clearPendingHooks is a no-op when nothing is set, and
    // with the inbox setting OFF the item was never stored in `this.approvals`
    // even though seedApprovals armed the alert — gating the clear on a map hit
    // would strand that alert forever.
    this.clearPendingHooks(info.sessionId, approvalKindToHook(info.kind));
    if (this.approvals?.delete(info.id)) this.renderApprovals();
  },

  // ─── Actions ─────────────────────────────────────────────────

  /**
   * Tell the server the session's pending IDLE prompt has been looked at, so
   * the yellow tab alert stays gone: `seedApprovals()` skips acknowledged
   * items on the next reload, and the resulting `approval:updated` broadcast
   * clears the alert on the user's other devices. Called by markIdleAlertSeen
   * (app.js), which owns the local half of the clear.
   *
   * Fire-and-forget: the alert is already down locally, `_apiJson` swallows
   * failures, and the worst case of a lost POST is today's behavior (yellow
   * returns after a reload). Runs regardless of `approvalsInboxEnabled`,
   * since the tab alert predates the inbox and is not gated on it.
   */
  acknowledgeIdleApprovalOnView(sessionId) {
    if (!sessionId) return;
    this._apiJson(`/api/approvals/session/${encodeURIComponent(sessionId)}/viewed`, { method: 'POST' });
  },

  async answerApproval(id, action, option) {
    if (this._approvalAnswerIsHeld(id)) return;
    const body = option !== undefined ? { action, option } : { action };
    const data = await this._apiJson(`/api/approvals/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body,
    });
    if (data) {
      this.showToast(action === 'deny' ? 'Denied' : 'Answer sent', 'success');
    } else {
      // 404/409 = resolved elsewhere or the dialog left the screen; refresh truth.
      this.showToast('Answer was not confirmed. No automatic retry was made.', 'warning');
      await this.seedApprovals();
    }
  },

  /** Idle prompts: send the typed line from the card's input as a prompt. */
  async answerApprovalIdleText(id) {
    if (this._approvalAnswerIsHeld(id)) return;
    const input = document.getElementById(`approvalText-${id}`);
    const text = input ? input.value.trim() : '';
    if (!text) return;
    if (!this._approvalDrafts) this._approvalDrafts = new Map();
    this._approvalDrafts.set(id, input.value);
    const data = await this._apiJson(`/api/approvals/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: { action: 'text', text },
    });
    if (data) this.showToast('Prompt sent', 'success');
    else {
      this.showToast('Answer was not confirmed. No automatic retry was made.', 'warning');
      await this.seedApprovals();
    }
  },

  _approvalHeldReason(item) {
    return item?.answerState === 'held' && typeof item.heldReason === 'string' && item.heldReason.trim()
      ? item.heldReason
      : 'Answer readiness is not confirmed. Reopen the inbox to refresh it.';
  },

  _approvalAnswerIsHeld(id) {
    const item = this.approvals?.get(id);
    if (item?.answerState === 'current') return false;
    this.showToast(this._approvalHeldReason(item), 'warning');
    return true;
  },

  async dismissApproval(id) {
    await this._apiJson(`/api/approvals/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: {} });
    // The SSE resolved event also lands; delete now for instant feedback.
    if (this.approvals?.delete(id)) this.renderApprovals();
  },

  openApprovalSession(id) {
    const item = this.approvals?.get(id);
    if (!item) return;
    this.closeApprovalsInbox();
    if (this.sessions.has(item.sessionId)) this.selectSession(item.sessionId);
  },

  /**
   * Push-notification action relay (sw.js → settings-ui notification-click →
   * here). Falls back to opening the session when the item is unknown, or
   * when the inbox is disabled (a stale notification from before the toggle
   * flipped can still carry an action).
   */
  // A notification is a hint to look, never an answer: whatever the action, an approval opens the drawer
  // so the human answers on the card the server shows (a push payload can be forged by any agent).
  handleNotificationAction(action, approvalId, sessionId) {
    if (approvalId && this.approvalsInboxEnabled()) {
      if (!document.getElementById('approvalsDrawer')?.classList.contains('open')) this.toggleApprovalsInbox();
      return;
    }
    if (sessionId && this.sessions.has(sessionId)) this.selectSession(sessionId);
  },

  // ─── Rendering ───────────────────────────────────────────────

  toggleApprovalsInbox() {
    const drawer = document.getElementById('approvalsDrawer');
    if (!drawer) return;
    if (drawer.classList.contains('open')) this.closeApprovalsInbox();
    else {
      drawer.classList.add('open');
      document.querySelector('.btn-approvals')?.setAttribute('aria-expanded', 'true');
      this.renderApprovals();
      this.seedApprovals();
    }
  },

  closeApprovalsInbox() {
    document.getElementById('approvalsDrawer')?.classList.remove('open');
    document.querySelector('.btn-approvals')?.setAttribute('aria-expanded', 'false');
  },

  /**
   * Items still waiting on a human. An acknowledged item (a human already looked, or the
   * session opened it acknowledged because it is watching its own background work) keeps
   * its card but arms no alert, so it must not light the bell either; this is the same
   * count `pendingApprovalCount()` gives `reverie tui`.
   */
  pendingApprovalsCount() {
    if (!this.approvals) return 0;
    let count = 0;
    for (const item of this.approvals.values()) if (!item.acknowledgedAt) count++;
    return count;
  },

  renderApprovals() {
    const count = this.pendingApprovalsCount();
    const btn = document.querySelector('.btn-approvals');
    if (btn) {
      // Marker-class visibility (base header rules are display !important):
      // the bell exists only while something is pending, so the header stays
      // untouched for everyone else.
      btn.classList.toggle('btn-approvals--hidden', count === 0 || !this.approvalsInboxEnabled());
      const badge = document.getElementById('approvalsBadge');
      if (badge) badge.textContent = String(count);
    }
    this.renderApprovalsDrawer();
    // Phone overview NEEDS YOU rows re-render on the tab-render tail; nudge it
    // so inline approve/deny buttons appear without a state change elsewhere.
    this.renderSessionTabs?.();
  },

  renderApprovalsDrawer() {
    const drawer = document.getElementById('approvalsDrawer');
    if (!drawer || !drawer.classList.contains('open')) return;
    const list = drawer.querySelector('.approvals-list');
    if (!list) return;
    const items = this.approvals ? [...this.approvals.values()].sort((a, b) => a.createdAt - b.createdAt) : [];
    if (!this._approvalDrafts) this._approvalDrafts = new Map();
    let focusedDraft = null;
    for (const input of list.querySelectorAll('.approval-text-input')) {
      const id = input.closest('[data-approval-id]')?.dataset.approvalId;
      if (id) this._approvalDrafts.set(id, input.value);
      if (id && input === document.activeElement) focusedDraft = {
        id, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
      };
    }
    for (const id of this._approvalDrafts.keys()) if (!this.approvals?.has(id)) this._approvalDrafts.delete(id);
    if (items.length === 0) {
      list.innerHTML = '<div class="approvals-empty">No pending approvals</div>';
      return;
    }
    list.innerHTML = items.map((item) => this._approvalCardHtml(item)).join('');
    for (const input of list.querySelectorAll('.approval-text-input')) {
      const id = input.closest('[data-approval-id]')?.dataset.approvalId;
      if (id && this._approvalDrafts.has(id)) input.value = this._approvalDrafts.get(id);
      if (id && focusedDraft?.id === id) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(focusedDraft.start, focusedDraft.end, focusedDraft.direction);
      }
    }
    // The quiet reason is the only pane-derived string on a card, and it is the one
    // an agent could write itself (it prints its own footer row), so it reaches the
    // DOM as text and never as markup. The card leaves an empty span for it.
    for (const item of items) {
      if (!item.acknowledgedReason) continue;
      const card = list.querySelector(`[data-approval-id="${CSS.escape(item.id)}"]`);
      const slot = card && card.querySelector('.approval-quiet');
      if (slot) slot.textContent = 'quiet, ' + item.acknowledgedReason;
    }
  },

  _approvalCardHtml(item) {
    const id = escapeHtml(item.id);
    const kindLabel = item.kind === 'permission' ? 'Permission' : item.kind === 'question' ? 'Question' : 'Idle';
    const summary = item.toolName
      ? `${item.toolName}${item.toolSummary ? ': ' + item.toolSummary : ''}`
      : item.message || '';
    const age = this._approvalAge(item.createdAt);
    const held = item.answerState !== 'current';
    const disabled = held ? ' disabled aria-disabled="true"' : '';
    let actions = '';
    if (item.kind === 'idle') {
      actions =
        `<div class="approval-text-row">` +
        `<input type="text" id="approvalText-${id}" class="approval-text-input" placeholder="Send a prompt…" data-i18n-skip ` +
        `onkeydown="if(event.key==='Enter')app.answerApprovalIdleText('${id}')">` +
        `<button class="approval-btn approval-btn-primary"${disabled} onclick="app.answerApprovalIdleText('${id}')">Send</button>` +
        `</div>`;
    } else if (item.answerInTerminal) {
      // Supervised-hook CLIs (DeepSeek Harness): keystrokes are unverifiable, so
      // Approve/Deny would hit the answer route and fail. Offer only Open session.
      actions = `<span class="approval-terminal-hint" data-i18n-skip>Answer in the terminal</span>`;
    } else if (item.options && item.options.length) {
      actions = item.options
        .map(
          (o) =>
            `<button class="approval-btn ${o.n === 1 ? 'approval-btn-primary' : ''}"${disabled} data-i18n-skip ` +
            `title="${escapeHtml(o.label)}" onclick="app.answerApproval('${id}','option',${o.n})">` +
            `${o.n}. ${escapeHtml(o.label.length > 42 ? o.label.slice(0, 42) + '…' : o.label)}</button>`
        )
        .join('');
    } else {
      actions =
        `<button class="approval-btn approval-btn-primary"${disabled} onclick="app.answerApproval('${id}','approve')">Approve</button>` +
        `<button class="approval-btn approval-btn-danger"${disabled} onclick="app.answerApproval('${id}','deny')">Deny (Esc)</button>`;
    }
    return (
      `<div class="approval-card approval-kind-${item.kind}" data-approval-id="${id}">` +
      `<div class="approval-card-head">` +
      `<span class="approval-kind-badge">${kindLabel}</span>` +
      `<span class="approval-session" data-i18n-skip>${escapeHtml(item.sessionName || item.sessionId.slice(0, 8))}</span>` +
      `<span class="approval-age" data-i18n-skip>${age}</span>` +
      `</div>` +
      // Filled by renderApprovalsDrawer through textContent, never here: see the note
      // there. An item a human acknowledged carries no reason and gets no line.
      (item.acknowledgedReason ? `<div class="approval-quiet" data-i18n-skip></div>` : '') +
      (held ? `<div class="approval-summary approval-held" role="status" data-i18n-skip>Answer held: ${escapeHtml(this._approvalHeldReason(item))}</div>` : '') +
      (summary ? `<div class="approval-summary" data-i18n-skip>${escapeHtml(summary)}</div>` : '') +
      (item.context ? `<pre class="approval-context">${escapeHtml(item.context)}</pre>` : '') +
      `<div class="approval-actions">${actions}</div>` +
      `<div class="approval-meta-actions">` +
      `<button class="approval-link" onclick="app.openApprovalSession('${id}')">Open session</button>` +
      `<button class="approval-link" onclick="app.dismissApproval('${id}')">Dismiss</button>` +
      `</div>` +
      `</div>`
    );
  },

  _approvalAge(createdAt) {
    const s = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  },
});
