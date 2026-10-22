import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/car-mode.js'), 'utf8');
const context = vm.createContext({ ReverieApp: class {} });
vm.runInContext(source, context);
const makeController = (deps: unknown) => {
  const Controller = vm.runInContext('CarScreenWakeLock', context);
  return new Controller(deps);
};
class Sentinel extends EventTarget {
  released = false;
  releases = 0;
  release() { this.releases++; this.drop(); return Promise.resolve(); }
  drop() { this.released = true; this.dispatchEvent(new Event('release')); }
}
function harness({ secure = true, supported = true } = {}) {
  vi.useFakeTimers();
  let visible = true;
  let visibility: (() => void) | undefined;
  const locks: Sentinel[] = [];
  const states: Array<{ held: boolean; text: string }> = [];
  const request = vi.fn(async () => { const lock = new Sentinel(); locks.push(lock); return lock; });
  const controller = makeController({ secure, visible: () => visible, request: supported ? request : null,
    status: (held: boolean, text: string) => states.push({ held, text }),
    addVisibility: (fn: () => void) => { visibility = fn; },
    removeVisibility: (fn: () => void) => { if (visibility === fn) visibility = undefined; },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });
  return { controller, request, locks, states, setVisible(value: boolean) { visible = value; visibility?.(); }, listening: () => !!visibility };
}
afterEach(() => vi.useRealTimers());

it('holds once on start and reacquires when a hidden page returns', async () => {
  const h = harness();
  await h.controller.start(); await h.controller.start();
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.states.at(-1)?.held).toBe(true);
  h.setVisible(false);
  expect(h.locks[0].releases).toBe(1);
  expect(h.states.at(-1)?.held).toBe(false);
  h.setVisible(true); await vi.advanceTimersByTimeAsync(0);
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(h.states.at(-1)?.held).toBe(true);
  h.controller.stop();
});
it('reacquires on release with a bounded retry budget and offers manual retry', async () => {
  const h = harness(); await h.controller.start();
  for (let i = 0; i < 3; i++) { h.locks[i].drop(); await vi.advanceTimersByTimeAsync(1000); }
  expect(h.request).toHaveBeenCalledTimes(3);
  expect(h.states.at(-1)?.text).toContain('Retry');
  await h.controller.retry();
  expect(h.request).toHaveBeenCalledTimes(4);
  expect(h.states.at(-1)?.held).toBe(true);
  h.controller.stop();
});
it('does not retry while hidden and releases late acquisition after close', async () => {
  const h = harness();
  let resolveRequest!: (lock: Sentinel) => void;
  h.request.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
  const pending = h.controller.start();
  h.controller.stop();
  const late = new Sentinel(); resolveRequest(late); await pending;
  expect(late.releases).toBe(1);
  expect(h.listening()).toBe(false);
  expect(h.states.some((s) => s.held)).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.request).toHaveBeenCalledTimes(1);
});
it('does not let an old pending request clear a new acquisition', async () => {
  const h = harness(); let resolveOld!: (lock: Sentinel) => void;
  h.request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const pending = h.controller.start();
  h.setVisible(false); h.setVisible(true);
  await Promise.resolve(); await Promise.resolve();
  expect(h.request).toHaveBeenCalledTimes(2);
  const late = new Sentinel(); resolveOld(late); await pending;
  expect(late.releases).toBe(1);
  expect(h.states.at(-1)?.held).toBe(true);
  h.controller.stop(); expect(h.locks[0].releases).toBe(1);
});
it('refusal is visible and does not spin; manual retry can recover', async () => {
  const h = harness(); h.request.mockRejectedValueOnce(new Error('NotAllowedError'));
  await h.controller.start();
  expect(h.states.at(-1)?.text).toContain('refused');
  await vi.advanceTimersByTimeAsync(60_000); expect(h.request).toHaveBeenCalledTimes(1);
  await h.controller.retry(); expect(h.states.at(-1)?.held).toBe(true);
  h.controller.stop();
});
it.each([{ secure: false, supported: true, expected: 'HTTPS' }, { secure: true, supported: false, expected: 'unavailable' }])('shows $expected without requesting', async ({ secure, supported, expected }) => {
  const h = harness({ secure, supported }); await h.controller.start();
  expect(h.request).not.toHaveBeenCalled(); expect(h.states.at(-1)?.text).toContain(expected);
  expect(h.states.at(-1)?.held).toBe(false); h.controller.stop();
});
it('close cancels scheduled reacquisition and detaches visibility handling', async () => {
  const h = harness(); await h.controller.start(); h.locks[0].drop(); h.controller.stop();
  h.setVisible(false); h.setVisible(true); await vi.advanceTimersByTimeAsync(10_000);
  expect(h.request).toHaveBeenCalledTimes(1); expect(h.listening()).toBe(false);
});
it('real Car UI shows an accessible notice and retry when secure context is missing', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://reverie.test', runScripts: 'outside-only' });
  try {
    const w = dom.window;
    Object.defineProperty(w, 'isSecureContext', { value: false });
    Object.defineProperty(w.document, 'visibilityState', { value: 'visible' });
    w.eval('window.ReverieApp = class {}'); w.eval(source);
    const app = w.eval('new ReverieApp()');
    app._buildCarMode({ name: 'Test voice' }); app._carScreen.hidden = false;
    await app._keepCarScreenAwake();
    const notice = w.document.querySelector('.car-wake-notice') as HTMLElement;
    expect(notice).not.toBeNull();
    expect(notice.hidden).toBe(false); expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('HTTPS');
    expect(notice.querySelector('button')?.textContent).toBe('Retry keep awake');
    app.closeCarMode(); expect(app._carAwake).toBeNull();
  } finally { dom.window.close(); }
});
