/**
 * @fileoverview Service worker for PWA install + Web Push notifications.
 *
 * App-shell caching: on install, precaches the core UI assets so the app
 * launches instantly and works offline (or on flaky connections). Uses a
 * network-first strategy for navigation and API calls, cache-first for
 * static assets.
 *
 * Push notifications: receives push events from the Reverie server (via
 * web-push library) and displays OS-level notifications. Handles notification
 * clicks to focus an existing Reverie tab or open a new one.
 *
 * Lifecycle: skipWaiting on install, claim clients on activate -- ensures the
 * latest service worker takes control immediately without waiting for tab
 * refresh.
 *
 * @dependency None (runs in ServiceWorkerGlobalScope, isolated from page scripts)
 * @see src/push-store.ts -- server-side VAPID key management and subscription CRUD
 */

// Build identity. scripts/build.mjs rewrites this declaration after it content-
// hashes the assets; the literal below is what dev serves, and dev wants a
// stable key.
//
// Why the cache key MUST carry it: `activate` deletes every cache whose key is
// not the current one, so the old constant key meant that cleanup never deleted
// anything — hashed assets from every release ever deployed accumulated in one
// bucket until the origin hit its storage quota.
const BUILD_ID = 'dev';
const CACHE_NAME = `reverie-${BUILD_ID}`;

// Reverse-proxy base path: the worker is served at `<base>/sw.js`, so its own
// location tells us the mount prefix ('' at root, or '/reverie'). Every URL below
// is prefixed through B() so the cached shell, icons and API calls resolve under
// the mount instead of escaping to the origin root.
const SW_BASE = self.location.pathname.replace(/\/sw\.js$/, '');
const B = (p) => (p && p[0] === '/' ? SW_BASE + p : p);

// Content-hashed assets. scripts/build.mjs rewrites this declaration with the
// filenames it actually emitted; dev has no hashing, so the empty literal below
// is correct there and the unhashed modules are simply cached on first use by
// the runtime handler further down.
//
// This list used to be maintained by hand with the PRE-hash names, which the
// build then renamed — so in production every entry 404'd and the silent
// `.catch()` in install swallowed all of it. Measured against a running
// instance: 15 of 23 entries failed. Offline still worked, because the fetch
// handler caches every successful GET at runtime, but the precache warmed
// nothing while looking like it did. Deriving it from the same manifest that
// renames the files is the only thing that keeps the two from drifting again.
const HASHED_ASSETS = [];

// Core app shell -- cached on install for instant startup
const APP_SHELL = [
  '/',
  ...HASHED_ASSETS.map((p) => '/' + p),
  '/vendor/xterm.min.js',
  '/vendor/xterm-addon-fit.min.js',
  '/vendor/xterm-addon-unicode11.min.js',
  '/vendor/xterm.css',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  '/mobile-app.js',
  '/mobile-app.css',
].map(B);

// --- Install: precache app shell ---

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use addAll but don't fail install if some assets 404 (hashed filenames)
      return Promise.allSettled(
        APP_SHELL.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
  self.skipWaiting();
});

// --- Activate: clean old caches, claim clients ---

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// --- Fetch: network-first with cache fallback ---
// Network-first ensures deploys take effect immediately when online.
// Cache is only used when the network is unavailable (offline/flaky).

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET, WebSocket upgrades, and SSE streams
  if (request.method !== 'GET') return;
  if (request.headers.get('upgrade') === 'websocket') return;
  if (request.headers.get('accept') === 'text/event-stream') return;
  if (request.url.includes('/api/')) return;
  // A rendered HTML page is served `no-store` behind a capability that logout
  // revokes; caching a popped-out page here would let the offline fallback
  // serve it after the capability is gone.
  if (request.url.includes('/html-view/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      // ignoreSearch, or the precache can never be hit. `renderIndexHtml` runs
      // `cacheBustAssets`, which appends `?v=<mtime>` to EVERY same-origin
      // `.js`/`.css` reference — content-hashed names included, so the page asks
      // for `/app.556be563.js?v=1789423735875` while the precache stored
      // `/app.556be563.js`. `caches.match` is query-sensitive by default, so
      // every precached entry was unreachable and only `/`, the icons and the
      // manifest could ever be served offline.
      //
      // It also makes runtime-cached entries survive an mtime change: the same
      // file re-requested under a new `?v=` still matches the copy already held.
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});

// --- Push notifications ---

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const { title, hostTitle, body, tag, sessionId, roomId, approvalId, urgency, actions, board } = payload;

  const options = {
    body: body || '',
    tag: tag || 'reverie-default',
    icon: B('/icon-192.png'),
    badge: B('/icon-192.png'),
    data: { sessionId, roomId, approvalId, url: board === true ? B('/board.html') : roomId ? B(`/?room=${encodeURIComponent(roomId)}`) : (sessionId ? B(`/?session=${encodeURIComponent(sessionId)}`) : B('/')) },
    renotify: true,
    requireInteraction: urgency === 'critical',
  };

  // No action buttons, whatever the payload says. Any process that can read the push keys (every agent
  // in this container) can send a payload, so a notification is only ever a hint to open the app. An
  // Approve/Deny button answered with the owner's cookie from the lock screen, a confused deputy for
  // forged pushes. Approvals are answered in the app, on the card the server shows.

  // Match the in-page Notification format: "reverie:<host>: <event title>".
  // hostTitle is sent by servers >= the hostname-aware push payload change;
  // older servers omit it and we fall back to the bare title.
  const displayTitle = hostTitle && title
    ? `${hostTitle}: ${title}`
    : (title || hostTitle || 'Reverie');

  event.waitUntil(
    self.registration.showNotification(displayTitle, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { sessionId, roomId, approvalId, url } = event.notification.data || {};
  const candidate = new URL(url || B('/'), self.location.origin);
  const targetUrl = candidate.origin === self.location.origin && candidate.pathname.startsWith(SW_BASE + '/') ? candidate.href : B('/');
  // A click never answers anything (see the push handler): it opens the app, on the approval card when
  // the notification names one. `event.action` is ignored, so a forged button cannot pick an answer.
  const action = approvalId ? 'review' : null;
  event.waitUntil(openOrFocus(sessionId, action, approvalId, targetUrl, roomId));
});

function openOrFocus(sessionId, action, approvalId, targetUrl, roomId) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    // Try to find an existing Reverie tab
    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin && new URL(client.url).pathname.startsWith(SW_BASE + '/')) {
        client.postMessage({
          type: 'notification-click',
          sessionId,
          roomId,
          approvalId,
          action,
        });
        return client.focus();
      }
    }
    // No existing tab -- open a new one
    return self.clients.openWindow(targetUrl);
  });
}
