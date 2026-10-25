/** Current-schema decision fallback: inject-only routes and synthetic task-owned board files. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from '../src/board-store.js';
import { registerBoardRoutes, type BoardDeps } from '../src/web/routes/board-routes.js';
import type { ChatRoom } from '../src/chatroom-store.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

const NOW = Date.UTC(2026, 9, 25, 12);
const COORD = '0000002d-0035-4000-8000-000000000047';
const MEMBER = '00000038-0043-4000-8000-000000000060';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture(mode?: boolean, existingStore?: BoardStore) {
  let store = existingStore;
  if (!store) {
    const dir = await mkdtemp(join(tmpdir(), 'quill-decision-fallback-'));
    dirs.push(dir);
    store = new BoardStore(join(dir, 'board.json'));
    await store.init();
    await store.update({}, (state) => {
      state.decisions.push(
        { id: 'legacy', text: 'Retained prose question', where: 'synthetic-room', at: 1 },
        { id: 'pending', text: 'Retained question with choices', where: '', at: 2, options: ['Approve', 'Hold'] },
        {
          id: 'decided',
          text: 'Retained owner outcome',
          where: '',
          at: 3,
          options: ['Ship', 'Wait'],
          chosen: 'Wait',
          clearedAt: 4,
          clearedBy: 'owner',
        }
      );
    });
  }
  const audit = vi.fn(async (_entry: Record<string, unknown>) => {});
  const broadcast = vi.fn();
  const sessions = new Map([COORD, MEMBER].map((id) => [id, { id, owner: undefined }]));
  const deps: BoardDeps = {
    store,
    ...(mode === undefined ? {} : { structuredDecisionWrites: mode }),
    verifiedOwner: trustedFixtureOwner,
    company: () => ({
      settings: { ownerName: 'Synthetic Owner', timeZone: 'UTC' },
      employees: [
        { id: 'coordinator', name: 'Synthetic Coordinator', sessionId: COORD },
        { id: 'member', name: 'Synthetic Member', sessionId: MEMBER },
      ],
    }),
    rooms: () =>
      [
        {
          id: 'synthetic-room',
          name: 'Synthetic room',
          createdAt: 0,
          messages: [],
          members: [
            { sessionId: COORD, role: 'coordinator', goal: '' },
            { sessionId: MEMBER, role: 'member', goal: '' },
          ],
        },
      ] as unknown as ChatRoom[],
    audit,
    now: () => NOW,
  };
  const app = Fastify();
  apps.push(app);
  registerBoardRoutes(app, { sessions, broadcast } as unknown as SessionPort, deps);
  await app.ready();
  return { app, store, deps, audit, broadcast };
}

const gatedRequests = [
  {
    label: 'create',
    method: 'POST' as const,
    url: '/api/board/decisions',
    payload: { id: 'new', text: 'New question?', options: ['Approve', 'Hold'] },
  },
  {
    label: 'owner choice',
    method: 'POST' as const,
    url: '/api/board/decisions/pending/choose',
    payload: { option: 'Approve' },
  },
  {
    label: 'replace options',
    method: 'PATCH' as const,
    url: '/api/board/decisions/pending',
    payload: { options: ['Continue', 'Pause'] },
  },
  {
    label: 'legacy options repair',
    method: 'PATCH' as const,
    url: '/api/board/decisions/legacy',
    payload: { options: ['Continue', 'Pause'], summary: 'Must also remain unsaved' },
  },
  ...[false, true].flatMap((dryRun) => [
    {
      label: `new decision import (dryRun=${dryRun})`,
      method: 'POST' as const,
      url: '/api/board/import',
      payload: {
        dryRun,
        content: { decisions: [{ id: 'imported', text: 'Imported question?', options: ['Approve', 'Hold'] }] },
      },
    },
    {
      label: `existing decision import (dryRun=${dryRun})`,
      method: 'POST' as const,
      url: '/api/board/import',
      payload: {
        dryRun,
        content: { decisions: [{ id: 'pending', text: 'Replacement question', options: ['Continue', 'Pause'] }] },
      },
    },
    {
      label: `prose decision import (dryRun=${dryRun})`,
      method: 'POST' as const,
      url: '/api/board/import',
      payload: { dryRun, content: { decisions: [{ id: 'legacy', text: 'Replacement prose' }] } },
    },
  ]),
];

describe.each([undefined, false])('structured decision writes OFF (%s)', (mode) => {
  it.each(gatedRequests)('refuses $label before any audit or store write', async (request) => {
    const f = await fixture(mode);
    const before = f.store.snapshot();
    const bytes = await readFile(f.store.file);
    const update = vi.spyOn(f.store, 'update');
    const response = await f.app.inject({ method: request.method, url: request.url, payload: request.payload });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ success: false, error: expect.any(String) });
    expect(update).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.store.snapshot()).toEqual(before);
    expect(await readFile(f.store.file)).toEqual(bytes);
  });

  it('projects OFF without mutating the board, even after the dependency is changed to true', async () => {
    const f = await fixture(mode);
    const bytes = await readFile(f.store.file);
    f.deps.structuredDecisionWrites = true;
    const view = await f.app.inject({ url: '/api/board' });
    expect(view.statusCode).toBe(200);
    expect(view.json().data.structuredDecisionWrites).toBe(false);
    expect(view.json().data.capabilities.board.createDecision).toBe(false);
    expect((await f.app.inject(gatedRequests[0])).statusCode).toBe(503);
    expect(f.audit).not.toHaveBeenCalled();
    expect(await readFile(f.store.file)).toEqual(bytes);
  });

  it('allows ordinary annotations, clearing and unrelated writes without losing retained outcomes', async () => {
    const f = await fixture(mode);
    const decided = f.store.snapshot().decisions.find((item) => item.id === 'decided');
    const headers = { 'x-reverie-parent-session': COORD };
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: '/api/board/decisions/pending',
          headers,
          payload: {
            summary: 'New annotation',
            tradeoff: 'Wait for review',
            recommendation: { option: 'Hold', reason: 'Synthetic review' },
          },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/board/decisions/pending/clear', headers, payload: {} }))
        .statusCode
    ).toBe(200);
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/board/issues', headers, payload: { title: 'Unrelated issue' } }))
        .statusCode
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/board/import',
          payload: {
            content: {
              decisions: [],
              wins: [{ at: '2026-10-25T12:00', text: 'Synthetic retained win', who: 'Synthetic Owner' }],
            },
          },
        })
      ).statusCode
    ).toBe(200);
    expect(f.store.snapshot().decisions.find((item) => item.id === 'pending')).toMatchObject({
      options: ['Approve', 'Hold'],
      summary: 'New annotation',
      clearedBy: 'coordinator',
      clearedAt: NOW,
      recommendation: { option: 'Hold', reason: 'Synthetic review', by: 'Synthetic Coordinator' },
    });
    expect(f.store.snapshot().decisions.find((item) => item.id === 'decided')).toEqual(decided);
    expect(f.store.snapshot().decisions.find((item) => item.id === 'legacy')).toMatchObject({
      text: 'Retained prose question',
    });
    expect(f.audit).toHaveBeenCalledTimes(4);
    const reopened = new BoardStore(f.store.file);
    await reopened.init();
    expect(reopened.snapshot()).toEqual(f.store.snapshot());
  });
});

it('captures enabled mode, persists string choices, and reopens OFF without migration or outcome loss', async () => {
  const enabled = await fixture(true);
  enabled.deps.structuredDecisionWrites = false;
  expect((await enabled.app.inject({ url: '/api/board' })).json().data.structuredDecisionWrites).toBe(true);
  const created = await enabled.app.inject({
    method: 'POST',
    url: '/api/board/decisions',
    headers: { 'x-reverie-parent-session': COORD },
    payload: {
      id: 'enabled',
      text: 'Publish synthetic result?',
      options: ['Publish', 'Hold'],
      recommendation: { option: 'Hold', reason: 'Review first' },
    },
  });
  expect(created.statusCode).toBe(200);
  const chosen = await enabled.app.inject({
    method: 'POST',
    url: '/api/board/decisions/enabled/choose',
    payload: { option: 'Hold', ifRev: enabled.store.snapshot().rev },
  });
  expect(chosen.statusCode).toBe(200);
  const outcome = enabled.store.snapshot().decisions.find((item) => item.id === 'enabled');
  expect(outcome).toMatchObject({ options: ['Publish', 'Hold'], chosen: 'Hold', clearedBy: 'owner', clearedAt: NOW });
  expect(enabled.audit.mock.calls.map(([entry]) => entry.action)).toEqual([
    'board-decision-add',
    'board-decision-choose',
  ]);
  const sealedBytes = await readFile(enabled.store.file);
  const disk = JSON.parse(sealedBytes.toString());
  expect(disk.decisions.find((item: { id: string }) => item.id === 'enabled')).toEqual(outcome);
  expect(disk).not.toHaveProperty('structuredDecisionWrites');
  await enabled.app.close();
  const reopened = new BoardStore(enabled.store.file);
  await reopened.init();
  const disabled = await fixture(undefined, reopened);
  const offView = await disabled.app.inject({ url: '/api/board' });
  expect(offView.json().data.structuredDecisionWrites).toBe(false);
  expect(offView.json().data.decisions.find((item: { id: string }) => item.id === 'enabled')).toEqual(outcome);
  expect(await readFile(reopened.file)).toEqual(sealedBytes);
  expect((await disabled.app.inject(gatedRequests[0])).statusCode).toBe(503);
  expect(disabled.audit).not.toHaveBeenCalled();
  expect(await readFile(reopened.file)).toEqual(sealedBytes);
  expect(
    (await disabled.app.inject({ method: 'POST', url: '/api/board/issues', payload: { title: 'After fallback' } }))
      .statusCode
  ).toBe(200);
  expect(
    (await disabled.app.inject({ method: 'POST', url: '/api/board/decisions/legacy/clear', payload: {} })).statusCode
  ).toBe(200);
  expect(reopened.snapshot().decisions.find((item) => item.id === 'enabled')).toEqual(outcome);
  await disabled.app.close();
  const finalStore = new BoardStore(reopened.file);
  await finalStore.init();
  expect(finalStore.snapshot().decisions.find((item) => item.id === 'enabled')).toEqual(outcome);
  const reenabled = await fixture(true, finalStore);
  expect(
    (
      await reenabled.app.inject({
        method: 'POST',
        url: '/api/board/decisions',
        payload: { id: 'after-reenable', text: 'New question after fallback?', options: ['Proceed', 'Hold'] },
      })
    ).statusCode
  ).toBe(200);
  expect(
    (
      await reenabled.app.inject({
        method: 'POST',
        url: '/api/board/decisions/after-reenable/choose',
        payload: { option: 'Hold' },
      })
    ).statusCode
  ).toBe(200);
  const afterReenable = new BoardStore(finalStore.file);
  await afterReenable.init();
  expect(afterReenable.snapshot().decisions.find((item) => item.id === 'enabled')).toEqual(outcome);
  expect(afterReenable.snapshot().decisions.find((item) => item.id === 'after-reenable')).toMatchObject({
    chosen: 'Hold',
    clearedBy: 'owner',
  });
});

it.each([undefined, false, true])('preserves owner-only choice authorization in mode %s', async (mode) => {
  const f = await fixture(mode);
  const bytes = await readFile(f.store.file);
  for (const session of [COORD, MEMBER]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/board/decisions/pending/choose',
      headers: { 'x-reverie-parent-session': session },
      payload: { option: 'Approve' },
    });
    expect(response.statusCode).toBe(403);
  }
  expect(f.audit).not.toHaveBeenCalled();
  expect(await readFile(f.store.file)).toEqual(bytes);
});

it.each(['enabled', 'true', 1, {}, [], new Boolean(true)])(
  'keeps truthy non-boolean BoardDeps value %j OFF before every write gate',
  async (value) => {
    // Deliberately cross the static boolean boundary to pin the runtime === true contract.
    const f = await fixture(value as unknown as boolean);
    const bytes = await readFile(f.store.file);
    const before = f.store.snapshot();
    const update = vi.spyOn(f.store, 'update');
    const view = (await f.app.inject({ url: '/api/board' })).json().data;
    expect(view.structuredDecisionWrites).toBe(false);
    expect(view.capabilities.board.createDecision).toBe(false);
    for (const request of gatedRequests) {
      expect(
        (await f.app.inject({ method: request.method, url: request.url, payload: request.payload })).statusCode
      ).toBe(503);
    }
    expect(update).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.store.snapshot()).toEqual(before);
    expect(await readFile(f.store.file)).toEqual(bytes);
  }
);
