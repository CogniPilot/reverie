/**
 * GET /api/board?known=<stateKey>: the Board page's refresh. A caller that already holds the current state key gets the
 * live part of the view only; any write or employee rename changes the key and brings the whole view back. Without the
 * parameter the reply is exactly the whole view every other reader expects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardStateKey, registerBoardRoutes } from '../../src/web/routes/board-routes.js';
import { BoardStore } from '../../src/board-store.js';
import { boardPace } from '../../src/board-logic.js';
import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';

const NOW = Date.UTC(2026, 9, 17, 18, 0, 0);
const MEMBER = '00000038-0043-4000-8000-000000000060';

describe('GET /api/board?known=', () => {
  let app: FastifyInstance;
  let dir: string;
  let store: BoardStore;
  let employees: { id: string; name: string; sessionId?: string }[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-known-'));
    store = new BoardStore(join(dir, 'board.json'));
    await store.init();
    employees = [{ id: 'e-builder', name: 'Builder', sessionId: MEMBER }];
    app = Fastify();
    registerBoardRoutes(app, { sessions: new Map([[MEMBER, { id: MEMBER, pid: 1, isWorking: false }]]) } as never, {
      structuredDecisionWrites: true,
      store,
      company: () => ({ employees, settings: { timeZone: 'UTC', ownerName: 'Owner' } }),
      rooms: () => [],
      audit: async () => {},
      now: () => NOW,
      verifiedOwner: trustedFixtureOwner,
    } as never);
    await app.ready();
    for (const title of ['Open card', 'Finished card'])
      expect((await app.inject({ method: 'POST', url: '/api/board/issues', payload: { title, owner: 'e-builder' } })).statusCode).toBe(200);
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const read = async (query = '') => {
    const res = await app.inject({ method: 'GET', url: '/api/board' + query });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  };

  it('leaves the reply of a reader without the parameter unchanged', async () => {
    const view = await read();
    expect(view.stateKey).toBeUndefined();
    expect(view.unchanged).toBeUndefined();
    expect(view.issues.map((i: { title: string }) => i.title)).toEqual(['Open card', 'Finished card']);
    expect(view.ownerIds).toEqual(Object.fromEntries(view.issues.map((i: { id: string }) => [i.id, 'e-builder'])));
  });

  it('answers a current key with the live part only, and the whole view again after a write or a rename', async () => {
    const first = await read('?known=');
    expect(first.stateKey).toBe(boardStateKey(first.rev, employees));
    expect(first.issues).toHaveLength(2);

    const same = await read('?known=' + encodeURIComponent(first.stateKey));
    expect(same).toMatchObject({ unchanged: true, stateKey: first.stateKey, rev: first.rev });
    for (const stored of ['issues', 'decisions', 'milestones', 'wins', 'blockers', 'marks', 'agents', 'plans', 'ownerIds'])
      expect(same).not.toHaveProperty(stored);
    // The live part is still computed for this read: roster, capabilities and pace.
    expect(same.roster.map((r: { id: string }) => r.id)).toEqual(['e-builder']);
    expect(same.capabilities.identity).toEqual(first.capabilities.identity);
    expect(same.pace).toEqual(first.pace);
    // Merged with the cards the caller holds, it is the whole view.
    const { unchanged: _unchanged, ...live } = same;
    expect({ ...first, ...live }).toEqual(await read('?known='));

    const id = first.issues[1].id;
    expect((await app.inject({ method: 'PATCH', url: `/api/board/issues/${id}`, payload: { status: 'done' } })).statusCode).toBe(200);
    const afterWrite = await read('?known=' + encodeURIComponent(first.stateKey));
    expect(afterWrite.unchanged).toBeUndefined();
    expect(afterWrite.rev).toBe(first.rev + 1);
    expect(afterWrite.issues.find((i: { id: string }) => i.id === id).status).toBe('done');

    employees[0] = { ...employees[0], name: 'Renamed builder' };
    const afterRename = await read('?known=' + encodeURIComponent(afterWrite.stateKey));
    expect(afterRename.rev).toBe(afterWrite.rev);
    expect(afterRename.stateKey).not.toBe(afterWrite.stateKey);
    expect(afterRename.issues).toHaveLength(2);
  });

  it('treats an unknown or malformed key as holding nothing', async () => {
    expect((await read('?known=1.0000000000000000')).issues).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/api/board?known=' + 'x'.repeat(81) })).statusCode).toBe(400);
  });

  it('reads the committed board without copying it and never changes it', async () => {
    const before = JSON.stringify(store.committed());
    await read('?known=');
    await read();
    expect(JSON.stringify(store.committed())).toBe(before);
    expect(store.committed()).toBe(store.committed());
  });

  it('keeps pace grouped by owner and milestone as before', () => {
    const issues = ['a', 'b', 'c'].map((id, n) => ({
      id, title: id, status: n === 2 ? ('wontdo' as const) : ('done' as const), tags: [], links: [], owner: 'e-builder',
      milestoneId: 'm', start: NOW - 2 * 3600e3, end: NOW - 3600e3, doneAt: NOW - 3600e3, createdAt: 0, updatedAt: 0,
    }));
    const pace = boardPace({ issues, milestones: [{ id: 'm', title: 'M', due: '2026-10-20' }] } as never, NOW);
    expect(Object.keys(pace.owners)).toEqual(['e-builder']);
    expect(pace.milestones.m).toMatchObject({ done: 2, total: 2 });
  });
});
