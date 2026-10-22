import { afterEach, expect, it } from 'vitest';
import { createHarness, room, member } from './helpers/chat-app-harness.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opened: any[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dom.window.close();
});
async function setup() {
  const h = await createHarness({
    sessions: [{ id: 'local', name: 'Local', mode: 'claude' }],
    rooms: [room('r1', 'General', [member('local', 'Local')])],
  });
  opened.push(h);
  await h.flush(25);
  return { ...h, ui: h.shell.embassy };
}
const note = (h: Awaited<ReturnType<typeof setup>>) => h.shell.els.sideScroll.querySelector('.eg-access-note');

it('a server failure shows the real error and HTTP status, and Retry recovers', async () => {
  const h = await setup();
  h.app._chatApi = async () => ({ ok: false, status: 503, error: 'Service unavailable' });
  await h.ui.refresh();
  expect(note(h)!.getAttribute('role')).toBe('alert');
  expect(note(h)!.textContent).toContain('Embassies unavailable: Service unavailable (HTTP 503)');
  expect(h.shell.els.sideScroll.querySelector('[aria-label="Add embassy channel"]')).toBeNull();
  h.app._chatApi = async () => ({ ok: true, data: { connections: [] } });
  (note(h)!.querySelector('[aria-label="Retry loading embassies"]') as HTMLButtonElement).click();
  await h.flush(25);
  expect(note(h)).toBeNull();
  expect(h.shell.els.sideScroll.querySelector('[aria-label="Add embassy channel"]')).not.toBeNull();
});

it('a thrown transport error reads as a connection failure, without a made-up status', async () => {
  const h = await setup();
  h.app._chatApi = async () => {
    throw new Error('synthetic');
  };
  await h.ui.refresh();
  expect(note(h)!.textContent).toContain('Embassies unavailable: Connection unavailable');
  expect(note(h)!.textContent).not.toContain('HTTP');
});

it('the owner refusal keeps its sign-in note, not the generic alert', async () => {
  const h = await setup();
  h.app._chatApi = async () => ({ ok: false, status: 403, error: 'Forbidden' });
  await h.ui.refresh();
  expect(note(h)!.getAttribute('role')).toBe('status');
  expect(note(h)!.textContent).toContain('owner sign-in');
});

it('_chatApi keeps the HTTP status on a JSON error body', async () => {
  const h = await setup();
  const proto = Object.getPrototypeOf(h.app);
  const api = (proto._chatApi ?? h.app.constructor.prototype._chatApi) as (p: string) => Promise<unknown>;
  const fake = { _api: async () => ({ ok: false, status: 502, json: async () => ({ success: false, error: 'Bad gateway' }) }) };
  expect(await api.call(fake, '/x')).toEqual({ ok: false, status: 502, error: 'Bad gateway' });
});
