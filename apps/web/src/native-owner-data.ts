/** Existing fixed native owner/principal and pool-policy wire DATA codecs. */
import { z } from 'zod';

export const NativeOwnerId = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase() && v !== '00000000-0000-0000-0000-000000000000');
export const NativeOwnerPrincipal = z
  .object({
    accountId: NativeOwnerId,
    personId: z.union([z.literal('owner'), NativeOwnerId]),
    sessionEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();
export const NativePoolPolicy = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-docker-worker-pool-v1'),
    deployment: z.string(),
    instanceRoot: z.string(),
    engineId: NativeOwnerId,
    anchorImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    controllerImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    websiteContainer: z.string().regex(/^[a-f0-9]{64}$/),
    brokerUid: z.number().int().nonnegative(),
    brokerGid: z.number().int().nonnegative(),
    memoryMaxMiB: z.literal(49152),
    poolTasksMax: z.number().int().positive(),
    cpuWeight: z.number().int().min(1).max(10000),
    allowedCpus: z.array(z.number().int().nonnegative()).min(1).readonly(),
    employeeMemoryHighMiB: z.record(NativeOwnerId, z.number().int().positive().max(49152)).readonly(),
  })
  .strict()
  .readonly();
