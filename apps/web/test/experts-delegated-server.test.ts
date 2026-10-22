/** Real server/auth/session hooks; only external CLI startup is replaced with no-op IO. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { dataPath } from '../src/config/instance.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { addSubscriptionProfile } from '../src/subscription-profiles.js';

describe('delegated template hiring through the real enforce-mode server', () => {
  let server: WebServer, app: FastifyInstance, directory: string, delegate: string, stranger: string, roomId: string, profileId: string;
  let cookie: string;
  const activations: Array<{ id: string; registered: boolean; joined: boolean }> = [];
  const headers = { host: 'localhost', origin: 'http://localhost' };
  const password = 'violet-saturn-kettle-82-Z';
  const owner = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) => app.inject({ method, url, headers: { ...headers, cookie }, payload });
  const agent = (id: string, url: string, payload: any) => app.inject({ method: 'POST', url, headers: { ...headers, 'x-reverie-parent-session': id }, payload });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'delegated-server-'));
    vi.spyOn(Session.prototype, 'startInteractive').mockImplementation(async function (this: Session) {
      activations.push({ id: this.id, registered: (server as any).companyService.view().employees.some((employee: any) => employee.sessionId === this.id), joined: (server as any).chatroomService.room(roomId)?.members.some((member: any) => member.sessionId === this.id) === true });
    });
    const service = new OwnerAuthService({ store: new OwnerAuthStore(dataPath('owner-auth.json')), auditFile: dataPath('owner-auth-audit.jsonl'), setupEnabled: true });
    await service.setup('fixture-owner', password, password, '127.0.0.1');
    server = new WebServer(0, false, true, '127.0.0.1'); await server.start();
    app = (server as any).app;
    const login = await app.inject({ method: 'POST', url: '/api/owner/login', headers, payload: { username: 'fixture-owner', password } });
    expect(login.statusCode).toBe(200);
    cookie = login.cookies.find(item => item.name === 'reverie_owner')!.name + '=' + login.cookies.find(item => item.name === 'reverie_owner')!.value;
    const create = async (name: string) => {
      const response = await owner('POST', '/api/sessions', { workingDir: directory, mode: 'claude', name });
      expect(response.json()).toMatchObject({ success: true, data: { session: { id: expect.any(String) } } });
      return response.json().data.session.id;
    };
    delegate = await create('Delegate'); stranger = await create('Stranger');
    const room = (server as any).chatroomService.createRoom('General', undefined); roomId = room.id;
    (server as any).chatroomService.addMember(roomId, delegate);
    const configDir = join(directory, 'selected-account'); await mkdir(configDir);
    profileId = (await addSubscriptionProfile({ label: 'Synthetic template account', provider: 'anthropic', configDir })).id;
    expect((await owner('PUT', '/api/experts/reviewer', { name: 'Reviewer', icon: 'R', role: 'Code reviewer', persona: 'Review only assigned changes.', expertise: ['Testing'], defaults: { mode: 'claude', accountProfileId: profileId }, rooms: [roomId] })).statusCode).toBe(200);
    expect((await owner('PUT', '/api/experts-settings', { hireDelegates: [delegate], noticeRoomId: roomId, delegateWorkingRoot: directory, maxActive: 3, maxHiresPerDay: 10 })).statusCode).toBe(200);
  }, 30000);
  afterAll(async () => { await server?.stop(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  it('refuses direct and unlisted launches, then hires with the selected template account and real parent lineage', async () => {
    const before = (server as any).sessions.size;
    expect((await agent(delegate, '/api/sessions', { workingDir: directory, mode: 'claude', name: 'Direct' })).statusCode).toBe(403);
    expect((await agent(stranger, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Review fixture changes' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: { workingDir: directory, mode: 'claude' } })).statusCode).toBe(401);
    expect((server as any).sessions.size).toBe(before);
    // The outer request really enters over HTTP. The private authorization exists
    // only for the nested in-process injection, never on the wire.
    const { stdout } = await promisify(execFile)('curl', ['--silent', '--show-error', '--max-time', '10', '--header', 'Content-Type: application/json', '--header', `x-reverie-parent-session: ${delegate}`, '--data', JSON.stringify({ workingDir: directory, reason: 'Review fixture changes' }), '--write-out', '\n%{http_code}', `http://127.0.0.1:${server.boundPort}/api/experts/reviewer/hire`], { maxBuffer: 128 * 1024 });
    const split = stdout.lastIndexOf('\n');
    expect(Number(stdout.slice(split + 1))).toBe(200);
    const response = JSON.parse(stdout.slice(0, split));
    expect(response).toMatchObject({ success: true, data: { sessionId: expect.any(String), employeeId: expect.any(String) } });
    const hired = response.data;
    expect(activations).toEqual([{ id: hired.sessionId, registered: true, joined: true }]);
    const child = (server as any).sessions.get(hired.sessionId);
    expect(child.parentSessionId).toBe(delegate); expect(child.mode).toBe('claude'); expect(child.workingDir).toBe(directory);
    expect(child.toState().subscriptionProfile.id).toBe(profileId);
    expect(child._envOverrides.CLAUDE_CONFIG_DIR).toBe(join(directory, 'selected-account'));
    expect((server as any).companyService.view().employees.find((item: any) => item.id === hired.employeeId)).toMatchObject({
      sessionId: hired.sessionId, desiredRunning: true,
      runtimeRecipe: { mode: 'claude', workingDir: directory, subscriptionProfile: { id: profileId } },
    });
    expect((server as any).sessions.size).toBe(before + 1);
  });

  it('keeps template selection/root guards and rolls back a failed notice without leaking a runtime or identity', async () => {
    const before = (server as any).sessions.size;
    expect((await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Review changes', mode: 'codex' })).statusCode).toBe(403);
    expect((await agent(delegate, '/api/experts/reviewer/hire', { workingDir: tmpdir(), reason: 'Review changes' })).statusCode).toBe(403);
    const chat = (server as any).chatroomService;
    const post = chat.post.bind(chat);
    const failure = vi.spyOn(chat, 'post').mockImplementation((...args: any[]) => { if (args[1]?.name === 'experts') throw new Error('Synthetic notice refusal'); return post(...args); });
    const response = await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Review fixture changes' });
    failure.mockRestore();
    expect(response.json().success).toBe(false);
    expect((server as any).sessions.size).toBe(before);
    expect((server as any).companyService.view().employees.map((employee: any) => employee.name)).toEqual(['Reviewer']);
    const settings = (await owner('GET', '/api/experts')).json().data.settings;
    expect((await owner('PUT', '/api/experts-settings', { ...settings, maxActive: 1 })).statusCode).toBe(200);
    expect((await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Review fixture changes' })).statusCode).toBe(409);
    expect((server as any).sessions.size).toBe(before);
  });

  it('rechecks a delegate revoked while its hire waits behind another launch', async () => {
    const settings = (await owner('GET', '/api/experts')).json().data.settings;
    await owner('PUT', '/api/experts-settings', { ...settings, maxActive: 3 });
    let signal!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const inject = app.inject.bind(app);
    const paused = vi.spyOn(app, 'inject').mockImplementation(((options: any) => {
      if (options.url === '/api/sessions') { signal(); return held.then(() => inject(options)); }
      return inject(options);
    }) as any);
    const first = owner('POST', '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Owner fixture review' }).then(response => response);
    await entered;
    const before = (server as any).sessions.size;
    const queued = agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Queued fixture review' }).then(response => response);
    await new Promise(resolve => setImmediate(resolve));
    await owner('PUT', '/api/experts-settings', { ...settings, maxActive: 3, hireDelegates: [] });
    release();
    expect((await first).json().success).toBe(true);
    expect((await queued).statusCode).toBe(403);
    paused.mockRestore();
    expect((server as any).sessions.size).toBe(before + 1); // The owner's held hire alone completed.
  });
});
