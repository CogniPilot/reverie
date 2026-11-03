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

async function setup({ verified = true, experts = true } = {}) {
  const company: any = { canManage: true, settings: { owner: 'owner', ownerName: 'Alex', timeZone: 'UTC' }, employees: [ADA, BO] };
  const settings: any = { hireDelegates: ['sess-bo', 'sess-gone-1234'], maxHiresPerDay: 2, maxActive: 5, noticeRoomId: 'room-notice',
    requireBudgetStopForDelegates: true };
  const state: any = {
    experts: [{ id: 'reviewer', name: 'Reviewer' }],
    hires: [
      { id: 'h1', templateId: 'reviewer', sessionId: 'sess-hired', employeeId: 'emp-hired', by: 'agent:sess-bo', reason: 'Review the parser', hiredAt: Date.now() - HOUR, status: 'active', sessionLive: true },
      { id: 'h2', templateId: 'reviewer', sessionId: 'sess-lost', employeeId: 'emp-lost', by: 'owner', reason: 'Second opinion', hiredAt: Date.now() - 2 * HOUR, status: 'active', sessionLive: false },
      { id: 'h3', templateId: 'reviewer', sessionId: 'sess-old', employeeId: 'emp-old', by: 'owner', reason: 'Old work', hiredAt: Date.now() - 50 * HOUR, status: 'retired' },
    ],
  };
  const h = await createHarness({ company });
  opened.push(h);
  const puts: any[] = [];
  let reads = 0;
  h.app._chatApi = vi.fn(async (path: string, options?: any) => {
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
    if (path === '/api/experts') {
      reads++;
      if (!experts) return { ok: false, status: 503, error: 'HTTP 503' };
      return { ok: true, data: { ...state, settings: { ...settings },
        limits: { hiresLast24h: 1, maxHiresPerDay: settings.maxHiresPerDay, active: 2, maxActive: settings.maxActive } } };
    }
    if (path === '/api/experts-settings') {
      puts.push(options.body);
      Object.assign(settings, options.body);
      return { ok: true, data: { settings } };
    }
    return { ok: true, data: company };
  });
  await h.shell.openCompany();
  const opener = h.document.querySelector('[aria-label="Company settings"]') as HTMLButtonElement | null;
  if (opener) opener.click(); else void h.shell.openCompanySettings();
  await h.flush(); await h.flush();
  const form = () => h.document.querySelector('.ca-company-settings .ca-company-hiring') as HTMLFormElement | null;
  const submit = async () => {
    form()!.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush(); await h.flush();
  };
  const boxes = () => [...form()!.querySelectorAll('input[name="hireDelegate"]')] as HTMLInputElement[];
  return { h, settings, puts, form, submit, boxes, reads: () => reads };
}

it('shows the caps with their use, the delegates from the roster, and the active hires with a gone session flagged', async () => {
  const { form, boxes } = await setup();
  const text = form()!.textContent!;
  expect(text).toContain('In the last 24 hours: 1 of 2 hires. Active now: 2 of 5.');
  expect((form()!.querySelector('[aria-label="Hires in any 24 hours"]') as HTMLInputElement).value).toBe('2');
  expect((form()!.querySelector('[aria-label="Active hires at most"]') as HTMLInputElement).value).toBe('5');
  expect(boxes().map((b) => [b.value, b.checked, b.parentElement!.textContent])).toEqual([
    ['sess-ada', false, 'Ada · Builder'],
    ['sess-bo', true, 'Bo · Reviewer'],
    ['sess-gone-1234', true, 'Session sess-gon (no current expert)'],
  ]);
  const records = [...form()!.querySelectorAll('.ca-company-hire-record')].map((r) => r.textContent);
  expect(records).toHaveLength(2); // the retired hire is not listed
  expect(records[0]).toContain('hired by Bo');
  expect(records[0]).toContain('Review the parser');
  expect(records[0]).not.toContain('no longer exists');
  expect(records[1]).toContain('hired by you');
  expect(records[1]).toContain('Its session no longer exists. It still counts as active until it is retired.');
});

it('saves the delegates and caps on a fresh read, keeping every other setting', async () => {
  const { form, submit, boxes, puts, reads } = await setup();
  boxes()[0].checked = true; // add Ada
  boxes()[2].checked = false; // drop the stale session
  (form()!.querySelector('[aria-label="Hires in any 24 hours"]') as HTMLInputElement).value = '4';
  (form()!.querySelector('[aria-label="Active hires at most"]') as HTMLInputElement).value = '8';
  const before = reads();
  await submit();
  expect(reads()).toBeGreaterThan(before); // re-read before the write
  expect(puts).toEqual([{ hireDelegates: ['sess-ada', 'sess-bo'], maxHiresPerDay: 4, maxActive: 8, noticeRoomId: 'room-notice',
    requireBudgetStopForDelegates: true }]);
  expect(form()!.querySelector('[role="status"]')!.textContent).toBe('Hiring settings saved.');
});

it('does not overwrite delegates or caps changed elsewhere since the section loaded; it shows them again', async () => {
  const { form, submit, boxes, settings, puts } = await setup();
  boxes()[0].checked = true;
  settings.maxActive = 9; // another owner session saved meanwhile
  await submit();
  expect(puts).toEqual([]);
  expect(form()!.querySelector('[role="alert"]')!.textContent).toContain('changed elsewhere');
  expect((form()!.querySelector('[aria-label="Active hires at most"]') as HTMLInputElement).value).toBe('9');
  expect(boxes()[0].checked).toBe(false); // the shown state is the fresh one
  boxes()[0].checked = true;
  await submit();
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ hireDelegates: ['sess-ada', 'sess-bo', 'sess-gone-1234'], maxActive: 9 });
});

it('refuses a cap out of range without a request', async () => {
  const { form, submit, puts } = await setup();
  (form()!.querySelector('[aria-label="Hires in any 24 hours"]') as HTMLInputElement).value = '21';
  await submit();
  expect(puts).toEqual([]);
});

it('cannot save when the settings could not be read', async () => {
  const { form, puts } = await setup({ experts: false });
  expect(form()!.querySelector('[role="alert"]')!.textContent).toBe('Hiring settings could not be loaded. Reopen Company settings to try again.');
  expect((form()!.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  expect(puts).toEqual([]);
});

it('is not offered to someone who is not the signed-in owner', async () => {
  const { form, reads } = await setup({ verified: false });
  expect(form()).toBeNull();
  expect(reads()).toBe(0);
});
