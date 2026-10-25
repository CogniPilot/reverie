import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
const handles: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.window.close(); });

async function fixture({ owner = false, verified = owner, hash = '', narrow = false } = {}) {
  const h = await createHarness({ hash, narrow, rooms: [room('general', 'General', [member('expert', 'Expert')])], sessions: [{ id: 'expert', name: 'Expert' }] });
  handles.push(h);
  const previous = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: { canManage: owner, employees: [], settings: {} } };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: verified ? 'owner' : 'agent', canSetOwn: verified } };
    return previous(path, options);
  };
  return h;
}

it('keeps just one Office entry above channels instead of seven management rows', async () => {
  const h = await fixture();
  expect([...h.document.querySelectorAll('.ca-pages .ca-name')].map(n => n.textContent)).toEqual(['Office']);
  expect(h.document.querySelector('.ca-item--room')).not.toBeNull();
  expect(h.document.querySelector('.ca-office-links')).toBeNull();
  h.shell.renderSidebar();
  expect(h.document.querySelectorAll('.ca-office-nav')).toHaveLength(1);
});

it.each([false, true])('the nameplate gear opens a full Office page with nested terminal settings (narrow=%s)', async narrow => {
  const h = await fixture({ narrow, owner: true });
  h.document.querySelector<HTMLButtonElement>('.ca-user [aria-label="Office settings"]')!.click(); await h.flush();
  expect(h.window.location.hash).toBe('#office');
  expect(h.document.querySelector('.ca-office-page')).not.toBeNull();
  expect(h.document.querySelector('.ca-office-page iframe')).toBeNull();
  expect(h.app.settingsOpened).toBeUndefined();
  expect([...h.document.querySelectorAll('.ca-office-sections button')].map(n => n.textContent)).toEqual(['Company', 'Board', 'Handbook', 'Workspace', 'Bots', 'People', 'Laptop previews']);
  h.document.querySelector<HTMLButtonElement>('[aria-label="Open terminal settings"]')!.click();
  expect(h.app.settingsOpened).toBe(1);
  expect(h.shell.embed).toBe('office');
  expect(h.document.querySelector('.ca-user [aria-label="Shut down Reverie"]')).toBeNull();
});

it('reveals power controls only after owner verification and never executes them on opening Office', async () => {
  const h = await fixture({ owner: true });
  h.app.officePower = vi.fn(async (_action, output) => { output.textContent = 'Host acknowledgement'; });
  h.shell.openPage('office'); await h.flush();
  const buttons = [...h.document.querySelectorAll<HTMLButtonElement>('.ca-office-power button')];
  expect(buttons.map(button => button.textContent)).toEqual(['Stop all agents', 'Restart website', 'Shut down Reverie']);
  expect(h.app.officePower).not.toHaveBeenCalled();
  expect(buttons[0].classList.contains('is-danger')).toBe(true);
  expect(buttons[1].classList.contains('is-danger')).toBe(false);
  expect(buttons[2].classList.contains('is-danger')).toBe(true);
  buttons[2].click(); await h.flush();
  expect(h.app.officePower).toHaveBeenCalledExactlyOnceWith('shutdown', h.document.querySelector('.ca-office-page > [role="status"]'));
});

it.each([{ owner: false }, { owner: true, verified: false }])('does not expose power to unverified or limited access (%j)', async access => {
  const h = await fixture(access); h.shell.openPage('office'); await h.flush();
  expect(h.document.querySelector('.ca-office-power')).toBeNull();
  expect(h.document.querySelectorAll('.ca-office-link')).toHaveLength(0);
  expect(h.document.querySelector('[aria-label="Open terminal settings"]')).not.toBeNull();
});

it('preserves hub links, browser Back/Forward and the selected channel', async () => {
  const h = await fixture({ owner: true });
  h.document.querySelector<HTMLButtonElement>('.ca-office-nav')!.click();
  await h.flush();
  h.document.querySelector<HTMLButtonElement>('.ca-office-sections [data-key="page:board"]')!.click();
  expect(h.document.querySelector('iframe[title="Board"]')!.getAttribute('src')).toBe('/board');
  h.window.history.back(); await new Promise(resolve => setTimeout(resolve, 50));
  expect(h.shell.embed).toBe('office'); expect(h.document.querySelector('.ca-office-page')).not.toBeNull();
  h.window.history.forward(); await new Promise(resolve => setTimeout(resolve, 50));
  expect(h.shell.embed).toBe('board');
  h.shell.openPage('office'); h.document.querySelector<HTMLButtonElement>('.ca-office-head [aria-label="Back to chat"]')!.click();
  expect(h.shell.embed).toBeNull(); expect(h.window.location.hash).toBe('');
  expect(h.shell.roomId).toBe('general');
});

it.each(['office', 'board', 'handbook', 'workspace', 'bots', 'people', 'previews', 'company', 'company-people'])('keeps #%s deep links and reload navigation working', async kind => {
  const h = await fixture({ hash: '#' + kind }); await h.flush();
  expect(h.shell.embed).toBe(kind.startsWith('company') ? 'company' : kind);
  expect(h.document.querySelector('.ca-office-nav')!.getAttribute('aria-current')).toBe('page');
  expect(h.document.querySelector('.ca-page')!.hidden).toBe(false);
});
