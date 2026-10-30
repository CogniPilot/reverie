/** Owner-selected fixed GET watchers; durable reservations and legacy cursor adoption, no model/shell jobs. */
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { BotWatchState, BotWatchPostRefused } from './bot-watch-state.js';
import { PublicIssueWatch } from './cron/public-issue-watch.js';
import type { ChatBot } from './chat-bots.js';
import type { ChatRoom, ChatMessage } from './chatroom-store.js';
import type { PublicationCredentialVault } from './publication-credentials.js';
import {
  GithubWatchConfig,
  Seen,
  GithubWatchError,
  fingerprint,
  scanGithub,
  type WatchConfig,
  type ScanState,
  type Reply,
} from './github-repository-watch-source.js';
export { GithubWatchConfig };
const scanSchema = z
  .object({
    issueCursor: z.string().max(40).optional(),
    issueSeen: z.record(z.string(), Seen),
    issuePrimed: z.boolean(),
    ciSeen: z.record(z.string(), Seen),
    ciPrimed: z.boolean(),
    openRuns: z.record(z.string().regex(/^\d+$/), z.string().max(40)),
    pageCache: z
      .record(z.string(), z.object({ etag: z.string().max(300), body: z.unknown(), next: z.boolean() }).strict())
      .optional(),
  })
  .strict();
const slotSchema = z
  .object({
    config: GithubWatchConfig,
    generation: z.number().int().positive(),
    removed: z.boolean().default(false),
    legacyAdopted: z.boolean(),
    scan: scanSchema,
    nextPollAt: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative().max(1000),
    lastSuccessAt: z.number().int().optional(),
    lastError: z.string().max(60).optional(),
    baselineAt: z.number().int().optional(),
    ciCreatedSince: z.number().int().optional(),
    posts: z.array(z.number().int()).max(120),
    pending: z
      .object({
        id: z.string().length(32),
        text: z.string().max(5000),
        generation: z.number().int().positive(),
        next: scanSchema,
        phase: z.enum(['prepared', 'reserved', 'delivered', 'unknown']),
        messageId: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    adoptedLegacy: z.boolean(),
    slots: z.record(z.string(), slotSchema).refine((x) => Object.keys(x).length <= 32),
  })
  .strict();
export const GithubWatchCollectionInput = z
  .object({
    version: z.literal(1),
    expectedRevision: z.number().int().nonnegative(),
    watches: z.array(GithubWatchConfig).max(8),
  })
  .strict();
export interface GithubRepositoryWatchDeps {
  legacy: PublicIssueWatch;
  bot(id: string): ChatBot | undefined;
  room(id: string): ChatRoom | undefined;
  post(bot: ChatBot, roomId: string, text: string, recent: number): ChatMessage;
  /** Existing server-private vault; no material route or token is exposed to browser/agent. */
  credentials?: Pick<PublicationCredentialVault, 'metadata' | 'material'>;
  now?: () => number;
  fetch?: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<Reply>;
}
const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const emptyScan = (): ScanState => ({ issueSeen: {}, issuePrimed: false, ciSeen: {}, ciPrimed: false, openRuns: {} });
const SCAN_BUDGET_MS = 60_000;
const need = (ok: unknown, code: string) => {
  if (!ok) throw new GithubWatchError(code);
};
/** Raw response stays bounded and never reaches error/status logs. Redirects never receive credentials. */
async function request(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Reply> {
  const r = await fetch(url, { method: 'GET', headers, signal, redirect: 'error', credentials: 'omit' });
  if (r.status === 304) return { status: r.status, headers: r.headers, body: null };
  if (!r.body) throw new GithubWatchError('GITHUB_UNAVAILABLE');
  const reader = r.body.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.length;
      if (count > 2 * 1024 * 1024) throw new GithubWatchError('RESPONSE_BOUND');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { status: r.status, headers: r.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
/** Persist only the selected metadata needed to validate a conditional response, never raw API objects. */
function compact(path: string, body: unknown, redact: (s: string) => string): unknown {
  const obj = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' ? redact(value) : value);
  const run = (value: unknown) => {
    const r = obj(value);
    return {
      id: r.id,
      name: text(r.name),
      run_attempt: r.run_attempt,
      status: r.status,
      conclusion: r.conclusion,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  };
  if (path.startsWith('/issues?') && Array.isArray(body))
    return body.map((value) => {
      const r = obj(value);
      return {
        number: r.number,
        title: text(r.title),
        state: r.state,
        created_at: r.created_at,
        updated_at: r.updated_at,
        ...(Object.hasOwn(r, 'pull_request') ? { pull_request: {} } : {}),
      };
    });
  if (path.startsWith('/actions/runs?')) {
    const r = obj(body);
    return {
      total_count: r.total_count,
      workflow_runs: Array.isArray(r.workflow_runs) ? r.workflow_runs.map(run) : r.workflow_runs,
    };
  }
  return path.startsWith('/actions/runs/') ? run(body) : body;
}
export class GithubRepositoryWatches {
  readonly store: BotWatchState<z.infer<typeof stateSchema>>;
  private tickFlight?: Promise<void>;
  private configuring = false;
  private configuringRefs = new Set<string>();
  constructor(
    file: string,
    private deps: GithubRepositoryWatchDeps
  ) {
    this.store = new BotWatchState(file, stateSchema, { version: 1, revision: 0, adoptedLegacy: false, slots: {} });
  }
  async init() {
    await this.store.init();
  }
  private now() {
    return Math.trunc((this.deps.now ?? Date.now)());
  }
  private legacyConfig(): WatchConfig | undefined {
    const c = this.deps.legacy.status().config;
    if (!c) return;
    return {
      id: 'github-issues',
      enabled: c.enabled,
      botId: c.botId,
      roomId: c.roomId,
      owner: c.owner,
      repo: c.repo,
      visibility: 'public',
      intervalMinutes: c.intervalMinutes,
      events: { issues: true, pullRequests: false, workflowFailures: false },
      credentialId: null,
    };
  }
  status() {
    const s = this.store.snapshot();
    let slots = Object.values(s.slots).filter((x) => !x.removed);
    if (!s.adoptedLegacy) {
      const c = this.legacyConfig(),
        old = this.deps.legacy.status();
      slots = c
        ? [
            {
              config: c,
              generation: 1,
              removed: false,
              legacyAdopted: true,
              scan: { ...emptyScan(), issueCursor: old.cursor, issueSeen: old.seen, issuePrimed: true },
              nextPollAt: old.nextPollAt,
              failures: old.failures,
              lastSuccessAt: old.lastSuccessAt,
              posts: old.posts,
              ...(old.pending ? { lastError: 'LEGACY_DELIVERY_PENDING' } : {}),
            },
          ]
        : [];
    }
    return {
      version: 1,
      revision: s.revision,
      watches: slots.map((x) => ({
        config: x.config,
        status: {
          state:
            x.pending?.phase === 'unknown'
              ? 'hold'
              : !x.config.enabled
                ? 'disabled'
                : x.config.visibility === 'private' && !x.config.credentialId
                  ? 'auth-required'
                  : x.lastError === 'AUTH_REQUIRED'
                    ? 'auth-required'
                    : x.lastError
                      ? 'error'
                      : x.lastSuccessAt
                        ? 'active'
                        : 'not-run',
          lastSuccessAt: x.lastSuccessAt ?? null,
          nextPollAt: x.nextPollAt,
          failures: x.failures,
          pendingCount: x.pending ? 1 : 0,
          lastError: x.lastError ?? null,
          legacyAdopted: x.legacyAdopted,
          ciCoverage: {
            createdSince: x.ciCreatedSince ?? null,
            rerunWindowDays: 31,
            baselineAt: x.baselineAt ?? null,
            complete: !!x.lastSuccessAt && !x.lastError && (!x.config.events.workflowFailures || x.scan.ciPrimed),
          },
        },
      })),
    };
  }
  usesBot(id: string): boolean {
    return this.configuringRefs.has(id) || this.status().watches.some((x) => x.config.botId === id);
  }
  private validateRoom(c: WatchConfig) {
    const b = this.deps.bot(c.botId),
      r = this.deps.room(c.roomId);
    need(
      b && b.rooms.includes(c.roomId) && r && !r.archivedAt && r.kind !== 'dm' && r.owner === undefined,
      'ALLOWED_BOT_ROOM_REQUIRED'
    );
  }
  private current(id: string, generation: number) {
    const x = own(this.store.snapshot().slots, id);
    need(x && !x.removed && x.config.enabled && x.generation === generation, 'CONFIG_CHANGED');
    if (x) this.validateRoom(x.config);
    return x!;
  }
  private async credential(c: WatchConfig, validate: () => void) {
    validate();
    let material: Buffer | undefined;
    try {
      if (!c.credentialId) {
        need(c.visibility === 'public', 'AUTH_REQUIRED');
        return undefined;
      }
      need(this.deps.credentials, 'AUTH_REQUIRED');
      const select = async () => {
        const meta = await this.deps.credentials!.metadata(undefined);
        validate();
        const selected = meta.find((x) => x.id === c.credentialId);
        need(
          selected?.repositories.some((r) => r.toLowerCase() === `${c.owner}/${c.repo}`.toLowerCase()),
          'CREDENTIAL_REPOSITORY_REQUIRED'
        );
        return fingerprint(selected);
      };
      const binding = await select();
      const revalidate = async () => {
        validate();
        need((await select()) === binding, 'CREDENTIAL_CHANGED');
        validate();
      };
      material = await this.deps.credentials!.material(undefined, c.credentialId, validate);
      await revalidate();
      return { material, revalidate };
    } catch (error) {
      material?.fill(0);
      if (error instanceof GithubWatchError) throw error;
      throw new GithubWatchError('AUTH_REQUIRED');
    }
  }
  async configure(raw: unknown, validate: () => void = () => {}) {
    const check = () => {
      need(validate() === undefined, 'SYNCHRONOUS_AUTHORITY_REQUIRED');
      for (const c of input.watches) this.validateRoom(c);
    };
    const input = GithubWatchCollectionInput.parse(raw);
    check();
    need(!this.configuring, 'CONFIGURATION_BUSY');
    this.configuring = true;
    this.configuringRefs = new Set(input.watches.map((c) => c.botId));
    try {
      let before = this.store.snapshot();
      need(before.revision === input.expectedRevision, 'REVISION_CONFLICT');
      const ids = new Set<string>(),
        targets = new Set<string>();
      const legacy = this.legacyConfig();
      for (const c of input.watches) {
        need(!ids.has(c.id) && !targets.has(`${c.owner}/${c.repo}`.toLowerCase()), 'DUPLICATE_WATCH');
        ids.add(c.id);
        targets.add(`${c.owner}/${c.repo}`.toLowerCase());
        this.validateRoom(c);
        const previous =
          own(before.slots, c.id)?.config ?? (!before.adoptedLegacy && legacy?.id === c.id ? legacy : undefined);
        if (previous)
          need(
            `${previous.owner}/${previous.repo}`.toLowerCase() === `${c.owner}/${c.repo}`.toLowerCase(),
            'WATCH_TARGET_IMMUTABLE'
          );
        if (c.intervalMinutes < 15) {
          need(
            previous &&
              c.intervalMinutes === previous.intervalMinutes &&
              fingerprint({ ...c, enabled: false }) === fingerprint({ ...previous, enabled: false }),
            'MINIMUM_NEW_INTERVAL_15'
          );
        }
        if (c.credentialId) {
          const metadata = await this.deps.credentials?.metadata(undefined);
          check();
          need(
            metadata?.some(
              (m) =>
                m.id === c.credentialId &&
                m.repositories.some((r) => r.toLowerCase() === `${c.owner}/${c.repo}`.toLowerCase())
            ),
            'CREDENTIAL_REPOSITORY_REQUIRED'
          );
        }
      }
      // Stop new legacy dispatch; await only an ALREADY-running scheduler flight, never create a manual tick.
      if (!before.adoptedLegacy) {
        if (this.tickFlight) await this.tickFlight;
        check();
        const old = this.deps.legacy.status();
        need(!old.pending, 'LEGACY_DELIVERY_PENDING');
        if (old.config?.enabled) await this.deps.legacy.configure({ ...old.config, enabled: false }, check);
        check();
        need(!this.deps.legacy.status().pending, 'LEGACY_DELIVERY_PENDING');
      }
      before = this.store.snapshot();
      need(before.revision === input.expectedRevision, 'REVISION_CONFLICT');
      const legacyState = this.deps.legacy.status();
      const priorSlots = { ...before.slots };
      if (!before.adoptedLegacy && legacy)
        priorSlots[legacy.id] = {
          config: legacy,
          generation: 1,
          removed: false,
          legacyAdopted: true,
          scan: { ...emptyScan(), issueCursor: legacyState.cursor, issueSeen: legacyState.seen, issuePrimed: true },
          nextPollAt: legacyState.nextPollAt,
          failures: legacyState.failures,
          lastSuccessAt: legacyState.lastSuccessAt,
          posts: legacyState.posts,
        };
      const cancelled: unknown[] = [];
      for (const [id, x] of Object.entries(priorSlots)) {
        const c = input.watches.find((c) => c.id === id);
        if (fingerprint(c) !== fingerprint(x.config) && x.pending) {
          const disableOnly =
            c && !c.enabled && fingerprint({ ...c, enabled: false }) === fingerprint({ ...x.config, enabled: false });
          need(disableOnly || x.pending.phase === 'prepared', 'DELIVERY_UNCONFIRMED');
          if (x.pending.phase === 'prepared')
            cancelled.push({
              kind: 'github-watch-prepared-cancelled',
              id,
              generation: x.generation,
              pending: x.pending,
            });
        }
      }
      await this.store.archive([
        {
          kind: 'github-watch-configuration-proposed',
          at: this.now(),
          revision: input.expectedRevision,
          watches: input.watches,
        },
        ...cancelled,
      ]);
      check();
      await this.store.update((s) => {
        check();
        need(s.revision === input.expectedRevision, 'REVISION_CONFLICT');
        if (!s.adoptedLegacy) s.slots = priorSlots;
        for (const [id, x] of Object.entries(s.slots)) {
          const c = input.watches.find((c) => c.id === id);
          if (fingerprint(c) === fingerprint(x.config) || !x.pending) continue;
          const disableOnly =
            c && !c.enabled && fingerprint({ ...c, enabled: false }) === fingerprint({ ...x.config, enabled: false });
          if (disableOnly && x.pending.phase !== 'prepared') continue;
          need(
            x.pending.phase === 'prepared' &&
              cancelled.some((v) => {
                const a = v as { id: string; pending: unknown };
                return a.id === id && fingerprint(a.pending) === fingerprint(x.pending);
              }),
            'REVISION_CONFLICT'
          );
        }

        for (const [id, x] of Object.entries(s.slots))
          if (!ids.has(id)) {
            x.config.enabled = false;
            x.removed = true;
            x.generation++;
            delete x.pending;
          }
        for (const c of input.watches) {
          const x = own(s.slots, c.id);
          if (x) {
            if (fingerprint(x.config) !== fingerprint(c) || x.removed) {
              x.generation++;
              if (x.pending?.phase === 'prepared') delete x.pending;
              delete x.lastError;
              delete x.lastSuccessAt;
              x.nextPollAt = 0;
            }
            x.config = c;
            x.removed = false;
          } else
            s.slots[c.id] = {
              config: c,
              generation: 1,
              removed: false,
              legacyAdopted: false,
              scan: emptyScan(),
              nextPollAt: 0,
              failures: 0,
              posts: [],
            };
        }
        s.adoptedLegacy = true;
        s.revision++;
      }, check);
      check();
      await this.store.archive([
        { kind: 'github-watch-configuration-committed', at: this.now(), revision: input.expectedRevision + 1 },
      ]);
      check();
      return this.status();
    } finally {
      this.configuring = false;
      this.configuringRefs.clear();
    }
  }
  tick(): Promise<void> {
    if (this.tickFlight || this.configuring) return this.tickFlight ?? Promise.resolve();
    const work = this.run();
    this.tickFlight = work;
    return work.finally(() => {
      if (this.tickFlight === work) this.tickFlight = undefined;
    });
  }
  private async run() {
    if (!this.store.snapshot().adoptedLegacy) {
      await this.deps.legacy.tick();
      return;
    }
    for (const x of Object.values(this.store.snapshot().slots))
      if (x.config.enabled && !x.removed) await this.poll(x.config.id, x.generation);
  }
  private async deliver(id: string, generation: number) {
    let x = this.current(id, generation),
      p = x.pending;
    if (!p) return;
    const bot = this.deps.bot(x.config.botId)!,
      room = this.deps.room(x.config.roomId)!;
    need(p.generation === generation, 'DELIVERY_UNCONFIRMED');
    if (p.phase === 'reserved' || p.phase === 'unknown') {
      const matches = room.messages.filter(
        (m) => m.from.kind === 'bot' && m.from.botId === bot.id && m.text === p!.text && !m.deleted
      );
      if (matches.length !== 1) {
        await this.store.update((s) => {
          const a = s.slots[id]!;
          if (a.generation === generation && a.pending) a.pending.phase = 'unknown';
        });
        return;
      }
      await this.store.update((s) => {
        this.current(id, generation);
        s.slots[id]!.pending!.phase = 'delivered';
        s.slots[id]!.pending!.messageId = matches[0]!.id;
      });
    }
    x = this.current(id, generation);
    p = x.pending!;
    if (p.phase === 'prepared') {
      const recent = x.posts.filter((t) => t > this.now() - 3600000);
      if (recent.length >= bot.maxPerHour) return;
      await this.store.update((s) => {
        this.current(id, generation);
        const a = s.slots[id]!;
        a.posts = [...recent, this.now()];
        a.pending!.phase = 'reserved';
      });
      try {
        const fresh = this.current(id, generation),
          currentBot = this.deps.bot(fresh.config.botId)!;
        this.validateRoom(fresh.config);
        const message = this.deps.post(currentBot, fresh.config.roomId, p.text, recent.length);
        await this.store.update((s) => {
          this.current(id, generation);
          s.slots[id]!.pending!.phase = 'delivered';
          s.slots[id]!.pending!.messageId = message.id;
        });
      } catch (error) {
        await this.store.update((s) => {
          const a = s.slots[id]!;
          if (a.generation === generation && a.pending)
            a.pending.phase = error instanceof BotWatchPostRefused ? 'prepared' : 'unknown';
        });
        return;
      }
    }
    x = this.current(id, generation);
    if (x.pending?.phase === 'delivered')
      await this.store.update((s) => {
        this.current(id, generation);
        const a = s.slots[id]!;
        a.scan = a.pending!.next;
        delete a.pending;
      });
  }
  private async poll(id: string, generation: number) {
    let token: Buffer | undefined;
    try {
      const x = this.current(id, generation);
      if (x.pending) {
        await this.deliver(id, generation);
        return;
      }
      if (this.now() < x.nextPollAt) return;
      await this.store.update((s) => {
        this.current(id, generation);
        s.slots[id]!.nextPollAt = this.now() + x.config.intervalMinutes * 60000;
      });
      const validate = () => {
        this.current(id, generation);
      };
      const credential = await this.credential(x.config, validate);
      token = credential?.material;
      const secret = token?.toString('ascii');
      const redact = (v: string) => (secret ? v.split(secret).join('[redacted]') : v);
      const began = performance.now();
      let totalBytes = 0,
        backoff = 0;
      const pageCache: NonNullable<ScanState['pageCache']> = {};
      const get = async (path: string): Promise<Reply> => {
        if (credential) await credential.revalidate();
        validate();
        need(path === '' || /^\/(?:issues\?|actions\/runs(?:\?|\/\d+$))/.test(path), 'FIXED_GITHUB_PATH_REQUIRED');
        const remaining = SCAN_BUDGET_MS - (performance.now() - began);
        need(remaining > 0, 'SCAN_TIMEOUT');
        const headers: Record<string, string> = {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'reverie-github-watch',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(secret ? { Authorization: 'Bearer ' + secret } : {}),
          ...(x.scan.pageCache?.[path] ? { 'If-None-Match': x.scan.pageCache[path]!.etag } : {}),
        };
        const url = `https://api.github.com/repos/${encodeURIComponent(x.config.owner)}/${encodeURIComponent(x.config.repo)}${path}`;
        const signal = AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
        let reply: Reply;
        try {
          reply = await (this.deps.fetch ?? request)(url, headers, signal);
        } catch (error) {
          if (signal.aborted) throw new GithubWatchError('SCAN_TIMEOUT');
          throw error;
        }
        validate();
        need(!signal.aborted, 'SCAN_TIMEOUT');
        totalBytes += Buffer.byteLength(JSON.stringify(reply.body ?? null));
        need(totalBytes <= 64 * 1024 * 1024, 'SCAN_BYTE_BOUND');
        if (
          reply.status === 429 ||
          (reply.status === 403 &&
            (reply.headers.get('x-ratelimit-remaining') === '0' || reply.headers.get('retry-after')))
        ) {
          const reset = Number(reply.headers.get('x-ratelimit-reset')) * 1000,
            retry = Number(reply.headers.get('retry-after')) * 1000;
          backoff = Math.max(
            backoff,
            Number.isFinite(reset) ? Math.min(reset, this.now() + 86400000) : 0,
            Number.isFinite(retry) ? this.now() + Math.min(retry, 86400000) : 0
          );
        }
        const prior = x.scan.pageCache?.[path];
        if (reply.status === 304) {
          need(prior, 'UNCACHED_CONDITIONAL_REPLY');
          pageCache[path] = prior!;
          return {
            status: 200,
            body: prior!.body,
            headers: {
              get: (k) =>
                k === 'link' ? (prior!.next ? '<fixed>; rel="next"' : null) : k === 'etag' ? prior!.etag : null,
            },
          };
        }
        if (reply.status === 200 && path) {
          const body = compact(path, reply.body, redact),
            etag = reply.headers.get('etag');
          if (etag) {
            need(etag.length <= 300 && !/[\r\n]/.test(etag), 'INVALID_ETAG');
            pageCache[path] = { etag, body, next: !!reply.headers.get('link')?.includes('rel="next"') };
          }
          return { ...reply, body };
        }
        return reply;
      };
      let result;
      try {
        result = await scanGithub(x.config, x.scan, get, this.now(), redact);
      } catch (e) {
        if (backoff)
          await this.store.update((s) => {
            this.current(id, generation);
            s.slots[id]!.nextPollAt = Math.max(s.slots[id]!.nextPollAt, backoff);
          });
        throw e;
      }
      result.next.pageCache = pageCache;
      if (credential) await credential.revalidate();
      validate();
      const text = result.events.length
        ? `[github-watch:${fingerprint([id, generation, result.events]).slice(0, 32)}] ${x.config.owner}/${x.config.repo}\n` +
          result.events.map((e) => e.text).join('\n')
        : '';
      need(text.length <= 5000, 'CHANGE_BATCH_BOUND');
      await this.store.update(
        (s) => {
          this.current(id, generation);
          const a = s.slots[id]!;
          a.failures = 0;
          delete a.lastError;
          a.lastSuccessAt = this.now();
          a.baselineAt ??= this.now();
          a.ciCreatedSince = result.createdSince;
          if (result.events.length)
            a.pending = {
              id: fingerprint([id, generation, result.events]).slice(0, 32),
              text,
              generation,
              next: result.next,
              phase: 'prepared',
            };
          else a.scan = result.next;
        },
        // Check at writer admission and after temporary-file write/fsync, immediately before rename.
        () => need(performance.now() - began < SCAN_BUDGET_MS, 'SCAN_TIMEOUT')
      );
      await this.deliver(id, generation);
    } catch (error) {
      if (error instanceof GithubWatchError && error.code === 'CONFIG_CHANGED') return;
      const code = error instanceof GithubWatchError ? error.code : 'GITHUB_UNAVAILABLE';
      await this.store.update((s) => {
        const a = own(s.slots, id);
        if (!a || a.generation !== generation) return;
        a.failures = Math.min(1000, a.failures + 1);
        a.lastError = code;
        a.nextPollAt = Math.max(a.nextPollAt, this.now() + Math.min(3600000, 60000 * 2 ** Math.min(a.failures, 6)));
      });
    } finally {
      token?.fill(0);
    }
  }
}
