# Codeman Performance Optimization Plan

## Current State

The backend is **already production-grade** — SSE broadcasting, state persistence, terminal batching, buffer management, and memory patterns are all well-optimized. The biggest gains are on the **frontend delivery** side.

## Implemented Optimizations

### 1. V8 Compile Cache (10-20% faster cold start)

**Files:** `scripts/codeman-web.service`, `package.json`

Node.js re-parses and compiles all JS on every cold start. `NODE_COMPILE_CACHE` caches V8 compiled bytecode to disk, reusing it on subsequent starts.

- Added `Environment=NODE_COMPILE_CACHE=/home/arkon/.codeman/compile-cache` to systemd service
- Added to `npm start` script for non-systemd usage
- Zero code changes, immediate win on every restart

### 2. WebGL Addon Lazy-Loading (244KB saved on mobile, non-blocking on desktop)

**Files:** `src/web/public/index.html`, `src/web/public/app.js`

`xterm-addon-webgl.min.js` (244KB) was loaded eagerly for all users via `<script defer>`, but only used on desktop with WebGL2 support.

- Removed `<script defer>` from `index.html`
- Added dynamic script loading in `app.js` — only downloads on desktop when WebGL is needed
- Mobile users never download the file at all (244KB saved)
- Desktop: loads in parallel with page rendering, addon initializes when ready
- Graceful fallback: canvas renderer used if WebGL unavailable or script fails

### 3. Preload Hints (~50-100ms faster perceived load)

**Files:** `src/web/public/index.html`

Browser discovers `<script defer>` tags only when the parser reaches them at the bottom of `<body>`. By then, the HTML parse has blocked for hundreds of lines.

- Added `<link rel="preload" as="script">` in `<head>` for `vendor/xterm.min.js`, `constants.js`, `app.js`
- Browser starts fetching critical scripts immediately during HTML parse (before reaching `<body>`)
- Zero runtime overhead — just hints for the browser's preload scanner

### 4. Batch Tmux Reconciliation (N subprocess calls → 1)

**Files:** `src/tmux-manager.ts`

`reconcileSessions()` previously called `tmux has-session` + `tmux display-message` per known session, plus `tmux list-sessions` for discovery, plus `tmux display-message` per discovered session. With 20 sessions: 41+ subprocess calls.

- Replaced with single `tmux list-panes -a -F '#{session_name}\t#{pane_pid}'` call
- Builds a Map from the result, then does O(1) lookups for both known and discovered sessions
- Also replaced inner O(n) `isKnown` scan with a Set lookup
- 20 sessions: 41 subprocess calls → 1, with faster lookups

### 5. Asset Hashing / Cache Busting (already implemented)

**Files:** `scripts/build.mjs` (pre-existing)

Content-hash cache busting was already implemented in the build script:
- All app JS/CSS files get content hashes (`app.abc123.js`)
- `index.html` rewritten to reference hashed filenames
- Pre-compressed with gzip + Brotli
- 1-year immutable cache works correctly — new deploys get new filenames

## Already Optimized (No Action Needed)

| Area | Why It's Fine |
|------|---------------|
| **SSE Broadcasting** | Single serialization per broadcast, preformatted frames, backpressure handling, session subscription filtering |
| **State Persistence** | 500ms debounce, incremental per-session JSON caching, async atomic writes, circuit breaker on failures |
| **Terminal Batching** | Adaptive intervals (16-50ms), per-session queues, immediate flush at 32KB, array-based accumulation |
| **Buffer Management** | BufferAccumulator (array-push, lazy join), auto-trim at 2MB/1MB, no string concatenation in hot paths |
| **ANSI Stripping** | Pre-compiled regex via factory functions, single-pass processing |
| **Static File Serving** | @fastify/static with 1-year cache, pre-compressed Brotli/gzip, no-cache for HTML |
| **Memory Management** | CleanupManager, LRUMap, StaleExpirationMap, bounded buffers, explicit listener cleanup |
| **Import Patterns** | Pure ESM, lazy web server import, no circular deps, no dynamic imports in hot paths |
| **Config Loading** | Small constant files, no I/O at import time, specific imports (no barrel) |
