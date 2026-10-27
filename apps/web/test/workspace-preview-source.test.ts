import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdir, writeFile, rename, symlink, link, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceServer } from './helpers/workspace-server.js';
import { WorkspaceFiles, WORKSPACE_MAX_PDF } from '../src/workspace-files.js';

let server: Awaited<ReturnType<typeof workspaceServer>>;
beforeEach(async () => { server = await workspaceServer(); });
afterEach(async () => { await server?.close(); });
const resolveFile = (path: string) => server.app.inject({ method: 'GET',
  url: `/api/workspace/resolve?path=${encodeURIComponent(path)}`, cookies: server.cookies });
const read = (path: string, binding: string, preview = true) => server.app.inject({ method: 'GET',
  url: `/api/workspace/file?path=${encodeURIComponent(path)}&binding=${binding}${preview ? '&preview=1' : ''}`, cookies: server.cookies });

it('resolves a genuine Workspace path to canonical crumbs and a non-authorizing content binding', async () => {
  const path = join(server.root, 'Projects', 'hello λ.txt');
  const resolved = await resolveFile(path);
  expect(resolved.statusCode).toBe(200);
  const info = resolved.json().data;
  expect(info).toMatchObject({ kind: 'workspace', path: 'Projects/hello λ.txt', name: 'hello λ.txt', absolutePath: path,
    crumbs: [{ name: server.root, path: '' }, { name: 'Projects', path: 'Projects' }] });
  expect(info.binding).toMatch(/^[a-f0-9]{64}$/);
  const content = await read(info.path, info.binding);
  expect(content.statusCode).toBe(200);
  expect(content.headers['x-reverie-file-binding']).toBe(info.binding);
  expect(content.body).toContain('Hello λ');
  // Possessing metadata/binding never substitutes for the current owner cookie.
  const refused = await server.app.inject({ url: `/api/workspace/file?path=${encodeURIComponent(info.path)}&binding=${info.binding}&preview=1` });
  expect(refused.statusCode).toBe(403);
});
it('keeps resolve and read behind fresh owner/same-origin/agent-header checks', async () => {
  const url = `/api/workspace/resolve?path=${encodeURIComponent(join(server.root, 'picture.png'))}`;
  for (const options of [
    { headers: {} },
    { cookies: server.cookies, headers: { origin: 'https://other.example' } },
    { cookies: server.cookies, headers: { 'sec-fetch-site': 'cross-site' } },
    { cookies: server.cookies, headers: { 'x-reverie-parent-session': 'agent' } },
  ]) {
    const result = await server.app.inject({ method: 'GET', url, ...options });
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain(server.root);
  }
});
it('refuses traversal, hidden/outside paths, directories, symlinks and hardlinks without alias expansion', async () => {
  await writeFile(join(server.root, '.hidden.txt'), 'private');
  await symlink(join(server.root, 'picture.png'), join(server.root, 'alias.png'));
  await writeFile(join(server.root, 'linked.txt'), 'linked');
  await link(join(server.root, 'linked.txt'), join(server.root, 'hard.txt'));
  const paths = ['Projects/hello λ.txt', join(server.root, '.hidden.txt'), `${server.root}/Projects/../picture.png`,
    join(server.task, 'elsewhere.txt'), join(server.root, 'Projects'), join(server.root, 'alias.png'),
    join(server.root, 'hard.txt'), `${server.root}//picture.png`];
  for (const path of paths) expect((await resolveFile(path)).statusCode).not.toBe(200);
});
it('rejects same-name replacement and changed contents after resolution', async () => {
  const path = join(server.root, 'Projects', 'hello λ.txt');
  const info = (await resolveFile(path)).json().data;
  await rename(path, path + '.old');
  await writeFile(path, 'different file');
  expect((await read(info.path, info.binding)).statusCode).toBe(409);
  const next = (await resolveFile(path)).json().data;
  await writeFile(path, 'same inode, changed content');
  expect((await read(next.path, next.binding)).statusCode).toBe(409);
});
it('rejects a replacement configured-root inode even when file names/content are the same', async () => {
  const info = (await resolveFile(join(server.root, 'Projects', 'hello λ.txt'))).json().data;
  await rename(server.root, server.root + '.old');
  await mkdir(join(server.root, 'Projects'), { recursive: true });
  await writeFile(join(server.root, 'Projects', 'hello λ.txt'), 'Hello λ\n<img src=x onerror="window.executed=true">\n');
  expect((await read(info.path, info.binding)).statusCode).toBe(409);
});
it('refuses stale bindings after the configured root changes and resolves only its selected namespace', async () => {
  const second = join(server.task, 'second'); await mkdir(second); await writeFile(join(second, 'a.txt'), 'a');
  await writeFile(join(server.root, 'a.txt'), 'a');
  let selected = server.root;
  const files = new WorkspaceFiles(() => selected);
  const info = await files.resolve(join(server.root, 'a.txt'));
  selected = second;
  await expect(files.file('a.txt', true, info.binding)).rejects.toMatchObject({ status: 409 });
  await expect(files.resolve(join(server.root, 'a.txt'))).rejects.toMatchObject({ status: 403 });
});
it('adds bounded signature-based PDF preview under the same existing file guards', async () => {
  await writeFile(join(server.root, 'report.pdf'), '%PDF-1.7\n% controlled test header\n');
  const info = (await resolveFile(join(server.root, 'report.pdf'))).json().data;
  const result = await read(info.path, info.binding);
  expect(result.statusCode).toBe(200);
  expect(result.headers['content-type']).toBe('application/pdf');
  expect(result.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(result.headers['x-content-type-options']).toBe('nosniff');
  expect(result.headers['content-disposition']).toContain('inline');
  expect((await read(info.path, info.binding, false)).headers['content-disposition']).toContain('attachment');
});
it('refuses unsupported PDF claims and PDF preview over16MiB while retaining bounded download', async () => {
  const path = join(server.root, 'report.pdf');
  await writeFile(path, '<html>not PDF</html>');
  let info = (await resolveFile(path)).json().data;
  expect((await read(info.path, info.binding)).statusCode).toBe(415);
  await writeFile(path, '%PDF-1.7\n'); await truncate(path, WORKSPACE_MAX_PDF + 1);
  info = (await resolveFile(path)).json().data;
  expect((await read(info.path, info.binding)).statusCode).toBe(413);
});
it('returns bindings on listed files without attributing a path to attachment snapshots', async () => {
  const response = await server.app.inject({ url: '/api/workspace/files?path=Projects', cookies: server.cookies });
  const item = response.json().data.entries.find((entry: any) => entry.name === 'hello λ.txt');
  expect(item.binding).toMatch(/^[a-f0-9]{64}$/);
  expect(item.absolutePath).toBe(join(server.root, 'Projects', 'hello λ.txt'));
  expect((await read(item.path, item.binding)).statusCode).toBe(200);
});
it('refuses malformed and mismatched consistency bindings', async () => {
  for (const binding of ['bad', 'A'.repeat(64), 'a'.repeat(65)])
    expect((await read('picture.png', binding)).statusCode).toBe(400);
  expect((await read('picture.png', 'a'.repeat(64))).statusCode).toBe(409);
});

it('does not complete a streamed file after its directory entry is replaced mid-read', async () => {
  const path = join(server.root, 'large.bin');
  await writeFile(path, Buffer.alloc(512 * 1024, 65));
  const files = new WorkspaceFiles(() => server.root);
  const info = await files.resolve(path);
  const result = await files.file('large.bin', false, info.binding);
  const errors: unknown[] = [];
  result.stream.on('error', (error) => errors.push(error));
  // The bounded PassThrough is backpressured until a consumer drains it.
  await rename(path, path + '.old');
  await writeFile(path, Buffer.alloc(512 * 1024, 66));
  const consume = async () => { for await (const _chunk of result.stream) { void _chunk; /* drain to EOF */ } };
  await expect(consume()).rejects.toMatchObject({ status: 409 });
  expect(errors).not.toHaveLength(0);
  await new Promise<void>((done) => setTimeout(done, 20));
});
it('rejects malformed PDF version signatures rather than trusting a filename or bare prefix', async () => {
  const path = join(server.root, 'bad.pdf');
  for (const data of ['%PDF-not-a-version', '%PDF-9.9\n']) {
    await writeFile(path, data);
    const info = (await resolveFile(path)).json().data;
    expect((await read(info.path, info.binding)).statusCode).toBe(415);
  }
});
it('finishes successful HTTP only after the final consistency guard completes', async () => {
  const path = join(server.root, 'http-gate.txt'); await writeFile(path, 'stable bytes');
  const info = await server.files.resolve(path);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), atFinal = new Promise<void>(r => { entered = r; });
  const original = (server.files as any).current.bind(server.files); let calls = 0;
  (server.files as any).current = async (...args: any[]) => { if (++calls === 2) { entered(); await gate; } return original(...args); };
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = Object.entries(server.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const response = fetch(`${address}/api/workspace/file?path=http-gate.txt&preview=1&binding=${info.binding}`, { headers: { cookie } })
    .then(async r => ({ status: r.status, text: await r.text() }));
  await atFinal;
  const early = await Promise.race([response.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 100))]);
  release(); const delivered = await response;
  expect(early).toBe(false); expect(delivered).toEqual({ status: 200, text: 'stable bytes' });
});
