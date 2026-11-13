/** Real owner GUI/API over an isolated OFF-only company; no Session or provider is created. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createIsolatedOffice, type IsolatedOffice } from './helpers/isolated-office.js';
import {
  claimOwner,
  contextFor,
  observeOffice,
  requireOfficeReady,
  paint,
  closeCoveredPage,
  closeCoveredContext,
  closeCoveredBrowser,
  type CompanyView,
} from './helpers/office-browser.js';

const artifacts = process.env.TEST_RETIREMENT_SCREENSHOT_DIR;
const password = 'Synthetic-retirement-' + randomBytes(18).toString('hex');
let office: IsolatedOffice, browser: Browser, audit: BrowserContext, context: BrowserContext, page: Page;
let employees: Awaited<ReturnType<IsolatedOffice['seedStoppedEmployees']>>;
let ownerState: Awaited<ReturnType<BrowserContext['storageState']>>;
let blocked: string[] = [],
  errors: string[] = [],
  posts: number;
let loseReply = false;
const employee = () => employees[0]!;

async function company(): Promise<CompanyView> {
  const response = await audit.request.get(office.origin() + '/api/company');
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function update(id: string, data: { reportsTo: string }): Promise<void> {
  const response = await audit.request.put(office.origin() + `/api/company/employees/${id}`, {
    headers: { origin: office.origin() },
    data,
  });
  expect(response.status()).toBe(200);
}
async function disk(): Promise<CompanyView> {
  const { dataPath } = await import('../src/config/instance.js');
  return JSON.parse(await readFile(dataPath('company.json'), 'utf8'));
}
async function profile(width = 320): Promise<Locator> {
  await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
  await page.evaluate(() =>
    (window as unknown as { reverieChat: { openCompany(section: string): void } }).reverieChat.openCompany('people')
  );
  await page.getByRole('button', { name: `Edit profile for ${employee().name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Edit profile: ${employee().name}`, exact: true });
  await dialog.getByLabel('Role title', { exact: true }).fill('Unsaved retirement draft');
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await dialog.getByText('Remove from company', { exact: true }).click();
  return dialog;
}
async function confirm(dialog: Locator): Promise<Locator> {
  await dialog.getByRole('button', { name: `Retire ${employee().name}`, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: `Retire: ${employee().name}`, exact: true });
  await confirmation.waitFor();
  return confirmation;
}
async function screenshot(name: string): Promise<void> {
  await paint(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, name + '.png') });
  }
}
async function readableError(dialog: Locator, error: Locator): Promise<void> {
  // A viewport-only check misses text clipped by the profile's fixed footer.
  // Neither the fixture nor the screenshot scrolls the error into view.
  const box = await error.boundingBox(),
    clip = await dialog.locator('.ca-profile-editor-body').boundingBox();
  expect(box).not.toBeNull();
  expect(clip).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(clip!.y);
  expect(box!.y + box!.height).toBeLessThanOrEqual(clip!.y + clip!.height);
  const viewport = page.viewportSize()!;
  for (const landmark of [
    dialog.getByRole('heading', { name: employee().name, exact: true }),
    dialog.getByRole('button', { name: `Close profile for ${employee().name}`, exact: true }),
    dialog.getByRole('tablist', { name: 'Employee profile sections', exact: true }),
    dialog.locator('.ca-profile-footer'),
  ]) {
    const bounds = await landmark.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  }
}

beforeAll(async () => {
  office = await createIsolatedOffice();
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const setup = await browser.newContext(),
    setupBlocked: string[] = [];
  await contextFor(setup, office.origin(), setupBlocked);
  const setupPage = await setup.newPage();
  await observeOffice(setupPage, 'retirement:setup');
  await claimOwner(setupPage, office.origin(), 'fixture-owner', password);
  expect(setupBlocked).toEqual([]);
  await closeCoveredContext(setup);
  employees = await office.seedStoppedEmployees();
  audit = await browser.newContext();
  const login = await audit.request.post(office.origin() + '/api/owner/login', {
    headers: { origin: office.origin() },
    data: { username: 'fixture-owner', password },
  });
  expect(login.status()).toBe(200);
  ownerState = await audit.storageState();
}, 60_000);

beforeEach(async (test) => {
  blocked = [];
  errors = [];
  posts = 0;
  loseReply = false;
  await office.assertNoRunningIntent();
  const before = await company();
  for (const row of before.retired) {
    if (!employees.some((item) => item.id === row.id)) throw Error('Unexpected retired fixture identity');
    const response = await audit.request.post(office.origin() + `/api/company/employees/${row.id}/restore`, {
      headers: { origin: office.origin() },
      data: {},
    });
    expect(response.status()).toBe(200);
  }
  for (const row of employees) await update(row.id, { reportsTo: 'owner' });
  context = await browser.newContext({ storageState: ownerState, viewport: { width: 320, height: 640 } });
  await contextFor(context, office.origin(), blocked);
  // The general no-worker guard remains closed. This one exact owner action is
  // admitted only while the actual live/disk Session registries remain empty.
  await context.route('**/api/company/employees/' + employee().id + '/retire', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST' || new URL(request.url()).origin !== office.origin()) return route.fallback();
    await office.assertNoRunningIntent();
    posts++;
    const response = await route.fetch({ maxRedirects: 0 });
    try {
      await office.assertNoRunningIntent();
      if (loseReply) {
        loseReply = false;
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else await route.fulfill({ response });
    } finally {
      await response.dispose();
    }
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await observeOffice(page, 'retirement:' + test.task.name);
  await page.goto(office.origin());
  await requireOfficeReady(page);
});
afterEach(async () => {
  try {
    await office.assertNoRunningIntent();
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    if (page) await closeCoveredPage(page);
    if (context) await closeCoveredContext(context);
  }
});
afterAll(async () => {
  if (audit) await closeCoveredContext(audit);
  if (browser) await closeCoveredBrowser(browser);
  if (office) await office.close();
});

it('cancels actual retirement confirmation without posting or saving profile drafts', async () => {
  for (const width of [320, 1280]) {
    const dialog = await profile(width),
      confirmation = await confirm(dialog);
    expect(posts).toBe(0);
    await screenshot('retirement-confirm-' + width);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(posts).toBe(0);
    expect((await company()).employees.some((row) => row.id === employee().id)).toBe(true);
    expect((await disk()).employees.find((row) => row.id === employee().id)?.position).toBe('Synthetic reviewer');
    expect(await dialog.getByRole('button', { name: `Retire ${employee().name}`, exact: true }).isEnabled()).toBe(true);
    await dialog.getByRole('button', { name: `Close profile for ${employee().name}`, exact: true }).click();
  }
});

it('shows the actual reporting-line refusal and retains the employee and unsaved profile', async () => {
  await update(employees[1]!.id, { reportsTo: employee().id });
  const dialog = await profile(),
    confirmation = await confirm(dialog);
  await confirmation.getByRole('button', { name: 'Retire', exact: true }).click();
  const error = dialog.locator('.ca-company-lifecycle-error');
  await expect.poll(() => error.textContent()).toContain('Reassign reports before retiring their manager');
  await screenshot('retirement-reporting-refusal-320');
  await readableError(dialog, error);
  expect(posts).toBe(1);
  expect((await company()).employees.some((row) => row.id === employee().id)).toBe(true);
  expect((await disk()).retired.some((row) => row.id === employee().id)).toBe(false);
  await dialog.getByRole('tab', { name: 'Profile', exact: true }).click();
  expect(await dialog.getByLabel('Role title', { exact: true }).inputValue()).toBe('Unsaved retirement draft');
});

it('retires the actual stopped employee once and preserves their durable identity', async () => {
  const dialog = await profile(1280),
    confirmation = await confirm(dialog);
  await confirmation.getByRole('button', { name: 'Retire', exact: true }).click();
  await expect.poll(async () => (await company()).employees.some((row) => row.id === employee().id)).toBe(false);
  await expect.poll(() => dialog.isVisible()).toBe(false);
  expect(posts).toBe(1);
  const saved = await disk(),
    retired = saved.retired.filter((row) => row.id === employee().id);
  expect(retired).toHaveLength(1);
  expect(retired[0]).toMatchObject({
    id: employee().id,
    sessionId: employee().sessionId,
    name: employee().name,
    desiredRunning: false,
    position: 'Synthetic reviewer',
  });
  expect(saved.employees.some((row) => row.id === employee().id)).toBe(false);
  await screenshot('retirement-recorded-1280');
});

it('reports a lost committed retirement reply without automatically repeating the action', async () => {
  const dialog = await profile(),
    confirmation = await confirm(dialog);
  loseReply = true;
  await confirmation.getByRole('button', { name: 'Retire', exact: true }).click();
  const error = dialog.locator('.ca-company-lifecycle-error');
  await expect.poll(async () => (await error.textContent())?.trim()).toBeTruthy();
  expect(await error.isVisible()).toBe(true);
  expect(posts).toBe(1);
  expect((await company()).employees.some((row) => row.id === employee().id)).toBe(false);
  expect((await disk()).retired.filter((row) => row.id === employee().id)).toHaveLength(1);
  await screenshot('retirement-reply-lost-320');
  await readableError(dialog, error);
  await dialog.getByRole('button', { name: `Close profile for ${employee().name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { reverieChat: { openCompany(section: string): void } }).reverieChat.openCompany('people')
  );
  await expect
    .poll(() => page.getByRole('button', { name: `Edit profile for ${employee().name}`, exact: true }).count())
    .toBe(0);
  expect(posts).toBe(1);
});
