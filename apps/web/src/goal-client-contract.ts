/**
 * @fileoverview Typed wire contract for the sealed Goal r3 API. No canonical store,
 * authentication adapter or authority is created here. Keep this in step with r3
 * goal-lifecycle.ts/company-types.ts until server composition supplies that API.
 */
import { z } from 'zod';

// Absolute end, not JavaScript "$" (which also matches before a final newline).
export const GoalId = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}(?![\s\S])/);
const positive = z.number().int().positive();
const instant = z.number().int().nonnegative();
const sequence = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nextAction = z.string().trim().min(1).max(2000);
const recordId = z.string().trim().min(1).max(100);
export const GoalState = z.enum(['READY', 'ASSIGNED', 'ACTIVE', 'HOLD', 'REVIEW', 'DONE', 'NO_GO', 'CANCELLED']);
const category = z.enum(['INPUT', 'OWNER_DECISION', 'OWNER_ACTION', 'REVIEW', 'DEPENDENCY', 'POLICY']);
const blocker = z
  .object({
    category,
    summary: z.string().trim().min(1).max(500),
    unblocker: z.object({ kind: category, id: GoalId }).strict(),
  })
  .strict();
const evidence = z.string().regex(/^evidence:sha256:[a-f0-9]{64}$/);
export const GoalCreateCommand = z
  .object({
    createId: GoalId,
    employeeId: GoalId,
    sessionId: GoalId,
    sessionGeneration: positive,
    objective: z.string().trim().min(1).max(8000),
    nextAction,
    deadlineAt: instant.optional(),
    inputDigests: z.array(digest).max(100).default([]),
  })
  .strict();
/** Path owns goalId; no caller-supplied actor, owner, grant object or credential. */
export const GoalTransitionCommand = z
  .object({
    generation: positive,
    expectedState: GoalState,
    expectedSequence: sequence,
    sessionId: GoalId,
    sessionGeneration: positive,
    transitionId: GoalId,
    to: GoalState,
    nextAction,
    blocker: blocker.optional(),
    deadlineAt: instant.optional(),
    semanticProgressAt: instant.optional(),
    evidenceRefs: z.array(evidence).max(200).optional(),
    verifierGrantId: GoalId.optional(),
    unblockProofId: GoalId.optional(),
  })
  .strict();
export type GoalCreateCommand = z.input<typeof GoalCreateCommand>;
export type GoalTransitionCommand = z.input<typeof GoalTransitionCommand>;

const snapshot = z
  .object({
    sessionId: GoalId,
    sessionGeneration: positive,
    generation: positive,
    state: GoalState,
    blocker: blocker.optional(),
    nextAction,
    deadlineAt: instant.optional(),
    semanticProgressAt: instant,
    updatedAt: instant,
    transitionSequence: sequence,
    evidenceCount: sequence.max(200),
  })
  .strict();
export const GoalClosedReceipt = z
  .object({
    transitionId: GoalId,
    sequence: positive,
    generation: positive,
    from: GoalState,
    to: GoalState,
    actorKind: z.enum(['worker', 'verifier', 'owner']),
    actorEmployeeId: recordId.optional(),
    actorSessionId: recordId.optional(),
    actorSessionGeneration: positive.optional(),
    authorityId: GoalId.optional(),
    operation: z.enum(['TRANSITION', 'ADOPT']),
    at: instant,
  })
  .strict();
const fullReceipt = GoalClosedReceipt.extend({
  requestDigest: digest,
  unblockProofId: GoalId.optional(),
  after: snapshot,
});
export const GoalSummary = z
  .object({
    id: recordId,
    generation: positive,
    sessionId: recordId,
    sessionGeneration: positive,
    state: GoalState,
    transitionSequence: sequence,
    updatedAt: instant,
  })
  .strict();
export const GoalFullRecord = GoalSummary.extend({
  createId: GoalId,
  createRequestDigest: digest,
  owner: z.string().optional(),
  employeeId: recordId,
  objective: z.string().trim().min(1).max(8000),
  blocker: blocker.optional(),
  nextAction,
  deadlineAt: instant.optional(),
  semanticProgressAt: instant,
  inputDigests: z.array(digest).max(100).default([]),
  evidenceRefs: z.array(evidence).max(200).default([]),
  createdAt: instant,
  transitions: z.array(fullReceipt).max(256),
  creation: snapshot,
})
  .strict()
  .superRefine((goal, context) => {
    if ((goal.state === 'HOLD') !== !!goal.blocker) context.addIssue({ code: 'custom', message: 'Invalid HOLD shape' });
  });
export const GoalCommandResult = z.discriminatedUnion('visibility', [
  z.object({ visibility: z.literal('full'), goal: GoalFullRecord, receipt: fullReceipt }).strict(),
  z.object({ visibility: z.literal('verification'), goal: GoalSummary, receipt: GoalClosedReceipt }).strict(),
]);
export type GoalCommandResult = z.infer<typeof GoalCommandResult>;
export const GoalMetadata = z
  .object({
    id: recordId,
    generation: positive,
    employeeId: recordId,
    sessionId: recordId,
    sessionGeneration: positive,
    state: GoalState,
    blockerCategory: category.optional(),
    bindingState: z.enum(['MIGRATING', 'CURRENT', 'STALE']),
    deadlineAt: instant.optional(),
    semanticProgressAt: instant,
    updatedAt: instant,
    transitionSequence: sequence,
  })
  .strict();

/** Deliberately construct closed views; full record/receipt spreads could disclose private input. */
export function goalSummary(goal: z.infer<typeof GoalSummary>): z.infer<typeof GoalSummary> {
  return {
    id: goal.id,
    generation: goal.generation,
    sessionId: goal.sessionId,
    sessionGeneration: goal.sessionGeneration,
    state: goal.state,
    transitionSequence: goal.transitionSequence,
    updatedAt: goal.updatedAt,
  };
}
export function closedReceipt(receipt: z.infer<typeof GoalClosedReceipt>): z.infer<typeof GoalClosedReceipt> {
  return {
    transitionId: receipt.transitionId,
    sequence: receipt.sequence,
    generation: receipt.generation,
    from: receipt.from,
    to: receipt.to,
    actorKind: receipt.actorKind,
    actorEmployeeId: receipt.actorEmployeeId,
    actorSessionId: receipt.actorSessionId,
    actorSessionGeneration: receipt.actorSessionGeneration,
    authorityId: receipt.authorityId,
    operation: receipt.operation,
    at: receipt.at,
  };
}
