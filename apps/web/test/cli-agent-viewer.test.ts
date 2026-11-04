import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { agentViewerRecovery, viewerRecoveryStatus } from '../src/cli-agent-viewer.js';
import {
  registerAgentCommands,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
  EXIT,
} from '../src/cli-agent.js';

const EID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const company = { employees: [{ id: EID, sessionId: SID, sessionGeneration: 3 }] };
const connected = { state: 'connected', reason: 'connected', attempts: 1, retryAfterMs: 0 };
const ok = (data: unknown): ApiResponse => ({ status: 200, text: '', json: { success: true, data } });
function fixture(answers: Array<ApiResponse | Error>, json = true) {
  const calls: RequestOptions[] = [],
    out: string[] = [],
    err: string[] = [];
  const ctx = { apiUrl: 'http://fixture.invalid', selfId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  const deps: AgentDeps = {
    ctx,
    json,
    io: { out: (x) => out.push(x), err: (x) => err.push(x) },
    request: async (actual, request) => {
      expect(actual).toBe(ctx);
      calls.push(request);
      const result = answers.shift();
      if (!result) throw Error('Unexpected request');
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { deps, calls, out, err };
}

describe('scoped viewer recovery client', () => {
  it('sends the unique current binding once through the existing context without custom authority headers', async () => {
    const f = fixture([ok(company), ok({ state: 'viewer-connected', reconnect: connected })]);
    expect(await agentViewerRecovery(f.deps, { employeeId: EID })).toBe(EXIT.ok);
    expect(f.calls).toEqual([
      { method: 'GET', path: '/api/company' },
      {
        method: 'POST',
        path: `/api/company/employees/${EID}/reconnect`,
        body: { sessionId: SID, sessionGeneration: 3 },
      },
    ]);
    expect(JSON.parse(f.out[0])).toEqual({ state: 'viewer-connected', reconnect: connected });
  });

  it('reads status without dispatching the repair endpoint', async () => {
    const status = { state: 'blocked', reason: 'native-health-unavailable', attempts: 0, retryAfterMs: 0 };
    const f = fixture([ok(company), ok({ reconnect: status })]);
    expect(await agentViewerRecovery(f.deps, { employeeId: EID, statusOnly: true })).toBe(EXIT.ok);
    expect(f.calls[1]).toEqual({
      method: 'POST',
      path: `/api/company/employees/${EID}/reconnect/status`,
      body: { sessionId: SID, sessionGeneration: 3 },
    });
    expect(JSON.parse(f.out[0])).toEqual({ reconnect: status });
  });

  it.each(['Alex', EID.slice(0, 8), EID.toUpperCase(), `${EID}/restart`])(
    'refuses invalid employee reference %s',
    async (employeeId) => {
      const f = fixture([]);
      expect(await agentViewerRecovery(f.deps, { employeeId })).toBe(EXIT.refused);
      expect(f.calls).toEqual([]);
    }
  );

  it.each([
    [],
    [company.employees[0], company.employees[0]],
    [{ ...company.employees[0], sessionGeneration: 0 }],
    [{ ...company.employees[0], sessionId: 'pid-4' }],
  ])('rejects missing, duplicate and invalid current bindings', async (employees) => {
    const f = fixture([ok({ employees })]);
    expect(await agentViewerRecovery(f.deps, { employeeId: EID })).toBe(EXIT.refused);
    expect(f.calls).toHaveLength(1);
  });

  it('retains bounded refused status and never replays an unavailable attempt', async () => {
    const status = { state: 'blocked', reason: 'backoff', attempts: 3, retryAfterMs: 5000 };
    const f = fixture([
      ok(company),
      { status: 409, text: '', json: { success: false, error: 'Not confirmed', reconnect: status } } as ApiResponse,
    ]);
    expect(await agentViewerRecovery(f.deps, { employeeId: EID })).toBe(EXIT.refused);
    expect(JSON.parse(f.out[0])).toEqual({ reconnect: status });
    expect(f.calls).toHaveLength(2);
  });

  it('does not repeat an unconfirmed POST or turn a 200 missing observation into acceptance', async () => {
    for (const answer of [
      new Error('connection lost'),
      ok({ state: 'viewer-connected' }),
      ok({ state: 'viewer-connected', reconnect: { ...connected, state: 'blocked' } }),
    ]) {
      const f = fixture([ok(company), answer]);
      expect(await agentViewerRecovery(f.deps, { employeeId: EID })).toBe(EXIT.error);
      expect(f.calls).toHaveLength(2);
      expect(f.out.join('')).not.toContain('"state":"viewer-connected"');
    }
  });

  it('fails closed on missing native authority proof without borrowing another identity', async () => {
    const f = fixture([
      ok(company),
      { status: 403, text: '', json: { success: false, error: 'Current office proof required' } },
    ]);
    expect(await agentViewerRecovery(f.deps, { employeeId: EID })).toBe(EXIT.refused);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((call) => !call.headers)).toBe(true);
  });

  it('bounds diagnostics instead of reflecting arbitrary response content', () => {
    for (const bad of [
      { ...connected, reason: 'private path /secret' },
      { ...connected, attempts: -1 },
      { ...connected, retryAfterMs: 60001 },
      { ...connected, state: 'provider-restarted' },
    ])
      expect(viewerRecoveryStatus(bad)).toBeUndefined();
  });

  it('registers normal discoverable CLI verbs', () => {
    const root = new Command();
    registerAgentCommands(root);
    const names = root.commands.find((c) => c.name() === 'agent')!.commands.map((c) => c.name());
    expect(names).toContain('viewer-status');
    expect(names).toContain('reconnect-viewer');
  });
});
