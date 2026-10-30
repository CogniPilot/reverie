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
  h.document.querySelector<HTMLButtonElement>('.ca-office-gear')!.click(); await h.flush();
  return h;
}

it('keeps Office navigation only at the workspace gear and leaves the sidebar for channels', async () => {
  const h = await fixture();
  expect(h.document.querySelector('.ca-pages')).toBeNull();
  expect(h.document.querySelector('.ca-item--room')).not.toBeNull();
  expect(h.document.querySelector('.ca-office-links')).toBeNull();
  h.shell.renderSidebar();
  expect(h.document.querySelectorAll('.ca-office-nav')).toHaveLength(0);
  expect(h.document.querySelectorAll('.ca-office-gear')).toHaveLength(1);
});

it.each([false, true])('the workspace-gutter panel exposes only Company and Board (narrow=%s)', async narrow => {
  const h = await fixture({ narrow, owner: true });
  expect(h.document.querySelector('.ca-rail .ca-office-gear')).not.toBeNull();
  expect(h.window.location.hash).toBe('');
  expect(h.document.querySelector('.ca-office-page')).toBeNull();
  const menu = h.document.querySelector('.ca-office-pane')!;
  expect(menu.tagName).toBe('NAV'); expect((menu as HTMLElement).hidden).toBe(false);
  expect(h.app.settingsOpened).toBeUndefined();
  const entries = [...menu.querySelectorAll<HTMLButtonElement>('button')];
  expect(entries.map(n => n.textContent)).toEqual(['Company', 'Board', 'Workspace']);
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
  expect(h.document.querySelector('.ca-root > .ca-office-pane')).not.toBeNull();
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
  h.shell.openPage('office'); h.document.querySelector<HTMLButtonElement>('.ca-office-head [aria-label="Back to Company / tools"]')!.click(); await h.flush(); await h.flush();
  expect(h.shell.embed).toBe('company'); expect(h.window.location.hash).toBe('#company');
  expect(h.shell.roomId).toBe('general');
});

it.each(['office', 'board', 'handbook', 'workspace', 'bots', 'people', 'previews', 'company', 'company-people'])('keeps #%s deep links and reload navigation working', async kind => {
  const h = await fixture({ hash: '#' + kind }); await h.flush();
  expect(h.shell.embed).toBe(kind.startsWith('company') ? 'company' : kind);
  expect(h.document.querySelector('.ca-office-gear')!.getAttribute('aria-current')).toBe('page');
  expect(h.document.querySelector('.ca-page')!.hidden).toBe(false);
});

it('opens the owner failure view under a mounted base and preserves preview deep-link fields', async () => {
  const h = await fixture({ owner: true });
  h.window.__REVERIE_BASE__ = '/office';
  const anchor = h.document.createElement('button'); h.document.body.append(anchor);
  await h.shell.openCompanyTools(anchor);
  const failures = [...h.document.querySelectorAll<HTMLButtonElement>('[aria-label="Company tools"] button')]
    .find(button => button.textContent === 'Command failures');
  expect(failures).toBeDefined(); failures!.click();
  expect(h.document.querySelector('iframe[title="Command failures"]')!.getAttribute('src')).toBe('/office/command-failures');
  expect(h.shell.roomId).toBe('general');
  h.document.querySelector<HTMLButtonElement>('.ca-tool-page-head button')!.click();
  await h.flush(); await h.flush();
  expect(h.shell.embed).toBe('company');
  h.window.history.replaceState(null, '', '#previews?sessionId=example&port=8106&path=%2Fview');
  h.shell.openPage('previews', { push: false });
  expect(h.document.querySelector('iframe[title="Laptop previews"]')!.getAttribute('src'))
    .toBe('/office/previews?sessionId=example&port=8106&path=%2Fview');
});

async function warmBoardFixture() {
  const h = await fixture({ owner: true });
  let owner = true, identity = 'owner'; const idle: (() => void)[] = [], writes: string[] = [];
  const previous = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options: any = {}) => {
    if (options.method && options.method !== 'GET') writes.push(path);
    if (path === '/api/company') return { ok: true, data: { canManage: owner, employees: [], settings: {} } };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    if (path === '/api/office/me') return { ok: true, data: { person: { id: identity, role: owner ? 'owner' : 'limited', primary: identity === 'owner' } } };
    return previous(path, options);
  };
  (h.window as any).requestIdleCallback = (callback: () => void) => idle.push(callback);
  h.shell._boardWarmAttempted = false;
  const warm = async () => { h.shell.scheduleBoardWarm(); idle.shift()?.(); await h.flush(); await h.flush(); };
  return { h, idle, writes, warm, revoke: () => { owner = false; }, changeOwner: () => { identity = 'other-owner'; } };
}
it('warms only one owner-bound Board without navigating or changing an existing draft', async () => {
  const { h, warm, writes } = await warmBoardFixture(); const prior = h.shell.roomId;
  const input = h.shell.els.composerInput(); input.value = 'Unsent draft';
  await warm(); const cache = h.shell._boardCache; expect(cache.owner).toBe('owner:true'); expect(cache.panel.hidden).toBe(true);
  expect(cache.frame.getAttribute('src')).toBe('/board'); expect(cache.frame.dataset.boardActive).toBe('false');
  await warm(); expect(h.document.querySelectorAll('.ca-board-frame')).toHaveLength(1); expect(h.shell.embed).toBeNull();
  expect(h.shell.roomId).toBe(prior); expect(input.value).toBe('Unsent draft'); expect(writes).toEqual([]);
});
it('retains the same Board iframe across close and other pages while suspending its visibility', async () => {
  const { h, warm, writes } = await warmBoardFixture(); await warm(); const frame = h.shell._boardCache.frame;
  await h.shell.openWarmBoard(); expect(h.shell.embed).toBe('board'); expect(frame.dataset.boardActive).toBe('true');
  h.shell.closePage(); expect(frame.getAttribute('src')).toBe('/board'); expect(frame.dataset.boardActive).toBe('false');
  h.shell.openPage('workspace'); expect(h.shell._boardCache.frame).toBe(frame); expect(h.shell._boardCache.panel.hidden).toBe(true);
  await h.shell.openWarmBoard(); expect(h.shell._boardCache.frame).toBe(frame); expect(h.shell.embed).toBe('board'); expect(writes).toEqual([]);
});
it('discards a retained document on current owner revocation or a different owner identity', async () => {
  const { h, warm, revoke, writes } = await warmBoardFixture(); await warm(); const old = h.shell._boardCache.frame;
  revoke(); await h.shell.openWarmBoard(); expect(h.shell._boardCache).toBeNull(); expect(old.isConnected).toBe(false); expect(writes).toEqual([]);
  const next = await warmBoardFixture(); await next.warm(); const prior = next.h.shell._boardCache.frame; next.changeOwner();
  await next.h.shell.openWarmBoard(); expect(prior.isConnected).toBe(false); expect(next.h.shell._boardCache).toBeNull();
});
it('does not let a stale owner check or idle callback restore a document after revocation/navigation', async () => {
  const { h, warm } = await warmBoardFixture(); await warm();
  let finish!: (value: string) => void; h.shell.readBoardOwnerKey = () => new Promise(resolve => { finish = resolve; });
  const opening = h.shell.openWarmBoard(); await h.shell.openCompany('people'); finish('owner:true'); await opening;
  expect(h.shell.embed).toBe('company'); expect(h.shell._boardCache.panel.hidden).toBe(true);
  const pending = await warmBoardFixture(); let finishWarm!: (value: string) => void;
  pending.h.shell.readBoardOwnerKey = () => new Promise(resolve => { finishWarm = resolve; });
  pending.h.shell.scheduleBoardWarm(); pending.idle.shift()?.();
  // A current identity notification invalidates even an older successful in-flight warm check.
  pending.h.shell.checkBoardIdentity({ id: 'owner', role: 'limited', primary: true });
  finishWarm('owner:true'); await pending.h.flush(); await pending.h.flush();
  expect(pending.h.shell._boardCache).toBeNull();
});
it('rejects wrong-window/origin Board authority messages and accepts only its exact retained frame', async () => {
  const { h, warm } = await warmBoardFixture(); await warm(); const frame = h.shell._boardCache.frame;
  const send = (origin: string, source: Window) => h.window.dispatchEvent(new h.window.MessageEvent('message', { origin, source, data: { type: 'board-auth-lost' } }));
  send('https://foreign.test', frame.contentWindow); send(h.window.location.origin, h.window); expect(h.shell._boardCache).not.toBeNull();
  send(h.window.location.origin, frame.contentWindow); expect(h.shell._boardCache).toBeNull(); expect(frame.isConnected).toBe(false);
});

it('drops cached private content when a current phone-authority read reports logout', async () => {
  const {h,warm}=await warmBoardFixture();await warm();const frame=h.shell._boardCache.frame;const previous=h.app._chatApi.bind(h.app);
  h.app._chatApi=async(path:string,options:any)=>path==='/api/chatrooms/phone-status'?{ok:false,status:401}:previous(path,options);
  await h.shell.loadPhoneStatus();expect(h.shell._boardCache).toBeNull();expect(frame.isConnected).toBe(false);
});
it('leaves an unsaved detailed profile open while an authorized idle Board is prepared', async () => {
  const {h,warm,writes}=await warmBoardFixture();
  h.shell.openEmployeeProfile({id:'river',sessionId:'runtime',sessionGeneration:1,name:'River',position:'Engineer',expertise:[],responsibilities:[],permissions:{}},()=>{});
  const dialog=h.document.querySelector('.ca-expert-profile')!,field=dialog.querySelector<HTMLInputElement>('[name=position]')!;field.value='Unsaved role';
  await warm();expect(dialog.isConnected).toBe(true);expect(field.value).toBe('Unsaved role');expect(h.shell._boardCache.panel.hidden).toBe(true);expect(writes).toEqual([]);
});

it.each(['debug','transient-debug','hidden','hidden-before-event'])('cannot activate a delayed cached Board open after %s', async mode => {
  const {h,warm}=await warmBoardFixture();await warm();const cache=h.shell._boardCache;
  let finish!: (value:string)=>void;h.shell.readBoardOwnerKey=()=>new Promise(resolve=>{finish=resolve;});const opening=h.shell.openWarmBoard();
  if(mode==='debug'||mode==='transient-debug'){h.shell.setView('debug');if(mode==='transient-debug')h.shell.setView('chat');}
  else {Object.defineProperty(h.document,'hidden',{configurable:true,value:true});if(mode==='hidden')h.document.dispatchEvent(new h.window.Event('visibilitychange'));}
  finish('owner:true');await opening;
  expect(cache.panel.hidden).toBe(true);expect(cache.frame.dataset.boardActive).toBe('false');
  if(mode!=='transient-debug') {h.shell.notifyBoard(true);expect(cache.frame.dataset.boardActive).toBe('false');}
});
