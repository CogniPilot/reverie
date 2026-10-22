import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { startPairingPreview } from './helpers/embassy-pairing-preview.mjs';
it('first-run Embassy asks for the owner address and creates a QR only after saving', async () => {
  const preview = await startPairingPreview(),
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
  try {
    const page = await browser.newPage();
    await page.goto(preview.url);
    await page.waitForSelector('.eg-channel');
    await page.evaluate(() => {
      const old = window.__server.handle;
      window.__server.handle = async (path, opts = {}) => {
        if (path === '/api/embassy-host') {
          const r = await old(path, opts),
            body = await r.json();
          body.data.builtin = true;
          body.data.needsAdvertisedOrigin = !window.__addressSaved;
          if (!window.__addressSaved) body.data.origin = '';
          return { ...r, json: async () => body };
        }
        if (path === '/api/embassy-host/settings') {
          window.__addressSaved = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { builtin: true, needsAdvertisedOrigin: false } }),
          };
        }
        return old(path, opts);
      };
    });
    await page.getByRole('button', { name: 'Add embassy channel', exact: true }).click();
    await page.getByText('Embassy is ready locally.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Invite a company', exact: true }).click();
    const address = page.getByLabel('Shareable HTTPS address');
    await expect(await address.inputValue()).toBe('');
    await address.fill('https://relay.example.test:8443');
    await page.getByRole('button', { name: 'Save address and invite', exact: true }).click();
    await page.locator('.eg-pair-qr').waitFor();
    expect(await page.locator('.eg-pair-dialog').textContent()).not.toContain('A'.repeat(43));
  } finally {
    await browser.close();
    await preview.close();
  }
});
