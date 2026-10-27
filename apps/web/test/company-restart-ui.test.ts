import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
const sid = '0000002d-0035-4000-8000-000000000047';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
async function setup({ verified = true, missing = false } = {}) {
  const employee = { id: 'expert', sessionId: sid, name: 'Alex', available: !missing };
  const company = { canManage: true, employees: [employee], settings: {} };
  const h = await createHarness({ company, sessions: missing ? [] : [{ id: sid, name: 'Alex', mode: 'codex' }], rooms: [room('r1', 'Office', [member(sid, 'Alex')])] }); opened.push(h);
  const original = h.app._chatApi.bind(h.app); const calls: any[] = []; let reply: any = { ok: true, data: { employee, sessionId: sid } }; let finish: any;
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    if (path === '/api/company') return { ok: true, data: company };
    if (path.endsWith('/restart') || path.endsWith('/vacation')) { calls.push({ path, ...options }); return reply ?? new Promise(resolve => { finish = resolve; }); }
    return original(path, options);
  };
  h.shell.company = company;
  h.shell.phoneStatus = { self: verified ? 'owner' : 'agent', canSetOwn: verified };
  const native = vi.spyOn(h.window, 'confirm').mockImplementation(() => { throw new Error('No native confirmations'); });
  const open = async () => { await h.shell.openEmployeeRestart(employee); await h.flush(); };
  const accept = () => h.document.querySelector('.ca-employee-restart .is-primary').click();
  return { h, employee, calls, open, accept, native, reply: (value: any) => { reply = value; }, resolve: (value: any) => finish(value) };
}
it('requires explicit styled confirmation and safely cancels with Cancel or Escape', async () => {
  const { h, calls, open, native } = await setup(); await open();
  expect(h.document.activeElement?.textContent).toBe('Cancel'); expect(calls).toHaveLength(0);
  expect(h.document.querySelector('.ca-employee-restart').textContent).toContain('Restart Alex');
  h.document.querySelector('.ca-employee-restart button').click(); await h.flush(); expect(calls).toHaveLength(0);
  await open(); h.document.querySelector('.ca-employee-restart').dispatchEvent(new h.window.Event('cancel', { cancelable: true })); await h.flush();
  expect(h.document.querySelector('.ca-employee-restart')).toBeNull(); expect(calls).toHaveLength(0); expect(native).not.toHaveBeenCalled();
});
it('uses the employee identity to restart a missing runtime and suppresses parallel submits', async () => {
  const { h, calls, open, accept, reply, resolve } = await setup({ missing: true }); reply(null); await open(); accept(); accept();
  expect(calls).toEqual([{ path: '/api/company/employees/expert/restart', method: 'POST', body: {} }]);
  await open(); expect(h.document.querySelectorAll('.ca-employee-restart')).toHaveLength(1);
  resolve({ ok: true, data: { sessionId: sid } }); await h.flush(); expect(h.document.querySelector('.ca-employee-restart')).toBeNull();
  expect(h.app.toasts.some((toast: any) => toast.text === 'Session restarted for Alex.')).toBe(true);
});
it.each([false, true])('permits a deliberate retry after HTTP refusal (recovery=%s)', async (recovery) => {
  const { h, calls, open, accept, reply } = await setup(); reply({ ok: false, status: 400, error: 'Choose runtime settings first, then retry the restart.' });
  await open();
  if (recovery) h.document.querySelector('.ca-employee-restart input[type="checkbox"]').click();
  accept(); await h.flush();
  expect(h.document.querySelector('.ca-employee-restart [role="alert"]').textContent).toContain('Choose runtime settings first');
  expect(h.document.querySelector('.ca-employee-restart .is-primary').disabled).toBe(false);
  reply({ ok: true }); accept(); await h.flush(); expect(calls).toHaveLength(2); expect(h.document.querySelector('.ca-employee-restart')).toBeNull();
});
it('rejects an unverified owner even with stale management permission', async () => {
  const { h, calls, open } = await setup({ verified: false }); await open();
  expect(h.document.querySelector('.ca-employee-restart .is-primary').disabled).toBe(true);
  expect(h.document.querySelector('.ca-employee-restart [role="alert"]').textContent).toContain('Sign in as the owner'); expect(calls).toHaveLength(0);
});
it('offers restart in the detailed Company profile and member context menu without changing identity', async () => {
  const { h } = await setup(); await h.shell.openCompany();
  expect(h.document.querySelector('.ca-company-chart [aria-label="Restart session for Alex"]')).toBeNull();
  h.document.querySelector('[aria-label="Edit profile for Alex"]').click(); await h.flush();
  h.document.querySelector('.ca-expert-profile [aria-label="Restart session for Alex"]').click(); await h.flush();
  expect(h.document.querySelector('.ca-employee-restart')).not.toBeNull(); h.document.querySelector('.ca-employee-restart button').click();
  h.shell.closePage(); h.document.querySelector('.ca-member').click();
  h.shell.openMemberMenu(member(sid, 'Alex'), h.document.querySelector('.ca-member'));
  const restart = [...h.document.querySelectorAll('.ca-member-menu button')].find(button => button.textContent === 'Restart session')!;
  expect(restart).not.toBeUndefined(); restart.click(); await h.flush(); expect(h.document.querySelector('.ca-employee-restart')).not.toBeNull();
});

it('keeps compact cards free of lifecycle actions and marks detailed-profile and member-menu actions as dangerous', async () => {
  const { h } = await setup(); await h.shell.openCompany();
  expect(h.document.querySelector('.ca-company-chart [aria-label="Restart session for Alex"]')).toBeNull();
  expect(h.document.querySelector('.ca-company-chart [aria-label="Leave office for Alex"]')).toBeNull();
  h.document.querySelector('[aria-label="Edit profile for Alex"]').click(); await h.flush();
  expect(h.document.querySelector('.ca-expert-profile [aria-label="Restart session for Alex"]').classList.contains('is-danger')).toBe(true);
  expect(h.document.querySelector('[aria-label="Leave office for Alex"]').classList.contains('is-danger')).toBe(true);
  h.shell.closePage(); const anchor = h.document.querySelector('.ca-member'); anchor.click();
  for (const name of ['Restart session', 'Leave office']) {
    const action = [...h.document.querySelectorAll('.ca-profile-actions button')].find(button => button.textContent === name)!;
    expect(action).toBeUndefined();
  }
  h.shell.openMemberMenu(member(sid, 'Alex'), anchor);
  for (const name of ['Restart session', 'Leave office']) {
    const action = [...h.document.querySelectorAll('.ca-popmenu button')].find(button => button.textContent === name)!;
    expect(action.classList.contains('is-danger')).toBe(true);
  }
});

it('warns that restart interrupts work without a fresh handoff, while retaining saved context', async () => {
  const { h, open } = await setup(); await open();
  expect(h.document.querySelector('.ca-employee-restart').textContent).toContain('Active work is interrupted without a fresh handoff');
  expect(h.document.querySelector('.ca-employee-restart').textContent).toContain('saved conversation, memory, files');
  expect(h.document.querySelector('.ca-employee-restart .is-primary').classList.contains('is-danger')).toBe(true);
});

it('quick leave requires explicit confirmation, stops the named employee once, and retains its identity', async () => {
  const { h, employee, calls, reply } = await setup();
  reply({ ok: true, data: { employee: { ...employee, onVacation: true, desiredRunning: false } } });
  const flight = h.shell.leaveEmployeeOffice(employee);
  void h.shell.leaveEmployeeOffice(employee);
  await h.flush();
  const dialog = h.document.querySelector('.ca-company-confirm');
  expect(dialog.textContent).toContain('Active work is interrupted without a fresh handoff');
  expect(h.document.activeElement?.textContent).toBe('Cancel'); expect(calls).toHaveLength(0);
  const accept = dialog.querySelector('[aria-label="Leave office"]');
  expect(accept.classList.contains('is-danger')).toBe(true); accept.click(); await flight;
  expect(calls).toEqual([{ path: '/api/company/employees/expert/vacation', method: 'POST', body: { enabled: true } }]);
  expect(employee).toMatchObject({ id: 'expert', sessionId: sid, onVacation: true, desiredRunning: false });
});

it.each([false, true])('quick leave sends no stop after cancellation or an unverified owner (%s)', async verified => {
  const { h, employee, calls } = await setup({ verified });
  const flight = h.shell.leaveEmployeeOffice(employee); await h.flush();
  if (verified) h.document.querySelector('.ca-company-confirm [aria-label="Cancel"]').click();
  await flight; expect(calls).toHaveLength(0);
});

it('places power on the Office page and uses the existing office-power workflow', async () => {
  const { h } = await setup(); h.app.officePower = vi.fn(async (_action, output) => { output.textContent = 'Shutdown confirmed by laptop manager'; });
  h.shell.openPage('office'); await h.flush();
  const actions = [...h.document.querySelectorAll('.ca-office-power button')];
  expect(actions.map(button => button.textContent)).toEqual(['Stop all agents', 'Restart website', 'Shut down Reverie']);
  expect(actions[0].classList.contains('is-danger')).toBe(true);
  expect(actions[1].classList.contains('is-danger')).toBe(false);
  expect(actions[2].classList.contains('is-danger')).toBe(true);
  actions[2].click(); await h.flush();
  expect(h.app.officePower).toHaveBeenCalledExactlyOnceWith('shutdown', h.document.querySelector('.ca-office-page > [role="status"]'));
  expect(h.document.querySelector('.ca-office-page > [role="status"]').textContent).toBe('Shutdown confirmed by laptop manager');
  await h.shell.openCompany(); expect(h.document.querySelector('.ca-company-power-button')).toBeNull();
});

it('never offers Office shutdown controls to an unverified owner', async () => {
  const { h } = await setup({ verified: false }); h.shell.openPage('office'); await h.flush();
  expect(h.document.querySelector('.ca-office-power')).toBeNull();
});

it('requires a separate owner choice before sending stalled-session recovery confirmation', async () => {
  const { h, calls, open, accept } = await setup(); await open();
  const recovery = h.document.querySelector('.ca-employee-restart input[type="checkbox"]');
  expect(recovery.checked).toBe(false); recovery.click();
  expect(h.document.querySelector('.ca-employee-restart .is-primary').textContent).toBe('Recover and restart');
  accept(); await h.flush();
  expect(calls).toEqual([{ path: '/api/company/employees/expert/restart', method: 'POST', body: { forceRestart: true, confirmSessionId: sid } }]);
});

it.each([['missing response', false], ['thrown transport error', false], ['missing response', true], ['thrown transport error', true]])('reports an unconfirmed restart after %s (recovery=%s) without another POST', async (failure, recovery) => {
  const { h, open, accept } = await setup();
  await open();
  if (recovery) h.document.querySelector('.ca-employee-restart input[type="checkbox"]').click();
  // Exercise the real _chatApi envelope handling instead of stubbing its Network error result.
  delete h.app._chatApi;
  const transport = vi.spyOn(h.app, '_api').mockImplementation(async () => {
    if (failure === 'thrown transport error') throw new Error('Connection closed');
    return null;
  });
  accept(); await h.flush();
  const dialog = h.document.querySelector('.ca-employee-restart');
  expect(dialog.querySelector('[role="alert"]').textContent).toBe('');
  expect(dialog.querySelector('[role="status"]').textContent).toContain('Restart could not be confirmed');
  expect(dialog.querySelector('[role="status"]').textContent).toContain('may already be restarting');
  expect(dialog.querySelector('[role="status"]').textContent).toContain('Check their status before trying again');
  expect(dialog.querySelector('.is-primary').disabled).toBe(true);
  expect(dialog.querySelector('button').textContent).toBe('Close');
  expect(dialog.querySelector('button').getAttribute('aria-label')).toBe('Close');
  expect(h.app.toasts.some((toast: any) => toast.text === 'Session restarted for Alex.')).toBe(false);
  accept(); await h.flush();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith('/api/company/employees/expert/restart', { method: 'POST', body: recovery ? { forceRestart: true, confirmSessionId: sid } : {} });
  dialog.querySelector('button').click(); await h.flush();
  expect(h.document.querySelector('.ca-employee-restart')).toBeNull();
});
