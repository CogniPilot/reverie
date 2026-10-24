/** Actual WebServer routes/auth/company/chat/cron, app.inject only. No start/listen/scheduler/provider effects. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import type { CompanyService } from '../src/company-service.js';
import type { ChatroomService } from '../src/chatroom-service.js';
import type { CronService } from '../src/cron/cron-service.js';
import type { RoutinesPolicy } from '../src/web/ports/cron-port.js';
import { EmployeeSchema } from '../src/company-types.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';

const SID = '11111111-2222-4333-8444-555555555555';
type Internal = {
  app: FastifyInstance;
  sessions: Map<string, Session>;
  companyService: CompanyService;
  chatroomService: ChatroomService;
  cronService: CronService;
  cronPort: { routines: RoutinesPolicy };
  setupRoutes(): Promise<void>;
};
describe('actual server configurable routine announcement room', () => {
  let directory: string, server: WebServer, actual: Internal, officeId: string;
  const previousDirectory = process.env.REVERIE_DATA_DIR;
  const previousAnnouncement = process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID;
  const input = () => ({
    action: 'post',
    name: 'Synthetic disabled canary',
    roomId: officeId,
    postText: 'Synthetic reminder only',
    scheduleType: 'interval',
    intervalMinutes: 5,
    enabled: false,
  });
  const create = () =>
    actual.app.inject({
      method: 'POST',
      url: '/api/cron/jobs',
      headers: { host: 'localhost', 'x-reverie-parent-session': SID },
      payload: input(),
    });
  beforeAll(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'routine-announcement-server-'));
    process.env.REVERIE_DATA_DIR = directory;
    const owner = new OwnerAuthService({
      store: new OwnerAuthStore(join(directory, 'owner-auth.json')),
      auditFile: join(directory, 'synthetic-owner-audit.jsonl'),
      setupEnabled: true,
    });
    await owner.setup(
      'SYNTHETIC_OWNER',
      'synthetic-Circuit!93-announcement',
      'synthetic-Circuit!93-announcement',
      '127.0.0.1'
    );
    await fs.writeFile(
      join(directory, 'routines-grants.json'),
      JSON.stringify({ roles: [], employees: { 'synthetic-author': true } })
    );
    server = new WebServer(0, false, true, '127.0.0.1');
    actual = server as unknown as Internal;
    await actual.setupRoutes();
    await actual.app.ready();
    actual.sessions.set(SID, new Session({ id: SID, workingDir: directory, name: 'Synthetic author' })); // unstarted, no PTY/CLI
    await actual.companyService.store.update((state) => {
      state.employees.push(
        EmployeeSchema.parse({
          id: 'synthetic-author',
          sessionId: SID,
          name: 'Synthetic author',
          icon: 'R',
          position: 'Engineer',
          expertise: ['synthetic'],
          createdAt: 1,
        })
      );
    });
    const office = actual.chatroomService.createRoom('Office', undefined);
    officeId = office.id;
    // Owned synthetic room fixture membership; no briefing, wake or session launch.
    office.members.push({ sessionId: SID, lastName: 'Synthetic author', joinedAt: 1 });
    expect(actual.chatroomService.rooms().some((room) => room.name.toLowerCase() === 'general')).toBe(false);
    expect(actual.app.server.listening).toBe(false);
  }, 30000);
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID;
    for (const job of actual.cronService.listJobs()) actual.cronService.deleteJob(job.id);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    actual?.sessions.clear();
    await server?.stop();
    if (previousDirectory === undefined) delete process.env.REVERIE_DATA_DIR;
    else process.env.REVERIE_DATA_DIR = previousDirectory;
    if (previousAnnouncement === undefined) delete process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID;
    else process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID = previousAnnouncement;
    if (directory?.startsWith(join(tmpdir(), 'routine-announcement-server-')))
      await fs.rm(directory, { recursive: true, force: true });
  });
  it('reproduces missing General refusal with no mutation, then explicit room posts notice BEFORE creating one disabled own routine', async () => {
    const missing = await create();
    expect(missing.statusCode, missing.body).toBe(403);
    expect(actual.cronService.listJobs()).toEqual([]);
    process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID = officeId;
    const grants = actual.cronPort.routines.grants.snapshot();
    const original = actual.cronService.createJob.bind(actual.cronService);
    vi.spyOn(actual.cronService, 'createJob').mockImplementation((...args: Parameters<CronService['createJob']>) => {
      expect(
        actual.chatroomService
          .room(officeId)!
          .messages.some((message) => message.from.kind === 'system' && message.text.includes('created post job'))
      ).toBe(true);
      return original(...args);
    });
    const made = await create();
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().data.job).toMatchObject({
      enabled: false,
      postAs: 'author',
      createdBy: { employeeId: 'synthetic-author' },
    });
    expect(actual.cronService.listJobs()).toHaveLength(1);
    expect(actual.cronPort.routines.grants.snapshot()).toEqual(grants);
  });
  it.each(['unknown', 'invalid', 'archived', 'dm', 'wrong-owner'] as const)(
    'refuses configured%s without a notice, fallback or job',
    async (mode) => {
      const room = actual.chatroomService.createRoom(
        'Not an inferred audience',
        mode === 'wrong-owner' ? 'other-owner' : undefined
      );
      if (mode === 'archived') actual.chatroomService.archiveRoom(room.id, true);
      if (mode === 'dm') room.kind = 'dm'; // synthetic invalid-audience fixture, no real DM/private state
      process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID =
        mode === 'unknown' ? 'unknown-room' : mode === 'invalid' ? '../invalid' : room.id;
      const post = vi.spyOn(actual.chatroomService, 'post');
      const response = await create();
      expect(response.statusCode, response.body).toBe(403);
      expect(post).not.toHaveBeenCalled();
      expect(actual.cronService.listJobs()).toEqual([]);
    }
  );
  it('retains legacy active General default when unset but never falls back to it for a bad explicit ID', async () => {
    const general = actual.chatroomService.createRoom(' General ', undefined);
    const made = await create();
    expect(made.statusCode, made.body).toBe(200);
    expect(general.messages.some((message) => message.text.includes('created post job'))).toBe(true);
    actual.cronService.deleteJob(made.json().data.job.id);
    process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID = 'missing-configured-room';
    const before = general.messages.length;
    expect((await create()).statusCode).toBe(403);
    expect(general.messages).toHaveLength(before);
    expect(actual.cronService.listJobs()).toEqual([]);
  });
  it('revalidates archived state at actual notify and preserves refusal when posting fails', async () => {
    process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID = officeId;
    const policy = actual.cronPort.routines;
    expect(policy.notificationRoomId()).toBe(officeId);
    actual.chatroomService.archiveRoom(officeId, true);
    expect(policy.notify(officeId, 'Synthetic notice')).toBe(false);
    actual.chatroomService.archiveRoom(officeId, false);
    vi.spyOn(actual.chatroomService, 'post').mockImplementation(() => {
      throw Error('Synthetic notice write failure');
    });
    expect((await create()).statusCode).toBe(403);
    expect(actual.cronService.listJobs()).toEqual([]);
  });
  it.each(['dm', 'wrong-owner', 'changed-config'] as const)('revalidates%s at actual notify', (mode) => {
    process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID = officeId;
    const policy = actual.cronPort.routines;
    const room = actual.chatroomService.room(officeId)!;
    expect(policy.notificationRoomId()).toBe(officeId);
    const post = vi.spyOn(actual.chatroomService, 'post');
    try {
      if (mode === 'dm') room.kind = 'dm';
      if (mode === 'wrong-owner') room.owner = 'another-owner';
      if (mode === 'changed-config') process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID = 'missing-audience';
      expect(policy.notify(officeId, 'Synthetic notice')).toBe(false);
      expect(post).not.toHaveBeenCalled();
    } finally {
      room.kind = undefined;
      room.owner = undefined;
    }
  });
  it('does not let worker request fields override server announcement configuration', async () => {
    process.env.REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID = 'missing-audience';
    const response = await actual.app.inject({
      method: 'POST',
      url: '/api/cron/jobs',
      headers: { host: 'localhost', 'x-reverie-parent-session': SID, 'x-routine-announcement-room': officeId },
      payload: { ...input(), announcementRoomId: officeId, REVERIE_ROUTINE_ANNOUNCEMENT_ROOM_ID: officeId },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(actual.cronService.listJobs()).toEqual([]);
  });
});
