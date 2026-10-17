# Codeman Gesture Control — Prototype Build Plan

> Canonical spec for this project. A Jarvis-style hand-tracking input layer for
> the Codeman dashboard. Webcam sees your hands; you pinch-drag session tabs
> between Screen columns and fire discrete gesture commands. Runs entirely
> in-browser, camera feed never leaves the machine.

Build it as a **standalone prototype first** (its own folder, fake tabs) so the
input feel can be validated on real hardware before any integration with
Codeman's existing drag/command code.

---

## Goal & success criteria

Build a `GestureController` module + a self-contained demo page that:

1. Opens the webcam and runs MediaPipe Gesture Recognizer at ~30fps.
2. Emits a smoothed cursor position and a `pinch` state (grab/release) from hand landmarks.
3. Lets you **drag fake tabs between columns by pinching**, dropping on release.
4. Fires **discrete gesture commands** (open palm, thumbs up, victory) onto an event bus.
5. Feels responsive — drag lag is not perceptible, jitter is filtered out.

**Done when:** you can sit at your desk, pinch a tab, move it to another column,
release, and it lands — reliably, without visible jitter, with the camera
mounted at your chosen angle.

---

## Tech stack

- **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`) — `GestureRecognizer` in `VIDEO` running mode, `numHands: 1` for v1 (add 2 later). Loads the prebuilt `gesture_recognizer.task` model + WASM from CDN.
- **Vanilla TS + Vite** for the prototype (no framework needed; keep it portable so the module drops into Codeman regardless of its stack). If Codeman is React, the module stays framework-agnostic and you wrap it in a hook at integration time.
- **One-Euro filter** for cursor smoothing — implement it directly, it's ~40 lines and is the correct tool for noisy interactive landmark streams (low lag at speed, heavy smoothing when still).
- **Web Worker** for inference is a **Phase 4** optimization — do NOT start there. Get it working on the main thread first; only move to a worker if the dashboard UI stutters.

---

## File structure

```
gesture-proto/
├── index.html              # demo page: video preview + columns of fake tabs
├── package.json
├── vite.config.ts
├── src/
│   ├── main.ts             # wires GestureController -> demo UI
│   ├── gesture/
│   │   ├── GestureController.ts   # core: camera + recognizer + state machine + events
│   │   ├── OneEuroFilter.ts       # cursor smoothing
│   │   ├── pinch.ts               # pinch detection w/ hysteresis
│   │   ├── landmarks.ts           # landmark index constants + helpers
│   │   └── types.ts               # event payload types, config
│   └── demo/
│       ├── tabs.ts         # fake tab/column model + render
│       └── overlay.ts      # draws hand skeleton + cursor dot over video (debug)
└── README.md
```

---

## Core algorithms (the parts that decide whether it feels good)

### 1. Cursor from landmarks
The drag cursor is the **midpoint of thumb tip (landmark 4) and index tip (landmark 8)**, in normalized [0,1] coords from MediaPipe.

- **Mirror X** (`x = 1 - x`) — the webcam image is flipped relative to the user.
- Map normalized → screen pixels against the dashboard's bounding rect.
- Run the resulting (x, y) through **two independent One-Euro filters** (one per axis) before using it. Raw landmarks jitter by several pixels even when the hand is still; this is the single most important quality step.

### 2. Pinch detection with hysteresis
Compute euclidean distance between landmark 4 and landmark 8. **Normalize by hand size** (e.g. distance wrist→middle-finger-MCP, landmarks 0→9) so the threshold is robust to how close the hand is to the camera.

- Use **two thresholds, not one** (hysteresis): enter pinch below `PINCH_ON` (e.g. 0.35 of hand size), exit only above `PINCH_OFF` (e.g. 0.5). This stops flickering between grab/release at the boundary — critical for not "dropping" a tab mid-drag.
- Require the pinch state to persist N frames (e.g. 2–3) before firing, to reject single-frame noise.

### 3. State machine
```
IDLE ──hand detected──> HOVER ──pinch on──> GRABBED ──pinch off──> (drop) ──> HOVER
  ^                        |                                                    |
  └────hand lost───────────┴────────────────hand lost────────────────────────┘
```
- `HOVER`: cursor moves, highlights the tab/column under it (hit-test).
- `GRABBED`: the grabbed tab follows the cursor; emit `drag` events.
- On `pinch off` in GRABBED: hit-test cursor against drop columns, emit `drop {tabId, targetColumnId}` or `dropCancelled` if outside any column.

### 4. Discrete gestures → command bus
From `result.gestures[0].categoryName`, debounced (fire once per gesture entry, not every frame while held):
- `Open_Palm` held ~1s → `command: "halt-all"` (dead-man's-switch — pauses every session; genuinely useful for autonomous loops).
- `Thumb_Up` → `command: "approve"`.
- `Victory` → `command: "new-session"`.
- Map these to the SAME command names your voice layer already dispatches, so both input sources converge on one dispatcher.

---

## GestureController public API (target shape)

```ts
const gc = new GestureController({
  video: videoEl,
  surface: dashboardEl,          // coords mapped against this element's rect
  numHands: 1,
  pinchOn: 0.35, pinchOff: 0.5,
  palmHoldMs: 1000,
});

gc.on("hover",  ({ x, y, targetId }) => {...});
gc.on("grab",   ({ x, y })           => {...});
gc.on("drag",   ({ x, y })           => {...});  // throttled to frame rate
gc.on("drop",   ({ targetColumnId }) => {...});
gc.on("command",({ name })           => {...});  // halt-all | approve | new-session
gc.on("status", ({ fps, handPresent, pinchDist }) => {...}); // debug HUD

await gc.start();   // requests camera, loads model
gc.stop();
```

Keep it **transport-agnostic**: it emits semantic events, it does NOT know about
Codeman's DOM. Integration is just subscribing to these events and calling
Codeman's existing tab-move / command functions.

---

## Phased build (each phase is independently testable — stop and feel it before moving on)

**Phase 0 — Scaffold & camera (½ day)**
Vite + TS project. `index.html` with a mirrored `<video>` and a "start" button (camera must be a user gesture). Confirm `getUserMedia` works and you see yourself. Must be served over http(s), not `file://`.

**Phase 1 — Recognizer + debug overlay (½ day)**
Load `GestureRecognizer` (`VIDEO` mode, CDN model+wasm). Run `recognizeForVideo(video, performance.now())` in a `requestAnimationFrame` loop. Draw the 21-point skeleton + an FPS counter on a canvas over the video. **Checkpoint: confirm you're getting ≥25fps on your actual camera/lighting setup.** Tune lighting here.

**Phase 2 — Cursor + pinch (1 day)**
Implement `OneEuroFilter` and `pinch.ts`. Render a cursor dot driven by the filtered thumb/index midpoint. Show live pinch distance in the HUD and a color change on grab. **Checkpoint: the dot is steady when your hand is still, and pinch grab/release is crisp with no flicker.** Tune filter constants (`minCutoff`, `beta`) and pinch thresholds here — this is where the "feel" is won or lost.

**Phase 3 — Drag the fake tabs (1 day)**
Build `tabs.ts`: 3 columns of draggable fake "sessions." Wire the state machine: hover-highlight, grab, drag-follow, drop-with-hit-test. **Checkpoint: you can move a tab across columns reliably 10/10 times.** This is the core demo and the real go/no-go for the whole idea.

**Phase 4 — Discrete commands + polish (1 day)**
Add gesture→command bus with debouncing and the 1s open-palm halt. Add an on-screen toast when a command fires. Optional: move inference to a Web Worker if the UI stutters; add second-hand support.

**Phase 5 — Codeman integration (✅ working, 2026-06-07)**
Drop `gesture/` into Codeman via a new consumer `src/codeman/entry.ts` (the core is unchanged; the demo's `main.ts` is *not* the integration point). It binds `grab`/`drag`/`drop` to real `.session-tab`s (grab-to-detach → `app.detachSession`) and pinch-taps the Run / Run Shell toolbar buttons. Runs in Codeman behind `CODEMAN_GESTURE=1`. See the detailed status under "Implementation status" below.

> **Prerequisite (decided 2026-06-06, ✅ done 2026-06-07): Codeman tab-detach first.**
> Codeman needed a **tab-detach / undock** feature — a session pops out into its
> own browser window — *before* gesture wiring, because gestures can only drag DOM
> *within* the one page that owns the camera (you can't drag a node across isolated
> tabs/OS windows). So undock is a Codeman session-placement op the gesture `drop`
> *triggers*. **Shipped** as `app.detachSession(id)` → `/session/:id` solo window +
> BroadcastChannel sync + re-dock on close (the gesture layer calls it directly).
> Per-monitor placement via `getScreenDetails` stays in the multi-monitor backlog.

---

## Tuning defaults to start from (then adjust by feel)
- One-Euro: `minCutoff ≈ 1.0`, `beta ≈ 0.01` (raise `beta` if drag lags during fast moves; lower `minCutoff` if it's jittery when still).
- Pinch: `PINCH_ON 0.35`, `PINCH_OFF 0.5` (fractions of hand-size reference distance).
- `min_detection_confidence` / `min_tracking_confidence` ≈ 0.6; lower if quick gestures get missed, raise if you get false hands.
- Camera: target 30–60fps, even frontal lighting on the hand zone (matters more than the sensor).

---

## Hardware note

Prototype on the **MacBook M1 Max built-in cam** for zero-friction Phase 0–3.
For the real setup, switch to **iPhone via Continuity Camera** mounted at desk
level aimed at your hand-gesture zone — best sensor + best angle. Decide
front-facing (pointing/pinch-to-grab) vs overhead (swipe/drag-on-a-plane) mount
before Phase 3, since it slightly changes the gesture grammar.

---

## Implementation status (kept current)

- ✅ Phase 0, ✅ Phase 1 — see top-level `CLAUDE.md` and `gesture-proto/README.md`.
- ✅ Phase 1 fps checkpoint — 60fps on MacBook + iPhone 17 Pro (Continuity Camera).
- ✅ Phase 2 — `OneEuroFilter.ts` + `pinch.ts`: filtered cursor dot + pinch hysteresis. Cursor + `pinchDist` + `pinching` on the `status` event; HUD shows pinch distance, cursor ring turns green on grab.
- ✅ Phase 3 — `demo/tabs.ts`: 3 Screen columns of draggable session tabs. Controller owns the per-hand pinch state machine and emits `grab`/`drag`/`drop` in surface pixels (with a `hand` id); the demo hit-tests and moves tabs. Two-handed (drag two tabs at once); drop-on-vanish releases a tab if a pinched hand leaves frame.
- ✅ Beyond plan — two-hand tracking (`numHands: 2`, filters keyed by handedness) and a live camera picker.
- ✅ Camera (2026-06-06) — front-facing iPhone 17 Pro main lens (Chrome) is the default. **The superwide / Desk View (ultra-wide, overhead) camera now works with no issues and tracking is confirmed on it** — the earlier "Safari-only / stretched / unusable" finding is superseded. Pick either via the in-app camera picker.
- ✅ Phase 4 (built) — `commands.ts`: debounced gesture→command bus. `Thumb_Up`→approve, `Victory`→new-session (edge-triggered, fire once per entry), `Open_Palm` held `palmHoldMs`→halt-all (dead-man's-switch) with a 0–1 `haltProgress` charge surfaced on `status`. Commands ignore a pinching (mid-drag) hand.
- ⛔ **Phase 4 unwired in the demo (2026-06-06).** User wants pinch-drag only — an open palm while reaching to pinch kept charging the hold-to-halt. `main.ts` no longer subscribes to `command`/`haltProgress` and the command/charge toasts are gone. The `GestureController` core is untouched and still emits both events, so Phase 5 (or a re-enabled demo) can pick them up unchanged.
- 🐛 **Drag-position fix (2026-06-06).** A `.dragging` tab is `position: absolute`; the `.column`s establish a containing block via `backdrop-filter`, so board-local left/top were offset by the column's own position — tabs in the middle/right columns flew to the right on grab. Fix: `tabs.ts` reparents the floating tab onto `#board` (no filter/transform) for the drag, so the coordinates `moveTo` computes match the containing block.
- ✅ **Phase 5 — WORKING at the desk (2026-06-07).** Prerequisite cleared: Codeman tab-detach/undock works in the runtime (`app.detachSession(id)` is the idempotent hook). The gesture overlay runs live in the real Codeman dashboard on `:5000` and was confirmed by the user (normal tab): fullscreen cam + hand/cursor tracking, undock-by-pinch, and Run/Run Shell taps.
  - **Integration shape: in-page overlay, built into Codeman beta.** The gesture `core` (`src/gesture/`) ships **unchanged**; the consumer is `src/codeman/entry.ts`, esbuild-bundled (`npm run build:codeman`) and served by Codeman at `/gesture/gesture-codeman.js`. A full-viewport, click-through overlay maps coords straight to `elementFromPoint`.
  - **Gestures (routed by what the pinch lands on):** (a) **grab → in-page floating panel** *(⚠️ pivoted 2026-06-08 — was grab-to-detach)*: pinch a `.session-tab`, a ghost clone follows the hand, pull >`DETACH_PULL_PX` (70) and release → `floatSession(id, x, y)` spawns a re-grabbable `.cg-float` iframe of `/session/:id` (640×420). This **replaced** `window.app.detachSession(id)` (an OS window is a sealed box the hand can't move again — a one-way trip); the float stays in-page so the hand keeps control. See `../../docs/MULTIMONITOR_DESIGN.md`. (b) **Run / Run Shell taps** — pinch over `#runBtn`→`app.run()` / `.btn-shell`→`app.runShell()` and release in place; drift >`TAP_CANCEL_PX` (45) cancels. `CLICK_SELECTOR` is the extensible list. (c) **Fullscreen dimmed cam** by default, **⛶** toggles corner PiP.
  - **Self-hosted MediaPipe (no CDN).** `entry.ts` passes `wasmBase: "/gesture/wasm"` + `modelUrl: "/gesture/gesture_recognizer.task"`; Codeman serves them same-origin. The CDN path failed in the normal browser tab (content/ad blocker blocking `jsdelivr`/`googleapis`) → surfaced as `failed: {"isTrusted":true}` once `entry.ts` learned to report non-Error throws. Core also gained a GPU→CPU delegate fallback.
  - **Gated by `CODEMAN_GESTURE=1` (OFF by default).** Under the flag Codeman injects the module script (dashboard only, not `/session/:id` solo popups), cache-busts it with `?v=<mtime>` (static is `max-age=1y`), and widens CSP (`'wasm-unsafe-eval'` + `worker-src 'self' blob:`; same-origin assets now covered by `'self'`). Flag off ⇒ Codeman HTML/CSP unchanged.
  - **Codeman-side / version control:** the detach + instance isolation + base gesture overlay are committed on `Ark0N/Codeman` branch `beta/session-detach`, open as **PR #103** (tip `afea6d6`; `ceca853` after I fixed its `auth.ts` format:check → CI green). Gotcha: the local prod clone `~/.codeman/app` tracks only `master`, so the branch is hidden until `git fetch origin beta/session-detach` (this briefly misled me into a bogus local reconstruction `03b31b8`, since deleted). The session improvements — direct-detach via `window.app.detachSession`, Run/Run Shell pinch-taps, self-hosted MediaPipe (`/gesture/wasm` + `.task`), and the `server.ts` mtime cache-bust — were **ported onto PR #103** in commit `eea84db` (CI green); their source is `Ark0N/codeman-gesture-control` (`src/codeman/entry.ts`).
  - **Commits (gesture-proto):** `ddf9cda` (consumer: detach/cam/errors) → `2dd97da` (detach direct) → `21ef793` (Run/Run Shell taps) → `e055b79` (self-host MediaPipe).
  - **Next:** tune feel; optional in-strip reorder (deferred — user chose detach-only) and more buttons (Stop). Discrete `command` events remain available but unwired (pinch-only). Hand-off brief: `../docs/CODEMAN_DETACH_BRIEF.md`.

## Backlog (requested, for later)

- ✅ **Fullscreen mode** — done. Toggle button fullscreens the `#stage`;
  `:fullscreen` CSS fills the viewport and the coord mapping adapts since it
  reads the stage rect every frame.
- ✅ **Multi-monitor mode — A+C BUILT & validated at the desk (2026-06-08).** The
  eventual real goal (fling a Codeman session onto an external display by gesture)
  is reached. **Design → [`../../docs/MULTIMONITOR_DESIGN.md`](../../docs/MULTIMONITOR_DESIGN.md)**,
  approach **A+C**:
  - **A — in-page floating panels** (`581fcf9`, `3e0447a`): `entry.ts`
    `floatSession(id, x, y)` pops a tab into a re-grabbable `.cg-float` iframe of
    `/session/:id` (640×420) instead of `window.app.detachSession`. The session
    stays in the camera-owning page's DOM, so the hand keeps control — fixing the
    one-way-trip flaw of OS-window detach.
  - **C-span — spanned window** (`063fd8f`, `59946b8`): `scripts/span-codeman.sh`
    launches a Brave-first (`BROWSER=` override) `--app` window sized to the
    display union; prereq macOS "Displays have separate Spaces" OFF + re-login.
    One-click via the **Codeman header button** → `POST /api/system/span-displays`
    (PR #103 `95b0035`). **Validated:** one window spans both monitors and a panel
    drags across the seam.
  - **C-snap** (`getScreenDetails` snapping + seam dead-band) and the **re-dock**
    gesture/zone are **still pending** — not needed for basic cross-seam dragging.
  - **Concurrent-rendering question** was RESOLVED first: Codeman already mounts
    live terminals into floating panels (teammate terminals, log-viewer SSE
    windows, the iframe-able `/session/:id` solo route), so the live float needed
    no new Codeman rendering.

Note: the public event surface evolved from the original API sketch. The
controller stays transport-agnostic but emits coordinate-only `grab`/`drag`/
`drop` (hit-testing lives in the consumer, since only it knows the DOM/columns).
`hover`/`dropCancelled`/`targetId` were dropped; hover highlighting is derived
from the `status` snapshot instead.
