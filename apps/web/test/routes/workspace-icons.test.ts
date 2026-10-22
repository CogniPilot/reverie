/**
 * Workspace pictures: stored on the server (not per browser), owner-only to change, sniffed by their bytes like profile images, and
 * private to the owner they belong to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerWorkspaceIconRoutes } from '../../src/web/routes/workspace-icon-routes.js';
import { MAX_ICONS, MAX_ICON_BYTES, WorkspaceIconStore, workspaceIconKey } from '../../src/workspace-icons.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pretend pixels')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('data')]);
const AGENT = { 'x-reverie-parent-session': '0000002d-0035-4000-8000-000000000047' };

describe('workspace pictures', () => {
  let app: FastifyInstance;
  let root: string;
  let store: WorkspaceIconStore;

  beforeEach(async () => {
    root = join(mkdtempSync(join(tmpdir(), 'wsicons-')), 'workspace-icons');
    store = new WorkspaceIconStore(root);
    const harness = await createRouteTestHarness((fastify) => registerWorkspaceIconRoutes(fastify, store));
    app = harness.app;
  });
  afterEach(async () => {
    await app.close();
  });

  const put = (name: string, body: Buffer, type = 'image/png', headers: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: `/api/workspace-icons/image?name=${encodeURIComponent(name)}`, headers: { 'content-type': type, ...headers }, payload: body });
  const list = async () => (await app.inject({ method: 'GET', url: '/api/workspace-icons' })).json().data.icons as Record<string, string>;

  it('stores a PNG for a workspace, lists it by name, and serves its bytes with the safe headers', async () => {
    const res = await put('Acme', PNG);
    expect(res.statusCode).toBe(200);
    const url = res.json().data.url as string;
    expect(url).toMatch(/^\/api\/workspace-icons\/[0-9a-f]{32}\?v=\d+$/);
    expect(await list()).toEqual({ Acme: url });
    const served = await app.inject({ method: 'GET', url });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(served.rawPayload.equals(PNG)).toBe(true);
    // 0600 file in a private directory, plus the index
    const files = readdirSync(root).filter((f) => f.endsWith('.png'));
    expect(files).toHaveLength(1);
    expect(statSync(join(root, files[0])).mode & 0o777).toBe(0o600);
  });

  it('a name is matched ignoring case and spacing; the default workspace is the empty name; a new picture replaces the old one', async () => {
    const a = (await put('Acme', PNG)).json().data.url as string;
    const b = (await put('  acme ', WEBP, 'image/webp')).json().data.url as string;
    expect(Object.keys(await list())).toEqual(['acme']);
    expect(b).not.toBe(a);
    expect((await app.inject({ method: 'GET', url: b })).headers['content-type']).toBe('image/webp');
    expect(readdirSync(root).filter((f) => /\.(png|webp)$/.test(f))).toHaveLength(1);
    expect((await put('', PNG)).statusCode).toBe(200);
    expect(Object.keys(await list()).sort()).toEqual(['', 'acme']);
  });

  it('refuses anything that is not a PNG, JPEG, GIF or WebP by its bytes, and stores nothing', async () => {
    expect((await put('Acme', Buffer.from('<svg onload="x()"/>'), 'image/png')).statusCode).toBe(415);
    expect((await put('Acme', Buffer.from('<html></html>'), 'image/png')).statusCode).toBe(415);
    expect((await put('Acme', Buffer.alloc(0), 'application/octet-stream')).statusCode).toBe(400);
    expect((await put('Acme', Buffer.concat([PNG, Buffer.alloc(260 * 1024)]))).statusCode).toBe(413);
    expect(await list()).toEqual({});
    expect((await put('bad\u0007name', PNG)).statusCode).toBe(400);
    expect((await put('x'.repeat(61), PNG)).statusCode).toBe(400);
  });

  it('only the owner changes pictures: a request naming an agent session is refused, but it can read', async () => {
    expect((await put('Acme', PNG, 'image/png', AGENT)).statusCode).toBe(403);
    await put('Acme', PNG);
    expect((await app.inject({ method: 'DELETE', url: '/api/workspace-icons?name=Acme', headers: AGENT })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/workspace-icons/rename', headers: AGENT, payload: { from: 'Acme', to: 'X' } })).statusCode
    ).toBe(403);
    expect(Object.keys(await list())).toEqual(['Acme']);
    const listed = await app.inject({ method: 'GET', url: '/api/workspace-icons', headers: AGENT });
    expect(listed.statusCode).toBe(200);
    expect(Object.keys(listed.json().data.icons)).toEqual(['Acme']);
  });

  it('clears a picture, which then 404s', async () => {
    const url = (await put('Acme', PNG)).json().data.url as string;
    expect((await app.inject({ method: 'DELETE', url: '/api/workspace-icons?name=Acme' })).statusCode).toBe(200);
    expect(await list()).toEqual({});
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect(readdirSync(root).filter((f) => f.endsWith('.png'))).toEqual([]);
  });

  it('a renamed workspace keeps its picture; a name that already has one is not overwritten', async () => {
    await put('Old', PNG);
    const res = await app.inject({ method: 'POST', url: '/api/workspace-icons/rename', payload: { from: 'Old', to: 'New' } });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(await list())).toEqual(['New']);
    expect((await app.inject({ method: 'GET', url: (await list()).New })).rawPayload.equals(PNG)).toBe(true);
    await put('Other', WEBP, 'image/webp');
    const clash = await app.inject({ method: 'POST', url: '/api/workspace-icons/rename', payload: { from: 'New', to: 'Other' } });
    expect(clash.json().data.url).toBeNull();
    expect(Object.keys(await list()).sort()).toEqual(['New', 'Other']);
    const none = await app.inject({ method: 'POST', url: '/api/workspace-icons/rename', payload: { from: 'Nothing', to: 'Z' } });
    expect(none.json().data.url).toBeNull();
  });

  it('a picture belongs to its owner: another owner neither lists nor reads it, and a bad key is a 404', async () => {
    await store.put('alice', 'Acme', PNG);
    const key = workspaceIconKey('alice', 'Acme');
    expect(await store.list('bob')).toEqual({});
    expect(await store.get('bob', key)).toBeUndefined();
    expect((await store.get('alice', key))?.data.equals(PNG)).toBe(true);
    expect(workspaceIconKey('alice', 'Acme')).not.toBe(workspaceIconKey('bob', 'Acme'));
    expect((await app.inject({ method: 'GET', url: '/api/workspace-icons/not-a-key' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/workspace-icons/${'0'.repeat(32)}` })).statusCode).toBe(404);
  });

  it('caps the number of pictures and the bytes they take together, checked before anything is written', async () => {
    const tiny = new WorkspaceIconStore(join(mkdtempSync(join(tmpdir(), 'wscap-')), 'icons'));
    for (let i = 0; i < MAX_ICONS; i++) await tiny.put('o', `w${i}`, PNG);
    await expect(tiny.put('o', 'one-too-many', PNG)).rejects.toMatchObject({ status: 409 });
    // replacing an existing one is still fine at the cap
    await expect(tiny.put('o', 'w3', WEBP)).resolves.toMatch(/^\/api\/workspace-icons\//);
    expect(Object.keys(await tiny.list('o'))).toHaveLength(MAX_ICONS);
    // total bytes: 256 KB each, so 128 of them fill the cap
    const big = new WorkspaceIconStore(join(mkdtempSync(join(tmpdir(), 'wscap-')), 'icons'));
    const full = Buffer.concat([PNG, Buffer.alloc(255 * 1024)]);
    const fits = Math.floor(MAX_ICON_BYTES / full.length);
    for (let i = 0; i < fits; i++) await big.put('o', `b${i}`, full);
    await expect(big.put('o', 'over', full)).rejects.toMatchObject({ status: 413 });
    // replacing one with a smaller picture still works, and then there is room again
    await expect(big.put('o', 'b0', PNG)).resolves.toBeDefined();
    await expect(big.put('o', 'over', full)).resolves.toBeDefined();
    expect(readdirSync(big['root']).filter((f) => f.endsWith('.png'))).toHaveLength(Object.keys(await big.list('o')).length);
  });

  it('a read error is not an empty index: only a missing index is, and a corrupt one is set aside, not overwritten', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'wsidx-')), 'icons');
    const local = new WorkspaceIconStore(dir);
    await local.put('o', 'Keep', PNG);
    const index = join(dir, 'index.json');
    // an index that cannot be read (here: a directory in its place) fails the write instead of replacing it
    const saved = readFileSync(index);
    rmSync(index);
    mkdirSync(index);
    await expect(local.put('o', 'Other', PNG)).rejects.toThrow();
    await expect(local.list('o')).rejects.toThrow();
    rmSync(index, { recursive: true });
    writeFileSync(index, saved);
    expect(Object.keys(await local.list('o'))).toEqual(['Keep']);
    // not JSON: kept under another name, then the store carries on empty
    writeFileSync(index, '{ not json');
    expect(await local.list('o')).toEqual({});
    expect(readdirSync(dir).some((f) => f.startsWith('index.json.corrupt-'))).toBe(true);
    // missing: empty
    rmSync(index, { force: true });
    expect(await local.list('o')).toEqual({});
  });

  it('a rename that only changes the case keeps the picture under the new spelling; names are matched in NFC', async () => {
    await put('Acme', PNG);
    const res = await app.inject({ method: 'POST', url: '/api/workspace-icons/rename', payload: { from: 'Acme', to: 'acme' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toMatch(/^\/api\/workspace-icons\//);
    expect(Object.keys(await list())).toEqual(['acme']);
    expect((await app.inject({ method: 'GET', url: (await list()).acme })).rawPayload.equals(PNG)).toBe(true);
    // é as one code point and as e + combining accent are one name
    await put('Caf\u00e9', PNG);
    await put('Cafe\u0301', WEBP, 'image/webp');
    expect(Object.keys(await list()).filter((n) => n.startsWith('Caf'))).toHaveLength(1);
  });

  it('serves a picture with a long-lived immutable cache and an ETag, and answers a repeat with 304 and no body', async () => {
    const url = (await put('Acme', PNG)).json().data.url as string;
    const first = await app.inject({ method: 'GET', url });
    expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    // a new picture is a new link and a new ETag
    const url2 = (await put('Acme', WEBP, 'image/webp')).json().data.url as string;
    expect(url2).not.toBe(url);
    expect((await app.inject({ method: 'GET', url: url2 })).headers.etag).not.toBe(etag);
  });

  it('a failed write of the new file during a rename leaves the old picture and its index entry alone', async () => {
    await put('Old', PNG);
    const before = await list();
    const key = workspaceIconKey(undefined, 'New');
    // block the target name with a directory so the new file cannot be written
    mkdirSync(join(root, `${key}.png`));
    const res = await app.inject({ method: 'POST', url: '/api/workspace-icons/rename', payload: { from: 'Old', to: 'New' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await list()).toEqual(before);
    expect((await app.inject({ method: 'GET', url: before.Old })).rawPayload.equals(PNG)).toBe(true);
  });

  it('two uploads at once both land in the index', async () => {
    await Promise.all([put('A', PNG), put('B', WEBP, 'image/webp'), put('C', PNG)]);
    expect(Object.keys(await list()).sort()).toEqual(['A', 'B', 'C']);
  });
});
