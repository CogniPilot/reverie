/** Closed hosted orchestration contracts only; these tests never call Docker or build images. */
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  requireHostedPlanOffice,
  planOfficeCiNamespace,
  planOfficeCiImage,
  planOfficeCiContract,
  requirePlanOfficeCiAcceptance,
  planOfficeCiFailureDiagnostic,
  readPlanOfficeCiFailureState,
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
it('requires the explicit hosted-only command before any filesystem, build or Engine effect', () => {
  expect(() => requireHostedPlanOffice(['--ci'], env, 'linux', 'x64')).not.toThrow();
  expect(requireHostedPlanOffice(['--ci'], env, 'linux', 'x64')).toBe('ordinary-self');
  expect(requireHostedPlanOffice(['--ci', '--scenario', 'self-roundtrip'], env, 'linux', 'x64')).toBe('self-roundtrip');
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
      phase: 'identity-issued',
      state: 'held',
      code: 'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED',
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
