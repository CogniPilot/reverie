import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';

const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const source = (id: string, label = id) => ({ kind: 'subscription', id, label, modes: ['opencode', 'codex'], defaultMode: 'codex', models: [] });
const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

async function setup(initial = [source('default', 'Default Codex')]) {
  const h = await createHarness();
  opened.push(h);
  const state = { sources: initial, requests: 0, hired: null as any };
  const original = h.app._chatApi.bind(h.app);
  Object.defineProperty(h.window, 'speechSynthesis', {
    value: { getVoices: () => [{ voiceURI: 'my-voice', name: 'My voice', lang: 'en-US' }] },
  });
  h.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: { canManage: true, employees: [], settings: {} } };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/company/hire-options') {
      state.requests++;
      return {
        ok: true,
        data: { sources: state.sources, harnesses: [{ id: 'codex', label: 'Codex', efforts: ['low', 'high'] }, { id: 'opencode', label: 'OpenCode', efforts: [] }] },
      };
    }
    if (path === '/api/voice/options') return { ok: true, data: { voices: [] } };
    if (path === '/api/company/hire') {
      state.hired = options.body;
      return { ok: false, error: 'Captured request' };
    }
    return original(path, options);
  };
  h.shell.imageToIcon = async () => PIXEL;
  await h.shell.openCompany();
  const form = h.document.querySelector('.ca-company-hire form') as HTMLFormElement;
  const field = (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement;
  field('roleTemplate').value = 'custom'; field('roleTemplate').dispatchEvent(new h.window.Event('change'));
  const frame = h.document.querySelector('.ca-company-plans-frame') as HTMLIFrameElement;
  const changed = (origin = h.window.location.origin, from = frame.contentWindow) =>
    h.window.dispatchEvent(
      new h.window.MessageEvent('message', { data: { type: 'company-plans-changed' }, origin, source: from })
    );
  return { h, state, form, field, frame, changed };
}

it('updates added, renamed and removed plans while preserving the entire open hire draft', async () => {
  const { h, state, form, field, changed } = await setup();
  field('plan').value = 'subscription:default';
  field('plan').dispatchEvent(new h.window.Event('change'));
  field('mode').value = 'opencode';
  field('name').value = 'Ellis';
  field('pronouns').value = 'they/them';
  field('position').value = 'Engineer';
  field('expertise').value = 'Systems';
  field('voice').value = JSON.stringify({ provider: 'browser', id: 'my-voice' });
  const picture = form.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(picture, 'files', { value: [new h.window.File(['png'], 'own.png', { type: 'image/png' })] });
  picture.dispatchEvent(new h.window.Event('change'));
  await settle();
  const preserved = () => {
    expect(h.document.querySelector('.ca-company-hire form')).toBe(form);
    expect(field('name').value).toBe('Ellis');
    expect(field('model')).toBeNull();
    expect(field('effort')).toBeNull();
    expect(field('mode').value).toBe('opencode');
    expect(field('position').value).toBe('Engineer');
    expect(field('expertise').value).toBe('Systems');
    expect(field('pronouns').value).toBe('they/them');
    expect(JSON.parse(field('voice').value).id).toBe('my-voice');
    expect(form.querySelector('.ca-picture-preview img')?.getAttribute('src')).toBe(PIXEL);
  };
  state.sources = [source('default', 'Renamed Codex'), source('gmail', 'Gmail Codex')];
  changed();
  await settle();
  preserved();
  expect(field('plan').value).toBe('subscription:default');
  expect([...field('plan').querySelectorAll('option')].map((option) => option.textContent)).toContain('Gmail Codex');
  expect(field('plan').selectedOptions[0].textContent).toBe('Renamed Codex');
  state.sources = [source('gmail', 'Gmail Codex')];
  changed();
  await settle();
  preserved();
  expect(field('plan').value).toBe('');
  field('plan').value = 'subscription:gmail';
  field('plan').dispatchEvent(new h.window.Event('change'));
  expect(field('mode').value).toBe('codex');
  for (let i = 0; i < 3; i++) (form.querySelector('[aria-label="Next"]') as HTMLButtonElement).click();
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await settle();
  expect(state.hired.source).toEqual({ kind: 'subscription', profileId: 'gmail' });
  expect(state.hired).toMatchObject({
    mode: 'codex',
    name: 'Ellis',
    position: 'Engineer',
    expertise: ['Systems'],
    pronouns: 'they/them',
    voice: { provider: 'browser', id: 'my-voice' },
  });
  expect(state.hired).not.toHaveProperty('model');
  expect(state.hired).not.toHaveProperty('effort');
});

it('ignores messages from another frame or origin and refreshes safely on plan focus', async () => {
  const { h, state, field, changed } = await setup();
  const before = state.requests;
  state.sources = [source('gmail', 'Gmail Codex')];
  changed('https://untrusted.invalid');
  changed(h.window.location.origin, h.window);
  await settle();
  expect(state.requests).toBe(before);
  field('name').value = 'Ellis';
  field('position').value = 'Engineer';
  field('plan').dispatchEvent(new h.window.Event('focus'));
  await settle();
  expect(state.requests).toBe(before + 1);
  expect(field('name').value).toBe('Ellis');
  expect(field('position').value).toBe('Engineer');
  expect(field('model')).toBeNull();
  expect(field('effort')).toBeNull();
  expect([...field('plan').querySelectorAll('option')].some((option) => option.value === 'subscription:gmail')).toBe(
    true
  );
  state.sources = [];
  changed();
  await settle();
  expect(field('plan').disabled).toBe(true);
  expect((h.document.querySelector('.ca-company-hire button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
});
