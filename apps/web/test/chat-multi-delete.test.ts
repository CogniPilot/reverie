/**
 * Group delete: pick several messages with Ctrl-click and delete them together. Ctrl-click (Cmd-click on a
 * Mac), or "Select for deleting" in a message's menu, picks messages; the bar over the message box deletes them together
 * after one confirmation, each through the same delete as one at a time, and keeps any it could not delete selected.
 */
import { afterEach, expect, it } from 'vitest';
import { agent, createHarness, member, message, room, user } from './helpers/chat-app-harness.mjs';

const A = '0000002d-0035-4000-8000-0000000000a1';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); });
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  const rooms = [
    room('r1', 'General', [member(A, 'alpha')], {
      messages: [
        message('m1', 'r1', agent(A, 'alpha'), 'one', 1000),
        message('m2', 'r1', agent(A, 'alpha'), 'two', 1100),
        message('m3', 'r1', agent(A, 'alpha'), 'three', 1200),
        message('m4', 'r1', user, 'mine', 1300),
      ],
    }),
    room('r2', 'Ops', [member(A, 'alpha')], { messages: [message('m9', 'r2', agent(A, 'alpha'), 'elsewhere', 2000)] }),
  ];
  const h = await createHarness({ sessions: [{ id: A, name: 'alpha', mode: 'claude' }], rooms });
  opened.push(h);
  const msg = (id: string) => h.document.querySelector(`[data-msg-id="${id}"]`) as HTMLElement;
  const click = (el: Element, keys: { ctrlKey?: boolean; metaKey?: boolean } = { ctrlKey: true }) =>
    el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, ...keys }));
  const bar = () => h.document.querySelector('.ca-select-bar') as HTMLElement;
  const selected = () => [...h.document.querySelectorAll('.ca-msg.is-delete-selected')].map((n) => (n as HTMLElement).dataset.msgId);
  const deletes = () => h.server.calls.filter((c: { method: string }) => c.method === 'DELETE').map((c: { path: string }) => c.path.split('/').pop());
  return { h, msg, click, bar, selected, deletes };
}

it('Ctrl- or Cmd-click picks messages, a plain click or a click on a button does not, and Escape clears', async () => {
  const { h, msg, click, bar, selected } = await setup();
  expect(bar().hidden).toBe(true);
  click(msg('m1'));
  click(msg('m3'), { metaKey: true });
  click(msg('m2'), {});                                          // a plain click
  click(msg('m4').querySelector('[aria-label="More"]') ?? msg('m4').querySelector('button')!); // a button inside keeps its click
  expect(selected()).toEqual(['m1', 'm3']);
  // aria-selected is not a state of role=article: a picked message says so in its label, an unpicked one has none.
  expect(msg('m1').getAttribute('aria-label')).toBe('Selected for deletion');
  expect(msg('m1').hasAttribute('aria-selected')).toBe(false);
  expect(msg('m2').hasAttribute('aria-label')).toBe(false);
  expect(bar().hidden).toBe(false);
  expect(bar().textContent).toContain('2 messages selected');
  click(msg('m3'));                                              // again: unpicks
  expect(selected()).toEqual(['m1']);
  expect(msg('m3').hasAttribute('aria-label')).toBe(false);
  expect(bar().textContent).toContain('1 message selected');
  // The button kept its own click (it opened the message menu): the first Escape closes that menu, the next clears the pick.
  const escape = () => h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(h.document.querySelector('.ca-msg-menu')).not.toBeNull();
  escape();
  expect(h.document.querySelector('.ca-msg-menu')).toBeNull();
  expect(selected()).toEqual(['m1']);
  escape();
  expect(selected()).toEqual([]);
  expect(bar().hidden).toBe(true);
});

it('deletes the picked messages after one confirmation, and keeps any it could not delete selected', async () => {
  const { h, msg, click, bar, selected, deletes } = await setup();
  for (const id of ['m1', 'm2', 'm3']) click(msg(id));
  const deleteButton = () => bar().querySelector('.is-danger') as HTMLButtonElement;
  h.window.confirm = () => false;
  deleteButton().click();
  await settle();
  expect(deletes()).toEqual([]);
  // One refusal from the server (its own rank rule), the rest go through.
  const api = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: { method?: string }) =>
    options?.method === 'DELETE' && path.endsWith('/messages/m2') ? { ok: false, status: 403, error: 'You can only delete messages from someone ranked below you' } : api(path, options);
  let asked = '';
  h.window.confirm = (text: string) => { asked = text; return true; };
  deleteButton().click();
  await settle(120);
  expect(asked).toContain('these 3 messages');
  expect(deletes()).toEqual(['m1', 'm3']);
  expect(msg('m1').classList.contains('is-deleted')).toBe(true);
  expect(msg('m3').classList.contains('is-deleted')).toBe(true);
  expect(msg('m2').classList.contains('is-deleted')).toBe(false);
  expect(selected()).toEqual(['m2']);
  expect(h.app.toasts.at(-1)).toMatchObject({ kind: 'error' });
  expect(h.app.toasts.at(-1).text).toContain('Deleted 2 of 3. 1 could not be deleted: You can only delete messages from someone ranked below you');
});

it('offers "Select for deleting" in a message\'s menu, and a pick does not follow you to another room', async () => {
  const { h, msg, bar, selected } = await setup();
  (msg('m2').querySelector('[aria-label="More"]') as HTMLElement).click();
  const item = (label: string) => [...h.document.querySelectorAll('.ca-msg-menu button')].find((b) => b.textContent === label) as HTMLElement;
  item('Select for deleting').click();
  expect(selected()).toEqual(['m2']);
  (msg('m2').querySelector('[aria-label="More"]') as HTMLElement).click();
  expect(item('Unselect')).toBeTruthy();
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  (msg('m2').querySelector('[aria-label="More"]') as HTMLElement)?.click();
  item('Select for deleting')?.click();
  await h.shell.selectRoom('r2');
  await settle();
  expect(bar().hidden).toBe(true);
  expect(selected()).toEqual([]);
});
