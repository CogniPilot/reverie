/**
 * The server board: audited writes (audit before save, fail closed), who may write, nothing deleted, the import of the
 * pre-console board files, and the derived parts of GET /api/board (roster, polls, pins, pace).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBoardRoutes } from '../../src/web/routes/board-routes.js';
import { BoardStore } from '../../src/board-store.js';
import { paceOf, zonedMs, importSchedule } from '../../src/board-logic.js';
import type { ChatRoom } from '../../src/chatroom-store.js';
import type { Issue } from '../../src/board-types.js';

const NOW = Date.UTC(2026, 9, 17, 18, 0, 0); // 14:00 ET
const COORD = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEV = 'bbbbbbbb-0000-4000-8000-000000000002';
const STRANGER = 'cccccccc-0000-4000-8000-000000000003';

function room(over: Partial<ChatRoom> = {}): ChatRoom {
  return {
    id: 'r1',
    name: 'reverie',
    createdAt: 0,
    members: [
      { sessionId: COORD, role: 'coordinator', goal: '' },
      { sessionId: BEV, role: 'member', goal: '' },
    ],
    messages: [],
    ...over,
  } as unknown as ChatRoom;
}

describe('board routes', () => {
  let app: FastifyInstance;
  let dir: string;
  let store: BoardStore;
  let audit: Record<string, unknown>[];
  let auditFails: boolean;
  let rooms: ChatRoom[];
  let events: unknown[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-'));
    store = new BoardStore(join(dir, 'board.json'));
    await store.init();
    audit = [];
    auditFails = false;
    events = [];
    rooms = [room()];
    const sessions = new Map(
      [COORD, BEV, STRANGER].map((id) => [id, { id, owner: undefined, pid: 1, isWorking: id === BEV }] as const)
    );
    app = Fastify();
    registerBoardRoutes(app, { sessions, broadcast: (e: string, d: unknown) => events.push([e, d]) } as never, {
      store,
      company: () => ({
        employees: [
          { id: 'e-burt', name: 'Burt', sessionId: COORD },
          { id: 'e-bev', name: 'Bev', sessionId: BEV },
        ],
        settings: { timeZone: 'America/New_York', ownerName: 'James' },
      }),
      rooms: () => rooms,
      audit: async (entry) => {
        if (auditFails) throw new Error('disk full');
        audit.push(entry);
      },
      now: () => NOW,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (session?: string) => (session ? { 'x-codeman-parent-session': session } : {});
  const post = (url: string, payload: unknown, session?: string) => app.inject({ method: 'POST', url, payload: payload as object, headers: as(session) });
  const patch = (url: string, payload: unknown, session?: string) => app.inject({ method: 'PATCH', url, payload: payload as object, headers: as(session) });

  it('a member files into triage; the audit line is written before the save', async () => {
    const res = await post('/api/board/issues', { title: 'Mesa ICD noise', status: 'doing' }, BEV);
    expect(res.statusCode).toBe(200);
    const issue = res.json().data.item;
    expect(issue).toMatchObject({ status: 'triage', requester: 'e-bev' });
    expect(audit).toEqual([expect.objectContaining({ action: 'board-issue-add', by: 'e-bev', session: BEV, id: issue.id })]);
    expect(JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')).issues).toHaveLength(1);
    expect(events).toEqual([['board:changed', { rev: 1 }]]);
  });

  it('fails closed when the audit cannot be written: 500 and the board is unchanged', async () => {
    auditFails = true;
    const res = await post('/api/board/issues', { title: 'x' }, COORD);
    expect(res.statusCode).toBe(500);
    expect(store.snapshot()).toMatchObject({ rev: 0, issues: [] });
  });

  it('a header that is only a prefix, or an unknown session, is refused', async () => {
    expect((await post('/api/board/issues', { title: 'x' }, COORD.slice(0, 8))).statusCode).toBe(403);
    expect((await post('/api/board/issues', { title: 'x' }, 'dddddddd-0000-4000-8000-000000000009')).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });

  it('members edit only their own issues; coordinators edit all; done stamps doneAt', async () => {
    const id = (await post('/api/board/issues', { title: 'Keyframe suite', owner: 'e-bev' }, COORD)).json().data.item.id;
    expect((await patch(`/api/board/issues/${id}`, { status: 'doing' }, STRANGER)).statusCode).toBe(403);
    expect((await patch(`/api/board/issues/${id}`, { owner: 'e-burt' }, BEV)).statusCode).toBe(403);
    const done = await patch(`/api/board/issues/${id}`, { status: 'done' }, BEV);
    expect(done.json().data.item).toMatchObject({ status: 'done', doneAt: NOW });
    const reopened = await patch(`/api/board/issues/${id}`, { status: 'todo' }, COORD);
    expect(reopened.json().data.item.doneAt).toBeUndefined();
  });

  it('status-only PATCH preserves omitted metadata in the response and persisted board', async () => {
    const fields = {
      title: 'Hourly task',
      owner: 'e-bev',
      tags: ['release', 'phone'],
      scale: 'hour',
      start: NOW,
      end: NOW + 3600_000,
      links: [{ url: 'https://example.com/report', kind: 'report' }],
      source: { roomId: 'r1', messageId: 'request-1' },
    };
    const created = (await post('/api/board/issues', fields, COORD)).json().data.item;
    const updated = await patch(`/api/board/issues/${created.id}`, { status: 'doing' }, BEV);
    expect(updated.statusCode).toBe(200);
    const expected = { ...fields, id: created.id, status: 'doing' };
    expect(updated.json().data.item).toMatchObject(expected);
    expect(store.snapshot().issues[0]).toMatchObject(expected);
    expect(JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')).issues[0]).toMatchObject(expected);
    expect(audit.at(-1)).not.toHaveProperty('tags');
    expect(audit.at(-1)).not.toHaveProperty('scale');
  });

  it('PATCH accepts explicit empty tags and day scale without changing unrelated fields', async () => {
    const created = (
      await post(
        '/api/board/issues',
        {
          title: 'Hourly task',
          owner: 'e-bev',
          tags: ['release'],
          scale: 'hour',
          start: NOW,
          end: NOW + 3600_000,
        },
        COORD
      )
    ).json().data.item;
    const updated = await patch(`/api/board/issues/${created.id}`, { tags: [], scale: 'day' }, BEV);
    expect(updated.statusCode).toBe(200);
    expect(store.snapshot().issues[0]).toMatchObject({
      title: created.title,
      owner: created.owner,
      status: created.status,
      start: created.start,
      end: created.end,
      tags: [],
      scale: 'day',
    });
  });

  it('create keeps its defaults while empty PATCH is refused without a write', async () => {
    const created = (await post('/api/board/issues', { title: 'Defaults' }, COORD)).json().data.item;
    expect(created).toMatchObject({ tags: [], scale: 'day' });
    const before = store.snapshot();
    for (const body of [{}, { ifRev: before.rev }]) {
      const response = await patch(`/api/board/issues/${created.id}`, body, COORD);
      expect(response.statusCode).toBe(400);
      expect(store.snapshot()).toEqual(before);
      expect(audit).toHaveLength(1);
    }
  });

  it('the edit check uses the issue as it is at write time', async () => {
    const id = (await post('/api/board/issues', { title: 'x', owner: 'e-bev' }, COORD)).json().data.item.id;
    const [reassign, edit] = await Promise.all([patch(`/api/board/issues/${id}`, { owner: 'e-burt' }, COORD), patch(`/api/board/issues/${id}`, { title: 'mine' }, BEV)]);
    expect(reassign.statusCode).toBe(200);
    expect(edit.statusCode).toBe(403);
    expect(store.snapshot().issues[0].title).toBe('x');
  });

  it('wontdo and blocked need a reason', async () => {
    const id = (await post('/api/board/issues', { title: 'x' }, COORD)).json().data.item.id;
    expect((await patch(`/api/board/issues/${id}`, { status: 'wontdo' }, COORD)).statusCode).toBe(400);
    expect((await patch(`/api/board/issues/${id}`, { status: 'wontdo', reason: 'dup' }, COORD)).statusCode).toBe(200);
  });

  it('links are plain http(s) URLs', async () => {
    expect((await post('/api/board/issues', { title: 'x', links: [{ url: 'javascript:alert(1)' }] }, COORD)).statusCode).toBe(400);
    const ok = await post('/api/board/issues', { title: 'x', links: [{ url: 'https://github.com/a/b/pull/1' }] }, COORD);
    expect(ok.json().data.item.links).toEqual([{ url: 'https://github.com/a/b/pull/1', kind: 'other' }]);
  });

  it('a stale ifRev is a 409', async () => {
    await post('/api/board/issues', { title: 'a' }, COORD);
    expect((await post('/api/board/issues', { title: 'b', ifRev: 0 }, COORD)).statusCode).toBe(409);
    expect((await post('/api/board/issues', { title: 'b', ifRev: 1 }, COORD)).statusCode).toBe(200);
  });

  it('blockers and decisions are lead-only and cleared, never deleted', async () => {
    expect((await post('/api/board/blockers', { who: 'All', owner: 'James', text: 'bot' }, BEV)).statusCode).toBe(403);
    const id = (await post('/api/board/blockers', { who: 'All', owner: 'James', text: 'bot' }, COORD)).json().data.item.id;
    const cleared = await post(`/api/board/blockers/${id}/clear`, {}, COORD);
    expect(cleared.json().data.item).toMatchObject({ clearedAt: NOW, clearedBy: 'e-burt' });
    expect(store.snapshot().blockers).toHaveLength(1);
    expect((await post(`/api/board/blockers/${id}/clear`, {}, COORD)).statusCode).toBe(409);
  });

  it('a member sets only its own focus', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/board/agents/e-burt', payload: { focus: 'x' }, headers: as(BEV) })).statusCode).toBe(403);
    const res = await app.inject({ method: 'PUT', url: '/api/board/agents/e-bev', payload: { focus: 'suite', receipts: ['r1'] }, headers: as(BEV) });
    expect(res.json().data.item).toMatchObject({ focus: 'suite', receipts: ['r1'], updatedBy: 'e-bev' });
  });

  it('GET derives roster, open polls, pins and pace (planBurn null without a plan source)', async () => {
    rooms = [
      room({
        messages: [
          { id: 'm1', roomId: 'r1', at: 1, from: { kind: 'user', name: 'James' }, to: 'all', text: 'pick', poll: { question: 'pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], votes: { user: ['a'] } } },
          { id: 'm2', roomId: 'r1', at: 2, from: { kind: 'user', name: 'James' }, to: 'all', text: 'old', poll: { question: 'old', options: [], votes: {}, closed: { at: 3, by: 'user' } } },
          { id: 'm3', roomId: 'r1', at: 4, from: { kind: 'user', name: 'James' }, to: 'all', text: 'rule', pinned: { at: 5, by: 'Burt', kind: 'agent' } },
        ],
      } as Partial<ChatRoom>),
      room({ id: 'r2', name: 'old', archivedAt: 1, messages: [{ id: 'm9', roomId: 'r2', at: 1, from: { kind: 'user', name: 'J' }, to: 'all', text: 'gone', pinned: { at: 9, by: 'x', kind: 'user' } }] } as Partial<ChatRoom>),
    ];
    await post('/api/board/issues', { title: 'late', owner: 'e-bev', start: NOW - 7200_000, end: NOW - 3600_000 }, COORD);
    const view = (await app.inject({ method: 'GET', url: '/api/board' })).json().data;
    expect(view.roster).toEqual([
      expect.objectContaining({ id: 'e-burt', state: 'idle', coordinator: true }),
      expect.objectContaining({ id: 'e-bev', state: 'running', coordinator: false }),
    ]);
    expect(view.polls).toEqual([expect.objectContaining({ messageId: 'm1', createdAt: 1, options: [{ id: 'a', label: 'A', votes: 1 }, { id: 'b', label: 'B', votes: 0 }] })]);
    expect(view.pins).toEqual([expect.objectContaining({ messageId: 'm3', by: 'Burt' })]);
    expect(view.pace.owners['e-bev']).toMatchObject({ plannedToDate: 1, overdue: 1, overdueHours: 1, verdict: 'behind' });
    expect(view.planBurn).toBeNull();
    expect(view.timeZone).toBe('America/New_York');
  });

  it('GET /api/board/waiting counts open decisions and open polls the owner has not voted on', async () => {
    rooms = [
      room({
        messages: [
          { id: 'm1', roomId: 'r1', at: 1, from: { kind: 'user', name: 'James' }, to: 'all', text: 'p', poll: { question: 'pick', options: [{ id: 'a', label: 'A' }], votes: {} } },
          { id: 'm2', roomId: 'r1', at: 2, from: { kind: 'user', name: 'James' }, to: 'all', text: 'p', poll: { question: 'voted', options: [{ id: 'a', label: 'A' }], votes: { user: ['a'] } } },
        ],
      } as Partial<ChatRoom>),
    ];
    await post('/api/board/decisions', { id: 'd-one', text: 'ship it?' }, COORD);
    const res = await app.inject({ method: 'GET', url: '/api/board/waiting' });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body).toMatchObject({ count: 2, decisions: 1, polls: 1 });
    expect(body.items.map((i: { key: string }) => i.key).sort()).toEqual(['d-one', 'r1:m1']);
  });

  it('resolves legacy owner names for display and pace without rewriting ownership or granting edit rights', async () => {
    const issue = (id: string, fields: Partial<Issue>): Issue => ({id, title:id, status:'todo', tags:[], links:[], start:NOW-7200000, end:NOW-3600000, createdAt:1, updatedAt:1, ...fields});
    const issues = [
      issue('stable', {owner:'e-bev', status:'done', doneAt:NOW-3600000}),
      issue('label', {ownerLabel:'  bEV  '}),
      issue('literal', {owner:'BEV'}),
      issue('explicit', {owner:'e-burt', ownerLabel:'Bev'}),
      issue('owner-label', {ownerLabel:'James'}),
      issue('sleep-label', {ownerLabel:'Sleep'}),
    ];
    await store.update({}, state => {state.issues=issues;});
    const before=JSON.stringify(store.snapshot());
    const view=(await app.inject({method:'GET',url:'/api/board'})).json().data;
    expect(view.ownerIds).toEqual({stable:'e-bev',label:'e-bev',literal:'e-bev',explicit:'e-burt'});
    expect(view.issues).toEqual(issues);
    expect(view.pace.owners['e-bev']).toMatchObject({plannedToDate:3,doneOfPlanned:1,overdue:2});
    expect(view.pace.owners.BEV).toBeUndefined();
    expect(view.pace.owners['  bEV  ']).toBeUndefined();
    expect(view.pace.owners.James.overdue).toBe(1);
    expect(view.pace.owners.Sleep.overdue).toBe(1);
    expect((await patch('/api/board/issues/label',{status:'doing'},BEV)).statusCode).toBe(403);
    expect(JSON.stringify(store.snapshot())).toBe(before);
    expect(audit).toEqual([]);
  });

  it('imports schedule-data.json and content.json idempotently, keeping unmatched names', async () => {
    const schedule = {
      today: { date: '2026-10-17', rows: [{ who: 'Bev', blocks: [[13.0, 14.0, 'Smoke test', 'done'], [14.0, 15.0, 'Suite', 'now']] }], marks: [[17.08, 'check-ins']] },
      twoweek: { rows: [{ who: 'Stan', bars: [['2026-10-18', '2026-10-19', 'Resume', 'gate']] }] },
    };
    const content = {
      plans: { 'claude tertiary': { name: 'Claude Tertiary', who: 'Otto' } },
      agents: [{ who: 'Burt', focus: 'Board', receipts: ['a'] }],
      wins: [{ at: '2026-10-17T14:02', who: 'James', text: 'Board' }, { at: '2026-10-16', who: 'Bev', text: 'Date only' }],
      blockers: [{ since: '2026-10-17T13:18', who: 'All', owner: 'James', sev: 'med', text: 'bot' }],
      decisions: [{ id: 'resume', text: 'Resume Stan', where: 'console' }],
    };
    expect((await post('/api/board/import', { schedule }, BEV)).statusCode).toBe(403);
    const dry = (await post('/api/board/import', { schedule, content, dryRun: true }, COORD)).json().data;
    expect(dry.item).toMatchObject({ issues: 3, marks: 1, wins: 2, unmatched: ['Stan'] });
    expect(store.snapshot().rev).toBe(0);
    await post('/api/board/import', { schedule, content }, COORD);
    await post('/api/board/import', { schedule, content }, COORD);
    const s = store.snapshot();
    expect(s.issues).toHaveLength(3);
    expect(s.wins).toHaveLength(2);
    expect(s.issues.find((i) => i.title === 'Smoke test')).toMatchObject({ owner: 'e-bev', status: 'done', scale: 'hour', start: Date.UTC(2026, 9, 17, 17), doneAt: Date.UTC(2026, 9, 17, 18) });
    expect(s.issues.find((i) => i.title === 'Resume')).toMatchObject({ ownerLabel: 'Stan', status: 'todo', tags: ['gate'], scale: 'day' });
    expect(s.wins.map((w) => w.at)).toEqual([Date.UTC(2026, 9, 17, 18, 2), Date.UTC(2026, 9, 16, 4)]);
    expect(s.agents['e-burt']).toMatchObject({ focus: 'Board' });
    expect(s.marks).toHaveLength(1);
  });
});

describe('board logic', () => {
  it('zonedMs follows the zone across the DST change', () => {
    expect(zonedMs('2026-10-17', 14, 'America/New_York')).toBe(Date.UTC(2026, 9, 17, 18));
    expect(zonedMs('2026-11-02', 14, 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 19));
  });

  it('pace: early finishes are ahead, overdue is behind, otherwise on track', () => {
    const base = { title: 't', tags: [], links: [], scale: 'day' as const, createdAt: 0, updatedAt: 0 };
    const early: Issue = { ...base, id: 'a', status: 'done', end: 100, doneAt: 50 };
    const late: Issue = { ...base, id: 'b', status: 'doing', end: 100 };
    const future: Issue = { ...base, id: 'c', status: 'todo', end: 500 };
    expect(paceOf([early, future], 200).verdict).toBe('ahead');
    expect(paceOf([early, late], 200)).toMatchObject({ plannedToDate: 2, doneOfPlanned: 1, overdue: 1, verdict: 'behind' });
    expect(paceOf([future], 200).verdict).toBe('on-track');
  });

  it('day bars span 07:00 to 22:00 like build_board.py', () => {
    const { issues } = importSchedule({ twoweek: { rows: [{ who: 'X', bars: [['2026-10-18', '2026-10-18', 'L', 'plan']] }] } }, () => undefined, 'America/New_York', 0);
    expect(issues[0]).toMatchObject({ start: Date.UTC(2026, 9, 18, 11), end: Date.UTC(2026, 9, 19, 2) });
  });

  it('names each plan by its account label, never by a board note name, and carries the account ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-plans-'));
    const store = new BoardStore(join(dir, 'board.json'));
    await store.init();
    await store.update({}, (st) => {
      st.plans = { Work: { name: 'Old note name', who: 'Bev' } };
    });
    const pace = { weekly: 40, burnPerHour: 1, projected: 80, weekStart: NOW - 86400_000, weekReset: NOW + 86400_000, runsOutAt: null, burnBasis: 'average', remainingPct: 60, hoursToReset: 24, sustainablePctPerHour: 2.5 };
    const rows = [
      { id: 'p-1', label: 'Work', provider: 'anthropic', profileId: 'p-1', acctName: null, isDefault: false, signedIn: true, updatedAt: NOW, pace },
      { id: 'acct-openai-spare', label: 'spare', provider: 'openai', profileId: null, acctName: 'spare', isDefault: false, signedIn: false, updatedAt: NOW, pace },
    ];
    const own = Fastify();
    registerBoardRoutes(own, { sessions: new Map(), broadcast: () => {} } as never, {
      store,
      company: () => ({ employees: [], settings: { timeZone: 'America/New_York', ownerName: 'James' } }),
      rooms: () => [],
      audit: async () => {},
      plans: async () => rows as never,
      now: () => NOW,
    });
    await own.ready();
    try {
      const burn = (await own.inject({ method: 'GET', url: '/api/board' })).json().data.planBurn;
      expect(burn.map((b: { name: string }) => b.name)).toEqual(['Work', 'spare']);
      expect(burn[0]).toMatchObject({ id: 'p-1', profileId: 'p-1', provider: 'anthropic', isDefault: false, label: 'Work', who: 'Bev', used: 40 });
      expect(burn[1]).toMatchObject({ id: 'acct-openai-spare', profileId: null, who: '' });
      expect(JSON.stringify(burn)).not.toContain('Old note name');
    } finally {
      await own.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
