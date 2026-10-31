import http from 'node:http';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentWakeEmployee,
  EXIT,
  registerAgentCommands,
  resolveAgentContext,
  type AgentContext,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';

vi.mock('../src/reverie-credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/reverie-credentials.js')>()),
  readReverieEnvFile: () => ({}),
}));

const SELF = '33333333-3333-4333-8333-333333333333';
const EMPLOYEE = 'b70db8c4-2f39-43d0-95e6-6c1851bea5b9';
const SESSION = '99999999-9999-4999-8999-999999999999';
const company = { employees: [{ id: EMPLOYEE, sessionId: SESSION, name: 'Alex' }] };
const report = { awakened: [EMPLOYEE], skipped: [] };
const ok = (data: unknown): ApiResponse => ({ status: 200, text: '', json: { success: true, data } });

function fixture(answers: Array<ApiResponse | Error>, json = false) {
  const calls: Array<{ ctx: AgentContext; request: RequestOptions }> = [];
  const out: string[] = [],
    err: string[] = [];
  const ctx = resolveAgentContext(
    { REVERIE_MUX: '1', REVERIE_API_URL: 'http://synthetic.test', REVERIE_SESSION_ID: SELF },
    () => ({})
  );
  const deps: AgentDeps = {
    ctx,
    json,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    request: async (caller, request) => {
      calls.push({ ctx: caller, request });
      const response = answers.shift();
      if (!response) throw new Error('Unexpected extra request');
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { deps, calls, out, err };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('agent wake-employee', () => {
  it('resolves only the canonical employee and posts the empty body using the same own context', async () => {
    const f = fixture([ok(company), ok({ recovery: report })], true);
    expect(await agentWakeEmployee(f.deps, { employeeId: EMPLOYEE })).toBe(EXIT.ok);
    expect(f.calls).toEqual([
      { ctx: f.deps.ctx, request: { method: 'GET', path: '/api/company' } },
      { ctx: f.deps.ctx, request: { method: 'POST', path: `/api/company/employees/${EMPLOYEE}/wake`, body: {} } },
    ]);
    expect(f.calls.every((call) => call.ctx === f.deps.ctx)).toBe(true);
    expect(JSON.parse(f.out[0])).toEqual({ recovery: report });
  });

  it.each(['12345', 'Alex', EMPLOYEE.slice(0, 8), EMPLOYEE.toUpperCase(), `${EMPLOYEE}/wake`])(
    'refuses a noncanonical employee ID before requests: %s',
    async (employeeId) => {
      const f = fixture([]);
      expect(await agentWakeEmployee(f.deps, { employeeId })).toBe(EXIT.refused);
      expect(f.calls).toEqual([]);
    }
  );

  it('never interprets a full session UUID as the employee UUID', async () => {
    const f = fixture([ok(company)]);
    expect(await agentWakeEmployee(f.deps, { employeeId: SESSION })).toBe(EXIT.refused);
    expect(f.calls.map((call) => call.request.method)).toEqual(['GET']);
  });

  it('refuses unknown or duplicate employee bindings without a POST', async () => {
    for (const employees of [[], [company.employees[0], company.employees[0]]]) {
      const f = fixture([ok({ employees })]);
      expect(await agentWakeEmployee(f.deps, { employeeId: EMPLOYEE })).toBe(EXIT.refused);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('reports a real 403 refusal and never claims that recovery happened', async () => {
    const f = fixture([
      ok(company),
      { status: 403, text: '', json: { success: false, error: 'Recovery permission denied' } },
    ]);
    expect(await agentWakeEmployee(f.deps, { employeeId: EMPLOYEE })).toBe(EXIT.refused);
    expect(f.err.join('')).toContain('Recovery permission denied');
    expect(f.out).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it.each(['recovery-in-progress', 'intentionally-ended', 'not-desired', 'wake-failed'])(
    'prints the actual skipped reason and exits nonzero without retrying: %s',
    async (reason) => {
      const recovery = { awakened: [], skipped: [{ employeeId: EMPLOYEE, reason }] };
      const f = fixture([ok(company), ok({ recovery })], true);
      expect(await agentWakeEmployee(f.deps, { employeeId: EMPLOYEE })).toBe(EXIT.refused);
      expect(JSON.parse(f.out[0])).toEqual({ recovery });
      expect(f.calls.filter((call) => call.request.method === 'POST')).toHaveLength(1);
      const human = fixture([ok(company), ok({ recovery })]);
      expect(await agentWakeEmployee(human.deps, { employeeId: EMPLOYEE })).toBe(EXIT.refused);
      expect(human.out.join('')).toContain(reason);
      expect(human.out.join('')).not.toContain('Awakened employee');
    }
  );

  it('does not turn an empty, already-live report into a successful awakening', async () => {
    const f = fixture([ok(company), ok({ recovery: { awakened: [], skipped: [] } })]);
    expect(await agentWakeEmployee(f.deps, { employeeId: EMPLOYEE })).toBe(EXIT.refused);
    expect(f.out.join('')).toContain('No employee awakened');
    expect(f.calls).toHaveLength(2);
  });

  it.each([
    {},
    { awakened: [SESSION], skipped: [] },
    { awakened: [EMPLOYEE], skipped: [{ employeeId: EMPLOYEE, reason: 'not-desired' }] },
    { awakened: [], skipped: [{ employeeId: EMPLOYEE }] },
  ])('refuses an unconfirmed or contradictory report', async (recovery) => {
    const f = fixture([ok(company), ok({ recovery })]);
    expect(await agentWakeEmployee(f.deps, { employeeId: EMPLOYEE })).toBe(EXIT.error);
    expect(f.out).toEqual([]);
  });

  it('does not retry or claim failure-free delivery after a lost POST response', async () => {
    const f = fixture([ok(company), new Error('Synthetic connection loss')]);
    expect(await agentWakeEmployee(f.deps, { employeeId: EMPLOYEE })).toBe(EXIT.error);
    expect(f.err.join('')).toContain('unconfirmed');
    expect(f.calls).toHaveLength(2);
    expect(f.out).toEqual([]);
  });

  it('keeps the session-nudge command and explains employee recovery in help', () => {
    const program = new Command();
    const agent = registerAgentCommands(program);
    expect(agent.commands.find((command) => command.name() === 'wake')?.description()).toContain('Nudge an idle');
    const wake = agent.commands.find((command) => command.name() === 'wake-employee');
    expect(wake?.helpInformation()).toContain('full employee UUID');
    expect(wake?.helpInformation()).toContain('recovery grant');
    expect(wake?.helpInformation()).not.toContain('--owner');
  });
});

describe('wake-employee CLI with an owned fake HTTP server', () => {
  async function run(inside: boolean, denied = false) {
    const calls: Array<{
      method: string | undefined;
      path: string | undefined;
      headers: http.IncomingHttpHeaders;
      body: string;
    }> = [];
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push({ method: request.method, path: request.url, headers: request.headers, body });
      response.setHeader('content-type', 'application/json');
      response.statusCode = denied && request.method === 'POST' ? 403 : 200;
      response.end(
        JSON.stringify(
          request.method === 'GET'
            ? { success: true, data: company }
            : denied
              ? { success: false, error: 'Recovery permission denied' }
              : { success: true, data: { recovery: report } }
        )
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP fixture unavailable');
    vi.stubEnv('REVERIE_MUX', inside ? '1' : '0');
    vi.stubEnv('REVERIE_SESSION_ID', SELF);
    vi.stubEnv('REVERIE_API_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('REVERIE_USERNAME', 'synthetic-agent');
    vi.stubEnv('REVERIE_PASSWORD', 'synthetic-password');
    const out: string[] = [],
      err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => {
      out.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line) => {
      err.push(String(line));
    });
    const oldExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerAgentCommands(program);
      await program.parseAsync(['agent', 'wake-employee', EMPLOYEE, '--json'], { from: 'user' });
      return { code: process.exitCode, calls, out, err };
    } finally {
      process.exitCode = oldExit;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  it('uses resolveAgentContext/httpRequest with own credentials, no override, and one fixed POST', async () => {
    const f = await run(true);
    expect(f.code).toBe(EXIT.ok);
    expect(f.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ['GET', '/api/company', ''],
      ['POST', `/api/company/employees/${EMPLOYEE}/wake`, '{}'],
    ]);
    for (const call of f.calls) {
      expect(call.headers.authorization).toBe(
        `Basic ${Buffer.from('synthetic-agent:synthetic-password').toString('base64')}`
      );
      expect(call.headers['x-reverie-parent-session']).toBe(SELF);
      expect(call.headers['x-reverie-owner']).toBeUndefined();
    }
    expect(JSON.parse(f.out[0])).toEqual({ recovery: report });
  });

  it('sets a nonzero CLI exit on the server actual refusal, without another POST', async () => {
    const f = await run(true, true);
    expect(f.code).toBe(EXIT.refused);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(f.out[0])).toEqual({
      success: false,
      error: expect.stringContaining('Recovery permission denied'),
    });
    expect(f.out.join('')).not.toContain('awakened');
  });

  it('refuses outside a managed session before any HTTP request', async () => {
    const f = await run(false);
    expect(f.code).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
    expect(f.err.join('')).toContain('Not inside a Reverie-managed session');
  });
});
