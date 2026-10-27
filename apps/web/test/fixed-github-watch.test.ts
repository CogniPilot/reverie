import { describe, it, expect } from 'vitest';
import { readFixedPr, fixedTarget, parseWatchCursor } from '../src/cron/fixed-github-watch.js';
import type { Fetcher } from '../src/cron/github-source.js';

const target = { owner: 'Example', repo: 'public', pull: 7 };
const head = 'a'.repeat(40);
const now = Date.parse('2026-10-24T12:00:00Z');
const pr = () => ({
  number: 7,
  base: { repo: { private: false, full_name: 'Example/public' } },
  head: { sha: head },
  updated_at: '2026-10-24T10:00:00Z',
  state: 'open',
  merged: false,
  title: '@everyone\n`untrusted` <x>',
});
const run = () => ({
  id: 99,
  head_sha: head,
  run_attempt: 1,
  updated_at: '2026-10-24T10:00:00Z',
  status: 'completed',
  conclusion: 'failure',
});
const check = () => ({
  id: 33,
  head_sha: head,
  name: '@Reviewer private-looking name',
  status: 'completed',
  conclusion: 'failure',
});
const review = () => ({
  id: 22,
  state: 'APPROVED',
  commit_id: head,
  submitted_at: '2026-10-24T10:00:00Z',
  body: 'SECRET BODY MUST NOT PERSIST',
  user: { login: '@secret' },
});
function fixture(change?: (body: unknown, path: string, call: number) => unknown, link?: string) {
  const urls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    urls.push(url);
    expect(init.headers).not.toHaveProperty('Authorization');
    const path = new URL(url).pathname;
    let body: unknown = path.endsWith('/reviews')
      ? [review()]
      : path.endsWith('/check-runs')
        ? { total_count: 1, check_runs: [check()] }
        : path.endsWith('/runs')
          ? { total_count: 1, workflow_runs: [run()] }
          : pr();
    if (change) body = change(body, path, urls.length);
    return { ok: true, status: 200, headers: { get: () => link ?? null }, json: async () => body };
  };
  return { fetcher, urls };
}
describe('fixed public PR metadata', () => {
  it('reads exactly five fixed anonymous queries, projects bounded receipts, removes mentions and bodies', async () => {
    const f = fixture();
    const s = await readFixedPr(target, undefined, f.fetcher, now);
    expect(f.urls).toHaveLength(5);
    expect(s.events).toHaveLength(4);
    expect(s.message).not.toMatch(/[@\r\n`<>]/);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|secret|private-looking|Authorization/);
    const query = new URL(f.urls[3]!);
    expect(query.searchParams.get('head_sha')).toBe(head);
    expect(query.searchParams.get('per_page')).toBe('100');
  });
  it('deduplicates unchanged snapshots, including after cursor serialization/restart', async () => {
    const first = await readFixedPr(target, undefined, fixture().fetcher, now);
    const next = await readFixedPr(target, JSON.stringify(first.cursor), fixture().fetcher, now);
    expect(next.events).toEqual([]);
    expect(next.cursor).toEqual(first.cursor);
  });
  it('records a new run_attempt independently of run ID and repeated status', async () => {
    const first = await readFixedPr(target, undefined, fixture().fetcher, now);
    const next = await readFixedPr(
      target,
      JSON.stringify(first.cursor),
      fixture((x, p) => (p.endsWith('/runs') ? { total_count: 1, workflow_runs: [{ ...run(), run_attempt: 2 }] } : x))
        .fetcher,
      now
    );
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.attempt).toBe(2);
  });
  it('refuses decreasing run attempts', async () => {
    const first = await readFixedPr(
      target,
      undefined,
      fixture((x, p) => (p.endsWith('/runs') ? { total_count: 1, workflow_runs: [{ ...run(), run_attempt: 2 }] } : x))
        .fetcher,
      now
    );
    await expect(readFixedPr(target, JSON.stringify(first.cursor), fixture().fetcher, now)).rejects.toThrow(
      'WATCH_TARGET_UNKNOWN'
    );
  });
  it('reports a new head, excludes wrong-head checks, and labels historical reviews', async () => {
    const first = await readFixedPr(target, undefined, fixture().fetcher, now);
    const nextHead = 'b'.repeat(40);
    const next = await readFixedPr(
      target,
      JSON.stringify(first.cursor),
      fixture((x, p) =>
        p.endsWith('/reviews')
          ? [review()]
          : p.endsWith('/check-runs')
            ? { total_count: 1, check_runs: [{ ...check(), id: 34, head_sha: nextHead }] }
            : p.endsWith('/runs')
              ? { total_count: 1, workflow_runs: [{ ...run(), id: 100, head_sha: nextHead }] }
              : { ...pr(), head: { sha: nextHead }, updated_at: '2026-10-24T11:00:00Z' }
      ).fetcher,
      now
    );
    expect(next.cursor.head).toBe(nextHead);
    expect(next.events).toHaveLength(3);
  });
  it('refuses stale run timestamps even with the same attempt', async () => {
    const first = await readFixedPr(target, undefined, fixture().fetcher, now);
    await expect(
      readFixedPr(
        target,
        JSON.stringify(first.cursor),
        fixture((x, p) =>
          p.endsWith('/runs')
            ? { total_count: 1, workflow_runs: [{ ...run(), updated_at: '2026-10-24T09:00:00Z' }] }
            : x
        ).fetcher,
        now
      )
    ).rejects.toThrow();
  });
  it('deduplicates identical rows but refuses conflicting duplicate observations', async () => {
    const same = fixture((x, p) => (p.endsWith('/reviews') ? [review(), review()] : x));
    expect((await readFixedPr(target, undefined, same.fetcher, now)).events).toHaveLength(4);
    const bad = fixture((x, p) => (p.endsWith('/reviews') ? [review(), { ...review(), state: 'DISMISSED' }] : x));
    await expect(readFixedPr(target, undefined, bad.fetcher, now)).rejects.toThrow();
  });
  it.each([
    [
      'wrong-head checks',
      (x: unknown, p: string) =>
        p.endsWith('/check-runs') ? { total_count: 1, check_runs: [{ ...check(), head_sha: 'b'.repeat(40) }] } : x,
    ],
    [
      'wrong-head runs',
      (x: unknown, p: string) =>
        p.endsWith('/runs') ? { total_count: 1, workflow_runs: [{ ...run(), head_sha: 'b'.repeat(40) }] } : x,
    ],
    [
      'incomplete counts',
      (x: unknown, p: string) => (p.endsWith('/runs') ? { total_count: 2, workflow_runs: [run()] } : x),
    ],
    ['overflow', (x: unknown, p: string) => (p.endsWith('/reviews') ? Array.from({ length: 100 }, review) : x)],
    [
      'private repo',
      (x: unknown, p: string) =>
        /\/pulls\/7$/.test(p) ? { ...pr(), base: { repo: { private: true, full_name: 'Example/public' } } } : x,
    ],
    [
      'wrong repo',
      (x: unknown, p: string) =>
        /\/pulls\/7$/.test(p) ? { ...pr(), base: { repo: { private: false, full_name: 'Other/repo' } } } : x,
    ],
    ['missing field', (x: unknown, p: string) => (p.endsWith('/reviews') ? [{ id: 22 }] : x)],
    [
      'future data',
      (x: unknown, p: string) => (/\/pulls\/7$/.test(p) ? { ...pr(), updated_at: '2027-01-01T00:00:00Z' } : x),
    ],
  ])('refuses %s', async (_name, change) => {
    await expect(readFixedPr(target, undefined, fixture(change).fetcher, now)).rejects.toThrow();
  });
  it('refuses a changing head fence', async () => {
    await expect(
      readFixedPr(
        target,
        undefined,
        fixture((x, _p, call) => (call === 5 ? { ...pr(), head: { sha: 'b'.repeat(40) } } : x)).fetcher,
        now
      )
    ).rejects.toThrow();
  });
  it('refuses any next-page link', async () => {
    await expect(
      readFixedPr(target, undefined, fixture(undefined, '<next>; rel="next"').fetcher, now)
    ).rejects.toThrow();
  });
  it('refuses over 128 new events and a full retained event ledger without eviction', async () => {
    await expect(
      readFixedPr(
        target,
        undefined,
        fixture((x, p) =>
          p.endsWith('/reviews')
            ? Array.from({ length: 64 }, (_, i) => ({ ...review(), id: i + 1 }))
            : p.endsWith('/check-runs')
              ? { total_count: 64, check_runs: Array.from({ length: 64 }, (_, i) => ({ ...check(), id: i + 1 })) }
              : x
        ).fetcher,
        now
      )
    ).rejects.toThrow();
    const first = await readFixedPr(target, undefined, fixture().fetcher, now);
    for (let i = 0; first.cursor.events.length < 500; i++) first.cursor.events.push(i.toString(16).padStart(64, '0'));
    await expect(
      readFixedPr(
        target,
        JSON.stringify(first.cursor),
        fixture((x, p) => (p.endsWith('/runs') ? { total_count: 1, workflow_runs: [{ ...run(), run_attempt: 2 }] } : x))
          .fetcher,
        now
      )
    ).rejects.toThrow();
  });
  it('completely accounts for 40-check initial and mass completion snapshots, with replay deduplication', async () => {
    const forty = (complete: boolean) =>
      fixture((x, p) =>
        p.endsWith('/check-runs')
          ? {
              total_count: 40,
              check_runs: Array.from({ length: 40 }, (_, i) => ({
                ...check(),
                id: i + 1,
                status: complete ? 'completed' : 'queued',
                conclusion: complete ? 'success' : null,
              })),
            }
          : x
      ).fetcher;
    const initial = await readFixedPr(target, undefined, forty(false), now);
    expect(initial.events).toHaveLength(43); // PR +40 checks +review +workflow run, all actually accounted.
    expect(initial.message).toContain('further events retained in receipt');
    expect((await readFixedPr(target, JSON.stringify(initial.cursor), forty(false), now)).events).toEqual([]);
    const complete = await readFixedPr(target, JSON.stringify(initial.cursor), forty(true), now);
    expect(complete.events).toHaveLength(40);
    expect(complete.cursor.events).toHaveLength(83);
    expect((await readFixedPr(target, JSON.stringify(complete.cursor), forty(true), now)).events).toEqual([]);
  });
  it('accepts exactly 128 new events with full accounting, but refuses 129', async () => {
    const boundary = (reviews: number) =>
      fixture((x, p) =>
        p.endsWith('/reviews')
          ? Array.from({ length: reviews }, (_, i) => ({ ...review(), id: i + 1 }))
          : p.endsWith('/check-runs')
            ? { total_count: 99, check_runs: Array.from({ length: 99 }, (_, i) => ({ ...check(), id: i + 1 })) }
            : x
      ).fetcher;
    const full = await readFixedPr(target, undefined, boundary(27), now);
    expect(full.events).toHaveLength(128);
    expect(full.cursor.events).toHaveLength(128);
    await expect(readFixedPr(target, undefined, boundary(28), now)).rejects.toThrow();
  });
  it('refuses inconsistent public/state/title data at an otherwise stable PR fence', async () => {
    await expect(
      readFixedPr(
        target,
        undefined,
        fixture((x, _p, call) => (call === 5 ? { ...pr(), title: 'changed without updated fence' } : x)).fetcher,
        now
      )
    ).rejects.toThrow();
  });
  it.each([
    { ...target, owner: 'bad/query' },
    { ...target, pull: 0 },
    { ...target, kinds: ['pulls'] },
    { ...target, command: 'run' },
  ])('rejects malformed/overridden target before fetch', (args) => {
    expect(() => fixedTarget(args)).toThrow();
  });
  it('rejects malformed, wrong-target and overflow cursors', async () => {
    expect(() => parseWatchCursor('{broken', 'x')).toThrow();
    const s = await readFixedPr(target, undefined, fixture().fetcher, now);
    expect(() => parseWatchCursor(JSON.stringify(s.cursor), 'other/public#7')).toThrow();
    expect(() => parseWatchCursor('x'.repeat(120001), 'x')).toThrow();
  });
});
