/** Goal r3 contract fixtures; fake scoped transport only, no socket or server effects. */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDeps, ApiResponse, RequestOptions } from '../src/cli-agent.js';
import { registerAgentCommands } from '../src/cli-agent.js';
import {
  agentGoalCreate,
  agentGoalList,
  agentGoalMetadata,
  agentGoalRead,
  agentGoalTransition,
  GOAL_EXIT,
  readGoalCommand,
  registerGoalCommands,
} from '../src/cli-goal.js';
import { GoalCreateCommand, GoalTransitionCommand, GoalCommandResult } from '../src/goal-client-contract.js';

const privateText = 'PRIVATE_OBJECTIVE_CREATION_HISTORY_EVIDENCE';
const create = {
  createId: 'create-1',
  employeeId: 'worker',
  sessionId: 'session-1',
  sessionGeneration: 1,
  objective: privateText,
  nextAction: privateText,
  inputDigests: ['a'.repeat(64)],
};
const transition = {
  generation: 1,
  expectedState: 'REVIEW',
  expectedSequence: 3,
  sessionId: 'session-1',
  sessionGeneration: 1,
  transitionId: 'decision-1',
  to: 'DONE',
  nextAction: privateText,
  verifierGrantId: 'grant-1',
  evidenceRefs: ['evidence:sha256:' + 'b'.repeat(64)],
};
const creation = {
  sessionId: 'session-1',
  sessionGeneration: 1,
  generation: 1,
  state: 'READY',
  nextAction: privateText,
  semanticProgressAt: 1000,
  updatedAt: 1000,
  transitionSequence: 0,
  evidenceCount: 0,
};
const ready = {
  id: 'goal-1',
  ...create,
  createRequestDigest: 'c'.repeat(64),
  owner: 'company-owner',
  generation: 1,
  state: 'READY',
  semanticProgressAt: 1000,
  evidenceRefs: [],
  createdAt: 1000,
  updatedAt: 1000,
  transitionSequence: 0,
  transitions: [],
  creation,
};
const closed = {
  visibility: 'verification',
  goal: {
    id: 'goal-1',
    generation: 1,
    sessionId: 'session-1',
    sessionGeneration: 1,
    state: 'DONE',
    transitionSequence: 4,
    updatedAt: 1010,
  },
  receipt: {
    transitionId: 'decision-1',
    sequence: 4,
    generation: 1,
    from: 'REVIEW',
    to: 'DONE',
    actorKind: 'verifier',
    actorEmployeeId: 'verifier',
    actorSessionId: 'verifier-session',
    actorSessionGeneration: 1,
    authorityId: 'grant-1',
    operation: 'TRANSITION',
    at: 1010,
  },
};
const fullReceipt = {
  ...closed.receipt,
  requestDigest: 'd'.repeat(64),
  after: { ...creation, state: 'DONE', transitionSequence: 4, evidenceCount: 1, updatedAt: 1010 },
};
const full = {
  visibility: 'full',
  goal: { ...ready, ...closed.goal, evidenceRefs: transition.evidenceRefs, transitions: [fullReceipt] },
  receipt: fullReceipt,
};
const metadata = {
  id: 'goal-1',
  generation: 1,
  employeeId: 'worker',
  sessionId: 'session-1',
  sessionGeneration: 1,
  state: 'READY',
  bindingState: 'CURRENT',
  semanticProgressAt: 1000,
  updatedAt: 1000,
  transitionSequence: 0,
};
function success(data: unknown): ApiResponse {
  return { status: 200, text: '', json: { success: true, data } };
}
function fixture(answer: ApiResponse | Error = success(closed), json = true) {
  const calls: RequestOptions[] = [],
    out: string[] = [],
    err: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://synthetic.invalid', selfId: 'session-1' },
    json,
    request: async (context, options) => {
      expect(context).toBe(deps.ctx);
      calls.push(options);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
  };
  return { deps, calls, out, err };
}
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('Goal CLI request and output contract', () => {
  it('registers the supported group in the real agent CLI without activating any endpoint', () => {
    const program = new Command();
    registerAgentCommands(program);
    expect(
      program.commands
        .find((command) => command.name() === 'agent')
        ?.commands.find((command) => command.name() === 'goal')
        ?.commands.map((command) => command.name())
    ).toEqual(['list', 'read', 'metadata', 'create', 'transition']);
  });
  it('sends one exact scoped create command with the caller stable key and prints only a state projection', async () => {
    const f = fixture(success(ready));
    expect(await agentGoalCreate(f.deps, create)).toBe(0);
    expect(f.calls).toEqual([{ method: 'POST', path: '/api/goals', body: create }]);
    expect(f.out.join('')).not.toContain(privateText);
    expect(f.out.join('')).not.toMatch(/objective|nextAction|inputDigests|requestDigest|creation|owner|evidence/);
    expect(JSON.parse(f.out[0])).toMatchObject({ createId: 'create-1', goal: { id: 'goal-1', state: 'READY' } });
  });
  it.each(['ACTIVE', 'DONE', 'NO_GO'])(
    'preserves closed r3 verifier %s replies and exact CAS/idempotency input',
    async (to) => {
      const reply = { ...closed, goal: { ...closed.goal, state: to }, receipt: { ...closed.receipt, to } };
      const f = fixture(success(reply));
      expect(await agentGoalTransition(f.deps, 'goal-1', { ...transition, to })).toBe(0);
      expect(f.calls).toEqual([{ method: 'POST', path: '/api/goals/goal-1/transitions', body: { ...transition, to } }]);
      expect(JSON.parse(f.out[0])).toEqual(reply);
      expect(f.calls[0].headers).toBeUndefined();
      expect(f.out.join('')).not.toContain(privateText);
    }
  );
  it('reduces a full mutation result to the closed CLI summary even in JSON mode', async () => {
    const f = fixture(success(full));
    expect(await agentGoalTransition(f.deps, 'goal-1', transition)).toBe(0);
    expect(JSON.parse(f.out[0])).toEqual({ ...closed, visibility: 'summary' });
    expect(f.out.join('')).not.toMatch(/PRIVATE_|objective|after|requestDigest|creation|evidence/);
  });
  it('lists closed state summaries and never dumps full records with --json', async () => {
    const f = fixture(success([ready]));
    expect(await agentGoalList(f.deps)).toBe(0);
    expect(f.calls).toEqual([{ method: 'GET', path: '/api/goals' }]);
    expect(JSON.parse(f.out[0])[0]).toMatchObject({ id: 'goal-1', state: 'READY' });
    expect(f.out.join('')).not.toContain(privateText);
  });
  it('prints private fields only for an explicit full read that the server accepts', async () => {
    const f = fixture(success(ready));
    expect(await agentGoalRead(f.deps, 'goal-1')).toBe(0);
    expect(f.out[0]).not.toContain(privateText);
    f.out.splice(0);
    expect(await agentGoalRead(f.deps, 'goal-1', true)).toBe(0);
    expect(JSON.parse(f.out[0])).toEqual(ready);
    expect(f.calls).toEqual(Array(2).fill({ method: 'GET', path: '/api/goals/goal-1' }));
  });
  it('uses only the existing metadata grant ID and exact closed target projection', async () => {
    const f = fixture(success([metadata]));
    expect(await agentGoalMetadata(f.deps, 'worker', 'metadata-grant')).toBe(0);
    expect(f.calls).toEqual([
      { method: 'GET', path: '/api/goal-metadata/worker', query: { grantId: 'metadata-grant' } },
    ]);
    expect(JSON.parse(f.out[0])).toEqual([metadata]);
  });
  it('prints concise human state and receipt output', async () => {
    const f = fixture(success(closed), false);
    expect(await agentGoalTransition(f.deps, 'goal-1', transition)).toBe(0);
    expect(f.out).toEqual(['goal-1 DONE generation=1 sequence=4 receipt=decision-1 visibility=verification']);
  });
  it('accepts the owner terminal reopen generation increment without rewriting the input fence', async () => {
    const reply = {
      visibility: 'full',
      goal: { ...full.goal, state: 'ACTIVE', generation: 2 },
      receipt: {
        ...fullReceipt,
        from: 'DONE',
        to: 'ACTIVE',
        generation: 2,
        actorKind: 'owner',
        after: { ...fullReceipt.after, state: 'ACTIVE', generation: 2 },
      },
    };
    const f = fixture(success(reply));
    expect(await agentGoalTransition(f.deps, 'goal-1', { ...transition, expectedState: 'DONE', to: 'ACTIVE' })).toBe(0);
    expect(f.calls[0].body?.generation).toBe(1);
    expect(JSON.parse(f.out[0]).goal.generation).toBe(2);
  });
});

describe('Goal CLI refuses uncertainty and unsafe/unsupported shapes', () => {
  it.each(['owner', 'actor', 'principal', 'credential', 'grant', 'goalId'])(
    'rejects unknown authority/path field %s before transport',
    async (key) => {
      const f = fixture();
      expect(await agentGoalTransition(f.deps, 'goal-1', { ...transition, [key]: privateText })).toBe(
        GOAL_EXIT.refused
      );
      expect(f.calls).toEqual([]);
      expect(f.out.join('')).not.toContain(privateText);
    }
  );
  it('requires stable IDs and all CAS fields rather than guessing or fetching state', async () => {
    const f = fixture();
    for (const key of [
      'transitionId',
      'generation',
      'expectedSequence',
      'expectedState',
      'sessionId',
      'sessionGeneration',
    ]) {
      expect(await agentGoalTransition(f.deps, 'goal-1', { ...transition, [key]: undefined })).toBe(4);
    }
    expect(await agentGoalCreate(f.deps, { ...create, createId: undefined })).toBe(4);
    expect(f.calls).toEqual([]);
  });
  it.each([401, 403, 409, 400, 404, 503])(
    'reports HTTP%s using fixed redacted messages and never retries a command',
    async (status) => {
      const f = fixture({
        status,
        text: privateText,
        json: { success: false, errorCode: status === 409 ? 'GOAL_CONFLICT' : 'PRIVATE_CODE', error: privateText },
      });
      const result = await agentGoalTransition(f.deps, 'goal-1', transition);
      expect(result).toBe(status === 503 ? 5 : status === 404 ? 1 : 4);
      expect(f.calls).toHaveLength(1);
      expect(f.out.join('') + f.err.join('')).not.toMatch(/PRIVATE_|objective|nextAction/);
    }
  );
  it('truthfully reports absent/uninstalled Goal API for reads', async () => {
    const f = fixture({ status: 404, text: privateText });
    expect(await agentGoalList(f.deps)).toBe(1);
    expect(JSON.parse(f.out[0]).errorCode).toBe('GOAL_UNAVAILABLE');
    expect(f.calls).toHaveLength(1);
  });
  it('does not widen a denied explicit full read', async () => {
    const f = fixture({ status: 403, text: privateText });
    expect(await agentGoalRead(f.deps, 'goal-1', true)).toBe(4);
    expect(f.calls).toHaveLength(1);
    expect(f.out.join('')).not.toContain(privateText);
  });
  it.each(['generation', 'sessionGeneration', 'transitionSequence', 'id'])(
    'treats mismatched response %s as uncertain without resubmission',
    async (key) => {
      const reply = { ...closed, goal: { ...closed.goal, [key]: key === 'id' ? 'other-goal' : 99 } };
      const f = fixture(success(reply));
      expect(await agentGoalTransition(f.deps, 'goal-1', transition)).toBe(5);
      expect(JSON.parse(f.out[0])).toMatchObject({ errorCode: 'GOAL_SUBMIT_UNCERTAIN', operationId: 'decision-1' });
      expect(f.calls).toHaveLength(1);
    }
  );
  it('treats a transport failure after submission as uncertain and retains the caller key for reconciliation', async () => {
    const f = fixture(new Error(privateText));
    expect(await agentGoalCreate(f.deps, create)).toBe(5);
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.out[0])).toMatchObject({ errorCode: 'GOAL_SUBMIT_UNCERTAIN', operationId: 'create-1' });
    expect(f.out.join('')).not.toContain(privateText);
  });
  it('rejects widened verifier responses, unknown discriminants and malformed metadata without dumping them', async () => {
    for (const reply of [
      { ...closed, visibility: 'public' },
      { ...closed, goal: { ...closed.goal, objective: privateText } },
    ]) {
      const f = fixture(success(reply));
      expect(await agentGoalTransition(f.deps, 'goal-1', transition)).toBe(5);
      expect(f.out.join('')).not.toContain(privateText);
      expect(f.calls).toHaveLength(1);
    }
    const f = fixture(success([{ ...metadata, objective: privateText }]));
    expect(await agentGoalMetadata(f.deps, 'worker')).toBe(1);
    expect(f.out.join('')).not.toContain(privateText);
  });
  it('does not mix a different employee metadata projection into the requested target', async () => {
    const f = fixture(success([{ ...metadata, employeeId: 'other' }]));
    expect(await agentGoalMetadata(f.deps, 'worker')).toBe(1);
  });
});

describe('Goal CLI bounded file and command parsing', () => {
  async function inputFile(text: string) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'goal-cli-'));
    directories.push(directory);
    const file = join(directory, 'command.json');
    await fs.writeFile(file, text);
    return { directory, file };
  }
  it('reads exact file commands and refuses oversized, nonregular and symlink inputs', async () => {
    const { directory, file } = await inputFile(JSON.stringify(transition));
    expect(await readGoalCommand(file)).toEqual(transition);
    await expect(readGoalCommand(directory)).rejects.toThrow();
    const alias = join(directory, 'alias');
    await fs.symlink(file, alias);
    await expect(readGoalCommand(alias)).rejects.toThrow();
    await fs.writeFile(file, 'x'.repeat(65537));
    await expect(readGoalCommand(file)).rejects.toThrow();
  });
  it('wires transition input/JSON flags through Commander to the same typed call', async () => {
    const { file } = await inputFile(JSON.stringify(transition));
    const f = fixture();
    const program = new Command();
    const agent = program.command('agent');
    registerGoalCommands(agent, async (json, verb) => {
      f.deps.json = json;
      await verb(f.deps);
    });
    await program.parseAsync(['agent', 'goal', 'transition', 'goal-1', '--input', file, '--json'], { from: 'user' });
    expect(f.calls).toEqual([{ method: 'POST', path: '/api/goals/goal-1/transitions', body: transition }]);
    expect(JSON.parse(f.out[0])).toEqual(closed);
  });
  it('wires create input through Commander without generating an idempotency key', async () => {
    const { file } = await inputFile(JSON.stringify(create));
    const f = fixture(success(ready));
    const program = new Command();
    registerGoalCommands(program.command('agent'), async (json, verb) => {
      f.deps.json = json;
      await verb(f.deps);
    });
    await program.parseAsync(['agent', 'goal', 'create', '--input', file, '--json'], { from: 'user' });
    expect(f.calls).toEqual([{ method: 'POST', path: '/api/goals', body: create }]);
    expect(f.out.join('')).not.toContain(privateText);
  });
  it('requires an explicit Commander full-read flag before printing private data', async () => {
    const f = fixture(success(ready));
    const program = new Command();
    registerGoalCommands(program.command('agent'), async (json, verb) => {
      f.deps.json = json;
      await verb(f.deps);
    });
    await program.parseAsync(['agent', 'goal', 'read', 'goal-1', '--json'], { from: 'user' });
    expect(f.out[0]).not.toContain(privateText);
    await program.parseAsync(['agent', 'goal', 'read', 'goal-1', '--full', '--json'], { from: 'user' });
    expect(JSON.parse(f.out[1])).toEqual(ready);
  });
  it('never calls transport when a command file cannot be parsed', async () => {
    const { file } = await inputFile(privateText);
    const f = fixture();
    const program = new Command();
    registerGoalCommands(program.command('agent'), async (json, verb) => {
      f.deps.json = json;
      await verb(f.deps);
    });
    await program.parseAsync(['agent', 'goal', 'create', '--input', file, '--json'], { from: 'user' });
    expect(f.calls).toEqual([]);
    expect(f.out.join('')).not.toContain(privateText);
  });
  it('retains exact accepted r3 command and response discriminants', () => {
    expect(GoalCreateCommand.parse(create)).toEqual(create);
    expect(GoalTransitionCommand.parse(transition)).toEqual(transition);
    expect(GoalCommandResult.parse(closed)).toEqual(closed);
    expect(GoalCommandResult.parse(full)).toEqual(full);
  });
});
