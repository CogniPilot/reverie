/** Independent human PTY. Owner cookie stays browser-managed; no agent input,
 * proof, native request, command, reconnect or persistent keystroke storage. */
let active = null;
export async function openOwnerTerminal(app, employeeId, label) {
  if (active) { active.dialog.focus(); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'reverie-owner-terminal';
  dialog.setAttribute('aria-label', `Laptop terminal · ${label}`);
  const style = document.createElement('style');
  style.textContent = `
    .reverie-owner-terminal{box-sizing:border-box;width:min(540px,94vw);max-width:100vw;max-height:94dvh;padding:0;border:1px solid var(--ca-line,#3a4050);border-radius:12px;background:var(--ca-main-bg,var(--bg-card,#181b22));color:var(--text,#e5e7eb);box-shadow:0 20px 80px #0008;font:14px/1.45 system-ui,sans-serif;overflow:hidden}
    .reverie-owner-terminal::backdrop{background:#0009}
    .reverie-owner-terminal.has-terminal{width:min(1040px,96vw);height:min(760px,92dvh);display:flex;flex-direction:column}
    .reverie-owner-terminal header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--ca-line,#3a4050)}
    .reverie-owner-terminal h2{flex:1;min-width:0;margin:0;font-size:15px;font-weight:650;overflow-wrap:anywhere}
    .reverie-owner-terminal button{font:inherit;color:inherit;border:1px solid var(--ca-line,#41495a);border-radius:6px;background:var(--bg-card,#252b36);padding:5px 10px;min-height:32px;cursor:pointer}
    .reverie-owner-terminal button:focus-visible{outline:2px solid var(--accent,#8bb1ff);outline-offset:2px}
    .reverie-owner-terminal button:hover:not(:disabled){background:var(--ca-hover,var(--bg-hover,#354052))}
    .reverie-owner-terminal button:disabled{opacity:.45;cursor:default}
    .reverie-owner-terminal .human-screen{flex:1;min-height:0;padding:0 8px;background:#101318;overflow:hidden}
    .reverie-owner-terminal .human-keys{display:flex;flex:none;gap:5px;overflow-x:auto;padding:7px 12px;border-top:1px solid var(--ca-line,#3a4050)}
    .reverie-owner-terminal .human-keys button{min-width:34px;min-height:30px;padding:3px 8px;font:12px ui-monospace,monospace}
    .reverie-owner-terminal .laptop-status{display:flex;align-items:center;gap:7px;padding:8px 16px;margin:0;font-size:12px;color:var(--text-dim,#b2bbcc)}
    .reverie-owner-terminal .laptop-status::before{content:'';width:7px;height:7px;flex:none;border-radius:50%;background:var(--yellow,#e4b966)}
    .reverie-owner-terminal[data-state=connected] .laptop-status::before{background:var(--green,#6ad19b)}
    .reverie-owner-terminal:is([data-state=unavailable],[data-state=unconfirmed],[data-state=lost]) .laptop-status::before{background:var(--red,#ef8c8c)}
    .reverie-owner-terminal[data-state=closed] .laptop-status::before{background:var(--text-dim,#a0a9ba)}
    .reverie-owner-terminal .laptop-notice{padding:10px 20px 22px}
    .reverie-owner-terminal .laptop-notice h3{font-size:16px;margin:0 0 7px}
    .reverie-owner-terminal .laptop-notice p{margin:0 0 14px;color:var(--text-dim,#b2bbcc);overflow-wrap:anywhere}
    .reverie-owner-terminal .laptop-retry{border-color:var(--accent,#8bb1ff)}
    .reverie-owner-terminal [hidden]{display:none!important}
    @media(max-width:600px){.reverie-owner-terminal.has-terminal{width:100vw;height:100dvh;max-height:100dvh;margin:0;border-radius:0}.reverie-owner-terminal header{padding:10px 12px}}
    @media(pointer:coarse){.reverie-owner-terminal button{min-height:40px}.reverie-owner-terminal .human-keys button{min-width:40px}}
  `;
  const header = document.createElement('header'), title = document.createElement('h2');
  title.textContent = `Laptop terminal · ${label}`;
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close laptop terminal');
  const status = document.createElement('p'); status.className = 'laptop-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = 'Checking laptop terminal access…';
  const screen = document.createElement('div'); screen.className = 'human-screen'; screen.hidden = true;
  screen.setAttribute('aria-label', `Independent laptop shell for ${label}`);
  const keys = document.createElement('div'); keys.className = 'human-keys'; keys.hidden = true; keys.setAttribute('role', 'toolbar'); keys.setAttribute('aria-label', 'Laptop terminal keys');
  const notice = document.createElement('section'); notice.className = 'laptop-notice'; notice.hidden = true;
  const message = document.createElement('p');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'laptop-retry'; retry.textContent = 'Retry'; retry.hidden = true;
  notice.append(message, retry);
  header.append(title, close); dialog.append(style, header, status, notice, screen, keys); document.body.append(dialog);
  const previous = document.activeElement;
  const record = active = {dialog, ws: null, disposed: false};
  let terminal, fit, observer, controller, settled = false, loading = false;
  function failed(text, safeRetry = false, state = 'unconfirmed') {
    dialog.dataset.state = safeRetry ? 'unavailable' : state;
    status.textContent = state === 'lost' ? 'Connection lost' : safeRetry || state === 'unavailable' ? 'Cannot open terminal' : 'Could not open terminal';
    notice.hidden = false;
    message.textContent = text; retry.hidden = !safeRetry; retry.disabled = false;
    for (const key of keys.querySelectorAll('button')) key.disabled = true;
    if (terminal?.options) terminal.options.disableStdin = true;
  }
  function send(value) {
    if (record.ws?.readyState !== WebSocket.OPEN || record.ws.bufferedAmount > 65536) return false;
    record.ws.send(JSON.stringify(value)); return true;
  }
  const input = text => {
    if (record.disposed || settled || record.ws?.readyState !== WebSocket.OPEN) return;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 4096) { status.textContent = 'Paste at most 4 KiB at a time'; return; }
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    if (!send({kind: 'input', data: btoa(binary)})) status.textContent = 'Disconnected; input was not retried';
  };
  function dispose() {
    if (record.disposed) return;
    record.disposed = true;
    controller?.abort();
    window.removeEventListener('pagehide', pagehide);
    send({kind: 'close'});
    record.ws?.close(); observer?.disconnect(); terminal?.dispose();
    dialog.remove(); if (active === record) active = null;
    if (previous?.isConnected) previous.focus();
  }
  close.addEventListener('click', dispose);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dispose(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && screen.contains(document.activeElement)) {
      event.preventDefault(); event.stopPropagation(); input('\x1b');
    }
  }, true);
  const pagehide = () => dispose();
  window.addEventListener('pagehide', pagehide, {once: true});
  dialog.addEventListener('close', () => window.removeEventListener('pagehide', pagehide), {once: true});
  dialog.showModal();
  close.focus();
  async function connect() {
   if (loading || record.disposed) return;
   loading = true; retry.disabled = true; notice.hidden = true; dialog.dataset.state = 'loading'; status.textContent = 'Checking laptop terminal access…';
   try {
    if (typeof Terminal !== 'function' || typeof FitAddon?.FitAddon !== 'function') throw new Error('Terminal display unavailable');
    controller = new AbortController();
    const response = await app._api(`/api/company/employees/${encodeURIComponent(employeeId)}/human-terminal`,
      {method: 'POST', body: {cols: 80, rows: 24}, signal: controller.signal});
    let body; try { body = await response?.json(); } catch { /* Unknown outcome; never retry. */ }
    if (record.disposed) return;
    const reference = body?.data?.authorizationRef;
    if (!response?.ok || body?.success !== true || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(reference)) {
      const unavailable = response?.status === 503 && body?.error === 'Owner terminal is not installed for this website' && !reference;
      const refused = [400, 403, 404, 409].includes(response?.status) && typeof body?.error === 'string' && !reference;
      failed(unavailable ? 'Laptop terminal is not enabled on this website yet. Try again after setup is complete.'
        : refused
          ? body.error.slice(0, 300).replace(/human terminal/gi, 'laptop terminal')
          : 'The request may still be pending. Close this window and check the laptop before opening another shell.', unavailable, refused ? 'unavailable' : 'unconfirmed');
      return;
    }
    screen.hidden = false; keys.hidden = false; dialog.classList.add('has-terminal'); dialog.dataset.state = 'connecting'; status.textContent = 'Opening laptop shell…';
    terminal = new Terminal({cursorBlink: true, scrollback: 1000, fontSize: 14, allowProposedApi: false, disableStdin: true,
      theme: {background: '#101318', foreground: '#e5e7ef', cursor: '#aac3ff', selectionBackground: '#36517a'}});
    fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(screen); fit.fit();
    terminal.onData(input);
    for (const [name, value] of [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']]) {
      const key = document.createElement('button'); key.type = 'button'; key.textContent = name; key.disabled = true;
      key.setAttribute('aria-label', name === 'Ctrl+C' ? 'Interrupt laptop shell (Ctrl+C)' : `Send ${name}`);
      key.addEventListener('click', () => { input(value); terminal.focus(); }); keys.append(key);
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = record.ws = new WebSocket(`${proto}//${location.host}${ReverieBase.base}/ws/owner-terminals/${reference}`);
    ws.onopen = () => { dialog.dataset.state = 'connected'; status.textContent = 'Connected · separate laptop shell, not agent input'; if (terminal.options) terminal.options.disableStdin = false; for (const key of keys.querySelectorAll('button')) key.disabled = false; fit.fit(); send({kind: 'resize', cols: Math.max(2, Math.min(300, terminal.cols)), rows: Math.max(2, Math.min(120, terminal.rows))}); terminal.focus(); };
    ws.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 8192) throw new Error();
        const value = JSON.parse(event.data);
        if (value.kind === 'output' && typeof value.data === 'string' && value.data.length <= 5464)
          terminal.write(Uint8Array.from(atob(value.data), character => character.charCodeAt(0)));
        else if (value.kind === 'closed' && value.settled === true) { settled = true; dialog.dataset.state = 'closed'; status.textContent = 'Shell closed'; if (terminal.options) terminal.options.disableStdin = true; for (const key of keys.querySelectorAll('button')) key.disabled = true; }
        else throw new Error();
      } catch { ws.close(); failed('Your shell may still be running. This window will not reconnect automatically.', false, 'lost'); }
    };
    ws.onclose = () => { if (!settled && !record.disposed) failed('Your shell may still be running. This window will not reconnect automatically.', false, 'lost'); };
    ws.onerror = () => { if (!record.disposed) failed('Your shell may still be running. This window will not reconnect automatically.', false, 'lost'); };
    observer = new ResizeObserver(() => {
      if (record.disposed || settled || !screen.isConnected) return;
      fit.fit(); send({kind: 'resize', cols: Math.max(2, Math.min(300, terminal.cols)), rows: Math.max(2, Math.min(120, terminal.rows))});
    });
    observer.observe(screen);
   } catch { if (!record.disposed) failed('The request may still be pending. Close this window and check the laptop before opening another shell.'); }
   finally { loading = false; }
  }
  retry.addEventListener('click', () => { if (!retry.hidden) void connect(); });
  await connect();
}

window.ReverieOwnerTerminal = Object.freeze({ open: openOwnerTerminal });
