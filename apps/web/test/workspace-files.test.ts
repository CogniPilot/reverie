import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile, readFile, symlink, link, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { workspaceServer } from './helpers/workspace-server.js';
import { WorkspaceFiles, WORKSPACE_MAX_FILE } from '../src/workspace-files.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';

const simulatedMount = vi.hoisted(() => ({ enabled: false, reads: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (simulatedMount.enabled && String(args[0]).startsWith('/proc/self/fdinfo/'))
        return Promise.resolve(`mnt_id: ${simulatedMount.reads++ === 0 ? 100 : 101}\n`);
      return fs.readFile(...args);
    },
  };
});
let fixture: Awaited<ReturnType<typeof workspaceServer>>;
beforeEach(async () => {
  fixture = await workspaceServer();
});
afterEach(async () => {
  await fixture.close();
});
const get = (path: string, preview = false) =>
  fixture.app.inject({
    url: `/api/workspace/file?${new URLSearchParams({ path, ...(preview ? { preview: '1' } : {}) })}`,
    cookies: fixture.cookies,
  });
const upload = (name: string, bytes: Buffer, path = '') =>
  fixture.app.inject({
    method: 'POST',
    url: `/api/workspace/files?${new URLSearchParams({ path, name })}`,
    cookies: fixture.cookies,
    headers: {
      'content-type': 'application/octet-stream',
      'x-reverie-workspace-upload': '1',
      origin: 'http://localhost',
    },
    payload: bytes,
  });

describe('owner workspace boundary', () => {
  it('requires a verified unrestricted owner cookie for page/list/download/upload and rejects agent or cross-origin requests', async () => {
    for (const url of [
      '/workspace',
      '/workspace-files.html',
      '/workspace-files.js',
      '/workspace-files.css',
      '/api/workspace/files',
      '/api/workspace/file?path=picture.png',
    ]) {
      for (const cookies of [{}, { [OWNER_COOKIE]: 'forged' }, { [OWNER_COOKIE]: fixture.restricted }])
        expect((await fixture.app.inject({ url, cookies })).statusCode).toBe(403);
      expect(
        (await fixture.app.inject({ url, cookies: fixture.cookies, headers: { 'x-reverie-parent-session': 'agent' } }))
          .statusCode
      ).toBe(403);
      expect(
        (await fixture.app.inject({ url, cookies: fixture.cookies, headers: { origin: 'https://evil.test' } }))
          .statusCode
      ).toBe(403);
      expect(
        (await fixture.app.inject({ url, cookies: fixture.cookies, headers: { 'sec-fetch-site': 'cross-site' } }))
          .statusCode
      ).toBe(403);
    }
    expect(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/workspace/files?name=x',
          cookies: fixture.cookies,
          headers: { 'content-type': 'application/octet-stream', 'x-reverie-workspace-upload': '1' },
          payload: Buffer.from('private'),
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/workspace/files?name=x',
          headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost' },
          payload: Buffer.from('private'),
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/workspace/files?name=x',
          cookies: fixture.cookies,
          headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost' },
          payload: Buffer.from('private'),
        })
      ).statusCode
    ).toBe(400);
  });
  it('serves the page, its static alias and modules with verified owner auth and no-store caching', async () => {
    for (const url of ['/workspace', '/workspace-files.html', '/workspace-files.js', '/workspace-files.css']) {
      const response = await fixture.app.inject({ url, cookies: fixture.cookies });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });
  it('rejects absolute, traversal, hidden, control, symlink, hardlink and sensitive files without exposing metadata', async () => {
    await writeFile(join(fixture.task, 'outside.txt'), 'outside secret');
    await symlink(fixture.task, join(fixture.root, 'escape'));
    await symlink(join(fixture.root, 'Projects'), join(fixture.root, 'inside-link'));
    await link(join(fixture.task, 'outside.txt'), join(fixture.root, 'hard.txt'));
    await writeFile(join(fixture.root, '.env'), 'secret');
    await writeFile(join(fixture.root, 'credentials.json'), 'secret');
    for (const path of [
      '../outside.txt',
      '/etc/passwd',
      'Projects/../../outside.txt',
      'escape/outside.txt',
      'inside-link/hello λ.txt',
      'hard.txt',
      '.env',
      'credentials.json',
      'Projects\\hello.txt',
      'a\0b',
      'a//b',
    ]) {
      expect((await get(path)).statusCode, path).toBeGreaterThanOrEqual(400);
      expect((await upload(path, Buffer.from('bad'))).statusCode, path).toBeGreaterThanOrEqual(400);
    }
    for (const destination of ['escape', 'inside-link', '../'])
      expect((await upload('new.bin', Buffer.from('bad'), destination)).statusCode).toBeGreaterThanOrEqual(400);
    const list = await fixture.app.inject({ url: '/api/workspace/files', cookies: fixture.cookies });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(/escape|inside-link|hard.txt|credentials|\.env|outside secret/);
    await expect(new WorkspaceFiles(() => '/').list('')).rejects.toMatchObject({ status: 403 });
    await expect(new WorkspaceFiles(() => undefined).list('')).rejects.toMatchObject({ status: 503 });
  });
  it('rejects a same-device child whose kernel descriptor mount ID differs from the root', async () => {
    simulatedMount.enabled = true;
    simulatedMount.reads = 0;
    try {
      expect((await get('picture.png')).statusCode).toBe(403);
    } finally {
      simulatedMount.enabled = false;
    }
  });
  it('serves real HTTP curl list/upload/download with exact bytes and owner protection', async () => {
    const origin = await fixture.app.listen({ port: 0, host: '127.0.0.1' });
    const curl = promisify(execFile);
    const run = (...args: string[]) => curl('curl', ['--silent', '--show-error', '--max-time', '10', ...args]);
    expect((await run('-o', '/dev/null', '-w', '%{http_code}', origin + '/api/workspace/files')).stdout).toBe('403');
    const auth = ['--cookie', `${OWNER_COOKIE}=${fixture.ownerCookie}`];
    expect(JSON.parse((await run(...auth, origin + '/api/workspace/files')).stdout).data.entries.length).toBe(3);
    const bytes = Buffer.from([0, 255, 13, 10, 128, 1]);
    const input = join(fixture.task, 'curl-input.bin'),
      output = join(fixture.task, 'curl-output.bin');
    await writeFile(input, bytes);
    expect(
      (
        await run(
          ...auth,
          '-X',
          'POST',
          '-H',
          `Origin: ${origin}`,
          '-H',
          'Content-Type: application/octet-stream',
          '-H',
          'X-Reverie-Workspace-Upload: 1',
          '--data-binary',
          '@' + input,
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          origin + '/api/workspace/files?name=curl.bin'
        )
      ).stdout
    ).toBe('201');
    expect(
      (await run(...auth, '-o', output, '-w', '%{http_code}', origin + '/api/workspace/file?path=curl.bin')).stdout
    ).toBe('200');
    expect((await readFile(output)).equals(bytes)).toBe(true);
  });
  it('lists nested and empty folders and gives safe UTF-8 text/raster previews without running HTML or SVG', async () => {
    const list = await fixture.app.inject({ url: '/api/workspace/files?path=Projects', cookies: fixture.cookies });
    expect(list.json().data.entries[0].name).toBe('hello λ.txt');
    expect((await fixture.files.list('Empty')).entries).toEqual([]);
    const preview = await get('Projects/hello λ.txt', true);
    expect(preview.headers['content-type']).toMatch(/^text\/plain/);
    expect(preview.body).toContain('<img');
    expect(preview.headers['content-security-policy']).toContain('sandbox');
    expect((await get('picture.png', true)).headers['content-type']).toBe('image/png');
    await writeFile(join(fixture.root, 'active.svg'), '<svg onload="bad()"/>');
    expect((await get('active.svg', true)).headers['content-type']).toMatch(/^text\/plain/);
    await writeFile(join(fixture.root, 'binary.txt'), Buffer.from([0, 255, 10]));
    expect((await get('binary.txt', true)).statusCode).toBe(415);
  });
  it('previews a movie as video it plays, only when its bytes are that container, and never as text', async () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(4096, 7)]);
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(4096, 1)]);
    const cases: Array<[string, Buffer, string]> = [['sim run λ.mp4', mp4, 'video/mp4'], ['clip.M4V', mp4, 'video/mp4'],
      ['take.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]), 'video/webm'],
      ['phone.mov', Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(64)]), 'video/quicktime'],
      ['flight.ogv', ogg, 'video/ogg']];
    for (const [name, bytes, type] of cases) {
      await writeFile(join(fixture.root, name), bytes);
      const preview = await get(name, true);
      expect(preview.statusCode, name).toBe(200);
      expect(preview.headers['content-type'], name).toBe(type);
      expect(preview.headers['content-disposition'], name).toMatch(/^inline;/);
      expect(preview.headers['content-security-policy'], name).toContain('sandbox');
      expect(preview.rawPayload.equals(bytes), name).toBe(true);
    }
    // A page or script named like a movie is never served under a playable (or any renderable) type.
    await writeFile(join(fixture.root, 'trap.mp4'), '<html><script>bad()</script>');
    expect((await get('trap.mp4', true)).statusCode).toBe(415);
    await writeFile(join(fixture.root, 'mislabelled.webm'), mp4);
    expect((await get('mislabelled.webm', true)).statusCode).toBe(415);
    // A download of the same file is unchanged.
    expect((await get('sim run λ.mp4')).headers['content-type']).toBe('application/octet-stream');
  });
  it('preserves exact 25 MiB binary bytes, Unicode and spaces, does not overwrite and removes temporary files', async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024);
    for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
    const name = 'report λ with spaces.zip';
    const result = await upload(name, bytes);
    expect(result.statusCode, result.body).toBe(201);
    expect((await readFile(join(fixture.root, name))).equals(bytes)).toBe(true);
    const downloaded = await get(name);
    expect(downloaded.rawPayload.equals(bytes)).toBe(true);
    expect(downloaded.headers['content-disposition']).toContain(encodeURIComponent(name));
    expect(downloaded.headers['cache-control']).toBe('no-store');
    expect((await upload(name, Buffer.from('replacement'))).statusCode).toBe(409);
    expect((await readFile(join(fixture.root, name))).equals(bytes)).toBe(true);
    expect((await readdir(join(fixture.root, 'Projects'))).some((n) => n.startsWith('.reverie-upload'))).toBe(false);
    expect((await upload('zero.txt', Buffer.alloc(0))).statusCode).toBe(201);
    expect((await get('zero.txt')).rawPayload).toEqual(Buffer.alloc(0));
  });
  it('reports timeout and storage-full upload failures with useful recovery guidance', async () => {
    const operation = vi.spyOn(fixture.files, 'upload');
    operation.mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    const full = await upload('full.txt', Buffer.from('x'));
    expect(full.statusCode).toBe(507);
    expect(full.json().error).toContain('storage is full');
    operation.mockRejectedValueOnce(Object.assign(new Error('deadline'), { name: 'AbortError' }));
    const timed = await upload('timed.txt', Buffer.from('x'));
    expect(timed.statusCode).toBe(408);
    expect(timed.json().error).toContain('timed out');
  });
  it('admits one process-wide operation and releases it after actual cleanup', async () => {
    const files = new WorkspaceFiles(
      () => fixture.root,
      50,
      async () => {}
    );
    const attempts = Array.from({ length: 8 }, (_, i) =>
      files.upload('', `slow-${i}.bin`, new Readable({ read() {} }), 1)
    );
    const outcomes = await Promise.allSettled(attempts);
    expect(outcomes.filter((r) => r.status === 'rejected' && r.reason.status === 429)).toHaveLength(7);
    expect(outcomes.filter((r) => r.status === 'rejected' && r.reason.status === 408)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await readdir(fixture.root)).some((n) => n.startsWith('.reverie-upload'))).toBe(false);
    await files.upload('', 'after.txt', Readable.from([Buffer.from('ok')]), 2);
    expect(await readFile(join(fixture.root, 'after.txt'), 'utf8')).toBe('ok');
  });
  it('bounds declared and actual sizes, cleans aborted/short uploads, and refuses oversized preview/download', async () => {
    await expect(fixture.files.upload('', 'huge.bin', Readable.from([]), WORKSPACE_MAX_FILE + 1)).rejects.toMatchObject(
      { status: 413 }
    );
    await expect(fixture.files.upload('', 'long.bin', Readable.from([Buffer.from('123')]), 2)).rejects.toMatchObject({
      status: 413,
    });
    await expect(fixture.files.upload('', 'short.bin', Readable.from([Buffer.from('1')]), 2)).rejects.toMatchObject({
      status: 400,
    });
    const aborted = new Readable({
      read() {
        this.push(Buffer.from('part'));
        this.destroy(new Error('client aborted'));
      },
    });
    await expect(fixture.files.upload('', 'aborted.bin', aborted, 10)).rejects.toThrow('client aborted');
    expect((await readdir(fixture.root)).sort()).toEqual(['Empty', 'Projects', 'picture.png']);
    await writeFile(join(fixture.root, 'large.txt'), Buffer.alloc(256 * 1024 + 1, 65));
    expect((await get('large.txt', true)).statusCode).toBe(413);
    const { open } = await import('node:fs/promises');
    const large = await open(join(fixture.root, 'large.bin'), 'w');
    await large.truncate(WORKSPACE_MAX_FILE + 1);
    await large.close();
    expect((await get('large.bin')).statusCode).toBe(413);
  });
});
