import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * @fileoverview Profile images: an agent sets or clears its OWN image, the owner may set any agent's,
 * and the image shows on the agent's membership in every room it is in. Only real PNG/JPEG/GIF/WebP
 * bytes are accepted. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerCompanyRoutes } from '../../src/web/routes/company-routes.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatroomChanged } from '../../src/web/sse-events.js';
import { AvatarStore, MAX_AVATAR_BYTES, sniffImage } from '../../src/agent-avatars.js';
import { createMockSession } from '../mocks/index.js';
import type { SessionPort } from '../../src/web/ports/session-port.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { agentProfile, type AgentDeps, type ApiResponse, type RequestOptions } from '../../src/cli-agent.js';

const ALPHA = 'alpha-session';
const BETA = 'beta-session';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const URL_SHAPE = /^\/api\/avatars\/alpha-session\?v=\d+$/;

describe('profile images', () => {
  let app: FastifyInstance;
  let directory: string;
  let service: CompanyService;
  let chatrooms: ChatroomService;
  let events: Array<{ event: string; data: { roomId?: string } }>;
  let showSelfProfile: ReturnType<typeof vi.fn>;
  let rooms: string[];
  let sessions: Map<string, ReturnType<typeof createMockSession>>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-company-avatar-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    sessions = new Map(
      [ALPHA, BETA].map((id) => {
        const session = createMockSession(id);
        session.name = id.split('-')[0];
        return [id, session] as const;
      })
    );
    events = [];
    chatrooms = new ChatroomService({
      file: join(directory, 'chatrooms.json'),
      getSession: (id) => sessions.get(id) as never,
      broadcast: (event, data) => events.push({ event, data: data as { roomId?: string } }),
    });
    await chatrooms.init();
    showSelfProfile = vi.fn();
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id) as never,
      chatrooms,
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
      showSelfProfile,
    });
    app = Fastify();
    registerCompanyRoutes(app, { sessions } as unknown as SessionPort, service, new AvatarStore(join(directory, 'agent-avatars')), undefined, undefined, { verifiedOwner: trustedFixtureOwner }
    );
    installRouteErrorHandler(app);
    await app.ready();
    const lab = chatrooms.createRoom('Lab', undefined);
    chatrooms.addMember(lab.id, ALPHA, { role: 'coordinator', goal: 'run the lab', icon: '🌱' });
    chatrooms.addMember(lab.id, BETA, { goal: 'assist', icon: '🦊' });
    const field = chatrooms.createRoom('Field', undefined);
    chatrooms.addMember(field.id, ALPHA, { goal: 'survey', voice: true });
    rooms = [lab.id, field.id];
    events.length = 0;
  });

  afterEach(async () => {
    await chatrooms.stop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const upload = (url: string, body: Buffer, as?: string, type = 'image/png') =>
    app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: { 'content-type': type, ...(as === undefined ? {} : { 'x-reverie-parent-session': as }) },
    });
  const member = (roomId: string, id: string) => chatrooms.room(roomId)!.members.find((m) => m.sessionId === id)!;
  const record = (id: string) => service.store.snapshot().temporaryAgents.find((a) => a.sessionId === id);
  const stored = async () => readdir(join(directory, 'agent-avatars')).catch(() => [] as string[]);

  it('the owner edits a disconnected vacation employee image without replacing the persistent profile', async () => {
    const employee = await service.hire({ name: 'Ellis', icon: 'E', position: 'Engineer', expertise: ['systems'],
      sessionId: ALPHA, pronouns: 'they/them', voice: { provider: 'browser', id: 'chosen-voice' } });
    await service.store.update((state) => { state.employees[0].onVacation = true; });
    sessions.delete(ALPHA);
    const before = service.store.snapshot().employees[0];
    const uploaded = await upload(`/api/company/agents/${ALPHA}/avatar`, PNG);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().data.profile.record).toBe('employee');
    expect(service.store.snapshot().employees[0]).toMatchObject({ ...before, id: employee.id, onVacation: true });
    const served = await app.inject({ method: 'GET', url: uploaded.json().data.profile.avatar });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(PNG)).toBe(true);
    expect((await upload(`/api/company/agents/${ALPHA}/avatar`, GIF, BETA)).statusCode).toBe(403);
    expect((await upload('/api/company/self/avatar', GIF, ALPHA)).statusCode).toBe(403);
    const cleared = await app.inject({ method: 'DELETE', url: `/api/company/agents/${ALPHA}/avatar` });
    expect(cleared.statusCode).toBe(200);
    expect(service.store.snapshot().employees[0]).toEqual(before);
    expect((await app.inject({ method: 'GET', url: `/api/avatars/${ALPHA}` })).statusCode).toBe(404);
    expect(service.store.snapshot().temporaryAgents).toEqual([]);
  });

  it('keeps retired pictures readable and editable but refuses foreign persisted identities', async () => {
    await service.hire({ name: 'Ellis', icon: 'E', position: 'Engineer', expertise: ['systems'], sessionId: ALPHA });
    await upload(`/api/company/agents/${ALPHA}/avatar`, PNG);
    sessions.delete(ALPHA);
    await service.store.update((state) => {
      const employee = state.employees.shift()!;
      state.retired.push({ ...employee, retiredAt: Date.now() });
      state.employees.push({ ...employee, id: 'foreign-employee', sessionId: 'foreign-runtime', owner: 'another-owner' });
    });
    expect((await app.inject({ method: 'GET', url: `/api/avatars/${ALPHA}` })).statusCode).toBe(200);
    expect((await upload(`/api/company/agents/${ALPHA}/avatar`, GIF, undefined, 'image/gif')).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/avatars/${ALPHA}` })).headers['content-type']).toBe('image/gif');
    expect((await upload('/api/company/agents/foreign-runtime/avatar', PNG)).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/company/agents/foreign-runtime/avatar' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/avatars/foreign-runtime' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/avatars/unknown-runtime' })).statusCode).toBe(404);
  });

  it('an agent sets its own image: stored, on its record and on its own membership in every room', async () => {
    const res = await upload('/api/company/self/avatar', PNG, ALPHA);
    expect(res.statusCode).toBe(200);
    const { profile } = res.json().data;
    expect(profile).toMatchObject({ record: 'temporary', rooms: 2 }); // no record before: one is created
    expect(profile.avatar).toMatch(URL_SHAPE);
    expect(record(ALPHA)).toMatchObject({ avatar: profile.avatar, name: 'alpha' });
    expect(member(rooms[0], ALPHA)).toMatchObject({
      avatar: profile.avatar,
      role: 'coordinator',
      goal: 'run the lab',
      icon: '🌱',
    });
    expect(member(rooms[1], ALPHA)).toMatchObject({ avatar: profile.avatar, voice: true, goal: 'survey' });
    expect(member(rooms[0], BETA).avatar).toBeUndefined(); // others untouched
    expect(
      events
        .filter((e) => e.event === ChatroomChanged)
        .map((e) => e.data.roomId)
        .sort()
    ).toEqual([...rooms].sort());
    expect(showSelfProfile).toHaveBeenCalledWith(ALPHA);
    const file = join(directory, 'agent-avatars', 'alpha-session.png');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const served = await app.inject({ method: 'GET', url: profile.avatar });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(PNG)).toBe(true);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toContain('sandbox');
  });

  it('a new format replaces the old file, and clearing removes the image everywhere', async () => {
    await upload('/api/company/self/avatar', PNG, ALPHA);
    await upload('/api/company/self/avatar', GIF, ALPHA, 'application/octet-stream');
    expect(await stored()).toEqual(['alpha-session.gif']);
    const served = await app.inject({ method: 'GET', url: '/api/avatars/alpha-session' });
    expect(served.headers['content-type']).toBe('image/gif'); // from the bytes
    const cleared = await app.inject({
      method: 'DELETE',
      url: '/api/company/self/avatar',
      headers: { 'x-reverie-parent-session': ALPHA },
    });
    expect(cleared.json().data.profile).toMatchObject({ avatar: null, rooms: 2 });
    expect(record(ALPHA)?.avatar).toBeUndefined();
    expect(member(rooms[0], ALPHA).avatar).toBeUndefined();
    expect(member(rooms[0], ALPHA).icon).toBe('🌱'); // the icon shows again
    expect(await stored()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/avatars/alpha-session' })).statusCode).toBe(404);
  });

  it('refuses anything that is not a small raster image, storing and recording nothing', async () => {
    for (const [body, type, status] of [
      [SVG, 'image/png', 415],
      [Buffer.from('<html><script>x</script></html>'), 'image/png', 415],
      [Buffer.alloc(0), 'image/png', 400],
      [Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]), 'image/png', 413],
    ] as Array<[Buffer, string, number]>) {
      const res = await upload('/api/company/self/avatar', body, ALPHA, type);
      expect(res.statusCode, `${type} ${body.length}`).toBe(status);
    }
    expect(await stored()).toEqual([]);
    expect(record(ALPHA)).toBeUndefined();
    expect(member(rooms[0], ALPHA).avatar).toBeUndefined();
  });

  it('only the caller itself, or the owner, sets an image', async () => {
    for (const as of [undefined, 'not-a-session', '']) {
      expect((await upload('/api/company/self/avatar', PNG, as)).statusCode, String(as)).toBe(403);
    }
    // An agent cannot use the owner route for another agent (or itself).
    expect((await upload(`/api/company/agents/${BETA}/avatar`, PNG, ALPHA)).statusCode).toBe(403);
    expect(member(rooms[0], BETA).avatar).toBeUndefined();
    // The owner (no header) sets an agent's image; an unknown session is 404.
    const owner = await upload(`/api/company/agents/${BETA}/avatar`, PNG);
    expect(owner.statusCode).toBe(200);
    expect(member(rooms[0], BETA).avatar).toMatch(/^\/api\/avatars\/beta-session\?v=\d+$/);
    expect(member(rooms[0], ALPHA).avatar).toBeUndefined();
    expect((await upload('/api/company/agents/nobody/avatar', PNG)).statusCode).toBe(404);
    expect(await stored()).toEqual(['beta-session.png']);
  });

  it('refuses at the profile cap instead of evicting another record, and writes no file', async () => {
    await service.store.update((state) => {
      for (let i = 0; i < 500; i++)
        state.temporaryAgents.push({ sessionId: `other-${i}`, name: 'x', icon: '', createdAt: 0 });
    });
    expect((await upload('/api/company/self/avatar', PNG, ALPHA)).statusCode).toBe(409);
    expect(service.store.snapshot().temporaryAgents).toHaveLength(500);
    expect(await stored()).toEqual([]);
  });

  it('a failed write records nothing, and a refused record restores the previous image', async () => {
    await upload('/api/company/self/avatar', PNG, ALPHA);
    const first = record(ALPHA)!.avatar;
    // A write failure: the URL is never recorded, and rooms keep the old image.
    const put = vi.spyOn(AvatarStore.prototype, 'put').mockRejectedValueOnce(new Error('disk full'));
    const failed = await upload('/api/company/self/avatar', GIF, ALPHA, 'application/octet-stream');
    expect(failed.statusCode).toBe(500);
    expect(record(ALPHA)!.avatar).toBe(first);
    expect(member(rooms[0], ALPHA).avatar).toBe(first);
    put.mockRestore();
    // A refused record (the session vanished between check and record): the old bytes come back.
    const setAvatar = vi.spyOn(service, 'setAvatar').mockRejectedValueOnce(new Error('refused'));
    expect((await upload('/api/company/self/avatar', GIF, ALPHA, 'application/octet-stream')).statusCode).toBe(500);
    setAvatar.mockRestore();
    expect(await stored()).toEqual(['alpha-session.png']);
    const served = await app.inject({ method: 'GET', url: '/api/avatars/alpha-session' });
    expect(served.rawPayload.equals(PNG)).toBe(true);
  });

  it('a member avatar can only ever be a URL of this server', () => {
    expect(() => chatrooms.setStatus(rooms[0], ALPHA, { avatar: 'https://evil.example/x.png' })).toThrow();
    expect(() => chatrooms.setStatus(rooms[0], ALPHA, { avatar: 'javascript:alert(1)' })).toThrow();
    expect(member(rooms[0], ALPHA).avatar).toBeUndefined();
  });

  it('sniffs real image types only', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImage(SVG)).toBeUndefined();
  });
});

describe('agent profile --image (CLI)', () => {
  function deps(answers: ApiResponse[]) {
    const calls: RequestOptions[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const d: AgentDeps = {
      ctx: { apiUrl: 'http://127.0.0.1:1', selfId: ALPHA },
      json: false,
      now: () => 0,
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      request: async (_c, options) => {
        calls.push(options);
        return answers.shift()!;
      },
    } as AgentDeps;
    return { d, calls, out, err };
  }
  const ok = (data: unknown): ApiResponse => ({ status: 200, json: { success: true, data }, text: '' });

  it('uploads the file bytes to the self route, and can clear the image', async () => {
    const run = deps([ok({ profile: { avatar: '/api/avatars/alpha-session?v=1', rooms: 2 } })]);
    const code = await agentProfile(run.d, { image: 'me.png', readFile: async () => PNG });
    expect(code).toBe(0);
    expect(run.calls).toEqual([{ method: 'POST', path: '/api/v1/company/self/avatar', rawBody: PNG }]);
    expect(run.out.join('\n')).toContain('new profile image');
    const clear = deps([ok({ profile: { avatar: null, rooms: 2 } })]);
    expect(await agentProfile(clear.d, { clearImage: true })).toBe(0);
    expect(clear.calls).toEqual([{ method: 'DELETE', path: '/api/v1/company/self/avatar' }]);
  });

  it('refuses both image flags at once and an unreadable file, before any request', async () => {
    const both = deps([]);
    expect(await agentProfile(both.d, { image: 'a.png', clearImage: true })).not.toBe(0);
    const missing = deps([]);
    expect(
      await agentProfile(missing.d, {
        image: 'missing.png',
        readFile: async () => {
          throw new Error('ENOENT');
        },
      })
    ).not.toBe(0);
    expect([...both.calls, ...missing.calls]).toEqual([]);
  });
});
