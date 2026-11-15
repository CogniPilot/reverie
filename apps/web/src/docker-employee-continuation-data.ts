import { EphemeralRestoration } from './docker-ephemeral-data.js';
import { DockerContinuationTask } from './docker-continuation-task.js';
/** Private Docker continuation metadata. Correlation never grants engine or native authority. */
import { z } from 'zod';
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().nonnegative().safe();
const cpus = z
  .array(z.number().int().nonnegative().max(4095))
  .min(1)
  .max(256)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1]! < value));
export const DockerEmployeePoolPolicy = z
  .object({
    memoryMaxBytes: bytes.refine((value) => value >= 512 * 1024 * 1024),
    swapMaxBytes: bytes,
    pidsMax: z.number().int().positive().max(1048576),
    cpuWeight: z.number().int().min(1).max(10000),
    allowedCpus: cpus,
  })
  .strict();
export const DockerEmployeeResourcePolicy = z
  .object({
    memoryMaxBytes: bytes.refine((value) => value >= 512 * 1024 * 1024),
    memoryHighBytes: bytes.positive().nullable(),
    swapMaxBytes: bytes,
    pidsMax: z.number().int().positive().max(1048576),
    cpuWeight: z.number().int().min(1).max(10000),
    allowedCpus: cpus,
    pool: DockerEmployeePoolPolicy,
  })
  .strict()
  .refine(
    (value) =>
      (value.memoryHighBytes === null || value.memoryHighBytes <= value.memoryMaxBytes) &&
      value.memoryMaxBytes <= value.pool.memoryMaxBytes &&
      value.swapMaxBytes <= value.pool.swapMaxBytes &&
      value.pidsMax <= value.pool.pidsMax &&
      value.allowedCpus.every((cpu) => value.pool.allowedCpus.includes(cpu))
  );
export type DockerEmployeeResourcePolicy = z.infer<typeof DockerEmployeeResourcePolicy>;
export const DockerEmployeeContinuationRequest = z
  .object({
    operationId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    containerId: digest,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expectedPolicyDigest: digest,
    expectedDestinationImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    enterOffice: z.boolean(),
  })
  .strict();
export type DockerEmployeeContinuationRequest = z.infer<typeof DockerEmployeeContinuationRequest>;
const home = z
  .object({
    type: z.enum(['bind', 'volume']),
    source: z.string().min(1).max(4096),
    destination: z.literal('/home/agent'),
    readWrite: z.literal(true),
  })
  .strict();
export const DockerEmployeeOriginal = z
  .object({
    containerId: digest,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    deployment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    employeeId: uuid,
    sessionId: uuid,
    home,
    mountDigest: digest,
    storageDigest: digest,
    configurationDigest: digest,
  })
  .strict();
export type DockerEmployeeOriginal = z.infer<typeof DockerEmployeeOriginal>;
export const DockerEmployeeBinding = z
  .object({
    version: z.literal(1),
    operationId: uuid,
    credentialId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    containerId: digest,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    originalDigest: digest,
    policyDigest: digest,
  })
  .strict();
export type DockerEmployeeBinding = z.infer<typeof DockerEmployeeBinding>;
export const DockerEmployeeWorkerImage = z
  .object({
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    clientManifestDigest: digest,
  })
  .strict();
export type DockerEmployeeWorkerImage = z.infer<typeof DockerEmployeeWorkerImage>;
export const DockerEmployeePool = z
  .object({
    containerId: digest,
    cgroupParent: z.string().min(1).max(4096),
    policyDigest: digest,
    physicalDigest: digest,
  })
  .strict();
export type DockerEmployeePool = z.infer<typeof DockerEmployeePool>;
export const DockerEmployeeContinuationPhase = z.enum([
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
]);
export type DockerEmployeeContinuationPhase = z.infer<typeof DockerEmployeeContinuationPhase>;
const continuationRecordFields = {
  employeeId: uuid,
  owner: z.string().max(200).optional(),
  request: DockerEmployeeContinuationRequest,
  sourceDigest: digest,
  original: DockerEmployeeOriginal,
  workerImage: DockerEmployeeWorkerImage,
  policy: DockerEmployeeResourcePolicy,
  credentialId: uuid,
  tasks: z
    .array(DockerContinuationTask)
    .max(5)
    .refine((tasks) => new Set(tasks.map((task) => task.role)).size === tasks.length)
    .optional(),
  ephemeralRestoration: z.lazy(() => EphemeralRestoration).optional(),
  phase: DockerEmployeeContinuationPhase,
  pool: DockerEmployeePool.optional(),
  destination: DockerEmployeeOriginal.optional(),
};
const legacyContinuationRecord = z
  .object({
    version: z.literal(1),
    purpose: z.literal('docker-employee-continuation-v1'),
    ...continuationRecordFields,
  })
  .strict();
const currentContinuationRecord = z
  .object({
    version: z.literal(2),
    purpose: z.literal('docker-employee-continuation-v2'),
    ...continuationRecordFields,
    providerSourceDigest: digest,
  })
  .strict();
const planIdentifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
/** Correlation DATA for one explicit cross-SID replacement. Account/credential
 * contents and effect authority never enter this read projection. */
/** Exact Engine network membership DATA. Names, IPs and aliases are never copied. */
export const DockerPlanReplacementNetworkIds = z
  .array(digest)
  .min(1)
  .max(16)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id));
export type DockerPlanReplacementNetworkIds = z.infer<typeof DockerPlanReplacementNetworkIds>;
export const DockerEmployeePlanReplacementProvenance = z
  .object({
    version: z.literal(1),
    purpose: z.literal('docker-plan-replacement-provenance-v1'),
    moveId: planIdentifier,
    source: z
      .object({
        binding: DockerEmployeeBinding,
        continuationDigest: digest,
        providerSourceDigest: digest,
        ephemeralSessionId: uuid.optional(),
        networkIds: DockerPlanReplacementNetworkIds.optional(),
      })
      .strict(),
    account: z
      .object({
        id: planIdentifier,
        provider: z.enum(['anthropic', 'openai']),
        projectionDigest: digest,
        contextDigest: digest,
      })
      .strict(),
  })
  .strict();
const planReplacementRecord = z
  .object({
    version: z.literal(3),
    purpose: z.literal('docker-employee-plan-replacement-v3'),
    ...continuationRecordFields,
    providerSourceDigest: digest,
    planReplacement: DockerEmployeePlanReplacementProvenance,
  })
  .strict();
type CorrelatedRecord =
  | z.infer<typeof legacyContinuationRecord>
  | z.infer<typeof currentContinuationRecord>
  | z.infer<typeof planReplacementRecord>;
function correlatedRecord(row: CorrelatedRecord): boolean {
  const common =
    (!row.ephemeralRestoration ||
      row.ephemeralRestoration.attempts.every(
        (attempt, index) =>
          attempt.ordinal === index + 1 &&
          attempt.request.operationId === row.request.operationId &&
          attempt.request.employeeId === row.employeeId &&
          attempt.request.sessionId ===
            (row.version === 3
              ? (row.planReplacement.source.ephemeralSessionId ?? row.original.sessionId)
              : row.request.sessionId) &&
          attempt.request.sessionGeneration === row.request.sessionGeneration &&
          attempt.imageId === row.workerImage.imageId
      )) &&
    row.employeeId === row.original.employeeId &&
    row.request.containerId === row.original.containerId &&
    row.request.imageId === row.original.imageId &&
    row.workerImage.sourceImageId === row.original.imageId &&
    row.request.expectedDestinationImageId === row.workerImage.imageId;
  if (!common) return false;
  if (row.version !== 3)
    return (
      row.request.sessionId === row.original.sessionId &&
      (!row.destination ||
        (row.destination.employeeId === row.employeeId &&
          row.destination.sessionId === row.original.sessionId &&
          row.destination.imageId === row.workerImage.imageId &&
          row.destination.containerId !== row.original.containerId &&
          row.destination.storageDigest === row.original.storageDigest))
    );
  const source = row.planReplacement.source.binding;
  return (
    source.sessionId === row.original.sessionId &&
    source.containerId === row.original.containerId &&
    source.imageId === row.original.imageId &&
    row.request.sessionId !== source.sessionId &&
    row.request.sessionGeneration === source.sessionGeneration + 1 &&
    row.request.operationId !== source.operationId &&
    row.credentialId !== source.credentialId &&
    (!row.destination ||
      (row.destination.employeeId === row.employeeId &&
        row.destination.sessionId === row.request.sessionId &&
        row.destination.imageId === row.workerImage.imageId &&
        row.destination.containerId !== row.original.containerId &&
        JSON.stringify(row.destination.home) === JSON.stringify(row.original.home)))
  );
}
/** Mutable work exists only in the PlanMoves journal. It is not a Company
 * provider projection and cannot authorize normal continuation dispatch. */
export const DockerEmployeePlanReplacementWorkRecord = planReplacementRecord.refine(correlatedRecord);
export type DockerEmployeePlanReplacementWorkRecord = z.infer<typeof DockerEmployeePlanReplacementWorkRecord>;
function publishedPlanRecord(row: CorrelatedRecord): boolean {
  if (row.version !== 3) return true;
  if (!['provider-issued', 'ready'].includes(row.phase) || !row.pool || !row.destination || !row.tasks) return false;
  const phases = new Map(row.tasks.map((task) => [task.role, task.phase]));
  return (
    phases.get('storage-holder') === 'running' &&
    phases.get('identity-helper') === 'completed' &&
    phases.get('leaf-helper') === 'completed' &&
    row.tasks.every((task) =>
      task.role === 'anchor' || task.role === 'storage-holder' ? task.phase === 'running' : task.phase === 'completed'
    )
  );
}
export const DockerEmployeeContinuationRecord = z
  .discriminatedUnion('version', [legacyContinuationRecord, currentContinuationRecord, planReplacementRecord])
  .refine(correlatedRecord)
  .refine(publishedPlanRecord);
export type DockerEmployeeContinuationRecord = z.infer<typeof DockerEmployeeContinuationRecord>;
