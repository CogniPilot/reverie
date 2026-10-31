import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../src/session.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { SseEvent } from '../src/web/sse-events.js';
import { selectedSubscription } from '../src/subscription-profiles.js';
import { restartEligibility } from '../src/session-restart-policy.js';
import { registerSessionRuntimeRoutes, runtimeView } from '../src/web/routes/session-runtime-routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

vi.mock('../src/subscription-profiles.js', async (original) => ({
  ...await original<typeof import('../src/subscription-profiles.js')>(),
  selectedSubscription: vi.fn(async (id: string, mode: string) => {
    if (id === 'invalid') throw new Error('Incompatible profile');
    return { selection: { id, label: id, provider: 'openai' }, env: { CODEX_HOME: '/accounts/' + id,
      ...(mode === 'opencode' ? { OPENCODE_CONFIG_CONTENT: '{"model":"openai/gpt-5.4"}' } : {}) } };
  }),
}));

vi.mock('../src/custom-model-hosts.js', async (original) => ({
  ...await original<typeof import('../src/custom-model-hosts.js')>(),
  readCustomModelHosts: vi.fn(async () => [{ id: 'qwen-box', label: 'Qwen box', baseUrl: 'http://10.0.0.5:8080',
    models: ['qwen3.8-27b'], defaultModelId: 'qwen3.8-27b', modelContextLengths: { 'qwen3.8-27b': 262144 } }]),
}));

const makeSession = () => new Session({ id: 'expert-id', name: 'Expert', mode: 'opencode', workingDir: '/workspace',
  subscriptionProfile: { id: 'first', label: 'First', provider: 'openai' },
  envOverrides: { CODEX_HOME: '/accounts/first' }, openCodeConfig: { continueSession: 'ses_exact', autoAllowTools: true } });

afterEach(() => vi.restoreAllMocks());

describe('owner runtime transaction', () => {
  it('preserves exact conversations by harness/account, identity and safe persistent state', () => {
    const session = makeSession();
    session.configureRuntime({ mode: 'codex', selection: { id: 'second', label: 'Second', provider: 'openai' },
      env: { CODEX_HOME: '/accounts/second', PRIVATE_KEY: 'synthetic-secret' }, sourceKey: 'subscription:second', model: 'gpt-5', effort: 'high', effortField: 'reasoningEffort' });
    expect(session.toState().codexConfig).toMatchObject({ model: 'gpt-5', reasoningEffort: 'high' });
    expect(session.toState().codexConfig?.resumeSessionId).toBeUndefined();
    expect(session.id).toBe('expert-id');
    session.configureRuntime({ mode: 'opencode', selection: { id: 'first', label: 'First', provider: 'openai' },
      env: { CODEX_HOME: '/accounts/first' }, sourceKey: 'subscription:first' });
    expect(session.toState().openCodeConfig?.continueSession).toBe('ses_exact');
    expect(JSON.stringify(session.toState())).not.toContain('synthetic-secret');
    expect(runtimeView(session).source).toEqual({ kind: 'subscription', profileId: 'first' });
  });

  async function harness(detached = false) {
    const session = makeSession();
    const sessions = new Map(detached ? [] : [[session.id, session]]);
    const ctx = { sessions, persistSessionStateNow: vi.fn(), addSession: vi.fn(async (s: Session) => { sessions.set(s.id, s); }),
      setupSessionListeners: vi.fn(), discardPartiallyBuiltSession: vi.fn() };
    const app = Fastify();
    registerSessionRuntimeRoutes(app, ctx as unknown as SessionPort, (req) => req.headers['x-owner-test'] === 'yes', () => session);
    await app.ready();
    return { app, ctx, session };
  }
  const payload = { mode: 'codex', source: { kind: 'subscription', profileId: 'second' }, model: 'gpt-5', effort: 'high' };
  const headers = { 'x-owner-test': 'yes' };

  it.each([false, true])('does not persist an isolated runtime switch from viewer success (recovery=%s)', async (recovery) => {
    const { app, session, ctx } = await harness();
    if (recovery) {
      vi.spyOn(session, 'isBusy').mockReturnValue(true);
      vi.spyOn(session, 'isWorking', 'get').mockReturnValue(true);
      vi.spyOn(session, 'lastActivityAt', 'get').mockReturnValue(Date.now() - 300_000);
    }
    const original = session.toState();
    const env = session.getEnvOverridesForPersist();
    // A new outside viewer does not imply that the broker replaced this
    // existing inside consumer. The old route treated that viewer as success.
    const consumer = { pid: 1234, mode: session.mode };
    let viewerPid = 400;
    const restart = vi.spyOn(session, 'restartCli').mockImplementation(async () => {
      viewerPid++;
      return true;
    });
    const configure = vi.spyOn(session, 'configureRuntime');
    const selected = vi.mocked(selectedSubscription);
    selected.mockClear();
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/owned-fixture/broker.sock');
    try {
      const response = await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers,
        payload: { ...payload, ...(recovery ? { forceRestart: true, confirmSessionId: session.id } : {}) } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('whole-session replacement');
      expect(configure).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(ctx.persistSessionStateNow).not.toHaveBeenCalled();
      expect(ctx.addSession).not.toHaveBeenCalled();
      expect(session.toState()).toEqual(original);
      expect(session.getEnvOverridesForPersist()).toEqual(env);
      expect(consumer).toEqual({ pid: 1234, mode: original.mode });
      expect(viewerPid).toBe(400);
    } finally { vi.unstubAllEnvs(); await app.close(); }
  });

  it('requires the real owner, rejects agents/busy sessions and never starts on GET', async () => {
    const { app, session } = await harness();
    try {
      const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
      expect((await app.inject({ url: '/api/sessions/expert-id/runtime' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers: { ...headers, 'x-reverie-parent-session': 'agent' }, payload })).statusCode).toBe(403);
      const current = await app.inject({ url: '/api/sessions/expert-id/runtime', headers });
      expect(current.json().data.source.profileId).toBe('first');
      expect(restart).not.toHaveBeenCalled();
      vi.spyOn(session, 'isWorking', 'get').mockReturnValue(true);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload })).statusCode).toBe(409);
      expect(restart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('restarts a stale busy label without clearing or replacing the expert identity', async () => {
    const { app, session } = await harness();
    try {
      vi.spyOn(session, 'isBusy').mockReturnValue(true);
      vi.spyOn(session, 'lastActivityAt', 'get').mockReturnValue(Date.now() - 300_000);
      const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
      const result = await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload });
      expect(result.statusCode).toBe(200);
      expect(restart).toHaveBeenCalledOnce();
      expect(session.id).toBe('expert-id');
    } finally { await app.close(); }
  });

  it('requires explicit matching confirmation for stale work detection and rejects agent recovery', async () => {
    const { app, session } = await harness();
    try {
      vi.spyOn(session, 'isBusy').mockReturnValue(true);
      vi.spyOn(session, 'isWorking', 'get').mockReturnValue(true);
      vi.spyOn(session, 'lastActivityAt', 'get').mockReturnValue(Date.now() - 300_000);
      const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
      for (const extra of [{}, { forceRestart: true }, { forceRestart: true, confirmSessionId: 'another' }]) {
        expect((await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload: { ...payload, ...extra } })).statusCode).toBe(409);
      }
      const force = { ...payload, forceRestart: true, confirmSessionId: session.id };
      expect((await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers: { ...headers, 'x-reverie-parent-session': 'agent' }, payload: force })).statusCode).toBe(403);
      expect(restart).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload: force })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it.each(['task', 'submit', 'output', 'dialog'])('refuses owner recovery over current %s evidence', async (kind) => {
    const { app, session } = await harness();
    try {
      vi.spyOn(session, 'isBusy').mockReturnValue(true);
      vi.spyOn(session, 'lastActivityAt', 'get').mockReturnValue(kind === 'output' ? Date.now() : Date.now() - 300_000);
      if (kind === 'dialog') vi.spyOn(session, 'paneDialog', 'get').mockReturnValue('permission');
      if (kind === 'task') vi.spyOn(session, 'runningTaskCount', 'get').mockReturnValue(1);
      if (kind === 'submit') vi.spyOn(session, 'lastSubmitAt', 'get').mockReturnValue(Date.now());
      const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
      for (const extra of [{}, { forceRestart: true, confirmSessionId: session.id }]) {
        const result = await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload: { ...payload, ...extra } });
        expect(result.statusCode).toBe(409);
      }
      expect(restart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('rechecks for newly submitted work after asynchronous account validation', async () => {
    const { app, session } = await harness();
    try {
      const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
      vi.mocked(selectedSubscription).mockImplementationOnce(async () => {
        vi.spyOn(session, 'lastSubmitAt', 'get').mockReturnValue(Date.now());
        return { selection: { id: 'second', label: 'second', provider: 'openai' }, env: {} };
      });
      expect((await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload })).statusCode).toBe(409);
      expect(restart).not.toHaveBeenCalled();
      expect(session.mode).toBe('opencode');
    } finally { await app.close(); }
  });

  it('rolls account, model, harness and thread back when restart fails', async () => {
    const { app, session, ctx } = await harness();
    try {
      const restart = vi.spyOn(session, 'restartCli').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const result = await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload });
      expect(result.statusCode).toBe(400);
      expect(restart).toHaveBeenCalledTimes(2);
      expect(session.mode).toBe('opencode');
      expect(session.subscriptionProfile?.id).toBe('first');
      expect(session.toState().openCodeConfig?.continueSession).toBe('ses_exact');
      expect(session.getEnvOverridesForPersist()?.CODEX_HOME).toBe('/accounts/first');
      expect(ctx.persistSessionStateNow).toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('moves an OpenCode expert on a local model to Claude Code on the same model', async () => {
    const { app, session } = await harness();
    session.setCustomModel({ endpointId: 'qwen-box', modelId: 'qwen3.8-27b', label: 'Qwen box',
      envKeys: ['OPENCODE_CONFIG_CONTENT'] }, { OPENCODE_CONFIG_CONTENT: '{"model":"custom/qwen3.8-27b"}' });
    try {
      const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
      const result = await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers,
        payload: { mode: 'claude', source: { kind: 'local', endpointId: 'qwen-box' }, model: 'qwen3.8-27b' } });
      expect(result.statusCode).toBe(200);
      expect(result.json().data).toMatchObject({ mode: 'claude', source: { kind: 'local', endpointId: 'qwen-box' }, model: 'qwen3.8-27b' });
      expect(restart).toHaveBeenCalledOnce();
      // What the relaunch actually receives; the persisted copy deliberately omits endpoint values.
      type RespawnProbe = { _buildRespawnPaneOptions(): { envOverrides?: Record<string, string> } };
      const env = (session as unknown as RespawnProbe)._buildRespawnPaneOptions().envOverrides ?? {};
      expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://10.0.0.5:8080', ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-27b', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144' });
      expect(env.CLAUDE_CONFIG_DIR).toBe(session.getCustomModelForPersist()?.configDir);
      expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(env.CODEX_HOME).toBeUndefined();
    } finally { await app.close(); }
  });

  it('rebuilds a detached expert with its same id only after a confirmed owner POST', async () => {
    const { app, session, ctx } = await harness(true);
    try {
      const start = vi.spyOn(session, 'startInteractive').mockResolvedValue();
      await app.inject({ url: '/api/sessions/expert-id/runtime', headers });
      expect(start).not.toHaveBeenCalled();
      const result = await app.inject({ method: 'POST', url: '/api/sessions/expert-id/runtime', headers, payload });
      expect(result.statusCode).toBe(200);
      expect(result.json().data).toMatchObject({ mode: 'codex', source: { profileId: 'second' }, model: 'gpt-5', effort: 'high' });
      expect(ctx.addSession).toHaveBeenCalledWith(session);
      expect(session.id).toBe('expert-id');
    } finally { await app.close(); }
  });
});

describe('explicit company restart', () => {
  it('fails closed for missing recipes and vacation without launching or guessing', async () => {
    const app = Fastify();
    const employee = { id: 'person', sessionId: 'lost', onVacation: false };
    const company = { view: () => ({ employees: [employee] }) };
    const ctx = { sessions: new Map() };
    registerSessionRuntimeRoutes(app, ctx as never, () => true, () => undefined, company as never);
    try {
      const missing = await app.inject({ method: 'POST', url: '/api/company/employees/person/restart', payload: {} });
      expect(missing.statusCode).toBe(409);
      expect(missing.json().error).toContain('No saved runtime recipe');
      employee.onVacation = true;
      const vacation = await app.inject({ method: 'POST', url: '/api/company/employees/person/restart', payload: {} });
      expect(vacation.statusCode).toBe(409);
      expect(vacation.json().error).toContain('vacation');
      expect((await app.inject({ method: 'POST', url: '/api/company/employees/retired/restart', payload: {} })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('forwards only the owner-confirmed recovery for the same employee session', async () => {
    const app = Fastify(); const session = makeSession();
    vi.spyOn(session, 'isBusy').mockReturnValue(true);
    vi.spyOn(session, 'isWorking', 'get').mockReturnValue(true);
    vi.spyOn(session, 'lastActivityAt', 'get').mockReturnValue(Date.now() - 300_000);
    const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
    const company = { view: () => ({ employees: [{ id: 'person', sessionId: session.id }] }) };
    const ctx = { sessions: new Map([[session.id, session]]), persistSessionStateNow: vi.fn() };
    registerSessionRuntimeRoutes(app, ctx as never, () => true, undefined, company as never);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/company/employees/person/restart', payload: {} })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/company/employees/person/restart',
        payload: { forceRestart: true, confirmSessionId: session.id } })).statusCode).toBe(200);
      expect(restart).toHaveBeenCalledOnce();
      expect(session.id).toBe('expert-id');
    } finally { await app.close(); }
  });
  it('protects an open dialog on both ordinary and confirmed company restart', async () => {
    const app = Fastify(); const session = makeSession();
    vi.spyOn(session, 'isBusy').mockReturnValue(true);
    vi.spyOn(session, 'lastActivityAt', 'get').mockReturnValue(Date.now() - 300_000);
    vi.spyOn(session, 'paneDialog', 'get').mockReturnValue('permission');
    const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
    const company = { view: () => ({ employees: [{ id: 'person', sessionId: session.id }] }) };
    const ctx = { sessions: new Map([[session.id, session]]), persistSessionStateNow: vi.fn() };
    registerSessionRuntimeRoutes(app, ctx as never, () => true, undefined, company as never);
    try {
      for (const payload of [{}, { forceRestart: true, confirmSessionId: session.id }]) {
        expect((await app.inject({ method: 'POST', url: '/api/company/employees/person/restart', payload })).statusCode).toBe(409);
      }
      expect(restart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('tells the owner to leave and re-enter the office for a live isolated laptop, recovery or not', async () => {
    const app = Fastify(); const session = makeSession();
    vi.spyOn(session, 'isBusy').mockReturnValue(true);
    vi.spyOn(session, 'lastActivityAt', 'get').mockReturnValue(Date.now() - 300_000);
    const restart = vi.spyOn(session, 'restartCli').mockResolvedValue(true);
    const company = { view: () => ({ employees: [{ id: 'person', name: 'Alex', sessionId: session.id }] }) };
    const ctx = { sessions: new Map([[session.id, session]]), persistSessionStateNow: vi.fn() };
    registerSessionRuntimeRoutes(app, ctx as never, () => true, undefined, company as never);
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/owned-fixture/broker.sock');
    try {
      for (const payload of [{}, { forceRestart: true, confirmSessionId: session.id }]) {
        const response = await app.inject({ method: 'POST', url: '/api/company/employees/person/restart', payload });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toBe('Alex’s laptop is running, so Restart cannot replace it in place. To recover them, use Leave office, then Enter office. That stops and starts their laptop and keeps their identity, saved conversation, memory and files.');
      }
      expect(restart).not.toHaveBeenCalled();
      expect(ctx.persistSessionStateNow).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); await app.close(); }
  });
  it('restarts from a persisted recipe under the same expert/session identity', async () => {
    const app = Fastify();
    const session = makeSession();
    const employee = { id: 'person', sessionId: session.id, onVacation: false };
    const company = { view: () => ({ employees: [employee] }) };
    const start = vi.spyOn(session, 'startInteractive').mockResolvedValue();
    const sessions = new Map();
    const ctx = { sessions, addSession: vi.fn(async (s: Session) => sessions.set(s.id, s)), setupSessionListeners: vi.fn(), persistSessionStateNow: vi.fn() };
    registerSessionRuntimeRoutes(app, ctx as never, () => true, () => session, company as never);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/company/employees/person/restart', payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.sessionId).toBe('expert-id');
      expect(response.json().data.employee.id).toBe('person');
      expect(session.toState().openCodeConfig?.continueSession).toBe('ses_exact');
      expect(start).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});

describe('restart work evidence', () => {
  const stale = { isBusy: () => true, isWorking: false, runningTaskCount: 0,
    lastSubmitAt: 1, lastActivityAt: 1, paneDialog: null };
  it('ignores a stale status label, but keeps live tasks, recent activity and submissions protected', () => {
    expect(restartEligibility(stale, 300_000)).toEqual({ blocked: false, recoverable: true });
    for (const evidence of [{ runningTaskCount: 1 }, { lastSubmitAt: 299_999 }, { lastActivityAt: 299_999 },
      { lastActivityAt: Number.NaN }, { lastSubmitAt: 400_000 }]) {
      expect(restartEligibility({ ...stale, ...evidence }, 300_000)).toEqual({ blocked: true, recoverable: false });
    }
    expect(restartEligibility({ ...stale, isWorking: true }, 300_000)).toEqual({ blocked: true, recoverable: true });
    expect(restartEligibility({ ...stale, paneDialog: 'permission' }, 300_000)).toEqual({ blocked: true, recoverable: false });
    expect(restartEligibility({ ...stale, isBusy: () => false, isWorking: true }, 300_000)).toEqual({ blocked: true, recoverable: false });
  });
});

describe('owner restart across the durable laptop boundary', () => {
  const headers = { cookie: 'fixture-owner=yes' };
  async function fixture(detached = true, initiallyRunning: boolean | undefined = false) {
    const directory = await mkdtemp(join(tmpdir(), 'reverie-runtime-intent-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const session = makeSession();
    const sessions = new Map(detached ? [] : [[session.id, session]]);
    const employee = EmployeeSchema.parse({ id: 'person', name: 'Expert', icon: 'E', position: 'Developer',
      expertise: ['systems'], sessionId: session.id, createdAt: 1, desiredRunning: initiallyRunning });
    const other = EmployeeSchema.parse({ ...employee, id: 'other', name: 'Other', sessionId: 'other-session' });
    await store.update((state) => { state.employees = [employee, other]; });
    const service = new CompanyService(store, { getSession: (id) => sessions.get(id),
      stopSession: vi.fn(async () => {}), chatrooms: {} as never, research: {} as never });
    const timeline: string[] = [];
    const state = { id: session.id, name: session.name, status: 'idle', pid: 123 };
    const ctx = { sessions, addSession: vi.fn(async (s: Session) => {
      timeline.push('add'); sessions.set(s.id, s);
    }), setupSessionListeners: vi.fn(async () => { timeline.push('listeners'); }),
    persistSessionStateNow: vi.fn(() => { timeline.push('persist'); }),
    discardPartiallyBuiltSession: vi.fn(async (id: string) => { sessions.delete(id); await session.stop(); }),
    getSessionStateWithRespawn: vi.fn(() => state),
    broadcast: vi.fn(() => { timeline.push('broadcast'); }) };
    const stop = vi.spyOn(session, 'stop').mockResolvedValue();
    const app = Fastify();
    const hooks = { saved: async () => {} };
    const saved = vi.fn(async () => {
      timeline.push('saved');
      await hooks.saved();
      await service.setDesiredRunning(session.id, true);
    });
    registerSessionRuntimeRoutes(app, ctx as never, (req) => req.headers.cookie === headers.cookie,
      () => session, service, saved);
    await app.ready();
    const readEmployee = () => store.snapshot().employees.find((e) => e.id === employee.id)!;
    const request = () => app.inject({ method: 'POST', url: '/api/company/employees/person/restart', headers, payload: {} });
    const close = async () => { await app.close(); await rm(directory, { recursive: true, force: true }); };
    return { app, session, sessions, store, service, employee, other, ctx, stop, timeline, state, hooks, saved,
      readEmployee, request, close, directory };
  }

  it.each([true, false])('commits stopped intent before %s-detached launch and publishes its saved light state', async (detached) => {
    const f = await fixture(detached);
    try {
      const launch = vi.fn(async () => {
        // This is the actual broker's boundary: read durable company state before admission.
        const disk = JSON.parse(await readFile(join(f.directory, 'company.json'), 'utf8'));
        expect(disk.employees.find((e: { id: string }) => e.id === 'person').desiredRunning).toBe(true);
        f.timeline.push('launch');
        return true;
      });
      if (detached) vi.spyOn(f.session, 'startInteractive').mockImplementation(async () => { await launch(); });
      else vi.spyOn(f.session, 'restartCli').mockImplementation(launch);
      const response = await f.request();
      expect(response.statusCode).toBe(200);
      expect(f.readEmployee().desiredRunning).toBe(true);
      expect(f.store.snapshot().employees.find((e) => e.id === 'other')).toEqual(f.other);
      expect(f.ctx.broadcast).toHaveBeenCalledExactlyOnceWith(detached ? SseEvent.SessionCreated : SseEvent.SessionUpdated,
        detached ? f.state : { session: f.state });
      expect(f.timeline).toEqual(detached ? ['launch', 'add', 'listeners', 'persist', 'saved', 'broadcast'] :
        ['launch', 'persist', 'saved', 'broadcast']);
    } finally { await f.close(); }
  });

  it.each([true, false])('restores stopped intent after failed %s-detached launch without restarting the old CLI', async (detached) => {
    const f = await fixture(detached);
    try {
      const launch = vi.fn(async () => { expect(f.readEmployee().desiredRunning).toBe(true); throw new Error('synthetic launch failure'); });
      if (detached) vi.spyOn(f.session, 'startInteractive').mockImplementation(async () => { await launch(); });
      const restart = vi.spyOn(f.session, 'restartCli').mockImplementation(launch);
      expect((await f.request()).statusCode).toBe(400);
      expect(f.readEmployee().desiredRunning).toBe(false);
      expect(f.stop).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledTimes(detached ? 0 : 1);
      expect(f.saved).not.toHaveBeenCalled();
      expect(f.ctx.broadcast).not.toHaveBeenCalled();
      expect(f.store.snapshot().employees.find((e) => e.id === 'other')).toEqual(f.other);
    } finally { await f.close(); }
  });

  it.each(['stop', 'vacation', 'rebind'])('a concurrent %s during startup wins before registration and publication', async (change) => {
    const f = await fixture();
    try {
      vi.spyOn(f.session, 'startInteractive').mockImplementation(async () => {
        if (change === 'stop') await f.service.setDesiredRunning(f.session.id, false);
        else if (change === 'vacation') await f.service.setVacation(f.employee.id, undefined, true);
        else {
          const replacement = makeSession();
          f.sessions.set('replacement', replacement);
          await f.service.rebind(f.employee.id, undefined, 'replacement');
        }
      });
      expect((await f.request()).statusCode).toBe(409);
      if (change === 'rebind') expect(f.readEmployee().sessionId).toBe('replacement');
      else expect(f.readEmployee()).toMatchObject({ desiredRunning: false, onVacation: change === 'vacation' });
      expect(f.ctx.addSession).not.toHaveBeenCalled();
      expect(f.ctx.broadcast).not.toHaveBeenCalled();
      expect(f.saved).not.toHaveBeenCalled();
      expect(f.stop).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it.each(['stop', 'vacation'])('a concurrent %s while saving cannot be undone by onRuntimeSaved', async (change) => {
    const f = await fixture();
    try {
      vi.spyOn(f.session, 'startInteractive').mockResolvedValue();
      f.hooks.saved = async () => {
        if (change === 'stop') await f.service.setDesiredRunning(f.session.id, false);
        else await f.service.setVacation(f.employee.id, undefined, true);
      };
      expect((await f.request()).statusCode).toBe(409);
      expect(f.readEmployee()).toMatchObject({ desiredRunning: false, onVacation: change === 'vacation' });
      expect(f.ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith(f.session.id);
      expect(f.ctx.broadcast).not.toHaveBeenCalled();
      expect(f.stop).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it('stops a registered partial launch and restores stopped intent when saving fails', async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.session, 'startInteractive').mockResolvedValue();
      f.hooks.saved = async () => { throw new Error('synthetic save failure'); };
      expect((await f.request()).statusCode).toBe(400);
      expect(f.ctx.persistSessionStateNow).toHaveBeenCalled();
      expect(f.ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith(f.session.id);
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.readEmployee().desiredRunning).toBe(false);
      expect(f.ctx.broadcast).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('restores an absent legacy intent field after launch failure', async () => {
    const f = await fixture(true, undefined);
    try {
      // The fixture's default is false; remove the field as in an older company record.
      await f.store.update((state) => { delete state.employees.find((e) => e.id === 'person')!.desiredRunning; });
      vi.spyOn(f.session, 'startInteractive').mockRejectedValue(new Error('synthetic launch failure'));
      expect((await f.request()).statusCode).toBe(400);
      expect(f.readEmployee().desiredRunning).toBeUndefined();
      expect(JSON.parse(await readFile(join(f.directory, 'company.json'), 'utf8')).employees[0]).not.toHaveProperty('desiredRunning');
      expect(f.stop).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it('preserves a stop arriving during asynchronous profile validation', async () => {
    const f = await fixture(false, true);
    try {
      const restart = vi.spyOn(f.session, 'restartCli').mockResolvedValue(true);
      vi.mocked(selectedSubscription).mockImplementationOnce(async () => {
        await f.service.setDesiredRunning(f.session.id, false);
        return { selection: { id: 'first', label: 'first', provider: 'openai' }, env: {} };
      });
      expect((await f.request()).statusCode).toBe(409);
      expect(f.readEmployee().desiredRunning).toBe(false);
      expect(restart).not.toHaveBeenCalled();
      expect(f.ctx.broadcast).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('does not roll back a newer stop followed by a new running request', async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.session, 'startInteractive').mockImplementation(async () => {
        await f.service.setDesiredRunning(f.session.id, false);
        await f.service.setVacation(f.employee.id, undefined, false);
        throw new Error('late failure');
      });
      expect((await f.request()).statusCode).toBe(400);
      expect(f.readEmployee().desiredRunning).toBe(true);
      expect(f.ctx.broadcast).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('ignores an old-session stop observation whose guard is false without cancelling restart', async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.session, 'startInteractive').mockImplementation(async () => {
        await f.service.setDesiredRunning(f.session.id, false, () => false);
        expect(f.readEmployee().desiredRunning).toBe(true);
      });
      expect((await f.request()).statusCode).toBe(200);
      expect(f.readEmployee().desiredRunning).toBe(true);
      expect(f.ctx.broadcast).toHaveBeenCalledExactlyOnceWith(SseEvent.SessionCreated, f.state);
      expect(f.stop).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('a genuine stop cancels a pending restart claim even when the flag is already false', async () => {
    const f = await fixture();
    const intent = f.service.prepareRuntimeRestart(f.session.id, undefined)!;
    try {
      await f.service.setDesiredRunning(f.session.id, false);
      await expect(intent.claim()).rejects.toMatchObject({ status: 409 });
      expect(intent.current()).toBe(false);
      expect(f.readEmployee().desiredRunning).toBe(false);
    } finally { intent.finish(); await f.close(); }
  });

  it('rejects agent and service callers without creating intent or events', async () => {
    const f = await fixture();
    try {
      const start = vi.spyOn(f.session, 'startInteractive').mockResolvedValue();
      for (const callerHeaders of [{ ...headers, 'x-reverie-parent-session': 'agent' }, { 'x-reverie-service-token': 'synthetic-service' }]) {
        const response = await f.app.inject({ method: 'POST', url: '/api/company/employees/person/restart', headers: callerHeaders, payload: {} });
        expect(response.statusCode).toBe(403);
      }
      expect(start).not.toHaveBeenCalled();
      expect(f.readEmployee().desiredRunning).toBe(false);
      expect(f.ctx.broadcast).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
