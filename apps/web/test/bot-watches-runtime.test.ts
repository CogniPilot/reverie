import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBotWatches } from '../src/bot-watches-runtime.js';
import { BoardStore } from '../src/board-store.js';
import { ChatBotRegistry } from '../src/chat-bots.js';
import type { ChatroomService } from '../src/chatroom-service.js';
describe('typed bot watch owner-only runtime integration', () => {
  let root: string, app: FastifyInstance, board: BoardStore, bots: ChatBotRegistry, multi: boolean;
  const config = {
    version: 1,
    type: 'assignment-status',
    enabled: true,
    botId: 'status',
    roomIds: ['room'],
    intervalMinutes: 60,
    responseMinutes: 15,
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-runtime-'));
    app = Fastify();
    board = new BoardStore(path.join(root, 'board.json'));
    await board.init();
    bots = new ChatBotRegistry(path.join(root, 'bots.json'));
    await bots.set('status', { name: 'Status', rooms: ['room'], maxPerHour: 30 });
    multi = false;
  });
  afterEach(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const setup = async (extra: Partial<Parameters<typeof registerBotWatches>[1]> = {}) => {
    const room = { id: 'room', name: 'Room', members: [], messages: [] };
    return registerBotWatches(app, {
      dataPath: (n) => path.join(root, n),
      bots,
      board,
      employees: () => [],
      running: () => false,
      multiUser: multi,
      verifiedOwner: (req) =>
        req.headers['x-fixture-owner'] === 'yes' && req.headers['x-reverie-parent-session'] === undefined,
      chat: {
        room: () => room,
        rooms: () => [room],
        auditEntry: async () => {},
        alertMode: () => undefined,
        adminPhoneWakeEnabled: true,
      } as unknown as ChatroomService,
      ...extra,
    });
  };
  it('unauthenticated/agent/limited requests cannot configure or inspect private task history', async () => {
    await setup();
    for (const headers of [
      {},
      { 'x-reverie-parent-session': 'employee' },
      { 'x-fixture-owner': 'yes', 'x-reverie-parent-session': 'employee' },
    ]) {
      expect((await app.inject({ method: 'GET', url: '/api/bot-watches', headers })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'PUT', url: '/api/bot-watches/assignments', headers, payload: config })).statusCode
      ).toBe(403);
    }
    await expect(fs.stat(path.join(root, 'assignment-status-watch.json'))).rejects.toThrow();
  });
  it('verified fixture owner enables a typed watch but creates no agent/session work', async () => {
    const runtime = await setup();
    const reply = await app.inject({
      method: 'PUT',
      url: '/api/bot-watches/assignments',
      headers: { 'x-fixture-owner': 'yes' },
      payload: config,
    });
    expect(reply.statusCode).toBe(200);
    await runtime.tick();
    expect(runtime.assignments.status().entries).toHaveLength(0);
    expect(
      (await app.inject({ method: 'GET', url: '/api/bot-watches', headers: { 'x-fixture-owner': 'yes' } })).json().data
        .assignments.coverage.eligible
    ).toBe(0);
  });
  it('no arbitrary command/model launch fields are accepted', async () => {
    await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/bot-watches/assignments',
      headers: { 'x-fixture-owner': 'yes' },
      payload: { ...config, launchCommand: 'not executable' },
    });
    expect(res.statusCode).toBe(400);
    expect(await fs.readdir(root)).not.toContain('assignment-status-watch.json');
  });
  it('corrupt watch state holds only that automation rather than resetting or blocking website startup', async () => {
    await fs.writeFile(path.join(root, 'assignment-status-watch.json'), '{}', { mode: 0o600 });
    const runtime = await setup();
    await runtime.tick();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/bot-watches/assignments',
      headers: { 'x-fixture-owner': 'yes' },
      payload: config,
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(await fs.readFile(path.join(root, 'assignment-status-watch.json'), 'utf8'))).toEqual({});
  });
  it('only the verified owner configures the disk-space alarm, and it posts as a notice on change', async () => {
    const room = { id: 'room', name: 'Room', members: [], messages: [] as unknown[] };
    const posts: Array<{ text: string; to: unknown; deliver: unknown }> = [];
    let used = 50, clock = Date.UTC(2026, 10, 1, 3);
    const runtime = await setup({
      now: () => clock,
      chat: {
        room: () => room,
        rooms: () => [room],
        auditEntry: async () => {},
        alertMode: () => undefined,
        adminPhoneWakeEnabled: true,
        checkBotPost: () => {},
        postDurableBotMessage: (_b: unknown, _r: unknown, text: string, _n: unknown, to: unknown, deliver: unknown) => {
          posts.push({ text, to, deliver });
          return { id: `m${posts.length}`, text };
        },
      } as unknown as ChatroomService,
      disk: {
        volumes: async () => [{ key: 'dev-1', labels: ['Workspace'], totalBytes: 1000, availableBytes: 1000 - used * 10, roots: [] }],
        consumers: async () => ({ entries: [], partial: false }),
      },
    });
    const disk = {
      version: 1, type: 'disk-space', enabled: true, botId: 'status', roomId: 'room',
      warnPercent: 90, criticalPercent: 99, rearmMarginPercent: 1, intervalMinutes: 5,
    };
    for (const headers of [{}, { 'x-reverie-parent-session': 'employee' }]) {
      expect((await app.inject({ method: 'PUT', url: '/api/bot-watches/disk-space', headers, payload: disk })).statusCode).toBe(403);
    }
    const ok = await app.inject({ method: 'PUT', url: '/api/bot-watches/disk-space', headers: { 'x-fixture-owner': 'yes' }, payload: disk });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.disk.config.type).toBe('disk-space');
    await runtime.tick();
    expect(posts).toEqual([]);
    used = 95;
    clock += 5 * 60_000;
    await runtime.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain('Disk warning: Workspace is at 95% used');
    expect(posts[0]!.to).toBe('all');
    expect(posts[0]!.deliver).toBe(false);
  });
  it('multiuser refuses activation until Board partition is defined', async () => {
    multi = true;
    const runtime = await setup();
    await runtime.tick();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/bot-watches/assignments',
          headers: { 'x-fixture-owner': 'yes' },
          payload: config,
        })
      ).statusCode
    ).toBe(403);
  });
});
