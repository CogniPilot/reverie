/** Public fleet resource contract. Values describe policy; they confer no host authority. */
import { z } from 'zod';

const EmployeeId = z.string().uuid();
const Reference = z.string().min(1).max(200);
const MemoryMiB = z.number().int().min(512).max(1048576);
const CpuWeight = z.number().int().min(1).max(10000);
export const FleetPolicySchema = z
  .object({
    memoryHighMiB: MemoryMiB,
    memoryMaxMiB: MemoryMiB,
    cpuWeight: CpuWeight,
    perfEnabled: z.boolean(),
  })
  .strict()
  .refine((value) => value.memoryHighMiB < value.memoryMaxMiB, {
    message: 'The soft RAM threshold must be below the hard RAM ceiling',
  });
export const FleetPoolSchema = z
  .object({
    // Required null means a known unbounded parent soft threshold, not unknown.
    memoryHighMiB: MemoryMiB.nullable(),
    memoryMaxMiB: MemoryMiB,
    cpuWeight: CpuWeight,
    allowedCpus: z.array(z.number().int().min(0).max(65535)).min(1).max(4096),
  })
  .strict()
  .refine(
    (value) =>
      (value.memoryHighMiB === null || value.memoryHighMiB < value.memoryMaxMiB) &&
      new Set(value.allowedCpus).size === value.allowedCpus.length,
    {
      message: 'Use an unbounded soft threshold or one below the pool ceiling, and unique CPU identifiers',
    }
  );
export const FleetPreviewRequestSchema = z
  .object({
    expectedRevision: Reference,
    targetImageId: Reference,
    policies: z
      .array(FleetPolicySchema.safeExtend({ employeeId: EmployeeId }))
      .min(1)
      .max(256),
    pool: FleetPoolSchema,
    canaryEmployeeId: EmployeeId,
    handoff: z
      .string()
      .trim()
      .min(1)
      .max(12000)
      .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)),
  })
  .strict()
  .superRefine((value, context) => {
    const selected = new Set(value.policies.map((policy) => policy.employeeId));
    if (selected.size !== value.policies.length || !selected.has(value.canaryEmployeeId))
      context.addIssue({ code: 'custom', message: 'Select unique employees and a canary from that fleet' });
  });
export const FleetApplyRequestSchema = z
  .object({
    previewId: Reference,
    expectedRevision: Reference,
  })
  .strict();
export const FleetResultRequestSchema = z.object({ operationId: Reference }).strict();

export type FleetPolicy = z.infer<typeof FleetPolicySchema>;
export type FleetPool = z.infer<typeof FleetPoolSchema>;
export type FleetPreviewRequest = z.infer<typeof FleetPreviewRequestSchema>;
export interface FleetBlocker {
  code: string;
  message: string;
  remedy: string;
}
/** A null observation is unknown. A null controller value means observed unbounded/untested. */
export interface FleetObservedPolicy {
  memoryHighMiB: number | null;
  memoryMaxMiB: number | null;
  cpuWeight: number | null;
  perfEnabled: boolean | null;
}
export interface FleetEmployee {
  employeeId: string;
  name: string;
  state: string;
  reason: string | null;
  desired: FleetPolicy | null;
  observed: FleetObservedPolicy | null;
  desiredImageId: string | null;
  observedImageId: string | null;
}
export interface FleetOperation {
  id: string;
  state: string;
  blocksFurtherChanges: boolean;
  employees: Array<{ employeeId: string; state: string; verified: boolean; reason: string | null }>;
  message: string;
}
export interface FleetStatus {
  version: 1;
  revision: string | null;
  canPreview: boolean;
  blockers: FleetBlocker[];
  images: Array<{ id: string; label: string }>;
  /** Outer null is unavailable/unknown; an object's high=null is known unbounded. */
  pool: { desired: FleetPool | null; observed: FleetPool | null };
  employees: FleetEmployee[];
  /** Null means host history could not be read; it is never proof of no pending rollout. */
  operations: FleetOperation[] | null;
  /** Null means unmanaged/orphaned laptop coverage has not been observed. */
  unmanagedLaptops: Array<{ id: string; reason: string }> | null;
}
export interface FleetPreview {
  previewId: string;
  operationId: string;
  revision: string;
  expiresAt: number;
  canApply: boolean;
  blockers: FleetBlocker[];
  steps: Array<{ employeeId: string; name: string; action: string }>;
  request: FleetPreviewRequest;
}
