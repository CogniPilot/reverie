/** Actual WebServer, owner cookie, source registration, chat SQLite; no listen/start or live fetch. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebServer } from '../src/web/server.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatDb } from '../src/chat-db.js';
import type { CronService } from '../src/cron/cron-service.js';
import type { StateStore } from '../src/state-store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';

type Internal = {
  app: FastifyInstance;
  cronService: CronService;
  chatroomService: ChatroomService;
  setupRoutes(): Promise<void>;
};
describe('actual fixed watcher server wiring', () => {
  let dir: string, server: WebServer, actual: Internal, room: string, cookie: string;
  const beforeDir = process.env.REVERIE_DATA_DIR;
  const head = 'a'.repeat(40);
  const ownerHeaders = { host: 'localhost', origin: 'http://localhost' };
  const input = () => ({
    name: 'Synthetic public watcher',
    action: 'post',
    postSource: 'github',
    postSourceArgs: { owner: 'Example', repo: 'public', pull: 7 },
    postText: '{message}',
    postChangeOnly: true,
    botId: 'watch',
    roomId: room,
    scheduleType: 'interval',
    intervalMinutes: 60,
    enabled: false,
  });
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'fixed-watch-server-'));
    process.env.REVERIE_DATA_DIR = dir;
    const owner = new OwnerAuthService({
      store: new OwnerAuthStore(join(dir, 'owner-auth.json')),
      auditFile: join(dir, 'synthetic-auth.jsonl'),
      setupEnabled: true,
    });
    await owner.setup('SYNTHETIC_OWNER', 'synthetic-watch-Circuit!93', 'synthetic-watch-Circuit!93', '127.0.0.1');
    server = new WebServer(0, false, true, '127.0.0.1');
    actual = server as unknown as Internal;
    await actual.setupRoutes();
    await actual.app.ready();
    const login = await actual.app.inject({
      method: 'POST',
      url: '/api/owner/login',
      headers: ownerHeaders,
      payload: { username: 'SYNTHETIC_OWNER', password: 'synthetic-watch-Circuit!93' },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = login.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
    room = actual.chatroomService.createRoom('Synthetic watch notices', undefined).id;
    const bot = await actual.app.inject({
      method: 'PUT',
      url: '/api/chat-bots/watch',
      headers: ownerHeaders,
      cookies: { [OWNER_COOKIE]: cookie },
      payload: { name: 'Synthetic Watch', rooms: [room], maxPerHour: 30 },
    });
    expect(bot.statusCode, bot.body).toBe(200);
    expect(actual.app.server.listening).toBe(false);
  }, 30000);
  beforeEach(() => {
    vi.restoreAllMocks();
    const store = (actual.cronService as unknown as { store: StateStore }).store;
    // Owned synthetic fixture reset, not a production uncertainty escape path.
    for (const job of actual.cronService.listJobs()) store.removeCronJob(job.id);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string) => {
        const path = new URL(raw).pathname;
        const body = path.endsWith('/reviews')
          ? []
          : path.endsWith('/check-runs')
            ? { total_count: 0, check_runs: [] }
            : path.endsWith('/runs')
              ? { total_count: 0, workflow_runs: [] }
              : {
                  number: 7,
                  base: { repo: { private: false, full_name: 'Example/public' } },
                  head: { sha: head },
                  updated_at: '2026-10-24T01:00:00Z',
                  state: 'open',
                  merged: false,
                  title: '@someone\nexternal title',
                  body: 'NEVER PERSIST BODY',
                };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await server?.stop();
    if (beforeDir === undefined) delete process.env.REVERIE_DATA_DIR;
    else process.env.REVERIE_DATA_DIR = beforeDir;
  });
  async function create() {
    const result = await actual.app.inject({
      method: 'POST',
      url: '/api/cron/jobs',
      headers: ownerHeaders,
      cookies: { [OWNER_COOKIE]: cookie },
      payload: input(),
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json().data.job.id as string;
  }
  it('owner cookie configures source; actual registered reader and poster commit a notify-only message', async () => {
    const id = await create();
    const delivery = vi.spyOn(
      (actual.chatroomService as unknown as { delivery: { deliverMessage(...args: unknown[]): void } }).delivery,
      'deliverMessage'
    );
    const run = await actual.app.inject({
      method: 'POST',
      url: `/api/cron/jobs/${id}/run`,
      headers: ownerHeaders,
      cookies: { [OWNER_COOKIE]: cookie },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(actual.cronService.getJob(id)?.lastStatus).toBe('posted');
    expect(delivery).not.toHaveBeenCalled();
    const receipt = actual.cronService.getJob(id)!.watchState!.delivery!;
    const db = ChatDb.open(join(dir, 'chat.db'));
    try {
      expect(JSON.parse(db.contents().messages.get(`${room}/${receipt.messageId}`)!).text).toContain(
        `Receipt ${receipt.receipt}`
      );
    } finally {
      db.close();
    }
    expect(actual.chatroomService.room(room)!.messages.at(-1)!.text).not.toMatch(/@|NEVER|\n/);
    expect(fetch).toHaveBeenCalledTimes(5);
    await actual.cronService.runNow(id);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(delivery).not.toHaveBeenCalled();
  });
  it('worker/service headers cannot configure or override the owner target', async () => {
    for (const headers of [
      { 'x-reverie-parent-session': 'synthetic-worker' },
      { 'x-reverie-service-token': 'synthetic-not-a-credential' },
    ]) {
      const r = await actual.app.inject({
        method: 'POST',
        url: '/api/cron/jobs',
        headers: { ...ownerHeaders, ...headers },
        payload: input(),
      });
      expect([401, 403], r.body).toContain(r.statusCode);
    }
    expect(actual.cronService.listJobs()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a real SQLite COMMIT failure returns no acknowledgement and holds cursor/pending', async () => {
    const id = await create();
    const db = (actual.chatroomService as unknown as { db: ChatDb }).db;
    const exec = db.db.exec.bind(db.db);
    let fail = true;
    const spy = vi.spyOn(db.db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && fail) {
        fail = false;
        throw new Error('synthetic disk failure');
      }
      return exec(sql);
    });
    const before = actual.chatroomService.room(room)!.messages.length;
    expect((await actual.cronService.runNow(id))?.status).toBe('failed');
    spy.mockRestore();
    expect(actual.chatroomService.room(room)!.messages).toHaveLength(before);
    expect(actual.cronService.getJob(id)?.postLastText).toBeUndefined();
    expect(actual.cronService.getJob(id)?.watchState?.pending).toBeTruthy();
  });
  it('refuses JSON fallback, unavailable DB, archived/DM and cross-owner rooms', async () => {
    const s = new ChatroomService({
      file: join(dir, 'fallback.json'),
      getSession: () => undefined,
      broadcast: () => {},
    });
    await s.init();
    const fallback = s.createRoom('fallback', undefined);
    expect(() =>
      s.postWatchNotice({ id: 'watch', name: 'Watch', rooms: [fallback.id], maxPerHour: 30 }, fallback.id, 'notice', 0)
    ).toThrow('durable chat');
    await s.stop();
    const bot = { id: 'watch', name: 'Watch', rooms: [room], maxPerHour: 30 };
    const actualRoom = actual.chatroomService.room(room)!;
    for (const mode of ['archived', 'dm', 'owner'] as const) {
      if (mode === 'archived') actualRoom.archivedAt = Date.now();
      if (mode === 'dm') actualRoom.kind = 'dm';
      if (mode === 'owner') actualRoom.owner = 'another-owner';
      expect(() => actual.chatroomService.postWatchNotice(bot, room, 'notice', 0)).toThrow();
      delete actualRoom.archivedAt;
      delete actualRoom.kind;
      delete actualRoom.owner;
    }
    const privateState = actual.chatroomService as unknown as { writesClosed: string };
    privateState.writesClosed = 'synthetic unavailable';
    expect(() => actual.chatroomService.postWatchNotice(bot, room, 'notice', 0)).toThrow('durable chat');
    privateState.writesClosed = '';
  });
  it('post-commit exception is ambiguous: SQLite keeps the notice but cursor/pending hold and no resend', async () => {
    const id = await create();
    const original = actual.chatroomService.post.bind(actual.chatroomService);
    const post = vi.spyOn(actual.chatroomService, 'post').mockImplementation((...args) => {
      original(...args);
      throw new Error('synthetic exception after durable chat commit');
    });
    expect((await actual.cronService.runNow(id))?.status).toBe('failed');
    post.mockRestore();
    const pending = actual.cronService.getJob(id)!.watchState!.pending!;
    const db = ChatDb.open(join(dir, 'chat.db'));
    try {
      expect(
        [...db.contents().messages.values()].some((raw) => JSON.parse(raw).text.endsWith(`Receipt ${pending.receipt}.`))
      ).toBe(true);
    } finally {
      db.close();
    }
    expect(actual.cronService.getJob(id)?.postLastText).toBeUndefined();
    const count = actual.chatroomService.room(room)!.messages.length;
    await actual.cronService.runNow(id);
    expect(actual.chatroomService.room(room)!.messages).toHaveLength(count);
  });
  it('actual registered reader and SQLite poster account for the 40-check baseline and mass completion', async () => {
    const base = fetch;
    expect(vi.isMockFunction(base)).toBe(true);
    let completed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (!url.includes('/check-runs?')) return base(url, init);
        return new Response(
          JSON.stringify({
            total_count: 40,
            check_runs: Array.from({ length: 40 }, (_, i) => ({
              id: i + 1,
              head_sha: head,
              name: `public check ${i + 1}`,
              status: completed ? 'completed' : 'queued',
              conclusion: completed ? 'success' : null,
            })),
          }),
          { status: 200 }
        );
      })
    );
    const id = await create();
    const count = actual.chatroomService.room(room)!.messages.length;
    expect((await actual.cronService.runNow(id))?.status).toBe('posted');
    expect(actual.cronService.getJob(id)?.watchState?.delivery?.events).toHaveLength(41);
    expect(actual.chatroomService.room(room)!.messages).toHaveLength(count + 1);
    completed = true;
    expect((await actual.cronService.runNow(id))?.status).toBe('posted');
    expect(actual.cronService.getJob(id)?.watchState?.delivery?.events).toHaveLength(40);
    expect(JSON.parse(actual.cronService.getJob(id)!.postLastText!).events).toHaveLength(81);
    expect(actual.chatroomService.room(room)!.messages).toHaveLength(count + 2);
    expect((await actual.cronService.runNow(id))?.status).toBe('skipped');
    expect(actual.chatroomService.room(room)!.messages).toHaveLength(count + 2);
  });
  it('actual owner API surfaces recovery uncertainty before query/post and cannot clear the same-ID hold', async () => {
    const id = await create();
    const store = (actual.cronService as unknown as { store: StateStore }).store;
    await store.saveNowAsync();
    const file = store.getState().config.stateFilePath;
    expect(file).toBe(join(dir, 'state.json'));
    await fs.writeFile(file + '.bak', await fs.readFile(file));
    expect(store.recoverFromBackup()).toBe(true);
    const read = await actual.app.inject({
      method: 'GET',
      url: `/api/cron/jobs/${id}`,
      headers: ownerHeaders,
      cookies: { [OWNER_COOKIE]: cookie },
    });
    expect(read.body).toContain('recoveryUncertain');
    for (const [method, suffix, payload] of [
      ['POST', '/run', undefined],
      ['PUT', '/enabled', { enabled: true }],
      ['PUT', '', { enabled: true, recoveryUncertain: false }],
      ['DELETE', '', undefined],
    ] as const) {
      const response = await actual.app.inject({
        method,
        url: `/api/cron/jobs/${id}${suffix}`,
        headers: ownerHeaders,
        cookies: { [OWNER_COOKIE]: cookie },
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).toContain('RECOVERY_UNCERTAIN');
    }
    const disabled = await actual.app.inject({
      method: 'PUT',
      url: `/api/cron/jobs/${id}/enabled`,
      headers: ownerHeaders,
      cookies: { [OWNER_COOKIE]: cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(actual.cronService.getJob(id)?.recoveryUncertain).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
