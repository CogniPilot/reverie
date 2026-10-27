import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  expect(conditionals).toBe(1);
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
