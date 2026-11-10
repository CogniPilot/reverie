/** Durable observations only. These records never reconstruct a Q or consent. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { NativeOwnerId, NativeOwnerPrincipal } from './native-owner-data.js';
import {
  NativeFleetMigrationData,
  NativeFleetPreviewData,
  NativeFleetMigrationFailureData,
} from './resource-fleet-native-data.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.number().int().nonnegative().safe();
export const FleetOperationPhase = z.enum([
  'prepared',
  'issued',
  'native-confirmed',
  'restoring',
  'completed',
  'unknown',
]);
const Report = z
  .object({
    awakened: z.array(NativeOwnerId).max(256),
    skipped: z.array(z.object({ employeeId: NativeOwnerId, reason: z.string().max(1024) }).strict()).max(256),
  })
  .strict();
export const FleetRestoreOutcomeData = z
  .object({
    employeeId: NativeOwnerId,
    sessionId: NativeOwnerId,
    state: z.enum(['pending', 'wake-confirmed', 'skipped-current-intent', 'unknown']),
    report: Report.nullable(),
  })
  .strict();
export type FleetRestoreOutcome = z.infer<typeof FleetRestoreOutcomeData>;
const FailureCode = z.enum([
  'NATIVE_OUTCOME_UNCONFIRMED',
  'RESTORE_OUTCOME_UNCONFIRMED',
  'OWNER_AUTHORIZATION_CHANGED',
  'OPERATION_STORE_UNCONFIRMED',
  'WEB_PROCESS_RESTARTED',
  'ORIGINAL_PREVIEW_UNAVAILABLE',
]);
export type FleetOperationFailureCode = z.infer<typeof FailureCode>;
const messages: Record<FleetOperationFailureCode, string> = {
  NATIVE_OUTCOME_UNCONFIRMED: 'The original native outcome is unconfirmed. Do not resend consent.',
  RESTORE_OUTCOME_UNCONFIRMED: 'An original employee recovery outcome is unconfirmed. It will not be replayed.',
  OWNER_AUTHORIZATION_CHANGED: 'Original owner authorization changed. No further recovery was dispatched.',
  OPERATION_STORE_UNCONFIRMED: 'Operation persistence is unconfirmed. No further effect was dispatched.',
  WEB_PROCESS_RESTARTED:
    'The original web process ended before a complete outcome was recorded. No effect is replayed.',
  ORIGINAL_PREVIEW_UNAVAILABLE: 'The original preview connection is unavailable. No new consent was reconstructed.',
};
const Failure = z
  .object({ code: FailureCode, message: z.string().min(1).max(256) })
  .strict()
  .refine((value) => value.message === messages[value.code], 'Unsafe fleet failure message');
export const FleetOperationData = z
  .object({
    version: z.literal(1),
    purpose: z.literal('fleet-migration-operation-v1'),
    operationId: NativeOwnerId,
    ownerScopeDigest: Digest,
    principal: NativeOwnerPrincipal,
    owner: z.string().min(1).max(100).nullable(),
    preview: NativeFleetPreviewData,
    phase: FleetOperationPhase,
    sequence: z.number().int().nonnegative().safe(),
    createdAtEpochMs: Time,
    updatedAtEpochMs: Time,
    originalBindings: z
      .array(
        z
          .object({
            employeeId: NativeOwnerId,
            sessionId: NativeOwnerId,
            generation: z.number().int().positive().safe(),
          })
          .strict()
      )
      .max(256),
    native: NativeFleetMigrationData.nullable(),
    nativeFailure: NativeFleetMigrationFailureData.nullable(),
    restore: z.array(FleetRestoreOutcomeData).max(256),
    failure: Failure.nullable(),
    reconciledAsUnconfirmed: NativeOwnerId.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const reject = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (value.operationId !== value.preview.approval.operationId || value.updatedAtEpochMs < value.createdAtEpochMs)
      reject('Operation correlation changed');
    if ((value.phase === 'prepared') !== (value.sequence === 0)) reject('Original operation sequence changed');
    for (const rows of [value.originalBindings, value.restore]) {
      if (
        new Set(rows.map((row) => row.employeeId)).size !== rows.length ||
        new Set(rows.map((row) => row.sessionId)).size !== rows.length
      )
        reject('Ambiguous employee cohort');
    }
    if (
      value.native &&
      (value.native.requestId !== value.preview.requestId ||
        !isDeepStrictEqual(value.native.approval, value.preview.approval) ||
        !isDeepStrictEqual(value.native.policy, value.preview.policy))
    )
      reject('Native outcome changed');
    if (
      value.nativeFailure &&
      (value.nativeFailure.requestId !== value.preview.requestId ||
        !isDeepStrictEqual(value.nativeFailure.approval, value.preview.approval))
    )
      reject('Native diagnostic correlation changed');
    if (value.nativeFailure && (value.native !== null || value.phase !== 'unknown'))
      reject('Native failure is not completion');
    if (
      value.native &&
      (new Set(value.native.restore.map((row) => row.employeeId)).size !== value.native.restore.length ||
        new Set(value.native.restore.map((row) => row.sessionId)).size !== value.native.restore.length)
    )
      reject('Ambiguous native cohort');
    if (['prepared', 'issued'].includes(value.phase) && (value.native !== null || value.restore.length))
      reject('Unissued native outcome');
    if (['native-confirmed', 'restoring', 'completed'].includes(value.phase) && value.native === null)
      reject('Known native result required');
    if (value.phase === 'native-confirmed' && value.restore.length) reject('Restoration not started');
    if ((value.phase === 'unknown') !== (value.failure !== null)) reject('Failure phase changed');
    if (value.restore.filter((row) => row.state === 'pending').length > 1) reject('Concurrent recovery intents');
    for (const row of value.restore) {
      if (
        !value.native?.restore.some(
          (original) => original.employeeId === row.employeeId && original.sessionId === row.sessionId
        )
      )
        reject('Restore cohort changed');
    }
    if (
      value.phase === 'completed' &&
      (value.restore.length !== value.native?.restore.length ||
        value.restore.some((row) => row.state === 'pending' || row.state === 'unknown'))
    )
      reject('Restoration unconfirmed');
    if (value.reconciledAsUnconfirmed !== null && value.phase !== 'unknown')
      reject('Only unknown history may be reconciled');
  });
export type FleetOperation = z.infer<typeof FleetOperationData>;

export const fleetOperationFailure = (code: FleetOperationFailureCode) => ({ code, message: messages[code] });
const legal: Record<FleetOperation['phase'], readonly FleetOperation['phase'][]> = {
  prepared: ['issued', 'unknown'],
  issued: ['native-confirmed', 'unknown'],
  'native-confirmed': ['restoring', 'unknown'],
  restoring: ['restoring', 'completed', 'unknown'],
  completed: [],
  unknown: ['unknown'],
};
export function advanceFleetOperation(
  previous: FleetOperation,
  phase: FleetOperation['phase'],
  patch: Partial<
    Pick<FleetOperation, 'native' | 'nativeFailure' | 'restore' | 'failure' | 'reconciledAsUnconfirmed'>
  > = {}
): FleetOperation {
  const next = FleetOperationData.parse({
    ...previous,
    ...patch,
    phase,
    sequence: previous.sequence + 1,
    updatedAtEpochMs: Math.max(Date.now(), previous.updatedAtEpochMs),
  });
  assertFleetOperationSuccessor(previous, next);
  return next;
}
export function assertFleetOperationSuccessor(previous: FleetOperation, next: FleetOperation): void {
  if (
    !legal[previous.phase].includes(next.phase) ||
    next.sequence !== previous.sequence + 1 ||
    next.updatedAtEpochMs < previous.updatedAtEpochMs
  )
    throw new Error('Illegal fleet operation transition');
  for (const key of [
    'version',
    'purpose',
    'operationId',
    'ownerScopeDigest',
    'principal',
    'owner',
    'preview',
    'createdAtEpochMs',
    'originalBindings',
  ] as const) {
    if (!isDeepStrictEqual(previous[key], next[key])) throw new Error('Original operation binding changed');
  }
  const phase = next.phase;
  const added = next.restore.filter(
    (row) => !previous.restore.some((original) => original.employeeId === row.employeeId)
  );
  if (
    added.length > 1 ||
    added.some(
      (row) =>
        previous.phase !== 'restoring' ||
        (phase === 'restoring' ? row.state !== 'pending' : phase !== 'unknown' || row.state !== 'unknown')
    )
  )
    throw new Error('Recovery must retain one original intent before its outcome');
  if (
    previous.phase === 'unknown' &&
    (added.length ||
      !isDeepStrictEqual(previous.native, next.native) ||
      !isDeepStrictEqual(previous.nativeFailure, next.nativeFailure))
  )
    throw new Error('Unknown history cannot reconstruct native or recovery authority');
  for (const original of previous.restore) {
    const row = next.restore.find((value) => value.employeeId === original.employeeId);
    if (!row || (original.state !== 'pending' && !isDeepStrictEqual(row, original)))
      throw new Error('Original employee recovery cannot be removed or replayed');
  }
  if (previous.native && !isDeepStrictEqual(next.native, previous.native))
    throw new Error('Original native result changed');
  if (previous.nativeFailure && !isDeepStrictEqual(next.nativeFailure, previous.nativeFailure))
    throw new Error('Original native diagnostic changed');
  if (previous.failure && !isDeepStrictEqual(next.failure, previous.failure))
    throw new Error('Original failure changed');
}
export function fleetOperationBlocks(value: FleetOperation): boolean {
  return value.reconciledAsUnconfirmed === null && value.phase !== 'completed';
}
