/** Bounded ephemeral projection and intent DATA, never host mkdir authority. */
import { z } from 'zod';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DockerEmployeeInspect } from './docker-employee-engine-data.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import type { DockerEmployeeOriginal, DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const EphemeralDirectory = z
  .object({
    dev: decimal,
    ino: decimal,
    uid: z.number().int().positive().safe(),
    gid: z.number().int().nonnegative().safe(),
    mode: z.literal(0o700),
  })
  .strict();
export type EphemeralDirectory = z.infer<typeof EphemeralDirectory>;
export const EphemeralLayout = z.enum(['employees', 'operator-recovery', 'operator-sessions']);
export type EphemeralLayout = z.infer<typeof EphemeralLayout>;
export const EphemeralRequest = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ephemeral-directory-restore-v1'),
    operationId: uuid,
    employeeId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    invocation: z.number().int().positive().safe(),
    layout: EphemeralLayout,
    root: EphemeralDirectory,
    forbidden: z.array(z.object({ dev: decimal, ino: decimal }).strict()).max(16),
  })
  .strict();
export type EphemeralRequest = z.infer<typeof EphemeralRequest>;
export const EphemeralAck = EphemeralRequest.omit({ forbidden: true })
  .extend({
    purpose: z.literal('reverie-ephemeral-directories-ready-v1'),
    scratch: EphemeralDirectory,
    tmp: EphemeralDirectory,
  })
  .strict();
export type EphemeralAck = z.infer<typeof EphemeralAck>;
const attemptBase = {
  ordinal: z.number().int().min(1).max(32),
  name: z.string().regex(/^reverie-boxed-ephemeral-[a-f0-9]{64}$/),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rootSource: z.string().min(1).max(4096),
  request: EphemeralRequest,
};
const cid = z.string().regex(/^[a-f0-9]{64}$/);
export const EphemeralAttempt = z.discriminatedUnion('phase', [
  z.object({ ...attemptBase, phase: z.literal('create-issued'), containerId: cid.optional() }).strict(),
  z.object({ ...attemptBase, phase: z.literal('created'), containerId: cid }).strict(),
  z.object({ ...attemptBase, phase: z.literal('start-issued'), containerId: cid }).strict(),
  z.object({ ...attemptBase, phase: z.literal('completed'), containerId: cid, ack: EphemeralAck }).strict(),
]);
export type EphemeralAttempt = z.infer<typeof EphemeralAttempt>;
const continuationBase = {
  attemptOrdinal: z.number().int().min(1).max(32),
  invocation: z.number().int().min(33).safe(),
};
export const EphemeralContinuation = z.discriminatedUnion('phase', [
  z.object({ ...continuationBase, phase: z.literal('create-issued') }).strict(),
  z.object({ ...continuationBase, phase: z.literal('created'), containerId: cid }).strict(),
  z.object({ ...continuationBase, phase: z.literal('start-issued'), containerId: cid }).strict(),
  z.object({ ...continuationBase, phase: z.literal('completed'), containerId: cid, ack: EphemeralAck }).strict(),
]);
export type EphemeralContinuation = z.infer<typeof EphemeralContinuation>;
export const EphemeralRestoration = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ephemeral-restoration-v1'),
    attempts: z.array(EphemeralAttempt).min(1).max(32),
    continuation: EphemeralContinuation.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.attempts.every(
        (attempt, index) => attempt.ordinal === index + 1 && attempt.request.invocation === index + 1
      ) &&
      (!value.continuation ||
        (value.attempts.length === 32 &&
          (!('containerId' in value.continuation) ||
            value.attempts[value.continuation.attemptOrdinal - 1]?.containerId === value.continuation.containerId)))
  );
export type EphemeralRestoration = z.infer<typeof EphemeralRestoration>;
function discovery(before: readonly EphemeralAttempt[], next: readonly EphemeralAttempt[]): boolean {
  return (
    before.length === next.length &&
    before.every((item, index) => {
      const value = next[index]!;
      if (isDeepStrictEqual(item, value)) return true;
      if (
        item.phase !== 'create-issued' ||
        value.phase !== 'create-issued' ||
        item.containerId !== undefined ||
        value.containerId === undefined
      )
        return false;
      const { containerId: _id, ...rest } = value;
      return isDeepStrictEqual(item, rest);
    })
  );
}
export function allowedEphemeralTransition(
  before: EphemeralRestoration | undefined,
  next: EphemeralRestoration
): boolean {
  const prior = before?.attempts ?? [],
    after = next.attempts,
    old = before?.continuation,
    value = next.continuation;
  if (old || value) {
    if (!value || !discovery(prior, after)) return false;
    if (!old) return value.invocation === 33 && ['create-issued', 'created'].includes(value.phase);
    if (old.attemptOrdinal !== value.attemptOrdinal) return false;
    // Every older invocation remains issued/unconfirmed. A later ACK settles ONLY its own counter.
    if (value.invocation === old.invocation + 1)
      return (
        ['create-issued', 'created'].includes(value.phase) &&
        (!('containerId' in old) || ('containerId' in value && old.containerId === value.containerId))
      );
    if (value.invocation !== old.invocation) return false;
    if (isDeepStrictEqual(old, value)) return true;
    if ('containerId' in old && (!('containerId' in value) || old.containerId !== value.containerId)) return false;
    return (
      {
        'create-issued': ['created'],
        created: ['start-issued'],
        'start-issued': ['completed'],
        completed: [],
      } as Record<EphemeralContinuation['phase'], readonly string[]>
    )[old.phase].includes(value.phase);
  }
  if (discovery(prior, after)) return true;
  if (after.length === prior.length + 1)
    return (
      isDeepStrictEqual(after.slice(0, -1), prior) &&
      after.at(-1)!.phase === 'create-issued' &&
      after.at(-1)!.ordinal === after.length
    );
  if (!prior.length || after.length !== prior.length || !isDeepStrictEqual(prior.slice(0, -1), after.slice(0, -1)))
    return false;
  const original = prior.at(-1)!,
    updated = after.at(-1)!;
  const clean = (item: EphemeralAttempt) => {
    const { phase: _phase, ...rest } = item;
    return Object.fromEntries(Object.entries(rest).filter(([key]) => !['containerId', 'ack'].includes(key)));
  };
  if (!isDeepStrictEqual(clean(original), clean(updated))) return false;
  if ('containerId' in original && (!('containerId' in updated) || original.containerId !== updated.containerId))
    return false;
  return (
    { 'create-issued': ['created'], created: ['start-issued'], 'start-issued': ['completed'], completed: [] } as Record<
      EphemeralAttempt['phase'],
      readonly string[]
    >
  )[original.phase].includes(updated.phase);
}
export interface EphemeralProjection {
  rootSource: string;
  layout: EphemeralLayout;
  identity: string;
  scratchSource: string;
  tmpSource: string;
}
function within(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/');
}
export function ephemeralProjection(
  source: DockerEmployeeInspect,
  employeeId: string,
  sessionId: string
): EphemeralProjection | undefined {
  uuid.parse(employeeId);
  uuid.parse(sessionId);
  const scratch = source.Mounts.filter((mount) => mount.Destination === '/scratch');
  const tmp = source.Mounts.filter((mount) => mount.Destination === '/tmp');
  if (!scratch.length && !tmp.some((mount) => mount.Type === 'bind')) return;
  if (
    scratch.length !== 1 ||
    tmp.length !== 1 ||
    scratch[0]!.Type !== 'bind' ||
    tmp[0]!.Type !== 'bind' ||
    !scratch[0]!.RW ||
    !tmp[0]!.RW
  )
    return;
  const selected = scratch[0]!.Source;
  if (
    !selected.startsWith('/') ||
    selected.length > 4096 ||
    /[\r\n\0]/.test(selected) ||
    posix.normalize(selected) !== selected
  )
    return;
  const layout = EphemeralLayout.options.find((role) =>
    selected.endsWith('/laptops/' + role + '/' + (role === 'employees' ? employeeId : sessionId))
  );
  if (!layout) return;
  const identity = layout === 'employees' ? employeeId : sessionId;
  const suffix = '/laptops/' + layout + '/' + identity,
    rootSource = selected.slice(0, -suffix.length);
  if (!rootSource || tmp[0]!.Source !== selected + '/tmp')
    throw new DockerEmployeeContinuationError('DOCKER_EPHEMERAL_SOURCE_PAIR_INVALID');
  for (const mount of source.Mounts.filter(
    (value) => value !== scratch[0] && value !== tmp[0] && value.Type !== 'tmpfs'
  )) {
    if (
      !mount.Source.startsWith('/') ||
      within(selected, mount.Source) ||
      within(mount.Source, selected) ||
      within(rootSource, mount.Source)
    )
      throw new DockerEmployeeContinuationError('DOCKER_EPHEMERAL_PERSISTENT_OVERLAP');
  }
  return { rootSource, layout, identity, scratchSource: selected, tmpSource: selected + '/tmp' };
}

/** A retained operator directory may predate several plan generations. Derive
 * its closed UUID selector only from the exact original mount descriptor. This
 * is projection DATA; the owner still earns actual fixed-root FD/inode custody. */
export function ephemeralRetainedProjection(
  source: DockerEmployeeInspect,
  original: DockerEmployeeOriginal
): EphemeralProjection | undefined {
  const mounts = [...source.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination));
  if (
    source.Id !== original.containerId ||
    source.Image !== original.imageId ||
    dockerContinuationDigest(mounts) !== original.mountDigest
  )
    throw new DockerEmployeeContinuationError('DOCKER_EPHEMERAL_ORIGINAL_CHANGED');
  const scratch = source.Mounts.find((m) => m.Destination === '/scratch');
  const match = scratch?.Source.match(/\/laptops\/(?:operator-recovery|operator-sessions)\/([^/]+)$/);
  const selector = match ? uuid.parse(match[1]) : original.sessionId;
  return ephemeralProjection(source, original.employeeId, selector);
}
export function ephemeralContinuationProjection(
  source: DockerEmployeeInspect,
  row: DockerEmployeeContinuationRecord
): EphemeralProjection | undefined {
  if (row.version !== 3) return ephemeralProjection(source, row.employeeId, row.request.sessionId);
  const projection = ephemeralRetainedProjection(source, row.original);
  if (
    projection &&
    projection.layout !== 'employees' &&
    projection.identity !== (row.planReplacement.source.ephemeralSessionId ?? row.original.sessionId)
  )
    throw new DockerEmployeeContinuationError('DOCKER_EPHEMERAL_ORIGINAL_CHANGED');
  return projection;
}
export function ephemeralDirectorySessionId(row: DockerEmployeeContinuationRecord): string {
  return row.version === 3
    ? (row.planReplacement.source.ephemeralSessionId ?? row.original.sessionId)
    : row.request.sessionId;
}

export interface EphemeralJournal {
  readEphemeral(
    row: import('./docker-employee-continuation-data.js').DockerEmployeeContinuationRecord
  ): EphemeralRestoration | undefined;
  publishEphemeral(
    row: import('./docker-employee-continuation-data.js').DockerEmployeeContinuationRecord,
    before: EphemeralRestoration | undefined,
    next: EphemeralRestoration,
    current: () => void
  ): Promise<void>;
}
