/**
 * @fileoverview The owner sign-in and account pages. Self-contained (no chat-app bundle), sized
 * for a phone, light and dark. All server text is inserted with textContent; the only markup taken
 * from the server is the QR code SVG that `qrcode` generates for the enrolment URL.
 */

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5b6472;--line:#d9dde3;--accent:#3b5bdb;--danger:#c92a2a}
@media (prefers-color-scheme:dark){:root{--bg:#15171c;--card:#1e2128;--text:#e7e9ee;--muted:#9aa3b2;--line:#323743;--accent:#7b93f3;--danger:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,sans-serif}
main{max-width:420px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:8px 0 16px}h2{font-size:17px;margin:20px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
label{display:block;margin:10px 0 4px;color:var(--muted);font-size:14px}
input[type=text],input[type=password]{width:100%;font-size:16px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
button{min-height:44px;font-size:16px;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer;margin-top:12px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;width:100%}
button.danger{color:var(--danger)}
.muted{color:var(--muted);font-size:14px}.error{color:var(--danger);min-height:1.4em;margin-top:8px}
.codes{font-family:ui-monospace,monospace;font-size:15px;columns:2;padding-left:18px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid var(--line);padding:8px 0}
.qr{background:#fff;display:inline-block;border-radius:8px;padding:6px}
[hidden]{display:none!important}
`;

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><link rel="icon" href="data:,"><title>${title}</title><style>${STYLE}</style></head>
<body><main>${body}</main><script src="/owner/owner.js"></script></body></html>`;

export const LOGIN_PAGE = shell(
  'Reverie: sign in',
  `<h1>Reverie</h1>
<form class="card" id="password-form" data-page="login">
  <label for="username">Username</label><input type="text" id="username" autocomplete="username" autocapitalize="none" required>
  <label for="password">Password</label><input type="password" id="password" autocomplete="current-password" required>
  <button class="primary" type="submit">Sign in</button><div class="error" id="password-error"></div>
</form>
<form class="card" id="factor-form" hidden>
  <p class="muted" id="factor-hint">Enter the 6-digit code from your authenticator app.</p>
  <label for="code" id="code-label">Code</label><input type="text" id="code" inputmode="numeric" autocomplete="one-time-code">
  <label><input type="checkbox" id="remember"> Remember this device for 30 days</label>
  <button class="primary" type="submit">Continue</button>
  <button type="button" id="use-recovery">Use a recovery code instead</button><div class="error" id="factor-error"></div>
</form>
<form class="card" id="change-form" hidden>
  <p class="muted">Choose your own password to replace the one-time password (at least 12 characters).</p>
  <label for="new-password">New password</label><input type="password" id="new-password" autocomplete="new-password" required>
  <label for="new-password-2">Repeat it</label><input type="password" id="new-password-2" autocomplete="new-password" required>
  <button class="primary" type="submit">Save and continue</button><div class="error" id="change-error"></div>
</form>`
);

export const ACCOUNT_PAGE = shell(
  'Reverie: owner account',
  `<h1>Owner account</h1><div data-page="account"></div>
<p id="signed-out" hidden>You are not signed in. <a href="/owner/login">Sign in</a></p>
<div id="account" hidden>
 <section class="card"><h2>Two-step sign-in</h2><p class="muted" id="tf-status"></p>
  <button id="tf-start" hidden>Set up an authenticator app</button>
  <div id="tf-enrol" hidden><p class="muted">Scan this with your authenticator app, or enter the key by hand, then type the code it shows.</p>
   <div class="qr" id="tf-qr"></div><p class="muted">Key: <code id="tf-secret"></code></p>
   <label for="tf-code">Code</label><input type="text" id="tf-code" inputmode="numeric" autocomplete="one-time-code">
   <button class="primary" id="tf-confirm">Turn on</button></div>
  <div id="tf-codes" hidden><p><strong>Recovery codes.</strong> Each works once if you lose your phone. They are shown only now: save them somewhere safe.</p><ol class="codes" id="tf-code-list"></ol></div>
  <div id="tf-manage" hidden><label for="tf-manage-code">Current authenticator code</label><input type="text" id="tf-manage-code" inputmode="numeric">
   <button id="tf-regenerate">New recovery codes</button>
   <label for="tf-disable-password">Password (to turn two-step off)</label><input type="password" id="tf-disable-password" autocomplete="current-password">
   <button class="danger" id="tf-disable">Turn two-step off</button></div>
  <div class="error" id="tf-error"></div></section>
 <section class="card"><h2>Remembered devices</h2><div id="devices"></div><p class="muted" id="no-devices">None.</p></section>
 <section class="card"><h2>Password</h2>
  <label for="pw-current">Current password</label><input type="password" id="pw-current" autocomplete="current-password">
  <label for="pw-next">New password</label><input type="password" id="pw-next" autocomplete="new-password">
  <div id="pw-code-row" hidden><label for="pw-code">Authenticator code</label><input type="text" id="pw-code" inputmode="numeric" autocomplete="one-time-code"></div>
  <p class="muted">At least 12 characters; a few unrelated words work well. Other browsers and remembered devices are signed out.</p>
  <button id="pw-change">Change password</button><div class="error" id="pw-error"></div></section>
 <section class="card"><button id="logout">Sign out</button>
  <button class="danger" id="logout-all">Sign out everywhere (all browsers and remembered devices)</button></section>
 <p><a href="/">Back to Reverie</a></p>
</div>`
);

/**
 * The page to open after signing in, from `?next=`: a page on this origin, never another origin and
 * never the sign-in pages. The value is resolved the way the browser would resolve it (so `/\t/x`,
 * `//x` and `/\\x` all count as other origins), and the result is the ABSOLUTE same-origin URL: a
 * path alone could normalise to `//host` (`/.//x`, `/a/..//x`) and leave the origin again.
 * Embedded in the page script below, so it must stay plain JavaScript.
 */
export function safeNext(raw: string | null, origin: string): string {
  if (!raw || raw.charAt(0) !== '/') return '/';
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin || url.pathname.toLowerCase().startsWith('/owner')) return '/';
    return url.href;
  } catch {
    return '/';
  }
}

export const OWNER_SCRIPT = `'use strict';
const $ = (id) => document.getElementById(id);
async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch {}
  if (!res.ok || json.success === false) {
    const wait = json.retryAfter ? ' (try again in ' + json.retryAfter + ' s)' : '';
    throw new Error((json.error || ('HTTP ' + res.status)) + wait);
  }
  return json.data || {};
}
const show = (el, on) => { el.hidden = !on; };
// Where to go after signing in: a same-site path from ?next=, never another origin or the sign-in pages.
const safeNext = ${safeNext.toString()};
const nextUrl = () => safeNext(new URLSearchParams(location.search).get('next'), location.origin);
const say = (el, text) => { el.textContent = text || ''; };

function login() {
  let challenge = ''; let typedPassword = ''; let recovery = false;
  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault(); say($('password-error'));
    typedPassword = $('password').value;
    try {
      const r = await api('POST', '/api/owner/login', { username: $('username').value, password: typedPassword });
      if (r.next === 'second-factor') { challenge = r.challenge; show($('password-form'), false); show($('factor-form'), true); $('code').focus(); }
      else if (r.next === 'change-password') { show($('password-form'), false); show($('change-form'), true); }
      else location.href = nextUrl();
    } catch (err) { say($('password-error'), err.message); }
  });
  $('use-recovery').addEventListener('click', () => {
    recovery = !recovery;
    say($('code-label'), recovery ? 'Recovery code' : 'Code');
    say($('factor-hint'), recovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.');
    $('code').inputMode = recovery ? 'text' : 'numeric';
    say($('use-recovery'), recovery ? 'Use the authenticator app instead' : 'Use a recovery code instead');
  });
  $('factor-form').addEventListener('submit', async (e) => {
    e.preventDefault(); say($('factor-error'));
    const value = $('code').value.trim();
    const body = recovery ? { challenge, recoveryCode: value } : { challenge, code: value };
    body.remember = $('remember').checked; body.label = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'Device';
    try {
      const r = await api('POST', '/api/owner/login/second-factor', body);
      if (r.next === 'change-password') { show($('factor-form'), false); show($('change-form'), true); } else location.href = nextUrl();
    } catch (err) { say($('factor-error'), err.message); }
  });
  $('change-form').addEventListener('submit', async (e) => {
    e.preventDefault(); say($('change-error'));
    if ($('new-password').value !== $('new-password-2').value) return say($('change-error'), 'The two passwords differ.');
    try { await api('POST', '/api/owner/password', { current: typedPassword, next: $('new-password').value }); typedPassword = ''; location.href = '/owner/account'; }
    catch (err) { say($('change-error'), err.message); }
  });
}

async function account() {
  let status;
  try { status = await api('GET', '/api/owner/status'); } catch (err) { status = {}; }
  if (!status.signedIn) return show($('signed-out'), true);
  show($('account'), true);
  const render = (s) => {
    say($('tf-status'), s.twoFactor ? 'On. Recovery codes left: ' + s.recoveryCodesLeft + '.' : 'Off. Turn it on so a password alone cannot sign in.');
    show($('tf-start'), !s.twoFactor); show($('tf-manage'), !!s.twoFactor);
    show($('pw-code-row'), !!s.twoFactor);
    const list = $('devices'); list.textContent = '';
    (s.devices || []).forEach((d) => {
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('span'); name.textContent = d.label + ' (until ' + new Date(d.expiresAt).toLocaleDateString() + ')';
      const revoke = document.createElement('button'); revoke.textContent = 'Revoke'; revoke.className = 'danger';
      revoke.addEventListener('click', async () => { try { await api('DELETE', '/api/owner/devices/' + encodeURIComponent(d.id)); render(await api('GET', '/api/owner/status')); } catch (err) { say($('tf-error'), err.message); } });
      row.append(name, revoke); list.append(row);
    });
    show($('no-devices'), !(s.devices || []).length);
  };
  render(status);
  const showCodes = (codes) => { const ol = $('tf-code-list'); ol.textContent = ''; codes.forEach((c) => { const li = document.createElement('li'); li.textContent = c; ol.append(li); }); show($('tf-codes'), true); };
  $('tf-start').addEventListener('click', async () => {
    say($('tf-error'));
    try { const r = await api('POST', '/api/owner/2fa/start'); $('tf-qr').innerHTML = r.qr; say($('tf-secret'), r.secret); show($('tf-enrol'), true); show($('tf-start'), false); }
    catch (err) { say($('tf-error'), err.message); }
  });
  $('tf-confirm').addEventListener('click', async () => {
    say($('tf-error'));
    try { const r = await api('POST', '/api/owner/2fa/confirm', { code: $('tf-code').value.trim() }); show($('tf-enrol'), false); showCodes(r.recoveryCodes); render(await api('GET', '/api/owner/status')); }
    catch (err) { say($('tf-error'), err.message); }
  });
  $('tf-regenerate').addEventListener('click', async () => {
    say($('tf-error'));
    try { const r = await api('POST', '/api/owner/recovery-codes', { code: $('tf-manage-code').value.trim() }); showCodes(r.recoveryCodes); render(await api('GET', '/api/owner/status')); }
    catch (err) { say($('tf-error'), err.message); }
  });
  $('tf-disable').addEventListener('click', async () => {
    say($('tf-error'));
    if (!confirm('Turn two-step sign-in off? Remembered devices are forgotten too.')) return;
    try { await api('POST', '/api/owner/2fa/disable', { password: $('tf-disable-password').value, code: $('tf-manage-code').value.trim() }); render(await api('GET', '/api/owner/status')); }
    catch (err) { say($('tf-error'), err.message); }
  });
  $('pw-change').addEventListener('click', async () => {
    say($('pw-error'));
    try { await api('POST', '/api/owner/password', { current: $('pw-current').value, next: $('pw-next').value, code: $('pw-code').value.trim() || undefined }); $('pw-current').value = ''; $('pw-next').value = ''; $('pw-code').value = ''; say($('pw-error'), 'Changed. Other browsers and remembered devices are signed out.'); }
    catch (err) { say($('pw-error'), err.message); }
  });
  $('logout').addEventListener('click', async () => { await api('POST', '/api/owner/logout').catch(() => {}); location.href = '/owner/login'; });
  $('logout-all').addEventListener('click', async () => {
    if (!confirm('Sign out everywhere, including remembered devices?')) return;
    try { await api('POST', '/api/owner/logout-everywhere'); location.href = '/owner/login'; } catch (err) { say($('tf-error'), err.message); }
  });
}

if (document.querySelector('[data-page="login"]')) login();
if (document.querySelector('[data-page="account"]')) account();
`;
