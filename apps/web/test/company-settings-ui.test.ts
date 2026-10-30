import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';

const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
  vi.restoreAllMocks();
});
async function setup(verified = true) {
  const data: any = {
    canManage: true,
    settings: {
      owner: 'owner',
      ownerName: 'Alex',
      ownerTitle: 'Founder',
      enabled: false,
      nightHour: 2,
      morningHour: 8,
      researchMinutes: 30,
    },
    employees: [{ id: 'expert', name: 'River', expertise: ['Review'], position: 'Reviewer' }],
    cycles: [
      {
        date: '2026-10-22',
        employeeId: 'expert',
        kind: 'research',
        state: 'completed',
        result: {
          summary: '<img src=x onerror=alert(1)> A report',
          findings: [
            { status: 'observed', text: 'Measured result', evidence: ['receipt: test.log'] },
            { status: 'hypothesis', text: 'An idea', evidence: [] },
          ],
        },
      },
    ],
  };
  const h = await createHarness({ company: data });
  opened.push(h);
  const calls: any[] = [];
  h.app._chatApi = vi.fn(async (path: string, options?: any) => {
    calls.push({ path, ...options });
    if (path === '/api/chatrooms/phone-status')
      return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
    if (path === '/api/company/settings') {
      Object.assign(data.settings, options.body);
      return { ok: true, data: { settings: data.settings } };
    }
    return { ok: true, data };
  });
  const native = vi.spyOn(h.window, 'confirm').mockImplementation(() => {
    throw new Error('No native dialogs');
  });
  return { h, data, calls, native };
}
const submit = (h: any) =>
  h.document
    .querySelector('.ca-company-settings .ca-company-settings-form')
    .dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));

it('opens styled settings within Company without the legacy registration or nightly schedule UI', async () => {
  const { h, native } = await setup();
  h.app.openLegacyCompany = vi.fn();
  await h.shell.openCompany();
  h.document.querySelector('[aria-label="Company settings"]').click();
  await h.flush();
  const dialog = h.document.querySelector('dialog.ca-company-settings')!;
  expect(dialog.open).toBe(true);
  expect(h.document.querySelector('.ca-company')).not.toBeNull();
  expect(h.app.openLegacyCompany).not.toHaveBeenCalled();
  expect(h.document.querySelector('.reverie-company-dialog')).toBeNull();
  expect(dialog.querySelector('[aria-label="Owner display name"]').value).toBe('Alex');
  expect(dialog.querySelector('[aria-label="Owner title"]').value).toBe('Founder');
  for (const label of [
    'Hire registered session',
    'Existing owned agent session ID',
    'Night hour',
    'Save research schedule',
    'Enable dedicated tool-capable research sessions',
  ])
    expect(dialog.textContent).not.toContain(label);
  expect(dialog.querySelector('[name="sessionId"], [name="icon"]')).toBeNull();
  expect(dialog.querySelector('[aria-label="Automatic recovery"]')).not.toBeNull();
  expect(dialog.querySelector('.ca-company-settings-form input[type="checkbox"]')).toBeNull();
  h.document.querySelector('[aria-label="Close company settings"]').click();
  await h.flush();
  expect(h.document.querySelector('.ca-company-settings')).toBeNull();
  expect(native).not.toHaveBeenCalled();
});

it('saves owner details using fresh settings without enabling or changing the legacy scheduler', async () => {
  const { h, data, calls } = await setup();
  await h.shell.openCompanySettings();
  const dialog = h.document.querySelector('.ca-company-settings')!;
  dialog.querySelector('[aria-label="Owner display name"]').value = ' Morgan ';
  dialog.querySelector('[aria-label="Owner title"]').value = ' Owner ';
  data.settings.researchMinutes = 45;
  data.settings.ownerAvatar = '/api/owner-avatar/00000000000000000000000000000000';
  submit(h);
  submit(h);
  await h.flush();
  const writes = calls.filter((call) => call.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual({
    path: '/api/company/settings',
    method: 'PUT',
    body: {
      ownerName: 'Morgan',
      ownerTitle: 'Owner',
      enabled: false,
      nightHour: 2,
      morningHour: 8,
      researchMinutes: 45,
    },
  });
  expect(dialog.querySelector('[role=status]').textContent).toBe('Owner details saved.');
});

it('keeps research receipts collapsed, renders evidence literally, and refreshes without writes', async () => {
  const { h, data, calls } = await setup();
  await h.shell.openCompanySettings();
  const receipts = h.document.querySelector('.ca-company-settings-receipts')!;
  expect(receipts.open).toBe(false);
  expect(receipts.querySelector('img')).toBeNull();
  expect(receipts.textContent).toContain('<img src=x onerror=alert(1)> A report');
  expect(receipts.textContent).toContain('Observed (agent reported): Measured result');
  expect(receipts.textContent).toContain('Hypothesis: An idea');
  expect(receipts.querySelector('pre').textContent).toBe('receipt: test.log');
  data.cycles = [];
  receipts.querySelector('[aria-label="Refresh research receipts"]').click();
  await h.flush();
  expect(receipts.textContent).toContain('No research receipts yet.');
  expect(calls.some((call) => call.method === 'PUT' || call.method === 'POST')).toBe(false);
});

it('preserves owner draft values and surfaces server refusal without enabling a scheduler', async () => {
  const { h, calls } = await setup();
  await h.shell.openCompanySettings();
  const api = h.app._chatApi;
  h.app._chatApi = async (path: string, options: any) =>
    path === '/api/company/settings' ? { ok: false, error: 'Owner sign-in required' } : api(path, options);
  h.document.querySelector('.ca-company-settings [aria-label="Owner display name"]').value = 'Draft';
  submit(h);
  await h.flush();
  expect(h.document.querySelector('.ca-company-settings [role=alert]').textContent).toBe('Owner sign-in required');
  expect(h.document.querySelector('.ca-company-settings [aria-label="Owner display name"]').value).toBe('Draft');
  expect(h.document.querySelector('.ca-company-settings-form button[type=submit]').disabled).toBe(false);
  expect(calls.some((call) => call.method === 'POST')).toBe(false);
});

it('does not expose owner editing when the caller is not verified', async () => {
  const { h } = await setup(false);
  await h.shell.openCompanySettings();
  expect(h.document.querySelector('.ca-company-settings .ca-company-settings-form')).toBeNull();
  expect(h.document.querySelector('.ca-company-settings-receipts')).not.toBeNull();
});

it('offers this device’s app install and notifications to every viewer, even when the company fails to load', async () => {
  for (const verified of [true, false]) {
    const { h } = await setup(verified);
    const open = vi.fn();
    (h.window as any).ReverieMobile = { open };
    await h.shell.openCompanySettings();
    const device = h.document.querySelector('.ca-company-settings .ca-company-device');
    expect(device?.querySelector('h3')?.textContent).toBe('This device');
    (device!.querySelector('button') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledTimes(1);
    h.document.querySelector('.ca-company-settings')!.remove();
  }
  const { h } = await setup();
  (h.window as any).ReverieMobile = { open: vi.fn() };
  h.app._chatApi = vi.fn(async () => ({ ok: false, error: 'Company settings are unavailable.' }));
  await h.shell.openCompanySettings();
  expect(h.document.querySelector('.ca-company-settings .ca-company-device button')?.textContent).toBe('Install app and notifications');
});

it('shows no device section where the phone setup script is not loaded', async () => {
  const { h } = await setup();
  delete (h.window as any).ReverieMobile;
  await h.shell.openCompanySettings();
  expect(h.document.querySelector('.ca-company-device')).toBeNull();
});
