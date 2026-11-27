/**
 * `reverie agent model`: a thin client. It reads with GET, chooses with PUT, refuses malformed input
 * before any request, and passes the server's refusal through.
 */
import { describe, expect, it, vi } from 'vitest';
import { agentEmployeeModel, describeModelStatus } from '../src/cli-agent-model.js';
import { EXIT, resolveAgentContext, type AgentDeps, type ApiResponse, type RequestOptions } from '../src/cli-agent.js';

vi.mock('../src/reverie-credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/reverie-credentials.js')>()),
  readReverieEnvFile: () => ({}),
}));

const EMPLOYEE = 'b70db8c4-2f39-43d0-95e6-6c1851bea5b9';
const ok = (data: unknown): ApiResponse => ({ status: 200, text: '', json: { success: true, data } });

function fixture(answers: ApiResponse[], json = false) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: AgentDeps = {
    ctx: resolveAgentContext(
      {
        REVERIE_MUX: '1',
        REVERIE_API_URL: 'http://synthetic.test',
        REVERIE_SESSION_ID: '33333333-3333-4333-8333-333333333333',
      },
      () => ({})
    ),
    json,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    request: async (_ctx, request) => {
      calls.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error('Unexpected request');
      return answer;
    },
  };
  return { deps, calls, out, err };
}

describe('agent model', () => {
  it('reads with GET and chooses with PUT', async () => {
    const read = fixture([ok({ name: 'Stan', supported: true, live: 'Fable 5.2', state: 'none' })]);
    expect(await agentEmployeeModel(read.deps, { employeeId: EMPLOYEE })).toBe(EXIT.ok);
    expect(read.calls).toEqual([{ method: 'GET', path: `/api/company/employees/${EMPLOYEE}/model` }]);
    expect(read.out).toEqual(['Stan: running Fable 5.2.']);
    const choose = fixture(
      [
        ok({
          name: 'Stan',
          supported: true,
          live: 'Fable 5.2',
          target: 'claude-opus-5-5',
          state: 'pending',
          reason: 'something is typed in its composer',
          preferred: { model: 'claude-opus-5-5', by: 'employee Burt' },
        }),
      ],
      true
    );
    expect(
      await agentEmployeeModel(choose.deps, { employeeId: EMPLOYEE, model: 'claude-opus-5-5', effort: 'high' })
    ).toBe(EXIT.ok);
    expect(choose.calls).toEqual([
      {
        method: 'PUT',
        path: `/api/company/employees/${EMPLOYEE}/model`,
        body: { model: 'claude-opus-5-5', effort: 'high' },
      },
    ]);
    expect(JSON.parse(choose.out[0]).state).toBe('pending');
  });

  it('refuses a name, a malformed model and a stray effort before any request', async () => {
    for (const options of [
      { employeeId: 'Stan' },
      { employeeId: EMPLOYEE, model: '-opus' },
      { employeeId: EMPLOYEE, model: 'opus\r/clear' },
      { employeeId: EMPLOYEE, effort: 'high' },
      { employeeId: EMPLOYEE, model: 'opus', effort: 'ultracode' },
    ]) {
      const f = fixture([]);
      expect(await agentEmployeeModel(f.deps, options)).toBe(EXIT.refused);
      expect(f.calls).toEqual([]);
    }
  });

  it('passes a server refusal through and exits nonzero on a failed switch', async () => {
    const refused = fixture([
      { status: 403, text: '', json: { success: false, error: 'Employee model permission is required' } },
    ]);
    expect(await agentEmployeeModel(refused.deps, { employeeId: EMPLOYEE, model: 'opus' })).toBe(EXIT.refused);
    expect(refused.err).toEqual(['Employee model permission is required']);
    const failed = fixture([
      ok({ name: 'Stan', supported: true, target: 'opus', state: 'failed', reason: 'not confirmed' }),
    ]);
    expect(await agentEmployeeModel(failed.deps, { employeeId: EMPLOYEE, model: 'opus' })).toBe(EXIT.error);
  });

  it('describes a fallback in force', () => {
    expect(
      describeModelStatus({
        name: 'Stan',
        supported: true,
        live: 'Opus 5.5',
        target: 'claude-opus-5-5',
        state: 'applied',
        fallback: {
          to: 'claude-opus-5-5',
          family: 'fable',
          restore: 'claude-fable-5-2',
          restoreAt: Date.UTC(2026, 10, 26, 4, 2),
        },
      })
    ).toBe(
      'Stan: running Opus 5.5; on claude-opus-5-5 after the fable limit, back to claude-fable-5-2 after 2026-11-26T04:02:00.000Z; applied.'
    );
  });
});
