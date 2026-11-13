/** Actual private credential files and owned loopback HTTP only. No provider/engine effects. */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as http from 'node:http';
import { readDockerWorkerIdentity } from '../src/docker-worker-identity-client.js';
import { baseHeaders, resolveAgentContext, httpRequest, type AgentContext } from '../src/cli-agent.js';
import { DOCKER_WORKER_IDENTITY_HEADER } from '../src/docker-worker-identity.js';
const sid = '33333333-3333-4333-8333-333333333333';
const token = 'c3ludGhldGlj.' + 'a'.repeat(64);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function file(content = token + '\n') {
  const dir = mkdtempSync(join(tmpdir(), 'worker-credential-'));
  dirs.push(dir);
  fs.chmodSync(dir, 0o700);
  const path = join(dir, 'callback-identity');
  fs.writeFileSync(path, content, { mode: 0o600 });
  return path;
}
function env(path: string): NodeJS.ProcessEnv {
  return {
    REVERIE_MUX: '1',
    REVERIE_SESSION_ID: sid,
    REVERIE_API_URL: 'http://127.0.0.1:3000',
    REVERIE_WORKER_IDENTITY_FILE: path,
    REVERIE_PASSWORD: 'synthetic-human-password',
  };
}
describe('private worker callback client', () => {
  it('reads only a selected private bounded file and emits identity without human Basic', () => {
    const path = file();
    let envReads = 0;
    const ctx = resolveAgentContext(env(path), () => {
      envReads++;
      return { REVERIE_PASSWORD: 'synthetic-fallback' };
    });
    expect(envReads).toBe(0);
    expect(ctx.auth).toBeUndefined();
    expect(ctx.workerIdentity).toBe(token);
    expect(baseHeaders(ctx)).toEqual({
      Accept: 'application/json',
      'X-Reverie-Parent-Session': sid,
      [DOCKER_WORKER_IDENTITY_HEADER]: token,
    });
  });
  it('does not silently fall back to owner credentials when the selected file is absent or malformed', () => {
    const path = file('malformed');
    let envReads = 0;
    expect(() =>
      resolveAgentContext(env(path), () => {
        envReads++;
        return {};
      })
    ).toThrow('credential unavailable');
    fs.unlinkSync(path);
    expect(() =>
      resolveAgentContext(env(path), () => {
        envReads++;
        return {};
      })
    ).toThrow();
    expect(envReads).toBe(0);
  });
  it('refuses symlink, hardlink, broad-mode, oversize and partial-SID fixtures', () => {
    const path = file(),
      dir = join(path, '..');
    const link = join(dir, 'alias');
    fs.symlinkSync(path, link);
    expect(() => readDockerWorkerIdentity(env(link), sid)).toThrow();
    fs.unlinkSync(link);
    fs.linkSync(path, link);
    expect(() => readDockerWorkerIdentity(env(path), sid)).toThrow();
    fs.unlinkSync(link);
    fs.chmodSync(path, 0o644);
    expect(() => readDockerWorkerIdentity(env(path), sid)).toThrow();
    fs.chmodSync(path, 0o600);
    fs.writeFileSync(path, 'a'.repeat(2050));
    expect(() => readDockerWorkerIdentity(env(path), sid)).toThrow();
    fs.writeFileSync(path, token);
    expect(() => readDockerWorkerIdentity(env(path), sid.slice(0, 8))).toThrow();
  });
  it('keeps the unselected legacy human client path and refuses mixed context credentials', () => {
    expect(readDockerWorkerIdentity({}, sid)).toBeUndefined();
    expect(() =>
      baseHeaders({
        apiUrl: 'http://127.0.0.1',
        selfId: sid,
        workerIdentity: token,
        auth: { username: 'admin', password: 'synthetic' },
      })
    ).toThrow('cannot be mixed');
  });
  it('sends only to the exact callback origin and forbids credential/header overrides', async () => {
    let requests = 0,
      observed: http.IncomingHttpHeaders | undefined;
    const server = http.createServer((req, res) => {
      requests++;
      observed = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const ctx: AgentContext = { apiUrl: 'http://127.0.0.1:' + address.port, selfId: sid, workerIdentity: token };
      expect((await httpRequest(ctx, { method: 'GET', path: '/api/sessions' })).status).toBe(200);
      expect(observed?.[DOCKER_WORKER_IDENTITY_HEADER]).toBe(token);
      expect(observed?.authorization).toBeUndefined();
      await expect(
        httpRequest(ctx, { method: 'GET', path: 'http://localhost:' + address.port + '/api/sessions' })
      ).rejects.toThrow('target or header override');
      for (const header of ['Authorization', 'cookie', 'X-Reverie-Parent-Session', DOCKER_WORKER_IDENTITY_HEADER]) {
        await expect(
          httpRequest(ctx, { method: 'GET', path: '/api/sessions', headers: { [header]: 'synthetic' } })
        ).rejects.toThrow('target or header override');
      }
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
