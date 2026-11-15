/** Closed hosted orchestration contracts only; these tests never call Docker or build images. */
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  PLAN_OFFICE_STARTUP_PREFIX,
  PLAN_OFFICE_STARTUP_STAGES,
  planOfficeStartupDiagnostic,
  readPlanOfficeStartupDiagnostic,
  projectPlanOfficeStartupDiagnostic,
} from './helpers/plan-office-startup-diagnostic.js';
import {
  requireHostedPlanOffice,
  planOfficeCiNamespace,
  planOfficeCiImage,
  planOfficeCiContract,
  requirePlanOfficeCiAcceptance,
  planOfficeCiFailureDiagnostic,
  readPlanOfficeCiFailureState,
  requirePlanOfficeCiTeamAcceptance,
} from '../scripts/plan-office-ci.mjs';
const instance = 'a'.repeat(32),
  namespace = planOfficeCiNamespace(instance);
const sha = 'sha256:' + 'b'.repeat(64),
  employeeId = '11111111-1111-4111-8111-111111111111';
const env = { GITHUB_ACTIONS: 'true', REVERIE_CI_RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/private/runner' };
const metadata = {
  version: 1,
  purpose: 'reverie-ci-plan-office-inputs-v1',
  imageNamespace: namespace,
  sourcePath: '/nix/store/' + 'c'.repeat(32) + '-source',
  runtimePath: '/nix/store/' + 'd'.repeat(32) + '-runtime',
  platformClosure: '/nix/store/' + 'e'.repeat(32) + '-closure',
  clientManifestDigest: 'f'.repeat(64),
};
it('projects only complete correlated startup stages/classes/codes and never hostile error content', () => {
  const token = 'HOSTILE_AUTH_TOKEN_DO_NOT_PUBLISH';
  const error = Object.assign(new Error(token), {
    code: 'ERR_ASSERTION',
    details: token,
    path: token,
    env: { TOKEN: token },
  });
  error.name = 'AssertionError';
  const value = planOfficeStartupDiagnostic('driver-image-helper', instance, error);
  const frame = PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(value) + '\n';
  expect(readPlanOfficeStartupDiagnostic(frame, instance)).toEqual(value);
  const publicReport = planOfficeCiFailureDiagnostic({ status: 1, signal: null, startup: value }, [], instance);
  expect(publicReport).toMatchObject({
    observation: 'last-known-entered-stage',
    startup: { stage: 'driver-image-helper', errorClass: 'AssertionError', errorCode: 'ERR_ASSERTION' },
  });
  expect(JSON.stringify(publicReport)).not.toContain(token);
  expect(readPlanOfficeStartupDiagnostic(token + '\n' + frame, instance)).toEqual(value);
  expect(
    planOfficeStartupDiagnostic('entry-driver-import', instance, { name: token, code: token, message: token })
  ).toMatchObject({ errorClass: 'unknown', errorCode: null });
  for (const role of ['source', 'worker', 'helper', 'control'] as const)
    expect(PLAN_OFFICE_STARTUP_STAGES).toContain('driver-image-' + role);
  for (const stdout of [
    frame + frame,
    frame.slice(0, -1),
    frame.slice(0, -20),
    'x'.repeat(65536) + frame,
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, message: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, stage: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, errorClass: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, errorCode: token }) + '\n',
    PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify(value).replace('"version":1', '"version":1,"version":1') + '\n',
  ])
    expect(readPlanOfficeStartupDiagnostic(stdout, instance)).toBeUndefined();
  expect(readPlanOfficeStartupDiagnostic(frame, 'b'.repeat(32))).toBeUndefined();
  expect(
    readPlanOfficeStartupDiagnostic(
      frame + PLAN_OFFICE_STARTUP_PREFIX + JSON.stringify({ ...value, instance: 'b'.repeat(32) }) + '\n',
      instance
    )
  ).toBeUndefined();
  expect(projectPlanOfficeStartupDiagnostic({ ...value, instance: 'b'.repeat(32) }, instance)).toBeUndefined();
  expect(
    planOfficeCiFailureDiagnostic({ startup: { ...value, instance: 'b'.repeat(32) } }, [], instance).observation
  ).toBe('unavailable');
  const hostile = {
    get name() {
      throw Error(token);
    },
    get code() {
      throw Error(token);
    },
    get message() {
      throw Error(token);
    },
    get stack() {
      throw Error(token);
    },
  };
  expect(planOfficeStartupDiagnostic('entry-driver-import', instance, hostile)).toMatchObject({
    errorClass: 'unknown',
    errorCode: null,
  });
  expect(
    projectPlanOfficeStartupDiagnostic(
      {
        get stage() {
          throw Error(token);
        },
      },
      instance
    )
  ).toBeUndefined();
  let reads = 0;
  const changing = {
    ...value,
    get stage() {
      return ++reads < 3 ? value.stage : token;
    },
  };
  expect(projectPlanOfficeStartupDiagnostic(changing, instance)).toEqual(value);
  expect(reads).toBe(1);
});
it('requires the explicit hosted-only command before any filesystem, build or Engine effect', () => {
  expect(() => requireHostedPlanOffice(['--ci'], env, 'linux', 'x64')).not.toThrow();
  expect(requireHostedPlanOffice(['--ci'], env, 'linux', 'x64')).toBe('ordinary-self');
  expect(requireHostedPlanOffice(['--ci', '--scenario', 'self-roundtrip'], env, 'linux', 'x64')).toBe('self-roundtrip');
  expect(requireHostedPlanOffice(['--ci', '--scenario', 'self-owner-force'], env, 'linux', 'x64')).toBe(
    'self-owner-force'
  );
  expect(() => requireHostedPlanOffice(['--ci', '--scenario', 'force'], env, 'linux', 'x64')).toThrow();
  for (const args of [[], ['--ci', '--force'], ['--contract', '/private/office']])
    expect(() => requireHostedPlanOffice(args, env, 'linux', 'x64')).toThrow();
  for (const change of [
    { GITHUB_ACTIONS: 'false' },
    { REVERIE_CI_RUNNER_ENVIRONMENT: 'self-hosted' },
    { REVERIE_CI_RUNNER_ENVIRONMENT: undefined },
    { RUNNER_TEMP: 'relative' },
  ])
    expect(() => requireHostedPlanOffice(['--ci'], { ...env, ...change }, 'linux', 'x64')).toThrow();
  expect(() => requireHostedPlanOffice(['--ci'], env, 'darwin', 'x64')).toThrow();
  expect(() => requireHostedPlanOffice(['--ci'], env, 'linux', 'arm64')).toThrow();
});
it('offers only closed dispatch choices and passes them as quoted data while PR/main stays ordinary-self', () => {
  const repositoryWorkflow = path.resolve('../../.github/workflows/image.yml');
  const workflowFile = fs.existsSync(repositoryWorkflow)
    ? repositoryWorkflow
    : path.resolve('test/fixtures/control-coverage/image.yml');
  const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
  const workflow = yaml.load(fs.readFileSync(workflowFile, 'utf8')) as {
    on: {
      workflow_dispatch: { inputs: { plan_office_scenario: { type: string; default: string; options: string[] } } };
    };
    jobs: { image: { steps: Array<{ run?: string; env?: Record<string, string> }> } };
  };
  const input = workflow.on.workflow_dispatch.inputs.plan_office_scenario;
  expect(input.type).toBe('choice');
  expect(input.default).toBe('ordinary-self');
  expect(input.options).toEqual([
    'ordinary-self',
    'self-roundtrip',
    'self-owner-force',
    'self-agent-force',
    'team-plan-move',
  ]);
  for (const choice of input.options)
    expect(requireHostedPlanOffice(['--ci', '--scenario', choice], env, 'linux', 'x64')).toBe(choice);
  const office = workflow.jobs.image.steps.find((step) => step.run?.includes('scripts/plan-office-ci.mts'))!;
  expect(office.env?.PLAN_OFFICE_SCENARIO).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs.plan_office_scenario || 'ordinary-self' }}"
  );
  expect(office.run).toContain('--ci --scenario "$PLAN_OFFICE_SCENARIO"');
  expect(office.run).not.toContain('${{');
  for (const hostile of [
    '$(touch /tmp/forbidden)',
    'ordinary-self; echo leaked',
    'self-owner-force\n--force',
    '--help',
  ])
    expect(() => requireHostedPlanOffice(['--ci', '--scenario', hostile], env, 'linux', 'x64')).toThrow();
});
it('publishes useful closed child/operation diagnostics without hostile tokens, freeform errors or objects', () => {
  const token = 'HOSTILE_TOKEN_DO_NOT_PUBLISH_abcdefghijklmnopqrstuv';
  const id = '22222222-2222-4222-8222-222222222222';
  const report = planOfficeCiFailureDiagnostic(
    {
      status: 1,
      signal: null,
      errorName: 'TimeoutError',
      stdout: token,
      stderr: token,
      message: token,
      stack: token,
      env: { TOKEN: token },
    },
    [
      {
        kind: 'request-status',
        id,
        employeeId,
        phase: 'executing',
        movePhase: 'checking',
        httpStatus: 200,
        errorCode: 'CONFLICT',
        error: token,
        token,
        nonceHash: token,
        owner: token,
        handoff: token,
      },
      { kind: 'owner-refusal', httpStatus: 403, errorCode: 'FORBIDDEN', message: token },
      { kind: 'request-status', id: token, phase: token, errorCode: token, sessionId: token },
      { kind: { toString: () => 'request-status', token }, id },
    ]
  );
  expect(report.child).toEqual({ status: 1, signal: null, errorName: 'TimeoutError' });
  expect(report.operations).toEqual([
    {
      kind: 'request-status',
      id,
      employeeId,
      phase: 'executing',
      movePhase: 'checking',
      httpStatus: 200,
      errorCode: 'CONFLICT',
    },
    { kind: 'owner-refusal', httpStatus: 403, errorCode: 'FORBIDDEN' },
  ]);
  expect(JSON.stringify(report)).not.toContain(token);
  expect(
    planOfficeCiFailureDiagnostic({ status: token, signal: { toString: () => 'SIGTERM', token }, errorName: token }, [])
      .child
  ).toEqual({});
  expect(planOfficeCiFailureDiagnostic({ status: null, signal: 'SIGKILL', errorName: 'Error' }, []).child).toEqual({
    status: null,
    signal: 'SIGKILL',
    errorName: 'Error',
  });
});
it('projects only bounded owned observations/canonical phases and preserves an absent original status before failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-office-ci-diagnostic-'));
  const token = 'PRIVATE_FAKE_PASSWORD_AND_HMAC_DO_NOT_PUBLISH';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const requestId = '33333333-3333-4333-8333-333333333333';
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(data), { mode: 0o600 });
  try {
    fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
    write('original-3-' + employeeId + '.json', {
      operationId,
      phase: 'completed',
      operation: {
        operationId,
        employeeId,
        phase: 'identity-issued',
        state: 'held',
        code: 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED',
        error: token,
      },
      error: token,
    });
    write('status-' + requestId + '-absent-5.json', {
      id: requestId,
      originalOutcome: 'unknown',
      noRetry: true,
      token,
    });
    write('data/company.json', {
      dockerEmployeeContinuations: [
        { employeeId, phase: 'identity-issued', request: { operationId, sessionId }, credential: token, owner: token },
      ],
    });
    write('data/plan-requests.json', [
      { id: requestId, employeeId, sessionId, phase: 'executing', movePhase: 'checking', error: token },
    ]);
    write('owner-api-refused.json', { status: 409, response: { errorCode: 'CONFLICT', error: token } });
    write('request-' + requestId + '-intent.json', { credential: token, phase: 'completed' });
    write('owner-session.json', { cookie: token, id: requestId, employeeId, phase: 'completed' });
    fs.symlinkSync(path.join(root, 'owner-session.json'), path.join(root, 'status-' + requestId + '-9.json'));
    write('data/plan-moves.json', [{ id: requestId, employeeId: sessionId, phase: 'completed', error: token }]);
    const projected = planOfficeCiFailureDiagnostic(
      { status: 1, signal: null },
      readPlanOfficeCiFailureState(root, employeeId)
    );
    expect(projected.operations).toContainEqual({
      kind: 'recovery-status',
      id: operationId,
      employeeId,
      phase: 'identity-issued',
      state: 'held',
      errorCode: 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED',
    });
    expect(projected.operations).toContainEqual({
      kind: 'request-status',
      id: requestId,
      employeeId,
      state: 'unknown',
      httpStatus: 404,
    });
    expect(projected.operations).toContainEqual({
      kind: 'canonical-request',
      id: requestId,
      employeeId,
      sessionId,
      phase: 'executing',
      movePhase: 'checking',
    });
    expect(JSON.stringify(projected)).not.toContain(token);
    expect(projected.operations.some((record) => record.phase === 'completed')).toBe(false);
    expect(readPlanOfficeCiFailureState(root, 'foreign-secret')).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
it('rejects present foreign scope in original/status receipts rather than relabeling it with the owned filename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-office-ci-diagnostic-scope-'));
  const foreign = '22222222-2222-4222-8222-222222222222';
  const foreignOperation = '33333333-3333-4333-8333-333333333333';
  const ownRequest = '44444444-4444-4444-8444-444444444444';
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  try {
    write('original-1-' + employeeId + '.json', {
      employeeId: foreign,
      operationId: foreignOperation,
      operation: { phase: 'failed', state: 'held', code: 'CONFLICT' },
    });
    write('status-' + foreignOperation + '-1.json', { employeeId: foreign, id: foreignOperation, phase: 'failed' });
    write('original-2-' + employeeId + '.json', {
      employeeId,
      operationId: foreignOperation,
      operation: { employeeId: foreign, phase: 'failed', state: 'held' },
    });
    write('status-' + ownRequest + '-1.json', { employeeId, id: ownRequest, phase: 'executing' });
    const report = planOfficeCiFailureDiagnostic(
      { status: 1, signal: null },
      readPlanOfficeCiFailureState(root, employeeId)
    );
    expect(report.observation).toBe('last-known-retained-data');
    expect(report.operations).toEqual([{ kind: 'request-status', id: ownRequest, employeeId, phase: 'executing' }]);
    expect(JSON.stringify(report)).not.toContain(foreignOperation);
    expect(JSON.stringify(report)).not.toContain(foreign);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
it('selects only fresh namespaced actual Engine IDs and fixed immutable current-source inputs', () => {
  for (const invalid of ['production', '', '../office', 'A'.repeat(32), 'a'.repeat(31)])
    expect(() => planOfficeCiNamespace(invalid)).toThrow();
  const image = { Id: sha, Os: 'linux', Architecture: 'amd64', RepoTags: [namespace + '-source:latest'] };
  expect(planOfficeCiImage(image, namespace, 'source')).toBe(sha);
  for (const change of [
    { Id: 'source:latest' },
    { Architecture: 'arm64' },
    { Os: 'windows' },
    { RepoTags: ['production:latest'] },
    { RepoTags: [...image.RepoTags, 'production:latest'] },
  ])
    expect(() => planOfficeCiImage({ ...image, ...change }, namespace, 'source')).toThrow();
  const ids = { source: sha, worker: sha, helper: sha, control: sha };
  const c = planOfficeCiContract(metadata, instance, ids);
  expect(c.acceptance).toBe('ordinary-self');
  expect(planOfficeCiContract(metadata, instance, ids, 'self-roundtrip').acceptance).toBe('self-roundtrip');
  expect(planOfficeCiContract(metadata, instance, ids, 'self-owner-force').acceptance).toBe('self-owner-force');
  const team = planOfficeCiContract(metadata, instance, ids, 'team-plan-move');
  expect(team.bootstrap.employees).toHaveLength(2);
  expect(team.bootstrap.employees.map((e) => e.permissions)).toEqual([
    { moveOwnPlan: false, managePlans: false },
    { moveOwnPlan: true, managePlans: false },
  ]);
  for (const key of ['employeeId', 'sessionId', 'nativeThreadId'] as const)
    expect(team.bootstrap.employees[0]![key]).not.toBe(team.bootstrap.employees[1]![key]);
  expect(c.bootstrap.employees[0]?.permissions).toEqual({ moveOwnPlan: true, managePlans: false });
  expect(c.sourceProviders[0]?.mode).toBe('ordinary');
  for (const change of [
    { imageNamespace: 'production' },
    { sourcePath: '/tmp/mutable' },
    { runtimePath: '/tmp/mutable' },
    { clientManifestDigest: 'invalid' },
  ])
    expect(() => planOfficeCiContract({ ...metadata, ...change }, instance, ids)).toThrow();
  expect(() => planOfficeCiContract(metadata, instance, { ...ids, worker: 'worker:latest' })).toThrow();
});
it('requires separate team API denial/revocation, positive capsule and physical receipts without claiming the full matrix', () => {
  const id = '22222222-2222-4222-8222-222222222222',
    caller = '33333333-3333-4333-8333-333333333333',
    callerSession = '44444444-4444-4444-8444-444444444444',
    source = '55555555-5555-4555-8555-555555555555',
    target = '66666666-6666-4666-8666-666666666666',
    operation = '77777777-7777-4777-8777-777777777777';
  const root = '/private/team';
  const result = {
    status: 0,
    acceptedScenario: 'team-plan-move',
    baselineReady: true,
    planMovesAccepted: true,
    teamAccepted: true,
    evidence: root,
    forceAccepted: false,
    refreshReuseAccepted: false,
  };
  const receipt = {
    id,
    employeeId,
    callerEmployeeId: caller,
    callerSessionId: callerSession,
    sessionId: source,
    newSession: target,
    fromAccount: 'ci-plan-a',
    toAccount: 'ci-plan-b',
    realCapsuleHmac: true,
    originalOnly: true,
    physicalReceipt: 'physical-move-' + id,
    callerContainerId: 'a'.repeat(64),
    sourceContainerId: 'b'.repeat(64),
    targetContainerId: 'c'.repeat(64),
    targetOperationId: operation,
    sessionGeneration: 1,
    nativeThreadId: operation,
  };
  const physical = {
    sourceStopped: true,
    sourceId: receipt.sourceContainerId,
    targetId: receipt.targetContainerId,
    operationId: operation,
    sessionId: target,
    sessionGeneration: 2,
    nativeThreadId: operation,
    actualCallbacksAndConsumingCloses: true,
  };
  const permissionReceipts = [403, 200, 403, 200].map((status, i) => ({
    version: 1,
    purpose: 'reverie-ci-team-permission-receipt-v1',
    id: `00000000-0000-4000-8000-00000000000${i}`,
    scope: status === 403 ? 'team-request' : 'team-pending',
    callerEmployeeId: caller,
    callerSessionId: callerSession,
    employeeId,
    sessionId: source,
    namespacePid: 55,
    status,
    code: status === 403 ? 'FORBIDDEN' : null,
    success: status === 200,
  }));
  const summary = {
    id,
    employeeId,
    callerEmployeeId: caller,
    callerSessionId: callerSession,
    apiDenialsObserved: true,
    capsulePositive: true,
    callerPreserved: true,
    receipt: 'team-move-' + id + '-completed',
    physicalReceipt: receipt.physicalReceipt,
    permissionReceipts,
    permissionChecks: permissionReceipts.map((receipt) => ({
      ...receipt,
      unchangedNativeAndJournals: true,
      actualSdkProcess: true,
    })),
  };
  expect(requirePlanOfficeCiTeamAcceptance(result, summary, receipt, physical, root, caller, employeeId)).toMatchObject(
    {
      teamAccepted: true,
      teamManagePlansGrantRevocationAccepted: true,
      ordinarySelfAccepted: false,
      permissionMatrixAccepted: false,
      agentForceAccepted: false,
    }
  );
  for (const change of [
    { callerPreserved: false },
    { permissionReceipts: permissionReceipts.slice(1) },
    { permissionReceipts: permissionReceipts.map((p, i) => (i === 2 ? { ...p, status: 500 } : p)) },
    { permissionReceipts: permissionReceipts.map((p, i) => (i === 2 ? { ...p, id: permissionReceipts[0]!.id } : p)) },
  ])
    expect(() =>
      requirePlanOfficeCiTeamAcceptance(result, { ...summary, ...change }, receipt, physical, root, caller, employeeId)
    ).toThrow();
  for (const change of [
    { realCapsuleHmac: false },
    { callerContainerId: receipt.sourceContainerId },
    { callerSessionId: source },
  ])
    expect(() =>
      requirePlanOfficeCiTeamAcceptance(result, summary, { ...receipt, ...change }, physical, root, caller, employeeId)
    ).toThrow();
  expect(() =>
    requirePlanOfficeCiTeamAcceptance(
      result,
      summary,
      receipt,
      { ...physical, actualCallbacksAndConsumingCloses: false },
      root,
      caller,
      employeeId
    )
  ).toThrow();
  expect(() => requirePlanOfficeCiAcceptance(result, receipt, root, employeeId, 'team-plan-move')).toThrow();
});
it('requires both separately completed opposite moves with linked new sessions to accept opt-in roundtrip', () => {
  const root = '/private/owned/office-' + instance;
  const first = {
    id: '22222222-2222-4222-8222-222222222222',
    employeeId,
    fromAccount: 'ci-plan-a',
    toAccount: 'ci-plan-b',
    realCapsuleHmac: true,
    originalOnly: true,
    sessionId: '33333333-3333-4333-8333-333333333333',
    sessionGeneration: 1,
    newSession: '44444444-4444-4444-8444-444444444444',
  };
  const returned = {
    ...first,
    id: '55555555-5555-4555-8555-555555555555',
    fromAccount: 'ci-plan-b',
    toAccount: 'ci-plan-a',
    sessionId: first.newSession,
    sessionGeneration: 2,
    newSession: '66666666-6666-4666-8666-666666666666',
  };
  const summary = {
    employeeId,
    firstMoveId: first.id,
    returnMoveId: returned.id,
    firstNewSession: first.newSession,
    returnNewSession: returned.newSession,
    accounts: ['ci-plan-a', 'ci-plan-b', 'ci-plan-a'],
    firstReceipt: 'first-self-move-completed',
    returnReceipt: 'self-move-' + returned.id + '-completed',
  };
  const result = {
    status: 0,
    baselineReady: true,
    planMovesAccepted: true,
    acceptedScenario: 'self-roundtrip',
    evidence: root,
    forceAccepted: false,
    refreshReuseAccepted: false,
    selfRoundtripAccepted: true,
  };
  const accept = (r: unknown, value: { returned: unknown; summary: unknown } | undefined) =>
    requirePlanOfficeCiAcceptance(r, first, root, employeeId, 'self-roundtrip', value);
  expect(accept(result, { returned, summary })).toMatchObject({
    selfRoundtripAccepted: true,
    returnScenarioId: returned.id,
    forceAccepted: false,
    teamAccepted: false,
  });
  expect(() => accept(result, undefined)).toThrow();
  expect(() => accept({ ...result, selfRoundtripAccepted: false }, { returned, summary })).toThrow();
  for (const change of [
    { id: first.id },
    { sessionId: first.sessionId },
    { sessionGeneration: 1 },
    { newSession: first.sessionId },
    { fromAccount: 'ci-plan-a' },
    { realCapsuleHmac: false },
  ])
    expect(() => accept(result, { returned: { ...returned, ...change }, summary })).toThrow();
  expect(() => accept(result, { returned, summary: { ...summary, returnMoveId: first.id } })).toThrow();
  expect(() => requirePlanOfficeCiAcceptance(result, first, root, employeeId)).toThrow();
  const nativeThreadId = '77777777-7777-4777-8777-777777777777';
  const forceFirst = { ...first, nativeThreadId, targetContainerId: 'a'.repeat(64) };
  const forceReturned = {
    ...returned,
    realCapsuleHmac: false,
    ownerApiForce: true,
    nativeThreadId,
    sourceContainerId: 'a'.repeat(64),
    targetContainerId: 'b'.repeat(64),
    targetOperationId: '88888888-8888-4888-8888-888888888888',
    physicalReceipt: 'physical-move-' + returned.id,
  };
  const forceSummary = {
    ...summary,
    returnKind: 'owner-force',
    returnReceipt: 'owner-force-move-' + returned.id + '-completed',
  };
  const forceResult = {
    ...result,
    acceptedScenario: 'self-owner-force',
    forceAccepted: true,
    ownerForceAccepted: true,
    selfRoundtripAccepted: false,
  };
  const physical = {
    sourceStopped: true,
    sourceId: forceReturned.sourceContainerId,
    targetId: 'b'.repeat(64),
    sessionId: returned.newSession,
    sessionGeneration: 3,
    nativeThreadId,
    operationId: forceReturned.targetOperationId,
    actualCallbacksAndConsumingCloses: true,
  };
  const acceptForce = (value: unknown) =>
    requirePlanOfficeCiAcceptance(forceResult, forceFirst, root, employeeId, 'self-owner-force', {
      returned: forceReturned,
      summary: forceSummary,
      physical: value,
    });
  expect(acceptForce(physical)).toMatchObject({
    ownerForceAccepted: true,
    forceAccepted: true,
    selfRoundtripAccepted: false,
    agentForceAccepted: false,
    exhaustedSourceAccepted: false,
    deadViewerAccepted: false,
    teamAccepted: false,
  });
  for (const change of [
    { sourceStopped: false },
    { targetId: physical.sourceId },
    { sessionGeneration: 2 },
    { nativeThreadId: employeeId },
    { operationId: employeeId },
    { actualCallbacksAndConsumingCloses: false },
  ])
    expect(() => acceptForce({ ...physical, ...change })).toThrow();
  expect(() => acceptForce(undefined)).toThrow();
  expect(() =>
    requirePlanOfficeCiAcceptance(forceResult, forceFirst, root, employeeId, 'self-owner-force', {
      returned: { ...forceReturned, realCapsuleHmac: true },
      summary: forceSummary,
      physical,
    })
  ).toThrow();
  const sdkReceipt = {
    version: 1,
    purpose: 'reverie-ci-sdk-agent-force-v1',
    kind: 'prepared',
    id: returned.id,
    employeeId,
    sessionId: returned.sessionId,
    sessionGeneration: returned.sessionGeneration,
    fromAccount: 'ci-plan-b',
    toAccount: 'ci-plan-a',
    namespacePid: 42,
    nativeBirthTicks: '1234',
    identityFileDigest: 'c'.repeat(64),
    handoffDigest: 'd'.repeat(64),
    inheritedMuxPresent: true,
    childMuxAbsent: true,
    capabilitiesCheckedAt: 1000,
    moveOwnPlan: true,
    managePlans: false,
  };
  const spawned = {
    ...sdkReceipt,
    kind: 'spawned',
    child: {
      childPid: 43,
      parentPid: 42,
      childBirthTicks: '1235',
      nodeStage: '/opt/reverie-worker-client/bin/node',
      argsDigest: 'f'.repeat(64),
      sessionId: sdkReceipt.sessionId,
      identityFileDigest: sdkReceipt.identityFileDigest,
      childMuxAbsent: true,
      requiredEnvironmentMatched: true,
    },
  };
  const sdk = {
    prepared: sdkReceipt,
    issued: { ...sdkReceipt, kind: 'issued' },
    spawned,
    childClosed: {
      version: 1,
      purpose: 'sdk-force-child-proof-after-close-v1',
      id: sdkReceipt.id,
      proofDigest: createHash('sha256').update(JSON.stringify(spawned)).digest('hex'),
    },
    native: { panePid: 42, paneStartTicks: '1234' },
    inheritedMinusOnlyMux: true,
    actualCompletedForceJournal: true,
    forceBusy: true,
    handoffDigest: sdkReceipt.handoffDigest,
    journalHandoffDigest: 'e'.repeat(64),
    forceJournal: {
      id: returned.id,
      employeeId,
      oldSession: returned.sessionId,
      newSession: returned.newSession,
      phase: 'completed',
      sourceGeneration: returned.sessionGeneration,
      targetGeneration: 3,
      forceBusy: true,
      handoffDigest: sdkReceipt.handoffDigest,
      submittedHandoffDigest: 'e'.repeat(64),
    },
  };
  const agentReturned = { ...forceReturned, ownerApiForce: false, realCapsuleHmac: true, agentForce: sdk };
  const agentSummary = {
    ...forceSummary,
    returnKind: 'agent-force',
    returnReceipt: 'agent-force-move-' + returned.id + '-completed',
  };
  const agentResult = {
    ...forceResult,
    acceptedScenario: 'self-agent-force',
    ownerForceAccepted: false,
    agentForceAccepted: true,
  };
  const acceptAgent = (proof: unknown, extra: Record<string, unknown> = {}) =>
    requirePlanOfficeCiAcceptance(agentResult, forceFirst, root, employeeId, 'self-agent-force', {
      returned: { ...agentReturned, agentForce: proof, ...extra },
      summary: agentSummary,
      physical,
    });
  expect(acceptAgent(sdk)).toMatchObject({
    ordinarySelfAccepted: true,
    forceAccepted: true,
    agentForceAccepted: true,
    ownerForceAccepted: false,
    selfRoundtripAccepted: false,
    teamAccepted: false,
  });
  for (const change of [
    { inheritedMinusOnlyMux: false },
    { actualCompletedForceJournal: false },
    { forceBusy: false },
    { native: { panePid: 43, paneStartTicks: '1234' } },
    { issued: { ...sdk.issued, childMuxAbsent: false } },
    { prepared: { ...sdkReceipt, managePlans: true } },
    { prepared: { ...sdkReceipt, sessionGeneration: 1 } },
    { handoffDigest: 'bad' },
    { forceJournal: { ...sdk.forceJournal, phase: 'recovery-required' } },
    { forceJournal: { ...sdk.forceJournal, handoffDigest: '0'.repeat(64) } },
    { forceJournal: { ...sdk.forceJournal, targetGeneration: 2 } },
    { spawned: undefined },
    { childClosed: { ...sdk.childClosed, proofDigest: '0'.repeat(64) } },
    { spawned: { ...spawned, child: { ...spawned.child, parentPid: 44 } } },
    { spawned: { ...spawned, child: { ...spawned.child, childMuxAbsent: false } } },
    { spawned: { ...spawned, child: { ...spawned.child, nodeStage: '/opt/reverie-worker-client/bin/reverie' } } },
  ])
    expect(() => acceptAgent({ ...sdk, ...change })).toThrow();
  expect(() => acceptAgent(undefined)).toThrow();
  expect(() => acceptAgent(sdk, { ownerApiForce: true })).toThrow();
});
it('requires both the ordinary-self result and separate real HMAC/physical-completion sentinel', () => {
  const root = '/private/owned/office-' + instance;
  const result = {
    status: 0,
    baselineReady: true,
    planMovesAccepted: true,
    acceptedScenario: 'ordinary-self',
    evidence: root,
    forceAccepted: false,
    refreshReuseAccepted: false,
  };
  const proof = {
    id: '22222222-2222-4222-8222-222222222222',
    employeeId,
    fromAccount: 'ci-plan-a',
    toAccount: 'ci-plan-b',
    realCapsuleHmac: true,
    originalOnly: true,
  };
  expect(requirePlanOfficeCiAcceptance(result, proof, root, employeeId)).toMatchObject({
    ordinarySelfAccepted: true,
    forceAccepted: false,
    teamAccepted: false,
  });
  for (const change of [
    { status: 1 },
    { baselineReady: false },
    { planMovesAccepted: false },
    { acceptedScenario: 'baseline' },
    { evidence: '/foreign/office' },
    { forceAccepted: true },
    { ownerForceAccepted: true },
  ])
    expect(() => requirePlanOfficeCiAcceptance({ ...result, ...change }, proof, root, employeeId)).toThrow();
  for (const change of [
    { id: 'latest' },
    { employeeId: 'foreign' },
    { fromAccount: 'ci-plan-b' },
    { toAccount: 'ci-plan-a' },
    { realCapsuleHmac: false },
    { originalOnly: false },
  ])
    expect(() => requirePlanOfficeCiAcceptance(result, { ...proof, ...change }, root, employeeId)).toThrow();
  expect(() => requirePlanOfficeCiAcceptance(result, undefined, root, employeeId)).toThrow();
});
it('the actual executable exits nonzero on an unqualified host without touching its proposed fixture directory', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-office-ci-refusal-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.resolve('scripts/plan-office-ci.mts'), '--ci'],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_ACTIONS: 'false',
          REVERIE_CI_RUNNER_ENVIRONMENT: 'github-hosted',
          RUNNER_TEMP: temp,
        },
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(temp)).toEqual([]);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});
