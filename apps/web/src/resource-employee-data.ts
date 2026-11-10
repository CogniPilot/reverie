/** Native employee resource observations. These data grant no host effects. */
import { z } from 'zod';
import { NativeOwnerId } from './native-owner-data.js';

const Decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const Limit = z.union([z.literal('max'), Decimal]);
const CpuWeight = z.number().int().min(1).max(10000);
const Cpus = z
  .array(z.number().int().min(0).max(65535))
  .min(1)
  .max(4096)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1] < value));
export const EmployeeResourceRequested = z
  .object({
    memoryHighMiB: z.number().int().positive().max(49152).nullable(),
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
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['uninstalled', 'absent', 'stopped', 'controller-unavailable', 'running']),
    requested: EmployeeResourceRequested.nullable(),
    observed: EmployeeResourceObserved.nullable(),
    perfObserved: z.null(),
    perfObservationReason: z.literal('OWN_PROCESS_PROBE_REQUIRED'),
    capabilities: z
      .object({
        softMemoryLive: z.literal(false),
        cpuWeightLive: z.literal(false),
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
      (value.state === 'uninstalled') !== (value.requested === null)
    ) {
      context.addIssue({ code: 'custom', message: 'Native resource state and observations disagree' });
    }
  });
export type EmployeeResourceStatus = z.infer<typeof EmployeeResourceStatus>;
