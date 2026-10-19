/**
 * @fileoverview The 'github' post source: new or changed pull requests and issues of a PUBLIC repository, read from
 * GitHub's unauthenticated REST API (no token, no credentials in the console; 60 requests an hour is plenty for a
 * twice-daily job). Titles and names come from strangers, so they are cleaned before they reach a chat room: no
 * newlines, no `@` (a title must not wake a room member), no markup, and a length cap.
 */
import type { PostSourceData } from './post-sources.js';

export interface GithubArgs {
  owner: string;
  repo: string;
  /** Which items to report; both by default. */
  kinds?: Array<'pulls' | 'issues'>;
}

export const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_ITEMS = 10;
const PAGE = 30;
const TITLE_MAX = 80;

interface ApiItem {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  user?: { login?: string } | null;
  pull_request?: { merged_at?: string | null } | null;
}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** One line of untrusted text made safe to post: single line, no @ mentions, no markup, capped. */
export function cleanUntrusted(text: unknown, max: number): string {
  const s = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[@`*_<>[\]|{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function describe(item: ApiItem, since: string): string {
  const kind = item.pull_request ? 'PR' : 'issue';
  const merged = item.pull_request?.merged_at;
  const what = merged
    ? 'merged'
    : item.created_at > since
      ? 'opened'
      : item.state === 'closed'
        ? 'closed'
        : 'updated';
  const by = cleanUntrusted(item.user?.login, 40);
  return `${kind} #${item.number} ${what}${by ? ` by ${by}` : ''}: ${cleanUntrusted(item.title, TITLE_MAX)}`;
}

/**
 * A read that cannot be completed (network error, rate limit, bad reply) never looks like "nothing new": it returns a
 * "monitoring incomplete" message with `_hold`, which the cron service posts regardless of change-only and which leaves
 * the cursor where it was, so the next run re-reads the same window.
 *
 * Items of `owner/repo` updated after `last` (the newest updated_at already reported, kept by the job as its change
 * key; empty on the first run, which reports the most recent few as a baseline). `_key` is the newest updated_at
 * seen, so a quiet period posts nothing.
 */
export async function githubData(args: GithubArgs, last: string | undefined, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<PostSourceData> {
  if (!GITHUB_NAME.test(args.owner) || !GITHUB_NAME.test(args.repo)) throw new Error('Invalid GitHub owner or repo name');
  try {
    return await read(args, last, fetcher);
  } catch (err) {
    const why = cleanUntrusted(err instanceof Error ? err.message : err, 120);
    return {
      items: 0,
      lines: '',
      _hold: 1,
      _key: last ?? '',
      message: `GitHub ${args.owner}/${args.repo}: monitoring incomplete (${why}). Nothing was skipped; the next run re-reads the same window. This is NOT an all-clear.`,
    };
  }
}

/** An ISO time as Eastern Time, for posts (James reads ET). */
function etStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'the last run';
  return `${d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ET`;
}

async function read(args: GithubArgs, last: string | undefined, fetcher: Fetcher): Promise<PostSourceData> {
  const kinds = new Set(args.kinds?.length ? args.kinds : ['pulls', 'issues']);
  const url = `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues?state=all&sort=updated&direction=desc&per_page=${PAGE}`;
  const res = await fetcher(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'reverie-console', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10_000),
  });
  const remaining = res.headers?.get('x-ratelimit-remaining');
  if (!res.ok) throw new Error(remaining === '0' ? `rate limited (HTTP ${res.status})` : `GitHub answered ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('unexpected reply');
  // A full page with the cursor still inside it means older changes were cut off: say so instead of dropping them.
  if (body.length >= PAGE && (body as ApiItem[]).every((i) => i && i.updated_at > (last ?? '')) && last) {
    throw new Error(`more than ${PAGE} items changed since the last run`);
  }
  const items = (body as ApiItem[]).filter(
    (i) => i && typeof i.number === 'number' && typeof i.updated_at === 'string' && kinds.has(i.pull_request ? 'pulls' : 'issues')
  );
  const since = last ?? '';
  const changed = items.filter((i) => i.updated_at > since);
  const fresh = changed.slice(0, MAX_ITEMS);
  const more = changed.length - fresh.length;
  const newest = items.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), since);
  const repo = `${args.owner}/${args.repo}`;
  const lines = fresh.map((i) => describe(i, since)).join('; ');
  // The cursor below moves past every changed item, so the ones not listed are named and linked, never silently dropped.
  const listUrl = (kind: string) => `https://github.com/${repo}/${kind}?q=sort%3Aupdated-desc`;
  const tail = more > 0
    ? `; ... and ${more} more changed${since ? ` since ${etStamp(since)}` : ''} (not listed): ${[...kinds].map(listUrl).join(' ')}`
    : '';
  return {
    items: fresh.length,
    lines,
    // An empty key is the quiet baseline: a repo with nothing matching posts nothing.
    _key: items.length ? newest : '',
    message: fresh.length
      ? `GitHub ${repo}, ${changed.length} new or changed (titles are from outside the team): ${lines}${tail}`
      : `GitHub ${repo}: nothing new.`,
  };
}
