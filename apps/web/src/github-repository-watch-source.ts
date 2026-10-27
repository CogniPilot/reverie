/** Fixed GitHub metadata scans. No credentials, posting, tools or caller-selected URLs in this module. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cleanUntrusted } from './cron/github-source.js';
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const GithubWatchConfig = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    enabled: z.boolean(),
    botId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    roomId: z.string().min(1).max(100),
    owner: name,
    repo: name,
    visibility: z.enum(['public', 'private']),
    intervalMinutes: z.number().int().min(5).max(1440),
    events: z
      .object({ issues: z.boolean(), pullRequests: z.boolean(), workflowFailures: z.boolean() })
      .strict()
      .refine((x) => x.issues || x.pullRequests || x.workflowFailures),
    credentialId: z.string().uuid().nullable(),
  })
  .strict();
export type WatchConfig = z.infer<typeof GithubWatchConfig>;
export const Seen = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.string().max(40),
    at: z.string().max(40).optional(),
    attempt: z.number().int().positive().optional(),
  })
  .strict();
export type SeenValue = z.infer<typeof Seen>;
export const Event = z
  .object({
    key: z.string().max(100),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.string().max(40),
    at: z.string().max(40),
    text: z.string().max(400),
  })
  .strict();
export type WatchEvent = z.infer<typeof Event>;
export interface ScanState {
  issueCursor?: string;
  issueSeen: Record<string, SeenValue>;
  issuePrimed: boolean;
  ciSeen: Record<string, SeenValue>;
  ciPrimed: boolean;
  openRuns: Record<string, string>;
  pageCache?: Record<string, { etag: string; body: unknown; next: boolean }>;
}
export interface Reply {
  status: number;
  headers: { get(name: string): string | null };
  body: unknown;
}
export type Get = (path: string) => Promise<Reply>;
export class GithubWatchError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code = 'SCAN_INCOMPLETE'): never => {
  throw new GithubWatchError(code);
};
export const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const integer = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail());
const timestamp = (v: unknown, now: number) =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  Date.parse(v) <= now + 300000
    ? v
    : fail();
function good(r: Reply) {
  if (r.status === 401) fail('AUTH_REQUIRED');
  if (r.status === 403 && r.headers.get('x-ratelimit-remaining') !== '0' && !r.headers.get('retry-after'))
    fail('AUTH_REQUIRED');
  if (r.status === 403 || r.status === 429) fail('RATE_LIMITED');
  if (r.status !== 200) fail('GITHUB_UNAVAILABLE');
}
/** Every page is fetched, including older pages. A page-1 ETag cannot attest older reruns. */
async function pages(get: Get, path: string, kind: 'issues' | 'runs', budget: { left: number }): Promise<unknown[]> {
  if (--budget.left < 0) fail();
  const first = await get(path);
  good(first);
  const firstHash = fingerprint(first.body);
  let r = first;
  const result: unknown[] = [];
  let count = 0;
  const runIds = new Set<number>();
  const expectedTotal = kind === 'runs' ? object(first.body).total_count : undefined;
  for (let page = 1; ; page++) {
    good(r);
    const body = kind === 'runs' ? object(r.body) : undefined;
    const rows = kind === 'runs' ? body!.workflow_runs : r.body;
    if (!Array.isArray(rows) || rows.length > (kind === 'runs' ? 100 : 30)) fail();
    if (kind === 'runs') {
      if (!Number.isSafeInteger(expectedTotal) || Number(expectedTotal) < 0 || body!.total_count !== expectedTotal)
        fail();
      for (const raw of rows as unknown[]) {
        const id = integer(object(raw).id);
        if (runIds.has(id)) fail();
        runIds.add(id);
      }
    }
    result.push(...(rows as unknown[]));
    count++;
    if (!r.headers.get('link')?.includes('rel="next"')) {
      if (kind === 'runs' && Number(expectedTotal) !== runIds.size) fail();
      break;
    }
    if (count >= (kind === 'runs' ? 10 : 10) || --budget.left < 0) fail();
    r = await get(path + '&page=' + (page + 1));
  }
  if (count > 1) {
    if (--budget.left < 0) fail();
    const fence = await get(path);
    good(fence);
    if (fingerprint(fence.body) !== firstHash) fail('PAGE_FENCE_CHANGED');
  }
  return result;
}
/** Inclusive created ranges split before GitHub's documented filtered-result cap of 1000. */
async function runs(get: Get, start: number, end: number, budget: { left: number }, depth = 0): Promise<unknown[]> {
  if (depth > 12 || --budget.left < 0) fail();
  const iso = (n: number) => new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const path = '/actions/runs?per_page=100&created=' + encodeURIComponent(iso(start) + '..' + iso(end));
  const first = await get(path);
  good(first);
  const total = object(first.body).total_count;
  if (!Number.isSafeInteger(total) || Number(total) < 0) fail();
  if (Number(total) > 1000) {
    const middle = Math.floor((start + end) / 2000) * 1000;
    if (middle <= start || middle >= end) fail();
    return [
      ...(await runs(get, start, middle, budget, depth + 1)),
      ...(await runs(get, middle, end, budget, depth + 1)),
    ];
  }
  let served = false;
  const cached: Get = async (p) => {
    if (p === path && !served) {
      served = true;
      return first;
    }
    return get(p);
  };
  return pages(cached, path, 'runs', budget);
}
export async function scanGithub(
  config: WatchConfig,
  state: ScanState,
  get: Get,
  now: number,
  redact: (s: string) => string = (x) => x
) {
  return scan(config, state, get, now, redact);
}
async function scan(config: WatchConfig, state: ScanState, get: Get, now: number, redact: (s: string) => string) {
  const rootReply = await get('');
  good(rootReply);
  const repository = object(rootReply.body);
  if (
    typeof repository.private !== 'boolean' ||
    repository.private !== (config.visibility === 'private') ||
    String(repository.full_name).toLowerCase() !== `${config.owner}/${config.repo}`.toLowerCase()
  )
    fail('REPOSITORY_VISIBILITY_CHANGED');
  const next: ScanState = structuredClone(state),
    events: WatchEvent[] = [];
  const budget = { left: 60 };
  if (config.events.issues || config.events.pullRequests) {
    const path =
      '/issues?state=all&sort=updated&direction=desc&per_page=30' +
      (state.issueCursor
        ? '&since=' +
          encodeURIComponent(new Date(Date.parse(state.issueCursor) - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
        : '');
    const rows = await pages(get, path, 'issues', budget);
    const observed = new Map<string, string>();
    for (const raw of rows as unknown[]) {
      const row = object(raw),
        number = integer(row.number),
        at = timestamp(row.updated_at, now);
      timestamp(row.created_at, now);
      if (!['open', 'closed'].includes(String(row.state)) || typeof row.title !== 'string') fail();
      if (!next.issueCursor || at > next.issueCursor) next.issueCursor = at;
      const pull = Object.hasOwn(row, 'pull_request'),
        key = pull ? 'pr:' + number : String(number),
        hash = fingerprint([number, row.title, row.state, at]);
      if (observed.has(key)) {
        if (observed.get(key) !== hash) fail();
        continue;
      }
      observed.set(key, hash);
      if ((pull && !config.events.pullRequests) || (!pull && !config.events.issues)) continue;
      const previous = state.issueSeen[key];
      if (previous?.at && at < previous.at) fail('METADATA_REGRESSION');
      if (state.issuePrimed && previous?.digest !== hash) {
        const change =
          previous?.state === 'closed' && row.state === 'open'
            ? 'reopened'
            : row.state === 'closed'
              ? 'closed'
              : previous
                ? 'updated'
                : state.issueCursor && String(row.created_at) <= state.issueCursor
                  ? 'updated'
                  : 'new';
        events.push({
          key: 'issue:' + key,
          digest: hash,
          state: String(row.state),
          at,
          text: `${pull ? 'PR' : 'Issue'} #${number} ${change}: ${cleanUntrusted(redact(String(row.title)), 160)} https://github.com/${config.owner}/${config.repo}/${pull ? 'pull' : 'issues'}/${number}`,
        });
      }
      next.issueSeen[key] = { digest: hash, state: String(row.state), at };
    }
    next.issuePrimed = true;
  }
  const createdSince = Math.floor((now - 31 * 86400000) / 1000) * 1000;
  if (config.events.workflowFailures) {
    const rows = await runs(get, createdSince, Math.floor(now / 1000) * 1000, budget),
      observed = new Map<string, string>();
    // A run observed nonterminal stays watched after it ages out of the rerun window.
    const returned = new Set(rows.map((r) => String(integer(object(r).id))));
    for (const id of Object.keys(state.openRuns))
      if (!returned.has(id)) {
        if (--budget.left < 0) fail();
        const reply = await get('/actions/runs/' + id);
        good(reply);
        if (String(object(reply.body).id) !== id) fail();
        rows.push(reply.body);
      }
    for (const raw of rows as unknown[]) {
      const row = object(raw),
        id = integer(row.id),
        attempt = integer(row.run_attempt),
        at = timestamp(row.updated_at, now),
        created = timestamp(row.created_at, now);
      if (typeof row.name !== 'string' || typeof row.status !== 'string') fail();
      const key = String(id),
        hash = fingerprint([id, attempt, row.status, row.conclusion]);
      if (observed.has(key)) {
        if (observed.get(key) !== hash) fail();
        continue;
      }
      observed.set(key, hash);
      const previous = state.ciSeen[key];
      if (previous?.attempt && attempt < previous.attempt) fail('METADATA_REGRESSION');
      if (previous?.at && at < previous.at) fail('METADATA_REGRESSION');
      if (row.status === 'completed') {
        delete next.openRuns[key];
        if (
          ![
            'success',
            'failure',
            'timed_out',
            'cancelled',
            'neutral',
            'skipped',
            'stale',
            'action_required',
            'startup_failure',
          ].includes(String(row.conclusion))
        )
          fail();
        if (
          state.ciPrimed &&
          previous?.digest !== hash &&
          ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(String(row.conclusion))
        )
          events.push({
            key: 'ci:' + key,
            digest: hash,
            state: String(row.conclusion),
            at,
            text: `CI ${row.conclusion}: ${cleanUntrusted(redact(String(row.name)), 120)} · attempt ${attempt} https://github.com/${config.owner}/${config.repo}/actions/runs/${id}`,
          });
      } else next.openRuns[key] = created;
      next.ciSeen[key] = {
        digest: hash,
        state: String(row.status === 'completed' ? row.conclusion : row.status),
        at,
        attempt,
      };
    }
    next.ciPrimed = true;
  }
  if (
    Object.keys(next.issueSeen).length + Object.keys(next.ciSeen).length > 6000 ||
    Object.keys(next.openRuns).length > 256
  )
    fail('STATE_CAPACITY');
  if (events.length > 30) fail('CHANGE_BATCH_BOUND');
  return { next, events, createdSince };
}
