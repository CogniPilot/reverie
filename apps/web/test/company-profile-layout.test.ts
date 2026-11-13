import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
import { EmployeePermissionsSchema } from '../src/company-types.js';
const handles: any[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.window.close(); });
async function setup() {
  const employee: any = { id: 'river', sessionId: 'runtime', sessionGeneration: 2, name: 'River', position: 'Engineer', expertise: ['Systems'], responsibilities: ['Review work'], personality: 'Careful', pronouns: 'they/them', onVacation: true, desiredRunning: false, permissions: {}, coreBeliefs: ['Preserve\r\nexact text'], sleepEnabled: false, dreamEnabled: false, effectiveBoardPermissions: { editBoardIssues: true, manageBoard: false, manageDecisions: false }, boardPermissionSources: { editBoardIssues: 'legacy', manageBoard: 'legacy', manageDecisions: 'legacy' } };
  employee.permissions = EmployeePermissionsSchema.parse({});
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

it('keeps incomplete initial permissions visible and recoverable without losing profile drafts or lifecycle controls', async () => {
  const { h, employee, writes, dialog, open } = await setup();
  const permissions = employee.permissions;
  employee.permissions = null; // An incomplete API response, never an inferred denial.
  dialog.close();
  const current = await open();
  current.querySelector('[name=position]').value = 'Unsaved role';
  current.querySelector('[data-profile-tab=permissions]').click();
  const error = current.querySelector('.ca-profile-permission-error');
  expect(error.textContent).toContain('Current permissions could not be confirmed');
  const input = current.querySelector('[aria-label="Recovery permission for River"]');
  expect(input.disabled).toBe(true);
  expect(input.indeterminate).toBe(true);
  expect(current.querySelector('[aria-label="Restart session for River"]')).not.toBeNull();
  const original = h.app._chatApi.bind(h.app);
  let reads = 0;
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/company/employees/river/permissions') {
      reads++;
      return {
        ok: true,
        data: {
          employeeId: employee.id,
          permissions,
          effectiveBoardPermissions: employee.effectiveBoardPermissions,
          boardPermissionSources: employee.boardPermissionSources,
        },
      };
    }
    return original(path, options);
  };
  current.querySelector('[aria-label="Refresh permissions for River"]').click();
  await h.flush();
  expect(reads).toBe(1);
  expect(input.disabled).toBe(false);
  expect(input.indeterminate).toBe(false);
  expect(current.querySelector('[name=position]').value).toBe('Unsaved role');
  expect(writes).toEqual([]);
});

it('groups existing controls, keeps a real associated save action, and supports keyboard tab navigation', async () => {
  const { h, dialog, writes } = await setup();
  const tabs = [...dialog.querySelectorAll('[role=tab]')];
  expect(tabs.map((t: any) => t.textContent)).toEqual(['Profile', 'Permissions', 'GitHub PATs', 'Identity & context']);
  expect(dialog.querySelector('[role=tabpanel]:not([hidden])').id).toBe('ca-employee-panel-profile');
  const form = dialog.querySelector('form'), save = dialog.querySelector('button[type=submit]');
  expect(save.form).toBe(form); expect(save.closest('.ca-profile-footer')).not.toBeNull();
  tabs[0].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(tabs[1].getAttribute('aria-selected')).toBe('true'); expect(h.document.activeElement).toBe(tabs[1]);
  expect(form.hidden).toBe(true); expect(dialog.querySelector('.ca-profile-management').hidden).toBe(false);
  expect(dialog.querySelector('[aria-label="Manage company board for River"]').form).toBeNull();
  tabs[1].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(tabs[3].getAttribute('aria-selected')).toBe('true');
  expect(dialog.querySelector('[aria-label="View startup context for River"]').closest('[role=tabpanel]').hidden).toBe(false);
  expect(writes).toEqual([]);
});

it('places hiring delegation and the RAM, CPU and GPU controls on employee Permissions', async () => {
  const { dialog, writes } = await setup();
  dialog.querySelector('[data-profile-tab=permissions]').click();
  const panel = dialog.querySelector('#ca-employee-panel-permissions');
  const resources = panel.querySelector('[aria-label="Laptop resources"]');
  expect(resources).not.toBeNull();
  expect(resources.querySelector('.ca-employee-resources')).not.toBeNull();
  expect(resources.querySelector('.ca-employee-gpu')).not.toBeNull();
  expect(panel.querySelector('[aria-label="Hiring permission for River"]')).not.toBeNull();
  expect(writes).toEqual([]);
});
it('states the save rule once, in the footer, and offers Save profile only where it saves something', async () => {
  const { h, dialog } = await setup();
  const save = dialog.querySelector('button[type=submit]');
  // One statement of the rule, in the footer; the header and the Permissions panel no longer repeat it.
  // (The PAT panel keeps its own setup instructions, which mention it in passing.)
  const hints = [...dialog.querySelectorAll('.ca-hint')].filter((p: any) => /save[sd]? immediately/i.test(p.textContent)
    && !p.closest('#ca-employee-panel-credentials'));
  expect(hints.map((p: any) => p.className)).toEqual([]);
  expect(dialog.querySelector(':scope > .ca-hint')).toBeNull();
  expect(save.hidden).toBe(false);
  for (const [tab, visible] of [['permissions', false], ['credentials', false], ['identity', true], ['profile', true]] as const) {
    dialog.querySelector(`[data-profile-tab=${tab}]`).click();
    expect(save.hidden, tab).toBe(!visible);
    expect(dialog.querySelector('.ca-profile-save-hint').textContent.length, tab).toBeGreaterThan(0);
  }
  dialog.querySelector('[data-profile-tab=permissions]').click();
  expect(dialog.querySelector('.ca-profile-save-hint').textContent).toContain('Permissions save immediately');
  expect([...dialog.querySelectorAll('.ca-profile-footer button')].some((b: any) => b.textContent === 'Cancel' && !b.hidden)).toBe(true);
  void h;
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
