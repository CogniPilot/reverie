import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

// The owner's recorded GPU history on the Company page, from /api/resource-history (a whole-host observation).
const sid = '0000002d-0035-4000-8000-000000000047';
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
const now = Math.floor(Date.now() / 1000);
const point = (t: number, avg: number | null, status = 'observed', max?: number) => ({
  t, end: t + 300, samples: avg === null ? 0 : 10, status,
  cpu_pct: null, mem_pct: null, gpu_pct: avg === null ? null : { min: avg, avg, max: max ?? avg, n: 10 },
});
const history = (points: unknown[], freshness = 'fresh') => ({
  version: 1, scope: 'shared-host-unattributed-observations', start: now - 86400, end: now, bucketSeconds: 300,
  freshness, points, effectAuthority: false, employeeAttribution: null,
});
async function setup(reply: (path: string) => any, owner = true) {
  const company = { canManage: true, employees: [{ id: 'lead', sessionId: sid, name: 'Lena', available: true }], settings: {} };
  const h = await createHarness({ company, sessions: [{ id: sid, name: 'Lena', mode: 'claude' }], rooms: [room('r1', 'Office', [member(sid, 'Lena')])] }); opened.push(h);
  const original = h.app._chatApi.bind(h.app); const calls: string[] = [];
  h.app._chatApi = async (path: string, options?: any) => {
    if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: owner ? 'owner' : 'agent', canSetOwn: owner } };
    if (path === '/api/company') return { ok: true, data: company };
    if (path.startsWith('/api/resource-history')) { calls.push(path); return reply(path); }
    if (path === '/api/experts-hire-requests') return { ok: true, data: { requests: [] } };
    return original(path, options);
  };
  h.shell.company = company;
  await h.shell.openCompany(); await h.flush(); await h.flush();
  return { h, calls, section: () => h.document.querySelector('.ca-company-gpu-history') };
}

it('draws the recorded day as lines split at gaps, with average, peak and whole-host wording', async () => {
  const day = now - 86400;
  const { h, calls, section } = await setup(() => ({ ok: true, data: history([
    point(day, 20), point(day + 300, 40, 'observed', 90), point(day + 600, null, 'missing'), point(day + 900, 60, 'partial'), point(day + 1200, 80),
  ]) }));
  await h.flush();
  expect(calls).toHaveLength(1);
  const q = new URLSearchParams(calls[0].split('?')[1]);
  expect(Number(q.get('end')) - Number(q.get('start'))).toBe(86400);
  expect(q.get('resolution')).toBe('five-minute');
  const lines = section().querySelectorAll('polyline');
  expect(lines).toHaveLength(2); // the missing bucket splits the line instead of bridging it
  expect(lines[0].getAttribute('points')!.split(' ')).toHaveLength(2);
  expect(lines[1].getAttribute('points')!.split(' ')).toHaveLength(2);
  const note = section().querySelector('[role="status"]').textContent;
  expect(note).toContain('average 50%'); expect(note).toContain('peak 90%'); expect(note).toContain('whole host');
  expect(note).not.toContain('stale');
  expect(section().querySelector('svg').getAttribute('aria-label')).toBe('GPU utilization over the last day, average 50%, peak 90%');
});

it('switches to a week at hourly resolution and says when the newest reading is stale', async () => {
  const { h, calls, section } = await setup((path) => ({ ok: true, data: history([point(now - 3600, 33)], path.includes('resolution=hour') ? 'stale' : 'fresh') }));
  const week = section().querySelector('[aria-label="GPU history for the last 7 days"]') as HTMLButtonElement;
  week.click(); await h.flush(); await h.flush();
  const q = new URLSearchParams(calls[1].split('?')[1]);
  expect(Number(q.get('end')) - Number(q.get('start'))).toBe(7 * 86400);
  expect(q.get('resolution')).toBe('hour');
  expect(week.getAttribute('aria-pressed')).toBe('true');
  expect(section().querySelector('[role="status"]').textContent).toContain('The newest reading is stale.');
  await h.shell.openCompany(); h.shell.closePage(); await h.shell.openCompany(); await h.flush(); await h.flush(); // a fresh paint
  expect(section().querySelector('[aria-label="GPU history for the last 7 days"]').getAttribute('aria-pressed')).toBe('true');
  expect(calls.at(-1)).toContain('resolution=hour');
});

it('says history is not recorded when the service is off, and shows nothing when the day has no readings', async () => {
  const off = await setup(() => ({ ok: false, status: 503, error: 'HTTP 503' }));
  expect(off.section().querySelector('[role="status"]').textContent).toBe('GPU history is not recorded on this host. The live GPU meter still works.');
  expect(off.section().querySelectorAll('polyline')).toHaveLength(0);
  const empty = await setup(() => ({ ok: true, data: history([point(now - 600, null, 'missing')]) }));
  expect(empty.section().querySelector('[role="status"]').textContent).toBe('No GPU readings were recorded in the last day.');
});

it('is not shown to a viewer who is not the verified owner, and asks nothing', async () => {
  const { calls, section } = await setup(() => ({ ok: true, data: history([]) }), false);
  expect(section()).toBeNull();
  expect(calls).toHaveLength(0);
});
