/**
 * Employee pronouns (card i-f5b288f8): an optional one-line field on the employee record that only the owner sets
 * (PUT /api/company/employees/:id, null clears it). An agent can neither set them on itself (/api/company/self stays
 * name and icon) nor on anyone else; `reverie agent profile --pronouns` only posts a proposal line in the room, which
 * remains a chat message. Room views and `agent chat who` carry them where known; editing uses the owner profile form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendAdminAudit } from '../src/web/admin-audit.js';

vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: vi.fn(async () => {}) }));
import Fastify, { type FastifyInstance } from 'fastify';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { registerCompanyRoutes } from '../src/web/routes/company-routes.js';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { CompanyStateSchema, EmployeeSchema } from '../src/company-types.js';
import { pronounsProposal } from '../src/pronouns.js';
import { agentChatWho, agentProfile, type AgentDeps, type ApiResponse, type RequestOptions } from '../src/cli-agent.js';
import { createMockSession } from './mocks/index.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { agent, createHarness, member, message, room } from './helpers/chat-app-harness.mjs';

const record = {
  id: 'emp-1',
  name: 'Maya',
  icon: '🌱',
  position: 'Scientist',
  expertise: ['biology'],
  sessionId: 'expert-session',
  researchEnabled: true,
  createdAt: 1,
};

describe('the pronouns field on the employee record', () => {
  it('is optional, round-trips when set, and is trimmed', () => {
    expect(EmployeeSchema.parse(record)).not.toHaveProperty('pronouns');
    expect(EmployeeSchema.parse({ ...record, pronouns: 'she/her' }).pronouns).toBe('she/her');
    expect(EmployeeSchema.parse({ ...record, pronouns: '  they/them ' }).pronouns).toBe('they/them');
    expect(EmployeeSchema.parse({ ...record, pronouns: 'x'.repeat(24) }).pronouns).toHaveLength(24);
  });

  it('refuses empty, 25 characters, control characters and a second line', () => {
    for (const bad of [
      '',
      '   ',
      'x'.repeat(25),
      'she\nher',
      'she\u0007her',
      'she\u2028her',
      'he\u0000',
      'she\u202Eher',
      'he\u200B',
      7,
    ]) {
      expect(EmployeeSchema.safeParse({ ...record, pronouns: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a company.json written before the field loads unchanged, retired rows included; retired rows take it too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reverie-pronouns-old-'));
    try {
      const file = join(dir, 'company.json');
      const old = {
        version: 1,
        employees: [record],
        settings: [],
        cycles: [],
        memories: [],
        temporaryAgents: [],
        retired: [{ ...record, id: 'emp-0', sessionId: 'gone', retiredAt: 5 }],
      };
      await writeFile(file, JSON.stringify(old));
      const store = new CompanyStore(file);
      await store.init();
      expect(store.snapshot().employees).toEqual([{ ...record, onVacation: false, sleepEnabled: false, dreamEnabled: false, permissions: { recoverEmployees: false, moveOwnPlan: false, managePlans: false }, wakeAttempts: [] }]);
      expect(store.snapshot().retired[0]).not.toHaveProperty('pronouns');
      expect(
        CompanyStateSchema.parse({ ...old, retired: [{ ...old.retired[0], pronouns: 'he/him' }] }).retired[0].pronouns
      ).toBe('he/him');
      expect(
        CompanyStateSchema.safeParse({ ...old, retired: [{ ...old.retired[0], pronouns: 'x'.repeat(25) }] }).success
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('who may set pronouns', () => {
  let app: FastifyInstance;
  let directory: string;
  let file: string;
  let service: CompanyService;
  let id: string;

  beforeEach(async () => {
    vi.mocked(appendAdminAudit).mockClear();
    directory = await mkdtemp(join(tmpdir(), 'reverie-pronouns-routes-'));
    file = join(directory, 'company.json');
    const store = new CompanyStore(file);
    await store.init();
    const rooms = new ChatroomStore();
    const sessions = new Map([
      ['expert-session', { id: 'expert-session', name: 'Expert' }],
      ['parent-session', { id: 'parent-session', name: 'Parent' }],
    ]);
    service = new CompanyService(store, {
      getSession: (sid) => sessions.get(sid),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (rid) => rooms.get(rid),
        addMember: (rid, sessionId, options) => rooms.addMember(rid, sessionId, options).member,
        removeMember: (rid, sessionId) => rooms.removeMember(rid, sessionId),
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    app = Fastify();
    registerCompanyRoutes(app, { sessions } as unknown as SessionPort, service);
    installRouteErrorHandler(app);
    await app.ready();
    const { id: _id, createdAt: _at, ...hire } = record;
    void _id;
    void _at;
    id = (await service.hire({ ...hire, sessionId: 'expert-session' })).id;
    await service.hire({ ...hire, name: 'Parent', sessionId: 'parent-session' });
    vi.mocked(appendAdminAudit).mockClear();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const put = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: `/api/company/employees/${id}`, payload: payload as object, headers });
  const maya = () => service.view().employees.find((e) => e.id === id)!;

  it('the owner sets them (audited from/to), changes them, and clears them with null', async () => {
    const set = await put({ pronouns: ' she/her ' });
    expect(set.statusCode).toBe(200);
    expect(set.json().data.employee.pronouns).toBe('she/her');
    expect(maya().pronouns).toBe('she/her');
    expect(JSON.parse(await readFile(file, 'utf8')).employees.find((e: { id: string }) => e.id === id).pronouns).toBe(
      'she/her'
    );
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'employee_update',
        admin: 'owner',
        detail: expect.objectContaining({ fields: ['pronouns'], pronouns: { from: null, to: 'she/her' } }),
      })
    );
    await put({ pronouns: 'they/them', position: 'Lead scientist' });
    expect(maya()).toMatchObject({ pronouns: 'they/them', position: 'Lead scientist' });
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ pronouns: { from: 'she/her', to: 'they/them' } }) })
    );
    const cleared = await put({ pronouns: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.employee).not.toHaveProperty('pronouns');
    expect(maya()).not.toHaveProperty('pronouns');
    expect(
      JSON.parse(await readFile(file, 'utf8')).employees.find((e: { id: string }) => e.id === id)
    ).not.toHaveProperty('pronouns');
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ pronouns: { from: 'they/them', to: null } }) })
    );
    // An edit that leaves them alone says nothing about them.
    await put({ position: 'Scientist' });
    expect(vi.mocked(appendAdminAudit).mock.lastCall?.[0].detail).not.toHaveProperty('pronouns');
  });

  it('refuses invalid pronouns without a change or an audit line', async () => {
    for (const pronouns of ['', '  ', 'x'.repeat(25), 'a\nb', 'a\u001bb', 3, ['she']]) {
      expect((await put({ pronouns })).statusCode, JSON.stringify(pronouns)).toBe(400);
    }
    expect(maya()).not.toHaveProperty('pronouns');
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('refuses any agent header (its own record or another), leaving company.json byte for byte', async () => {
    await put({ pronouns: 'she/her' });
    vi.mocked(appendAdminAudit).mockClear();
    const before = await readFile(file, 'utf8');
    for (const header of ['parent-session', 'expert-session', 'stale-session', '']) {
      for (const pronouns of ['he/him', null]) {
        const res = await put({ pronouns }, { 'x-reverie-parent-session': header });
        expect(res.statusCode).toBe(403);
      }
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('an agent cannot set them through its own profile route', async () => {
    const before = await readFile(file, 'utf8');
    for (const payload of [{ pronouns: 'she/her' }, { name: 'Maya', pronouns: 'she/her' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/company/self',
        payload,
        headers: { 'x-reverie-parent-session': 'expert-session' },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('agent profile --pronouns posts the proposal in the room and writes nothing', async () => {
    const before = await readFile(file, 'utf8');
    const forwarded: RequestOptions[] = [];
    const calls: RequestOptions[] = [];
    const out: string[] = [];
    const d: AgentDeps = {
      ctx: { apiUrl: 'http://127.0.0.1:1', selfId: 'expert-session' },
      json: false,
      io: { out: (l) => void out.push(l), err: () => undefined },
      request: async (_c, options): Promise<ApiResponse> => {
        calls.push(options);
        if (options.method === 'GET' && options.path === '/api/v1/chatrooms') {
          const rooms = [
            {
              id: 'room-1',
              name: 'Lab',
              members: [{ sessionId: 'expert-session', name: 'Maya', role: 'agent', goal: '', progress: '' }],
            },
          ];
          return { status: 200, text: '', json: { success: true, data: { rooms, ownerNames: ['Owner'] } } };
        }
        if (options.method === 'POST' && options.path === '/api/v1/chatrooms/room-1/messages') {
          return { status: 200, text: '', json: { success: true, data: { message: {} } } };
        }
        // Anything else would be a write attempt: send it to the real company routes as this agent.
        forwarded.push(options);
        const res = await app.inject({
          method: options.method as 'POST',
          url: options.path.replace('/api/v1/', '/api/'),
          payload: options.body as object,
          headers: { 'x-reverie-parent-session': 'expert-session' },
        });
        return { status: res.statusCode, text: res.body, json: res.json() };
      },
    };
    expect(await agentProfile(d, { pronouns: ' she/her ' })).toBe(0);
    expect(forwarded).toEqual([]);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ text: 'Maya proposes pronouns: she/her (@Owner can set them on my member card)' });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(maya()).not.toHaveProperty('pronouns');

    // Checked before any request: too long, two lines, or mixed with a real profile change.
    calls.length = 0;
    expect(await agentProfile(d, { pronouns: 'x'.repeat(25) })).not.toBe(0);
    expect(await agentProfile(d, { pronouns: 'she\nher' })).not.toBe(0);
    expect(await agentProfile(d, { pronouns: '' })).not.toBe(0);
    expect(await agentProfile(d, { pronouns: 'she/her', name: 'May' })).not.toBe(0);
    expect(calls).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

describe('pronouns in the room member list', () => {
  let directory: string;
  let chatrooms: ChatroomService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-pronouns-rooms-'));
  });
  afterEach(async () => {
    await chatrooms?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("a room view carries an employee's pronouns on its member, and nothing for one without", async () => {
    const sessions = new Map(['alpha-session', 'beta-session'].map((id) => [id, createMockSession(id)] as const));
    chatrooms = new ChatroomService({
      file: join(directory, 'chatrooms.json'),
      getSession: (id) => sessions.get(id) as never,
      broadcast: () => undefined,
      pronounsOf: (id) => (id === 'alpha-session' ? 'she/her' : undefined),
    });
    await chatrooms.init();
    const lab = chatrooms.createRoom('Lab', undefined);
    chatrooms.addMember(lab.id, 'alpha-session', {});
    chatrooms.addMember(lab.id, 'beta-session', {});
    const members = chatrooms.view(chatrooms.room(lab.id)!).members;
    expect(members.find((m) => m.sessionId === 'alpha-session')?.pronouns).toBe('she/her');
    expect(members.find((m) => m.sessionId === 'beta-session')).not.toHaveProperty('pronouns');
    // A view only: the stored membership never holds them.
    expect(chatrooms.room(lab.id)!.members.find((m) => m.sessionId === 'alpha-session')).not.toHaveProperty('pronouns');
  });

  it("agent chat who prints a member's pronouns (your own too) and no line where none are set", async () => {
    const out: string[] = [];
    const rooms = [
      {
        id: 'room-aaaa',
        name: 'Lab',
        members: [
          { sessionId: 'me-session', name: 'Ada', role: 'agent', goal: '', progress: '', pronouns: 'she/her' },
          { sessionId: 'other-session', name: 'Linus', role: 'agent', goal: '', progress: '' },
        ],
      },
    ];
    const d: AgentDeps = {
      ctx: { apiUrl: 'http://127.0.0.1:1', selfId: 'me-session' },
      json: false,
      io: { out: (l) => void out.push(l), err: () => undefined },
      request: async () => ({ status: 200, text: '', json: { success: true, data: { rooms } } }),
    };
    expect(await agentChatWho(d, { room: 'Lab' })).toBe(0);
    const text = out.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
    expect(text).toMatch(/"Ada" \(you\).*\n {4}pronouns: "she\/her"/);
    expect(text.match(/pronouns: /g)).toHaveLength(1);
  });
});

describe('the member card helpers (chat-app.js)', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-app.js'), 'utf8'), context);
  const fn = <T>(name: string) => vm.runInContext(name, context) as T;
  const proposalOf = fn<(messages: unknown, sessionId: string) => string>('caPronounsProposal');
  const pronounsBySession = fn<(company: unknown) => Map<string, string>>('caProfilePronouns');
  const from = (sessionId: string, text: string, extra = {}) => ({
    from: { kind: 'agent', sessionId, name: 'Maya' },
    text,
    ...extra,
  });

  it("reads the line the CLI writes, the latest one, and only from that member's own agent message", () => {
    const line = (p: string) => pronounsProposal('Maya', p, '@Owner');
    expect(proposalOf([from('s1', line('she/her'))], 's1')).toBe('she/her');
    expect(proposalOf([from('s1', line('she/her')), from('s1', line('they (them)'))], 's1')).toBe('they (them)');
    expect(proposalOf([from('s1', pronounsProposal('Maya', 'xe/xem', '@owner'))], 's1')).toBe('xe/xem');
    expect(proposalOf([from('s2', line('he/him'))], 's1')).toBe('');
    expect(proposalOf([{ from: { kind: 'user', name: 'user' }, text: line('he/him') }], 's1')).toBe('');
    expect(proposalOf([from('s1', line('she/her'), { deleted: { at: 1 } })], 's1')).toBe('');
    expect(
      proposalOf(
        [from('s1', `Maya proposes pronouns: ${'x'.repeat(25)} (@Owner can set them on my member card)`)],
        's1'
      )
    ).toBe('');
    expect(proposalOf([from('s1', 'I think Maya proposes pronouns: she/her soon')], 's1')).toBe('');
    expect(proposalOf([from('s1', line('she\u202Eher'))], 's1')).toBe(''); // an invisible bidi override is no offer
    expect(proposalOf(undefined, 's1')).toBe('');
  });

  it('maps sessions to the pronouns on their employee records', () => {
    const map = pronounsBySession({
      employees: [{ sessionId: 's1', pronouns: 'she/her' }, { sessionId: 's2' }, { sessionId: 's3', pronouns: ' ' }],
    });
    expect([...map.entries()]).toEqual([['s1', 'she/her']]);
    expect(pronounsBySession(undefined).size).toBe(0);
  });
});

describe('the member card', () => {
  const A = '00000026-002d-4000-8000-00000000003c';
  const B = '00000035-0040-4000-8000-00000000005c';
  const sessions = [
    { id: A, name: 'alpha', mode: 'claude' },
    { id: B, name: 'bravo', mode: 'opencode' },
  ];
  const company = () => ({
    settings: { ownerName: 'Owner' },
    employees: [
      {
        id: 'emp-a',
        sessionId: A,
        name: 'alpha',
        icon: '🌱',
        position: 'Engineer',
        expertise: ['x'],
        pronouns: 'she/her',
      },
      { id: 'emp-b', sessionId: B, name: 'bravo', icon: '🦊', position: 'Analyst', expertise: ['y'] },
    ],
  });
  const rooms = () => [
    room('r1', 'General', [member(A, 'alpha'), member(B, 'bravo')], {
      messages: [
        message(
          'm1',
          'r1',
          agent(B, 'bravo'),
          'bravo proposes pronouns: they/them (@Owner can set them on my member card)',
          1000
        ),
      ],
    }),
  ];
  const open = (h: Awaited<ReturnType<typeof createHarness>>, sessionId: string) => {
    (h.document.querySelector(`.ca-member[data-key="member:${sessionId}"]`) as HTMLButtonElement).click();
    return h.document.querySelector('.ca-profile') as HTMLElement;
  };
  const buttons = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>('.ca-profile-actions button')];

  it('shows position and pronouns under the name, and the pronouns on the member row', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), company: company() });
    const row = h.document.querySelector(`.ca-member[data-key="member:${A}"]`) as HTMLElement;
    expect(row.title).toBe('alpha (she/her)');
    expect(row.getAttribute('aria-label')).toContain('alpha (she/her)');
    const card = open(h, A);
    expect(card.querySelector('.ca-profile-who')?.textContent).toBe('Engineer · she/her');
    expect(buttons(card).map((b) => b.textContent)).not.toContain('Pronouns');
    // No proposal from alpha: no Set button.
    expect(buttons(card).some((b) => b.textContent?.startsWith('Set '))).toBe(false);
  });

  it('keeps proposals in chat without offering pronoun selection in the popover', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), company: company() });
    const puts: Array<{ path: string; body: unknown }> = [];
    const handle = h.server.handle;
    h.server.handle = async (path: string, opts: { method?: string; body?: { pronouns?: string | null } } = {}) => {
      const m = String(path).match(/^\/api\/company\/employees\/([^/]+)$/);
      if (m && opts.method === 'PUT') {
        puts.push({ path, body: opts.body });
        const e = h.server.company.employees.find((x: { id: string }) => x.id === decodeURIComponent(m[1]));
        if (opts.body?.pronouns === null) delete e.pronouns;
        else e.pronouns = opts.body?.pronouns;
        return { ok: true, status: 200, json: async () => ({ success: true, data: { employee: e } }) };
      }
      return handle(path, opts);
    };
    const card = open(h, B);
    expect(card.querySelector('.ca-profile-who')?.textContent).toBe('Analyst');
    expect(buttons(card).some((b) => b.textContent === 'Pronouns' || b.textContent?.startsWith('Set '))).toBe(false);
    expect(puts).toEqual([]);
    expect(h.shell.room.messages.some((entry: { text: string }) => entry.text.includes('proposes pronouns: they/them'))).toBe(true);
  });

  it('shows no pronoun actions to an agent viewing the page', async () => {
    const h = await createHarness({ sessions, rooms: rooms(), company: company() });
    h.app._chatSelf = A;
    const card = open(h, B);
    expect(buttons(card).some((b) => b.textContent === 'Pronouns' || b.textContent?.startsWith('Set '))).toBe(false);
  });
});
