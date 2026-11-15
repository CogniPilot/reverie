import { allowedEphemeralTransition } from './docker-ephemeral-data.js';
/** Private PlanMoves journal DATA. None of these references mint effect authority.
 * An actor epoch fences publishers; it never changes an already-issued task. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { allowedDockerTaskTransition } from './docker-continuation-task.js';
import { containsHandoffControls } from './text-controls.js';
import {
  DockerEmployeeContinuationPhase,
  DockerEmployeeBinding,
  DockerEmployeeContinuationRecord,
  DockerEmployeePlanReplacementWorkRecord,
  DockerEmployeeWorkerImage,
} from './docker-employee-continuation-data.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { DockerPlanSourceContext, dockerPlanContextForProvider } from './docker-plan-source-data.js';
import { dockerPlanMaterial } from './docker-plan-material.js';
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const ticks = z.string().regex(/^[1-9][0-9]{0,19}$/);
const readerBase = {
  version: z.literal(1),
  purpose: z.literal('docker-plan-source-reader-v1'),
  name: z.string().regex(/^reverie-boxed-[a-z0-9-]{1,100}$/),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  configurationDigest: digest,
};
const readerInit = z.object({ pid: z.number().int().positive().safe(), startTicks: ticks }).strict();
export const DockerPlanMoveSourceReader = z.discriminatedUnion('phase', [
  z.object({ ...readerBase, phase: z.literal('create-issued'), containerId: digest.optional() }).strict(),
  z.object({ ...readerBase, phase: z.literal('created'), containerId: digest }).strict(),
  z.object({ ...readerBase, phase: z.literal('start-issued'), containerId: digest }).strict(),
  z.object({ ...readerBase, phase: z.literal('running'), containerId: digest, init: readerInit }).strict(),
  z.object({ ...readerBase, phase: z.literal('close-issued'), containerId: digest, init: readerInit }).strict(),
  z
    .object({
      ...readerBase,
      phase: z.literal('closed'),
      containerId: digest,
      init: readerInit.optional(),
      terminalStateDigest: digest,
    })
    .strict(),
]);
export type DockerPlanMoveSourceReader = z.infer<typeof DockerPlanMoveSourceReader>;
export const DockerPlanMoveSeed = z
  .object({
    version: z.literal(1),
    purpose: z.literal('docker-plan-replacement-seed-v1'),
    moveId: identifier,
    forceBusy: z.boolean(),
    handoff: z
      .string()
      .min(1)
      .max(12000)
      .refine((value) => !!value.trim() && !containsHandoffControls(value)),
    source: z
      .object({
        record: DockerEmployeeContinuationRecord,
        binding: DockerEmployeeBinding,
        providerSourceDigest: digest,
        observation: z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('running'),
              init: z.object({ pid: z.number().int().positive().max(2147483647), startTicks: ticks }).strict(),
              provider: z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('observed'), viewDigest: digest }).strict(),
                z.object({ kind: z.literal('unobserved') }).strict(),
              ]),
            })
            .strict(),
          z.object({ kind: z.literal('stopped'), terminalStateDigest: digest }).strict(),
        ]),
      })
      .strict(),
    target: z
      .object({
        sessionId: uuid,
        sessionGeneration: z.number().int().positive().safe(),
        operationId: uuid,
        credentialId: uuid,
        accountId: identifier,
        provider: z.enum(['anthropic', 'openai']),
        accountSnapshotDigest: digest,
        accountSource: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('canonical') }).strict(),
          z
            .object({
              kind: z.literal('retained-generation'),
              moveId: identifier,
              operationId: uuid,
              containerId: digest,
              projectionDigest: digest,
              originalCanonicalSnapshotDigest: digest,
            })
            .strict(),
        ]),
        /** Stable canonical RuntimeRecipe digest from the shared stock codec. */
        templateDigest: digest,
        /** Resolved selected model, retained to reconstruct the same recipe. */
        model: z.string().min(1).max(1024).optional(),
        workerImage: DockerEmployeeWorkerImage,
      })
      .strict(),
    requestDigest: digest,
  })
  .strict()
  .refine((seed) => {
    const row = seed.source.record,
      binding = seed.source.binding,
      target = seed.target,
      destination = row.destination;
    return (
      ['provider-issued', 'ready'].includes(row.phase) &&
      (seed.forceBusy ||
        (seed.source.observation.kind === 'running' && seed.source.observation.provider.kind === 'observed')) &&
      (target.accountSource.kind === 'canonical' ||
        target.accountSource.originalCanonicalSnapshotDigest === target.accountSnapshotDigest) &&
      !!destination &&
      binding.operationId === row.request.operationId &&
      binding.sessionId === row.request.sessionId &&
      binding.sessionGeneration === row.request.sessionGeneration &&
      binding.credentialId === row.credentialId &&
      binding.containerId === destination.containerId &&
      binding.imageId === destination.imageId &&
      binding.originalDigest === dockerContinuationDigest(destination) &&
      binding.policyDigest === dockerContinuationDigest(row.policy) &&
      (row.version === 1 || seed.source.providerSourceDigest === row.providerSourceDigest) &&
      target.sessionId !== binding.sessionId &&
      target.sessionGeneration === binding.sessionGeneration + 1 &&
      target.operationId !== binding.operationId &&
      target.credentialId !== binding.credentialId &&
      target.workerImage.sourceImageId === destination.imageId
    );
  });
export type DockerPlanMoveSeed = z.infer<typeof DockerPlanMoveSeed>;
const sourceStopBase = {
  epoch: uuid,
  sourceContainerId: digest,
  sourceConfigurationDigest: digest,
  sourceInit: z
    .object({ pid: z.number().int().positive().max(2147483647), startTicks: ticks })
    .strict()
    .nullable(),
};
export const DockerPlanMoveSourceStop = z.discriminatedUnion('phase', [
  z.object({ ...sourceStopBase, phase: z.literal('issued') }).strict(),
  z.object({ ...sourceStopBase, phase: z.literal('closed'), terminalStateDigest: digest }).strict(),
]);
export type DockerPlanMoveSourceStop = z.infer<typeof DockerPlanMoveSourceStop>;
/** Exact bytes submitted by the shared guarded recovery-prompt writer. */
export function dockerPlanMoveHandoffDigest(text: string): string {
  return createHash('sha256')
    .update(text.replace(/[\r\n]+/g, ' ') + '\r')
    .digest('hex');
}
export const DockerPlanMoveJournalState = z
  .object({
    version: z.literal(1),
    purpose: z.literal('docker-plan-replacement-v1'),
    epoch: uuid,
    seed: DockerPlanMoveSeed,
    sourceStop: DockerPlanMoveSourceStop.optional(),
    sourceReader: DockerPlanMoveSourceReader.optional(),
    // Resolved metadata only. Credentials and context file contents never enter
    // the journal; these hashes do not grant installer or provider authority.
    material: z.object({ context: DockerPlanSourceContext, authDigest: digest }).strict().optional(),
    work: DockerEmployeePlanReplacementWorkRecord.optional(),
    paidDispatch: z
      .object({
        phase: z.literal('issued'),
        epoch: uuid,
        operationId: uuid,
        sessionId: uuid,
        containerId: digest,
        recipeDigest: digest,
      })
      .strict()
      .optional(),
    companyPublication: z
      .discriminatedUnion('phase', [
        z.object({ phase: z.literal('issued'), digest }).strict(),
        z.object({ phase: z.literal('published'), digest }).strict(),
      ])
      .optional(),
    handoff: z
      .object({ phase: z.enum(['issued', 'submitted']), digest })
      .strict()
      .optional(),
  })
  .strict()
  .refine((state) => {
    const {
      seed,
      sourceStop: stop,
      sourceReader: reader,
      material,
      work,
      paidDispatch: paid,
      companyPublication: publication,
      handoff,
    } = state;
    const source = seed.source.record.destination!,
      target = seed.target;
    if (
      stop &&
      (stop.sourceContainerId !== source.containerId ||
        stop.sourceConfigurationDigest !== source.configurationDigest ||
        !isEqual(stop.sourceInit, seed.source.observation.kind === 'running' ? seed.source.observation.init : null) ||
        (stop.phase === 'issued' && seed.source.observation.kind === 'stopped'))
    )
      return false;
    if (
      reader &&
      (stop?.phase !== 'closed' || reader.imageId !== target.workerImage.imageId || (paid && reader.phase !== 'closed'))
    )
      return false;
    if (
      work &&
      (stop?.phase !== 'closed' ||
        work.employeeId !== seed.source.record.employeeId ||
        work.owner !== seed.source.record.owner ||
        work.request.sessionId !== target.sessionId ||
        work.request.sessionGeneration !== target.sessionGeneration ||
        work.request.operationId !== target.operationId ||
        work.credentialId !== target.credentialId ||
        !isEqual(work.original, source) ||
        !isEqual(work.workerImage, target.workerImage) ||
        work.planReplacement.moveId !== seed.moveId ||
        !isEqual(work.planReplacement.source.binding, seed.source.binding) ||
        work.planReplacement.source.continuationDigest !== dockerContinuationDigest(seed.source.record) ||
        work.planReplacement.source.providerSourceDigest !== seed.source.providerSourceDigest ||
        work.planReplacement.account.id !== target.accountId ||
        work.planReplacement.account.provider !== target.provider)
    )
      return false;
    if (material) {
      if (!work) return false;
      try {
        dockerPlanContextForProvider(material.context, target.provider);
        const resolved = dockerPlanMaterial(
          {
            operationId: target.operationId,
            sessionId: target.sessionId,
            provider: target.provider,
            accountId: target.accountId,
            context: material.context,
          },
          material.authDigest
        );
        if (
          work.planReplacement.account.projectionDigest !== resolved.projectionDigest ||
          work.planReplacement.account.contextDigest !== resolved.contextInputDigest
        )
          return false;
      } catch {
        return false;
      }
    }
    if (
      paid &&
      (!work ||
        !['provider-issued', 'ready'].includes(work.phase) ||
        paid.epoch !== state.epoch ||
        paid.operationId !== target.operationId ||
        paid.sessionId !== target.sessionId ||
        paid.containerId !== work.destination?.containerId ||
        paid.recipeDigest !== work.sourceDigest ||
        !DockerEmployeeContinuationRecord.safeParse(work).success)
    )
      return false;
    if (work && ['provider-issued', 'ready'].includes(work.phase) && !paid) return false;
    if (publication && !paid) return false;
    if (
      handoff &&
      (publication?.phase !== 'published' ||
        work?.phase !== 'ready' ||
        handoff.digest !== dockerPlanMoveHandoffDigest(seed.handoff))
    )
      return false;
    return true;
  });
function isEqual(left: unknown, right: unknown): boolean {
  return dockerContinuationDigest(left) === dockerContinuationDigest(right);
}
export type DockerPlanMoveJournalState = z.infer<typeof DockerPlanMoveJournalState>;

/** Publish only monotonic native cursor DATA. This function supplies no native
 * completion credit; each actor must still earn its physical proof. */
export function assertDockerPlanMoveTransition(
  before: DockerPlanMoveJournalState,
  next: DockerPlanMoveJournalState
): void {
  DockerPlanMoveJournalState.parse(before);
  DockerPlanMoveJournalState.parse(next);
  const unchanged = (left: unknown, right: unknown) => isEqual(left, right);
  if (before.epoch !== next.epoch || !unchanged(before.seed, next.seed))
    throw Error('Docker plan actor or immutable seed changed');
  if (before.material && (!next.material || !unchanged(before.material, next.material)))
    throw Error('Resolved Docker plan material changed');
  if (before.work && !before.material && next.material)
    throw Error('Historical Docker work cannot acquire replacement material');
  if (!before.work && next.work && !next.material) throw Error('New Docker work requires its resolved material');
  if (before.sourceStop?.phase === 'closed') {
    if (!unchanged(before.sourceStop, next.sourceStop)) throw Error('Docker plan source closure regressed');
  } else if (before.sourceStop) {
    if (!next.sourceStop) throw Error('Docker plan source closure disappeared');
    const { phase: _oldPhase, ...oldStop } = before.sourceStop;
    const { phase: _newPhase, ...newStop } = next.sourceStop;
    if ('terminalStateDigest' in newStop) delete (newStop as Partial<typeof newStop>).terminalStateDigest;
    if (!unchanged(oldStop, newStop)) throw Error('Docker plan source closure changed');
  }
  const oldReader = before.sourceReader,
    reader = next.sourceReader;
  if (!oldReader && reader && reader.phase !== 'create-issued')
    throw Error('Source reader requires its original create intent');
  if (oldReader) {
    if (
      !reader ||
      oldReader.name !== reader.name ||
      oldReader.imageId !== reader.imageId ||
      oldReader.configurationDigest !== reader.configurationDigest ||
      ('containerId' in oldReader &&
        oldReader.containerId !== undefined &&
        (!('containerId' in reader) || oldReader.containerId !== reader.containerId)) ||
      ('init' in oldReader &&
        oldReader.init !== undefined &&
        (!('init' in reader) || !unchanged(oldReader.init, reader.init)))
    )
      throw Error('Source reader immutable scope changed');
    const transitions: Record<DockerPlanMoveSourceReader['phase'], readonly DockerPlanMoveSourceReader['phase'][]> = {
      'create-issued': ['created', 'closed'],
      created: ['start-issued', 'running', 'closed'],
      'start-issued': ['running', 'closed'],
      running: ['close-issued', 'closed'],
      'close-issued': ['closed'],
      closed: [],
    };
    if (!unchanged(oldReader, reader) && !transitions[oldReader.phase].includes(reader.phase))
      throw Error('Source reader cursor changed');
  }
  if (!before.handoff && next.handoff?.phase === 'submitted')
    throw Error('Docker plan handoff requires its original input intent');
  for (const field of ['paidDispatch', 'companyPublication', 'handoff'] as const) {
    if (!before[field]) continue;
    if (!next[field]) throw Error('Docker plan publication changed');
    if (
      field === 'companyPublication' &&
      before.companyPublication?.phase === 'issued' &&
      next.companyPublication?.phase === 'published' &&
      before.companyPublication.digest === next.companyPublication.digest
    )
      continue;
    if (
      field === 'handoff' &&
      before.handoff?.phase === 'issued' &&
      next.handoff?.phase === 'submitted' &&
      before.handoff.digest === next.handoff.digest
    )
      continue;
    if (!unchanged(before[field], next[field])) throw Error('Docker plan publication changed');
  }
  if (!before.work) return;
  if (!next.work) throw Error('Docker plan native work disappeared');
  const {
    phase: oldPhase,
    tasks: oldTasks = [],
    pool: oldPool,
    destination: oldDestination,
    ephemeralRestoration: oldEphemeral,
    ...oldWork
  } = before.work;
  const {
    phase: newPhase,
    tasks: newTasks = [],
    pool: newPool,
    destination: newDestination,
    ephemeralRestoration: newEphemeral,
    ...newWork
  } = next.work;
  if (
    !unchanged(oldEphemeral ?? null, newEphemeral ?? null) &&
    (before.paidDispatch || !newEphemeral || !allowedEphemeralTransition(oldEphemeral, newEphemeral))
  )
    throw Error('Docker plan ephemeral task changed');
  const phases = DockerEmployeeContinuationPhase.options;
  if (
    !unchanged(oldWork, newWork) ||
    phases.indexOf(newPhase) < phases.indexOf(oldPhase) ||
    (oldPool && !unchanged(oldPool, newPool)) ||
    (oldDestination && !unchanged(oldDestination, newDestination))
  )
    throw Error('Docker plan native work changed');
  for (const oldTask of oldTasks) {
    const task = newTasks.find((item) => item.role === oldTask.role);
    if (!task || (!unchanged(oldTask, task) && !allowedDockerTaskTransition(oldTask, task)))
      throw Error('Docker plan native task changed');
  }
  for (const task of newTasks)
    if (!oldTasks.some((item) => item.role === task.role) && task.phase !== 'create-issued')
      throw Error('Docker plan native task requires its original intent');
}
