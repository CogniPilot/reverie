import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/board.html'), 'utf8');
const now = Date.now();
const board = {
  built: now,
  timeZone: 'America/New_York',
  issues: Array.from({ length: 18 }, (_, i) => ({
    id: `issue-${i}`,
    title: `Scheduled task ${i}`,
    owner: `person-${i}`,
    ownerLabel: `Person ${i}`,
    status: 'todo',
    start: now - 3600000,
    end: now + 3600000,
    scale: 'hour',
    tags: [],
    links: [],
  })),
  milestones: [],
  decisions: [],
  polls: [],
  blockers: [],
  wins: [],
  people: [],
  plans: [],
  pace: {},
};

describe('Board timeline navigation in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let errors: string[];
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
  });
  afterAll(async () => browser?.close());
  afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
  });

  async function open(width = 1100) {
    errors = [];
    page = await browser.newPage({ viewport: { width, height: 650 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://board.test/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/api/board') {
        await route.fulfill({ json: { success: true, data: board } });
      } else await route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('http://board.test/board');
    await page.waitForFunction(() => document.querySelector('#tl svg') !== null);
    expect(await page.locator('#banner').isHidden()).toBe(true);
  }
  const view = () => page.evaluate(() => (window as any).eval('({...view})'));
  const span = async () => {
    const v = await view();
    return v.e - v.s;
  };
  async function wheel(modifier?: 'ctrlKey' | 'metaKey', deltaX = 0) {
    return page.locator('#tl').evaluate(
      (el, args) => {
        const r = el.getBoundingClientRect();
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -120,
          deltaX: args.deltaX,
          clientX: r.left + r.width * 0.7,
          ...(args.modifier ? { [args.modifier]: true } : {}),
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { modifier, deltaX }
    );
  }

  it('leaves ordinary vertical and horizontal wheel events uncancelled and the view unchanged', async () => {
    await open();
    const before = await view();
    expect(await wheel()).toBe(false);
    expect(await view()).toEqual(before);
    expect(await wheel(undefined, 250)).toBe(false);
    expect(await view()).toEqual(before);
  });
  it('ordinary physical wheel scrolls the page over the timeline without zoom', async () => {
    await open();
    const before = await view();
    await page.locator('#tl').hover({ position: { x: 400, y: 80 } });
    const top = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 200);
    await page.waitForFunction((y) => scrollY > y, top);
    expect(await view()).toEqual(before);
  });
  it.each(['ctrlKey', 'metaKey'] as const)('%s wheel zooms and prevents page scrolling', async (modifier) => {
    await open();
    const before = await span();
    expect(await wheel(modifier)).toBe(true);
    expect(await span()).toBeLessThan(before);
  });
  it('zoom controls keep the center and clamp at the minimum span', async () => {
    await open();
    const before = await view();
    await page.getByRole('button', { name: 'Zoom in timeline', exact: true }).click();
    const after = await view();
    expect(after.e - after.s).toBeLessThan(before.e - before.s);
    expect((after.s + after.e) / 2).toBeCloseTo((before.s + before.e) / 2, 0);
    for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Zoom in timeline', exact: true }).click();
    expect(await span()).toBe(1.5 * 3600000);
    await page.getByRole('button', { name: 'Zoom out timeline', exact: true }).click();
    expect(await span()).toBeGreaterThan(1.5 * 3600000);
  });
  it('Fit restores the full bounds and controls work with keyboard on a phone viewport', async () => {
    await open(390);
    await page.getByRole('button', { name: 'Zoom in timeline', exact: true }).focus();
    await page.keyboard.press('Enter');
    const small = await span();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-z="fit"]')?.classList.contains('on'));
    await page.waitForTimeout(350);
    expect(await span()).toBeGreaterThan(small);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.BOARD_TIMELINE_SCREENSHOT) {
      await page.screenshot({ path: process.env.BOARD_TIMELINE_SCREENSHOT, fullPage: true });
    }
  });
  it('manual zoom cancels an in-flight preset animation', async () => {
    await open();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(50);
    await page.getByRole('button', { name: 'Zoom in timeline', exact: true }).click();
    const after = await view();
    await page.waitForTimeout(300);
    expect(await view()).toEqual(after);
  });
});
