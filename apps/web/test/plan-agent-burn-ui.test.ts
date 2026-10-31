/**
 * The Plans card's per-agent burn block: the realtime rate with its band, the work-unit conversion with its basis, and one
 * line per session, all escaped; nothing at all for a plan without cost reports.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

const html = readFileSync(new URL('../src/web/public/company-plans.html', import.meta.url), 'utf8');
const start = html.indexOf('function agentBurnBlock(p)');
const helper = html.slice(start, html.indexOf('function burnChart(svg, p)', start));
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (v: number | null, d?: number) => (v == null ? '–' : d == null ? v : Math.round(v * 10 ** d) / 10 ** d);
const block = runInNewContext(helper + ';agentBurnBlock', { esc, num, Math }) as (p: unknown) => string;

const burn = {
  conversion: { pctPerUsd: 0.4567, low: 0.3, high: 0.7, basis: 'learned', tier: null },
  fit: { maePerHour: 0.42, biasPerHour: -0.1, n: 6 },
  realtimePerHour: 1.37,
  realtimeLow: 0.9,
  realtimeHigh: 2.1,
  usdPerHour: 3,
  agents: [
    { sessionId: 's1', name: 'Worker <A>', usdPerHour: 2, pctPerHour: 0.91, share: 0.667 },
    { sessionId: 's2', name: 'Worker B', usdPerHour: null, pctPerHour: null, share: null },
  ],
};

it('shows the realtime rate, its band, the learned conversion and one escaped line per session', () => {
  const doc = new JSDOM(`<div>${block({ id: 'acct-1', agentBurn: burn })}</div>`).window.document;
  const root = doc.querySelector('[data-plan-agent-burn="acct-1"]')!;
  expect(root.textContent).toContain('1.37 %/h');
  expect(root.textContent).toContain('(0.9–2.1)');
  expect(root.textContent).toContain('0.457 %/work unit (0.3–0.7, learned from this plan; fit ±0.42 %/h over 6 h)');
  const rows = root.querySelectorAll('li[data-agent-burn]');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('Worker <A>');
  expect(rows[0].innerHTML).not.toContain('<A>');
  expect(rows[0].textContent).toContain('0.91 %/h');
  expect(rows[0].textContent).toContain('2 units/h, 67%');
  expect(rows[1].textContent).toContain('too new to rate');
});

it('names a prior guess and its tier, and says when no session reported cost', () => {
  const prior = { ...burn, fit: null, conversion: { ...burn.conversion, basis: 'prior', tier: '20x' }, agents: [] };
  const doc = new JSDOM(`<div>${block({ id: 'acct-2', agentBurn: prior })}</div>`).window.document;
  expect(doc.body.textContent).toContain('prior guess for 20x)');
  expect(doc.body.textContent).toContain('No session on this plan reported cost in the last 30 minutes.');
  const unknown = { ...prior, conversion: { ...prior.conversion, tier: null } };
  expect(new JSDOM(block({ id: 'x', agentBurn: unknown })).window.document.body.textContent).toContain('prior guess, tier unknown');
});

it('adds nothing for a plan without per-agent burn', () => {
  expect(block({ id: 'acct-3', agentBurn: null })).toBe('');
  expect(block({ id: 'acct-3' })).toBe('');
});

const moveStart = html.indexOf('async function moveImpactText(sessionId, toAccount)');
const moveHelper = html.slice(moveStart, html.indexOf('async function openPlanMove(employeeId, destination)', moveStart));
const IMPACT = {
  usdPerHour: 2,
  from: { label: 'Team plan', endNow: 92.4, endAfter: 71.2 },
  to: { label: 'Big plan', endNow: 10, endAfter: 14.6, endAfterLow: 12.1, endAfterHigh: 19.8, conversion: { basis: 'prior' } },
};

function moveDialog(fetch: unknown) {
  const doc = new JSDOM('<dialog><p data-move-impact></p></dialog>').window.document;
  const show = runInNewContext(moveHelper + ';showMoveImpact', { fetch, encodeURIComponent, Math, AbortController, setTimeout, clearTimeout }) as (d: unknown, s: string, t: string) => Promise<void>;
  return { doc, box: doc.querySelector('[data-move-impact]')!, show: (to: string) => show(doc.querySelector('dialog'), 'session-1', to) };
}
const reply = (status: number, body: unknown) => Promise.resolve({ status, ok: status < 300, json: () => Promise.resolve(body) });

it('shows both plans before and after the move, with the joining band and a prior note', async () => {
  const urls: string[] = [];
  const { box, show } = moveDialog((url: string) => (urls.push(url), reply(200, { success: true, data: IMPACT })));
  await show('acct big');
  expect(urls[0]).toBe('/api/plans/move-impact?session=session-1&to=acct%20big');
  expect(box.textContent).toContain('(2 work units/h)');
  expect(box.textContent).toContain('Team plan 92% → 71%; Big plan 10% → 15% (12%–20%)');
  expect(box.textContent).toContain('prior guess');
});

it('says when there is no work rate yet, or no estimate, without blocking the dialog', async () => {
  let m = moveDialog(() => reply(404, { success: false }));
  await m.show('x');
  expect(m.box.textContent).toBe('No impact estimate yet: this session has no recent work rate.');
  m = moveDialog(() => Promise.reject(new Error('offline')));
  await m.show('x');
  expect(m.box.textContent).toBe('Impact estimate unavailable.');
});

it('never lets a slow answer for an earlier destination overwrite the current one', async () => {
  let release: (v: unknown) => void = () => {};
  const slow = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { box, show } = moveDialog(() => (++calls === 1 ? slow : reply(200, { success: true, data: { ...IMPACT, to: { ...IMPACT.to, label: 'Second' } } })));
  const first = show('first');
  await show('second');
  release({ status: 200, ok: true, json: () => Promise.resolve({ success: true, data: IMPACT }) });
  await first;
  expect(box.textContent).toContain('Second');
  expect(box.textContent).not.toContain('Big plan');
});

it('drops an older answer for the same destination after A to B to A', async () => {
  const pending: Array<(label: string) => void> = [];
  const fetch = () =>
    new Promise((resolve) => {
      pending.push((label) => resolve({ status: 200, ok: true, json: () => Promise.resolve({ success: true, data: { ...IMPACT, to: { ...IMPACT.to, label } } }) }));
    });
  const { box, show } = moveDialog(fetch);
  const firstA = show('A');
  const toB = show('B');
  const secondA = show('A');
  pending[2]('newest A');
  await secondA;
  expect(box.textContent).toContain('newest A');
  pending[0]('oldest A');
  pending[1]('B');
  await Promise.all([firstA, toB]);
  expect(box.textContent).toContain('newest A');
  expect(box.textContent).not.toContain('oldest A');
});

it('drops an answer once the form it was asked for is gone', async () => {
  let release: (v: unknown) => void = () => {};
  const { doc, box, show } = moveDialog(() => new Promise((resolve) => { release = resolve; }));
  const asked = show('A');
  box.remove();
  release({ status: 200, ok: true, json: () => Promise.resolve({ success: true, data: IMPACT }) });
  await asked;
  expect(box.textContent).toBe('Estimating the impact on both plans…');
  expect(doc.querySelector('[data-move-impact]')).toBeNull();
});
