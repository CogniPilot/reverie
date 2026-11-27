import {
  DockerOriginalWriterReceipt,
  DockerOriginalPrestartReceipt,
  DockerResourceOriginalCursorDTO,
} from './docker-resource-original-data.js';
import {
  requireDockerOriginalResourceWriterProof,
  requireDockerOriginalResourcePrestartProof,
} from './docker-resource-original-writer.js';
import { DockerResourceAttemptKey } from './docker-resource-attempt-key.js';
export { DockerResourceAttemptKey } from './docker-resource-attempt-key.js';
/** Separate durable desired/live leaf revisions. Original launch rows and key custody never change. */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
import { DockerSingleAttemptTask, allowedDockerTaskTransition } from './docker-continuation-task.js';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type {
  DockerEmployeeContinuationRecord,
  DockerEmployeeResourcePolicy,
} from './docker-employee-continuation-data.js';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const DockerMemoryHigh = z
  .number()
  .int()
  .safe()
  .min(1024 ** 3)
  .max(1024 ** 4)
  .refine((value) => value % 4096 === 0);
export const DockerResourceDesiredRevision = z
  .object({
    revision: uuid,
    owner: z.string().min(1).max(200).nullable(),
    scope: z.literal('all-current-and-future'),
    memoryHighBytes: DockerMemoryHigh,
  })
  .strict();
export type DockerResourceDesiredRevision = z.infer<typeof DockerResourceDesiredRevision>;
export const DockerResourceLeafIdentity = z
  .object({
    boxId: digest,
    parent: z.object({ path: z.string().max(4096), dev: decimal, ino: decimal }).strict(),
    anchor: z
      .object({
        id: digest,
        pid: z.number().int().positive().safe(),
        startTicks: decimal,
        path: z.string().max(4096),
        dev: decimal,
        ino: decimal,
      })
      .strict(),
    worker: z
      .object({
        id: digest,
        pid: z.number().int().positive().safe(),
        startTicks: decimal,
        path: z.string().max(4096),
        dev: decimal,
        ino: decimal,
      })
      .strict(),
  })
  .strict();
export type DockerResourceLeafIdentity = z.infer<typeof DockerResourceLeafIdentity>;
const base = DockerResourceAttemptKey;
export const DockerResourceClosedWriter = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-memory-writer-closed-v1'),
    authority: z.literal('canonical-issued-high-only-image-v1'),
    containerId: digest,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    configurationDigest: digest,
    terminalStateDigest: digest,
    exitCode: z.number().int().min(0).max(255),
    identity: DockerResourceLeafIdentity,
    originalOutcome: z.literal('unknown'),
  })
  .strict();
export type DockerResourceClosedWriter = z.infer<typeof DockerResourceClosedWriter>;
const DockerResourceRetiredIntent = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-memory-unstarted-intent-retired-v1'),
    authority: z.literal('canonical-prestart-cas-v1'),
    taskDigest: digest,
    originalOutcome: z.literal('unknown'),
  })
  .strict();

const defaultPublicationOrigin = Symbol('actual locked default validation before publication');
class DockerDefaultPublicationRefusal extends DockerEmployeeContinuationError {
  readonly #revision: string;
  constructor(origin: symbol, revision: string, code: string) {
    if (origin !== defaultPublicationOrigin) throw Error('Actual default publication refusal required');
    super(
      z
        .enum([
          'DOCKER_RESOURCE_REVISION_CHANGED',
          'DOCKER_RESOURCE_REVISION_CAPACITY',
          'DOCKER_RESOURCE_REVISION_ORIGINAL_ATTEMPT_PENDING',
        ])
        .parse(code)
    );
    this.#revision = uuid.parse(revision);
    Object.freeze(this);
  }
  describe() {
    return {
      code: this.code,
      action: 'approve-default' as const,
      revision: this.#revision,
      publication: 'not-issued' as const,
    };
  }
}
Object.freeze(DockerDefaultPublicationRefusal.prototype);
/** DATA only. An aggregate/finalizer/transport failure cannot carry a prewrite outcome. */
export function dockerDefaultPublicationRefusal(error: unknown) {
  try {
    return DockerDefaultPublicationRefusal.prototype.describe.call(error as DockerDefaultPublicationRefusal);
  } catch {
    return undefined;
  }
}

const attemptPublicationOrigin = Symbol('actual initial attempt capacity rejection before publication');
class DockerAttemptPublicationRefusal extends DockerEmployeeContinuationError {
  readonly #target: ReturnType<typeof dockerResourceAttemptKey>;
  constructor(origin: symbol, target: ReturnType<typeof dockerResourceAttemptKey>) {
    if (origin !== attemptPublicationOrigin) throw Error('Actual initial resource publication refusal required');
    super('DOCKER_RESOURCE_REVISION_CAPACITY');
    this.#target = base.parse(target);
    Object.freeze(this);
  }
  describe() {
    const { employeeId, sessionId, sessionGeneration, operationId, containerId, revision } = this.#target;
    return {
      code: this.code,
      action: 'apply' as const,
      publication: 'not-issued' as const,
      employeeId,
      sessionId,
      sessionGeneration,
      operationId,
      containerId,
      revision,
    };
  }
}
Object.freeze(DockerAttemptPublicationRefusal.prototype);
export function dockerAttemptPublicationRefusal(error: unknown) {
  try {
    return DockerAttemptPublicationRefusal.prototype.describe.call(error as DockerAttemptPublicationRefusal);
  } catch {
    return undefined;
  }
}
function isPublicationRefusal(error: unknown) {
  return error instanceof DockerDefaultPublicationRefusal || error instanceof DockerAttemptPublicationRefusal;
}

export const DockerResourceAttempt = z.discriminatedUnion('state', [
  base.extend({
    state: z.literal('original-closed'),
    task: DockerSingleAttemptTask.refine((t) => t.role === 'leaf-helper'),
    originalClosure: DockerOriginalWriterReceipt,
  }),
  base.extend({
    state: z.literal('original-retired'),
    task: DockerSingleAttemptTask.refine(
      (t) => t.role === 'leaf-helper' && ['create-issued', 'created'].includes(t.phase)
    ),
    originalRetirement: DockerOriginalPrestartReceipt,
  }),
  base.extend({
    state: z.literal('helper'),
    task: DockerSingleAttemptTask.refine((task) => task.role === 'leaf-helper'),
  }),
  base.extend({
    state: z.literal('unstarted-retired'),
    task: DockerSingleAttemptTask.refine(
      (task) => task.role === 'leaf-helper' && ['create-issued', 'created'].includes(task.phase)
    ),
    retirement: DockerResourceRetiredIntent,
  }),
  base.extend({
    state: z.literal('observed-after-retirement'),
    task: DockerSingleAttemptTask.refine(
      (task) => task.role === 'leaf-helper' && ['create-issued', 'created'].includes(task.phase)
    ),
    retirement: DockerResourceRetiredIntent,
    identity: DockerResourceLeafIdentity,
    observationDigest: digest,
  }),
  base.extend({ state: z.literal('observed'), identity: DockerResourceLeafIdentity, observationDigest: digest }),
  base.extend({
    state: z.literal('applied'),
    identity: DockerResourceLeafIdentity,
    observationDigest: digest,
    task: DockerSingleAttemptTask.refine((task) => task.phase === 'completed' && task.role === 'leaf-helper'),
  }),
  base.extend({
    state: z.literal('closed-writer'),
    task: DockerSingleAttemptTask.refine(
      (task) => task.role === 'leaf-helper' && ['start-issued', 'running', 'completed'].includes(task.phase)
    ),
    closure: DockerResourceClosedWriter,
  }),
  base.extend({
    state: z.literal('observed-after-closure'),
    task: DockerSingleAttemptTask.refine(
      (task) => task.role === 'leaf-helper' && ['start-issued', 'running', 'completed'].includes(task.phase)
    ),
    closure: DockerResourceClosedWriter,
    identity: DockerResourceLeafIdentity,
    observationDigest: digest,
  }),
]);
export type DockerResourceAttempt = z.infer<typeof DockerResourceAttempt>;
const ledger = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    purpose: z.literal('reverie-docker-resource-revisions-v1'),
    desired: z.array(DockerResourceDesiredRevision).max(256),
    attempts: z.array(DockerResourceAttempt).max(4096),
  })
  .strict();
type Ledger = z.infer<typeof ledger>;

export const DockerResourceLedgerByteLimit = 2 * 1024 ** 2;
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Constructive upper bounds for the actual closed schemas. JSON needs at most six
 * bytes per UTF-16 unit; NUL attains that maximum. Safe integers use <=16 decimal
 * digits. Regex-only fields are ASCII. Every task phase and attempt variant is
 * represented, including BOTH copies of identity after terminal closure.
 * Owning tests pin union coverage and each field's accepting/rejecting boundary. */
export function dockerResourceCapacityWitnesses(): DockerResourceAttempt[] {
  const hex = 'f'.repeat(64),
    uuidMax = 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    decimalMax = '9'.repeat(20);
  const identity = DockerResourceLeafIdentity.parse({
    boxId: hex,
    parent: { path: '\0'.repeat(4096), dev: decimalMax, ino: decimalMax },
    anchor: {
      id: hex,
      pid: Number.MAX_SAFE_INTEGER,
      startTicks: decimalMax,
      path: '\0'.repeat(4096),
      dev: decimalMax,
      ino: decimalMax,
    },
    worker: {
      id: hex,
      pid: Number.MAX_SAFE_INTEGER,
      startTicks: decimalMax,
      path: '\0'.repeat(4096),
      dev: decimalMax,
      ino: decimalMax,
    },
  });
  const key = {
    revision: uuidMax,
    scopeDigest: hex,
    employeeId: uuidMax,
    sessionId: uuidMax,
    sessionGeneration: Number.MAX_SAFE_INTEGER,
    operationId: uuidMax,
    containerId: hex,
  };
  const taskBase = {
    role: 'leaf-helper',
    name: 'reverie-boxed-' + 'z'.repeat(100),
    imageId: 'sha256:' + hex,
    configurationDigest: hex,
  };
  const tasks = [
    { ...taskBase, phase: 'create-issued' },
    { ...taskBase, phase: 'created', containerId: hex },
    { ...taskBase, phase: 'start-issued', containerId: hex },
    { ...taskBase, phase: 'running', containerId: hex, initPid: Number.MAX_SAFE_INTEGER, initStartTicks: decimalMax },
    { ...taskBase, phase: 'completed', containerId: hex, resultDigest: hex },
  ].map((task) => DockerSingleAttemptTask.parse(task));
  const make = (extra: Record<string, unknown>) => DockerResourceAttempt.parse({ ...key, ...extra });
  const result = tasks.map((task) => make({ state: 'helper', task }));
  result.push(make({ state: 'observed', identity, observationDigest: hex }));
  for (const task of tasks) {
    if (task.phase === 'create-issued' || task.phase === 'created') {
      const retirement = {
        version: 1,
        purpose: 'reverie-memory-unstarted-intent-retired-v1',
        authority: 'canonical-prestart-cas-v1',
        taskDigest: dockerContinuationDigest(task),
        originalOutcome: 'unknown',
      };
      result.push(
        make({ state: 'unstarted-retired', task, retirement }),
        make({ state: 'observed-after-retirement', task, retirement, identity, observationDigest: hex })
      );
    } else {
      const closure = {
        version: 1,
        purpose: 'reverie-memory-writer-closed-v1',
        authority: 'canonical-issued-high-only-image-v1',
        containerId: hex,
        imageId: task.imageId,
        configurationDigest: task.configurationDigest,
        terminalStateDigest: hex,
        exitCode: 255,
        identity,
        originalOutcome: 'unknown',
      };
      result.push(
        make({ state: 'closed-writer', task, closure }),
        make({ state: 'observed-after-closure', task, closure, identity, observationDigest: hex })
      );
      if (task.phase === 'completed') result.push(make({ state: 'applied', task, identity, observationDigest: hex }));
    }
  }
  for (const task of tasks) {
    result.push(
      make({
        state: 'original-closed',
        task,
        originalClosure: {
          version: 1,
          purpose: 'reverie-original-memory-writer-closed-v1',
          authority: 'fresh-original-helper-terminal-v1',
          originalKey: key,
          taskDigest: dockerContinuationDigest(task),
          originalBoxId: hex,
          containerId: hex,
          imageId: task.imageId,
          configurationDigest: task.configurationDigest,
          terminalStateDigest: hex,
          exitCode: 255,
          originalOutcome: 'unknown',
        },
      })
    );
    if (task.phase === 'create-issued' || task.phase === 'created')
      for (const observed of [null, { containerId: hex, originalBoxId: hex, stateDigest: hex }])
        result.push(
          make({
            state: 'original-retired',
            task,
            originalRetirement: {
              version: 1,
              purpose: 'reverie-original-memory-prestart-observation-v1',
              authority: 'canonical-retirement-cas-required-v1',
              originalKey: key,
              taskDigest: dockerContinuationDigest(task),
              observed,
              originalOutcome: 'unknown',
            },
          })
        );
  }
  return result;
}
export const DockerResourceAttemptMaximumBytes = Math.max(...dockerResourceCapacityWitnesses().map(encodedBytes));
/** Size DATA, never effect authority. Mutable records occupy their full proven
 * settlement bound. Old terminal/retired history is immutable after a new owner
 * revision, so its unused reservation is released without dropping any history. */
export function dockerResourceLedgerCapacity(input: unknown) {
  const state = ledger.parse(input);
  const latest = new Map(state.desired.map((desired) => [desired.owner, desired.revision]));
  const approvals = new Map(state.desired.map((desired) => [desired.revision, desired]));
  let reservedBytes = 0;
  for (const attempt of state.attempts) {
    const bytes = encodedBytes(attempt);
    if (bytes > DockerResourceAttemptMaximumBytes) refuse('DOCKER_RESOURCE_REVISION_CAPACITY');
    const approval = approvals.get(attempt.revision);
    const stillCurrent = !approval || latest.get(approval.owner) === attempt.revision;
    if (
      attempt.state === 'helper' ||
      (stillCurrent && (attempt.state === 'closed-writer' || attempt.state === 'unstarted-retired'))
    )
      reservedBytes += DockerResourceAttemptMaximumBytes - bytes;
  }
  const usedBytes = encodedBytes(state);
  return { usedBytes, reservedBytes, requiredBytes: usedBytes + reservedBytes };
}

const empty = (): Ledger => ({
  version: 1,
  purpose: 'reverie-docker-resource-revisions-v1',
  desired: [],
  attempts: [],
});
function refuse(code = 'DOCKER_RESOURCE_REVISION_CHANGED'): never {
  throw new DockerEmployeeContinuationError(code);
}
/** Stable binding only. Native-thread progress/phase cannot replace an operation or original limits. */
export function dockerResourceScope(row: DockerEmployeeContinuationRecord): string {
  return dockerContinuationDigest({
    owner: row.owner ?? null,
    employeeId: row.employeeId,
    request: {
      operationId: row.request.operationId,
      sessionId: row.request.sessionId,
      sessionGeneration: row.request.sessionGeneration,
    },
    destination: row.destination ?? null,
    workerImage: row.workerImage,
    policy: row.policy,
    pool: row.pool ?? null,
    original: row.original,
    sourceDigest: row.sourceDigest,
    credentialId: row.credentialId,
  });
}
export function dockerResourceAttemptKey(row: DockerEmployeeContinuationRecord, revision: string) {
  if (!row.destination) refuse();
  return {
    revision,
    scopeDigest: dockerResourceScope(row),
    employeeId: row.employeeId,
    sessionId: row.request.sessionId,
    sessionGeneration: row.request.sessionGeneration,
    operationId: row.request.operationId,
    containerId: row.destination.containerId,
  };
}
export function dockerOriginalAttemptKey(attempt: DockerResourceAttempt) {
  const { revision, scopeDigest, employeeId, sessionId, sessionGeneration, operationId, containerId } = attempt;
  return base.parse({ revision, scopeDigest, employeeId, sessionId, sessionGeneration, operationId, containerId });
}
function originalMetadataFinal(attempt: DockerResourceAttempt): boolean {
  return attempt.state === 'original-closed' || attempt.state === 'original-retired';
}
function sameKey(a: DockerResourceAttempt, row: DockerEmployeeContinuationRecord, revision: string): boolean {
  const key = dockerResourceAttemptKey(row, revision);
  return Object.entries(key).every(([name, value]) => (a as unknown as Record<string, unknown>)[name] === value);
}
export function dockerRevisedPolicy(
  original: DockerEmployeeResourcePolicy,
  desired: DockerResourceDesiredRevision
): DockerEmployeeResourcePolicy {
  if (desired.memoryHighBytes > original.memoryMaxBytes) refuse('DOCKER_RESOURCE_REVISION_EXCEEDS_HARD_LIMIT');
  return { ...structuredClone(original), memoryHighBytes: desired.memoryHighBytes };
}
/** One owner-controlled journal, flock shared across processes, atomic complete-file replacement.
 * A failed publication finalizer closes this writer; durable issued tasks still fence every restart. */
export class DockerResourceRevisionStore {
  readonly #fd: number;
  readonly #path: string;
  readonly #identity: string;
  #held = false;
  #closed = false;
  #seen = false;
  #seenFormatTwo = false;
  #closeCause: unknown;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {
    if (!directory.startsWith('/') || dirname(directory) === directory) refuse();
    const parent = fs.openSync(
      dirname(directory),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      const p = fs.fstatSync(parent);
      if (!p.isDirectory() || p.uid !== process.getuid?.() || (p.mode & 0o022) !== 0) refuse();
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.fsyncSync(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      fs.closeSync(parent);
    }
    this.#fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    this.#path = '/proc/self/fd/' + this.#fd;
    const stat = fs.fstatSync(this.#fd);
    this.#identity = this.#stamp(stat);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
      fs.closeSync(this.#fd);
      refuse();
    }
    try {
      this.#current();
    } catch (error) {
      fs.closeSync(this.#fd);
      throw error;
    }
  }
  #stamp(stat: fs.Stats): string {
    return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
  }
  #current(): void {
    if (this.#held) refuse('DOCKER_RESOURCE_REVISION_PUBLICATION_UNCONFIRMED');
    try {
      if (
        this.#identity !== this.#stamp(fs.fstatSync(this.#fd)) ||
        this.#identity !== this.#stamp(fs.lstatSync(this.directory))
      )
        refuse();
    } catch (error) {
      this.#held = true;
      throw error;
    }
  }
  #read(): Ledger {
    this.#current();
    let fd: number;
    try {
      fd = fs.openSync(
        join(this.#path, 'revisions.json'),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.#seen) {
          this.#held = true;
          refuse('DOCKER_RESOURCE_REVISION_PUBLICATION_UNCONFIRMED');
        }
        this.#current();
        return empty();
      }
      throw error;
    }
    this.#seen = true;
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.nlink !== 1 ||
        stat.size > DockerResourceLedgerByteLimit
      )
        refuse();
      const raw = fs.readFileSync(fd);
      if (raw.length !== stat.size || !Buffer.from(raw.toString('utf8')).equals(raw)) refuse();
      const after = fs.fstatSync(fd);
      if (
        [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(
          ':'
        ) !==
        [
          after.dev,
          after.ino,
          after.mode,
          after.uid,
          after.gid,
          after.size,
          after.nlink,
          after.mtimeMs,
          after.ctimeMs,
        ].join(':')
      )
        refuse();
      const value = ledger.parse(parseBoxedConfigurationJson(raw.toString('utf8')));
      if (
        new Set(value.desired.map((item) => item.revision)).size !== value.desired.length ||
        new Set(value.attempts.map((item) => [item.revision, item.operationId, item.containerId].join(':'))).size !==
          value.attempts.length
      )
        refuse();
      for (const item of value.attempts) {
        if (item.state === 'original-closed' || item.state === 'original-retired') {
          const r = item.state === 'original-closed' ? item.originalClosure : item.originalRetirement;
          if (
            !isDeepStrictEqual(r.originalKey, dockerOriginalAttemptKey(item)) ||
            r.taskDigest !== dockerContinuationDigest(item.task)
          )
            refuse();
          if (
            item.state === 'original-closed' &&
            (item.originalClosure.imageId !== item.task.imageId ||
              item.originalClosure.configurationDigest !== item.task.configurationDigest ||
              ('containerId' in item.task && item.originalClosure.containerId !== item.task.containerId))
          )
            refuse();
          if (
            item.state === 'original-retired' &&
            item.originalRetirement.observed &&
            'containerId' in item.task &&
            item.originalRetirement.observed.containerId !== item.task.containerId
          )
            refuse();
        }
        if ('retirement' in item && item.retirement.taskDigest !== dockerContinuationDigest(item.task)) refuse();
        if (item.state === 'closed-writer' || item.state === 'observed-after-closure') {
          if (
            !('containerId' in item.task) ||
            item.task.containerId !== item.closure.containerId ||
            item.task.imageId !== item.closure.imageId ||
            item.task.configurationDigest !== item.closure.configurationDigest
          )
            refuse();
          if (item.state === 'observed-after-closure' && !isDeepStrictEqual(item.identity, item.closure.identity))
            refuse();
        }
      }
      if (value.version === 1 && (this.#seenFormatTwo || value.attempts.some(originalMetadataFinal))) {
        this.#held = true;
        refuse('DOCKER_RESOURCE_REVISION_FORMAT_CHANGED');
      }
      if (value.version === 2) this.#seenFormatTwo = true;
      this.#current();
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }
  desired(owner: string | undefined): DockerResourceDesiredRevision | undefined {
    return structuredClone([...this.#read().desired].reverse().find((item) => item.owner === (owner ?? null)));
  }
  revision(owner: string | undefined, revision: string): DockerResourceDesiredRevision | undefined {
    return structuredClone(
      this.#read().desired.find((item) => item.owner === (owner ?? null) && item.revision === revision)
    );
  }
  approved(
    row: DockerEmployeeContinuationRecord
  ): Array<{ desired: DockerResourceDesiredRevision; attempt: DockerResourceAttempt }> {
    const state = this.#read();
    const attempt = [...state.attempts].reverse().find((item) => item.containerId === row.destination?.containerId);
    if (
      !attempt ||
      attempt.state === 'helper' ||
      attempt.state === 'closed-writer' ||
      attempt.state === 'unstarted-retired' ||
      originalMetadataFinal(attempt) ||
      !sameKey(attempt, row, attempt.revision)
    )
      return [];
    const desired = state.desired.find(
      (item) => item.revision === attempt.revision && item.owner === (row.owner ?? null)
    );
    if (!desired) refuse();
    return [structuredClone({ desired, attempt })];
  }
  history(row: DockerEmployeeContinuationRecord): Array<{
    desired: DockerResourceDesiredRevision;
    attempt: DockerResourceAttempt;
  }> {
    const state = this.#read();
    return state.attempts
      .filter((item) => item.containerId === row.destination?.containerId)
      .map((attempt) => {
        if (!sameKey(attempt, row, attempt.revision) && !originalMetadataFinal(attempt)) refuse();
        const desired = state.desired.find(
          (item) => item.revision === attempt.revision && item.owner === (row.owner ?? null)
        );
        if (!desired) refuse();
        return structuredClone({ desired, attempt });
      });
  }
  attempt(row: DockerEmployeeContinuationRecord, revision: string): DockerResourceAttempt | undefined {
    const all = this.#read().attempts.filter(
      (item) =>
        item.operationId === row.request.operationId &&
        item.containerId === row.destination?.containerId &&
        item.revision === revision
    );
    if (all.length > 1 || (all[0] && !sameKey(all[0], row, revision) && !originalMetadataFinal(all[0]))) refuse();
    return structuredClone(all[0]);
  }
  /** Any issued older revision for this binding must settle before a new effect/adoption. */
  requireSettled(row: DockerEmployeeContinuationRecord, revision: string): void {
    if (
      this.#read().attempts.some(
        (item) =>
          item.containerId === row.destination?.containerId &&
          item.state === 'helper' &&
          (item.revision !== revision ||
            item.operationId !== row.request.operationId ||
            item.scopeDigest !== dockerResourceScope(row))
      )
    )
      refuse('DOCKER_RESOURCE_REVISION_ORIGINAL_ATTEMPT_PENDING');
  }
  async #update(change: (state: Ledger) => void, current: () => void): Promise<void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let lock: number | undefined;
    let failure: { cause: unknown } | undefined;
    let checkedPublicationRefusal: unknown;
    try {
      this.#current();
      current();
      lock = fs.openSync(
        join(this.#path, 'writer.lock'),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        0o600
      );
      const stat = fs.fstatSync(lock);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
        refuse();
      await new Promise<void>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '--wait', '5', '--conflict-exit-code', '75', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', lock!],
          env: { PATH: process.env.PATH },
        });
        child.once('error', reject);
        child.once('close', (code) => (code === 0 ? resolve() : reject(Error('Resource revision lock unavailable'))));
      });
      this.#current();
      current();
      const state = this.#read();
      try {
        change(state);
      } catch (cause) {
        if (isPublicationRefusal(cause)) checkedPublicationRefusal = cause;
        throw cause;
      }
      state.version = 2; // Reserve-aware publications fence literal-v1 rollback readers.
      const data = Buffer.from(JSON.stringify(ledger.parse(state)));
      if (dockerResourceLedgerCapacity(state).requiredBytes > DockerResourceLedgerByteLimit)
        refuse('DOCKER_RESOURCE_REVISION_CAPACITY');
      const temporary = join(this.#path, '.stage-' + randomUUID());
      const file = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        fs.writeFileSync(file, data);
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      this.#current();
      current();
      try {
        fs.renameSync(temporary, join(this.#path, 'revisions.json'));
        fs.fsyncSync(this.#fd);
        this.#current();
        current();
        if (!isDeepStrictEqual(this.#read(), state)) refuse();
      } catch (error) {
        this.#held = true;
        throw error;
      }
    } catch (cause) {
      failure = { cause };
    }
    try {
      if (lock !== undefined) fs.closeSync(lock);
    } catch (cause) {
      this.#held = true;
      failure = {
        cause: failure ? new AggregateError([failure.cause, cause], 'Resource journal close unconfirmed') : cause,
      };
    } finally {
      release();
    }
    if (failure) {
      if (isPublicationRefusal(failure.cause) && failure.cause !== checkedPublicationRefusal)
        throw new AggregateError([failure.cause], 'Resource publication outcome unconfirmed');
      throw failure.cause;
    }
  }
  #approvalCode(state: Ledger, owner: string | null): string | undefined {
    const old = [...state.desired].reverse().find((item) => item.owner === owner);
    if (old && state.attempts.some((item) => item.revision === old.revision && item.state === 'helper'))
      return 'DOCKER_RESOURCE_REVISION_ORIGINAL_ATTEMPT_PENDING';
    if (state.desired.length >= 256 || state.attempts.length >= 4096) return 'DOCKER_RESOURCE_REVISION_CAPACITY';
    const occupied = new Set([...state.desired, ...state.attempts].map((value) => value.revision));
    let revision = '';
    for (let index = 0; index <= occupied.size; index++) {
      const candidate = '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
      if (!occupied.has(candidate)) {
        revision = candidate;
        break;
      }
    }
    if (!revision) refuse('DOCKER_RESOURCE_REVISION_CAPACITY');
    const next = { revision, owner, scope: 'all-current-and-future' as const, memoryHighBytes: 1024 ** 4 };
    if (
      dockerResourceLedgerCapacity({ ...state, desired: [...state.desired, next] }).requiredBytes >
      DockerResourceLedgerByteLimit
    )
      return 'DOCKER_RESOURCE_REVISION_CAPACITY';
    return undefined;
  }
  approvalAvailability(owner: string | undefined) {
    const code = this.#approvalCode(this.#read(), owner ?? null);
    return { allowed: code === undefined, ...(code === 'DOCKER_RESOURCE_REVISION_CAPACITY' ? { code } : {}) };
  }
  canApprove(owner: string | undefined): boolean {
    return this.approvalAvailability(owner).allowed;
  }
  actions(row: DockerEmployeeContinuationRecord, revision: string | undefined): string[] {
    if (!revision || this.desired(row.owner)?.revision !== revision) return [];
    const attempt = this.attempt(row, revision);
    if (!attempt) return ['apply'];
    if (attempt.state === 'helper')
      return ['create-issued', 'created'].includes(attempt.task.phase)
        ? ['continue-original', 'abandon-original']
        : ['reconcile'];
    if (originalMetadataFinal(attempt)) return ['new-revision'];
    if (attempt.state === 'closed-writer' || attempt.state === 'unstarted-retired')
      return ['reconcile', 'new-revision'];
    return [];
  }
  approve(desired: DockerResourceDesiredRevision, expectedRevision: string | null, current: () => void): Promise<void> {
    const checked = DockerResourceDesiredRevision.parse(desired);
    return this.#update((state) => {
      const old = [...state.desired].reverse().find((item) => item.owner === checked.owner);
      const notIssued = (code = 'DOCKER_RESOURCE_REVISION_CHANGED'): never => {
        throw new DockerDefaultPublicationRefusal(defaultPublicationOrigin, checked.revision, code);
      };
      if ((old?.revision ?? null) !== expectedRevision) notIssued();
      if (old?.revision === checked.revision) notIssued();
      const blocked = this.#approvalCode(state, checked.owner);
      if (blocked) notIssued(blocked);
      if (
        state.desired.some((item) => item.revision === checked.revision) ||
        state.attempts.some((item) => item.revision === checked.revision)
      )
        notIssued();
      state.desired.push(checked);
    }, current);
  }
  publish(
    row: DockerEmployeeContinuationRecord,
    desired: DockerResourceDesiredRevision,
    before: DockerResourceAttempt | undefined,
    next: DockerResourceAttempt,
    current: () => void
  ): Promise<void> {
    const checked = DockerResourceAttempt.parse(next);
    if (!sameKey(checked, row, desired.revision) || originalMetadataFinal(checked)) refuse();
    return this.#update((state) => {
      if (
        !isDeepStrictEqual(
          [...state.desired].reverse().find((item) => item.owner === desired.owner),
          desired
        )
      )
        refuse();
      if (
        state.attempts.some(
          (item) =>
            item.revision === desired.revision &&
            item.operationId === row.request.operationId &&
            item.containerId === row.destination?.containerId &&
            !sameKey(item, row, desired.revision)
        )
      )
        refuse();
      const index = state.attempts.findIndex((item) => sameKey(item, row, desired.revision));
      if (!isDeepStrictEqual(state.attempts[index], before)) refuse();
      if (
        state.attempts.some(
          (item) =>
            item.containerId === row.destination?.containerId &&
            item.state === 'helper' &&
            (item.revision !== desired.revision ||
              item.operationId !== row.request.operationId ||
              item.scopeDigest !== dockerResourceScope(row))
        )
      )
        refuse();
      if (!before) {
        if (
          checked.state === 'applied' ||
          checked.state === 'closed-writer' ||
          checked.state === 'unstarted-retired' ||
          checked.state === 'observed-after-retirement' ||
          checked.state === 'observed-after-closure' ||
          (checked.state === 'helper' && checked.task.phase !== 'create-issued')
        )
          refuse();
      } else if (before.state === 'helper') {
        if (checked.state === 'helper') {
          if (!allowedDockerTaskTransition(before.task, checked.task)) refuse();
        } else if (checked.state === 'unstarted-retired') {
          if (
            !['create-issued', 'created'].includes(before.task.phase) ||
            !isDeepStrictEqual(before.task, checked.task) ||
            checked.retirement.taskDigest !== dockerContinuationDigest(before.task)
          )
            refuse();
        } else if (checked.state === 'closed-writer') {
          if (
            !isDeepStrictEqual(before.task, checked.task) ||
            !('containerId' in before.task) ||
            checked.closure.containerId !== before.task.containerId ||
            checked.closure.imageId !== before.task.imageId ||
            checked.closure.configurationDigest !== before.task.configurationDigest
          )
            refuse();
        } else if (
          checked.state !== 'applied' ||
          before.task.phase !== 'completed' ||
          !isDeepStrictEqual(before.task, checked.task)
        )
          refuse();
      } else if (before.state === 'unstarted-retired') {
        if (
          checked.state !== 'observed-after-retirement' ||
          !isDeepStrictEqual(before.task, checked.task) ||
          !isDeepStrictEqual(before.retirement, checked.retirement)
        )
          refuse();
      } else if (before.state === 'closed-writer') {
        if (
          checked.state !== 'observed-after-closure' ||
          !isDeepStrictEqual(before.task, checked.task) ||
          !isDeepStrictEqual(before.closure, checked.closure) ||
          !isDeepStrictEqual(checked.identity, before.closure.identity)
        )
          refuse();
      } else refuse();
      const projected = { ...state, attempts: [...state.attempts] };
      if (index < 0) projected.attempts.push(checked);
      else projected.attempts[index] = checked;
      if (dockerResourceLedgerCapacity(projected).requiredBytes > DockerResourceLedgerByteLimit) {
        if (!before)
          throw new DockerAttemptPublicationRefusal(
            attemptPublicationOrigin,
            dockerResourceAttemptKey(row, desired.revision)
          );
        refuse('DOCKER_RESOURCE_REVISION_CAPACITY');
      }
      state.attempts = projected.attempts;
    }, current);
  }

  #original(state: Ledger, owner: string | undefined, cursorId: string) {
    digest.parse(cursorId);
    for (const attempt of state.attempts) {
      if (!('task' in attempt)) continue;
      const desired = state.desired.find(
        (value) => value.revision === attempt.revision && value.owner === (owner ?? null)
      );
      if (!desired) continue;
      const key = dockerOriginalAttemptKey(attempt);
      if (dockerContinuationDigest({ owner: desired.owner, key }) !== cursorId) continue;
      const pending = attempt.state === 'helper';
      const stateName = pending
        ? 'pending'
        : attempt.state === 'applied'
          ? 'acknowledged'
          : attempt.state === 'unstarted-retired' ||
              attempt.state === 'observed-after-retirement' ||
              attempt.state === 'original-retired'
            ? 'retired'
            : 'closed';
      const dto = DockerResourceOriginalCursorDTO.parse({
        revision: key.revision,
        employeeId: key.employeeId,
        sessionId: key.sessionId,
        sessionGeneration: key.sessionGeneration,
        operationId: key.operationId,
        containerId: key.containerId,
        cursorId,
        expectedDigest: dockerContinuationDigest(attempt),
        helperContainerId:
          'containerId' in attempt.task
            ? attempt.task.containerId
            : attempt.state === 'original-closed'
              ? attempt.originalClosure.containerId
              : attempt.state === 'original-retired'
                ? (attempt.originalRetirement.observed?.containerId ?? null)
                : null,
        taskPhase: attempt.task.phase,
        state: stateName,
        originalOutcome: attempt.state === 'applied' ? 'acknowledged' : 'unknown',
        allowedActions: pending
          ? ['create-issued', 'created'].includes(attempt.task.phase)
            ? ['reconcile', 'retire']
            : ['reconcile']
          : [],
        enforcement: 'not-observed',
      });
      return structuredClone({ desired, attempt, key, dto });
    }
    refuse('DOCKER_RESOURCE_ORIGINAL_NOT_FOUND');
  }
  original(owner: string | undefined, cursorId: string) {
    return this.#original(this.#read(), owner, cursorId);
  }
  originals(owner: string | undefined, after?: string) {
    if (after !== undefined) digest.parse(after);
    const state = this.#read();
    const ids = state.attempts
      .filter((value) => value.state === 'helper')
      .flatMap((value) => {
        const desired = state.desired.find((d) => d.revision === value.revision && d.owner === (owner ?? null));
        return desired
          ? [dockerContinuationDigest({ owner: desired.owner, key: dockerOriginalAttemptKey(value) })]
          : [];
      })
      .sort()
      .filter((id) => !after || id > after);
    const selected = ids.slice(0, 64);
    return {
      items: selected.map((id) => this.#original(state, owner, id).dto),
      next: ids.length > 64 ? selected.at(-1)! : null,
      enforcement: 'not-observed' as const,
    };
  }
  /** Metadata settlement never supplies current kernel identity or policy authority. */
  settleOriginal(
    owner: string | undefined,
    cursorId: string,
    expectedDigest: string,
    proof: unknown,
    kind: 'close' | 'retire',
    authority: () => void
  ): Promise<void> {
    digest.parse(expectedDigest);
    return this.#update((state) => {
      const captured = this.#original(state, owner, cursorId);
      if (captured.dto.expectedDigest !== expectedDigest || captured.attempt.state !== 'helper') refuse();
      const before = captured.attempt;
      let next: DockerResourceAttempt;
      if (kind === 'close') {
        const receipt = requireDockerOriginalResourceWriterProof(proof, captured.key, before.task);
        next = DockerResourceAttempt.parse({
          ...captured.key,
          state: 'original-closed',
          task: before.task,
          originalClosure: receipt,
        });
      } else {
        if (!['create-issued', 'created'].includes(before.task.phase)) refuse();
        const receipt = requireDockerOriginalResourcePrestartProof(proof, captured.key, before.task);
        next = DockerResourceAttempt.parse({
          ...captured.key,
          state: 'original-retired',
          task: before.task,
          originalRetirement: receipt,
        });
      }
      const index = state.attempts.findIndex((value) => isDeepStrictEqual(value, before));
      if (index < 0) refuse();
      state.attempts[index] = next;
    }, authority);
  }
  close(): void {
    if (this.#closed) {
      if (this.#closeCause) throw this.#closeCause;
      return;
    }
    this.#closed = true;
    this.#held = true;
    try {
      fs.closeSync(this.#fd);
    } catch (error) {
      this.#closeCause = error;
      throw error;
    }
  }
}
