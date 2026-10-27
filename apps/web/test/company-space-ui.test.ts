import { afterEach, expect, it } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const handles: any[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.window.close(); });
async function fixture() {
  const company = { canManage: true, settings: { ownerName: 'Owner' }, employees: [] };
  const h = await createHarness({ company }); handles.push(h);
  let owner = true; const reads: string[] = []; const api = h.app._chatApi.bind(h.app);
  h.app._chatApi = async (path: string, options?: any) => {
    reads.push(path);
    if (path === '/api/company') return { ok: true, data: company };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    return api(path, options);
  };
  h.shell.company = company; h.shell.phoneStatus = { self: 'owner', canSetOwn: true }; h.shell.renderUser();
  h.document.querySelector<HTMLButtonElement>('.ca-office-gear')!.click(); await h.flush();
  return { h, reads, revoke: () => { owner = false; } };
}
it('keeps Company and Board inline across page navigation and persists collapse across rerenders', async () => {
  const { h } = await fixture();
  const pane = () => h.document.querySelector('.ca-office-pane')!;
  const gear = () => h.document.querySelector('.ca-office-gear')!;
  expect(gear().closest('.ca-rail')).not.toBeNull();
  expect(gear().getAttribute('aria-expanded')).toBe('true');
  expect([...pane().querySelectorAll('button')].map((b: any) => b.textContent)).toEqual(['Company', 'Board']);
  (pane().querySelector('button') as HTMLButtonElement).click(); await h.flush();
  expect(h.shell.embed).toBe('company'); expect(pane().hidden).toBe(false);
  gear().click(); await h.flush(); expect(pane().hidden).toBe(true);
  expect(h.window.localStorage.getItem('reverie:office-expanded')).toBe('false');
  h.shell.renderUser(); expect(pane().hidden).toBe(true);
  gear().click(); await h.flush(); expect(pane().hidden).toBe(false);
  expect(h.document.querySelector('.ca-popmenu')).toBeNull();
});
it('rechecks actual owner access on an inline action instead of trusting a persisted panel', async () => {
  const { h, reads, revoke } = await fixture(); revoke();
  (h.document.querySelector('.ca-office-pane button') as HTMLButtonElement).click(); await h.flush();
  expect(reads).toContain('/api/company'); expect(reads).toContain('/api/chatrooms/phone-status');
  expect(h.shell.embed).not.toBe('company');
  expect(h.document.querySelector('.ca-office-pane')!.textContent).not.toContain('Company');
  expect(h.app.toasts.at(-1).text).toContain('Sign in as the owner');
});

it('keeps the gear in the workspace rail across presence and rail refreshes', async () => {
  const {h}=await fixture();h.shell.renderRail();h.shell.renderUser();h.shell.renderRail();
  expect(h.document.querySelectorAll('.ca-office-gear')).toHaveLength(1);
  expect(h.document.querySelector('.ca-rail > .ca-office-launcher .ca-office-gear')).not.toBeNull();
  expect(h.document.querySelector('.ca-user .ca-office-gear')).toBeNull();
  expect(h.document.querySelector('.ca-root > .ca-office-pane')).not.toBeNull();
});
it('places the existing burn-rate section before the People section without removing either', async () => {
  const {h}=await fixture();await h.shell.openCompany('plans');
  const company=h.document.querySelector('.ca-company')!;
  const plans=company.querySelector('.ca-company-plans')!,people=company.querySelector('.ca-company-content')!;
  expect([...company.children].indexOf(plans)).toBeLessThan([...company.children].indexOf(people));
  expect(plans.querySelector('iframe')?.title).toBe('Company plans and burn rate');
});
it.each(['handbook','workspace','bots','people','previews'])('returns %s to Company and its tools through the shell button', async kind => {
  const {h}=await fixture();h.shell.openPage(kind);await h.flush();
  const back=h.document.querySelector<HTMLButtonElement>('.ca-tool-page-head button')!;
  expect(back.textContent).toContain('Back to Company / tools');back.click();await h.flush();await h.flush();
  expect(h.shell.embed).toBe('company');
  expect(h.document.querySelector('[aria-label="Company tools"]')).not.toBeNull();
});
it('rewires only the same-origin embedded back link and preserves the channel and draft', async () => {
  const {h}=await fixture();h.shell.openPage('workspace');const frame=h.document.querySelector('iframe')!;
  frame.contentDocument!.write('<!doctype html><html><body></body></html>');
  frame.contentDocument!.body.innerHTML='<a href="./" target="_top">Back to chat</a><a href="/other">Other link</a>';
  h.shell.configureCompanyToolsBack(frame);expect(frame.contentDocument!.querySelector('a')!.textContent).toBe('Back to Company / tools');
  expect(frame.contentDocument!.querySelectorAll('a')[1].textContent).toBe('Other link');
  const prior=h.shell.roomId;frame.contentDocument!.querySelector('a')!.click();await h.flush();await h.flush();
  expect(h.shell.embed).toBe('company');expect(h.shell.roomId).toBe(prior);
});
