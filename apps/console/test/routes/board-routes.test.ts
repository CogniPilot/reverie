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
const JORDAN = 'bbbbbbbb-0000-4000-8000-000000000002';
const STRANGER = 'cccccccc-0000-4000-8000-000000000003';

function room(over: Partial<ChatRoom> = {}): ChatRoom {
  return {
    id: 'r1',
    name: 'reverie',
    createdAt: 0,
    members: [
      { sessionId: COORD, role: 'coordinator', goal: '' },
      { sessionId: JORDAN, role: 'member', goal: '' },
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
      [COORD, JORDAN, STRANGER].map((id) => [id, { id, owner: undefined, pid: 1, isWorking: id === JORDAN }] as const)
    );
    app = Fastify();
    registerBoardRoutes(app, { sessions, broadcast: (e: string, d: unknown) => events.push([e, d]) } as never, {
      store,
      company: () => ({
        employees: [
          { id: 'e-avery', name: 'Avery', sessionId: COORD },
          { id: 'e-jordan', name: 'Jordan', sessionId: JORDAN },
        ],
        settings: { timeZone: 'America/New_York', ownerName: 'Robin' },
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
    const res = await post('/api/board/issues', { title: 'Mesa ICD noise', status: 'doing' }, JORDAN);
    expect(res.statusCode).toBe(200);
    const issue = res.json().data.item;
    expect(issue).toMatchObject({ status: 'triage', requester: 'e-jordan' });
    expect(audit).toEqual([expect.objectContaining({ action: 'board-issue-add', by: 'e-jordan', session: JORDAN, id: issue.id })]);
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
    const id = (await post('/api/board/issues', { title: 'Keyframe suite', owner: 'e-jordan' }, COORD)).json().data.item.id;
    expect((await patch(`/api/board/issues/${id}`, { status: 'doing' }, STRANGER)).statusCode).toBe(403);
    expect((await patch(`/api/board/issues/${id}`, { owner: 'e-avery' }, JORDAN)).statusCode).toBe(403);
    const done = await patch(`/api/board/issues/${id}`, { status: 'done' }, JORDAN);
    expect(done.json().data.item).toMatchObject({ status: 'done', doneAt: NOW });
    const reopened = await patch(`/api/board/issues/${id}`, { status: 'todo' }, COORD);
    expect(reopened.json().data.item.doneAt).toBeUndefined();
  });

  it('the edit check uses the issue as it is at write time', async () => {
    const id = (await post('/api/board/issues', { title: 'x', owner: 'e-jordan' }, COORD)).json().data.item.id;
    const [reassign, edit] = await Promise.all([patch(`/api/board/issues/${id}`, { owner: 'e-avery' }, COORD), patch(`/api/board/issues/${id}`, { title: 'mine' }, JORDAN)]);
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
    expect((await post('/api/board/blockers', { who: 'All', owner: 'Robin', text: 'bot' }, JORDAN)).statusCode).toBe(403);
    const id = (await post('/api/board/blockers', { who: 'All', owner: 'Robin', text: 'bot' }, COORD)).json().data.item.id;
    const cleared = await post(`/api/board/blockers/${id}/clear`, {}, COORD);
    expect(cleared.json().data.item).toMatchObject({ clearedAt: NOW, clearedBy: 'e-avery' });
    expect(store.snapshot().blockers).toHaveLength(1);
    expect((await post(`/api/board/blockers/${id}/clear`, {}, COORD)).statusCode).toBe(409);
  });

  it('a member sets only its own focus', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/board/agents/e-avery', payload: { focus: 'x' }, headers: as(JORDAN) })).statusCode).toBe(403);
    const res = await app.inject({ method: 'PUT', url: '/api/board/agents/e-jordan', payload: { focus: 'suite', receipts: ['r1'] }, headers: as(JORDAN) });
    expect(res.json().data.item).toMatchObject({ focus: 'suite', receipts: ['r1'], updatedBy: 'e-jordan' });
  });

  it('GET derives roster, open polls, pins and pace (planBurn null without a plan source)', async () => {
    rooms = [
      room({
        messages: [
          { id: 'm1', roomId: 'r1', at: 1, from: { kind: 'user', name: 'Robin' }, to: 'all', text: 'pick', poll: { question: 'pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], votes: { user: ['a'] } } },
          { id: 'm2', roomId: 'r1', at: 2, from: { kind: 'user', name: 'Robin' }, to: 'all', text: 'old', poll: { question: 'old', options: [], votes: {}, closed: { at: 3, by: 'user' } } },
          { id: 'm3', roomId: 'r1', at: 4, from: { kind: 'user', name: 'Robin' }, to: 'all', text: 'rule', pinned: { at: 5, by: 'Avery', kind: 'agent' } },
        ],
      } as Partial<ChatRoom>),
      room({ id: 'r2', name: 'old', archivedAt: 1, messages: [{ id: 'm9', roomId: 'r2', at: 1, from: { kind: 'user', name: 'J' }, to: 'all', text: 'gone', pinned: { at: 9, by: 'x', kind: 'user' } }] } as Partial<ChatRoom>),
    ];
    await post('/api/board/issues', { title: 'late', owner: 'e-jordan', start: NOW - 7200_000, end: NOW - 3600_000 }, COORD);
    const view = (await app.inject({ method: 'GET', url: '/api/board' })).json().data;
    expect(view.roster).toEqual([
      expect.objectContaining({ id: 'e-avery', state: 'idle', coordinator: true }),
      expect.objectContaining({ id: 'e-jordan', state: 'running', coordinator: false }),
    ]);
    expect(view.polls).toEqual([expect.objectContaining({ messageId: 'm1', createdAt: 1, options: [{ id: 'a', label: 'A', votes: 1 }, { id: 'b', label: 'B', votes: 0 }] })]);
    expect(view.pins).toEqual([expect.objectContaining({ messageId: 'm3', by: 'Avery' })]);
    expect(view.pace.owners['e-jordan']).toMatchObject({ plannedToDate: 1, overdue: 1, overdueHours: 1, verdict: 'behind' });
    expect(view.planBurn).toBeNull();
    expect(view.timeZone).toBe('America/New_York');
  });

  it('imports schedule-data.json and content.json idempotently, keeping unmatched names', async () => {
    const schedule = {
      today: { date: '2026-10-17', rows: [{ who: 'Jordan', blocks: [[13.0, 14.0, 'Smoke test', 'done'], [14.0, 15.0, 'Suite', 'now']] }], marks: [[17.08, 'check-ins']] },
      twoweek: { rows: [{ who: 'Blake', bars: [['2026-10-18', '2026-10-19', 'Resume', 'gate']] }] },
    };
    const content = {
      plans: { 'claude globex': { name: 'Claude Globex', who: 'Morgan' } },
      agents: [{ who: 'Avery', focus: 'Board', receipts: ['a'] }],
      wins: [{ at: '2026-10-17T14:02', who: 'Robin', text: 'Board' }, { at: '2026-10-16', who: 'Jordan', text: 'Date only' }],
      blockers: [{ since: '2026-10-17T13:18', who: 'All', owner: 'Robin', sev: 'med', text: 'bot' }],
      decisions: [{ id: 'resume', text: 'Resume Blake', where: 'console' }],
    };
    expect((await post('/api/board/import', { schedule }, JORDAN)).statusCode).toBe(403);
    const dry = (await post('/api/board/import', { schedule, content, dryRun: true }, COORD)).json().data;
    expect(dry.item).toMatchObject({ issues: 3, marks: 1, wins: 2, unmatched: ['Blake'] });
    expect(store.snapshot().rev).toBe(0);
    await post('/api/board/import', { schedule, content }, COORD);
    await post('/api/board/import', { schedule, content }, COORD);
    const s = store.snapshot();
    expect(s.issues).toHaveLength(3);
    expect(s.wins).toHaveLength(2);
    expect(s.issues.find((i) => i.title === 'Smoke test')).toMatchObject({ owner: 'e-jordan', status: 'done', scale: 'hour', start: Date.UTC(2026, 9, 17, 17), doneAt: Date.UTC(2026, 9, 17, 18) });
    expect(s.issues.find((i) => i.title === 'Resume')).toMatchObject({ ownerLabel: 'Blake', status: 'todo', tags: ['gate'], scale: 'day' });
    expect(s.wins.map((w) => w.at)).toEqual([Date.UTC(2026, 9, 17, 18, 2), Date.UTC(2026, 9, 16, 4)]);
    expect(s.agents['e-avery']).toMatchObject({ focus: 'Board' });
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
});
