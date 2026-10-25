import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';

const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
  vi.restoreAllMocks();
});
const avatars = Array.from({ length: 50 }, (_, index) => {
  const id = `pack-${String(index + 1).padStart(2, '0')}`;
  return { id, name: `Avatar ${index + 1}`, src: `/assets/avatars/${id}.png` };
});
const photo = 'data:image/png;base64,iVBORw0KGgo=';
it('offers the original 50 and 50 new default avatars, excluding the retired people set while refusing out-of-pack IDs and mismatched sources', async () => {
  const { h, fetch, mount, button } = await fixture({ random: false });
  const expanded = JSON.parse(readFileSync(new URL('../src/web/public/assets/avatars/pack-manifest.json', import.meta.url), 'utf8')).avatars;
  expect(expanded).toHaveLength(100);
  fetch.mockImplementation(async (url: string) => url === '/assets/avatars/pack-manifest.json'
    ? { ok: true, json: async () => ({ avatars: [...expanded,
      { id: 'pack-101', name: 'Sly Jester', src: '/assets/avatars/pack-101.png' },
      { id: 'pack-152', name: 'Outside pack', src: '/assets/avatars/pack-152.png' },
      { id: 'pack-51', name: 'Wrong source', src: 'https://outside.test/private.png' },
      { id: '../private', name: 'Traversal', src: '/assets/avatars/../private.png' },
    ] }) }
    : { ok: true, blob: async () => new h.window.Blob(['avatar'], { type: 'image/png' }) });
  mount(); await h.flush(); button('Choose avatar').click(); await h.flush();
  expect(fetch.mock.calls[0]).toEqual(['/assets/avatars/pack-manifest.json', { cache: 'no-cache', signal: expect.objectContaining({ aborted: false }) }]);
  const dialog = h.document.querySelector('.ca-avatar-dialog')!;
  expect(dialog.querySelectorAll('.ca-expert-portraits button')).toHaveLength(100);
  expect(dialog.textContent).not.toContain('Outside pack');
  expect(dialog.textContent).not.toContain('Wrong source');
  expect(dialog.querySelector('[aria-label="Use Sly Jester"]')).toBeNull();
  expect(expanded.some((avatar: any) => Number(avatar.id.slice(5)) >= 51 && Number(avatar.id.slice(5)) <= 101)).toBe(false);
  const last = dialog.querySelector('[aria-label="Use Merry Dragon"]') as HTMLButtonElement;
  last.click(); await h.flush();
  expect(fetch.mock.calls.some(call => call[0] === '/assets/avatars/pack-151.png')).toBe(true);
  expect(fetch.mock.calls.some(call => String(call[0]).startsWith('https://'))).toBe(false);
});
it('uses the shared compact picker for human profiles without overriding a saved picture', async () => {
  const h = await createHarness({ stored: { 'reverie:chat:profile': JSON.stringify({ name: 'Alex', image: photo }) } });
  opened.push(h);
  const fetch = vi.spyOn(h.window, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ avatars }) } as Response);
  h.shell.openProfileEditor(); await h.flush();
  const dialog = h.document.querySelector('.ca-profile-edit')!;
  expect(dialog.querySelector('.ca-picture-preview img')?.getAttribute('src')).toBe(photo);
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/assets/avatars/pack-manifest.json']);
  expect(dialog.textContent).not.toContain('emoji'); expect(dialog.textContent).not.toContain('agents still see');
  expect(dialog.querySelector('.ca-expert-portraits')).toBeNull();
  const initials = [...dialog.querySelectorAll('button')].find(item => item.textContent === 'Use initials')!;
  initials.click(); const name = dialog.querySelector('input[maxlength="32"]')!;
  name.value = 'Morgan'; name.dispatchEvent(new h.window.Event('input'));
  expect(dialog.querySelector('.ca-picture-preview')!.textContent).toBe('M');
  dialog.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true })); await h.flush();
  expect(h.shell.profile.name).toBe('Morgan'); expect(h.shell.profile.image).toBe(''); expect(h.shell.profile.icon).toBe('');
});
async function fixture({ random = true, current = '' } = {}) {
  const h = await createHarness();
  opened.push(h);
  const form = h.document.createElement('form');
  const name = h.document.createElement('input');
  name.value = 'Alex';
  form.append(name);
  h.document.body.append(form);
  const blob = new h.window.Blob(['avatar'], { type: 'image/png' });
  const fetch = vi.spyOn(h.window, 'fetch').mockImplementation(
    async (path: string) =>
      ({
        ok: true,
        json: async () => ({ avatars }),
        blob: async () => blob,
      }) as Response
  );
  h.shell.imageToIcon = vi.fn(async () => photo);
  const mount = () => h.shell.expertAppearanceFields(form, current, { name, random });
  const button = (label: string) =>
    [...form.querySelectorAll('button')].find((item: any) => item.textContent === label)!;
  return { h, form, name, blob, fetch, mount, button };
}

it('gives a new hire one random avatar from the pack without an inline gallery or reroll on typing', async () => {
  const { h, form, name, fetch, mount } = await fixture();
  vi.spyOn(h.window.Math, 'random').mockReturnValue(0.54);
  const appearance = mount();
  await h.flush();
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    '/assets/avatars/pack-manifest.json',
    '/assets/avatars/pack-28.png',
  ]);
  expect(appearance.picture.value()).toBe(photo);
  expect(form.querySelector('.ca-expert-portraits')).toBeNull();
  expect([...form.querySelectorAll('button')].map((item: any) => item.textContent)).toEqual([
    'Upload picture',
    'Choose avatar',
    'Use initials',
  ]);
  name.value = 'Morgan';
  name.dispatchEvent(new h.window.Event('input'));
  await h.flush();
  expect(h.shell.imageToIcon).toHaveBeenCalledTimes(1);
  expect(appearance.picture.value()).toBe(photo);
});

it('shows live typed initials and never lets a late manifest override an explicit initials choice', async () => {
  const { h, name, form, fetch, mount, button } = await fixture();
  let finish!: (value: unknown) => void;
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const appearance = mount();
  expect(appearance.pending()).toBe(false);
  button('Use initials').click();
  name.value = 'Alex';
  name.dispatchEvent(new h.window.Event('input'));
  expect(form.querySelector('.ca-picture-preview')!.textContent).toBe('A');
  expect(button('Use initials').hidden).toBe(false);
  finish({ ok: true, json: async () => ({ avatars }) });
  await h.flush();
  expect(appearance.picture.value()).toBe('');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(form.querySelector('.ca-picture-preview')!.textContent).toBe('A');
});

it('cancels a superseded random conversion immediately when initials are chosen', async () => {
  const { h, form, mount, button } = await fixture();
  let finish!: (value: string) => void;
  h.shell.imageToIcon = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const appearance = mount();
  await h.flush();
  expect(appearance.pending()).toBe(true);
  button('Use initials').click();
  expect(appearance.pending()).toBe(false);
  finish(photo);
  await h.flush();
  expect(appearance.picture.value()).toBe('');
  expect(form.querySelector('.ca-picture-preview')!.textContent).toBe('A');
});

it('keeps an explicit upload when an older automatic conversion finishes later', async () => {
  const { h, form, mount } = await fixture();
  let finishRandom!: (value: string) => void;
  h.shell.imageToIcon = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRandom = resolve;
        })
    )
    .mockResolvedValueOnce(photo);
  const appearance = mount();
  await h.flush();
  const input = form.querySelector('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ type: 'image/png', size: 4 }] });
  input.dispatchEvent(new h.window.Event('change'));
  await h.flush();
  expect(appearance.picture.value()).toBe(photo);
  finishRandom('data:image/png;base64,AAAA');
  await h.flush();
  expect(appearance.picture.value()).toBe(photo);
  expect(appearance.pending()).toBe(false);
});

it('preserves an existing profile and makes Cancel and Escape leave its photo unchanged', async () => {
  const current = '/api/avatars/existing?v=1';
  const { h, fetch, mount, button } = await fixture({ random: false, current });
  const appearance = mount();
  await h.flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(h.shell.imageToIcon).not.toHaveBeenCalled();
  for (const method of ['cancel', 'escape']) {
    button('Choose avatar').click();
    await h.flush();
    const dialog = h.document.querySelector('.ca-avatar-dialog')!;
    expect(dialog.querySelectorAll('.ca-expert-portraits button')).toHaveLength(50);
    if (method === 'cancel') dialog.querySelector('[aria-label=Cancel]').click();
    else dialog.dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
    await h.flush();
    expect(h.document.querySelector('.ca-avatar-dialog')).toBeNull();
    expect(appearance.picture.value()).toBe(current);
  }
});

it('selects from the modal and uses the existing profile picture upload endpoint on save', async () => {
  const { h, blob, fetch } = await fixture({ random: false });
  const employee = { id: 'expert', sessionId: 'runtime', name: 'Alex' };
  h.shell.loadOwner = vi.fn(async () => {});
  h.app._chatApi = vi.fn(async () => ({ ok: true, data: { employee } }));
  h.shell.openEmployeeProfile(employee);
  h.document.querySelector('.ca-expert-profile [aria-label="Choose avatar"]').click();
  await h.flush();
  h.document.querySelector('.ca-avatar-dialog [aria-label="Use Avatar 50"]').click();
  await h.flush();
  expect(h.document.querySelector('.ca-avatar-dialog')).toBeNull();
  expect(h.shell.imageToIcon).toHaveBeenCalledWith(blob);
  h.document
    .querySelector('.ca-expert-profile form')
    .dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush();
  expect(fetch).toHaveBeenCalledWith(
    '/api/company/agents/runtime/avatar',
    expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'image/png' } })
  );
});

it('cancels an in-flight modal selection before its conversion can change the preview', async () => {
  const { h, mount, button } = await fixture({ random: false });
  const appearance = mount();
  button('Choose avatar').click();
  await h.flush();
  let finish!: (value: string) => void;
  h.shell.imageToIcon = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  h.document.querySelector('.ca-avatar-dialog [aria-label="Use Avatar 1"]').click();
  await h.flush();
  expect(appearance.pending()).toBe(true);
  h.document.querySelector('.ca-avatar-dialog [aria-label=Cancel]').click();
  expect(appearance.pending()).toBe(false);
  finish(photo);
  await h.flush();
  expect(appearance.picture.value()).toBe('');
});

it('retries a failed catalog on reopening without losing the saved picture', async () => {
  const current = '/api/avatars/existing?v=1';
  const { h, fetch, mount, button } = await fixture({ random: false, current });
  fetch.mockRejectedValueOnce(new Error('prefetch failed'))
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValue({ ok: true, json: async () => ({ avatars }) });
  const appearance = mount(); await h.flush();
  button('Choose avatar').click(); await h.flush();
  expect(h.document.querySelector('.ca-avatar-dialog')!.textContent).toContain('Avatars are unavailable');
  expect(fetch).toHaveBeenCalledTimes(2);
  h.document.querySelector('.ca-avatar-dialog [aria-label=Cancel]').click();
  button('Choose avatar').click(); await h.flush();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(h.document.querySelectorAll('.ca-avatar-dialog .ca-expert-portraits button')).toHaveLength(50);
  expect(appearance.picture.value()).toBe(current);
  expect(appearance.pending()).toBe(false);
});

it('offers explicit Retry after failure and never runs background retry loops', async () => {
  const { h, fetch, mount, button } = await fixture({ random: false });
  fetch.mockRejectedValueOnce(new Error('prefetch failed'))
    .mockRejectedValueOnce(new Error('open failed'))
    .mockResolvedValue({ ok: true, json: async () => ({ avatars }) });
  mount(); await h.flush(); button('Choose avatar').click(); await h.flush();
  const dialog = h.document.querySelector('.ca-avatar-dialog')!;
  const retry = dialog.querySelector('[aria-label="Retry avatars"]') as HTMLButtonElement;
  expect(retry.hidden).toBe(false); expect(retry.disabled).toBe(false);
  await h.flush(); expect(fetch).toHaveBeenCalledTimes(2);
  retry.click(); await h.flush();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(dialog.querySelectorAll('.ca-expert-portraits button')).toHaveLength(50);
  expect(retry.hidden).toBe(true);
});

it('bounds a hung request, aborts it and permits one explicit retry', async () => {
  const { h, fetch, mount, button } = await fixture({ random: false });
  fetch.mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue({ ok: true, json: async () => ({ avatars }) });
  const before = h.window.__watchdogs.length;
  mount(); button('Choose avatar').click(); await h.flush();
  const watchdog = h.window.__watchdogs.slice(before).find((timer: any) => timer.ms === 5000)!;
  expect(watchdog).toBeDefined(); watchdog.fn(); await h.flush();
  const dialog = h.document.querySelector('.ca-avatar-dialog')!;
  expect(dialog.textContent).toContain('took too long');
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await h.flush(); expect(fetch).toHaveBeenCalledTimes(1);
  dialog.querySelector('[aria-label="Retry avatars"]').click(); await h.flush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(dialog.querySelectorAll('.ca-expert-portraits button')).toHaveLength(50);
});

it('keeps the same deadline through catalog JSON decoding and ignores its late result', async () => {
  const { h, fetch, mount, button } = await fixture({ random: false });
  let finish!: (value: unknown) => void;
  fetch.mockResolvedValueOnce({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) })
    .mockResolvedValue({ ok: true, json: async () => ({ avatars }) });
  const before = h.window.__watchdogs.length;
  mount(); button('Choose avatar').click(); await h.flush();
  h.window.__watchdogs.slice(before).find((timer: any) => timer.ms === 5000)!.fn(); await h.flush();
  const dialog = h.document.querySelector('.ca-avatar-dialog')!;
  dialog.querySelector('[aria-label="Retry avatars"]').click(); await h.flush();
  finish({ avatars: [{ ...avatars[0], name: 'Stale response' }] }); await h.flush();
  expect(dialog.querySelectorAll('.ca-expert-portraits button')).toHaveLength(50);
  expect(dialog.textContent).not.toContain('Stale response');
});

it('aborts a cancelled chooser and fences its result from a reopened chooser', async () => {
  const { h, fetch, mount, button } = await fixture({ random: false });
  let finish!: (value: unknown) => void;
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ok: true, json: async () => ({ avatars }) });
  const appearance = mount(); button('Choose avatar').click(); await h.flush();
  const old = h.document.querySelector('.ca-avatar-dialog')!;
  old.querySelector('[aria-label=Cancel]').click();
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  button('Choose avatar').click(); await h.flush();
  const current = h.document.querySelector('.ca-avatar-dialog')!;
  finish({ ok: true, json: async () => ({ avatars: [{ ...avatars[0], name: 'Old chooser' }] }) }); await h.flush();
  expect(old.isConnected).toBe(false);
  expect(current.querySelectorAll('.ca-expert-portraits button')).toHaveLength(50);
  expect(current.textContent).not.toContain('Old chooser');
  expect(appearance.picture.value()).toBe('');
});

it('does not retry an empty or invalid catalog until asked and preserves explicit initials', async () => {
  const { h, fetch, mount, button } = await fixture();
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ avatars: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ avatars: [{ id: '../private', src: 'https://outside.test/a.png' }] }) })
    .mockResolvedValue({ ok: true, json: async () => ({ avatars }) });
  const appearance = mount(); await h.flush(); button('Use initials').click();
  button('Choose avatar').click(); await h.flush();
  const dialog = h.document.querySelector('.ca-avatar-dialog')!;
  expect(dialog.textContent).toContain('Avatars are unavailable');
  await h.flush(); expect(fetch).toHaveBeenCalledTimes(2);
  dialog.querySelector('[aria-label="Retry avatars"]').click(); await h.flush();
  expect(dialog.querySelectorAll('.ca-expert-portraits button')).toHaveLength(50);
  expect(appearance.picture.value()).toBe('');
  expect(h.shell.imageToIcon).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(call => call[0] === '/assets/avatars/pack-manifest.json')).toBe(true);
});

it('fetches and previews a versioned transparent replacement while rejecting malformed revisions', async () => {
  const { h, fetch, mount, button } = await fixture({ random: false });
  const src = '/assets/avatars/pack-01.png?v=' + 'a'.repeat(64);
  fetch.mockImplementation(async (url: string) => url === '/assets/avatars/pack-manifest.json'
    ? { ok: true, json: async () => ({ avatars: [
      { id: 'pack-01', name: 'Transparent Rocket', src },
      { id: 'pack-02', name: 'Short version', src: '/assets/avatars/pack-02.png?v=a' },
      { id: 'pack-03', name: 'Extra parameter', src: '/assets/avatars/pack-03.png?v=' + 'b'.repeat(64) + '&outside=1' },
      { id: 'pack-04', name: 'Wrong identity', src: '/assets/avatars/pack-05.png?v=' + 'c'.repeat(64) },
    ] }) }
    : { ok: true, blob: async () => new h.window.Blob(['avatar'], { type: 'image/png' }) });
  mount(); await h.flush(); button('Choose avatar').click(); await h.flush();
  const dialog = h.document.querySelector('.ca-avatar-dialog')!;
  expect(dialog.querySelectorAll('.ca-expert-portraits button')).toHaveLength(1);
  const choice = dialog.querySelector('[aria-label="Use Transparent Rocket"]') as HTMLButtonElement;
  expect(choice.querySelector('img')!.getAttribute('src')).toBe(src);
  choice.click(); await h.flush();
  expect(fetch).toHaveBeenCalledWith(src);
  expect(h.shell.imageToIcon).toHaveBeenCalledTimes(1);
});
