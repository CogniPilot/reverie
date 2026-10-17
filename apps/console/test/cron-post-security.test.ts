/**
 * Routine bot authorization: a bot posts only in its allowlisted rooms (checked by the real chat service),
 * and only the owner (no agent header) creates, edits, deletes, enables or runs a post job or changes a bot.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatBotRegistry, type ChatBot } from '../src/chat-bots.js';
import { CronService, type BotPoster, type CronDeps } from '../src/cron/cron-service.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { registerChatBotRoutes } from '../src/web/routes/chat-bot-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'postsec-'));
const bot: ChatBot = { id: 'routines', name: 'Routines', rooms: [], maxPerHour: 5 };

describe('bot allowlist, real chat service', () => {
  const services: ChatroomService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.stop();
  });
  const make = async () => {
    const s = new ChatroomService({ file: join(tmp(), 'chatrooms.json'), getSession: () => undefined as never, broadcast: () => {} });
    await s.init();
    services.push(s);
    return s;
  };

  it('refuses a room that is not on the allowlist and posts nothing', async () => {
    const chat = await make();
    const allowed = chat.createRoom('allowed', undefined);
    const other = chat.createRoom('other', undefined);
    const b: ChatBot = { ...bot, rooms: [allowed.id] };
    expect(() => chat.postAsBot(b, other.id, 'hello', 0)).toThrow(/may not post in that room/);
    expect(chat.room(other.id)?.messages).toHaveLength(0);
    // The allowlisted room still works, so the refusal above is the allowlist and nothing else.
    expect(chat.postAsBot(b, allowed.id, 'hello', 0).from).toMatchObject({ kind: 'bot', botId: 'routines' });
    expect(chat.room(allowed.id)?.messages).toHaveLength(1);
  });

  it('refuses a bot with an empty allowlist everywhere', async () => {
    const chat = await make();
    const r = chat.createRoom('any', undefined);
    expect(() => chat.postAsBot(bot, r.id, 'hello', 0)).toThrow();
    expect(chat.room(r.id)?.messages).toHaveLength(0);
  });

  it('refuses at the hourly cap', async () => {
    const chat = await make();
    const r = chat.createRoom('capped', undefined);
    const b: ChatBot = { ...bot, rooms: [r.id], maxPerHour: 2 };
    expect(() => chat.postAsBot(b, r.id, 'hello', 2)).toThrow(/limit/);
    expect(chat.room(r.id)?.messages).toHaveLength(0);
  });
});

describe('post jobs and bots are owner-only', () => {
  const jobs: Record<string, CronJob> = {};
  const runs: Record<string, CronJobRun> = {};
  const store = {
    getCronJobs: () => jobs, getCronJob: (id: string) => jobs[id] ?? null,
    setCronJob: (id: string, j: CronJob) => { jobs[id] = j; }, removeCronJob: (id: string) => { delete jobs[id]; },
    getCronJobRuns: () => runs, setCronJobRun: (id: string, r: CronJobRun) => { runs[id] = r; },
    removeCronJobRun: (id: string) => { delete runs[id]; },
  };
  const posted: string[] = [];

  async function setup() {
    for (const k of Object.keys(jobs)) delete jobs[k];
    posted.length = 0;
    const cron = new CronService({ store, broadcast: vi.fn(), sessions: new Map() } as unknown as CronDeps);
    const poster: BotPoster = {
      getBot: () => ({ ...bot, rooms: ['room-1'] }),
      check: () => {},
      post: (_b, _r, text) => { posted.push(text); },
    };
    cron.setBotPoster(poster);
    const registry = new ChatBotRegistry(join(tmp(), 'chat-bots.json'));
    await registry.set('routines', { name: 'Routines', rooms: ['room-1'], maxPerHour: 5 });
    const app = Fastify({ logger: false });
    registerCronRoutes(app, { cron } as never);
    registerChatBotRoutes(app, registry);
    installRouteErrorHandler(app);
    await app.ready();
    return { app, cron, registry };
  }

  const body = {
    name: 'refresh', action: 'post', botId: 'routines', roomId: 'room-1', postText: '@Alex hello',
    scheduleType: 'daily', dailyTime: '06:45', timeZone: 'America/New_York', enabled: true,
  };
  // A real session id, garbage, and the empty string (a header sent with no value); 'name;' is the shape of a stray value.
  const AGENT_HEADERS = ['2edf4125-0000-4000-8000-000000000001', 'garbage', '', 'name;'];

  it.each(AGENT_HEADERS)('refuses an agent header %j on every post-job and bot route', async (header) => {
    const { app, cron, registry } = await setup();
    const owner = cron.createJob(body as never);
    const h = { 'x-codeman-parent-session': header };
    const before = JSON.stringify(cron.getJob(owner.id));
    const botBefore = JSON.stringify(registry.list());

    const calls = [
      app.inject({ method: 'POST', url: '/api/cron/jobs', headers: h, payload: body }),
      app.inject({ method: 'PUT', url: `/api/cron/jobs/${owner.id}`, headers: h, payload: { postText: '@Alex changed' } }),
      app.inject({ method: 'PUT', url: `/api/cron/jobs/${owner.id}/enabled`, headers: h, payload: { enabled: false } }),
      app.inject({ method: 'POST', url: `/api/cron/jobs/${owner.id}/run`, headers: h }),
      app.inject({ method: 'DELETE', url: `/api/cron/jobs/${owner.id}`, headers: h }),
      app.inject({ method: 'PUT', url: '/api/chat-bots/routines', headers: h, payload: { name: 'Routines', rooms: ['room-1', 'room-2'], maxPerHour: 500 } }),
      app.inject({ method: 'DELETE', url: '/api/chat-bots/routines', headers: h }),
    ];
    for (const res of await Promise.all(calls)) {
      // The API reports a refusal in the body (success:false, errorCode), as every other route does.
      expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    }
    expect(Object.keys(jobs)).toEqual([owner.id]);
    expect(JSON.stringify(cron.getJob(owner.id))).toBe(before);
    expect(JSON.stringify(registry.list())).toBe(botBefore);
    expect(posted).toEqual([]);
    await app.close();
  });

  it('lets the owner (no header) do the same, so the refusals above are the header and nothing else', async () => {
    const { app, cron, registry } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/cron/jobs', payload: body });
    expect(created.statusCode).toBe(200);
    const id = created.json().job.id as string;
    expect((await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}`, payload: { postText: '@Alex changed' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/api/cron/jobs/${id}/enabled`, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/cron/jobs/${id}/run` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/cron/jobs/${id}` })).statusCode).toBe(200);
    expect(cron.getJob(id)).toBeFalsy();
    expect((await app.inject({ method: 'PUT', url: '/api/chat-bots/routines', payload: { name: 'Routines', rooms: ['room-1', 'room-2'], maxPerHour: 9 } })).statusCode).toBe(200);
    expect(registry.get('routines')?.rooms).toEqual(['room-1', 'room-2']);
    expect((await app.inject({ method: 'DELETE', url: '/api/chat-bots/routines' })).statusCode).toBe(200);
    await app.close();
  });
});
