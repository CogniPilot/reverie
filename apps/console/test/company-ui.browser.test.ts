import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

describe('company roster and research reports in Chromium', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: 'class CodemanApp {} window.CodemanApp = CodemanApp;' });
    await page.addScriptTag({
      content: await readFile(resolve(import.meta.dirname, '../src/web/public/company-ui.js'), 'utf8'),
    });
    await page.evaluate(() => {
      const w = window as any;
      w.calls = [];
      w.companyData = {
        canManage: true,
        employees: [
          {
            id: 'ada',
            name: '<img src=x onerror=window.pwned=1>',
            icon: '🔭',
            position: 'Research scientist',
            expertise: ['systems'],
            available: true,
          },
        ],
        settings: {
          enabled: false,
          timeZone: 'UTC',
          nightHour: 1,
          morningHour: 8,
          researchMinutes: 60,
          briefingMinutes: 10,
        },
        cycles: [
          {
            id: 'cycle',
            date: '2026-10-15',
            employeeId: 'ada',
            kind: 'research',
            state: 'completed',
            result: {
              summary: 'Actual experiment report',
              findings: [
                { text: 'A possible next experiment', status: 'hypothesis', evidence: [] },
                { text: 'Experiment result', status: 'observed', evidence: ['tool receipt: actual experiment.log'] },
              ],
            },
          },
        ],
      };
      w.app = new w.CodemanApp();
      w.app._api = async (path: string, options: any) => {
        w.calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
        return { ok: true, json: async () => ({ success: true, data: path === '/api/company' ? w.companyData : {} }) };
      };
    });
  });

  it('renders real employee/report state safely and invites the registered expert into the chosen channel', async () => {
    await page.evaluate(() => (window as any).app.openCompany('science-room'));
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    expect(await page.getByText('Research scientist', { exact: false }).isVisible()).toBe(true);
    expect(await page.locator('dialog img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
    await page.getByRole('button', { name: 'Invite to channel', exact: true }).click();
    expect(await page.evaluate(() => (window as any).calls.find((c: any) => c.path.endsWith('/invite')))).toEqual({
      path: '/api/company/employees/ada/invite',
      method: 'POST',
      body: { roomId: 'science-room' },
    });
    await page.locator('details summary').click();
    expect(await page.getByText('Actual experiment report', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText('Hypothesis: A possible next experiment', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText('Observed (agent reported): Experiment result', { exact: true }).isVisible()).toBe(
      true
    );
    expect(await page.getByText('tool receipt: actual experiment.log', { exact: true }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
  });

  it('shows owner research controls with actual defaults and hides hiring from agent callers', async () => {
    await page.evaluate(() => (window as any).app.openCompany());
    expect(await page.getByLabel('IANA timezone').inputValue()).toBe('UTC');
    expect(await page.getByLabel('Research minutes per employee (1–120)').inputValue()).toBe('60');
    expect(await page.getByLabel('Enable dedicated tool-capable research sessions').isChecked()).toBe(false);
    await page.getByLabel('Enable dedicated tool-capable research sessions').check();
    await page.getByRole('button', { name: 'Save research schedule' }).click();
    expect(
      await page.evaluate(() => (window as any).calls.find((c: any) => c.path === '/api/company/settings').body.enabled)
    ).toBe(true);
    await page.evaluate(async () => {
      const w = window as any;
      w.companyData.canManage = false;
      await w.app._renderCompany();
    });
    expect(await page.getByRole('button', { name: 'Hire registered session' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Assign CTO' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Invite to channel' }).isVisible()).toBe(true);
  });
});
