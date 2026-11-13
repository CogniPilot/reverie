/// <reference lib="dom" />
/// <reference lib="dom.asynciterable" />
import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
import { EmployeePermissionsSchema } from '../src/company-types.js';
import { effectiveBoardPermissions } from '../src/board-permissions.js';
const handles: any[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.window.close();
});
async function setup() {
  const employee = {
    id: 'river',
    sessionId: 'runtime',
    name: 'River',
    icon: 'R',
    reportsTo: 'owner',
    onVacation: true,
    sleepEnabled: false,
    dreamEnabled: false,
    permissions: EmployeePermissionsSchema.parse({ recoverEmployees: false, moveOwnPlan: false, managePlans: false }),
    effectiveBoardPermissions: { editBoardIssues: true, manageBoard: false, manageDecisions: false },
    boardPermissionSources: { editBoardIssues: 'legacy', manageBoard: 'legacy', manageDecisions: 'legacy' },
  };
  employee.effectiveBoardPermissions = effectiveBoardPermissions(employee, false);
  const company = { employees: [employee], settings: {}, canManage: true };
  const h = await createHarness({ company });
  handles.push(h);
  const pending: Array<{ body: any; resolve(value: any): void }> = [];
  let reads = 0;
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/company/employees/river/permissions') {
      reads++;
      return {
        ok: true,
        data: {
          employeeId: employee.id,
          permissions: structuredClone(employee.permissions),
          effectiveBoardPermissions: structuredClone(employee.effectiveBoardPermissions),
          boardPermissionSources: structuredClone(employee.boardPermissionSources),
        },
      };
    }
    if (path === '/api/company/employees/river' && options?.method === 'PUT')
      return await new Promise((resolve) => pending.push({ body: options.body, resolve }));
    return { ok: true, data: {} };
  };
  await h.shell.openCompany();
  h.document.querySelector<HTMLButtonElement>('[aria-label="Edit profile for River"]')!.click();
  await h.flush();
  const profile = () => h.document.querySelector<HTMLDialogElement>('.ca-expert-profile')!;
  profile().querySelector<HTMLButtonElement>('[data-profile-tab=permissions]')!.click();
  const input = (label: string) => profile().querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  const reopen = async () => {
    profile()?.close();
    h.document.querySelector<HTMLButtonElement>('[aria-label="Edit profile for River"]')!.click();
    await h.flush();
    profile().querySelector<HTMLButtonElement>('[data-profile-tab=permissions]')!.click();
  };
  const finish = (index: number, ok = true) => {
    const p = pending[index];
    if (ok) {
      const { permissions, ...rest } = p.body;
      Object.assign(employee, rest);
      if (permissions) Object.assign(employee.permissions, permissions);
    }
    p.resolve(
      ok
        ? { ok: true, data: { employee: structuredClone(employee) } }
        : { ok: false, status: 403, error: 'Save refused' }
    );
  };
  const refresh = async () => {
    profile().querySelector<HTMLButtonElement>('[aria-label="Refresh permissions for River"]')!.click();
    await h.flush();
  };
  return { h, employee, pending, input, finish, profile, reopen, refresh, reads: () => reads };
}

it('saves permission controls immediately and preserves them with explicit rest preferences through profile reload', async () => {
  const { h, pending, input, finish, profile, reopen } = await setup();
  expect(h.document.querySelector('[aria-label="Save preferences for River"]')).toBeNull();
  const labels = ['Recovery permission for River', 'Move own plan for River', 'Manage team plans for River'];
  for (const [index, label] of labels.entries()) {
    input(label).click();
    await h.flush();
    expect(pending).toHaveLength(index + 1);
    for (const other of labels) expect(input(other).disabled).toBe(true);
    input(labels[(index + 1) % labels.length]).click();
    expect(pending).toHaveLength(index + 1);
    finish(index);
    await h.flush();
  }
  expect(pending.map((p) => p.body)).toEqual([
    { permissions: { recoverEmployees: true } },
    { permissions: { moveOwnPlan: true } },
    { permissions: { managePlans: true } },
  ]);
  // The owner can grant recovery while the expert is off, without waking them.
  expect(profile().textContent).toContain('Preferences saved.');
  await reopen();
  for (const label of labels) expect(input(label).checked).toBe(true);
  profile().querySelector<HTMLButtonElement>('[data-profile-tab=profile]')!.click();
  input('Sleep').click();
  input('Dream').click();
  expect(pending).toHaveLength(3);
  const save = [...profile().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Save profile'
  )!;
  save.click();
  await h.flush();
  expect(pending).toHaveLength(4);
  expect(pending[3].body).toMatchObject({ sleepEnabled: true, dreamEnabled: true });
  finish(3);
  await h.flush();
  await reopen();
  for (const label of [...labels, 'Sleep', 'Dream']) expect(input(label).checked).toBe(true);
});

it('keeps a refused permission uncertain until readback, preserving an unrelated saved permission without replay', async () => {
  const { h, employee, pending, input, finish, profile, refresh, reads } = await setup();
  input('Move own plan for River').click();
  await h.flush();
  finish(0);
  await h.flush();
  input('Recovery permission for River').click();
  await h.flush();
  expect(input('Recovery permission for River').disabled).toBe(true);
  finish(1, false);
  await h.flush();
  expect(employee.permissions.moveOwnPlan).toBe(true);
  expect(employee.permissions.recoverEmployees).toBe(false);
  expect(input('Recovery permission for River').indeterminate).toBe(true);
  expect(input('Recovery permission for River').disabled).toBe(true);
  expect(profile().textContent).toContain('Save refused');
  input('Recovery permission for River').click();
  expect(pending).toHaveLength(2);
  await refresh();
  expect(reads()).toBe(1);
  expect(pending).toHaveLength(2);
  expect(input('Recovery permission for River').checked).toBe(false);
  expect(input('Recovery permission for River').disabled).toBe(false);
  input('Recovery permission for River').click();
  await h.flush();
  expect(pending).toHaveLength(3);
  finish(2);
  await h.flush();
  expect(profile().textContent).toContain('Preferences saved.');
});

it('does not report a malformed success as saved and requires readback without replay', async () => {
  const { h, input, pending, profile, refresh, reads } = await setup();
  input('Recovery permission for River').click();
  await h.flush();
  pending[0].resolve({ ok: true, data: {} });
  await h.flush();
  expect(input('Recovery permission for River').indeterminate).toBe(true);
  expect(input('Recovery permission for River').disabled).toBe(true);
  expect(profile().textContent).toContain('may already have saved');
  expect(profile().textContent).not.toContain('Preferences saved.');
  await refresh();
  expect(reads()).toBe(1);
  expect(pending).toHaveLength(1);
  expect(input('Recovery permission for River').checked).toBe(false);
  expect(input('Recovery permission for River').disabled).toBe(false);
});

it('saves the owner-only team Goal permission as an isolated patch and preserves it on reopen', async () => {
  const { h, employee, pending, input, finish, reopen, refresh, reads } = await setup();
  expect(input('Manage team goals for River').checked).toBe(false);
  input('Manage team goals for River').click();
  await h.flush();
  expect(pending[0].body).toEqual({ permissions: { manageGoals: true } });
  finish(0);
  await h.flush();
  await reopen();
  expect(input('Manage team goals for River').checked).toBe(true);
  input('Manage team goals for River').click();
  await h.flush();
  expect(pending[1].body).toEqual({ permissions: { manageGoals: false } });
  finish(1, false);
  await h.flush();
  expect(employee.permissions.manageGoals).toBe(true);
  expect(input('Manage team goals for River').indeterminate).toBe(true);
  expect(input('Manage team goals for River').disabled).toBe(true);
  await refresh();
  expect(reads()).toBe(1);
  expect(pending).toHaveLength(2);
  expect(input('Manage team goals for River').checked).toBe(true);
});
