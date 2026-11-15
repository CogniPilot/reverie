/** Mandatory hosted acceptance. All model executables and credentials are synthetic;
 * the ordinary owner API, HMAC client, Docker lifecycle and native verifier are real.
 * --ci keeps the ordinary-self gate; other scenarios require explicit selection. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The hosted command executes this source with Node --experimental-strip-types.
import {
  readPlanOfficeStartupDiagnostic,
  projectPlanOfficeStartupDiagnostic,
  readPlanOfficeBuildDiagnostic,
  PLAN_OFFICE_BUILD_STAGES,
} from '../test/helpers/plan-office-startup-diagnostic.ts';

type Json = Record<string, unknown>;
const imageId = /^sha256:[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type PlanOfficeCiSelection =
  | 'ordinary-self'
  | 'self-roundtrip'
  | 'self-owner-force'
  | 'self-agent-force'
  | 'team-plan-move';
function requireSelection(value: string): asserts value is PlanOfficeCiSelection {
  assert.ok(
    value === 'ordinary-self' ||
      value === 'self-roundtrip' ||
      value === 'self-owner-force' ||
      value === 'self-agent-force' ||
      value === 'team-plan-move'
  );
}
function object(value: unknown): Json {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Json;
}
export function requireHostedPlanOffice(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  arch = process.arch
) {
  const selection = args.length === 1 ? 'ordinary-self' : args[2];
  assert.ok(selection);
  requireSelection(selection);
  assert.deepEqual(args, args.length === 1 ? ['--ci'] : ['--ci', '--scenario', selection]);
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.REVERIE_CI_RUNNER_ENVIRONMENT, 'github-hosted', 'Never use a self-hosted employee Engine');
  assert.equal(platform, 'linux');
  assert.equal(arch, 'x64');
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP));
  return selection;
}
export function planOfficeCiNamespace(instance: string) {
  assert.match(instance, /^[a-f0-9]{32}$/);
  return 'reverie-ci-plan-office-' + instance;
}
export function planOfficeCiImage(value: unknown, namespace: string, role: string) {
  assert.match(namespace, /^reverie-ci-plan-office-[a-f0-9]{32}$/);
  assert.ok(['source', 'worker', 'helper', 'control'].includes(role));
  const image = object(value);
  assert.match(String(image.Id), imageId);
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, 'amd64');
  assert.ok(Array.isArray(image.RepoTags));
  assert.ok(image.RepoTags.includes(namespace + '-' + role + ':latest'));
  assert.ok(image.RepoTags.every((tag: unknown) => typeof tag === 'string' && tag.startsWith(namespace + '-')));
  return image.Id as string;
}
export function planOfficeCiContract(
  metadata: unknown,
  instance: string,
  ids: Record<string, string>,
  selection: PlanOfficeCiSelection = 'ordinary-self'
) {
  requireSelection(selection);
  const m = object(metadata);
  assert.equal(m.version, 1);
  assert.equal(m.purpose, 'reverie-ci-plan-office-inputs-v1');
  assert.equal(m.imageNamespace, planOfficeCiNamespace(instance));
  for (const key of ['sourcePath', 'runtimePath', 'platformClosure'])
    assert.match(String(m[key]), /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/);
  assert.match(String(m.clientManifestDigest), /^[a-f0-9]{64}$/);
  for (const role of ['source', 'worker', 'helper', 'control']) assert.match(ids[role] ?? '', imageId);
  const employeeId = randomUUID(),
    sessionId = randomUUID(),
    nativeThreadId = randomUUID();
  return {
    version: 1,
    purpose: 'reverie-ci-plan-office-baseline-v1',
    acceptance: selection,
    instance,
    sourcePath: m.sourcePath,
    runtimePath: m.runtimePath,
    platformClosure: m.platformClosure,
    sourceImageId: ids.source,
    workerImageId: ids.worker,
    helperImageId: ids.helper,
    controlImageId: ids.control,
    clientManifestDigest: m.clientManifestDigest,
    bootstrap: {
      version: 1,
      purpose: 'reverie-ci-plan-office-bootstrap-v1',
      employees: [
        {
          employeeId,
          sessionId,
          nativeThreadId,
          name: selection === 'team-plan-move' ? 'CI Team Caller' : 'CI Ordinary Self',
          account: 'ci-plan-a',
          permissions: { moveOwnPlan: selection !== 'team-plan-move', managePlans: false },
        },
        ...(selection === 'team-plan-move'
          ? [
              {
                employeeId: randomUUID(),
                sessionId: randomUUID(),
                nativeThreadId: randomUUID(),
                name: 'CI Team Target',
                account: 'ci-plan-a',
                permissions: { moveOwnPlan: true, managePlans: false },
              },
            ]
          : []),
      ],
    },
    sourceProviders: [{ employeeId, mode: 'ordinary' }],
    sourceLayouts: [{ employeeId, layout: 'operator-recovery', missingEphemeral: true }],
  };
}
/** Baseline readiness or an HTTP acknowledgement can never satisfy this gate. */
export function requirePlanOfficeCiAcceptance(
  result: unknown,
  receipt: unknown,
  root: string,
  employeeId: string,
  selection: PlanOfficeCiSelection = 'ordinary-self',
  roundtrip?: { returned: unknown; summary: unknown; physical?: unknown }
) {
  requireSelection(selection);
  assert.notEqual(selection, 'team-plan-move', 'Team acceptance requires its separate permission/native receipts');
  const r = object(result),
    proof = object(receipt);
  assert.equal(r.status, 0);
  assert.equal(r.baselineReady, true);
  assert.equal(r.planMovesAccepted, true);
  assert.equal(r.acceptedScenario, selection);
  assert.equal(r.evidence, root);
  const ownerForce = selection === 'self-owner-force';
  const agentForce = selection === 'self-agent-force';
  const forced = ownerForce || agentForce;
  assert.equal(r.forceAccepted, forced);
  if (agentForce) assert.equal(r.agentForceAccepted, true);
  else assert.notEqual(r.agentForceAccepted, true);
  if (!ownerForce) assert.notEqual(r.ownerForceAccepted, true);
  assert.equal(r.refreshReuseAccepted, false);
  assert.match(String(proof.id), uuid);
  assert.equal(proof.employeeId, employeeId);
  assert.equal(proof.fromAccount, 'ci-plan-a');
  assert.equal(proof.toAccount, 'ci-plan-b');
  assert.equal(proof.realCapsuleHmac, true);
  assert.equal(proof.originalOnly, true);
  const acceptance = {
    scenarioId: proof.id,
    employeeId,
    ordinarySelfAccepted: true,
    forceAccepted: forced,
    agentForceAccepted: agentForce,
    exhaustedSourceAccepted: false,
    deadViewerAccepted: false,
    teamAccepted: false,
    permissionMatrixAccepted: false,
    officeReentryAccepted: false,
  };
  if (selection === 'ordinary-self') {
    assert.notEqual(r.selfRoundtripAccepted, true);
    assert.equal(roundtrip, undefined);
    return { ...acceptance, selfRoundtripAccepted: false };
  }
  assert.equal(r.selfRoundtripAccepted, !forced);
  if (ownerForce) assert.equal(r.ownerForceAccepted, true);
  assert.ok(roundtrip);
  const returned = object(roundtrip.returned),
    summary = object(roundtrip.summary);
  assert.match(String(returned.id), uuid);
  assert.notEqual(returned.id, proof.id);
  assert.equal(returned.employeeId, employeeId);
  assert.equal(returned.fromAccount, 'ci-plan-b');
  assert.equal(returned.toAccount, 'ci-plan-a');
  assert.equal(returned.realCapsuleHmac, !ownerForce);
  if (agentForce) assert.equal(returned.ownerApiForce, false);
  if (ownerForce) assert.equal(returned.ownerApiForce, true);
  assert.equal(returned.originalOnly, true);
  for (const value of [proof.sessionId, proof.newSession, returned.sessionId, returned.newSession])
    assert.match(String(value), uuid);
  assert.ok(Number.isSafeInteger(proof.sessionGeneration) && Number(proof.sessionGeneration) > 0);
  assert.equal(returned.sessionId, proof.newSession);
  assert.equal(returned.sessionGeneration, Number(proof.sessionGeneration) + 1);
  assert.notEqual(returned.newSession, proof.sessionId);
  assert.notEqual(returned.newSession, returned.sessionId);
  assert.equal(summary.employeeId, employeeId);
  assert.equal(summary.firstMoveId, proof.id);
  assert.equal(summary.returnMoveId, returned.id);
  assert.equal(summary.firstNewSession, proof.newSession);
  assert.equal(summary.returnNewSession, returned.newSession);
  assert.deepEqual(summary.accounts, ['ci-plan-a', 'ci-plan-b', 'ci-plan-a']);
  assert.equal(summary.firstReceipt, 'first-self-move-completed');
  assert.equal(
    summary.returnReceipt,
    (ownerForce ? 'owner-force-move-' : agentForce ? 'agent-force-move-' : 'self-move-') + returned.id + '-completed'
  );
  if (forced) {
    assert.equal(summary.returnKind, agentForce ? 'agent-force' : 'owner-force');
    assert.equal(returned.physicalReceipt, 'physical-move-' + returned.id);
    const physical = object(roundtrip.physical);
    assert.equal(physical.sourceStopped, true);
    for (const id of [physical.sourceId, physical.targetId]) assert.match(String(id), /^[a-f0-9]{64}$/);
    assert.equal(physical.sourceId, returned.sourceContainerId);
    assert.match(String(proof.targetContainerId), /^[a-f0-9]{64}$/);
    assert.equal(physical.sourceId, proof.targetContainerId);
    assert.equal(physical.targetId, returned.targetContainerId);
    assert.notEqual(physical.targetId, physical.sourceId);
    assert.match(String(returned.targetOperationId), uuid);
    assert.equal(physical.operationId, returned.targetOperationId);
    assert.equal(physical.sessionId, returned.newSession);
    assert.equal(physical.sessionGeneration, Number(returned.sessionGeneration) + 1);
    assert.match(String(proof.nativeThreadId), uuid);
    assert.equal(returned.nativeThreadId, proof.nativeThreadId);
    assert.equal(physical.nativeThreadId, proof.nativeThreadId);
    assert.equal(physical.actualCallbacksAndConsumingCloses, true);
    if (agentForce) {
      const sdk = object(returned.agentForce),
        prepared = object(sdk.prepared),
        issued = object(sdk.issued),
        native = object(sdk.native);
      assert.equal(sdk.inheritedMinusOnlyMux, true);
      assert.equal(sdk.actualCompletedForceJournal, true);
      assert.equal(sdk.forceBusy, true);
      assert.match(String(sdk.handoffDigest), /^[a-f0-9]{64}$/);
      assert.match(String(sdk.journalHandoffDigest), /^[a-f0-9]{64}$/);
      for (const [receipt, kind] of [
        [prepared, 'prepared'],
        [issued, 'issued'],
      ] as const) {
        assert.equal(receipt.version, 1);
        assert.equal(receipt.purpose, 'reverie-ci-sdk-agent-force-v1');
        assert.equal(receipt.kind, kind);
        assert.equal(receipt.id, returned.id);
        assert.equal(receipt.employeeId, employeeId);
        assert.equal(receipt.sessionId, returned.sessionId);
        assert.equal(receipt.sessionGeneration, returned.sessionGeneration);
        assert.equal(receipt.fromAccount, 'ci-plan-b');
        assert.equal(receipt.toAccount, 'ci-plan-a');
        assert.equal(receipt.namespacePid, native.panePid);
        assert.equal(receipt.nativeBirthTicks, native.paneStartTicks);
        assert.equal(receipt.childMuxAbsent, true);
        assert.equal(typeof receipt.inheritedMuxPresent, 'boolean');
        assert.equal(receipt.moveOwnPlan, true);
        assert.equal(receipt.managePlans, false);
        assert.equal(receipt.handoffDigest, sdk.handoffDigest);
        assert.match(String(receipt.identityFileDigest), /^[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(receipt.capabilitiesCheckedAt) && Number(receipt.capabilitiesCheckedAt) >= 0);
      }
      assert.equal(prepared.identityFileDigest, issued.identityFileDigest);
      assert.equal(prepared.inheritedMuxPresent, issued.inheritedMuxPresent);
      assert.ok(Number(issued.capabilitiesCheckedAt) >= Number(prepared.capabilitiesCheckedAt));
      assert.ok(Number.isSafeInteger(native.panePid) && Number(native.panePid) > 1);
      assert.match(String(native.paneStartTicks), /^[1-9][0-9]{0,19}$/);
      const spawned = object(sdk.spawned),
        { child: childValue, ...spawnScope } = spawned,
        child = object(childValue),
        closed = object(sdk.childClosed);
      assert.deepEqual({ ...spawnScope, kind: 'issued' }, issued);
      assert.equal(spawned.kind, 'spawned');
      assert.ok(Number.isSafeInteger(child.childPid) && Number(child.childPid) > 1);
      assert.notEqual(child.childPid, native.panePid);
      assert.equal(child.parentPid, native.panePid);
      assert.match(String(child.childBirthTicks), /^[1-9][0-9]{0,19}$/);
      assert.equal(child.nodeStage, '/opt/reverie-worker-client/bin/node');
      assert.equal(child.childMuxAbsent, true);
      assert.equal(child.requiredEnvironmentMatched, true);
      assert.equal(child.sessionId, returned.sessionId);
      assert.equal(child.identityFileDigest, issued.identityFileDigest);
      assert.match(String(child.argsDigest), /^[a-f0-9]{64}$/);
      assert.equal(closed.version, 1);
      assert.equal(closed.purpose, 'sdk-force-child-proof-after-close-v1');
      assert.equal(closed.id, returned.id);
      assert.equal(closed.proofDigest, createHash('sha256').update(JSON.stringify(spawned)).digest('hex'));
      const journal = object(sdk.forceJournal);
      assert.equal(journal.id, returned.id);
      assert.equal(journal.employeeId, employeeId);
      assert.equal(journal.oldSession, returned.sessionId);
      assert.equal(journal.newSession, returned.newSession);
      assert.equal(journal.phase, 'completed');
      assert.equal(journal.forceBusy, true);
      assert.equal(journal.sourceGeneration, returned.sessionGeneration);
      assert.equal(journal.targetGeneration, physical.sessionGeneration);
      assert.equal(journal.handoffDigest, sdk.handoffDigest);
      assert.equal(journal.submittedHandoffDigest, sdk.journalHandoffDigest);
    }
  }
  return {
    ...acceptance,
    selfRoundtripAccepted: !forced,
    ownerForceAccepted: ownerForce,
    returnScenarioId: returned.id,
  };
}
/** Team permission scope is explicit: two denied API requests, two granted
 * read-only probes, one actual capsule request and physically verified target. */
export function requirePlanOfficeCiTeamAcceptance(
  result: unknown,
  summary: unknown,
  receipt: unknown,
  physical: unknown,
  root: string,
  callerEmployeeId: string,
  employeeId: string
) {
  const r = object(result),
    s = object(summary),
    p = object(receipt),
    native = object(physical);
  assert.equal(r.status, 0);
  assert.equal(r.acceptedScenario, 'team-plan-move');
  assert.equal(r.baselineReady, true);
  assert.equal(r.planMovesAccepted, true);
  assert.equal(r.teamAccepted, true);
  assert.equal(r.evidence, root);
  assert.equal(r.forceAccepted, false);
  assert.equal(r.refreshReuseAccepted, false);
  for (const id of [
    callerEmployeeId,
    employeeId,
    s.id,
    s.callerSessionId,
    p.sessionId,
    p.newSession,
    p.targetOperationId,
  ])
    assert.match(String(id), uuid);
  assert.notEqual(callerEmployeeId, employeeId);
  assert.equal(s.employeeId, employeeId);
  assert.equal(s.callerEmployeeId, callerEmployeeId);
  assert.equal(s.apiDenialsObserved, true);
  assert.equal(s.capsulePositive, true);
  assert.equal(s.callerPreserved, true);
  assert.equal(p.id, s.id);
  assert.equal(s.receipt, 'team-move-' + s.id + '-completed');
  assert.equal(s.physicalReceipt, 'physical-move-' + s.id);
  assert.equal(p.employeeId, employeeId);
  assert.equal(p.callerEmployeeId, callerEmployeeId);
  assert.equal(p.callerSessionId, s.callerSessionId);
  assert.notEqual(p.sessionId, p.callerSessionId);
  assert.equal(p.fromAccount, 'ci-plan-a');
  assert.equal(p.toAccount, 'ci-plan-b');
  assert.equal(p.realCapsuleHmac, true);
  assert.equal(p.originalOnly, true);
  assert.equal(p.physicalReceipt, s.physicalReceipt);
  assert.notEqual(p.newSession, p.sessionId);
  assert.notEqual(p.callerContainerId, p.sourceContainerId);
  assert.notEqual(p.callerContainerId, p.targetContainerId);
  for (const id of [p.sourceContainerId, p.targetContainerId, p.callerContainerId])
    assert.match(String(id), /^[a-f0-9]{64}$/);
  assert.equal(native.sourceStopped, true);
  assert.equal(native.sourceId, p.sourceContainerId);
  assert.equal(native.targetId, p.targetContainerId);
  assert.notEqual(native.sourceId, native.targetId);
  assert.equal(native.operationId, p.targetOperationId);
  assert.equal(native.sessionId, p.newSession);
  assert.ok(Number.isSafeInteger(p.sessionGeneration) && Number(p.sessionGeneration) > 0);
  assert.equal(native.sessionGeneration, Number(p.sessionGeneration) + 1);
  assert.match(String(p.nativeThreadId), uuid);
  assert.equal(native.nativeThreadId, p.nativeThreadId);
  assert.equal(native.actualCallbacksAndConsumingCloses, true);
  assert.ok(Array.isArray(s.permissionReceipts) && s.permissionReceipts.length === 4);
  assert.ok(Array.isArray(s.permissionChecks) && s.permissionChecks.length === 4);
  const ids = new Set([s.id]);
  let pid: unknown;
  for (const [i, raw] of s.permissionReceipts.entries()) {
    const v = object(raw),
      denied = i % 2 === 0;
    const checked = object(s.permissionChecks[i]);
    assert.equal(checked.unchangedNativeAndJournals, true);
    assert.equal(checked.actualSdkProcess, true);
    for (const key of Object.keys(v)) assert.equal(checked[key], v[key]);
    assert.match(String(v.id), uuid);
    assert.ok(!ids.has(v.id));
    ids.add(v.id);
    assert.equal(v.callerEmployeeId, callerEmployeeId);
    assert.equal(v.callerSessionId, s.callerSessionId);
    assert.equal(v.employeeId, employeeId);
    assert.equal(v.sessionId, p.sessionId);
    assert.equal(v.scope, denied ? 'team-request' : 'team-pending');
    assert.equal(v.status, denied ? 403 : 200);
    assert.equal(v.code, denied ? 'FORBIDDEN' : null);
    assert.equal(v.success, !denied);
    assert.ok(Number.isSafeInteger(v.namespacePid) && Number(v.namespacePid) > 1);
    if (i) assert.equal(v.namespacePid, pid);
    else pid = v.namespacePid;
  }
  return {
    scenarioId: s.id,
    employeeId,
    callerEmployeeId,
    teamAccepted: true,
    teamManagePlansGrantRevocationAccepted: true,
    ordinarySelfAccepted: false,
    selfRoundtripAccepted: false,
    forceAccepted: false,
    agentForceAccepted: false,
    exhaustedSourceAccepted: false,
    deadViewerAccepted: false,
    permissionMatrixAccepted: false,
    officeReentryAccepted: false,
  };
}
function save(file: string, value: unknown) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const diagnosticPhases = new Set([
  'staged',
  'office-issued',
  'office-ready',
  'pool-issued',
  'pool-ready',
  'destination-issued',
  'destination-ready',
  'start-issued',
  'container-running',
  'resources-issued',
  'resources-ready',
  'identity-issued',
  'identity-ready',
  'provider-issued',
  'ready',
  'pending',
  'held',
  'waiting',
  'creating',
  'starting',
  'checking',
  'stopping',
  'executing',
  'completed',
  'failed',
  'recovery-required',
  'reauthorize-required',
  'rejected',
  'cancelled',
  'expired',
  'unknown',
]);
const diagnosticCodes = new Set([
  'BAD_REQUEST',
  'CONFLICT',
  'CAPACITY',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'INVALID_INPUT',
  'SESSION_BUSY',
  'ALREADY_EXISTS',
  'RATE_LIMITED',
  'OPERATION_FAILED',
  'PASSWORD_CHANGE_REQUIRED',
  'USER_EXISTS',
  'USER_NOT_FOUND',
  'LAST_ADMIN',
  'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED',
  'DOCKER_CONTINUATION_ORIGINAL_HELD',
  'DOCKER_CONTINUATION_DESTINATION_UNCONFIRMED',
  'DOCKER_CONTINUATION_UNKNOWN_OPERATION',
  'DOCKER_CONTINUATION_TARGET_CHANGED',
  'DOCKER_CONTINUATION_POLICY_CHANGED',
]);
const diagnosticKinds = new Set([
  'recovery-status',
  'request-status',
  'canonical-continuation',
  'canonical-request',
  'canonical-move',
  'owner-refusal',
]);
/** Explicit projection only: even a public DTO's message/error/stack can contain credentials. */
export function planOfficeCiFailureDiagnostic(child: unknown, observations: readonly unknown[], instance?: string) {
  const c = child && typeof child === 'object' ? (child as Json) : {};
  const childStatus: Json = {};
  if (c.status === null || (Number.isInteger(c.status) && Number(c.status) >= 0 && Number(c.status) <= 255))
    childStatus.status = c.status;
  if (
    c.signal === null ||
    (typeof c.signal === 'string' &&
      ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'SIGPIPE'].includes(c.signal))
  )
    childStatus.signal = c.signal;
  if (
    typeof c.errorName === 'string' &&
    ['Error', 'TimeoutError', 'AbortError', 'TypeError', 'RangeError'].includes(c.errorName)
  )
    childStatus.errorName = c.errorName;
  const operations = observations.slice(-16).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const v = value as Json;
    if (typeof v.kind !== 'string' || !diagnosticKinds.has(v.kind)) return [];
    const result: Json = { kind: v.kind };
    for (const key of ['id', 'employeeId', 'sessionId', 'newSession'])
      if (typeof v[key] === 'string' && uuid.test(v[key] as string)) result[key] = v[key];
    for (const key of ['phase', 'movePhase', 'state'])
      if (typeof v[key] === 'string' && diagnosticPhases.has(v[key] as string)) result[key] = v[key];
    if (Number.isInteger(v.httpStatus) && Number(v.httpStatus) >= 100 && Number(v.httpStatus) <= 599)
      result.httpStatus = v.httpStatus;
    if (typeof v.errorCode === 'string' && diagnosticCodes.has(v.errorCode)) result.errorCode = v.errorCode;
    return Object.keys(result).length > 1 ? [result] : [];
  });
  const startup = instance ? projectPlanOfficeStartupDiagnostic(c.startup, instance) : undefined;
  const build = c.build && typeof c.build === 'object' ? (c.build as Json) : {};
  const builder = projectPlanOfficeStartupDiagnostic(build.builder, '0'.repeat(32));
  const importSmoke = projectPlanOfficeStartupDiagnostic(build.importSmoke, '0'.repeat(32));
  const fixtureBuild =
    builder && (PLAN_OFFICE_BUILD_STAGES as readonly string[]).includes(builder.stage)
      ? { builder, ...(importSmoke ? { importSmoke } : {}) }
      : undefined;
  return {
    child: childStatus,
    operations,
    ...(startup ? { startup } : {}),
    ...(fixtureBuild ? { fixtureBuild } : {}),
    observation: operations.length
      ? 'last-known-retained-data'
      : startup
        ? 'last-known-entered-stage'
        : fixtureBuild
          ? 'last-known-build-stage'
          : 'unavailable',
  };
}
/** Fixed files in this run's owned fixture only. Missing/partial evidence is not a reason to replay or sign in. */
export function readPlanOfficeCiFailureState(root: string, employeeId: string): unknown[] {
  if (!uuid.test(employeeId)) return [];
  const read = (relative: string): unknown => {
    let fd: number | undefined;
    try {
      assert.equal(fs.realpathSync(root), root);
      const parent = fs.lstatSync(root);
      assert.ok(parent.isDirectory() && parent.uid === process.getuid!() && (parent.mode & 0o777) === 0o700);
      const file = path.join(root, relative);
      assert.equal(fs.realpathSync(path.dirname(file)), path.dirname(file));
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      assert.ok(st.isFile() && st.uid === process.getuid!() && st.nlink === 1 && (st.mode & 0o777) === 0o600);
      assert.ok(st.size > 0 && st.size <= 8 * 1024 ** 2);
      const bytes = Buffer.alloc(st.size + 1),
        length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      assert.equal(length, st.size);
      return JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* Best-effort diagnostic read only. */
        }
      }
    }
  };
  const result: unknown[] = [];
  const add = (raw: unknown, kind: string) => {
    if (!raw || typeof raw !== 'object') return;
    const v = raw as Json,
      request = v.request as Json | undefined,
      operation =
        v.operation && typeof v.operation === 'object' && !Array.isArray(v.operation)
          ? (v.operation as Json)
          : undefined;
    if (v.employeeId !== employeeId) return;
    if (operation && Object.hasOwn(operation, 'employeeId') && operation.employeeId !== employeeId) return;
    result.push({
      kind,
      id: v.operationId ?? operation?.operationId ?? v.id ?? request?.operationId,
      employeeId,
      sessionId: v.sessionId ?? operation?.sessionId ?? v.oldSession ?? request?.sessionId,
      newSession: v.newSession,
      phase: operation?.phase ?? v.phase,
      movePhase: v.movePhase,
      state: operation?.state ?? v.state,
      httpStatus: v.httpStatus,
      errorCode:
        operation?.code ?? operation?.errorCode ?? v.errorCode ?? v.code ?? (v.startRefusal as Json | undefined)?.code,
    });
  };
  try {
    // Retain only the latest bounded public observation receipts; never read intent latches or auth files.
    const files = fs
      .readdirSync(root)
      .filter((name) =>
        /^(?:original-\d+-[a-f0-9-]{36}|status-[a-f0-9-]{36}-(?:(?:absent-|timeout-)?\d+))\.json$/.test(name)
      )
      .slice(-512)
      .sort((a, b) => fs.lstatSync(path.join(root, a)).mtimeMs - fs.lstatSync(path.join(root, b)).mtimeMs)
      .slice(-8);
    for (const name of files) {
      const value = read(name);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Json;
      // The owned filename can supply missing scope, but must never relabel a supplied foreign employee.
      if (Object.hasOwn(v, 'employeeId') && v.employeeId !== employeeId) continue;
      // Original policy selections carry their public phase/state/code in operation, not at the top level.
      if (name.startsWith('original-') && name.endsWith('-' + employeeId + '.json') && value)
        add({ ...value, employeeId }, 'recovery-status');
      else if (name.startsWith('status-')) {
        if (typeof v.id === 'string' && uuid.test(v.id) && name.startsWith('status-' + v.id + '-'))
          add(
            { ...v, employeeId, ...(name.includes('-absent-') ? { httpStatus: 404, state: 'unknown' } : {}) },
            'request-status'
          );
      }
    }
  } catch {
    /* A missing or changing observation directory remains explicitly unconfirmed. */
  }
  const company = read('data/company.json') as Json | undefined;
  for (const row of (Array.isArray(company?.dockerEmployeeContinuations)
    ? company.dockerEmployeeContinuations
    : []
  ).slice(-4))
    add(row, 'canonical-continuation');
  for (const [file, kind] of [
    ['plan-requests.json', 'canonical-request'],
    ['plan-moves.json', 'canonical-move'],
  ]) {
    const rows = read('data/' + file);
    if (Array.isArray(rows)) for (const row of rows.slice(-4)) add(row, kind);
  }
  const refusal = read('owner-api-refused.json') as Json | undefined;
  if (refusal)
    result.push({
      kind: 'owner-refusal',
      httpStatus: refusal.status,
      errorCode: (refusal.response as Json | undefined)?.errorCode,
    });
  return result;
}
export async function runPlanOfficeCi(args: readonly string[], env = process.env) {
  const selection = requireHostedPlanOffice(args, env);
  assert.ok(process.getuid!() > 0 && process.getgid!() > 0);
  const source = fileURLToPath(new URL('../../..', import.meta.url));
  const instance = randomBytes(16).toString('hex'),
    namespace = planOfficeCiNamespace(instance);
  const evidence = path.join(env.RUNNER_TEMP!, namespace);
  fs.mkdirSync(evidence, { mode: 0o700 });
  const dockerConfig = path.join(evidence, 'docker-config');
  fs.mkdirSync(dockerConfig, { mode: 0o700 });
  const published = path.join(source, 'acceptance', 'plan-office');
  fs.mkdirSync(path.dirname(published), { recursive: true });
  assert.equal(fs.realpathSync(path.dirname(published)), path.dirname(published));
  fs.mkdirSync(published, { mode: 0o700 });
  let serial = 0,
    lastStage = 'admission';
  let lastChild: unknown;
  let ownedEmployeeIds: string[] = [];
  const run = (label: string, program: string, argv: string[], timeout = 120000) => {
    lastStage = label;
    console.log('Plan office: ' + label);
    const key = String(++serial).padStart(3, '0') + '-' + label;
    save(path.join(evidence, key + '-intent.json'), { program, argv });
    const result = spawnSync(program, argv, {
      cwd: source,
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...env, DOCKER_CONFIG: dockerConfig, DOCKER_HOST: 'unix:///var/run/docker.sock' },
    });
    lastChild = {
      status: result.status,
      signal: result.signal,
      errorName: result.error?.name,
      ...(label === 'actual-' + selection ? { startup: readPlanOfficeStartupDiagnostic(result.stdout, instance) } : {}),
      ...(label === 'build-fixture-inputs' || label === 'build-control'
        ? { build: readPlanOfficeBuildDiagnostic(result.stderr) }
        : {}),
    };
    // Raw replies can contain synthetic passwords/tokens. They stay outside artifacts and console logs.
    save(path.join(evidence, key + '-result.json'), {
      status: result.status,
      signal: result.signal,
      errorName: result.error?.name,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.equal(result.error, undefined, label + ' outcome unconfirmed');
    assert.equal(result.signal, null, label + ' interrupted');
    assert.equal(result.status, 0, label + ' failed; private raw replies are not published');
    return result.stdout;
  };
  const docker = (label: string, argv: string[]) =>
    run(label, 'docker', ['--host', 'unix:///var/run/docker.sock', ...argv]);
  const build = (label: string, expression: string, output: string) =>
    run(
      label,
      'nix',
      [
        'build',
        '--expr',
        expression,
        '--log-format',
        'internal-json',
        '--no-write-lock-file',
        '--max-jobs',
        '1',
        '--cores',
        '2',
        '--out-link',
        output,
        '-L',
      ],
      2700000
    );
  try {
    const head = run('head', 'git', ['rev-parse', 'HEAD']).trim();
    run('tracked-entry', 'git', [
      'ls-files',
      '--error-unmatch',
      'apps/web/scripts/plan-office-ci.mts',
      'nix/ci-plan-office-inputs.nix',
    ]);
    assert.equal(run('clean', 'git', ['status', '--porcelain', '--untracked-files=no']), '');
    const archived = object(
      JSON.parse(run('archive-source', 'nix', ['flake', 'archive', '--json', '--no-write-lock-file', source]))
    );
    assert.match(String(archived.path), /^\/nix\/store\/[a-z0-9]{32}-source$/);
    const locked = object(
      JSON.parse(
        run('lock-source', 'nix', ['flake', 'metadata', '--json', '--no-write-lock-file', String(archived.path)])
      )
    );
    const lockedValue = object(locked.locked);
    assert.equal(lockedValue.type, 'path');
    assert.equal(lockedValue.path, archived.path);
    assert.match(String(lockedValue.narHash), /^sha256-[A-Za-z0-9+/]+=*$/);
    assert.ok(String(locked.url).startsWith('path:' + archived.path + '?'));
    const expression = `let source = builtins.getFlake ${JSON.stringify(locked.url)}; pkgs = import source.inputs.nixpkgs { system = "x86_64-linux"; }; src = import (source.outPath + "/nix/source-filter.nix") { lib = pkgs.lib; src = source.outPath; }; in import (source.outPath + "/nix/ci-plan-office-inputs.nix") { inherit pkgs src; dependencyConsole = source.packages.x86_64-linux.console; imageNamespace = ${JSON.stringify(namespace)}; }`;
    const stage = path.join(evidence, 'inputs');
    build('build-fixture-inputs', '(' + expression + ').stage', stage);
    const metadata = object(JSON.parse(fs.readFileSync(path.join(stage, 'metadata.json'), 'utf8')));
    const ids: Record<string, string> = {};
    const load = (role: string, archive: string) => {
      const tag = namespace + '-' + role + ':latest';
      assert.equal(docker('tag-absent-' + role, ['image', 'ls', '--quiet', '--filter', 'reference=' + tag]).trim(), '');
      const file = fs.realpathSync(archive),
        stat = fs.statSync(file);
      assert.ok(file.startsWith('/nix/store/') && stat.isFile() && stat.uid === 0 && (stat.mode & 0o222) === 0);
      // Full archived size, including already-known layers, can consume daemon staging/chain storage.
      const free = fs.statfsSync(evidence);
      assert.ok(
        free.bavail * free.bsize > 3 * 1024 ** 3 + 5 * stat.size,
        'Insufficient disposable runner disk reserve'
      );
      docker('load-' + role, ['image', 'load', '--input', file]);
      const rows: unknown[] = JSON.parse(docker('inspect-' + role, ['image', 'inspect', tag]));
      assert.equal(rows.length, 1);
      ids[role] = planOfficeCiImage(rows[0], namespace, role);
    };
    for (const role of ['source', 'worker', 'helper']) load(role, path.join(stage, role + '.tar.gz'));
    const control = path.join(evidence, 'control-image');
    build(
      'build-control',
      '(' +
        expression +
        ').mkControl ' +
        `{ workerImageId = ${JSON.stringify(ids.worker)}; sourceImageIds = [${JSON.stringify(ids.source)}]; helperImageId = ${JSON.stringify(ids.helper)}; }`,
      control
    );
    load('control', control);
    const contract = planOfficeCiContract(metadata, instance, ids, selection);
    ownedEmployeeIds = contract.bootstrap.employees.map((employee) => employee.employeeId);
    const file = path.join(evidence, 'contract.json');
    save(file, contract);
    assert.equal(run('head-current', 'git', ['rev-parse', 'HEAD']).trim(), head);
    assert.equal(run('clean-current', 'git', ['status', '--porcelain', '--untracked-files=no']), '');
    const runtime = String(metadata.runtimePath);
    const runtimeMetadata = object(JSON.parse(fs.readFileSync(path.join(runtime, 'metadata.json'), 'utf8')));
    const stdout = run(
      'actual-' + selection,
      String(runtimeMetadata.nodeExecutable),
      [
        path.join(runtime, 'lib/reverie/test/fixtures/plan-office-canary.mjs'),
        '--contract',
        file,
        '--diagnostic-instance',
        instance,
      ],
      600000
    );
    const root = path.join(evidence, 'office-' + instance);
    let acceptance: Json;
    if (selection === 'team-plan-move') {
      const summary = object(JSON.parse(fs.readFileSync(path.join(root, 'team-plan-move-completed.json'), 'utf8')));
      assert.match(String(summary.id), uuid);
      acceptance = requirePlanOfficeCiTeamAcceptance(
        JSON.parse(stdout),
        summary,
        JSON.parse(fs.readFileSync(path.join(root, 'team-move-' + summary.id + '-completed.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(root, 'physical-move-' + summary.id + '.json'), 'utf8')),
        root,
        contract.bootstrap.employees[0]!.employeeId,
        contract.bootstrap.employees[1]!.employeeId
      );
    } else {
      const proof = JSON.parse(fs.readFileSync(path.join(root, 'first-self-move-completed.json'), 'utf8'));
      let roundtrip: { returned: unknown; summary: unknown; physical?: unknown } | undefined;
      if (selection !== 'ordinary-self') {
        const ownerForce = selection === 'self-owner-force';
        const agentForce = selection === 'self-agent-force';
        const summary = object(
          JSON.parse(
            fs.readFileSync(
              path.join(
                root,
                ownerForce
                  ? 'self-owner-force-completed.json'
                  : agentForce
                    ? 'self-agent-force-completed.json'
                    : 'self-roundtrip-completed.json'
              ),
              'utf8'
            )
          )
        );
        assert.match(String(summary.returnMoveId), uuid);
        roundtrip = {
          summary,
          returned: JSON.parse(
            fs.readFileSync(
              path.join(
                root,
                (ownerForce ? 'owner-force-move-' : agentForce ? 'agent-force-move-' : 'self-move-') +
                  summary.returnMoveId +
                  '-completed.json'
              ),
              'utf8'
            )
          ),
          ...(ownerForce || agentForce
            ? {
                physical: JSON.parse(
                  fs.readFileSync(path.join(root, 'physical-move-' + summary.returnMoveId + '.json'), 'utf8')
                ),
              }
            : {}),
        };
      }
      acceptance = requirePlanOfficeCiAcceptance(
        JSON.parse(stdout),
        proof,
        root,
        contract.bootstrap.employees[0]!.employeeId,
        selection,
        roundtrip
      );
    }
    save(path.join(published, 'result.json'), {
      status: 0,
      head,
      namespace,
      ...acceptance,
      recoveryMatrixAccepted: false,
    });
  } catch {
    // Publish a closed diagnostic only. Do not serialize exceptions, raw replies, owner cookies or fixture homes.
    save(path.join(published, 'failure.json'), {
      status: 1,
      namespace,
      failedStage: lastStage,
      ordinarySelfAccepted: false,
      selfRoundtripAccepted: false,
      selectedScenario: selection,
      diagnostic: planOfficeCiFailureDiagnostic(
        lastChild,
        ownedEmployeeIds.flatMap((employeeId) =>
          readPlanOfficeCiFailureState(path.join(evidence, 'office-' + instance), employeeId)
        ),
        instance
      ),
    });
    throw Error('Actual ' + selection + ' plan acceptance failed at ' + lastStage);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  await runPlanOfficeCi(process.argv.slice(2));
