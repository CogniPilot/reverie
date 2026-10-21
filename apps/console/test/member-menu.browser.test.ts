import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
const A = '00000026-002d-4000-8000-00000000003c';

describe('member menu and profile in Chromium', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    });
  });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // All requests stay inside this fixture; no application server or live state.
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
    await page.goto('http://member-menu.test/', { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: read('styles.css') });
    await page.addStyleTag({ content: read('chat-app.css') });
    await page.addScriptTag({ content: `
      ${member.toString()}
      ${room.toString()}
      ${message.toString()}
      ${createServer.toString()}
      const user = { kind: 'user', name: 'Owner' };
      window.CodemanUrlSession = { sessionIdFromFragment: () => null };
      window.__server = createServer([room('r1', 'General', [member('${A}', 'Maple', { goal: 'Review the interface', mode: 'claude' })])]);
      window.__server.profiles = { '${A}': {
        persona: { agent_name: 'Maple', persona: 'Detailed profile. '.repeat(100) },
        employee: { position: 'Engineer' }, backend: { mode: 'claude' }, usage: { messages: 30 },
        session: { status: 'idle' },
        rooms: Array.from({ length: 30 }, (_, i) => ({ name: 'Channel ' + i, role: 'member' })),
        runtime: { backends: [{ name: 'claude', enabled: true }], switch: { available: false, reason: 'Owner authentication required.' } }
      } };
      window.fetch = () => Promise.resolve({ ok: true });
      ${appStub}
    ` });
    for (const name of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(name) });
    await page.addScriptTag({ content: `window.app = new CodemanApp(); window.app.sessions.set('${A}', { id: '${A}', name: 'Maple', mode: 'claude' });` });
    await page.addScriptTag({ content: read('chat-app.js') });
    await page.waitForSelector('.ca-member');
  });

  const open = () => page.locator('.ca-member').click({ button: 'right' });
  const bounds = (selector: string) => page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, height: r.height, scroll: el.scrollHeight, client: el.clientHeight };
  });

  it('keeps all actions visible without scrolling at 720 px and captures the review image', async () => {
    await open();
    const r = await bounds('.ca-member-menu');
    expect(r.height).toBeLessThanOrEqual(330);
    expect(r.top).toBeGreaterThanOrEqual(8);
    expect(r.bottom).toBeLessThanOrEqual(712);
    expect(r.scroll).toBeLessThanOrEqual(r.client);
    for (const label of ['Make lead', 'Remove from channel', 'Copy session id']) {
      const b = await page.getByRole('menuitem', { name: label, exact: true }).boundingBox();
      expect(b!.y).toBeGreaterThanOrEqual(r.top);
      expect(b!.y + b!.height).toBeLessThanOrEqual(r.bottom);
    }
    if (process.env.MEMBER_MENU_SCREENSHOT) await page.screenshot({ path: process.env.MEMBER_MENU_SCREENSHOT });
  });

  it('flips the menu inside the bottom and right edges', async () => {
    await page.locator('.ca-member').dispatchEvent('contextmenu', { clientX: 1278, clientY: 718 });
    const r = await bounds('.ca-member-menu');
    expect(r.right).toBeLessThanOrEqual(1272);
    expect(r.bottom).toBeLessThanOrEqual(712);
    expect(r.top).toBeGreaterThanOrEqual(8);
    expect(r.left).toBeGreaterThanOrEqual(8);
  });

  it('folds the full profile and keeps it on screen when opened at the bottom or expanded', async () => {
    await page.locator('.ca-member').evaluate((el) => {
      Object.assign((el as HTMLElement).style, { position: 'fixed', bottom: '2px', right: '2px', zIndex: '1200' });
    });
    await open();
    await page.getByRole('menuitem', { name: 'Profile', exact: true }).click();
    await page.waitForSelector('.ca-profile-full details');
    expect(await page.locator('.ca-profile details[open]').count()).toBe(0);
    const channels = page.locator('.ca-profile summary').filter({ hasText: 'in 30 channels' });
    await channels.click();
    expect(await page.locator('.ca-profile details[open]').count()).toBe(1);
    const r = await bounds('.ca-profile');
    expect(r.top).toBeGreaterThanOrEqual(8);
    expect(r.bottom).toBeLessThanOrEqual(712);
    expect(r.right).toBeLessThanOrEqual(1272);
    expect(r.height).toBeLessThanOrEqual(704);
  });

  it('uses arrows and Enter once, closes on Escape and outside click, and restores focus', async () => {
    await open();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.locator('.chatroom-input').inputValue()).toBe('@Maple ');
    expect(await page.locator('.ca-member-menu').count()).toBe(0);
    await open();
    await page.keyboard.press('Escape');
    expect(await page.locator('.ca-member').evaluate((el) => document.activeElement === el)).toBe(true);
    await open();
    await page.locator('.ca-head-title').click();
    expect(await page.locator('.ca-member-menu').count()).toBe(0);
  });

  it('opens the plus picker with icons and kinds, and captures its closed and open states', async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.app.sessions.set('s-river', { id: 's-river', name: 'River', mode: 'claude' });
      w.app.sessions.set('s-birch', { id: 's-birch', name: 'Birch', mode: 'claude' });
    });
    expect(await page.locator('.ca-members select').count()).toBe(0);
    if (process.env.MEMBER_PICKER_CLOSED_SCREENSHOT) await page.screenshot({ path: process.env.MEMBER_PICKER_CLOSED_SCREENSHOT });
    await page.getByRole('button', { name: 'Add an agent', exact: true }).click();
    expect(await page.locator('.ca-member-picker button').count()).toBe(2);
    expect(await page.locator('.ca-member-picker .chatroom-avatar').count()).toBe(2);
    expect(await page.locator('.ca-member-picker .ca-menu-hint').allTextContents()).toEqual(['claude', 'claude']);
    expect(await page.locator('.ca-member-picker input').count()).toBe(0);
    const r = await bounds('.ca-member-picker');
    expect(r.bottom).toBeLessThanOrEqual(712);
    expect(r.right).toBeLessThanOrEqual(1272);
    if (process.env.MEMBER_PICKER_OPEN_SCREENSHOT) await page.screenshot({ path: process.env.MEMBER_PICKER_OPEN_SCREENSHOT });
  });

  it('caps a long picker near the bottom, accepts spaces in search and adds a matching row with Enter', async () => {
    await page.evaluate(() => {
      const w = window as any;
      for (let i = 0; i < 30; i++) w.app.sessions.set(`candidate-${i}`, { id: `candidate-${i}`, name: `Candidate ${i}`, mode: 'claude' });
      w.app.sessions.set('long-name', { id: 'long-name', name: 'LongName'.repeat(30), mode: 'claude' });
      Object.assign((document.querySelector('.ca-add-button') as HTMLElement).style, { position: 'fixed', bottom: '2px', right: '2px' });
    });
    await page.getByRole('button', { name: 'Add an agent', exact: true }).click();
    const r = await bounds('.ca-member-picker');
    expect(r.bottom).toBeLessThanOrEqual(712);
    expect(r.right).toBeLessThanOrEqual(1272);
    expect(r.height).toBeLessThanOrEqual(420);
    expect(r.scroll).toBeGreaterThan(r.client);
    expect(await page.locator('.ca-member-picker').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole('searchbox', { name: 'Search agents' }).pressSequentially('Candidate 7');
    expect(await page.getByRole('searchbox').inputValue()).toBe('Candidate 7');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-key="member:candidate-7"]');
    expect(await page.evaluate(() => (window as any).__server.invited)).toEqual([{ id: 'r1', sessionId: 'candidate-7' }]);
    expect(await page.locator('.ca-member-picker').count()).toBe(0);
    expect(await page.locator('.ca-add-button').evaluate((el) => el === document.activeElement)).toBe(true);
  });

  it('explains an empty picker and closes with Escape or outside click', async () => {
    const plus = page.getByRole('button', { name: 'Add an agent', exact: true });
    await plus.click();
    expect(await page.locator('.ca-member-picker').innerText()).toBe('No other agents to add');
    await page.keyboard.press('Escape');
    expect(await plus.evaluate((el) => el === document.activeElement)).toBe(true);
    await plus.click();
    await page.locator('.ca-head-title').click();
    expect(await page.locator('.ca-member-picker').count()).toBe(0);
    expect(await plus.evaluate((el) => el === document.activeElement)).toBe(true);
  });
});
