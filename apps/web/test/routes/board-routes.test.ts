import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
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
import type { BoardView, Issue } from '../../src/board-types.js';

const NOW = Date.UTC(2026, 9, 17, 18, 0, 0); // 14:00 ET
const COORD = '0000002d-0035-4000-8000-000000000047';
const BUILDER = '00000038-0043-4000-8000-000000000060';
const STRANGER = '0000003e-004c-4000-8000-00000000006f';

function room(over: Partial<ChatRoom> = {}): ChatRoom {
  return {
    id: 'r1',
    name: 'reverie',
    createdAt: 0,
    members: [
      { sessionId: COORD, role: 'coordinator', goal: '' },
      { sessionId: BUILDER, role: 'member', goal: '' },
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
      [COORD, BUILDER, STRANGER].map((id) => [id, { id, owner: undefined, pid: 1, isWorking: id === BUILDER }] as const)
    );
    app = Fastify();
    registerBoardRoutes(app, { sessions, broadcast: (e: string, d: unknown) => events.push([e, d]) } as never, { ...({
      structuredDecisionWrites: true,
      store,
      company: () => ({
        employees: [
          { id: 'e-reviewer', name: 'Reviewer', sessionId: COORD },
          { id: 'e-builder', name: 'Builder', sessionId: BUILDER },
        ],
        settings: { timeZone: 'America/New_York', ownerName: 'Owner' },
      }),
      rooms: () => rooms,
      audit: async (entry) => {
        if (auditFails) throw new Error('disk full');
        audit.push(entry);
      },
      now: () => NOW,
    }), verifiedOwner: trustedFixtureOwner });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (session?: string) => (session ? { 'x-reverie-parent-session': session } : {});
  const post = (url: string, payload: unknown, session?: string) => app.inject({ method: 'POST', url, payload: payload as object, headers: as(session) });
  const patch = (url: string, payload: unknown, session?: string) => app.inject({ method: 'PATCH', url, payload: payload as object, headers: as(session) });

  it('requires explicit distinct choices and validates named recommendations', async () => {
    for (const options of [undefined, [], ['Yes'], ['Yes', 'yes'], ['', 'No']]) {
      const res = await post('/api/board/decisions', { text: 'Publish?', ...(options ? { options } : {}) }, COORD);
      expect(res.statusCode).toBe(400);
    }
    expect((await post('/api/board/decisions', { text: 'Publish?', options: ['Yes', 'No'], recommendation: { option: 'Maybe' } }, COORD)).statusCode).toBe(400);
    expect(store.snapshot().decisions).toHaveLength(0);
    expect(audit).toEqual([]);
    const response = await post('/api/board/decisions', { id: 'publish', text: 'Publish?', options: ['Approve', 'Hold', 'Reject'], recommendation: { option: 'approve', reason: 'Checks passed', by: 'Forged' } }, COORD);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.item).toMatchObject({ options: ['Approve', 'Hold', 'Reject'], recommendation: { option: 'Approve', by: 'Reviewer' } });
  });

  it('only an owner records a valid choice, persisted and audited exactly once', async () => {
    await post('/api/board/decisions', { id: 'publish', text: 'Publish?', options: ['Approve', 'Hold'] }, COORD);
    for (const session of [COORD, BUILDER]) expect((await post('/api/board/decisions/publish/choose', { option: 'Approve' }, session)).statusCode).toBe(403);
    expect((await post('/api/board/decisions/publish/choose', { option: 'Not provided' })).statusCode).toBe(400);
    expect((await post('/api/board/decisions/publish/choose', { option: 'Hold', ifRev: 0 })).statusCode).toBe(409);
    const result = await post('/api/board/decisions/publish/choose', { option: 'Hold', ifRev: store.snapshot().rev });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.item).toMatchObject({ chosen: 'Hold', clearedAt: NOW, clearedBy: 'owner' });
    expect((await post('/api/board/decisions/publish/choose', { option: 'Approve' })).statusCode).toBe(409);
    const reloaded = new BoardStore(join(dir, 'board.json')); await reloaded.init();
    expect(reloaded.snapshot().decisions[0].chosen).toBe('Hold');
    expect(audit.filter(row => row.action === 'board-decision-choose')).toEqual([expect.objectContaining({ by: 'owner', option: 'Hold' })]);
  });

  it('repairs a legacy card without replacing its identity or inventing a decision', async () => {
    await store.update({}, state => { state.decisions.push({ id: 'legacy', text: 'Old prose-only question', where: 'office', at: 1 }); });
    const result = await patch('/api/board/decisions/legacy', { options: ['Approve', 'Hold'], recommendation: { option: 'Hold' } }, COORD);
    expect(result.statusCode).toBe(200);
    expect(store.snapshot().decisions[0]).toMatchObject({ id: 'legacy', at: 1, options: ['Approve', 'Hold'] });
    expect(store.snapshot().decisions[0].chosen).toBeUndefined();
    await post('/api/board/decisions/legacy/choose', { option: 'Hold' });
    expect((await patch('/api/board/decisions/legacy', { options: ['Other', 'Choices'] }, COORD)).statusCode).toBe(409);
    for (const payload of [{ chosen: 'Approve' }, { clearedBy: 'Forged owner' }, { clearedAt: 1 }])
      expect((await patch('/api/board/decisions/legacy', payload, COORD)).statusCode).toBe(400);
    await post('/api/board/import', { content: { decisions: [{ id: 'legacy', text: 'Imported updated prose' }] } });
    expect(store.snapshot().decisions[0]).toMatchObject({ chosen: 'Hold', options: ['Approve', 'Hold'], clearedBy: 'owner' });
  });

  it('cannot bypass required choices by importing a new prose-only decision', async () => {
    const response = await post('/api/board/import', { content: { decisions: [{ id: 'bad', text: 'Approve or Hold?' }] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('needs 2–10 options');
    expect(store.snapshot().decisions).toEqual([]);
  });

  it('a member files into triage; the audit line is written before the save', async () => {
    const res = await post('/api/board/issues', { title: 'Mesa ICD noise', status: 'doing' }, BUILDER);
    expect(res.statusCode).toBe(200);
    const issue = res.json().data.item;
    expect(issue).toMatchObject({ status: 'triage', requester: 'e-builder' });
    expect(audit).toEqual([expect.objectContaining({ action: 'board-issue-add', by: 'e-builder', session: BUILDER, id: issue.id })]);
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
    expect((await post('/api/board/issues', { title: 'x' }, '00000043-0053-4000-8000-00000000007b')).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });

  it('members edit only their own issues; coordinators edit all; done stamps doneAt', async () => {
    const id = (await post('/api/board/issues', { title: 'Keyframe suite', owner: 'e-builder' }, COORD)).json().data.item.id;
    expect((await patch(`/api/board/issues/${id}`, { status: 'doing' }, STRANGER)).statusCode).toBe(403);
    expect((await patch(`/api/board/issues/${id}`, { owner: 'e-reviewer' }, BUILDER)).statusCode).toBe(403);
    const done = await patch(`/api/board/issues/${id}`, { status: 'done' }, BUILDER);
    expect(done.json().data.item).toMatchObject({ status: 'done', doneAt: NOW });
    const reopened = await patch(`/api/board/issues/${id}`, { status: 'todo' }, COORD);
    expect(reopened.json().data.item.doneAt).toBeUndefined();
  });

  it('status-only PATCH preserves omitted metadata in the response and persisted board', async () => {
    const fields = {
      title: 'Hourly task',
      owner: 'e-builder',
      tags: ['release', 'phone'],
      scale: 'hour',
      start: NOW,
      end: NOW + 3600_000,
      links: [{ url: 'https://example.com/report', kind: 'report' }],
      source: { roomId: 'r1', messageId: 'request-1' },
    };
    const created = (await post('/api/board/issues', fields, COORD)).json().data.item;
    const updated = await patch(`/api/board/issues/${created.id}`, { status: 'doing' }, BUILDER);
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
          owner: 'e-builder',
          tags: ['release'],
          scale: 'hour',
          start: NOW,
          end: NOW + 3600_000,
        },
        COORD
      )
    ).json().data.item;
    const updated = await patch(`/api/board/issues/${created.id}`, { tags: [], scale: 'day' }, BUILDER);
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
    const id = (await post('/api/board/issues', { title: 'x', owner: 'e-builder' }, COORD)).json().data.item.id;
    const [reassign, edit] = await Promise.all([patch(`/api/board/issues/${id}`, { owner: 'e-reviewer' }, COORD), patch(`/api/board/issues/${id}`, { title: 'mine' }, BUILDER)]);
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
    expect((await post('/api/board/blockers', { who: 'All', owner: 'Owner', text: 'bot' }, BUILDER)).statusCode).toBe(403);
    const id = (await post('/api/board/blockers', { who: 'All', owner: 'Owner', text: 'bot' }, COORD)).json().data.item.id;
    const cleared = await post(`/api/board/blockers/${id}/clear`, {}, COORD);
    expect(cleared.json().data.item).toMatchObject({ clearedAt: NOW, clearedBy: 'e-reviewer' });
    expect(store.snapshot().blockers).toHaveLength(1);
    expect((await post(`/api/board/blockers/${id}/clear`, {}, COORD)).statusCode).toBe(409);
  });

  it('a member sets only its own focus', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/board/agents/e-reviewer', payload: { focus: 'x' }, headers: as(BUILDER) })).statusCode).toBe(403);
    const res = await app.inject({ method: 'PUT', url: '/api/board/agents/e-builder', payload: { focus: 'suite', receipts: ['r1'] }, headers: as(BUILDER) });
    expect(res.json().data.item).toMatchObject({ focus: 'suite', receipts: ['r1'], updatedBy: 'e-builder' });
  });

  it('GET derives roster, open polls, pins and pace (planBurn null without a plan source)', async () => {
    rooms = [
      room({
        messages: [
          { id: 'm1', roomId: 'r1', at: 1, from: { kind: 'user', name: 'Owner' }, to: 'all', text: 'pick', poll: { question: 'pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], votes: { user: ['a'] } } },
          { id: 'm2', roomId: 'r1', at: 2, from: { kind: 'user', name: 'Owner' }, to: 'all', text: 'old', poll: { question: 'old', options: [], votes: {}, closed: { at: 3, by: 'user' } } },
          { id: 'm3', roomId: 'r1', at: 4, from: { kind: 'user', name: 'Owner' }, to: 'all', text: 'rule', pinned: { at: 5, by: 'Reviewer', kind: 'agent' } },
        ],
      } as Partial<ChatRoom>),
      room({ id: 'r2', name: 'old', archivedAt: 1, messages: [{ id: 'm9', roomId: 'r2', at: 1, from: { kind: 'user', name: 'J' }, to: 'all', text: 'gone', pinned: { at: 9, by: 'x', kind: 'user' } }] } as Partial<ChatRoom>),
    ];
    await post('/api/board/issues', { title: 'late', owner: 'e-builder', start: NOW - 7200_000, end: NOW - 3600_000 }, COORD);
    const view = (await app.inject({ method: 'GET', url: '/api/board' })).json().data;
    expect(view.roster).toEqual([
      expect.objectContaining({ id: 'e-reviewer', state: 'idle', coordinator: true }),
      expect.objectContaining({ id: 'e-builder', state: 'running', coordinator: false }),
    ]);
    expect(view.polls).toEqual([expect.objectContaining({ messageId: 'm1', createdAt: 1, options: [{ id: 'a', label: 'A', votes: 1 }, { id: 'b', label: 'B', votes: 0 }] })]);
    expect(view.pins).toEqual([expect.objectContaining({ messageId: 'm3', by: 'Reviewer' })]);
    expect(view.pace.owners['e-builder']).toMatchObject({ plannedToDate: 1, overdue: 1, overdueHours: 1, verdict: 'behind' });
    expect(view.planBurn).toBeNull();
    expect(view.timeZone).toBe('America/New_York');
  });

  it('GET /api/board/waiting counts open decisions and open polls the owner has not voted on', async () => {
    rooms = [
      room({
        messages: [
          { id: 'm1', roomId: 'r1', at: 1, from: { kind: 'user', name: 'Owner' }, to: 'all', text: 'p', poll: { question: 'pick', options: [{ id: 'a', label: 'A' }], votes: {} } },
          { id: 'm2', roomId: 'r1', at: 2, from: { kind: 'user', name: 'Owner' }, to: 'all', text: 'p', poll: { question: 'voted', options: [{ id: 'a', label: 'A' }], votes: { user: ['a'] } } },
        ],
      } as Partial<ChatRoom>),
    ];
    await post('/api/board/decisions', { id: 'd-one', text: 'ship it?', options: ['Ship', 'Hold'] }, COORD);
    const res = await app.inject({ method: 'GET', url: '/api/board/waiting' });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body).toMatchObject({ count: 2, decisions: 1, polls: 1 });
    expect(body.items.map((i: { key: string }) => i.key).sort()).toEqual(['d-one', 'r1:m1']);
  });

  describe('room authorization', () => {
    beforeEach(async () => {
      rooms = [
        room({ id: 'r1', members: [{ sessionId: BUILDER, role: 'member', goal: '' }] }),
        room({ id: 'r2', members: [{ sessionId: COORD, role: 'coordinator', goal: '' }] }),
        room({ id: 'r3', archivedAt: 1 }),
      ];
      for (const r of rooms) {
        r.messages = [{
          id: 'm1', roomId: r.id, at: 1, from: { kind: 'user', name: 'Owner' }, to: 'all',
          text: `Pin in ${r.id}`, pinned: { at: 1, by: 'Owner', kind: 'user' },
          poll: { question: `Poll in ${r.id}`, options: [{ id: 'a', label: 'A' }], votes: { [BUILDER]: ['a'] } },
        }];
      }
      await store.update({}, (s) => {
        for (const id of ['r1', 'r2', 'r3', 'missing-room']) {
          s.pollNotes[`${id}:m1`] = { summary: `Note in ${id}`, updatedAt: 1, updatedBy: 'owner' };
        }
      });
      await post('/api/board/decisions', { id: 'd-shared', text: 'Shared decision', options: ['Proceed', 'Hold'] });
    });

    it.each([
      { kind: 'owner', session: undefined, ids: ['r1', 'r2'] },
      { kind: 'member', session: BUILDER, ids: ['r1'] },
      { kind: 'owner-made coordinator', session: COORD, ids: ['r2'] },
      { kind: 'non-member', session: STRANGER, ids: [] },
    ])('$kind sees only permitted pins, polls, notes and waiting counts', async ({ session, ids }) => {
      const res = await app.inject({ method: 'GET', url: '/api/board', headers: as(session) });
      expect(res.statusCode).toBe(200);
      const view = res.json().data as BoardView;
      expect(view.pins.map((p) => p.roomId).sort()).toEqual(ids);
      expect(view.polls.map((p) => p.roomId).sort()).toEqual(ids);
      expect(view.polls.every((p) => p.options[0].votes === 1)).toBe(true);
      expect(Object.keys(view.pollNotes).sort()).toEqual(
        session ? ids.map((id) => `${id}:m1`) : ['missing-room:m1', 'r1:m1', 'r2:m1', 'r3:m1']
      );
      const waiting = await app.inject({ method: 'GET', url: '/api/board/waiting', headers: as(session) });
      expect(waiting.statusCode).toBe(200);
      expect(waiting.json().data).toMatchObject({ count: ids.length + 1, decisions: 1, polls: ids.length });
      expect(waiting.json().data.items.map((i: { key: string }) => i.key).sort()).toEqual(['d-shared', ...ids.map((id) => `${id}:m1`)]);
    });

    it('a removed employee member immediately loses pins, polls, notes and waiting items', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/board', headers: as(BUILDER) })).json().data.pins).toHaveLength(1);
      rooms[0].members = [];
      const view = (await app.inject({ method: 'GET', url: '/api/board', headers: as(BUILDER) })).json().data;
      expect(view).toMatchObject({ pins: [], polls: [], pollNotes: {} });
      expect((await app.inject({ method: 'GET', url: '/api/board/waiting', headers: as(BUILDER) })).json().data)
        .toMatchObject({ count: 1, polls: 0, items: [{ key: 'd-shared' }] });
    });

    it('filters non-member and archived rooms before accessing their messages', async () => {
      for (const r of rooms.slice(1)) {
        Object.defineProperty(r, 'messages', { get: () => { throw new Error('Excluded room content accessed'); } });
      }
      for (const url of ['/api/board', '/api/board/waiting']) {
        const res = await app.inject({ method: 'GET', url, headers: as(BUILDER) });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  it.each([
    { kind: 'owner-made coordinator', addedBy: undefined, archivedAt: undefined, status: 200 },
    { kind: 'self-made coordinator', addedBy: COORD, archivedAt: undefined, status: 403 },
    { kind: 'another employee-made coordinator', addedBy: BUILDER, archivedAt: undefined, status: 403 },
    { kind: 'archived owner-made coordinator', addedBy: undefined, archivedAt: 1, status: 403 },
  ])('$kind foreign-issue edit returns $status', async ({ addedBy, archivedAt, status }) => {
    const id = (await post('/api/board/issues', { title: 'Foreign issue', owner: 'e-builder' })).json().data.item.id;
    rooms = [room({ archivedAt, members: [{ sessionId: COORD, role: 'coordinator', goal: '', addedBy }] })];
    const before = store.snapshot();
    const persisted = readFileSync(store.file, 'utf8');
    const auditCount = audit.length;
    const eventCount = events.length;
    const res = await patch(`/api/board/issues/${id}`, { status: 'doing' }, COORD);
    expect(res.statusCode).toBe(status);
    if (status === 403) {
      expect(store.snapshot()).toEqual(before);
      expect(readFileSync(store.file, 'utf8')).toBe(persisted);
      expect(audit).toHaveLength(auditCount);
      expect(events).toHaveLength(eventCount);
    } else {
      expect(store.snapshot().issues[0]).toMatchObject({ id, owner: 'e-builder', status: 'doing' });
    }
    const view = (await app.inject({ method: 'GET', url: '/api/board' })).json().data as BoardView;
    expect(view.roster.find((r) => r.id === 'e-reviewer')?.coordinator).toBe(status === 200);
  });

  it('resolves legacy owner names for display and pace without rewriting ownership or granting edit rights', async () => {
    const issue = (id: string, fields: Partial<Issue>): Issue => ({id, title:id, status:'todo', tags:[], links:[], start:NOW-7200000, end:NOW-3600000, createdAt:1, updatedAt:1, ...fields});
    const issues = [
      issue('stable', {owner:'e-builder', status:'done', doneAt:NOW-3600000}),
      issue('label', {ownerLabel:'  Builder  '}),
      issue('literal', {owner:'BUILDER'}),
      issue('explicit', {owner:'e-reviewer', ownerLabel:'Builder'}),
      issue('owner-label', {ownerLabel:'Owner'}),
      issue('sleep-label', {ownerLabel:'Sleep'}),
    ];
    await store.update({}, state => {state.issues=issues;});
    const before=JSON.stringify(store.snapshot());
    const view=(await app.inject({method:'GET',url:'/api/board'})).json().data;
    expect(view.ownerIds).toEqual({stable:'e-builder',label:'e-builder',literal:'e-builder',explicit:'e-reviewer'});
    expect(view.issues).toEqual(issues);
    expect(view.pace.owners['e-builder']).toMatchObject({plannedToDate:3,doneOfPlanned:1,overdue:2});
    expect(view.pace.owners.BUILDER).toBeUndefined();
    expect(view.pace.owners['  Builder  ']).toBeUndefined();
    expect(view.pace.owners.Owner.overdue).toBe(1);
    expect(view.pace.owners.Sleep.overdue).toBe(1);
    expect((await patch('/api/board/issues/label',{status:'doing'},BUILDER)).statusCode).toBe(403);
    expect(JSON.stringify(store.snapshot())).toBe(before);
    expect(audit).toEqual([]);
  });

  it('imports schedule-data.json and content.json idempotently, keeping unmatched names', async () => {
    const schedule = {
      today: { date: '2026-10-17', rows: [{ who: 'Builder', blocks: [[13.0, 14.0, 'Smoke test', 'done'], [14.0, 15.0, 'Suite', 'now']] }], marks: [[17.08, 'check-ins']] },
      twoweek: { rows: [{ who: 'Verifier', bars: [['2026-10-18', '2026-10-19', 'Resume', 'gate']] }] },
    };
    const content = {
      plans: { 'claude tertiary': { name: 'Claude tertiary', who: 'Coordinator' } },
      agents: [{ who: 'Reviewer', focus: 'Board', receipts: ['a'] }],
      wins: [{ at: '2026-10-17T14:02', who: 'Owner', text: 'Board' }, { at: '2026-10-16', who: 'Builder', text: 'Date only' }],
      blockers: [{ since: '2026-10-17T13:18', who: 'All', owner: 'Owner', sev: 'med', text: 'bot' }],
      decisions: [{ id: 'resume', text: 'Resume Verifier', where: 'console', options: ['Resume', 'Hold'] }],
    };
    expect((await post('/api/board/import', { schedule }, BUILDER)).statusCode).toBe(403);
    const dry = (await post('/api/board/import', { schedule, content, dryRun: true }, COORD)).json().data;
    expect(dry.item).toMatchObject({ issues: 3, marks: 1, wins: 2, unmatched: ['Verifier'] });
    expect(store.snapshot().rev).toBe(0);
    await post('/api/board/import', { schedule, content }, COORD);
    await post('/api/board/import', { schedule, content }, COORD);
    const s = store.snapshot();
    expect(s.issues).toHaveLength(3);
    expect(s.wins).toHaveLength(2);
    expect(s.issues.find((i) => i.title === 'Smoke test')).toMatchObject({ owner: 'e-builder', status: 'done', scale: 'hour', start: Date.UTC(2026, 9, 17, 17), doneAt: Date.UTC(2026, 9, 17, 18) });
    expect(s.issues.find((i) => i.title === 'Resume')).toMatchObject({ ownerLabel: 'Verifier', status: 'todo', tags: ['gate'], scale: 'day' });
    expect(s.wins.map((w) => w.at)).toEqual([Date.UTC(2026, 9, 17, 18, 2), Date.UTC(2026, 9, 16, 4)]);
    expect(s.agents['e-reviewer']).toMatchObject({ focus: 'Board' });
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
      st.plans = { Work: { name: 'Old note name', who: 'Builder' } };
    });
    const pace = { fiveHour: 25, fiveHourReset: NOW + 7200000, weekly: 40, burnPerHour: 1, projected: 80, weekStart: NOW - 86400_000, weekReset: NOW + 86400_000, runsOutAt: null, burnBasis: 'average', remainingPct: 60, hoursToReset: 24, sustainablePctPerHour: 2.5 };
    const rows = [
      { id: 'p-1', label: 'Work', provider: 'anthropic', profileId: 'p-1', acctName: null, isDefault: false, signedIn: true, updatedAt: NOW, usageAsOf: NOW - 60000, usageStale: false, pace },
      { id: 'acct-openai-spare', label: 'spare', provider: 'openai', profileId: null, acctName: 'spare', isDefault: false, signedIn: false, updatedAt: NOW, pace: { ...pace, fiveHour: null, fiveHourReset: null }, bankedResets: { availableCount: 2, earliestExpiresAt: NOW + 5 } },
    ];
    const own = Fastify();
    registerBoardRoutes(own, { sessions: new Map(), broadcast: () => {} } as never, { ...({
      store,
      company: () => ({ employees: [], settings: { timeZone: 'America/New_York', ownerName: 'Owner' } }),
      rooms: () => [],
      audit: async () => {},
      plans: async () => rows as never,
      now: () => NOW,
    }), verifiedOwner: trustedFixtureOwner });
    await own.ready();
    try {
      const burn = (await own.inject({ method: 'GET', url: '/api/board' })).json().data.planBurn;
      expect(burn.map((b: { name: string }) => b.name)).toEqual(['Work', 'spare']);
      expect(burn[0]).toMatchObject({ id: 'p-1', profileId: 'p-1', provider: 'anthropic', isDefault: false, label: 'Work', who: 'Builder', used: 40 });
      expect(burn[1]).toMatchObject({ id: 'acct-openai-spare', profileId: null, who: '', banked: { count: 2, expiresAt: NOW + 5 } });
      expect(burn[0].fiveHour).toEqual({ used: 25, reset: NOW + 7200000, asOf: NOW - 60000, stale: false });
      expect(burn[1].fiveHour).toEqual({ used: null, reset: null, asOf: null, stale: false });
      expect(burn[0].banked).toBeNull();
      expect(JSON.stringify(burn)).not.toContain('Old note name');
    } finally {
      await own.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
