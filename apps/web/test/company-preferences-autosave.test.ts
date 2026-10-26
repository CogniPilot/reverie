import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
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
    permissions: { recoverEmployees: false, moveOwnPlan: false, managePlans: false },
  };
  const company = { employees: [employee], settings: {}, canManage: true };
  const h = await createHarness({ company });
  handles.push(h);
  const pending: Array<{ body: any; resolve(value: any): void }> = [];
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/company') return { ok: true, data: structuredClone(company) };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/company/employees/river' && options?.method === 'PUT')
      return await new Promise((resolve) => pending.push({ body: options.body, resolve }));
    return { ok: true, data: {} };
  };
  await h.shell.openCompany();
  h.document.querySelector<HTMLButtonElement>('[aria-label="Edit profile for River"]')!.click();
  await h.flush();
  const profile = () => h.document.querySelector<HTMLDialogElement>('.ca-expert-profile')!;
  const input = (label: string) => profile().querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  const reopen = async () => {
    profile()?.close();
    h.document.querySelector<HTMLButtonElement>('[aria-label="Edit profile for River"]')!.click();
    await h.flush();
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
  return { h, employee, pending, input, finish, profile, reopen };
}

it('saves permission controls immediately and preserves them with explicit rest preferences through profile reload', async () => {
  const { h, pending, input, finish, profile, reopen } = await setup();
  expect(h.document.querySelector('[aria-label="Save preferences for River"]')).toBeNull();
  const labels = [
    'Recovery permission for River',
    'Move own plan for River',
    'Manage team plans for River',
  ];
  for (const label of labels) {
    input(label).click();
    await h.flush();
  }
  expect(pending.map((p) => p.body)).toEqual([
    { permissions: { recoverEmployees: true } },
    { permissions: { moveOwnPlan: true } },
    { permissions: { managePlans: true } },
  ]);
  // The owner can grant recovery while the expert is off, without waking them.
  for (let i = pending.length - 1; i >= 0; i--) finish(i);
  await h.flush();
  expect(profile().textContent).toContain('Preferences saved.');
  await reopen();
  for (const label of labels) expect(input(label).checked).toBe(true);
  input('Sleep').click(); input('Dream').click();
  expect(pending).toHaveLength(3);
  const save = [...profile().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save profile')!;
  save.click(); await h.flush();
  expect(pending).toHaveLength(4);
  expect(pending[3].body).toMatchObject({ sleepEnabled: true, dreamEnabled: true });
  finish(3); await h.flush();
  await reopen();
  for (const label of [...labels, 'Sleep', 'Dream']) expect(input(label).checked).toBe(true);
});

it('restores a denied permission, keeps unrelated successful saves, and retains the error until a successful retry', async () => {
  const { h, employee, pending, input, finish, profile } = await setup();
  input('Move own plan for River').click();
  input('Recovery permission for River').click();
  await h.flush();
  expect(input('Recovery permission for River').disabled).toBe(true);
  finish(1, false);
  finish(0);
  await h.flush();
  expect(employee.permissions.moveOwnPlan).toBe(true);
  expect(employee.permissions.recoverEmployees).toBe(false);
  expect(input('Recovery permission for River').checked).toBe(false);
  expect(input('Recovery permission for River').disabled).toBe(false);
  expect(profile().textContent).toContain(
    'Could not save preferences: Save refused'
  );
  input('Recovery permission for River').click();
  await h.flush();
  expect(pending).toHaveLength(3);
  finish(2);
  await h.flush();
  expect(profile().textContent).toContain('Preferences saved.');
});

it('does not report a malformed or unrelated success as a saved permission', async () => {
  const { h, input, pending, profile } = await setup();
  input('Recovery permission for River').click();
  await h.flush();
  pending[0].resolve({ ok: true, data: {} });
  await h.flush();
  expect(input('Recovery permission for River').checked).toBe(false);
  expect(profile().textContent).toContain('Save not confirmed');
  expect(profile().textContent).not.toContain('Preferences saved.');
});
