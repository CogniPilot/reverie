/** Pure transport boundary: no Engine/provider effects and no permission grants. */
import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import {
  agentDockerContinuation,
  registerDockerEmployeeContinuationCommands,
} from '../src/docker-employee-continuation-cli.js';
import { registerAgentCommands, type AgentDeps, type ApiResponse } from '../src/cli-agent.js';
const eid = '22222222-2222-4222-8222-222222222222',
  sid = '33333333-3333-4333-8333-333333333333';
const selection = {
  operationId: '44444444-4444-4444-8444-444444444444',
  sessionId: sid,
  sessionGeneration: 3,
  containerId: 'a'.repeat(64),
  imageId: 'sha256:' + 'b'.repeat(64),
  expectedDestinationImageId: 'sha256:' + 'c'.repeat(64),
  expectedPolicyDigest: 'd'.repeat(64),
  enterOffice: false,
};
function fixture(reply: ApiResponse = { status: 200, text: '', json: { success: true, data: { state: 'ready' } } }) {
  const calls: unknown[] = [],
    out: string[] = [],
    err: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1', selfId: sid, workerIdentity: 'synthetic-opaque' },
    json: true,
    io: { out: (x) => out.push(x), err: (x) => err.push(x) },
    request: async (_ctx, options) => {
      calls.push(options);
      return reply;
    },
  };
  return { deps, calls, out, err };
}
describe('packaged Docker continuation commands', () => {
  it('registers all required commands through the shared agent entry', () => {
    const agent = registerAgentCommands(new Command());
    expect(agent.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['docker-policy', 'continue-employee', 'observe-docker-continuation'])
    );
  });
  it('refuses malformed selections before transport', async () => {
    const f = fixture();
    for (const request of [
      { ...selection, containerId: 'short' },
      { ...selection, sessionGeneration: 0 },
      { ...selection, extra: true },
    ]) {
      expect(await agentDockerContinuation(f.deps, eid, 'continue', request)).toBe(4);
    }
    expect(await agentDockerContinuation(f.deps, eid.slice(0, 8), 'policy')).toBe(4);
    expect(f.calls).toHaveLength(0);
  });
  it('preserves the exact original selection and reports held/pending separately from ready', async () => {
    for (const [state, code] of [
      ['held', 2],
      ['pending', 3],
      ['ready', 0],
    ] as const) {
      const f = fixture({ status: 200, text: '', json: { success: true, data: { state } } });
      expect(await agentDockerContinuation(f.deps, eid, 'continue', selection)).toBe(code);
      expect(f.calls).toEqual([
        {
          method: 'POST',
          path: '/api/company/employees/' + eid + '/docker-continuation',
          body: { request: selection },
          bounds: { maxBytes: 65536, deadlineMs: 35000 },
        },
      ]);
      expect(f.out).toEqual([JSON.stringify({ state })]);
    }
  });
  it('never retries uncertain transport and exposes no policy editing command', async () => {
    const f = fixture();
    let calls = 0;
    f.deps.request = async () => {
      calls++;
      throw Error('controlled lost reply');
    };
    expect(await agentDockerContinuation(f.deps, eid, 'continue', selection)).toBe(1);
    expect(calls).toBe(1);
    expect(f.out).toEqual([]);
    expect(f.err.join(' ')).toContain('same original operation');
    const agent = new Command();
    registerDockerEmployeeContinuationCommands(agent, async () => {});
    expect(agent.commands.map((c) => c.name())).toEqual([
      'docker-policy',
      'observe-docker-continuation',
      'continue-employee',
    ]);
  });
});
