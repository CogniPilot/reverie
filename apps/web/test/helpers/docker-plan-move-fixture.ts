import { dockerProviderRuntimeRecipeDigest } from '../../src/docker-employee-source-correlation.js';
import {
  DockerEmployeePlanReplacementWorkRecord,
  DockerEmployeeContinuationRecord,
} from '../../src/docker-employee-continuation-data.js';
import { dockerContinuationDigest } from '../../src/docker-employee-continuation.js';
import { DockerPlanMoveSeed, DockerPlanMoveJournalState } from '../../src/docker-plan-move-data.js';
import type { PlanMoveRecord } from '../../src/plan-move.js';
export function dockerPlanJournalFixture() {
  const employeeId = '10000000-0000-4000-8000-000000000001';
  const sessionId = '20000000-0000-4000-8000-000000000002';
  const operationId = '30000000-0000-4000-8000-000000000003';
  const targetSid = '40000000-0000-4000-8000-000000000004';
  const targetOp = '50000000-0000-4000-8000-000000000005';
  const credentialId = '60000000-0000-4000-8000-000000000006';
  const targetCredential = '70000000-0000-4000-8000-000000000007';
  const epoch = '80000000-0000-4000-8000-000000000008';
  const imageId = 'sha256:' + 'a'.repeat(64);
  const original = {
    containerId: 'b'.repeat(64),
    imageId,
    deployment: 'synthetic-office',
    employeeId,
    sessionId,
    home: { type: 'bind', source: '/synthetic-private-home', destination: '/home/agent', readWrite: true },
    mountDigest: 'c'.repeat(64),
    storageDigest: 'd'.repeat(64),
    configurationDigest: 'e'.repeat(64),
  };
  const policy = {
    memoryMaxBytes: 48 * 1024 ** 3,
    memoryHighBytes: 16 * 1024 ** 3,
    swapMaxBytes: 0,
    pidsMax: 512,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  };
  const destination = { ...original, containerId: 'f'.repeat(64) };
  const workerImage = { imageId, sourceImageId: imageId, clientManifestDigest: '1'.repeat(64) };
  const row = DockerEmployeeContinuationRecord.parse({
    version: 2,
    purpose: 'docker-employee-continuation-v2',
    employeeId,
    owner: 'synthetic-owner',
    request: {
      operationId,
      sessionId,
      sessionGeneration: 1,
      containerId: original.containerId,
      imageId,
      expectedPolicyDigest: dockerContinuationDigest(policy),
      expectedDestinationImageId: imageId,
      enterOffice: true,
    },
    sourceDigest: '2'.repeat(64),
    providerSourceDigest: '3'.repeat(64),
    original,
    workerImage,
    policy,
    credentialId,
    phase: 'ready',
    destination,
  });
  const binding = {
    version: 1,
    operationId,
    sessionId,
    sessionGeneration: 1,
    credentialId,
    containerId: destination.containerId,
    imageId,
    originalDigest: dockerContinuationDigest(destination),
    policyDigest: dockerContinuationDigest(policy),
  };
  const seed = DockerPlanMoveSeed.parse({
    version: 1,
    purpose: 'docker-plan-replacement-seed-v1',
    moveId: 'synthetic-move',
    forceBusy: false,
    handoff: 'Continue the synthetic existing task.',
    source: {
      record: row,
      binding,
      providerSourceDigest: row.version === 1 ? '3'.repeat(64) : row.providerSourceDigest,
      observation: {
        kind: 'running',
        init: { pid: 42, startTicks: '1234' },
        provider: { kind: 'observed', viewDigest: '4'.repeat(64) },
      },
    },
    target: {
      sessionId: targetSid,
      sessionGeneration: 2,
      operationId: targetOp,
      credentialId: targetCredential,
      accountId: 'anthropic-target',
      provider: 'anthropic',
      accountSnapshotDigest: '5'.repeat(64),
      accountSource: { kind: 'canonical' },
      templateDigest: dockerProviderRuntimeRecipeDigest(undefined),
      workerImage,
    },
    requestDigest: '7'.repeat(64),
  });
  const state = DockerPlanMoveJournalState.parse({ version: 1, purpose: 'docker-plan-replacement-v1', epoch, seed });
  const record: PlanMoveRecord = {
    id: seed.moveId,
    owner: row.owner,
    employeeId,
    name: 'Synthetic employee',
    oldSession: sessionId,
    newSession: targetSid,
    fromAccount: 'anthropic-source',
    toAccount: seed.target.accountId,
    phase: 'waiting',
    at: 1,
    requestDigest: seed.requestDigest,
    dockerReplacement: state,
  };
  const closed = DockerPlanMoveJournalState.parse({
    ...state,
    sourceStop: {
      phase: 'closed',
      epoch,
      sourceContainerId: destination.containerId,
      sourceConfigurationDigest: destination.configurationDigest,
      sourceInit: seed.source.observation.kind === 'running' ? seed.source.observation.init : null,
      terminalStateDigest: '8'.repeat(64),
    },
  });

  const work = DockerEmployeePlanReplacementWorkRecord.parse({
    version: 3,
    purpose: 'docker-employee-plan-replacement-v3',
    employeeId,
    owner: row.owner,
    request: {
      ...row.request,
      sessionId: targetSid,
      sessionGeneration: 2,
      operationId: targetOp,
      containerId: destination.containerId,
      imageId: destination.imageId,
    },
    original: destination,
    workerImage,
    policy: row.policy,
    credentialId: targetCredential,
    sourceDigest: '9'.repeat(64),
    providerSourceDigest: 'a'.repeat(64),
    phase: 'staged',
    planReplacement: {
      version: 1,
      purpose: 'docker-plan-replacement-provenance-v1',
      moveId: seed.moveId,
      source: {
        binding: seed.source.binding,
        continuationDigest: dockerContinuationDigest(row),
        providerSourceDigest: seed.source.providerSourceDigest,
      },
      account: {
        id: seed.target.accountId,
        provider: seed.target.provider,
        projectionDigest: 'b'.repeat(64),
        contextDigest: 'c'.repeat(64),
      },
    },
  });
  return { record, state, closed, epoch, targetSid, targetOp, work };
}
