/** Closed native Q wire DATA. Observations and approvals confer no authority. */
import { z } from 'zod';
import { NativeOwnerId, NativeOwnerPrincipal, NativePoolPolicy } from './native-owner-data.js';
import { FLEET_MAINTENANCE_PURPOSE } from './resource-owner-authority.js';
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const FleetApprovalData = z
  .object({
    operationId: NativeOwnerId,
    previewId: NativeOwnerId,
    cohortDigest: Digest,
    poolPolicyDigest: Digest,
    coverageDigest: Digest,
    revisionDigest: Digest,
  })
  .strict()
  .readonly();
const envelope = { purpose: z.literal(FLEET_MAINTENANCE_PURPOSE), version: z.literal(1), requestId: NativeOwnerId };
export const NativeFleetPreviewData = z
  .object({
    ...envelope,
    kind: z.literal('fleet-preview'),
    approval: FleetApprovalData,
    policy: NativePoolPolicy,
    status: z.enum(['target-verification-required', 'awaiting-maintenance-consent']),
    expiresAtEpochMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();
export const NativeFleetMigrationData = z
  .object({
    ...envelope,
    kind: z.literal('fleet-migration-result'),
    approval: FleetApprovalData,
    phase: z.literal('pool-configured'),
    policy: NativePoolPolicy,
    configurationDigest: Digest,
    domainDigest: Digest,
    restore: z
      .array(z.object({ employeeId: NativeOwnerId, sessionId: NativeOwnerId }).strict())
      .max(256)
      .readonly(),
  })
  .strict()
  .readonly();
export const NativeFleetPreviewRequest = z.object({}).strict();
export const NativeFleetApplyRequest = z
  .object({
    previewId: NativeOwnerId,
    expectedRevision: Digest,
    consent: z.literal(true),
    verb: z.literal('migrate-pool'),
  })
  .strict();
export const NativeFleetResultRequest = z.object({ operationId: NativeOwnerId }).strict();
export const FleetPreviewChallenge = z
  .object({
    ...envelope,
    kind: z.literal('fleet-preview-owner-check'),
    nonce: NativeOwnerId,
    principal: NativeOwnerPrincipal,
  })
  .strict();
export const FleetMigrationChallenge = z
  .object({
    ...envelope,
    kind: z.literal('fleet-maintenance-owner-check'),
    nonce: NativeOwnerId,
    principal: NativeOwnerPrincipal,
    approval: FleetApprovalData,
    verb: z.literal('migrate-pool'),
  })
  .strict();
export type NativeFleetPreview = z.infer<typeof NativeFleetPreviewData>;
export type NativeFleetMigration = z.infer<typeof NativeFleetMigrationData>;
