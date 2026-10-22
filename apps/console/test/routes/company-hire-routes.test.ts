import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { registerCompanyHireRoutes } from '../../src/web/routes/company-hire-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';

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
      ],
      endpoints: async () => [endpoint],
      start,
      stop,
      forget,
    });
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
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
      subscriptionProfileId: 'work',
      sessionName: 'Reviewer',
      codexConfig: { model: 'model-main', reasoningEffort: 'high' },
    });
    expect(start.mock.calls[0][1]).not.toHaveProperty('effort');
    expect(start.mock.calls[0][1].caseName).toMatch(/^expert-/);
    const restarted = new CompanyStore(store.file);
    await restarted.init();
    expect(restarted.snapshot().employees[0].id).toBe(employee.id);
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
    expect((await hire({ ...body, permissions: { recoverEmployees: true } } as never)).statusCode).toBe(400);
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
  });
});
