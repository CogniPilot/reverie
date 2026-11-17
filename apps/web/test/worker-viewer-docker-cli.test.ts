/** Real protected-file/CLI/HMAC/HTTP authority composition. The public Session
 * repair method is an adapter double; these cases claim no native attachment. */
import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Command } from 'commander';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Session } from '../src/session.js';
import type { MuxSession } from '../src/mux-interface.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { registerAgentCommands, EXIT } from '../src/cli-agent.js';
import {
  DockerWorkerIdentityAuthentication,
  dockerWorkerIdentityOf,
  registerDockerWorkerIdentity,
} from '../src/docker-worker-identity.js';
import { WorkerViewerReconnect, registerWorkerViewerReconnect } from '../src/worker-viewer-reconnect.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(team = false) {
  vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/fixture/worker.sock');
  const directory = await mkdtemp(join(tmpdir(), 'viewer-hmac-'));
  await chmod(directory, 0o700);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sessions = new Map<string, Session>();
  const addSession = () => {
    const id = randomUUID();
    const row = { sessionId: id, muxName: 'owned-' + id, pid: 41 } as MuxSession;
    const mux = {
      getSession: (selected: string) => (selected === id ? row : undefined),
      readPaneLiveness: vi.fn(async () => ({ state: 'dead' as const })),
      muxSessionExists: () => true,
      isPaneDead: () => true,
    };
    const session = new Session({
      id,
      workingDir: directory,
      mode: 'codex',
      useMux: true,
      mux: mux as never,
      muxSession: row,
    });
    sessions.set(id, session);
    return session;
  };
  const actorSession = addSession();
  const targetSession = team ? addSession() : actorSession;
  targetSession.setPaneExit({ status: 1, at: 123 }); // Lost outer viewer, not a provider exit receipt.
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  const company = new CompanyService(store, {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as never);
  const hire = async (session: Session) => {
    const employee = await company.hire({
      name: session.id,
      icon: 'E',
      position: 'Engineer',
      expertise: ['systems'],
      sessionId: session.id,
      researchEnabled: false,
    });
    await company.setDesiredRunning(session.id, true);
    return employee;
  };
  const actor = await hire(actorSession);
  const target = team ? await hire(targetSession) : actor;
  await company.update(actor.id, undefined, { permissions: { recoverEmployees: true } }, () => {});
  const credentialId = randomUUID(),
    containerId = 'a'.repeat(64);
  let keyCurrent = true;
  const binding = () => {
    const row = store.snapshot().employees.find((employee) => employee.id === actor.id);
    return row && sessions.has(row.sessionId) && row.desiredRunning === true && !row.onVacation && !row.bindingMigration
      ? {
          employeeId: row.id,
          sessionId: row.sessionId,
          sessionGeneration: row.sessionGeneration,
          owner: row.owner,
          credentialId,
          containerId,
        }
      : undefined;
  };
  const auth = new DockerWorkerIdentityAuthentication(randomUUID(), Buffer.alloc(32, 42), {
    binding,
    keyCurrent: () => keyCurrent,
  });
  cleanups.push(async () => auth.close());
  const token = auth.issue(binding()!, () => true),
    credential = join(directory, 'identity');
  await writeFile(credential, token + '\n', { mode: 0o600 });
  const moveGuard = vi.fn(async () => () => true),
    publish = vi.fn(),
    pause = vi.fn(() => vi.fn());
  const controller = new WorkerViewerReconnect({
    company,
    session: (id) => sessions.get(id),
    ready: () => true,
    providerHealthy: () => true,
    moveGuard,
    publish,
    pause,
  });
  const repair = vi.spyOn(targetSession, 'reconnectWorkerViewer').mockImplementation(async (allowed) => {
    if (!allowed()) return false;
    targetSession.setPaneExit(undefined);
    return allowed();
  });
  const provider = [
    vi.spyOn(targetSession, 'startInteractive'),
    vi.spyOn(targetSession, 'restartCli'),
    vi.spyOn(targetSession, 'restartDeadCli'),
  ];
  const app = Fastify();
  cleanups.push(() => app.close());
  await app.register(cookie);
  registerDockerWorkerIdentity(app, auth, '', { requireMachineProof: true });
  const requests: Array<{ method: string; url: string; status: number }> = [];
  let dropRepairReply = false;
  app.addHook('onSend', async (request, reply, payload) => {
    if (dropRepairReply && request.url.endsWith('/reconnect') && reply.statusCode === 200) reply.raw.destroy();
    return payload;
  });
  app.addHook('onResponse', (request, reply, done) => {
    requests.push({ method: request.method, url: request.url, status: reply.statusCode });
    done();
  });
  app.get('/api/company', (request) => {
    expect(dockerWorkerIdentityOf(request)?.employeeId).toBe(actor.id);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-reverie-parent-session']).toBe(actor.sessionId);
    return { success: true, data: company.view(undefined) };
  });
  registerWorkerViewerReconnect(app, controller, () => false);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiUrl = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  const run = async (verb = 'viewer-status') => {
    vi.stubEnv('REVERIE_MUX', undefined);
    vi.stubEnv('REVERIE_SESSION_ID', actor.sessionId);
    vi.stubEnv('REVERIE_API_URL', apiUrl);
    vi.stubEnv('REVERIE_WORKER_IDENTITY_FILE', credential);
    vi.stubEnv('REVERIE_PASSWORD', 'HOSTILE_HUMAN_FALLBACK');
    const out: string[] = [],
      err: string[] = [];
    const stdout = vi.spyOn(console, 'log').mockImplementation((value) => {
      out.push(String(value));
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation((value) => {
      err.push(String(value));
    });
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerAgentCommands(program);
      await program.parseAsync(['agent', verb, target.id, '--json'], { from: 'user' });
      return { code: process.exitCode ?? 0, out, err };
    } finally {
      process.exitCode = previous;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  };
  const noProvider = () => {
    for (const operation of provider) expect(operation).not.toHaveBeenCalled();
  };
  return {
    actor,
    target,
    actorSession,
    targetSession,
    store,
    company,
    sessions,
    auth,
    token,
    credential,
    apiUrl,
    app,
    controller,
    moveGuard,
    repair,
    publish,
    pause,
    requests,
    run,
    noProvider,
    revokeKey: () => {
      keyCurrent = false;
    },
    dropReply: () => {
      dropRepairReply = true;
    },
  };
}

it('a genuine protected Docker identity without legacy MUX can inspect its disconnected viewer through the actual CLI and HTTP route', async () => {
  const f = await fixture();
  expect(f.targetSession.runtimeHealth).toBe('disconnected');
  const result = await f.run();
  expect(f.requests.map((request) => [request.method, request.url, request.status])).toEqual([
    ['GET', '/api/company', 200],
    ['POST', `/api/company/employees/${f.target.id}/reconnect/status`, 200],
  ]);
  expect(result.code, result.err.join('\n')).toBe(EXIT.ok);
  expect(JSON.parse(result.out[0]!).reconnect.state).toBe('blocked');
  expect(f.repair).not.toHaveBeenCalled();
  f.noProvider();
});

it.each([false, true])('the real CLI can repair only the existing %s viewer with a live scoped grant', async (team) => {
  const f = await fixture(team);
  const before = f.store.snapshot();
  expect(f.targetSession.runtimeHealth).toBe('disconnected');
  const result = await f.run('reconnect-viewer');
  expect(result.code, result.err.join('\n')).toBe(EXIT.ok);
  expect(JSON.parse(result.out[0]!)).toMatchObject({ state: 'viewer-connected', reconnect: { state: 'connected' } });
  expect(f.repair).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.targetSession);
  expect(f.store.snapshot()).toEqual(before);
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  f.noProvider();
});

it.each(['grant', 'generation', 'rebound', 'retired', 'off', 'key'] as const)(
  'refuses the actual CLI when the caller becomes %s before transport without an authority fallback',
  async (change) => {
    const f = await fixture(true);
    if (change === 'key') f.revokeKey();
    else
      await f.store.update((state) => {
        const actor = state.employees.find((employee) => employee.id === f.actor.id)!;
        if (change === 'grant') {
          actor.permissions.recoverEmployees = false;
          actor.position = 'CTO';
        }
        if (change === 'generation') actor.sessionGeneration++;
        if (change === 'rebound') actor.sessionId = randomUUID();
        if (change === 'off') actor.desiredRunning = false;
        if (change === 'retired') state.employees = state.employees.filter((employee) => employee.id !== actor.id);
      });
    expect((await f.run('reconnect-viewer')).code).toBe(EXIT.refused);
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    f.noProvider();
  }
);

it('a valid Docker caller cannot repair another owner’s target', async () => {
  const f = await fixture(true);
  await f.store.update((state) => {
    state.employees.find((employee) => employee.id === f.target.id)!.owner = 'foreign';
  });
  const result = await f.run('reconnect-viewer');
  expect(result.code).toBe(EXIT.refused);
  expect(f.requests).toEqual([{ method: 'GET', url: '/api/company', status: 200 }]);
  const response = await fetch(`${f.apiUrl}/api/company/employees/${f.target.id}/reconnect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-reverie-worker-identity': f.token,
      'x-reverie-parent-session': f.actor.sessionId,
    },
    body: JSON.stringify({ sessionId: f.target.sessionId, sessionGeneration: f.target.sessionGeneration }),
  });
  expect(response.status).toBe(403);
  expect(f.repair).not.toHaveBeenCalled();
  f.noProvider();
});

it('a selected but unverified worker proof cannot fall through to human or native recovery authority', async () => {
  const f = await fixture();
  const app = Fastify();
  cleanups.push(() => app.close());
  const native = { authenticate: vi.fn() };
  registerWorkerViewerReconnect(app, f.controller, () => true, native as never);
  const response = await app.inject({
    method: 'POST',
    url: `/api/company/employees/${f.target.id}/reconnect`,
    headers: { 'x-reverie-worker-identity': f.token },
    payload: { sessionId: f.target.sessionId, sessionGeneration: f.target.sessionGeneration },
  });
  expect(response.statusCode).toBe(403);
  expect(native.authenticate).not.toHaveBeenCalled();
  expect(f.repair).not.toHaveBeenCalled();
  f.noProvider();
});

it('a lost successful repair reply remains unknown and the actual CLI never sends a second repair', async () => {
  const f = await fixture();
  f.dropReply();
  const result = await f.run('reconnect-viewer');
  expect(result.code).toBe(EXIT.error);
  expect(result.err.join('\n')).toContain('unconfirmed');
  expect(result.err.join('\n')).toContain('not retried');
  expect(f.repair).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledOnce();
  f.noProvider();
});

it.each(['admission', 'repair', 'status'] as const)(
  'revocation during actual HTTP %s await prevents acceptance and never redispatches',
  async (phase) => {
    const f = await fixture(true);
    const revoke = async () =>
      f.company.update(f.actor.id, undefined, { permissions: { recoverEmployees: false } }, () => {});
    if (phase === 'repair')
      f.repair.mockImplementationOnce(async (allowed) => {
        expect(allowed()).toBe(true);
        await revoke();
        expect(allowed()).toBe(false);
        return false;
      });
    else
      f.moveGuard.mockImplementationOnce(async () => {
        await revoke();
        return () => true;
      });
    const result = await f.run(phase === 'status' ? 'viewer-status' : 'reconnect-viewer');
    expect(result.code).toBe(EXIT.refused);
    expect(f.requests.at(-1)?.status).toBe(403);
    expect(f.repair).toHaveBeenCalledTimes(phase === 'repair' ? 1 : 0);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    f.noProvider();
  }
);

it.each(['generation', 'rebound', 'retired', 'off', 'key', 'target-generation', 'live-session'] as const)(
  'holds the original HTTP repair when %s changes during admission',
  async (change) => {
    const f = await fixture(true);
    f.moveGuard.mockImplementationOnce(async () => {
      if (change === 'key') f.revokeKey();
      else if (change === 'live-session') f.sessions.delete(f.actor.sessionId);
      else
        await f.store.update((state) => {
          const actor = state.employees.find((employee) => employee.id === f.actor.id)!;
          if (change === 'generation') actor.sessionGeneration++;
          if (change === 'rebound') actor.sessionId = randomUUID();
          if (change === 'retired') state.employees = state.employees.filter((employee) => employee.id !== actor.id);
          if (change === 'off') actor.desiredRunning = false;
          if (change === 'target-generation')
            state.employees.find((employee) => employee.id === f.target.id)!.sessionGeneration++;
        });
      return () => true;
    });
    expect((await f.run('reconnect-viewer')).code).toBe(EXIT.refused);
    expect(f.requests.at(-1)?.status).toBe(403);
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    f.noProvider();
  }
);

it.each([
  { 'x-reverie-parent-session': randomUUID() },
  { 'x-reverie-parent-session': 'extra,parent' },
  { 'x-reverie-recovery-assertion': 'hostile-native-proof' },
  { 'x-reverie-service-token': 'hostile-service-token' },
  { authorization: 'Basic aHVtYW46cGFzc3dvcmQ=' },
  { cookie: 'reverie_owner=hostile-owner-cookie' },
  { cookie: 'reverie_session=hostile-human-session' },
])('rejects mixed or mismatched selectors before repair: %j', async (extra) => {
  const f = await fixture();
  const headers = new Headers({
    'content-type': 'application/json',
    'x-reverie-worker-identity': f.token,
    'x-reverie-parent-session': f.actor.sessionId,
  });
  for (const [name, value] of Object.entries(extra)) if (typeof value === 'string') headers.set(name, value);
  const response = await fetch(`${f.apiUrl}/api/company/employees/${f.target.id}/reconnect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId: f.target.sessionId, sessionGeneration: f.target.sessionGeneration }),
  });
  expect(response.status).toBe(403);
  expect(f.repair).not.toHaveBeenCalled();
  f.noProvider();
});

it('refuses an altered credential signature without using the selected human password', async () => {
  const f = await fixture();
  const signature = f.token.at(-1) === '0' ? '1' : '0';
  await writeFile(f.credential, f.token.slice(0, -1) + signature + '\n', { mode: 0o600 });
  expect((await f.run('reconnect-viewer')).code).toBe(EXIT.refused);
  expect(f.requests).toEqual([{ method: 'GET', url: '/api/company', status: 403 }]);
  expect(f.repair).not.toHaveBeenCalled();
  f.noProvider();
});

it('retains strict current target body selection and never accepts provider or binding overrides', async () => {
  const f = await fixture();
  for (const change of [{ command: 'restart-provider' }, { sessionGeneration: 0 }, { sessionId: randomUUID() }]) {
    const response = await fetch(`${f.apiUrl}/api/company/employees/${f.target.id}/reconnect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-reverie-worker-identity': f.token,
        'x-reverie-parent-session': f.actor.sessionId,
      },
      body: JSON.stringify({ sessionId: f.target.sessionId, sessionGeneration: f.target.sessionGeneration, ...change }),
    });
    expect([400, 409]).toContain(response.status);
  }
  expect(f.repair).not.toHaveBeenCalled();
  f.noProvider();
});
