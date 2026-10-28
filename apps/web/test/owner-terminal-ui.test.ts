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
  constructor() { terminals.push(this); }
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
async function module() { return import('../src/web/public/owner-terminal-ui.js' as string); }

it('cancelled pending owner request cannot open a later socket or resurrect the removed dialog', async () => {
  const source = await module(); let resolve!: (value: unknown) => void;
  const app = {_api: vi.fn(() => new Promise(done => { resolve = done; }))};
  const pending = source.openOwnerTerminal(app, employee, '<Generic employee>');
  const dialog = dom.window.document.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe('Human terminal · <Generic employee>');
  dialog.querySelector<HTMLButtonElement>('header button')!.click();
  resolve(result); await pending;
  expect(sockets).toHaveLength(0); expect(dom.window.document.querySelector('dialog')).toBeNull();
  expect(terminals[0].disposed).toBe(true); expect(dom.window.document.activeElement?.id).toBe('original');
  expect(app._api.mock.calls[0][1]).toEqual({method:'POST',body:{cols:80,rows:24}});
});
it('uses only same-origin ephemeral reference, bounded input/resize, and no automatic reconnect', async () => {
  const source = await module(); await source.openOwnerTerminal({_api: async () => result}, employee, 'Generic');
  expect(sockets).toHaveLength(1);
  const socket = sockets[0]; expect(socket.url).toBe('wss://fixture.test/office/ws/owner-terminals/'+result.data.authorizationRef);
  socket.readyState = 1; socket.onopen?.(); terminals[0].data?.('hello'); observers[0].callback();
  expect(socket.sent).toEqual([{kind:'input',data:'aGVsbG8='},{kind:'resize',cols:80,rows:24}]);
  terminals[0].data?.('x'.repeat(4097)); expect(socket.sent).toHaveLength(2);
  socket.close(); expect(sockets).toHaveLength(1);
  expect(dom.window.document.querySelector('[role="status"]')?.textContent).toContain('not been confirmed');
  dom.window.document.querySelector<HTMLButtonElement>('header button')!.click(); expect(observers[0].disconnected).toBe(true);
});
it('delivers Escape once to the focused terminal and provides explicit touch keys and Close', async () => {
  const source = await module(); await source.openOwnerTerminal({_api: async () => result}, employee, 'Generic');
  const socket = sockets[0]; socket.readyState = 1; socket.onopen?.();
  const event = new dom.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true});
  terminals[0].textarea!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true); expect(socket.sent).toEqual([{kind:'input',data:'Gw=='}]);
  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')];
  buttons.find(button => button.textContent === 'Ctrl+C')!.click();
  expect(socket.sent[1]).toEqual({kind:'input',data:'Aw=='});
  expect(dom.window.document.querySelector('dialog')).not.toBeNull();
  buttons.find(button => button.textContent === 'Close')!.click(); expect(socket.closed).toBe(true);
});
