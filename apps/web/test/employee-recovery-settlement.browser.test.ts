/** Real profile -> protected API -> actual application writers over a synthetic Q port.
 * The dedicated native frame is a physical-port fixture, never native acceptance.
 * Every employee stays OFF and each registered Session remains pid-null/idle. */
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, mkdir, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createIsolatedOffice, type IsolatedOffice } from './helpers/isolated-office.js';
import {
  claimOwner,
  contextFor,
  observeOffice,
  paint,
  closeCoveredBrowser,
  closeCoveredContext,
  closeCoveredPage,
} from './helpers/office-browser.js';
let office: IsolatedOffice, browser: Browser, context: BrowserContext, page: Page;
let cleanup: Array<() => Promise<unknown>> = [],
  blocked: string[] = [],
  errors: string[] = [],
  operations: Array<{ verb: string; approval: unknown }> = [];
let employee: { id: string; sessionId: string; name: string };
const artifacts = process.env.TEST_RECOVERY_SETTLEMENT_SCREENSHOT_DIR;
let diagnosticReply = false;
const diagnosticCodes = {
  primaryCode: 'WORKER_RECOVERY_' + 'X'.repeat(96 - 'WORKER_RECOVERY_'.length),
  secondaryCode: 'WORKER_REPORT_CLOSE_UNKNOWN',
};
const captureSetupTimings = process.env.TEST_RECOVERY_SETUP_TIMINGS === '1';
async function measureSetup<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const began = performance.now();
  try {
    return await operation();
  } finally {
    if (captureSetupTimings)
      process.stderr.write(
        'recovery browser setup ' + JSON.stringify({ phase, elapsedMs: performance.now() - began }) + '\n'
      );
  }
}
const encode = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};
beforeEach(async (test) => {
  cleanup = [];
  diagnosticReply = false;
  blocked = [];
  errors = [];
  operations = [];
  vi.resetModules();
  const directory = await mkdtemp('/tmp/rvr-stop-'),
    socketPath = join(directory, 'native.sock'),
    peers = new Set<Socket>();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', (error) => errors.push(error.message));
    let bytes = Buffer.alloc(0),
      ready = false,
      operation: Record<string, unknown>;
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!ready) {
        if (bytes.length < 5) return;
        const size = bytes.readUInt32BE(1);
        if (bytes.length < size + 5) return;
        expect(bytes[0]).toBe('Q'.charCodeAt(0));
        expect(JSON.parse(bytes.subarray(5, size + 5).toString())).toEqual({
          purpose: 'resource-ram-pool-v2',
          version: 2,
        });
        bytes = bytes.subarray(size + 5);
        ready = true;
        socket.write('RESOURCE_READY\n');
      }
      while (bytes.length >= 4) {
        const size = bytes.readUInt32BE();
        if (bytes.length < size + 4) return;
        const message = JSON.parse(bytes.subarray(4, size + 4).toString()) as Record<string, unknown>;
        bytes = bytes.subarray(size + 4);
        if (message.kind === 'resource-operation') {
          expect(message.employeeId).toBe(employee.id);
          expect(['employee-recovery', 'employee-recovery-observe']).toContain(message.verb);
          operation = message;
          operations.push({ verb: String(message.verb), approval: message.approval });
          socket.write(
            encode({
              kind: 'resource-owner-check',
              requestId: message.requestId,
              nonce: randomUUID(),
              stage: message.verb,
              employeeId: employee.id,
              approval: message.approval,
            })
          );
        } else {
          expect(message.kind).toBe('resource-owner-current');
          expect(message.recoveryAuthority).toMatchObject({ kind: 'human-owner' });
          const value = {
            version: 1,
            purpose: 'employee-recovery-v1',
            employeeId: employee.id,
            approval: operation.approval,
            outcome: diagnosticReply
              ? 'unconfirmed'
              : operation.verb === 'employee-recovery-observe'
                ? 'provider-stopped'
                : 'provider-stop-pending',
            ...(diagnosticReply ? { diagnostics: diagnosticCodes } : {}),
            newDispatch: 'attempted',
            earlierEffects: 'unproved',
          };
          if (operation.verb === 'employee-recovery-observe' && !diagnosticReply)
            socket.end(
              encode({
                kind: 'resource-stopped-original',
                version: 1,
                purpose: 'employee-recovery-stopped-original-v1',
                requestId: operation.requestId,
                ownerNonce: message.nonce,
                ownerScopeDigest: message.ownerScopeDigest,
                employeeId: employee.id,
                approval: operation.approval,
                value,
              })
            );
          else socket.write(encode({ kind: 'resource-result', requestId: operation.requestId, value }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  cleanup.push(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  });
  vi.doMock('../src/employee-recovery-service.js', async () => {
    const actual = await vi.importActual<typeof import('../src/employee-recovery-service.js')>(
      '../src/employee-recovery-service.js'
    );
    return {
      ...actual,
      EmployeeRecoveryService: class extends actual.EmployeeRecoveryService {
        constructor(...args: ConstructorParameters<typeof actual.EmployeeRecoveryService>) {
          super(args[0], args[1], socketPath, args[3], args[4], args[5]);
        }
      },
    };
  });
  office = await measureSetup('isolated-server', () => createIsolatedOffice());
  const originalOffice = office;
  cleanup.push(() => originalOffice.close());
  const employees = await measureSetup('seed-OFF-employees', () => office.seedStoppedEmployees());
  employee = employees[0]!;
  browser = await measureSetup('sandboxed-Chromium', () =>
    chromium.launch({
      headless: true,
      chromiumSandbox: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    })
  );
  const originalBrowser = browser;
  cleanup.push(() => closeCoveredBrowser(originalBrowser));
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const originalContext = context;
  cleanup.push(() => closeCoveredContext(originalContext));
  await contextFor(context, office.origin(), blocked);
  const endpoint = '/api/company/employees/' + employee.id + '/recovery';
  await context.route('**/api/company/employees/*/recovery{,/observe}', async (route) => {
    if (
      route.request().method() !== 'POST' ||
      ![endpoint, endpoint + '/observe'].includes(new URL(route.request().url()).pathname)
    )
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
  page = await context.newPage();
  const originalPage = page;
  cleanup.push(() => closeCoveredPage(originalPage));
  await observeOffice(page, 'recovery-settlement:' + test.task.name);
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await measureSetup('genuine-owner-startup', () =>
    claimOwner(page, office.origin(), 'fixture-owner', 'Synthetic-recovery-settlement-42!')
  );
  // Complete genuine empty-session startup before registering the pid-null
  // target; this profile test never selects or attaches a terminal.
  await measureSetup('register-pid-null-target', () =>
    office.seedUnstartedSessions({ employees: [employee], nativeSocket: socketPath })
  );
  // Match the established bounded real-office startup hook. This includes cold
  // module transforms, server/browser startup and genuine first-run authentication;
  // the Source authorization deadline and action/assertion timeouts are unchanged.
}, 60000);
afterEach(async () => {
  const failures: unknown[] = [];
  if (office)
    try {
      await office.assertNoRunningIntent();
    } catch (error) {
      failures.push(error);
    }
  for (const close of cleanup.splice(0).reverse())
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  vi.doUnmock('../src/employee-recovery-service.js');
  vi.restoreAllMocks();
  expect(blocked).toEqual([]);
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
});
async function open(width: number) {
  await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
  await page.evaluate(() =>
    (window as unknown as { reverieChat: { openCompany(section: string): void } }).reverieChat.openCompany('people')
  );
  await page.getByRole('button', { name: 'Edit profile for ' + employee.name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit profile: ' + employee.name, exact: true });
  await dialog.getByLabel('Role title', { exact: true }).fill('Unsubmitted settlement draft');
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  const panel = dialog.locator('.ca-employee-recovery');
  await panel.getByRole('button', { name: 'Stop provider for ' + employee.name, exact: true }).waitFor();
  return { dialog, panel };
}
it.each([320, 1280])(
  'shows genuine component stopped settlement and lost final reply readback at width%s',
  async (width) => {
    const { dialog, panel } = await open(width);
    const draft = dialog.getByLabel('Role title', { exact: true });
    await panel.getByRole('button', { name: 'Stop provider for ' + employee.name, exact: true }).click();
    const confirm = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: 'Stop provider', exact: true }) });
    await confirm.getByRole('button', { name: 'Stop provider', exact: true }).click();
    await expect.poll(() => panel.textContent()).toContain('Recovery still requires attention');
    await panel.getByRole('button', { name: 'Refresh recovery status for ' + employee.name, exact: true }).click();
    await panel.getByRole('button', { name: 'Inspect original operation for ' + employee.name, exact: true }).waitFor();
    const endpoint = '/api/company/employees/' + employee.id + '/recovery/observe';
    await context.route('**/recovery/observe', async (route) => {
      if (new URL(route.request().url()).pathname !== endpoint) return route.fallback();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const result = await response.json();
      expect(result.data.application.state).toBe('completed-stopped');
      await response.dispose();
      await route.abort('failed');
      await context.unroute('**/recovery/observe');
    });
    await panel.getByRole('button', { name: 'Inspect original operation for ' + employee.name, exact: true }).click();
    await expect
      .poll(() => panel.locator('[role="alert"]').textContent())
      .toContain('original operation has been kept');
    const error = panel.locator('[role="alert"]');
    const box = await error.boundingBox(),
      viewport = page.viewportSize()!;
    expect(
      !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height
    ).toBe(true);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await paint(page);
      await page.screenshot({ path: join(artifacts, 'lost-final-reply-' + width + '.png') });
    }
    expect(await draft.inputValue()).toBe('Unsubmitted settlement draft');
    expect(operations.map((row) => row.verb)).toEqual(['employee-recovery', 'employee-recovery-observe']);
    const { dataPath } = await import('../src/config/instance.js');
    const saved = JSON.parse(await readFile(dataPath('company.json'), 'utf8'));
    expect(saved.employeeRecoveryOperations[0].application.state).toBe('completed-stopped');
    await panel.getByRole('button', { name: 'Refresh recovery status for ' + employee.name, exact: true }).click();
    await expect
      .poll(() => panel.textContent())
      .toContain('Recovery completed with its provider stopped. Enter office is a separate action.');
    expect(await draft.inputValue()).toBe('Unsubmitted settlement draft');
    expect(operations).toHaveLength(2);
    await panel.locator('[role="status"]').scrollIntoViewIfNeeded();
    await paint(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, 'completed-stopped-' + width + '.png') });
    }
    await office.assertNoRunningIntent();
  }
);

it.each([320, 1280])(
  'shows retained primary and cleanup diagnostics without completion or overflow at width%s',
  async (width) => {
    const { dialog, panel } = await open(width);
    await panel.getByRole('button', { name: 'Stop provider for ' + employee.name, exact: true }).click();
    const confirm = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: 'Stop provider', exact: true }) });
    await confirm.getByRole('button', { name: 'Stop provider', exact: true }).click();
    await expect.poll(() => panel.textContent()).toContain('Recovery still requires attention');
    await panel.getByRole('button', { name: 'Refresh recovery status for ' + employee.name, exact: true }).click();
    await panel.getByRole('button', { name: 'Inspect original operation for ' + employee.name, exact: true }).waitFor();
    diagnosticReply = true;
    await panel.getByRole('button', { name: 'Inspect original operation for ' + employee.name, exact: true }).click();
    const alert = panel.locator('[role="alert"]');
    await expect.poll(() => alert.textContent()).toContain('Primary recovery error: ' + diagnosticCodes.primaryCode);
    expect(await alert.textContent()).toContain('Cleanup error: ' + diagnosticCodes.secondaryCode);
    expect(await panel.textContent()).toContain('Recovery still requires attention');
    expect(await panel.textContent()).not.toContain('Recovery completed');
    await alert.scrollIntoViewIfNeeded();
    await paint(page);
    const box = await alert.boundingBox(),
      viewport = page.viewportSize()!;
    expect(
      !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height
    ).toBe(true);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await dialog.getByLabel('Role title', { exact: true }).inputValue()).toBe('Unsubmitted settlement draft');
    expect(operations.map((row) => row.verb)).toEqual(['employee-recovery', 'employee-recovery-observe']);
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, 'retained-diagnostics-' + width + '.png') });
    }
    await office.assertNoRunningIntent();
  }
);
