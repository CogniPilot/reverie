// demo/tabs.ts — Phase 3 fake-tab board.
//
// 3 columns of draggable "session" tabs, driven entirely by gesture events
// (no mouse). The board overlays the camera stage, so surface-pixel coords
// from GestureController map straight onto board-local coords.
//
// Source of truth for which tab is in which column is the DOM itself. The
// state machine here is tiny: grab → (drag)* → drop, tracked per hand so two
// hands can drag two tabs at once.

interface Tab {
  id: string;
  el: HTMLElement;
}

interface Column {
  id: string;
  title: string;
  el: HTMLElement;
  list: HTMLElement;
}

interface Grab {
  tab: Tab;
  originList: HTMLElement;
  w: number;
  h: number;
}

/** A hovering cursor for highlight purposes. */
export interface HoverPoint {
  x: number;
  y: number;
  pinching: boolean;
}

const INITIAL: Array<{ id: string; title: string; tabs: string[] }> = [
  { id: 'screen-1', title: 'Screen 1', tabs: ['auth-refactor', 'api-tests'] },
  { id: 'screen-2', title: 'Screen 2', tabs: ['db-migrate', 'ui-polish', 'docs'] },
  { id: 'screen-3', title: 'Screen 3', tabs: ['ci-fix'] },
];

export class TabsBoard {
  private columns: Column[] = [];
  private tabs = new Map<string, Tab>();
  /** hand id → the tab it is currently dragging. */
  private grabs = new Map<string, Grab>();

  /** @param onDrop notified after a settled drop: (tab, column or null if cancelled). */
  constructor(
    private root: HTMLElement,
    private onDrop?: (tabId: string, columnId: string | null) => void
  ) {
    this.build();
  }

  private build(): void {
    this.root.classList.add('board');
    for (const col of INITIAL) {
      const el = document.createElement('div');
      el.className = 'column';
      el.dataset.col = col.id;

      const header = document.createElement('header');
      header.textContent = col.title;

      const list = document.createElement('div');
      list.className = 'tablist';

      el.append(header, list);
      this.root.append(el);
      this.columns.push({ id: col.id, title: col.title, el, list });

      for (const id of col.tabs) {
        const tab = this.makeTab(id);
        list.append(tab.el);
      }
    }
  }

  private makeTab(id: string): Tab {
    const el = document.createElement('div');
    el.className = 'tab';
    el.dataset.tab = id;
    el.textContent = id;
    const tab: Tab = { id, el };
    this.tabs.set(id, tab);
    return tab;
  }

  // ---- Geometry --------------------------------------------------------

  /** Element rect in board-local coords (origin = board top-left). */
  private localRect(el: HTMLElement): DOMRect {
    const r = el.getBoundingClientRect();
    const base = this.root.getBoundingClientRect();
    return new DOMRect(r.left - base.left, r.top - base.top, r.width, r.height);
  }

  /** Hit-test slop (px). Cursor jitter + a small target shouldn't fight you. */
  private static readonly GRAB_PAD = 18;

  private static contains(r: DOMRect, x: number, y: number, pad = 0): boolean {
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  private columnAt(x: number, y: number): Column | null {
    for (const c of this.columns) {
      if (TabsBoard.contains(this.localRect(c.el), x, y)) return c;
    }
    return null;
  }

  /** Topmost ungrabbed tab under the point. Nearest-center wins ties so the
   *  padded hit-areas of adjacent tabs resolve to the most likely target. */
  private tabAt(x: number, y: number): Tab | null {
    let best: Tab | null = null;
    let bestDist = Infinity;
    for (const tab of this.tabs.values()) {
      if (this.isGrabbed(tab.id)) continue;
      const r = this.localRect(tab.el);
      if (!TabsBoard.contains(r, x, y, TabsBoard.GRAB_PAD)) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = tab;
      }
    }
    return best;
  }

  private isGrabbed(tabId: string): boolean {
    for (const g of this.grabs.values()) if (g.tab.id === tabId) return true;
    return false;
  }

  // ---- Highlights (driven each frame from the status snapshot) ---------

  /** Recompute hover highlights from the full set of present cursors. */
  hover(points: HoverPoint[]): void {
    this.root.querySelectorAll('.col-hot, .tab-hot').forEach((el) => el.classList.remove('col-hot', 'tab-hot'));

    for (const p of points) {
      this.columnAt(p.x, p.y)?.el.classList.add('col-hot');
      // Only show a grab affordance when the hand is open (not pinching).
      if (!p.pinching) this.tabAt(p.x, p.y)?.el.classList.add('tab-hot');
    }
  }

  // ---- Drag state machine ---------------------------------------------

  grab(hand: string, x: number, y: number): void {
    if (this.grabs.has(hand)) return;
    const tab = this.tabAt(x, y);
    if (!tab) return;

    const rect = this.localRect(tab.el);
    this.grabs.set(hand, {
      tab,
      originList: tab.el.parentElement as HTMLElement,
      w: rect.width,
      h: rect.height,
    });
    tab.el.classList.add('dragging');
    tab.el.style.width = `${rect.width}px`;
    // Reparent the floating tab onto the board root before positioning it.
    // A `.column` can't be the containing block: its `backdrop-filter` makes it
    // the containing block for absolutely-positioned children, so our
    // board-local left/top would be offset by the column's own position (tabs
    // in the middle/right columns flew off to the right). #board has no
    // filter/transform, so it's a stable origin that matches moveTo's coords.
    this.root.append(tab.el);
    this.moveTo(tab.el, x, y, rect.width, rect.height);
  }

  drag(hand: string, x: number, y: number): void {
    const g = this.grabs.get(hand);
    if (!g) return;
    this.moveTo(g.tab.el, x, y, g.w, g.h);
  }

  drop(hand: string, x: number, y: number): void {
    const g = this.grabs.get(hand);
    if (!g) return;
    this.grabs.delete(hand);

    const target = this.columnAt(x, y);
    const dest = target ? target.list : g.originList;
    dest.append(g.tab.el);

    g.tab.el.classList.remove('dragging');
    g.tab.el.style.removeProperty('width');
    g.tab.el.style.removeProperty('left');
    g.tab.el.style.removeProperty('top');

    this.onDrop?.(g.tab.id, target ? target.id : null);
  }

  /** Center the floating tab on the cursor (clamped to the board). */
  private moveTo(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    const base = this.root.getBoundingClientRect();
    const left = Math.max(0, Math.min(x - w / 2, base.width - w));
    const top = Math.max(0, Math.min(y - h / 2, base.height - h));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
}
