/** An original read-only Docker namespace retains HOME/Nix directory owners.
 * Named host paths are never substituted for the held FD/inode observations.
 */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { DockerContinuationTaskJournal } from './docker-continuation-task.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { DockerEmployeeInspect } from './docker-employee-engine-data.js';
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
type Storage = z.infer<typeof storage>;
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
export class DockerEmployeeStorage {
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly journal: DockerContinuationTaskJournal,
    private readonly helperImageId: string,
    private readonly source: (row: DockerEmployeeContinuationRecord) => Promise<DockerEmployeeInspect>
  ) {
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
      name = 'reverie-boxed-storage-' + row.request.operationId;
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
    const value = storage.parse(
      JSON.parse(
        await this.command.run([
          'exec',
          task.containerId,
          '/bin/reverie-docker-resources',
          'storage-status',
          '--holder-start',
          first.holderStartTicks,
        ])
      )
    );
    if (
      !isDeepStrictEqual(value, first) ||
      (task.phase === 'running' && (task.initPid !== state.Pid || task.initStartTicks !== value.holderStartTicks))
    )
      refuse('DOCKER_STORAGE_HOLDER_REPLACED');
    return { pid: state.Pid, value };
  }
  async observe(row: DockerEmployeeContinuationRecord): Promise<'ready' | 'unissued' | 'unknown'> {
    const source = await this.source(row),
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
    const source = await this.source(row),
      held = await this.#held(row, this.#configuration(row, source));
    if (!held) refuse('DOCKER_STORAGE_HOLDER_UNCONFIRMED');
    return {
      source: source.Mounts.find((m) => m.Destination === '/home/agent')!.Source,
      user: source.Config.User,
      dev: held.value.home.dev,
      ino: held.value.home.ino,
    };
  }
  async verifyDestination(row: DockerEmployeeContinuationRecord): Promise<void> {
    if (!row.destination) refuse('DOCKER_STORAGE_DESTINATION_UNKNOWN');
    const source = await this.source(row),
      held = await this.#held(row, this.#configuration(row, source));
    if (!held) refuse('DOCKER_STORAGE_HOLDER_UNCONFIRMED');
    const seen = storage.parse(
      JSON.parse(
        await this.command.run([
          'exec',
          row.destination.containerId,
          '/opt/reverie-worker-tools/reverie-docker-resources',
          'probe-storage',
        ])
      )
    );
    if (
      seen.holderStartTicks !== null ||
      !isDeepStrictEqual(seen.home, held.value.home) ||
      !isDeepStrictEqual(seen.nix, held.value.nix)
    )
      refuse('DOCKER_STORAGE_DESTINATION_REPLACED');
  }
}
