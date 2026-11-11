/** Real GUI/API behavior. Synthetic employees stay OFF; no native/provider success is simulated. */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createIsolatedOffice, type IsolatedOffice } from './helpers/isolated-office.js';
import {
  claimOwner,
  contextFor,
  signedIn,
  observeOffice,
  requireOfficeReady,
  paint,
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
async function api<T = CompanyView>(path = '/api/company', method = 'GET', data?: unknown): Promise<T> {
  if (!/^\/api\/(?:company(?:\/settings|\/employees\/[^/]+(?:\/hiring-permission)?)?|sessions)$/.test(path))
    throw new Error('The no-worker audit client refuses this endpoint');
  if (method !== 'GET' && !/^\/api\/company\/(?:settings|employees\/[^/]+(?:\/hiring-permission)?)$/.test(path))
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
async function visibleError(locator: Locator) {
  await expect.poll(async () => (await locator.textContent())?.trim()).toBeTruthy();
  expect(await locator.isVisible()).toBe(true);
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
  await observeOffice(setupPage);
  await claimOwner(setupPage, office.origin(), username, password);
  expect(setupBlocked).toEqual([]);
  await setup.close();
  employees = await office.seedStoppedEmployees();
  audit = await browser.newContext();
  await contextFor(audit, office.origin(), setupBlocked);
  const login = await audit.newPage();
  await observeOffice(login);
  await signedIn(login, office.origin(), username, password);
  ownerState = await audit.storageState();
  await login.close();
}, 60_000);

beforeEach(async () => {
  blocked = [];
  errors = [];
  responses = [];
  await api('/api/company/settings', 'PUT', { ownerName: 'Synthetic owner', ownerTitle: 'Owner', timeZone: 'UTC' });
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
  await observeOffice(page);
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
    await context?.close();
  }
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await office?.close();
  }
});

it('discards unsaved owner edits when the company dialog closes', async () => {
  const dialog = await settings();
  await dialog.getByLabel('Owner display name', { exact: true }).fill('Unsaved owner');
  await dialog.getByRole('button', { name: 'Close company settings', exact: true }).click();
  expect((await api()).settings.ownerName).toBe('Synthetic owner');
  const reopened = await settings();
  expect(await reopened.getByLabel('Owner display name', { exact: true }).inputValue()).toBe('Synthetic owner');
});

it('persists trimmed owner details while preserving an unrelated saved setting', async () => {
  await api('/api/company/settings', 'PUT', { timeZone: 'Europe/London' });
  const dialog = await settings();
  await dialog.getByLabel('Owner display name', { exact: true }).fill('  Updated owner  ');
  await dialog.getByLabel('Owner title', { exact: true }).fill('  Director  ');
  await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
  await expect.poll(async () => (await api()).settings.ownerName).toBe('Updated owner');
  expect((await api()).settings).toMatchObject({
    ownerName: 'Updated owner',
    ownerTitle: 'Director',
    timeZone: 'Europe/London',
  });
});

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
    expect((await api()).settings.ownerName).toBe('Synthetic owner');
    expect(await dialog.getByRole('button', { name: 'Save owner details', exact: true }).isEnabled()).toBe(true);
    await capture('disconnected-owner-save', dialog.locator(':scope > [role="alert"]'));
  } finally {
    await context.setOffline(false);
  }
  await dialog.getByRole('button', { name: 'Save owner details', exact: true }).click();
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
