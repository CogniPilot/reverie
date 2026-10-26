import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const handles: any[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.window.close(); });
async function setup() {
  const employee: any = { id: 'river', sessionId: 'runtime', sessionGeneration: 2, name: 'River', position: 'Engineer', expertise: ['Systems'], responsibilities: ['Review work'], personality: 'Careful', pronouns: 'they/them', onVacation: true, desiredRunning: false, permissions: {}, coreBeliefs: ['Preserve\r\nexact text'], sleepEnabled: false, dreamEnabled: false, effectiveBoardPermissions: { editBoardIssues: true, manageBoard: false, manageDecisions: false }, boardPermissionSources: { editBoardIssues: 'legacy', manageBoard: 'legacy', manageDecisions: 'legacy' } };
  const company = { canManage: true, employees: [employee], settings: { coreBeliefs: ['Company first'] } };
  const h = await createHarness({ company }); handles.push(h); const writes: any[] = [];
  const original = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/publication/tokens') return { ok: true, data: { tokens: [] } };
    if (path === '/api/company/employees/river' && options?.method === 'PUT') {
      writes.push(structuredClone(options.body));
      Object.assign(employee, { ...options.body, permissions: { ...employee.permissions, ...options.body.permissions } });
      for (const key of ['manageBoard', 'manageDecisions', 'editBoardIssues']) if (Object.hasOwn(options.body.permissions || {}, key)) {
        employee.effectiveBoardPermissions[key] = options.body.permissions[key]; employee.boardPermissionSources[key] = 'explicit';
      }
      return { ok: true, data: { employee: structuredClone(employee) } };
    }
    return original(path, options);
  };
  await h.shell.openCompany('people');
  const open = async () => { h.document.querySelector('[aria-label="Edit profile for River"]').click(); await h.flush(); return h.document.querySelector('.ca-expert-profile'); };
  const dialog = await open();
  return { h, employee, writes, dialog, open };
}
it('groups existing controls, keeps a real associated save action, and supports keyboard tab navigation', async () => {
  const { h, dialog, writes } = await setup();
  const tabs = [...dialog.querySelectorAll('[role=tab]')];
  expect(tabs.map((t: any) => t.textContent)).toEqual(['Profile', 'Permissions', 'Identity & context']);
  expect(dialog.querySelector('[role=tabpanel]:not([hidden])').id).toBe('ca-employee-panel-profile');
  const form = dialog.querySelector('form'), save = dialog.querySelector('button[type=submit]');
  expect(save.form).toBe(form); expect(save.closest('.ca-profile-footer')).not.toBeNull();
  tabs[0].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(tabs[1].getAttribute('aria-selected')).toBe('true'); expect(h.document.activeElement).toBe(tabs[1]);
  expect(form.hidden).toBe(true); expect(dialog.querySelector('.ca-profile-management').hidden).toBe(false);
  expect(dialog.querySelector('[aria-label="Manage company board for River"]').form).toBeNull();
  tabs[1].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  expect(dialog.querySelector('[aria-label="View startup context for River"]').closest('[role=tabpanel]').hidden).toBe(false);
  expect(writes).toEqual([]);
});
it('keeps permission autosaves when Cancel discards unsaved profile and rest edits', async () => {
  const { h, dialog, employee, writes, open } = await setup();
  dialog.querySelector('[name=position]').value = 'Unsaved role'; dialog.querySelector('[name=sleepEnabled]').checked = true;
  dialog.querySelector('[data-profile-tab=permissions]').click();
  const checkbox = dialog.querySelector('[aria-label="Manage company board for River"]'); checkbox.checked = true; checkbox.dispatchEvent(new h.window.Event('change')); await h.flush();
  expect(writes).toEqual([{ permissions: { manageBoard: true } }]);
  expect(dialog.querySelector('.ca-profile-save-hint').textContent).toContain('Cancel does not undo');
  [...dialog.querySelectorAll('button')].find((b: any) => b.textContent === 'Cancel').click();
  expect(employee.position).toBe('Engineer'); expect(employee.sleepEnabled).toBe(false); expect(employee.permissions.manageBoard).toBe(true);
  const again = await open(); expect(again.querySelector('[name=position]').value).toBe('Engineer');
});
it('preserves unsaved fields across groups and does not rewrite untouched literal core blocks', async () => {
  const { h, dialog, employee, writes } = await setup();
  dialog.querySelector('[name=position]').value = 'Updated role'; dialog.querySelector('[data-profile-tab=identity]').click();
  expect(dialog.querySelector('[name=position]').value).toBe('Updated role');
  dialog.querySelector('form').dispatchEvent(new h.window.Event('submit', { cancelable: true })); await h.flush();
  expect(writes).toHaveLength(1); expect(writes[0].position).toBe('Updated role'); expect(writes[0]).not.toHaveProperty('coreBeliefs');
  expect(employee.coreBeliefs).toEqual(['Preserve\r\nexact text']);
});
