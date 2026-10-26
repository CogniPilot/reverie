import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });
function fixture({ available = true, owner = true, fails = false, modalFails = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><button id="origin">Power</button><p id="officePowerResult"></p></body></html>', { url: 'http://owned-fixture.test', runScripts: 'outside-only' }); windows.push(dom);
  const w: any = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { if (modalFails) throw Error('unsupported'); this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  w.confirm = vi.fn(() => { throw Error('native confirmation must not be used'); });
  const calls: { path: string; options: any }[] = [];
  w.fetch = vi.fn(async (path: string, options: any = {}) => {
    calls.push({ path, options });
    const data = path === '/api/system/laptops'
      ? owner ? { success: true, data: { available, runningLaptops: 3 } } : { success: false, error: 'Only the verified owner may read laptop controls.' }
      : fails ? { success: false, error: 'Laptops did not stop' } : { success: true };
    return { ok: owner && (!fails || path === '/api/system/laptops'), status: owner ? fails ? 503 : 200 : 403, json: async () => data };
  });
  w.eval('window.ReverieApp = class ReverieApp {};');
  // The real serialization bridge is essential: mocking _api hid the old double encoding.
  for (const name of ['api-client.js', 'settings-ui.js']) w.eval(readFileSync(new URL('../src/web/public/' + name, import.meta.url), 'utf8'));
  const app = new w.ReverieApp(); const output = w.document.getElementById('officePowerResult');
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const click = (label: string) => [...w.document.querySelectorAll('dialog button')].find((b: any) => b.textContent === label)?.click();
  return { app, output, calls, w, flush, click };
}
describe('office power uses a real confirmation and the actual serialization bridge', () => {
  it.each([['shutdown', 'Shut down Reverie'], ['stop-laptops', 'Stop all laptops'], ['restart-website', 'Restart website']])('posts one object only after explicit %s confirmation', async (action, label) => {
    const f = fixture(); f.w.document.getElementById('origin').focus(); const pending = f.app.officePower(action); await f.flush();
    const dialog = f.w.document.querySelector('dialog'); expect(dialog.open).toBe(true); expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(f.calls.map(c => c.path)).toEqual(['/api/system/laptops']); expect(f.w.document.activeElement.textContent).toBe('Cancel');
    expect(dialog.textContent).toContain(action === 'restart-website' ? 'laptop(s) will keep working' : 'without a fresh handoff');
    f.click(label); await pending;
    expect(f.calls).toHaveLength(2); const request = f.calls[1]; expect(request.path).toBe('/api/system/' + action);
    expect(request.options.method).toBe('POST'); expect(request.options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(request.options.body)).toEqual({ confirmed: true }); expect(typeof JSON.parse(request.options.body)).toBe('object');
    expect(f.w.confirm).not.toHaveBeenCalled(); expect(f.w.document.querySelector('dialog')).toBeNull(); expect(f.w.document.activeElement.id).toBe('origin'); expect(f.app._officePowerPending).toBe(false);
  });
  it.each(['Cancel', 'Escape', 'close'])('does not post when confirmation ends with %s', async how => {
    const f = fixture(); const pending = f.app.officePower('shutdown'); await f.flush();
    if (how === 'Cancel') f.click('Cancel'); else if (how === 'Escape') f.w.document.querySelector('dialog').dispatchEvent(new f.w.Event('cancel', { cancelable: true })); else f.w.document.querySelector('dialog').close();
    await pending; expect(f.calls).toHaveLength(1); expect(f.app._officePowerPending).toBe(false); expect(f.w.document.querySelector('dialog')).toBeNull();
  });
  it.each([{ available: false }, { owner: false }, { modalFails: true }])('fails closed for unavailable owner/status/modal %j', async options => {
    const f = fixture(options); await f.app.officePower('shutdown'); expect(f.calls).toHaveLength(1); expect(f.w.document.querySelector('dialog')).toBeNull(); expect(f.app._officePowerPending).toBe(false);
  });
  it('allows only one pending dialog and one confirmed POST', async () => {
    const f = fixture(); const first = f.app.officePower('shutdown'); const second = f.app.officePower('shutdown'); await f.flush(); expect(f.w.document.querySelectorAll('dialog')).toHaveLength(1);
    const confirm = [...f.w.document.querySelectorAll('dialog button')].find((b: any) => b.textContent === 'Shut down Reverie'); confirm.click(); confirm.click(); await Promise.all([first, second]); expect(f.calls).toHaveLength(2);
  });
  it('never claims an unsuccessful backend power request completed', async () => {
    const f = fixture({ fails: true }); const pending = f.app.officePower('shutdown'); await f.flush(); f.click('Shut down Reverie'); await pending; expect(f.output.textContent).toBe('Laptops did not stop'); expect(f.output.textContent).not.toContain('shutting down');
  });
  it('refuses unknown action strings without even reading power status', async () => {
    const f = fixture(); await f.app.officePower('arbitrary-path'); expect(f.calls).toHaveLength(0); expect(f.app._officePowerPending).toBeUndefined();
  });
});
