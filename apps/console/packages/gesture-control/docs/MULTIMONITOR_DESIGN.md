# Multi-monitor gesture design — in-page panels + spanned window (A + C)

**Status:** **A + C-span BUILT & validated at the desk (2026-06-08).** C-snap
(`getScreenDetails` snapping) still pending. Decided + built 2026-06-08.
**Supersedes** the OS-window detach as the *gesture* verb (see "Why detach
broke movability") — *now actually replaced in `entry.ts`, not just planned.*
**Companion docs:** `CODEMAN_DETACH_BRIEF.md` (the original window.open detach),
`../gesture-proto/docs/BUILD_PLAN.md` (canonical build spec, Phase 5).

> ## Implementation status (2026-06-08)
> - ✅ **A — in-page floating panels.** `entry.ts` `floatSession(id, x, y)` spawns
>   a `.cg-float` div with an `<iframe src="/session/:id">` (640×420) at the drop
>   point; panels are re-grabbable. Replaces `window.app.detachSession`. Commits
>   `581fcf9`, `3e0447a`.
> - ✅ **C-span — spanned window.** `scripts/span-codeman.sh` (Brave-first;
>   `BROWSER=` override) launches a `--app` window sized to the display union.
>   Commits `063fd8f`, `59946b8`. **Validated at the desk:** one window spans
>   both monitors (3432×1080) and a panel drags across the seam.
> - ✅ **Launch entry point in Codeman.** A header "multi-monitor" button (replaces
>   the notification bell) → `POST /api/system/span-displays` → spawns the span
>   script. Bundled `span-codeman.sh` into Codeman's repo. **PR #103** `95b0035`.
> - ✅ **Cache-bust** all same-origin module scripts/CSS (`renderIndexHtml` →
>   `cacheBustAssets`), so frontend edits show on a normal reload. PR #103 `b5ea711`.
> - ⏳ **C-snap** (`getScreenDetails` snapping + seam dead-band) — not built; not
>   required for basic cross-seam dragging. Also pending: the re-dock gesture/zone.
> - **Known caveats from the desk run:** dead band on a taller/offset external
>   display (inherent to one spanning rect); superwide lens not selectable in the
>   fresh span-window browser profile; 3-monitor works unchanged but dead-space +
>   cursor-sensitivity caveats grow.

---

## Goal

Pinch a Codeman session, drag it anywhere — including **across a second
physical monitor** — drop it, and have it stay where you put it and stay
grabbable again. The "fling a session onto the external display by gesture"
end-goal from the BUILD_PLAN backlog, made real **without losing the ability to
move a session after you've placed it.**

## The root constraint (why this design, not the others)

The hand only exists in **the one page that owns the camera**. Hand tracking,
the cursor, and `document.elementFromPoint` hit-testing all live in that single
document. **An OS window created by `window.open` is a sealed box that page
cannot reach into** — no shared DOM, no shared cursor.

> **Why detach broke movability.** Today `entry.ts` → `detach(id)` calls
> `window.app.detachSession(id)`, which `window.open`s the session into its own
> OS window. The instant it leaves the camera-owning page, the hand can never
> touch it again. Detach-by-pinch *works*, but it's a one-way trip.

**Rule:** anything you want to keep gesture-movable must stay inside **one
page's DOM.** This design honors that with two composed pieces:

- **A — In-page floating panels.** "Detach" pops a session into a free-floating,
  absolutely-positioned element *in the same page* (not an OS window), so the
  hand keeps control forever.
- **C — One window spanning both monitors.** Run Codeman in a single window
  stretched across both physical displays, so "drag across monitors" is just
  "drag across the page," and the second monitor's pixels are actually used.

Option **B** (one OS window per monitor + a distributed BroadcastChannel cursor
protocol + cross-window session hand-off) was considered and deferred: it's the
only path to *independent* per-monitor OS windows, but it's a much larger build
and reintroduces the cross-window wall this design exists to avoid.

---

## Part A — In-page floating panels

### Codeman already has the primitive

`panels-ui.js` has a `.detached` "floating window": an absolutely-positioned
`<div>` with `panel.style.top/left/width/height` and a drag handler
(`setupMonitorDrag`) — **all in-page, no `window.open`.** The session-tab detach
simply picked the wrong primitive (the OS-window one). Part A reuses the
in-page one.

### Concurrent session rendering — RESOLVED (2026-06-08): live floats are feasible now

The main *dashboard view* renders **one active session at a time** (a single
shared `this.terminal` opened into `#terminalContainer` in `terminal-ui.js:26`,
swapped by `selectSession()`). But the page is **not** limited to one terminal —
the PR #103 branch already ships **three independent in-page concurrent
floating-content subsystems** we can reuse, so a live floating panel per session
needs **no new Codeman rendering architecture**:

1. **Teammate terminals** (`panels-ui.js` `teammateTerminals` Map +
   `subagent-windows.js`). A `Map` of **concurrent live `new Terminal()`
   instances**, each `terminal.open(body)`'d into a floating panel, bound to a
   `sessionId` + tmux `paneTarget`, **seeded via REST** buffer fetch
   (`/api/sessions/:id/teammate-pane-buffer/:pane`), **input via REST**
   (`/api/sessions/:id/teammate-pane-input`), with lazy-mount (`_lazyPaneTarget`)
   and `dispose()` cleanup. *This is option 2 already built and shipping.*
2. **Log-viewer windows** (`panels-ui.js:2632`). Concurrent draggable floating
   windows, each with its own `EventSource` **SSE stream** and lifecycle map —
   proof of the generic "floating window + independent per-window stream"
   pattern.
3. **`/session/:id` solo route** (`server.ts:573`, `renderIndexHtml(soloId)`,
   `text/event-stream` at `:633`). A full **standalone live session page** —
   **iframe-able** — reusing the exact multi-client fan-out detach already
   depends on. Solo mode deliberately **omits** the gesture overlay
   (`server.ts:1010-1014`), so there's no nested-overlay problem.

**The PTY multi-viewer fan-out is confirmed** (the brief's open "yes"): a session
is addressable by multiple concurrent clients — the solo route, the teammate
REST endpoints, and the on-tab pop-out all view the same live session.

**Resolution:** skip the static-preview fallback. Build live floats directly,
ranked by new-code cost:

- **Primary — iframe the solo route.** `floatPanel(id)` =
  `<div class="cg-float" data-id><iframe src="/session/:id"></iframe></div>`.
  The iframe is a complete live session view (its own terminal + stream client);
  the gesture layer moves the **div** and the iframe rides along. Lowest new
  code; reuses proven fan-out; no terminal wiring. Trade-off: a full app shell
  per float (heavier — fine for a few, watch memory at many).
- **Richer alt — native teammate-style panel.** Mount a `new Terminal()` in the
  float body, seed via the session buffer endpoint, feed via the teammate
  stream. Native (no iframe), lighter per-float, same-document. Use if the
  iframe feels heavy or you want tighter integration.

Either way the hand only **places** the float; typing into it uses a keyboard
(focus the iframe / native terminal) — consistent with "gesture places,
keyboard types."

### Gesture grammar (replaces the current detach path in `entry.ts`)

The grab/drag/drop plumbing already exists; only the **drop action** changes.

- **Grab** a `.session-tab[data-id]` (unchanged: `onGrab`, ghost-follow).
- **Pull** past `DETACH_PULL_PX` to arm (unchanged: `grab.armed`).
- **Drop while armed** → **no longer** `window.app.detachSession`. Instead spawn
  an **in-page floating panel** for that session id at the drop point. New
  method `floatPanel(id, x, y)` replacing `detach(id)`.
- **Re-grab** a floating panel (new `PANEL_SELECTOR`, e.g. `.cg-float[data-id]`)
  → move it; drop anywhere → it stays. This is the capability detach lost.
- **Drop a panel back over the tab strip** (or a dock zone) → **re-dock**
  (remove the float; session returns to a plain tab). Mirrors the `.detached` →
  attach toggle Codeman already has.
- **Keep `window.open` detach as a separate, deliberate verb** — e.g. a button,
  or a distinct "throw up and off-screen" gesture — for intentionally parking a
  session in its own OS window. It is *not* the default pinch action anymore.

### `entry.ts` change surface

- New state: `floats: Map<string, FloatingPanel>` (id → element + position),
  parallel to the existing `grabs`/`taps` maps.
- `onGrab`: extend hit-testing to also match `PANEL_SELECTOR`, so an existing
  float can be re-grabbed (priority: panel over tab when overlapping).
- `onDrop`: replace `if (grab.armed) this.detach(grab.id)` with
  `this.floatPanel(...)`; add the panel re-dock branch.
- `floatPanel(id, x, y)`: create/show the in-page panel (Part A option 1/2),
  position it absolutely at the drop point. Idempotent per id (re-grab moves the
  existing one, never duplicates).
- Coordinate mapping is **already viewport-pixel based** (the click-through
  surface maps cursor → viewport px), so it needs **no change** for spanning —
  see Part C.

---

## Part C — One window spanning both monitors

Once the Codeman window physically covers both displays, Part A's panels drag
across the seam for free, because the gesture cursor is already in viewport
pixels and the viewport now spans both monitors.

### macOS setup (operational, near-zero code)

1. **System Settings → Desktop & Dock → uncheck "Displays have separate
   Spaces."** (Requires a logout/login.) This is what lets a single window
   straddle two physical displays.
2. Run Codeman **maximized, not fullscreen.** Browser fullscreen is *per
   display* and will **not** span — use a maximized/borderless window dragged to
   cover both monitors. (A kiosk/`--app` Chrome window sized to the union rect is
   the cleanest.) **Automated by `scripts/span-codeman.sh`** — it reads the
   display-union rect (Finder desktop bounds) and launches a **Brave-first**
   Chromium-family `--app` window sized to it (fresh per-browser profile so the
   geometry flags are honored; `BROWSER=` overrides — plain Chrome bounced on the
   desk machine). One-click from the **Codeman header "multi-monitor" button**
   (`POST /api/system/span-displays`, which spawns this script), or run it
   directly. Step 1 + logout is still manual; the script warns if spanning isn't
   active.
3. Arrange the two monitors as a contiguous rectangle in Display settings so the
   union has no vertical offset gap.

### Coordinate model & the bezel seam

- Enumerate displays with **`window.getScreenDetails()`** (Chrome, secure
  context, `window-management` permission). Gives each screen's
  `left/top/width/height/availLeft/...` in a **virtual-desktop coordinate
  space** spanning all monitors.
- Use it for **screen-edge snapping zones**: e.g. dropping a panel within the
  right screen's bounds snaps it to fill that screen; the seam between the two
  screens' rects is a "halt / boundary" zone the cursor crosses.
- **Account for the bezel gap.** The two monitors are physically separated, but
  the spanned window's pixels are contiguous — a panel dragged across the seam
  visually jumps the bezel. Optional: add a dead-band at the seam x-coordinate
  so a panel snaps to one side rather than straddling.
- `getScreenDetails` is **only needed for snapping/zone logic**, not for basic
  dragging — dragging works the moment the window spans. So Part C can ship in
  two steps: (1) just span + free drag, (2) add `getScreenDetails` snapping.

### Constraints to surface to the user

- macOS-specific; the "separate Spaces" toggle is global and affects all apps.
- Real fullscreen is unavailable (must run maximized).
- A bezel-width discontinuity sits in the middle of the coordinate space.
- `window-management` permission prompts once.

---

## Build phases

1. ✅ **A-MVP — in-page live float, single monitor (DONE, `581fcf9`/`3e0447a`).**
   `entry.ts` `floatSession(id, x, y)` spawns an **iframe of `/session/:id`** in a
   `.cg-float` div (640×420) at the drop point; re-grab + move work (re-dock zone
   still TBD). Movability restored — the live session rides inside the page. (The
   method is named `floatSession`, not the design-sketch `floatPanel`.)
2. ✅ **C-span — span the window (DONE, `063fd8f`/`59946b8`; validated at desk).**
   macOS "separate Spaces" off + `scripts/span-codeman.sh` launches a maximized
   `--app` window across the display union (Brave-first; `BROWSER=` override).
   **Confirmed:** panels drag across the seam — viewport mapping held with zero
   `entry.ts` change. Launchable one-click from the **Codeman header button** →
   `POST /api/system/span-displays` (PR #103 `95b0035`), or by running the script.
3. ⏳ **C-snap — screen-aware snapping (pending).** Add `getScreenDetails`; snap a
   panel to the screen it's dropped on; add the seam dead-band.
4. **A-alt (optional).** Swap the iframe float for a native teammate-style
   `new Terminal()` panel if the iframe shell feels heavy or many floats strain
   memory.

## Open questions / verification before coding

- [x] **Concurrent rendering — RESOLVED (2026-06-08).** A live session view
  *can* be mounted into an arbitrary in-page container concurrently with the
  main view. The PR #103 branch already ships it three ways (teammate terminals,
  log-viewer SSE windows, the iframe-able `/session/:id` solo route); fan-out
  confirmed. Primary path: iframe the solo route. See the resolved section above.
- [ ] **Native-panel live feed (only if taking A-alt, not the iframe):** trace
  the exact transport that pushes *continuous* teammate-pane output after the
  REST buffer seed (`pendingData` flush source). The iframe path sidesteps this.
- [ ] **`window.app.detachSession` location:** when wiring the *kept* OS-window
  detach verb, note this method was **not found in PR #103 source** (only
  server-side `detachSessionListeners`); it works at runtime, so confirm where
  it's actually defined before extending it.
- [ ] **Spanning feasibility on the actual desk setup** (monitor arrangement,
  whether "separate Spaces" off is acceptable to the user globally).
- [ ] **Re-dock target:** decide the re-dock gesture/zone (drop over tab strip
  vs a dedicated dock region).

## Touch-points summary

| Layer | File | Change | Status |
|-------|------|--------|--------|
| Gesture consumer | `gesture-proto/src/codeman/entry.ts` | `detach()` → `floatSession()`; `floats` map; panel re-grab; (later) re-dock branch + `getScreenDetails` snapping | ✅ float+re-grab done (`581fcf9`/`3e0447a`); re-dock/snap pending |
| Gesture core | `gesture-proto/src/gesture/*` | **none** — stays transport-agnostic | ✅ unchanged |
| Codeman — launch | `src/web/routes/system-routes.ts`, `src/web/public/{index.html,panels-ui.js}`, `scripts/span-codeman.sh` | header button → `POST /api/system/span-displays` → spawn span script (bundled into repo) | ✅ PR #103 `95b0035` |
| Codeman — caching | `src/web/server.ts` | `cacheBustAssets()` — `?v=<mtime>` on all same-origin `.js`/`.css` so frontend edits show on normal reload | ✅ PR #103 `b5ea711` |
| Ops | macOS display settings + `scripts/span-codeman.sh` | "separate Spaces" off + re-login; Brave-first maximized spanning window | ✅ validated at desk |
