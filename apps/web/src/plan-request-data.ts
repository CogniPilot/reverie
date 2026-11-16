/** Plan request wire DATA only; importing the schema never loads runtime effects. */
import { z } from 'zod';
import { PlanRequestId } from './plan-request-capability.js';

export const PlanRequestSchema = z
  .object({
    id: PlanRequestId,
    owner: z.string().optional(),
    requestedBy: PlanRequestId.optional(),
    employeeId: PlanRequestId,
    sessionId: PlanRequestId,
    name: z.string().max(100),
    fromAccount: PlanRequestId,
    toAccount: PlanRequestId,
    mode: z.string(),
    targetMode: z.enum(['codex', 'claude']).optional(),
    model: z.string().optional(),
    purpose: z.literal('runtime-refresh').optional(),
    runtimeDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    phase: z.enum([
      'pending',
      'reauthorize-required',
      'executing',
      'completed',
      'failed',
      'recovery-required',
      'rejected',
      'cancelled',
      'expired',
    ]),
    createdAt: z.number().finite(),
    expiresAt: z.number().finite(),
    notified: z.boolean(),
    nonceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    error: z.string().max(4000).optional(),
    startRefusal: z
      .object({
        version: z.literal(1),
        purpose: z.literal('docker-plan-move-not-issued-v1'),
        code: z.literal('CAPACITY'),
        action: z.literal('begin'),
        publication: z.literal('not-issued'),
        id: PlanRequestId,
        employeeId: PlanRequestId,
        sessionId: PlanRequestId,
        sessionGeneration: z.number().int().positive().safe(),
        toAccount: PlanRequestId,
        requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    newSession: PlanRequestId.optional(),
    movePhase: z.string().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.startRefusal &&
      (record.phase !== 'failed' ||
        record.startRefusal.id !== record.id ||
        record.startRefusal.employeeId !== record.employeeId ||
        record.startRefusal.sessionId !== record.sessionId ||
        record.startRefusal.toAccount !== record.toAccount)
    )
      context.addIssue({ code: 'custom', message: 'Not-issued start refusal must match its failed original request' });

    if (
      record.purpose === 'runtime-refresh'
        ? record.fromAccount !== record.toAccount || !record.runtimeDigest
        : record.runtimeDigest !== undefined
    )
      context.addIssue({ code: 'custom', message: 'A refresh request must bind its unchanged account and runtime' });
  });
export type PlanRequestRecord = z.infer<typeof PlanRequestSchema>;
export type PlanRequestView = Omit<PlanRequestRecord, 'nonceHash'>;
