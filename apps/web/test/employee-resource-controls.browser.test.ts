/** Real GUI→owner API→shared RAM service/client; synthetic physical wire only.
 * Every employee stays OFF and every live/persisted Session registry stays empty.
 * The actor's reported PID/cgroup DATA are deliberate fixtures, not native acceptance.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmployeeResourceActor } from './helpers/employee-resource-actor.js';
import { createIsolatedOffice, type IsolatedOffice } from './helpers/isolated-office.js';
import type { FleetStatus } from '../src/types/resource-fleet.js';
import {
  claimOwner,
  contextFor,
  observeOffice,
  paint,
  closeCoveredPage,
  closeCoveredContext,
  closeCoveredBrowser,
  type CompanyView,
} from './helpers/office-browser.js';

const artifacts = process.env.TEST_RESOURCE_CONTROLS_SCREENSHOT_DIR;
let actor: Awaited<ReturnType<typeof createEmployeeResourceActor>>, office: IsolatedOffice;
let browser: Browser, context: BrowserContext, page: Page, audit: BrowserContext;
let employee: CompanyView['employees'][number];
let blocked: string[], errors: string[], responses: Array<{ path: string; method: string; status: number }>;
let pause: { entered(): void; wait: Promise<void> } | undefined;
let release = () => {};
let ready = false;
let cleanup: Array<() => Promise<unknown>> = [];
const password = 'Synthetic-' + randomBytes(18).toString('hex');
const policyPath = () => `/api/company/resources/employees/${employee.id}/policy`;
const editOperations = () => actor.operations.filter((operation) => operation.verb === 'employee-policy-edit');
async function json<T = CompanyView>(path = '/api/company'): Promise<T> {
  if (
    path !== '/api/company' &&
    path !== '/api/sessions' &&
    path !== '/api/company/resources/fleet' &&
    path !== `/api/company/resources/employees/${employee.id}`
  )
    throw new Error('Unapproved fixture audit read');
  const response = await audit.request.get(office.origin() + path);
  expect(response.status()).toBe(200);
  const body = await response.json();
  return body.success === true ? body.data : body;
}
async function profile(width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
  await page.evaluate(() =>
    (window as unknown as { reverieChat: { openCompany(section: string): void } }).reverieChat.openCompany('people')
  );
  await page.getByRole('button', { name: `Edit profile for ${employee.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Edit profile: ${employee.name}`, exact: true });
  expect(await dialog.getByLabel(`Hiring permission for ${employee.name}`, { exact: true }).isVisible()).toBe(false);
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  expect(await dialog.getByLabel(`Hiring permission for ${employee.name}`, { exact: true }).isVisible()).toBe(true);
  const panel = dialog.locator('.ca-employee-resources');
  await expect
    .poll(() => panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).isEnabled())
    .toBe(true);
  expect(await panel.locator('[data-memory-advisory]').textContent()).toContain('unknown');
  return panel;
}
async function draft(panel: Locator, memory: string, cpu: string) {
  await panel.getByLabel('Soft RAM (MiB)', { exact: true }).fill(memory);
  await panel.getByLabel('CPU share weight', { exact: true }).fill(cpu);
}
async function preserved(panel: Locator, memory: string, cpu: string) {
  expect(await panel.getByLabel('Soft RAM (MiB)', { exact: true }).inputValue()).toBe(memory);
  expect(await panel.getByLabel('CPU share weight', { exact: true }).inputValue()).toBe(cpu);
}
async function shownError(panel: Locator, text: string) {
  const error = panel.locator(':scope > [role="alert"]');
  await expect.poll(() => error.textContent()).toContain(text);
  // Viewport is set BEFORE the gesture. No scroll-to-error masks an offscreen alert.
  try {
    await expect
      .poll(async () => {
        const box = await error.boundingBox(),
          viewport = page.viewportSize()!;
        return (
          !!box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y + box.height <= viewport.height
        );
      })
      .toBe(true);
  } catch (failure) {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, 'offscreen-error.json'),
        JSON.stringify(
          {
            error: await error.textContent(),
            box: await error.boundingBox(),
            viewport: page.viewportSize(),
            memoryDraft: await panel.getByLabel('Soft RAM (MiB)', { exact: true }).inputValue(),
            cpuDraft: await panel.getByLabel('CPU share weight', { exact: true }).inputValue(),
            policyResponses: responses.filter((response) => response.path === policyPath()),
          },
          null,
          2
        )
      );
      await page.screenshot({ path: join(artifacts, 'offscreen-error.png') });
    }
    throw failure;
  }
}
async function capture(name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await paint(page);
    await page.screenshot({ path: join(artifacts, name + '.png') });
  }
}

beforeEach(async (test) => {
  ready = false;
  cleanup = [];
  vi.doUnmock('../src/resource-employee-service.js');
  vi.resetModules();
  actor = await createEmployeeResourceActor();
  const originalActor = actor;
  cleanup.push(() => originalActor.close());
  const socketPath = actor.socketPath;
  // The constructor and its Company/Owner classes must belong to this fresh
  // real module graph; retaining a mocked class across resetModules is invalid.
  vi.doMock('../src/resource-employee-service.js', async () => {
    const actual = await vi.importActual<typeof import('../src/resource-employee-service.js')>(
      '../src/resource-employee-service.js'
    );
    return {
      ...actual,
      EmployeeResourcesService: class extends actual.EmployeeResourcesService {
        constructor(...args: ConstructorParameters<typeof actual.EmployeeResourcesService>) {
          // ONLY the physical constructor port changes; all real methods/guards remain.
          super(args[0], args[1], socketPath);
        }
      },
    };
  });
  pause = undefined;
  release = () => {};
  blocked = [];
  errors = [];
  responses = [];
  office = await createIsolatedOffice({
    beforeStart: (server) => {
      server['app'].addHook('preHandler', async (request) => {
        if (
          request.method === 'POST' &&
          request.routeOptions.url === '/api/company/resources/employees/:employeeId/policy' &&
          pause
        ) {
          const original = pause;
          pause = undefined;
          original.entered();
          await original.wait;
        }
      });
    },
  });
  const originalOffice = office;
  cleanup.push(() => originalOffice.close());
  await office.seedStoppedEmployees();
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const originalBrowser = browser;
  cleanup.push(() => closeCoveredBrowser(originalBrowser));
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const originalContext = context;
  cleanup.push(() => closeCoveredContext(originalContext));
  await contextFor(context, office.origin(), blocked);
  page = await context.newPage();
  const originalPage = page;
  cleanup.push(() => closeCoveredPage(originalPage));
  await observeOffice(page, 'employee-resource-controls:' + test.task.name);
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  page.on('response', (response) =>
    responses.push({
      path: new URL(response.url()).pathname,
      method: response.request().method(),
      status: response.status(),
    })
  );
  await claimOwner(page, office.origin(), 'fixture-owner', password);
  audit = await browser.newContext({ storageState: await context.storageState() });
  const originalAudit = audit;
  cleanup.push(() => closeCoveredContext(originalAudit));
  const auditLogin = await audit.request.post(office.origin() + '/api/owner/login', {
    headers: { origin: office.origin() },
    data: { username: 'fixture-owner', password },
  });
  expect(auditLogin.status()).toBe(200); // Independent real owner session, not the page token revoked by a negative case.
  employee = (await json()).employees[0];
  actor.select(employee);
  // The only forwarded resource mutation is the existing fixed policy route
  // for the exact OFF employee, backed solely by this disposable wire fixture.
  await context.route('**/api/company/resources/employees/*/policy', async (route) => {
    if (new URL(route.request().url()).pathname !== policyPath() || route.request().method() !== 'POST')
      return route.fallback();
    await office.assertNoRunningIntent();
    const response = await route.fetch();
    try {
      await office.assertNoRunningIntent();
      await route.fulfill({ response });
    } finally {
      await response.dispose();
    }
  });
  ready = true;
});
afterEach(async () => {
  release();
  const failures: unknown[] = [];
  try {
    if (ready) {
      expect(await json('/api/sessions')).toEqual([]);
      await office.assertNoRunningIntent();
      expect(actor.failures).toEqual([]);
      expect(errors).toEqual([]);
      expect(blocked).toEqual([]);
    }
  } catch (error) {
    failures.push(error);
  }
  for (const close of cleanup.reverse())
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length) throw new AggregateError(failures, 'Owned resource-browser fixture checks or cleanup failed');
});

for (const width of [320, 1280]) {
  it(`applies one exact RAM and CPU edit through the real owner API at ${width}px`, async () => {
    const panel = await profile(width),
      before = actor.snapshot();
    await draft(panel, '12288', '180');
    await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).click();
    await expect.poll(() => editOperations().length).toBe(1);
    await expect.poll(() => panel.locator(':scope > [role="status"]').textContent()).toContain('Change applied.');
    const operation = editOperations()[0];
    expect(operation).toMatchObject({
      employeeId: employee.id,
      approval: {
        sessionId: employee.sessionId,
        expectedRevision: before.revision,
        memoryHighMiB: 12288,
        cpuWeight: 180,
      },
    });
    expect(operation.verb).toBe('employee-policy-edit');
    const value = await json<ReturnType<typeof actor.snapshot>>(`/api/company/resources/employees/${employee.id}`);
    expect(value.requested).toMatchObject({ memoryHighMiB: 12288, cpuWeight: 180 });
    expect(value.observed).toMatchObject({ memoryHighBytes: '12884901888', cpuWeight: 180 });
    expect(
      actor.proofs.some((proof) => proof.stage === 'employee-policy-edit' && proof.requestId === operation.requestId)
    ).toBe(true);
    expect(JSON.stringify(actor.proofs)).not.toContain(password);
    await preserved(panel, '12288', '180');
    await capture('ram-cpu-applied-' + width);
  });
  it(`keeps a native committed-lost reply unconfirmed without replay and refreshes explicitly at ${width}px`, async () => {
    const panel = await profile(width);
    actor.outcome('commit-lost-reply');
    await draft(panel, '16384', '240');
    await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).click();
    await shownError(panel, 'not confirmed');
    await preserved(panel, '16384', '240');
    expect(await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).isDisabled()).toBe(true);
    expect(editOperations()).toHaveLength(1);
    expect(
      responses
        .filter((response) => response.method === 'POST' && response.path === policyPath())
        .map((response) => response.status)
    ).toEqual([503]);
    expect(actor.snapshot().requested).toMatchObject({ memoryHighMiB: 16384, cpuWeight: 240 });
    await capture('ram-cpu-committed-unconfirmed-' + width);
    actor.outcome('confirmed');
    await panel.getByRole('button', { name: `Refresh resource status for ${employee.name}`, exact: true }).click();
    await expect.poll(() => panel.locator(':scope > [role="alert"]').textContent()).toBe('');
    await preserved(panel, '16384', '240');
    expect(await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).isEnabled()).toBe(true);
    expect(editOperations()).toHaveLength(1); // Readback never replays the lost original edit.
  });
}

it('refuses invalid values before dispatch and a stale native revision without changing the draft', async () => {
  const panel = await profile(320),
    before = actor.snapshot();
  await draft(panel, '49153', '180');
  await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).click();
  expect(editOperations()).toEqual([]);
  expect(responses.filter((response) => response.method === 'POST' && response.path === policyPath())).toEqual([]);
  const invalid = await audit.request.post(office.origin() + policyPath(), {
    headers: { origin: office.origin() },
    data: {
      sessionId: employee.sessionId,
      operationId: randomUUID(),
      expectedRevision: before.revision,
      memoryHighMiB: 49153,
      cpuWeight: 180,
    },
  });
  expect(invalid.status()).toBe(400);
  expect(editOperations()).toEqual([]);
  await draft(panel, '12288', '1.5');
  await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).click();
  expect(responses.filter((response) => response.method === 'POST' && response.path === policyPath())).toEqual([]);
  const invalidCpu = await audit.request.post(office.origin() + policyPath(), {
    headers: { origin: office.origin() },
    data: {
      sessionId: employee.sessionId,
      operationId: randomUUID(),
      expectedRevision: before.revision,
      memoryHighMiB: 12288,
      cpuWeight: 1.5,
    },
  });
  expect(invalidCpu.status()).toBe(400);
  expect(editOperations()).toEqual([]);
  expect(actor.snapshot()).toEqual(before);
  await draft(panel, '12288', '180');
  actor.changeRevision();
  const changed = actor.snapshot();
  await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).click();
  await shownError(panel, 'revision changed');
  await preserved(panel, '12288', '180');
  expect(await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).isDisabled()).toBe(true);
  expect(actor.snapshot()).toEqual(changed);
  expect(editOperations()).toHaveLength(1);
  await capture('ram-cpu-stale-revision-320');
});

it('rechecks actual owner revocation after request setup before opening the resource channel', async () => {
  const panel = await profile(320),
    before = actor.snapshot();
  await draft(panel, '12288', '180');
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  pause = {
    entered,
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).click();
  await reached;
  const logout = await context.request.post(office.origin() + '/api/owner/logout', {
    headers: { origin: office.origin() },
  });
  expect(logout.status()).toBe(200);
  release();
  await shownError(panel, 'Company owner authorization is required');
  await preserved(panel, '12288', '180');
  expect(await panel.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).isDisabled()).toBe(true);
  expect(editOperations()).toEqual([]);
  expect(actor.snapshot()).toEqual(before);
  expect(
    responses
      .filter((response) => response.method === 'POST' && response.path === policyPath())
      .map((response) => response.status)
  ).toEqual([403]);
  await capture('ram-cpu-owner-revoked-320');
});

for (const width of [320, 1280]) {
  it(`keeps the real aggregate unknown and opens the correct Permissions profile with unconfigured GPU refresh at ${width}px`, async () => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    await page.evaluate(() =>
      (window as unknown as { reverieChat: { openCompany(section: string): void } }).reverieChat.openCompany('people')
    );
    await page.getByRole('button', { name: 'Company settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
    const table = settings.getByRole('table', { name: 'Laptop resource summary', exact: true });
    await table.waitFor();
    const fleet = await json<FleetStatus>('/api/company/resources/fleet');
    expect(fleet.canPreview).toBe(false);
    expect(fleet.pool.observed).toBeNull();
    expect(fleet.employees.every((row) => row.observed === null && row.desired === null)).toBe(true);
    const row = table
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: `Resource permissions for ${employee.name}`, exact: true }) });
    expect(await row.getByRole('cell').nth(1).textContent()).toContain('vacation');
    expect(await row.getByRole('cell').nth(2).textContent()).toBe('Unavailable');
    expect(await row.getByRole('cell').nth(3).textContent()).toBe('Not verified');
    const reads = () =>
      responses.filter((response) => response.path === '/api/company/resources/fleet' && response.method === 'GET')
        .length;
    const before = reads();
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/company/resources/fleet' && response.request().method() === 'GET'
    );
    await settings.getByRole('button', { name: 'Refresh laptop fleet status', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    expect(reads()).toBe(before + 1);
    // The actual controller awaits its second owner read before replacing the
    // table. Join its enabled state, not merely the earlier HTTP response.
    await expect
      .poll(() => settings.getByRole('button', { name: 'Refresh laptop fleet status', exact: true }).isEnabled())
      .toBe(true);
    await table.scrollIntoViewIfNeeded();
    await capture('company-resource-summary-unknown-' + width);
    await row.getByRole('button', { name: `Resource permissions for ${employee.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Edit profile: ${employee.name}`, exact: true });
    expect(await dialog.getByRole('tab', { name: 'Permissions', exact: true }).getAttribute('aria-selected')).toBe(
      'true'
    );
    // The profile publishes its fields only after the actual company and owner
    // reads complete; selecting the tab itself is synchronous.
    await expect
      .poll(() => dialog.getByLabel(`Hiring permission for ${employee.name}`, { exact: true }).isVisible())
      .toBe(true);
    await dialog.getByRole('tab', { name: 'Profile', exact: true }).click();
    expect(await dialog.getByLabel(`Hiring permission for ${employee.name}`, { exact: true }).isVisible()).toBe(false);
    await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
    const gpu = dialog.getByRole('group', { name: 'Laptop GPU access', exact: true });
    const refresh = gpu.getByRole('button', { name: `Refresh GPU status for ${employee.name}`, exact: true });
    await expect.poll(() => refresh.isEnabled()).toBe(true);
    const gpuResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/company/employees/${employee.id}/gpu-access` &&
        response.request().method() === 'GET'
    );
    await refresh.click();
    expect((await gpuResponse).status()).toBe(503);
    await expect.poll(() => refresh.isEnabled()).toBe(true);
    expect(await gpu.getByRole('status').textContent()).toBe(
      'Host GPU status unavailable; no policy change is confirmed.'
    );
    expect(
      await gpu
        .getByLabel(`GPU access for ${employee.name}`, { exact: true })
        .evaluate((element) => element instanceof HTMLInputElement && element.indeterminate)
    ).toBe(true);
    expect(await gpu.getByLabel(`GPU access for ${employee.name}`, { exact: true }).isDisabled()).toBe(true);
    expect(await gpu.getByLabel(`GPU device for ${employee.name}`, { exact: true }).isDisabled()).toBe(true);
    expect(
      await gpu.getByRole('button', { name: `Save GPU request for ${employee.name}`, exact: true }).isDisabled()
    ).toBe(true);
    expect(responses.filter((response) => response.path.endsWith('/gpu-access') && response.method !== 'GET')).toEqual(
      []
    );
    expect(editOperations()).toEqual([]);
    await capture('gpu-unconfigured-refresh-' + width);
  });
}
