/** An original read-only Docker namespace retains HOME/Nix directory owners.
 * Named host paths are never substituted for the held FD/inode observations.
 */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { DockerContinuationTask, DockerContinuationTaskJournal } from './docker-continuation-task.js';
import type { DockerCredentialHome } from './docker-employee-credential-installer.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { DockerEmployeeInspect } from './docker-employee-engine-data.js';
import {
  classifyDockerExecFailure,
  describeDockerExecFailure,
  dockerExecFailureCode,
  dockerExecFailureRetryable,
  type DockerExecFailure,
} from './docker-exec-failure.js';
/** Waits before the second and third read of a holder's status. */
const STATUS_RETRY_DELAYS_MS = [150, 600] as const;
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  cid = z.string().regex(/^[a-f0-9]{64}$/);
const directory = z
  .object({
    dev: decimal,
    ino: decimal,
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
  })
  .strict();
const storage = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-storage-observation-v1'),
    holderStartTicks: decimal.nullable(),
    home: directory,
    nix: directory,
  })
  .strict();
export type DockerEmployeeStorageObservation = z.infer<typeof storage>;
type Storage = DockerEmployeeStorageObservation;
const reference = storage.extend({
  purpose: z.literal('reverie-boxed-storage-reference-v1'),
  holderStartTicks: z.null(),
});
const endedHolder = z
  .object({
    Running: z.literal(false),
    Paused: z.literal(false),
    Restarting: z.literal(false),
    Dead: z.literal(false),
    Pid: z.literal(0),
    Status: z.literal('exited'),
  })
  .passthrough();
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
function sameDirectoryAcrossRestart(older: Storage['home'], current: Storage['home']): boolean {
  return (
    older.ino !== '0' &&
    older.ino === current.ino &&
    older.uid === current.uid &&
    older.gid === current.gid &&
    older.mode === current.mode
  );
}
export async function probeDockerEmployeeStorage(command: DockerEngineCommand, containerId: string): Promise<Storage> {
  return storage.parse(
    JSON.parse(
      await command.run([
        'exec',
        cid.parse(containerId),
        '/opt/reverie-worker-tools/reverie-docker-resources',
        'probe-storage',
      ])
    )
  );
}
export class DockerEmployeeStorage {
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly journal: DockerContinuationTaskJournal,
    private readonly helperImageId: string,
    private readonly source: (row: DockerEmployeeContinuationRecord) => Promise<DockerEmployeeInspect>,
    private readonly boxId: string,
    private readonly readSource: (row: DockerEmployeeContinuationRecord) => Promise<DockerEmployeeInspect> = source,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    if (!/^[a-f0-9]{64}$/.test(boxId)) throw Error('Fixed boxed namespace required');
    if (!/^sha256:[a-f0-9]{64}$/.test(helperImageId)) throw Error('Fixed qualified storage helper required');
  }
  #configuration(row: DockerEmployeeContinuationRecord, source: DockerEmployeeInspect): Record<string, unknown> {
    const selected = ['/home/agent', '/nix'].map((destination) => {
      const mounts = source.Mounts.filter((m) => m.Destination === destination);
      if (mounts.length !== 1 || mounts[0]!.Type !== 'bind' || !mounts[0]!.RW)
        refuse('DOCKER_STORAGE_PRIVATE_BIND_REQUIRED');
      return {
        Type: 'bind',
        Source: mounts[0]!.Source,
        Target: destination === '/nix' ? '/run/reverie-worker-nix' : '/run/reverie-worker-home',
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate' },
      };
    });
    return {
      Image: this.helperImageId,
      User: source.Config.User,
      Entrypoint: ['/bin/reverie-docker-resources'],
      Cmd: ['hold-storage'],
      Labels: {
        'reverie.box.storage.operation': row.request.operationId,
        'reverie.box.storage.box': this.boxId,
        'reverie.box.storage.employee': row.employeeId,
      },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        RestartPolicy: { Name: 'no' },
        Memory: 16 * 1024 * 1024,
        MemorySwap: 16 * 1024 * 1024,
        PidsLimit: 8,
        Mounts: selected,
      },
    };
  }
  async #inspect(id: string, expected: Record<string, unknown>): Promise<Record<string, unknown>> {
    cid.parse(id);
    const raw = z
      .array(z.record(z.string(), z.unknown()))
      .length(1)
      .parse(JSON.parse(await this.command.run(['container', 'inspect', id])))[0]!;
    const config = z.record(z.string(), z.unknown()).parse(raw.Config),
      host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
    if (
      raw.Id !== id ||
      raw.Image !== this.helperImageId ||
      config.User !== expected.User ||
      !isDeepStrictEqual(config.Entrypoint, expected.Entrypoint) ||
      !isDeepStrictEqual(config.Cmd, expected.Cmd) ||
      !Object.entries(expected.Labels as Record<string, string>).every(
        ([key, value]) => (config.Labels as Record<string, string> | null)?.[key] === value
      )
    )
      refuse('DOCKER_STORAGE_HOLDER_CHANGED');
    const desired = expected.HostConfig as Record<string, unknown>;
    for (const key of ['Privileged', 'ReadonlyRootfs', 'NetworkMode', 'Memory', 'MemorySwap', 'PidsLimit'])
      if (!isDeepStrictEqual(host[key], desired[key])) refuse('DOCKER_STORAGE_HOLDER_CHANGED');
    if (!isDeepStrictEqual(host.CapDrop, ['ALL']) || !isDeepStrictEqual(host.SecurityOpt, ['no-new-privileges']))
      refuse('DOCKER_STORAGE_HOLDER_SECURITY_CHANGED');
    for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'VolumesFrom'])
      if (host[key] !== null && host[key] !== undefined && !isDeepStrictEqual(host[key], []))
        refuse('DOCKER_STORAGE_HOLDER_SECURITY_CHANGED');
    if (
      host.PidMode === 'host' ||
      host.IpcMode === 'host' ||
      host.AutoRemove === true ||
      (!isDeepStrictEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 }) &&
        !isDeepStrictEqual(host.RestartPolicy, { Name: 'no' }))
    )
      refuse('DOCKER_STORAGE_HOLDER_SECURITY_CHANGED');
    const actualMounts = z
      .array(z.object({ Source: z.string(), Destination: z.string(), RW: z.boolean() }))
      .length(2)
      .parse(raw.Mounts);
    const wanted = desired.Mounts as Array<{ Source: string; Target: string; ReadOnly: boolean }>;
    if (
      actualMounts.some(
        (m) => !wanted.some((w) => w.Source === m.Source && w.Target === m.Destination && m.RW === false)
      )
    )
      refuse('DOCKER_STORAGE_HOLDER_MOUNT_CHANGED');
    return raw;
  }
  async prepare(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const source = await this.source(row);
    current();
    const config = this.#configuration(row, source),
      name =
        'reverie-boxed-storage-' + dockerContinuationDigest([this.boxId, 'storage-holder', row.request.operationId]);
    const base = {
      role: 'storage-holder' as const,
      name,
      imageId: this.helperImageId,
      configurationDigest: dockerContinuationDigest(config),
    };
    let task = this.journal.read(row, 'storage-holder'),
      fresh = task === undefined;
    if (!task) {
      await this.journal.publish(row, undefined, { ...base, phase: 'create-issued' }, current);
      task = this.journal.read(row, 'storage-holder')!;
    }
    if (
      task.configurationDigest !== base.configurationDigest ||
      task.imageId !== this.helperImageId ||
      task.name !== name
    )
      refuse('DOCKER_STORAGE_ORIGINAL_CHANGED');
    if (task.phase === 'create-issued') {
      const selected = (
        await this.command.run([
          'container',
          'ls',
          '--all',
          '--no-trunc',
          '--filter',
          'label=reverie.box.storage.operation=' + row.request.operationId,
          '--filter',
          'label=reverie.box.storage.box=' + this.boxId,
          '--format',
          '{{.ID}}',
        ])
      ).trim();
      current();
      if (!selected && !fresh) refuse('DOCKER_STORAGE_CREATE_UNCONFIRMED');
      const id = selected ? cid.parse(selected) : await this.command.create(name, config, current);
      current();
      await this.#inspect(id, config);
      current();
      await this.journal.publish(row, task, { ...base, phase: 'created', containerId: id }, current);
      task = this.journal.read(row, 'storage-holder')!;
      fresh = false;
    }
    if (!('containerId' in task)) refuse('DOCKER_STORAGE_CREATE_UNCONFIRMED');
    const raw = await this.#inspect(task.containerId, config);
    current();
    const state = z.object({ Running: z.boolean(), Status: z.string() }).parse(raw.State);
    if (task.phase === 'created') {
      if (state.Running || state.Status !== 'created') refuse('DOCKER_STORAGE_START_UNCONFIRMED');
      await this.journal.publish(row, task, { ...base, phase: 'start-issued', containerId: task.containerId }, current);
      current();
      await this.command.run(['container', 'start', task.containerId]);
      current();
    }
    const observed = await this.#held(row, config);
    current();
    task = this.journal.read(row, 'storage-holder');
    if (!observed || !task || !('containerId' in task)) refuse('DOCKER_STORAGE_HOLDER_UNCONFIRMED');
    if (task.phase === 'start-issued')
      await this.journal.publish(
        row,
        task,
        {
          ...base,
          phase: 'running',
          containerId: task.containerId,
          initPid: observed.pid,
          initStartTicks: observed.value.holderStartTicks!,
        },
        current
      );
  }
  async #held(
    row: DockerEmployeeContinuationRecord,
    config: Record<string, unknown>
  ): Promise<{ pid: number; value: Storage } | null> {
    const task = this.journal.read(row, 'storage-holder');
    if (!task || !('containerId' in task)) return null;
    const raw = await this.#inspect(task.containerId, config),
      state = z.object({ Running: z.boolean(), Pid: z.number().int().nonnegative() }).parse(raw.State);
    if (!state.Running) return null;
    const first = storage.parse(JSON.parse(await this.command.run(['logs', task.containerId])));
    if (!first.holderStartTicks || first.holderStartTicks === '0') refuse('DOCKER_STORAGE_ORIGINAL_HEADER_UNKNOWN');
    const status = await this.#status(task.containerId, first.holderStartTicks, config);
    if (status === null) return null;
    const value = storage.parse(JSON.parse(status));
    if (
      !isDeepStrictEqual(value, first) ||
      (task.phase === 'running' && (task.initPid !== state.Pid || task.initStartTicks !== value.holderStartTicks))
    )
      refuse('DOCKER_STORAGE_HOLDER_REPLACED');
    return { pid: state.Pid, value };
  }
  /** The holder's own status, read by one exec of its fixed helper. The read
   * changes nothing, so a failed one is repeated a bounded number of times: the
   * holder runs under a 16 MiB memory limit and a limit of eight tasks, which
   * an exec that overlaps another one can exceed. A holder that the Engine then
   * positively reports as stopped is `null`, exactly as before the exec; a
   * holder that reports a different init is a replacement and is not read
   * again. What finally fails carries its class, not the command line. */
  async #status(id: string, ticks: string, config: Record<string, unknown>): Promise<string | null> {
    const args = ['exec', id, '/bin/reverie-docker-resources', 'storage-status', '--holder-start', ticks];
    let failure: DockerExecFailure | undefined;
    for (let attempt = 0; attempt <= STATUS_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt) await this.sleep(STATUS_RETRY_DELAYS_MS[attempt - 1]!);
      try {
        return await this.command.run(args);
      } catch (error) {
        failure = classifyDockerExecFailure(error);
        console.warn(
          `[docker-storage] storage-status read of holder ${id.slice(0, 12)} failed ` +
            `(attempt ${attempt + 1}/${STATUS_RETRY_DELAYS_MS.length + 1}): ${describeDockerExecFailure(failure)}`
        );
        if (failure.helper === 'BOXED_STORAGE_HOLDER_CHANGED') refuse('DOCKER_STORAGE_HOLDER_REPLACED');
        if (failure.kind === 'not-running' || failure.kind === 'absent') {
          const state = z.object({ Running: z.boolean() }).parse((await this.#inspect(id, config)).State);
          if (!state.Running) return null;
        } else if (!dockerExecFailureRetryable(failure) && failure.kind !== 'helper-refused') break;
      }
    }
    throw new DockerEmployeeContinuationError(dockerExecFailureCode('DOCKER_STORAGE_HOLDER_STATUS', failure!), 409, {
      cause: failure,
    });
  }
  /** Settle an already observed live holder cursor; never create or START.
   * Monotone task publication and the owning epoch keep this exact cursor. */
  async settleObserved(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    current();
    const task = this.journal.read(row, 'storage-holder');
    if (!task || !['start-issued', 'running'].includes(task.phase)) return;
    if ((await this.observe(row)) !== 'ready') refuse('DOCKER_STORAGE_HOLDER_UNCONFIRMED');
    current();
    // prepare has no effect branch for these two retained task phases. It
    // re-reads the same fixed holder and publishes its actual init once.
    await this.prepare(row, current);
    current();
  }
  async observe(row: DockerEmployeeContinuationRecord): Promise<'ready' | 'unissued' | 'unknown'> {
    const source = await this.readSource(row),
      config = this.#configuration(row, source),
      task = this.journal.read(row, 'storage-holder');
    if (!task) return 'unissued';
    if (task.phase === 'create-issued' || task.phase === 'created') {
      const id =
        task.phase === 'created'
          ? task.containerId
          : (
              await this.command.run([
                'container',
                'ls',
                '--all',
                '--no-trunc',
                '--filter',
                'label=reverie.box.storage.operation=' + row.request.operationId,
                '--filter',
                'label=reverie.box.storage.box=' + this.boxId,
                '--format',
                '{{.ID}}',
              ])
            ).trim();
      if (!id) return 'unknown';
      const raw = await this.#inspect(cid.parse(id), config),
        state = z.object({ Running: z.boolean(), Status: z.string() }).parse(raw.State);
      // Only actual unchanged never-started state is known pre-effect. A
      // running/exited original is not permission to replay its START.
      return !state.Running && state.Status === 'created' ? 'unissued' : 'unknown';
    }
    const held = await this.#held(row, config);
    return held ? 'ready' : 'unknown';
  }
  async credentialHome(row: DockerEmployeeContinuationRecord) {
    return this.#home(row, await this.source(row));
  }
  async observedCredentialHome(row: DockerEmployeeContinuationRecord) {
    return this.#home(row, await this.readSource(row));
  }
  async #home(row: DockerEmployeeContinuationRecord, source: DockerEmployeeInspect) {
    const held = await this.#held(row, this.#configuration(row, source));
    if (!held) refuse('DOCKER_STORAGE_HOLDER_UNCONFIRMED');
    return {
      source: source.Mounts.find((m) => m.Destination === '/home/agent')!.Source,
      user: source.Config.User,
      dev: held.value.home.dev,
      ino: held.value.home.ino,
    };
  }
  async protectedDirectories(row: DockerEmployeeContinuationRecord) {
    const source = await this.readSource(row),
      held = await this.#held(row, this.#configuration(row, source));
    if (!held) refuse('DOCKER_STORAGE_HOLDER_UNCONFIRMED');
    return [held.value.home, held.value.nix].map(({ dev, ino }) => ({ dev, ino }));
  }
  #readEndedHolder(raw: Record<string, unknown>, name: string, config: Record<string, unknown>) {
    const desired = config.HostConfig as { Mounts: Array<{ Source: string; Target: string }> };
    const mounts = z
      .array(z.object({ Type: z.literal('bind'), Source: z.string(), Destination: z.string(), RW: z.literal(false) }))
      .length(2)
      .parse(raw.Mounts);
    if (
      raw.Name !== '/' + name ||
      !desired.Mounts.every((expected) =>
        mounts.some((mount) => mount.Destination === expected.Target && mount.Source === expected.Source)
      )
    )
      refuse('DOCKER_STORAGE_HOLDER_CHANGED');
    return endedHolder.parse(raw.State);
  }
  async #originalReceipt(task: Extract<DockerContinuationTask, { phase: 'running' }>): Promise<Storage> {
    const log = (await this.command.run(['logs', task.containerId])).replace(/\n$/, '');
    if (!log || log.length > 4096 || /[\r\n]/.test(log)) refuse('DOCKER_STORAGE_ORIGINAL_HEADER_UNKNOWN');
    const receipt = storage.parse(JSON.parse(log));
    if (
      !receipt.holderStartTicks ||
      receipt.holderStartTicks === '0' ||
      receipt.holderStartTicks !== task.initStartTicks
    )
      refuse('DOCKER_STORAGE_ORIGINAL_HEADER_UNKNOWN');
    return receipt;
  }
  #checkExistingDestination(row: DockerEmployeeContinuationRecord, destination: DockerEmployeeInspect, running: boolean): void {
    if (
      (row.phase !== 'ready' && row.phase !== 'provider-issued') ||
      destination.Id !== row.destination?.containerId ||
      destination.State.Running !== running ||
      destination.State.Paused ||
      destination.State.Restarting ||
      destination.State.Dead
    )
      refuse('DOCKER_STORAGE_DESTINATION_UNKNOWN');
  }
  /**
   * Reobserve an existing placement after the original read-only holder has
   * exited. This does not settle its journal or confer any new write authority.
   */
  async readExistingReference(
    row: DockerEmployeeContinuationRecord,
    destination: DockerEmployeeInspect,
    verify: (destination: DockerEmployeeInspect, observation: Storage, filesystemId?: string) => Promise<unknown>,
    current: () => void,
    stoppedObservation?: Storage | 'original-reference',
    migrate?: (original: Storage) => { observation: Storage; filesystemId?: string }
  ): Promise<(DockerCredentialHome & { readonly originalHomeDev: string }) | undefined> {
    current();
    this.#checkExistingDestination(row, destination, !stoppedObservation);
    const config = this.#configuration(row, destination);
    const retained = this.journal.read(row, 'storage-holder');
    const name =
      'reverie-boxed-storage-' + dockerContinuationDigest([this.boxId, 'storage-holder', row.request.operationId]);
    if (
      !retained ||
      !('containerId' in retained) ||
      retained.role !== 'storage-holder' ||
      retained.name !== name ||
      retained.imageId !== this.helperImageId ||
      retained.configurationDigest !== dockerContinuationDigest(config)
    )
      refuse('DOCKER_STORAGE_ORIGINAL_CHANGED');
    const task = { ...retained };
    const holder = await this.#inspect(task.containerId, config);
    current();
    if (z.object({ Running: z.boolean() }).parse(holder.State).Running) return undefined;
    if (task.phase !== 'running') refuse('DOCKER_STORAGE_ORIGINAL_CHANGED');

    const ended = this.#readEndedHolder(holder, name, config);
    const historical = await this.#originalReceipt(task);
    current();
    // A stopped worker cannot probe its own mounts. Without a previous live
    // observation the verifier must match even the original device numbers.
    const original = { ...historical, holderStartTicks: null };
    const migration = stoppedObservation === 'original-reference' ? migrate?.(original) : undefined;
    const seen = stoppedObservation === 'original-reference'
      ? migration?.observation ?? original
      : stoppedObservation ?? await probeDockerEmployeeStorage(this.command, destination.Id);
    current();
    if (
      seen.holderStartTicks !== null ||
      !sameDirectoryAcrossRestart(historical.home, seen.home) ||
      !sameDirectoryAcrossRestart(historical.nix, seen.nix)
    )
      refuse('DOCKER_STORAGE_DESTINATION_REPLACED');
    const independentlyObserved = reference.parse(await verify(destination, seen, migration?.filesystemId));
    current();
    if (
      !isDeepStrictEqual(independentlyObserved.home, seen.home) ||
      !isDeepStrictEqual(independentlyObserved.nix, seen.nix)
    )
      refuse('DOCKER_STORAGE_DESTINATION_REPLACED');

    const after = await this.#inspect(task.containerId, config);
    current();
    if (!isDeepStrictEqual(this.#readEndedHolder(after, name, config), ended)) refuse('DOCKER_STORAGE_HOLDER_CHANGED');
    const repeated = await this.#originalReceipt(task);
    current();
    const destinationAfter = stoppedObservation
      ? reference.parse(await verify(destination, seen, migration?.filesystemId))
      : await probeDockerEmployeeStorage(this.command, destination.Id);
    current();
    if (
      !isDeepStrictEqual(repeated, historical) ||
      !isDeepStrictEqual(destinationAfter.home, seen.home) ||
      !isDeepStrictEqual(destinationAfter.nix, seen.nix) ||
      destinationAfter.holderStartTicks !== null ||
      !isDeepStrictEqual(this.journal.read(row, 'storage-holder'), task)
    )
      refuse('DOCKER_STORAGE_DESTINATION_REPLACED');
    return Object.freeze({
      source: destination.Mounts.find((m) => m.Destination === '/home/agent')!.Source,
      user: destination.Config.User,
      dev: seen.home.dev,
      ino: seen.home.ino,
      originalHomeDev: historical.home.dev,
    });
  }
  async verifyDestination(row: DockerEmployeeContinuationRecord): Promise<void> {
    if (!row.destination) refuse('DOCKER_STORAGE_DESTINATION_UNKNOWN');
    const source = await this.readSource(row),
      held = await this.#held(row, this.#configuration(row, source));
    if (!held) refuse('DOCKER_STORAGE_HOLDER_UNCONFIRMED');
    const seen = await probeDockerEmployeeStorage(this.command, row.destination.containerId);
    if (
      seen.holderStartTicks !== null ||
      !isDeepStrictEqual(seen.home, held.value.home) ||
      !isDeepStrictEqual(seen.nix, held.value.nix)
    )
      refuse('DOCKER_STORAGE_DESTINATION_REPLACED');
  }
}
