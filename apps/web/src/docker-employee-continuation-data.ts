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
export const DockerEmployeeContinuationRecord = z
  .object({
    version: z.literal(1),
    purpose: z.literal('docker-employee-continuation-v1'),
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
    phase: DockerEmployeeContinuationPhase,
    pool: DockerEmployeePool.optional(),
    destination: DockerEmployeeOriginal.optional(),
  })
  .strict()
  .refine(
    (row) =>
      row.employeeId === row.original.employeeId &&
      row.request.sessionId === row.original.sessionId &&
      row.request.containerId === row.original.containerId &&
      row.request.imageId === row.original.imageId &&
      row.workerImage.sourceImageId === row.original.imageId &&
      row.request.expectedDestinationImageId === row.workerImage.imageId &&
      (!row.destination ||
        (row.destination.employeeId === row.employeeId &&
          row.destination.sessionId === row.original.sessionId &&
          row.destination.imageId === row.workerImage.imageId &&
          row.destination.containerId !== row.original.containerId &&
          row.destination.storageDigest === row.original.storageDigest))
  );
export type DockerEmployeeContinuationRecord = z.infer<typeof DockerEmployeeContinuationRecord>;
