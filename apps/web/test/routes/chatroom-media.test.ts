import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * Chatroom attachments, reactions and custom emotes: the store and its limits, what is
 * served inline, how attachments reach an agent's pane, and reactions over SSE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore, safeFileName } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

const A = '0000002d-0035-4000-8000-000000000047';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('chatroom media', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let root: string;
  let roomId: string;
  let clock = 1_000_000;
  const events: Array<{ event: string; data: unknown }> = [];

  beforeEach(async () => {
    events.length = 0;
    clock = 1_000_000;
    root = mkdtempSync(join(tmpdir(), 'chatmedia-'));
    const files = new ChatFileStore(root, { maxFile: 1024, maxRoom: 2500 });
    const harness = await createRouteTestHarness((fastify, c) => {
      service = new ChatroomService({
        file: join(root, 'chatrooms.json'),
        getSession: (id) => c.sessions.get(id),
        broadcast: (event, data) => events.push({ event, data }),
        files,
        now: () => clock,
      });
      registerChatroomRoutes(fastify, c, service, files, trustedFixtureOwner);
    });
    app = harness.app;
    ctx = harness.ctx;
    const s = createMockSession(A);
    s.name = 'alpha';
    ctx.sessions.set(A, s as never);
    roomId = service.createRoom('Reverie', undefined).id;
    service.addMember(roomId, A);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await service.stop();
    await app.close();
  });

  const upload = (name: string, type: string, data: Buffer, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/files?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      headers: { 'content-type': 'application/octet-stream', ...headers },
      payload: data,
    });

  it('rejects a persisted attachment index redirected to the bot token store', async () => {
    vi.stubEnv('REVERIE_DATA_DIR', root);
    writeFileSync(join(root, 'external-chat.json'), '{"token":"test-secret"}');
    const uploaded = (await upload('innocent.txt', 'text/plain', Buffer.from('safe'))).json().data.file;
    const indexPath = join(root, 'chatroom-files', roomId, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index[0].stored = '../../external-chat.json';
    writeFileSync(indexPath, JSON.stringify(index));
    const response = await app.inject({ url: `/api/chatrooms/${roomId}/files/${uploaded.id}` });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('test-secret');
  });

  it('stores an upload privately under the room and attaches it to a message', async () => {
    const res = await upload('../../etc/shot.png', 'image/png', PNG);
    expect(res.statusCode).toBe(200);
    const file = res.json().data.file;
    expect(file).toMatchObject({ name: 'shot.png', size: PNG.length, type: 'image/png' });
    const post = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text: '', attachments: [file.id] },
    });
    expect(post.statusCode).toBe(200);
    const att = post.json().data.message.attachments[0];
    expect(att.path.startsWith(join(root, 'chatroom-files', roomId))).toBe(true);
    expect(statSync(att.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(att.path)).toEqual(PNG);
  });

  it('enforces the per-file and per-room limits', async () => {
    expect((await upload('big.bin', 'application/octet-stream', Buffer.alloc(1025))).statusCode).toBe(413);
    expect((await upload('a.bin', '', Buffer.alloc(1000))).statusCode).toBe(200);
    expect((await upload('b.bin', '', Buffer.alloc(1000))).statusCode).toBe(200);
    const over = await upload('c.bin', '', Buffer.alloc(1000));
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toContain('attachments');
    expect((await upload('empty.bin', '', Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('serves only raster images inline; SVG and everything else download', async () => {
    const png = (await upload('p.png', 'image/png', PNG)).json().data.file;
    const svg = (await upload('x.svg', 'image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'))).json().data.file;
    const a = await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/files/${png.id}` });
    expect(a.headers['content-type']).toBe('image/png');
    expect(a.headers['content-disposition']).toMatch(/^inline/);
    const b = await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/files/${svg.id}` });
    expect(b.headers['content-type']).toBe('application/octet-stream');
    expect(b.headers['content-disposition']).toMatch(/^attachment/);
    expect(b.headers['x-content-type-options']).toBe('nosniff');
    expect(b.headers['content-security-policy']).toContain('sandbox');
  });

  it('refuses a message naming a file from elsewhere', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text: 'see', attachments: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(res.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text: '  ' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("hands an agent the attachment's absolute path on its one delivered line", async () => {
    await service.delivery.flushAll();
    const pane = (ctx.sessions.get(A) as unknown as { writeBuffer: string[] }).writeBuffer;
    pane.length = 0;
    clock += 10_000;
    const file = (await upload('log.txt', 'text/plain', Buffer.from('hello'))).json().data.file;
    const post = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text: '@alpha look at this', attachments: [file.id] },
    });
    const path = post.json().data.message.attachments[0].path;
    await service.delivery.flushAll();
    const line = pane.join('');
    expect(line).toContain(`USER: "@alpha look at this" [attached: ${JSON.stringify(path)}]`);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  it('toggles reactions per person, counts them, and broadcasts each change', async () => {
    const msg = (
      await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages`, payload: { text: 'ship it' } })
    ).json().data.message;
    const react = (emoji: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/chatrooms/${roomId}/messages/${msg.id}/reactions`,
        headers,
        payload: { emoji },
      });
    expect((await react('\u{1F44D}')).json().data.reactions).toEqual({ '\u{1F44D}': ['user'] });
    expect((await react('\u{1F44D}', { 'x-reverie-parent-session': A })).json().data.reactions).toEqual({
      '\u{1F44D}': ['user', A],
    });
    expect((await react('\u{1F44D}')).json().data.reactions).toEqual({ '\u{1F44D}': [A] });
    expect((await react('not an emoji at all')).statusCode).toBe(400);
    expect((await react(':nope:')).statusCode).toBe(400);
    expect(events.filter((e) => e.event === 'chatroom:reaction')).toHaveLength(3);
    const view = service.view(service.room(roomId)!);
    expect(view.messages.find((m) => m.id === msg.id)?.reactions).toEqual({ '\u{1F44D}': [A] });
  });

  it('adds, lists, serves and removes custom emotes, and allows them as reactions', async () => {
    const add = (name: string, type: string, data: Buffer, scope = '') =>
      app.inject({
        method: 'POST',
        url: `/api/chatrooms/${roomId}/emotes?name=${name}&type=${encodeURIComponent(type)}${scope}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: data,
      });
    expect((await add('party_parrot', 'image/png', PNG)).statusCode).toBe(200);
    expect((await add('globe', 'image/gif', PNG, '&scope=global')).statusCode).toBe(200);
    expect((await add('Bad Name', 'image/png', PNG)).statusCode).toBe(400);
    expect((await add('svg_one', 'image/svg+xml', PNG)).statusCode).toBe(415);
    const list = (await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/emotes` })).json().data.emotes;
    expect(list).toEqual([
      { name: 'party_parrot', scope: 'room' },
      { name: 'globe', scope: 'global' },
    ]);
    const img = await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/emotes/party_parrot/image` });
    expect(img.headers['content-type']).toBe('image/png');
    const msg = (
      await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages`, payload: { text: 'hi' } })
    ).json().data.message;
    const r = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages/${msg.id}/reactions`,
      payload: { emoji: ':party_parrot:' },
    });
    expect(r.json().data.reactions).toEqual({ ':party_parrot:': ['user'] });
    const del = await app.inject({ method: 'DELETE', url: `/api/chatrooms/${roomId}/emotes/party_parrot` });
    expect(del.statusCode).toBe(200);
    const byAgent = await app.inject({
      method: 'DELETE',
      url: `/api/chatrooms/${roomId}/emotes/globe?scope=global`,
      headers: { 'x-reverie-parent-session': A },
    });
    expect(byAgent.statusCode).toBe(403);
  });

  it("removes a deleted room's files", async () => {
    const file = (await upload('x.txt', 'text/plain', Buffer.from('x'))).json().data.file;
    const post = await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text: 'x', attachments: [file.id] },
    });
    const path = post.json().data.message.attachments[0].path;
    expect(existsSync(path)).toBe(true);
    await service.deleteRoom(roomId);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(path)).toBe(false);
  });

  it('keeps file names safe', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a\u0000b<c>.txt')).toBe('ab_c_.txt');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('')).toBe('file');
  });

  it('refuses letters as reactions but takes emoji, flags and keycap-like pictographs', async () => {
    const msg = (
      await app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages`, payload: { text: 'x' } })
    ).json().data.message;
    const react = (emoji: string) =>
      app.inject({ method: 'POST', url: `/api/chatrooms/${roomId}/messages/${msg.id}/reactions`, payload: { emoji } });
    expect((await react('ab')).statusCode).toBe(400);
    expect((await react('x')).statusCode).toBe(400);
    expect((await react('\u{1F1FA}\u{1F1F8}')).statusCode).toBe(200); // US flag
    expect((await react('\u2764\uFE0F')).statusCode).toBe(200);
    expect((await react('a\u{1F525}')).statusCode).toBe(400); // a letter plus an emoji
    expect((await react('1\uFE0F\u20E3')).statusCode).toBe(200); // keycap
    expect((await react('\u{1F44D}\u{1F3FD}')).statusCode).toBe(200); // skin tone
    expect((await react('\u{1F468}\u200D\u{1F4BB}')).statusCode).toBe(200); // ZWJ sequence
  });

  it('prunes unattached uploads after the grace period, freeing the room budget', async () => {
    const files = new ChatFileStore(root, { maxFile: 1024, maxRoom: 2500 });
    const kept = await files.add(roomId, { name: 'kept.bin', type: '', data: Buffer.alloc(1000), by: 'user' });
    const orphan = await files.add(roomId, { name: 'orphan.bin', type: '', data: Buffer.alloc(1000), by: 'user' });
    expect(await files.pruneUnreferenced(roomId, new Set([kept.id]), Date.now())).toBe(0); // still in grace
    expect(await files.pruneUnreferenced(roomId, new Set([kept.id]), Date.now() + 2 * 3600_000)).toBe(1);
    expect((await files.list(roomId)).map((f) => f.id)).toEqual([kept.id]);
    expect(existsSync(join(root, 'chatroom-files', roomId, orphan.stored))).toBe(false);
  });

  it('streams files with range support', async () => {
    const file = (await upload('d.bin', '', Buffer.from('0123456789'))).json().data.file;
    const whole = await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/files/${file.id}` });
    expect(whole.headers['content-length']).toBe('10');
    expect(whole.body).toBe('0123456789');
    const part = await app.inject({
      method: 'GET',
      url: `/api/chatrooms/${roomId}/files/${file.id}`,
      headers: { range: 'bytes=2-5' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');
    // Removed from disk after the index was read: a clean 404, not a broken stream.
    const { rmSync } = await import('node:fs');
    rmSync(
      join(
        root,
        'chatroom-files',
        roomId,
        (await new ChatFileStore(root).list(roomId)).find((f) => f.id === file.id)!.stored
      )
    );
    const gone = await app.inject({ method: 'GET', url: `/api/chatrooms/${roomId}/files/${file.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it("removes a deleted room's own emotes too", async () => {
    await app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/emotes?name=room_only&type=image/png`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: PNG,
    });
    await service.deleteRoom(roomId);
    await new Promise((r) => setTimeout(r, 50));
    const index = JSON.parse(readFileSync(join(root, 'chatroom-emotes', 'index.json'), 'utf8'));
    expect(index.filter((e: { scope: string }) => e.scope === roomId)).toEqual([]);
    expect(existsSync(join(root, 'chatroom-emotes', roomId))).toBe(false);
  });
});
