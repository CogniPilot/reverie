/** Public metadata only. No credentials, bodies, automatic decisions or executable input. */
import { createHash } from 'node:crypto';
import { cleanUntrusted, GITHUB_NAME, type Fetcher } from './github-source.js';

export interface FixedPrTarget {
  owner: string;
  repo: string;
  pull: number;
}
export interface WatchEvent {
  target_id: string;
  event_id: string;
  attempt: number;
  dedupe_key: string;
}
export interface WatchCursor {
  v: 1;
  target: string;
  head: string;
  updated: string;
  seen: Record<string, { attempt: number; digest: string; stamp: string }>;
  events: string[];
}
export interface WatchSnapshot {
  cursor: WatchCursor;
  events: WatchEvent[];
  message: string;
}
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ROWS = 100;
const MAX_EVENTS = 500;
const MAX_CURSOR = 120_000;
const MAX_BODY = 262_144;
/** One shared reader/delivery bound: covers the intended 40-check PR without dropping a baseline. */
export const FIXED_WATCH_LIMITS = Object.freeze({ eventsPerPoll: 128, snapshotChars: 196_608 });
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail = (): never => {
  throw new Error('WATCH_TARGET_UNKNOWN: incomplete, stale or conflicting public metadata');
};
function record(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return fail();
  return x as Record<string, unknown>;
}
function integer(x: unknown): number {
  if (!Number.isSafeInteger(x) || (x as number) < 1) return fail();
  return x as number;
}
function text(x: unknown, max = 256): string {
  if (typeof x !== 'string' || x.length > max) return fail();
  return x;
}
function time(x: unknown, now: number): string {
  const s = text(x, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s) || !Number.isFinite(Date.parse(s)) || Date.parse(s) > now + 300_000)
    return fail();
  return s;
}
function sha(x: unknown): string {
  const s = text(x, 40);
  return SHA.test(s) ? s : fail();
}
function enumeration(x: unknown, allowed: string[]): string {
  const s = text(x, 40);
  return allowed.includes(s) ? s : fail();
}
export function fixedTarget(args: unknown): FixedPrTarget {
  const a = record(args);
  if (
    Object.keys(a).some((k) => !['owner', 'repo', 'pull'].includes(k)) ||
    !GITHUB_NAME.test(text(a.owner, 100)) ||
    !GITHUB_NAME.test(text(a.repo, 100))
  )
    return fail();
  return { owner: a.owner as string, repo: a.repo as string, pull: integer(a.pull) };
}
export const fixedTargetId = (a: FixedPrTarget): string => `${a.owner.toLowerCase()}/${a.repo.toLowerCase()}#${a.pull}`;
export function parseWatchCursor(raw: string | undefined, target: string): WatchCursor | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > MAX_CURSOR) return fail();
  let c: Record<string, unknown>;
  try {
    c = record(JSON.parse(raw));
  } catch {
    return fail();
  }
  if (
    Object.keys(c).sort().join(',') !== 'events,head,seen,target,updated,v' ||
    c.v !== 1 ||
    c.target !== target ||
    !SHA.test(text(c.head, 40))
  )
    return fail();
  time(c.updated, Date.now());
  const seen = record(c.seen);
  if (
    Object.keys(seen).length > 300 ||
    !Array.isArray(c.events) ||
    c.events.length > MAX_EVENTS ||
    new Set(c.events).size !== c.events.length
  )
    return fail();
  for (const [key, value] of Object.entries(seen)) {
    if (!/^(pr|review|check|run):[0-9]+$/.test(key)) return fail();
    const row = record(value);
    if (Object.keys(row).sort().join(',') !== 'attempt,digest,stamp' || !HASH.test(text(row.digest, 64))) return fail();
    if (row.stamp !== '') time(row.stamp, Date.now());
    integer(row.attempt);
  }
  for (const e of c.events) if (!HASH.test(text(e, 64))) return fail();
  return c as unknown as WatchCursor;
}

/** Default reader caps bytes BEFORE JSON parsing; fixtures inject the same closed response interface. */
const publicFetch: Fetcher = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'error', credentials: 'omit' });
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: async () => {
      if (!response.body) return fail();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_BODY) return fail();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    },
  };
};

/** Five bounded anonymous GETs; reread the PR fence after collecting the head-bound observations. */
export async function readFixedPr(
  args: unknown,
  raw?: string,
  fetcher: Fetcher = publicFetch,
  now = Date.now()
): Promise<WatchSnapshot> {
  const a = fixedTarget(args);
  const target = fixedTargetId(a);
  const old = parseWatchCursor(raw, target);
  const root = `https://api.github.com/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}`;
  const signal = AbortSignal.timeout(10_000);
  const get = async (path: string): Promise<unknown> => {
    const r = await fetcher(`${root}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'reverie-console',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
    });
    if (!r.ok || r.headers?.get('link')?.includes('rel="next"')) return fail();
    const body = await r.json();
    if (JSON.stringify(body).length > MAX_BODY) return fail();
    return body;
  };
  const list = (x: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(x) || x.length >= MAX_ROWS) return fail();
    return x.map(record);
  };
  const pr = record(await get(`/pulls/${a.pull}`));
  if (pr.number !== a.pull || typeof pr.merged !== 'boolean') return fail();
  // Public must be positively attested, never inferred from an anonymous HTTP 200 alone.
  const baseRepo = record(record(pr.base).repo);
  if (baseRepo.private !== false || text(baseRepo.full_name).toLowerCase() !== `${a.owner}/${a.repo}`.toLowerCase())
    return fail();
  const head = sha(record(pr.head).sha);
  const updated = time(pr.updated_at, now);
  if (old && updated < old.updated) return fail();
  const seen = { ...(old?.seen ?? {}) };
  const eventIds = new Set(old?.events ?? []);
  const events: WatchEvent[] = [];
  const summaries: string[] = [];
  const observed = new Map<string, string>();
  const observe = (kind: string, id: number, attempt: number, state: unknown, summary: string, stamp = '') => {
    const identity = `${kind}:${id}`;
    const digest = hash(state);
    const observation = hash([attempt, digest]);
    if (observed.has(identity) && observed.get(identity) !== observation) return fail();
    observed.set(identity, observation);
    const previous = seen[identity];
    if (previous && (attempt < previous.attempt || stamp < previous.stamp)) return fail();
    const event_id = hash([target, identity, attempt, digest]);
    seen[identity] = { attempt, digest, stamp };
    if (!eventIds.has(event_id)) {
      eventIds.add(event_id);
      events.push({ target_id: target, event_id, attempt, dedupe_key: event_id });
      summaries.push(summary);
    }
  };
  observe(
    'pr',
    a.pull,
    1,
    [head, updated, enumeration(pr.state, ['open', 'closed']), pr.merged === true, text(pr.title, 1024)],
    `PR ${String(pr.state)}${pr.merged ? '/merged' : ''}`
  );
  for (const r of list(await get(`/pulls/${a.pull}/reviews?per_page=100`))) {
    observe(
      'review',
      integer(r.id),
      1,
      [
        enumeration(r.state, ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
        sha(r.commit_id),
        r.submitted_at === null ? null : time(r.submitted_at, now),
      ],
      `review ${String(r.id)} ${String(r.state)} (${r.commit_id === head ? 'current' : 'historical'} head)`
    );
  }
  const checks = record(await get(`/commits/${head}/check-runs?per_page=100`));
  const checkRows = list(checks.check_runs);
  if (checks.total_count !== checkRows.length) return fail();
  for (const r of checkRows) {
    if (sha(r.head_sha) !== head) return fail();
    if (r.status === 'completed' && r.conclusion === null) return fail();
    observe(
      'check',
      integer(r.id),
      1,
      [
        head,
        enumeration(r.status, ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
        r.conclusion === null
          ? null
          : enumeration(r.conclusion, [
              'success',
              'failure',
              'neutral',
              'cancelled',
              'skipped',
              'timed_out',
              'action_required',
              'stale',
              'startup_failure',
            ]),
        text(r.name, 256),
      ],
      `check ${String(r.id)} ${String(r.status)}/${String(r.conclusion ?? 'unknown')}`
    );
  }
  const runs = record(await get(`/actions/runs?head_sha=${head}&per_page=100`));
  const runRows = list(runs.workflow_runs);
  if (runs.total_count !== runRows.length) return fail();
  for (const r of runRows) {
    if (sha(r.head_sha) !== head) return fail();
    if (r.status === 'completed' && r.conclusion === null) return fail();
    observe(
      'run',
      integer(r.id),
      integer(r.run_attempt),
      [
        head,
        time(r.updated_at, now),
        enumeration(r.status, ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
        r.conclusion === null
          ? null
          : enumeration(r.conclusion, [
              'success',
              'failure',
              'neutral',
              'cancelled',
              'skipped',
              'timed_out',
              'action_required',
              'stale',
              'startup_failure',
            ]),
      ],
      `run ${String(r.id)} attempt ${String(r.run_attempt)} ${String(r.status)}/${String(r.conclusion ?? 'unknown')}`,
      time(r.updated_at, now)
    );
  }
  const fence = record(await get(`/pulls/${a.pull}`));
  if (sha(record(fence.head).sha) !== head || time(fence.updated_at, now) !== updated || fence.number !== a.pull)
    return fail();
  const fenceRepo = record(record(fence.base).repo);
  if (
    hash([fence.state, fence.merged, fence.title, fenceRepo.private, text(fenceRepo.full_name).toLowerCase()]) !==
    hash([pr.state, pr.merged, pr.title, baseRepo.private, text(baseRepo.full_name).toLowerCase()])
  )
    return fail();
  if (events.length > FIXED_WATCH_LIMITS.eventsPerPoll || eventIds.size > MAX_EVENTS || Object.keys(seen).length > 300)
    return fail();
  const cursor: WatchCursor = { v: 1, target, head, updated, seen, events: [...eventIds] };
  if (JSON.stringify(cursor).length > MAX_CURSOR) return fail();
  const title = cleanUntrusted(text(pr.title, 1024).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '), 80);
  const lines =
    summaries.slice(0, 10).join('; ') +
    (summaries.length > 10 ? `; ${summaries.length - 10} further events retained in receipt` : '');
  const snapshot = {
    cursor,
    events,
    message: `GitHub ${target}: ${events.length} new metadata event(s); head ${head.slice(0, 12)}; ${title}. ${lines}. Notify only; observations are not approval or an all-clear. https://github.com/${a.owner}/${a.repo}/pull/${a.pull}`,
  };
  if (JSON.stringify(snapshot).length > FIXED_WATCH_LIMITS.snapshotChars) return fail();
  return snapshot;
}
