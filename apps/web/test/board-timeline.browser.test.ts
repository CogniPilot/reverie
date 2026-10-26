import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/board.html'), 'utf8');
const styles = readFileSync(resolve(import.meta.dirname, '../src/web/public/company-board.css'), 'utf8');
const now = Date.now();
const board = {
  rev: 1,
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
  let boardReads = 0;
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

  async function open(width = 1100, data: Record<string, unknown> = board, clock = false) {
    errors = [];
    boardReads = 0;
    page = await browser.newPage({ viewport: { width, height: 650 } });
    if (clock) await page.clock.install();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://board.test/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/api/board') {
        boardReads++;
        await route.fulfill({ json: { success: true, data } });
      } else if (new URL(route.request().url()).pathname === '/company-board.css') {
        await route.fulfill({ contentType: 'text/css', body: styles });
      } else await route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('http://board.test/board');
    await page.waitForFunction(() => document.querySelector('#tl svg') !== null);
    expect(await page.locator('#banner').isHidden()).toBe(true);
  }
  const view = () => page.evaluate(() => (window as any).eval('({...view})'));
  const visibleIds = () => page.evaluate(() => (window as any).eval('rowsForView().flatMap(r=>r.items.map(b=>b.i.id))'));
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

  it('groups legacy name owners with their canonical person in timeline and Kanban', async () => {
    const row = (id: string, owner: {owner?: string; ownerLabel?: string}, status='todo') => ({...board.issues[0],id,title:id,...owner,status});
    await open(390, {...board, roster:[{id:'person-one',name:'Morgan',state:'idle',position:'Engineer'}],
      issues:[row('stable',{owner:'person-one'},'done'),row('label',{owner:undefined,ownerLabel:'mOrGaN'}),row('literal',{owner:'MORGAN'}),row('owner',{owner:undefined,ownerLabel:'Owner'}),row('sleep',{owner:undefined,ownerLabel:'Sleep'})],
      ownerIds:{stable:'person-one',label:'person-one',literal:'person-one'},
      pace:{owners:{'person-one':{plannedToDate:3,doneOfPlanned:1,overdue:2,overdueHours:2,early:0,verdict:'behind'}}}});
    const rows=await page.evaluate(() => window.eval('rowsForView().map(r=>({key:r.key,who:r.who,count:r.items.length}))'));
    expect(rows).toEqual([{key:'person-one',who:'Morgan',count:3},{key:'label:Owner',who:'Owner',count:1},{key:'label:Sleep',who:'Sleep',count:1}]);
    expect(await page.evaluate(() => window.eval('ownerName(B.issues[1])'))).toBe('Morgan');
    await page.locator('[data-tab="kanban"]').click();
    expect(await page.locator('#kanban .card .meta2 .chip').filter({hasText:'Morgan'}).count()).toBe(3);
  });

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

  function plannedBoard() {
    const day = 24 * 3600000;
    const row = (id: string, start: number, end: number, tags: string[]) => ({
      ...board.issues[0], id, title: id, owner: 'person-one', ownerLabel: undefined, tags, start, end,
      status: 'triage', scale: end - start > day ? 'day' : 'hour',
    });
    return {...board, issues: [
      row('legacy', now - 4 * day, now - 3 * day, []),
      row('older-plan', now - 3 * day, now - 2 * day, ['company-plan-20000101']),
      row('current-task', now - 3600000, now + 3600000, ['company-plan-20261026']),
      row('current-forecast', now + 11 * day, now + 12 * day, ['company-plan-20261026']),
    ]};
  }

  it('defaults to the latest generic plan, keeps global overdue truthful, and restores All work on reload', async () => {
    const data = plannedBoard();
    await open(1100, data);
    expect(await page.getByLabel('Board work view').inputValue()).toBe('latest');
    expect(await visibleIds()).toEqual(['current-task', 'current-forecast']);
    expect(await page.locator('#work-scope-count').textContent()).toContain('2 of 4 cards');
    expect(await page.locator('#kpis .kpi').filter({hasText:'issues overdue'}).locator('b').textContent()).toBe('2');
    await page.locator('[data-tab="kanban"]').click();
    expect(await page.locator('#kanban .card').count()).toBe(2);
    await page.getByLabel('Board work view').selectOption('all');
    expect(await page.locator('#kanban .card').count()).toBe(4);
    expect(await page.evaluate(() => (window as any).eval('B.issues.length'))).toBe(4);
    await page.reload();await page.waitForSelector('#tl svg');
    expect(await page.getByLabel('Board work view').inputValue()).toBe('all');
    expect(await visibleIds()).toHaveLength(4);
    expect(await page.locator('#work-scope-count').textContent()).toContain('Summary totals above cover all work');
  });

  it('anchors 2 weeks to today for exactly 14 days, separately from historical Fit', async () => {
    await open(1100, plannedBoard());
    await page.getByLabel('Board work view').selectOption('all');
    const fit = await view();
    await page.locator('[data-z="2w"]').click();await page.waitForTimeout(350);
    const fortnight = await view();
    const today = await page.evaluate(() => (window as any).eval('startOfDay(Date.now())'));
    expect(Math.abs(fortnight.s - today)).toBeLessThan(1000);
    expect(fortnight.e - fortnight.s).toBe(14 * 24 * 3600000);
    expect(fit.s).toBeLessThan(fortnight.s - 24 * 3600000);
  });

  it('polls visible pages at 10 seconds without rebuilding an unchanged SVG, and refreshes on focus/visibility', async () => {
    const data = plannedBoard();
    data.issues.push({...data.issues[2], id:'due-without-revision', title:'due-without-revision', owner:'',
      start:Date.now() + 1000, end:Date.now() + 5000});
    await open(1100, data, true);
    expect(await page.locator('#kpis .kpi').filter({hasText:'issues overdue'}).locator('b').textContent()).toBe('2');
    const svg = await page.locator('#tl svg').elementHandle();
    const before = boardReads;
    data.built += 10000;
    await page.clock.fastForward(10000);
    await page.waitForFunction(() => (window as any).eval('loading === false'));
    await expect.poll(() => boardReads).toBe(before + 1);
    expect(await svg!.evaluate(el => el.isConnected)).toBe(true);
    expect(await page.locator('#kpis .kpi').filter({hasText:'issues overdue'}).locator('b').textContent()).toBe('3');
    await page.evaluate(() => Object.defineProperty(document, 'hidden', {configurable:true,get:()=>true}));
    await page.clock.fastForward(10000);expect(boardReads).toBe(before + 1);
    data.rev = 2;
    data.issues.push({...data.issues[2], id:'new-current-task', title:'new-current-task'});
    await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(() => (window as any).eval('B.rev === 2'));
    expect(await visibleIds()).toContain('new-current-task');
    const visibleReads = boardReads;
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => (window as any).eval('loading === false'));
    await expect.poll(() => boardReads).toBe(visibleReads + 1);
  });
});
