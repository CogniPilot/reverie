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
  await h.shell.loadOwner();
  return h;
}

it('keeps Office navigation only at the footer gear and leaves the sidebar for channels', async () => {
  const h = await fixture();
  expect(h.document.querySelector('.ca-pages')).toBeNull();
  expect(h.document.querySelector('.ca-item--room')).not.toBeNull();
  expect(h.document.querySelector('.ca-office-links')).toBeNull();
  h.shell.renderSidebar();
  expect(h.document.querySelectorAll('.ca-office-nav')).toHaveLength(0);
  expect(h.document.querySelectorAll('.ca-office-gear')).toHaveLength(1);
});

it.each([false, true])('the avatar-aligned persistent panel exposes only Company and Board (narrow=%s)', async narrow => {
  const h = await fixture({ narrow, owner: true });
  expect(h.document.querySelector('.ca-user .ca-office-gear')).not.toBeNull();
  expect(h.window.location.hash).toBe('');
  expect(h.document.querySelector('.ca-office-page')).toBeNull();
  const menu = h.document.querySelector('.ca-office-pane')!;
  expect(menu.tagName).toBe('NAV'); expect((menu as HTMLElement).hidden).toBe(false);
  expect(h.app.settingsOpened).toBeUndefined();
  const entries = [...menu.querySelectorAll<HTMLButtonElement>('button')];
  expect(entries.map(n => n.textContent)).toEqual(['Company', 'Board']);
  entries.find(button => button.textContent === 'Company')!.click(); await h.flush();
  h.document.querySelector<HTMLButtonElement>('.ca-company-tools-button')!.click(); await h.flush();
  [...h.document.querySelectorAll<HTMLButtonElement>('[aria-label="Company tools"] button')].find(button => button.textContent === 'Terminal settings')!.click();
  expect(h.app.settingsOpened).toBe(1);
  expect(h.shell.embed).toBe('company');
  expect(h.document.querySelector('.ca-user [aria-label="Shut down Reverie"]')).toBeNull();
});

it('opens a separate footer power menu without executing an action until selected', async () => {
  const h = await fixture({ owner: true });
  h.app.officePower = vi.fn(async (_action, output) => { output.textContent = 'Host acknowledgement'; });
  const gear = h.document.querySelector('.ca-office-gear')!;
  const power = h.document.querySelector<HTMLButtonElement>('.ca-office-power-button')!;
  expect(gear.parentElement!.classList.contains('ca-office-launcher')).toBe(true);
  expect(gear.nextElementSibling!.classList.contains('ca-office-pane')).toBe(true);
  expect(power.parentElement!.classList.contains('ca-user')).toBe(true);
  power.click(); await h.flush();
  const buttons = [...h.document.querySelectorAll<HTMLButtonElement>('.ca-power-menu button')];
  expect(buttons.map(button => button.textContent)).toEqual(['Stop all agents', 'Restart website', 'Shut down Reverie']);
  expect(h.app.officePower).not.toHaveBeenCalled();
  expect(buttons[0].classList.contains('is-danger')).toBe(true);
  expect(buttons[1].classList.contains('is-danger')).toBe(false);
  buttons[2].click(); await h.flush();
  expect(h.app.officePower).toHaveBeenCalledExactlyOnceWith('shutdown', expect.anything());
});

it('rechecks revoked owner access before offering footer power actions', async () => {
  const h = await fixture({ owner: true }); h.app.officePower = vi.fn();
  const power = h.document.querySelector<HTMLButtonElement>('.ca-office-power-button')!;
  h.app._chatApi = async () => ({ ok: false });
  power.click(); await h.flush();
  expect(h.document.querySelector('.ca-power-menu')).toBeNull();
  expect(h.app.officePower).not.toHaveBeenCalled();
});

it('keeps the requested inline expansion when a presence refresh replaces the footer during access checks', async () => {
  const h = await fixture({ owner: true });
  let release!: (allowed: boolean) => void;
  vi.spyOn(h.shell, 'verifyOfficeOwner').mockReturnValue(new Promise(resolve => { release = resolve; }));
  h.window.localStorage.setItem('reverie:office-expanded', 'false'); h.shell.renderUser();
  const previous = h.document.querySelector<HTMLButtonElement>('.ca-office-gear')!;
  previous.click(); h.shell.renderUser();
  expect(previous.isConnected).toBe(false);
  release(true); await h.flush();
  expect((h.document.querySelector('.ca-office-pane') as HTMLElement).hidden).toBe(false);
  expect(h.shell.embed).toBeNull();
});

it('keeps company tools out of the workspace dropdown and accessible inside Company', async () => {
  const h = await fixture({ owner: true });
  h.app._chatRetired = [{ sessionId: 'old' }];
  const workspaceLabels = h.shell.workspaceEntries('', { full: true }).map(entry => entry.label);
  for (const label of ['Org chart', 'Retired sessions', 'Send diagnostics', 'Custom emotes']) expect(workspaceLabels).not.toContain(label);
  [...h.document.querySelectorAll<HTMLButtonElement>('.ca-office-pane button')].find(button => button.textContent === 'Company')!.click(); await h.flush();
  h.document.querySelector<HTMLButtonElement>('.ca-company-tools-button')!.click(); await h.flush();
  const buttons = [...h.document.querySelectorAll<HTMLButtonElement>('[aria-label="Company tools"] button')];
  expect(buttons.map(button => button.textContent)).toContain('Retired sessions');
  buttons.find(button => button.textContent === 'Org chart')!.click(); await h.flush();
  expect(h.document.querySelector('.ca-org[role="dialog"]')).not.toBeNull();
  h.shell.closeOrg(); expect(h.document.activeElement).toBe(h.document.querySelector('.ca-office-gear'));
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
  expect(h.document.querySelector('.ca-office-power-button')).toBeNull();
});

it('preserves hub links, browser Back/Forward and the selected channel', async () => {
  const h = await fixture({ owner: true });
  h.shell.openPage('office');
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
  expect(h.document.querySelector('.ca-office-gear')!.getAttribute('aria-current')).toBe('page');
  expect(h.document.querySelector('.ca-page')!.hidden).toBe(false);
});
