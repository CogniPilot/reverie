import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { registerCompanyHireRoutes } from '../../src/web/routes/company-hire-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import * as registry from '../../src/config/cli-registry/registry.js';

describe('fresh permanent expert hire', () => {
  let directory: string;
  let app: FastifyInstance;
  let company: CompanyService;
  let store: CompanyStore;
  const sessions = new Map();
  const start = vi.fn(async () => {
    sessions.set('new-runtime', { id: 'new-runtime', name: 'Expert' });
    return 'new-runtime';
  });
  const stop = vi.fn(async (id: string) => {
    sessions.delete(id);
  });
  const forget = vi.fn(async () => {});
  const endpoint = {
    id: 'local',
    label: 'Local server',
    baseUrl: 'http://127.0.0.1:8080',
    apiKey: 'PRIVATE_SENTINEL',
    models: ['model-local'],
    defaultModelId: 'model-local',
  };
  const body = {
    name: 'Reviewer',
    icon: 'R',
    position: 'Engineer',
    expertise: ['systems'],
    reportsTo: 'owner',
    source: { kind: 'subscription', profileId: 'work' },
    mode: 'codex',
    model: 'model-main',
    effort: 'high',
  };
  beforeEach(async () => {
    sessions.clear();
    start.mockClear();
    stop.mockClear();
    forget.mockClear();
    directory = await mkdtemp(join(tmpdir(), 'reverie-hire-'));
    store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    company = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn() },
      research: { start: vi.fn(), stop: vi.fn(), inspect: vi.fn() },
    });
    app = Fastify();
    registerCompanyHireRoutes(app, {
      company,
      verifiedOwner: (req) => req.headers['x-unverified'] === undefined,
      profiles: async () => [
        { id: 'work', label: 'Work plan', provider: 'openai', configDir: directory, openCodeDataDir: directory },
        { id: 'claude-plan', label: 'Claude plan', provider: 'anthropic', configDir: directory, openCodeDataDir: directory },
      ],
      endpoints: async () => [endpoint],
      captureRuntime: () => ({ mode: String(start.mock.calls.at(-1)?.[1].mode), workingDir: '/workspace/expert', configs: {} }),
      start,
      stop,
      forget,
    });
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const hire = (payload = body, headers = {}) =>
    app.inject({ method: 'POST', url: '/api/company/hire', payload, headers });

  it('creates a fresh runtime with its plan, model and actual harness effort; identity gets no implicit grants', async () => {
    const response = await hire();
    expect(response.statusCode).toBe(200);
    const employee = response.json().data.employee;
    expect(employee.id).not.toBe('new-runtime');
    expect(employee.sessionId).toBe('new-runtime');
    expect(employee.permissions.recoverEmployees).toBe(false);
    expect(employee.desiredRunning).toBe(true);
    expect(start.mock.calls[0][1]).toMatchObject({
      mode: 'codex',
      pinned: true,
      subscriptionProfileId: 'work',
      sessionName: 'Reviewer',
      codexConfig: { model: 'model-main', reasoningEffort: 'high' },
    });
    expect(start.mock.calls[0][1]).not.toHaveProperty('effort');
    expect(start.mock.calls[0][1].caseName).toMatch(/^expert-/);
    const restarted = new CompanyStore(store.file);
    await restarted.init();
    expect(restarted.snapshot().employees[0].id).toBe(employee.id);
    expect(restarted.snapshot().employees[0].runtimeRecipe).toMatchObject({ mode: 'codex', workingDir: '/workspace/expert' });
  });
  it('persists explicit sleep and dream opt-ins at hire without enabling research', async () => {
    const response = await hire({ ...body, sleepEnabled: true, dreamEnabled: true } as never);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.employee).toMatchObject({ sleepEnabled: true, dreamEnabled: true, researchEnabled: false });
  });

  it('uses the same configured local model with OpenCode without copying credentials or account selection', async () => {
    const response = await hire({
      ...body,
      source: { kind: 'local', endpointId: 'local' },
      mode: 'opencode',
      model: 'model-local',
      effort: undefined,
    } as never);
    expect(response.statusCode).toBe(200);
    expect(start.mock.calls[0][1]).toMatchObject({
      mode: 'opencode',
      customModel: { endpointId: 'local', modelId: 'model-local' },
    });
    expect(JSON.stringify(start.mock.calls[0][1])).not.toContain(endpoint.apiKey);
    expect(start.mock.calls[0][1]).not.toHaveProperty('subscriptionProfileId');
  });
  it('keeps owner-selected pronouns and voice through store reopen and runtime replacement', async () => {
    const voice = { provider: 'browser', id: 'voice://chosen' };
    const response = await hire({ ...body, pronouns: 'they/them', voice } as never);
    expect(response.statusCode).toBe(200);
    const employee = response.json().data.employee;
    sessions.set('different-model-runtime', { id: 'different-model-runtime', name: 'Reviewer' });
    await company.rebind(employee.id, undefined, 'different-model-runtime');
    const reopened = new CompanyStore(store.file);
    await reopened.init();
    expect(reopened.snapshot().employees[0]).toMatchObject({
      id: employee.id,
      pronouns: 'they/them',
      voice,
      sessionId: 'different-model-runtime',
    });
    await company.update(employee.id, undefined, { voice: { provider: 'piper', id: 'en_US-amy-medium' } });
    expect(store.snapshot().employees[0].voice?.provider).toBe('piper');
    await company.update(employee.id, undefined, { voice: null });
    expect(store.snapshot().employees[0]).not.toHaveProperty('voice');
  });

  it('rejects invalid voice configurations before starting a runtime', async () => {
    expect((await hire({ ...body, voice: { provider: 'remote', id: 'test' } } as never)).statusCode).toBe(400);
    expect((await hire({ ...body, voice: { provider: 'browser', id: 'x'.repeat(301) } } as never)).statusCode).toBe(
      400
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('rejects unsupported plans, efforts and unsaved local models before creating a runtime', async () => {
    expect((await hire({ ...body, mode: 'claude' })).statusCode).toBe(400);
    expect((await hire({ ...body, effort: 'invented' })).statusCode).toBe(400);
    expect(
      (await hire({ ...body, source: { kind: 'local', endpointId: 'local' }, model: 'unknown' } as never)).statusCode
    ).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  it('agents and unverified callers cannot hire or grant themselves permissions', async () => {
    expect((await hire(body, { 'x-reverie-parent-session': 'agent' })).statusCode).toBe(403);
    expect((await hire(body, { 'x-unverified': '1' })).statusCode).toBe(403);
    expect((await hire({ ...body, permissions: { hireEmployees: true } } as never)).statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  it('rolls back the new runtime when durable identity registration fails', async () => {
    const response = await hire({ ...body, reportsTo: 'missing-manager' });
    expect(response.statusCode).toBe(400);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('new-runtime');
    expect(forget).toHaveBeenCalledWith(undefined, 'new-runtime');
    expect(company.view().employees).toEqual([]);
    expect(sessions.size).toBe(0);
  });
  it('options separate profile/provider from compatible harnesses and never expose endpoint keys', async () => {
    const response = await app.inject('/api/company/hire-options');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(endpoint.apiKey);
    expect(response.body).not.toContain(endpoint.baseUrl);
    const sources = response.json().data.sources;
    expect(sources.find((s) => s.kind === 'local').modes).toContain('opencode');
    expect(sources.find((s) => s.kind === 'subscription').modes).toContain('codex');
    expect(sources.find((s) => s.kind === 'subscription').modes).not.toContain('claude');
    expect(sources.find((s) => s.id === 'work')).toMatchObject({ defaultMode: 'codex', modes: ['codex', 'opencode'] });
    expect(sources.find((s) => s.id === 'claude-plan')).toMatchObject({ defaultMode: 'claude', modes: ['claude'] });
    expect(sources.find((s) => s.kind === 'local').defaultMode).toBe('opencode');
    expect(response.json().data.roles.map((r: { id: string }) => r.id)).toEqual(['cto', 'coo', 'software', 'systems', 'assistant', 'custom']);
  });
  it('persists owner-edited role details and only the explicitly selected recovery permission', async () => {
    const result = await hire({ ...body, responsibilities: ['Review architecture with evidence'], personality: 'Calm and precise', permissions: { recoverEmployees: true } } as never);
    expect(result.statusCode).toBe(200);
    const employee = result.json().data.employee;
    expect(employee).toMatchObject({ responsibilities: ['Review architecture with evidence'], personality: 'Calm and precise', permissions: { recoverEmployees: true } });
    await company.update(employee.id, undefined, { icon: 'X' });
    const reopened = new CompanyStore(store.file); await reopened.init();
    expect(reopened.snapshot().employees[0]).toMatchObject({ responsibilities: ['Review architecture with evidence'], personality: 'Calm and precise' });
    await company.update(employee.id, undefined, { responsibilities: [], personality: '' });
    expect(company.view().employees[0]).toMatchObject({ responsibilities: [], personality: '' });
  });
  it('rejects a case-insensitive duplicate name before starting another runtime', async () => {
    expect((await hire()).statusCode).toBe(200); start.mockClear();
    const result = await hire({ ...body, name: ' reviewer ' });
    expect(result.statusCode).toBe(409); expect(result.body).toContain('distinct name');
    expect(start).not.toHaveBeenCalled();
  });
  it('rejects oversized role/personality details', async () => {
    expect((await hire({ ...body, personality: 'x'.repeat(1001) } as never)).statusCode).toBe(400);
    expect((await hire({ ...body, responsibilities: ['x'.repeat(501)] } as never)).statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  it('local sources prefer an enabled saved custom harness when OpenCode is unavailable', async () => {
    const custom = { ...registry.getCli('opencode')!, id: registry.asCliId('custom-local'), stock: false };
    vi.spyOn(registry, 'listClis').mockReturnValue([registry.getCli('codex')!, { ...registry.getCli('opencode')!, enabled: false }, custom]);
    const response = await app.inject('/api/company/hire-options');
    const local = response.json().data.sources.find((s) => s.kind === 'local');
    expect(local.defaultMode).toBe('custom-local');
    expect(local.modes).not.toContain('opencode');
    expect(start).not.toHaveBeenCalled();
  });
});
