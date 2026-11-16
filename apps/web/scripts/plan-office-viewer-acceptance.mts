/** Hosted receipt consumer only. These observations never grant product authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const birth = /^[1-9][0-9]{0,19}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function record(value: unknown, keys: string): Json {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), keys.split(' ').sort(), 'Closed viewer receipt required');
  return value as Json;
}
function match(value: unknown, pattern: RegExp): asserts value is string {
  assert.equal(typeof value, 'string');
  assert.match(value as string, pattern);
}
function pid(value: unknown): void {
  assert.ok(Number.isSafeInteger(value) && Number(value) > 1 && Number(value) <= 2147483647);
}
function native(value: unknown, threadId: unknown) {
  const v = record(value, 'paneId panePid paneStartTicks threadId hookGenerationSha256');
  match(v.paneId, /^%[0-9]+$/);
  pid(v.panePid);
  match(v.paneStartTicks, birth);
  match(v.threadId, uuid);
  assert.equal(v.threadId, threadId);
  match(v.hookGenerationSha256, hash);
  return v;
}
function website(value: unknown, sessionId: unknown) {
  const v = record(
    value,
    'sessionId muxName pid birth tty ttyStamp parentBirth parentCommandDigest serverPid serverBirth socketStamp outerPid outerBirth outerCommandDigest outerForm manifestDigest socketPathSha256'
  );
  assert.equal(v.sessionId, sessionId);
  match(v.sessionId, uuid);
  assert.equal(v.muxName, 'reverie-' + v.sessionId.slice(0, 8));
  for (const key of ['pid', 'serverPid', 'outerPid']) pid(v[key]);
  assert.notEqual(v.pid, v.outerPid);
  for (const key of ['birth', 'parentBirth', 'serverBirth', 'outerBirth']) match(v[key], birth);
  match(v.tty, /^\/dev\/pts\/(?:0|[1-9][0-9]*)$/);
  for (const key of ['ttyStamp', 'socketStamp'])
    assert.ok(typeof v[key] === 'string' && v[key].length > 0 && v[key].length <= 512);
  for (const key of ['parentCommandDigest', 'outerCommandDigest', 'manifestDigest', 'socketPathSha256'])
    match(v[key], hash);
  assert.equal(v.outerForm, 'paid-launch');
  return v;
}
function sameWebsiteOwner(value: Json) {
  const { pid: _pid, birth: _birth, tty: _tty, ttyStamp: _ttyStamp, ...owner } = value;
  return owner;
}
function command(value: unknown, index: number, scope: Json, caller: Json, ids: Set<unknown>) {
  const v = record(
    value,
    'version purpose id command expected callerEmployeeId callerSessionId employeeId sessionId sessionGeneration namespacePid child exitCode reconnect stdoutSha256 stderrSha256'
  );
  assert.equal(v.version, 1);
  assert.equal(v.purpose, 'reverie-ci-sdk-viewer-command-returned-v1');
  match(v.id, uuid);
  assert.ok(!ids.has(v.id), 'Each SDK command must have its own original receipt');
  ids.add(v.id);
  const denied = index === 3;
  assert.equal(v.command, index === 1 ? 'reconnect-viewer' : 'viewer-status');
  assert.equal(v.expected, denied ? 'denied' : 'allowed');
  assert.equal(v.exitCode, denied ? 4 : 0);
  for (const key of ['callerEmployeeId', 'callerSessionId', 'employeeId', 'sessionId', 'sessionGeneration'])
    assert.equal(v[key], scope[key]);
  assert.equal(v.namespacePid, caller.panePid);
  const child = record(
    v.child,
    'childPid parentPid childBirthTicks nodeStage argsDigest sessionId identityFileDigest childMuxAbsent requiredEnvironmentMatched'
  );
  pid(child.childPid);
  assert.notEqual(child.childPid, caller.panePid);
  assert.equal(child.parentPid, caller.panePid);
  match(child.childBirthTicks, birth);
  assert.equal(child.nodeStage, '/opt/reverie-worker-client/bin/node');
  const argv = [
    child.nodeStage,
    '--no-global-search-paths',
    '--no-addons',
    '/opt/reverie-worker-client/bin/reverie.mjs',
    'agent',
    v.command,
    scope.employeeId,
    '--json',
  ];
  assert.equal(child.argsDigest, digest(JSON.stringify(argv)));
  assert.equal(child.sessionId, scope.callerSessionId);
  match(child.identityFileDigest, hash);
  assert.equal(child.childMuxAbsent, true);
  assert.equal(child.requiredEnvironmentMatched, true);
  for (const key of ['stdoutSha256', 'stderrSha256']) match(v[key], hash);
  if (denied)
    assert.equal(v.reconnect, null); // Exit 4 proves CLI refusal, not an HTTP status.
  else {
    const status = record(v.reconnect, 'state reason attempts retryAfterMs');
    assert.equal(status.state, index === 0 ? 'blocked' : 'connected');
    match(status.reason, /^[A-Za-z0-9_-]{1,96}$/);
    if (index === 0) assert.equal(status.reason, 'not-attempted');
    assert.ok(Number.isInteger(status.attempts) && Number(status.attempts) >= 0 && Number(status.attempts) <= 1000);
    assert.ok(
      Number.isInteger(status.retryAfterMs) && Number(status.retryAfterMs) >= 0 && Number(status.retryAfterMs) <= 60000
    );
  }
  return child;
}
export function requirePlanOfficeViewerAcceptance(
  value: unknown,
  context: {
    controlId: unknown;
    callerEmployeeId: string;
    callerSessionId: unknown;
    callerThreadId: string;
    callerPid: unknown;
    employeeId: string;
    sessionId: unknown;
    sessionGeneration: unknown;
    operationId: unknown;
    containerId: unknown;
    nativeThreadId: unknown;
    pane: unknown;
  }
) {
  const v = record(
    value,
    'version purpose id controlId callerEmployeeId employeeId callerSessionId sessionId sessionGeneration operationId containerId callerNative targetNative oldWebsite newWebsite afterRevokeWebsite commands draft paidJournalSha256 kernelPolicySha256 canonicalScopeSha256 inputFences activeUnknownInputExercised unknownPipelineHistoryNativeQualified sdkInheritedMinusOnlyMux realPackagedCliAndHttp oneWebsiteClientOnly originalPaidProviderAndDraftRetained grantRevokedAndReadBack currentAfterCallerGrantRevoked productViewCurrentAfterRepair productViewCurrentAfterCallerRevoke limitation'
  );
  assert.equal(v.version, 1);
  assert.equal(v.purpose, 'reverie-ci-team-viewer-repair-completed-v1');
  for (const key of ['id', 'callerEmployeeId', 'employeeId', 'callerSessionId', 'sessionId', 'operationId'])
    match(v[key], uuid);
  assert.notEqual(v.callerEmployeeId, v.employeeId);
  assert.notEqual(v.callerSessionId, v.sessionId);
  for (const key of ['controlId', 'containerId']) match(v[key], hash);
  assert.ok(Number.isSafeInteger(v.sessionGeneration) && Number(v.sessionGeneration) > 0);
  for (const key of [
    'controlId',
    'callerEmployeeId',
    'employeeId',
    'callerSessionId',
    'sessionId',
    'sessionGeneration',
    'operationId',
    'containerId',
  ] as const)
    assert.equal(v[key], context[key]);
  const caller = native(v.callerNative, context.callerThreadId),
    target = native(v.targetNative, context.nativeThreadId);
  assert.equal(caller.panePid, context.callerPid);
  assert.notEqual(v.controlId, v.containerId);
  const pane = record(context.pane, 'paneId panePid paneStartTicks hooks');
  for (const key of ['paneId', 'panePid', 'paneStartTicks']) assert.equal(target[key], pane[key]);
  const hooks = record(pane.hooks, 'kind generation');
  assert.equal(hooks.kind, 'generation');
  assert.equal(typeof hooks.generation, 'string');
  assert.equal(target.hookGenerationSha256, digest(hooks.generation as string));
  const old = website(v.oldWebsite, v.sessionId),
    fresh = website(v.newWebsite, v.sessionId);
  assert.notEqual(fresh.pid, old.pid);
  assert.deepEqual(sameWebsiteOwner(fresh), sameWebsiteOwner(old));
  assert.deepEqual(website(v.afterRevokeWebsite, v.sessionId), fresh);
  assert.ok(Array.isArray(v.commands) && v.commands.length === 4);
  const ids = new Set<unknown>([v.id]);
  const childIdentities = new Set<string>();
  let identity: unknown;
  for (const [i, receipt] of v.commands.entries()) {
    const child = command(receipt, i, v, caller, ids);
    const childIdentity = JSON.stringify([child.childPid, child.childBirthTicks]);
    assert.ok(!childIdentities.has(childIdentity), 'Completed SDK child cannot be reused for another command');
    childIdentities.add(childIdentity);
    if (i) assert.equal(child.identityFileDigest, identity);
    else identity = child.identityFileDigest;
  }
  const draft = record(v.draft, 'sha256 occurrences targetTurnFilesSha256 consumingHistoryBarriersSha256');
  assert.equal(draft.occurrences, 1);
  for (const key of ['sha256', 'targetTurnFilesSha256', 'consumingHistoryBarriersSha256']) match(draft[key], hash);
  for (const key of ['paidJournalSha256', 'kernelPolicySha256', 'canonicalScopeSha256']) match(v[key], hash);
  const fences = record(v.inputFences, 'publicTerminal savedTerminal publicProvider savedProvider');
  for (const flag of Object.values(fences)) {
    const f = record(flag, 'present value');
    assert.equal(typeof f.present, 'boolean');
    if (f.present) assert.equal(typeof f.value, 'boolean');
    else assert.equal(f.value, null);
  }
  assert.equal(
    v.activeUnknownInputExercised,
    ['publicTerminal', 'savedTerminal'].some((key) => {
      const f = fences[key] as Json;
      return f.present && f.value === true;
    })
  );
  assert.equal(v.unknownPipelineHistoryNativeQualified, false);
  for (const key of [
    'sdkInheritedMinusOnlyMux',
    'realPackagedCliAndHttp',
    'oneWebsiteClientOnly',
    'originalPaidProviderAndDraftRetained',
    'grantRevokedAndReadBack',
    'currentAfterCallerGrantRevoked',
    'productViewCurrentAfterRepair',
    'productViewCurrentAfterCallerRevoke',
  ])
    assert.equal(v[key], true);
  assert.equal(v.limitation, 'External fake provider; no paid vendor/chat/self/website-restart recovery proof.');
  return {
    teamViewerRepairAccepted: true,
    recoveryGrantRevocationAccepted: true,
    activeUnknownInputExercised: v.activeUnknownInputExercised,
    unknownPipelineHistoryNativeQualified: false,
  };
}
