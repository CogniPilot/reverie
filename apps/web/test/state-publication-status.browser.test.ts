/** Actual styled office, original StateStore fault and real authenticated SSE. No workers. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { createIsolatedOffice } from './helpers/isolated-office.js';
import {
  contextFor,
  observeOffice,
  claimOwner,
  requireOfficeReady,
  paint,
  closeCoveredPage,
  closeCoveredContext,
  closeCoveredBrowser,
} from './helpers/office-browser.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const artifacts = process.env.TEST_STATE_PUBLICATION_SCREENSHOT_DIR;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
type App = {
  eventSource: EventSource;
  connectSSE(): void;
  _updateSseSubscription(sessionId: string | null): Promise<void>;
};

for (const authentication of ['unacknowledged-public', 'rotated-owner-login', 'lost-update-reply'] as const) {
  it(`reconnects read-only to the selected terminal after ${authentication} refuses the old subscription`, async () => {
    vi.resetModules();
    const forwardedSessionWrites: string[] = [];
    const office = await createIsolatedOffice({
      ownerSetup: authentication !== 'unacknowledged-public',
      beforeStart: (server) => {
        server['app'].addHook('onRequest', async (request) => {
          if (request.method !== 'GET' && request.url.startsWith('/api/sessions/'))
            forwardedSessionWrites.push(request.method + ' ' + request.url);
        });
      },
    });
    const browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true });
    let context: BrowserContext | undefined, page: Page | undefined;
    const blocked: string[] = [],
      errors: string[] = [],
      mutations: string[] = [];
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await contextFor(context, office.origin(), blocked);
      page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.stack || error.message));
      await observeOffice(page, 'state-publication-' + authentication);
      const password = 'Synthetic-' + randomBytes(18).toString('hex');
      if (authentication !== 'unacknowledged-public') {
        await claimOwner(page, office.origin(), 'fixture-owner', password);
      } else {
        await page.goto(office.origin());
        await requireOfficeReady(page);
      }
      const rows = await office.seedUnstartedSessions(); // Genuine registered Sessions, never started.
      const resizePaths = new Set(rows.map((row) => `/api/sessions/${row.id}/resize`));
      await context.route('**/api/sessions/*/resize', async (route) => {
        if (!resizePaths.has(new URL(route.request().url()).pathname) || route.request().method() !== 'POST')
          return route.fallback();
        await office.assertNoRunningIntent();
        const response = await route.fetch(); // Only the real pid-null Session's ordinary geometry metadata route.
        try {
          expect(response.status()).toBe(200);
          await office.assertNoRunningIntent();
          await route.fulfill({ response });
        } finally {
          await response.dispose();
        }
      });
      const { getStore } = await import('../src/state-store.js');
      const store = getStore(),
        original = store.getSessions()[rows[0].id];
      try {
        store.setSession(rows[0].id, { ...original, pid: 42 });
        await store.saveNowAsync();
        await expect(office.assertNoRunningIntent()).rejects.toThrow('stored fixture Session');
        store.setSession(rows[0].id, { ...original, status: 'busy' });
        await store.saveNowAsync();
        await expect(office.assertNoRunningIntent()).rejects.toThrow('stored fixture Session');
      } finally {
        store.setSession(rows[0].id, original);
        await store.saveNowAsync();
      }
      await office.assertNoRunningIntent();
      const network = await context.newCDPSession(page);
      const streams = new Map<string, URL>();
      const frames: Array<{ nonce: string | null; event: string; data: { id?: string; data?: string } }> = [];
      network.on('Network.requestWillBeSent', (event) => {
        const url = new URL(event.request.url);
        if (url.pathname === '/api/events') streams.set(event.requestId, url);
      });
      network.on('Network.eventSourceMessageReceived', (event) => {
        const url = streams.get(event.requestId);
        if (url)
          frames.push({
            nonce: url.searchParams.get('streamNonce'),
            event: event.eventName,
            data: JSON.parse(event.data),
          });
      });
      await network.send('Network.enable');
      page.on('request', (request) => {
        if (
          request.method() !== 'GET' &&
          request.method() !== 'HEAD' &&
          new URL(request.url()).pathname !== '/api/crash-diag'
        )
          mutations.push(request.method() + ' ' + new URL(request.url()).pathname);
      });
      await page.goto(office.origin() + '/?legacy=1');
      await page.locator(`.session-tab[data-id="${rows[0].id}"]`).click();
      await page.waitForFunction(
        (id) => (window as unknown as { app: { activeSessionId: string } }).app.activeSessionId === id,
        rows[0].id
      );
      await page.evaluate(() => (window as unknown as { app: App }).app.connectSSE());
      const oldNonce = await page.evaluate(() =>
        new URL((window as unknown as { app: App }).app.eventSource.url).searchParams.get('streamNonce')
      );
      await expect.poll(() => frames.some((frame) => frame.nonce === oldNonce && frame.event === 'init')).toBe(true);
      if (authentication === 'rotated-owner-login') {
        const login = await context.request.post(office.origin() + '/api/owner/login', {
          headers: { origin: office.origin() },
          data: { username: 'fixture-owner', password },
        });
        expect(login.status()).toBe(200); // Browser cookie rotates; the existing SSE still belongs to the original login.
      }
      const subscriptions: number[] = [];
      const committedReplies: number[] = [];
      if (authentication === 'lost-update-reply') {
        await context.route('**/api/events/subscribe', async (route) => {
          const committed = await route.fetch(); // Actual authorized metadata mutation commits before its reply is lost.
          committedReplies.push(committed.status());
          await committed.dispose();
          await route.abort('connectionreset');
        });
      }
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/events/subscribe') subscriptions.push(response.status());
      });
      await page.locator(`.session-tab[data-id="${rows[1].id}"]`).click();
      await page.waitForFunction(
        (id) => (window as unknown as { app: { activeSessionId: string } }).app.activeSessionId === id,
        rows[1].id
      );
      if (authentication === 'lost-update-reply') await expect.poll(() => committedReplies).toEqual([204]);
      else await expect.poll(() => subscriptions).toEqual([404]);
      await page.waitForFunction(
        ({ nonce, id }) => {
          const source = (window as unknown as { app: App }).app.eventSource,
            url = new URL(source.url);
          return (
            source.readyState === EventSource.OPEN &&
            url.searchParams.get('streamNonce') !== nonce &&
            url.searchParams.get('sessions') === id
          );
        },
        { nonce: oldNonce, id: rows[1].id }
      );
      const currentNonce = await page.evaluate(() =>
        new URL((window as unknown as { app: App }).app.eventSource.url).searchParams.get('streamNonce')
      );
      await expect
        .poll(() => frames.some((frame) => frame.nonce === currentNonce && frame.event === 'init'))
        .toBe(true);
      const marker = 'Synthetic current terminal ' + authentication;
      const transport = office.currentServer()['sse'];
      transport.batchTerminalData(rows[0].id, 'EXCLUDED ORIGINAL TERMINAL');
      transport['flushSessionTerminalBatch'](rows[0].id);
      transport.batchTerminalData(rows[1].id, marker);
      transport['flushSessionTerminalBatch'](rows[1].id);
      await expect
        .poll(() =>
          frames
            .filter((frame) => frame.nonce === currentNonce && frame.event === 'session:terminal')
            .map((frame) => frame.data.id)
        )
        .toEqual([rows[1].id]);
      await expect
        .poll(() =>
          page!.evaluate(() => {
            const terminal = (
              window as unknown as {
                app: {
                  terminal: {
                    buffer: {
                      active: {
                        length: number;
                        getLine(index: number): { translateToString(trim: boolean): string } | undefined;
                      };
                    };
                  };
                };
              }
            ).app.terminal;
            const buffer = terminal.buffer.active;
            return Array.from(
              { length: buffer.length },
              (_, index) => buffer.getLine(index)?.translateToString(true) || ''
            ).join('\n');
          })
        )
        .toContain(marker);
      expect(await page.locator('.xterm-screen').isVisible()).toBe(true);
      await page.evaluate(() =>
        (window as unknown as { app: App }).app._updateSseSubscription(
          (window as unknown as { app: { activeSessionId: string } }).app.activeSessionId
        )
      );
      expect(subscriptions).toEqual(authentication === 'lost-update-reply' ? [] : [404]);
      expect(committedReplies).toEqual(authentication === 'lost-update-reply' ? [204] : []);
      // Matching fresh GET init cannot cause a denial/reconnect loop, even after a committed reply was lost.
      await office.assertNoRunningIntent();
      if (artifacts && errors.length) {
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          join(artifacts, authentication + '-failure.json'),
          JSON.stringify({ errors, blocked, mutations }, null, 2)
        );
      }
      expect(errors).toEqual([]);
      expect(
        mutations.filter(
          (value) =>
            value !== 'POST /api/events/subscribe' &&
            value !== 'POST /api/office/presence' &&
            value !== 'PUT /api/subagent-window-states' &&
            ![...resizePaths].some((path) => value === 'POST ' + path) &&
            !blocked.includes(value)
        )
      ).toEqual([]);
      // The browser's normal terminal socket attempts are denied by the owned
      // fixture boundary; no provider/input request is forwarded.
      expect(forwardedSessionWrites.length).toBeGreaterThan(0);
      expect(forwardedSessionWrites.every((value) => [...resizePaths].some((path) => value === 'POST ' + path))).toBe(
        true
      );
      expect(
        blocked.every((value) =>
          rows.some(
            (row) =>
              value === `WEBSOCKET /ws/sessions/${row.id}/terminal` || value === `POST /api/sessions/${row.id}/shell`
          )
        )
      ).toBe(true);
    } finally {
      if (page) await closeCoveredPage(page);
      if (context) await closeCoveredContext(context);
      await closeCoveredBrowser(browser);
      await office.close();
    }
  });
}

it('shows a known subscription authentication refusal without navigating or spending the editable draft', async () => {
  vi.resetModules();
  const office = await createIsolatedOffice();
  const browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true });
  let context: BrowserContext | undefined, page: Page | undefined;
  let release = () => {};
  let pending: Promise<unknown> | undefined;
  const blocked: string[] = [],
    errors: string[] = [];
  try {
    context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    await contextFor(context, office.origin(), blocked);
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.stack || error.message));
    await observeOffice(page, 'state-publication-auth-refusal');
    await claimOwner(page, office.origin(), 'fixture-owner', 'Synthetic-' + randomBytes(18).toString('hex'));
    await page.evaluate(() => (window as unknown as { app: { openChatroom(): void } }).app.openChatroom());
    // The empty office's real room-creation form is editable, but remains
    // unsubmitted: no room, member briefing or initial message is published.
    const draft = page.getByLabel('Room name', { exact: true });
    await draft.fill('Unsubmitted original draft Ω');
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const statuses: number[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/events/subscribe') statuses.push(response.status());
    });
    await context.route('**/api/events/subscribe', async (route) => {
      entered();
      await released; // Original browser request has not reached the actual authentication hook yet.
      await route.continue();
    });
    pending = page.evaluate(() =>
      (window as unknown as { app: App }).app._updateSseSubscription('readonly-auth-fixture')
    );
    await reached;
    const logout = await context.request.post(office.origin() + '/api/owner/logout', {
      headers: { origin: office.origin() },
    });
    expect(logout.status()).toBe(200);
    release();
    await pending;
    expect(statuses).toEqual([401]);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, 'auth-refusal-result.json'),
        JSON.stringify(
          await page.evaluate(() => ({
            url: location.href,
            toasts: [...document.querySelectorAll('.toast')].map((element) => ({
              text: element.textContent,
              display: getComputedStyle(element).display,
              parent: element.parentElement?.outerHTML.slice(0, 1000),
            })),
            stream: (window as unknown as { app?: App }).app?.eventSource?.url,
          })),
          null,
          2
        )
      );
    }
    const message = page.getByText('Sign in again to refresh terminal output. Unsaved drafts are kept.', {
      exact: true,
    });
    await expect.poll(() => message.isVisible()).toBe(true);
    await expect
      .poll(() =>
        message.evaluate((element) => {
          const toast = element.closest('.toast')!;
          const rect = toast.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return (
            getComputedStyle(toast).opacity === '1' &&
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            !!hit &&
            toast.contains(hit)
          );
        })
      )
      .toBe(true);
    await paint(page);
    if (artifacts) await page.screenshot({ path: join(artifacts, 'auth-refusal-result.png') });
    expect(page.url()).toBe(office.origin() + '/');
    expect(await draft.inputValue()).toBe('Unsubmitted original draft Ω');
    expect(await draft.isVisible()).toBe(true);
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
    await office.assertNoRunningIntent();
  } finally {
    release();
    await pending?.catch(() => {});
    if (page) await closeCoveredPage(page);
    if (context) await closeCoveredContext(context);
    await closeCoveredBrowser(browser);
    await office.close();
  }
});
async function visible(page: Page) {
  const banner = page.getByRole('alert').filter({ hasText: 'App state saving is blocked' });
  await expect(banner.isVisible()).resolves.toBe(true);
  const geometry = await banner.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: innerWidth,
      height: innerHeight,
      unobscured: !!center && element.contains(center),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.unobscured).toBe(true);
  expect(geometry.overflow).toBe(false);
  expect(await banner.textContent()).toContain('Recent changes may already be saved');
  return banner;
}

it('keeps an actual publication warning visible in phone and desktop chat/Company views across stale init', async () => {
  vi.resetModules();
  const office = await createIsolatedOffice();
  const browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true });
  const contexts: BrowserContext[] = [],
    pages: Page[] = [],
    blocked: string[] = [],
    errors: string[] = [];
  const writes: string[] = [];
  const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  try {
    const employees = await office.seedStoppedEmployees();
    const owner = await browser.newContext({ viewport: { width: 320, height: 640 } });
    contexts.push(owner);
    await contextFor(owner, office.origin(), blocked);
    const phone = await owner.newPage();
    pages.push(phone);
    phone.on('pageerror', (error) => errors.push(error.message));
    await observeOffice(phone, 'state-publication-phone');
    await claimOwner(phone, office.origin(), 'fixture-owner', 'Synthetic-' + randomBytes(18).toString('hex'));
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: { cookies: (await owner.storageState()).cookies, origins: [] },
    });
    contexts.push(desktopContext);
    await contextFor(desktopContext, office.origin(), blocked);
    const desktop = await desktopContext.newPage();
    pages.push(desktop);
    desktop.on('pageerror', (error) => errors.push(error.message));
    await observeOffice(desktop, 'state-publication-desktop');
    await desktop.goto(office.origin());
    await requireOfficeReady(desktop);
    const clientIds = await Promise.all(
      pages.map((page) => page.evaluate(() => (window as unknown as { app: { _clientId: string } }).app._clientId))
    );
    expect(new Set(clientIds).size).toBe(2); // Independent devices share auth, not browser-local input/device state.
    const sibling = await owner.newPage(); // Genuine same-context tab shares the original browser localStorage.
    pages.push(sibling);
    sibling.on('pageerror', (error) => errors.push(error.message));
    await observeOffice(sibling, 'state-publication-same-browser-tab');
    await sibling.goto(office.origin());
    await requireOfficeReady(sibling);
    expect(await sibling.evaluate(() => (window as unknown as { app: { _clientId: string } }).app._clientId)).toBe(
      clientIds[0]
    );
    await sibling.evaluate(() =>
      (window as unknown as { reverieChat: { openCompany(section: string): Promise<void> } }).reverieChat.openCompany(
        'people'
      )
    );
    const selection = (page: Page) =>
      page.evaluate(() => {
        const scope = window as unknown as {
          app: { activeSessionId: string | null };
          reverieChat: { view: string; embed: string | null; roomId: string | null };
        };
        return {
          view: scope.reverieChat.view,
          embed: scope.reverieChat.embed ?? null,
          roomId: scope.reverieChat.roomId ?? null,
          session: scope.app.activeSessionId ?? null,
        };
      });
    const selectedViews = await Promise.all(pages.map(selection));
    expect(selectedViews[2].embed).toBe('company');
    expect(selectedViews[0].embed).not.toBe('company');
    for (const page of pages) {
      expect(await page.locator('#statePublicationBanner').isVisible()).toBe(false);
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() !== 'GET' && request.method() !== 'HEAD' && url.pathname !== '/api/crash-diag')
          writes.push(request.method() + ' ' + url.pathname);
      });
    }
    const snapshotResponse = await owner.request.get(office.origin() + '/api/status');
    const snapshotBody = await snapshotResponse.json();
    const oldSnapshot = snapshotBody.data ?? snapshotBody;
    const { getStore } = await import('../src/state-store.js');
    const store = getStore();
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      original(from, to);
      throw new Error('PRIVATE_STATE_PUBLICATION_BROWSER_EVIDENCE');
    });
    await expect(store.commitCronWatch(() => {})).rejects.toMatchObject({ code: 'STATE_PUBLICATION_UNCONFIRMED' });
    for (const page of pages) await page.locator('#statePublicationBanner:not([hidden])').waitFor({ timeout: 5_000 });
    expect(await Promise.all(pages.map(selection))).toEqual(selectedViews); // Real same-browser tabs keep independent view selection.
    for (const [index, page] of pages.entries()) {
      const label = index === 0 ? 'phone' : index === 1 ? 'desktop' : 'same-browser-tab';
      const width = page.viewportSize()!.width;
      await page.locator('#statePublicationBanner:not([hidden])').waitFor({ timeout: 5_000 });
      await visible(page); // Reached by the original server's actual SSE notification, not a client dispatch.
      await paint(page);
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, label + '-chat-' + width + '.png') });
      }
      await page.evaluate(() => {
        (window as unknown as { reverieChat: { openCompany(section: string): Promise<void> } }).reverieChat.openCompany(
          'people'
        );
      });
      await page.locator('.ca-root:visible').waitFor();
      await visible(page);
      const contentTop = await page.locator('.ca-root').evaluate((element) => element.getBoundingClientRect().top);
      const bannerBottom = await page
        .locator('#statePublicationBanner')
        .evaluate((element) => element.getBoundingClientRect().bottom);
      expect(contentTop).toBeGreaterThanOrEqual(bannerBottom - 1);
      const contentBottom = await page
        .locator('.ca-root')
        .evaluate((element) => element.getBoundingClientRect().bottom);
      expect(contentBottom).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
      await paint(page);
      if (artifacts) await page.screenshot({ path: join(artifacts, label + '-company-' + width + '.png') });
      await page.getByRole('button', { name: 'Company settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
      await settings.getByRole('tab', { name: 'Company', exact: true }).click();
      const ownerDraft = settings.getByLabel('Owner display name', { exact: true });
      await ownerDraft.fill('Unsubmitted owner draft');
      await ownerDraft.focus();
      await visible(page);
      for (const control of [
        settings.locator('h2'),
        settings.getByRole('button', { name: 'Close company settings', exact: true }),
        ownerDraft,
      ]) {
        const rect = await control.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.y).toBeGreaterThanOrEqual(bannerBottom - 1);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      }
      expect(await ownerDraft.inputValue()).toBe('Unsubmitted owner draft');
      expect(await ownerDraft.evaluate((element) => document.activeElement === element)).toBe(true);
      if (artifacts) await page.screenshot({ path: join(artifacts, label + '-settings-' + width + '.png') });
      await settings.getByRole('button', { name: 'Close company settings', exact: true }).click();
      await page.getByRole('button', { name: 'Edit profile for ' + employees[0].name, exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Edit profile: ' + employees[0].name, exact: true });
      const roleDraft = profile.getByLabel('Role title', { exact: true });
      await roleDraft.fill('Unsubmitted profile draft');
      await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
      const permission = profile.getByRole('checkbox').first();
      await permission.focus();
      await visible(page);
      const closeProfile = profile.getByRole('button', { name: 'Close profile for ' + employees[0].name, exact: true });
      for (const control of [profile.locator('h2'), closeProfile, permission]) {
        const rect = await control.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.y).toBeGreaterThanOrEqual(bannerBottom - 1);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      }
      expect(await roleDraft.inputValue()).toBe('Unsubmitted profile draft');
      expect(await permission.evaluate((element) => document.activeElement === element)).toBe(true);
      if (artifacts) await page.screenshot({ path: join(artifacts, label + '-permissions-' + width + '.png') });

      // Generic native-dialog composition: insert the new fixture before the
      // actual profile, then show it above that profile without moving any open dialog.
      const nativeOrder = await page.evaluate(() => {
        const profile = document.querySelector('dialog.ca-expert-profile');
        if (!profile?.matches(':modal')) throw new Error('Actual profile must remain native modal');
        const upper = document.createElement('dialog');
        upper.className = 'ca-dialog';
        upper.setAttribute('aria-label', 'Native top-layer ordering fixture');
        const label = document.createElement('label');
        label.textContent = 'Native top-layer draft';
        const input = document.createElement('input');
        input.value = 'Original top-layer draft';
        label.append(input);
        const close = document.createElement('button');
        close.textContent = 'Close native ordering fixture';
        close.addEventListener('click', () => upper.close());
        upper.addEventListener('close', () => upper.remove());
        upper.append(label, close);
        document.body.insertBefore(upper, profile);
        upper.showModal();
        input.focus();
        return {
          bothModal: upper.matches(':modal') && profile.matches(':modal'),
          focused: document.activeElement === input,
          order: [...document.querySelectorAll('dialog:modal')].map((dialog) => dialog.getAttribute('aria-label')),
        };
      });
      expect(nativeOrder).toEqual({
        bothModal: true,
        focused: true,
        order: ['Native top-layer ordering fixture', 'Edit profile: ' + employees[0].name],
      });
      if (artifacts) await writeFile(join(artifacts, label + '-native-order.json'), JSON.stringify(nativeOrder));
      const upperDraft = page
        .getByRole('dialog', { name: 'Native top-layer ordering fixture', exact: true })
        .getByLabel('Native top-layer draft', { exact: true });
      await visible(page);
      expect(await upperDraft.inputValue()).toBe('Original top-layer draft');
      expect(await upperDraft.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await roleDraft.inputValue()).toBe('Unsubmitted profile draft');
      if (artifacts) await page.screenshot({ path: join(artifacts, label + '-native-order-' + width + '.png') });
      await page.getByRole('button', { name: 'Close native ordering fixture', exact: true }).click();
      await visible(page);
      await closeProfile.click();
      await page.evaluate(() =>
        (window as unknown as { reverieChat: { setView(view: string): void } }).reverieChat.setView('debug')
      );
      await visible(page);
      for (const control of [page.locator('.ca-back'), page.locator('.app > .main')]) {
        const rect = await control.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.y).toBeGreaterThanOrEqual(bannerBottom - 1);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
      }
      const debugBottom = await page.locator('.app').evaluate((element) => element.getBoundingClientRect().bottom);
      expect(debugBottom).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
      if (artifacts) await page.screenshot({ path: join(artifacts, label + '-debug-' + width + '.png') });
      await page.evaluate(() =>
        (window as unknown as { reverieChat: { setView(view: string): void } }).reverieChat.setView('chat')
      );
      await visible(page);
      await page.evaluate((snapshot) => {
        const app = (window as unknown as { app: App }).app;
        app.eventSource.dispatchEvent(new MessageEvent('init', { data: JSON.stringify(snapshot) }));
        app.eventSource.dispatchEvent(
          new MessageEvent('state:publicationHeld', {
            data: JSON.stringify({ version: 1, kind: 'no-hold-observed' }),
          })
        );
        app.eventSource.dispatchEvent(
          new MessageEvent('init', { data: JSON.stringify({ ...snapshot, statePublication: false }) })
        );
      }, oldSnapshot);
      await visible(page);
    }
    const keys = await Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          new URL((window as unknown as { app: App }).app.eventSource.url).searchParams.get('clientId')
        )
      )
    );
    expect(new Set(keys).size).toBe(3);
    for (const page of pages) {
      const originalKey = await page.evaluate(() =>
        new URL((window as unknown as { app: App }).app.eventSource.url).searchParams.get('clientId')
      );
      await page.evaluate(() => (window as unknown as { app: App }).app._updateSseSubscription(null));
      const staleHandlersPreserveSuccessor = await page.evaluate(() => {
        const app = (window as unknown as { app: App }).app;
        const predecessor = app.eventSource,
          oldOpen = predecessor.onopen,
          oldError = predecessor.onerror;
        const oldNonce = new URL(predecessor.url).searchParams.get('streamNonce');
        app.connectSSE();
        const successor = app.eventSource;
        oldOpen?.call(predecessor, new Event('open'));
        oldError?.call(predecessor, new Event('error'));
        return (
          app.eventSource === successor &&
          successor.readyState !== EventSource.CLOSED &&
          new URL(successor.url).searchParams.get('streamNonce') !== oldNonce
        );
      });
      expect(staleHandlersPreserveSuccessor).toBe(true);
      await requireOfficeReady(page);
      expect(
        await page.evaluate(() =>
          new URL((window as unknown as { app: App }).app.eventSource.url).searchParams.get('clientId')
        )
      ).toBe(originalKey);
      await visible(page);
    }
    expect(Object.keys(store.getSessions())).toEqual([]);
    // Existing authenticated presence metadata may settle independently; no notice or provider/input write is replayed.
    expect(
      writes.filter((write) => write !== 'POST /api/office/presence' && write !== 'PUT /api/subagent-window-states')
    ).toEqual([]); // The initial GET already establishes this exact filter; no redundant update/retry.
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
    await office.assertNoRunningIntent();
  } catch (error) {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      const states = await Promise.all(
        pages.map((page) =>
          page.evaluate(() => {
            const scope = window as unknown as {
              app: App & {
                _clientId: string;
                _wsTabNonce: string;
                _statePublicationHoldObserved?: boolean;
                _sseHandlerWrappers?: Map<string, unknown>;
              };
            };
            const banner = document.getElementById('statePublicationBanner');
            return {
              deviceId: scope.app._clientId,
              pageNonce: scope.app._wsTabNonce,
              streamKey: new URL(scope.app.eventSource.url).searchParams.get('clientId'),
              streamState: scope.app.eventSource.readyState,
              registered: scope.app._sseHandlerWrappers?.has('state:publicationHeld'),
              observed: scope.app._statePublicationHoldObserved ?? false,
              bannerHidden: banner?.hidden,
              bannerDisplay: banner ? getComputedStyle(banner).display : null,
              ancestors: (() => {
                const rows = [];
                for (let node: Element | null = banner; node; node = node.parentElement) {
                  rows.push({
                    tag: node.tagName,
                    id: node.id,
                    class: node.className,
                    display: getComputedStyle(node).display,
                    open: node.getAttribute('open'),
                    style: node.getAttribute('style'),
                  });
                }
                return rows;
              })(),
              dialogs: [...document.querySelectorAll('dialog')].map((dialog) => ({
                name: dialog.getAttribute('aria-label'),
                open: dialog.open,
              })),
            };
          })
        )
      );
      await writeFile(
        join(artifacts, 'failure-state.json'),
        JSON.stringify({ states, errors, writes, blocked }, null, 2)
      );
      for (const [index, page] of pages.entries())
        await page.screenshot({ path: join(artifacts, 'failure-' + index + '.png') });
    }
    throw error;
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(original);
    for (const page of pages) await closeCoveredPage(page);
    for (const context of contexts) await closeCoveredContext(context);
    await closeCoveredBrowser(browser);
    await office.close();
  }
}, 60_000);

it('keeps the genuine Config publication failure visible above Terminal settings without losing its independent draft', async () => {
  vi.resetModules();
  const office = await createIsolatedOffice();
  const browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true });
  const contexts: BrowserContext[] = [],
    pages: Page[] = [],
    blocked: string[] = [],
    errors: string[] = [];
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  try {
    const phoneContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
    contexts.push(phoneContext);
    await contextFor(phoneContext, office.origin(), blocked);
    const phone = await phoneContext.newPage();
    pages.push(phone);
    phone.on('pageerror', (error) => errors.push(error.message));
    await observeOffice(phone, 'config-held-phone');
    await claimOwner(phone, office.origin(), 'fixture-owner', 'Synthetic-' + randomBytes(18).toString('hex'));
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: { cookies: (await phoneContext.storageState()).cookies, origins: [] },
    });
    contexts.push(desktopContext);
    await contextFor(desktopContext, office.origin(), blocked);
    const desktop = await desktopContext.newPage();
    pages.push(desktop);
    desktop.on('pageerror', (error) => errors.push(error.message));
    await observeOffice(desktop, 'config-held-desktop');
    await desktop.goto(office.origin());
    await requireOfficeReady(desktop);
    for (const page of pages) {
      await page.evaluate(() =>
        (window as unknown as { reverieChat: { openPage(name: string): Promise<void> } }).reverieChat.openPage('office')
      );
      await page.getByRole('button', { name: 'Open terminal settings', exact: true }).click();
      await page.locator('#appSettingsSearch').fill('display name');
      await page.locator('#appSettingsDisplayName').fill('Unsaved independent settings draft');
    }
    const store = office.currentServer()['store'];
    const before = store.getConfig().maxConcurrentSessions;
    let lost = false;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actual.renameSync(from, to);
      if (!lost && String(to) === store['filePath']) {
        lost = true;
        throw Error('Synthetic Config commit answer lost');
      }
    });
    const result = await phone.request.put(office.origin() + '/api/config', {
      headers: { Origin: office.origin() },
      data: { maxConcurrentSessions: before + 1 },
    });
    expect(result.status()).toBe(503);
    expect(lost).toBe(true);
    expect((await phone.request.get(office.origin() + '/api/config')).status()).toBe(503);
    for (const page of pages) {
      const warning = page.locator('#statePublicationBanner');
      await warning.waitFor({ state: 'visible' });
      await paint(page);
      const close = page.getByRole('button', { name: 'Close app settings', exact: true });
      const warningBox = await warning.boundingBox(),
        closeBox = await close.boundingBox();
      expect(warningBox).not.toBeNull();
      expect(closeBox).not.toBeNull();
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: join(artifacts, 'config-held-terminal-settings-' + page.viewportSize()!.width + '.png'),
        });
      }
      expect(closeBox!.y).toBeGreaterThanOrEqual(warningBox!.y + warningBox!.height);
      expect(
        await close.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })
      ).toBe(true);
      expect(await page.locator('#appSettingsDisplayName').inputValue()).toBe('Unsaved independent settings draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await close.click();
    }
    await office.assertNoRunningIntent();
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    for (const page of pages) await closeCoveredPage(page);
    for (const context of contexts) await closeCoveredContext(context);
    await closeCoveredBrowser(browser);
    await office.close();
  }
}, 60_000);

it('reconciles actual mux metadata independently after a lost reply and ignores an older repair acknowledgement', async () => {
  vi.resetModules();
  const office = await createIsolatedOffice();
  const browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true });
  const contexts: BrowserContext[] = [],
    pages: Page[] = [],
    blocked: string[] = [],
    errors: string[] = [];
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const { TmuxManager } = await import('../src/tmux-manager.js');
  let releaseOldReply = () => {};
  try {
    await office.seedStoppedEmployees();
    // Seeding restarts the owned server; capture the actual current writer only afterwards.
    const manager = office.currentServer()['mux'];
    if (!(manager instanceof TmuxManager)) throw Error('Expected actual fixture tmux metadata owner');
    const owner = await browser.newContext({ viewport: { width: 320, height: 640 } });
    contexts.push(owner);
    await contextFor(owner, office.origin(), blocked);
    const phone = await owner.newPage();
    pages.push(phone);
    phone.on('pageerror', (error) => errors.push(error.message));
    await observeOffice(phone, 'mux-metadata-phone');
    await claimOwner(phone, office.origin(), 'fixture-owner', 'Synthetic-' + randomBytes(18).toString('hex'));
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: { cookies: (await owner.storageState()).cookies, origins: [] },
    });
    contexts.push(desktopContext);
    await contextFor(desktopContext, office.origin(), blocked);
    const desktop = await desktopContext.newPage();
    pages.push(desktop);
    desktop.on('pageerror', (error) => errors.push(error.message));
    await observeOffice(desktop, 'mux-metadata-desktop');
    await desktop.goto(office.origin());
    await requireOfficeReady(desktop);
    const dataDirectory = (await import('../src/config/instance.js')).getDataDir();
    const before = await asyncFs.readFile(join(dataDirectory, 'company.json'), 'utf8');
    const failOriginal = async () => {
      let armed = true;
      vi.mocked(asyncFs.rename).mockImplementation(async (...args) => {
        await actual.rename(...args);
        if (armed && args[1] === join(dataDirectory, 'mux-sessions.json')) {
          armed = false;
          throw Error('Synthetic answer lost after actual metadata rename');
        }
      });
      await expect(manager.publishCurrentSessionMetadata()).rejects.toThrow('Mux metadata publication is unconfirmed');
      expect(armed).toBe(false);
    };
    await failOriginal();
    const first = manager.getMuxMetadataPublicationStatus();
    if (first.kind !== 'unconfirmed') throw Error('Expected the actual original incident');
    const status = await phone.request.get(office.origin() + '/api/status');
    expect(status.status()).toBe(200);
    const body = await status.json();
    expect(body.data.muxMetadataPublication).toEqual(first);
    expect(body.data.statePublication).toEqual({ version: 1, kind: 'no-hold-observed' });
    const metadataRenames = () =>
      vi.mocked(asyncFs.rename).mock.calls.filter((args) => args[1] === join(dataDirectory, 'mux-sessions.json'))
        .length;
    const beforeRefusals = metadataRenames();
    const outsider = await browser.newContext();
    contexts.push(outsider);
    const denied = await outsider.request.post(office.origin() + '/api/mux/metadata/reconcile', {
      headers: { Origin: office.origin() },
      data: { writerId: first.writerId, expectedIncidentId: first.incidentId },
    });
    expect(denied.status()).toBe(401);
    expect(
      (
        await phone.request.post(office.origin() + '/api/mux/metadata/reconcile', {
          headers: { Origin: office.origin() },
          data: { writerId: (await import('node:crypto')).randomUUID(), expectedIncidentId: first.incidentId },
        })
      ).status()
    ).toBe(409);
    expect(metadataRenames()).toBe(beforeRefusals);
    expect(manager.getMuxMetadataPublicationStatus()).toEqual(first);
    for (const page of pages) {
      const notice = page.locator('#muxMetadataPublicationNotice');
      await notice.waitFor({ state: 'visible' });
      await paint(page);
      const bounds = await notice.boundingBox(),
        viewport = page.viewportSize()!;
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `mux-metadata-unconfirmed-${viewport.width}.png`) });
      }
      await page.evaluate(() =>
        (
          window as unknown as {
            reverieChat: {
              openCompany(section: string): Promise<void>;
            };
          }
        ).reverieChat.openCompany('people')
      );
      await page.getByRole('button', { name: 'Company settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
      await settings.getByRole('tab', { name: 'Company', exact: true }).click();
      const draft = settings.getByLabel('Owner display name', { exact: true });
      await draft.fill('Unsubmitted metadata-warning draft');
      await draft.focus();
      await paint(page);
      const banner = page.locator('#statePublicationBanner');
      const bannerBounds = await banner.boundingBox();
      expect(bannerBounds).not.toBeNull();
      expect(await banner.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
      for (const name of ['Refresh metadata status', 'Reconcile current metadata']) {
        const bounds = await banner.getByRole('button', { name, exact: true }).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.y).toBeGreaterThanOrEqual(bannerBounds!.y);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(bannerBounds!.y + bannerBounds!.height);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      }
      const bannerBottom = bannerBounds!.y + bannerBounds!.height;
      for (const control of [
        settings.locator('h2'),
        draft,
        settings.getByRole('button', { name: 'Close company settings', exact: true }),
      ]) {
        const bounds = await control.boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(bannerBottom - 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      }
      if (artifacts) await page.screenshot({ path: join(artifacts, `mux-metadata-settings-${viewport.width}.png`) });
    }
    // Close only this browser's original read stream so a lost POST reply cannot
    // be mistaken for a delivered repair receipt. Desktop still observes real SSE.
    await phone.evaluate(() => (window as unknown as { app: App }).app.eventSource.close());
    let writes = 0;
    const repairPath = '**/api/mux/metadata/reconcile';
    await phone.route(repairPath, async (route) => {
      writes++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
      await response.dispose();
    });
    await phone.getByRole('button', { name: 'Reconcile current metadata', exact: true }).click();
    await expect
      .poll(() => phone.locator('#muxMetadataPublicationResult').textContent())
      .toContain('may already have saved');
    expect(writes).toBe(1);
    expect(await phone.locator('#muxMetadataPublicationNotice').isVisible()).toBe(true);
    await expect.poll(() => desktop.locator('#statePublicationBanner').isVisible()).toBe(false);
    await phone.getByRole('button', { name: 'Refresh metadata status', exact: true }).click();
    await expect.poll(() => phone.locator('#statePublicationBanner').isVisible()).toBe(false);
    expect(writes).toBe(1); // Readback never republishes the lost original request.
    expect(
      await phone
        .getByRole('dialog', { name: 'Company settings', exact: true })
        .getByLabel('Owner display name', { exact: true })
        .inputValue()
    ).toBe('Unsubmitted metadata-warning draft');
    await phone.getByRole('button', { name: 'Close company settings', exact: true }).click();
    await phone.unroute(repairPath);
    await phone.reload();
    await requireOfficeReady(phone);
    await failOriginal();
    await phone.locator('#muxMetadataPublicationNotice').waitFor({ state: 'visible' });
    let replyReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      replyReady = resolve;
    });
    const heldReply = new Promise<void>((resolve) => {
      releaseOldReply = resolve;
    });
    await phone.route(repairPath, async (route) => {
      writes++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      replyReady();
      await heldReply;
      await route.fulfill({ response });
      await response.dispose();
    });
    await phone.getByRole('button', { name: 'Reconcile current metadata', exact: true }).click();
    await ready;
    await failOriginal(); // New incident on the SAME writer after the earlier known repair.
    const latest = manager.getMuxMetadataPublicationStatus();
    if (latest.kind !== 'unconfirmed') throw Error('Expected the new original incident');
    await expect
      .poll(() =>
        phone.evaluate(
          () =>
            (
              window as unknown as {
                app: { _muxMetadataIncident?: { incidentId: string } };
              }
            ).app._muxMetadataIncident?.incidentId
        )
      )
      .toBe(latest.incidentId);
    releaseOldReply();
    await expect
      .poll(() =>
        phone.evaluate(
          () =>
            !!(
              window as unknown as {
                app: { _muxMetadataNoticeFlight?: unknown };
              }
            ).app._muxMetadataNoticeFlight
        )
      )
      .toBe(false);
    expect(await phone.locator('#muxMetadataPublicationNotice').isVisible()).toBe(true);
    expect(manager.getMuxMetadataPublicationStatus()).toEqual(latest);
    expect(writes).toBe(2);
    // A successful metadata repair cannot clear the independent original main-state fence.
    const { getStore } = await import('../src/state-store.js');
    const originalMainRename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      originalMainRename(from, to);
      throw Error('Synthetic original main-state answer lost');
    });
    await expect(getStore().commitCronWatch(() => {})).rejects.toMatchObject({ code: 'STATE_PUBLICATION_UNCONFIRMED' });
    await phone.locator('#mainStatePublicationNotice').waitFor({ state: 'visible' });
    const compoundBounds = await phone.locator('#statePublicationBanner').boundingBox();
    expect(compoundBounds!.y + compoundBounds!.height).toBeLessThanOrEqual(640);
    if (artifacts) await phone.screenshot({ path: join(artifacts, 'mux-and-main-unconfirmed-320.png') });
    await phone.getByRole('button', { name: 'Reconcile current metadata', exact: true }).click();
    await expect.poll(() => phone.locator('#muxMetadataPublicationNotice').isVisible()).toBe(false);
    expect(await phone.locator('#mainStatePublicationNotice').isVisible()).toBe(true);
    expect(await phone.locator('#statePublicationBanner').isVisible()).toBe(true);
    expect(getStore().getStatePublicationStatus()).toEqual({ version: 1, kind: 'unconfirmed' });
    expect(writes).toBe(3);
    expect(await asyncFs.readFile(join(dataDirectory, 'company.json'), 'utf8')).toBe(before);
    await office.assertNoRunningIntent();
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
  } finally {
    releaseOldReply();
    vi.mocked(fs.renameSync).mockImplementation(
      (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync
    );
    vi.mocked(asyncFs.rename).mockImplementation(actual.rename);
    for (const page of pages) await closeCoveredPage(page);
    for (const context of contexts) await closeCoveredContext(context);
    await closeCoveredBrowser(browser);
    await office.close();
  }
}, 60_000);
