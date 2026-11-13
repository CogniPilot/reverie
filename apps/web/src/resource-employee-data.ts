/** Native employee resource observations. These data grant no host effects. */
import { z } from 'zod';
import { NativeOwnerId } from './native-owner-data.js';

const Decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const Limit = z.union([z.literal('max'), Decimal]);
const CpuWeight = z.number().int().min(1).max(10000);
const MemoryHighMiB = z.number().int().min(1).max(49152);
const Revision = z.string().regex(/^[a-f0-9]{64}$/);
export const EmployeePolicyEditApproval = z
  .object({
    sessionId: NativeOwnerId,
    operationId: NativeOwnerId,
    expectedRevision: Revision,
    memoryHighMiB: MemoryHighMiB,
    cpuWeight: CpuWeight,
  })
  .strict()
  .readonly();
export type EmployeePolicyEditApproval = z.infer<typeof EmployeePolicyEditApproval>;
export const EmployeePolicyEditResult = z
  .object({
    version: z.literal(1),
    employeeId: NativeOwnerId,
    sessionId: NativeOwnerId,
    operationId: NativeOwnerId,
    state: z.literal('applied'),
    memoryHighMiB: MemoryHighMiB,
    cpuWeight: CpuWeight,
  })
  .strict();
export type EmployeePolicyEditResult = z.infer<typeof EmployeePolicyEditResult>;
const Cpus = z
  .array(z.number().int().min(0).max(65535))
  .min(1)
  .max(4096)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1] < value));
export const EmployeeResourceRequested = z
  .object({
    memoryHighMiB: MemoryHighMiB.nullable(),
    memoryMaxMiB: z.literal(49152),
    cpuWeight: CpuWeight,
    allowedCpus: Cpus,
    perfPolicy: z.enum(['off', 'task-v1', 'task-v2']),
  })
  .strict()
  .refine((value) => value.memoryHighMiB === null || value.memoryHighMiB <= value.memoryMaxMiB);
export const EmployeeResourceObserved = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    pid: z.number().int().min(2).max(4294967295),
    processStart: Decimal,
    leafDevice: Decimal,
    leafInode: Decimal,
    memoryHighBytes: Limit,
    memoryMaxBytes: Limit,
    memoryCurrentBytes: Decimal,
    memorySwapMaxBytes: Limit,
    cpuWeight: CpuWeight,
    cpuMax: z.string().regex(/^(max|[1-9][0-9]*) [1-9][0-9]*$/),
    allowedCpus: Cpus,
  })
  .strict();
export const EmployeeResourceStatus = z
  .object({
    version: z.literal(1),
    employeeId: NativeOwnerId,
    sessionId: NativeOwnerId,
    revision: Revision,
    state: z.enum(['uninstalled', 'absent', 'stopped', 'controller-unavailable', 'running']),
    requested: EmployeeResourceRequested.nullable(),
    observed: EmployeeResourceObserved.nullable(),
    perfObserved: z.null(),
    perfObservationReason: z.literal('OWN_PROCESS_PROBE_REQUIRED'),
    capabilities: z
      .object({
        softMemoryLive: z.boolean(),
        cpuWeightLive: z.boolean(),
        hardMemoryReplacement: z.literal(false),
        perfReplacement: z.literal(false),
        gpuReplacement: z.literal(false),
      })
      .strict(),
    readOnly: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === 'running') !== (value.observed !== null) ||
      (value.state === 'uninstalled') !== (value.requested === null) ||
      ((value.capabilities.softMemoryLive || value.capabilities.cpuWeightLive) &&
        (value.state !== 'running' || value.requested?.memoryHighMiB == null))
    ) {
      context.addIssue({ code: 'custom', message: 'Native resource state and observations disagree' });
    }
  });
export type EmployeeResourceStatus = z.infer<typeof EmployeeResourceStatus>;

const Generation = z.string().regex(/^[1-9][0-9]*$/);
const UnavailableMetric = z
  .object({
    state: z.literal('unavailable'),
    reason: z.enum(['missing', 'permission-denied', 'malformed', 'read-error']),
  })
  .strict();
const Stall = z
  .object({
    avg10Hundredths: z.number().int().min(0).max(10000),
    avg60Hundredths: z.number().int().min(0).max(10000),
    avg300Hundredths: z.number().int().min(0).max(10000),
    totalUs: Decimal,
  })
  .strict();
const MemoryObservation = z
  .object({
    binding: z
      .object({
        containerId: Revision,
        initPid: z.number().int().min(2).max(4294967295),
        initProcessStart: Decimal,
        leafDevice: Decimal,
        leafInode: Decimal,
      })
      .strict(),
    sampledAtEpochMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sampleDurationUs: Decimal,
    pressure: z.discriminatedUnion('state', [
      UnavailableMetric,
      z.object({ state: z.literal('available'), some: Stall, full: Stall }).strict(),
    ]),
    events: z.discriminatedUnion('state', [
      UnavailableMetric,
      z
        .object({
          state: z.literal('available'),
          low: Decimal,
          high: Decimal,
          max: Decimal,
          oom: Decimal,
          oomKill: Decimal,
          oomGroupKill: Decimal.nullable(),
        })
        .strict(),
    ]),
  })
  .strict();

/** Native compound DATA, never a status, policy or provider-liveness grant. */
export const EmployeeMemoryDiagnostics = z
  .object({
    version: z.literal(1),
    purpose: z.literal('employee-memory-diagnostics-v1'),
    employeeId: NativeOwnerId,
    sessionId: NativeOwnerId,
    sessionGeneration: Generation,
    state: z.enum(['observed', 'uninstalled', 'absent', 'stopped', 'controller-unavailable']),
    observation: MemoryObservation.nullable(),
    resources: EmployeeResourceStatus,
    readOnly: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    const resource = value.resources,
      observed = resource.observed,
      sample = value.observation;
    if (
      resource.employeeId !== value.employeeId ||
      resource.sessionId !== value.sessionId ||
      (value.state === 'observed'
        ? resource.state !== 'running' || !sample
        : resource.state !== value.state || sample !== null) ||
      (sample &&
        (!observed ||
          sample.binding.containerId !== observed.containerId ||
          sample.binding.initPid !== observed.pid ||
          sample.binding.initProcessStart !== observed.processStart ||
          sample.binding.leafDevice !== observed.leafDevice ||
          sample.binding.leafInode !== observed.leafInode))
    )
      context.addIssue({ code: 'custom', message: 'Memory sample and original resource binding disagree' });
  });
export type EmployeeMemoryDiagnostics = z.infer<typeof EmployeeMemoryDiagnostics>;

const AdvisoryTime = z.number().int().positive().max(8_640_000_000_000_000);
const AdvisoryTimes = { sampledAtEpochMs: AdvisoryTime, evaluatedAtEpochMs: AdvisoryTime };
/** Application-only diagnostic; no native protocol, liveness or policy authority. */
export const EmployeeMemoryAdvisory = z.discriminatedUnion('state', [
  z.object({ state: z.literal('warning'), code: z.literal('high-memory-stall'), ...AdvisoryTimes }).strict(),
  z.object({ state: z.literal('not-observed'), ...AdvisoryTimes }).strict(),
  z
    .object({
      state: z.literal('unknown'),
      reason: z.enum([
        'native-observation-unconfirmed',
        'no-sample',
        'pressure-unavailable',
        'stale-sample',
        'future-sample',
        'sample-time-unavailable',
        'server-clock-unavailable',
      ]),
      sampledAtEpochMs: AdvisoryTime.nullable(),
      evaluatedAtEpochMs: AdvisoryTime.nullable(),
    })
    .strict(),
]);
export type EmployeeMemoryAdvisory = z.infer<typeof EmployeeMemoryAdvisory>;

/** Heuristic only: >=50% recent stalls, sampled no more than 30 seconds before evaluation.
 * Cumulative events never establish recent pressure or a cause. Bad clocks stay unknown. */
export function memoryPressureAdvisory(
  snapshot: EmployeeMemoryDiagnostics | null,
  evaluatedAt: number
): EmployeeMemoryAdvisory {
  const time = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000 ? value : null;
  const sample = snapshot?.observation,
    evaluatedAtEpochMs = time(evaluatedAt),
    sampledAtEpochMs = time(sample?.sampledAtEpochMs);
  const unknown = (
    reason: Extract<EmployeeMemoryAdvisory, { state: 'unknown' }>['reason']
  ): EmployeeMemoryAdvisory => ({ state: 'unknown', reason, sampledAtEpochMs, evaluatedAtEpochMs });
  if (evaluatedAtEpochMs === null) return unknown('server-clock-unavailable');
  if (!snapshot) return unknown('native-observation-unconfirmed');
  if (!sample) return unknown('no-sample');
  if (sampledAtEpochMs === null) return unknown('sample-time-unavailable');
  const age = evaluatedAtEpochMs - sampledAtEpochMs;
  if (age < 0) return unknown('future-sample');
  if (age > 30_000) return unknown('stale-sample');
  if (sample.pressure.state !== 'available') return unknown('pressure-unavailable');
  const timing = { sampledAtEpochMs, evaluatedAtEpochMs };
  return sample.pressure.some.avg10Hundredths >= 5000 || sample.pressure.full.avg10Hundredths >= 5000
    ? { state: 'warning', code: 'high-memory-stall', ...timing }
    : { state: 'not-observed', ...timing };
}

/** Application projection distinguishes an independent fallback read from the native compound. */
export type EmployeeMemoryView = {
  version: 1;
  employeeId: string;
  sessionId: string;
  sessionGeneration: string;
  resources: EmployeeResourceStatus;
  advisory: EmployeeMemoryAdvisory;
} & (
  | {
      source: 'native-compound';
      diagnostics: { kind: 'snapshot'; value: EmployeeMemoryDiagnostics };
    }
  | {
      source: 'independent-status-read';
      diagnostics: { kind: 'unavailable'; reason: 'native-observation-unconfirmed' };
    }
);
