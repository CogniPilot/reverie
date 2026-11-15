/** Historical helper closure is independent of current employee/worker policy.
 * Only real inspect calls mint these process-local proofs. Serializable receipts
 * are metadata, never a current resource ACK or permission to repeat an effect. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DockerContinuationTask } from './docker-continuation-task.js';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { DockerResourceAttemptKey as keySchema, type DockerResourceAttemptKey } from './docker-resource-attempt-key.js';
import {
  dockerResourceHelperConfiguration,
  inspectDockerResourceContainer,
  requireDockerMemoryHighHelperImage,
  requireDockerResourceHelperConfiguration,
  type DockerResourceHelperConfiguration,
} from './docker-resource-helper-inspection.js';

export type DockerOriginalResourceWriterKey = DockerResourceAttemptKey;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const origin = Symbol('actual original resource helper inspection');
function refuse(code = 'DOCKER_RESOURCE_ORIGINAL_WRITER_UNCONFIRMED'): never {
  throw new DockerEmployeeContinuationError(code);
}
export interface DockerOriginalResourceWriterReceipt {
  readonly version: 1;
  readonly purpose: 'reverie-original-memory-writer-closed-v1';
  readonly authority: 'fresh-original-helper-terminal-v1';
  readonly originalKey: DockerOriginalResourceWriterKey;
  readonly taskDigest: string;
  readonly originalBoxId: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly configurationDigest: string;
  readonly terminalStateDigest: string;
  readonly exitCode: number;
  readonly originalOutcome: 'unknown';
}
export interface DockerOriginalResourcePrestartReceipt {
  readonly version: 1;
  readonly purpose: 'reverie-original-memory-prestart-observation-v1';
  readonly authority: 'canonical-retirement-cas-required-v1';
  readonly originalKey: DockerOriginalResourceWriterKey;
  readonly taskDigest: string;
  /** Absence is an observation only. Retirement still requires canonical CAS. */
  readonly observed: null | {
    readonly containerId: string;
    readonly originalBoxId: string;
    readonly stateDigest: string;
  };
  readonly originalOutcome: 'unknown';
}
class OriginalProof<T> {
  readonly #key: DockerOriginalResourceWriterKey;
  readonly #task: DockerContinuationTask;
  readonly #receipt: T;
  readonly #started: number;
  readonly #current: () => void;
  #revoked = false;
  constructor(
    token: symbol,
    key: DockerOriginalResourceWriterKey,
    task: DockerContinuationTask,
    receipt: T,
    started: number,
    current: () => void
  ) {
    if (token !== origin) refuse('DOCKER_RESOURCE_ORIGINAL_WRITER_PROOF_REQUIRED');
    this.#key = structuredClone(key);
    this.#task = structuredClone(task);
    this.#receipt = structuredClone(receipt);
    this.#started = started;
    this.#current = current;
    Object.freeze(this);
  }
  require(key: DockerOriginalResourceWriterKey, task: DockerContinuationTask): T {
    if (this.#revoked) refuse();
    try {
      this.#current();
      const elapsed = performance.now() - this.#started;
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > 5000 ||
        !isDeepStrictEqual(key, this.#key) ||
        !isDeepStrictEqual(task, this.#task)
      )
        refuse();
      return structuredClone(this.#receipt);
    } catch (error) {
      this.#revoked = true;
      throw error;
    }
  }
}
Object.freeze(OriginalProof.prototype);
export class DockerOriginalResourceWriterProof extends OriginalProof<DockerOriginalResourceWriterReceipt> {}
export class DockerOriginalResourcePrestartProof extends OriginalProof<DockerOriginalResourcePrestartReceipt> {}
Object.freeze(DockerOriginalResourceWriterProof.prototype);
Object.freeze(DockerOriginalResourcePrestartProof.prototype);
export function requireDockerOriginalResourceWriterProof(
  proof: unknown,
  key: DockerOriginalResourceWriterKey,
  task: DockerContinuationTask
): DockerOriginalResourceWriterReceipt {
  if (!(proof instanceof DockerOriginalResourceWriterProof)) refuse('DOCKER_RESOURCE_ORIGINAL_WRITER_PROOF_REQUIRED');
  return OriginalProof.prototype.require.call(proof, key, task) as DockerOriginalResourceWriterReceipt;
}
export function requireDockerOriginalResourcePrestartProof(
  proof: unknown,
  key: DockerOriginalResourceWriterKey,
  task: DockerContinuationTask
): DockerOriginalResourcePrestartReceipt {
  if (!(proof instanceof DockerOriginalResourcePrestartProof)) refuse('DOCKER_RESOURCE_ORIGINAL_WRITER_PROOF_REQUIRED');
  return OriginalProof.prototype.require.call(proof, key, task) as DockerOriginalResourcePrestartReceipt;
}
function issuedConfiguration(
  key: DockerOriginalResourceWriterKey,
  task: DockerContinuationTask,
  raw: Record<string, unknown>
): { box: string; configuration: DockerResourceHelperConfiguration } {
  const config = z
    .object({ Cmd: z.array(z.string().max(4096)).min(1).max(512), Labels: z.record(z.string(), z.string()) })
    .parse(raw.Config);
  const box = digest.parse(config.Labels['reverie.box.resource.box']);
  const name =
    'reverie-boxed-leaf-helper-' + dockerContinuationDigest([box, 'leaf-helper', key.operationId, key.revision]);
  if (task.name !== name || raw.Name !== '/' + name) refuse();
  const plain: string[] = [],
    members = new Set<string>();
  for (let index = 0; index < config.Cmd.length; index++) {
    if (config.Cmd[index] !== '--member') {
      plain.push(config.Cmd[index]!);
      continue;
    }
    const member = config.Cmd[++index];
    if (
      !member ||
      !/^[a-f0-9]{64}:[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(member) ||
      members.size >= 64 ||
      members.has(member.split(':')[0]!)
    )
      refuse();
    members.add(member.split(':')[0]!);
  }
  const flags = [
    '--box-id',
    '--anchor-id',
    '--anchor-pid',
    '--anchor-start',
    '--worker-id',
    '--worker-pid',
    '--worker-start',
    '--leaf-dev',
    '--leaf-ino',
    '--memory-max',
    '--swap-max',
    '--pids-max',
    '--memory-high',
    '--cpu-weight',
    '--cpuset-cpus',
  ];
  if (plain.length !== 1 + flags.length * 2 || plain[0] !== 'configure-memory-high') refuse();
  for (const [index, flag] of flags.entries()) if (plain[index * 2 + 1] !== flag) refuse();
  if (plain[2] !== box || plain[10] !== key.containerId || !digest.safeParse(plain[4]).success) refuse();
  for (const index of [6, 8, 12, 14, 16, 18, 20, 22, 24, 26, 28])
    if (!/^(0|[1-9][0-9]{0,19})$/.test(plain[index]!)) refuse();
  if (!/^[0-9,-]{1,4096}$/.test(plain[30]!)) refuse();
  const path = `/reverie.slice/reverie-box.slice/reverie-box-${box}.slice/docker-${key.containerId}.scope`;
  const configuration = dockerResourceHelperConfiguration(
    box,
    'leaf-helper',
    name,
    config.Cmd,
    { path, target: '/run/reverie-worker-cgroup' },
    task.imageId
  );
  if (dockerContinuationDigest(configuration) !== task.configurationDigest) refuse();
  requireDockerResourceHelperConfiguration(raw, configuration);
  return { box, configuration };
}
function terminal(raw: Record<string, unknown>) {
  const state = z
    .object({
      Status: z.literal('exited'),
      Running: z.literal(false),
      Pid: z.literal(0),
      Paused: z.literal(false),
      Restarting: z.literal(false),
      Dead: z.literal(false),
      ExitCode: z.number().int().min(0).max(255),
    })
    .parse(raw.State);
  return { digest: dockerContinuationDigest(raw.State), exitCode: state.ExitCode };
}
function created(raw: Record<string, unknown>) {
  z.object({
    Status: z.literal('created'),
    Running: z.literal(false),
    Pid: z.literal(0),
    Paused: z.literal(false),
    Restarting: z.literal(false),
    Dead: z.literal(false),
  }).parse(raw.State);
  return dockerContinuationDigest(raw.State);
}
/** Runtime owns the real Docker command port. No HTTP parameter selects a port,
 * current worker, helper image or execution command. */
export class DockerOriginalResourceWriterReader {
  readonly #command: Pick<DockerEngineCommand, 'run'>;
  constructor(command: Pick<DockerEngineCommand, 'run'>) {
    this.#command = command;
  }
  async #originalId(task: DockerContinuationTask, current: () => void): Promise<string | undefined> {
    current();
    if ('containerId' in task) return task.containerId;
    const listing = await this.#command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'label=reverie.box.resource.name=' + task.name,
      '--format',
      '{{.ID}}',
    ]);
    current();
    if (listing.length > 130) refuse();
    const ids = listing.trim() ? listing.trim().split('\n') : [];
    if (ids.length > 1) refuse();
    return ids.length ? digest.parse(ids[0]) : undefined;
  }
  async capture(
    key: DockerOriginalResourceWriterKey,
    task: DockerContinuationTask,
    current: () => void
  ): Promise<DockerOriginalResourceWriterProof> {
    try {
      return await this.#capture(key, task, current);
    } catch (error) {
      // Malformed Engine/canonical metadata is not invalid HTTP request data.
      if (error instanceof z.ZodError || error instanceof SyntaxError) refuse();
      throw error;
    }
  }
  async #capture(
    originalKey: DockerOriginalResourceWriterKey,
    originalTask: DockerContinuationTask,
    current: () => void
  ): Promise<DockerOriginalResourceWriterProof> {
    const key = keySchema.parse(structuredClone(originalKey)),
      task = DockerContinuationTask.parse(structuredClone(originalTask));
    const started = performance.now();
    if (task.role !== 'leaf-helper') refuse();
    await requireDockerMemoryHighHelperImage(this.#command, task.imageId, current);
    current();
    const id = await this.#originalId(task, current);
    if (!id) refuse();
    const first = await inspectDockerResourceContainer(this.#command, id);
    current();
    const { box, configuration } = issuedConfiguration(key, task, first),
      before = terminal(first);
    if ((await this.#originalId(task, current)) !== id) refuse();
    const second = await inspectDockerResourceContainer(this.#command, id);
    current();
    requireDockerResourceHelperConfiguration(second, configuration);
    if (second.Name !== first.Name || !isDeepStrictEqual(before, terminal(second))) refuse();
    return new DockerOriginalResourceWriterProof(
      origin,
      key,
      task,
      {
        version: 1,
        purpose: 'reverie-original-memory-writer-closed-v1',
        authority: 'fresh-original-helper-terminal-v1',
        originalKey: key,
        taskDigest: dockerContinuationDigest(task),
        originalBoxId: box,
        containerId: id,
        imageId: task.imageId,
        configurationDigest: task.configurationDigest,
        terminalStateDigest: before.digest,
        exitCode: before.exitCode,
        originalOutcome: 'unknown',
      },
      started,
      current
    );
  }
  async inspectUnstarted(
    key: DockerOriginalResourceWriterKey,
    task: DockerContinuationTask,
    current: () => void
  ): Promise<DockerOriginalResourcePrestartProof> {
    try {
      return await this.#inspectUnstarted(key, task, current);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) refuse();
      throw error;
    }
  }
  async #inspectUnstarted(
    originalKey: DockerOriginalResourceWriterKey,
    originalTask: DockerContinuationTask,
    current: () => void
  ): Promise<DockerOriginalResourcePrestartProof> {
    const key = keySchema.parse(structuredClone(originalKey)),
      task = DockerContinuationTask.parse(structuredClone(originalTask));
    const started = performance.now();
    if (task.role !== 'leaf-helper' || !['create-issued', 'created'].includes(task.phase)) refuse();
    await requireDockerMemoryHighHelperImage(this.#command, task.imageId, current);
    const snapshot = async () => {
      current();
      const id = await this.#originalId(task, current);
      if (!id) return null;
      const raw = await inspectDockerResourceContainer(this.#command, id);
      current();
      const { box } = issuedConfiguration(key, task, raw);
      return { containerId: id, originalBoxId: box, stateDigest: created(raw) };
    };
    const first = await snapshot(),
      second = await snapshot();
    current();
    if (!isDeepStrictEqual(first, second)) refuse();
    return new DockerOriginalResourcePrestartProof(
      origin,
      key,
      task,
      {
        version: 1,
        purpose: 'reverie-original-memory-prestart-observation-v1',
        authority: 'canonical-retirement-cas-required-v1',
        originalKey: key,
        taskDigest: dockerContinuationDigest(task),
        observed: second,
        originalOutcome: 'unknown',
      },
      started,
      current
    );
  }
}
