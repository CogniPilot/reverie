import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: JSDOM, sockets: FakeSocket[], terminals: FakeTerminal[], observers: Array<{callback: () => void; disconnected: boolean}>;
class FakeSocket {
  static OPEN = 1;
  readyState = 0; bufferedAmount = 0; sent: object[] = []; closed = false;
  onopen?: () => void; onmessage?: (event: {data: string}) => void; onclose?: () => void;
  constructor(readonly url: string) { sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
}
class FakeTerminal {
  cols = 80; rows = 24; disposed = false; textarea?: HTMLTextAreaElement; data?: (value: string) => void;
  constructor(public options: {disableStdin: boolean}) { terminals.push(this); }
  loadAddon() {} open(screen: HTMLElement) { this.textarea = dom.window.document.createElement('textarea'); screen.append(this.textarea); }
  onData(callback: (value: string) => void) { this.data = callback; }
  focus() { this.textarea?.focus(); } dispose() { this.disposed = true; } write() {}
}
beforeEach(() => {
  vi.resetModules(); sockets = []; terminals = []; observers = [];
  dom = new JSDOM('<!doctype html><button id="original">Employee profile</button>', {url: 'https://fixture.test/office/'});
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('Terminal', FakeTerminal);
  vi.stubGlobal('FitAddon', {FitAddon: class {fit() {}}}); vi.stubGlobal('ReverieBase', {base: '/office'});
  vi.stubGlobal('ResizeObserver', class {
    record: {callback: () => void; disconnected: boolean};
    constructor(callback: () => void) { this.record = {callback, disconnected: false}; observers.push(this.record); }
    observe() {} disconnect() { this.record.disconnected = true; }
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.document.querySelector<HTMLButtonElement>('#original')!.focus();
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const employee = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const result = {success: true, data: {authorizationRef: '11111111-1111-4111-8111-111111111111'}};
const response = (body: unknown = result, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type':'application/json'}});
async function module() { return import('../src/web/public/owner-terminal-ui.js' as string); }

it('cancelled pending owner request cannot open a later socket or resurrect the removed dialog', async () => {
  const source = await module(); let resolve!: (value: unknown) => void;
  const app = {_api: vi.fn(() => new Promise(done => { resolve = done; }))};
  const pending = source.openOwnerTerminal(app, employee, '<Generic employee>');
  const dialog = dom.window.document.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe('Laptop terminal · <Generic employee>');
  dialog.querySelector<HTMLButtonElement>('header button')!.click();
  resolve(response()); await pending;
  expect(sockets).toHaveLength(0); expect(dom.window.document.querySelector('dialog')).toBeNull();
  expect(terminals).toHaveLength(0); expect(dom.window.document.activeElement?.id).toBe('original');
  expect(app._api.mock.calls[0][1]).toMatchObject({method:'POST',body:{cols:80,rows:24}});
  expect((app._api.mock.calls[0][1] as {signal: AbortSignal}).signal.aborted).toBe(true);
});
it('uses only same-origin ephemeral reference, bounded input/resize, and no automatic reconnect', async () => {
  const source = await module(); await source.openOwnerTerminal({_api: async () => response()}, employee, 'Generic');
  expect(sockets).toHaveLength(1);
  const socket = sockets[0]; expect(socket.url).toBe('wss://fixture.test/office/ws/owner-terminals/'+result.data.authorizationRef);
  socket.readyState = 1; socket.onopen?.(); terminals[0].data?.('hello'); observers[0].callback();
  expect(socket.sent).toEqual([{kind:'resize',cols:80,rows:24},{kind:'input',data:'aGVsbG8='},{kind:'resize',cols:80,rows:24}]);
  terminals[0].data?.('x'.repeat(4097)); expect(socket.sent).toHaveLength(3);
  socket.close(); expect(sockets).toHaveLength(1);
  expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe('Connection lost');
  expect(dom.window.document.querySelector('.laptop-notice')?.textContent).toContain('may still be running');
  expect(dom.window.document.querySelector<HTMLButtonElement>('.laptop-retry')!.hidden).toBe(true);
  expect(terminals[0].options.disableStdin).toBe(true);
  dom.window.document.querySelector<HTMLButtonElement>('header button')!.click(); expect(observers[0].disconnected).toBe(true);
});
it('delivers Escape once to the focused terminal and provides explicit touch keys and Close', async () => {
  const source = await module(); await source.openOwnerTerminal({_api: async () => response()}, employee, 'Generic');
  const socket = sockets[0]; socket.readyState = 1; socket.onopen?.();
  const event = new dom.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true});
  terminals[0].textarea!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true); expect(socket.sent).toEqual([{kind:'resize',cols:80,rows:24},{kind:'input',data:'Gw=='}]);
  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')];
  buttons.find(button => button.textContent === 'Ctrl+C')!.click();
  expect(socket.sent[2]).toEqual({kind:'input',data:'Aw=='});
  expect(dom.window.document.querySelector('dialog')).not.toBeNull();
  buttons.find(button => button.textContent === 'Close')!.click(); expect(socket.closed).toBe(true);
});

it('shows the real known 503 without allocating a black terminal and permits one explicit retry', async () => {
  const source = await module(); const api = vi.fn().mockResolvedValueOnce(response({success:false,error:'Owner terminal is not installed for this website'},503)).mockResolvedValueOnce(response());
  await source.openOwnerTerminal({_api:api},employee,'Generic');
  expect(terminals).toHaveLength(0); expect(sockets).toHaveLength(0);
  const dialog=dom.window.document.querySelector('dialog')!;
  expect(dialog.classList.contains('has-terminal')).toBe(false);
  expect(dialog.querySelector<HTMLElement>('.human-screen')!.hidden).toBe(true);
  expect(dialog.querySelector<HTMLElement>('.human-keys')!.hidden).toBe(true);
  expect(dialog.textContent).toContain('not enabled on this website');
  const retry=dialog.querySelector<HTMLButtonElement>('.laptop-retry')!;expect(retry.hidden).toBe(false);
  retry.click();retry.click();await vi.waitFor(()=>expect(sockets).toHaveLength(1));
  expect(api).toHaveBeenCalledTimes(2);expect(terminals).toHaveLength(1);
  expect(terminals[0].options.disableStdin).toBe(true);
  expect([...dialog.querySelectorAll<HTMLButtonElement>('.human-keys button')].every(button=>button.disabled)).toBe(true);
});

it.each([null, {success:false,error:'Terminal request refused or unconfirmed; it was not retried'}])('never offers retry for an unconfirmed issued request (%j)', async body=>{
  const source=await module();const api=vi.fn(async()=>body===null?null:response(body,503));
  await source.openOwnerTerminal({_api:api},employee,'Generic');
  expect(api).toHaveBeenCalledTimes(1);expect(terminals).toHaveLength(0);expect(sockets).toHaveLength(0);
  const retry=dom.window.document.querySelector<HTMLButtonElement>('.laptop-retry')!;
  expect(retry.hidden).toBe(true);retry.click();await Promise.resolve();expect(api).toHaveBeenCalledTimes(1);
  expect(dom.window.document.querySelector('[role="status"]')!.textContent).toBe('Could not open terminal');
});

it('reports a confirmed owner refusal and keeps input disabled after settled closure', async()=>{
  const source=await module();await source.openOwnerTerminal({_api:async()=>response({success:false,error:'Use your unrestricted owner login'},403)},employee,'Generic');
  expect(dom.window.document.querySelector('[role="status"]')!.textContent).toBe('Cannot open terminal');
  expect(dom.window.document.querySelector('.laptop-notice')!.textContent).toContain('unrestricted owner login');
  expect(terminals).toHaveLength(0);
  dom.window.document.querySelector<HTMLButtonElement>('header button')!.click();
  await source.openOwnerTerminal({_api:async()=>response()},employee,'Generic');
  const socket=sockets[0];socket.readyState=1;socket.onopen?.();expect(terminals[0].options.disableStdin).toBe(false);
  socket.onmessage?.({data:JSON.stringify({kind:'closed',settled:true})});
  expect(terminals[0].options.disableStdin).toBe(true);const count=socket.sent.length;
  terminals[0].data?.('must not send');expect(socket.sent).toHaveLength(count);
  observers[0].callback();expect(socket.sent).toHaveLength(count);
});
