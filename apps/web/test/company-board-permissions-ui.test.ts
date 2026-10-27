import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness } from './helpers/chat-app-harness.mjs';
const handles: any[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.window.close(); });
const labels = ['Update own board work', 'Manage company board', 'Prepare decision cards'];
async function setup(options: { owner?: boolean; projection?: boolean } = {}) {
  const employee: any = {
    id: 'river', sessionId: 'runtime', name: 'River', icon: 'R', position: 'CEO', reportsTo: 'owner', onVacation: true,
    permissions: { editBoardIssues: false, recoverEmployees: false, moveOwnPlan: false, managePlans: false },
    ...(options.projection === false ? {} : {
      effectiveBoardPermissions: { editBoardIssues: true, manageBoard: true, manageDecisions: true },
      boardPermissionSources: { editBoardIssues: 'included', manageBoard: 'legacy', manageDecisions: 'legacy' },
    }),
  };
  const company = { employees: [employee], settings: {}, canManage: options.owner !== false };
  const h = await createHarness({ company }); handles.push(h);
  const pending: Array<{ body: any; resolve(value: any): void }> = [];
  h.app._chatApi = async (path: string, opts?: any) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: options.owner === false ? 'runtime' : 'owner', canSetOwn: options.owner !== false } };
    if (path === '/api/company/employees/river' && opts?.method === 'PUT')
      return new Promise(resolve => pending.push({ body: opts.body, resolve }));
    return { ok: true, data: {} };
  };
  const input = (label: string) => h.document.querySelector(`[aria-label="${label} for River"]`) as HTMLInputElement;
  await h.shell.openCompany();
  const opener = h.document.querySelector('[aria-label="Edit profile for River"]') as HTMLButtonElement;
  if (opener) { opener.click(); await h.flush(); }
  return { h, employee, pending, input };
}

it('shows authoritative inherited and included access without saving or deriving it from a title', async () => {
  const { h, employee, pending, input } = await setup();
  expect(input(labels[0]).checked).toBe(true);
  expect(input(labels[0]).disabled).toBe(true);
  expect(input(labels[0]).closest('label')!.textContent).toContain('Included with Manage company board');
  expect(input(labels[1]).checked).toBe(true);
  expect(input(labels[1]).closest('label')!.textContent).toContain('Inherited current policy');
  expect(input(labels[2]).checked).toBe(true);
  expect(employee.permissions).not.toHaveProperty('manageBoard');
  expect(employee.permissions).not.toHaveProperty('manageDecisions');
  expect(pending).toEqual([]);
  expect(h.document.querySelector('.ca-company-board-permissions').textContent).toContain('Board permissions');
});

it('saves an explicit revocation, preserves a separate basic denial, and rereads the saved state on reopen', async () => {
  const { h, employee, pending, input } = await setup();
  input(labels[1]).click(); await h.flush();
  expect(pending.map(p => p.body)).toEqual([{ permissions: { manageBoard: false } }]);
  for (const label of labels) expect(input(label).disabled).toBe(true);
  input(labels[2]).click(); await h.flush(); expect(pending).toHaveLength(1);
  employee.permissions.manageBoard = false;
  employee.effectiveBoardPermissions = { editBoardIssues: false, manageBoard: false, manageDecisions: true };
  employee.boardPermissionSources = { editBoardIssues: 'explicit', manageBoard: 'explicit', manageDecisions: 'legacy' };
  pending[0].resolve({ ok: true, data: { employee: structuredClone(employee) } }); await h.flush();
  expect(input(labels[0]).checked).toBe(false); expect(input(labels[0]).disabled).toBe(false);
  expect(input(labels[1]).checked).toBe(false);
  expect(h.document.querySelector('.ca-expert-profile').textContent).toContain('Preferences saved.');
  h.shell.closePage(); await h.shell.openCompany();
  (h.document.querySelector('[aria-label="Edit profile for River"]') as HTMLButtonElement).click(); await h.flush();
  expect(input(labels[1]).checked).toBe(false);
  expect(input(labels[0]).checked).toBe(false);
  expect(input(labels[2]).checked).toBe(true);
  expect(employee.permissions.recoverEmployees).toBe(false);
});

it('restores the effective checked state when an inherited permission revocation is refused', async () => {
  const { h, employee, pending, input } = await setup();
  input(labels[2]).click(); await h.flush();
  expect(pending[0].body).toEqual({ permissions: { manageDecisions: false } });
  pending[0].resolve({ ok: false, status: 403, error: 'Owner session expired' }); await h.flush();
  expect(input(labels[2]).checked).toBe(true); expect(input(labels[2]).disabled).toBe(false);
  expect(employee.permissions).not.toHaveProperty('manageDecisions');
  expect(h.document.querySelector('.ca-expert-profile').textContent).toContain('Owner session expired');
  expect(input(labels[0]).disabled).toBe(true);
});

it('does not report an incomplete effective-access response as confirmed, or invent missing server access', async () => {
  const { h, employee, pending, input } = await setup();
  input(labels[2]).click(); await h.flush();
  pending[0].resolve({ ok: true, data: { employee: { id: employee.id, permissions: { manageDecisions: false } } } });
  await h.flush();
  expect(input(labels[2]).checked).toBe(true);
  expect(h.document.querySelector('.ca-expert-profile').textContent).toContain('current access could not be read');
  expect(h.document.querySelector('.ca-expert-profile').textContent).not.toContain('Preferences saved.');
  const missing = await setup({ projection: false });
  for (const label of labels) expect(missing.input(label).disabled).toBe(true);
  expect(missing.pending).toEqual([]);
});

it('never exposes board grant controls to an agent or limited human view', async () => {
  const { input, pending } = await setup({ owner: false });
  for (const label of labels) expect(input(label)).toBeNull();
  expect(pending).toEqual([]);
});

it('keeps legacy owner permissions inside the expert details and confirms each one-field save', async () => {
  const h = await createHarness(); handles.push(h);
  h.window.eval(readFileSync(new URL('../src/web/public/company-ui.js', import.meta.url), 'utf8'));
  const employee: any = { id: 'river', name: 'River', icon: 'R', expertise: [], permissions: {},
    effectiveBoardPermissions: { editBoardIssues: true, manageBoard: false, manageDecisions: false },
    boardPermissionSources: { editBoardIssues: 'legacy', manageBoard: 'legacy', manageDecisions: 'legacy' } };
  const company = { canManage: true, settings: {}, employees: [employee], cycles: [] };
  const writes: any[] = [];
  h.app._companyApi = async (path: string, method = 'GET', body?: any) => {
    if (method === 'GET') return structuredClone(company);
    writes.push(body);
    employee.permissions.manageBoard = true;
    employee.effectiveBoardPermissions.manageBoard = true;
    employee.boardPermissionSources.manageBoard = 'explicit';
    employee.boardPermissionSources.editBoardIssues = 'included';
    return { employee: structuredClone(employee) };
  };
  h.app._companyPanel = h.document.createElement('dialog'); h.document.body.append(h.app._companyPanel);
  await h.app._renderCompany();
  const card = h.app._companyPanel.querySelector('article');
  const control = card.querySelector('[aria-label="Manage company board for River"]') as HTMLInputElement;
  expect(control.closest('details')!.open).toBe(false);
  expect(writes).toEqual([]);
  control.closest('details')!.open = true;
  control.click(); await h.flush();
  expect(writes).toEqual([{ permissions: { manageBoard: true } }]);
  expect(control.checked).toBe(true);
  const basic = card.querySelector('[aria-label="Update own board work for River"]') as HTMLInputElement;
  expect(basic.checked).toBe(true); expect(basic.disabled).toBe(true);
  company.canManage = false; await h.app._renderCompany();
  expect(h.app._companyPanel.querySelector('[aria-label="Manage company board for River"]')).toBeNull();
});
