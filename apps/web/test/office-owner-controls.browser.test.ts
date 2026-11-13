/** Real GUI/API behavior. Synthetic employees stay OFF; no native/provider success is simulated. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createIsolatedOffice, type IsolatedOffice } from './helpers/isolated-office.js';
import type { ExpertSettings } from '../src/experts.js';
import {
  claimOwner,
  contextFor,
  signedIn,
  observeOffice,
  requireOfficeReady,
  paint,
  closeCoveredPage,
  closeCoveredContext,
  closeCoveredBrowser,
  type CompanyView,
} from './helpers/office-browser.js';

const artifacts = process.env.TEST_OWNER_CONTROLS_SCREENSHOT_DIR;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const username = 'fixture-owner',
  password = `Synthetic-${randomBytes(18).toString('hex')}`;
let office: IsolatedOffice, browser: Browser, context: BrowserContext, audit: BrowserContext, page: Page;
let ownerState: Awaited<ReturnType<BrowserContext['storageState']>>;
let employees: Awaited<ReturnType<IsolatedOffice['seedStoppedEmployees']>>;
let blocked: string[] = [],
  errors: string[] = [];
let responses: Array<{ method: string; path: string; status: number }> = [];

type Hiring = { employeeId: string; sessionId: string; enabled: boolean };
type ExpertView = { settings: ExpertSettings };
const hiringLimitsPath = '/api/experts-settings/hiring-limits';
async function api<T = CompanyView>(path = '/api/company', method = 'GET', data?: unknown): Promise<T> {
  const hiringRead = path === '/api/experts' && method === 'GET';
  const hiringWrite = path === hiringLimitsPath && method === 'PATCH';
  if (
    !hiringRead &&
    !hiringWrite &&
    !/^\/api\/(?:company(?:\/settings|\/employees\/[^/]+(?:\/hiring-permission)?)?|sessions)$/.test(path)
  )
    throw new Error('The no-worker audit client refuses this endpoint');
  if (
    !hiringWrite &&
    method !== 'GET' &&
    !/^\/api\/company\/(?:settings|employees\/[^/]+(?:\/hiring-permission)?)$/.test(path)
  )
    throw new Error('The no-worker audit client refuses this mutation');
  const response = await audit.request.fetch(office.origin() + path, {
    method,
    headers: { origin: office.origin() },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  const parsed = await response.json();
  return (parsed.success === true ? parsed.data : parsed) as T;
}
const current = async () => (await api()).employees.find((employee) => employee.id === employees[0].id)!;
const hiringPath = () => `/api/company/employees/${employees[0].id}/hiring-permission`;
const budget = async () => (await api<ExpertView>('/api/experts')).settings;
async function diskBudget(): Promise<ExpertSettings> {
  // Import only after createIsolatedOffice has established its owned data root.
  const [{ dataPath }, { ExpertStateSchema }] = await Promise.all([
    import('../src/config/instance.js'),
    import('../src/experts.js'),
  ]);
  return ExpertStateSchema.parse(JSON.parse(await readFile(dataPath('experts.json'), 'utf8'))).settings;
}
async function setBudget(maxHiresPerDay: number, maxActive: number) {
  const before = await budget();
  await api(hiringLimitsPath, 'PATCH', {
    expected: { maxHiresPerDay: before.maxHiresPerDay, maxActive: before.maxActive },
    limits: { maxHiresPerDay, maxActive },
  });
}
async function openCompany() {
  await page.evaluate(() =>
    (
      window as unknown as Window & { reverieChat: { openCompany(section: string): Promise<void> } }
    ).reverieChat.openCompany('people')
  );
}
async function settings(): Promise<Locator> {
  await openCompany();
  await page.getByRole('button', { name: 'Company settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Company settings', exact: true });
  await dialog.getByRole('tab', { name: 'Company', exact: true }).click();
  await dialog.getByLabel('Owner display name', { exact: true }).waitFor();
  return dialog;
}
async function profile(permissions = false): Promise<Locator> {
  await openCompany();
  await page.getByRole('button', { name: `Edit profile for ${employees[0].name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Edit profile: ${employees[0].name}`, exact: true });
  await dialog.getByLabel('Role title', { exact: true }).waitFor();
  if (permissions) await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  return dialog;
}
async function hiringSettings(): Promise<Locator> {
  const dialog = await settings();
  await dialog.getByRole('tab', { name: 'Hiring', exact: true }).click();
  const form = dialog.getByRole('form', { name: 'Hiring', exact: true });
  await expect
    .poll(() => form.getByRole('button', { name: 'Save hiring settings', exact: true }).isEnabled())
    .toBe(true);
  return form;
}
async function visibleError(locator: Locator) {
  await expect.poll(async () => (await locator.textContent())?.trim()).toBeTruthy();
  expect(await locator.isVisible()).toBe(true);
}
async function errorInViewport(locator: Locator) {
  await visibleError(locator);
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      const viewport = page.viewportSize()!;
      return (
        !!box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height
      );
    })
    .toBe(true);
}
async function capture(label: string, focus?: Locator) {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (focus) await focus.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      `${label} at ${width}px`
    ).toBe(false);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await paint(page);
      await page.screenshot({ path: join(artifacts, `${label}-${width}.png`) });
    }
  }
}

beforeAll(async () => {
  office = await createIsolatedOffice();
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const setup = await browser.newContext();
  const setupBlocked: string[] = [];
  await contextFor(setup, office.origin(), setupBlocked);
  const setupPage = await setup.newPage();
  await observeOffice(setupPage, 'office-owner-controls:setup');
  await claimOwner(setupPage, office.origin(), username, password);
  expect(setupBlocked).toEqual([]);
  await closeCoveredContext(setup);
  employees = await office.seedStoppedEmployees();
  audit = await browser.newContext();
  await contextFor(audit, office.origin(), setupBlocked);
  const login = await audit.newPage();
  await observeOffice(login, 'office-owner-controls:login');
  await signedIn(login, office.origin(), username, password);
  ownerState = await audit.storageState();
  await closeCoveredPage(login);
}, 60_000);

beforeEach(async (testContext) => {
  blocked = [];
  errors = [];
  responses = [];
  await api('/api/company/settings', 'PUT', { ownerName: 'Synthetic owner', ownerTitle: 'Owner', timeZone: 'UTC' });
  await setBudget(2, 5);
  // Reset only logical metadata in the owned OFF cohort; no session/action routes.
  for (const employee of [...employees].reverse())
    await api(`/api/company/employees/${employee.id}`, 'PUT', {
      position: 'Synthetic reviewer',
      expertise: ['Browser acceptance'],
      responsibilities: [],
      reportsTo: 'owner',
      sleepEnabled: false,
      dreamEnabled: false,
      permissions: { recoverEmployees: false },
    });
  const hiring = await api<Hiring>(hiringPath());
  if (hiring.enabled)
    await api(hiringPath(), 'PUT', { expectedSessionId: hiring.sessionId, expected: true, enabled: false });
  context = await browser.newContext({ storageState: ownerState, viewport: { width: 1280, height: 900 } });
  await contextFor(context, office.origin(), blocked);
  page = await context.newPage();
  await observeOffice(page, 'office-owner-controls:' + testContext.task.name);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) =>
    responses.push({
      method: response.request().method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
    })
  );
  await page.goto(office.origin());
  await requireOfficeReady(page);
  await page.waitForFunction(() => !!(window as Window & { reverieChat?: { built?: boolean } }).reverieChat?.built);
});
afterEach(async () => {
  try {
    if (context) await context.setOffline(false);
    expect(await api('/api/sessions')).toEqual([]);
    await office.assertNoRunningIntent();
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    if (context) await closeCoveredContext(context);
  }
});
afterAll(async () => {
  try {
    if (browser) await closeCoveredBrowser(browser);
  } finally {
    await office?.close();
  }
});

it('saves company hiring limits through the GUI without replacing a concurrent employee permission', async () => {
  const form = await hiringSettings();
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('3');
  await form.getByLabel('Active hires at most', { exact: true }).fill('7');
  let interleaved = false;
  await page.route('**/api/experts', async (route) => {
    if (interleaved) return route.continue();
    interleaved = true;
    const snapshot = await route.fetch();
    const before = await api<Hiring>(hiringPath());
    await api(hiringPath(), 'PUT', { expectedSessionId: before.sessionId, expected: false, enabled: true });
    await route.fulfill({ response: snapshot });
  });
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === hiringLimitsPath
  );
  await form.getByRole('button', { name: 'Save hiring settings', exact: true }).click();
  const reply = await saved;
  expect(reply.status()).toBe(200);
  expect(reply.request().postDataJSON()).toEqual({
    expected: { maxHiresPerDay: 2, maxActive: 5 },
    limits: { maxHiresPerDay: 3, maxActive: 7 },
  });
  await expect.poll(() => form.getByRole('status').textContent()).toBe('Hiring settings saved.');
  expect(interleaved).toBe(true);
  expect(await budget()).toMatchObject({ maxHiresPerDay: 3, maxActive: 7, hireEmployeeDelegates: [employees[0].id] });
  expect((await api<Hiring>(hiringPath())).enabled).toBe(true);
  expect(await diskBudget()).toEqual(await budget());
  await capture('hiring-budget-saved', form.getByRole('button', { name: 'Save hiring settings', exact: true }));
});

it('rejects invalid hiring limits before the GUI write and through the real API without mutation', async () => {
  const form = await hiringSettings();
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('21');
  await form.getByRole('button', { name: 'Save hiring settings', exact: true }).click();
  expect(
    await form
      .getByLabel('Hires in any 24 hours', { exact: true })
      .evaluate((input) => input instanceof HTMLInputElement && input.validity.rangeOverflow)
  ).toBe(true);
  expect(responses.filter((response) => response.method === 'PATCH' && response.path === hiringLimitsPath)).toEqual([]);
  const refused = await audit.request.patch(office.origin() + hiringLimitsPath, {
    headers: { origin: office.origin() },
    data: { expected: { maxHiresPerDay: 2, maxActive: 5 }, limits: { maxHiresPerDay: 21, maxActive: 7 } },
  });
  expect(refused.status()).toBe(400);
  expect(await budget()).toMatchObject({ maxHiresPerDay: 2, maxActive: 5 });
  expect(await diskBudget()).toEqual(await budget());
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('3');
  await form.getByRole('button', { name: 'Save hiring settings', exact: true }).click();
  await expect.poll(async () => (await budget()).maxHiresPerDay).toBe(3);
  expect((await budget()).maxActive).toBe(5);
});

it('refuses a hiring budget changed after the fresh read and requires review before the explicit retry', async () => {
  const form = await hiringSettings();
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('3');
  await form.getByLabel('Active hires at most', { exact: true }).fill('7');
  let interleaved = false;
  await page.route('**/api/experts', async (route) => {
    if (interleaved) return route.continue();
    interleaved = true;
    const snapshot = await route.fetch();
    await setBudget(4, 9);
    await route.fulfill({ response: snapshot });
  });
  const refused = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === hiringLimitsPath
  );
  const save = form.getByRole('button', { name: 'Save hiring settings', exact: true });
  await save.click();
  expect((await refused).status()).toBe(409);
  const error = form.getByRole('alert');
  await expect.poll(() => error.textContent()).toContain('Hiring limits changed; refresh before saving');
  await visibleError(error);
  expect(await error.textContent()).not.toContain('may already have saved');
  expect(await budget()).toMatchObject({ maxHiresPerDay: 4, maxActive: 9 });
  expect(await diskBudget()).toEqual(await budget());
  expect(await form.getByLabel('Active hires at most', { exact: true }).inputValue()).toBe('7');
  await capture('hiring-budget-conflict', error);
  await save.click();
  await expect.poll(() => error.textContent()).toContain('changed elsewhere since this page loaded');
  expect(await form.getByLabel('Hires in any 24 hours', { exact: true }).inputValue()).toBe('4');
  expect(await form.getByLabel('Active hires at most', { exact: true }).inputValue()).toBe('9');
  expect(
    responses.filter((response) => response.method === 'PATCH' && response.path === hiringLimitsPath)
  ).toHaveLength(1);
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('3');
  await form.getByLabel('Active hires at most', { exact: true }).fill('7');
  await save.click();
  await expect.poll(() => form.getByRole('status').textContent()).toBe('Hiring settings saved.');
  expect(await budget()).toMatchObject({ maxHiresPerDay: 3, maxActive: 7 });
  expect(await diskBudget()).toEqual(await budget());
  expect(
    responses
      .filter((response) => response.method === 'PATCH' && response.path === hiringLimitsPath)
      .map((response) => response.status)
  ).toEqual([409, 200]);
});

it('does not change hiring limits after owner browser authority is lost', async () => {
  const form = await hiringSettings();
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('3');
  await form.getByLabel('Active hires at most', { exact: true }).fill('7');
  await context.clearCookies();
  await form.getByRole('button', { name: 'Save hiring settings', exact: true }).click();
  await page.waitForURL('**/owner/login**');
  expect(responses.some((response) => response.path === '/api/experts' && response.status === 401)).toBe(true);
  expect(responses.filter((response) => response.method === 'PATCH' && response.path === hiringLimitsPath)).toEqual([]);
  expect(await budget()).toMatchObject({ maxHiresPerDay: 2, maxActive: 5 });
  expect(await diskBudget()).toEqual(await budget());
});

it('keeps a committed hiring budget unconfirmed after a lost reply and reads it on reopening without replay', async () => {
  const form = await hiringSettings();
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('3');
  await form.getByLabel('Active hires at most', { exact: true }).fill('7');
  let patches = 0;
  await page.route('**/api/experts-settings/hiring-limits', async (route) => {
    patches++;
    const actual = await route.fetch();
    expect(actual.status()).toBe(200);
    expect(await budget()).toMatchObject({ maxHiresPerDay: 3, maxActive: 7 });
    await route.abort('failed');
  });
  await form.getByRole('button', { name: 'Save hiring settings', exact: true }).click();
  const error = form.getByRole('alert');
  await visibleError(error);
  expect(await error.textContent()).toContain('It may already have saved.');
  expect(await error.textContent()).toContain('Reopen settings to check the saved values before trying again.');
  expect(await form.getByRole('status').textContent()).not.toContain('saved');
  expect(await form.getByLabel('Hires in any 24 hours', { exact: true }).inputValue()).toBe('3');
  expect(await form.getByLabel('Active hires at most', { exact: true }).inputValue()).toBe('7');
  expect(await budget()).toMatchObject({ maxHiresPerDay: 3, maxActive: 7 });
  expect(await diskBudget()).toEqual(await budget());
  expect(patches).toBe(1);
  await capture('hiring-budget-committed-unconfirmed', error);
  await page
    .getByRole('dialog', { name: 'Company settings', exact: true })
    .getByRole('button', { name: 'Close company settings', exact: true })
    .click();
  const reopened = await hiringSettings();
  expect(await reopened.getByLabel('Hires in any 24 hours', { exact: true }).inputValue()).toBe('3');
  expect(await reopened.getByLabel('Active hires at most', { exact: true }).inputValue()).toBe('7');
  expect(patches).toBe(1);
});

it('keeps a committed hiring budget unconfirmed after a server failure response without retrying', async () => {
  const form = await hiringSettings();
  await form.getByLabel('Hires in any 24 hours', { exact: true }).fill('4');
  await form.getByLabel('Active hires at most', { exact: true }).fill('8');
  let patches = 0;
  // The real route commits; this controlled response fault models a later server failure.
  await page.route('**/api/experts-settings/hiring-limits', async (route) => {
    patches++;
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(200);
    expect(await diskBudget()).toMatchObject({ maxHiresPerDay: 4, maxActive: 8 });
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Response unavailable after publication' }),
    });
  });
  await form.getByRole('button', { name: 'Save hiring settings', exact: true }).click();
  const error = form.getByRole('alert');
  await expect.poll(() => error.textContent()).toContain('It may already have saved.');
  await visibleError(error);
  expect(await error.textContent()).toContain('Reopen settings to check the saved values before trying again.');
  expect(await form.getByRole('status').textContent()).not.toContain('saved');
  expect(await form.getByLabel('Active hires at most', { exact: true }).inputValue()).toBe('8');
  expect(await diskBudget()).toEqual(await budget());
  expect(patches).toBe(1);
  await capture('hiring-budget-server-error-unconfirmed', error);
  await page.getByRole('button', { name: 'Close company settings', exact: true }).click();
  const reopened = await hiringSettings();
  expect(await reopened.getByLabel('Active hires at most', { exact: true }).inputValue()).toBe('8');
  expect(patches).toBe(1);
});

it('clears the saved recovery expert through Automatic without overwriting a newer unrelated setting', async () => {
  await api('/api/company/settings', 'PUT', { autoWakeEnabled: true, crashWakeEmployeeId: employees[0].id });
  const dialog = await settings();
  await dialog.getByRole('tab', { name: 'Employees', exact: true }).click();
  expect(await dialog.getByLabel('Wake after a crash', { exact: true }).inputValue()).toBe(employees[0].id);
  expect(
    await dialog.getByLabel('Wake after a crash', { exact: true }).locator('option:checked').textContent()
  ).toContain('(unavailable)');
  await api('/api/company/settings', 'PUT', { timeZone: 'Europe/London' });
  await dialog.getByLabel('Wake after a crash', { exact: true }).selectOption('');
  await dialog.getByLabel('Automatic recovery', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save recovery', exact: true }).click();
  await expect.poll(() => dialog.locator(':scope > [role="status"]').textContent()).toBe('Recovery settings saved.');
  const saved = (await api()).settings;
  expect({ timeZone: saved.timeZone, expert: saved.crashWakeEmployeeId, automatic: saved.autoWakeEnabled }).toEqual({
    timeZone: 'Europe/London',
    expert: undefined,
    automatic: false,
  });
  await capture('recovery-automatic-saved', dialog.getByRole('button', { name: 'Save recovery', exact: true }));
  await dialog.getByRole('button', { name: 'Close company settings', exact: true }).click();
  const reopened = await settings();
  await reopened.getByRole('tab', { name: 'Employees', exact: true }).click();
  expect(await reopened.getByLabel('Wake after a crash', { exact: true }).inputValue()).toBe('');
  expect(await reopened.getByLabel('Automatic recovery', { exact: true }).isChecked()).toBe(false);
});

it('reports a disconnected recovery save without writing and confirms one explicit online retry', async () => {
  await api('/api/company/settings', 'PUT', { autoWakeEnabled: true, crashWakeEmployeeId: employees[0].id });
  const dialog = await settings();
  await dialog.getByRole('tab', { name: 'Employees', exact: true }).click();
  const expert = dialog.getByLabel('Wake after a crash', { exact: true });
  const automatic = dialog.getByLabel('Automatic recovery', { exact: true });
  const save = dialog.getByRole('button', { name: 'Save recovery', exact: true });
  await expert.selectOption('');
  await automatic.uncheck();
  await context.setOffline(true);
  const error = dialog.locator('.ca-company-recovery [role="alert"]');
  try {
    await save.click();
    await visibleError(error);
    expect((await api()).settings).toMatchObject({ autoWakeEnabled: true, crashWakeEmployeeId: employees[0].id });
    expect(await automatic.isChecked()).toBe(false);
    expect(await expert.inputValue()).toBe('');
    expect(await save.isEnabled()).toBe(true);
    await capture('recovery-save-disconnected', error);
  } finally {
    await context.setOffline(false);
  }
  await save.click();
  await expect
    .poll(async () => {
      const saved = (await api()).settings;
      return { automatic: saved.autoWakeEnabled, expert: saved.crashWakeEmployeeId };
    })
    .toEqual({ automatic: false, expert: undefined });
  expect(
    responses.filter(
      (response) => response.method === 'PUT' && response.path === '/api/company/settings' && response.status === 200
    )
  ).toHaveLength(1);
  await capture('recovery-save-retried', save);
});

it('refuses the recovery save after owner authority is lost without changing stored recovery', async () => {
  await api('/api/company/settings', 'PUT', { autoWakeEnabled: true, crashWakeEmployeeId: employees[0].id });
  const dialog = await settings();
  await dialog.getByRole('tab', { name: 'Employees', exact: true }).click();
  await dialog.getByLabel('Automatic recovery', { exact: true }).uncheck();
  await context.clearCookies();
  const refused = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/company/settings'
  );
  await dialog.getByRole('button', { name: 'Save recovery', exact: true }).click();
  expect((await refused).status()).toBe(401);
  expect((await api()).settings).toMatchObject({ autoWakeEnabled: true, crashWakeEmployeeId: employees[0].id });
  await page.waitForURL('**/owner/login**');
  expect(await page.getByRole('button', { name: 'Sign in', exact: true }).isVisible()).toBe(true);
});

it('discards unsaved owner edits when the company dialog closes', async () => {
  const dialog = await settings();
  await dialog.getByLabel('Owner display name', { exact: true }).fill('Unsaved owner');
  await dialog.getByRole('button', { name: 'Close company settings', exact: true }).click();
  expect((await api()).settings.ownerName).toBe('Synthetic owner');
  const reopened = await settings();
  expect(await reopened.getByLabel('Owner display name', { exact: true }).inputValue()).toBe('Synthetic owner');
});

it('persists owner details while preserving an edit committed between its fresh GET and PUT', async () => {
  await api('/api/company/settings', 'PUT', { timeZone: 'Europe/London' });
  const dialog = await settings();
  await dialog.getByLabel('Owner display name', { exact: true }).fill('  Updated owner  ');
  await dialog.getByLabel('Owner title', { exact: true }).fill('  Director  ');
  await api('/api/company/settings', 'PUT', { timeZone: 'UTC' });
  let interleaved = false;
  await page.route('**/api/company', async (route) => {
    if (route.request().method() !== 'GET' || interleaved) return route.continue();
    interleaved = true;
    const snapshot = await route.fetch();
    await api('/api/company/settings', 'PUT', { timeZone: 'Europe/London' });
    await route.fulfill({ response: snapshot });
  });
  await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
  await expect.poll(async () => (await api()).settings.ownerName).toBe('Updated owner');
  expect(interleaved).toBe(true);
  expect((await api()).settings).toMatchObject({
    ownerName: 'Updated owner',
    ownerTitle: 'Director',
    timeZone: 'Europe/London',
  });
  await expect.poll(() => dialog.locator(':scope > [role="status"]').textContent()).toBe('Owner details saved.');
  await capture(
    'owner-details-concurrent-saved',
    dialog.getByRole('button', { name: 'Save owner details', exact: true })
  );
});

it('reports an unconfirmed committed owner save without replay and recovers by reopening settings', async () => {
  const dialog = await settings();
  await dialog.getByLabel('Owner display name', { exact: true }).fill('Committed but unconfirmed');
  let puts = 0;
  await page.route('**/api/company/settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts++;
    const upstream = await route.fetch();
    expect(upstream.ok()).toBe(true);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    });
  });
  await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
  const error = dialog.locator(':scope > [role="alert"]');
  await expect.poll(() => error.textContent()).toContain('not confirmed');
  expect(await error.textContent()).toContain('It may already have saved.');
  expect(await error.isVisible()).toBe(true);
  expect(await dialog.locator(':scope > [role="status"]').textContent()).not.toContain('saved');
  expect((await api()).settings.ownerName).toBe('Committed but unconfirmed');
  expect(puts).toBe(1);
  await capture('owner-details-unconfirmed-committed', error);
  await dialog.getByRole('button', { name: 'Close company settings', exact: true }).click();
  const reopened = await settings();
  expect(await reopened.getByLabel('Owner display name', { exact: true }).inputValue()).toBe(
    'Committed but unconfirmed'
  );
  expect(puts).toBe(1);
});

it.each([320, 390])(
  'shows an uncertain owner save in the viewport at %ipx without scrolling to the error',
  async (width) => {
    await page.setViewportSize({ width, height: 640 });
    const dialog = await settings();
    await dialog.getByLabel('Owner display name', { exact: true }).fill('Phone save outcome');
    let puts = 0;
    await page.route('**/api/company/settings', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      puts++;
      const upstream = await route.fetch();
      expect(upstream.ok()).toBe(true);
      await route.abort('failed');
    });
    await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
    const error = dialog.locator(':scope > [role="alert"]');
    await errorInViewport(error);
    expect(await error.textContent()).toContain('It may already have saved.');
    expect((await api()).settings.ownerName).toBe('Phone save outcome');
    expect(puts).toBe(1);
    if (artifacts) await page.screenshot({ path: join(artifacts, `owner-save-outcome-phone-${width}.png`) });
  }
);

it.each([320, 390])(
  'shows an uncertain hiring save in the viewport at %ipx without scrolling to the error',
  async (width) => {
    await page.setViewportSize({ width, height: 640 });
    const form = await hiringSettings();
    await form.getByLabel('Active hires at most', { exact: true }).fill('7');
    let patches = 0;
    await page.route('**/api/experts-settings/hiring-limits', async (route) => {
      patches++;
      const upstream = await route.fetch();
      expect(upstream.ok()).toBe(true);
      await route.abort('failed');
    });
    await form.getByRole('button', { name: 'Save hiring settings', exact: true }).click();
    const error = form.getByRole('alert');
    await errorInViewport(error);
    expect(await error.textContent()).toContain('It may already have saved.');
    expect(await budget()).toMatchObject({ maxActive: 7 });
    expect(patches).toBe(1);
    if (artifacts) await page.screenshot({ path: join(artifacts, `hiring-save-outcome-phone-${width}.png`) });
  }
);

it('shows invalid time zone validation without writing and saves a valid retry', async () => {
  const dialog = await settings();
  await dialog.getByLabel('Company time zone', { exact: true }).fill('Not/A-Time-Zone');
  await dialog.getByRole('button', { name: 'Save time zone', exact: true }).click();
  const error = dialog.locator(':scope > [role="alert"]');
  await visibleError(error);
  expect((await api()).settings.timeZone).toBe('UTC');
  expect(
    responses.filter((response) => response.method === 'PUT' && response.path === '/api/company/settings')
  ).toEqual([]);
  await capture('invalid-time-zone', error);
  await dialog.getByLabel('Company time zone', { exact: true }).fill('Europe/London');
  await dialog.getByRole('button', { name: 'Save time zone', exact: true }).click();
  await expect.poll(async () => (await api()).settings.timeZone).toBe('Europe/London');
  await capture('valid-time-zone-retry', dialog.getByRole('button', { name: 'Save time zone', exact: true }));
});

it('reports a real disconnected save without writing and commits exactly one online retry', async () => {
  const dialog = await settings();
  await dialog.getByLabel('Owner display name', { exact: true }).fill('Retried owner');
  await context.setOffline(true);
  try {
    await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
    await visibleError(dialog.locator(':scope > [role="alert"]'));
    expect(await dialog.locator(':scope > [role="alert"]').textContent()).toContain('No save request was sent.');
    expect(await dialog.locator(':scope > [role="alert"]').textContent()).not.toContain('may already have saved');
    expect((await api()).settings.ownerName).toBe('Synthetic owner');
    expect(await dialog.getByRole('button', { name: 'Save owner details', exact: true }).isEnabled()).toBe(true);
    await capture('disconnected-owner-save', dialog.locator(':scope > [role="alert"]'));
  } finally {
    await context.setOffline(false);
  }
  const acknowledged = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/company/settings' && response.request().method() === 'PUT'
  );
  await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
  // A canonical read can observe the commit before this page receives its response.
  // Join the actual original acknowledgement before counting delivered replies.
  expect((await acknowledged).status()).toBe(200);
  await expect.poll(async () => (await api()).settings.ownerName).toBe('Retried owner');
  expect(
    responses.filter(
      (response) => response.method === 'PUT' && response.path === '/api/company/settings' && response.status === 200
    )
  ).toHaveLength(1);
});

it('requires owner sign-in after browser authority is lost and does not save stale edits', async () => {
  const dialog = await settings();
  await dialog.getByLabel('Owner display name', { exact: true }).fill('Unauthorized edit');
  await context.clearCookies();
  await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
  await page.waitForURL('**/owner/login**');
  expect(await page.getByRole('button', { name: 'Sign in', exact: true }).isVisible()).toBe(true);
  expect(responses.some((response) => response.path === '/api/company' && response.status === 401)).toBe(true);
  expect((await api()).settings.ownerName).toBe('Synthetic owner');
  await capture('owner-authority-lost');
});

it('cancels employee profile edits without changing persisted role or skills', async () => {
  const dialog = await profile();
  await dialog.getByLabel('Role title', { exact: true }).fill('Unsaved role');
  await dialog.getByLabel('Skills and expertise', { exact: true }).fill('Unsaved skill');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await current()).toMatchObject({ position: 'Synthetic reviewer', expertise: ['Browser acceptance'] });
  const reopened = await profile();
  expect(await reopened.getByLabel('Role title', { exact: true }).inputValue()).toBe('Synthetic reviewer');
});

it('closes unsaved employee profile edits through the header without changing canonical fields', async () => {
  const before = await current();
  const dialog = await profile();
  const role = await dialog.getByLabel('Role title', { exact: true }).inputValue();
  const skills = await dialog.getByLabel('Skills and expertise', { exact: true }).inputValue();
  await dialog.getByLabel('Role title', { exact: true }).fill('Unsaved header-close role');
  await dialog.getByLabel('Skills and expertise', { exact: true }).fill('Unsaved header-close skills');
  const close = dialog.getByRole('button', { name: 'Close profile for ' + employees[0].name, exact: true });
  await capture('employee-profile-header-close', close);
  await close.click();
  await expect.poll(() => dialog.isVisible()).toBe(false);
  expect(await current()).toMatchObject({
    position: before.position,
    expertise: before.expertise,
    desiredRunning: false,
    onVacation: true,
  });
  const employeePath = '/api/company/employees/' + employees[0].id;
  expect(responses.filter((response) => response.method === 'PUT' && response.path === employeePath)).toEqual([]);
  const reopened = await profile();
  expect(await reopened.getByLabel('Role title', { exact: true }).inputValue()).toBe(role);
  expect(await reopened.getByLabel('Skills and expertise', { exact: true }).inputValue()).toBe(skills);
});

it('saves employee profile fields through the real API while preserving OFF intent', async () => {
  const dialog = await profile();
  await dialog.getByLabel('Role title', { exact: true }).fill('  Review engineer  ');
  await dialog.getByLabel('Skills and expertise', { exact: true }).fill('TypeScript, Rust');
  await dialog
    .getByLabel('Responsibilities (one per line)', { exact: true })
    .fill('Review changes\nWrite acceptance checks');
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(() => dialog.isVisible()).toBe(false);
  expect(await current()).toMatchObject({
    position: 'Review engineer',
    expertise: ['TypeScript', 'Rust'],
    responsibilities: ['Review changes', 'Write acceptance checks'],
    desiredRunning: false,
    onVacation: true,
  });
});

it('shows the real excessive-skills refusal and preserves edits for a corrected retry', async () => {
  const dialog = await profile();
  await dialog
    .getByLabel('Skills and expertise', { exact: true })
    .fill(Array.from({ length: 21 }, (_, index) => `Skill ${index}`).join(', '));
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/company/employees/${employees[0].id}` &&
      response.request().method() === 'PUT'
  );
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
  expect((await rejected).status()).toBe(400);
  await visibleError(dialog.locator('.ca-profile-save-error'));
  expect((await current()).expertise).toEqual(['Browser acceptance']);
  expect(await dialog.getByRole('button', { name: 'Save profile', exact: true }).isEnabled()).toBe(true);
  await capture('excessive-skills-refused', dialog.locator('.ca-profile-save-error'));
  await dialog.getByLabel('Skills and expertise', { exact: true }).fill('Corrected skill');
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(() => dialog.isVisible()).toBe(false);
  expect((await current()).expertise).toEqual(['Corrected skill']);
});

it('refuses a concurrent reporting cycle without partial mutation and accepts a safe retry', async () => {
  const dialog = await profile();
  await expect.poll(() => dialog.getByLabel('Reports to', { exact: true }).isEnabled()).toBe(true);
  await api(`/api/company/employees/${employees[1].id}`, 'PUT', { reportsTo: employees[0].id });
  await dialog.getByLabel('Reports to', { exact: true }).selectOption(employees[1].id);
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
  await visibleError(dialog.locator('.ca-profile-save-error'));
  expect((await current()).reportsTo).toBe('owner');
  await capture('reporting-cycle-refused', dialog.locator('.ca-profile-save-error'));
  await dialog.getByLabel('Reports to', { exact: true }).selectOption('owner');
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(() => dialog.isVisible()).toBe(false);
  expect((await current()).reportsTo).toBe('owner');
});

it('keeps an immediately saved recovery permission when Cancel closes the profile', async () => {
  const dialog = await profile(true);
  const permission = dialog.getByLabel(`Recovery permission for ${employees[0].name}`, { exact: true });
  await permission.check();
  await expect.poll(async () => (await current()).permissions.recoverEmployees).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await current()).permissions.recoverEmployees).toBe(true);
  const reopened = await profile(true);
  expect(await reopened.getByLabel(`Recovery permission for ${employees[0].name}`, { exact: true }).isChecked()).toBe(
    true
  );
});

it('recovers an incomplete initial permission response through a visible read-only refresh without losing profile drafts', async () => {
  await page.setViewportSize({ width: 320, height: 640 });
  const before = await current();
  let incomplete = 0;
  await page.route('**/api/company', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const body = await response.json();
    const employee = body.data.employees.find((value: { id: string }) => value.id === employees[0].id);
    expect(employee).toBeDefined();
    employee.permissions = null; // Corrupt only the browser's otherwise genuine API reply.
    incomplete++;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  const dialog = await profile();
  const draft = dialog.getByLabel('Role title', { exact: true });
  await draft.fill('Unsubmitted permission recovery draft');
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  const permission = dialog.getByLabel(`Recovery permission for ${employees[0].name}`, { exact: true });
  const error = dialog.locator('.ca-profile-permission-error');
  await expect.poll(() => error.textContent()).toContain('Current permissions could not be confirmed');
  expect(incomplete).toBeGreaterThan(0);
  await errorInViewport(error);
  expect(await permission.isDisabled()).toBe(true);
  expect(await permission.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(true);
  expect(
    await dialog.getByRole('button', { name: `Restart session for ${employees[0].name}`, exact: true }).count()
  ).toBe(1);
  const refresh = dialog.getByRole('button', { name: `Refresh permissions for ${employees[0].name}`, exact: true });
  expect(await refresh.isEnabled()).toBe(true);
  await capture('permission-initial-unconfirmed', error);
  await page.unroute('**/api/company');
  const readback = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/company/employees/${employees[0].id}/permissions` &&
      response.request().method() === 'GET'
  );
  await refresh.click();
  expect((await readback).ok()).toBe(true);
  await expect.poll(() => permission.isEnabled()).toBe(true);
  expect(await permission.isChecked()).toBe(before.permissions.recoverEmployees);
  expect(await permission.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(false);
  await dialog.getByRole('tab', { name: 'Profile', exact: true }).click();
  expect(await draft.inputValue()).toBe('Unsubmitted permission recovery draft');
  const after = await current();
  expect(after.permissions).toEqual(before.permissions);
  expect(after.position).toBe(before.position);
  expect(responses.filter((response) => response.method === 'PUT' && response.path.startsWith('/api/company'))).toEqual(
    []
  );
});

it('keeps a committed permission save unconfirmed after a lost reply and refreshes without replay', async () => {
  await page.setViewportSize({ width: 320, height: 640 });
  const dialog = await profile(true);
  const permission = dialog.getByLabel(`Recovery permission for ${employees[0].name}`, { exact: true });
  const path = `/api/company/employees/${employees[0].id}`;
  let puts = 0;
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts++;
    const actual = await route.fetch();
    expect(actual.ok()).toBe(true);
    if (puts === 1) await route.abort('failed');
    else await route.fulfill({ response: actual });
  });
  await permission.check();
  await expect.poll(async () => (await current()).permissions.recoverEmployees).toBe(true);
  const error = dialog.locator('.ca-profile-permission-error');
  await expect.poll(() => error.textContent()).toContain('Could not save');
  expect(await permission.isDisabled()).toBe(true);
  expect(await permission.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(true);
  expect(puts).toBe(1);
  await errorInViewport(error);
  expect(await error.textContent()).toContain('may already have saved');
  await capture('permission-save-unconfirmed', error);
  await dialog.getByRole('button', { name: `Refresh permissions for ${employees[0].name}`, exact: true }).click();
  await expect.poll(() => permission.isEnabled()).toBe(true);
  expect(await permission.isChecked()).toBe(true);
  expect(await permission.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(false);
  expect(puts).toBe(1);
  await permission.uncheck();
  await expect.poll(async () => (await current()).permissions.recoverEmployees).toBe(false);
  expect(puts).toBe(2);
  await capture('permission-save-reconciled', dialog.locator('.ca-profile-permissions'));
});

it('keeps a disconnected permission save on hold until an explicit read-only refresh', async () => {
  const dialog = await profile(true);
  const permission = dialog.getByLabel(`Recovery permission for ${employees[0].name}`, { exact: true });
  await context.setOffline(true);
  await permission.check();
  const error = dialog.locator('.ca-profile-permission-error');
  await errorInViewport(error);
  expect(await permission.isDisabled()).toBe(true);
  expect(await permission.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(true);
  expect((await current()).permissions.recoverEmployees).toBe(false);
  await context.setOffline(false);
  expect(await permission.isDisabled()).toBe(true);
  await dialog.getByRole('button', { name: `Refresh permissions for ${employees[0].name}`, exact: true }).click();
  await expect.poll(() => permission.isEnabled()).toBe(true);
  expect(await permission.isChecked()).toBe(false);
  expect(await error.textContent()).toBe('');
  expect(
    responses.filter(
      (response) => response.method === 'PUT' && response.path === `/api/company/employees/${employees[0].id}`
    )
  ).toEqual([]);
  expect((await current()).permissions.recoverEmployees).toBe(false);
  await capture('permission-disconnected-readback', dialog.locator('.ca-profile-permissions'));
});

it('does not treat a malformed permission acknowledgement as a confirmed grant', async () => {
  const dialog = await profile(true);
  const permission = dialog.getByLabel(`Recovery permission for ${employees[0].name}`, { exact: true });
  const path = `/api/company/employees/${employees[0].id}`;
  let puts = 0;
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts++;
    const actual = await route.fetch();
    expect(actual.ok()).toBe(true);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    });
  });
  await permission.check();
  const error = dialog.locator('.ca-profile-permission-error');
  await errorInViewport(error);
  expect(await permission.isDisabled()).toBe(true);
  expect(await permission.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(true);
  expect((await current()).permissions.recoverEmployees).toBe(true);
  expect(puts).toBe(1);
  await dialog.getByRole('button', { name: `Refresh permissions for ${employees[0].name}`, exact: true }).click();
  await expect.poll(() => permission.isEnabled()).toBe(true);
  expect(await permission.isChecked()).toBe(true);
  expect(puts).toBe(1);
});

it('keeps derived board access unconfirmed with its lost manager permission save', async () => {
  const path = `/api/company/employees/${employees[0].id}`;
  await api(path, 'PUT', { permissions: { manageBoard: false, editBoardIssues: false } });
  const dialog = await profile(true);
  const manager = dialog.getByLabel(`Manage company board for ${employees[0].name}`, { exact: true });
  const ownWork = dialog.getByLabel(`Update own board work for ${employees[0].name}`, { exact: true });
  expect(await ownWork.isChecked()).toBe(false);
  let puts = 0;
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts++;
    const actual = await route.fetch();
    expect(actual.ok()).toBe(true);
    if (puts === 1) await route.abort('failed');
    else await route.fulfill({ response: actual });
  });
  await manager.check();
  const error = dialog.locator('.ca-profile-permission-error');
  await errorInViewport(error);
  expect(await current()).toMatchObject({
    permissions: { manageBoard: true, editBoardIssues: false },
    effectiveBoardPermissions: { manageBoard: true, editBoardIssues: true },
    boardPermissionSources: { editBoardIssues: 'included' },
  });
  expect(await manager.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(true);
  expect(await ownWork.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(true);
  expect(await ownWork.isDisabled()).toBe(true);
  expect(await ownWork.locator('..').textContent()).toContain('Current permission unconfirmed.');
  expect(puts).toBe(1);
  await capture('board-permission-derived-unconfirmed', error);
  await dialog.getByRole('button', { name: `Refresh permissions for ${employees[0].name}`, exact: true }).click();
  await expect.poll(() => manager.isEnabled()).toBe(true);
  expect(await manager.isChecked()).toBe(true);
  expect(await ownWork.isChecked()).toBe(true);
  expect(await ownWork.isDisabled()).toBe(true);
  expect(await ownWork.evaluate((element) => Reflect.get(element, 'indeterminate') === true)).toBe(false);
  expect(await ownWork.locator('..').textContent()).toContain('Included with Manage company board.');
  expect(puts).toBe(1);
  await manager.uncheck();
  await expect.poll(() => ownWork.isEnabled()).toBe(true);
  expect(await ownWork.isChecked()).toBe(false);
  expect(puts).toBe(2);
});

it('reports a real hiring permission conflict and recovers by refreshing the current value', async () => {
  const dialog = await profile(true);
  const permission = dialog.getByLabel(`Hiring permission for ${employees[0].name}`, { exact: true });
  await expect.poll(() => permission.isEnabled()).toBe(true);
  const baseline = await api<Hiring>(hiringPath());
  await api(hiringPath(), 'PUT', { expectedSessionId: baseline.sessionId, expected: baseline.enabled, enabled: true });
  const conflict = page.waitForResponse(
    (response) => new URL(response.url()).pathname === hiringPath() && response.request().method() === 'PUT'
  );
  await permission.check();
  expect((await conflict).status()).toBe(409);
  const error = dialog.locator('.ca-profile-hiring [role="alert"]');
  await visibleError(error);
  expect(await permission.isDisabled()).toBe(true);
  expect((await api<Hiring>(hiringPath())).enabled).toBe(true);
  await capture('hiring-permission-conflict', error);
  await dialog.getByRole('button', { name: `Refresh hiring permission for ${employees[0].name}`, exact: true }).click();
  await expect.poll(() => permission.isEnabled()).toBe(true);
  expect(await permission.isChecked()).toBe(true);
  await permission.uncheck();
  await expect.poll(async () => (await api<Hiring>(hiringPath())).enabled).toBe(false);
  await capture('hiring-permission-recovered', dialog.locator('.ca-profile-hiring'));
});

it('shows genuine API recovery availability for a stopped employee without starting any session', async () => {
  const dialog = await profile(true);
  const panel = dialog.getByRole('region', { name: `Session recovery for ${employees[0].name}`, exact: true });
  const refresh = panel.getByRole('button', { name: `Refresh recovery status for ${employees[0].name}`, exact: true });
  await expect.poll(() => refresh.isEnabled()).toBe(true);
  expect(await panel.textContent()).toContain('The original session binding could not be verified.');
  expect(await panel.getByRole('button').count()).toBe(1);
  const draft = dialog.getByLabel('Role title', { exact: true });
  await dialog.getByRole('tab', { name: 'Profile', exact: true }).click();
  await draft.fill('Unsaved recovery test draft');
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await refresh.click();
  await expect.poll(() => refresh.isEnabled()).toBe(true);
  expect(await draft.inputValue()).toBe('Unsaved recovery test draft');
  const recoveryReads = responses.filter((r) => r.path.endsWith('/recovery-selection'));
  expect(recoveryReads.length).toBeGreaterThanOrEqual(2);
  expect(recoveryReads.every((r) => r.method === 'GET' && r.status === 200)).toBe(true);
  expect(responses.filter((r) => /\/recovery(?:\/observe)?$/.test(r.path))).toEqual([]);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 800 });
    await panel.scrollIntoViewIfNeeded();
    await paint(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await dialog.getByRole('button', { name: `Close profile for ${employees[0].name}`, exact: true }).isVisible()
    ).toBe(true);
    expect(await refresh.isVisible()).toBe(true);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `session-recovery-unavailable-${width}.png`) });
    }
  }
});

it('recovers a lost genuine recovery-selection reply through a read-only refresh while keeping the profile draft', async () => {
  await page.setViewportSize({ width: 320, height: 640 });
  const endpoint = `/api/company/employees/${employees[0].id}/recovery-selection`;
  let actualReads = 0;
  await page.route('**' + endpoint, async (route) => {
    const actual = await route.fetch();
    expect(actual.status()).toBe(200);
    actualReads++;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Synthetic recovery status reply unavailable' }),
    });
  });
  const dialog = await profile(true);
  const panel = dialog.getByRole('region', { name: `Session recovery for ${employees[0].name}`, exact: true });
  const error = panel.getByRole('alert');
  await errorInViewport(error);
  expect(await error.textContent()).toContain('Refresh recovery status');
  expect(actualReads).toBe(1);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 800 });
    await error.scrollIntoViewIfNeeded();
    await paint(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `session-recovery-read-unconfirmed-${width}.png`) });
    }
  }
  await dialog.getByRole('tab', { name: 'Profile', exact: true }).click();
  const draft = dialog.getByLabel('Role title', { exact: true });
  await draft.fill('Draft retained after lost recovery reply');
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await page.unroute('**' + endpoint);
  const refresh = panel.getByRole('button', { name: `Refresh recovery status for ${employees[0].name}`, exact: true });
  await refresh.click();
  await expect.poll(async () => (await error.textContent())?.trim()).toBe('');
  expect(await draft.inputValue()).toBe('Draft retained after lost recovery reply');
  expect(await panel.getByRole('button').count()).toBe(1);
  expect(
    responses.filter(
      (r) => r.method === 'POST' && r.path.startsWith(`/api/company/employees/${employees[0].id}/recovery`)
    )
  ).toEqual([]);
});

it('keeps the profile draft on a genuine request-authentication refusal and restores the authorized recovery read', async () => {
  const dialog = await profile();
  const draft = dialog.getByLabel('Role title', { exact: true });
  await draft.fill('Draft retained during recovery authentication refusal');
  const endpoint = `/api/company/employees/${employees[0].id}/recovery-selection`;
  let unauthenticatedReads = 0;
  await page.route('**' + endpoint, async (route) => {
    // Exercise the real enforcing owner middleware for this request, while
    // retaining the page's real owner cookie for unrelated background reads.
    const actual = await route.fetch({ headers: { ...route.request().headers(), cookie: '' } });
    expect(actual.status()).toBe(401);
    const body = await actual.json();
    expect(body.errorCode).toBe('UNAUTHORIZED');
    unauthenticatedReads++;
    await route.fulfill({ status: actual.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  const panel = dialog.getByRole('region', { name: `Session recovery for ${employees[0].name}`, exact: true });
  const refresh = panel.getByRole('button', { name: `Refresh recovery status for ${employees[0].name}`, exact: true });
  await expect.poll(() => refresh.isEnabled()).toBe(true);
  const originalUrl = page.url();
  await page.setViewportSize({ width: 320, height: 640 });
  await refresh.click();
  const error = panel.getByRole('alert');
  await expect.poll(async () => (await error.textContent())?.includes('Sign in again as the owner')).toBe(true);
  await errorInViewport(error);
  expect(page.url()).toBe(originalUrl);
  expect(await draft.inputValue()).toBe('Draft retained during recovery authentication refusal');
  expect(unauthenticatedReads).toBe(1);
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'session-recovery-auth-refusal-320.png') });
  }
  await page.unroute('**' + endpoint);
  await refresh.click();
  await expect.poll(async () => (await error.textContent())?.trim()).toBe('');
  expect(await draft.inputValue()).toBe('Draft retained during recovery authentication refusal');
  expect(page.url()).toBe(originalUrl);
  expect(
    responses.filter(
      (r) => r.method === 'POST' && r.path.startsWith(`/api/company/employees/${employees[0].id}/recovery`)
    )
  ).toEqual([]);
});

for (const width of [320, 1280]) {
  it(`keeps a committed employee hiring grant unconfirmed after a lost reply and refreshes without replay at ${width}px`, async () => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const dialog = await profile();
    const draft = dialog.getByLabel('Role title', { exact: true });
    await draft.fill('Unsubmitted hiring grant draft');
    await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
    const permission = dialog.getByLabel(`Hiring permission for ${employees[0].name}`, { exact: true });
    await expect.poll(() => permission.isEnabled()).toBe(true);
    let writes = 0;
    await page.route('**/hiring-permission', async (route) => {
      if (new URL(route.request().url()).pathname !== hiringPath() || route.request().method() !== 'PUT')
        return route.fallback();
      writes++;
      const response = await route.fetch();
      try {
        expect(response.status()).toBe(200);
        expect((await response.json()).data.enabled).toBe(true);
      } finally {
        await response.dispose();
      }
      await route.abort('failed');
    });
    await permission.check();
    const group = dialog.locator('.ca-profile-hiring');
    const error = group.getByRole('alert');
    await visibleError(error);
    expect(await group.getByRole('status').textContent()).toBe('Save is unconfirmed; refresh the current permission.');
    expect(await permission.isDisabled()).toBe(true);
    expect((await api<Hiring>(hiringPath())).enabled).toBe(true);
    expect((await diskBudget()).hireEmployeeDelegates).toContain(employees[0].id);
    expect(writes).toBe(1);
    expect(await draft.inputValue()).toBe('Unsubmitted hiring grant draft');
    await errorInViewport(error);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await paint(page);
      await page.screenshot({ path: join(artifacts, `employee-hiring-lost-reply-${width}.png`) });
    }
    const refresh = group.getByRole('button', {
      name: `Refresh hiring permission for ${employees[0].name}`,
      exact: true,
    });
    await refresh.scrollIntoViewIfNeeded();
    const footer = await dialog.locator('.ca-profile-footer').boundingBox();
    const clip = await dialog.locator('.ca-profile-editor-body').boundingBox();
    expect(footer).not.toBeNull();
    expect(clip).not.toBeNull();
    for (const control of [error, refresh]) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(clip!.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(clip!.y + clip!.height);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(footer!.y);
    }
    if (artifacts) {
      await paint(page);
      await page.screenshot({ path: join(artifacts, `employee-hiring-lost-reply-actionable-${width}.png`) });
    }

    await group
      .getByRole('button', { name: `Refresh hiring permission for ${employees[0].name}`, exact: true })
      .click();
    await expect.poll(() => permission.isEnabled()).toBe(true);
    expect(await permission.isChecked()).toBe(true);
    expect(await error.textContent()).toBe('');
    expect((await api<Hiring>(hiringPath())).enabled).toBe(true);
    expect((await diskBudget()).hireEmployeeDelegates).toContain(employees[0].id);
    expect(writes).toBe(1);
    expect(await draft.inputValue()).toBe('Unsubmitted hiring grant draft');
  });

  it(`cancels Enter office from the real profile without sending an action or changing the draft at ${width}px`, async () => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const before = await current();
    const { dataPath } = await import('../src/config/instance.js');
    const diskBefore = await readFile(dataPath('company.json'), 'utf8');
    const dialog = await profile();
    const draft = dialog.getByLabel('Role title', { exact: true });
    await draft.fill('Unsubmitted attendance draft');
    await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
    const enter = dialog.getByRole('switch', { name: `Enter office: ${employees[0].name}`, exact: true });
    expect(await enter.isChecked()).toBe(false);
    expect(await dialog.getByRole('button', { name: `Wake ${employees[0].name}`, exact: true }).isDisabled()).toBe(
      true
    );
    expect(
      await dialog.getByRole('button', { name: `Restart session for ${employees[0].name}`, exact: true }).isDisabled()
    ).toBe(true);
    await enter.click();
    const confirmation = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: 'Enter office', exact: true }) });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => enter.isEnabled()).toBe(true);
    expect(await enter.isChecked()).toBe(false);
    expect(await draft.inputValue()).toBe('Unsubmitted attendance draft');
    expect(await current()).toEqual(before);
    expect(await readFile(dataPath('company.json'), 'utf8')).toBe(diskBefore);
    expect(responses.filter((response) => /\/(?:wake|restart|vacation)$/.test(response.path))).toEqual([]);
  });
}
