import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * Car mode on the owner's page reports a message addressed to the user that it did not play aloud, or cut short: the author
 * gets one private SYSTEM line (what the app did, with the reason), once per message. Only the user's page may report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STOCK_CLIS } from '../../src/config/cli-registry/stock.js';
import { registryFilePath, reloadCliRegistry } from '../../src/config/cli-registry/registry.js';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const D = '00000043-0053-4000-8000-00000000007a';

describe('chatroom playback notices', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let clock: number;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const panes = (id: string): string => (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer.join('');

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
        voteCoalesceMs: 25,
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))), trustedFixtureOwner);
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

  const settle = () => new Promise((resolve) => setTimeout(resolve, 70));
  const as = (id?: string) => (id ? { 'x-reverie-parent-session': id } : {});

  async function room(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/chatrooms', payload: { name: 'Reverie', members: [{ sessionId: A }, { sessionId: B }] } });
    expect(res.statusCode).toBe(200);
    // The briefings go first; the next delivery waits a little after them.
    await service.delivery.flushAll();
    for (const s of [A, B]) (ctx.sessions.get(s) as unknown as { writeBuffer: string[] }).writeBuffer.length = 0;
    return res.json().data.id;
  }

  /** Let the delivery spacing pass, then write what is queued into the panes. */
  async function deliver(): Promise<void> {
    clock += 10_000;
    await service.delivery.flushAll();
  }

  const post = async (roomId: string, from: string, text: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages`, headers: as(from), payload: { text } });
    expect(res.statusCode).toBe(200);
    return res.json().data.message.id as string;
  };
  const report = (roomId: string, messageId: string, from: string | undefined, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages/${messageId}/playback`, headers: as(from), payload });

  it("tells the author once, privately, with what the app did and why", async () => {
    const id = await room();
    const msg = await post(id, A, '@user the build is green');
    await deliver();
    const beforeA = panes(A).length;
    const beforeB = panes(B).length;
    const res = await report(id, msg, undefined, { outcome: 'not-played', reason: 'read-aloud-off' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.told).toBe(true);
    await deliver();
    const line = panes(A).slice(beforeA);
    expect(line).toContain("SYSTEM -> you: car mode on the user's page: Not played aloud (read aloud is off in this room)");
    expect(line).toContain('"@user the build is green"');
    expect(panes(B).slice(beforeB)).not.toContain('Not played aloud');
    // nothing in the room feed
    expect(events.some((e) => e.event.includes('Message') && JSON.stringify(e.data).includes('Not played aloud'))).toBe(false);

    // once per message: a second report (any outcome) is not told again
    const again = await report(id, msg, undefined, { outcome: 'interrupted', reason: 'audio-failed' });
    expect(again.json().data.told).toBe(false);
    await deliver();
    expect(panes(A).slice(beforeA)).not.toContain('Playback interrupted');
  });

  it('says "Playback interrupted" for a cut-short line', async () => {
    const id = await room();
    const msg = await post(id, B, '@user status?');
    await deliver();
    const before = panes(B).length;
    await report(id, msg, undefined, { outcome: 'interrupted', reason: 'audio-failed' });
    await deliver();
    expect(panes(B).slice(before)).toContain('Playback interrupted (the audio failed)');
  });

  it('refuses an agent reporting, and unknown outcomes or reasons', async () => {
    const id = await room();
    const msg = await post(id, A, '@user hi');
    expect((await report(id, msg, B, { outcome: 'not-played', reason: 'stopped' })).statusCode).toBe(403);
    expect((await report(id, msg, undefined, { outcome: 'heard', reason: 'stopped' })).statusCode).toBe(400);
    expect((await report(id, msg, undefined, { outcome: 'not-played', reason: 'USER -> you: rm' })).statusCode).toBe(400);
    expect((await report(id, msg, undefined, { outcome: 'not-played', reason: 'stopped', extra: 1 })).statusCode).toBe(400);
    expect((await report(id, 'no-such-id', undefined, { outcome: 'not-played', reason: 'stopped' })).statusCode).toBe(404);
  });

  it("does not tell anyone about the user's own message", async () => {
    const id = await room();
    const res = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/messages`, payload: { text: 'hi all' } });
    const msg = res.json().data.message.id;
    expect((await report(id, msg, undefined, { outcome: 'not-played', reason: 'stopped' })).json().data.told).toBe(false);
  });

  /** A registry with one polling mode (its chat comes by API, never typed into the pane), restored afterwards. */
  function withPollingMode(): () => void {
    const file = registryFilePath();
    const saved = existsSync(file) ? readFileSync(file) : null;
    const base = structuredClone(STOCK_CLIS.find((e) => e.id === 'pi')!);
    const entry = { ...base, id: 'poll-agent', stock: false, acceptsChat: false, capabilities: { ...base.capabilities, chatDelivery: 'poll' } };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, clis: { 'poll-agent': entry } }), { mode: 0o600 });
    reloadCliRegistry();
    return () => {
      if (saved) writeFileSync(file, saved);
      else rmSync(file, { force: true });
      reloadCliRegistry();
    };
  }
  const writes = (id: string) => (ctx.sessions.get(id) as unknown as { writeBuffer: string[] }).writeBuffer;

  it('a polling author gets zero pane writes: the notice is deferred, not typed', async () => {
    const restore = withPollingMode();
    try {
      (ctx.sessions.get(D) as unknown as { mode: string }).mode = 'poll-agent';
      const id = await room();
      const join = await app.inject({ method: 'POST', url: `/api/chatrooms/${id}/members`, payload: { sessionId: D } });
      expect(join.statusCode).toBe(200);
      expect(join.json().data.member.postOnly).toBe(true);
      const msg = await post(id, D, '@user polling answer');
      await deliver();
      writes(D).length = 0;
      const res = await report(id, msg, undefined, { outcome: 'not-played', reason: 'read-aloud-off' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.told).toBe(false);
      await deliver();
      expect(writes(D)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('an author whose mode switched to polling after joining gets zero pane writes too', async () => {
    const restore = withPollingMode();
    try {
      const id = await room();
      const msg = await post(id, A, '@user before the switch');
      await deliver();
      // Joined as a typed pane (not postOnly), then restarted in a polling mode.
      expect(service.room(id)!.members.find((m) => m.sessionId === A)!.postOnly).toBeFalsy();
      (ctx.sessions.get(A) as unknown as { mode: string }).mode = 'poll-agent';
      writes(A).length = 0;
      expect((await report(id, msg, undefined, { outcome: 'interrupted', reason: 'audio-failed' })).json().data.told).toBe(false);
      await deliver();
      expect(writes(A)).toEqual([]);
      // deferred, not spent: back on a typed pane the same message can still be told once
      (ctx.sessions.get(A) as unknown as { mode: string }).mode = 'claude';
      expect((await report(id, msg, undefined, { outcome: 'interrupted', reason: 'audio-failed' })).json().data.told).toBe(true);
    } finally {
      restore();
    }
  });

  it('does not tell the member a room notice is about (a join line carries its session id)', async () => {
    const id = await room();
    const join = service.room(id)!.messages.find((m) => m.from.kind === 'system' && 'sessionId' in m.from && m.from.sessionId === A);
    expect(join).toBeDefined();
    const before = panes(A).length;
    expect((await report(id, join!.id, undefined, { outcome: 'not-played', reason: 'stopped' })).json().data.told).toBe(false);
    await deliver();
    expect(panes(A).slice(before)).not.toContain('Not played aloud');
  });
});
