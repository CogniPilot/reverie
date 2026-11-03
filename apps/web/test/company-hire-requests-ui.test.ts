import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

// The owner's list of delegate hire requests on the Company page: details shown as data, one approval, no retries.
const sid = '0000002d-0035-4000-8000-000000000047';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
const pending = {
  id: 'req-1', templateId: 'alpha', templateSha256: 'a'.repeat(64), requestedBy: 'agent:delegate-1', requestedAt: Date.parse('2026-10-31T01:00:00Z'),
  status: 'pending', fields: { workingDir: '/work/parser', reason: 'Need a <b>parser</b> reviewer', name: 'Parsa', position: 'Parser reviewer',
    reportsTo: 'lead', mode: 'codex', accountProfileId: 'plan-b', rooms: ['r1'] },
};
async function setup({ requests = [pending], owner = true } = {}) {
  const employees = [{ id: 'lead', sessionId: sid, name: 'Lena', available: true }];
  const company = { canManage: true, employees, settings: {} };
  const h = await createHarness({ company, sessions: [{ id: sid, name: 'Lena', mode: 'claude' }], rooms: [room('r1', 'Office', [member(sid, 'Lena')])] }); opened.push(h);
  const original = h.app._chatApi.bind(h.app); const calls: any[] = []; let reply: any = { ok: true, data: { request: { ...pending, status: 'approved' }, hire: { id: 'h1' } } };
  let list = requests;
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    if (path === '/api/company') return { ok: true, data: company };
    if (path === '/api/experts-hire-requests') return { ok: true, data: { requests: list } };
    if (path.startsWith('/api/experts-hire-requests/')) { calls.push({ path, ...options }); if (reply.ok) list = []; return reply; }
    return original(path, options);
  };
  h.shell.company = company;
  await h.shell.openCompany(); await h.flush(); await h.flush();
  return { h, calls, reply: (value: any) => { reply = value; } };
}
const card = (h: any) => h.document.querySelector('.ca-company-hire-requests [data-request-id="req-1"]');

it('shows the owner each open request with its details as text, and approves it with one click', async () => {
  const { h, calls } = await setup();
  const shown = card(h);
  expect(shown.textContent).toContain('Parsa · Parser reviewer');
  for (const text of ['agent:delegate-1', 'Lena', 'codex', 'plan-b', '/work/parser', 'Need a <b>parser</b> reviewer']) expect(shown.textContent).toContain(text);
  expect(shown.querySelector('b')).toBeNull(); // the reason is data, never markup
  shown.querySelector('[aria-label="Approve and hire for request req-1"]').click();
  shown.querySelector('[aria-label="Approve and hire for request req-1"]').click();
  await h.flush(); await h.flush();
  expect(calls).toEqual([{ path: '/api/experts-hire-requests/req-1/approve', method: 'POST', body: {} }]);
  expect(h.app.toasts.some((t: any) => t.text === "Hired Parsa on agent:delegate-1's request.")).toBe(true);
  expect(h.document.querySelector('.ca-company-hire-requests')).toBeNull(); // repainted: nothing left open
});

it('shows a refusal and offers the click again; an unanswered approval is called unconfirmed and is not offered again', async () => {
  const { h, calls, reply } = await setup();
  reply({ ok: false, status: 409, error: 'Hire limit reached: 3 of 3 in the last 24 hours' });
  card(h).querySelector('.is-primary').click(); await h.flush();
  expect(card(h).querySelector('[role="alert"]').textContent).toContain('Hire limit reached');
  expect(card(h).querySelector('.is-primary').disabled).toBe(false);
  reply({ ok: false });
  card(h).querySelector('.is-primary').click(); await h.flush();
  expect(card(h).querySelector('[role="alert"]').textContent).toContain('outcome is unconfirmed');
  expect(card(h).querySelector('.is-primary').disabled).toBe(true);
  expect(calls).toHaveLength(2);
});

it('declines, marks an unfinished approval, and shows nothing when there is nothing open or the viewer is not the owner', async () => {
  const declined = await setup();
  card(declined.h).querySelector('[aria-label="Decline request req-1"]').click(); await declined.h.flush();
  expect(declined.calls).toEqual([{ path: '/api/experts-hire-requests/req-1/decline', method: 'POST', body: {} }]);
  const stuck = await setup({ requests: [{ ...pending, status: 'approving' }] });
  expect(card(stuck.h).querySelector('.is-primary').disabled).toBe(true);
  expect(card(stuck.h).textContent).toContain('did not finish');
  const none = await setup({ requests: [{ ...pending, status: 'declined' }] });
  expect(none.h.document.querySelector('.ca-company-hire-requests')).toBeNull();
  const agent = await setup({ owner: false });
  expect(agent.h.document.querySelector('.ca-company-hire-requests')).toBeNull();
});
