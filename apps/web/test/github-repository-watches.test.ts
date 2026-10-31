import { afterEach, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import fs, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubRepositoryWatches } from '../src/github-repository-watches.js';
import { PublicIssueWatch } from '../src/cron/public-issue-watch.js';
import { PublicationCredentialVault } from '../src/publication-credentials.js';
import type { ChatBot } from '../src/chat-bots.js';
import type { ChatRoom, ChatMessage } from '../src/chatroom-store.js';
import type { Reply, WatchConfig } from '../src/github-repository-watch-source.js';
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const stamp = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const reply = (body: unknown, headers: Record<string, string> = {}, status = 200): Reply => ({
  body,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});
async function fixture(legacy = false) {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), 'repo-watch-'));
  dirs.push(dir);
  let now = Date.UTC(2026, 9, 27),
    requests = 0,
    postThrows = false;
  const messages: ChatMessage[] = [];
  const bot = { id: 'github-issues', name: 'GitHub', rooms: ['room', 'second'], maxPerHour: 30 } as ChatBot;
  const room = { id: 'room', name: 'Room', messages, members: [] } as unknown as ChatRoom;
  const bots = (id: string) => (id === bot.id ? bot : undefined);
  const rooms = (id: string) => (['room', 'second'].includes(id) ? { ...room, id } : undefined);
  const post = (_b: ChatBot, _r: string, text: string) => {
    if (postThrows) throw Error('Fixture unknown effect');
    const m = { id: 'message-' + messages.length, text, from: { kind: 'bot', botId: bot.id }, at: now } as ChatMessage;
    messages.push(m);
    return m;
  };
  let issueRows: unknown[] = [],
    ciRows: unknown[] = [];
  let fetcher = async (url: string, _headers: Record<string, string>, _signal: AbortSignal) => {
    requests++;
    const u = new URL(url);
    if (u.pathname.endsWith('/issues')) return reply(issueRows);
    if (u.pathname.includes('/actions/runs')) return reply({ total_count: ciRows.length, workflow_runs: ciRows });
    return reply({ full_name: 'owner/repo', private: false });
  };
  const old = new PublicIssueWatch(join(dir, 'public-issue-watch.json'), {
    bot: bots,
    room: rooms,
    post,
    now: () => now,
    fetch: async () => {
      throw Error('Legacy must not fetch after adoption');
    },
  });
  await old.init();
  if (legacy)
    await old.configure({
      version: 1,
      type: 'public-github-issues',
      enabled: true,
      botId: bot.id,
      roomId: 'room',
      owner: 'owner',
      repo: 'repo',
      intervalMinutes: 10,
    });
  const vault = new PublicationCredentialVault(join(dir, 'vault'), { audit: () => {} });
  const deps = {
    legacy: old,
    bot: bots,
    room: rooms,
    post,
    now: () => now,
    credentials: vault,
    fetch: (url: string, headers: Record<string, string>, signal: AbortSignal) => fetcher(url, headers, signal),
  };
  const service = new GithubRepositoryWatches(join(dir, 'github-repository-watches.json'), deps);
  await service.init();
  const cfg: WatchConfig = {
    id: legacy ? 'github-issues' : 'repo',
    enabled: true,
    botId: bot.id,
    roomId: 'room',
    owner: 'owner',
    repo: 'repo',
    visibility: 'public',
    intervalMinutes: 30,
    events: { issues: true, pullRequests: true, workflowFailures: true },
    credentialId: null,
  };
  return {
    dir,
    service,
    old,
    vault,
    deps,
    cfg,
    bot,
    messages,
    now: () => now,
    advance: (n = 1800001) => (now += n),
    requests: () => requests,
    postFail: () => (postThrows = true),
    setFetch: (f: typeof fetcher) => (fetcher = f),
    setIssues: (a: unknown[]) => (issueRows = a),
    setRuns: (a: unknown[]) => (ciRows = a),
    issue: (number = 1, title = 'A change', pull = false) => ({
      number,
      title,
      state: 'open',
      created_at: stamp(now - 1000),
      updated_at: stamp(now),
      ...(pull ? { pull_request: {} } : {}),
    }),
    run: (id = 1, attempt = 1, conclusion = 'failure') => ({
      id,
      run_attempt: attempt,
      name: 'Build',
      status: 'completed',
      conclusion,
      created_at: stamp(now - 86400000),
      updated_at: stamp(now),
    }),
    configure: (watches = [cfg], revision = service.status().revision) =>
      service.configure({ version: 1, expectedRevision: revision, watches }),
  };
}
it('creates a quiet baseline then announces issues, PRs and each new CI attempt once', async () => {
  const f = await fixture();
  f.setIssues([f.issue()]);
  f.setRuns([f.run()]);
  await f.configure();
  await f.service.tick();
  expect(f.messages).toHaveLength(0);
  f.advance();
  f.setIssues([f.issue(1, 'Updated'), f.issue(2, 'PR title', true)]);
  f.setRuns([f.run(1, 2)]);
  await f.service.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]!.text).toContain('PR #2');
  expect(f.messages[0]!.text).toContain('attempt 2');
  f.advance();
  await f.service.tick();
  expect(f.messages).toHaveLength(1);
});
it('adopts exact legacy issue cursor/seen and unchanged10 without duplicate dispatch', async () => {
  const f = await fixture(true);
  const row = f.issue();
  const { fingerprint } = await import('../src/github-repository-watch-source.js');
  await f.old.store.update((s) => {
    s.cursor = String(row.updated_at);
    s.seen['1'] = { digest: fingerprint([row.number, row.title, row.state, row.updated_at]), state: 'open' };
  });
  const projected = f.service.status().watches[0]!.config;
  expect(projected.intervalMinutes).toBe(10);
  await f.configure([projected]);
  expect(f.old.status().config!.enabled).toBe(false);
  expect(f.service.store.snapshot().slots['github-issues']!.scan.issueCursor).toBe(row.updated_at);
  f.setIssues([row]);
  await f.service.tick();
  expect(f.messages).toHaveLength(0);
  expect(f.service.status().watches[0]!.status.legacyAdopted).toBe(true);
});
it('rejects stale CAS and changed same-id repository without modifying durable bytes', async () => {
  const f = await fixture();
  await f.configure();
  const bytes = await readFile(f.service.store.file);
  await expect(f.configure([f.cfg], 0)).rejects.toThrow();
  await expect(f.configure([{ ...f.cfg, repo: 'other' }])).rejects.toThrow();
  expect(await readFile(f.service.store.file)).toEqual(bytes);
});
it('private no-handle config is saved auth-required and makes no remote request', async () => {
  const f = await fixture();
  await f.configure([{ ...f.cfg, visibility: 'private' }]);
  await f.service.tick();
  expect(f.requests()).toBe(0);
  expect(f.service.status().watches[0]!.status.state).toBe('auth-required');
});
it('real server vault material is constrained to declared repository and never in status/notice', async () => {
  const f = await fixture();
  const secret = 'owned-fixture-only-secret';
  const token = await f.vault.create(
    undefined,
    { name: 'read-only', token: secret, repositories: ['owner/repo'] },
    () => {}
  );
  const cfg = { ...f.cfg, visibility: 'private' as const, credentialId: token.id };
  let version = 1;
  f.setFetch(async (url, headers) => {
    expect(headers.Authorization).toBe('Bearer ' + secret);
    const path = new URL(url).pathname;
    if (path.endsWith('/issues')) return reply([f.issue(1, 'Title ' + version + ' ' + secret)]);
    if (path.includes('/actions/runs')) return reply({ total_count: 0, workflow_runs: [] });
    return reply({ full_name: 'owner/repo', private: true });
  });
  await f.configure([cfg]);
  await f.service.tick();
  f.advance();
  version++;
  await f.service.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]!.text).toContain('redacted');
  expect(JSON.stringify(f.service.status())).not.toContain(secret);
  expect(await readFile(f.service.store.file, 'utf8')).not.toContain(secret);
});
it('rejects a handle whose repository declaration does not match, before config publication', async () => {
  const f = await fixture();
  const token = await f.vault.create(
    undefined,
    { name: 'other', token: 'fixture-only', repositories: ['owner/other'] },
    () => {}
  );
  await expect(f.configure([{ ...f.cfg, credentialId: token.id }])).rejects.toThrow();
  expect(f.service.status().revision).toBe(0);
  expect(f.requests()).toBe(0);
});
it('reserves unknown delivery durably and never blindly resends after reopen', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  f.advance();
  f.setIssues([f.issue()]);
  f.postFail();
  await f.service.tick();
  expect(f.service.status().watches[0]!.status.state).toBe('hold');
  const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
  await reopened.init();
  await reopened.tick();
  expect(f.messages).toHaveLength(0);
  expect(reopened.status().watches[0]!.status.state).toBe('hold');
});
it('incomplete pages hold all cursors and do not report false healthy progress', async () => {
  const f = await fixture();
  await f.configure();
  f.setFetch(async (url) =>
    new URL(url).pathname.endsWith('/issues')
      ? reply([f.issue()], { link: '<ignored>; rel="next"' })
      : reply({ full_name: 'owner/repo', private: false })
  );
  await f.service.tick();
  const s = f.service.store.snapshot().slots.repo!;
  expect(s.scan.issueCursor).toBeUndefined();
  expect(s.lastSuccessAt).toBeUndefined();
  expect(f.messages).toHaveLength(0);
  expect(s.lastError).toBeDefined();
});
it('neutralizes external mentions without targeted wake text', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  f.advance();
  f.setIssues([f.issue(1, '@everyone\n@Owner *do this*')]);
  await f.service.tick();
  expect(f.messages[0]!.text).not.toContain('@everyone');
  expect(f.messages[0]!.text).not.toContain('\n@Owner');
});
it('configuration generation change during awaited fetch prevents stale publication', async () => {
  const f = await fixture();
  await f.configure();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  f.setFetch(async () => {
    entered();
    await gate;
    return reply({ full_name: 'owner/repo', private: false });
  });
  const polling = f.service.tick();
  await started;
  await f.configure([{ ...f.cfg, enabled: false }]);
  release();
  await polling;
  expect(f.messages).toHaveLength(0);
  expect(f.service.status().watches[0]!.config.enabled).toBe(false);
});
it('no token is fetched or emitted by deterministic offline configuration with null references', async () => {
  const f = await fixture();
  f.deps.credentials.metadata = async () => {
    throw Error('Unused credential metadata');
  };
  f.deps.credentials.material = async () => {
    throw Error('Unused token material');
  };
  await f.configure([{ ...f.cfg, visibility: 'private' }]);
  expect(f.requests()).toBe(0);
  expect(f.service.status().watches[0]!.status.state).toBe('auth-required');
});
it('conditionally reuses only the matching complete issue page, without inventing a 304 body', async () => {
  const f = await fixture();
  f.cfg.events = { issues: true, pullRequests: false, workflowFailures: false };
  let conditionals = 0;
  const row = f.issue();
  f.setFetch(async (url, headers) => {
    if (new URL(url).pathname.endsWith('/issues')) {
      if (headers['If-None-Match']) {
        conditionals++;
        return reply(null, {}, 304);
      }
      return reply([row], { etag: '"fixture-etag"' });
    }
    return reply({ full_name: 'owner/repo', private: false });
  });
  await f.configure();
  await f.service.tick();
  f.advance();
  await f.service.tick();
  f.advance();
  await f.service.tick();
  expect(conditionals).toBe(2);
  expect(f.service.status().watches[0]!.status.state).toBe('active');
  expect(f.messages).toHaveLength(0);
});
it('honors rate-limit backoff and exposes static status without response/token errors', async () => {
  const f = await fixture();
  await f.configure();
  f.setFetch(async () => reply({ message: 'untrusted body must not escape' }, { 'retry-after': '3600' }, 429));
  await f.service.tick();
  const status = f.service.status().watches[0]!.status;
  expect(status.nextPollAt).toBeGreaterThanOrEqual(f.now() + 3600000);
  expect(status.lastError).toBe('RATE_LIMITED');
  expect(JSON.stringify(status)).not.toContain('untrusted');
});
it('rejects asynchronous authority callbacks instead of treating their Promise as admission', async () => {
  const f = await fixture();
  await expect(
    f.service.configure({ version: 1, expectedRevision: 0, watches: [f.cfg] }, async () => {})
  ).rejects.toThrow('SYNCHRONOUS_AUTHORITY_REQUIRED');
  expect(f.service.status().revision).toBe(0);
});
it('allows disabling unknown delivery but preserves its no-replay fence and refuses removal', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  f.advance();
  f.setIssues([f.issue()]);
  f.postFail();
  await f.service.tick();
  await f.configure([{ ...f.cfg, enabled: false }]);
  expect(f.service.status().watches[0]!.config.enabled).toBe(false);
  expect(f.service.status().watches[0]!.status.pendingCount).toBe(1);
  await expect(f.configure([])).rejects.toThrow('DELIVERY_UNCONFIRMED');
});
it('holds bot references during configuration publication and releases them only after retirement', async () => {
  const f = await fixture();
  const t = await f.vault.create(
    undefined,
    { name: 'read', token: 'fixture-read', repositories: ['owner/repo'] },
    () => {}
  );
  const original = f.vault.metadata.bind(f.vault);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (entered = r));
  f.vault.metadata = async (owner) => {
    entered();
    await gate;
    return original(owner);
  };
  const writing = f.configure([{ ...f.cfg, credentialId: t.id }]);
  await start;
  expect(f.service.usesBot(f.cfg.botId)).toBe(true);
  release();
  await writing;
  expect(f.service.usesBot(f.cfg.botId)).toBe(true);
  await f.configure([]);
  expect(f.service.usesBot(f.cfg.botId)).toBe(false);
});
it('wipes material returned across a stale configuration boundary and makes no HTTP request', async () => {
  const f = await fixture();
  const t = await f.vault.create(
    undefined,
    { name: 'read', token: 'fixture-secret', repositories: ['owner/repo'] },
    () => {}
  );
  const cfg = { ...f.cfg, visibility: 'private' as const, credentialId: t.id };
  await f.configure([cfg]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (entered = r)),
    bytes = Buffer.from('fixture-secret');
  f.vault.material = async () => {
    entered();
    await gate;
    return bytes;
  };
  const polling = f.service.tick();
  await start;
  await f.configure([{ ...cfg, enabled: false }]);
  release();
  await polling;
  expect(bytes.every((n) => n === 0)).toBe(true);
  expect(f.requests()).toBe(0);
});
it('treats constructor as an own record key rather than an inherited Object function', async () => {
  const f = await fixture();
  await f.configure([{ ...f.cfg, id: 'constructor' }]);
  expect(f.service.status().watches.map((x) => x.config.id)).toEqual(['constructor']);
  expect(Object.hasOwn(f.service.store.snapshot().slots, 'constructor')).toBe(true);
  await f.service.tick();
  expect(f.service.status().watches[0]!.status.state).toBe('active');
});

it('revalidates the selected credential repository grant before each later HTTP page', async () => {
  const f = await fixture();
  const t = await f.vault.create(
    undefined,
    { name: 'read', token: 'fixture-secret', repositories: ['owner/repo'] },
    () => {}
  );
  await f.configure([{ ...f.cfg, visibility: 'private', credentialId: t.id }]);
  const original = f.vault.metadata.bind(f.vault);
  let revoked = false,
    calls = 0;
  f.vault.metadata = async (owner) => (revoked ? [] : original(owner));
  const bytes = Buffer.from('fixture-secret');
  f.vault.material = async () => bytes;
  f.setFetch(async (_url, headers) => {
    calls++;
    expect(headers.Authorization).toBe('Bearer fixture-secret');
    revoked = true;
    return reply({ full_name: 'owner/repo', private: true });
  });
  await f.service.tick();
  expect(calls).toBe(1);
  expect(bytes.every((n) => n === 0)).toBe(true);
  expect(f.service.status().watches[0]!.status.lastError).toBe('CREDENTIAL_REPOSITORY_REQUIRED');
  expect(f.messages).toHaveLength(0);
});

it('completes all seven CI pages and their consistency fence after 20 seconds within one 60-second budget', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  f.advance();
  let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const rows = Array.from({ length: 697 }, (_, i) => f.run(i + 1, 1, i === 696 ? 'failure' : 'success'));
  const paths: URL[] = [];
  f.setFetch(async (url) => {
    elapsed += 4000;
    const path = new URL(url);
    paths.push(path);
    if (path.pathname.endsWith('/issues')) return reply([f.issue()]);
    if (path.pathname.endsWith('/actions/runs')) {
      const page = Number(path.searchParams.get('page') ?? 1);
      return reply(
        { total_count: rows.length, workflow_runs: rows.slice((page - 1) * 100, page * 100) },
        page < 7 ? { link: '<fixed>; rel="next"' } : {}
      );
    }
    return reply({ full_name: 'owner/repo', private: false });
  });
  await f.service.tick();
  expect(elapsed).toBe(40000);
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual(Array.from({ length: 10 }, (_, i) => 60000 - i * 4000));
  const runPages = paths.filter((p) => p.pathname.endsWith('/actions/runs'));
  expect(runPages.map((p) => p.searchParams.get('page') ?? '1')).toEqual(['1', '2', '3', '4', '5', '6', '7', '1']);
  expect(new Set(runPages.map((p) => p.searchParams.get('created')))).toEqual(
    new Set([stamp(f.now() - 31 * 86400000) + '..' + stamp(f.now())])
  );
  const slot = f.service.store.snapshot().slots.repo!;
  expect(Object.keys(slot.scan.ciSeen)).toHaveLength(697);
  expect(slot.scan.issueCursor).toBe(stamp(f.now()));
  expect(slot.lastSuccessAt).toBe(f.now());
  expect(slot.lastError).toBeUndefined();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]!.text).toContain('/actions/runs/697');
});

it('holds all scan, success and delivery progress when the final response returns beyond the shared deadline', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  const before = f.service.store.snapshot().slots.repo!;
  f.advance();
  let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  f.setFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/issues')) return reply([f.issue()]);
    if (path.endsWith('/actions/runs')) {
      // A delayed event loop or non-cooperating fetch may return before its abort timer runs.
      elapsed = 60001;
      return reply({ total_count: 1, workflow_runs: [f.run()] });
    }
    return reply({ full_name: 'owner/repo', private: false });
  });
  await f.service.tick();
  const after = f.service.store.snapshot().slots.repo!;
  expect(after.lastError).toBe('SCAN_TIMEOUT');
  expect(after.scan).toEqual(before.scan);
  expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
  expect(after.baselineAt).toBe(before.baselineAt);
  expect(after.ciCreatedSince).toBe(before.ciCreatedSince);
  expect(after.pending).toBeUndefined();
  expect(after.posts).toEqual(before.posts);
  expect(after.failures).toBe(1);
  expect(after.nextPollAt).toBeGreaterThan(f.now());
  expect(f.messages).toHaveLength(0);
});

it('does not commit scan success or lose events when temporary-file writing consumes the deadline', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  const before = f.service.store.snapshot().slots.repo!;
  f.advance();
  f.setIssues([f.issue()]);
  f.setRuns([f.run()]);
  let elapsed = 0,
    expiredDuringWrite = false;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
    const handle = await (open as (...a: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
    if (String(path).startsWith(f.service.store.file + '.') && String(path).endsWith('.tmp'))
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'writeFile')
            return async (data: unknown) => {
              await target.writeFile(String(data));
              if (JSON.parse(String(data)).slots.repo.pending?.scannedAt === f.now()) {
                expiredDuringWrite = true;
                elapsed = 60001;
              }
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    return handle;
  }) as typeof fs.open);
  // The existing state writer latches publication uncertainty; it must not post or publish the staged success.
  await expect(f.service.tick()).rejects.toThrow('unavailable');
  expect(expiredDuringWrite).toBe(true);
  expect(() => f.service.store.snapshot()).toThrow('unavailable');
  const after = JSON.parse(await readFile(f.service.store.file, 'utf8')).slots.repo;
  expect(after.scan).toEqual(before.scan);
  expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
  expect(after.baselineAt).toBe(before.baselineAt);
  expect(after.ciCreatedSince).toBe(before.ciCreatedSince);
  expect(after.pending).toBeUndefined();
  expect(after.posts).toEqual(before.posts);
  expect(f.messages).toHaveLength(0);
  expect((await readdir(f.dir)).some((name) => name.endsWith('.tmp'))).toBe(false);

  vi.restoreAllMocks();
  const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
  await reopened.init();
  f.advance();
  await reopened.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]!.text).toContain('/issues/1');
  expect(f.messages[0]!.text).toContain('/actions/runs/1');
  f.advance();
  await reopened.tick();
  expect(f.messages).toHaveLength(1);
});

it('classifies an actual abort of its own remaining-deadline signal as SCAN_TIMEOUT', async () => {
  const f = await fixture();
  await f.configure();
  let elapsed = 0,
    calls = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  f.setFetch(async (_url, _headers, signal) => {
    if (++calls === 1) {
      elapsed = 59999;
      return reply({ full_name: 'owner/repo', private: false });
    }
    return new Promise<Reply>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await f.service.tick();
  expect(calls).toBe(2);
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([60000, 1]);
  expect(timeout.mock.results[1]!.value.aborted).toBe(true);
  expect(f.service.status().watches[0]!.status.lastError).toBe('SCAN_TIMEOUT');
  expect(f.service.status().watches[0]!.status.lastSuccessAt).toBeNull();
  expect(f.messages).toHaveLength(0);
});

it('holds progress when final credential revalidation consumes the remaining scan budget', async () => {
  const f = await fixture();
  const token = await f.vault.create(
    undefined,
    { name: 'read', token: 'fixture-secret', repositories: ['owner/repo'] },
    () => {}
  );
  await f.configure([{ ...f.cfg, credentialId: token.id }]);
  await f.service.tick();
  const before = f.service.store.snapshot().slots.repo!;
  f.advance();
  let elapsed = 0,
    fetchedLastPage = false;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const metadata = f.vault.metadata.bind(f.vault);
  f.vault.metadata = async (owner) => {
    const result = await metadata(owner);
    if (fetchedLastPage) elapsed = 60001;
    return result;
  };
  f.setFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/issues')) return reply([f.issue()]);
    if (path.endsWith('/actions/runs')) {
      fetchedLastPage = true;
      return reply({ total_count: 1, workflow_runs: [f.run()] });
    }
    return reply({ full_name: 'owner/repo', private: false });
  });
  await f.service.tick();
  const after = f.service.store.snapshot().slots.repo!;
  expect(after.lastError).toBe('SCAN_TIMEOUT');
  expect(after.scan).toEqual(before.scan);
  expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
  expect(after.pending).toBeUndefined();
  expect(after.posts).toEqual(before.posts);
  expect(f.messages).toHaveLength(0);
});

it('keeps unrelated fetch failures generic even when their error name claims a timeout', async () => {
  const f = await fixture();
  await f.configure();
  f.setFetch(async (_url, _headers, signal) => {
    expect(signal.aborted).toBe(false);
    throw new DOMException('Unrelated transport failure', 'TimeoutError');
  });
  await f.service.tick();
  expect(f.service.status().watches[0]!.status.lastError).toBe('GITHUB_UNAVAILABLE');
  expect(f.service.status().watches[0]!.status.lastSuccessAt).toBeNull();
  expect(f.messages).toHaveLength(0);
});

it.each(['configuration', 'credential'] as const)(
  'rechecks %s authority after a page takes 40 seconds',
  async (change) => {
    const f = await fixture();
    const token = await f.vault.create(
      undefined,
      { name: 'read', token: 'fixture-secret', repositories: ['owner/repo'] },
      () => {}
    );
    const cfg = { ...f.cfg, visibility: 'private' as const, credentialId: token.id };
    await f.configure([cfg]);
    const before = f.service.store.snapshot().slots.repo!.scan;
    const bytes = Buffer.from('fixture-secret');
    f.vault.material = async () => bytes;
    let elapsed = 0,
      calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    f.setFetch(async (_url, headers) => {
      calls++;
      expect(headers.Authorization).toBe('Bearer fixture-secret');
      elapsed = 40000;
      if (change === 'configuration') await f.configure([{ ...cfg, enabled: false }]);
      else await f.vault.update(undefined, token.id, { repositories: [] }, () => {});
      return reply({ full_name: 'owner/repo', private: true });
    });
    await f.service.tick();
    const slot = f.service.store.snapshot().slots.repo!;
    expect(calls).toBe(1);
    expect(slot.scan).toEqual(before);
    expect(slot.lastSuccessAt).toBeUndefined();
    expect(slot.lastError).toBe(change === 'credential' ? 'CREDENTIAL_REPOSITORY_REQUIRED' : undefined);
    expect(bytes.every((n) => n === 0)).toBe(true);
    expect(f.messages).toHaveLength(0);
  }
);

it('durably drains >30 changes without advancing seen or success before the final chunk', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  const baseline = f.service.store.snapshot().slots.repo!;
  f.advance();
  const scannedAt = f.now();
  f.setRuns(Array.from({ length: 70 }, (_, i) => f.run(i + 1)));
  await f.service.tick();
  let slot = f.service.store.snapshot().slots.repo!;
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]!.text.match(/https:\/\//g)).toHaveLength(30);
  expect(slot.scan).toEqual(baseline.scan);
  expect(slot.lastSuccessAt).toBe(baseline.lastSuccessAt);
  expect(f.service.status().watches[0]!.status.pendingCount).toBe(2);
  const requests = f.requests();
  const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
  await reopened.init();
  await reopened.tick();
  expect(reopened.store.snapshot().slots.repo!.scan).toEqual(baseline.scan);
  await reopened.tick();
  slot = reopened.store.snapshot().slots.repo!;
  expect(f.requests()).toBe(requests);
  expect(slot.pending).toBeUndefined();
  expect(Object.keys(slot.scan.ciSeen)).toHaveLength(70);
  expect(slot.lastSuccessAt).toBe(scannedAt);
  expect(f.messages).toHaveLength(3);
  expect(new Set(f.messages.flatMap((m) => m.text.match(/actions\/runs\/\d+/g) ?? []))).toHaveLength(70);
});

it('chunks long notices below5000 characters and respects bot backpressure without renewing scan time', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  f.advance();
  f.bot.maxPerHour = 1;
  const scannedAt = f.now();
  f.setRuns(Array.from({ length: 30 }, (_, i) => ({ ...f.run(i + 1), name: 'Long build '.repeat(20) })));
  await f.service.tick();
  const pending = f.service.store.snapshot().slots.repo!.pending!;
  expect(pending).toBeDefined();
  expect(f.messages[0]!.text.length).toBeLessThanOrEqual(5000);
  const requests = f.requests();
  await f.service.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.service.store.snapshot().slots.repo!.pending).toEqual(pending);
  f.advance(3600001);
  await f.service.tick();
  expect(f.requests()).toBe(requests);
  expect(f.messages).toHaveLength(2);
  expect(f.messages.every((m) => m.text.length <= 5000)).toBe(true);
  expect(f.service.store.snapshot().slots.repo!.lastSuccessAt).toBe(scannedAt);
});

it('keeps frozen earlier revisions while later repository revisions wait for the next scan', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  f.advance();
  f.setRuns(Array.from({ length: 35 }, (_, i) => f.run(i + 1)));
  await f.service.tick();
  f.setRuns(Array.from({ length: 35 }, (_, i) => f.run(i + 1, 2)));
  await f.service.tick();
  expect(f.messages[1]!.text).toContain('attempt 1');
  expect(f.messages[1]!.text).not.toContain('attempt 2');
  f.advance();
  await f.service.tick();
  await f.service.tick();
  expect(f.messages).toHaveLength(4);
  for (const attempt of [1, 2]) {
    const matching = f.messages.filter((m) => m.text.includes('attempt ' + attempt));
    expect(matching.flatMap((m) => m.text.match(/actions\/runs\/\d+/g) ?? [])).toHaveLength(35);
  }
  expect(Object.values(f.service.store.snapshot().slots.repo!.scan.ciSeen).every((s) => s.attempt === 2)).toBe(true);
});

it.each([false, true])(
  'holds an ambiguous chunk and all successors across restart (actual post=%s)',
  async (actualPost) => {
    const f = await fixture();
    await f.configure();
    await f.service.tick();
    const baseline = f.service.store.snapshot().slots.repo!;
    f.advance();
    f.setRuns(Array.from({ length: 35 }, (_, i) => f.run(i + 1)));
    const post = f.deps.post;
    f.deps.post = (...args) => {
      if (actualPost) post(...args);
      throw Error('Interrupted acknowledgement');
    };
    await f.service.tick();
    expect(f.service.store.snapshot().slots.repo!.pending!.phase).toBe('unknown');
    f.deps.post = post;
    const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
    await reopened.init();
    await reopened.tick();
    expect(reopened.store.snapshot().slots.repo!.scan).toEqual(baseline.scan);
    expect(reopened.store.snapshot().slots.repo!.lastSuccessAt).toBe(baseline.lastSuccessAt);
    if (!actualPost) {
      await reopened.tick();
      expect(f.messages).toHaveLength(0);
      expect(reopened.status().watches[0]!.status.pendingCount).toBe(2);
      expect(reopened.status().watches[0]!.status.state).toBe('hold');
    } else {
      expect(f.messages).toHaveLength(1); // Exact existing message confirms, never resends, the interrupted chunk.
      await reopened.tick();
      expect(f.messages).toHaveLength(2);
      expect(reopened.store.snapshot().slots.repo!.pending).toBeUndefined();
      expect(Object.keys(reopened.store.snapshot().slots.repo!.scan.ciSeen)).toHaveLength(35);
    }
  }
);

it('refuses an entire spool over the aggregate4MiB limit without seen, success or delivery progress', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  await f.service.store.update((s) => {
    const padding = structuredClone(s.slots.repo!);
    padding.config.id = 'padding';
    padding.config.enabled = false;
    padding.scan.pageCache = { fixture: { etag: 'padding', next: false, body: '' } };
    s.slots.padding = padding;
    padding.scan.pageCache.fixture!.body = 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(s)) - 4000);
  });
  const baseline = f.service.store.snapshot().slots.repo!;
  f.advance();
  f.setRuns(Array.from({ length: 35 }, (_, i) => f.run(i + 1)));
  await f.service.tick();
  const after = f.service.store.snapshot().slots.repo!;
  expect(after.lastError).toBe('SPOOL_CAPACITY');
  expect(after.scan).toEqual(baseline.scan);
  expect(after.lastSuccessAt).toBe(baseline.lastSuccessAt);
  expect(after.pending).toBeUndefined();
  expect(f.messages).toHaveLength(0);
  await f.service.store.update((s) => {
    delete s.slots.padding;
  });
  f.advance(3600001);
  await f.service.tick();
  await f.service.tick();
  expect(f.messages).toHaveLength(2);
  expect(Object.keys(f.service.store.snapshot().slots.repo!.scan.ciSeen)).toHaveLength(35);
});

it.each(['reserved', 'delivered'] as const)(
  'recovers a crash at the durable %s boundary without replaying a chunk',
  async (phase) => {
    const f = await fixture();
    await f.configure();
    await f.service.tick();
    f.advance();
    f.bot.maxPerHour = 0;
    f.setRuns(Array.from({ length: 35 }, (_, i) => f.run(i + 1)));
    await f.service.tick();
    const p = f.service.store.snapshot().slots.repo!.pending!;
    const message = phase === 'delivered' ? f.deps.post(f.bot, f.cfg.roomId, p.text) : undefined;
    await f.service.store.update((s) => {
      s.slots.repo!.pending!.phase = phase;
      if (message) s.slots.repo!.pending!.messageId = message.id;
    });
    f.bot.maxPerHour = 30;
    const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
    await reopened.init();
    await reopened.tick();
    if (phase === 'reserved') {
      expect(f.messages).toHaveLength(0);
      expect(reopened.status().watches[0]!.status.state).toBe('hold');
      expect(reopened.status().watches[0]!.status.pendingCount).toBe(2);
    } else {
      expect(f.messages).toHaveLength(1);
      await reopened.tick();
      expect(f.messages).toHaveLength(2);
      expect(reopened.store.snapshot().slots.repo!.pending).toBeUndefined();
    }
  }
);

it('checks credential revocation before delivering each queued chunk', async () => {
  const f = await fixture();
  const token = await f.vault.create(
    undefined,
    { name: 'read', token: 'owned-fixture-only', repositories: ['owner/repo'] },
    () => {}
  );
  let rows: unknown[] = [];
  f.setFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/issues')) return reply([]);
    if (path.includes('/actions/runs')) return reply({ total_count: rows.length, workflow_runs: rows });
    return reply({ full_name: 'owner/repo', private: true });
  });
  await f.configure([{ ...f.cfg, visibility: 'private', credentialId: token.id }]);
  await f.service.tick();
  const baseline = f.service.store.snapshot().slots.repo!;
  f.advance();
  rows = Array.from({ length: 35 }, (_, i) => f.run(i + 1));
  await f.service.tick();
  await f.vault.remove(undefined, token.id, () => {});
  await f.service.tick();
  const after = f.service.store.snapshot().slots.repo!;
  expect(f.messages).toHaveLength(1);
  expect(after.pending).toBeDefined();
  expect(after.scan).toEqual(baseline.scan);
  expect(after.lastSuccessAt).toBe(baseline.lastSuccessAt);
  expect(after.lastError).toBe('CREDENTIAL_REPOSITORY_REQUIRED');
});

it.each(['membership', 'configuration'] as const)('refuses queued delivery after %s changes', async (change) => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  f.advance();
  f.setRuns(Array.from({ length: 35 }, (_, i) => f.run(i + 1)));
  await f.service.tick();
  const before = f.service.store.snapshot().slots.repo!;
  if (change === 'membership') f.bot.rooms = [];
  else
    await f.service.store.update((s) => {
      s.slots.repo!.config.roomId = 'second';
    });
  await f.service.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.service.store.snapshot().slots.repo!.pending).toEqual(before.pending);
  expect(f.service.store.snapshot().slots.repo!.scan).toEqual(before.scan);
});

it('reads pre-spool pending records and confirms them without inventing a new success timestamp', async () => {
  const f = await fixture();
  await f.configure();
  await f.service.tick();
  const baseline = f.service.store.snapshot().slots.repo!;
  f.advance();
  f.bot.maxPerHour = 0;
  f.setIssues([f.issue()]);
  await f.service.tick();
  await f.service.store.update((s) => {
    const p = s.slots.repo!.pending!;
    delete p.remaining;
    delete p.configDigest;
    delete p.credentialDigest;
    delete p.scannedAt;
    delete p.createdSince;
  });
  f.bot.maxPerHour = 30;
  const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
  await reopened.init();
  await reopened.tick();
  expect(f.messages).toHaveLength(1);
  expect(reopened.store.snapshot().slots.repo!.pending).toBeUndefined();
  expect(reopened.store.snapshot().slots.repo!.lastSuccessAt).toBe(baseline.lastSuccessAt);
});

async function queuedArchiveFixture(count = 3000) {
  const f = await fixture();
  f.cfg.events = { issues: false, pullRequests: false, workflowFailures: true };
  await f.configure();
  await f.service.tick();
  f.advance();
  f.bot.maxPerHour = 0;
  const rows = Array.from({ length: count }, (_, i) => ({
    ...f.run(i + 1),
    name: '🧭'.repeat(60),
    created_at: stamp(f.now() - 31 * 86400000 + Math.floor(((i + 1) * 30 * 86400000) / (count + 1))),
  }));
  f.setFetch(async (url) => {
    const u = new URL(url);
    if (!u.pathname.endsWith('/actions/runs')) return reply({ full_name: 'owner/repo', private: false });
    const [start, end] = u.searchParams.get('created')!.split('..').map(Date.parse);
    const selected = rows.filter((row) => Date.parse(row.created_at) >= start! && Date.parse(row.created_at) <= end!);
    const page = Number(u.searchParams.get('page') ?? 1);
    return reply(
      { total_count: selected.length, workflow_runs: selected.slice((page - 1) * 100, page * 100) },
      { etag: 'owned-' + u.search, ...(page * 100 < selected.length ? { link: '<fixed>; rel="next"' } : {}) }
    );
  });
  await f.service.tick();
  expect(f.service.store.snapshot().slots.repo!.pending).toBeDefined();
  return f;
}
const cancellation = (slot: ReturnType<GithubRepositoryWatches['store']['snapshot']>['slots'][string]) => ({
  kind: 'github-watch-prepared-cancelled',
  id: slot.config.id,
  generation: slot.generation,
  pending: slot.pending,
});
interface CancellationFrame {
  kind: string;
  version: number;
  id: string;
  generation: number;
  recordSHA256: string;
  recordBytes: number;
  partIndex: number;
  partCount: number;
  payload: string;
}
async function storedCancellationFrames(file: string): Promise<CancellationFrame[]> {
  const lines = (await readFile(file + '.history.jsonl', 'utf8')).trimEnd().split('\n');
  for (const line of lines) expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(2 * 1024 * 1024);
  return lines
    .map((line) => JSON.parse(line).record)
    .filter((r) => r.kind === 'github-watch-prepared-cancelled-fragment');
}
function reconstructCancellation(frames: CancellationFrame[]) {
  if (!frames.length || frames.length !== frames[0]!.partCount) throw Error('Incomplete cancellation frames');
  const first = frames[0]!;
  const parts = frames.map((frame, index) => {
    if (
      frame.version !== 1 ||
      frame.partIndex !== index ||
      frame.partCount !== frames.length ||
      frame.recordSHA256 !== first.recordSHA256 ||
      frame.recordBytes !== first.recordBytes ||
      frame.id !== first.id ||
      frame.generation !== first.generation
    )
      throw Error('Cancellation frame sequence differs');
    const part = Buffer.from(frame.payload, 'base64');
    if (part.toString('base64') !== frame.payload || part.length > 256 * 1024)
      throw Error('Cancellation frame payload differs');
    return part;
  });
  const bytes = Buffer.concat(parts);
  if (bytes.length !== first.recordBytes || createHash('sha256').update(bytes).digest('hex') !== first.recordSHA256)
    throw Error('Cancellation record bytes differ');
  return bytes;
}
it('archives an oversized prepared spool losslessly before owner disable', async () => {
  const f = await queuedArchiveFixture();
  const original = cancellation(f.service.store.snapshot().slots.repo!);
  const expected = Buffer.from(JSON.stringify(original));
  expect(expected.length).toBeGreaterThan(2 * 1024 * 1024);
  await f.configure([{ ...f.cfg, enabled: false }]);
  const frames = await storedCancellationFrames(f.service.store.file);
  expect(reconstructCancellation(frames)).toEqual(expected);
  expect(JSON.parse(reconstructCancellation(frames).toString('utf8'))).toEqual(original);
  expect(f.service.store.snapshot().slots.repo!.config.enabled).toBe(false);
  expect(f.service.store.snapshot().slots.repo!.pending).toBeUndefined();
  expect(f.messages).toHaveLength(0);
  expect(() => reconstructCancellation(frames.slice(1))).toThrow('Incomplete');
  expect(() => reconstructCancellation([...frames].reverse())).toThrow('sequence');
  expect(() =>
    reconstructCancellation(frames.map((p, i) => (i ? p : { ...p, payload: Buffer.from('wrong').toString('base64') })))
  ).toThrow('bytes differ');
});

it('archives several unchanged small cancellation records separately when their sum exceeds2MiB', async () => {
  const f = await queuedArchiveFixture(1500);
  await f.service.store.update((s) => {
    const second = structuredClone(s.slots.repo!);
    second.config.id = 'second';
    second.config.repo = 'other';
    s.slots.second = second;
  });
  const slots = f.service.store.snapshot().slots;
  const originals = [cancellation(slots.repo!), cancellation(slots.second!)];
  const sizes = originals.map((r) => Buffer.byteLength(JSON.stringify({ version: 1, record: r }) + '\n'));
  expect(sizes.every((n) => n <= 2 * 1024 * 1024)).toBe(true);
  expect(sizes.reduce((a, b) => a + b)).toBeGreaterThan(2 * 1024 * 1024);
  await f.configure([
    { ...f.cfg, enabled: false },
    { ...slots.second!.config, enabled: false },
  ]);
  const records = (await readFile(f.service.store.file + '.history.jsonl', 'utf8'))
    .trimEnd()
    .split('\n')
    .map((s) => JSON.parse(s).record);
  expect(records.filter((r) => r.kind === 'github-watch-prepared-cancelled')).toEqual(originals);
  expect(records.some((r) => r.kind === 'github-watch-prepared-cancelled-fragment')).toBe(false);
});

it.each([false, true])(
  'preserves the original live spool when a fragment append fails (tornLine=%s)',
  async (tornLine) => {
    const f = await queuedArchiveFixture();
    const original = await readFile(f.service.store.file);
    const pending = f.service.store.snapshot().slots.repo!.pending;
    const history = f.service.store.file + '.history.jsonl',
      open = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, 'open').mockImplementation((async (path: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => ReturnType<typeof fs.open>)(path, ...args);
      if (String(path) !== history) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'writeFile')
            return async (data: unknown) => {
              const text = String(data),
                record = JSON.parse(text).record;
              if (record.kind === 'github-watch-prepared-cancelled-fragment' && record.partIndex === 1) {
                injected = true;
                await target.writeFile(tornLine ? text.slice(0, 17) : text);
                throw Error('Owned append interruption');
              }
              return target.writeFile(text);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fs.open);
    await expect(f.configure([{ ...f.cfg, enabled: false }])).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await readFile(f.service.store.file)).toEqual(original);
    expect(() => f.service.store.snapshot()).toThrow('unavailable');
    vi.restoreAllMocks();
    const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
    if (tornLine) await expect(reopened.init()).rejects.toThrow('history');
    else {
      await reopened.init(); // Existing init validates framing, not semantic completeness of fragment groups.
      expect(reopened.store.snapshot().slots.repo!.config.enabled).toBe(true);
      expect(reopened.store.snapshot().slots.repo!.pending).toEqual(pending);
      const frames = await storedCancellationFrames(f.service.store.file);
      expect(() => reconstructCancellation(frames)).toThrow('Incomplete');
    }
    expect(f.messages).toHaveLength(0);
  }
);

it('requires all archived frames and current authority before cancellation commit', async () => {
  const f = await queuedArchiveFixture();
  const original = await readFile(f.service.store.file);
  const expected = Buffer.from(JSON.stringify(cancellation(f.service.store.snapshot().slots.repo!)));
  const archive = f.service.store.archive.bind(f.service.store);
  let allArchived = false;
  vi.spyOn(f.service.store, 'archive').mockImplementation(async (records) => {
    await archive(records);
    const last = records.at(-1) as CancellationFrame;
    if (last.kind === 'github-watch-prepared-cancelled-fragment' && last.partIndex === last.partCount - 1)
      allArchived = true;
  });
  await expect(
    f.service.configure(
      { version: 1, expectedRevision: f.service.status().revision, watches: [{ ...f.cfg, enabled: false }] },
      () => {
        if (allArchived) throw Error('Owner revoked before cancellation commit');
      }
    )
  ).rejects.toThrow('Owner revoked');
  expect(allArchived).toBe(true);
  expect(await readFile(f.service.store.file)).toEqual(original);
  expect(reconstructCancellation(await storedCancellationFrames(f.service.store.file))).toEqual(expected);
  const reopened = new GithubRepositoryWatches(f.service.store.file, f.deps);
  await reopened.init();
  expect(reopened.store.snapshot().slots.repo!.config.enabled).toBe(true);
  expect(f.messages).toHaveLength(0);
});
