/** Settings saves patch only the form's fields, including across a concurrent edit. */
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness } from './helpers/chat-app-harness.mjs';

const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.window.close();
});

async function fixture() {
  const company = {
    canManage: true,
    settings: {
      ownerName: 'Owner',
      ownerTitle: 'Founder',
      timeZone: 'UTC',
      autoWakeEnabled: false,
      enabled: false,
      nightHour: 1,
      morningHour: 8,
      researchMinutes: 30,
      briefingMinutes: 10,
    },
    employees: [
      {
        id: 'reviewer',
        sessionId: 'fixture-session',
        name: 'River',
        icon: 'R',
        position: 'Reviewer',
        expertise: [],
        permissions: {},
        onVacation: true,
      },
    ],
    cycles: [],
  };
  const h = await createHarness({ company });
  handles.push(h);
  const writes: unknown[] = [];
  let interleave = false;
  const concurrentEdit = () =>
    Object.assign(company.settings, {
      timeZone: 'Europe/London',
      autoWakeEnabled: true,
      ownerTitle: 'Updated elsewhere',
      researchMinutes: 55,
    });
  const api = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: { method?: string; body?: object }) => {
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/company' && !options?.method) {
      const snapshot = structuredClone(company);
      // The other write commits after the response snapshot is read, before the form's PUT.
      if (interleave) {
        interleave = false;
        concurrentEdit();
      }
      return { ok: true, data: snapshot };
    }
    if (path === '/api/company/settings' && options?.method === 'PUT') {
      writes.push(structuredClone(options.body));
      Object.assign(company.settings, options.body);
      return { ok: true, data: { settings: structuredClone(company.settings) } };
    }
    return api(path, options);
  };
  return {
    h,
    company,
    writes,
    concurrentEdit,
    interleave: () => {
      interleave = true;
    },
  };
}

it.each(['coordinator', 'owner', 'timezone', 'research'] as const)(
  'the legacy %s save preserves settings changed since render',
  async (kind) => {
    const f = await fixture(),
      { h } = f;
    h.window.eval(readFileSync(new URL('../src/web/public/company-ui.js', import.meta.url), 'utf8'));
    h.app._companyApi = async (path: string, method = 'GET', body?: object) => {
      if (method === 'GET') return structuredClone(f.company);
      expect(path).toBe('/settings');
      f.writes.push(structuredClone(body));
      Object.assign(f.company.settings, body);
      return { settings: structuredClone(f.company.settings) };
    };
    h.app._companyPanel = h.document.createElement('dialog');
    h.document.body.append(h.app._companyPanel);
    await h.app._renderCompany();
    const field = (label: string) => h.document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    let label: string, patch: object;
    if (kind === 'coordinator') {
      label = 'Assign briefing coordinator';
      patch = { coordinatorEmployeeId: 'reviewer' };
    } else if (kind === 'owner') {
      field('Owner display name').value = ' New owner ';
      field('Owner title').value = ' New title ';
      label = 'Save owner record';
      patch = { ownerName: 'New owner', ownerTitle: 'New title' };
    } else if (kind === 'timezone') {
      field('Company timezone').value = 'America/New_York';
      label = 'Save timezone';
      patch = { timeZone: 'America/New_York' };
    } else {
      label = 'Save research schedule';
      patch = { enabled: false, nightHour: 1, morningHour: 8, researchMinutes: 30, briefingMinutes: 10 };
    }
    f.concurrentEdit();
    const save = [...h.document.querySelectorAll('button')].find(
      (node: HTMLButtonElement) => node.textContent === label
    )!;
    save.click();
    await h.flush(60);
    expect(f.writes).toEqual([patch]);
    expect(f.company.settings.autoWakeEnabled).toBe(true);
    if (kind !== 'timezone') expect(f.company.settings.timeZone).toBe('Europe/London');
    if (kind !== 'owner') expect(f.company.settings.ownerTitle).toBe('Updated elsewhere');
    if (kind !== 'research') expect(f.company.settings.researchMinutes).toBe(55);
  }
);

it('owner details preserve an unrelated edit committed after the fresh GET snapshot', async () => {
  const f = await fixture(),
    { h } = f;
  await h.shell.openCompanySettings();
  const dialog = h.document.querySelector('.ca-company-settings')!;
  (dialog.querySelector('[aria-label="Owner display name"]') as HTMLInputElement).value = 'New owner';
  (dialog.querySelector('[aria-label="Owner title"]') as HTMLInputElement).value = 'New title';
  f.interleave();
  dialog
    .querySelector('form.ca-company-settings-form')!
    .dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush(60);
  expect(f.writes).toEqual([{ ownerName: 'New owner', ownerTitle: 'New title' }]);
  expect(f.company.settings.timeZone).toBe('Europe/London');
  expect(f.company.settings.autoWakeEnabled).toBe(true);
});

it('the shared owner-name save patches only the name across the same interleaving', async () => {
  const f = await fixture();
  f.interleave();
  expect(await f.h.shell.saveOwnerName('New owner')).toBe(true);
  expect(f.writes).toEqual([{ ownerName: 'New owner' }]);
  expect(f.company.settings).toMatchObject({
    ownerTitle: 'Updated elsewhere',
    timeZone: 'Europe/London',
    autoWakeEnabled: true,
  });
});

it.each(['owner details', 'owner name'] as const)(
  'does not confirm %s from an incomplete successful reply',
  async (kind) => {
    const f = await fixture(),
      { h } = f;
    const api = h.app._chatApi.bind(h.app);
    h.app._chatApi = async (path: string, options?: { method?: string; body?: object }) =>
      path === '/api/company/settings' ? { ok: true, data: {} } : api(path, options);
    if (kind === 'owner name') {
      expect(await h.shell.saveOwnerName('Unconfirmed')).toBe(false);
      expect(h.shell.ownerName).not.toBe('Unconfirmed');
    } else {
      await h.shell.openCompanySettings();
      const dialog = h.document.querySelector('.ca-company-settings')!;
      (dialog.querySelector('[aria-label="Owner display name"]') as HTMLInputElement).value = 'Unconfirmed';
      dialog
        .querySelector('form.ca-company-settings-form')!
        .dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
      await h.flush(60);
      expect(dialog.querySelector('[role="alert"]')!.textContent).toContain('not confirmed');
      expect(dialog.querySelector('[role="status"]')!.textContent).not.toContain('saved');
      expect((dialog.querySelector('[aria-label="Owner display name"]') as HTMLInputElement).value).toBe('Unconfirmed');
    }
    expect(f.company.settings.ownerName).toBe('Owner');
  }
);

it.each([
  { name: 'lost response', result: { ok: false, error: 'Network error' } },
  { name: 'server error', result: { ok: false, status: 503, error: 'Storage response unavailable' } },
  { name: 'malformed refusal', result: { status: 409, error: 'Incomplete response' } },
  { name: 'missing acknowledgement', result: { ok: true, data: {} } },
  { name: 'different saved value', result: { ok: true, data: { settings: { ownerName: 'Other' } } } },
])('reports a dispatched $name as unconfirmed without another request', async ({ result }) => {
  const { h, company } = await fixture();
  const calls: unknown[] = [];
  h.app._chatApi = async (path: string, options: object) => {
    calls.push({ path, ...options });
    return result;
  };
  await expect(
    h.shell.saveScopedSettings(
      'company',
      { ownerName: 'Draft' },
      (reply: { settings?: { ownerName?: string } }) => reply?.settings?.ownerName === 'Draft'
    )
  ).rejects.toThrow('It may already have saved. Reopen settings to check the saved values before trying again.');
  expect(calls).toEqual([{ path: '/api/company/settings', method: 'PUT', body: { ownerName: 'Draft' } }]);
  expect(company.settings.ownerName).toBe('Owner');
});

it.each([400, 403, 409])(
  'preserves a confirmed HTTP %i refusal instead of reporting an ambiguous save',
  async (status) => {
    const { h } = await fixture();
    let calls = 0;
    h.app._chatApi = async () => {
      calls++;
      return { ok: false, status, error: 'The server refused this exact change' };
    };
    await expect(h.shell.saveScopedSettings('hiring', {}, () => true)).rejects.toThrow(
      /^The server refused this exact change$/
    );
    expect(calls).toBe(1);
  }
);

it('refuses an unknown scoped operation before issuing a request', async () => {
  const { h } = await fixture();
  let calls = 0;
  h.app._chatApi = async () => {
    calls++;
    throw new Error('Must not dispatch');
  };
  await expect(h.shell.saveScopedSettings('arbitrary', {}, () => true)).rejects.toThrow('No save request was sent.');
  expect(calls).toBe(0);
});

it.each(['owner details', 'owner name'] as const)(
  'keeps %s distinct from a write when the fresh read throws',
  async (kind) => {
    const f = await fixture(),
      { h } = f;
    if (kind === 'owner details') await h.shell.openCompanySettings();
    const api = h.app._chatApi.bind(h.app);
    h.app._chatApi = async (path: string, options?: { method?: string; body?: object }) => {
      if (path === '/api/company' && !options?.method) throw new Error('Read connection lost');
      return api(path, options);
    };
    let message = '';
    if (kind === 'owner name') {
      expect(
        await h.shell.saveOwnerName('Draft', {
          quiet: true,
          onFailure: (value: string) => {
            message = value;
          },
        })
      ).toBe(false);
    } else {
      const dialog = h.document.querySelector('.ca-company-settings')!;
      (dialog.querySelector('[aria-label="Owner display name"]') as HTMLInputElement).value = 'Draft';
      dialog
        .querySelector('form.ca-company-settings-form')!
        .dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
      await h.flush(60);
      message = dialog.querySelector('[role="alert"]')!.textContent!;
      expect((dialog.querySelector('[aria-label="Owner display name"]') as HTMLInputElement).value).toBe('Draft');
    }
    expect(message).toContain('No save request was sent.');
    expect(message).not.toContain('may already have saved');
    expect(f.writes).toEqual([]);
  }
);
