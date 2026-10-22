import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
const A = '0000002d-0035-4000-8000-000000000047',
  B = '00000038-0043-4000-8000-000000000060';
const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
});
async function setup(verified = true) {
  const data: any = {
    canManage: true,
    settings: { ownerName: 'Owner' },
    employees: [
      {
        id: 'lead',
        name: 'Inspector',
        icon: '🦊',
        position: 'Security',
        sessionId: A,
        available: true,
        reportsTo: 'owner',
        expertise: ['Review'],
      },
    ],
  };
  const h = await createHarness({
    sessions: [
      { id: A, name: 'Inspector', mode: 'codex' },
      { id: B, name: 'Writer', mode: 'codex' },
    ],
    rooms: [room('r1', 'Office', [member(A, 'Inspector')])],
    company: data,
  });
  opened.push(h);
  const previous = h.app._chatApi.bind(h.app);
  let finish: any;
  const calls: any[] = [];
  h.app._chatApi = async (path: string, opts: any) => {
    if (path === '/api/chatrooms/phone-status')
      return { ok: verified, data: { canSetOwn: verified, canSetAgents: verified, self: 'owner' } };
    if (path === '/api/company/hire-options')
      return {
        ok: true,
        data: {
          harnesses: [
            { id: 'codex', label: 'Codex', efforts: ['low', 'high'] },
            { id: 'opencode', label: 'OpenCode', efforts: [] },
          ],
          sources: [
            { kind: 'subscription', id: 'plan-one', label: 'Work plan', modes: ['opencode', 'codex'], defaultMode: 'codex', models: [] },
            {
              kind: 'local',
              id: 'local-one',
              label: 'Local server',
              modes: ['codex', 'opencode'],
              models: ['model-local'],
              defaultModel: 'model-local',
            },
          ],
        },
      };
    if (path === '/api/company' && !opts) return { ok: true, data };
    if (path === '/api/company/hire') {
      calls.push(opts);
      return await new Promise((resolve) => {
        finish = resolve;
      });
    }
    return previous(path, opts);
  };
  return { h, data, calls, resolve: (value: any) => finish(value) };
}
function fill(h: any) {
  const doc = h.document;
  const field = (name: string) => doc.querySelector(`.ca-company [name="${name}"]`) as HTMLInputElement;
  field('roleTemplate').value = 'custom';
  field('roleTemplate').dispatchEvent(new h.window.Event('change'));
  field('plan').value = 'subscription:plan-one';
  field('plan').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  field('name').value = 'Writer';
  field('position').value = 'Flight-stack reviewer';
  field('expertise').value = 'Code review, Flight systems';
  field('reportsTo').value = 'lead';
  return field;
}
function submit(h: any) {
  const next = h.document.querySelector('.ca-company-hire [aria-label="Next"]');
  for (let i = 0; i < 3 && !next.hidden; i++) next.click();
  h.document
    .querySelector('.ca-company-hire form')
    .dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
}
it('opens Company directly from the sidebar without the legacy settings window', async () => {
  const { h } = await setup();
  const link = h.document.querySelector('.ca-company-nav');
  expect(link?.textContent).toBe('Company');
  link.click();
  await h.flush();
  expect(h.document.querySelector('.ca-page .ca-company')).not.toBeNull();
  expect(h.document.querySelector('dialog.ca-company')).toBeNull();
  expect(h.document.querySelector('.ca-company').textContent).toContain('Inspector');
  expect(h.document.querySelector('.ca-company form')).not.toBeNull();
  expect(h.document.querySelector('.reverie-company-dialog')).toBeNull();
  expect(h.document.querySelector('.ca-company-chart').textContent).toContain('Reporting structure');
  expect(h.document.querySelector('.ca-company-hire').hidden).toBe(true);
  h.document.querySelector('[aria-label="Hire"]').click();
  expect(h.document.querySelector('.ca-company-hire').hidden).toBe(false);
  expect(h.document.querySelector('.ca-company [name="sessionId"]')).toBeNull();
  expect(h.document.querySelector('.ca-company [name="plan"]').textContent).toContain('Work plan');
});
it('chooses a plan and harness with backend runtime defaults for a fresh expert; sends one object and suppresses double submit', async () => {
  const { h, data, calls, resolve } = await setup();
  await h.shell.openCompany('people');
  const fields = fill(h);
  expect(fields('name').value).toBe('Writer');
  submit(h);
  submit(h);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    method: 'POST',
    body: {
      source: { kind: 'subscription', profileId: 'plan-one' },
      mode: 'codex',
      name: 'Writer',
      icon: 'W',
      position: 'Flight-stack reviewer',
      expertise: ['Code review', 'Flight systems'],
      responsibilities: [],
      personality: '',
      permissions: { recoverEmployees: false, moveOwnPlan: false, managePlans: false },
      sleepEnabled: false,
      dreamEnabled: false,
      reportsTo: 'lead',
    },
  });
  expect(h.document.querySelector('.ca-company-hire button[type="submit"]').disabled).toBe(true);
  data.employees.push({ id: 'new-writer', ...calls[0].body, available: true });
  resolve({ ok: true, data: { employee: data.employees.at(-1) } });
  await h.flush();
  expect(h.document.querySelector('.ca-company > [role="status"]').textContent).toBe('Hired Writer.');
  expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(2);
});
it('uses the same local model profile through an independently selected OpenCode harness', async () => {
  const { h, calls, resolve } = await setup();
  await h.shell.openCompany('people');
  const fields = fill(h);
  fields('plan').value = 'local:local-one';
  fields('plan').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  fields('mode').value = 'opencode';
  fields('mode').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  expect(fields('model')).toBeNull();
  expect(fields('effort')).toBeNull();
  submit(h);
  expect(calls[0].body).toMatchObject({
    source: { kind: 'local', endpointId: 'local-one' },
    mode: 'opencode',
  });
  expect(calls[0].body).not.toHaveProperty('model');
  expect(calls[0].body).not.toHaveProperty('effort');
  expect(calls[0].body).not.toHaveProperty('sessionId');
  resolve({ ok: false, error: 'Synthetic refusal' });
  await h.flush();
});
it('server refusal preserves form values and shows the real error without adding an employee', async () => {
  const { h, calls, resolve } = await setup();
  await h.shell.openCompany('people');
  const fields = fill(h);
  submit(h);
  expect(calls).toHaveLength(1);
  resolve({ ok: false, error: 'Owner sign-in required' });
  await h.flush();
  expect(h.document.querySelector('.ca-company-hire [role="alert"]').textContent).toBe('Owner sign-in required');
  expect(fields('name').value).toBe('Writer');
  expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(1);
});
it('unverified owner does not get hiring controls, even if the legacy company response says canManage', async () => {
  const { h } = await setup(false);
  await h.shell.openCompany('people');
  expect(h.document.querySelector('.ca-company form')).toBeNull();
  expect(h.document.querySelector('.ca-company-signin')).not.toBeNull();
});
it('company helper and real API client serialize hiring payload exactly once', async () => {
  class App {}
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { employee: { id: 'new' } } }) });
  const context = { ReverieApp: App, fetch, window: {} };
  runInNewContext(readFileSync(new URL('../src/web/public/api-client.js', import.meta.url), 'utf8'), context);
  runInNewContext(readFileSync(new URL('../src/web/public/company-ui.js', import.meta.url), 'utf8'), context);
  const app = new App() as any;
  const body = { name: 'Writer', expertise: ['Review'] };
  await app._companyApi('/employees', 'POST', body);
  const call = fetch.mock.calls[0];
  expect(call[0]).toBe('/api/company/employees');
  expect(JSON.parse(call[1].body)).toEqual(body);
  expect(typeof JSON.parse(call[1].body)).toBe('object');
});
it('legacy settings Company button delegates to the native surface when chat is mounted', async () => {
  class App {}
  runInNewContext(readFileSync(new URL('../src/web/public/company-ui.js', import.meta.url), 'utf8'), {
    ReverieApp: App,
    window: {},
  });
  const app = new App() as any;
  const openCompany = vi.fn();
  app._chatApp = { built: true, openCompany };
  await app.openCompany();
  expect(openCompany).toHaveBeenCalledOnce();
});

it('uses pictures with initials fallback and no icon selector', async () => {
  const { h } = await setup();
  await h.shell.openCompany('people');
  expect(h.document.querySelector('.ca-company-hire [name="icon"]')).toBeNull();
  const picture = h.document.querySelector('.ca-company-hire .ca-picture')!;
  h.shell.imageToIcon = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
  const input = picture.querySelector('input')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ type: 'image/png', size: 8 }] });
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.flush();
  expect(picture.querySelector('img')).not.toBeNull();
  const clear = [...picture.querySelectorAll('button')].find((b) => b.textContent === 'Use initials')!;
  clear.click();
  expect(picture.querySelector('img')).toBeNull();
});

it('a photo failure after successful hiring reports the existing expert and never repeats hiring', async () => {
  const { h, data, calls, resolve } = await setup();
  await h.shell.openCompany('people');
  fill(h);
  h.shell.imageToIcon = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
  const input = h.document.querySelector('.ca-company-hire input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ type: 'image/png', size: 8 }] });
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.flush();
  const fetch = vi.spyOn(h.window, 'fetch').mockResolvedValue({ ok: false } as Response);
  submit(h);
  expect(calls).toHaveLength(1);
  data.employees.push({ id: 'new-expert', sessionId: 'new-runtime', ...calls[0].body, available: true });
  resolve({ ok: true, data: { employee: data.employees.at(-1), sessionId: 'new-runtime' } });
  await h.flush();
  expect(fetch).toHaveBeenCalledWith(
    '/api/company/agents/new-runtime/avatar',
    expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'image/png' } })
  );
  expect(calls).toHaveLength(1);
  expect(h.document.querySelector('.ca-company > [role="status"]')!.textContent).toContain('expert is already hired');
  expect(h.document.querySelectorAll('.ca-company-person')).toHaveLength(2);
});

it('the owner can replace or clear an expert photo with initials fallback and stable identity', async () => {
  const { h, data } = await setup();
  const employee = data.employees[0];
  employee.avatar = '/api/avatars/' + A + '?v=1';
  const api = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company/employees/lead') {
      Object.assign(employee, options.body);
      return { ok: true, data: { employee } };
    }
    return api(path, options);
  };
  const fetch = vi.spyOn(h.window, 'fetch').mockImplementation(async (path: string, options: any) => {
    if (path === '/api/company/agents/' + A + '/avatar' && options.method === 'DELETE') {
      delete employee.avatar;
      return { ok: true } as Response;
    }
    return { ok: false } as Response;
  });
  await h.shell.openCompany('people');
  expect(h.document.querySelector('.ca-company-person img')!.getAttribute('src')).toBe('/api/avatars/' + A + '?v=1');
  (h.document.querySelector('[aria-label="Edit profile for Inspector"]') as HTMLElement).click();
  const dialog = h.document.querySelector('.ca-expert-profile')!;
  expect(dialog.querySelector('[name="icon"]')).toBeNull();
  ([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Use initials') as HTMLElement).click();
  dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush();
  expect(fetch).toHaveBeenCalledWith('/api/company/agents/' + A + '/avatar', { method: 'DELETE' });
  expect(employee.id).toBe('lead');
  expect(employee.icon).toBe('I');
  expect(employee.avatar).toBeUndefined();
  expect(h.document.querySelector('.ca-company-person img')).toBeNull();
});

it('loads the illustrated pack and saves a selected picture through the upload flow', async () => {
  const { h } = await setup();
  const blob = new h.window.Blob(['image'], { type: 'image/png' });
  vi.spyOn(h.window, 'fetch').mockImplementation(async (path: string) => ({
    ok: true,
    json: async () => ({ avatars: [
      { id: 'pack-01', name: 'Deadpan Rocket', src: '/assets/avatars/pack-01.png' },
      { id: 'pack-02', name: 'Invalid external', src: 'https://example.com/image.png' },
    ] }),
    blob: async () => blob,
  }) as Response);
  h.shell.imageToIcon = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
  await h.shell.openCompany('people');
  await h.flush();
  expect(h.document.querySelector('[aria-label="Expert illustrations"]')).toBeNull();
  (h.document.querySelector('.ca-company-hire [aria-label="Choose avatar"]') as HTMLElement).click();
  await h.flush();
  const gallery = h.document.querySelector('[aria-label="Expert illustrations"]')!;
  expect(gallery.querySelectorAll('button')).toHaveLength(1);
  (gallery.querySelector('[aria-label="Use Deadpan Rocket"]') as HTMLElement).click();
  await h.flush();
  expect(h.shell.imageToIcon).toHaveBeenCalledWith(blob);
  expect(h.document.querySelector('.ca-company-hire .ca-picture img')).not.toBeNull();
});

it('offers optional pronouns at hire and carries an explicit choice into the saved profile', async () => {
  const { h, calls, resolve } = await setup();
  await h.shell.openCompany('people');
  fill(h);
  const pronouns = h.document.querySelector('.ca-company-hire [name="pronouns"]') as HTMLInputElement;
  expect(pronouns.required).toBe(false);
  pronouns.value = 'they/them';
  submit(h);
  expect(calls[0].body.pronouns).toBe('they/them');
  resolve({ ok: false, error: 'test refusal' });
  await h.flush();
});

it('uses the selected plan’s default harness without carrying a previous OpenCode choice', async () => {
  const { h } = await setup();
  await h.shell.openCompany();
  const fields = fill(h);
  fields('plan').value = 'local:local-one';
  fields('plan').dispatchEvent(new h.window.Event('change'));
  fields('mode').value = 'opencode';
  fields('plan').value = 'subscription:plan-one';
  fields('plan').dispatchEvent(new h.window.Event('change'));
  expect(fields('mode').value).toBe('codex');
  expect(fields('name').value).toBe('Writer');
  expect(fields('position').value).toBe('Flight-stack reviewer');
});
