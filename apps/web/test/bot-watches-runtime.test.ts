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
  const setup = async () => {
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
