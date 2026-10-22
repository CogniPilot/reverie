import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const sessionId = '0000002d-0035-4000-8000-000000000047';
const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
});

async function setup({ verified = true, canManage = true, onVacation = false, actualDialog = false } = {}) {
  const employee = {
    id: 'expert/one',
    name: 'River',
    icon: 'R',
    position: 'Reviewer',
    sessionId,
    available: !onVacation,
    reportsTo: 'owner',
    onVacation,
    permissions: { recoverEmployees: true },
  };
  const data: any = {
    canManage,
    settings: { ownerName: 'Owner', crashWakeEmployeeId: employee.id },
    employees: [employee],
  };
  const h = await createHarness({
    sessions: [{ id: sessionId, name: employee.name, mode: 'codex' }],
    rooms: [room('office', 'Office', [member(sessionId, employee.name)])],
    company: data,
  });
  opened.push(h);
  const previous = h.app._chatApi.bind(h.app);
  const calls: any[] = [];
  let finish: any;
  let fail: any;
  h.app._chatApi = async (path: string, opts: any) => {
    if (path === '/api/company' && !opts) return { ok: true, data };
    if (path === '/api/chatrooms/phone-status')
      return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
    if (/\/employees\/.*\/(vacation|retire)$/.test(path)) {
      calls.push({ path, ...opts });
      return await new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    }
    return previous(path, opts);
  };
  const nativeConfirm = vi.spyOn(h.window, 'confirm').mockImplementation(() => {
    throw new Error('Native confirmation must not be used');
  });
  const confirm = vi.spyOn(h.shell, 'confirmCompanyAction');
  if (!actualDialog) confirm.mockResolvedValue(true);
  await h.shell.openCompany('people');
  const button = (label: string) =>
    h.document.querySelector(`.ca-company-person button[aria-label="${label}"]`) as HTMLButtonElement;
  const error = () => h.document.querySelector('.ca-company-person [role="alert"]')!.textContent;
  return {
    h,
    data,
    employee,
    calls,
    confirm,
    nativeConfirm,
    button,
    error,
    resolve: (value: any) => finish(value),
    reject: () => fail(new Error('Network lost')),
  };
}

it.each([{ verified: false }, { canManage: false }])(
  'only a verified company owner sees lifecycle controls (%j)',
  async (access) => {
    const { h } = await setup(access);
    expect(h.document.querySelector('.ca-company-person .ca-company-actions')).toBeNull();
  }
);

it.each([
  { onVacation: false, label: 'Send on vacation: River', meaning: 'pauses their session' },
  { onVacation: true, label: 'Return from vacation: River', meaning: 'eligible for recovery again' },
  { onVacation: false, label: 'Retire River', meaning: 'keeping their identity in chat history' },
])('names the expert and explains $label before any change', async ({ onVacation, label, meaning }) => {
  const { h, button, confirm, calls } = await setup({ onVacation });
  confirm.mockResolvedValue(false);
  button(label).click();
  await h.flush();
  expect(confirm).toHaveBeenCalledWith('River', expect.stringContaining(meaning), expect.any(String));
  expect(calls).toHaveLength(0);
  expect(button(label).disabled).toBe(false);
});

it('pauses once, blocks competing actions, and refreshes vacation state and recovery controls', async () => {
  const { h, employee, button, calls, resolve } = await setup();
  const pause = button('Send on vacation: River');
  const retire = button('Retire River');
  pause.click();
  await h.flush();
  pause.dispatchEvent(new h.window.Event('click'));
  retire.dispatchEvent(new h.window.Event('click'));
  expect(calls).toEqual([
    { path: '/api/company/employees/expert%2Fone/vacation', method: 'POST', body: { enabled: true } },
  ]);
  expect(pause.disabled).toBe(true);
  expect(retire.disabled).toBe(true);
  employee.onVacation = true;
  employee.available = false;
  resolve({ ok: true, data: { employee } });
  await h.flush();
  expect(h.document.querySelector('.ca-company-state')!.textContent).toBe('On vacation');
  expect(button('Return from vacation: River')).not.toBeNull();
  expect(h.document.querySelector('[aria-label="Recovery permission for River"]')!.disabled).toBe(true);
  const choices = h.document.querySelector('[aria-label="Wake after a crash"]')!;
  expect([...choices.options].map((option: any) => option.value)).not.toContain(employee.id);
  expect(choices.textContent).not.toContain('Automatic: River');
  expect(h.document.querySelector('.ca-company > [role="status"]')!.textContent).toBe('River is on vacation.');
});

it('returns the same expert to active status and recovery eligibility', async () => {
  const { h, employee, button, calls, resolve } = await setup({ onVacation: true });
  button('Return from vacation: River').click();
  await h.flush();
  expect(calls[0]).toMatchObject({ path: '/api/company/employees/expert%2Fone/vacation', body: { enabled: false } });
  employee.onVacation = false;
  resolve({ ok: true, data: { employee } });
  await h.flush();
  expect(button('Send on vacation: River')).not.toBeNull();
  expect(h.document.querySelector('[aria-label="Recovery permission for River"]')!.disabled).toBe(false);
  expect(
    [...h.document.querySelector('[aria-label="Wake after a crash"]')!.options].map((option: any) => option.value)
  ).toContain(employee.id);
  expect(h.document.querySelector('.ca-company > [role="status"]')!.textContent).toBe('River returned from vacation.');
});

it('retirement reuses the endpoint and removes the expert only after server success', async () => {
  const { h, data, button, calls, resolve } = await setup();
  button('Retire River').click();
  await h.flush();
  expect(calls[0]).toEqual({ path: '/api/company/employees/expert%2Fone/retire', method: 'POST', body: {} });
  expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(1);
  data.employees = [];
  resolve({ ok: true, data: { rooms: ['office'], failed: [] } });
  await h.flush();
  expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(0);
  expect(h.document.querySelector('.ca-company > [role="status"]')!.textContent).toBe('Retired River.');
});

it('surfaces server refusal and permits retry without changing the roster', async () => {
  const { h, button, calls, error, resolve } = await setup();
  button('Retire River').click();
  await h.flush();
  resolve({ ok: false, error: 'Reassign reports before retiring their manager' });
  await h.flush();
  expect(error()).toBe('Reassign reports before retiring their manager');
  expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(1);
  expect(button('Retire River').disabled).toBe(false);
  button('Retire River').click();
  await h.flush();
  expect(calls).toHaveLength(2);
  resolve({ ok: false, error: 'Still refused' });
  await h.flush();
});

it('reports a network failure and restores controls for another attempt', async () => {
  const { h, button, error, reject } = await setup();
  button('Send on vacation: River').click();
  await h.flush();
  reject();
  await h.flush();
  expect(error()).toBe('Could not update River. Try again.');
  expect(button('Send on vacation: River').disabled).toBe(false);
  expect(h.document.querySelector('.ca-company-state')!.textContent).toBe('Connected');
});

it('does not offer to repeat a saved change when the subsequent refresh fails', async () => {
  const { h, button, calls, resolve } = await setup();
  vi.spyOn(h.shell, 'loadOwner').mockRejectedValueOnce(new Error('Refresh failed'));
  const pause = button('Send on vacation: River');
  pause.click();
  await h.flush();
  resolve({ ok: true, data: {} });
  await h.flush();
  expect(h.document.querySelector('.ca-company > [role="status"]')!.textContent).toBe(
    'River is on vacation. The view could not refresh. Reopen Company to see the updated roster.'
  );
  expect(pause.disabled).toBe(true);
  pause.dispatchEvent(new h.window.Event('click'));
  expect(calls).toHaveLength(1);
});

it('surfaces incomplete room cleanup after successful retirement', async () => {
  const { h, data, button, resolve } = await setup();
  button('Retire River').click();
  await h.flush();
  data.employees = [];
  resolve({ ok: true, data: { rooms: [], failed: ['office'] } });
  await h.flush();
  expect(h.document.querySelector('.ca-company > [role="status"]')!.textContent).toBe(
    'Retired River. Some room removals failed; this expert may still appear in those rooms.'
  );
});

it.each([
  { onVacation: false, action: 'Send on vacation: River', confirmLabel: 'Send on vacation' },
  { onVacation: true, action: 'Return from vacation: River', confirmLabel: 'Return from vacation' },
  { onVacation: false, action: 'Retire River', confirmLabel: 'Retire' },
])(
  'uses an in-app dialog for $confirmLabel with Cancel focused and no native prompt',
  async ({ onVacation, action, confirmLabel }) => {
    const { h, button, calls, nativeConfirm } = await setup({ onVacation, actualDialog: true });
    button(action).click();
    const dialog = h.document.querySelector('dialog.ca-company-confirm')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe(`${confirmLabel}: River`);
    expect(dialog.textContent).toContain('River');
    expect([...dialog.querySelectorAll('button')].map((item: any) => item.textContent)).toEqual([
      'Cancel',
      confirmLabel,
    ]);
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
    expect(h.document.activeElement).toBe(dialog.querySelector('[aria-label="Cancel"]'));
    expect(calls).toHaveLength(0);
    dialog.querySelector('[aria-label="Cancel"]').click();
    await h.flush();
    expect(h.document.querySelector('.ca-company-confirm')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(button(action).disabled).toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
  }
);

it('guards competing actions before awaiting confirmation and sends only after one explicit acceptance', async () => {
  const { h, button, calls, resolve, nativeConfirm } = await setup({ actualDialog: true });
  const pause = button('Send on vacation: River');
  pause.click();
  pause.dispatchEvent(new h.window.Event('click'));
  button('Retire River').dispatchEvent(new h.window.Event('click'));
  expect(h.document.querySelectorAll('.ca-company-confirm')).toHaveLength(1);
  expect(calls).toHaveLength(0);
  const accept = h.document.querySelector('.ca-company-confirm [aria-label="Send on vacation"]')!;
  accept.click();
  accept.dispatchEvent(new h.window.Event('click'));
  await h.flush();
  expect(calls).toEqual([
    { path: '/api/company/employees/expert%2Fone/vacation', method: 'POST', body: { enabled: true } },
  ]);
  expect(nativeConfirm).not.toHaveBeenCalled();
  resolve({ ok: false, error: 'Synthetic refusal' });
  await h.flush();
});

it.each(['cancel', 'close', 'navigation'])('safely cancels the pending action on %s', async (reason) => {
  const { h, button, calls } = await setup({ actualDialog: true });
  button('Retire River').click();
  const dialog = h.document.querySelector('.ca-company-confirm')!;
  if (reason === 'navigation') h.shell.closePage();
  else if (reason === 'close') dialog.close();
  else dialog.dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
  await h.flush();
  expect(h.document.querySelector('.ca-company-confirm')).toBeNull();
  expect(calls).toHaveLength(0);
  if (reason !== 'navigation') expect(button('Retire River').disabled).toBe(false);
});
