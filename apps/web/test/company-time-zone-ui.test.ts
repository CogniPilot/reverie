/**
 * The company time zone in the chat app's Company settings (card i-3de8c2da). The server setting already existed
 * (CompanySettings.timeZone, an IANA name); only the old console page could edit it. Owners now set it here: only the
 * time zone is sent, an unknown zone is refused before any request, and the page clock follows once the server
 * confirms the saved value.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';

const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
  vi.restoreAllMocks();
});

async function setup({ verified = true, confirm = true } = {}) {
  const data: any = { canManage: true, settings: { owner: 'owner', ownerName: 'Alex', timeZone: 'UTC' }, employees: [] };
  const h = await createHarness({ company: data });
  opened.push(h);
  const puts: any[] = [];
  h.app._chatApi = vi.fn(async (path: string, options?: any) => {
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
    if (path === '/api/company/settings') {
      puts.push(options.body);
      if (confirm) Object.assign(data.settings, options.body);
      return { ok: true, data: { settings: data.settings } };
    }
    return { ok: true, data };
  });
  const setTimeZone = vi.fn();
  h.window.ReverieTime = { ...(h.window.ReverieTime || {}), setTimeZone };
  await h.shell.openCompany();
  // A non-owner has no Company settings button; open the dialog directly to prove the form is still not offered.
  const opener = h.document.querySelector('[aria-label="Company settings"]') as HTMLButtonElement | null;
  if (opener) opener.click(); else void h.shell.openCompanySettings();
  await h.flush();
  const form = () => h.document.querySelector('.ca-company-settings .ca-company-time-zone-form') as HTMLFormElement | null;
  const input = () => form()!.querySelector('[aria-label="Company time zone"]') as HTMLInputElement;
  const submit = async () => {
    form()!.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush();
  };
  const dialog = () => h.document.querySelector('dialog.ca-company-settings')!;
  const status = () => dialog().querySelector(':scope > [role="status"]')!.textContent;
  const error = () => dialog().querySelector(':scope > [role="alert"]')!.textContent;
  return { h, data, puts, setTimeZone, form, input, submit, status, error };
}

it('shows the current zone and saves only the time zone, then moves the page clock to it', async () => {
  const { puts, setTimeZone, input, submit, status } = await setup();
  expect(input().value).toBe('UTC');
  input().value = ' America/New_York ';
  await submit();
  expect(puts).toEqual([{ timeZone: 'America/New_York' }]);
  expect(setTimeZone).toHaveBeenCalledWith('America/New_York');
  expect(status()).toBe('Company time zone saved: America/New_York.');
});

it('refuses a zone the browser does not know without asking the server', async () => {
  const { puts, setTimeZone, input, submit, error } = await setup();
  input().value = 'Mars/Olympus_Mons';
  await submit();
  expect(puts).toHaveLength(0);
  expect(setTimeZone).not.toHaveBeenCalled();
  expect(error()).toContain('is not a time zone this browser knows');
});

it('does not move the clock when the server does not confirm the saved zone', async () => {
  const { puts, setTimeZone, input, submit, error } = await setup({ confirm: false });
  input().value = 'Europe/Berlin';
  await submit();
  expect(puts).toEqual([{ timeZone: 'Europe/Berlin' }]);
  expect(setTimeZone).not.toHaveBeenCalled();
  expect(error()).toContain('Save not confirmed');
});

it('is not offered to someone who is not the signed-in owner', async () => {
  const { h, form } = await setup({ verified: false });
  // The dialog did open (not a hollow pass): it shows the non-owner hint and no time zone form.
  expect(h.document.querySelector('dialog.ca-company-settings')!.textContent).toContain('Sign in as the owner to change company settings.');
  expect(form()).toBeNull();
});
