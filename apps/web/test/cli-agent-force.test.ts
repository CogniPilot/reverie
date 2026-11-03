import { afterEach, expect, it } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentForcePlanMove, agentMoveJournal } from '../src/cli-agent-force.js';
import {
  registerAgentCommands,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
  EXIT,
} from '../src/cli-agent.js';

const EID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const clean: string[] = [];
afterEach(async () => {
  for (const path of clean.splice(0)) await rm(path, { recursive: true, force: true });
});
const ok = (data: unknown): ApiResponse => ({ status: 200, text: '', json: { success: true, data } });
const record = {
  id: 'move-1',
  employeeId: EID,
  oldSession: SID,
  newSession: DEST,
  toAccount: 'account-1',
  phase: 'recovery-required',
};
function fixture(answers: Array<ApiResponse | Error>) {
  const calls: RequestOptions[] = [],
    out: string[] = [],
    err: string[] = [];
  const ctx = { apiUrl: 'http://fixture.invalid', selfId: DEST };
  const deps: AgentDeps = {
    ctx,
    json: true,
    io: { out: (x) => out.push(x), err: (x) => err.push(x) },
    request: async (actual, request) => {
      expect(actual).toBe(ctx);
      calls.push(request);
      const answer = answers.shift();
      if (!answer) throw Error('Unexpected request');
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { deps, calls, out, err };
}
async function handoff(text = 'Work saved; checks complete; remaining task documented.') {
  const root = await mkdtemp(join(tmpdir(), 'force-client-'));
  clean.push(root);
  const file = join(root, 'handoff.txt');
  await writeFile(file, text, { mode: 0o600 });
  return file;
}
const options = (handoffFile: string) => ({ employeeId: EID, accountId: 'account-1', id: 'move-1', handoffFile });

it('forces the current exact generation once with the real scoped context and truthful handoff', async () => {
  const file = await handoff();
  const f = fixture([
    ok({ employees: [{ id: EID, sessionId: SID, sessionGeneration: 3 }] }),
    ok({ ...record, phase: 'waiting' }),
  ]);
  expect(await agentForcePlanMove(f.deps, options(file))).toBe(EXIT.ok);
  expect(f.calls).toEqual([
    { method: 'GET', path: '/api/company' },
    {
      method: 'POST',
      path: '/api/plans/moves/force',
      body: {
        id: 'move-1',
        employeeId: EID,
        sessionId: SID,
        sessionGeneration: 3,
        toAccount: 'account-1',
        handoff: 'Work saved; checks complete; remaining task documented.',
      },
    },
  ]);
  expect(f.calls.every((call) => !call.headers)).toBe(true);
  expect(JSON.parse(f.out[0]).phase).toBe('waiting');
});

it('never repeats a forced transfer after a lost reply', async () => {
  const f = fixture([ok({ employees: [{ id: EID, sessionId: SID, sessionGeneration: 3 }] }), Error('lost reply')]);
  expect(await agentForcePlanMove(f.deps, options(await handoff()))).toBe(EXIT.error);
  expect(f.calls).toHaveLength(2);
  expect(f.err.join('')).toContain('not retried');
});

it.each(['blank', 'oversized', 'control', 'invalid-utf8', 'symlink'])(
  'refuses unsafe %s handoff before any request',
  async (kind) => {
    const file = await handoff(
      kind === 'blank' ? ' ' : kind === 'oversized' ? 'x'.repeat(48001) : kind === 'control' ? 'bad\x00text' : 'handoff'
    );
    let selected = file;
    if (kind === 'invalid-utf8') await writeFile(file, Buffer.from([0xff]));
    if (kind === 'symlink') {
      selected = file + '.link';
      await symlink(file, selected);
    }
    const f = fixture([]);
    expect(await agentForcePlanMove(f.deps, options(selected))).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
  }
);

it('refuses duplicate or malformed canonical binding before dispatching a transfer', async () => {
  const file = await handoff();
  for (const employees of [
    [],
    [{ id: EID, sessionId: SID, sessionGeneration: 0 }],
    [
      { id: EID, sessionId: SID, sessionGeneration: 3 },
      { id: EID, sessionId: SID, sessionGeneration: 3 },
    ],
  ]) {
    const f = fixture([ok({ employees })]);
    expect(await agentForcePlanMove(f.deps, options(file))).toBe(EXIT.refused);
    expect(f.calls).toHaveLength(1);
  }
});

it('does not call a different returned binding a confirmed forced operation', async () => {
  const f = fixture([
    ok({ employees: [{ id: EID, sessionId: SID, sessionGeneration: 3 }] }),
    ok({ ...record, oldSession: DEST }),
  ]);
  expect(await agentForcePlanMove(f.deps, options(await handoff()))).toBe(EXIT.error);
  expect(f.out).toEqual([]);
});

it('reads only the exact existing transfer journal', async () => {
  const f = fixture([ok(record)]);
  expect(await agentMoveJournal(f.deps, { employeeId: EID, id: 'move-1', action: 'status' })).toBe(EXIT.ok);
  expect(f.calls).toEqual([{ method: 'POST', path: '/api/plans/moves/move-1/status', body: { employeeId: EID } }]);
});

it('adopts only the existing journal tuple without creating a session or asserting target approval', async () => {
  const f = fixture([ok(record), ok({ ...record, phase: 'completed' })]);
  expect(await agentMoveJournal(f.deps, { employeeId: EID, id: 'move-1', action: 'resolve' })).toBe(EXIT.ok);
  expect(f.calls[1]).toEqual({
    method: 'POST',
    path: '/api/plans/moves/move-1/resolve',
    body: {
      employeeId: EID,
      action: 'adopt-existing',
      oldSession: SID,
      newSession: DEST,
      toAccount: 'account-1',
    },
  });
});

it('refuses mismatched or destination-less journals without a recovery effect', async () => {
  for (const data of [
    { ...record, employeeId: DEST },
    { ...record, newSession: undefined },
    { ...record, phase: 'starting' },
  ]) {
    const f = fixture([ok(data)]);
    expect(await agentMoveJournal(f.deps, { employeeId: EID, id: 'move-1', action: 'resolve' })).not.toBe(EXIT.ok);
    expect(f.calls).toHaveLength(1);
  }
});

it('does not repeat an uncertain adoption or cancellation', async () => {
  for (const action of ['resolve', 'cancel'] as const) {
    const f = fixture([ok(record), Error('lost reply')]);
    expect(await agentMoveJournal(f.deps, { employeeId: EID, id: 'move-1', action })).toBe(EXIT.error);
    expect(f.calls).toHaveLength(2);
    expect(f.err.join('')).toContain('not retried');
  }
});

it('exposes forced transfer and team journal recovery through the normal CLI', () => {
  const program = new Command();
  registerAgentCommands(program);
  const moves = program.commands.find((c) => c.name() === 'agent')!.commands.find((c) => c.name() === 'plan-move')!;
  expect(moves.commands.find((c) => c.name() === 'force')).toBeDefined();
  for (const name of ['recovery-status', 'recover-existing', 'cancel-recovery'])
    expect(moves.commands.find((c) => c.name() === name)?.options.some((o) => o.long === '--employee')).toBe(true);
});
