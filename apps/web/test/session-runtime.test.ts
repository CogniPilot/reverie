import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Session } from '../src/session.js';
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
