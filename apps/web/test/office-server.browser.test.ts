/** Actual backend/assets/auth; all fixture employees remain OFF and have no Session. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createIsolatedOffice } from './helpers/isolated-office.js';
import {
  contextFor,
  signedIn,
  json,
  claimOwner,
  observeOffice,
  paint,
  closeCoveredContext,
  closeCoveredBrowser,
} from './helpers/office-browser.js';

const artifacts = process.env.TEST_OFFICE_SCREENSHOT_DIR;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'narrow', width: 320, height: 900 },
];
type Control = {
  frame: string;
  role: string;
  label: string;
  disabled: boolean;
  disposition: 'exercised' | 'outside-fixture' | 'unmapped';
  reason?: string;
};
type Screen = { page: string; state: string; viewport: string; controls: Control[]; overflow: boolean };
const keyFor = (page: string, state: string, viewport: string, role: string, label: string) =>
  JSON.stringify([page, state, viewport, 'main', role, label]);
async function record(
  page: Page,
  screen: string,
  state: string,
  viewport: string,
  inventory: Screen[],
  exercised: Set<string>
) {
  const inspectDocument = () => {
    const modals = [...document.querySelectorAll('dialog:modal')],
      modal = modals.at(-1);
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect(),
        style = getComputedStyle(element);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !element.closest('[hidden],[inert],[aria-hidden="true"]') &&
        (!modal || modal.contains(element))
      );
    };
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        'button,a[href],input,select,textarea,[role="tab"],[role="switch"],summary'
      ),
    ]
      .filter(visible)
      .map((element) => {
        const input = element as HTMLInputElement;
        const role =
          element.getAttribute('role') ||
          (element.tagName === 'A'
            ? 'link'
            : element.tagName === 'SUMMARY'
              ? 'disclosure'
              : element.tagName === 'INPUT'
                ? input.type
                : element.tagName.toLowerCase());
        const label =
          element.getAttribute('aria-label') ||
          input.labels?.[0]?.textContent ||
          element.getAttribute('title') ||
          element.textContent ||
          input.name ||
          element.id;
        return { role, label: label.trim().replace(/\s+/g, ' ').slice(0, 240), disabled: !!input.disabled };
      });
    return { controls, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  };
  const snapshots = [];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && !(await (await frame.frameElement()).isVisible())) continue;
    if (!frame.url().startsWith(new URL(page.url()).origin)) continue;
    snapshots.push({
      frame: frame === page.mainFrame() ? 'main' : new URL(frame.url()).pathname,
      ...(await frame.evaluate(inspectDocument)),
    });
  }
  const controls: Control[] = snapshots.flatMap((snapshot) =>
    snapshot.controls.map((control) => {
      const base = { frame: snapshot.frame, ...control };
      if (snapshot.frame === 'main' && exercised.has(keyFor(screen, state, viewport, control.role, control.label)))
        return { ...base, disposition: 'exercised' as const };
      if (
        /hire|wake|restart|recover|apply|GPU|sign.in|model|plan|two.step|authenticator|password|token|PAT|shutdown|stop|retire|enter office/i.test(
          control.label
        )
      )
        return {
          ...base,
          disposition: 'outside-fixture' as const,
          reason:
            'External provider, native runtime, security enrollment, or disruptive action is outside this no-worker fixture.',
        };
      return {
        ...base,
        disposition: 'unmapped' as const,
        reason: 'Discovered; no behavioral coverage is claimed by this screenshot inventory.',
      };
    })
  );
  const overflow = snapshots.some((snapshot) => snapshot.overflow);
  inventory.push({ page: screen, state, viewport, controls, overflow });
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await paint(page);
    await page.screenshot({ path: join(artifacts, `${viewport}-${screen}-${state}.png`) });
  }
  expect(overflow, `${screen}/${state}/${viewport} horizontal overflow`).toBe(false);
}

async function openPrimary(page: Page, kind: string) {
  if (kind === 'company') {
    await page.evaluate(() => (window as any).reverieChat.openCompany('plans'));
    await page.frameLocator('#ca-company-plans iframe').locator('#plans').waitFor();
  } else {
    await page.evaluate((kind) => (window as any).reverieChat.openPage(kind), kind);
    if (kind !== 'office') {
      const selector = kind === 'board' ? 'iframe[title="Board"]:visible' : `.ca-page[data-kind="${kind}"] iframe`;
      const iframe = page.locator(selector);
      await iframe.waitFor();
      await expect
        .poll(async () => {
          const frame = await (await iframe.elementHandle())!.contentFrame();
          return !!frame && frame.url().startsWith(new URL(page.url()).origin);
        })
        .toBe(true);
      await (await (await iframe.elementHandle())!.contentFrame())!.waitForLoadState('domcontentloaded');
      await page.frameLocator(selector).locator('body').waitFor();
    }
  }
}

it('inventories real owner screens and converges GUI/API state without starting an employee', async () => {
  const office = await createIsolatedOffice();
  let browser: Browser | undefined;
  const inventory: Screen[] = [],
    blocked: string[] = [],
    errors: string[] = [],
    streams: string[] = [];
  const assets: Array<{ path: string; status: number; versioned: boolean }> = [];
  const exercised = new Set<string>();
  const mark = (screen: string, state: string, viewport: string, role: string, label: string) =>
    exercised.add(keyFor(screen, state, viewport, role, label));
  const observe = (page: Page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (['script', 'stylesheet'].includes(response.request().resourceType()))
        assets.push({ path: url.pathname, status: response.status(), versioned: url.searchParams.has('v') });
      if (response.headers()['content-type']?.includes('text/event-stream')) streams.push(url.pathname);
    });
  };
  const username = 'fixture-owner',
    password = `Synthetic-${randomBytes(18).toString('hex')}`;
  let contexts: BrowserContext[] = [];
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(executablePath ? { executablePath } : {}),
    });
    let origin = office.origin();
    const setup = await browser.newContext();
    contexts.push(setup);
    await contextFor(setup, origin, blocked);
    const page = await setup.newPage();
    observe(page);
    await observeOffice(page, 'office-server:setup');
    await claimOwner(page, origin, username, password, (stage) =>
      record(page, 'owner', stage, 'desktop', inventory, exercised)
    );
    mark('owner', 'first-run', 'desktop', 'button', 'Create account');
    mark('owner', 'display-name', 'desktop', 'button', 'Save');
    expect(await json(page, '/api/sessions')).toEqual([]);
    await page.evaluate(() => (window as any).reverieChat.openCompany('people'));
    await record(page, 'company', 'empty-people', 'desktop', inventory, exercised);
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const kind of ['company', 'board', 'workspace']) {
        await openPrimary(page, kind);
        await record(page, kind, 'empty', viewport.name, inventory, exercised);
      }
    }
    await closeCoveredContext(setup);
    contexts = [];

    const employees = await office.seedStoppedEmployees();
    origin = office.origin();
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      contexts.push(context);
      await contextFor(context, origin, blocked);
      const p = await context.newPage();
      observe(p);
      await observeOffice(p, 'office-server:' + viewport.name);
      await signedIn(p, origin, username, password, () =>
        record(p, 'owner', 'login', viewport.name, inventory, exercised)
      );
      mark('owner', 'login', viewport.name, 'button', 'Sign in');
      await record(p, 'chat', 'empty', viewport.name, inventory, exercised);
      await p.evaluate(() => (window as any).reverieChat.openCompany('people'));
      await record(p, 'company', 'stopped-employees', viewport.name, inventory, exercised);
      await p.getByRole('button', { name: 'Company settings', exact: true }).click();
      mark('company', 'stopped-employees', viewport.name, 'button', 'Company settings');
      const settings = p.getByRole('dialog', { name: 'Company settings', exact: true });
      for (const label of ['Company', 'Employees', 'Hiring', 'Reports']) {
        await settings.getByRole('tab', { name: label, exact: true }).click();
        mark('settings', label.toLowerCase(), viewport.name, 'tab', label);
        await record(p, 'settings', label.toLowerCase(), viewport.name, inventory, exercised);
      }
      if (viewport.name === 'desktop') {
        await settings.getByRole('tab', { name: 'Company', exact: true }).click();
        await settings.getByLabel('Owner display name', { exact: true }).fill('Synthetic owner display');
        await settings.getByRole('button', { name: 'Save owner details', exact: true }).click();
        mark('settings', 'company', viewport.name, 'button', 'Save owner details');
        await expect
          .poll(async () => (await json(p, '/api/company')).settings.ownerName)
          .toBe('Synthetic owner display');
      }
      await settings.getByRole('button', { name: 'Close company settings', exact: true }).click();
      mark(
        'settings',
        viewport.name === 'desktop' ? 'company' : 'reports',
        viewport.name,
        'button',
        'Close company settings'
      );
      const employee = employees[0];
      await p.getByRole('button', { name: `Edit profile for ${employee.name}`, exact: true }).click();
      mark('company', 'stopped-employees', viewport.name, 'button', `Edit profile for ${employee.name}`);
      const profile = p.getByRole('dialog', { name: `Edit profile: ${employee.name}`, exact: true });
      for (const label of ['Profile', 'Permissions', 'GitHub PATs', 'Identity & context']) {
        await profile.getByRole('tab', { name: label, exact: true }).click();
        mark('profile', label.toLowerCase().replace(/[^a-z]+/g, '-'), viewport.name, 'tab', label);
        if (label === 'Permissions') {
          const resources = profile.locator('.ca-employee-resources');
          await expect.poll(() => resources.locator('[role="alert"]').textContent()).not.toBe('');
          const refresh = resources.getByRole('button', {
            name: `Refresh resource status for ${employee.name}`,
            exact: true,
          });
          expect(await refresh.isEnabled()).toBe(true);
          const response = p.waitForResponse(
            (reply) =>
              new URL(reply.url()).pathname === `/api/company/resources/employees/${employee.id}/memory-diagnostics` &&
              reply.request().method() === 'GET'
          );
          await refresh.click();
          expect((await response).status()).toBe(503);
          mark('profile', 'permissions', viewport.name, 'button', `Refresh resource status for ${employee.name}`);
          expect(await resources.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).count()).toBe(
            0
          );
        }
        await record(p, 'profile', label.toLowerCase().replace(/[^a-z]+/g, '-'), viewport.name, inventory, exercised);
      }
      if (viewport.name === 'desktop') {
        await json(p, `/api/company/employees/${employee.id}`, 'PUT', { permissions: { recoverEmployees: true } });
        await profile.getByRole('button', { name: `Close profile for ${employee.name}`, exact: true }).click();
        await p.getByRole('button', { name: `Edit profile for ${employee.name}`, exact: true }).click();
        await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
        expect(await profile.getByLabel(`Recovery permission for ${employee.name}`, { exact: true }).isChecked()).toBe(
          true
        );
        await profile.getByLabel(`Recovery permission for ${employee.name}`, { exact: true }).uncheck();
        await expect
          .poll(
            async () =>
              (await json(p, '/api/company')).employees.find((entry: { id: string }) => entry.id === employee.id)!
                .permissions.recoverEmployees
          )
          .toBe(false);
        mark('profile', 'permissions-roundtrip', viewport.name, 'checkbox', `Recovery permission for ${employee.name}`);
        await record(p, 'profile', 'permissions-roundtrip', viewport.name, inventory, exercised);
      }
      await profile.getByRole('button', { name: `Close profile for ${employee.name}`, exact: true }).click();
      mark(
        'profile',
        viewport.name === 'desktop' ? 'permissions-roundtrip' : 'identity-context',
        viewport.name,
        'button',
        `Close profile for ${employee.name}`
      );
      for (const kind of ['company', 'board', 'workspace', 'office', 'handbook']) {
        await openPrimary(p, kind);
        await record(p, kind, kind === 'company' ? 'empty-plans' : 'readonly', viewport.name, inventory, exercised);
      }
      expect(await json(p, '/api/sessions')).toEqual([]);
      await office.assertNoRunningIntent();
      await closeCoveredContext(context);
      contexts = contexts.filter((item) => item !== context);
    }
    expect(assets.length).toBeGreaterThan(20);
    expect(assets.some((asset) => asset.versioned)).toBe(true);
    expect(streams).toContain('/api/events');
    expect(assets.filter((asset) => asset.status >= 400)).toEqual([]);
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
  } finally {
    for (const screen of inventory)
      for (const control of screen.controls)
        if (
          control.frame === 'main' &&
          exercised.has(keyFor(screen.page, screen.state, screen.viewport, control.role, control.label))
        ) {
          control.disposition = 'exercised';
          delete control.reason;
        }
    try {
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          join(artifacts, 'inventory.json'),
          JSON.stringify(
            {
              version: 1,
              scope: 'actual WebServer; no runtime transitions claimed',
              inventory,
              assets,
              streams,
              errors,
              blocked,
              exercised: [...exercised],
              remainingUnmapped: inventory.flatMap((screen) =>
                screen.controls
                  .filter((control) => control.disposition === 'unmapped')
                  .map((control) => ({ page: screen.page, state: screen.state, viewport: screen.viewport, ...control }))
              ),
            },
            null,
            2
          )
        );
      }
    } finally {
      try {
        try {
          await Promise.all(contexts.map((context) => closeCoveredContext(context)));
        } finally {
          if (browser) await closeCoveredBrowser(browser);
        }
      } finally {
        await office.close();
      }
    }
  }
}, 180_000);
