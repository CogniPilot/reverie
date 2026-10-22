/**
 * @fileoverview Desktop tab strip, one row: spawned sessions fold under their parent.
 *
 * With many agents the header strip wrapped onto several rows of lineage-linked tabs.
 * Here a session whose parent (or any ancestor) has a tab is folded away and counted
 * on its nearest visible ancestor as a "+N" badge; the badge opens a popover tree of
 * the family (avatar, name, status) and choosing one switches to it. The active session
 * is never folded. A family with a member that needs help makes the badge glow.
 *
 * The strip can also fold away entirely into the phone's sessions dropdown (the
 * needs-help chip stays), per device, from the toggle beside it or Alt+Shift+T.
 *
 * Rendering is a pass over the tabs the strip already drew (classes and one badge per
 * parent), run after every strip render through the switcher's scheduler, never a
 * rebuild: tab order, Alt+N numbering and drag stay exactly the strip's own. Only the
 * horizontal header strip folds; the vertical rail and the sidebar show every session.
 *
 * @mixin Extends ReverieApp.prototype via Object.assign
 * @dependency app.js, session-switcher.js (rows, ranking, scheduler, avatars)
 * @loadorder 12.566 (after session-switcher.js)
 */

/**
 * Pure: which tabs fold and under whom.
 * @param {Array<{id: string, parentId?: string|null}>} rows the strip's sessions, in order
 * @param {string|null} activeId never folded
 * @returns {{ hidden: Set<string>, families: Map<string, string[]> }} folded ids, and for
 *   each visible tab the folded descendants it carries, in strip order
 */
function computeTabFamilies(rows, activeId) {
  const present = new Map(rows.map((r) => [r.id, r]));
  const parentOf = (id) => {
    const p = present.get(id)?.parentId;
    return p && p !== id && present.has(p) ? p : null;
  };
  const hidden = new Set();
  for (const r of rows) {
    if (r.id !== activeId && parentOf(r.id)) hidden.add(r.id);
  }
  const families = new Map();
  for (const r of rows) {
    if (!hidden.has(r.id)) continue;
    // The nearest visible ancestor carries it (cycle-guarded).
    let up = parentOf(r.id);
    const seen = new Set([r.id]);
    while (up && hidden.has(up) && !seen.has(up)) {
      seen.add(up);
      up = parentOf(up);
    }
    if (!up || hidden.has(up)) {
      hidden.delete(r.id); // a cycle with no visible root: show it rather than lose it
      continue;
    }
    if (!families.has(up)) families.set(up, []);
    families.get(up).push(r.id);
  }
  return { hidden, families };
}

const TAB_FAMILIES_KEY = 'reverie:tabFamiliesFolded';
const TAB_STRIP_COLLAPSED_KEY = 'reverie:tabStripCollapsed';

Object.assign(ReverieApp.prototype, {
  _tabPref(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === '1';
    } catch {
      return fallback;
    }
  },

  _setTabPref(key, on) {
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      /* per-device convenience only */
    }
  },

  /** Fold children under parents (default on), unless the list is vertical. */
  _tabFamiliesActive() {
    if (this._isVerticalTabList?.() || this.isSessionSidebarActive?.()) return false;
    return this._tabPref(TAB_FAMILIES_KEY, true);
  },

  toggleTabFamilies() {
    this._setTabPref(TAB_FAMILIES_KEY, !this._tabPref(TAB_FAMILIES_KEY, true));
    this._applyTabFamilies();
  },

  /** Fold the whole strip into the sessions dropdown (or back). */
  toggleTabStripCollapsed() {
    const on = !this._tabPref(TAB_STRIP_COLLAPSED_KEY, false);
    this._setTabPref(TAB_STRIP_COLLAPSED_KEY, on);
    this._applyTabStripCollapsed();
    this.showToast?.(on ? 'Tabs folded into the sessions menu (Alt+Shift+T)' : 'Tab strip shown', 'info');
  },

  _applyTabStripCollapsed() {
    const on = this._tabPref(TAB_STRIP_COLLAPSED_KEY, false);
    document.documentElement.classList.toggle('tabs-collapsed', on);
    this._ensureTabStripToggle();
    const btn = document.getElementById('tabStripToggle');
    if (btn) {
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? 'Show the tab strip (Alt+Shift+T)' : 'Fold tabs into a menu (Alt+Shift+T)';
    }
    this._scheduleSessionSwitcher?.();
  },

  _ensureTabStripToggle() {
    if (document.getElementById('tabStripToggle')) return;
    const host = document.getElementById('sessionTabsHost');
    if (!host) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'tabStripToggle';
    btn.className = 'tab-strip-toggle';
    btn.setAttribute('aria-label', 'Fold tabs into a menu');
    btn.textContent = '☰';
    btn.onclick = () => this.toggleTabStripCollapsed();
    host.before(btn);
  },

  /** The pass run after every strip render: fold children, badge their parents. */
  _applyTabFamilies() {
    if (!this._tabStripCollapsedInit) {
      this._tabStripCollapsedInit = true;
      this._applyTabStripCollapsed();
    }
    const strip = document.getElementById('sessionTabs');
    if (!strip) return;
    const tabs = [...strip.querySelectorAll('.session-tab[data-id]')];
    // One row: the strip scrolls sideways instead of wrapping (it adds tabs-auto-wrap
    // by itself when tabs overflow; this class wins over it while folding is on).
    strip.classList.toggle('tabs-one-row', this._tabFamiliesActive());
    if (!this._tabFamiliesActive()) {
      this._foldedTabIds = new Set();
      for (const t of tabs) {
        t.classList.remove('tab-folded-child');
        t.querySelector('.tab-family-badge')?.remove();
      }
      return;
    }
    const rows = tabs.map((t) => ({ id: t.dataset.id, parentId: this.sessions?.get(t.dataset.id)?.parentSessionId }));
    const { hidden, families } = computeTabFamilies(rows, this.activeSessionId);
    const changed =
      !this._foldedTabIds ||
      hidden.size !== this._foldedTabIds.size ||
      [...hidden].some((id) => !this._foldedTabIds.has(id));
    this._foldedTabIds = hidden;
    const needing = new Set(
      typeof rankSessionsNeedingHelp === 'function'
        ? rankSessionsNeedingHelp(this._sessionSwitcherRows?.() || []).map((r) => r.id)
        : []
    );
    for (const t of tabs) {
      const id = t.dataset.id;
      t.classList.toggle('tab-folded-child', hidden.has(id));
      const kids = families.get(id);
      let badge = t.querySelector('.tab-family-badge');
      if (!kids) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'tab-family-badge';
        badge.addEventListener('pointerdown', (e) => e.stopPropagation());
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this._openTabFamily(id, badge);
        });
        t.append(badge);
      }
      badge.textContent = `+${kids.length}`;
      const help = kids.some((k) => needing.has(k));
      badge.classList.toggle('needs-help', help);
      badge.title = `${kids.length} spawned session${kids.length === 1 ? '' : 's'}${help ? ', one needs you' : ''}: click to see them`;
      badge.setAttribute('aria-label', badge.title);
    }
    // Lines to folded tabs would point at nothing: redraw without them.
    if (changed) this._updateConnectionLinesImmediate?.();
    this._revealActiveTab(strip);
    if (this._tabFamilyPopover) this._renderTabFamily();
  },

  /** Keep the active tab in view inside the one-row strip (never scrollIntoView: it moves the page). */
  _revealActiveTab(strip) {
    const tab = strip.querySelector(`.session-tab[data-id="${CSS.escape(this.activeSessionId || '')}"]`);
    if (!tab) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < s.left) strip.scrollLeft -= s.left - t.left + 8;
    else if (t.right > s.right) strip.scrollLeft += t.right - s.right + 8;
  },

  _openTabFamily(rootId, anchor) {
    this._closeTabFamily();
    const pop = document.createElement('div');
    pop.className = 'tab-family-popover';
    pop.setAttribute('role', 'listbox');
    pop.setAttribute('data-i18n-skip', '');
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - 328, r.left - 140)))}px`;
    this._tabFamilyPopover = { pop, rootId };
    this._renderTabFamily();
    this._tabFamilyDismiss = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) this._closeTabFamily();
    };
    document.addEventListener('pointerdown', this._tabFamilyDismiss, true);
    pop.querySelector('button')?.focus();
  },

  /** Safe when closed (Escape calls every close method). */
  _closeTabFamily() {
    if (!this._tabFamilyPopover) return;
    this._tabFamilyPopover.pop.remove();
    this._tabFamilyPopover = null;
    document.removeEventListener('pointerdown', this._tabFamilyDismiss, true);
  },

  _renderTabFamily() {
    const { pop, rootId } = this._tabFamilyPopover;
    const rows = new Map((this._sessionSwitcherRows?.() || []).map((r) => [r.id, r]));
    const help = new Map(
      (typeof rankSessionsNeedingHelp === 'function' ? rankSessionsNeedingHelp([...rows.values()]) : []).map((h) => [
        h.id,
        h.reason,
      ])
    );
    const childrenOf = (id) => [...rows.values()].filter((r) => r.session.parentSessionId === id).map((r) => r.id);
    const items = [];
    const walk = (id, depth, seen) => {
      for (const kid of childrenOf(id)) {
        if (seen.has(kid)) continue;
        seen.add(kid);
        items.push({ id: kid, depth });
        walk(kid, depth + 1, seen);
      }
    };
    walk(rootId, 0, new Set([rootId]));
    pop.replaceChildren(
      ...items.map(({ id, depth }) => {
        const row = rows.get(id);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tab-family-item';
        b.style.paddingLeft = `${8 + depth * 16}px`;
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(id === this.activeSessionId));
        const name = document.createElement('span');
        name.className = 'tab-family-name';
        name.textContent = row.session.name || id.slice(0, 8);
        const chip = document.createElement('span');
        const reason = help.get(id);
        chip.className = `session-switcher-chip session-switcher-chip--${row.state}`;
        chip.textContent = reason
          ? `needs help: ${reason}`
          : row.state === 'working'
            ? 'busy'
            : row.state === 'done'
              ? 'stopped'
              : row.state;
        b.append(this._sessionSwitcherAvatar(row.session), name, chip);
        b.onclick = () => {
          this._closeTabFamily();
          this.selectSession(id);
        };
        return b;
      })
    );
  },
});
