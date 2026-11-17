/** Global observation correlation, never a historical employee identity or a
 * resource/launch grant. Every future use earns the native ACK again. */
import { z } from 'zod';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { captureDockerSharedPoolLineages } from './docker-shared-pool-lineage.js';
import type { CompanyState } from './company-types.js';
import { DockerEmployeePoolPolicy } from './docker-employee-continuation-data.js';
import { DockerContinuationTask } from './docker-continuation-task.js';
const cid = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const processIdentity = z
  .object({
    id: cid,
    pid: z.number().int().positive().safe(),
    startTicks: decimal,
    path: z.string().max(4096),
    dev: decimal,
    ino: decimal,
  })
  .strict();
export const DockerResourceObservation = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-resource-observation-v1'),
    boxId: cid,
    parent: z.object({ path: z.string().max(4096), dev: decimal, ino: decimal }).strict(),
    anchor: processIdentity,
    worker: processIdentity.nullable(),
    resources: z
      .object({
        memoryMax: z.string(),
        memoryHigh: z.string(),
        swapMax: z.string(),
        pidsMax: z.string(),
        cpuWeight: decimal,
        cpuMax: z.string().max(128),
        cpusetCpus: z.string().max(4096),
        cpusetCpusEffective: z.string().max(4096),
        cpusetMemsEffective: z.string().max(4096),
      })
      .strict(),
  })
  .strict();
export type DockerResourceObservation = z.infer<typeof DockerResourceObservation>;
export const DockerPoolRestoreAcknowledgement = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-restore-pool-ack-v1'),
    observation: DockerResourceObservation,
    members: z.array(processIdentity).min(1).max(64),
  })
  .strict()
  .refine(
    (value) =>
      value.observation.worker === null &&
      value.members.every(
        (member) =>
          member.startTicks !== '0' &&
          member.pid > 1 &&
          member.id !== value.observation.anchor.id &&
          member.pid !== value.observation.anchor.pid &&
          member.path === value.observation.parent.path + '/docker-' + member.id + '.scope'
      ) &&
      new Set(value.members.map((member) => member.id)).size === value.members.length &&
      new Set(value.members.map((member) => member.pid)).size === value.members.length
  );

const runningAnchor = DockerContinuationTask.refine(
  (value) => value.role === 'anchor' && value.phase === 'running'
).transform((value) => value as Extract<DockerContinuationTask, { phase: 'running' }>);
const completedPool = DockerContinuationTask.refine(
  (value) => value.role === 'pool-helper' && value.phase === 'completed'
).transform((value) => value as Extract<DockerContinuationTask, { phase: 'completed' }>);
const poolRecord = z.object({
  purpose: z.literal('reverie-boxed-pool-observation-v1'),
  boxId: cid,
  deployment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  helperImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  poolPolicy: DockerEmployeePoolPolicy,
  epoch: DockerResourceObservation.pick({ boxId: true, parent: true, anchor: true }),
  anchorTask: runningAnchor,
  configuration: completedPool,
});
export const DockerPoolObservationRecord = z
  .union([
    poolRecord.extend({ version: z.literal(1) }).strict(),
    poolRecord
      .extend({ version: z.literal(2), poolRestoreHelperImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
      .strict(),
  ])
  .refine(
    (value) =>
      value.boxId === value.epoch.boxId &&
      value.anchorTask.imageId === value.helperImageId &&
      value.configuration.imageId === (value.version === 2 ? value.poolRestoreHelperImageId : value.helperImageId) &&
      value.anchorTask.name === 'reverie-boxed-anchor-' + value.boxId.slice(0, 32) &&
      value.anchorTask.containerId === value.epoch.anchor.id &&
      value.anchorTask.initPid === value.epoch.anchor.pid &&
      value.anchorTask.initStartTicks === value.epoch.anchor.startTicks &&
      value.epoch.parent.path === '/reverie.slice/reverie-box.slice/reverie-box-' + value.boxId + '.slice' &&
      value.epoch.anchor.path === value.epoch.parent.path + '/docker-' + value.epoch.anchor.id + '.scope'
  );
export type DockerPoolObservationRecord = z.infer<typeof DockerPoolObservationRecord>;
export const DockerPoolObservations = z
  .array(DockerPoolObservationRecord)
  .max(128)
  .refine(
    (values) => new Set(values.map((value) => value.configuration.containerId)).size === values.length,
    'Each observed original pool helper is recorded once'
  );

/** Effective pool metadata, including accepted legacy row cursors, is the CAS
 * boundary. Employee recipes and unrelated company edits are not pool grants. */
export function dockerPoolMetadataDigest(state: CompanyState): string {
  return dockerContinuationDigest({
    lineages: captureDockerSharedPoolLineages(state),
    observations: state.dockerPoolObservations ?? [],
  });
}
