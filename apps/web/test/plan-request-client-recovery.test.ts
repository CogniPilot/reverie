/** Real CLI helper/registration, synthetic transport only. Never dispatches an actual move. */
import { expect, it } from 'vitest';
import { Command } from 'commander';
import { agentRequestPlanMove } from '../src/cli-plan-request.js';
import { registerAgentCommands, type AgentDeps } from '../src/cli-agent.js';

function client(response: { status: number; json: unknown } | Error, json = true) {
  const calls: Parameters<AgentDeps['request']>[1][] = [],
    out: string[] = [],
    err: string[] = [];
  const deps: AgentDeps = {
    ctx: { selfId: 'source', apiUrl: 'http://synthetic.invalid' },
    json,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    request: async (_ctx, request) => {
      calls.push(structuredClone(request));
      if (request.method === 'GET')
        return {
          status: 200,
          text: '',
          json: { success: true, data: { employees: [{ id: 'expert', sessionId: 'source' }] } },
        };
      if (response instanceof Error) throw response;
      return { status: response.status, text: '', json: response.json as never };
    },
  };
  return { deps, calls, out, err };
}
it('retains the generated original request ID in structured failure without retrying the transport', async () => {
  const f = client(Error('Lost response'));
  expect(await agentRequestPlanMove(f.deps, { toAccount: 'target' })).toBe(1);
  const posted = f.calls.find((call) => call.path === '/api/plans/agent-requests')!.body as { id: string };
  expect(posted.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.out).toHaveLength(1);
  const result = JSON.parse(f.out[0]!);
  expect(result).toMatchObject({
    success: false,
    requestId: posted.id,
    inspectionCommand: `reverie agent plan-move status --json -- ${posted.id}`,
  });
  expect(result.error).toContain('unconfirmed');
  expect(f.err).toEqual([]);
  expect(f.calls.map((call) => call.path)).toEqual(['/api/company', '/api/plans/agent-requests']);
});
for (const status of [403, 409, 500])
  it(`reports exact original ID after HTTP${status} without claiming non-dispatch`, async () => {
    const f = client(
      { status, json: { success: false, error: { message: 'Current plan permission changed' } } },
      false
    );
    expect(await agentRequestPlanMove(f.deps, { id: 'retained-request', toAccount: 'target' })).toBe(1);
    expect(f.err.join(' ')).toContain('Current plan permission changed');
    expect(f.err.join(' ')).toContain('retained-request');
    expect(f.err.join(' ')).toContain('reverie agent plan-move status --json -- retained-request');
    expect(f.err.join(' ')).not.toContain('No plan request was sent');
    expect(f.out).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });
for (const invalidId of ['bad/request', '-original'])
  it(`does not invent an issued request for invalid ${invalidId} before any POST`, async () => {
    const f = client(Error('Should not POST'));
    expect(await agentRequestPlanMove(f.deps, { id: invalidId, toAccount: 'target' })).toBe(1);
    const result = JSON.parse(f.out[0]!);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('No plan request was sent');
    expect(result.requestId).toBeUndefined();
    expect(result.inspectionCommand).toBeUndefined();
    expect(f.calls.map((call) => call.method)).toEqual(['GET']);
  });
it('keeps success output unchanged and never emits a failure inspection request', async () => {
  const f = client({ status: 200, json: { success: true, data: { phase: 'pending' } } });
  expect(await agentRequestPlanMove(f.deps, { id: 'successful', toAccount: 'target' })).toBe(0);
  expect(JSON.parse(f.out[0]!)).toEqual({ success: true, id: 'successful', phase: 'pending' });
  expect(f.calls).toHaveLength(2);
});
it('prints an exact inspection command accepted by the actual CLI parser', async () => {
  const f = client(Error('Lost response'));
  expect(await agentRequestPlanMove(f.deps, { id: 'original-with-dashes', toAccount: 'target' })).toBe(1);
  const result = JSON.parse(f.out[0]!);
  const program = new Command();
  program.exitOverride();
  registerAgentCommands(program);
  const agent = program.commands.find((command) => command.name() === 'agent')!;
  const move = agent.commands.find((command) => command.name() === 'plan-move')!;
  let captured: unknown;
  move.commands
    .find((command) => command.name() === 'status')!
    .action((id, options) => {
      captured = { id, json: options.json };
    });
  await program.parseAsync(['node', ...result.inspectionCommand.split(' ')]);
  expect(captured).toEqual({ id: 'original-with-dashes', json: true });
  expect(f.calls).toHaveLength(2);
});
