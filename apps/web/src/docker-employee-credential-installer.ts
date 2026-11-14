import { parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
/** One original contained installer. File bytes cannot replace a failed helper
 * close ACK. No shell command, general exec route or arbitrary destination. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { DockerContinuationTask, DockerContinuationTaskJournal } from './docker-continuation-task.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
const cid = z.string().regex(/^[a-f0-9]{64}$/),
  decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export interface DockerCredentialHome {
  readonly source: string;
  readonly user: string;
  readonly dev: string;
  readonly ino: string;
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
export class DockerEmployeeCredentialInstaller {
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly journal: DockerContinuationTaskJournal,
    private readonly home: (row: DockerEmployeeContinuationRecord) => Promise<DockerCredentialHome>,
    private readonly boxId: string
  ) {
    if (!/^[a-f0-9]{64}$/.test(boxId)) throw Error('Fixed boxed namespace required');
  }
  async #config(row: DockerEmployeeContinuationRecord, home: DockerCredentialHome): Promise<Record<string, unknown>> {
    const image = z
      .array(
        z.object({
          Id: z.literal(row.workerImage.imageId),
          Config: z.object({
            Env: z.array(z.string().max(16384)).max(256).nullable(),
            Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
          }),
        })
      )
      .length(1)
      .parse(JSON.parse(await this.command.run(['image', 'inspect', row.workerImage.imageId])))[0]!;
    if (image.Config.Volumes && Object.keys(image.Config.Volumes).length)
      refuse('DOCKER_IDENTITY_IMAGE_IMPLICIT_STORAGE_UNSUPPORTED');
    const inherited = image.Config.Env ?? [],
      keys = inherited.map((value) => value.split('=')[0]);
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length) refuse('DOCKER_IDENTITY_IMAGE_ENV_UNKNOWN');
    const fixed = [
      'HOME=/home/agent',
      'REVERIE_SESSION_ID=' + row.request.sessionId,
      'REVERIE_WORKER_IDENTITY_FILE=/home/agent/.reverie/docker-worker-identity',
    ];
    const environment = [
      ...inherited.map((value) => fixed.find((item) => item.split('=')[0] === value.split('=')[0]) ?? value),
      ...fixed.filter((value) => !keys.includes(value.split('=')[0])),
    ];
    decimal.parse(home.dev);
    decimal.parse(home.ino);
    return {
      Image: row.workerImage.imageId,
      User: home.user,
      Entrypoint: ['/opt/reverie-worker-client/bin/reverie'],
      Cmd: [
        'worker-client',
        'credential-install',
        '--expected-digest',
        row.workerImage.clientManifestDigest,
        '--home-dev',
        home.dev,
        '--home-ino',
        home.ino,
      ],
      Env: environment,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Labels: {
        'reverie.box.identity.operation': row.request.operationId,
        'reverie.box.identity.box': this.boxId,
        'reverie.box.identity.employee': row.employeeId,
      },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        RestartPolicy: { Name: 'no' },
        Memory: 256 * 1024 * 1024,
        MemorySwap: 256 * 1024 * 1024,
        PidsLimit: 32,
        Mounts: [
          {
            Type: 'bind',
            Source: home.source,
            Target: '/home/agent',
            ReadOnly: false,
            BindOptions: { Propagation: 'rprivate' },
          },
        ],
      },
    };
  }
  async #fixed(id: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    cid.parse(id);
    const raw = z
      .array(z.record(z.string(), z.unknown()))
      .length(1)
      .parse(JSON.parse(await this.command.run(['container', 'inspect', id])))[0]!;
    if (raw.Id !== id || raw.Image !== config.Image) refuse('DOCKER_IDENTITY_HELPER_CHANGED');
    const actual = z.record(z.string(), z.unknown()).parse(raw.Config),
      host = z.record(z.string(), z.unknown()).parse(raw.HostConfig),
      wanted = config.HostConfig as Record<string, unknown>;
    for (const key of ['User', 'Entrypoint', 'Cmd', 'Env', 'OpenStdin', 'StdinOnce', 'Tty'])
      if (!isDeepStrictEqual(actual[key], config[key])) refuse('DOCKER_IDENTITY_HELPER_CHANGED');
    const labels = z.record(z.string(), z.string()).parse(actual.Labels);
    for (const [key, value] of Object.entries(config.Labels as Record<string, string>))
      if (labels[key] !== value) refuse('DOCKER_IDENTITY_HELPER_CHANGED');
    for (const key of [
      'Privileged',
      'ReadonlyRootfs',
      'CapDrop',
      'SecurityOpt',
      'NetworkMode',
      'Memory',
      'MemorySwap',
      'PidsLimit',
    ])
      if (!isDeepStrictEqual(host[key], wanted[key])) refuse('DOCKER_IDENTITY_HELPER_SECURITY_CHANGED');
    for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'VolumesFrom'])
      if (host[key] !== null && host[key] !== undefined && !isDeepStrictEqual(host[key], []))
        refuse('DOCKER_IDENTITY_HELPER_SECURITY_CHANGED');
    if (
      host.PidMode === 'host' ||
      host.IpcMode === 'host' ||
      host.AutoRemove === true ||
      (!isDeepStrictEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 }) &&
        !isDeepStrictEqual(host.RestartPolicy, { Name: 'no' }))
    )
      refuse('DOCKER_IDENTITY_HELPER_SECURITY_CHANGED');
    const mounts = z
      .array(
        z.object({
          Type: z.literal('bind'),
          Source: z.string(),
          Destination: z.literal('/home/agent'),
          RW: z.literal(true),
        })
      )
      .length(1)
      .parse(raw.Mounts);
    if (mounts[0]!.Source !== (wanted.Mounts as Array<{ Source: string }>)[0]!.Source)
      refuse('DOCKER_IDENTITY_HELPER_HOME_CHANGED');
    return raw;
  }
  #task(row: DockerEmployeeContinuationRecord, config: Record<string, unknown>): DockerContinuationTask | undefined {
    const task = this.journal.read(row, 'identity-helper');
    if (
      task &&
      (task.imageId !== row.workerImage.imageId ||
        task.configurationDigest !== dockerContinuationDigest(config) ||
        task.name !==
          'reverie-boxed-identity-' +
            dockerContinuationDigest([this.boxId, 'identity-helper', row.request.operationId]))
    )
      refuse('DOCKER_IDENTITY_ORIGINAL_CHANGED');
    return task;
  }
  async provision(row: DockerEmployeeContinuationRecord, token: string, current: () => void): Promise<void> {
    if (token.length > 2048 || token.length === 0 || /[\r\n\0]/.test(token)) refuse('DOCKER_IDENTITY_TOKEN_INVALID');
    const home = await this.home(row);
    current();
    const config = await this.#config(row, home),
      base = {
        role: 'identity-helper' as const,
        name:
          'reverie-boxed-identity-' +
          dockerContinuationDigest([this.boxId, 'identity-helper', row.request.operationId]),
        imageId: row.workerImage.imageId,
        configurationDigest: dockerContinuationDigest(config),
      };
    let task = this.#task(row, config);
    const fresh = task === undefined;
    if (!task) {
      await this.journal.publish(row, undefined, { ...base, phase: 'create-issued' }, current);
      task = this.#task(row, config)!;
    }
    if (task.phase === 'create-issued') {
      const existing = (
        await this.command.run([
          'container',
          'ls',
          '--all',
          '--no-trunc',
          '--filter',
          'label=reverie.box.identity.operation=' + row.request.operationId,
          '--filter',
          'label=reverie.box.identity.box=' + this.boxId,
          '--format',
          '{{.ID}}',
        ])
      ).trim();
      current();
      if (!existing && !fresh) refuse('DOCKER_IDENTITY_CREATE_UNCONFIRMED');
      const id = existing ? cid.parse(existing) : await this.command.create(base.name, config, current);
      current();
      await this.#fixed(id, config);
      current();
      await this.journal.publish(row, task, { ...base, phase: 'created', containerId: id }, current);
      task = this.#task(row, config)!;
    }
    if (!('containerId' in task)) refuse('DOCKER_IDENTITY_CREATE_UNCONFIRMED');
    const raw = await this.#fixed(task.containerId, config);
    current();
    if (task.phase !== 'created') refuse('DOCKER_IDENTITY_ORIGINAL_INSTALL_HELD');
    const state = z.object({ Running: z.boolean(), Status: z.string() }).parse(raw.State);
    if (state.Running || state.Status !== 'created') refuse('DOCKER_IDENTITY_ORIGINAL_INSTALL_HELD');
    // The same physical private HOME must still be retained immediately before
    // START. The fixed installer checks its newly opened HOME FD before writes.
    if (!isDeepStrictEqual(await this.home(row), home)) refuse('DOCKER_IDENTITY_ORIGINAL_HOME_CHANGED');
    current();
    await this.journal.publish(row, task, { ...base, phase: 'start-issued', containerId: task.containerId }, current);
    current();
    await this.command.run(['container', 'start', '--interactive', task.containerId], token);
    current();
    const acknowledged = await this.observe(row);
    current();
    if (acknowledged !== createHash('sha256').update(token).digest('hex'))
      refuse('DOCKER_IDENTITY_INSTALL_UNACKNOWLEDGED');
    task = this.#task(row, config)!;
    if (task.phase !== 'start-issued') refuse('DOCKER_IDENTITY_ORIGINAL_CHANGED');
    const ack = {
      version: 1,
      purpose: 'reverie-worker-credential-installed-v1',
      manifestDigest: row.workerImage.clientManifestDigest,
      sessionId: row.request.sessionId,
      tokenDigest: acknowledged,
      homeDev: home.dev,
      homeIno: home.ino,
    };
    await this.journal.publish(
      row,
      task,
      { ...base, phase: 'completed', containerId: task.containerId, resultDigest: dockerContinuationDigest(ack) },
      current
    );
  }
  async observe(row: DockerEmployeeContinuationRecord): Promise<string | null> {
    if (!this.journal.read(row, 'identity-helper')) return null;
    const home = await this.home(row),
      config = await this.#config(row, home),
      task = this.#task(row, config);
    if (!task || task.phase === 'create-issued' || task.phase === 'created') return null;
    if (!('containerId' in task) || !['start-issued', 'completed'].includes(task.phase))
      refuse('DOCKER_IDENTITY_ORIGINAL_INSTALL_HELD');
    const raw = await this.#fixed(task.containerId, config),
      state = z
        .object({
          Running: z.boolean(),
          Status: z.string(),
          ExitCode: z.number().int(),
          OOMKilled: z.boolean(),
          Dead: z.boolean(),
          Restarting: z.boolean(),
        })
        .parse(raw.State);
    if (state.Running) return null;
    if (state.Status !== 'exited' || state.ExitCode !== 0 || state.OOMKilled || state.Dead || state.Restarting)
      refuse('DOCKER_IDENTITY_INSTALL_UNACKNOWLEDGED');
    const body = await this.command.run(['logs', task.containerId]);
    if (Buffer.byteLength(body) > 4096) refuse('DOCKER_IDENTITY_INSTALL_ACK_INVALID');
    const ack = z
      .object({
        version: z.literal(1),
        purpose: z.literal('reverie-worker-credential-installed-v1'),
        manifestDigest: z.literal(row.workerImage.clientManifestDigest),
        sessionId: z.literal(row.request.sessionId),
        tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
        homeDev: z.literal(home.dev),
        homeIno: z.literal(home.ino),
      })
      .strict()
      .parse(parseBoxedConfigurationJson(body));
    if (task.phase === 'completed' && task.resultDigest !== dockerContinuationDigest(ack))
      refuse('DOCKER_IDENTITY_INSTALL_ACK_CHANGED');
    const after = await this.#fixed(task.containerId, config);
    if (!isDeepStrictEqual(after.State, raw.State) || !isDeepStrictEqual(await this.home(row), home))
      refuse('DOCKER_IDENTITY_ORIGINAL_CHANGED');
    return ack.tokenDigest;
  }
}
