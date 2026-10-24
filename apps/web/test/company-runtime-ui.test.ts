import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

const sid = '0000002d-0035-4000-8000-000000000047';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
async function setup(verified = true, current: any = { mode: 'codex', source: { kind: 'subscription', profileId: 'work' }, model: 'saved-model', effort: 'high' }) {
  const employee = { id: 'expert', sessionId: sid, name: 'Alex', available: true };
  const company = { canManage: true, settings: {}, employees: [employee] };
  const h = await createHarness({ company, sessions: [{ id: sid, name: 'Alex', mode: 'codex' }], rooms: [room('r1', 'Office', [member(sid, 'Alex')])] }); opened.push(h);
  const calls: any[] = []; let refusal = '';
  h.app._chatApi = vi.fn(async (path: string, opts?: any) => {
    if (opts?.method === 'POST') { calls.push({ path, ...opts }); return refusal ? { ok: false, error: refusal } : { ok: true, data: opts.body }; }
    if (path.endsWith('/runtime')) return { ok: true, data: current };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    if (path === '/api/company/hire-options') return { ok: true, data: { harnesses: [{ id: 'codex', label: 'Codex', efforts: ['low', 'high'] }, { id: 'custom-cli', label: 'Research CLI', efforts: ['deep'] }], sources: [{ kind: 'subscription', id: 'work', label: 'Work plan', modes: ['codex', 'custom-cli'], defaultMode: 'custom-cli', models: ['saved-model'] }, { kind: 'local', id: 'local', label: 'Local server', modes: ['custom-cli'], models: ['local-model'], defaultModel: 'local-model' }] } };
    return { ok: true, data: company };
  });
  h.shell.company = company;
  const native = vi.spyOn(h.window, 'confirm').mockImplementation(() => { throw new Error('Native confirmation is forbidden'); });
  await h.shell.openRuntimeSettings(employee); await h.flush();
  const dialog = h.document.querySelector('.ca-runtime-settings')!;
  const field = (name: string) => dialog.querySelector(`[name="${name}"]`) as HTMLInputElement;
  const submit = () => dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  const accept = async () => { h.document.querySelector('.ca-company-confirm .is-primary').click(); await h.flush(); };
  return { h, employee, calls, native, dialog, field, submit, accept, refuse: (value: string) => { refusal = value; } };
}
it('loads the actual saved binding and supports compatible custom harnesses', async () => {
  const { h, field } = await setup();
  expect(field('source').value).toBe('subscription:work'); expect(field('mode').value).toBe('codex');
  expect(field('model').value).toBe('saved-model'); expect(field('effort').value).toBe('high');
  field('source').value = 'local:local'; field('source').dispatchEvent(new h.window.Event('change'));
  expect(field('mode').value).toBe('custom-cli'); expect(field('mode').textContent).not.toContain('Codex');
  expect(field('model').value).toBe('local-model'); expect(field('effort').value).toBe('');
  expect(field('effort').textContent).toContain('deep');
  field('source').value = 'subscription:work'; field('source').dispatchEvent(new h.window.Event('change'));
  expect(field('mode').value).toBe('custom-cli');
});
it('does not apply anything before styled confirmation, and Cancel and Escape preserve the draft', async () => {
  const { h, calls, field, submit, native } = await setup(); field('model').value = 'edited';
  submit(); submit(); expect(calls).toHaveLength(0); expect(h.document.querySelectorAll('.ca-company-confirm')).toHaveLength(1);
  expect(h.document.activeElement?.textContent).toBe('Cancel');
  h.document.querySelector('.ca-company-confirm button').click(); await h.flush();
  expect(calls).toHaveLength(0); expect(field('model').value).toBe('edited');
  submit(); h.document.querySelector('.ca-company-confirm').dispatchEvent(new h.window.Event('cancel', { cancelable: true })); await h.flush();
  expect(calls).toHaveLength(0); expect(field('model').value).toBe('edited'); expect(native).not.toHaveBeenCalled();
});
it('sends one in-place update and retains all draft fields on a busy refusal', async () => {
  const { calls, field, submit, accept, refuse, dialog } = await setup(); refuse('Expert is busy. Try again when idle.');
  field('model').value = 'edited'; field('effort').value = 'low'; submit(); submit(); await accept();
  expect(calls).toEqual([{ path: `/api/sessions/${sid}/runtime`, method: 'POST', body: { mode: 'codex', source: { kind: 'subscription', profileId: 'work' }, model: 'edited', effort: 'low' } }]);
  expect(dialog.querySelector('[role="alert"]').textContent).toContain('Expert is busy'); expect(field('model').value).toBe('edited'); expect(field('effort').value).toBe('low');
  refuse(''); submit(); await accept(); expect(calls).toHaveLength(2); expect(dialog.isConnected).toBe(false);
});
it('requires an explicit compatible source for an unconfigured or missing saved plan', async () => {
  const { field, dialog } = await setup(true, { mode: 'codex', source: null });
  expect(field('source').value).toBe(''); expect(field('mode').value).toBe(''); expect(dialog.querySelector('button[type="submit"]').disabled).toBe(true);
});
it('keeps editing owner-only even when cached company data permits management', async () => {
  const { dialog } = await setup(false); expect(dialog.querySelector('form')).toBeNull(); expect(dialog.textContent).toContain('Sign in as the owner');
});
it('offers the same runtime editor from the employee profile', async () => {
  const { h, employee, dialog } = await setup(); dialog.close(); h.shell.openEmployeeProfile(employee);
  h.document.querySelector('.ca-expert-profile [aria-label="Runtime settings"]').click(); await h.flush();
  expect(h.document.querySelector('.ca-runtime-settings [name="source"]').value).toBe('subscription:work');
});
it('offers a reporting manager in Edit profile and persists it through the existing employee API', async () => {
  const { h, employee, dialog } = await setup(); dialog.close();
  h.app._chatApi = vi.fn(async (path, opts) => {
    if (opts?.method === 'PUT') return { ok: true, data: {} };
    return { ok: true, data: { settings: { ownerName: 'James' }, employees: [employee, { id: 'manager', name: 'Manager' }] } };
  });
  h.shell.openEmployeeProfile(employee); await h.flush();
  const parent = h.document.querySelector('.ca-expert-profile [name="reportsTo"]');
  expect(parent.disabled).toBe(false); expect(parent.textContent).toContain('James'); expect(parent.textContent).toContain('Manager');
  expect([...parent.options].some(option => option.value === employee.id)).toBe(false);
  parent.value = 'manager';
  h.document.querySelector('.ca-expert-profile form').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush();
  expect(h.app._chatApi).toHaveBeenCalledWith('/api/company/employees/expert', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ reportsTo: 'manager' }) }));
});
