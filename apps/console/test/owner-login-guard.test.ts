/**
 * @fileoverview Frontend test for owner-login-guard.js: the installed app (PWA) opens the owner
 * sign-in page once when an /api call is refused with 401 + errorCode UNAUTHORIZED (owner-auth
 * enforce), and never otherwise. Builds a JSDOM window in-test under the default node env and
 * evaluates the real module (and, for the notification path, the real settings-ui.js) against it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const GUARD = readFileSync(new URL('../src/web/public/owner-login-guard.js', import.meta.url), 'utf-8');
const SETTINGS_UI = readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf-8');
const INDEX_HTML = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const BUILD = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf-8');

type Reply = { status: number; body?: unknown };
type GuardWin = Window &
  typeof globalThis & {
    ReverieOwnerLoginGuard: { navigate: (u: string) => void; safeNext: (raw: unknown) => string; STORAGE_KEY: string };
    __REVERIE_BASE__?: string;
    ReverieApp?: unknown;
  };

function resp(status: number, body: unknown) {
  const r = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
    clone() {
      return r;
    },
  };
  return r;
}

const UNAUTH = { status: 401, body: { success: false, error: 'Sign in as the owner', errorCode: 'UNAUTHORIZED' } };

function boot(url: string, reply: (path: string) => Reply, opts: { base?: string; storage?: Record<string, string> } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url, runScripts: 'outside-only' });
  const win = dom.window as unknown as GuardWin;
  if (opts.base) win.__REVERIE_BASE__ = opts.base;
  for (const [k, v] of Object.entries(opts.storage ?? {})) win.sessionStorage.setItem(k, v);
  const calls: string[] = [];
  win.fetch = (async (input: string) => {
    calls.push(String(input));
    const r = reply(String(input));
    return resp(r.status, r.body);
  }) as unknown as typeof fetch;
  (win as unknown as { eval: (s: string) => void }).eval(GUARD);
  const navigations: string[] = [];
  win.ReverieOwnerLoginGuard.navigate = (u: string) => navigations.push(u);
  return { dom, win, calls, navigations };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const nextOf = (navigation: string) => new URL(navigation, 'http://localhost').searchParams.get('next');

describe('owner-login-guard: when it redirects', () => {
  it('a 401 UNAUTHORIZED on /api opens /owner/login with the encoded current path, search and hash', async () => {
    const { win, navigations } = boot('http://localhost/?app=1&room=r%201#msg-9', () => UNAUTH);
    const res = await win.fetch('/api/chatrooms');
    expect(res.status).toBe(401); // the caller still gets the response untouched
    await settle();
    expect(navigations).toEqual(['/owner/login?next=' + encodeURIComponent('/?app=1&room=r%201#msg-9')]);
    expect(nextOf(navigations[0])).toBe('/?app=1&room=r%201#msg-9');
  });

  it('also fires for an absolute same-origin /api URL', async () => {
    const { win, navigations } = boot('http://localhost/', () => UNAUTH);
    await win.fetch('http://localhost/api/sessions');
    await settle();
    expect(navigations).toHaveLength(1);
  });

  it('keeps the mount base under a reverse-proxy sub-path', async () => {
    const { win, navigations } = boot('http://localhost/reverie/?app=1', () => UNAUTH, { base: '/reverie' });
    await win.fetch('/api/status');
    await settle();
    expect(navigations).toEqual(['/reverie/owner/login?next=' + encodeURIComponent('/reverie/?app=1')]);
  });
});

describe('owner-login-guard: when it does not', () => {
  it('does not redirect on a 403', async () => {
    const { win, navigations } = boot('http://localhost/', () => ({
      status: 403,
      body: { success: false, error: 'Only the owner may do this', errorCode: 'FORBIDDEN' },
    }));
    await win.fetch('/api/sessions');
    await settle();
    expect(navigations).toEqual([]);
  });

  it('does not redirect on a 403 that carries UNAUTHORIZED', async () => {
    const { win, navigations } = boot('http://localhost/', () => ({ status: 403, body: UNAUTH.body }));
    await win.fetch('/api/sessions');
    await settle();
    expect(navigations).toEqual([]);
  });

  it('does not redirect on a 401 with a different errorCode, no errorCode, or no JSON body', async () => {
    const bodies: unknown[] = [
      { success: false, error: 'x', errorCode: 'PASSWORD_CHANGE_REQUIRED' },
      { success: false, error: 'Sign in first' },
      undefined,
    ];
    for (const body of bodies) {
      const { win, navigations } = boot('http://localhost/', () => ({ status: 401, body }));
      await win.fetch('/api/owner/devices');
      await settle();
      expect(navigations, JSON.stringify(body)).toEqual([]);
    }
  });

  it('does not redirect on other statuses', async () => {
    for (const status of [200, 400, 404, 500, 502]) {
      const { win, navigations } = boot('http://localhost/', () => ({ status, body: { success: false, errorCode: 'UNAUTHORIZED' } }));
      await win.fetch('/api/sessions');
      await settle();
      expect(navigations, String(status)).toEqual([]);
    }
  });

  it('does not redirect when already on /owner/* (no loops)', async () => {
    for (const url of ['http://localhost/owner/login?next=%2F', 'http://localhost/owner/account', 'http://localhost/OWNER/login']) {
      const { win, navigations } = boot(url, () => UNAUTH);
      await win.fetch('/api/owner/status');
      await settle();
      expect(navigations, url).toEqual([]);
    }
  });

  it('ignores non-/api and cross-origin fetches', async () => {
    const { win, navigations } = boot('http://localhost/', () => UNAUTH);
    await win.fetch('/chat-app.js');
    await win.fetch('https://evil.example/api/x');
    await win.fetch('/apix/y');
    await settle();
    expect(navigations).toEqual([]);
  });
});

describe('owner-login-guard: once', () => {
  it('redirects only once per page load, however many calls are refused', async () => {
    const { win, navigations } = boot('http://localhost/?app=1', () => UNAUTH);
    await Promise.all([win.fetch('/api/a'), win.fetch('/api/b'), win.fetch('/api/c')]);
    await win.fetch('/api/d');
    await settle();
    expect(navigations).toHaveLength(1);
  });

  it('does not redirect again on a fresh load within the window (a login page that bounces back)', async () => {
    const first = boot('http://localhost/?app=1', () => UNAUTH);
    await first.win.fetch('/api/a');
    await settle();
    expect(first.navigations).toHaveLength(1);
    const key = first.win.ReverieOwnerLoginGuard.STORAGE_KEY;
    const stamp = first.win.sessionStorage.getItem(key)!;
    expect(Number(stamp)).toBeGreaterThan(0);

    const bounced = boot('http://localhost/?app=1', () => UNAUTH, { storage: { [key]: stamp } });
    await bounced.win.fetch('/api/a');
    await settle();
    expect(bounced.navigations).toEqual([]);

    const later = boot('http://localhost/?app=1', () => UNAUTH, { storage: { [key]: String(Date.now() - 61000) } });
    await later.win.fetch('/api/a');
    await settle();
    expect(later.navigations).toHaveLength(1);
  });

  it('still redirects (once) when sessionStorage throws', async () => {
    const { win, navigations } = boot('http://localhost/', () => UNAUTH);
    Object.defineProperty(win, 'sessionStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    await win.fetch('/api/a');
    await win.fetch('/api/b');
    await settle();
    expect(navigations).toHaveLength(1);
  });
});

describe('owner-login-guard: notification click / focus path', () => {
  it('a notification-click handled by settings-ui.js redirects when its fetch is refused', async () => {
    const { win, navigations, calls } = boot('http://localhost/?app=1', (p) =>
      p.startsWith('/api/chatrooms/') ? UNAUTH : { status: 200, body: { success: true, data: {} } }
    );
    // The real settings-ui.js service-worker wiring, on a minimal ReverieApp.
    const ReverieApp = function ReverieApp() {};
    win.ReverieApp = ReverieApp;
    (win as unknown as { eval: (s: string) => void }).eval(SETTINGS_UI);
    const sw = new win.EventTarget() as EventTarget & Record<string, unknown>;
    const registration = { active: {}, pushManager: { getSubscription: async () => null } };
    sw.register = async () => registration;
    sw.ready = Promise.resolve(registration);
    Object.defineProperty(win.navigator, 'serviceWorker', { value: sw, configurable: true });
    win.focus = () => {};
    const app = new (ReverieApp as unknown as new () => Record<string, (...a: unknown[]) => unknown>)();
    app.openChatroom = async (roomId: unknown) => {
      await win.fetch('/api/chatrooms/' + encodeURIComponent(String(roomId)));
    };
    await app.registerServiceWorker();

    sw.dispatchEvent(new win.MessageEvent('message', { data: { type: 'notification-click', roomId: 'ops' } }));
    await settle();
    expect(calls).toContain('/api/chatrooms/ops');
    expect(navigations).toEqual(['/owner/login?next=' + encodeURIComponent('/?app=1')]);
  });

  it('a notification that opens a new window (sw.js openWindow /?room=) redirects back to that room', async () => {
    const { win, navigations } = boot('http://localhost/?room=ops', () => UNAUTH);
    await win.fetch('/api/chatrooms/ops');
    await settle();
    expect(nextOf(navigations[0])).toBe('/?room=ops');
  });
});

describe('owner-login-guard: next is never an open redirect', () => {
  const evil = [
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example/x',
    '\\\\evil.example',
    '/\t/evil.example',
    'javascript:alert(1)',
    'evil',
    '',
  ];

  it('safeNext rejects absolute URLs, // prefixes, backslashes and control characters', () => {
    const { win } = boot('http://localhost/', () => UNAUTH);
    for (const raw of evil) expect(win.ReverieOwnerLoginGuard.safeNext(raw), raw).toBe('/');
    expect(win.ReverieOwnerLoginGuard.safeNext(null)).toBe('/');
    expect(win.ReverieOwnerLoginGuard.safeNext('/a/..//evil.example')).toBe('/');
    expect(win.ReverieOwnerLoginGuard.safeNext('/?room=a#b')).toBe('/?room=a#b');
  });

  it('a page whose path starts with // still produces a relative same-origin next', async () => {
    const { win, navigations } = boot('http://localhost//evil.example/x?y=1', () => UNAUTH);
    await win.fetch('/api/a');
    await settle();
    expect(navigations).toHaveLength(1);
    const next = nextOf(navigations[0])!;
    expect(next.startsWith('/')).toBe(true);
    expect(next.startsWith('//')).toBe(false);
    expect(next).not.toContain('\\');
    expect(new URL(next, 'http://localhost').origin).toBe('http://localhost');
    expect(navigations[0].startsWith('/owner/login?next=')).toBe(true);
  });
});

describe('owner-login-guard: wiring', () => {
  it('is loaded first among the app scripts, before constants.js wraps fetch', () => {
    const guard = INDEX_HTML.indexOf('<script defer src="owner-login-guard.js"></script>');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(INDEX_HTML.indexOf('<script defer src="constants.js"></script>'));
  });

  it('is content-hashed by the build, so sw.js precaches it', () => {
    expect(BUILD).toContain("'owner-login-guard.js',");
  });
});
