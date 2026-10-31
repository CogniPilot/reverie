/**
 * A decision on the Board takes one click. The Board sits in a frame, so the first click into it gives
 * its window focus; that focus refreshed the board, and the refresh used to make the decisions section inert until the
 * read came back, so the click that caused it landed on an inert button and was dropped. A refresh must not take the
 * choices away: a stale choice is already refused by the server (ifRev).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';

const pub = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(pub, name), 'utf8');

async function setup(page: Page) {
  const state = { reads: 0, chosen: [] as unknown[], log: [] as string[] };
  const decisionsBoard = () => {
    const now = Date.now();
    return {
      success: true,
      data: {
        rev: 7, built: now, timeZone: 'UTC', company: { name: 'Fixture' }, issues: [], roster: [], milestones: [], polls: [],
        pins: [], wins: [], blockers: [], structuredDecisionWrites: true,
        decisions: [{ id: 'd-1', at: now - 6e4, where: 'office', text: 'Ship the fix today?', summary: 'Ship the fix today?', options: ['Yes', 'No'] }],
      },
    };
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const send = (type: string, body: string, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    if (path === '/') return send('text/html', '<!doctype html><html><body><input id="outside" aria-label="Outside"><iframe id="board" src="/board" style="width:1200px;height:800px;border:0"></iframe></body></html>');
    if (path === '/board') return send('text/html', read('board.html'));
    if (path === '/company-board.css') return send('text/css', read('company-board.css'));
    if (path === '/api/board') {
      state.reads++;
      state.log.push('read');
      // A board read takes a moment, as it does on a real console.
      setTimeout(() => send('application/json', JSON.stringify(decisionsBoard())), 400);
      return;
    }
    if (req.method === 'POST' && path === '/api/board/decisions/d-1/choose') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => { state.chosen.push(JSON.parse(body)); state.log.push('choose'); send('application/json', JSON.stringify({ success: true, data: {} })); });
      return;
    }
    send('text/plain', '', 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await page.goto(`http://127.0.0.1:${port}/`);
  const frame = page.frameLocator('#board');
  await expect.poll(() => page.frames().some((f) => new URL(f.url()).pathname === '/board')).toBe(true);
  const board = page.frames().find((f) => new URL(f.url()).pathname === '/board')!;
  await board.waitForFunction(() => (window as unknown as { eval(s: string): unknown }).eval('readyForActions') === true);
  return { state, frame, board, close: () => new Promise((r) => server.close(r)) };
}

it('records a choice on the first click into the board frame, even though that click starts a refresh', async () => {
  let closeServer: (() => Promise<unknown>) | undefined;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const { state, frame, board, close } = await setup(page);
    closeServer = close;
    // The owner was elsewhere on the page: the board frame does not have focus.
    await page.focus('#outside');
    expect(await board.evaluate(() => document.hasFocus())).toBe(false);
    const readsBefore = state.reads;
    const box = (await frame.locator('[data-decide="d-1"][data-opt="Yes"]').boundingBox())!;
    // One real click at the button, as a person makes it (no actionability waits that would hide a dropped click).
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // The focus refresh did start: that is what used to make the button inert under the click.
    await expect.poll(() => state.reads).toBeGreaterThan(readsBefore);
    await expect.poll(() => state.chosen, { timeout: 3000 }).toEqual([{ option: 'Yes', ifRev: 7 }]);
  } finally {
    await browser.close();
    await closeServer?.();
  }
}, 30000);

it('a background refresh leaves the choices usable, and hiding the board still takes them away', async () => {
  let closeServer: (() => Promise<unknown>) | undefined;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const { board, close } = await setup(page);
    closeServer = close;
    const inert = () => board.evaluate(() => (document.getElementById('sec-decisions') as HTMLElement & { inert: boolean }).inert);
    // A refresh is in flight (the read takes 400 ms): the decisions stay usable meanwhile.
    await board.evaluate(() => void (window as unknown as { eval(s: string): unknown }).eval('load()'));
    expect(await board.evaluate(() => (window as unknown as { eval(s: string): unknown }).eval('loading'))).toBe(true);
    expect(await inert()).toBe(false);
    expect(await board.evaluate(() => (window as unknown as { eval(s: string): unknown }).eval('readyForActions'))).toBe(true);
    // Pausing (hidden, or no longer the visible board) still makes them inert and refuses writes.
    await board.evaluate(() => (window as unknown as { eval(s: string): unknown }).eval('pauseBoard()'));
    expect(await inert()).toBe(true);
    expect(
      await board.evaluate(() =>
        (window as unknown as { eval(s: string): Promise<unknown> }).eval('post("/api/board/decisions/d-1/choose",{}).then(()=>false,()=>true)')
      )
    ).toBe(true);
  } finally {
    await browser.close();
    await closeServer?.();
  }
}, 30000);

it('a choice made while a refresh is in flight is followed by a fresh read, not the older one', async () => {
  let closeServer: (() => Promise<unknown>) | undefined;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const { state, frame, board, close } = await setup(page);
    closeServer = close;
    // The frame already has focus, so the click itself starts no refresh; one is in flight anyway (a poll).
    await board.evaluate(() => document.getElementById('cards')!.focus());
    await board.evaluate(() => void (window as unknown as { eval(s: string): unknown }).eval('load()'));
    state.log.length = 0;
    await frame.locator('[data-decide="d-1"][data-opt="No"]').click();
    await expect.poll(() => state.chosen).toEqual([{ option: 'No', ifRev: 7 }]);
    // The read that began before the write is dropped and a new one starts after it.
    await expect.poll(() => state.log.slice(state.log.indexOf('choose')), { timeout: 3000 }).toEqual(['choose', 'read']);
  } finally {
    await browser.close();
    await closeServer?.();
  }
}, 30000);
