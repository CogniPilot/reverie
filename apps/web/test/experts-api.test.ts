/**
 * Experts API: templates seeded from a seed directory, owner-only template and settings changes,
 * credential refusal, delegate-gated hiring with caps, notice-or-rollback, audit lines, and
 * retirement that keeps the employee and its data, delegate launch limits, template room checks and
 * the per-hire budget stop (fake time, fake plans). All data here is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { ExpertStore, sessionCreateBody, type SessionLaunch } from '../src/experts.js';
import {
  registerExpertRoutes,
  type ExpertAuditEntry,
  type ExpertRoutes,
  type PlanReading,
} from '../src/web/routes/expert-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { classify } from '../src/owner-auth/policy.js';

const HEADER = 'x-reverie-parent-session';
const DELEGATE = '00000027-002e-4000-8000-00000000003d';
const OTHER_AGENT = '00000027-002e-4000-8000-00000000003e';

const alpha = {
  id: 'alpha',
  name: 'Alpha',
  icon: 'A',
  role: 'Compiler reviewer',
  persona: 'A careful reviewer of compiler changes. Contact: reviewer@example.com',
  expertise: ['parsing', 'code generation'],
  kind: 'expert',
  defaults: { mode: 'claude' },
  rooms: [] as string[],
};
const beta = {
  name: 'Beta',
  icon: 'B',
  role: 'Test writer',
  persona: 'Writes small, focused tests.',
  expertise: ['testing'],
  kind: 'implementer',
  defaults: { mode: 'claude', effort: 'medium' },
};

interface FakeSession {
  id: string;
  name: string;
  owner?: string;
  mode: string;
}

describe('experts api', () => {
  let dir: string;
  let seedDir: string;
  let file: string;
  let app: FastifyInstance;
  let rooms: ChatroomStore;
  let company: CompanyService;
  let sessions: Map<string, FakeSession>;
  let audits: ExpertAuditEntry[];
  let launches: SessionLaunch[];
  let stopped: string[];
  let noticeFails: boolean;
  let activationFails: boolean;
  let activated: string[];
  let clock: number;
  let noticeRoom: string;
  let sideRoom: string;
  let counter: number;
  let plans: PlanReading[] | Error;
  let routes: ExpertRoutes;
  let expertStore: ExpertStore;
  let stopFails: Set<string>;
  let sendFails: boolean;
  const MIN = 60 * 1000;

  const build = async (opts: { seed?: boolean; fallbackRoom?: string | null; noSend?: boolean } = {}) => {
    const store = new ExpertStore(file, opts.seed === false ? undefined : seedDir, () => clock);
    expertStore = store;
    app = Fastify();
    installRouteErrorHandler(app);
    routes = registerExpertRoutes(app, {
      store,
      callerSession: (req) => {
        const raw = req.headers[HEADER];
        return typeof raw === 'string' && sessions.has(raw.trim()) ? raw.trim() : undefined;
      },
      createSession: async (_req, launch) => {
        sessionCreateBody(launch); // the real body builder must accept every launch the routes produce
        launches.push(launch);
        const id = `hired-${++counter}`;
        sessions.set(id, { id, name: launch.name, mode: launch.mode });
        return id;
      },
      startSession: async (id) => {
        expect(company.view().employees.some(employee => employee.sessionId === id)).toBe(true);
        expect(rooms.get(sideRoom)!.members.some(member => member.sessionId === id)).toBe(true);
        if (activationFails) throw new Error('Synthetic startup failure');
        activated.push(id);
      },
      stopSession: async (id) => {
        if (stopFails.has(id)) throw new Error('tmux did not answer');
        stopped.push(id);
        sessions.delete(id);
      },
      sessionExists: (id) => sessions.has(id),
      employeeNames: (owner) => company.view(owner).employees.map(employee => employee.name),
      hireEmployee: (input) => company.hire({ ...input, researchEnabled: false }),
      inviteEmployee: (employeeId, roomId, owner) => void company.invite(employeeId, roomId, owner),
      removeEmployee: async (employeeId) => {
        await company.store.update((state) => {
          state.employees = state.employees.filter((e) => e.id !== employeeId);
        });
      },
      leaveRoom: (roomId, sessionId) => void rooms.removeMember(roomId, sessionId),
      postNotice: (roomId, text) => {
        if (noticeFails) throw new Error('room unavailable');
        rooms.post(roomId, { kind: 'system', name: 'experts' }, text, 'all', clock);
      },
      audit: async (entry) => {
        audits.push(entry);
      },
      noticeRoomFallback: opts.fallbackRoom === null ? undefined : (opts.fallbackRoom ?? noticeRoom),
      roomExists: (roomId) => !!rooms.get(roomId),
      readPlans: async () => {
        if (plans instanceof Error) throw plans;
        return structuredClone(plans);
      },
      sendToSession: opts.noSend
        ? undefined
        : (roomId, sessionId, text) => {
            if (sendFails) throw new Error('pane closed');
            rooms.post(roomId, { kind: 'system', name: 'experts' }, text, [sessionId], clock);
          },
      budgetCheckEveryMs: 0,
      now: () => clock,
    });
    await app.ready();
  };

  const req = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, agent?: string) =>
    app.inject({ method, url, payload: payload as never, headers: agent === undefined ? {} : { [HEADER]: agent } });
  const state = async () => JSON.parse(await readFile(file, 'utf8'));
  const setSettings = (settings: Record<string, unknown>) => req('PUT', '/api/experts-settings', settings);
  const hire = (id: string, agent?: string, extra: Record<string, unknown> = {}) =>
    req('POST', `/api/experts/${id}/hire`, { workingDir: dir, reason: 'Need a reviewer for the parser work', ...extra }, agent);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'experts-api-'));
    seedDir = join(dir, 'seed');
    await mkdir(seedDir);
    await writeFile(join(seedDir, 'alpha.json'), JSON.stringify(alpha));
    await writeFile(join(seedDir, 'beta.json'), JSON.stringify(beta));
    await writeFile(join(seedDir, 'broken.json'), '{ not json');
    file = join(dir, 'data', 'experts.json');
    sessions = new Map([
      [DELEGATE, { id: DELEGATE, name: 'Delegate', mode: 'claude' }],
      [OTHER_AGENT, { id: OTHER_AGENT, name: 'Other', mode: 'claude' }],
    ]);
    audits = [];
    launches = [];
    stopped = [];
    noticeFails = false;
    activationFails = false;
    activated = [];
    stopFails = new Set();
    sendFails = false;
    counter = 0;
    clock = Date.parse('2026-10-15T12:00:00Z');
    plans = [{ id: 'plan-a', weeklyPercent: 40, updatedAt: clock }];
    rooms = new ChatroomStore();
    noticeRoom = rooms.create('notices', undefined, clock).id;
    sideRoom = rooms.create('reviews', undefined, clock).id;
    const companyStore = new CompanyStore(join(dir, 'company.json'));
    await companyStore.init();
    company = new CompanyService(companyStore, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        setStatus: () => {
          throw new Error('unused');
        },
      },
      research: {
        start: async () => {
          throw new Error('unused');
        },
        inspect: async () => undefined,
        stop: async () => undefined,
      },
      now: () => clock,
    });
    await build();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('seeds from the seed directory on first read, skipping invalid files, and writes 0600', async () => {
    const res = await req('GET', '/api/experts');
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.experts.map((e: { id: string }) => e.id);
    expect(ids).toEqual(['alpha', 'beta']);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const one = await req('GET', '/api/experts/beta');
    expect(one.json().data.expert).toMatchObject({ name: 'Beta', kind: 'implementer', expertise: ['testing'] });
    expect((await req('GET', '/api/experts/nobody')).statusCode).toBe(404);
  });

  it('starts empty without a seed directory and reads as any caller', async () => {
    await app.close();
    await build({ seed: false });
    const res = await req('GET', '/api/experts', undefined, 'garbage');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.experts).toEqual([]);
  });

  it('returns the whole settings object, so a PUT can write back a read-modify-write copy', async () => {
    const before = (await req('GET', '/api/experts')).json().data.settings;
    expect(before).toMatchObject({ maxHiresPerDay: expect.any(Number), maxActive: expect.any(Number), hireDelegates: expect.any(Array) });
    const put = await req('PUT', '/api/experts-settings', { ...before, maxActive: before.maxActive + 1 });
    expect(put.statusCode).toBe(200);
    expect((await req('GET', '/api/experts')).json().data.settings).toEqual({ ...before, maxActive: before.maxActive + 1 });
  });

  it('lets the owner create, update and delete a template, with an audit line each', async () => {
    const created = await req('PUT', '/api/experts/gamma', { ...beta, name: 'Gamma' });
    expect(created.statusCode).toBe(200);
    const first = created.json().data.expert;
    clock += 1000;
    const updated = await req('PUT', '/api/experts/gamma', { ...beta, name: 'Gamma', role: 'Lead test writer' });
    expect(updated.json().data.expert).toMatchObject({ role: 'Lead test writer', createdAt: first.createdAt, updatedAt: clock });
    expect((await state()).templates.find((t: { id: string }) => t.id === 'gamma').role).toBe('Lead test writer');
    const removed = await req('DELETE', '/api/experts/gamma');
    expect(removed.statusCode).toBe(200);
    expect((await state()).templates.some((t: { id: string }) => t.id === 'gamma')).toBe(false);
    expect(audits.map((a) => [a.action, a.target])).toEqual([
      ['expert_template_set', 'gamma'],
      ['expert_template_set', 'gamma'],
      ['expert_template_delete', 'gamma'],
    ]);
    expect(JSON.stringify(audits)).not.toContain('Writes small');
    expect((await req('DELETE', '/api/experts/gamma')).statusCode).toBe(404);
  });

  it.each([
    ['a real-looking session id', DELEGATE],
    ['garbage', 'garbage'],
    ['an empty value', ''],
  ])('refuses template and settings changes from an agent header (%s) and changes nothing', async (_label, value) => {
    await setSettings({ hireDelegates: [DELEGATE], noticeRoomId: noticeRoom });
    const before = await readFile(file, 'utf8');
    const auditCount = audits.length;
    const put = await req('PUT', '/api/experts/alpha', { ...alpha, role: 'Changed' }, value);
    const create = await req('PUT', '/api/experts/delta', { ...beta, name: 'Delta' }, value);
    const del = await req('DELETE', '/api/experts/beta', undefined, value);
    const settings = await req('PUT', '/api/experts-settings', { hireDelegates: [OTHER_AGENT], maxActive: 50 }, value);
    for (const res of [put, create, del, settings]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(audits).toHaveLength(auditCount);
  });

  it('refuses a curl-style empty agent header sent over a real socket', async () => {
    await req('GET', '/api/experts');
    const before = await readFile(file, 'utf8');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = new URL(address);
    const body = JSON.stringify({ ...alpha, role: 'Changed' });
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1');
      let out = '';
      socket.on('data', (d) => (out += d.toString()));
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
      socket.write(
        `PUT /api/experts/alpha HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\n` +
          `X-Reverie-Parent-Session:\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
    });
    expect(raw.split('\r\n')[0]).toContain('403');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('refuses credential-looking text, unknown keys and runtime-assigned fields', async () => {
    await req('GET', '/api/experts');
    const before = await readFile(file, 'utf8');
    const cases = [
      { ...alpha, persona: 'Use key sk-' + 'x'.repeat(30) },
      { ...alpha, persona: 'token ghp_' + 'A1'.repeat(15) },
      { ...alpha, persona: ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') },
      { ...alpha, expertise: ['Q'.repeat(20) + '_' + 'z9'.repeat(12)] },
      { ...alpha, data_dir: '../memory' },
      { ...alpha, initial_self: { consciousness: 'x', directives: [] } },
      { ...alpha, persona: 'p'.repeat(4001) },
      { ...alpha, defaults: { mode: 'no-such-cli' } },
      { ...alpha, defaults: { mode: 'claude', apiKey: 'value' } },
    ];
    for (const body of cases) {
      const res = await req('PUT', '/api/experts/alpha', body);
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).not.toContain('xxxxxxxxxx');
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(audits).toHaveLength(0);
  });

  describe('hiring', () => {
    beforeEach(async () => {
      await setSettings({ hireDelegates: [DELEGATE], noticeRoomId: noticeRoom, delegateWorkingRoot: dir });
      await req('PUT', '/api/experts/alpha', { ...alpha, rooms: [sideRoom] });
      audits.length = 0;
    });

    it('lets the owner hire: session, employee, rooms, one notice, audit line', async () => {
      const res = await hire('alpha');
      expect(res.statusCode).toBe(200);
      const { sessionId, employeeId, hire: record } = res.json().data;
      expect(launches).toEqual([
        expect.objectContaining({ workingDir: dir, mode: 'claude', name: 'Alpha', icon: 'A' }),
      ]);
      const employee = company.view().employees.find((e) => e.id === employeeId);
      expect(employee).toMatchObject({ sessionId, name: 'Alpha', position: 'Compiler reviewer', researchEnabled: false });
      expect(rooms.get(sideRoom)!.members.map((m) => m.sessionId)).toContain(sessionId);
      const notices = rooms.get(noticeRoom)!.messages.filter((m) => m.from.kind === 'system');
      expect(notices).toHaveLength(1);
      expect(notices[0].text).toContain('Expert hired');
      expect(record).toMatchObject({ templateId: 'alpha', by: 'owner', status: 'active' });
      expect((await state()).hires).toHaveLength(1);
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'expert_hire',
          target: 'alpha',
          detail: expect.objectContaining({ template: 'alpha', sessionId, by: 'owner' }),
        }),
      ]);
    });

    it('disambiguates repeated template hires against actual company names before launch, preserving stable identities', async () => {
      await setSettings({ maxHiresPerDay: 10, maxActive: 10 });
      const first = (await hire('alpha')).json().data;
      await company.hire({ name: 'ALPHA 2', icon: 'A', position: 'Existing colleague', expertise: ['Testing'], sessionId: OTHER_AGENT, researchEnabled: false });
      const second = (await hire('alpha')).json().data;
      const third = (await hire('alpha')).json().data;
      expect(launches.map(launch => launch.name)).toEqual(['Alpha', 'Alpha 3', 'Alpha 4']);
      expect(company.view().employees.map(employee => employee.name)).toEqual(['Alpha', 'ALPHA 2', 'Alpha 3', 'Alpha 4']);
      expect(new Set([first.employeeId, second.employeeId, third.employeeId]).size).toBe(3);
      expect((await state()).hires.map((record: any) => record.templateId)).toEqual(['alpha', 'alpha', 'alpha']);
      expect(rooms.get(noticeRoom)!.messages.at(-1)?.text).toContain('Alpha 4');
    });

    it('lets a listed delegate hire and refuses an unlisted or unknown agent', async () => {
      const refused = await hire('alpha', OTHER_AGENT);
      expect(refused.statusCode).toBe(403);
      const garbage = await hire('alpha', 'garbage');
      expect(garbage.statusCode).toBe(403);
      const empty = await hire('alpha', '');
      expect(empty.statusCode).toBe(403);
      expect(launches).toHaveLength(0);
      expect(company.view().employees).toHaveLength(0);
      const ok = await hire('alpha', DELEGATE);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.hire.by).toBe(`agent:${DELEGATE}`);
      expect(audits.at(-1)).toMatchObject({ admin: `agent:${DELEGATE}`, action: 'expert_hire' });
    });

    it('a delegated hire cannot grant employee permissions through its input or template', async () => {
      const refused = await hire('alpha', DELEGATE, { permissions: { recoverEmployees: true } });
      expect(refused.statusCode).toBe(400);
      expect(launches).toHaveLength(0);
      const ok = await hire('alpha', DELEGATE);
      expect(ok.statusCode).toBe(200);
      expect(company.view().employees[0].permissions).toEqual({ recoverEmployees: false, moveOwnPlan: false, managePlans: false });
    });

    it('refuses the third hire in 24 hours with 409 and creates nothing', async () => {
      expect((await hire('alpha')).statusCode).toBe(200);
      expect((await hire('alpha')).statusCode).toBe(200);
      const before = await readFile(file, 'utf8');
      const third = await hire('alpha');
      expect(third.statusCode).toBe(409);
      expect(launches).toHaveLength(2);
      expect(company.view().employees).toHaveLength(2);
      expect(await readFile(file, 'utf8')).toBe(before);
      // Retiring does not refund the day's count; the next day it opens again.
      const first = (await state()).hires[0];
      await req('POST', '/api/experts/alpha/retire', { sessionId: first.sessionId, reason: 'Work is finished' });
      expect((await hire('alpha')).statusCode).toBe(409);
      clock += 24 * 60 * 60 * 1000 + 1;
      expect((await hire('alpha')).statusCode).toBe(200);
    });

    it('refuses at the active cap with 409 and never retires anyone to make room', async () => {
      await setSettings({
        hireDelegates: [DELEGATE],
        noticeRoomId: noticeRoom,
        delegateWorkingRoot: dir,
        maxActive: 1,
        maxHiresPerDay: 10,
      });
      expect((await hire('alpha')).statusCode).toBe(200);
      const res = await hire('beta');
      expect(res.statusCode).toBe(409);
      expect(launches).toHaveLength(1);
      expect(stopped).toHaveLength(0);
      expect((await state()).hires.map((h: { status: string }) => h.status)).toEqual(['active']);
    });

    it('fails the hire and leaves nothing behind when the notice cannot be posted', async () => {
      noticeFails = true;
      const res = await hire('alpha');
      expect(res.statusCode).toBe(503);
      expect(launches).toHaveLength(1);
      expect(stopped).toEqual(['hired-1']);
      expect(sessions.has('hired-1')).toBe(false);
      expect(company.view().employees).toHaveLength(0);
      expect(rooms.get(sideRoom)!.members).toHaveLength(0);
      expect((await state()).hires).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });

    it('awaits activation after registering identity and rooms, and rolls everything back if startup fails', async () => {
      activationFails = true;
      const response = await hire('alpha', DELEGATE);
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain('runtime could not start');
      expect(activated).toEqual([]); expect(stopped).toEqual(['hired-1']);
      expect(sessions.has('hired-1')).toBe(false); expect(company.view().employees).toHaveLength(0);
      expect(rooms.get(sideRoom)!.members).toHaveLength(0);
      expect((await state()).hires).toHaveLength(0);
      expect(rooms.get(noticeRoom)!.messages.some(message => message.text.includes('Expert hired'))).toBe(false);
    });

    it('refuses to hire with no notice room configured, before creating anything', async () => {
      await app.close();
      await build({ fallbackRoom: null });
      await setSettings({ hireDelegates: [DELEGATE] });
      const res = await hire('alpha');
      expect(res.statusCode).toBe(503);
      expect(launches).toHaveLength(0);
      expect(company.view().employees).toHaveLength(0);
    });

    it('retires: stops the session, keeps the employee and its data, audits and posts a notice', async () => {
      const workFile = join(dir, 'notes.txt');
      await writeFile(workFile, 'kept');
      const { sessionId, employeeId } = (await hire('alpha')).json().data;
      const notAllowed = await req('POST', '/api/experts/alpha/retire', { sessionId, reason: 'Work is finished' }, OTHER_AGENT);
      expect(notAllowed.statusCode).toBe(403);
      const res = await req('POST', '/api/experts/alpha/retire', { sessionId, reason: 'Work is finished' }, DELEGATE);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ notice: true, hire: { status: 'retired', retiredBy: `agent:${DELEGATE}` } });
      expect(stopped).toEqual([sessionId]);
      expect(company.view().employees.map((e) => e.id)).toEqual([employeeId]);
      expect(await readFile(workFile, 'utf8')).toBe('kept');
      expect(audits.at(-1)).toMatchObject({
        action: 'expert_retire',
        detail: expect.objectContaining({ template: 'alpha', sessionId, by: `agent:${DELEGATE}` }),
      });
      const retiredText = rooms.get(noticeRoom)!.messages.at(-1)!.text;
      expect(retiredText).toContain('Expert retired');
      expect(retiredText).toContain('Removed: the session (its console row, running process and paste uploads)');
      expect(retiredText).toContain("Kept: the hire and employee records, the working directory, the agent's memory");
      expect((await req('POST', '/api/experts/alpha/retire', { sessionId, reason: 'again please' })).statusCode).toBe(404);
    });

    it('refuses to delete a template with an active hire', async () => {
      await hire('alpha');
      expect((await req('DELETE', '/api/experts/alpha')).statusCode).toBe(409);
    });

    it.each([
      ['mode', { mode: 'claude' }],
      ['accountProfileId', { accountProfileId: 'work' }],
      ['an out-of-root workingDir', { workingDir: '/' }],
      ['a workingDir that climbs out of the root', { workingDir: 'UP' }],
    ])('refuses a delegate hire that sets %s with 403 and creates nothing', async (_label, given) => {
      const extra: Record<string, unknown> = given.workingDir === 'UP' ? { workingDir: `${dir}/..` } : given;
      const before = await readFile(file, 'utf8');
      const res = await hire('alpha', DELEGATE, extra);
      expect(res.statusCode).toBe(403);
      expect(launches).toHaveLength(0);
      expect(company.view().employees).toHaveLength(0);
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(audits).toHaveLength(0);
      // The owner may still choose these.
      if (!('workingDir' in extra)) expect((await hire('alpha', undefined, extra)).statusCode).toBe(200);
    });

    it('refuses every delegate hire while no delegateWorkingRoot is set', async () => {
      await setSettings({ hireDelegates: [DELEGATE], noticeRoomId: noticeRoom });
      const res = await hire('alpha', DELEGATE);
      expect(res.statusCode).toBe(403);
      expect(launches).toHaveLength(0);
    });

    it('can require a budget stop on delegate hires (off by default)', async () => {
      await setSettings({
        hireDelegates: [DELEGATE],
        noticeRoomId: noticeRoom,
        delegateWorkingRoot: dir,
        requireBudgetStopForDelegates: true,
      });
      expect((await hire('alpha', DELEGATE)).statusCode).toBe(400);
      expect(launches).toHaveLength(0);
      expect((await hire('alpha')).statusCode).toBe(200);
      const ok = await hire('alpha', DELEGATE, { budgetStop: { planId: 'plan-a', weeklyPercent: 80 } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.hire.budgetStop).toEqual({ planId: 'plan-a', weeklyPercent: 80 });
    });
  });

  it('refuses to save a template whose rooms do not all exist', async () => {
    await req('GET', '/api/experts');
    const before = await readFile(file, 'utf8');
    const res = await req('PUT', '/api/experts/alpha', { ...alpha, rooms: [sideRoom, 'no-such-room'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('no-such-room');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await req('PUT', '/api/experts/alpha', { ...alpha, rooms: [sideRoom] })).statusCode).toBe(200);
  });

  describe('budget stop', () => {
    const stop = { planId: 'plan-a', weeklyPercent: 80 };
    const setWeekly = (weeklyPercent: number | null, updatedAt = clock) => {
      plans = [{ id: 'plan-a', weeklyPercent, updatedAt }];
    };
    const noticeTexts = () => rooms.get(noticeRoom)!.messages.filter((m) => m.to === 'all').map((m) => m.text);
    const checkpoints = (sessionId: string) =>
      rooms
        .get(noticeRoom)!
        .messages.filter((m) => Array.isArray(m.to) && m.to.includes(sessionId))
        .map((m) => m.text);
    const hireWithStop = async () => {
      const res = await hire('alpha', undefined, { budgetStop: stop });
      expect(res.statusCode).toBe(200);
      return res.json().data as { sessionId: string; hire: { id: string } };
    };
    const record = async (id: string) => (await state()).hires.find((h: { id: string }) => h.id === id);

    beforeEach(async () => {
      await setSettings({ hireDelegates: [DELEGATE], noticeRoomId: noticeRoom, delegateWorkingRoot: dir });
      await req('PUT', '/api/experts/alpha', { ...alpha, rooms: [sideRoom] });
    });

    it('validates the budget stop at hire', async () => {
      expect((await hire('alpha', undefined, { budgetStop: { planId: 'nope', weeklyPercent: 80 } })).statusCode).toBe(400);
      expect((await hire('alpha', undefined, { budgetStop: { planId: 'plan-a', weeklyPercent: 0 } })).statusCode).toBe(400);
      expect((await hire('alpha', undefined, { budgetStop: { planId: 'plan-a', weeklyPercent: 101 } })).statusCode).toBe(400);
      expect((await hire('alpha', undefined, { budgetStop: { planId: 'plan-a' } })).statusCode).toBe(400);
      expect(launches).toHaveLength(0);
      // Plans unreadable at hire: accepted, and the hourly check reports it.
      plans = new Error('usage endpoint down');
      expect((await hire('alpha', undefined, { budgetStop: stop })).statusCode).toBe(200);
    });

    it('stores the stop, joins the notice room, and does not trigger below the threshold', async () => {
      const { sessionId, hire: h } = await hireWithStop();
      expect(await record(h.id)).toMatchObject({ budgetStop: stop });
      expect(rooms.get(noticeRoom)!.members.map((m) => m.sessionId)).toContain(sessionId);
      setWeekly(79.9);
      const result = await routes.checkBudgetStops(clock);
      expect(result).toEqual({ triggered: [], retired: [], unchecked: [], failed: [] });
      expect(checkpoints(sessionId)).toEqual([]);
      expect((await record(h.id)).budgetStop.triggeredAt).toBeUndefined();
    });

    it('triggers at the threshold: checkpoint request, notice, then retires after the grace', async () => {
      const { sessionId, hire: h } = await hireWithStop();
      setWeekly(80);
      const at = clock;
      expect((await routes.checkBudgetStops(at)).triggered).toEqual([h.id]);
      expect(checkpoints(sessionId)).toEqual([
        'Budget stop: save your work and write a handoff now; this session stops in 10 minutes.',
      ]);
      expect(noticeTexts().at(-1)).toContain('Budget stop triggered');
      expect(noticeTexts().at(-1)).toContain('the session was asked to save its work');
      expect(noticeTexts().at(-1)).not.toContain('NOT told');
      expect((await record(h.id)).budgetStop.triggeredAt).toBe(at);
      // Checking again during the grace neither repeats the request nor stops early.
      clock = at + 9 * MIN;
      setWeekly(95);
      expect(await routes.checkBudgetStops(clock)).toEqual({ triggered: [], retired: [], unchecked: [], failed: [] });
      expect(checkpoints(sessionId)).toHaveLength(1);
      expect(stopped).toEqual([]);
      clock = at + 10 * MIN;
      expect((await routes.checkBudgetStops(clock)).retired).toEqual([h.id]);
      expect(stopped).toEqual([sessionId]);
      expect(await record(h.id)).toMatchObject({ status: 'retired', retiredBy: 'budget-stop' });
      expect(audits.at(-1)).toMatchObject({ action: 'expert_retire', detail: expect.objectContaining({ by: 'budget-stop' }) });
      expect(noticeTexts().at(-1)).toContain('Expert retired');
      expect(noticeTexts().at(-1)).toContain('by budget-stop');
    });

    it('refuses at hire a stop the fresh plan reading has already reached; a stale one is accepted', async () => {
      setWeekly(85);
      const res = await hire('alpha', undefined, { budgetStop: stop });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('budgetStop: plan plan-a is already at 85% weekly');
      expect(launches).toHaveLength(0);
      setWeekly(85, clock - 3 * 60 * MIN);
      expect((await hire('alpha', undefined, { budgetStop: stop })).statusCode).toBe(200);
    });

    it.each([
      ['the message fails', false, 'pane closed'],
      ['there is no channel to the session', true, 'no channel to the session'],
    ])('says the session was NOT told when %s, and still retires after the grace', async (_label, noSend, reason) => {
      if (noSend) {
        await app.close();
        await build({ noSend: true });
      }
      sendFails = true;
      const { sessionId, hire: h } = await hireWithStop();
      setWeekly(90);
      const at = clock;
      expect((await routes.checkBudgetStops(at)).triggered).toEqual([h.id]);
      const text = noticeTexts().at(-1)!;
      expect(text).toContain(`the session was NOT told (${reason}); retiring anyway in 10 minutes.`);
      expect(text).not.toContain('was asked');
      expect(checkpoints(sessionId)).toEqual([]);
      clock = at + 10 * MIN;
      expect((await routes.checkBudgetStops(clock)).retired).toEqual([h.id]);
    });

    it('a retire whose save fails after the stop is retried by saving only, never stopping twice', async () => {
      const { sessionId, hire: h } = await hireWithStop();
      setWeekly(90);
      const at = clock;
      await routes.checkBudgetStops(at);
      const realUpdate = expertStore.update.bind(expertStore);
      let failSave = true;
      const updates = vi.spyOn(expertStore, 'update').mockImplementation((mutate) => {
        if (failSave) {
          failSave = false;
          return Promise.reject(new Error('disk full'));
        }
        return realUpdate(mutate);
      });
      clock = at + 10 * MIN;
      const pass = await routes.checkBudgetStops(clock);
      expect(pass.failed).toEqual([h.id]);
      expect(stopped).toEqual([sessionId]);
      expect(await record(h.id)).toMatchObject({ status: 'active' });
      expect(noticeTexts().at(-1)).toBe(`Budget stop could not retire session ${sessionId}: disk full; retrying hourly.`);
      clock += 60 * MIN;
      expect((await routes.checkBudgetStops(clock)).retired).toEqual([h.id]);
      expect(stopped).toEqual([sessionId]); // no second stopSession: the session is gone
      expect(await record(h.id)).toMatchObject({ status: 'retired', retiredBy: 'budget-stop' });
      updates.mockRestore();
    });

    it('a failing retire does not block the other hires, notices once an hour and is retried', async () => {
      const first = await hireWithStop();
      const second = await hireWithStop();
      setWeekly(90);
      const at = clock;
      expect((await routes.checkBudgetStops(at)).triggered).toEqual([first.hire.id, second.hire.id]);
      stopFails.add(first.sessionId);
      clock = at + 10 * MIN;
      const pass = await routes.checkBudgetStops(clock);
      expect(pass.retired).toEqual([second.hire.id]);
      expect(pass.failed).toEqual([first.hire.id]);
      expect(stopped).toEqual([second.sessionId]);
      const failNotices = () => noticeTexts().filter((t) => t.startsWith('Budget stop could not retire'));
      expect(failNotices()).toEqual([
        `Budget stop could not retire session ${first.sessionId}: tmux did not answer; retrying hourly.`,
      ]);
      expect(await record(first.hire.id)).toMatchObject({ status: 'active', budgetStop: { retireFailNoticeAt: clock } });
      clock += 30 * MIN;
      expect((await routes.checkBudgetStops(clock)).failed).toEqual([first.hire.id]);
      expect(failNotices()).toHaveLength(1);
      stopFails.clear();
      clock += 60 * MIN;
      expect((await routes.checkBudgetStops(clock)).retired).toEqual([first.hire.id]);
      expect(await record(first.hire.id)).toMatchObject({ status: 'retired', retiredBy: 'budget-stop' });
    });

    it('triggers above the threshold too', async () => {
      const { hire: h } = await hireWithStop();
      setWeekly(97.5);
      expect((await routes.checkBudgetStops(clock)).triggered).toEqual([h.id]);
    });

    it('resumes the countdown after a restart mid-grace', async () => {
      const { sessionId, hire: h } = await hireWithStop();
      setWeekly(85);
      const at = clock;
      await routes.checkBudgetStops(at);
      await app.close();
      await build(); // a fresh store reads the record from disk
      clock = at + 5 * MIN;
      expect(await routes.checkBudgetStops(clock)).toEqual({ triggered: [], retired: [], unchecked: [], failed: [] });
      expect(checkpoints(sessionId)).toHaveLength(1);
      expect(stopped).toEqual([]);
      clock = at + 10 * MIN;
      expect((await routes.checkBudgetStops(clock)).retired).toEqual([h.id]);
      expect(stopped).toEqual([sessionId]);
    });

    it('a stale reading gives a notice once a day and never stops the session', async () => {
      const { sessionId, hire: h } = await hireWithStop();
      setWeekly(99, clock - 2 * 60 * MIN - 1);
      expect((await routes.checkBudgetStops(clock)).unchecked).toEqual([h.id]);
      expect(noticeTexts().filter((t) => t.startsWith('Budget stop cannot be checked'))).toHaveLength(1);
      expect(noticeTexts().at(-1)).toContain('stale');
      clock += 60 * MIN;
      await routes.checkBudgetStops(clock);
      expect(noticeTexts().filter((t) => t.startsWith('Budget stop cannot be checked'))).toHaveLength(1);
      clock += 24 * 60 * MIN;
      await routes.checkBudgetStops(clock);
      expect(noticeTexts().filter((t) => t.startsWith('Budget stop cannot be checked'))).toHaveLength(2);
      expect(stopped).toEqual([]);
      expect(checkpoints(sessionId)).toEqual([]);
      expect(await record(h.id)).toMatchObject({ status: 'active' });
    });

    it('a missing reading (unreadable plans or no weekly figure) gives a notice and no stop', async () => {
      const { hire: h } = await hireWithStop();
      plans = new Error('usage endpoint down');
      expect((await routes.checkBudgetStops(clock)).unchecked).toEqual([h.id]);
      expect(noticeTexts().at(-1)).toContain('the plans cannot be read');
      clock += 25 * 60 * MIN;
      setWeekly(null);
      expect((await routes.checkBudgetStops(clock)).unchecked).toEqual([h.id]);
      expect(noticeTexts().at(-1)).toContain('no weekly reading');
      expect(stopped).toEqual([]);
      expect(await record(h.id)).toMatchObject({ status: 'active' });
    });
  });

  it('owner policy: reads and hire/retire are open to agents, changes are owner-only', () => {
    expect(classify('GET', '/api/experts', '/api/experts')).toBe('agent');
    expect(classify('GET', '/api/experts/:id', '/api/experts/alpha')).toBe('agent');
    expect(classify('POST', '/api/experts/:id/hire', '/api/experts/alpha/hire')).toBe('agent');
    expect(classify('POST', '/api/experts/:id/retire', '/api/experts/alpha/retire')).toBe('agent');
    expect(classify('PUT', '/api/experts/:id', '/api/experts/alpha')).toBe('owner');
    expect(classify('DELETE', '/api/experts/:id', '/api/experts/alpha')).toBe('owner');
    expect(classify('PUT', '/api/experts-settings', '/api/experts-settings')).toBe('owner');
  });
});
