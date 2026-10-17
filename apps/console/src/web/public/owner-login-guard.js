/**
 * @fileoverview Owner sign-in guard for the installed app (PWA) and the browser page.
 *
 * When owner-auth enforcement is on, an owner request without a valid owner session is refused
 * with HTTP 401 and `{ success: false, errorCode: 'UNAUTHORIZED' }` (src/owner-auth/policy.ts).
 * A page load is redirected by the server, but the installed app keeps running on its cached
 * shell and only sees its API calls fail. This guard watches every same-origin `/api/*` fetch
 * and, on exactly that refusal, opens the sign-in page once:
 * `<base>/owner/login?next=<this page's path + search + hash>`.
 *
 * It never redirects on a 403, any other status, a 401 without `errorCode: 'UNAUTHORIZED'`, or
 * when the page is already under `/owner`. One redirect per page load at most, and none within
 * ONCE_WINDOW_MS of the last one (a sessionStorage timestamp), so a sign-in page that bounces
 * back cannot start a redirect loop. `next` is always a same-origin relative path.
 *
 * Wrapping `window.fetch` covers every caller, including the notification-click / focus path
 * (settings-ui.js handles the service worker's `notification-click` message and its fetches run
 * through here) and chat-app.js (it calls `defaultView.fetch` at call time).
 *
 * @dependency none (loaded first among the app scripts in index.html)
 */
(function installOwnerLoginGuard(global) {
  'use strict';
  if (!global || typeof global.fetch !== 'function' || global.ReverieOwnerLoginGuard) return;

  const STORAGE_KEY = 'reverie:owner-login-redirect';
  const ONCE_WINDOW_MS = 60000;
  const base = String(global.__CODEMAN_BASE__ || '').replace(/\/+$/, '');
  const nativeFetch = global.fetch;
  let redirected = false;

  /** The path below the mount base ('' base: the path itself). */
  function appPath(pathname) {
    if (base && (pathname === base || pathname.startsWith(base + '/'))) return pathname.slice(base.length) || '/';
    return pathname;
  }

  function onOwnerPage() {
    const p = appPath(global.location.pathname).toLowerCase();
    return p === '/owner' || p.startsWith('/owner/');
  }

  /** Is this request a same-origin call to /api/* (with or without the mount base)? */
  function isApiRequest(input) {
    try {
      const raw = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input);
      const url = new URL(raw, global.location.href);
      if (url.origin !== global.location.origin) return false;
      const p = appPath(url.pathname);
      return p === '/api' || p.startsWith('/api/');
    } catch {
      return false;
    }
  }

  /**
   * A same-origin relative path to come back to, or '/' (with the base). Rejects anything that is
   * not a single leading '/', a protocol-relative '//', backslashes and control characters, and
   * re-checks the resolved origin.
   */
  function safeNext(raw) {
    const fallback = (base || '') + '/';
    if (typeof raw !== 'string' || raw.charAt(0) !== '/' || raw.charAt(1) === '/') return fallback;
    if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
    try {
      const url = new URL(raw, global.location.origin);
      if (url.origin !== global.location.origin) return fallback;
      const out = url.pathname + url.search + url.hash;
      return out.charAt(0) === '/' && out.charAt(1) !== '/' ? out : fallback;
    } catch {
      return fallback;
    }
  }

  function loginUrl() {
    const loc = global.location;
    return base + '/owner/login?next=' + encodeURIComponent(safeNext(loc.pathname + loc.search + loc.hash));
  }

  /** Take the one redirect this page load may make; false when one was made recently. */
  function claimRedirect() {
    if (redirected) return false;
    const now = Date.now();
    try {
      const last = Number(global.sessionStorage.getItem(STORAGE_KEY));
      if (last && now - last >= 0 && now - last < ONCE_WINDOW_MS) return false;
      global.sessionStorage.setItem(STORAGE_KEY, String(now));
    } catch {
      /* storage blocked: the in-memory flag still limits this page load to one redirect */
    }
    redirected = true;
    return true;
  }

  async function inspect(response) {
    if (!response || response.status !== 401 || onOwnerPage()) return;
    let body;
    try {
      body = await response.clone().json();
    } catch {
      return;
    }
    if (!body || body.errorCode !== 'UNAUTHORIZED') return;
    if (onOwnerPage() || !claimRedirect()) return;
    api.navigate(loginUrl());
  }

  function guardedFetch(input) {
    const result = nativeFetch.apply(global, arguments);
    if (isApiRequest(input)) {
      result.then(inspect, () => {}).catch(() => {});
    }
    return result;
  }

  const api = {
    STORAGE_KEY,
    ONCE_WINDOW_MS,
    safeNext,
    loginUrl,
    /** Replace, so Back from the sign-in page does not land on a page that sends it there again. */
    navigate(url) {
      global.location.replace(url);
    },
  };
  global.fetch = guardedFetch;
  global.ReverieOwnerLoginGuard = api;
})(typeof window !== 'undefined' ? window : undefined);
