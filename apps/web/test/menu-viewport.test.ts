import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const opened: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const h of opened.splice(0)) h.window.close(); });

async function fixture(width = 1000, height = 720, visual?: { width: number; height: number; offsetLeft: number; offsetTop: number }) {
  const h = await createHarness(); opened.push(h);
  Object.defineProperty(h.window, 'innerWidth', { configurable: true, value: width, writable: true });
  Object.defineProperty(h.window, 'innerHeight', { configurable: true, value: height, writable: true });
  const viewport = visual ? Object.assign(new h.window.EventTarget(), visual) : undefined;
  Object.defineProperty(h.window, 'visualViewport', { configurable: true, value: viewport });
  const rect = (left: number, top: number, width: number, height: number) => new h.window.DOMRect(left, top, width, height);
  const original = h.window.HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(h.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains('ca-popmenu')) {
      const width = Math.min(232, parseFloat(this.style.getPropertyValue('--ca-menu-max-width')) || 232);
      const height = Math.min(this.querySelectorAll('button').length * 34 + 16, parseFloat(this.style.getPropertyValue('--ca-menu-max-height')) || 720);
      return rect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0, width, height);
    }
    const menu = this.closest('.ca-popmenu');
    if (menu && this.tagName === 'BUTTON') {
      const box = menu.getBoundingClientRect();
      const index = [...menu.querySelectorAll('button')].indexOf(this as HTMLButtonElement);
      return rect(box.left + 8, box.top + 8 + index * 34 - menu.scrollTop, box.width - 16, 34);
    }
    return original.call(this);
  });
  const anchor = (left: number, top: number, width = 100, height = 24) => {
    const button = h.document.createElement('button'); h.document.body.append(button);
    button.getBoundingClientRect = () => rect(left, top, width, height); return button;
  };
  const key = (key: string) => h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { ...h, viewport, anchor, key };
}

it('opens a channel context menu above a low pointer so Delete stays inside the viewport', async () => {
  const h = await fixture(); const remove = vi.fn();
  const menu = h.shell.openMenu([...Array.from({ length: 9 }, (_, n) => ({ label: 'Action ' + n })), { label: 'Delete', danger: true, run: remove }], { at: { x: 35, y: 690 } });
  const box = menu.getBoundingClientRect();
  expect(box.top).toBeLessThan(690); expect(box.bottom).toBeLessThanOrEqual(712);
  expect(box.left).toBeGreaterThanOrEqual(8); expect(box.right).toBeLessThanOrEqual(992);
  expect(remove).not.toHaveBeenCalled();
  h.key('End'); expect(h.document.activeElement?.textContent).toBe('Delete');
  const last = h.document.activeElement!.getBoundingClientRect();
  expect(last.bottom).toBeLessThanOrEqual(box.bottom);
});

it('caps tall menus to the visible height and scrolls keyboard focus to every action', async () => {
  const h = await fixture(380, 240); const runs = vi.fn();
  const menu = h.shell.openMenu(Array.from({ length: 30 }, (_, n) => ({ label: n === 29 ? 'Delete' : 'Action ' + n, run: runs })), { at: h.anchor(280, 218) });
  expect(menu.style.getPropertyValue('--ca-menu-max-height')).toBe('224px');
  expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(232);
  h.key('End'); expect(h.document.activeElement?.textContent).toBe('Delete');
  expect(menu.scrollTop).toBeGreaterThan(0);
  expect(h.document.activeElement!.getBoundingClientRect().bottom).toBeLessThanOrEqual(menu.getBoundingClientRect().bottom);
  const previousScroll = menu.scrollTop;
  h.key('Home'); expect(menu.scrollTop).toBeLessThan(previousScroll);
  expect(h.document.activeElement!.getBoundingClientRect().top).toBeGreaterThanOrEqual(menu.getBoundingClientRect().top);
  menu.scrollTop = 300; menu.dispatchEvent(new h.window.Event('scroll'));
  expect(menu.scrollTop).toBe(300);
  expect(runs).not.toHaveBeenCalled();
});

it('measures anchor menus and flips upward instead of leaving their bottom clipped', async () => {
  const h = await fixture();
  const menu = h.shell.openMenu(Array.from({ length: 7 }, (_, n) => ({ label: 'Item ' + n })), { at: h.anchor(800, 670), right: true });
  expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(664);
  expect(menu.getBoundingClientRect().right).toBe(900);
  expect(menu.style.bottom).toBe(''); expect(menu.style.right).toBe('');
});

it('flips a submenu to the left near the right edge and returns focus to its exact trigger', async () => {
  const h = await fixture(600, 500);
  const menu = h.shell.openMenu([{ label: 'First', sub: [{ label: 'Other' }] }, { label: 'Second', sub: [{ label: 'Choice' }] }], { at: { x: 590, y: 430 } });
  const trigger = menu.querySelectorAll('button')[1]; trigger.focus(); h.key('ArrowRight');
  const sub = [...h.document.querySelectorAll('.ca-popmenu')].at(-1)!;
  expect(sub.getBoundingClientRect().right).toBeLessThanOrEqual(menu.getBoundingClientRect().left);
  expect(sub.getBoundingClientRect().bottom).toBeLessThanOrEqual(492);
  h.key('ArrowLeft'); expect(h.document.activeElement).toBe(trigger);
});

it('uses visual-viewport offsets and refits on viewport scrolling, resize and layout resize without running actions', async () => {
  const h = await fixture(1200, 900, { width: 400, height: 300, offsetLeft: 80, offsetTop: 140 });
  const run = vi.fn(); const menu = h.shell.openMenu(Array.from({ length: 14 }, () => ({ label: 'Action', run })), { at: { x: 900, y: 850 } });
  const inside = () => {
    const box = menu.getBoundingClientRect(); const v = h.viewport!;
    expect(box.left).toBeGreaterThanOrEqual(v.offsetLeft + 8); expect(box.right).toBeLessThanOrEqual(v.offsetLeft + v.width - 8);
    expect(box.top).toBeGreaterThanOrEqual(v.offsetTop + 8); expect(box.bottom).toBeLessThanOrEqual(v.offsetTop + v.height - 8);
  };
  inside();
  Object.assign(h.viewport!, { width: 280, height: 180, offsetLeft: 120, offsetTop: 210 });
  h.viewport!.dispatchEvent(new h.window.Event('resize')); inside();
  h.viewport!.offsetTop = 250; h.viewport!.dispatchEvent(new h.window.Event('scroll')); inside();
  h.window.dispatchEvent(new h.window.Event('resize')); inside();
  expect(run).not.toHaveBeenCalled();
  h.shell.closeMenus(); const lastTop = menu.style.top;
  h.viewport!.offsetTop = 400; h.viewport!.dispatchEvent(new h.window.Event('scroll'));
  expect(menu.style.top).toBe(lastTop);
});
