/**
 * The owner's journal map: entries sized by importance and faded when superseded, joined by their own links and shared
 * topics, laid out the same way every time, read only through the owner journal route.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';

const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.js'), 'utf8');
const mod = { exports: {} as Record<string, any> };
new Function('module', src)(mod);
const { caJournalGraph, caJournalLayout, caJournalRadius } = mod.exports;

const entry = (entryId: number, extra: Record<string, unknown> = {}) => ({
  entryId, committedAt: '2026-11-02T13:00:00.000Z', text: `memory ${entryId}`, tags: [] as string[], sources: [], supersededBy: [] as number[], ...extra,
});

describe('journal graph', () => {
  it('sizes by importance and marks superseded entries', () => {
    expect([caJournalRadius('keystone'), caJournalRadius('important'), caJournalRadius('notable'), caJournalRadius(undefined)])
      .toEqual([22, 16, 12, 9]);
    const g = caJournalGraph([entry(1, { annotations: { importance: 'keystone' }, supersededBy: [2] }), entry(2)]);
    expect(g.nodes.map((n: any) => [n.id, n.r, n.superseded])).toEqual([[1, 22, true], [2, 9, false]]);
  });

  it('keeps supersedes and related links once, and drops links to entries not on the page', () => {
    const g = caJournalGraph([
      entry(1), entry(2, { annotations: { supersedes: [1, 99], related: [1, 3] } }), entry(3, { annotations: { related: [2] } }),
    ]);
    expect(g.edges.map((e: any) => [e.source, e.target, e.kind])).toEqual([[2, 1, 'supersedes'], [2, 3, 'related']]);
  });

  it('joins shared tags or topics, at most three per entry, preferring the larger overlap', () => {
    const list = [entry(1, { tags: ['a', 'b'] }), entry(2, { tags: ['a', 'b'] }), entry(3, { tags: ['a'] }), entry(4, { tags: ['a'] }),
      entry(5, { tags: ['a'] }), entry(6, { annotations: { topics: ['B'] } })];
    const g = caJournalGraph(list);
    const of1 = g.edges.filter((e: any) => e.source === 1 || e.target === 1).map((e: any) => (e.source === 1 ? e.target : e.source));
    expect(of1[0]).toBe(2);
    expect(g.edges.every((e: any) => e.kind === 'shared')).toBe(true);
    // Entry 3 overlaps four others by one tag each: it keeps three of them, the lowest ids first.
    const g3 = caJournalGraph([entry(3, { tags: ['a'] }), entry(4, { tags: ['a'] }), entry(5, { tags: ['a'] }), entry(7, { tags: ['a'] }), entry(8, { tags: ['a'] })]);
    const from3 = g3.edges.filter((e: any) => e.source === 3).map((e: any) => e.target);
    expect(from3).toEqual([4, 5, 7]);
    expect(g.edges.some((e: any) => [e.source, e.target].includes(6) && [e.source, e.target].includes(1))).toBe(true);
  });

  it('ignores malformed rows', () => {
    expect(caJournalGraph([null, { entryId: 'x' }, entry(1)] as any).nodes.map((n: any) => n.id)).toEqual([1]);
    expect(caJournalGraph(undefined as any)).toEqual({ nodes: [], edges: [] });
  });
});

describe('journal layout', () => {
  const many = Array.from({ length: 300 }, (_, i) => entry(i + 1, {
    tags: [`t${i % 7}`], annotations: { importance: ['keystone', 'important', 'notable', undefined][i % 4], ...(i ? { related: [i] } : {}) },
  }));

  it('draws the same map every time, inside the box', () => {
    const g = caJournalGraph(many);
    const a = caJournalLayout(g, { width: 900, height: 600 }), b = caJournalLayout(g, { width: 900, height: 600 });
    expect([...a]).toEqual([...b]);
    for (const node of g.nodes) {
      const p = a.get(node.id);
      expect(p.x).toBeGreaterThanOrEqual(node.r); expect(p.x).toBeLessThanOrEqual(900 - node.r);
      expect(p.y).toBeGreaterThanOrEqual(node.r); expect(p.y).toBeLessThanOrEqual(600 - node.r);
    }
  });

  it('separates nodes and stays fast enough for 300 entries', () => {
    const g = caJournalGraph(many);
    const started = performance.now();
    const p = caJournalLayout(g, { width: 900, height: 600 });
    expect(performance.now() - started).toBeLessThan(5000);
    const points = [...p.values()];
    const distinct = new Set(points.map((q: any) => `${q.x},${q.y}`));
    expect(distinct.size).toBe(points.length);
  });

  it('lays out nothing for an empty journal', () => {
    expect(caJournalLayout({ nodes: [], edges: [] }).size).toBe(0);
  });
});

describe('journal map dialog', () => {
  const open: any[] = [];
  afterEach(() => { for (const h of open.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });

  async function setup(pages: Array<{ entries: any[]; more: boolean } | { status: number }>) {
    const h: any = await createHarness({});
    open.push(h);
    const calls: string[] = [];
    h.app._chatApi = async (path: string) => {
      calls.push(path);
      const page = pages.shift();
      if (!page) return { ok: false, status: 500 };
      return 'status' in page ? { ok: false, status: page.status } : { ok: true, data: page };
    };
    return { h, calls };
  }

  it('reads every page through the owner route and draws one node per entry, the most important selected', async () => {
    const { h, calls } = await setup([
      { entries: [entry(3, { annotations: { supersedes: [1] } }), entry(2, { annotations: { importance: 'keystone' } })], more: true },
      { entries: [entry(1, { supersededBy: [3] })], more: false },
    ]);
    await h.shell.openJournalMap({ id: 'emp-1', name: 'Sage' });
    expect(calls).toEqual(['/api/company/employees/emp-1/journal', '/api/company/employees/emp-1/journal?before=2']);
    const dialog = h.document.querySelector('.ca-journal-dialog');
    expect(dialog.querySelectorAll('.ca-journal-node')).toHaveLength(3);
    expect(dialog.querySelectorAll('.ca-journal-node.is-superseded')).toHaveLength(1);
    expect(dialog.querySelectorAll('.ca-journal-edge.is-supersedes')).toHaveLength(1);
    expect(dialog.querySelector('.ca-journal-node.is-selected').getAttribute('aria-label')).toContain('Memory 2, keystone');
    expect(dialog.querySelector('[role="status"]').textContent).toBe('3 memories.');
  });

  it('shows entry text as text, links between memories, and filters by word', async () => {
    const { h } = await setup([{ entries: [
      entry(2, { text: '<img src=x onerror="window.hacked=1"> plan', tags: ['deploy'], annotations: { importance: 'keystone', supersedes: [1] },
        sources: [{ roomId: 'office', id: 'm-1', quote: 'go ahead', status: 'unverified', detail: '' }] }),
      entry(1, { supersededBy: [2] }),
    ], more: false }]);
    await h.shell.openJournalMap({ id: 'emp-1', name: 'Sage' });
    const dialog = h.document.querySelector('.ca-journal-dialog');
    const detail = dialog.querySelector('.ca-journal-detail');
    expect(detail.querySelector('img')).toBeNull();
    expect(detail.querySelector('.ca-journal-text').textContent).toContain('<img src=x');
    expect(detail.textContent).toContain('office/m-1: "go ahead"');
    detail.querySelector('button[aria-label="Supersedes memory 1"]').click();
    expect(dialog.querySelector('.ca-journal-node.is-selected').getAttribute('aria-label')).toContain('Memory 1');
    const search = dialog.querySelector('input[type="search"]');
    search.value = 'deploy'; search.dispatchEvent(new h.window.Event('input'));
    expect(dialog.querySelectorAll('.ca-journal-node.is-dim')).toHaveLength(1);
    expect((h.window as any).hacked).toBeUndefined();
  });

  it('says when the journal is empty, the reader is not the owner, or only the newest 500 are shown', async () => {
    let s = await setup([{ entries: [], more: false }]);
    await s.h.shell.openJournalMap({ id: 'emp-1', name: 'Sage' });
    expect(s.h.document.querySelector('.ca-journal-dialog [role="status"]').textContent).toBe('Sage has no journal entries yet.');
    s = await setup([{ status: 403 }]);
    await s.h.shell.openJournalMap({ id: 'emp-1', name: 'Sage' });
    expect(s.h.document.querySelector('.ca-journal-dialog [role="status"]').textContent).toBe('Sign in as the owner to see this journal.');
    const big = Array.from({ length: 6 }, (_, p) => ({ entries: Array.from({ length: 100 }, (_, i) => entry(1000 - p * 100 - i)), more: true }));
    s = await setup(big);
    await s.h.shell.openJournalMap({ id: 'emp-1', name: 'Sage' });
    expect(s.calls).toHaveLength(5);
    expect(s.h.document.querySelectorAll('.ca-journal-node')).toHaveLength(500);
    expect(s.h.document.querySelector('.ca-journal-dialog [role="status"]').textContent).toBe('500 memories (the newest 500).');
  }, 30_000);
});

describe('the Journal map button on the owner profile', () => {
  const opened: any[] = [];
  afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); });

  it('opens the map for that employee through the owner journal route', async () => {
    const sessionId = '0000002d-0035-4000-8000-000000000047', employeeId = '11111111-2222-4333-8444-555555555555';
    const employee = { id: employeeId, name: 'River', icon: 'R', position: 'Reviewer', sessionId, available: true,
      reportsTo: 'owner', onVacation: false, permissions: {} };
    const data: any = { canManage: true, settings: { ownerName: 'Owner' }, employees: [employee] };
    const { member, room } = await import('./helpers/chat-app-harness.mjs');
    const h: any = await createHarness({ sessions: [{ id: sessionId, name: 'River', mode: 'claude' }],
      rooms: [room('office', 'Office', [member(sessionId, 'River')])], company: data });
    opened.push(h);
    const previous = h.app._chatApi.bind(h.app);
    const journalCalls: string[] = [];
    h.app._chatApi = async (path: string, opts: any) => {
      if (path === '/api/owner/status') return { ok: true, data: { configured: true, signedIn: true, identity: { id: 'owner', role: 'owner', primary: true } } };
      if (path === '/api/company' && !opts) return { ok: true, data };
      if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
      if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
      if (path.startsWith(`/api/company/employees/${employeeId}/journal`)) {
        journalCalls.push(path);
        return { ok: true, data: { entries: [entry(1, { annotations: { importance: 'important' } })], more: false } };
      }
      return previous(path, opts);
    };
    await h.shell.openCompany('people');
    h.document.querySelector('[aria-label="Edit profile for River"]').click();
    await h.flush();
    const button = h.document.querySelector('.ca-expert-profile [aria-label="Open River\'s journal map"]');
    expect(button?.textContent).toBe('Journal map');
    button.click();
    await h.flush();
    expect(journalCalls).toEqual([`/api/company/employees/${employeeId}/journal`]);
    expect(h.document.querySelectorAll('.ca-journal-dialog .ca-journal-node')).toHaveLength(1);
  }, 30_000);
});
