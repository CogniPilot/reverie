/**
 * @fileoverview The owner's profile picture on the server: owner only to set or clear, kept as a link in the company settings the
 * page already loads, and served privately with a versioned immutable cache and an ETag. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerCompanyRoutes } from '../../src/web/routes/company-routes.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { AvatarStore } from '../../src/agent-avatars.js';
import { OWNER_AVATAR_URL, ownerAvatarKey } from '../../src/owner-avatar.js';
import type { SessionPort } from '../../src/web/ports/session-port.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(16, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const AGENT = { 'x-codeman-parent-session': 'alpha-session' };

describe('the owner profile picture', () => {
  let app: FastifyInstance;
  let directory: string;
  let service: CompanyService;
  let changed: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fleet-owner-avatar-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const chatrooms = new ChatroomService({ file: join(directory, 'chatrooms.json'), getSession: () => undefined, broadcast: () => {} });
    await chatrooms.init();
    changed = vi.fn();
    service = new CompanyService(store, {
      getSession: () => undefined,
      chatrooms,
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
      ownerProfileChanged: changed,
    });
    app = Fastify();
    registerCompanyRoutes(
      app,
      { sessions: new Map() } as unknown as SessionPort,
      service,
      new AvatarStore(join(directory, 'agent-avatars')),
      new AvatarStore(join(directory, 'owner-avatars'))
    );
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const post = (body: Buffer, type = 'image/png', headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/company/owner/avatar', headers: { 'content-type': type, ...headers }, payload: body });
  const company = async (headers: Record<string, string> = {}) => (await app.inject({ method: 'GET', url: '/api/company', headers })).json().data;

  it('stores a PNG, puts its versioned link in the company settings, tells open pages, and serves the bytes safely', async () => {
    const res = await post(PNG);
    expect(res.statusCode).toBe(200);
    const link = res.json().data.settings.ownerAvatar as string;
    expect(link).toMatch(OWNER_AVATAR_URL);
    expect((await company()).settings.ownerAvatar).toBe(link);
    expect(changed).toHaveBeenCalledTimes(1);
    const served = await app.inject({ method: 'GET', url: link });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(served.rawPayload.equals(PNG)).toBe(true);
    const files = (await readdir(join(directory, 'owner-avatars'))).filter((f) => f.endsWith('.png'));
    expect(files).toHaveLength(1);
    expect((await stat(join(directory, 'owner-avatars', files[0]))).mode & 0o777).toBe(0o600);
  });

  it('serves with a year-long immutable cache and an ETag, and answers a repeat with 304 and no body; a new picture is a new link', async () => {
    const link = (await post(PNG)).json().data.settings.ownerAvatar as string;
    const first = await app.inject({ method: 'GET', url: link });
    expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await app.inject({ method: 'GET', url: link, headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    expect(again.headers['x-content-type-options']).toBe('nosniff');
    const next = (await post(WEBP, 'image/webp')).json().data.settings.ownerAvatar as string;
    expect(next).not.toBe(link);
    expect((await app.inject({ method: 'GET', url: next })).headers.etag).not.toBe(etag);
    expect((await readdir(join(directory, 'owner-avatars'))).filter((f) => /\.(png|webp)$/.test(f))).toHaveLength(1);
  });

  it('refuses SVG, HTML, empty and oversized uploads and stores and records nothing', async () => {
    expect((await post(SVG)).statusCode).toBe(415);
    expect((await post(Buffer.from('<html></html>'))).statusCode).toBe(415);
    expect((await post(Buffer.alloc(0), 'application/octet-stream')).statusCode).toBe(400);
    expect((await post(Buffer.concat([PNG, Buffer.alloc(260 * 1024)]))).statusCode).toBe(413);
    expect((await company()).settings?.ownerAvatar).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it('is owner only: a request naming an agent session cannot set or clear it, but the link in the settings is readable', async () => {
    expect((await post(PNG, 'image/png', AGENT)).statusCode).toBe(403);
    await post(PNG);
    expect((await app.inject({ method: 'DELETE', url: '/api/company/owner/avatar', headers: AGENT })).statusCode).toBe(403);
    expect((await company(AGENT)).settings.ownerAvatar).toMatch(OWNER_AVATAR_URL);
  });

  it('a new picture always gets a higher version than the last, even within the same millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const first = (await post(PNG)).json().data.settings.ownerAvatar as string;
      const second = (await post(WEBP, 'image/webp')).json().data.settings.ownerAvatar as string;
      const v = (link: string) => Number(/\?v=(\d+)$/.exec(link)?.[1]);
      expect(v(first)).toBe(1_800_000_000_000);
      expect(v(second)).toBe(1_800_000_000_001);
      // a clock that stepped back still goes up
      now.mockReturnValue(1_700_000_000_000);
      const third = (await post(PNG)).json().data.settings.ownerAvatar as string;
      expect(v(third)).toBe(1_800_000_000_002);
    } finally {
      now.mockRestore();
    }
  });

  it('clearing removes the link, the file, and the picture itself (404)', async () => {
    const link = (await post(PNG)).json().data.settings.ownerAvatar as string;
    changed.mockClear();
    expect((await app.inject({ method: 'DELETE', url: '/api/company/owner/avatar' })).statusCode).toBe(200);
    expect((await company()).settings.ownerAvatar).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(404);
    expect((await readdir(join(directory, 'owner-avatars'))).filter((f) => f.endsWith('.png'))).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('a settings update neither sets, clears, nor spoofs the link, and the picture route only serves the caller’s own key', async () => {
    const link = (await post(PNG)).json().data.settings.ownerAvatar as string;
    const settings = (await company()).settings;
    // a settings save from the page (which sends the whole object back) keeps the link
    const saved = await app.inject({ method: 'PUT', url: '/api/company/settings', payload: { ...settings, ownerName: 'Pat Example' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.settings.ownerAvatar).toBe(link);
    // a client-chosen link is ignored
    await app.inject({ method: 'PUT', url: '/api/company/settings', payload: { ...settings, ownerAvatar: '/api/owner-avatar/' + 'f'.repeat(32) + '?v=1' } });
    expect((await company()).settings.ownerAvatar).toBe(link);
    // another key (another owner's) is a 404
    expect((await app.inject({ method: 'GET', url: `/api/owner-avatar/${'0'.repeat(32)}?v=1` })).statusCode).toBe(404);
    expect(ownerAvatarKey('alice')).not.toBe(ownerAvatarKey('bob'));
    expect(ownerAvatarKey(undefined)).toMatch(/^[0-9a-f]{32}$/);
  });
});
