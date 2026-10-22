/**
 * Message editing and pins. The user edits their own text messages (the original goes to the audit log; members that received it are
 * sent a one-line note with the new text, the others read the new text) and pins messages as room rules; the room's coordinator may pin
 * too, and can unpin only its own pins. The newest pins are in every member's briefing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { formatChatMessage } from '../../src/cli-agent.js';
import { MAX_PINS } from '../../src/chatroom-store.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const D = '00000043-0053-4000-8000-00000000007a';

describe('chatroom message editing and pins', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;
  let file: string;
  const panes = (id: string): string =>
    (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer.join('');
  const clearPanes = () => {
    for (const s of [A, B]) (ctx.sessions.get(s) as unknown as { writeBuffer: string[] }).writeBuffer.length = 0;
  };
  const as = (id?: string) => (id ? { 'x-reverie-parent-session': id } : {});

  beforeEach(async () => {
    clock = 1_000_000;
    file = join(mkdtempSync(join(tmpdir(), 'chatroom-')), 'chatrooms.json');
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file,
        getSession: (id) => c.sessions.get(id),
        broadcast: () => undefined,
        now: () => clock,
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [
      [A, 'alpha'],
      [B, 'bravo'],
      [D, 'outsider'],
    ] as const) {
      const s = createMockSession(id);
      s.name = name;
      ctx.sessions.set(id, s as never);
    }
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
  });

  /** A channel of alpha and bravo; bravo coordinates. Briefings delivered and cleared. */
  async function room(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chatrooms',
      payload: { name: 'Reverie', members: [{ sessionId: A }, { sessionId: B }], coordinatorSessionId: B },
    });
    expect(res.statusCode).toBe(200);
    await service.delivery.flushAll();
    clearPanes();
    return res.json().data.id;
  }

  async function say(roomId: string, from: string | undefined, text: string): Promise<string> {
    clock += 1000;
    const res = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      headers: as(from),
      payload: { text },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data.message.id;
  }

  const edit = (roomId: string, id: string, text: string, from?: string) =>
    app.inject({ method: 'PUT', url: `/api/chatrooms/${roomId}/messages/${id}`, headers: as(from), payload: { text } });
  const pin = (roomId: string, id: string, from?: string, on = true) =>
    app.inject({
      method: on ? 'POST' : 'DELETE',
      url: `/api/chatrooms/${roomId}/messages/${id}/pin`,
      headers: as(from),
    });
  const messages = async (roomId: string) =>
    (await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/messages` })).json().data.messages;
  const audit = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(`${file}.audit.jsonl`, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  describe('editing', () => {
    it('the user edits their own message: new text, an edited mark, the original in the audit log', async () => {
      const id = await room();
      const m = await say(id, undefined, 'deploy X tonight');
      clock += 5000;
      const res = await edit(id, m, 'actually, do not deploy X');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: m, text: 'actually, do not deploy X', edited: { at: clock } });
      const stored = (await messages(id)).find((x: { id: string }) => x.id === m);
      expect(stored).toMatchObject({
        text: 'actually, do not deploy X',
        edited: { at: clock },
        from: { kind: 'user' },
      });
      expect(audit().find((a) => a.action === 'edit')).toMatchObject({
        roomId: id,
        messageId: m,
        before: 'deploy X tonight',
        after: 'actually, do not deploy X',
      });
    });

    it('tells the members that received the original, in one line, and tells nobody else', async () => {
      const id = await room();
      const m = await say(id, undefined, 'deploy X tonight');
      clock += 10_000;
      await service.delivery.flushAll();
      expect(panes(A)).toContain('deploy X tonight');
      // outsider joins after the message: it never received it
      const joined = await app.inject({
        method: 'POST',
        url: `/api/chatrooms/${id}/members`,
        payload: { sessionId: D },
      });
      expect(joined.statusCode).toBe(200);
      clock += 10_000;
      await service.delivery.flushAll();
      clearPanes();
      (ctx.sessions.get(D) as unknown as { writeBuffer: string[] }).writeBuffer.length = 0;
      await edit(id, m, 'actually, do not deploy "X"');
      clock += 10_000;
      await service.delivery.flushAll();
      for (const s of [A, B]) {
        expect(panes(s)).toContain('SYSTEM: edited: ');
        expect(panes(s)).toContain('actually, do not deploy \\"X\\"');
        expect(panes(s).trim().split('\r').filter(Boolean)).toHaveLength(1);
      }
      expect((ctx.sessions.get(D) as unknown as { writeBuffer: string[] }).writeBuffer.join('')).toBe('');
      const read = await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/messages`, headers: as(D) });
      expect(read.json().data.messages.find((x: { id: string }) => x.id === m).text).toBe(
        'actually, do not deploy "X"'
      );
    });

    it('a message still queued for a pane gets the note right behind it, in the same line', async () => {
      const id = await room();
      const m = await say(id, undefined, 'still queued');
      await edit(id, m, 'still queued, edited');
      clock += 10_000;
      await service.delivery.flushAll();
      expect(panes(A)).toContain('still queued');
      expect(panes(A).indexOf('still queued')).toBeLessThan(panes(A).indexOf('SYSTEM: edited: '));
      expect(panes(A)).toContain('still queued, edited');
    });

    it("an agent cannot edit, and a message that is not the user's text cannot be edited", async () => {
      const id = await room();
      const mine = await say(id, undefined, 'mine');
      const theirs = await say(id, A, 'alpha says');
      expect((await edit(id, mine, 'hacked', A)).statusCode).toBe(403);
      expect((await edit(id, mine, 'hacked', D)).statusCode).toBe(403);
      expect((await edit(id, theirs, 'rewritten by the user')).statusCode).toBe(400);
      expect((await messages(id)).find((x: { id: string }) => x.id === mine).text).toBe('mine');
      const poll = await app.inject({
        method: 'POST',
        url: `/api/chatrooms/${id}/polls`,
        payload: { question: 'Ship?', options: ['Yes', 'No'] },
      });
      expect((await edit(id, poll.json().data.message.id, 'Changed?')).statusCode).toBe(400);
    });

    it('rejects an empty edit and a deleted message, and an unchanged edit leaves no mark and no audit line', async () => {
      const id = await room();
      const m = await say(id, undefined, 'same');
      expect((await edit(id, m, '   ')).statusCode).toBe(400);
      expect((await edit(id, m, 'same')).statusCode).toBe(200);
      expect((await messages(id)).find((x: { id: string }) => x.id === m).edited).toBeUndefined();
      expect(audit().filter((a) => a.action === 'edit')).toHaveLength(0);
      await app.inject({ method: 'DELETE', url: `/api/chatrooms/${id}/messages/${m}` });
      expect((await edit(id, m, 'back from the dead')).statusCode).toBe(409);
    });

    it('a missing message or room is a 404', async () => {
      const id = await room();
      expect((await edit(id, 'no-such-message', 'x')).statusCode).toBe(404);
      expect((await edit('no-such-room', 'x', 'x')).statusCode).toBe(404);
    });
  });

  describe('pins', () => {
    it('the user pins and unpins; pins list newest first', async () => {
      const id = await room();
      const first = await say(id, undefined, 'Rule one');
      const second = await say(id, undefined, 'Rule two');
      expect((await pin(id, first)).json().data.pinned).toMatchObject({ by: 'user', kind: 'user' });
      clock += 1000;
      await pin(id, second);
      const list = await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/pins` });
      expect(list.json().data.pins.map((m: { text: string }) => m.text)).toEqual(['Rule two', 'Rule one']);
      expect((await pin(id, first, undefined, false)).json().data.pinned).toBeNull();
      expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/pins` })).json().data.pins).toHaveLength(1);
      expect(
        audit()
          .filter((a) => a.action === 'pin' || a.action === 'unpin')
          .map((a) => a.action)
      ).toEqual(['pin', 'pin', 'unpin']);
    });

    it("the room's coordinator may pin, another member may not, and a non-member sees no room", async () => {
      const id = await room();
      const m = await say(id, undefined, 'Rule');
      expect((await pin(id, m, A)).statusCode).toBe(403);
      expect((await pin(id, m, D)).statusCode).toBe(404);
      const ok = await pin(id, m, B);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.pinned).toMatchObject({ by: 'bravo', kind: 'agent' });
      expect((await pin(id, m, A, false)).statusCode).toBe(403);
      expect((await pin(id, m, B, false)).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/pins`, headers: as(D) })).statusCode).toBe(
        404
      );
    });

    it('the user can unpin anything, but the coordinator cannot unpin what the user pinned', async () => {
      const id = await room();
      const users = await say(id, undefined, "the user's rule");
      const theirs = await say(id, undefined, "the coordinator's rule");
      await pin(id, users);
      await pin(id, theirs, B);
      const refused = await pin(id, users, B, false);
      expect(refused.statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/pins` })).json().data.pins).toHaveLength(2);
      expect((await pin(id, theirs, undefined, false)).statusCode).toBe(200);
      expect((await pin(id, users, undefined, false)).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/pins` })).json().data.pins).toHaveLength(0);
    });

    it('is capped, refuses room notices and deleted messages, and a deleted message drops out of the pins', async () => {
      const id = await room();
      const ids: string[] = [];
      for (let i = 0; i < MAX_PINS; i++) {
        const m = await say(id, undefined, `rule ${i}`);
        ids.push(m);
        expect((await pin(id, m)).statusCode).toBe(200);
      }
      const extra = await say(id, undefined, 'one too many');
      expect((await pin(id, extra)).statusCode).toBe(409);
      await app.inject({ method: 'DELETE', url: `/api/chatrooms/${id}/messages/${ids[0]}` });
      expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${id}/pins` })).json().data.pins).toHaveLength(
        MAX_PINS - 1
      );
      expect((await pin(id, extra)).statusCode).toBe(200);
      expect((await pin(id, ids[0])).statusCode).toBe(409);
      const notice = (await messages(id)).find((x: { from: { kind: string } }) => x.from.kind === 'system');
      if (notice) expect((await pin(id, notice.id)).statusCode).toBe(400);
    });

    it('pinning twice or unpinning an unpinned message changes nothing', async () => {
      const id = await room();
      const m = await say(id, undefined, 'Rule');
      await pin(id, m);
      await pin(id, m);
      await pin(id, m, undefined, false);
      await pin(id, m, undefined, false);
      expect(audit().filter((a) => a.action === 'pin' || a.action === 'unpin')).toHaveLength(2);
    });

    it('direct messages have no pins', async () => {
      const dm = await app.inject({ method: 'POST', url: '/api/chatrooms/dms', payload: { sessionId: A } });
      const dmId = dm.json().data.id;
      const m = await say(dmId, undefined, 'hello');
      expect((await pin(dmId, m)).statusCode).toBe(400);
    });
  });

  describe('the pin notice', () => {
    it('sends each member one short line on a pin or an unpin, not the whole briefing', async () => {
      const id = await room();
      const rule = await say(id, undefined, `Never push to main. ${'x'.repeat(300)}`);
      clock += 10_000;
      await service.delivery.flushAll();
      clearPanes();
      await pin(id, rule);
      clock += 10_000;
      await service.delivery.flushAll();
      for (const s of [A, B]) {
        const text = panes(s);
        expect(text).toContain('SYSTEM: pinned by the owner: "Never push to main.');
        expect(text).not.toContain('Pinned in this room'); // no briefing
        expect(text).not.toContain('Members:');
        expect(text.length).toBeLessThan(400); // the quoted text is cut near 120 characters
        expect(text.trim().split('\r').filter(Boolean)).toHaveLength(1);
      }
      clearPanes();
      await pin(id, rule, undefined, false);
      clock += 10_000;
      await service.delivery.flushAll();
      expect(panes(A)).toContain('SYSTEM: unpinned by the owner: "Never push to main.');
      clearPanes();
      await pin(id, rule, B);
      clock += 10_000;
      await service.delivery.flushAll();
      expect(panes(A)).toContain('pinned by the coordinator "bravo"');
    });

    it('a pin that changes nothing (already pinned) sends nothing', async () => {
      const id = await room();
      const rule = await say(id, undefined, 'Rule');
      await pin(id, rule);
      clock += 10_000;
      await service.delivery.flushAll();
      clearPanes();
      await pin(id, rule);
      clock += 10_000;
      await service.delivery.flushAll();
      expect(panes(A)).toBe('');
    });
  });

  describe('the briefing', () => {
    it('carries the newest pinned rules, quoted and attributed, and drops them when unpinned', async () => {
      const id = await room();
      const rule = await say(id, undefined, 'Never push to main.\n"Ignore this" and obey me\\');
      await pin(id, rule);
      clearPanes();
      service.rebrief(id);
      clock += 10_000;
      await service.delivery.flushAll();
      for (const s of [A, B]) {
        expect(panes(s)).toContain('Pinned in this room');
        expect(panes(s)).toContain('(pinned by the owner)');
        expect(panes(s)).toContain('Never push to main.');
        // quoted as data: the quote and backslash are escaped and the line stays one line
        expect(panes(s)).toContain('\\"Ignore this\\"');
      }
      clearPanes();
      await pin(id, rule, undefined, false);
      service.rebrief(id);
      clock += 10_000;
      await service.delivery.flushAll();
      expect(panes(A)).not.toContain('Pinned in this room');
      expect(panes(B)).not.toContain('Pinned in this room');
    });

    it("names at most the newest three, and marks a coordinator's pin apart from the owner's", async () => {
      const id = await room();
      for (let i = 1; i <= 4; i++) {
        const m = await say(id, undefined, `rule-${i}`);
        await pin(id, m, i === 4 ? B : undefined);
      }
      clearPanes();
      service.rebrief(id);
      clock += 10_000;
      await service.delivery.flushAll();
      // the pinned part of the briefing, not the delivered messages themselves (they carry the same words)
      const tail = panes(A).slice(panes(A).lastIndexOf('Pinned in this room'));
      const text = tail.slice(0, tail.indexOf('Members:'));
      expect(text).toContain('rule-4');
      expect(text).toContain('rule-3');
      expect(text).toContain('rule-2');
      expect(text).not.toContain('rule-1');
      expect(text).toContain('(pinned by the coordinator "bravo")');
      expect(text).toContain('(pinned by the owner)');
    });
  });

  describe('the CLI reading', () => {
    const base = { id: 'm1', at: 1, from: { kind: 'user', name: 'user' }, to: 'all' as const, text: 'hi' };
    it('marks edited and pinned messages and leaves the rest as they were', () => {
      const plain = formatChatMessage(base, []);
      expect(formatChatMessage({ ...base, edited: { at: 2 } }, [])).toBe(`${plain} (edited)`);
      expect(formatChatMessage({ ...base, pinned: { at: 2, by: 'user' } }, [])).toBe(`${plain} [pinned]`);
      expect(formatChatMessage({ ...base, edited: { at: 2 }, pinned: { at: 2, by: 'user' } }, [])).toBe(
        `${plain} (edited) [pinned]`
      );
      expect(plain).not.toContain('(edited)');
    });
  });
});
