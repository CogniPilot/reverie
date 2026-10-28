import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Command } from 'commander';
import {
  agentCredentialsInstall,
  agentCredentialsList,
  fetchGrantedCredentials,
} from '../src/cli-agent-credentials.js';
import {
  httpRequest,
  registerAgentCommands,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';
import { credentialReferences } from '../src/credential-references.js';

const rootFixture = vi.hoisted(() => ({
  normalizeNixRoot: process.env.NIX_REVERIE_TEST_ROOT_CUSTODY === '1',
  unknownRoot: false,
}));
// Nix's UID namespace exposes its trusted sandbox root as overflow UID 65534.
// Model only that root FD's owner for these custody fixtures; production rejects
// it. Every child FD, named edge, inode, mode, link count and file byte stays real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] !== '/') return handle;
      const root = await actual.lstat('/');
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat')
            return async (...options: unknown[]) => {
              const info = await Reflect.apply(target.stat, target, options);
              if (info.dev !== root.dev || info.ino !== root.ino) throw Error('Root fixture identity changed');
              const uid = rootFixture.unknownRoot
                ? 65534
                : rootFixture.normalizeNixRoot && info.uid === 65534
                  ? 0
                  : info.uid;
              return new Proxy(info, {
                get(value, field) {
                  if (field === 'uid') return uid;
                  const result = Reflect.get(value, field);
                  return typeof result === 'function' ? result.bind(value) : result;
                },
              });
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

const SID = '11111111-1111-4111-8111-111111111111',
  EID = 'employee-1';
const ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'fixture-PAT-DO-NOT-PROJECT';
const row = { id: ID, name: 'repo-code', repositories: ['owner/repo'], createdAt: 1, updatedAt: 2 };
const homes: string[] = [];
async function home() {
  const path = await mkdtemp(join(await realpath(process.env.TMPDIR || tmpdir()), 'reverie-pat-cli-'));
  homes.push(path);
  return path;
}
afterEach(async () => {
  for (const p of homes.splice(0)) await rm(p, { recursive: true, force: true });
});
function client(
  options: { identity?: unknown; list?: unknown; material?: Partial<ApiResponse>; requestError?: string } = {}
) {
  const out: string[] = [],
    err: string[] = [],
    calls: RequestOptions[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://fixture', selfId: SID },
    json: true,
    io: { out: (x) => out.push(x), err: (x) => err.push(x) },
    request: async (_ctx, req) => {
      calls.push(req);
      if (options.requestError) throw Error(options.requestError);
      if (req.path === '/api/board')
        return {
          status: 200,
          text: '',
          json: {
            success: true,
            data: {
              capabilities: { identity: options.identity ?? { kind: 'agent', employeeId: EID, sessionId: SID } },
            },
          },
        };
      if (req.path === '/api/publication/credentials')
        return {
          status: 200,
          text: '',
          json: { success: true, data: options.list ?? { employeeId: EID, sessionId: SID, credentials: [row] } },
        };
      return {
        status: 200,
        text: '',
        bytes: Buffer.from(SECRET),
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-reverie-employee-id': EID,
          'x-reverie-session-id': SID,
          'x-reverie-credential-id': ID,
        },
        ...options.material,
      };
    },
  };
  return { deps, out, err, calls };
}

describe('explicit named PAT CLI', () => {
  it('refuses an unknown root owner outside the trusted sandbox fixture adaptation', async () => {
    const h = await home(), c = client();
    const previous = rootFixture.normalizeNixRoot;
    rootFixture.normalizeNixRoot = false;
    rootFixture.unknownRoot = true;
    try {
      expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
      expect(c.out.join('')).not.toContain(SECRET);
      await expect(lstat(join(h, '.config'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      rootFixture.normalizeNixRoot = previous;
      rootFixture.unknownRoot = false;
    }
  });
  it('reuses a validated capability identity while still matching the fresh metadata endpoint', async () => {
    const c = client();
    expect(
      (await fetchGrantedCredentials(c.deps, { kind: 'agent', sessionId: SID, employeeId: EID })).credentials
    ).toEqual([row]);
    expect(c.calls.map((x) => x.path)).toEqual(['/api/publication/credentials']);
    await expect(
      fetchGrantedCredentials(c.deps, { kind: 'agent', sessionId: SID, employeeId: 'another' })
    ).rejects.toThrow();
  });
  it('registers list, status and install without a destination, actor or print-material flag', () => {
    const program = new Command();
    registerAgentCommands(program);
    const command = program.commands
      .find((x) => x.name() === 'agent')!
      .commands.find((x) => x.name() === 'credentials')!;
    expect(command.commands.map((x) => x.name())).toEqual(['list', 'status', 'install']);
    for (const child of command.commands) expect(child.options.map((x) => x.long)).toEqual(['--json']);
  });
  it('lists only sanitized metadata and never requests material', async () => {
    const c = client({ list: { employeeId: EID, sessionId: SID, credentials: [{ ...row, material: SECRET }] } });
    expect(await agentCredentialsList(c.deps)).toBe(0);
    expect(JSON.parse(c.out[0]).credentials).toEqual([row]);
    expect(c.calls.map((x) => x.path)).toEqual(['/api/board', '/api/publication/credentials']);
    expect(c.out.join('')).not.toContain(SECRET);
  });
  it.each([
    { kind: 'owner', employeeId: EID, sessionId: SID },
    { kind: 'agent', employeeId: EID, sessionId: 'another' },
  ])('refuses mismatched independent caller identity', async (identity) => {
    const c = client({ identity });
    expect(await agentCredentialsList(c.deps)).toBe(4);
    expect(c.calls).toHaveLength(1);
  });
  it.each([
    { employeeId: 'another', sessionId: SID, credentials: [row] },
    { employeeId: EID, sessionId: 'another', credentials: [row] },
    { employeeId: EID, sessionId: SID, credentials: [row, row] },
    { employeeId: EID, sessionId: SID, credentials: [{ ...row, name: '../escape' }] },
    { employeeId: EID, sessionId: SID, credentials: [{ ...row, repositories: ['bad\nrepo'] }] },
    { employeeId: EID, sessionId: SID, credentials: Array(65).fill(row) },
  ])('refuses malformed or conflicting grant metadata', async (list) => {
    const c = client({ list });
    expect(await agentCredentialsList(c.deps)).toBe(4);
    expect(c.out.join('')).not.toContain(SECRET);
  });
  it('installs exact bytes privately, exposes references, and repeats idempotently', async () => {
    const h = await home(),
      c = client();
    expect(await agentCredentialsInstall(c.deps, row.name, h)).toBe(0);
    const dir = join(h, '.config/reverie/credentials/github'),
      token = join(dir, row.name + '.token');
    expect(await readFile(token, 'utf8')).toBe(SECRET);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    for (const n of [row.name + '.token', row.name + '.json']) {
      const s = await lstat(join(dir, n));
      expect(s.mode & 0o777).toBe(0o600);
      expect(s.nlink).toBe(1);
    }
    expect((await credentialReferences(dir))[0]).toMatchObject({
      name: row.name,
      declaredRepositories: row.repositories,
    });
    const original = await lstat(token);
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(0);
    expect(JSON.parse(c.out.at(-1)!).state).toBe('ALREADY_INSTALLED');
    expect((await lstat(token)).ino).toBe(original.ino);
    expect(c.out.join('') + c.err.join('')).not.toContain(SECRET);
  });
  it('finishes only a matching known partial local pair', async () => {
    const h = await home(),
      c = client();
    await agentCredentialsInstall(c.deps, ID, h);
    const dir = join(h, '.config/reverie/credentials/github');
    await rm(join(dir, row.name + '.token'));
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(0);
    expect(await readFile(join(dir, row.name + '.token'), 'utf8')).toBe(SECRET);
  });
  it('refuses differing existing material and preserves it and other bindings', async () => {
    const h = await home(),
      c = client();
    await agentCredentialsInstall(c.deps, ID, h);
    const dir = join(h, '.config/reverie/credentials/github');
    await writeFile(join(dir, row.name + '.token'), 'old-owner-material');
    await writeFile(join(dir, 'other.token'), 'other-binding', { mode: 0o600 });
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
    expect(await readFile(join(dir, row.name + '.token'), 'utf8')).toBe('old-owner-material');
    expect(await readFile(join(dir, 'other.token'), 'utf8')).toBe('other-binding');
  });
  it('rejects symbolic ancestors before material retrieval', async () => {
    const h = await home(),
      target = await home();
    await symlink(target, join(h, '.config'));
    const c = client();
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
    expect(c.calls.some((x) => x.path.endsWith('/material'))).toBe(false);
  });
  it('rejects a hardlinked metadata/token alias without projecting its bytes', async () => {
    const h = await home(),
      c = client();
    await agentCredentialsInstall(c.deps, ID, h);
    const dir = join(h, '.config/reverie/credentials/github');
    await rm(join(dir, row.name + '.json'));
    await link(join(dir, row.name + '.token'), join(dir, row.name + '.json'));
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
    expect(c.out.join('') + c.err.join('')).not.toContain(SECRET);
  });
  it('rejects permissive credential directory and symbolic final target', async () => {
    const h = await home(),
      c = client();
    await agentCredentialsInstall(c.deps, ID, h);
    const dir = join(h, '.config/reverie/credentials/github');
    await chmod(dir, 0o755);
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
    await chmod(dir, 0o700);
    await rm(join(dir, row.name + '.token'));
    await symlink('other', join(dir, row.name + '.token'));
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
  });
  it.each([
    { status: 403, text: SECRET, bytes: Buffer.from(SECRET) },
    { status: 302, bytes: Buffer.from(SECRET) },
    { bytes: Buffer.from('has whitespace') },
    { bytes: Buffer.from([0, 255]) },
    { bytes: Buffer.alloc(4097, 65) },
    { headers: { 'content-type': 'text/plain' } },
  ])('refuses unknown material responses with static errors', async (material) => {
    const h = await home(),
      c = client({ material });
    expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
    expect(c.out.join('') + c.err.join('')).not.toContain(SECRET);
    await expect(lstat(join(h, '.config/reverie/credentials/github', row.name + '.token'))).rejects.toThrow();
  });
  it('does not reveal request exception text', async () => {
    const c = client({ requestError: SECRET });
    expect(await agentCredentialsList(c.deps)).toBe(4);
    expect(c.out.join('') + c.err.join('')).not.toContain(SECRET);
  });
  it.each(['x-reverie-employee-id', 'x-reverie-session-id', 'x-reverie-credential-id'])(
    'refuses material bound to another identity: %s',
    async (key) => {
      const h = await home(),
        headers = {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-reverie-employee-id': EID,
          'x-reverie-session-id': SID,
          'x-reverie-credential-id': ID,
          [key]: 'another',
        };
      const c = client({ material: { headers } });
      expect(await agentCredentialsInstall(c.deps, ID, h)).toBe(4);
      expect(c.out.join('') + c.err.join('')).not.toContain(SECRET);
    }
  );
  it('refuses an ungranted name without retrieving any material', async () => {
    const h = await home(),
      c = client();
    expect(await agentCredentialsInstall(c.deps, 'other', h)).toBe(4);
    expect(c.calls.some((x) => x.path.endsWith('/material'))).toBe(false);
  });
  it('uses the existing byte-safe HTTP transport and preserves binding headers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': Buffer.byteLength(SECRET),
        'Cache-Control': 'no-store',
        'X-Reverie-Session-Id': SID,
      });
      res.end(SECRET);
    });
    await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error();
      const response = await httpRequest(
        { apiUrl: `http://127.0.0.1:${address.port}`, selfId: SID },
        { method: 'POST', path: '/material', binary: { maxBytes: 4096, deadlineMs: 1000 } }
      );
      expect(response.bytes?.equals(Buffer.from(SECRET))).toBe(true);
      expect(response.text).toBe('');
      expect(response.headers?.['x-reverie-session-id']).toBe(SID);
    } finally {
      await new Promise<void>((yes) => server.close(() => yes()));
    }
  });
});
