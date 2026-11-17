/** Constructive maximum DATA for this closed native journal protocol.
 * The witness is decoded by the same owning schemas. It grants no effect credit. */
import {
  DockerPlanMoveJournalState,
  dockerPlanMoveHandoffDigest,
  type DockerPlanMoveSeed,
} from './docker-plan-move-data.js';
import { DockerEmployeePlanReplacementWorkRecord } from './docker-employee-continuation-data.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { dockerPlanMaterial } from './docker-plan-material.js';
import { DockerPlanSourceContext } from './docker-plan-source-data.js';
const MAX = Number.MAX_SAFE_INTEGER,
  hex = 'f'.repeat(64),
  decimal = '9'.repeat(20),
  escaped = '\0'.repeat(4096);
const directory = { dev: decimal, ino: decimal, uid: MAX, gid: MAX, mode: 0o700 as const };
/** Each relative path permits at most 4096 UTF-8 bytes including one separator
 * per component. Quotes attain the maximum two JSON bytes per allowed byte;
 * 32 components attain the largest array overhead. Required native filename
 * and role bytes remain genuine schema values rather than unchecked padding. */
function maximumContext(provider: 'anthropic' | 'openai'): DockerPlanSourceContext {
  const nativeId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const prefix = provider === 'anthropic' ? 'projects' : 'sessions';
  const filename = (provider === 'anthropic' ? '' : '-') + nativeId + '.jsonl';
  const quotedBytes = 4096 - 32 - Buffer.byteLength(prefix) - Buffer.byteLength(filename);
  const middle = Array.from({ length: 30 }, (_, i) =>
    '"'.repeat(Math.floor(quotedBytes / 30) + (i < quotedBytes % 30 ? 1 : 0))
  );
  return DockerPlanSourceContext.parse({
    source: {
      kind: 'home',
      relative: Array.from({ length: 32 }, () => '"'.repeat(127)),
      dev: '18446744073709551615',
      ino: '18446744073709551615',
    },
    roles:
      provider === 'anthropic'
        ? ['claude-projects', 'claude-instructions']
        : ['codex-sessions', 'codex-history', 'codex-instructions'],
    conversation: { nativeId, relative: [prefix, ...middle, filename], sha256: hex },
  });
}
const policy = {
  memoryMaxBytes: MAX,
  memoryHighBytes: MAX,
  swapMaxBytes: MAX,
  pidsMax: 1048576,
  cpuWeight: 10000,
  allowedCpus: Array.from({ length: 256 }, (_, i) => 3840 + i),
  pool: {
    memoryMaxBytes: MAX,
    swapMaxBytes: MAX,
    pidsMax: 1048576,
    cpuWeight: 10000,
    allowedCpus: Array.from({ length: 256 }, (_, i) => 3840 + i),
  },
};
export function dockerPlanMaximumStates(seed: DockerPlanMoveSeed, epoch: string): DockerPlanMoveJournalState[] {
  const source = seed.source.record.destination!,
    target = seed.target;
  const material = { context: maximumContext(target.provider), authDigest: hex };
  const resolved = dockerPlanMaterial(
    {
      operationId: target.operationId,
      sessionId: target.sessionId,
      provider: target.provider,
      accountId: target.accountId,
      context: material.context,
    },
    material.authDigest
  );
  const cid = source.containerId === hex ? 'e'.repeat(64) : hex;
  const request = {
    ...seed.source.record.request,
    operationId: target.operationId,
    sessionId: target.sessionId,
    sessionGeneration: target.sessionGeneration,
    containerId: source.containerId,
    imageId: source.imageId,
    expectedPolicyDigest: dockerContinuationDigest(policy),
    expectedDestinationImageId: target.workerImage.imageId,
    enterOffice: false,
  };
  const baseRequest = {
    version: 1 as const,
    purpose: 'reverie-ephemeral-directory-restore-v1' as const,
    operationId: target.operationId,
    employeeId: seed.source.record.employeeId,
    sessionId: source.sessionId,
    sessionGeneration: target.sessionGeneration,
    invocation: MAX,
    layout: 'operator-sessions' as const,
    root: directory,
  };
  const ack = {
    ...baseRequest,
    purpose: 'reverie-ephemeral-directories-ready-v1' as const,
    sessionGeneration: MAX,
    scratch: directory,
    tmp: directory,
  };
  const ephemeralRestoration = {
    version: 1,
    purpose: 'reverie-ephemeral-restoration-v1',
    attempts: Array.from({ length: 32 }, (_, i) => ({
      ordinal: i + 1,
      name: 'reverie-boxed-ephemeral-' + hex,
      imageId: target.workerImage.imageId,
      configurationDigest: hex,
      rootSource: escaped,
      request: {
        ...baseRequest,
        invocation: i + 1,
        forbidden: Array.from({ length: 16 }, () => ({ dev: decimal, ino: decimal })),
      },
      phase: 'completed',
      containerId: hex,
      ack,
    })),
    continuation: { attemptOrdinal: 32, invocation: MAX, phase: 'completed', containerId: hex, ack },
  };
  const roles = ['storage-holder', 'anchor', 'pool-helper', 'leaf-helper', 'identity-helper'] as const;
  const tasks = roles.map((role) => ({
    role,
    name: 'reverie-boxed-' + 'z'.repeat(100),
    imageId: target.workerImage.imageId,
    configurationDigest: hex,
    phase: 'completed',
    containerId: hex,
    resultDigest: hex,
  }));
  const work = DockerEmployeePlanReplacementWorkRecord.parse({
    version: 3,
    purpose: 'docker-employee-plan-replacement-v3',
    employeeId: seed.source.record.employeeId,
    ...(seed.source.record.owner === undefined ? {} : { owner: seed.source.record.owner }),
    request,
    sourceDigest: hex,
    providerSourceDigest: hex,
    original: source,
    workerImage: target.workerImage,
    policy,
    credentialId: target.credentialId,
    tasks,
    ephemeralRestoration,
    phase: 'destination-issued',
    pool: { containerId: hex, cgroupParent: escaped, policyDigest: hex, physicalDigest: hex },
    destination: {
      ...source,
      containerId: cid,
      imageId: target.workerImage.imageId,
      deployment: 'z'.repeat(100),
      sessionId: target.sessionId,
      mountDigest: hex,
      storageDigest: hex,
      configurationDigest: hex,
    },
    planReplacement: {
      version: 1,
      purpose: 'docker-plan-replacement-provenance-v1',
      ...(target.runtimeNamespace ? { runtimeNamespace: target.runtimeNamespace } : {}),
      moveId: seed.moveId,
      source: {
        binding: seed.source.binding,
        continuationDigest: dockerContinuationDigest(seed.source.record),
        providerSourceDigest: seed.source.providerSourceDigest,
        ephemeralSessionId: source.sessionId,
        networkIds: Array.from({ length: 16 }, (_, i) => 'f'.repeat(63) + i.toString(16)),
      },
      account: {
        id: target.accountId,
        provider: target.provider,
        projectionDigest: resolved.projectionDigest,
        contextDigest: resolved.contextInputDigest,
      },
    },
  });
  const state = {
    version: 1,
    purpose: 'docker-plan-replacement-v1',
    epoch,
    seed,
    sourceStop: {
      phase: 'closed',
      epoch,
      sourceContainerId: source.containerId,
      sourceConfigurationDigest: source.configurationDigest,
      sourceInit: seed.source.observation.kind === 'running' ? seed.source.observation.init : null,
      terminalStateDigest: hex,
    },
    sourceReader: {
      version: 1,
      purpose: 'docker-plan-source-reader-v1',
      name: 'reverie-boxed-' + 'z'.repeat(100),
      imageId: target.workerImage.imageId,
      configurationDigest: hex,
      phase: 'closed',
      containerId: hex,
      init: { pid: MAX, startTicks: decimal },
      terminalStateDigest: hex,
    },
    work,
    material,
  };
  const published = {
    ...state,
    work: {
      ...work,
      phase: 'ready',
      tasks: tasks.map((task) =>
        task.role === 'storage-holder' || task.role === 'anchor'
          ? {
              role: task.role,
              name: task.name,
              imageId: task.imageId,
              configurationDigest: hex,
              phase: 'running',
              containerId: hex,
              initPid: MAX,
              initStartTicks: decimal,
            }
          : task
      ),
    },
    paidDispatch: {
      phase: 'issued',
      epoch,
      operationId: target.operationId,
      sessionId: target.sessionId,
      containerId: cid,
      recipeDigest: hex,
    },
    companyPublication: { phase: 'published', digest: hex },
    handoff: { phase: 'submitted', digest: dockerPlanMoveHandoffDigest(seed.handoff) },
  };
  return [DockerPlanMoveJournalState.parse(state), DockerPlanMoveJournalState.parse(published)];
}
export function dockerPlanMaximumStateBytes(seed: DockerPlanMoveSeed, epoch: string): number {
  return Math.max(...dockerPlanMaximumStates(seed, epoch).map((value) => Buffer.byteLength(JSON.stringify(value))));
}
/** Also reserve every later coarse status/finalizer field. Decoded by RecordSchema
 * at the store boundary; all native timestamps are safe integers in this version. */
export function dockerPlanMaximumRecord<T extends { dockerReplacement?: DockerPlanMoveJournalState }>(record: T): T {
  if (!record.dockerReplacement) throw Error('Native settlement record required');
  const state = record.dockerReplacement;
  const maximum = dockerPlanMaximumStates(state.seed, state.epoch).sort(
    (a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a))
  )[0]!;
  return {
    ...record,
    dockerReplacement: maximum,
    name: '\0'.repeat(100),
    fromAccount: '\0'.repeat(100),
    phase: 'recovery-required',
    at: MAX,
    error: '\0'.repeat(4000),
    sourceStopRequested: true,
    sourceCleanupVerified: true,
    recoveryAction: 'adopt-existing',
    recoveredAt: MAX,
  };
}
