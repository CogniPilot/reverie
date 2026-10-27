import { expect, it } from 'vitest';
import { scanGithub, type WatchConfig, type ScanState, type Reply } from '../src/github-repository-watch-source.js';
const NOW = Date.UTC(2026, 9, 27),
  DAY = 86400000;
const at = (n: number) => new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');
const reply = (body: unknown, next = false): Reply => ({
  status: 200,
  body,
  headers: { get: (k) => (k === 'link' && next ? '<never-follow.invalid>; rel="next"' : null) },
});
const config: WatchConfig = {
  id: 'repo',
  enabled: true,
  owner: 'owner',
  repo: 'repo',
  botId: 'bot',
  roomId: 'room',
  visibility: 'public',
  intervalMinutes: 30,
  events: { issues: false, pullRequests: false, workflowFailures: true },
  credentialId: null,
};
const initial = (): ScanState => ({ issueSeen: {}, issuePrimed: false, ciSeen: {}, ciPrimed: false, openRuns: {} });
const run = (id: number, attempt = 1, conclusion = 'success', created = NOW - DAY) => ({
  id,
  run_attempt: attempt,
  status: 'completed',
  conclusion,
  name: 'Build',
  created_at: at(created),
  updated_at: at(NOW),
});
it('rechecks older CI pages even when page1 is unchanged; each new failing attempt appears once', async () => {
  let attempt = 1,
    page2 = 0;
  const get = async (path: string) => {
    if (path === '') return reply({ private: false, full_name: 'owner/repo' });
    const u = new URL('https://fixture.invalid' + path);
    if (u.searchParams.get('page') === '2') {
      page2++;
      return reply({ total_count: 101, workflow_runs: [run(101, attempt, 'failure')] });
    }
    return reply({ total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, i) => run(i + 1)) }, true);
  };
  const baseline = await scanGithub(config, initial(), get, NOW);
  expect(baseline.events).toHaveLength(0);
  attempt = 2;
  const next = await scanGithub(config, baseline.next, get, NOW);
  expect(next.events).toHaveLength(1);
  expect(next.events[0]!.text).toContain('attempt 2');
  expect(page2).toBe(2);
  const repeat = await scanGithub(config, next.next, get, NOW);
  expect(repeat.events).toHaveLength(0);
});
it('splits documented >1000 filtered results and deduplicates inclusive date boundary rows', async () => {
  let split = 0;
  const get = async (path: string) => {
    if (path === '') return reply({ private: false, full_name: 'owner/repo' });
    const range = new URL('https://fixture.invalid' + path).searchParams.get('created')!.split('..').map(Date.parse);
    if (range[1]! - range[0]! > 20 * DAY) {
      split++;
      return reply({ total_count: 1001, workflow_runs: [] });
    }
    return reply({ total_count: 1, workflow_runs: [run(3, 2, 'failure', NOW - 15 * DAY)] });
  };
  const state = initial();
  state.ciPrimed = true;
  const result = await scanGithub(config, state, get, NOW);
  expect(split).toBe(1);
  expect(result.events).toHaveLength(1);
  expect(result.createdSince).toBe(NOW - 31 * DAY);
});
it('rejects truncated total_count without cursor/seen mutation', async () => {
  const before = initial();
  await expect(
    scanGithub(
      config,
      before,
      async (p) =>
        p === ''
          ? reply({ private: false, full_name: 'owner/repo' })
          : reply({ total_count: 101, workflow_runs: [run(1)] }),
      NOW
    )
  ).rejects.toThrow('SCAN_INCOMPLETE');
  expect(before).toEqual(initial());
});
it('observed nonterminal run remains queried after ageing out and emits final failure', async () => {
  const state = initial();
  state.ciPrimed = true;
  state.openRuns['77'] = at(NOW - 40 * DAY);
  let direct = false;
  const result = await scanGithub(
    config,
    state,
    async (path) => {
      if (path === '') return reply({ private: false, full_name: 'owner/repo' });
      if (path === '/actions/runs/77') {
        direct = true;
        return reply(run(77, 1, 'failure', NOW - 40 * DAY));
      }
      return reply({ total_count: 0, workflow_runs: [] });
    },
    NOW
  );
  expect(direct).toBe(true);
  expect(result.events).toHaveLength(1);
  expect(result.next.openRuns['77']).toBeUndefined();
});
it('retains issue cursor when first-page consistency fence changes', async () => {
  let first = 0;
  const c = { ...config, events: { issues: true, pullRequests: true, workflowFailures: false } };
  const state = initial();
  const get = async (path: string) => {
    if (path === '') return reply({ private: false, full_name: 'owner/repo' });
    if (path.includes('&page=2')) return reply([]);
    first++;
    return reply(
      [
        {
          number: 1,
          title: first === 1 ? 'old' : 'changed',
          state: 'open',
          created_at: at(NOW - DAY),
          updated_at: at(NOW),
        },
      ],
      true
    );
  };
  await expect(scanGithub(c, state, get, NOW)).rejects.toThrow('PAGE_FENCE_CHANGED');
  expect(state.issueCursor).toBeUndefined();
});
it('does not turn CI timestamp-only metadata edits into repeat failure alerts', async () => {
  let timestamp = NOW;
  const get = async (path: string) =>
    path === ''
      ? reply({ private: false, full_name: 'owner/repo' })
      : reply({ total_count: 1, workflow_runs: [{ ...run(1, 1, 'failure'), updated_at: at(timestamp) }] });
  const first = await scanGithub(config, initial(), get, NOW);
  timestamp += 1000;
  const next = await scanGithub(config, first.next, get, NOW + 1000);
  expect(next.events).toHaveLength(0);
});

it('overlaps the issue cursor second and deduplicates unchanged boundary rows', async () => {
  const c = { ...config, events: { issues: true, pullRequests: true, workflowFailures: false } };
  let title = 'old',
    since: string | null = null;
  const get = async (path: string) => {
    if (!path) return reply({ private: false, full_name: 'owner/repo' });
    since = new URL('https://fixture.invalid' + path).searchParams.get('since');
    return reply([{ number: 1, title, state: 'open', created_at: at(NOW - DAY), updated_at: at(NOW) }]);
  };
  const first = await scanGithub(c, initial(), get, NOW);
  title = 'changed in same second';
  const next = await scanGithub(c, first.next, get, NOW);
  expect(since).toBe(at(NOW - 1000));
  expect(next.events).toHaveLength(1);
  expect((await scanGithub(c, next.next, get, NOW)).events).toHaveLength(0);
});

it('refuses duplicate rows within one CI range rather than counting them as complete coverage', async () => {
  const state = initial();
  const get = async (path: string) =>
    !path
      ? reply({ private: false, full_name: 'owner/repo' })
      : reply({ total_count: 2, workflow_runs: [run(1)] }, !path.includes('&page=2'));
  await expect(scanGithub(config, state, get, NOW)).rejects.toThrow('SCAN_INCOMPLETE');
  expect(state).toEqual(initial());
});
it('requires every page in a CI range to retain the same declared total', async () => {
  const get = async (path: string) =>
    !path
      ? reply({ private: false, full_name: 'owner/repo' })
      : path.includes('&page=2')
        ? reply({ total_count: 1, workflow_runs: [run(2)] })
        : reply({ total_count: 2, workflow_runs: [run(1)] }, true);
  await expect(scanGithub(config, initial(), get, NOW)).rejects.toThrow('SCAN_INCOMPLETE');
});

it('starts an empty quiet issue baseline now despite over 300 historical rows, then reports old-issue updates and new PRs', async () => {
  const c = { ...config, events: { issues: true, pullRequests: true, workflowFailures: false } };
  const historical = Array.from({ length: 450 }, (_, i) => ({
    number: i + 1,
    title: 'Historical ' + i,
    state: 'open',
    created_at: at(NOW - 10 * DAY),
    updated_at: at(NOW - DAY),
    ...(i % 2 ? { pull_request: {} } : {}),
  }));
  let rows = historical,
    paths: string[] = [];
  const get = async (path: string) => {
    if (!path) return reply({ private: false, full_name: 'owner/repo' });
    paths.push(path);
    const url = new URL('https://fixture.invalid' + path),
      since = url.searchParams.get('since'),
      page = Number(url.searchParams.get('page') || 1);
    const filtered = rows.filter((r) => !since || r.updated_at > since),
      start = (page - 1) * 30;
    return reply(filtered.slice(start, start + 30), filtered.length > start + 30);
  };
  const original = initial();
  const baseline = await scanGithub(c, original, get, NOW);
  expect(paths).toHaveLength(1);
  expect(new URL('https://fixture.invalid' + paths[0]).searchParams.get('since')).toBe(at(NOW - 1000));
  expect(baseline.events).toHaveLength(0);
  expect(baseline.next.issueCursor).toBe(at(NOW));
  expect(baseline.next.issuePrimed).toBe(true);
  expect(original).toEqual(initial());
  rows = [
    { ...historical[0]!, title: 'Old issue updated', updated_at: at(NOW + 2000) },
    {
      number: 451,
      title: 'New PR',
      state: 'open',
      created_at: at(NOW + 1000),
      updated_at: at(NOW + 2000),
      pull_request: {},
    },
  ];
  const changed = await scanGithub(c, baseline.next, get, NOW + 2000);
  expect(changed.events.map((e) => e.text)).toEqual([
    expect.stringContaining('Issue #1 updated:'),
    expect.stringContaining('PR #451 new:'),
  ]);
  expect((await scanGithub(c, changed.next, get, NOW + 2000)).events).toHaveLength(0);
});
it('keeps an existing primed legacy cursor instead of resetting it to the new scan time', async () => {
  const c = { ...config, events: { issues: true, pullRequests: false, workflowFailures: false } },
    state = initial();
  state.issuePrimed = true;
  state.issueCursor = at(NOW - 5 * DAY);
  let since: string | null = null;
  const result = await scanGithub(
    c,
    state,
    async (path) => {
      if (!path) return reply({ private: false, full_name: 'owner/repo' });
      since = new URL('https://fixture.invalid' + path).searchParams.get('since');
      return reply([]);
    },
    NOW
  );
  expect(since).toBe(at(NOW - 5 * DAY - 1000));
  expect(result.next.issueCursor).toBe(state.issueCursor);
  expect(result.next.issuePrimed).toBe(true);
});
