/** Source contracts over controlled ports only. Actual SDK/native acceptance
 * requires the mandatory hosted team Driver; these DTOs grant no authority. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerWorkerIdentityAuthentication } from '../src/docker-worker-identity.js';
import type { MuxSession } from '../src/mux-interface.js';
import { installRecordedDockerViewer, recordedDockerViewerStat } from './helpers/recorded-docker-viewer.js';
import { planOfficeForceChildArgs } from './helpers/plan-office-force-child.js';
import {
  PlanOfficeViewerCommandInput,
  PlanOfficeViewerCommandReceipt,
  planOfficeViewerArgs,
  planOfficeViewerPrompt,
  runPlanOfficeViewerCommand,
  planOfficeViewerDigest,
  runPlanOfficeViewerRepair,
  planOfficeWebsiteClientOperation,
  type PlanOfficeWebsiteClient,
  parsePlanOfficeViewerProcess,
  type PlanOfficeWebsiteClientInput,
} from './helpers/plan-office-viewer-repair.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
const callerId = '11111111-1111-4111-8111-111111111111',
  callerSid = '22222222-2222-4222-8222-222222222222',
  targetId = '33333333-3333-4333-8333-333333333333',
  targetSid = '44444444-4444-4444-8444-444444444444';
function input(
  command: 'viewer-status' | 'reconnect-viewer' = 'viewer-status',
  expected: 'allowed' | 'denied' = 'allowed'
) {
  return PlanOfficeViewerCommandInput.parse({
    version: 1,
    purpose: 'reverie-ci-sdk-viewer-command-v1',
    id: randomUUID(),
    command,
    expected,
    callerEmployeeId: callerId,
    callerSessionId: callerSid,
    employeeId: targetId,
    sessionId: targetSid,
    sessionGeneration: 2,
  });
}
function credential() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-sdk-'));
  fs.chmodSync(root, 0o700);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = {
    employeeId: callerId,
    sessionId: callerSid,
    sessionGeneration: 1,
    owner: undefined,
    containerId: 'a'.repeat(64),
    credentialId: randomUUID(),
  };
  const auth = new DockerWorkerIdentityAuthentication(randomUUID(), Buffer.alloc(32, 78), {
    binding: () => binding,
    keyCurrent: () => true,
  });
  cleanups.push(() => auth.close());
  const file = path.join(root, 'identity');
  fs.writeFileSync(file, auth.issue(binding, () => true) + '\n', { mode: 0o600 });
  return {
    HOME: '/home/agent',
    REVERIE_SESSION_ID: callerSid,
    REVERIE_API_URL: 'http://synthetic.invalid:3000',
    REVERIE_WORKER_IDENTITY_FILE: file,
    REVERIE_MUX: '1',
  };
}
function child(args: readonly string[], identity: string) {
  return {
    childPid: process.pid + 1,
    parentPid: process.pid,
    childBirthTicks: '123',
    nodeStage: '/opt/reverie-worker-client/bin/node' as const,
    argsDigest: planOfficeViewerDigest(JSON.stringify(planOfficeForceChildArgs(args))),
    sessionId: callerSid,
    identityFileDigest: planOfficeViewerDigest(identity),
    childMuxAbsent: true as const,
    requiredEnvironmentMatched: true as const,
  };
}
it.each(['viewer-status', 'reconnect-viewer'] as const)(
  'uses only exact %s packaged child arguments, protected context and closed receipts',
  async (command) => {
    const value = input(command),
      env = credential(),
      records: Array<{ kind: string; value: unknown }> = [];
    const files = {
      viewerCommandRecord: vi.fn((kind, payload) => {
        records.push({ kind, value: payload });
      }),
    };
    const cli = vi.fn(async (args, _stdin, context, observed) => {
      expect(records.map((record) => record.kind)).toEqual(['issued']);
      expect(args).toEqual(['agent', command, targetId, '--json']);
      expect(context).toBe('sdk-without-mux');
      observed(child(args, env.REVERIE_WORKER_IDENTITY_FILE));
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          ...(command === 'reconnect-viewer' ? { state: 'viewer-connected' } : {}),
          reconnect: { state: 'connected', reason: 'connected', attempts: 0, retryAfterMs: 0 },
        }),
        stderr: '',
      };
    });
    const returned = await runPlanOfficeViewerCommand(value, callerId, files, cli, env);
    expect(records.map((record) => record.kind)).toEqual(['issued', 'returned']);
    expect(PlanOfficeViewerCommandReceipt.parse(returned).id).toBe(value.id);
    expect(JSON.stringify(records)).not.toContain(env.REVERIE_WORKER_IDENTITY_FILE);
    expect(env.REVERIE_MUX).toBe('1'); // helper never mutates the actual SDK environment
  }
);
it('records a revoked-grant CLI refusal without inventing an HTTP status or publishing hostile output', async () => {
  const value = input('viewer-status', 'denied'),
    env = credential(),
    record = vi.fn();
  const hostile = 'HOSTILE_CREDENTIAL_OUTPUT_DO_NOT_PUBLISH';
  const returned = await runPlanOfficeViewerCommand(
    value,
    callerId,
    { viewerCommandRecord: record },
    async (args, _stdin, _ctx, observed) => {
      observed(child(args, env.REVERIE_WORKER_IDENTITY_FILE));
      return { exitCode: 4, signal: null, stdout: hostile, stderr: hostile };
    },
    env
  );
  expect(returned.exitCode).toBe(4);
  expect(returned.reconnect).toBeNull();
  expect(JSON.stringify(record.mock.calls)).not.toContain(hostile);
  expect(returned).not.toHaveProperty('httpStatus');
});
it('an unexpectedly allowed post-revoke status cannot become a denial receipt', async () => {
  const env = credential(),
    value = input('viewer-status', 'denied'),
    record = vi.fn();
  await expect(
    runPlanOfficeViewerCommand(
      value,
      callerId,
      { viewerCommandRecord: record },
      async (args, _stdin, _ctx, observed) => {
        observed(child(args, env.REVERIE_WORKER_IDENTITY_FILE));
        return { exitCode: 0, signal: null, stdout: '{}', stderr: '' };
      },
      env
    )
  ).rejects.toThrow();
  expect(record.mock.calls.map((call) => call[0])).toEqual(['issued']);
});
it('refuses an absent worker context before publishing intent or invoking any child', async () => {
  const record = vi.fn(),
    cli = vi.fn();
  await expect(
    runPlanOfficeViewerCommand(input(), callerId, { viewerCommandRecord: record }, cli, {
      HOME: '/home/agent',
      REVERIE_SESSION_ID: callerSid,
      REVERIE_MUX: '1',
    })
  ).rejects.toThrow('protected credential');
  expect(record).not.toHaveBeenCalled();
  expect(cli).not.toHaveBeenCalled();
});
it('an exclusive issued-write refusal prevents even the child binding GET and never retries', async () => {
  const env = credential(),
    cli = vi.fn(),
    record = vi.fn(() => {
      throw Error('existing intent');
    });
  await expect(
    runPlanOfficeViewerCommand(input(), callerId, { viewerCommandRecord: record }, cli, env)
  ).rejects.toThrow('existing intent');
  expect(record).toHaveBeenCalledOnce();
  expect(cli).not.toHaveBeenCalled();
});
it.each([
  'unobservable',
  'wrong-parent',
  'wrong-session',
  'wrong-args',
  'wrong-credential',
  'unknown-reply',
  'hostile-projection',
])('does not publish a successful SDK receipt for %s', async (fault) => {
  const env = credential(),
    value = input('reconnect-viewer'),
    record = vi.fn();
  const cli = vi.fn(async (args, _stdin, _ctx, observed) => {
    const proof = child(args, env.REVERIE_WORKER_IDENTITY_FILE);
    if (fault === 'wrong-parent') proof.parentPid++;
    if (fault === 'wrong-session') proof.sessionId = targetSid;
    if (fault === 'wrong-args') proof.argsDigest = '0'.repeat(64);
    if (fault === 'wrong-credential') proof.identityFileDigest = '0'.repeat(64);
    if (fault !== 'unobservable') observed(proof);
    return {
      exitCode: fault === 'unknown-reply' ? null : 0,
      signal: null,
      stdout: JSON.stringify({
        state: 'viewer-connected',
        reconnect: { state: 'connected', reason: 'connected', attempts: 0, retryAfterMs: 0 },
        ...(fault === 'hostile-projection' ? { token: 'HOSTILE' } : {}),
      }),
      stderr: '',
    };
  });
  await expect(
    runPlanOfficeViewerCommand(value, callerId, { viewerCommandRecord: record }, cli, env)
  ).rejects.toThrow();
  expect(cli).toHaveBeenCalledOnce();
  expect(record.mock.calls.map((call) => call[0])).toEqual(['issued']);
});
it.each([
  { command: 'restart-employee' },
  { command: 'reconnect-viewer', expected: 'denied' },
  { employeeId: callerId },
  { sessionId: callerSid },
  { args: ['--force'] },
  { ownerCookie: 'HOSTILE' },
  { sessionGeneration: 0 },
])('closes SDK viewer requests before transport: %j', (change) => {
  expect(() => PlanOfficeViewerCommandInput.parse({ ...input(), ...change })).toThrow();
});
it('publishes only one canonical CR trigger and the fixed command vector', () => {
  const value = input();
  expect(planOfficeViewerArgs(value)).toEqual(['agent', 'viewer-status', targetId, '--json']);
  expect(planOfficeViewerPrompt(value.id)).toEqual({ input: 'BOXED_VIEWER_COMMAND_' + value.id + '\r', useMux: true });
  expect(() => planOfficeViewerPrompt(value.id + ';danger')).toThrow();
});

const prefix = '/nix/store/' + 'a'.repeat(32);
function website(): PlanOfficeWebsiteClient {
  return {
    sessionId: targetSid,
    muxName: 'reverie-' + targetSid.slice(0, 8),
    pid: 31,
    birth: '40',
    tty: '/dev/pts/2',
    ttyStamp: '3:4:5:1000:100:8592',
    parentBirth: '11',
    parentCommandDigest: '1'.repeat(64),
    serverPid: 21,
    serverBirth: '20',
    socketPath: '/tmp/tmux-1000/reverie',
    socketStamp: '1:2:0:1000:100:49536',
    outerPid: 22,
    outerBirth: '30',
    outerCommandDigest: '2'.repeat(64),
    outerForm: 'paid-launch',
    manifestDigest: '3'.repeat(64),
  };
}
function websiteInput(): PlanOfficeWebsiteClientInput {
  return {
    operation: 'detach',
    sessionId: targetSid,
    pid: 31,
    outerPid: 22,
    containerId: 'b'.repeat(64),
    operationId: randomUUID(),
    controlCommand: [
      prefix + '-node/bin/node',
      prefix + '-runtime/lib/reverie/dist/index.js',
      'web',
      '--host',
      '0.0.0.0',
      '--port',
      '3000',
    ],
    expected: website(),
  };
}
it('rechecks the complete original tuple with both readonly TTY descriptors held before one exact detach', () => {
  const events: string[] = [],
    close = [
      vi.fn(() => {
        events.push('close1');
      }),
      vi.fn(() => {
        events.push('close2');
      }),
    ];
  const open = vi.fn(() => {
    events.push('open');
    return { value: website(), close: close[open.mock.calls.length - 1]! };
  });
  const detach = vi.fn((tty) => {
    expect(tty).toBe('/dev/pts/2');
    expect(close.every((fn) => fn.mock.calls.length === 0)).toBe(true);
    events.push('detach');
  });
  expect(planOfficeWebsiteClientOperation(websiteInput(), { open, detach })).toEqual(website());
  expect(events).toEqual(['open', 'open', 'detach', 'close2', 'close1']);
  expect(detach).toHaveBeenCalledOnce();
});
it.each([
  'pid',
  'birth',
  'tty',
  'ttyStamp',
  'serverPid',
  'serverBirth',
  'socketPath',
  'socketStamp',
  'outerPid',
  'outerBirth',
  'outerCommandDigest',
  'manifestDigest',
] as const)('changed %s refuses before detaching any client and closes both observations once', (field) => {
  const first = website(),
    second = structuredClone(first);
  Reflect.set(
    second,
    field,
    typeof second[field] === 'number' ? Number(second[field]) + 1 : String(second[field]) + '9'
  );
  const close1 = vi.fn(),
    close2 = vi.fn(),
    detach = vi.fn();
  const open = vi
    .fn()
    .mockReturnValueOnce({ value: first, close: close1 })
    .mockReturnValueOnce({ value: second, close: close2 });
  expect(() => planOfficeWebsiteClientOperation(websiteInput(), { open, detach })).toThrow('unconfirmed');
  expect(detach).not.toHaveBeenCalled();
  expect(close1).toHaveBeenCalledOnce();
  expect(close2).toHaveBeenCalledOnce();
});
it('a detach response or consuming-close failure is unknown, without retry or success', () => {
  for (const where of ['detach', 'close']) {
    const close = vi.fn(() => {
      if (where === 'close') throw Error('close unknown');
    });
    const open = vi.fn(() => ({ value: website(), close }));
    const detach = vi.fn(() => {
      if (where === 'detach') throw Error('response lost');
    });
    expect(() => planOfficeWebsiteClientOperation(websiteInput(), { open, detach })).toThrow('never repeat');
    expect(detach).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
  }
});
it.each([undefined, null, false, 0, ''])('even a falsy thrown detach result stays unknown: %j', (cause) => {
  const close = vi.fn(),
    detach = vi.fn(() => {
      throw cause;
    });
  expect(() =>
    planOfficeWebsiteClientOperation(websiteInput(), { open: () => ({ value: website(), close }), detach })
  ).toThrow('never repeat');
  expect(detach).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(2);
});

function rawProcess() {
  const recorder = installRecordedDockerViewer();
  const row: MuxSession = {
    sessionId: targetSid,
    muxName: 'reverie-' + targetSid.slice(0, 8),
    pid: 72,
    createdAt: 1,
    workingDir: '/workspace',
    mode: 'claude',
    attached: true,
  };
  recorder.seed(
    row,
    {
      argv: [
        '/bin/docker',
        '--host',
        'unix:///run/reverie-engine/docker.sock',
        'exec',
        '-it',
        '--workdir',
        '/workspace',
      ],
      shellCommand: 'fixed fixture command',
    },
    71
  );
  return recorder.data(72);
}
it('the hosted observer parser independently pins the actual post-wrapper Docker leaf argv0 and process incarnation', () => {
  const raw = rawProcess(),
    observed = parsePlanOfficeViewerProcess(raw, 72, '/bin/docker');
  expect(observed.args[0]).toBe(raw.executables['/bin/docker'].argv0);
  expect(observed.args[0]).not.toBe('/bin/docker');
  expect(observed.birth).toBeTruthy();
  expect(observed.parent).toBe(71);
});
it.each([
  'birth',
  'uid',
  'namespace',
  'self',
  'exe',
  'exe-inode',
  'manifest-owner',
  'manifest-write',
  'entry-write',
  'leaf-write',
  'argv0',
])('the actual hosted process parser refuses mismatched %s before any detach is possible', (fault) => {
  const raw = rawProcess();
  if (fault === 'birth') raw.statAfter = recordedDockerViewerStat(72, 71, '99999');
  if (fault === 'uid') raw.statusAfter = 'Uid:\t99999\t99999\t99999\t99999\n';
  if (fault === 'namespace') raw.namespaceAfter = 'pid:[99999]';
  if (fault === 'self') raw.selfStat = recordedDockerViewerStat(process.pid + 1, 1, '111');
  if (fault === 'exe') raw.exe += '-foreign';
  if (fault === 'exe-inode') raw.exeStat.ino = '99999';
  if (fault === 'manifest-owner') raw.manifest.stat.uid = process.getuid!();
  if (fault === 'manifest-write') raw.manifest.stat.mode |= 0o200;
  if (fault === 'entry-write') raw.executables['/bin/docker'].entry.stat.mode |= 0o200;
  if (fault === 'leaf-write') raw.executables['/bin/docker'].stat.mode |= 0o200;
  if (fault === 'argv0')
    raw.cmdline = Buffer.from(
      ['/bin/docker', ...raw.cmdline.toString('utf8').slice(0, -1).split('\0').slice(1)].join('\0') + '\0'
    );
  expect(() => parsePlanOfficeViewerProcess(raw, 72, '/bin/docker')).toThrow();
});

function receipt(
  command: 'viewer-status' | 'reconnect-viewer',
  expected: 'allowed' | 'denied',
  id: string,
  connected: boolean
) {
  const value = { ...input(command, expected), id };
  return PlanOfficeViewerCommandReceipt.parse({
    ...value,
    purpose: 'reverie-ci-sdk-viewer-command-returned-v1',
    namespacePid: process.pid,
    child: child(planOfficeViewerArgs(value), '/synthetic/identity'),
    exitCode: expected === 'allowed' ? 0 : 4,
    reconnect:
      expected === 'denied'
        ? null
        : {
            state: connected ? 'connected' : 'blocked',
            reason: connected ? 'connected' : 'not-attempted',
            attempts: 0,
            retryAfterMs: 0,
          },
    stdoutSha256: 'a'.repeat(64),
    stderrSha256: 'b'.repeat(64),
  });
}
it('requires the actual one-detach/status/repair/status/revoke/refusal sequence and post-revoke equality before completion', async () => {
  const events: string[] = [],
    ids: string[] = [];
  let snapshots = 0,
    connected = false;
  const value = await runPlanOfficeViewerRepair({
    current: () => {},
    grant: async (enabled) => {
      events.push('grant:' + enabled);
    },
    draft: async () => {
      events.push('draft');
    },
    snapshot: async () => ++snapshots,
    detach: async () => {
      events.push('detach');
    },
    command: async (cmd, expected, id) => {
      ids.push(id);
      events.push(cmd + ':' + expected);
      if (cmd === 'reconnect-viewer') connected = true;
      return receipt(cmd, expected, id, connected);
    },
    verify: (a, b, state) => {
      events.push('verify:' + state);
      expect(b).toBe(Number(a) + 1);
    },
    record: (name) => {
      events.push(name.endsWith('-completed') ? 'completed' : 'intent');
    },
  });
  expect(events).toEqual([
    'grant:true',
    'draft',
    'intent',
    'detach',
    'viewer-status:allowed',
    'reconnect-viewer:allowed',
    'viewer-status:allowed',
    'verify:replaced',
    'grant:false',
    'viewer-status:denied',
    'verify:same',
    'completed',
  ]);
  expect(new Set(ids).size).toBe(4);
  expect(ids).not.toContain(value.id);
});
it.each(['detach', 'repair', 'verify', 'revoke-verification'] as const)(
  'unknown %s never relaunches or claims completion',
  async (fault) => {
    const events: string[] = [];
    let connected = false,
      verifies = 0;
    const command = vi.fn(async (cmd, expected, id) => {
      if (fault === 'repair' && cmd === 'reconnect-viewer') throw Error('unknown repair');
      if (cmd === 'reconnect-viewer') connected = true;
      return receipt(cmd, expected, id, connected);
    });
    await expect(
      runPlanOfficeViewerRepair({
        current: () => {},
        grant: async () => {},
        draft: async () => {},
        snapshot: async () => ({}),
        detach: async () => {
          events.push('detach');
          if (fault === 'detach') throw Error('unknown detach');
        },
        command,
        verify: () => {
          if (++verifies === (fault === 'verify' ? 1 : fault === 'revoke-verification' ? 2 : -1))
            throw Error('unknown proof');
        },
        record: (name) => {
          if (name.endsWith('-completed')) events.push('completed');
        },
      })
    ).rejects.toThrow('unknown');
    expect(events).not.toContain('completed');
    expect(events.filter((event) => event === 'detach')).toHaveLength(1);
    expect(command.mock.calls.filter((call) => call[0] === 'reconnect-viewer').length).toBeLessThanOrEqual(1);
  }
);
