import { afterEach, expect, it } from 'vitest';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';
const windows: Array<{ close(): void }> = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});
const sid = '11111111-2222-4333-8444-555555555555';
async function setup() {
  const person = {
    id: 'employee-one',
    sessionId: sid,
    name: 'River',
    icon: '🧭',
    position: 'Engineer',
    expertise: ['testing'],
    permissions: {},
    sleepEnabled: false,
    dreamEnabled: false,
  };
  const h = await createHarness({
    rooms: [
      room('room', 'Office', [member(sid, 'River')], {
        messages: [message('post', 'room', { ...agent(sid, 'River'), employeeId: person.id }, 'Hello', 1)],
      }),
    ],
  });
  windows.push(h.window);
  h.server.company = { canManage: true, settings: { ownerName: 'Owner' }, employees: [person] };
  const original = h.server.handle;
  const updates: any[] = [];
  h.server.handle = async (path: string, options: any = {}) => {
    if (path === '/api/company/employees/' + person.id && options.method === 'PUT') {
      updates.push(options.body);
      for (const [key, value] of Object.entries(options.body)) {
        if (value === null) delete (person as any)[key];
        else (person as any)[key] = value;
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { employee: { ...person } } }) };
    }
    return original(path, options);
  };
  await h.shell.loadOwner();
  await h.flush();
  const open = () => {
    h.shell.openEmployeeProfile({ ...person });
    return h.document.querySelector('.ca-expert-profile')!;
  };
  const change = (input: HTMLInputElement, color: string) => {
    input.value = color;
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  };
  const save = async (editor: Element) => {
    editor.querySelector('form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true, bubbles: true }));
    await h.flush();
  };
  return { ...h, person, open, change, save, updates };
}
it('previews and saves the background everywhere, retaining the independent name accent', async () => {
  const h = await setup();
  const accent = h.app._chatAccent(sid);
  const editor = h.open();
  h.change(editor.querySelector('input[type=color]')!, '#12abcd');
  expect(editor.querySelector<HTMLSelectElement>('[name=avatarBackgroundMode]')!.value).toBe('custom');
  expect(editor.querySelector<HTMLElement>('.ca-picture-preview')!.style.backgroundColor).toBe('rgb(18, 171, 205)');
  expect(h.person).not.toHaveProperty('avatarBackground');
  await h.save(editor);
  expect(h.updates.at(-1).avatarBackground).toBe('#12abcd');
  expect(h.updates.at(-1).icon).toBe('🧭');
  expect(h.app._chatAccent(sid)).toBe(accent);
  expect(h.document.querySelector<HTMLElement>('.ca-member .chatroom-avatar')!.style.backgroundColor).toBe(
    'rgb(18, 171, 205)'
  );
  expect(h.shell.avatarFor({ ...agent(sid, 'River'), employeeId: h.person.id }, 'River').style.backgroundColor).toBe(
    'rgb(18, 171, 205)'
  );
  const reopened = h.open();
  expect(reopened.querySelector<HTMLInputElement>('input[type=color]')!.value).toBe('#12abcd');
});
it('supports transparent and automatic modes, and cancel leaves the saved employee unchanged', async () => {
  const h = await setup();
  let editor = h.open();
  h.change(editor.querySelector('input[type=color]')!, '#123456');
  [...editor.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click();
  expect(h.updates).toHaveLength(0);
  expect(h.person).not.toHaveProperty('avatarBackground');
  editor = h.open();
  const mode = editor.querySelector<HTMLSelectElement>('[name=avatarBackgroundMode]')!;
  mode.value = 'transparent';
  mode.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.save(editor);
  expect(h.app._chatAvatar(sid, 'River').style.backgroundColor).toBe('transparent');
  editor = h.open();
  const auto = editor.querySelector<HTMLSelectElement>('[name=avatarBackgroundMode]')!;
  auto.value = 'auto';
  auto.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.save(editor);
  expect(h.updates.at(-1).avatarBackground).toBe(null);
  expect(h.person).not.toHaveProperty('avatarBackground');
  expect(h.app._chatAvatar(sid, 'River').style.backgroundColor).toBe('');
});
