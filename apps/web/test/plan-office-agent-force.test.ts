/** Source-only SDK protocol tests; no native client, Docker or provider is started. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { PlanProviderFixtureFiles } from './helpers/boxed-plan-provider-files.js';
import {
  PlanOfficeAgentForceInput,
  preparePlanOfficeAgentForce,
  executePlanOfficeAgentForce,
  planOfficeForceEnvironment,
  planOfficeForceHandoff,
  planOfficeForceHandoffFile,
  planOfficeForceDigest,
} from './helpers/plan-office-agent-force.js';
import {
  parsePlanOfficeForceChild,
  planOfficeForceChildArgs,
  type PlanOfficeForceChild,
} from './helpers/plan-office-force-child.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-force-'));
  roots.push(home);
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, '.fixture'), 0o700);
  const input = PlanOfficeAgentForceInput.parse({
    version: 1,
    purpose: 'reverie-ci-sdk-agent-force-v1',
    id: '11111111-1111-4111-8111-111111111111',
    employeeId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    sessionGeneration: 2,
    fromAccount: 'ci-plan-b',
    toAccount: 'ci-plan-a',
  });
  const identity = path.join(home, 'identity');
  fs.writeFileSync(identity, 'c3ludGhldGlj.' + 'a'.repeat(64) + '\n', { mode: 0o600 });
  const env = {
    HOME: '/home/agent',
    REVERIE_MUX: '1',
    REVERIE_SESSION_ID: input.sessionId,
    REVERIE_API_URL: 'http://127.0.0.1:1',
    REVERIE_WORKER_IDENTITY_FILE: identity,
    REVERIE_PASSWORD: 'HOSTILE_HUMAN_VALUE',
    CUSTOM_SDK_VALUE: 'preserve-me',
  };
  const files = new PlanProviderFixtureFiles(home, undefined);
  let moveOwnPlan = true;
  const cli = vi.fn(
    async (
      args: readonly string[],
      _stdin?: string,
      context?: 'sdk-without-mux',
      observed?: (child: PlanOfficeForceChild) => void
    ) => {
      expect(context).toBe('sdk-without-mux');
      if (args[0] === 'agent' && args[1] === 'capabilities')
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            checkedAt: Date.now(),
            identity: { kind: 'agent', employeeId: input.employeeId, sessionId: input.sessionId },
            company: { moveOwnPlan, managePlans: false },
          }),
        };
      const issued = JSON.parse(
        fs.readFileSync(path.join(home, '.fixture', 'plan-agent-force-issued-' + input.id + '.json'), 'utf8')
      );
      expect(issued.kind).toBe('issued');
      expect(files.readForceHandoff(input.id)).toBe(planOfficeForceHandoff(input));
      observed?.({
        childPid: process.pid + 1,
        parentPid: process.pid,
        childBirthTicks: '1234',
        nodeStage: '/opt/reverie-worker-client/bin/node',
        argsDigest: planOfficeForceDigest(JSON.stringify(planOfficeForceChildArgs(args))),
        sessionId: input.sessionId,
        identityFileDigest: planOfficeForceDigest(env.REVERIE_WORKER_IDENTITY_FILE),
        childMuxAbsent: true,
        requiredEnvironmentMatched: true,
      });
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          id: input.id,
          employeeId: input.employeeId,
          oldSession: input.sessionId,
          fromAccount: input.fromAccount,
          toAccount: input.toAccount,
          phase: 'waiting',
        }),
      };
    }
  );
  return {
    home,
    input,
    files,
    env,
    cli,
    revoke: () => {
      moveOwnPlan = false;
    },
  };
}
it('clones actual SDK context and removes only the legacy mux flag without replacing identity or other environment', () => {
  const f = fixture(),
    child = planOfficeForceEnvironment(f.env),
    expected: NodeJS.ProcessEnv = { ...f.env };
  delete expected.REVERIE_MUX;
  expect(child).toEqual(expected);
  expect(child).not.toBe(f.env);
  expect(f.env.REVERIE_MUX).toBe('1');
  expect(child.REVERIE_WORKER_IDENTITY_FILE).toBe(f.env.REVERIE_WORKER_IDENTITY_FILE);
});
it('closes unique owned handoff/prepared and issued receipts before the sole fixed packaged force argv', async () => {
  const f = fixture();
  const prepared = await preparePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env);
  expect(prepared).toMatchObject({
    namespacePid: process.pid,
    sessionGeneration: 2,
    inheritedMuxPresent: true,
    childMuxAbsent: true,
    moveOwnPlan: true,
    managePlans: false,
  });
  expect(prepared.nativeBirthTicks).toMatch(/^[1-9][0-9]*$/);
  await executePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env);
  expect(f.cli.mock.calls.map(([args]) => args)).toEqual([
    ['agent', 'capabilities', '--json'],
    ['agent', 'capabilities', '--json'],
    [
      'agent',
      'plan-move',
      'force',
      'ci-plan-a',
      '--employee',
      f.input.employeeId,
      '--id',
      f.input.id,
      '--handoff-file',
      planOfficeForceHandoffFile(f.input.id),
      '--json',
    ],
  ]);
  const stat = fs.lstatSync(path.join(f.home, '.fixture', 'plan-force-handoff-' + f.input.id + '.txt'));
  expect(stat.mode & 0o777).toBe(0o600);
  expect(stat.nlink).toBe(1);
  expect(stat.uid).toBe(process.getuid!());
  const records = fs
    .readdirSync(path.join(f.home, '.fixture'))
    .filter((n) => n.endsWith('.json'))
    .map((n) => fs.readFileSync(path.join(f.home, '.fixture', n), 'utf8'))
    .join('');
  expect(records).not.toContain('HOSTILE_HUMAN_VALUE');
  expect(records).not.toContain('c3ludGhldGlj.');
  const before = f.cli.mock.calls.length;
  await expect(executePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env)).rejects.toThrow();
  expect(f.cli.mock.calls.slice(before).some(([args]) => args[2] === 'force')).toBe(false);
  await expect(preparePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env)).rejects.toThrow();
});
it('retains an issued unknown CLI outcome and refuses another business invocation or synthesized completion', async () => {
  const f = fixture();
  await preparePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env);
  const normal = f.cli.getMockImplementation()!;
  f.cli.mockImplementation(async (args, input, context, observed) => {
    if (args[2] === 'force') {
      await normal(args, input, context, observed);
      throw Error('HOSTILE_TRANSPORT');
    }
    return normal(args, input, context, observed);
  });
  await expect(executePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env)).rejects.toThrow();
  await expect(executePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env)).rejects.toThrow();
  expect(f.cli.mock.calls.filter(([args]) => args[2] === 'force')).toHaveLength(1);
  expect(fs.existsSync(path.join(f.home, '.fixture', 'plan-agent-force-returned-' + f.input.id + '.json'))).toBe(false);
});
it('denies changed grants, scope, protected identity and handoff before force dispatch', async () => {
  for (const change of ['grant', 'session', 'identity', 'handoff', 'symlink', 'prepared-pid'] as const) {
    const f = fixture();
    await preparePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env);
    if (change === 'grant') f.revoke();
    if (change === 'session') f.env.REVERIE_SESSION_ID = '44444444-4444-4444-8444-444444444444';
    if (change === 'identity') fs.writeFileSync(f.env.REVERIE_WORKER_IDENTITY_FILE, '{}');
    const handoff = path.join(f.home, '.fixture', 'plan-force-handoff-' + f.input.id + '.txt');
    if (change === 'handoff') fs.writeFileSync(handoff, 'changed');
    if (change === 'symlink') {
      fs.renameSync(handoff, handoff + '.old');
      fs.symlinkSync(handoff + '.old', handoff);
    }
    if (change === 'prepared-pid') {
      const file = path.join(f.home, '.fixture', 'plan-agent-force-prepared-' + f.input.id + '.json'),
        receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...receipt, namespacePid: receipt.namespacePid + 1 }));
    }
    await expect(executePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env)).rejects.toThrow();
    expect(f.cli.mock.calls.some(([args]) => args[2] === 'force')).toBe(false);
  }
  const f = fixture();
  for (const change of [
    { employeeId: 'bad' },
    { fromAccount: 'ci-plan-a' },
    { path: '/api/plans/moves/force' },
    { handoffFile: '/arbitrary' },
  ])
    expect(() => PlanOfficeAgentForceInput.parse({ ...f.input, ...change })).toThrow();
});
it('never dispatches after missing protected identity, changed SDK context during capabilities or an uncertain issued close', async () => {
  const missing = fixture();
  await expect(
    preparePlanOfficeAgentForce(missing.input, missing.input.employeeId, missing.files, missing.cli, {
      ...missing.env,
      REVERIE_WORKER_IDENTITY_FILE: undefined,
    })
  ).rejects.toThrow('identity');
  expect(missing.cli).not.toHaveBeenCalled();
  const changed = fixture(),
    normal = changed.cli.getMockImplementation()!;
  changed.cli.mockImplementation(async (args, input, context, observed) => {
    const reply = await normal(args, input, context, observed);
    changed.env.REVERIE_SESSION_ID = '44444444-4444-4444-8444-444444444444';
    return reply;
  });
  await expect(
    preparePlanOfficeAgentForce(changed.input, changed.input.employeeId, changed.files, changed.cli, changed.env)
  ).rejects.toThrow();
  expect(
    fs.existsSync(path.join(changed.home, '.fixture', 'plan-agent-force-prepared-' + changed.input.id + '.json'))
  ).toBe(false);
  const closed = fixture();
  await preparePlanOfficeAgentForce(closed.input, closed.input.employeeId, closed.files, closed.cli, closed.env);
  const record = closed.files.forceRecord.bind(closed.files);
  vi.spyOn(closed.files, 'forceRecord').mockImplementation((kind, receipt) => {
    record(kind, receipt);
    if (kind === 'issued') throw Error('Consuming close unconfirmed');
  });
  await expect(
    executePlanOfficeAgentForce(closed.input, closed.input.employeeId, closed.files, closed.cli, closed.env)
  ).rejects.toThrow('close');
  expect(closed.cli.mock.calls.some(([args]) => args[2] === 'force')).toBe(false);
});
it('requires the actual packaged Node stage and stable child PID/SDK parent/birth with unique matching sanitized environment', () => {
  const f = fixture(),
    pid = 43,
    parent = 42;
  const args = [
    'agent',
    'plan-move',
    'force',
    'ci-plan-a',
    '--employee',
    f.input.employeeId,
    '--id',
    f.input.id,
    '--handoff-file',
    planOfficeForceHandoffFile(f.input.id),
    '--json',
  ];
  const stat = (owner = parent, birth = '1234', state = 'S') => {
    const fields = Array<string>(22).fill('0');
    fields[0] = state;
    fields[1] = String(owner);
    fields[19] = birth;
    return `${pid} (node child) ${fields.join(' ')}`;
  };
  const entries = [
    'HOME=/home/agent',
    'REVERIE_API_URL=' + f.env.REVERIE_API_URL,
    'REVERIE_SESSION_ID=' + f.input.sessionId,
    'REVERIE_WORKER_IDENTITY_FILE=' + f.env.REVERIE_WORKER_IDENTITY_FILE,
    'PATH=/bin:/usr/bin',
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
  ];
  const bytes = (values: string[]) => Buffer.from(values.join('\0') + '\0');
  const value = {
    pid,
    parent,
    before: stat(),
    after: stat(),
    exeBefore: '/opt/reverie-worker-client/bin/node',
    exeAfter: '/opt/reverie-worker-client/bin/node',
    command: bytes(planOfficeForceChildArgs(args)),
    environment: bytes(entries),
    commandAfter: bytes(planOfficeForceChildArgs(args)),
    environmentAfter: bytes(entries),
  };
  const observed = parsePlanOfficeForceChild(value, args, f.env, '1234');
  expect(observed).toMatchObject({
    childPid: pid,
    parentPid: parent,
    childBirthTicks: '1234',
    childMuxAbsent: true,
    requiredEnvironmentMatched: true,
    sessionId: f.input.sessionId,
  });
  expect(JSON.stringify(observed)).not.toContain(f.env.REVERIE_WORKER_IDENTITY_FILE);
  expect(JSON.stringify(observed)).not.toContain(f.env.REVERIE_API_URL);
  for (const change of [
    { after: stat(parent, '1235') },
    { before: stat(44) },
    { after: stat(parent, '1234', 'Z') },
    { environment: bytes([...entries, 'REVERIE_MUX=1']) },
    { environment: bytes([...entries, 'REVERIE_MUX=']) },
    { environment: bytes([...entries, 'REVERIE_SESSION_ID=' + f.input.sessionId]) },
    { environment: bytes([...entries, 'REVERIE_PASSWORD=HOSTILE']) },
    { environment: bytes(entries.filter((entry) => !entry.startsWith('HOME='))) },
    {
      environment: bytes(
        entries.map((entry) =>
          entry.startsWith('REVERIE_WORKER_IDENTITY_FILE=') ? 'REVERIE_WORKER_IDENTITY_FILE=/other/identity' : entry
        )
      ),
    },
    { environment: Buffer.alloc(65537, 65) },
    { commandAfter: bytes(['/changed/argv']) },
    { environmentAfter: bytes([...entries, 'REVERIE_MUX=1']) },
  ]) {
    const sample = { ...value, ...change };
    if ('environment' in change && change.environment) sample.environmentAfter = change.environment;
    expect(() => parsePlanOfficeForceChild(sample, args, f.env, '1234')).toThrow();
  }
  expect(
    parsePlanOfficeForceChild({ ...value, exeBefore: '/opt/reverie-worker-client/bin/reverie' }, args, f.env)
  ).toBeUndefined();
  expect(
    parsePlanOfficeForceChild(
      { ...value, command: bytes(['/opt/reverie-worker-client/bin/node', '/synthetic/sdk']) },
      args,
      f.env
    )
  ).toBeUndefined();
});
it('does not turn readable child proof bytes into a checked-close witness after an actual consuming-close error', async () => {
  const f = fixture();
  await preparePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env);
  const original = fs.closeSync;
  let injected = false;
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    const target = fs.readlinkSync('/proc/self/fd/' + fd);
    original(fd);
    if (!injected && target.endsWith('/plan-agent-force-spawned-' + f.input.id + '.json')) {
      injected = true;
      throw Object.assign(Error('Actual close unconfirmed'), { code: 'EIO' });
    }
  });
  await expect(executePlanOfficeAgentForce(f.input, f.input.employeeId, f.files, f.cli, f.env)).rejects.toThrow(
    'close'
  );
  expect(injected).toBe(true);
  expect(fs.existsSync(path.join(f.home, '.fixture', 'plan-agent-force-spawned-' + f.input.id + '.json'))).toBe(true);
  expect(fs.existsSync(path.join(f.home, '.fixture', 'plan-agent-force-child-closed-' + f.input.id + '.json'))).toBe(
    false
  );
  expect(fs.existsSync(path.join(f.home, '.fixture', 'plan-agent-force-returned-' + f.input.id + '.json'))).toBe(false);
});
