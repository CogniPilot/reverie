/** Anonymous public issue metadata only; no PAT, private repo discovery, shell or external agent. */
import { z } from 'zod';
import type { ChatBot } from '../chat-bots.js';
import type { ChatRoom, ChatMessage } from '../chatroom-store.js';
import { BotWatchState, BotWatchPostRefused } from '../bot-watch-state.js';
import { cleanUntrusted } from './github-source.js';
import { createHash } from 'node:crypto';

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const PublicIssueWatchConfig = z
  .object({
    version: z.literal(1),
    type: z.literal('public-github-issues'),
    enabled: z.boolean(),
    botId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    roomId: z.string().min(1).max(100),
    owner: name,
    repo: name,
    intervalMinutes: z.number().int().min(5).max(1440),
  })
  .strict();
const event = z
  .object({
    number: z.number().int().positive(),
    updatedAt: z.string().max(40),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['open', 'closed']),
    text: z.string().max(400),
  })
  .strict();
export const PublicIssueWatchStateSchema = z
  .object({
    version: z.literal(1),
    config: PublicIssueWatchConfig.optional(),
    etag: z.string().max(300).optional(),
    cursor: z.string().max(40).optional(),
    seen: z.record(z.string(), z.object({ digest: z.string(), state: z.enum(['open', 'closed']) }).strict()),
    nextPollAt: z.number().int(),
    failures: z.number().int().max(1000),
    lastSuccessAt: z.number().int().optional(),
    lastFailureNoticeAt: z.number().int().optional(),
    posts: z.array(z.number().int()).max(120),
    pending: z
      .object({
        id: z.string().length(32),
        text: z.string().max(5000),
        events: z.array(event).max(30),
        etag: z.string().max(300).optional(),
        cursor: z.string().max(40).optional(),
        reservedAt: z.number().int(),
        phase: z.enum(['prepared', 'reserved', 'delivered', 'unknown']),
        messageId: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type FetchReply = { status: number; headers: { get(name: string): string | null }; body: unknown };
export interface PublicIssueWatchDeps {
  bot(id: string): ChatBot | undefined;
  room(id: string): ChatRoom | undefined;
  post(bot: ChatBot, roomId: string, text: string, recent: number): ChatMessage;
  now?: () => number;
  fetch?: (url: string, headers: Record<string, string>) => Promise<FetchReply>;
}
/** Exact HTTPS GitHub origin, redirects disabled, anonymous, bounded bytes before parse. */
export async function publicIssueFetch(url: string, headers: Record<string, string>): Promise<FetchReply> {
  const u = new URL(url);
  if (u.origin !== 'https://api.github.com' || u.username || u.password) throw Error('Public GitHub origin required');
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000), redirect: 'error', credentials: 'omit' });
  if (r.status === 304) return { status: r.status, headers: r.headers, body: null };
  if (!r.body) throw Error('Missing GitHub body');
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 262144) throw Error('GitHub response too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { status: r.status, headers: r.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class PublicIssueWatch {
  readonly store: BotWatchState<z.infer<typeof PublicIssueWatchStateSchema>>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    file: string,
    private deps: PublicIssueWatchDeps
  ) {
    this.store = new BotWatchState(file, PublicIssueWatchStateSchema, {
      version: 1,
      seen: {},
      nextPollAt: 0,
      failures: 0,
      posts: [],
    });
  }
  init() {
    return this.store.init();
  }
  status() {
    return this.store.snapshot();
  }
  async configure(raw: unknown) {
    const cfg = PublicIssueWatchConfig.parse(raw),
      bot = this.deps.bot(cfg.botId),
      room = this.deps.room(cfg.roomId);
    if (!bot || !bot.rooms.includes(cfg.roomId) || !room || room.kind === 'dm' || room.archivedAt)
      throw Error('Allowed ordinary bot room required');
    await this.store.update((s) => {
      if (
        s.config &&
        (s.config.owner.toLowerCase() !== cfg.owner.toLowerCase() ||
          s.config.repo.toLowerCase() !== cfg.repo.toLowerCase() ||
          s.config.roomId !== cfg.roomId ||
          s.config.botId !== cfg.botId)
      )
        throw Error('Existing target change requires separate reviewed watch; cursor retained');
      s.config = cfg;
    });
  }
  tick(): Promise<void> {
    const run = this.chain.then(() => this.poll());
    this.chain = run.catch(() => undefined);
    return run;
  }
  private now() {
    return Math.trunc((this.deps.now ?? Date.now)());
  }
  private async deliver() {
    const s = this.store.snapshot(),
      c = s.config,
      p = s.pending;
    if (!c?.enabled || !p) return;
    const b = this.deps.bot(c.botId),
      r = this.deps.room(c.roomId);
    if (!b || !r || r.archivedAt || r.kind === 'dm' || !b.rooms.includes(r.id)) return;
    const tag = `[github-issues:${p.id}]`;
    if (p.phase === 'reserved' || p.phase === 'unknown') {
      const matching = r.messages.filter(
        (m) => m.from.kind === 'bot' && m.from.botId === b.id && m.text === p.text && !m.deleted
      );
      if (matching.length !== 1) {
        if (p.phase !== 'unknown')
          await this.store.update((x) => {
            x.pending!.phase = 'unknown';
          });
        return;
      }
      await this.store.update((x) => {
        x.pending!.messageId = matching[0]!.id;
        x.pending!.phase = 'delivered';
      });
    }
    if (this.store.snapshot().pending!.phase === 'prepared') {
      const posts = s.posts.filter((t) => t > this.now() - 3600000);
      if (posts.length >= b.maxPerHour) return;
      await this.store.update((x) => {
        x.pending!.phase = 'reserved';
        x.posts = [...posts, this.now()];
      });
      try {
        if (!this.store.snapshot().config?.enabled) {
          await this.store.update((x) => {
            x.pending!.phase = 'prepared';
          });
          return;
        }
        const message = this.deps.post(b, r.id, p.text, posts.length);
        await this.store.update((x) => {
          x.pending!.phase = 'delivered';
          x.pending!.messageId = message.id;
        });
      } catch (error) {
        await this.store.update((x) => {
          x.pending!.phase = error instanceof BotWatchPostRefused ? 'prepared' : 'unknown';
        });
        return;
      }
    }
    if (this.store.snapshot().pending!.phase === 'delivered')
      await this.store.update((x) => {
        for (const e of p.events) x.seen[String(e.number)] = { digest: e.digest, state: e.state };
        x.etag = p.etag;
        x.cursor = p.cursor;
        delete x.pending;
      });
    void tag;
  }
  private async poll() {
    let s = this.store.snapshot();
    const c = s.config;
    if (!c?.enabled) return;
    if (s.pending) {
      await this.deliver();
      return;
    }
    if (this.now() < s.nextPollAt) return;
    const root = `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'reverie-public-issue-checker',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    await this.store.update((x) => {
      x.nextPollAt = this.now() + c.intervalMinutes * 60000;
    }); // Poll reservation survives restart.
    try {
      const fetcher = this.deps.fetch ?? publicIssueFetch;
      // Revalidate public visibility each cycle. A private/unreachable repo is never interpreted as quiet.
      const repo = await fetcher(root, headers);
      if (
        repo.status !== 200 ||
        !repo.body ||
        typeof repo.body !== 'object' ||
        !('private' in repo.body) ||
        repo.body.private !== false ||
        !('full_name' in repo.body) ||
        String(repo.body.full_name).toLowerCase() !== `${c.owner}/${c.repo}`.toLowerCase()
      )
        throw Error('Public repository unavailable');
      const url =
        root +
        '/issues?state=all&sort=updated&direction=desc&per_page=30' +
        (s.cursor ? '&since=' + encodeURIComponent(s.cursor) : '');
      const began = this.now();
      let result = await fetcher(url, { ...headers, ...(s.etag ? { 'If-None-Match': s.etag } : {}) });
      if (result.status === 304) {
        await this.store.update((x) => {
          x.failures = 0;
          x.lastSuccessAt = this.now();
        });
        return;
      }
      const firstBody = hash(result.body),
        etag = result.headers.get('etag') ?? undefined;
      const rows: unknown[] = [];
      let pages = 0;
      for (let page = 1; page <= 10; page++) {
        pages = page;
        if (result.status !== 200) {
          const reset = Number(result.headers.get('x-ratelimit-reset')) * 1000,
            retry = Number(result.headers.get('retry-after')) * 1000;
          if (result.status === 403 || result.status === 429)
            await this.store.update((x) => {
              x.nextPollAt = Math.max(
                x.nextPollAt,
                Number.isFinite(reset) ? Math.min(reset, this.now() + 86400000) : 0,
                Number.isFinite(retry) ? this.now() + Math.min(retry, 86400000) : 0
              );
            });
          throw Error('Public issue poll unavailable');
        }
        if (!Array.isArray(result.body) || result.body.length > 30 || this.now() - began > 20000)
          throw Error('Incomplete bounded public issue scan; cursor held');
        rows.push(...result.body);
        if (!result.headers.get('link')?.includes('rel="next"')) break;
        if (page === 10) throw Error('Public issue pagination bound; cursor held');
        // Never follow the supplied Link URL: only build the next fixed GitHub page ourselves.
        result = await fetcher(url + '&page=' + (page + 1), headers);
      }
      if (pages > 1) {
        const fence = await fetcher(url, { ...headers, ...(etag ? { 'If-None-Match': etag } : {}) });
        if (
          (fence.status !== 304 && (fence.status !== 200 || hash(fence.body) !== firstBody)) ||
          this.now() - began > 20000
        )
          throw Error('Public issue page fence changed; cursor held');
      }
      const events: z.infer<typeof event>[] = [];
      let cursor = s.cursor;
      const seenRows = new Map<number, string>();
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') throw Error('Malformed public issue');
        const row = raw as Record<string, unknown>;
        if (
          !Number.isSafeInteger(row.number) ||
          Number(row.number) < 1 ||
          !['open', 'closed'].includes(String(row.state)) ||
          typeof row.updated_at !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(row.updated_at) ||
          !Number.isFinite(Date.parse(row.updated_at)) ||
          Date.parse(row.updated_at) > this.now() + 300000 ||
          typeof row.created_at !== 'string' ||
          typeof row.title !== 'string'
        )
          throw Error('Invalid issue metadata');
        if (!cursor || row.updated_at > cursor) cursor = row.updated_at;
        const fingerprint = hash([row.number, row.title, row.state, row.updated_at]);
        if (seenRows.has(Number(row.number))) {
          if (seenRows.get(Number(row.number)) !== fingerprint) throw Error('Conflicting issue pages');
          continue;
        }
        seenRows.set(Number(row.number), fingerprint);
        if ('pull_request' in raw) continue;
        const state = row.state as 'open' | 'closed',
          digest = hash([row.number, row.title, state, row.updated_at]);
        const previous = s.seen[String(row.number)];
        const change = !previous
          ? s.cursor && row.created_at <= s.cursor
            ? 'updated'
            : 'new'
          : previous.state === 'closed' && state === 'open'
            ? 'reopened'
            : state === 'closed'
              ? 'closed'
              : 'updated';
        if (previous?.digest !== digest)
          events.push({
            number: Number(row.number),
            updatedAt: row.updated_at,
            digest,
            state,
            text: `Issue #${row.number} ${change}: ${cleanUntrusted(row.title, 160)} https://github.com/${c.owner}/${c.repo}/issues/${row.number}`,
          });
        if (!cursor || row.updated_at > cursor) cursor = row.updated_at;
      }
      if (Object.keys(s.seen).length + events.filter((e) => !s.seen[String(e.number)]).length > 10000)
        throw Error('Issue cursor capacity reached; explicit archival required');
      if (etag && (etag.length > 300 || /[\r\n]/.test(etag))) throw Error('Invalid ETag');
      if (events.length > 30) throw Error('Public issue change-batch bound; cursor held');
      if (events.length) {
        const id = hash([c.owner, c.repo, events.map((e) => e.digest)]).slice(0, 32);
        await this.store.update((x) => {
          x.pending = {
            id,
            text: `[github-issues:${id}] Public ${c.owner}/${c.repo}\n` + events.map((e) => e.text).join('\n'),
            events,
            etag,
            cursor,
            reservedAt: this.now(),
            phase: 'prepared',
          };
          x.failures = 0;
          x.lastSuccessAt = this.now();
        });
        await this.deliver();
      } else
        await this.store.update((x) => {
          x.etag = etag;
          x.cursor = cursor;
          x.failures = 0;
          x.lastSuccessAt = this.now();
        });
    } catch {
      s = this.store.snapshot();
      await this.store.update((x) => {
        x.failures = Math.min(1000, x.failures + 1);
        x.nextPollAt = Math.max(x.nextPollAt, this.now() + Math.min(3600000, 60000 * 2 ** Math.min(x.failures, 6)));
      });
      if (!s.lastFailureNoticeAt || this.now() - s.lastFailureNoticeAt >= 3600000) {
        const bot = this.deps.bot(c.botId),
          room = this.deps.room(c.roomId),
          posts = s.posts.filter((t) => t > this.now() - 3600000);
        if (
          this.store.snapshot().config?.enabled &&
          bot &&
          room &&
          !room.archivedAt &&
          room.kind !== 'dm' &&
          bot.rooms.includes(room.id) &&
          posts.length < bot.maxPerHour
        ) {
          await this.store.update((x) => {
            x.lastFailureNoticeAt = this.now();
            x.posts = [...posts, this.now()];
          });
          this.deps.post(
            bot,
            room.id,
            `Public GitHub issue checker ${c.owner}/${c.repo}: monitoring incomplete. Cursor retained; no all-clear. Check configured public visibility, API rate limits and bot state.`,
            posts.length
          );
        }
      }
    }
  }
}
