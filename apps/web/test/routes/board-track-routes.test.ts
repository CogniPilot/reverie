import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * POST /api/board/issues/:id/track: a PR card's track record. Who may write which part (any member reviews in its own
 * name; heads, bodies and gates are the card owner's or a lead's), the reviewer's name taken from the caller and never
 * the body, the record's rules enforced on the server, and every change audited.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBoardRoutes } from '../../src/web/routes/board-routes.js';
import { BoardStore } from '../../src/board-store.js';
import type { ChatRoom } from '../../src/chatroom-store.js';

const NOW = Date.UTC(2026, 10, 3, 7, 0, 0);
const LEAD = '0000002d-0035-4000-8000-000000000047';
const AUTHOR = '00000038-0043-4000-8000-000000000060';
const REVIEWER = '00000043-0053-4000-8000-00000000007b';
const STRANGER = '0000003e-004c-4000-8000-00000000006f';
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const BODY = '1'.repeat(64);

describe('board track route', () => {
  let app: FastifyInstance;
  let dir: string;
  let store: BoardStore;
  let audit: Record<string, unknown>[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-track-'));
    store = new BoardStore(join(dir, 'board.json'));
    await store.init();
    audit = [];
    const room = {
      id: 'r1',
      name: 'work',
      createdAt: 0,
      members: [
        { sessionId: LEAD, role: 'coordinator', goal: '' },
        { sessionId: AUTHOR, role: 'member', goal: '' },
        { sessionId: REVIEWER, role: 'member', goal: '' },
      ],
      messages: [],
    } as unknown as ChatRoom;
    const sessions = new Map([LEAD, AUTHOR, REVIEWER, STRANGER].map((id) => [id, { id, owner: undefined, pid: 1 }] as const));
    app = Fastify();
    registerBoardRoutes(app, { sessions, broadcast: () => {} } as never, {
      structuredDecisionWrites: true,
      store,
      company: () => ({
        employees: [
          { id: 'e-lead', name: 'Lead', sessionId: LEAD },
          { id: 'e-author', name: 'Author', sessionId: AUTHOR },
          { id: 'e-reviewer', name: 'Reviewer', sessionId: REVIEWER },
        ],
        settings: { timeZone: 'America/New_York', ownerName: 'Owner' },
      }),
      rooms: () => [room],
      audit: async (entry: Record<string, unknown>) => void audit.push(entry),
      now: () => NOW,
      verifiedOwner: trustedFixtureOwner,
    } as never);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (session: string) => ({ 'x-reverie-parent-session': session });
  const card = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/board/issues', payload: { title: 'PR', owner: 'e-author', status: 'doing' }, headers: as(LEAD) });
    expect(res.statusCode).toBe(200);
    return res.json().data.item.id as string;
  };
  const track = (id: string, payload: object, session: string) =>
    app.inject({ method: 'POST', url: `/api/board/issues/${id}/track`, payload, headers: as(session) });

  it('the author records the head, a reviewer reviews in its own name, and an unapproved body is flagged', async () => {
    const id = await card();
    expect((await track(id, { op: 'head', sha: HEAD, branch: 'feature' }, AUTHOR)).statusCode).toBe(200);
    const go = await track(id, { op: 'review', head: HEAD, kind: 'text', verdict: 'GO', bodySha256: BODY, by: 'Someone else' }, REVIEWER);
    // The body carries no `by`: the reviewer's name comes from the caller.
    expect(go.statusCode).toBe(400);
    expect((await track(id, { op: 'review', head: HEAD, kind: 'text', verdict: 'GO', bodySha256: BODY }, REVIEWER)).statusCode).toBe(200);
    const wrong = await track(id, { op: 'applied', bodySha256: '2'.repeat(64) }, LEAD);
    expect(wrong.json().data.item.track.applied.at(-1)).toMatchObject({ approved: false, by: 'Lead' });
    const right = await track(id, { op: 'applied', bodySha256: BODY }, LEAD);
    expect(right.json().data.item.track.applied.at(-1)).toMatchObject({ approved: true });
    expect(right.json().data.item.track.reviews[0]).toMatchObject({ by: 'Reviewer', head: HEAD, bodySha256: BODY });
    expect(audit.filter((a) => a.action === 'board-issue-track').map((a) => a.op)).toEqual(['head', 'review', 'applied', 'applied']);
    const board = (await app.inject({ url: '/api/board', headers: as(REVIEWER) })).json().data;
    expect(board.issues.find((i: { id: string }) => i.id === id).track.branch).toBe('feature');
  });

  it('a new head supersedes the earlier GO, and a review of the old head is refused', async () => {
    const id = await card();
    await track(id, { op: 'head', sha: HEAD }, AUTHOR);
    await track(id, { op: 'review', head: HEAD, kind: 'source', verdict: 'GO' }, REVIEWER);
    const next = await track(id, { op: 'head', sha: NEXT }, AUTHOR);
    expect(next.json().data.item.track.reviews[0].supersededAt).toBe(NOW);
    const stale = await track(id, { op: 'review', head: HEAD, kind: 'source', verdict: 'GO' }, REVIEWER);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain('latest head');
  });

  it('only the card owner or a lead records heads, bodies and gates; a non-employee writes nothing', async () => {
    const id = await card();
    expect((await track(id, { op: 'head', sha: HEAD }, REVIEWER)).statusCode).toBe(403);
    expect((await track(id, { op: 'head', sha: HEAD }, LEAD)).statusCode).toBe(200);
    expect((await track(id, { op: 'gate', name: 'nix test registration', state: 'covered' }, REVIEWER)).statusCode).toBe(403);
    expect((await track(id, { op: 'applied', bodySha256: BODY }, REVIEWER)).statusCode).toBe(403);
    expect((await track(id, { op: 'gate', name: 'nix test registration', state: 'covered' }, AUTHOR)).statusCode).toBe(200);
    expect((await track(id, { op: 'review', head: HEAD, kind: 'source', verdict: 'GO' }, STRANGER)).statusCode).toBe(403);
    const record = (await app.inject({ url: '/api/board', headers: as(LEAD) })).json().data.issues.find((i: { id: string }) => i.id === id).track;
    expect(record.heads[0].gates).toEqual([expect.objectContaining({ name: 'nix test registration', state: 'covered', by: 'Author' })]);
    expect(record.reviews).toEqual([]);
  });

  it('an unknown card is 404, and a malformed change is 400 before anything is written', async () => {
    expect((await track('missing-card', { op: 'head', sha: HEAD }, LEAD)).statusCode).toBe(404);
    const id = await card();
    for (const bad of [{ op: 'head', sha: 'not-hex' }, { op: 'review', head: HEAD, kind: 'text', verdict: 'GO' }, { op: 'nope' }]) {
      expect([400, 409]).toContain((await track(id, bad, LEAD)).statusCode);
    }
    expect(audit.filter((a) => a.action === 'board-issue-track')).toEqual([]);
  });
});
