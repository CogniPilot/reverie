import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

// The owner's Wake action: the scoped recovery route the CLI's agent wake-employee uses. The server decides; the button
// never retries, never interrupts a running agent, and shows the server's report (or that it could not be confirmed).
const sid = '0000002d-0035-4000-8000-000000000047';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
async function setup({ onVacation = false } = {}) {
  const employee = { id: 'expert', sessionId: sid, name: 'Alex', available: true, onVacation, desiredRunning: !onVacation };
  const company = { canManage: true, employees: [employee], settings: {} };
  const h = await createHarness({ company, sessions: [{ id: sid, name: 'Alex', mode: 'codex' }], rooms: [room('r1', 'Office', [member(sid, 'Alex')])] }); opened.push(h);
  const original = h.app._chatApi.bind(h.app); const calls: any[] = []; let reply: any = { ok: true, data: { recovery: { awakened: ['expert'], skipped: [] } } }; let finish: any;
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
    if (path === '/api/company') return { ok: true, data: company };
    if (/\/(wake|restart)$/.test(path)) { calls.push({ path, ...options }); if (reply instanceof Error) throw reply; return reply ?? new Promise(resolve => { finish = resolve; }); }
    return original(path, options);
  };
  h.shell.company = company;
  h.shell.phoneStatus = { self: 'owner', canSetOwn: true };
  const toasts = () => h.app.toasts.map((toast: any) => toast.text);
  const menuWake = () => {
    h.shell.openMemberMenu(member(sid, 'Alex'), h.document.querySelector('.ca-member'));
    return [...h.document.querySelectorAll('.ca-popmenu button')].find((button: any) => button.textContent.startsWith('Wake')) as any; // a disabled entry also carries its reason
  };
  return { h, employee, calls, toasts, menuWake, reply: (value: any) => { reply = value; }, resolve: (value: any) => finish(value) };
}

it('wakes the named employee once from the member menu, without a danger style, and says it woke them', async () => {
  const { h, employee, calls, toasts, menuWake, reply, resolve } = await setup();
  const wake = menuWake();
  expect(wake.classList.contains('is-danger')).toBe(false);
  reply(null); wake.click(); void h.shell.wakeEmployee(employee); await h.flush();
  expect(calls).toEqual([{ path: '/api/company/employees/expert/wake', method: 'POST', body: {} }]);
  expect(toasts()).toContain('A wake is already in progress for Alex.');
  resolve({ ok: true, data: { recovery: { awakened: ['expert'], skipped: [] } } }); await h.flush();
  expect(toasts()).toContain('Woke Alex. Check that their terminal is ready.');
  expect(employee).toMatchObject({ id: 'expert', sessionId: sid });
});

it.each([
  [{ awakened: [], skipped: [] }, 'Alex is already running. Nothing was started.'],
  [{ awakened: [], skipped: [{ employeeId: 'expert', reason: 'intentionally-ended' }] }, 'Alex was not woken: their session was ended on purpose. Use Restart session to resume it.'],
  [{ awakened: [], skipped: [{ employeeId: 'expert', reason: 'disabled-or-retry-limited' }] }, 'Alex was not woken: a restart is running for them, or their wake limit (three in fifteen minutes) is reached.'],
  [{ awakened: [], skipped: [{ employeeId: 'expert', reason: 'remote-or-docker' }] }, 'Alex was not woken: they run on another host or in a container, which Wake cannot start. Use Restart session.'],
  [{ awakened: [], skipped: [{ employeeId: 'expert', reason: 'some-future-reason' }] }, 'Alex was not woken: some-future-reason.'],
])('shows the server report as it is: %j', async (recovery, text) => {
  const { h, employee, calls, toasts, reply } = await setup();
  reply({ ok: true, data: { recovery } }); await h.shell.wakeEmployee(employee);
  expect(calls).toHaveLength(1); expect(toasts()).toContain(text);
});

it('an attempted start with an unknown outcome says so, sends one request and never retries', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { h, employee, calls, toasts, reply } = await setup();
    reply({ ok: true, data: { recovery: { awakened: [], skipped: [{ employeeId: 'expert', reason: 'start-unconfirmed' }] } } });
    await h.shell.wakeEmployee(employee);
    await vi.advanceTimersByTimeAsync(60_000); await h.flush();
    expect(calls).toEqual([{ path: '/api/company/employees/expert/wake', method: 'POST', body: {} }]);
    expect(toasts()).toContain('Startup of Alex could not be confirmed. Check their status before trying again.');
    expect(toasts().some((text: string) => text.includes('was not woken') || text.startsWith('Woke'))).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('shows a refusal from the server and does not retry it', async () => {
  const { h, employee, calls, toasts, reply } = await setup();
  reply({ ok: false, status: 409, error: 'Return the employee from vacation before waking them' });
  await h.shell.wakeEmployee(employee); await h.flush();
  expect(calls).toHaveLength(1); expect(toasts()).toContain('Return the employee from vacation before waking them');
});

it.each([
  ['no HTTP response', { ok: false, status: 0 }],
  ['a thrown request', new Error('network')],
  ['a report for someone else', { ok: true, data: { recovery: { awakened: ['other'], skipped: [] } } }],
  ['a report with no arrays', { ok: true, data: {} }],
])('says the wake is unconfirmed after %s, and does not retry', async (_name, value) => {
  const { h, employee, calls, toasts, reply } = await setup();
  reply(value); await h.shell.wakeEmployee(employee); await h.flush();
  expect(calls).toHaveLength(1);
  expect(toasts()).toContain('Wake for Alex could not be confirmed. Check their status before trying again.');
  expect(toasts().some((text: string) => text.startsWith('Woke'))).toBe(false);
});

it('offers Wake beside Restart in the detailed Company profile, and posts the same scoped wake', async () => {
  const { h, calls } = await setup(); await h.shell.openCompany();
  expect(h.document.querySelector('.ca-company-chart [aria-label="Wake Alex"]')).toBeNull();
  h.document.querySelector('[aria-label="Edit profile for Alex"]').click(); await h.flush();
  const wake = h.document.querySelector('.ca-expert-profile [aria-label="Wake Alex"]');
  expect(wake.disabled).toBe(false); expect(wake.classList.contains('is-danger')).toBe(false);
  wake.click(); await h.flush();
  expect(calls).toEqual([{ path: '/api/company/employees/expert/wake', method: 'POST', body: {} }]);
});

it('keeps Wake disabled for an expert who is out of office, in the menu and the profile', async () => {
  const { h, calls, menuWake } = await setup({ onVacation: true });
  const wake = menuWake();
  expect(wake.disabled).toBe(true); expect(wake.textContent).toContain('Bring this expert into the office'); wake.click(); await h.flush();
  h.shell.closePopover?.(); await h.shell.openCompany();
  h.document.querySelector('[aria-label="Edit profile for Alex"]').click(); await h.flush();
  const profileWake = h.document.querySelector('.ca-expert-profile [aria-label="Wake Alex"]');
  expect(profileWake.disabled).toBe(true); expect(profileWake.title).toContain('Bring this expert into the office');
  expect(calls).toHaveLength(0);
});

it('offers Wake beside Restart on the profile card of a dead pane, and only there', async () => {
  const { h, employee, calls } = await setup();
  const session = h.app.sessions.get(sid) ?? { id: sid, name: 'Alex', mode: 'codex' };
  h.shell.humanSelf = { role: 'owner' };
  const card = () => { h.shell.openProfile(h.shell.room.members[0], h.document.querySelector('.ca-member')); return h.flush(); };
  await card();
  expect(h.document.querySelector('.ca-profile-actions [aria-label="Wake Alex"]')).toBeNull(); // a live agent needs no wake
  h.shell.closeProfile();
  Object.assign(employee, { runtimeHealth: 'dead', runtimeHealthScope: 'provider' });
  Object.assign(session, { pid: 123, runtimeHealth: 'dead', runtimeHealthScope: 'provider', paneExit: { status: 137 } }); h.app.sessions.set(sid, session);
  await card();
  const actions = [...h.document.querySelectorAll('.ca-profile-actions button')].map((button: any) => button.textContent);
  expect(actions.indexOf('Wake')).toBeGreaterThan(-1); expect(actions.indexOf('Wake')).toBe(actions.indexOf('Restart session') - 1);
  h.document.querySelector('.ca-profile-actions [aria-label="Wake Alex"]').click(); await h.flush();
  expect(calls).toEqual([{ path: '/api/company/employees/expert/wake', method: 'POST', body: {} }]);
});
