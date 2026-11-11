/**
 * The owner's Hiring section in Company settings (James 10-23): who may hire for the owner, the two hire caps with their
 * current use, and the active hires, flagging any whose session is gone. PUT /api/experts-settings replaces the whole
 * settings object, so a save starts from a fresh read and changes only the delegates and the caps.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';

const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
  vi.restoreAllMocks();
});

const ADA = { id: 'emp-ada', name: 'Ada', position: 'Builder', sessionId: 'sess-ada' };
const BO = { id: 'emp-bo', name: 'Bo', position: 'Reviewer', sessionId: 'sess-bo' };
const HOUR = 3_600_000;

async function setup({ verified = true, experts = true, retained = false, storageUncertain = false } = {}) {
  const company: any = {
    canManage: true,
    settings: { owner: 'owner', ownerName: 'Alex', timeZone: 'UTC' },
    employees: [ADA, BO],
  };
  const settings: any = {
    hireDelegates: ['sess-bo', 'sess-gone-1234'],
    maxHiresPerDay: 2,
    maxActive: 5,
    noticeRoomId: 'room-notice',
    requireBudgetStopForDelegates: true,
  };
  const state: any = {
    storageUncertain,
    experts: [{ id: 'reviewer', name: 'Reviewer' }],
    hires: [
      {
        id: 'h1',
        templateId: 'reviewer',
        sessionId: 'sess-hired',
        employeeId: 'emp-hired',
        by: 'agent:sess-bo',
        reason: 'Review the parser',
        hiredAt: Date.now() - HOUR,
        status: 'active',
        sessionLive: true,
        ...(retained ? { startup: { phase: 'recovery-required', sessionGeneration: 1 }, notice: 'unconfirmed' } : {}),
      },
      {
        id: 'h2',
        templateId: 'reviewer',
        sessionId: 'sess-lost',
        employeeId: 'emp-lost',
        by: 'owner',
        reason: 'Second opinion',
        hiredAt: Date.now() - 2 * HOUR,
        status: 'active',
        sessionLive: false,
      },
      {
        id: 'h3',
        templateId: 'reviewer',
        sessionId: 'sess-old',
        employeeId: 'emp-old',
        by: 'owner',
        reason: 'Old work',
        hiredAt: Date.now() - 50 * HOUR,
        status: 'retired',
      },
    ],
  };
  const h = await createHarness({ company });
  opened.push(h);
  const puts: any[] = [];
  let reads = 0;
  h.app._chatApi = vi.fn(async (path: string, options?: any) => {
    if (path === '/api/chatrooms/phone-status')
      return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
    if (path === '/api/experts') {
      reads++;
      if (!experts) return { ok: false, status: 503, error: 'HTTP 503' };
      return {
        ok: true,
        data: {
          ...state,
          settings: { ...settings },
          limits: {
            hiresLast24h: 1,
            maxHiresPerDay: settings.maxHiresPerDay,
            active: 2,
            maxActive: settings.maxActive,
          },
        },
      };
    }
    if (path === '/api/experts-settings/hiring-limits') {
      puts.push(options.body);
      Object.assign(settings, options.body.limits);
      return { ok: true, data: { settings } };
    }
    return { ok: true, data: company };
  });
  await h.shell.openCompany();
  const opener = h.document.querySelector('[aria-label="Company settings"]') as HTMLButtonElement | null;
  if (opener) opener.click();
  else void h.shell.openCompanySettings();
  await h.flush();
  await h.flush();
  const form = () => h.document.querySelector('.ca-company-settings .ca-company-hiring') as HTMLFormElement | null;
  const submit = async () => {
    form()!.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush();
    await h.flush();
  };
  const boxes = () => [...form()!.querySelectorAll('input[name="hireDelegate"]')] as HTMLInputElement[];
  return { h, settings, puts, form, submit, boxes, reads: () => reads };
}

it('shows company limits and history, and puts individual hiring permissions on employee profiles', async () => {
  const { form, boxes } = await setup();
  const text = form()!.textContent!;
  expect(text).toContain('In the last 24 hours: 1 of 2 hires. Active now: 2 of 5.');
  expect((form()!.querySelector('[aria-label="Hires in any 24 hours"]') as HTMLInputElement).value).toBe('2');
  expect((form()!.querySelector('[aria-label="Active hires at most"]') as HTMLInputElement).value).toBe('5');
  expect(boxes()).toEqual([]);
  expect(text).toContain('profile’s Permissions tab');
  const records = [...form()!.querySelectorAll('.ca-company-hire-record')].map((r) => r.textContent);
  expect(records).toHaveLength(2); // the retired hire is not listed
  expect(records[0]).toContain('hired by Bo');
  expect(records[0]).toContain('Review the parser');
  expect(records[0]).not.toContain('no longer exists');
  expect(records[1]).toContain('hired by you');
  expect(records[1]).toContain('The original hire session is not present. Check the employee profile');
});

it('shows retained startup separately from presence and does not offer writes after storage uncertainty', async () => {
  const { form, submit, puts } = await setup({ retained: true, storageUncertain: true });
  const record = form()!.querySelector('.ca-company-hire-record')!;
  expect(record.textContent).toContain('Startup recovery-required. Identity retained.');
  expect(record.textContent).toContain('notice or audit confirmation is unavailable');
  expect(form()!.querySelector('[role="alert"]')!.textContent).toContain('A hiring write was not confirmed');
  expect((form()!.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await submit();
  expect(puts).toEqual([]);
});

it('saves only caps with a checked baseline, keeping all hiring permissions', async () => {
  const { form, submit, puts, reads, settings } = await setup();
  (form()!.querySelector('[aria-label="Hires in any 24 hours"]') as HTMLInputElement).value = '4';
  (form()!.querySelector('[aria-label="Active hires at most"]') as HTMLInputElement).value = '8';
  const before = reads();
  await submit();
  expect(reads()).toBeGreaterThan(before); // re-read before the write
  expect(puts).toEqual([
    { expected: { maxHiresPerDay: 2, maxActive: 5 }, limits: { maxHiresPerDay: 4, maxActive: 8 } },
  ]);
  expect(settings.hireDelegates).toEqual(['sess-bo', 'sess-gone-1234']);
  expect(form()!.querySelector('[role="status"]')!.textContent).toBe('Hiring settings saved.');
});

it('does not overwrite delegates or caps changed elsewhere since the section loaded; it shows them again', async () => {
  const { form, submit, settings, puts } = await setup();
  settings.maxActive = 9; // another owner session saved meanwhile
  await submit();
  expect(puts).toEqual([]);
  expect(form()!.querySelector('[role="alert"]')!.textContent).toContain('changed elsewhere');
  expect((form()!.querySelector('[aria-label="Active hires at most"]') as HTMLInputElement).value).toBe('9');
  await submit();
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ expected: { maxActive: 9 }, limits: { maxActive: 9 } });
});

it('refuses a cap out of range without a request', async () => {
  const { form, submit, puts } = await setup();
  (form()!.querySelector('[aria-label="Hires in any 24 hours"]') as HTMLInputElement).value = '21';
  await submit();
  expect(puts).toEqual([]);
});

it('cannot save when the settings could not be read', async () => {
  const { form, puts } = await setup({ experts: false });
  expect(form()!.querySelector('[role="alert"]')!.textContent).toBe(
    'Hiring settings could not be loaded. Reopen Company settings to try again.'
  );
  expect((form()!.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  expect(puts).toEqual([]);
});

it('is not offered to someone who is not the signed-in owner', async () => {
  const { form, reads } = await setup({ verified: false });
  expect(form()).toBeNull();
  expect(reads()).toBe(0);
});

it('edits hiring on the employee profile and requires a refresh after a lost save reply', async () => {
  const { h } = await setup();
  const path = '/api/company/employees/emp-ada/hiring-permission';
  const writes: any[] = [];
  let selected = false;
  const previous = h.app._chatApi;
  h.app._chatApi = async (url: string, request?: any) => {
    if (url !== path) return previous(url, request);
    if (request?.method === 'PUT') {
      writes.push(request.body);
      selected = request.body.enabled;
      throw new Error('lost save reply');
    }
    return { ok: true, data: { employeeId: ADA.id, sessionId: ADA.sessionId, enabled: selected, source: selected ? 'employee' : 'none' } };
  };
  const dialog = h.document.createElement('dialog'), content = h.document.createElement('div');
  dialog.append(content); h.document.body.append(dialog);
  h.shell.employeeHiringFields(content, ADA, dialog); await h.flush();
  const input = content.querySelector('input') as HTMLInputElement;
  expect(input.checked).toBe(false);
  expect(writes).toEqual([]);
  input.click(); input.click(); await h.flush();
  expect(writes).toEqual([{ expectedSessionId: ADA.sessionId, expected: false, enabled: true }]);
  expect(input.disabled).toBe(true);
  expect(content.querySelector('[role="alert"]')?.textContent).toBe('lost save reply');
  (content.querySelector('button') as HTMLButtonElement).click(); await h.flush();
  expect(input.checked).toBe(true);
  expect(input.disabled).toBe(false);
  expect(writes).toHaveLength(1);
});

it('identifies a legacy session grant without claiming it follows employee moves or migrating it on read', async () => {
  const { h } = await setup();
  const writes: any[] = [];
  h.app._chatApi = async (_url: string, request?: any) => {
    if (request?.method === 'PUT') writes.push(request.body);
    return { ok: true, data: { employeeId: ADA.id, sessionId: ADA.sessionId, enabled: true, source: 'legacy-session' } };
  };
  const dialog = h.document.createElement('dialog'), content = h.document.createElement('div');
  dialog.append(content); h.document.body.append(dialog);
  h.shell.employeeHiringFields(content, ADA, dialog); await h.flush();
  expect(content.textContent).toContain('Legacy permission applies to this session only');
  expect(content.textContent).not.toContain('Permission follows');
  expect(writes).toEqual([]);
});
