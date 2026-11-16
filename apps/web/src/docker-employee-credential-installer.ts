import { identityHelperConfiguration, inspectIdentityHelper } from './docker-identity-helper.js';
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
const cid = z.string().regex(/^[a-f0-9]{64}$/);
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
    private readonly boxId: string,
    private readonly readHome: (row: DockerEmployeeContinuationRecord) => Promise<DockerCredentialHome> = home
  ) {
    if (!/^[a-f0-9]{64}$/.test(boxId)) throw Error('Fixed boxed namespace required');
  }
  #config(row: DockerEmployeeContinuationRecord, home: DockerCredentialHome): Promise<Record<string, unknown>> {
    return identityHelperConfiguration(this.command, row, home, this.boxId);
  }
  #fixed(id: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return inspectIdentityHelper(this.command, id, config);
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
  /** Completed native inventory only, never an inference from a failed inspect.
   * This is restricted to a published original with no remaining installer for
   * the same employee. The old task and its uncertain ACK remain unchanged. */
  async originalInstallerAbsent(row: DockerEmployeeContinuationRecord): Promise<boolean> {
    if (row.version === 3 || !row.destination || !['provider-issued', 'ready'].includes(row.phase)) return false;
    const task = this.journal.read(row, 'identity-helper');
    if (!task || !('containerId' in task) || !['start-issued', 'completed'].includes(task.phase)) return false;
    const selected = await this.command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'label=reverie.box.identity.box=' + this.boxId,
      '--filter',
      'label=reverie.box.identity.employee=' + row.employeeId,
      '--format',
      '{{.ID}}',
    ]);
    if (Buffer.byteLength(selected) > 16384) refuse('DOCKER_IDENTITY_ORIGINAL_INSTALL_HELD');
    if (selected.trim() === '') return true;
    const ids = selected.trim().split('\n');
    if (ids.length > 128 || new Set(ids).size !== ids.length || ids.some((id) => !cid.safeParse(id).success))
      refuse('DOCKER_IDENTITY_ORIGINAL_INSTALL_HELD');
    return false;
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
    const home = await this.readHome(row),
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
    if (!isDeepStrictEqual(after.State, raw.State) || !isDeepStrictEqual(await this.readHome(row), home))
      refuse('DOCKER_IDENTITY_ORIGINAL_CHANGED');
    return ack.tokenDigest;
  }
}
