/** Shared real-browser boundaries; requests are forwarded only to the owned server. */
import { expect } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { CompanyService } from '../../src/company-service.js';
import { beginBrowserCoverage } from './browser-coverage.js';
export { closeCoveredPage, closeCoveredContext, closeCoveredBrowser } from './browser-coverage.js';
export type CompanyView = ReturnType<CompanyService['view']>;

type Probe = { errors: string[]; assets: string[]; initOrigins: string[] };
const probes = new WeakMap<Page, Probe>();
const ownedOrigins = new WeakMap<BrowserContext, string>();

/** Observe Chromium's actual network frames; no endpoint or EventSource is replaced. */
export async function observeOffice(page: Page, label: string) {
  const origin = ownedOrigins.get(page.context());
  if (!origin) throw new Error('Install the owned-origin boundary before observing a page');
  await beginBrowserCoverage(page, origin, label);
  const probe: Probe = { errors: [], assets: [], initOrigins: [] };
  probes.set(page, probe);
  page.on('pageerror', (error) => probe.errors.push(error.message));
  page.on('response', (response) => {
    if (['script', 'stylesheet'].includes(response.request().resourceType()) && response.status() >= 400)
      probe.assets.push(`${new URL(response.url()).pathname}: ${response.status()}`);
  });
  const network = await page.context().newCDPSession(page);
  const requests = new Map<string, string>();
  network.on('Network.requestWillBeSent', (event: { requestId: string; request: { url: string } }) => {
    const url = new URL(event.request.url);
    if (url.pathname === '/api/events') requests.set(event.requestId, url.origin);
  });
  network.on('Network.eventSourceMessageReceived', (event: { requestId: string; eventName: string; data: string }) => {
    const origin = requests.get(event.requestId);
    if (!origin || event.eventName !== 'init') return;
    try {
      const payload = JSON.parse(event.data) as { sessions?: unknown[] };
      if (Array.isArray(payload.sessions) && payload.sessions.length === 0) probe.initOrigins.push(origin);
    } catch {
      /* A malformed frame never qualifies readiness. */
    }
  });
  await network.send('Network.enable');
}

export async function requireOfficeReady(page: Page) {
  const probe = probes.get(page);
  if (!probe) throw new Error('Install the real office observer before navigation');
  await page.waitForLoadState('domcontentloaded');
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (probe.errors.length || probe.assets.length)
      throw new Error(
        `Office startup failed: ${JSON.stringify({ pageErrors: probe.errors, assetFailures: probe.assets })}`
      );
    const opened = await page.evaluate(() => {
      const stream = (window as Window & { app?: { eventSource?: EventSource } }).app?.eventSource;
      return stream?.readyState === EventSource.OPEN && new URL(stream.url).pathname === '/api/events';
    });
    if (opened && probe.initOrigins.includes(new URL(page.url()).origin)) return;
    await page.waitForTimeout(25);
  }
  throw new Error(
    `Office startup did not open its real event stream and receive the empty-session init frame within 5 s: ${JSON.stringify(probe)}`
  );
}

export async function paint(page: Page) {
  await page.bringToFront();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

const forbidden = (method: string, path: string) =>
  method !== 'GET' &&
  method !== 'HEAD' &&
  (/^\/api\/(?:sessions|model-endpoints|subscription-profiles|worker|system\/(?:shutdown|stop|restart))/.test(path) ||
    /^\/api\/company\/employees(?:\/[^/]+\/(?:wake|vacation|restart|retire|restore|session|invite|reconnect))?$/.test(
      path
    ) ||
    /^\/api\/company\/(?:hire|resources)/.test(path));

export async function contextFor(context: BrowserContext, origin: string, blocked: string[]) {
  ownedOrigins.set(context, origin);
  await context.routeWebSocket('**/*', (socket) => {
    blocked.push(`WEBSOCKET ${new URL(socket.url()).pathname}`);
    socket.close({ code: 1008, reason: 'This no-worker fixture permits no runtime sockets' });
  });
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.origin !== origin || forbidden(request.method(), url.pathname)) {
      blocked.push(`${request.method()} ${url.origin === origin ? url.pathname : 'external-origin'}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

export async function signedIn(
  page: Page,
  origin: string,
  username: string,
  password: string,
  inspect: () => Promise<void> = async () => {}
) {
  await page.goto(origin + '/owner/login');
  expect((await page.request.get(origin + '/api/status')).status()).toBe(401);
  await inspect();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin === origin && url.pathname === '/', { waitUntil: 'domcontentloaded' });
  await requireOfficeReady(page);
  await page.waitForFunction(() => !!(window as Window & { reverieChat?: { built?: boolean } }).reverieChat?.built);
}

export async function json<T = CompanyView>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> {
  return (await page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const parsed = await response.json();
      if (!response.ok) throw new Error(`Fixture API request failed: ${method} ${path} (${response.status})`);
      return parsed?.success === true ? parsed.data : parsed;
    },
    { path, method, body }
  )) as T;
}

export async function claimOwner(
  page: Page,
  origin: string,
  username: string,
  password: string,
  inspect: (stage: 'first-run' | 'display-name') => Promise<void> = async () => {}
) {
  await page.goto(origin + '/owner/setup');
  await inspect('first-run');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.waitForURL((url) => url.origin === origin && url.pathname === '/', { waitUntil: 'domcontentloaded' });
  await requireOfficeReady(page);
  await page.waitForFunction(() => !!(window as Window & { reverieChat?: { built?: boolean } }).reverieChat?.built);
  const prompt = page.getByRole('dialog', { name: 'Your name', exact: true });
  await prompt.waitFor();
  await inspect('display-name');
  await prompt.getByLabel('Your name', { exact: true }).fill('Synthetic owner');
  await prompt.getByRole('button', { name: 'Save', exact: true }).click();
  await prompt.waitFor({ state: 'hidden' });
}
