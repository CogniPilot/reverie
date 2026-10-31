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
  expect(root.textContent).toContain('0.457 %/work unit (0.3–0.7, learned from this plan)');
  const rows = root.querySelectorAll('li[data-agent-burn]');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('Worker <A>');
  expect(rows[0].innerHTML).not.toContain('<A>');
  expect(rows[0].textContent).toContain('0.91 %/h');
  expect(rows[0].textContent).toContain('2 units/h, 67%');
  expect(rows[1].textContent).toContain('too new to rate');
});

it('names a prior guess and its tier, and says when no session reported cost', () => {
  const prior = { ...burn, conversion: { ...burn.conversion, basis: 'prior', tier: '20x' }, agents: [] };
  const doc = new JSDOM(`<div>${block({ id: 'acct-2', agentBurn: prior })}</div>`).window.document;
  expect(doc.body.textContent).toContain('prior guess for 20x');
  expect(doc.body.textContent).toContain('No session on this plan reported cost in the last 30 minutes.');
  const unknown = { ...prior, conversion: { ...prior.conversion, tier: null } };
  expect(new JSDOM(block({ id: 'x', agentBurn: unknown })).window.document.body.textContent).toContain('prior guess, tier unknown');
});

it('adds nothing for a plan without per-agent burn', () => {
  expect(block({ id: 'acct-3', agentBurn: null })).toBe('');
  expect(block({ id: 'acct-3' })).toBe('');
});
