/** The owner's cleanup of superseded laptop leftovers on the Docker host.
 *
 * `report` reads only. `apply` recomputes the same report, requires the digest
 * the owner was shown, and then removes exactly the listed helpers and images,
 * one at a time, through the Engine port's own re-proving removals. Anything
 * this cannot prove superseded is reported as kept and never touched: storage
 * holders, the shared pool, laptops and their sources, volumes and networks are
 * outside it altogether. Every Engine call is asynchronous and bounded. */
import { z } from 'zod';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import {
  DOCKER_LEFTOVER_CONTAINER_BATCH,
  DOCKER_LEFTOVER_IMAGE_BATCH,
  classifyDockerLeftoverImages,
  classifyDockerLeftovers,
  dockerLeftoverFacts,
  dockerLeftoverSourceImages,
  parseDockerSize,
  type DockerLeftoverContainer,
  type DockerLeftoverEntry,
  type DockerLeftoverFacts,
  type DockerLeftoverImage,
  type DockerLeftoverImageEntry,
  type DockerLeftoverRecords,
  type DockerLeftoverSourceImages,
} from './docker-leftover-cleanup-data.js';

const cid = /^[a-f0-9]{64}$/,
  image = /^sha256:[a-f0-9]{64}$/;
/** The most containers one host listing may hold before the report refuses to guess. */
const LISTING_LIMIT = 2048,
  INSPECT_CHUNK = 32,
  KEPT_LIMIT = 512;
/** One line of JSON per container, with only what the classification reads.
 * The command is included for a leaf writer alone, to name its laptop. */
const INSPECT_FORMAT =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"State":{{json .State}},' +
  '"Labels":{{json .Config.Labels}},"Cmd":{{if eq (index .Config.Labels "reverie.box.resource.role") "leaf-helper"}}' +
  '{{json .Config.Cmd}}{{else}}null{{end}}}';
const inspected = z.object({
  Id: z.string().regex(cid),
  Name: z.string().min(2).max(256),
  Image: z.string().max(128),
  State: z
    .object({
      Status: z.string().max(32),
      Running: z.boolean(),
      Paused: z.boolean(),
      Restarting: z.boolean(),
      Dead: z.boolean(),
      Pid: z.number().int().nonnegative(),
    })
    .passthrough(),
  Labels: z.record(z.string(), z.string()).nullable(),
  Cmd: z.array(z.string().max(4096)).max(512).nullable(),
});
function refuse(code: string, cause?: unknown): never {
  throw new DockerEmployeeContinuationError(code, 409, cause === undefined ? undefined : { cause });
}
function lines(text: unknown): string[] {
  if (typeof text !== 'string') refuse('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED');
  return (text as string)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
export interface DockerLeftoverCleanupConfiguration {
  readonly boxId: string;
  readonly deployment: string;
  readonly workerImageId: string;
  readonly sourceImageIds: readonly string[];
  /** Every helper image the runtime configuration pins. Never removed. */
  readonly helperImageIds: readonly string[];
}
export interface DockerLeftoverCleanupDependencies {
  /** The canonical company state. Read, never edited. */
  records(): DockerLeftoverRecords;
  /** Whether this office process is running a laptop operation of that employee right now. */
  inFlight(employeeId: string): boolean;
  /** The plan move journal, once the server has bound it. */
  planMoves():
    | { openMoves(employeeId: string, owner: string | undefined): Promise<readonly { readonly id: string }[]> }
    | undefined;
  runtimeCurrent(): void;
}
/** Docker's own disk usage line for one kind of object, as it printed it and in bytes. */
export interface DockerLeftoverUsage {
  readonly total: number | null;
  readonly active: number | null;
  readonly size: string;
  readonly sizeBytes: number | null;
  readonly reclaimable: string;
  readonly reclaimableBytes: number | null;
}
export interface DockerLeftoverReport {
  readonly version: 1;
  readonly purpose: 'reverie-boxed-leftover-report-v1';
  readonly boxId: string;
  readonly deployment: string;
  /** Binds exactly what `apply` would remove. `apply` must echo it. */
  readonly digest: string;
  readonly containers: {
    readonly listed: number;
    /** Removed by one `apply`, at most a fixed batch. */
    readonly remove: readonly Omit<DockerLeftoverEntry, 'proof' | 'decision'>[];
    /** Also superseded; a later report offers them. */
    readonly deferred: number;
    readonly kept: readonly Omit<DockerLeftoverEntry, 'proof' | 'decision'>[];
    /** Kept containers beyond the listed ones are counted here only. */
    readonly keptByReason: readonly { readonly kind: string; readonly reason: string; readonly count: number }[];
  };
  readonly images: {
    readonly remove: readonly Omit<DockerLeftoverImageEntry, 'decision'>[];
    readonly deferred: number;
    readonly kept: readonly Omit<DockerLeftoverImageEntry, 'decision'>[];
  };
  readonly sourceImageIds: DockerLeftoverSourceImages;
  /** What Docker itself reports, before anything is removed. Null when it did not answer. */
  readonly docker: { readonly images: DockerLeftoverUsage | null; readonly containers: DockerLeftoverUsage | null };
  /** Bytes Docker attributes to the listed images alone. Layers they share only with each other come on top;
   * layers they share with an image that stays are not freed. Null when Docker reported no sizes. */
  readonly reclaimableImageBytes: number | null;
  readonly allowedActions: readonly 'apply'[];
}
export interface DockerLeftoverResult {
  readonly digest: string;
  readonly state: 'complete' | 'incomplete';
  /** Why it stopped early. Everything listed in `removed` is gone; nothing else was touched. */
  readonly code?: string;
  readonly removed: { readonly containers: readonly string[]; readonly images: readonly string[] };
  /** Superseded leftovers a new report will offer next. */
  readonly deferred: { readonly containers: number; readonly images: number };
}
interface Plan {
  readonly report: DockerLeftoverReport;
  readonly facts: DockerLeftoverFacts;
  readonly containers: readonly DockerLeftoverEntry[];
  readonly images: readonly DockerLeftoverImageEntry[];
}
export class DockerLeftoverCleanup {
  #busy = false;
  /** The store replaces its state and never edits it, so the same object is the same records. */
  #seen?: { readonly records: DockerLeftoverRecords; readonly fingerprint: string };
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly configuration: DockerLeftoverCleanupConfiguration,
    private readonly deps: DockerLeftoverCleanupDependencies
  ) {
    if (!cid.test(configuration.boxId)) throw Error('Fixed boxed namespace required');
    if (
      ![configuration.workerImageId, ...configuration.sourceImageIds, ...configuration.helperImageIds].every((id) =>
        image.test(id)
      )
    )
      throw Error('Fixed boxed images required');
  }
  async #run(args: readonly string[], code = 'DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED'): Promise<string> {
    try {
      return await this.command.run(args);
    } catch (cause) {
      return refuse(code, cause);
    }
  }
  async #listed(): Promise<string[]> {
    const ids = lines(await this.#run(['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}']));
    if (ids.length > LISTING_LIMIT || ids.some((id) => !cid.test(id)) || new Set(ids).size !== ids.length)
      refuse('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED');
    return ids.sort();
  }
  /** The Engine's complete container listing, read in bounded chunks and
   * confirmed by a second listing. A container that appears or goes during
   * the read makes the whole inventory unknown, never a partial one. */
  async #inventory(): Promise<DockerLeftoverContainer[]> {
    const ids = await this.#listed(),
      result: DockerLeftoverContainer[] = [];
    for (let index = 0; index < ids.length; index += INSPECT_CHUNK) {
      const chunk = ids.slice(index, index + INSPECT_CHUNK),
        rows = lines(await this.#run(['container', 'inspect', '--format', INSPECT_FORMAT, ...chunk]));
      if (rows.length !== chunk.length) refuse('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED');
      rows.forEach((row, at) => {
        let parsed: z.infer<typeof inspected>;
        try {
          parsed = inspected.parse(JSON.parse(row));
        } catch (cause) {
          return refuse('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED', cause);
        }
        if (parsed.Id !== chunk[at]) refuse('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED');
        result.push({
          id: parsed.Id,
          name: parsed.Name,
          imageId: parsed.Image,
          labels: parsed.Labels ?? {},
          state: {
            status: parsed.State.Status,
            running: parsed.State.Running,
            paused: parsed.State.Paused,
            restarting: parsed.State.Restarting,
            dead: parsed.State.Dead,
            pid: parsed.State.Pid,
          },
          command: parsed.Cmd,
        });
      });
    }
    if (JSON.stringify(await this.#listed()) !== JSON.stringify(ids)) refuse('DOCKER_LEFTOVER_INVENTORY_CHANGED');
    return result;
  }
  /** Sizes are Docker's own figures and optional: without them the report says so and removes the same things. */
  async #sizes(): Promise<Map<string, number | null>> {
    const sizes = new Map<string, number | null>();
    try {
      const rows = z
        .array(z.object({ ID: z.string(), UniqueSize: z.string() }).passthrough())
        .max(4096)
        .parse(JSON.parse(await this.command.run(['system', 'df', '--verbose', '--format', '{{json .Images}}'])));
      for (const row of rows) sizes.set(row.ID, parseDockerSize(row.UniqueSize));
    } catch {
      sizes.clear();
    }
    return sizes;
  }
  async #images(): Promise<DockerLeftoverImage[]> {
    const tags = new Map<string, string[]>();
    for (const line of lines(
      await this.#run(['image', 'ls', '--no-trunc', '--format', '{{.ID}}\t{{.Repository}}\t{{.Tag}}'])
    )) {
      const [id, repository, tag, ...rest] = line.split('\t');
      if (!id || !image.test(id) || !repository || !tag || rest.length) refuse('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED');
      const listed = tags.get(id!) ?? [];
      if (repository !== '<none>' || tag !== '<none>') listed.push(repository + ':' + tag);
      tags.set(id!, listed);
    }
    if (tags.size > LISTING_LIMIT) refuse('DOCKER_LEFTOVER_INVENTORY_UNCONFIRMED');
    const sizes = await this.#sizes();
    return [...tags].map(([id, listed]) => ({ id, tags: listed, uniqueBytes: sizes.get(id) ?? null }));
  }
  async #usage(): Promise<DockerLeftoverReport['docker']> {
    const found: Record<string, DockerLeftoverUsage> = {};
    try {
      for (const line of lines(await this.command.run(['system', 'df', '--format', '{{json .}}']))) {
        const row = z
          .object({
            Type: z.string(),
            TotalCount: z.string(),
            Active: z.string(),
            Size: z.string().max(64),
            Reclaimable: z.string().max(64),
          })
          .parse(JSON.parse(line));
        const count = (value: string) => (/^[0-9]{1,9}$/.test(value) ? Number(value) : null);
        found[row.Type] = {
          total: count(row.TotalCount),
          active: count(row.Active),
          size: row.Size,
          sizeBytes: parseDockerSize(row.Size),
          reclaimable: row.Reclaimable,
          reclaimableBytes: parseDockerSize(row.Reclaimable),
        };
      }
    } catch {
      return { images: null, containers: null };
    }
    return { images: found.Images ?? null, containers: found.Containers ?? null };
  }
  /** Employees whose superseded helpers are present and who have an operation in flight. */
  async #flights(
    records: DockerLeftoverRecords,
    facts: DockerLeftoverFacts,
    containers: readonly DockerLeftoverContainer[]
  ): Promise<Map<string, string>> {
    const employees = new Set<string>(),
      flights = new Map<string, string>(),
      journal = this.deps.planMoves();
    for (const container of containers) {
      const helper = facts.retiredHelpers.get(container.id);
      if (helper) employees.add(helper.employeeId);
    }
    for (const employeeId of [...employees].sort()) {
      if (this.deps.inFlight(employeeId)) flights.set(employeeId, 'laptop-operation');
      else if (!journal) flights.set(employeeId, 'plan-journal-unavailable');
      else {
        const owner = [...records.employees, ...(records.retired ?? [])].find((row) => row.id === employeeId)?.owner;
        let open: readonly unknown[] | undefined;
        try {
          open = await journal.openMoves(employeeId, owner);
        } catch {
          open = undefined;
        }
        if (!open) flights.set(employeeId, 'plan-journal-unreadable');
        else if (open.length) flights.set(employeeId, 'plan-move-open');
      }
    }
    return flights;
  }
  async #plan(require: () => void): Promise<Plan> {
    this.deps.runtimeCurrent();
    require();
    const records = this.deps.records();
    let facts: DockerLeftoverFacts;
    try {
      facts = dockerLeftoverFacts(records);
    } catch (cause) {
      return refuse('DOCKER_LEFTOVER_RECORDS_UNREADABLE', cause);
    }
    this.#seen = { records, fingerprint: facts.fingerprint };
    const listed = await this.#inventory(),
      inFlight = await this.#flights(records, facts, listed),
      entries = classifyDockerLeftovers(listed, { boxId: this.configuration.boxId, facts, inFlight }),
      superseded = entries.filter((entry) => entry.decision === 'remove'),
      batch = superseded.slice(0, DOCKER_LEFTOVER_CONTAINER_BATCH),
      going = new Set(batch.map((entry) => entry.containerId)),
      scope = {
        facts,
        workerImageId: this.configuration.workerImageId,
        sourceImageIds: this.configuration.sourceImageIds,
        helperImageIds: this.configuration.helperImageIds,
        staying: listed.filter((container) => !going.has(container.id)).map((container) => container.imageId),
      },
      inventory = await this.#images(),
      classified = classifyDockerLeftoverImages(inventory, scope),
      unused = classified.filter((entry) => entry.decision === 'remove'),
      images = unused.slice(0, DOCKER_LEFTOVER_IMAGE_BATCH),
      docker = await this.#usage();
    this.deps.runtimeCurrent();
    require();
    // The records every decision above rests on are still the records.
    if (this.#fingerprint() !== facts.fingerprint) refuse('DOCKER_LEFTOVER_SCOPE_CHANGED');
    const kept = entries.filter((entry) => entry.decision === 'keep'),
      groups = new Map<string, number>();
    for (const entry of kept) {
      const key = entry.kind + '\t' + entry.reason;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const plain = ({ proof: _proof, decision: _decision, ...entry }: DockerLeftoverEntry) => entry,
      plainImage = ({ decision: _decision, ...entry }: DockerLeftoverImageEntry) => entry,
      sizes = images.map((entry) => entry.uniqueBytes);
    const report: DockerLeftoverReport = {
      version: 1,
      purpose: 'reverie-boxed-leftover-report-v1',
      boxId: this.configuration.boxId,
      deployment: this.configuration.deployment,
      digest: dockerContinuationDigest({
        purpose: 'reverie-boxed-leftover-removal-v1',
        boxId: this.configuration.boxId,
        deployment: this.configuration.deployment,
        workerImageId: this.configuration.workerImageId,
        containers: batch.map((entry) => ({ id: entry.containerId, kind: entry.kind, proof: entry.proof })),
        images: images.map((entry) => ({ id: entry.imageId, tags: entry.tags })),
      }),
      containers: {
        listed: listed.length,
        remove: batch.map(plain),
        deferred: superseded.length - batch.length,
        kept: kept.slice(0, KEPT_LIMIT).map(plain),
        keptByReason: [...groups]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([key, count]) => ({ kind: key.split('\t')[0]!, reason: key.split('\t')[1]!, count })),
      },
      images: {
        remove: images.map(plainImage),
        deferred: unused.length - images.length,
        kept: classified.filter((entry) => entry.decision === 'keep').map(plainImage),
      },
      sourceImageIds: dockerLeftoverSourceImages(inventory, scope),
      docker,
      reclaimableImageBytes: sizes.every((bytes): bytes is number => bytes !== null)
        ? sizes.reduce((sum, bytes) => sum + bytes, 0)
        : null,
      allowedActions: batch.length || images.length ? ['apply'] : [],
    };
    return { report, facts, containers: batch, images };
  }
  #fingerprint(): string | undefined {
    try {
      const records = this.deps.records();
      if (this.#seen?.records !== records)
        this.#seen = { records, fingerprint: dockerLeftoverFacts(records).fingerprint };
      return this.#seen.fingerprint;
    } catch {
      return undefined;
    }
  }
  async #single<T>(body: () => Promise<T>): Promise<T> {
    if (this.#busy) refuse('DOCKER_LEFTOVER_BUSY');
    this.#busy = true;
    try {
      return await body();
    } finally {
      this.#busy = false;
    }
  }
  /** Read-only. Lists what one `apply` would remove and everything it keeps, with the reason. */
  report(require: () => void): Promise<DockerLeftoverReport> {
    return this.#single(async () => (await this.#plan(require)).report);
  }
  /** Removes exactly what a report with this digest listed: helpers first, so
   * the images they pinned are free, then images. It stops at the first
   * removal it cannot confirm and says how far it got. Nothing is forced. */
  apply(input: { readonly expectedDigest: string }, require: () => void): Promise<DockerLeftoverResult> {
    return this.#single(async () => {
      const plan = await this.#plan(require),
        { report, facts } = plan;
      if (report.digest !== input.expectedDigest) refuse('DOCKER_LEFTOVER_SCOPE_CHANGED');
      if (!plan.containers.length && !plan.images.length) refuse('DOCKER_LEFTOVER_NOTHING_TO_REMOVE');
      if (!this.command.removeSupersededHelper || !this.command.removeUnusedLaptopImage)
        refuse('DOCKER_LEFTOVER_REMOVAL_UNAVAILABLE');
      let revoked: unknown;
      const current = (employeeId?: string) => () => {
        try {
          this.deps.runtimeCurrent();
          require();
        } catch (cause) {
          revoked = cause;
          throw cause;
        }
        if (this.#fingerprint() !== facts.fingerprint) refuse('DOCKER_LEFTOVER_SCOPE_CHANGED');
        if (employeeId !== undefined && this.deps.inFlight(employeeId)) refuse('DOCKER_LEFTOVER_OPERATION_IN_FLIGHT');
      };
      const removed = { containers: [] as string[], images: [] as string[] };
      let code: string | undefined;
      const settle = (cause: unknown) =>
        cause instanceof DockerEmployeeContinuationError ? cause.code : 'DOCKER_LEFTOVER_REMOVAL_UNCONFIRMED';
      for (const entry of plan.containers) {
        try {
          await this.command.removeSupersededHelper!(entry.containerId, entry.proof!, current(entry.employeeId));
          // Only a positive listing that no longer holds the ID settles a removal.
          const still = await this.#run(
            ['container', 'ls', '--all', '--no-trunc', '--filter', 'id=' + entry.containerId, '--format', '{{.ID}}'],
            'DOCKER_LEFTOVER_REMOVAL_UNCONFIRMED'
          );
          if (still.trim() !== '') refuse('DOCKER_LEFTOVER_REMOVAL_UNCONFIRMED');
          removed.containers.push(entry.containerId);
        } catch (cause) {
          code = settle(cause);
          break;
        }
      }
      for (const entry of code ? [] : plan.images) {
        try {
          await this.command.removeUnusedLaptopImage!(entry.imageId, entry.tags, current());
          const still = lines(
            await this.#run(['image', 'ls', '--no-trunc', '--format', '{{.ID}}'], 'DOCKER_LEFTOVER_REMOVAL_UNCONFIRMED')
          );
          if (still.includes(entry.imageId)) refuse('DOCKER_LEFTOVER_REMOVAL_UNCONFIRMED');
          removed.images.push(entry.imageId);
        } catch (cause) {
          code = settle(cause);
          break;
        }
      }
      // The one trace of what an apply removed; the next report shows what is left.
      console.info(
        `[docker-leftover-cleanup] removed ${removed.containers.length} helper(s) and ${removed.images.length} ` +
          `image(s) of report ${report.digest.slice(0, 12)}` +
          (code ? `, stopped at ${code}` : '') +
          (revoked !== undefined ? ', authority no longer current' : '')
      );
      if (revoked !== undefined) throw revoked;
      return {
        digest: report.digest,
        state: code ? 'incomplete' : 'complete',
        ...(code ? { code } : {}),
        removed,
        deferred: { containers: report.containers.deferred, images: report.images.deferred },
      };
    });
  }
}
