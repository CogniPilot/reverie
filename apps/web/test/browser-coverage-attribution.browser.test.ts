/** A real iframe preload must never be reported as execution in that iframe. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { BrowserCoverageCollection, readRawBaseline } from './helpers/browser-coverage.js';
import { contextFor } from './helpers/office-browser.js';
import { createIsolatedOffice } from './helpers/isolated-office.js';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
it('binds real script execution to main even when a nested frame preloads the identical URL', async () => {
  const output = await mkdtemp(join(tmpdir(), 'coverage-attribution-'));
  let office: Awaited<ReturnType<typeof createIsolatedOffice>> | undefined;
  let browser: Browser | undefined, context: BrowserContext | undefined;
  try {
    office = await createIsolatedOffice();
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(executablePath ? { executablePath } : {}),
    });
    context = await browser.newContext();
    const blocked: string[] = [];
    await contextFor(context, office.origin(), blocked);
    const password = `Synthetic-${randomBytes(18).toString('hex')}`;
    const setup = await context.request.post(office.origin() + '/api/owner/setup', {
      headers: { origin: office.origin() },
      data: { username: 'fixture-owner', password, confirmation: password },
    });
    expect(setup.ok()).toBe(true);
    const page = await context.newPage(),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const collection = new BrowserCoverageCollection(resolve(import.meta.dirname, '..'), output);
    await collection.start(page, office.origin(), 'attribution-negative:main-execution-iframe-preload');
    const loaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/workspace-files.js' && response.request().frame() === page.mainFrame()
    );
    const listed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace/files');
    await page.goto(office.origin() + '/workspace-files.html');
    const actual = await loaded;
    expect(actual.status()).toBe(200);
    expect((await listed).status()).toBe(200);
    const preload = page.waitForResponse(
      (response) => response.url() === actual.url() && response.request().frame() !== page.mainFrame()
    );
    await page.evaluate((url) => {
      const iframe = document.createElement('iframe');
      iframe.title = 'Owned coverage preload fixture';
      iframe.srcdoc =
        '<!doctype html><link rel="preload" as="script" href="' +
        url +
        '"><p>Preload only; no script executes here.</p>';
      document.body.append(iframe);
    }, actual.url());
    const fetched = await preload;
    expect(fetched.status()).toBe(200);
    expect(fetched.request().resourceType()).toBe('script');
    await collection.finish(page);
    const report = readRawBaseline(output, { critical: ['/workspace-files.js'], iframe: [] });
    const module = report.sources.find((source) => source.asset === '/workspace-files.js');
    expect(module?.executed).toBe(true);
    expect(module?.frameKinds).toEqual(['main']);
    expect(() => readRawBaseline(output, { critical: [], iframe: ['/workspace-files.js'] })).toThrow(
      'Actual iframe JavaScript coverage was not collected'
    );
    expect((await context.request.get(office.origin() + '/api/sessions')).status()).toBe(200);
    const sessions = await (await context.request.get(office.origin() + '/api/sessions')).json();
    expect(sessions.data).toEqual([]);
    await office.assertNoRunningIntent();
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await office?.close();
      } finally {
        await rm(output, { recursive: true, force: true });
      }
    }
  }
}, 60_000);
