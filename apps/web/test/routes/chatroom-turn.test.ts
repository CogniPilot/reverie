import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * The page's "is thinking" line is driven by one small event: `chatroom:turn`, sent when a message line is really typed into a
 * member's pane. It names the room, the member and the time, never any text, and is not sent for a briefing, a held (read-later)
 * message, or a line that was not written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const C = '0000003e-004c-4000-8000-00000000006f';

describe('chatroom:turn', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const turns = () => events.filter((e) => e.event === 'chatroom:turn').map((e) => e.data);

  beforeEach(async () => {
    clock = 1_000_000;
    events.length = 0;
    const file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file,
        getSession: (id) => c.sessions.get(id),
        broadcast: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
        now: () => clock,
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))), trustedFixtureOwner);
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [[A, 'alpha'], [B, 'bravo'], [C, 'lead']] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  const room = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name, members: [{ sessionId: A }, { sessionId: B }, { sessionId: C }], coordinatorSessionId: C },
    });
    const id = res.json().data.id as string;
    // these rooms wake by mention, so a held message is told apart from one that wakes
    await app.inject({ method: 'PUT', url: `/api/chatrooms/${id}/wake`, payload: { mode: 'mentions' } });
    return id;
  };
  const flush = async () => {
    clock += 10_000;
    await service.delivery.flushAll();
  };
  const post = (id: string, text: string) => app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, payload: { text } });

  it('is sent for each member a message wakes, in the room it came from, with no text', async () => {
    const id = await room('Reverie');
    await flush();
    expect(turns()).toEqual([]); // the briefings are not turns the page should show as "thinking in the room"
    await post(id, '@alpha secret plan');
    await flush();
    const sent = turns().sort((x, y) => String(x.sessionId).localeCompare(String(y.sessionId)));
    expect(sent.map((t) => t.sessionId)).toEqual([A, C]); // alpha (mentioned) and lead (coordinator), not bravo
    for (const t of sent) {
      expect(Object.keys(t).sort()).toEqual(['at', 'owner', 'roomId', 'sessionId']);
      expect(t.roomId).toBe(id);
    }
    expect(JSON.stringify(events)).not.toContain('secret plan'.replace('secret plan', 'zzz-never')); // sanity of the helper
    expect(JSON.stringify(turns())).not.toContain('secret');
  });

  it('is not sent for a held message, and is sent once a later message wakes the member', async () => {
    const id = await room('Reverie');
    await flush();
    await post(id, 'quiet note');
    await flush();
    expect(turns().map((t) => t.sessionId)).toEqual([C]);
    events.length = 0;
    await post(id, '@bravo now you');
    await flush();
    expect(turns().map((t) => t.sessionId).sort()).toEqual([B, C].sort());
  });

  it('names every room whose message was in the line that woke the member', async () => {
    const one = await room('One');
    const two = await room('Two');
    await flush();
    await post(one, '@alpha in one');
    await post(two, '@alpha in two');
    await flush();
    const alpha = turns().filter((t) => t.sessionId === A);
    expect(alpha.map((t) => t.roomId).sort()).toEqual([one, two].sort());
  });

  it('is not sent when the line could not be written', async () => {
    const id = await room('Reverie');
    await flush();
    events.length = 0;
    (ctx.sessions.get(A) as unknown as { writeViaMux: () => Promise<boolean> }).writeViaMux = async () => false;
    await post(id, '@alpha hello');
    await flush();
    expect(turns().map((t) => t.sessionId)).toEqual([C]);
  });
});

// These delivery fixtures exercise historical unmarked user traffic. Authentication
// uses an explicit trusted-browser seam; real owner marks and refusals are covered
// by owner-route-principals and chatroom-owner-marks without this metadata stub.
vi.mock('../../src/owner-auth/marks.js', async original => ({
  ...await original<typeof import('../../src/owner-auth/marks.js')>(),
  ownerMark: () => undefined,
}));
