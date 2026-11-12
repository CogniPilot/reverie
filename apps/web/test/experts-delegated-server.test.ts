/** Real server/auth/session hooks; only external CLI startup is replaced with no-op IO. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import fileIo from 'node:fs/promises';
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
import { CompanyService } from '../src/company-service.js';
import * as companyFiles from '../src/company-store.js';

describe('delegated template hiring through the real enforce-mode server', () => {
  let server: WebServer, app: FastifyInstance, directory: string, delegate: string, stranger: string, roomId: string, profileId: string;
  let cookie: string;
  let preparationHook: (() => Promise<void>) | undefined;
  const activations: Array<{ id: string; registered: boolean; joined: boolean }> = [];
  const headers = { host: 'localhost', origin: 'http://localhost' };
  const password = 'violet-saturn-kettle-82-Z';
  const owner = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) => app.inject({ method, url, headers: { ...headers, cookie }, payload });
  const agent = (id: string, url: string, payload: any) => app.inject({ method: 'POST', url, headers: { ...headers, 'x-reverie-parent-session': id }, payload });
  const loginOwner = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/owner/login', headers, payload: { username: 'fixture-owner', password } });
    expect(response.statusCode).toBe(200);
    const session = response.cookies.find(item => item.name === 'reverie_owner')!;
    cookie = session.name + '=' + session.value;
  };
  const requestHire = async () => {
    const settings = (await owner('GET', '/api/experts')).json().data.settings;
    expect((await owner('PUT', '/api/experts-settings', { ...settings, hireDelegates: [delegate], maxActive: 20, maxHiresPerDay: 20 })).statusCode).toBe(200);
    const response = await agent(delegate, '/api/experts/reviewer/hire-requests', { workingDir: directory, reason: 'Exercise revocable owner creation' });
    expect(response.statusCode).toBe(200);
    return response.json().data.request.id as string;
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'delegated-server-'));
    const actualNice = (WebServer.prototype as any).getGlobalNiceConfig;
    vi.spyOn(WebServer.prototype as any, 'getGlobalNiceConfig').mockImplementation(async function(this: WebServer) {
      const result = await actualNice.call(this);
      await preparationHook?.();
      return result;
    });
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

  it('keeps template selection/root guards and retains the runtime and identity after a failed notice', async () => {
    const before = (server as any).sessions.size;
    expect((await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Review changes', mode: 'codex' })).statusCode).toBe(403);
    expect((await agent(delegate, '/api/experts/reviewer/hire', { workingDir: tmpdir(), reason: 'Review changes' })).statusCode).toBe(403);
    const chat = (server as any).chatroomService;
    const post = chat.post.bind(chat);
    const failure = vi.spyOn(chat, 'post').mockImplementation((...args: any[]) => { if (args[1]?.name === 'experts') throw new Error('Synthetic notice refusal'); return post(...args); });
    const response = await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Review fixture changes' });
    failure.mockRestore();
    expect(response.json()).toMatchObject({ success: true, data: { hire: { notice: 'unconfirmed', startup: { phase: 'launch-returned' } } } });
    expect((server as any).sessions.size).toBe(before + 1);
    expect((server as any).companyService.view().employees.map((employee: any) => employee.name)).toEqual(['Reviewer', 'Reviewer 2']);
    const settings = (await owner('GET', '/api/experts')).json().data.settings;
    expect((await owner('PUT', '/api/experts-settings', { ...settings, maxActive: 1 })).statusCode).toBe(200);
    expect((await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Review fixture changes' })).statusCode).toBe(409);
    expect((server as any).sessions.size).toBe(before + 1);
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

  it('passes current delegate admission into the real launch adapter and retains identity after revocation', async () => {
    const settings = (await owner('GET', '/api/experts')).json().data.settings;
    await owner('PUT', '/api/experts-settings', { ...settings, hireDelegates: [delegate], maxActive: 20, maxHiresPerDay: 20 });
    let admittedBefore = false;
    let admittedAfter = true;
    vi.mocked(Session.prototype.startInteractive).mockImplementationOnce(async admitted => {
      admittedBefore = admitted?.() === true;
      expect((await owner('PUT', '/api/experts-settings', { ...settings, hireDelegates: [], maxActive: 20, maxHiresPerDay: 20 })).statusCode).toBe(200);
      admittedAfter = admitted?.() === true;
      throw new Error('Synthetic launch admission revoked before external CLI effect');
    });
    const cleanup = vi.spyOn(server as any, 'cleanupSession');
    const response = await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Exercise current launch admission' });
    expect(response.statusCode).toBe(503);
    expect(admittedBefore).toBe(true);
    expect(admittedAfter).toBe(false);
    const retained = response.json().recovery;
    expect((server as any).companyService.view().employees.some((employee: any) => employee.id === retained.employeeId && employee.sessionId === retained.sessionId)).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    cleanup.mockRestore();
  });

  it.each(['saveRuntimeRecipe', 'setDesiredRunning'] as const)('retains canonical identity when the real adapter rejects %s after interactive startup', async method => {
    const settings = (await owner('GET', '/api/experts')).json().data.settings;
    await owner('PUT', '/api/experts-settings', { ...settings, maxActive: 20, maxHiresPerDay: 20 });
    const before = activations.length;
    const cleanup = vi.spyOn(server as any, 'cleanupSession');
    const failure = vi.spyOn(CompanyService.prototype, method).mockRejectedValueOnce(new Error('Synthetic post-launch persistence rejection'));
    const response = await owner('POST', '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Exercise post-launch persistence failure' });
    failure.mockRestore();
    expect(response.statusCode).toBe(503);
    const retained = response.json().recovery;
    expect(retained).toMatchObject({ kind: 'hire-retained', employeeId: expect.any(String), sessionId: expect.any(String), hireId: expect.any(String) });
    expect(activations.slice(before)).toEqual([{ id: retained.sessionId, registered: true, joined: true }]);
    expect((server as any).sessions.has(retained.sessionId)).toBe(true);
    expect((server as any).companyService.view().employees.find((employee: any) => employee.id === retained.employeeId))
      .toMatchObject({ sessionId: retained.sessionId, sessionGeneration: 1 });
    const data = (await owner('GET', '/api/experts')).json().data;
    expect(data.hires.find((hire: any) => hire.id === retained.hireId))
      .toMatchObject({ employeeId: retained.employeeId, status: 'active', startup: { phase: 'recovery-required', sessionGeneration: 1 } });
    expect(cleanup).not.toHaveBeenCalled();
    cleanup.mockRestore();
  });

  it.each(['reservation-publication', 'async-preparation', 'layout-lock'] as const)(
    'rechecks the actual owner cookie at %s and retains creation uncertainty without a Session/provider', async phase => {
      const requestId = await requestHire();
      const sessionsBefore = [...(server as any).sessions.keys()];
      const employeesBefore = (server as any).companyService.view().employees.map((employee: any) => employee.id);
      const activationsBefore = activations.length;
      let revoked = false;
      let revocationStatus: number | undefined;
      const revoke = async () => {
        if (revoked) return;
        revocationStatus = (await owner('POST', '/api/owner/logout')).statusCode;
        revoked = revocationStatus === 200;
      };
      const cleanup = vi.spyOn(server as any, 'cleanupSession');
      const stop = vi.spyOn(Session.prototype, 'stop');
      const kill = vi.spyOn((server as any).mux, 'killSession');
      let boundary: { mockRestore(): void };
      if (phase === 'reservation-publication') {
        const actual = companyFiles.writeCompanyStateFile;
        boundary = vi.spyOn(companyFiles, 'writeCompanyStateFile').mockImplementation(async (path, bytes, validate) => {
          await actual(path, bytes, validate);
          if (path === dataPath('experts.json') && JSON.parse(bytes).hireRequests.some((request: any) => request.id === requestId && request.reservation?.phase === 'creation-issued'))
            await revoke(); // publication completed; its awaited Promise has not returned to the hire route
        });
      } else if (phase === 'async-preparation') {
        // The route context binds this method during startup; install the real-method interceptor before binding.
        preparationHook = revoke;
        boundary = { mockRestore: () => { preparationHook = undefined; } };
      } else {
        const actual = (server as any).readSettings.bind(server);
        boundary = vi.spyOn(server as any, 'readSettings').mockImplementation(async (fresh?: unknown) => {
          const result = await actual(fresh);
          if (fresh === true) await revoke(); // awaited childrenFollowParent inside the actual owner layout lock
          return result;
        });
      }
      try {
        const response = await owner('POST', `/api/experts-hire-requests/${requestId}/approve`, {});
        expect(response.statusCode).toBe(503);
        expect(revoked).toBe(true);
        expect(revocationStatus).toBe(200);
        expect(response.json().recovery).toEqual({ kind: 'hire-retained', requestId });
        expect([...(server as any).sessions.keys()]).toEqual(sessionsBefore);
        expect((server as any).companyService.view().employees.map((employee: any) => employee.id)).toEqual(employeesBefore);
        expect(activations).toHaveLength(activationsBefore);
        expect(cleanup).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        expect(stop.mock.calls).toEqual(phase === 'layout-lock' ? [[false]] : []);
        const stored = JSON.parse(await readFile(dataPath('experts.json'), 'utf8'));
        const request = stored.hireRequests.find((row: any) => row.id === requestId);
        expect(request).toMatchObject({ status: 'approving', reservation: { phase: 'creation-issued' } });
        expect(request.reservation).not.toHaveProperty('sessionId');
      } finally {
        boundary.mockRestore(); cleanup.mockRestore(); stop.mockRestore(); kill.mockRestore();
        await loginOwner();
      }
      expect((await owner('POST', `/api/experts-hire-requests/${requestId}/approve`, {})).statusCode).toBe(409);
      expect((await owner('POST', `/api/experts-hire-requests/${requestId}/decline`, {})).statusCode).toBe(409);
    }
  );

  it.each(['owner-revoked', 'delegate-revoked', 'session-replaced', 'quota-lowered'] as const)(
    'refuses canonical publication at the actual CompanyStore beforeCommit boundary when %s', async kind => {
      const settings = (await owner('GET', '/api/experts')).json().data.settings;
      await owner('PUT', '/api/experts-settings', { ...settings, hireDelegates: [delegate], maxActive: 20, maxHiresPerDay: 20 });
      const requestId = kind === 'owner-revoked' ? await requestHire() : undefined;
      const employeesBefore = (server as any).companyService.view().employees.map((employee: any) => employee.id);
      const originalIds = new Set(employeesBefore);
      const activationsBefore = activations.length;
      let genuineSid: string | undefined;
      let original: Session | undefined;
      let replacement: Session | undefined;
      let faultApplied = false;
      let faultStatus: number | undefined;
      const actualOpen = fileIo.open.bind(fileIo);
      const syncHooks: Array<{ mockRestore(): void }> = [];
      const cleanup = vi.spyOn(server as any, 'cleanupSession');
      const kill = vi.spyOn((server as any).mux, 'killSession');
      const boundary = vi.spyOn(fileIo, 'open').mockImplementation(async (path, flags, mode) => {
        const handle = await actualOpen(path, flags, mode);
        if (typeof path === 'string' && path.startsWith(dataPath('company.json') + '.') && path.endsWith('.tmp') && flags === 'wx') {
          const actualSync = handle.sync.bind(handle);
          syncHooks.push(vi.spyOn(handle, 'sync').mockImplementation(async () => {
            await actualSync();
            if (genuineSid) return;
            const candidate = JSON.parse(await readFile(path, 'utf8')).employees.find((employee: any) => !originalIds.has(employee.id));
            if (!candidate) return;
            genuineSid = candidate.sessionId;
            if (kind === 'owner-revoked') faultStatus = (await owner('POST', '/api/owner/logout')).statusCode;
            else if (kind === 'delegate-revoked')
              faultStatus = (await owner('PUT', '/api/experts-settings', { ...settings, hireDelegates: [], maxActive: 20, maxHiresPerDay: 20 })).statusCode;
            else if (kind === 'quota-lowered')
              faultStatus = (await owner('PUT', '/api/experts-settings', { ...settings, hireDelegates: [delegate], maxActive: 0, maxHiresPerDay: 20 })).statusCode;
            else {
              original = (server as any).sessions.get(genuineSid);
              replacement = new Session({ id: genuineSid, workingDir: directory, mode: 'claude', owner: original!.owner });
              (server as any).sessions.set(genuineSid, replacement);
            }
            faultApplied = kind === 'session-replaced' || faultStatus === 200;
          }));
        }
        return handle;
      });
      try {
        const response = requestId
          ? await owner('POST', `/api/experts-hire-requests/${requestId}/approve`, {})
          : kind === 'delegate-revoked'
            ? await agent(delegate, '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Exercise canonical publication admission' })
            : await owner('POST', '/api/experts/reviewer/hire', { workingDir: directory, reason: 'Exercise canonical publication admission' });
        expect(response.statusCode).toBe(503);
        expect(genuineSid).toBeTruthy();
        expect(faultApplied).toBe(true);
        expect(response.json().recovery).toEqual({ kind: 'hire-retained', sessionId: genuineSid });
        expect((server as any).sessions.has(genuineSid)).toBe(true);
        expect((server as any).companyService.view().employees.map((employee: any) => employee.id)).toEqual(employeesBefore);
        expect(JSON.parse(await readFile(dataPath('company.json'), 'utf8')).employees.map((employee: any) => employee.id)).toEqual(employeesBefore);
        expect(activations).toHaveLength(activationsBefore);
        expect(cleanup).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        if (requestId) {
          const stored = JSON.parse(await readFile(dataPath('experts.json'), 'utf8'));
          expect(stored.hireRequests.find((request: any) => request.id === requestId))
            .toMatchObject({ status: 'approving', reservation: { phase: 'session-bound', sessionId: genuineSid } });
        }
      } finally {
        boundary.mockRestore(); for (const hook of syncHooks) hook.mockRestore(); cleanup.mockRestore(); kill.mockRestore();
        if (original && genuineSid) (server as any).sessions.set(genuineSid, original);
        await replacement?.stop(false);
        if (kind === 'owner-revoked') await loginOwner();
        await owner('PUT', '/api/experts-settings', { ...settings, hireDelegates: [delegate], maxActive: 20, maxHiresPerDay: 20 });
      }
    }
  );

  it('retains a real created session/profile when its response carries an error and an ID', async () => {
    const requestId = await requestHire();
    const inject = app.inject.bind(app);
    let createdId: string | undefined;
    const cleanup = vi.spyOn(server as any, 'cleanupSession');
    const altered = vi.spyOn(app, 'inject').mockImplementation((async (options: any) => {
      const response = await inject(options);
      if (options.url !== '/api/sessions') return response;
      createdId = response.json().data.session.id;
      return { statusCode: 503, json: () => ({ success: false, error: 'Synthetic response failure', data: { session: { id: createdId } } }) };
    }) as any);
    try {
      const response = await owner('POST', `/api/experts-hire-requests/${requestId}/approve`, {});
      expect(response.statusCode).toBe(503);
      expect(createdId).toBeTruthy();
      expect((server as any).sessions.has(createdId)).toBe(true);
      expect((server as any).companyService.view().temporaryAgents.some((profile: any) => profile.sessionId === createdId)).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      expect((await owner('GET', '/api/experts-hire-requests')).json().data.requests.find((request: any) => request.id === requestId))
        .toMatchObject({ status: 'approving', reservation: { phase: 'creation-issued' } });
    } finally { altered.mockRestore(); cleanup.mockRestore(); }
  });
});
