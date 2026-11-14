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
export const DockerContinuationTask = z.discriminatedUnion('phase', [
  base.extend({ phase: z.literal('create-issued') }),
  base.extend({ phase: z.literal('created'), containerId: cid }),
  base.extend({ phase: z.literal('start-issued'), containerId: cid }),
  base.extend({
    phase: z.literal('running'),
    containerId: cid,
    initPid: z.number().int().positive().safe(),
    initStartTicks: ticks,
  }),
  base.extend({ phase: z.literal('completed'), containerId: cid, resultDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
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
export function allowedDockerTaskTransition(
  before: DockerContinuationTask | undefined,
  next: DockerContinuationTask
): boolean {
  if (!before) return next.phase === 'create-issued';
  if (
    before.role !== next.role ||
    before.name !== next.name ||
    before.imageId !== next.imageId ||
    before.configurationDigest !== next.configurationDigest
  )
    return false;
  if ('containerId' in before && (!('containerId' in next) || before.containerId !== next.containerId)) return false;
  const transitions: Record<DockerContinuationTask['phase'], readonly DockerContinuationTask['phase'][]> = {
    'create-issued': ['created'],
    created: ['start-issued', 'running'],
    'start-issued': ['running', 'completed'],
    running: ['completed'],
    completed: [],
  };
  return transitions[before.phase].includes(next.phase);
}
