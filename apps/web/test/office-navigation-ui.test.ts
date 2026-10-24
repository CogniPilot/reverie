import { afterEach, expect, it } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.window.close();
});

it('collapses all office links, preserves channels, and retains the preference on redraw', async () => {
  const h = await createHarness({
    rooms: [room('general', 'General', [member('expert', 'Expert')])],
    sessions: [{ id: 'expert', name: 'Expert' }],
  });
  handles.push(h);
  const toggle = () => h.document.querySelector('.ca-pages-toggle') as HTMLButtonElement;
  const links = () => h.document.querySelector('.ca-office-links') as HTMLElement;
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  toggle().click();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(links().hidden).toBe(true);
  expect(h.window.localStorage.getItem('reverie:chat:office-collapsed')).toBe('1');
  expect(h.document.querySelector('.ca-item--room')).not.toBeNull();
  h.shell.renderSidebar();
  expect(links().hidden).toBe(true);
  toggle().click();
  expect(links().hidden).toBe(false);
  expect([...links().querySelectorAll('.ca-name')].map((n) => n.textContent)).toEqual([
    'Company',
    'Board',
    'Handbook',
    'Workspace',
    'Bots',
    'People',
    'Laptop previews',
  ]);
  expect(h.window.localStorage.getItem('reverie:chat:office-collapsed')).toBe('0');
});

it('keeps the current office page discoverable while the links are collapsed', async () => {
  const h = await createHarness({ rooms: [room('general', 'General', [])] });
  handles.push(h);
  (h.document.querySelector('.ca-pages-toggle') as HTMLButtonElement).click();
  h.shell.openPage('workspace');
  expect((h.document.querySelector('.ca-office-links') as HTMLElement).hidden).toBe(true);
  expect(h.document.querySelector('.ca-office-current')!.textContent).toBe('Workspace');
  expect(h.document.querySelector('iframe[title="Workspace"]')).not.toBeNull();
  h.shell.openPage('bots');
  expect(h.document.querySelector('.ca-office-current')!.textContent).toBe('Bots');
  expect(h.document.querySelector('iframe[title="Bots"]')!.getAttribute('src')).toBe('/bots');
});
