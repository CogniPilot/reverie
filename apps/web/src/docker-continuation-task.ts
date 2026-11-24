/** Subcursors in the SAME canonical operation journal. No parallel writer or
 * reset. These are deny-only correlations; helpers earn fresh native proof.
 */
import { z } from 'zod';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
export const DockerContinuationTaskRole = z.enum([
  'storage-holder',
  'anchor',
  'pool-helper',
  'leaf-helper',
  'identity-helper',
]);
export type DockerContinuationTaskRole = z.infer<typeof DockerContinuationTaskRole>;
const base = z
  .object({
    role: DockerContinuationTaskRole,
    name: z.string().regex(/^reverie-boxed-[a-z0-9-]{1,100}$/),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const cid = z.string().regex(/^[a-f0-9]{64}$/),
  ticks = z.string().regex(/^[1-9][0-9]{0,19}$/);
const createIssued = base.extend({ phase: z.literal('create-issued') }),
  created = base.extend({ phase: z.literal('created'), containerId: cid }),
  startIssued = base.extend({ phase: z.literal('start-issued'), containerId: cid }),
  running = base.extend({
    phase: z.literal('running'),
    containerId: cid,
    initPid: z.number().int().positive().safe(),
    initStartTicks: ticks,
  }),
  completed = base.extend({
    phase: z.literal('completed'),
    containerId: cid,
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  });
/** A task that is issued once and never again: the shape every record had
 * before the leaf writer could be rerun, and still the only shape of the
 * resource-revision ledger, whose reserved capacity is computed from it. */
export const DockerSingleAttemptTask = z.discriminatedUnion('phase', [
  createIssued,
  created,
  startIssued,
  running,
  completed,
]);
export type DockerSingleAttemptTask = z.infer<typeof DockerSingleAttemptTask>;
/** The most leaf writers one operation may ever issue. Three are issued
 * without being asked again; the rest need a repeated request. */
export const DOCKER_TASK_ATTEMPT_LIMIT = 9;
/** Why an exited leaf writer failed, as a closed class. The helper's own
 * text is never stored. Only `lost-process` and `deadline` permit a rerun. */
export const DockerTaskFailure = z.enum(['lost-process', 'deadline', 'refused', 'close-unconfirmed', 'unknown']);
export type DockerTaskFailure = z.infer<typeof DockerTaskFailure>;
export function dockerTaskFailureRetryable(failure: DockerTaskFailure): boolean {
  return failure === 'lost-process' || failure === 'deadline';
}
/** Absent on a first attempt, so that every earlier record reads unchanged. */
const retry = { attempt: z.number().int().min(2).max(DOCKER_TASK_ATTEMPT_LIMIT).optional() };
export const DockerContinuationTask = z
  .discriminatedUnion('phase', [
    createIssued.extend(retry),
    created.extend(retry),
    startIssued.extend(retry),
    running.extend(retry),
    // An acknowledged task never carries an attempt index. However many
    // attempts preceded it, it is recorded as it always was, so an office
    // that predates the rerun still reads every finished operation.
    completed,
    // Terminal: the exact container exited without acknowledging anything.
    base.extend({
      ...retry,
      phase: z.literal('failed'),
      containerId: cid,
      exitCode: z.number().int().min(1).max(255),
      failure: DockerTaskFailure,
    }),
  ])
  .refine((task) => task.role === 'leaf-helper' || (task.phase !== 'failed' && !('attempt' in task && task.attempt)));
export type DockerContinuationTask = z.infer<typeof DockerContinuationTask>;
export interface DockerContinuationTaskJournal {
  read(row: DockerEmployeeContinuationRecord, role: DockerContinuationTaskRole): DockerContinuationTask | undefined;
  publish(
    row: DockerEmployeeContinuationRecord,
    before: DockerContinuationTask | undefined,
    next: DockerContinuationTask,
    requireCurrent: () => void
  ): Promise<DockerEmployeeContinuationRecord>;
}
function attemptIndex(task: DockerContinuationTask): number | undefined {
  return 'attempt' in task ? task.attempt : undefined;
}
/** Which attempt an open or failed task is. An acknowledged task reads as 1. */
export function dockerTaskAttempt(task: DockerContinuationTask): number {
  return attemptIndex(task) ?? 1;
}
/** The fields an attempt keeps from its intent until it fails. */
export function dockerTaskIdentity(task: DockerContinuationTask) {
  const attempt = attemptIndex(task);
  return {
    role: task.role,
    name: task.name,
    imageId: task.imageId,
    configurationDigest: task.configurationDigest,
    ...(attempt === undefined ? {} : { attempt }),
  };
}
/** The hold a terminally failed leaf writer leaves its operation in until it
 * is rerun or the laptop is rebuilt. Only the first of these may be rerun. */
export function dockerFailedWriterHold(task: Extract<DockerContinuationTask, { phase: 'failed' }>): string {
  if (task.failure === 'refused') return 'DOCKER_RESOURCE_HELPER_REFUSED';
  if (task.failure === 'close-unconfirmed') return 'DOCKER_RESOURCE_HELPER_CLOSE_UNCONFIRMED';
  if (task.failure === 'unknown') return 'DOCKER_RESOURCE_HELPER_FAILURE_UNKNOWN';
  return dockerTaskAttempt(task) >= DOCKER_TASK_ATTEMPT_LIMIT
    ? 'DOCKER_RESOURCE_HELPER_ATTEMPTS_SPENT'
    : 'DOCKER_RESOURCE_HELPER_RETRY_PENDING';
}
export function allowedDockerTaskTransition(
  before: DockerContinuationTask | undefined,
  next: DockerContinuationTask
): boolean {
  if (!before) return next.phase === 'create-issued' && attemptIndex(next) === undefined;
  if (before.role !== next.role) return false;
  if (before.phase === 'failed') {
    // The only successor of a terminal failure is the intent of the next
    // attempt, under its own name. A failure that is not a lost read has none.
    const attempt = dockerTaskAttempt(before) + 1;
    return (
      next.phase === 'create-issued' &&
      next.role === 'leaf-helper' &&
      dockerTaskFailureRetryable(before.failure) &&
      attempt <= DOCKER_TASK_ATTEMPT_LIMIT &&
      next.attempt === attempt &&
      next.name !== before.name
    );
  }
  if (
    before.name !== next.name ||
    before.imageId !== next.imageId ||
    before.configurationDigest !== next.configurationDigest ||
    // The index stays with an attempt until it is acknowledged, and is not recorded then.
    (next.phase === 'completed' ? attemptIndex(next) !== undefined : attemptIndex(before) !== attemptIndex(next))
  )
    return false;
  if ('containerId' in before && (!('containerId' in next) || before.containerId !== next.containerId)) return false;
  if (next.phase === 'failed' && next.role !== 'leaf-helper') return false;
  const transitions: Record<DockerContinuationTask['phase'], readonly DockerContinuationTask['phase'][]> = {
    'create-issued': ['created'],
    created: ['start-issued', 'running'],
    'start-issued': ['running', 'completed', 'failed'],
    running: ['completed', 'failed'],
    completed: [],
    failed: [],
  };
  return transitions[before.phase].includes(next.phase);
}
