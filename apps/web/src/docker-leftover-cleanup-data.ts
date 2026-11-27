/** Which stopped one-shot helpers and laptop images of this box are provably
 * superseded. Pure DATA: nothing here reads the Engine or grants a removal.
 *
 * A helper is superseded only when a laptop record that the office itself
 * RETIRED (after the Engine positively listed that laptop absent) names this
 * exact container as its ephemeral-directory helper, identity installer or
 * leaf writer. Every other container is kept, with the reason. */
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { reprovisionHeads, type DockerAbsentContinuationRetirement } from './docker-absent-reprovision-data.js';
import { DOCKER_TASK_ATTEMPT_LIMIT } from './docker-continuation-task.js';
import { parseDockerLeafWriterArguments } from './docker-resource-leaf-census.js';

const CONTAINER_ID = /^[a-f0-9]{64}$/,
  IMAGE_ID = /^sha256:[a-f0-9]{64}$/,
  UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most helpers and images one report offers for removal. A later report lists the rest. */
export const DOCKER_LEFTOVER_CONTAINER_BATCH = 48;
export const DOCKER_LEFTOVER_IMAGE_BATCH = 8;
/** Laptop image repositories this office's build tags. An image with any other tag is not ours to remove. */
const LAPTOP_IMAGE_TAG = /^reverie-boxed-(?:worker|source):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type DockerLeftoverKind =
  | 'ephemeral-helper'
  | 'identity-helper'
  | 'leaf-helper'
  | 'storage-holder'
  | 'pool-anchor'
  | 'pool-helper'
  | 'laptop-source'
  | 'laptop'
  | 'other-boxed'
  | 'foreign';
export type DockerLeftoverKeepReason =
  /** Not a container this office instance created: another name, box or deployment. */
  | 'foreign'
  /** A boxed name this cleanup has no rule for. */
  | 'unclassified'
  /** Holds read-only handles on an employee's home and Nix store; its log is re-read. Never removed here. */
  | 'storage-holder'
  /** The shared pool anchor and its writers; pool reconciliation re-reads their logs. */
  | 'shared-pool'
  /** A laptop or its never-started source. Only the owner's laptop rebuild removes one. */
  | 'laptop'
  /** Created, running, paused, restarting or dead: not a finished one-shot helper. */
  | 'not-terminal'
  /** Named by a laptop record, binding or pending cursor that is still current. */
  | 'current-operation'
  /** No retired laptop record names this container. */
  | 'unrecorded'
  /** A retired record names this ID, but the container's name, image or labels differ from it. */
  | 'record-mismatch'
  /** The employee has a laptop operation, reprovision or plan move in flight. */
  | 'operation-in-flight'
  /** The employee's current installer is absent; removing the others would change the office's own inventory. */
  | 'installer-inventory'
  /** The laptop this leaf writer wrote to still exists or is still recorded. */
  | 'worker-present';
export interface DockerLeftoverContainer {
  readonly id: string;
  /** As the Engine reports it, with the leading slash. */
  readonly name: string;
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: {
    readonly status: string;
    readonly running: boolean;
    readonly paused: boolean;
    readonly restarting: boolean;
    readonly dead: boolean;
    readonly pid: number;
  };
  /** The command of a leaf writer only; it names the laptop it wrote to. */
  readonly command?: readonly string[] | null;
}
export interface DockerLeftoverImage {
  readonly id: string;
  readonly tags: readonly string[];
  /** Bytes Docker reports as used by this image alone, when it reported them. */
  readonly uniqueBytes: number | null;
}
/** The part of the canonical company state this reads. Never edited. */
export interface DockerLeftoverRecords {
  readonly employees: readonly { readonly id: string; readonly owner?: string; readonly dockerBinding?: unknown }[];
  readonly retired?: readonly { readonly id: string; readonly owner?: string; readonly dockerBinding?: unknown }[];
  readonly dockerEmployeeContinuations?: readonly DockerEmployeeContinuationRecord[];
  readonly retiredDockerEmployeeContinuations?: readonly DockerAbsentContinuationRetirement[];
  readonly dockerSharedPoolLineages?: unknown;
  readonly dockerPoolObservations?: unknown;
}
interface RetiredHelper {
  readonly kind: 'ephemeral-helper' | 'identity-helper' | 'leaf-helper';
  readonly name: string;
  readonly imageId: string;
  readonly operationId: string;
  readonly employeeId: string;
}
export interface DockerLeftoverFacts {
  /** Container IDs a current record, binding or pending cursor names. */
  readonly protectedIds: ReadonlySet<string>;
  /** Every identifier those same records carry: operations, sessions, employees. */
  readonly liveOperations: ReadonlySet<string>;
  /** Image IDs those same records carry. */
  readonly liveImages: ReadonlySet<string>;
  /** Image IDs of retired laptop generations. */
  readonly retiredImages: ReadonlySet<string>;
  /** Helper containers named by a retired record. `null` marks an ID two records disagree about. */
  readonly retiredHelpers: ReadonlyMap<string, RetiredHelper | null>;
  /** Employees whose own durable history shows an unfinished operation. */
  readonly pending: ReadonlyMap<string, string>;
  /** The identity installer of each employee's current record, where it names one. */
  readonly currentInstaller: ReadonlyMap<string, string>;
  /** Changes whenever any fact above could. */
  readonly fingerprint: string;
}
interface Scan {
  readonly ids: Set<string>;
  readonly operations: Set<string>;
  readonly images: Set<string>;
  nodes: number;
}
/** Every identifier anywhere inside a record. A record too large to read whole is refused, never read in part. */
function scan(value: unknown, into: Scan, depth = 0): void {
  if (++into.nodes > 200_000 || depth > 32) throw Error('Docker record exceeds its bound');
  if (typeof value === 'string') {
    if (CONTAINER_ID.test(value)) into.ids.add(value);
    else if (IMAGE_ID.test(value)) into.images.add(value);
    else if (UUID.test(value)) into.operations.add(value);
  } else if (Array.isArray(value)) for (const item of value) scan(item, into, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) scan(item, into, depth + 1);
}
function settled(entry: DockerAbsentContinuationRetirement): boolean {
  return (
    entry.source.phase === 'created' &&
    entry.session.phase === 'cleared' &&
    (!entry.removal || entry.removal.phase === 'removed')
  );
}
function retiredHelpers(entries: readonly DockerAbsentContinuationRetirement[]): Map<string, RetiredHelper | null> {
  const result = new Map<string, RetiredHelper | null>();
  const add = (id: string, helper: RetiredHelper) => {
    const before = result.get(id);
    result.set(id, before === undefined || JSON.stringify(before) === JSON.stringify(helper) ? helper : null);
  };
  for (const entry of entries) {
    const record = entry.record;
    if (!record) continue;
    const bound = { operationId: record.request.operationId, employeeId: record.employeeId };
    for (const task of record.tasks ?? [])
      if ((task.role === 'identity-helper' || task.role === 'leaf-helper') && 'containerId' in task)
        add(task.containerId, { kind: task.role, name: task.name, imageId: task.imageId, ...bound });
    for (const attempt of record.ephemeralRestoration?.attempts ?? [])
      if (attempt.containerId)
        add(attempt.containerId, {
          kind: 'ephemeral-helper',
          name: attempt.name,
          imageId: attempt.imageId,
          ...bound,
        });
  }
  return result;
}
/** Derives every fact from one view of the company state. */
export function dockerLeftoverFacts(records: DockerLeftoverRecords): DockerLeftoverFacts {
  const live: Scan = { ids: new Set(), operations: new Set(), images: new Set(), nodes: 0 },
    history: Scan = { ids: new Set(), operations: new Set(), images: new Set(), nodes: 0 },
    rows = records.dockerEmployeeContinuations ?? [],
    entries = records.retiredDockerEmployeeContinuations ?? [],
    pending = new Map<string, string>(),
    currentInstaller = new Map<string, string>();
  const bindings = [...records.employees, ...(records.retired ?? [])].map((employee) => employee.dockerBinding ?? null);
  scan([rows, bindings, records.dockerSharedPoolLineages ?? null, records.dockerPoolObservations ?? null], live);
  const cursors: unknown[] = [];
  for (const employeeId of new Set(entries.map((entry) => entry.employeeId))) {
    const heads = reprovisionHeads(entries, employeeId);
    if (heads.length !== 1) pending.set(employeeId, 'history-inconsistent');
    // The newest entry's source may still be waiting for its first laptop.
    for (const head of heads) cursors.push([head.operationId, head.source, head.removal ?? null]);
  }
  for (const entry of entries) {
    if (settled(entry)) continue;
    pending.set(entry.employeeId, 'reprovision-pending');
    cursors.push([entry.operationId, entry.source, entry.removal ?? null, entry.session, entry.absent]);
  }
  scan(cursors, live);
  for (const row of rows) {
    const installer = row.tasks?.find((task) => task.role === 'identity-helper');
    if (installer && 'containerId' in installer) currentInstaller.set(row.employeeId, installer.containerId);
  }
  scan(
    entries.map((entry) => [entry.record ?? null, entry.binding, entry.source]),
    history
  );
  const helpers = retiredHelpers(entries);
  return {
    protectedIds: live.ids,
    liveOperations: live.operations,
    liveImages: live.images,
    retiredImages: history.images,
    retiredHelpers: helpers,
    pending,
    currentInstaller,
    fingerprint: dockerContinuationDigest({
      rows,
      bindings,
      pools: [records.dockerSharedPoolLineages ?? null, records.dockerPoolObservations ?? null],
      cursors,
      pending: [...pending].sort(),
      helpers: [...helpers].sort(([left], [right]) => (left < right ? -1 : 1)),
      images: [...history.images].sort(),
    }),
  };
}

const KINDS: readonly (readonly [RegExp, DockerLeftoverKind])[] = [
  [/^\/reverie-boxed-ephemeral-[a-f0-9]{64}$/, 'ephemeral-helper'],
  [/^\/reverie-boxed-identity-[a-f0-9]{64}$/, 'identity-helper'],
  [/^\/reverie-boxed-leaf-helper-[a-f0-9]{64}$/, 'leaf-helper'],
  [/^\/reverie-boxed-storage-[a-f0-9]{64}$/, 'storage-holder'],
  [/^\/reverie-boxed-anchor-[a-f0-9]{32}$/, 'pool-anchor'],
  [/^\/reverie-boxed-pool-helper-[a-f0-9]{64}$/, 'pool-helper'],
  [/^\/reverie-boxed-source-[a-f0-9]{64}$/, 'laptop-source'],
  [/^\/reverie-boxed-[a-f0-9]{64}$/, 'laptop'],
  [/^\/reverie-boxed-/, 'other-boxed'],
];
export function dockerLeftoverKind(name: string): DockerLeftoverKind {
  return KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'foreign';
}
const FIXED: Partial<Record<DockerLeftoverKind, DockerLeftoverKeepReason>> = {
  foreign: 'foreign',
  'other-boxed': 'unclassified',
  'storage-holder': 'storage-holder',
  'pool-anchor': 'shared-pool',
  'pool-helper': 'shared-pool',
  'laptop-source': 'laptop',
  laptop: 'laptop',
};
/** The labels a helper's creator gave it. They are what the Engine port proves again before a removal. */
export function dockerLeftoverProofLabels(
  kind: RetiredHelper['kind'],
  boxId: string,
  name: string,
  helper: Pick<RetiredHelper, 'operationId' | 'employeeId'>
): Record<string, string> {
  if (kind === 'ephemeral-helper')
    return { 'reverie.box.ephemeral.box': boxId, 'reverie.box.ephemeral.operation': helper.operationId };
  if (kind === 'identity-helper')
    return {
      'reverie.box.identity.box': boxId,
      'reverie.box.identity.operation': helper.operationId,
      'reverie.box.identity.employee': helper.employeeId,
    };
  return {
    'org.reverie.purpose': 'boxed-resource-helper-v1',
    'reverie.box.resource.box': boxId,
    'reverie.box.resource.role': 'leaf-helper',
    'reverie.box.resource.name': name.slice(1),
  };
}
/** The name this box gives that helper of that operation. */
function derivedName(container: DockerLeftoverContainer, helper: RetiredHelper, boxId: string): boolean {
  const name = container.name.slice(1),
    operation = helper.operationId;
  if (helper.kind === 'ephemeral-helper') {
    const ordinal = container.labels['reverie.box.ephemeral.ordinal'] ?? '';
    return (
      /^(?:[1-9]|[12][0-9]|3[0-2])$/.test(ordinal) &&
      name === 'reverie-boxed-ephemeral-' + dockerContinuationDigest([boxId, operation, Number(ordinal)])
    );
  }
  if (helper.kind === 'identity-helper')
    return name === 'reverie-boxed-identity-' + dockerContinuationDigest([boxId, 'identity-helper', operation]);
  return Array.from({ length: DOCKER_TASK_ATTEMPT_LIMIT }, (_unused, index) => index + 1).some(
    (attempt) =>
      name ===
      'reverie-boxed-leaf-helper-' +
        dockerContinuationDigest([boxId, 'leaf-helper', operation, ...(attempt > 1 ? [{ attempt }] : [])])
  );
}
function leafWorker(container: DockerLeftoverContainer, boxId: string): string | undefined {
  try {
    return parseDockerLeafWriterArguments(container.command ?? [], boxId).workerId;
  } catch {
    return undefined;
  }
}
export interface DockerLeftoverEntry {
  readonly containerId: string;
  readonly name: string;
  readonly kind: DockerLeftoverKind;
  readonly state: string;
  readonly imageId: string;
  readonly decision: 'remove' | 'keep';
  /** Why it is kept, or `superseded-operation` for a removal. */
  readonly reason: DockerLeftoverKeepReason | 'superseded-operation';
  readonly employeeId?: string;
  readonly operationId?: string;
  /** Which unfinished operation holds it, for `operation-in-flight`. */
  readonly detail?: string;
  /** Present on a removal only. */
  readonly proof?: DockerSupersededHelperProof;
}
/** What the Engine port must read again, unchanged, immediately before it removes one helper. */
export interface DockerSupersededHelperProof {
  readonly name: string;
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
}
export interface DockerLeftoverScope {
  readonly boxId: string;
  readonly facts: DockerLeftoverFacts;
  /** Employees with an operation in flight in this office process or its plan journal, by reason. */
  readonly inFlight: ReadonlyMap<string, string>;
}
function decide(
  container: DockerLeftoverContainer,
  kind: RetiredHelper['kind'],
  scope: DockerLeftoverScope,
  present: ReadonlySet<string>
): { keep: DockerLeftoverKeepReason; detail?: string } | { remove: RetiredHelper } {
  const { boxId, facts } = scope,
    labels = container.labels,
    box = { 'ephemeral-helper': 'ephemeral', 'identity-helper': 'identity', 'leaf-helper': 'resource' }[kind],
    state = container.state;
  if (labels['reverie.box.' + box + '.box'] !== boxId) return { keep: 'foreign' };
  if (state.status !== 'exited' || state.running || state.paused || state.restarting || state.dead || state.pid !== 0)
    return { keep: 'not-terminal' };
  if (facts.protectedIds.has(container.id)) return { keep: 'current-operation' };
  const labelled = labels['reverie.box.' + box + '.operation'];
  if (labelled !== undefined && facts.liveOperations.has(labelled)) return { keep: 'current-operation' };
  const helper = facts.retiredHelpers.get(container.id);
  if (helper === undefined) return { keep: 'unrecorded' };
  const expected = helper && dockerLeftoverProofLabels(kind, boxId, container.name, helper);
  if (
    !helper ||
    helper.kind !== kind ||
    '/' + helper.name !== container.name ||
    helper.imageId !== container.imageId ||
    !Object.entries(expected!).every(([key, value]) => labels[key] === value) ||
    !derivedName(container, helper, boxId)
  )
    return { keep: 'record-mismatch' };
  if (facts.liveOperations.has(helper.operationId)) return { keep: 'current-operation' };
  const flight = facts.pending.get(helper.employeeId) ?? scope.inFlight.get(helper.employeeId);
  if (flight !== undefined) return { keep: 'operation-in-flight', detail: flight };
  if (kind === 'identity-helper') {
    // The office treats "no installer of this employee is listed" as a fact of its own. While the
    // current record's installer is missing, the others are what keeps that answer unchanged.
    const current = facts.currentInstaller.get(helper.employeeId);
    if (current !== undefined && !present.has(current)) return { keep: 'installer-inventory' };
  }
  if (kind === 'leaf-helper') {
    const worker = leafWorker(container, boxId);
    if (!worker) return { keep: 'unclassified' };
    if (present.has(worker) || facts.protectedIds.has(worker)) return { keep: 'worker-present' };
  }
  return { remove: helper };
}
/** One decision per listed container, in ID order. `containers` must be the Engine's complete listing. */
export function classifyDockerLeftovers(
  containers: readonly DockerLeftoverContainer[],
  scope: DockerLeftoverScope
): DockerLeftoverEntry[] {
  const present = new Set(containers.map((container) => container.id));
  return [...containers]
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((container) => {
      const kind = dockerLeftoverKind(container.name),
        base = {
          containerId: container.id,
          name: container.name.slice(1),
          kind,
          state: container.state.status,
          imageId: container.imageId,
        };
      const fixed = FIXED[kind];
      if (fixed) return { ...base, decision: 'keep' as const, reason: fixed };
      const removable = kind as RetiredHelper['kind'],
        decision = decide(container, removable, scope, present),
        helper = scope.facts.retiredHelpers.get(container.id) ?? undefined,
        bound = helper ? { employeeId: helper.employeeId, operationId: helper.operationId } : {};
      if ('keep' in decision)
        return {
          ...base,
          ...bound,
          decision: 'keep' as const,
          reason: decision.keep,
          ...(decision.detail ? { detail: decision.detail } : {}),
        };
      return {
        ...base,
        ...bound,
        decision: 'remove' as const,
        reason: 'superseded-operation' as const,
        proof: {
          name: container.name,
          imageId: container.imageId,
          labels: dockerLeftoverProofLabels(removable, scope.boxId, container.name, decision.remove),
        },
      };
    });
}

export type DockerLeftoverImageKeepReason =
  /** Carries a tag outside the laptop image repositories, or none at all. */
  | 'foreign-tag'
  /** The laptop or helper image the office is configured to use. */
  | 'configured-image'
  /** A current laptop record, an employee's binding or a waiting source names it. */
  | 'recorded'
  /** A container that stays was created from it. */
  | 'in-use'
  /** No retired laptop record names it: it may be an image built for the next update. */
  | 'never-recorded'
  /** The configured laptop image is not on this host, so an approved source may be needed to build one. */
  | 'worker-image-absent';
export interface DockerLeftoverImageEntry {
  readonly imageId: string;
  readonly tags: readonly string[];
  readonly uniqueBytes: number | null;
  readonly decision: 'remove' | 'keep';
  readonly reason: DockerLeftoverImageKeepReason | 'superseded-image';
  /** Containers created from it that stay. */
  readonly containers: number;
  /** Whether the runtime configuration still lists it as an approved source. */
  readonly approvedSource: boolean;
}
export interface DockerLeftoverImageScope {
  readonly facts: DockerLeftoverFacts;
  readonly workerImageId: string;
  readonly sourceImageIds: readonly string[];
  readonly helperImageIds: readonly string[];
  /** Image of every container that stays after the helper removals of this same report. */
  readonly staying: readonly string[];
}
/** Laptop images only. Any other image on the host is not listed at all. */
export function classifyDockerLeftoverImages(
  images: readonly DockerLeftoverImage[],
  scope: DockerLeftoverImageScope
): DockerLeftoverImageEntry[] {
  const used = new Map<string, number>();
  for (const imageId of scope.staying) used.set(imageId, (used.get(imageId) ?? 0) + 1);
  const workerPresent = images.some((image) => image.id === scope.workerImageId);
  return [...images]
    .filter((image) => image.tags.some((tag) => LAPTOP_IMAGE_TAG.test(tag)))
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((image) => {
      const containers = used.get(image.id) ?? 0,
        approvedSource = scope.sourceImageIds.includes(image.id);
      const reason: DockerLeftoverImageEntry['reason'] = !image.tags.every((tag) => LAPTOP_IMAGE_TAG.test(tag))
        ? 'foreign-tag'
        : image.id === scope.workerImageId || scope.helperImageIds.includes(image.id)
          ? 'configured-image'
          : scope.facts.liveImages.has(image.id)
            ? 'recorded'
            : containers
              ? 'in-use'
              : !scope.facts.retiredImages.has(image.id)
                ? 'never-recorded'
                : !workerPresent
                  ? 'worker-image-absent'
                  : 'superseded-image';
      return {
        imageId: image.id,
        tags: [...image.tags].sort(),
        uniqueBytes: image.uniqueBytes,
        decision: reason === 'superseded-image' ? ('remove' as const) : ('keep' as const),
        reason,
        containers,
        approvedSource,
      };
    });
}
export interface DockerLeftoverSourceImages {
  readonly configured: number;
  readonly limit: 32;
  /** Entries nothing needs: no current record, binding, waiting source or staying container uses that image. */
  readonly unneeded: readonly string[];
  /** Entries whose image is not on this host at all. A subset may also be `unneeded`. */
  readonly absent: readonly string[];
  readonly needed: readonly { readonly imageId: string; readonly reason: 'worker-image' | 'recorded' | 'in-use' }[];
}
/** Which approved source images the build may drop from the runtime configuration. Reported only. */
export function dockerLeftoverSourceImages(
  images: readonly DockerLeftoverImage[],
  scope: DockerLeftoverImageScope
): DockerLeftoverSourceImages {
  const present = new Set(images.map((image) => image.id)),
    staying = new Set(scope.staying),
    configured = [...new Set(scope.sourceImageIds)].sort(),
    needed: { imageId: string; reason: 'worker-image' | 'recorded' | 'in-use' }[] = [],
    unneeded: string[] = [];
  for (const imageId of configured) {
    const reason =
      imageId === scope.workerImageId
        ? ('worker-image' as const)
        : scope.facts.liveImages.has(imageId)
          ? ('recorded' as const)
          : staying.has(imageId)
            ? ('in-use' as const)
            : undefined;
    if (reason) needed.push({ imageId, reason });
    else unneeded.push(imageId);
  }
  return {
    configured: scope.sourceImageIds.length,
    limit: 32,
    unneeded,
    absent: configured.filter((imageId) => !present.has(imageId)),
    needed,
  };
}
/** Docker prints sizes in decimal units with a few significant digits; this is that figure in bytes. */
export function parseDockerSize(text: unknown): number | null {
  const found = typeof text === 'string' ? /^([0-9]{1,9}(?:\.[0-9]{1,6})?)\s?(B|kB|MB|GB|TB)\b/.exec(text) : null;
  if (!found) return null;
  const bytes = Number(found[1]) * { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[found[2] as 'B'];
  return Number.isSafeInteger(Math.round(bytes)) ? Math.round(bytes) : null;
}
