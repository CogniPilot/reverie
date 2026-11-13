/** Fixed recovery request and private application correlation DATA.
 * Loading a row supplies no native operation, dispatch receipt or recovery grant.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NativeOwnerId } from './native-owner-data.js';

export const EmployeeRecoveryAction = z.enum(['reconcile-owned', 'stop-provider', 'close-viewer']);
export type EmployeeRecoveryAction = z.infer<typeof EmployeeRecoveryAction>;
export const NativeEmployeeGeneration = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine(
    (value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n,
    'Canonical positive native generation required'
  );
/** Exact native RAM-v2 employee-recovery approval; no owner/actor selector. */
export const EmployeeRecoveryApproval = z
  .object({
    operationId: NativeOwnerId,
    sessionId: NativeOwnerId,
    sessionGeneration: NativeEmployeeGeneration,
    originalAttemptId: NativeOwnerId.nullable(),
    parentOperationId: NativeOwnerId.nullable(),
    action: EmployeeRecoveryAction,
  })
  .strict()
  .superRefine((approval, context) => {
    if (
      approval.parentOperationId !== null &&
      (approval.action !== 'close-viewer' || approval.parentOperationId === approval.operationId)
    )
      context.addIssue({
        code: 'custom',
        message: 'Only a distinct close-viewer component may name a parent operation',
      });
  })
  .readonly();
export type EmployeeRecoveryApproval = z.infer<typeof EmployeeRecoveryApproval>;
export const EmployeeRecoveryGrantRef = z
  .object({
    grantId: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    policyGeneration: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .readonly();
export const EmployeeRecoveryRequest = z
  .object({ approval: EmployeeRecoveryApproval, grantRef: EmployeeRecoveryGrantRef.optional() })
  .strict()
  .readonly();
export type EmployeeRecoveryRequest = z.infer<typeof EmployeeRecoveryRequest>;
export const EmployeeRecoverySelectionRequest = z.object({ grantRef: EmployeeRecoveryGrantRef }).strict().readonly();
const ActionAvailability = z
  .object({
    state: z.enum(['available', 'unavailable']),
    reason: z
      .enum([
        'no-native-channel',
        'unsupported-provider',
        'original-owner-unavailable',
        'recovery-preparing',
        'existing-recovery',
        'action-approval-required',
        'no-original-operation',
        'component-required',
        'original-binding-unavailable',
      ])
      .nullable(),
  })
  .strict()
  .readonly();
export const ApplicationRecovery = z
  .object({
    state: z.enum(['recovery-required', 'completed-stopped']),
    intentRetirement: z.enum(['not-applicable', 'known-unused-retired', 'issued-native-retired', 'unconfirmed']),
  })
  .strict()
  .readonly();
export const EmployeeRecoverySelection = z
  .object({
    version: z.literal(1),
    purpose: z.literal('employee-recovery-selection-v1'),
    employeeId: NativeOwnerId,
    sessionId: NativeOwnerId,
    sessionGeneration: NativeEmployeeGeneration,
    provider: z
      .object({
        source: z.enum(['retained-native-dispatch', 'saved-native-denial', 'unavailable']),
        originalAttemptId: NativeOwnerId.nullable(),
        providerExecution: z.literal('unproved'),
      })
      .strict()
      .readonly(),
    unusedIntent: z.enum(['acknowledged-never-claimed', 'none', 'unconfirmed']),
    recovery: z
      .union([
        z.object({ kind: z.enum(['none', 'preparing']) }).strict(),
        z
          .object({
            kind: z.enum(['retained', 'owner-unavailable']),
            approval: EmployeeRecoveryApproval,
            componentApproval: EmployeeRecoveryApproval.nullable(),
            application: ApplicationRecovery,
          })
          .strict(),
      ])
      .readonly(),
    availability: z
      .object({
        reconcileOwned: ActionAvailability,
        stopProvider: ActionAvailability,
        closeViewer: ActionAvailability,
        observeOriginal: ActionAvailability,
        closeRetainedViewer: ActionAvailability,
      })
      .strict()
      .readonly(),
    readOnly: z.literal(true),
  })
  .strict()
  .readonly();
export type EmployeeRecoverySelection = z.infer<typeof EmployeeRecoverySelection>;

const RecoveryDiagnostics = z
  .object({
    primaryCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,95}$/)
      .nullable(),
    secondaryCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,95}$/)
      .nullable(),
  })
  .strict()
  .refine(
    (value) => value.primaryCode !== null || value.secondaryCode !== null,
    'At least one diagnostic code required'
  )
  .readonly();

/** Closed native observation DATA. Even final-looking values do not mint the
 * private transport/operation settlement needed to release an application fence. */
export const EmployeeRecoveryResult = z
  .object({
    version: z.literal(1),
    purpose: z.literal('employee-recovery-v1'),
    employeeId: NativeOwnerId,
    approval: EmployeeRecoveryApproval,
    outcome: z.enum([
      'original-handler-pending',
      'original-handler-reconciled',
      'provider-stop-pending',
      'provider-stopped-viewer-pending',
      'provider-stopped',
      'viewer-close-pending',
      'viewer-closed',
      'custody-unavailable',
      'refused-before-new-effect',
      'unconfirmed',
    ]),
    newDispatch: z.enum(['not-attempted', 'attempted']),
    earlierEffects: z.literal('unproved'),
    diagnostics: RecoveryDiagnostics.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const action = value.approval.action,
      outcome = value.outcome;
    const valid = outcome.startsWith('original-handler-')
      ? action === 'reconcile-owned'
      : outcome.startsWith('provider-stop')
        ? action === 'stop-provider' && value.newDispatch === 'attempted'
        : outcome.startsWith('viewer-clos')
          ? action === 'close-viewer' && value.newDispatch === 'attempted'
          : outcome === 'custody-unavailable' || outcome === 'refused-before-new-effect'
            ? value.newDispatch === 'not-attempted'
            : outcome === 'unconfirmed';
    if (!valid)
      context.addIssue({ code: 'custom', message: 'Recovery outcome does not match its original action/dispatch' });
  })
  .readonly();
export type EmployeeRecoveryResult = z.infer<typeof EmployeeRecoveryResult>;

export function parseEmployeeRecoveryResult(
  value: unknown,
  employeeId: string,
  approval: EmployeeRecoveryApproval
): EmployeeRecoveryResult {
  const result = EmployeeRecoveryResult.parse(value);
  // Valid approval identity is independent of object insertion order. Strict
  // parsing validates callers and gives both digests the same field order.
  const original = EmployeeRecoveryApproval.parse(approval);
  if (result.employeeId !== employeeId || recoveryDataDigest(result.approval) !== recoveryDataDigest(original))
    throw Error('Native recovery observation does not match the original operation');
  return result;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const RecoveryComponent = z
  .object({
    approval: EmployeeRecoveryApproval,
    actorScopeDigest: digest,
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    phase: z.enum(['issued', 'observed']),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observationDigest: digest.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.approval.parentOperationId === null ||
      value.approval.action !== 'close-viewer' ||
      (value.phase === 'observed') !== (value.observationDigest !== undefined)
    )
      context.addIssue({ code: 'custom', message: 'Original retained viewer component required' });
  });
/** Kept only in the existing private CompanyStore. Every phase denies replay
 * after process loss; an observed digest is not a native settlement capability.
 */
export const EmployeeRecoveryOperation = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    employeeId: NativeOwnerId,
    owner: z.string().max(1024).optional(),
    approval: EmployeeRecoveryApproval,
    resourceDigest: digest,
    actorScopeDigest: digest,
    requestDigest: digest,
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Application admission -> observation correlation only. Both deny replay;
     * 'issued' is not a native effect receipt. There is no clearing transition. */
    phase: z.enum(['issued', 'observed']),
    observationDigest: digest.optional(),
    component: RecoveryComponent.optional(),
    application: z
      .object({
        version: z.literal(1),
        state: z.enum(['stopped-intent', 'completed-stopped']),
        stoppedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        supersededByIntent: NativeOwnerId.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      (row.version === 2) !== (row.application !== undefined) ||
      (row.application && (row.phase !== 'observed' || row.approval.action !== 'stop-provider')) ||
      (row.application?.supersededByIntent !== undefined && row.application.state !== 'completed-stopped')
    )
      context.addIssue({ code: 'custom', message: 'Versioned original stopped metadata required' });
    if ((row.phase === 'observed') !== (row.observationDigest !== undefined))
      context.addIssue({ code: 'custom', message: 'Only an original observed operation has an observation digest' });
    const component = row.component?.approval;
    if (
      row.approval.parentOperationId !== null ||
      (component &&
        (row.approval.action !== 'stop-provider' ||
          component.parentOperationId !== row.approval.operationId ||
          component.sessionId !== row.approval.sessionId ||
          component.sessionGeneration !== row.approval.sessionGeneration ||
          component.originalAttemptId !== row.approval.originalAttemptId))
    )
      context.addIssue({ code: 'custom', message: 'Component must retain the same original stop resource' });
  });
export type EmployeeRecoveryOperation = z.infer<typeof EmployeeRecoveryOperation>;
export function completedStoppedRecovery(row: EmployeeRecoveryOperation): boolean {
  return row.version === 2 && row.application?.state === 'completed-stopped';
}
/** Monotonic revocation DATA written only with an accepted new admission. */
export function supersedeStoppedRecoveryHistory(
  rows: EmployeeRecoveryOperation[] | undefined,
  employeeId: string,
  owner: string | undefined,
  intentId: string
): void {
  NativeOwnerId.parse(intentId);
  for (const row of rows ?? [])
    if (row.employeeId === employeeId && row.owner === owner && completedStoppedRecovery(row) && row.application)
      row.application.supersededByIntent ??= intentId;
}

export function recoveryDataDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sameRecoveryOperation(left: EmployeeRecoveryOperation, right: EmployeeRecoveryOperation): boolean {
  return recoveryDataDigest(left) === recoveryDataDigest(right);
}
