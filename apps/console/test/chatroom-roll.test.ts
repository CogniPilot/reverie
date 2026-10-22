/**
 * The server half of the conversation shell: the user's read cursor and unread counts (kept with the
 * room, so per owner and across devices), direct messages, placement and archive, and who may see
 * a direct message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/index.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { rollCommand, isRollCommand } from '../src/chatroom-dice.js';

const A = '0000002d-0035-4000-8000-000000000047';

describe('/roll command', () => {
  it('rolls a bare d20 by default and a spec with a modifier', () => {
    expect(rollCommand('/roll', 'Pat', () => 14)).toBe('🎲 Pat rolls d20: **14** (14)');
    expect(rollCommand('/roll 2d6+3', 'Pat', () => 4)).toBe('🎲 Pat rolls 2d6: **11** (4 + 4 + 3)'.replace('2d6:', '2d6+3:'));
  });
  it('keeps the higher die on advantage and flags a natural 20', () => {
    const dice = [3, 20];
    const out = rollCommand('/roll 1d20+2 adv for the lock', 'Pat', () => dice.shift()!);
    expect(out).toBe('🎲 Pat rolls 1d20+2 adv for the lock: **22** (3, 20 → keep 20 (adv) + 2) ✨ NAT 20');
  });
  it('rejects what it cannot read', () => {
    expect(isRollCommand('/roll 2d6')).toBe(true);
    expect(isRollCommand('/rolling')).toBe(false);
    expect(() => rollCommand('/roll 2d6 adv', 'Pat')).toThrow(/single d20/);
    expect(() => rollCommand('/roll 500d6', 'Pat')).toThrow(/between 1 and 100/);
  });
  it('real dice stay in range', () => {
    for (let i = 0; i < 200; i++) {
      const total = Number(/\*\*(\d+)\*\*/.exec(rollCommand('/roll d20', 'Pat'))![1]);
      expect(total).toBeGreaterThanOrEqual(1);
      expect(total).toBeLessThanOrEqual(20);
    }
  });
});

describe('/roll through the message route', () => {
  let app: FastifyInstance;
  let service: ChatroomService;
  beforeEach(async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'chat-roll-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({ file, getSession: (id) => c.sessions.get(id), broadcast: () => {}, ownerNames: () => ['Pat'] });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    const s = createMockSession(A);
    s.name = 'alpha';
    harness.ctx.sessions.set(A, s as never);
  });
  afterEach(async () => {
    await service.stop();
    await app.close();
  });
  const post = (id: string, text: string, headers = {}) =>
    app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, headers, payload: { text } });

  it('the user rolls on the server; an agent typing /roll stays plain text', async () => {
    const room = (await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'demo', members: [{ sessionId: A }] } })).json().data.id;
    const mine = await post(room, '/roll 1d20+3 for stealth');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data.message.text).toMatch(/^🎲 .* rolls 1d20\+3 for stealth: \*\*\d+\*\* \(\d+ \+ 3\)/);
    const agent = await post(room, '/roll 1d20', { 'x-reverie-parent-session': A });
    expect(agent.json().data.message.text).toBe('/roll 1d20');
    const bad = await post(room, '/roll 9d');
    expect(bad.statusCode).toBe(400);
  });
});
