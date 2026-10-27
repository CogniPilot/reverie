import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const handles: any[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.window.close();
});
async function fixture() {
  const company = { canManage: true, settings: { ownerName: 'Owner' }, employees: [] };
  const h = await createHarness({ company });
  handles.push(h);
  const old = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: any) =>
    path === '/api/company'
      ? { ok: true, data: company }
      : path === '/api/chatrooms/phone-status'
        ? { ok: true, data: { self: 'owner', canSetOwn: true } }
        : old(path, options);
  const observers: any[] = [];
  h.window.ResizeObserver = class {
    callback: () => void;
    targets: any[] = [];
    disconnected = false;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target: any) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  h.shell.company = company;
  h.shell.phoneStatus = { self: 'owner', canSetOwn: true };
  h.shell.renderUser();
  const meter = { left: 72, top: 790, right: 312, bottom: 846, width: 240, height: 56 };
  h.shell.els.machineBar.getBoundingClientRect = () => meter;
  h.shell.els.root.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 1280,
    bottom: 900,
    width: 1280,
    height: 900,
  });
  h.shell.els.rail.getBoundingClientRect = () => ({ left: 0, top: 0, right: 72, bottom: 846, width: 72, height: 846 });
  Object.defineProperty(h.shell.els.officeLauncher, 'offsetHeight', { value: 36 });
  h.document.querySelector('.ca-office-gear')!.click();
  await h.flush();
  return { h, meter, observers };
}
it('anchors the category panel exactly to the resource block and centers the left gear against it', async () => {
  const { h } = await fixture();
  const pane = h.shell.els.officePane;
  expect(pane.style.left).toBe('72px');
  expect(pane.style.width).toBe('240px');
  expect(pane.style.bottom).toBe('110px');
  expect(h.shell.els.officeLauncher.style.top).toBe('800px');
  expect(pane.parentElement).toBe(h.shell.els.root);
  expect(h.shell.els.machineBar.querySelector('.ca-office-pane')).toBeNull();
});
it('keeps the gear and seam in place as the workspace rail scrolls', async () => {
  const { h } = await fixture();
  h.shell.els.rail.scrollTop = 100;
  h.shell.els.rail.dispatchEvent(new h.window.Event('scroll'));
  expect(h.shell.els.officeLauncher.style.top).toBe('900px');
  expect(h.shell.els.officePane.style.bottom).toBe('110px');
});
it('repositions for actual resource or rail resize without replacing the category links', async () => {
  const { h, meter, observers } = await fixture();
  const current = observers.at(-1);
  expect(current.targets).toContain(h.shell.els.machineBar);
  expect(current.targets).toContain(h.shell.els.rail);
  const button = h.shell.els.officePane.querySelector('button');
  meter.top = 730;
  meter.bottom = 786;
  current.callback();
  expect(h.shell.els.officePane.style.bottom).toBe('170px');
  expect(h.shell.els.officeLauncher.style.top).toBe('740px');
  expect(h.shell.els.officePane.querySelector('button')).toBe(button);
});
it('preserves the focused category during rerender and cleans up the old geometry observer on user repaint', async () => {
  const { h, observers } = await fixture();
  h.shell.els.officePane.querySelectorAll('button')[1].focus();
  h.shell.renderOfficePane();
  expect(h.document.activeElement.textContent).toBe('Board');
  const previous = observers.at(-1);
  h.shell.renderUser();
  expect(previous.disconnected).toBe(true);
  expect(observers.at(-1)).not.toBe(previous);
});

it('only marks a gear opening for animation; persistent panel repaints and resize remain still', async () => {
  const { h } = await fixture();
  let pane = h.shell.els.officePane;
  expect(pane.classList.contains('ca-office-pane-opening')).toBe(true);
  const finished = new h.window.Event('animationend');
  Object.defineProperty(finished, 'animationName', { value: 'ca-office-slide-up' });
  pane.dispatchEvent(finished);
  expect(pane.classList.contains('ca-office-pane-opening')).toBe(false);
  h.shell.renderOfficePane();
  h.shell.renderUser();
  h.window.dispatchEvent(new h.window.Event('resize'));
  pane = h.shell.els.officePane;
  expect(pane.hidden).toBe(false);
  expect(pane.classList.contains('ca-office-pane-opening')).toBe(false);
  const gear = h.document.querySelector('.ca-office-gear');
  gear.click();
  await h.flush();
  expect(pane.hidden).toBe(true);
  expect(pane.classList.contains('ca-office-pane-opening')).toBe(false);
  gear.click();
  await h.flush();
  expect(pane.hidden).toBe(false);
  expect(pane.classList.contains('ca-office-pane-opening')).toBe(true);
});
