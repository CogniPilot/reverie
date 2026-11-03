/**
 * @fileoverview Setting old notices aside as `stale`: never "handled", refused for anything younger than 72 hours,
 * human (owner) notices selectable for it only past that age, and still listed by `notices/history?stale=1` after they
 * drop out of the pending summary.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService, STALE_MIN_AGE_MS } from '../../src/chatroom-service.js';
import { registerChatTurnSummary } from '../../src/web/routes/chat-turn-summary.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const headers = { 'x-reverie-parent-session': A };
const HOUR = 60 * 60 * 1000;
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'chat-stale-'));
  let context!: MockRouteContext;
  let now = Date.now();
  const service = new ChatroomService({
    file: join(directory, 'rooms.json'),
    database: join(directory, 'chat.db'),
    employeeOf: (id) => 'employee-' + id,
    getSession: (id) => context.sessions.get(id),
    now: () => now,
    timeZone: () => 'America/New_York',
    broadcast: () => {},
  });
  const { app } = await createRouteTestHarness((app, ctx) => {
    context = ctx;
    ctx.sessions.set(A, createMockSession(A));
    ctx.sessions.set(B, createMockSession(B));
    ctx.sessions.get(A).name = 'Reviewer';
    ctx.sessions.get(B).name = 'Peer';
    registerChatTurnSummary(app, ctx, service);
    app.addHook('onClose', async () => {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    });
  });
  await service.init();
  const room = service.createRoom('Office');
  service.addMember(room.id, A);
  service.addMember(room.id, B);
  const owner = (text: string) =>
    service.post(room.id, { kind: 'user', name: 'Owner', mark: 'owner_typed' }, text, 'all', { deliver: false });
  const resolve = (messageId: string, disposition: string) =>
    app.inject({
      method: 'POST',
      url: '/api/chatrooms/notices/resolve',
      headers,
      payload: {
        roomId: room.id,
        messageId,
        readToken: service.exactAgentRead(A, room.id, messageId).readToken,
        disposition,
      },
    });
  const pendingIds = async () =>
    (
      (await app.inject({ url: '/api/chatrooms/notices/history?roomId=' + room.id, headers })).json().data
        .sourceReferences as Array<{ messageId: string }>
    ).map((r) => r.messageId);
  const staleIds = async () =>
    (
      (await app.inject({ url: `/api/chatrooms/notices/history?roomId=${room.id}&stale=1`, headers })).json().data
        .sourceReferences as Array<{ messageId: string }>
    ).map((r) => r.messageId);
  return {
    app,
    service,
    room,
    owner,
    resolve,
    pendingIds,
    staleIds,
    advance: (ms: number) => void (now += ms),
    now: () => now,
  };
}

it('sets an old owner notice aside as stale: out of the pending list, still listed, never handled', async () => {
  const f = await fixture();
  try {
    const old = f.owner('@Reviewer an old request');
    f.advance(STALE_MIN_AGE_MS + HOUR);
    const fresh = f.owner('@Reviewer a new request');
    expect(await f.pendingIds()).toEqual(expect.arrayContaining([old.id, fresh.id]));
    const res = await f.resolve(old.id, 'stale');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.attention.disposition).toBe('stale');
    expect(await f.pendingIds()).toEqual([fresh.id]);
    expect(await f.staleIds()).toEqual([old.id]);
    expect(f.service.turnSummary(A).text).not.toContain('an old request');
  } finally {
    await f.app.close();
  }
});

it('refuses stale for a notice younger than 72 hours', async () => {
  const f = await fixture();
  try {
    const recent = f.owner('@Reviewer still current');
    f.advance(STALE_MIN_AGE_MS - HOUR);
    const res = await f.resolve(recent.id, 'stale');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('72 hours');
    expect(await f.pendingIds()).toEqual([recent.id]);
  } finally {
    await f.app.close();
  }
});

it('lists human notices for a bulk stale pass only with humans=1 and a time past the stale age', async () => {
  const f = await fixture();
  try {
    const old = f.owner('@Reviewer an old request');
    const peer = f.service.post(f.room.id, { kind: 'agent', sessionId: B, name: 'Peer' }, '@Reviewer old note', 'all', {
      deliver: false,
    });
    f.advance(STALE_MIN_AGE_MS + 2 * HOUR);
    const before = old.at + HOUR;
    const url = `/api/chatrooms/notices/pending-before?roomId=${f.room.id}&before=${before}`;
    const ids = async (suffix: string) =>
      (
        (await f.app.inject({ url: url + suffix, headers })).json().data.sourceReferences as Array<{
          messageId: string;
        }>
      ).map((r) => r.messageId);
    expect(await ids('')).toEqual([peer.id]);
    expect(await ids('&humans=1')).toEqual(expect.arrayContaining([old.id, peer.id]));
    const tooRecent = `/api/chatrooms/notices/pending-before?roomId=${f.room.id}&before=${f.now() - HOUR}&humans=1`;
    expect((await f.app.inject({ url: tooRecent, headers })).statusCode).toBe(400);
  } finally {
    await f.app.close();
  }
});
