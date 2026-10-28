/** Independent human PTY. Owner cookie stays browser-managed; no agent input,
 * proof, native request, command, reconnect or persistent keystroke storage. */
let active = null;
export async function openOwnerTerminal(app, employeeId, label) {
  if (active) { active.dialog.focus(); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'reverie-owner-terminal';
  dialog.setAttribute('aria-label', `Human terminal · ${label}`);
  const style = document.createElement('style');
  style.textContent = '.reverie-owner-terminal{box-sizing:border-box;width:min(960px,100vw);height:min(720px,100dvh);max-width:100vw;max-height:100dvh;padding:12px;border:1px solid var(--border,#555);background:var(--bg,#181818);color:var(--text,#eee)}.reverie-owner-terminal::backdrop{background:#0008}.reverie-owner-terminal header{display:flex;align-items:center;gap:12px}.reverie-owner-terminal h2{flex:1;font-size:1rem}.reverie-owner-terminal .human-screen{height:calc(100% - 130px);min-height:160px}.reverie-owner-terminal .human-keys{display:flex;gap:6px;overflow-x:auto;padding:8px 0}.reverie-owner-terminal button{min-width:44px;min-height:44px}.reverie-owner-terminal p{margin:4px 0;font-size:.85rem}@media(max-width:767px){.reverie-owner-terminal{width:100vw;height:100dvh;margin:0;border-radius:0}}';
  const header = document.createElement('header'), title = document.createElement('h2');
  title.textContent = `Human terminal · ${label}`;
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Connecting…';
  const screen = document.createElement('div'); screen.className = 'human-screen';
  const keys = document.createElement('div'); keys.className = 'human-keys'; keys.setAttribute('aria-label', 'Terminal keys');
  header.append(title, close); dialog.append(style, header, status, screen, keys); document.body.append(dialog);
  const previous = document.activeElement;
  const record = active = {dialog, ws: null, disposed: false};
  let terminal, fit, observer, settled = false;
  function send(value) {
    if (record.ws?.readyState !== WebSocket.OPEN || record.ws.bufferedAmount > 65536) return false;
    record.ws.send(JSON.stringify(value)); return true;
  }
  const input = text => {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 4096) { status.textContent = 'Paste at most 4 KiB at a time'; return; }
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    if (!send({kind: 'input', data: btoa(binary)})) status.textContent = 'Disconnected; input was not retried';
  };
  function dispose() {
    if (record.disposed) return;
    record.disposed = true;
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
  try {
    if (typeof Terminal !== 'function' || typeof FitAddon?.FitAddon !== 'function') throw new Error('Terminal display unavailable');
    terminal = new Terminal({cursorBlink: true, scrollback: 1000, fontSize: 14, allowProposedApi: false});
    fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(screen); fit.fit();
    terminal.onData(input);
    for (const [name, value] of [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']]) {
      const key = document.createElement('button'); key.type = 'button'; key.textContent = name;
      key.addEventListener('click', () => { input(value); terminal.focus(); }); keys.append(key);
    }
    const response = await app._api(`/api/company/employees/${encodeURIComponent(employeeId)}/human-terminal`,
      {method: 'POST', body: {cols: Math.max(2, Math.min(300, terminal.cols)), rows: Math.max(2, Math.min(120, terminal.rows))}});
    const reference = response?.data?.authorizationRef;
    if (record.disposed) return;
    if (!response?.success || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(reference))
      throw new Error(response?.error || 'Human terminal is unavailable');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = record.ws = new WebSocket(`${proto}//${location.host}${ReverieBase.base}/ws/owner-terminals/${reference}`);
    ws.onopen = () => { status.textContent = 'Human shell in this laptop · separate from the agent'; terminal.focus(); };
    ws.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 8192) throw new Error();
        const value = JSON.parse(event.data);
        if (value.kind === 'output' && typeof value.data === 'string' && value.data.length <= 5464)
          terminal.write(Uint8Array.from(atob(value.data), character => character.charCodeAt(0)));
        else if (value.kind === 'closed' && value.settled === true) { settled = true; status.textContent = 'Shell closed and cleanup confirmed'; }
        else throw new Error();
      } catch { ws.close(); status.textContent = 'Terminal response unconfirmed; no reconnect'; }
    };
    ws.onclose = () => { if (!settled) status.textContent = 'Disconnected; cleanup has not been confirmed'; };
    ws.onerror = () => { status.textContent = 'Connection failed; it was not retried'; };
    observer = new ResizeObserver(() => {
      if (record.disposed || !screen.isConnected) return;
      fit.fit(); send({kind: 'resize', cols: Math.max(2, Math.min(300, terminal.cols)), rows: Math.max(2, Math.min(120, terminal.rows))});
    });
    observer.observe(screen);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Human terminal is unavailable';
  }
}

window.ReverieOwnerTerminal = Object.freeze({ open: openOwnerTerminal });
