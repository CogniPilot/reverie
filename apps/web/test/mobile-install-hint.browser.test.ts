import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium, devices, type Browser } from 'playwright';

// The phone setup dialog in a real browser (Reverie would not install on his phone): an iPhone gets
// Safari's Add to Home Screen steps instead of a prompt it never receives, and a plain-HTTP page says why install
// and notifications cannot work rather than offering buttons that do nothing.
const pub = resolve(import.meta.dirname, '../src/web/public');
const read = (n: string) => readFileSync(resolve(pub, n), 'utf8');

async function dialog(browser: Browser, origin: string, device: (typeof devices)[string]) {
  const page = await browser.newPage({ ...device });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' }));
  await page.goto(origin + '/');
  await page.addStyleTag({ content: read('mobile-app.css') });
  await page.addScriptTag({ content: read('mobile-app.js') });
  await page.evaluate(() => (window as any).ReverieMobile.open());
  await page.waitForSelector('dialog.reverie-mobile-setup[open]');
  return page;
}

const launch = () => chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });

it('gives an iPhone the Share → Add to Home Screen steps and asks for the installed app before push', async () => {
  const browser = await launch();
  try {
    const page = await dialog(browser, 'https://reverie-phone.test', devices['iPhone 13']);
    expect(await page.locator('[data-insecure]').isHidden()).toBe(true);
    await page.locator('[data-install]').click();
    const help = page.locator('[data-install-help]');
    await expect.poll(() => help.textContent()).toContain('tap Share, then Add to Home Screen');
    expect(await help.isVisible()).toBe(true);
    await page.locator('[data-enable]').click();
    await expect.poll(() => page.locator('[data-status]').textContent()).toContain('add Reverie to your home screen first');
  } finally {
    await browser.close();
  }
});

it('keeps the Chrome steps on Android', async () => {
  const browser = await launch();
  try {
    const page = await dialog(browser, 'https://reverie-phone.test', devices['Pixel 7']);
    await page.locator('[data-install]').click();
    await expect.poll(() => page.locator('[data-install-help]').textContent()).toContain('In Chrome, tap ⋮ → Add to home screen');
  } finally {
    await browser.close();
  }
});

it('explains a plain-HTTP address and disables install and notifications there', async () => {
  const browser = await launch();
  try {
    const page = await dialog(browser, 'http://reverie-phone.test:3000', devices['Pixel 7']);
    const notice = page.locator('[data-insecure]');
    expect(await notice.isVisible()).toBe(true);
    expect(await notice.textContent()).toContain('http://reverie-phone.test:3000');
    expect(await notice.textContent()).toContain('over HTTPS');
    expect(await page.locator('[data-install]').isDisabled()).toBe(true);
    expect(await page.locator('[data-enable]').isDisabled()).toBe(true);
    const box = await notice.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  } finally {
    await browser.close();
  }
});
