/** Read-only real-browser acceptance against a labelled disposable control.
 * Uses a cookie issued by its real owner login; never enrolls or starts workers. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { loadVerifiedCanaryOwner, applyVerifiedOwnerCookie } from './boxed-canary-browser-proof.mjs';

const [proofFile, output, sessionName = 'owner-session.json'] = process.argv.slice(2);
assert(proofFile && output && resolve(output) === output);
const canary = await loadVerifiedCanaryOwner(proofFile, sessionName);
const { proof, endpoint } = canary;
await fs.mkdir(output, { mode: 0o700 });
const browser = await chromium.launch({
  executablePath: process.env.REVERIE_BROWSER_EXECUTABLE || '/run/current-system/sw/bin/microsoft-edge',
  headless: true,
  chromiumSandbox: true,
});
const report = { control: proof.cid, image: proof.image, endpoint: endpoint.origin, viewports: [], errors: [] };
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await applyVerifiedOwnerCookie(context, canary);
      const page = await context.newPage();
      page.on('pageerror', (error) => report.errors.push({ width, message: error.message }));
      await page.goto(endpoint.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.reverieChat?.built === true);
      const onboarding = page.getByRole('dialog', { name: 'Your name', exact: true });
      if (
        await onboarding.waitFor({ state: 'visible', timeout: 5000 }).then(
          () => true,
          () => false
        )
      ) {
        await onboarding.getByRole('button', { name: 'Cancel', exact: true }).click();
        await onboarding.waitFor({ state: 'hidden' });
      }
      await page.evaluate(() => globalThis.reverieChat.openCompany('people'));
      await page.getByRole('button', { name: 'Edit profile for Synthetic boxed employee', exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Edit profile: Synthetic boxed employee', exact: true });
      await profile.locator('[data-profile-tab="permissions"]').click();
      const recovery = profile.locator('.ca-profile-docker-recovery');
      await recovery.waitFor();
      await page.waitForFunction(
        () =>
          !globalThis.document
            .querySelector('.ca-profile-docker-recovery [role="status"]')
            ?.textContent?.includes('Checking')
      );
      await recovery.scrollIntoViewIfNeeded();
      const metrics = await recovery.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const table = element.querySelector('table')?.getBoundingClientRect();
        return {
          width: globalThis.innerWidth,
          left: bounds.left,
          right: bounds.right,
          tableRight: table?.right,
          buttons: [...element.querySelectorAll('button')].map((button) => ({
            label: button.textContent,
            disabled: button.disabled,
          })),
          status: element.querySelector('[role="status"]')?.textContent,
          error: element.querySelector('[role="alert"]')?.textContent,
        };
      });
      assert(metrics.left >= 0 && metrics.right <= width + 1, 'Recovery panel overflows viewport');
      assert(metrics.tableRight === undefined || metrics.tableRight <= width + 1, 'Resource table overflows viewport');
      assert(await recovery.getByRole('button', { name: 'Refresh recovery status', exact: true }).isVisible());
      await page.screenshot({ path: join(output, `recovery-${width}.png`), fullPage: true });
      report.viewports.push(metrics);
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, [], 'Unexpected browser errors');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  throw error;
} finally {
  await browser.close();
  await fs.writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
