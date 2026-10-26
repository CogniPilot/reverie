import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';
const sid = '00000026-002d-4000-8000-00000000003c';
const opened: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
async function fixture({ out = true, owner = true } = {}) {
  const employee = { id: 'expert/one', sessionId: sid, name: 'River', position: 'Reviewer', onVacation: out, desiredRunning: !out };
  const company = { canManage: owner, employees: [employee], settings: {} };
  const h = await createHarness({ company, sessions: [{ id: sid, name: 'River', mode: 'codex' }], rooms: [room('general', 'General', [member(sid, 'River', { goal: 'A long goal', progress: 'A long progress update' })])] });
  opened.push(h);
  const previous = h.app._chatApi.bind(h.app);
  const calls: any[] = [];
  const auth = { self: owner ? 'owner' : 'agent', canSetOwn: owner };
  let answer: any;
  h.app._chatApi = async (path: string, options: any) => {
    if (path === '/api/company') return { ok: true, data: company };
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: auth };
    if (path.endsWith('/vacation')) {
      calls.push({ path, ...options });
      return answer ?? { ok: true, data: { employee: { ...employee, onVacation: options.body.enabled }, startup: { state: 'started' } } };
    }
    return previous(path, options);
  };
  await h.shell.loadOwner();
  const confirm = vi.spyOn(h.shell, 'confirmCompanyAction').mockResolvedValue(true);
  const m = h.shell.room.members[0];
  const anchor = h.document.querySelector(`[data-key="member:${sid}"]`)!;
  const menu = () => { h.shell.openMemberMenu(m, anchor); return h.document.querySelector('.ca-member-menu')!; };
  const action = (label: string) => [...menu().querySelectorAll<HTMLButtonElement>('button')].find(b => b.querySelector('.ca-menu-label')?.firstChild?.textContent === label)!;
  return { h, employee, calls, auth, confirm, m, anchor, menu, action, response(value: any) { answer = value; } };
}
it('offers a green enabled Enter office and posts the return direction after confirmation', async () => {
  const f = await fixture(); const enter = f.action('Enter office');
  expect(enter.disabled).toBe(false); expect(enter.classList.contains('is-success')).toBe(true); expect(f.action('Leave office')).toBeUndefined();
  f.action('Enter office').click(); await f.h.flush();
  expect(f.confirm).toHaveBeenCalledWith('River', expect.stringContaining('starts their laptop'), 'Enter office');
  expect(f.calls).toEqual([{ path: '/api/company/employees/expert%2Fone/vacation', method: 'POST', body: { enabled: false } }]);
  expect(f.employee.onVacation).toBe(false); expect(f.action('Leave office')).toBeDefined();
});
it('keeps Leave office red for an in-office employee', async () => {
  const f = await fixture({ out: false }); expect(f.action('Enter office')).toBeUndefined();
  const leave = f.action('Leave office'); expect(leave.disabled).toBe(false); expect(leave.classList.contains('is-danger')).toBe(true);
  leave.click(); await f.h.flush(); expect(f.calls[0].body).toEqual({ enabled: true });
});
it('refuses revoked owner access before posting any return request', async () => {
  const f = await fixture(); const enter = f.action('Enter office'); f.auth.canSetOwn = false;
  enter.click(); await f.h.flush(); expect(f.calls).toHaveLength(0); expect(f.employee.onVacation).toBe(true);
});
it('does not expose lifecycle actions to an employee caller', async () => {
  const f = await fixture(); f.h.app._chatSelf = sid;
  expect(f.action('Enter office')).toBeUndefined(); expect(f.action('Leave office')).toBeUndefined();
});
it('does not change local office state after a refusal or an unconfirmed result', async () => {
  const f = await fixture();
  for (const result of [{ ok: false, error: 'Refused' }, { ok: true, data: { employee: { id: 'other', onVacation: false } } }]) {
    f.response(result); f.action('Enter office').click(); await f.h.flush(); expect(f.employee.onVacation).toBe(true);
  }
});
it('reports startup failure separately from the saved office state', async () => {
  const f = await fixture(); f.response({ ok: true, data: { employee: { ...f.employee, onVacation: false }, startup: { state: 'failed' } } });
  f.action('Enter office').click(); await f.h.flush(); expect(f.employee.onVacation).toBe(false);
  expect(f.h.app.toasts.at(-1).text).toContain('startup failed'); expect(f.h.app.toasts.at(-1).text).not.toContain('Agent started');
});
it('sends no request when the owner cancels the confirmation', async () => {
  const f = await fixture(); f.confirm.mockResolvedValue(false); f.action('Enter office').click(); await f.h.flush(); expect(f.calls).toHaveLength(0);
});
it('makes the left-click profile compact and keeps operational controls in right-click', async () => {
  const f = await fixture(); f.h.shell.openProfile(f.m, f.anchor); await f.h.flush();
  const card = f.h.document.querySelector('.ca-profile')!;
  expect(card.classList.contains('ca-profile--compact')).toBe(true); expect(card.textContent).toContain('Out of office');
  expect([...card.querySelectorAll('.ca-profile-actions button')].map(b => b.textContent)).toEqual(['Message', 'Edit profile']);
  const technical = card.querySelector<HTMLDetailsElement>('.ca-profile-technical')!;
  expect(technical.open).toBe(false); expect(technical.textContent).toContain('A long progress update');
  expect(f.action('Runtime settings')).toBeDefined(); expect(f.action('Enter office')).toBeDefined();
});
it('shows muted state in the channel and header and clears it on unmute', async () => {
  const f = await fixture(); expect(f.h.document.querySelector('.ca-head-bell')).toBeNull();
  f.h.shell.setNotify('general', { until: -1 }); await f.h.flush();
  const row = f.h.document.querySelector('[data-key="room:general"]')!;
  expect(row.querySelector('.ca-muted-badge')?.textContent).toBe('Muted'); expect(row.getAttribute('aria-label')).toContain('muted');
  expect(f.h.document.querySelector<HTMLElement>('.ca-head .ca-muted-badge')!.hidden).toBe(false);
  f.h.shell.setNotify('general', { until: 0 }); await f.h.flush();
  expect(f.h.document.querySelector('[data-key="room:general"] .ca-muted-badge')).toBeNull();
  expect(f.h.document.querySelector<HTMLElement>('.ca-head .ca-muted-badge')!.hidden).toBe(true);
});

it('keeps a visible mute marker when stored notification preferences are loaded', async () => {
  const h = await createHarness({ rooms: [room('general', 'General', [member(sid, 'River')])], sessions: [{ id: sid, name: 'River' }], stored: { 'reverie:chat:notify': JSON.stringify({ general: { level: 'default', until: -1 } }) } });
  opened.push(h);
  expect(h.document.querySelector('[data-key="room:general"] .ca-muted-badge')?.textContent).toBe('Muted');
  expect(h.document.querySelector<HTMLElement>('.ca-head .ca-muted-badge')!.hidden).toBe(false);
});
