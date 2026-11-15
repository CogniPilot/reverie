/** Actual private credential files and owned loopback HTTP only. No provider/engine effects. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as http from 'node:http';
import { readDockerWorkerIdentity } from '../src/docker-worker-identity-client.js';
import {
  baseHeaders,
  registerAgentCommands,
  resolveAgentContext,
  httpRequest,
  type AgentContext,
} from '../src/cli-agent.js';
import { DockerWorkerIdentityAuthentication, DOCKER_WORKER_IDENTITY_HEADER } from '../src/docker-worker-identity.js';
const sid = '33333333-3333-4333-8333-333333333333';
const token = 'c3ludGhldGlj.' + 'a'.repeat(64);
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
  it('uses the protected worker credential without a legacy mux flag or human credential fallback', () => {
    const selected = env(file());
    delete selected.REVERIE_MUX;
    expect(
      resolveAgentContext(selected, () => {
        throw Error('human credential fallback');
      })
    ).toEqual({
      apiUrl: selected.REVERIE_API_URL,
      selfId: sid,
      workerIdentity: token,
    });
    expect(() => resolveAgentContext({ ...selected, REVERIE_WORKER_IDENTITY_FILE: undefined })).toThrow(/REVERIE_MUX/);
    expect(() => resolveAgentContext({ ...selected, REVERIE_WORKER_IDENTITY_FILE: file('{"worker":true}') })).toThrow();
    expect(() => resolveAgentContext({ ...selected, REVERIE_SESSION_ID: sid.slice(0, 8) })).toThrow();
  });
  it('parses self plan requests without mux while genuine HMAC, current binding and server refusal still apply', async () => {
    const binding = {
      employeeId: '22222222-2222-4222-8222-222222222222',
      sessionId: sid,
      sessionGeneration: 1,
      owner: 'owner',
      containerId: 'a'.repeat(64),
      credentialId: '44444444-4444-4444-8444-444444444444',
    };
    let current = true,
      allowed = true;
    const auth = new DockerWorkerIdentityAuthentication(
      '11111111-1111-4111-8111-111111111111',
      Buffer.alloc(32, 0x51),
      {
        binding: (id) => (current && id === binding.employeeId ? binding : undefined),
        keyCurrent: () => true,
      }
    );
    const credential = auth.issue(binding, () => true),
      path = file(credential);
    const observed: Array<{ method?: string; url?: string; authenticated: boolean; body: string }> = [];
    const server = http.createServer(async (req, res) => {
      const identity = auth.capture(req),
        chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      observed.push({
        method: req.method,
        url: req.url,
        authenticated: identity !== undefined,
        body: Buffer.concat(chunks).toString(),
      });
      expect(req.headers.authorization).toBeUndefined();
      res.setHeader('Content-Type', 'application/json');
      if (!identity || !allowed) {
        res.writeHead(identity ? 403 : 401);
        res.end(JSON.stringify({ success: false, error: 'Controlled server refusal' }));
      } else if (req.url === '/api/company') {
        res.end(JSON.stringify({ success: true, data: { employees: [{ id: binding.employeeId, sessionId: sid }] } }));
      } else {
        res.end(JSON.stringify({ success: true, data: { phase: 'awaiting-approval' } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const oldExit = process.exitCode;
    try {
      const address = server.address() as { port: number };
      for (const [key, value] of Object.entries({ ...env(path), REVERIE_API_URL: 'http://127.0.0.1:' + address.port }))
        vi.stubEnv(key, value);
      vi.stubEnv('REVERIE_MUX', undefined);
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const operationId = '55555555-5555-4555-8555-555555555555',
        accountId = '66666666-6666-4666-8666-666666666666';
      const parse = () => {
        const program = new Command();
        registerAgentCommands(program);
        return program.parseAsync(['agent', 'plan-move', 'request', accountId, '--id', operationId, '--json'], {
          from: 'user',
        });
      };
      await parse();
      expect(process.exitCode).toBe(0);
      expect(observed.map(({ method, url, authenticated }) => ({ method, url, authenticated }))).toEqual([
        { method: 'GET', url: '/api/company', authenticated: true },
        { method: 'POST', url: '/api/plans/agent-requests', authenticated: true },
      ]);
      expect(JSON.parse(observed[1]!.body)).toEqual({
        id: operationId,
        employeeId: binding.employeeId,
        sessionId: sid,
        toAccount: accountId,
      });
      expect(output).toHaveBeenCalledWith(
        JSON.stringify({ success: true, id: operationId, phase: 'awaiting-approval' })
      );
      // These remain server decisions; locally readable files never mint identity or grants.
      allowed = false;
      await parse();
      expect(process.exitCode).toBe(1);
      allowed = true;
      fs.writeFileSync(path, token);
      await parse();
      expect(process.exitCode).toBe(1);
      fs.writeFileSync(path, credential);
      vi.stubEnv('REVERIE_SESSION_ID', '77777777-7777-4777-8777-777777777777');
      await parse();
      expect(process.exitCode).toBe(1);
      vi.stubEnv('REVERIE_SESSION_ID', sid);
      current = false;
      await parse();
      expect(process.exitCode).toBe(1);
      expect(observed.slice(2).map(({ authenticated }) => authenticated)).toEqual([true, false, false, false]);
      expect(observed.filter(({ method }) => method === 'POST')).toHaveLength(1);
      vi.stubEnv('REVERIE_WORKER_IDENTITY_FILE', undefined);
      await parse();
      expect(process.exitCode).toBe(4);
      expect(observed).toHaveLength(6);
    } finally {
      process.exitCode = oldExit;
      auth.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
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
