/** Real owner policy, company permissions, private migration scopes and normal session handlers. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { dataPath } from '../src/config/instance.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { addSubscriptionProfile } from '../src/subscription-profiles.js';
import { PlanRequestCapabilities } from '../src/plan-request-capability.js';
import { getCli } from '../src/config/cli-registry/registry.js';
vi.mock('../src/utils/cli-launcher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/cli-launcher.js')>()),
  resolveCliLaunchError: async () => undefined,
}));
vi.mock('../src/plan-move-processes.js', () => ({
  capturePlanProcesses: async () => [{ pid: 12345, start: 'fixture' }],
  survivingPlanProcesses: async () => [],
}));

describe('agent-requested cross-provider migration in enforce mode', () => {
  let server: any,
    app: any,
    directory: string,
    cookie: string,
    source: string,
    manager: string,
    employee: any,
    managerEmployee: any,
    destination: string;
  const headers = { host: 'localhost', origin: 'http://localhost' },
    password = 'fixture-violet-saturn-kettle-82-Z';
  const owner = (method: string, url: string, payload?: any) =>
    app.inject({ method, url, headers: { ...headers, cookie }, payload });
  const agent = (id: string, url: string, payload?: any) =>
    app.inject({ method: 'POST', url, headers: { 'x-reverie-parent-session': id }, payload });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-plan-server-'));
    const auth = new OwnerAuthService({
      store: new OwnerAuthStore(dataPath('owner-auth.json')),
      auditFile: dataPath('owner-auth-audit.jsonl'),
      setupEnabled: true,
    });
    await auth.setup('fixture-owner', password, password, '127.0.0.1');
    vi.spyOn(Session.prototype, 'pid', 'get').mockReturnValue(12345);
    vi.spyOn(Session.prototype, 'muxName', 'get').mockReturnValue('fixture-pane');
    vi.spyOn(Session.prototype, 'terminalBuffer', 'get').mockImplementation(function (this: Session) {
      return getCli(this.mode)!.capabilities.composerReadyMark!;
    });
    vi.spyOn(Session.prototype, 'isWorking', 'get').mockReturnValue(false);
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'writeViaMux').mockImplementation(async (_text, options) => {
      options?.onOutcome?.('submitted');
      return true;
    });
    server = new WebServer(0, false, true, '127.0.0.1');
    await server.start();
    app = server.app;
    server.mux.isPaneDead = () => false;
    vi.spyOn(server.mux, 'capturePaneText').mockReturnValue('? for shortcuts shift+tab');
    vi.spyOn(server, 'cleanupSession').mockImplementation(async (id: any) => {
      server.sessions.delete(id);
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      headers,
      payload: { username: 'fixture-owner', password },
    });
    cookie = 'reverie_owner=' + login.cookies.find((item: any) => item.name === 'reverie_owner').value;
    await mkdir(join(directory, 'first'));
    await mkdir(join(directory, 'second'));
    const first = await addSubscriptionProfile({
      label: 'Fixture Codex',
      provider: 'openai',
      configDir: join(directory, 'first'),
    });
    destination = (
      await addSubscriptionProfile({
        label: 'Fixture Claude',
        provider: 'anthropic',
        configDir: join(directory, 'second'),
      })
    ).id;
    // These profiles use fake CLIs and temporary empty directories. Model the
    // authenticated destination explicitly; no real provider login is involved.
    vi.spyOn(server.planService, 'rows').mockResolvedValue({
      accounts: [{id: first.id, signedIn: true}, {id: destination, signedIn: true}], catalogue: [],
    });
    const create = async (name: string) => {
      const response = await owner('POST', '/api/sessions', {
        workingDir: directory,
        mode: 'codex',
        name,
        subscriptionProfileId: first.id,
      });
      expect(response.statusCode, response.body).toBe(200);
      const id = response.json().data.session.id;
      const hire = await owner('POST', '/api/company/employees', {
        sessionId: id,
        name,
        position: 'CTO',
        icon: 'T',
        expertise: ['testing'],
      });
      expect(hire.statusCode).toBe(200);
      return hire.json().data.employee;
    };
    employee = await create('Fixture Expert');
    source = employee.sessionId;
    managerEmployee = await create('Fixture Manager');
    manager = managerEmployee.sessionId;
  }, 30000);
  afterAll(async () => {
    await server?.stop();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('requires an explicit grant, permits a CTO request over HTTP, and lets only the affected expert approve', async () => {
    const input = { id: 'fixture-agent-move', employeeId: employee.id, sessionId: source, toAccount: destination };
    expect((await agent(manager, '/api/plans/agent-requests', input)).statusCode).toBe(403);
    expect(
      (await owner('PUT', `/api/company/employees/${managerEmployee.id}`, { permissions: { managePlans: true } }))
        .statusCode
    ).toBe(200);
    expect((await agent(manager, '/api/sessions', { workingDir: directory, mode: 'claude' })).statusCode).toBe(403);
    const { stdout } = await promisify(execFile)('curl', [
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      '--header',
      'Content-Type: application/json',
      '--header',
      `x-reverie-parent-session: ${manager}`,
      '--data',
      JSON.stringify(input),
      '--write-out',
      '\n%{http_code}',
      `http://127.0.0.1:${server.boundPort}/api/plans/agent-requests`,
    ]);
    const split = stdout.lastIndexOf('\n');
    expect(Number(stdout.slice(split + 1))).toBe(202);
    expect(JSON.parse(stdout.slice(0, split)).data).toMatchObject({
      phase: 'pending',
      targetMode: 'claude',
      requestedBy: manager,
    });
    expect(server.sessions.size).toBe(2);
    const { nonce } = await new PlanRequestCapabilities().read(source, input.id);
    expect((await agent(manager, `/api/plans/requests/${input.id}/credential`)).statusCode).toBe(403);
    const privateCredential = await agent(source, `/api/plans/requests/${input.id}/credential`);
    expect(privateCredential.statusCode).toBe(200);
    expect(privateCredential.headers['cache-control']).toBe('no-store');
    expect(privateCredential.json().data).toEqual({requestId: input.id, sessionId: source, nonce});
    expect(
      (await agent(manager, `/api/plans/requests/${input.id}/approve`, { nonce, handoff: 'Continue fixture review.' }))
        .statusCode
    ).toBe(403);
    expect(
      (await agent(source, `/api/plans/requests/${input.id}/approve`, { nonce, handoff: 'Continue fixture review.' }))
        .statusCode
    ).toBe(202);
    let record: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      record = (await owner('POST', `/api/plans/requests/${input.id}/status`)).json().data;
      if (['completed', 'failed', 'recovery-required'].includes(record.phase)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(record, JSON.stringify(record)).toMatchObject({ phase: 'completed', newSession: expect.any(String) });
    expect(server.sessions.has(source)).toBe(false);
    const replacement = server.sessions.get(record.newSession);
    expect(replacement.mode).toBe('claude');
    expect(replacement.toState().subscriptionProfile.id).toBe(destination);
    expect(replacement.parentSessionId).toBe(source);
    expect(server.companyService.view().employees.find((item: any) => item.id === employee.id).sessionId).toBe(
      replacement.id
    );
    expect((await agent(manager, '/api/sessions', { workingDir: directory, mode: 'claude' })).statusCode).toBe(403);
    expect((await agent(manager, `/api/plans/agent-requests/${input.id}/status`)).json().data.phase).toBe('completed');
    // A queued self-move also loses its authority immediately when the owner revokes the grant.
    const second = { ...input, id: 'revoked-request', employeeId: managerEmployee.id, sessionId: manager };
    expect((await agent(manager, '/api/plans/agent-requests', second)).statusCode).toBe(202);
    const credential = await new PlanRequestCapabilities().read(manager, second.id);
    await owner('PUT', `/api/company/employees/${managerEmployee.id}`, { permissions: { managePlans: false } });
    expect(
      (
        await agent(manager, `/api/plans/requests/${second.id}/approve`, {
          nonce: credential.nonce,
          handoff: 'Not authorized.',
        })
      ).statusCode
    ).toBe(403);
    expect(server.sessions.size).toBe(2);
    await owner('POST', `/api/plans/requests/${second.id}/cancel`);
  });
});
