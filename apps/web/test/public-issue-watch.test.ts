import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PublicIssueWatch, type PublicIssueWatchDeps } from '../src/cron/public-issue-watch.js';
import type { ChatRoom, ChatMessage } from '../src/chatroom-store.js';
describe('anonymous public ISSUE watcher real durable cursor', () => {
  let root: string,
    at: number,
    w: PublicIssueWatch,
    room: ChatRoom,
    calls: { url: string; headers: Record<string, string> }[],
    reply: { status: number; headers: Record<string, string>; body: unknown },
    repoPrivate: boolean,
    posts: ChatMessage[],
    lost: boolean;
  let pages: Record<string, { status: number; headers: Record<string, string>; body: unknown }>;
  const cfg = {
    version: 1,
    type: 'public-github-issues',
    enabled: true,
    botId: 'issues',
    roomId: 'r',
    owner: 'Public',
    repo: 'Repo',
    intervalMinutes: 10,
  };
  const issue = (number = 1, state = 'open', stamp = '2026-10-26T11:00:00Z') => ({
    number,
    title: 'Untrusted @ALL <b> `title`',
    state,
    created_at: '2026-10-26T10:00:00Z',
    updated_at: stamp,
  });
  const create = () =>
    new PublicIssueWatch(path.join(root, 'watch.json'), {
      bot: () => ({ id: 'issues', name: 'Issues', rooms: ['r'], maxPerHour: 30 }),
      room: () => room,
      now: () => at,
      post: (b, r, text) => {
        const m = {
          id: 'm' + posts.length,
          at,
          from: { kind: 'bot', botId: b.id, name: b.name },
          text,
          to: 'all',
        } as ChatMessage;
        posts.push(m);
        room.messages.push(m);
        if (lost) throw Error('ack lost');
        return m;
      },
      fetch: async (url, headers) => {
        calls.push({ url, headers });
        const selected = pages[new URL(url).searchParams.get('page') ?? '1'] ?? reply;
        return {
          status: url.includes('/issues?') ? selected.status : 200,
          headers: { get: (k: string) => selected.headers[k] ?? null },
          body: url.includes('/issues?') ? selected.body : { full_name: 'Public/Repo', private: repoPrivate },
        };
      },
    } satisfies PublicIssueWatchDeps);
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'public-watch-'));
    at = Date.parse('2026-10-26T12:00:00Z');
    calls = [];
    pages = {};
    posts = [];
    lost = false;
    repoPrivate = false;
    room = { id: 'r', name: 'Room', members: [], messages: [] } as unknown as ChatRoom;
    reply = { status: 200, headers: { etag: '"v1"' }, body: [issue()] };
    w = create();
    await w.init();
    await w.configure(cfg);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it('posts public issues only; excludes PR rows, strips mentions and markup', async () => {
    reply.body = [issue(), { ...issue(2), pull_request: {} }];
    await w.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain('Issue #1 new');
    expect(posts[0]!.text).not.toContain('#2');
    expect(posts[0]!.text).not.toContain('@ALL');
    expect(calls.every((c) => !Object.keys(c.headers).some((k) => /authorization|cookie/i.test(k)))).toBe(true);
  });
  it('quiet304 uses ETag and survives restart without repeat', async () => {
    await w.tick();
    w = create();
    await w.init();
    at += 600001;
    reply.status = 304;
    reply.body = null;
    await w.tick();
    expect(posts).toHaveLength(1);
    expect(calls.at(-1)!.headers['If-None-Match']).toBe('"v1"');
    expect(w.status().lastSuccessAt).toBe(at);
  });
  it('reports closed then reopened transitions with durable per-issue dedup', async () => {
    await w.tick();
    at += 600001;
    reply.body = [issue(1, 'closed', '2026-10-26T11:10:00Z')];
    await w.tick();
    at += 600001;
    reply.body = [issue(1, 'open', '2026-10-26T11:20:00Z')];
    await w.tick();
    expect(posts).toHaveLength(3);
    expect(posts[1]!.text).toContain('closed');
    expect(posts[2]!.text).toContain('reopened');
    at += 600001;
    await w.tick();
    expect(posts).toHaveLength(3);
  });
  it('does not accept private repository visibility', async () => {
    repoPrivate = true;
    await w.tick();
    expect(calls).toHaveLength(1);
    expect(w.status().cursor).toBeUndefined();
    expect(posts[0]!.text).toContain('monitoring incomplete');
  });
  it('incomplete paginated response holds cursor with visible bounded failure', async () => {
    reply.headers.link = '<next>; rel="next"';
    await w.tick();
    expect(w.status().cursor).toBeUndefined();
    expect(posts).toHaveLength(1);
    at += 600001;
    await w.tick();
    expect(posts).toHaveLength(1);
  });
  it('rate-limited poll backs off and never asserts nothing new', async () => {
    reply.status = 429;
    reply.headers['retry-after'] = '3600';
    await w.tick();
    expect(w.status().nextPollAt).toBeGreaterThanOrEqual(at + 3600000);
    expect(w.status().failures).toBe(1);
    const count = calls.length;
    at += 600001;
    await w.tick();
    expect(calls).toHaveLength(count);
    expect(posts[0]!.text).toContain('no all-clear');
  });
  it('lost post acknowledgement recovers exact local message without repeating', async () => {
    lost = true;
    await w.tick();
    expect(w.status().pending?.phase).toBe('unknown');
    w = create();
    await w.init();
    lost = false;
    await w.tick();
    expect(posts).toHaveLength(1);
    expect(w.status().pending).toBeUndefined();
    expect(w.status().cursor).toBe('2026-10-26T11:00:00Z');
  });
  it('unresolved reserved attempt never reposts or skips cursor after restart', async () => {
    await w.store.update((s) => {
      s.pending = { id: '1'.repeat(32), text: 'missing exact post', events: [], reservedAt: at, phase: 'reserved' };
    });
    await w.tick();
    await w.tick();
    expect(posts).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(w.status().pending?.phase).toBe('unknown');
  });
  it('configuration cannot silently reuse another repository cursor', async () => {
    await expect(w.configure({ ...cfg, repo: 'Other' })).rejects.toThrow('target change');
    expect(w.status().config?.repo).toBe('Repo');
  });
  it('rejects URL/shell inputs and missing bot room authority', async () => {
    await expect(w.configure({ ...cfg, owner: 'https://evil' })).rejects.toThrow();
    await expect(w.configure({ ...cfg, roomId: 'other' })).rejects.toThrow();
  });
  it('never follows malformed or future issue metadata', async () => {
    reply.body = [issue(1, 'open', '2099-10-26T11:00:00Z')];
    await w.tick();
    expect(w.status().cursor).toBeUndefined();
    expect(posts[0]!.text).toContain('monitoring incomplete');
  });
  it('scans PR-only first page to actual issues on page2 without following Link hosts', async () => {
    reply.body = Array.from({ length: 30 }, (_, i) => ({ ...issue(i + 100), pull_request: {} }));
    reply.headers.link = '<https://evil.invalid/not-followed>; rel="next"';
    pages['2'] = { status: 200, headers: {}, body: [issue(1, 'open', '2026-10-26T10:30:00Z')] };
    await w.tick();
    expect(w.status().failures).toBe(0);
    expect(w.status().cursor).toBe('2026-10-26T11:00:00Z');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain('Issue #1');
    expect(calls.some((c) => c.url.includes('&page=2'))).toBe(true);
    expect(calls.every((c) => new URL(c.url).hostname === 'api.github.com')).toBe(true);
  });
  it('holds oversized issue-change batch rather than truncating30+', async () => {
    reply.body = Array.from({ length: 30 }, (_, i) => issue(i + 1));
    reply.headers.link = '<next>; rel="next"';
    pages['2'] = { status: 200, headers: {}, body: [issue(31)] };
    await w.tick();
    expect(w.status().cursor).toBeUndefined();
    expect(w.status().failures).toBe(1);
    expect(posts[0]!.text).toContain('monitoring incomplete');
  });
  it('finite10page boundary retains cursor instead of following an unbounded feed', async () => {
    reply.body = Array.from({ length: 30 }, (_, i) => ({ ...issue(i + 100), pull_request: {} }));
    reply.headers.link = '<next>; rel="next"';
    await w.tick();
    expect(calls.filter((c) => c.url.includes('/issues?'))).toHaveLength(10);
    expect(w.status().cursor).toBeUndefined();
    expect(w.status().failures).toBe(1);
  });
  it('corrupt durable cursor does not silently start a new baseline', async () => {
    await fs.writeFile(path.join(root, 'watch.json'), '{', { mode: 0o600 });
    w = create();
    await expect(w.init()).rejects.toThrow('unavailable');
    expect(calls).toHaveLength(0);
  });
});
