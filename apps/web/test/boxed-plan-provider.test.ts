/** External fake model protocol tests; transport injection cannot mint office/native grants. */
import { expect, it } from 'vitest';
import {
  BoxedPlanProviderFixture,
  PlanProviderFixtureContract,
  planFixtureTurnBarrier,
  requirePlanFixtureHooks,
  type FixtureCliReply,
  type PlanProviderFixturePorts,
  type PlanProviderFixtureReport,
} from './helpers/boxed-plan-provider.js';
import { workerHookSettings } from '../src/worker-client-callback.js';
const eid = '11111111-1111-4111-8111-111111111111',
  sid = '22222222-2222-4222-8222-222222222222',
  thread = '33333333-3333-4333-8333-333333333333';
const contract = PlanProviderFixtureContract.parse({
  version: 1,
  purpose: 'reverie-ci-plan-provider-v1',
  employeeId: eid,
  accounts: ['plan-a', 'plan-b'],
  autoApprove: true,
  exhausted: false,
  refreshAccountId: 'plan-a',
  pauseBeforeApproval: false,
});
const identity = {
  sessionId: sid,
  providerThread: thread,
  namespacePid: 12,
  hookGeneration: 'fixture_hook_generation',
};
const reply = (value: unknown): FixtureCliReply => ({
  exitCode: 0,
  signal: null,
  stdout: typeof value === 'string' ? value : JSON.stringify(value),
  stderr: '',
});
function fixture() {
  const calls: string[][] = [],
    trace: string[] = [],
    output: string[] = [],
    reports: PlanProviderFixtureReport[] = [],
    latches = new Set<string>();
  let status = {
    success: true,
    id: 'request-1',
    employeeId: eid,
    sessionId: sid,
    fromAccount: 'plan-a',
    toAccount: 'plan-b',
    phase: 'pending',
  };
  let approve = reply({ success: true, phase: 'executing' }),
    list = reply({ success: true, requests: [{ id: 'request-1', phase: 'pending', toAccount: 'plan-b' }] }),
    closeFails = false;
  const ports: PlanProviderFixturePorts = {
    cli: async (args) => {
      calls.push([...args]);
      trace.push(args.join(' '));
      if (args[0] === 'worker-callback') return reply('');
      if (args[0] === 'plans') return reply([{ id: 'plan-a', sessions: [{ id: sid }] }]);
      if (args[1] === 'capabilities') return reply({ identity: { kind: 'agent', sessionId: sid } });
      if (args[2] === 'list') return list;
      if (args[2] === 'status') return reply(status);
      return approve;
    },
    prepareApproval: async (id, handoff) => {
      trace.push('intent:' + id);
      expect(handoff).not.toContain('nonce');
      if (latches.has(id)) return 'existing';
      latches.add(id);
      return 'prepared';
    },
    refreshAuthOnce: async (id) => {
      trace.push('refresh:' + id);
    },
    beforeApproval: async () => {
      trace.push('pause');
    },
    record: async (report) => {
      trace.push('receipt-close');
      if (closeFails) throw Error('Close unknown');
      reports.push(structuredClone(report));
    },
    output: (text) => {
      trace.push('stdout');
      output.push(text);
    },
  };
  const provider = new BoxedPlanProviderFixture(contract, identity, ports, workerHookSettings());
  return {
    provider,
    ports,
    calls,
    trace,
    output,
    reports,
    latches,
    setStatus: (value: typeof status) => {
      status = value;
    },
    setList: (value: FixtureCliReply) => {
      list = value;
    },
    setApproval: (value: FixtureCliReply) => {
      approve = value;
    },
    failClose: () => {
      closeFails = true;
    },
    status: () => status,
  };
}
it('requires the actual generated Stop and PromptSubmitted callbacks before fixture launch', () => {
  requirePlanFixtureHooks(workerHookSettings());
  const wrong = structuredClone(workerHookSettings());
  wrong.hooks.Stop[0]!.hooks[0]!.command = 'arbitrary shell';
  expect(() => requirePlanFixtureHooks(wrong)).toThrow();
  expect(() => requirePlanFixtureHooks({ hooks: {} })).toThrow();
});
it('boots with real CLI identity and Stop but defers account reads until the bound turn', async () => {
  const f = fixture();
  await f.provider.start();
  expect(f.calls.map((args) => args.join(' '))).toEqual([
    'agent capabilities --json',
    'worker-callback hook-event --event stop',
  ]);
  expect(f.trace.slice(-2)).toEqual(['receipt-close', 'stdout']);
  expect(f.reports[0]!.accountId).toBeNull();
  expect(f.output[0]).toMatch(/^BCPLAN_[a-f0-9]{64}\nBCPLAN_TURN_[a-f0-9]{64}\n❯ $/);
  expect(f.output[0]).toContain(planFixtureTurnBarrier(f.reports[0]!) + '\n');
});
it('approves one exact own pending request then yields through the actual Stop callback', async () => {
  const f = fixture(),
    report = await f.provider.turn();
  expect(report!.state).toBe('approval-returned');
  expect(report!.requestId).toBe('request-1');
  expect(f.trace.indexOf('intent:request-1')).toBeLessThan(f.trace.findIndex((v) => v.includes('plan-move approve')));
  expect(f.trace.findIndex((v) => v.includes('plan-move approve'))).toBeLessThan(
    f.trace.indexOf('worker-callback hook-event --event stop')
  );
  expect(f.calls.find((args) => args[2] === 'approve')).toEqual([
    'agent',
    'plan-move',
    'approve',
    'request-1',
    '--handoff-file',
    '/home/agent/.fixture/plan-handoff-request-1.txt',
    '--json',
  ]);
  expect(f.trace).toContain('refresh:plan-a');
  expect(f.trace.slice(-2)).toEqual(['receipt-close', 'stdout']);
});
it('never repeats unknown approval, including a later SDK process sharing the durable intent', async () => {
  const f = fixture();
  f.setApproval({
    exitCode: null,
    signal: 'SIGKILL',
    stdout: 'private nonce must not be logged',
    stderr: 'private token',
  });
  expect((await f.provider.turn())!.state).toBe('unknown');
  const restored = new BoxedPlanProviderFixture(contract, identity, f.ports, workerHookSettings());
  expect((await restored.turn())!.state).toBe('already-attempted');
  expect(f.calls.filter((args) => args[2] === 'approve')).toHaveLength(1);
  expect(JSON.stringify(f.reports)).not.toMatch(/private nonce|private token/);
});
it('denied self tools do not become approval authority', async () => {
  const f = fixture();
  f.setList({ exitCode: 4, signal: null, stdout: '', stderr: 'Move own plan grant required' });
  expect((await f.provider.turn())!.state).toBe('denied');
  expect(f.calls.some((args) => args[2] === 'approve')).toBe(false);
});
it('rejects foreign employee/session/account and ambiguous or malformed pending metadata', async () => {
  for (const key of ['employeeId', 'sessionId', 'fromAccount', 'toAccount'] as const) {
    const f = fixture();
    f.setStatus({ ...f.status(), [key]: key.endsWith('Id') ? '99999999-9999-4999-8999-999999999999' : 'foreign' });
    await expect(f.provider.turn()).rejects.toThrow('scope differs');
    expect(f.calls.some((args) => args[2] === 'approve')).toBe(false);
  }
  const f = fixture();
  f.setList(
    reply({
      success: true,
      requests: [
        { id: 'one', phase: 'pending', toAccount: 'plan-b' },
        { id: 'two', phase: 'pending', toAccount: 'plan-b' },
      ],
    })
  );
  await expect(f.provider.turn()).rejects.toThrow('ambiguous');
  expect(f.latches.size).toBe(0);
});
it('exhaustion disables cooperation without bypassing any plan or native fence', async () => {
  const f = fixture(),
    exhausted = new BoxedPlanProviderFixture({ ...contract, exhausted: true }, identity, f.ports, workerHookSettings());
  expect((await exhausted.turn())!.state).toBe('cooperation-disabled');
  expect(f.calls.some((args) => args[2] === 'approve')).toBe(false);
});
it('does not print completion or composer when receipt consuming close fails', async () => {
  const f = fixture();
  f.failClose();
  await expect(f.provider.turn()).rejects.toThrow('Close unknown');
  expect(f.output).toEqual([]);
  expect(f.calls.filter((args) => args[2] === 'approve')).toHaveLength(1);
});
it('rechecks a revoked approval through real CLI refusal after the model pause', async () => {
  const f = fixture();
  f.ports.beforeApproval = async () => f.setApproval({ exitCode: 1, signal: null, stdout: '', stderr: 'Revoked' });
  const paused = new BoxedPlanProviderFixture(
    { ...contract, pauseBeforeApproval: true },
    identity,
    f.ports,
    workerHookSettings()
  );
  expect((await paused.turn())!.state).toBe('unknown');
  expect(f.calls.filter((args) => args[2] === 'approve')).toHaveLength(1);
});
it('refuses malformed contract and foreign startup identity without writes', () => {
  expect(() => PlanProviderFixtureContract.parse({ ...contract, accounts: ['same', 'same'] })).toThrow();
  expect(() => PlanProviderFixtureContract.parse({ ...contract, environment: { ANY: 'override' } })).toThrow();
  expect(
    () =>
      new BoxedPlanProviderFixture(contract, { ...identity, sessionId: 'short' }, fixture().ports, workerHookSettings())
  ).toThrow();
});

it('binds each successful consuming-close stdout barrier to a distinct turn even when SID/request/state repeat', async () => {
  const f = fixture();
  await f.provider.start();
  await f.provider.start();
  expect(f.reports[0]!.turnId).not.toBe(f.reports[1]!.turnId);
  expect(planFixtureTurnBarrier(f.reports[0]!)).not.toBe(planFixtureTurnBarrier(f.reports[1]!));
  for (let index = 0; index < 2; index++)
    expect(f.output[index]).toContain(planFixtureTurnBarrier(f.reports[index]!) + '\n');
  const g = fixture();
  g.failClose();
  await expect(g.provider.start()).rejects.toThrow();
  expect(g.output).toEqual([]);
});
