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
  return { h, reads, revoke: () => { owner = false; } };
}
it('keeps Company and Board inline across page navigation and persists collapse across rerenders', async () => {
  const { h } = await fixture();
  const pane = () => h.document.querySelector('.ca-office-pane')!;
  const gear = () => h.document.querySelector('.ca-office-gear')!;
  expect(gear().closest('.ca-user')).not.toBeNull();
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
