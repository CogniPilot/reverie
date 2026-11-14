/** Canonical shared-pool intent lineage outlives the employee that first
 * configured it. These private records never substitute for a fresh native ACK. */
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DockerEmployeePoolPolicy,
  type DockerEmployeeContinuationRecord,
} from './docker-employee-continuation-data.js';
import { DockerContinuationTask, allowedDockerTaskTransition } from './docker-continuation-task.js';

const uuid = z.string().uuid();
export const DockerSharedPoolLineage = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-shared-pool-lineage-v1'),
    origin: z
      .object({
        operationId: uuid,
        employeeId: uuid,
        sessionId: uuid,
        sessionGeneration: z.number().int().positive().safe(),
        owner: z.string().max(200).optional(),
      })
      .strict(),
    poolPolicy: DockerEmployeePoolPolicy,
    anchor: DockerContinuationTask.refine((task) => task.role === 'anchor').optional(),
    configuration: DockerContinuationTask.refine((task) => task.role === 'pool-helper'),
  })
  .strict()
  .refine((value) => !value.anchor || value.anchor.imageId === value.configuration.imageId);
export type DockerSharedPoolLineage = z.infer<typeof DockerSharedPoolLineage>;
export const DockerSharedPoolLineages = z
  .array(DockerSharedPoolLineage)
  .max(128)
  .refine(
    (values) => new Set(values.map((value) => value.origin.operationId)).size === values.length,
    'Shared pool operation identities must be unique'
  );
export class DockerSharedPoolLineageError extends DockerEmployeeContinuationError {
  constructor(
    code:
      | 'DOCKER_SHARED_POOL_LINEAGE_CHANGED'
      | 'DOCKER_SHARED_POOL_LINEAGE_LIMIT'
      | 'DOCKER_SHARED_POOL_SCOPE_UNCONFIRMED'
      | 'DOCKER_SHARED_POOL_WRITER_UNCONFIRMED'
  ) {
    super(code);
  }
}
interface PoolState {
  dockerEmployeeContinuations?: readonly DockerEmployeeContinuationRecord[];
  dockerSharedPoolLineages?: DockerSharedPoolLineage[];
}
function candidates(rows: readonly DockerEmployeeContinuationRecord[]): DockerSharedPoolLineage[] {
  return rows.flatMap((row) => {
    const configuration = row.tasks?.find((task) => task.role === 'pool-helper');
    if (!configuration) return [];
    const anchor = row.tasks?.find((task) => task.role === 'anchor');
    return [
      DockerSharedPoolLineage.parse({
        version: 1,
        purpose: 'reverie-boxed-shared-pool-lineage-v1',
        origin: {
          operationId: row.request.operationId,
          employeeId: row.employeeId,
          sessionId: row.request.sessionId,
          sessionGeneration: row.request.sessionGeneration,
          ...(row.owner === undefined ? {} : { owner: row.owner }),
        },
        poolPolicy: row.policy.pool,
        anchor,
        configuration,
      }),
    ];
  });
}
function nextTask(before: DockerContinuationTask, after: DockerContinuationTask): DockerContinuationTask {
  if (isDeepStrictEqual(before, after)) return before;
  if (!allowedDockerTaskTransition(before, after))
    throw new DockerSharedPoolLineageError('DOCKER_SHARED_POOL_LINEAGE_CHANGED');
  return after;
}
/** Capture before invoking a mutable canonical transaction callback. */
export function captureDockerSharedPoolLineages(state: PoolState): DockerSharedPoolLineage[] {
  return merge(state.dockerSharedPoolLineages ?? [], candidates(state.dockerEmployeeContinuations ?? []));
}
function merge(
  retained: readonly DockerSharedPoolLineage[],
  incoming: readonly DockerSharedPoolLineage[],
  admitStarts = false
): DockerSharedPoolLineage[] {
  const result = structuredClone(DockerSharedPoolLineages.parse(retained));
  for (const value of incoming) {
    const index = result.findIndex((prior) => prior.origin.operationId === value.origin.operationId);
    if (index < 0) {
      if (result.length === 128) throw new DockerSharedPoolLineageError('DOCKER_SHARED_POOL_LINEAGE_LIMIT');
      result.push(structuredClone(value));
      continue;
    }
    const before = result[index]!;
    if (!isDeepStrictEqual(before.origin, value.origin) || !isDeepStrictEqual(before.poolPolicy, value.poolPolicy))
      throw new DockerSharedPoolLineageError('DOCKER_SHARED_POOL_LINEAGE_CHANGED');
    if (
      admitStarts &&
      ['start-issued', 'running'].includes(value.configuration.phase) &&
      before.configuration.phase === 'created' &&
      result.some(
        (other) =>
          other.origin.operationId !== value.origin.operationId &&
          ['start-issued', 'running'].includes(other.configuration.phase) &&
          (value.anchor && other.anchor
            ? value.anchor.name === other.anchor.name
            : value.configuration.imageId === other.configuration.imageId)
      )
    )
      throw new DockerSharedPoolLineageError('DOCKER_SHARED_POOL_WRITER_UNCONFIRMED');
    result[index] = {
      ...before,
      anchor: before.anchor && value.anchor ? nextTask(before.anchor, value.anchor) : (before.anchor ?? value.anchor),
      configuration: nextTask(before.configuration, value.configuration),
    };
  }
  return result;
}
/** Owned by CompanyStore's single writer, in the SAME transaction as row changes.
 * Never evict an unresolved task or the sole ACK to make room. Exhaustion is a
 * pre-publication hold requiring a separate reviewed compaction workflow. */
export function preserveDockerSharedPoolLineages(before: readonly DockerSharedPoolLineage[], state: PoolState): void {
  const result = merge(before, candidates(state.dockerEmployeeContinuations ?? []), true);
  if (result.length) state.dockerSharedPoolLineages = result;
}
/** Includes legacy accepted rows before their first metadata transaction.
 * Selection remains correlation: the controller must validate FULL native scope. */
export function retainedDockerPoolTasks(
  state: PoolState,
  anchorName: string,
  helperImageId: string
): DockerContinuationTask[] {
  const values = captureDockerSharedPoolLineages(state);
  if (
    values.some(
      (value) =>
        !value.anchor &&
        value.configuration.imageId === helperImageId &&
        !['create-issued', 'created'].includes(value.configuration.phase)
    )
  )
    throw new DockerSharedPoolLineageError('DOCKER_SHARED_POOL_SCOPE_UNCONFIRMED');
  // A changed helper image must not hide a possibly started older writer in
  // this same box. The controller earns its terminal proof or visibly holds.
  return values
    .filter((value) => value.anchor?.name === anchorName)
    .map((value) => structuredClone(value.configuration));
}
