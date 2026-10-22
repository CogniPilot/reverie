import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';

const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.window.close(); });

async function fixture({ name = '', self = 'owner', canSetOwn = true, canManage = true } = {}) {
  const company = { employees: [], canManage, settings: { ownerName: name, owner: 'account-one', nightHour: 1, autoWakeEnabled: false, crashWakeEmployeeId: 'chosen' } };
  const handle = await createHarness({ company, loadShell: false });
  handles.push(handle);
  const previous = handle.app._chatApi.bind(handle.app);
  handle.app._chatApi = (path: string, options: unknown) => path === '/api/chatrooms/phone-status'
    ? Promise.resolve({ ok: true, data: { self, canSetOwn } }) : previous(path, options);
  const shell = await handle.startShell();
  await handle.flush(80);
  return { ...handle, shell, company };
}

describe('first-run owner display name', () => {
  it('asks a verified new owner and saves only their name using fresh organization settings', async () => {
    const h = await fixture();
    const dialog = h.document.querySelector<HTMLDialogElement>('dialog[aria-label="Your name"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelectorAll('input')).toHaveLength(1);
    h.server.company.settings.nightHour = 3;
    dialog.querySelector<HTMLInputElement>('input')!.value = 'New Owner';
    dialog.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await h.flush(80);
    expect(h.server.company.settings).toEqual({ ownerName: 'New Owner', nightHour: 3, autoWakeEnabled: false, crashWakeEmployeeId: 'chosen' });
    expect(h.document.querySelector('dialog[aria-label="Your name"]')).toBeNull();
    expect(h.shell.ownerName).toBe('New Owner');
  });

  it('does not ask when an owner display name already exists', async () => {
    const h = await fixture({ name: 'Existing Owner' });
    expect(h.document.querySelector('dialog[aria-label="Your name"]')).toBeNull();
  });

  it.each([{ self: 'agent-session' }, { canSetOwn: false }, { canManage: false }])('never asks an agent or unverified owner %j', async overrides => {
    const h = await fixture(overrides);
    expect(h.document.querySelector('dialog[aria-label="Your name"]')).toBeNull();
  });

  it('cancel leaves settings intact and does not prompt again in the same tab session', async () => {
    const h = await fixture();
    h.document.querySelector<HTMLDialogElement>('dialog[aria-label="Your name"]')!.close();
    await h.shell.loadOwner();
    expect(h.document.querySelector('dialog[aria-label="Your name"]')).toBeNull();
    expect(h.server.company.settings).toEqual(h.company.settings);
    expect(h.server.calls.filter(call => call.method === 'PUT')).toEqual([]);
  });

  it('failed save keeps the dialog and existing settings for retry', async () => {
    const h = await fixture();
    const previous = h.app._chatApi.bind(h.app);
    h.app._chatApi = (path: string, options: unknown) => path === '/api/company/settings'
      ? Promise.resolve({ ok: false, error: 'synthetic refusal' }) : previous(path, options);
    const dialog = h.document.querySelector<HTMLDialogElement>('dialog[aria-label="Your name"]')!;
    dialog.querySelector<HTMLInputElement>('input')!.value = 'New Owner';
    dialog.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await h.flush(80);
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('[role="alert"]')!.textContent).toContain('Try again');
    expect(h.server.company.settings.ownerName).toBe('');
    expect(h.shell.ownerName).toBe('');
    expect(h.server.company.settings.autoWakeEnabled).toBe(false);
  });
});
