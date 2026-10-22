import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); });
async function setup() {
  const h = await createHarness(); opened.push(h);
  const voices = [{ voiceURI: 'device-voice', name: 'Device voice', lang: 'en-US' }];
  const synth = { getVoices: () => voices, speak: vi.fn(), cancel: vi.fn() };
  Object.defineProperty(h.window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(h.window, 'SpeechSynthesisUtterance', { value: class { constructor(public text: string) {} }, configurable: true });
  const form = h.document.createElement('form'); h.document.body.append(form);
  const pronouns = { value: 'they/them' }, name = { value: 'River' };
  const api = vi.fn(async () => ({ ok: true, data: { voices: [] } })); h.app._chatApi = api;
  return { h, synth, form, pronouns, name, api };
}
it('previews an explicitly chosen device voice without hiring or depending on pronouns', async () => {
  const { h, synth, form, pronouns, name, api } = await setup();
  const fields = h.shell.expertVoiceFields(form, pronouns, name);
  await h.flush();
  const select = form.querySelector('select');
  select.value = JSON.stringify({ provider: 'browser', id: 'device-voice' });
  pronouns.value = 'she/her';
  expect(fields.value()).toEqual({ provider: 'browser', id: 'device-voice' });
  form.querySelector('button').click(); await h.flush();
  expect(synth.speak).toHaveBeenCalledOnce();
  expect(synth.speak.mock.calls[0][0].voice.voiceURI).toBe('device-voice');
  expect(form.querySelector('button').textContent).toBe('Stop sample');
  form.querySelector('button').click();
  expect(synth.cancel).toHaveBeenCalledOnce();
  expect(form.querySelector('button').textContent).toBe('Play sample');
  expect(api.mock.calls.every(([path]) => path === '/api/voice/options')).toBe(true);
});
it('retains a saved choice on another device and explains why it cannot preview there', async () => {
  const { h, synth, form, pronouns, name } = await setup();
  const saved = { provider: 'browser', id: 'other-device' };
  const fields = h.shell.expertVoiceFields(form, pronouns, name, saved);
  await h.flush();
  expect(fields.value()).toEqual(saved);
  form.querySelector('button').click(); await h.flush();
  expect(form.textContent).toContain('not installed on this device');
  expect(synth.speak).not.toHaveBeenCalled();
});
it('previews a server voice and reports service failure without changing selection', async () => {
  const { h, form, pronouns, name, api } = await setup();
  api.mockImplementation(async (path) => path === '/api/voice/options'
    ? { ok: true, data: { voices: [{ provider: 'piper', id: 'test', label: 'Test voice', language: 'en-US' }] } }
    : { ok: false, error: 'Voice service offline' });
  const fields = h.shell.expertVoiceFields(form, pronouns, name);
  await h.flush();
  form.querySelector('select').value = JSON.stringify({ provider: 'piper', id: 'test' });
  form.querySelector('button').click(); await h.flush();
  expect(api).toHaveBeenCalledWith('/api/voice/preview', { method: 'POST', body: { voice: { provider: 'piper', id: 'test' } } });
  expect(fields.value()).toEqual({ provider: 'piper', id: 'test' });
  expect(form.textContent).toContain('Voice service offline');
  expect(form.querySelector('button').disabled).toBe(false);
});
