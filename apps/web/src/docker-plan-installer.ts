/** Real contained installer observation. Loaded task DATA is deny-only until
 * fixed image/config, terminal helper ACK and fresh guest reads all agree. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import type { DockerContinuationTaskJournal } from './docker-continuation-task.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import type { DockerCredentialHome } from './docker-employee-credential-installer.js';
import {
  identityHelperConfiguration,
  inspectIdentityHelper,
  type DockerPlanHelperAction,
} from './docker-identity-helper.js';
import { DockerPlanInitialReceipt, DockerPlanLiveReceipt } from './docker-plan-install-data.js';
import { parseBoxedConfigurationJson } from './docker-employee-policy-import.js';
const cid = z.string().regex(/^[a-f0-9]{64}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const terminal = z.object({
  Running: z.literal(false),
  Status: z.literal('exited'),
  Pid: z.literal(0),
  ExitCode: z.literal(0),
  OOMKilled: z.literal(false),
  Dead: z.literal(false),
  Restarting: z.literal(false),
  Paused: z.literal(false),
});
function refuse(code = 'DOCKER_PLAN_INSTALL_UNCONFIRMED'): never {
  throw new DockerEmployeeContinuationError(code);
}
type Row = Extract<DockerEmployeeContinuationRecord, { version: 3 }>;
export class DockerPlanInstaller {
  readonly #command: DockerEngineCommand;
  readonly #journal: DockerContinuationTaskJournal;
  readonly #home: (row: DockerEmployeeContinuationRecord) => Promise<DockerCredentialHome>;
  readonly #box: string;
  constructor(
    command: DockerEngineCommand,
    journal: DockerContinuationTaskJournal,
    home: (row: DockerEmployeeContinuationRecord) => Promise<DockerCredentialHome>,
    boxId: string
  ) {
    hash.parse(boxId);
    this.#command = command;
    this.#journal = journal;
    this.#home = home;
    this.#box = boxId;
    Object.freeze(this);
  }
  async #inspect(cidValue: string): Promise<Record<string, unknown>> {
    cid.parse(cidValue);
    return z
      .array(z.record(z.string(), z.unknown()))
      .length(1)
      .parse(JSON.parse(await this.#command.run(['container', 'inspect', cidValue])))[0]!;
  }
  #plan(raw: Record<string, unknown>, row: Row): DockerPlanHelperAction {
    const config = z.record(z.string(), z.unknown()).parse(raw.Config),
      cmd = z.array(z.string()).length(14).parse(config.Cmd);
    const payloadDigest = hash.parse(cmd[7]);
    const host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
    const mounts = z.array(z.record(z.string(), z.unknown())).max(2).parse(host.Mounts);
    const context = mounts.filter((m) => m.Target === '/run/reverie-plan-context');
    if (context.length > 1) refuse();
    let contextSource: string | undefined;
    if (context.length) {
      const mount = z
        .object({
          Type: z.literal('bind'),
          Source: z.string().min(1).max(4096),
          Target: z.literal('/run/reverie-plan-context'),
          ReadOnly: z.literal(true),
          BindOptions: z.object({ Propagation: z.literal('rprivate'), NonRecursive: z.literal(true) }).strict(),
        })
        .strict()
        .parse(context[0]);
      contextSource = mount.Source;
      if (!contextSource.startsWith('/') || /[\0\r\n]/.test(contextSource) || contextSource.split('/').includes('..'))
        refuse();
    }
    return {
      projectionDigest: row.planReplacement.account.projectionDigest,
      payloadDigest,
      attempt: row.request.operationId,
      ...(contextSource ? { contextSource } : {}),
    };
  }
  #correlate(row: Row, home: DockerCredentialHome, value: DockerPlanInitialReceipt | DockerPlanLiveReceipt): void {
    if (
      !row.destination ||
      value.operationId !== row.request.operationId ||
      value.sessionId !== row.request.sessionId ||
      value.containerId !== row.destination.containerId ||
      value.projectionDigest !== row.planReplacement.account.projectionDigest ||
      value.accountId !== row.planReplacement.account.id ||
      value.provider !== row.planReplacement.account.provider ||
      value.contextInputDigest !== row.planReplacement.account.contextDigest ||
      value.homeDev !== home.dev ||
      value.homeIno !== home.ino
    )
      refuse('DOCKER_PLAN_INSTALL_BINDING_CHANGED');
  }
  async #fixed(
    row: Row,
    home: DockerCredentialHome,
    helperId: string,
    config: Record<string, unknown>,
    current: () => void
  ): Promise<Record<string, unknown>> {
    current();
    const raw = await inspectIdentityHelper(this.#command, helperId, config);
    current();
    const actual = z.record(z.string(), z.unknown()).parse(raw.Config),
      host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
    const health = z
      .object({ Test: z.tuple([z.literal('NONE')]) })
      .passthrough()
      .parse(actual.Healthcheck);
    if (
      actual.WorkingDir !== '/' ||
      health.Test[0] !== 'NONE' ||
      host.AutoRemove !== false ||
      host.PidMode !== '' ||
      host.IpcMode !== 'private' ||
      host.UTSMode !== '' ||
      host.UsernsMode !== ''
    )
      refuse('DOCKER_PLAN_INSTALL_HELPER_SECURITY_CHANGED');
    const wanted = config.HostConfig as Record<string, unknown>;
    const actualMounts = z.array(z.record(z.string(), z.unknown())).parse(host.Mounts);
    const projected = actualMounts.map((mount) =>
      mount.ReadOnly === undefined ? { ...mount, ReadOnly: false } : mount
    );
    if (!isDeepStrictEqual(projected, wanted.Mounts)) refuse('DOCKER_PLAN_INSTALL_HELPER_SECURITY_CHANGED');
    this.#correlateHome(row, home);
    return raw;
  }
  #correlateHome(row: Row, home: DockerCredentialHome): void {
    if (
      row.original.home.type !== 'bind' ||
      home.source !== row.original.home.source ||
      !home.user ||
      Number(home.user.split(':')[0]) === 0
    )
      refuse('DOCKER_PLAN_INSTALL_HOME_CHANGED');
  }
  async observe(
    input: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<Readonly<{ initial: DockerPlanInitialReceipt; live: DockerPlanLiveReceipt }>> {
    current();
    let row: Row;
    try {
      const parsed = DockerEmployeeContinuationRecord.parse(input);
      if (parsed.version !== 3) refuse('DOCKER_PLAN_INSTALL_PROTOCOL_REQUIRED');
      row = parsed;
    } catch (error) {
      if (error instanceof DockerEmployeeContinuationError) throw error;
      refuse();
    }
    const key = dockerContinuationDigest(row);
    let revoked = false;
    const check = () => {
      if (revoked) refuse();
      try {
        current();
        if (dockerContinuationDigest(input) !== key) refuse();
      } catch (error) {
        revoked = true;
        throw error;
      }
    };
    try {
      return await this.#observe(row, check);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) refuse();
      throw error;
    }
  }
  async #observe(
    row: Row,
    current: () => void
  ): Promise<Readonly<{ initial: DockerPlanInitialReceipt; live: DockerPlanLiveReceipt }>> {
    if (!row.destination) refuse();
    const task = this.#journal.read(row, 'identity-helper');
    if (
      !task ||
      task.phase !== 'completed' ||
      task.imageId !== row.workerImage.imageId ||
      task.name !==
        'reverie-boxed-identity-' + dockerContinuationDigest([this.#box, 'identity-helper', row.request.operationId])
    )
      refuse();
    const home = await this.#home(row);
    current();
    this.#correlateHome(row, home);
    const selected = await this.#inspect(task.containerId);
    current();
    const config = await identityHelperConfiguration(this.#command, row, home, this.#box, this.#plan(selected, row));
    current();
    if (task.configurationDigest !== dockerContinuationDigest(config)) refuse('DOCKER_PLAN_INSTALL_TASK_CHANGED');
    const before = await this.#fixed(row, home, task.containerId, config, current);
    terminal.parse(before.State);
    const text = await this.#command.run(['logs', task.containerId]);
    current();
    if (Buffer.byteLength(text) > 8192) refuse();
    const initial = DockerPlanInitialReceipt.parse(parseBoxedConfigurationJson(text));
    this.#correlate(row, home, initial);
    if (task.resultDigest !== dockerContinuationDigest(initial)) refuse('DOCKER_PLAN_INSTALL_ACK_CHANGED');
    const after = await this.#fixed(row, home, task.containerId, config, current);
    terminal.parse(after.State);
    if (!isDeepStrictEqual(before.State, after.State) || !isDeepStrictEqual(await this.#home(row), home))
      refuse('DOCKER_PLAN_INSTALL_ORIGINAL_CHANGED');
    current();
    const body = await this.#command.run([
      'exec',
      row.destination.containerId,
      '/opt/reverie-worker-client/bin/reverie',
      'worker-client',
      'plan-status',
      '--expected-digest',
      row.workerImage.clientManifestDigest,
      '--projection-digest',
      row.planReplacement.account.projectionDigest,
      '--operation',
      row.request.operationId,
      '--container-id',
      row.destination.containerId,
      '--read-mode',
      'live',
      '--home-dev',
      home.dev,
      '--home-ino',
      home.ino,
    ]);
    current();
    if (Buffer.byteLength(body) > 8192) refuse();
    const live = DockerPlanLiveReceipt.parse(parseBoxedConfigurationJson(body));
    this.#correlate(row, home, live);
    for (const field of ['installedAuthDigest', 'tokenDigest', 'contextDigest', 'configDev', 'configIno'] as const)
      if (live[field] !== initial[field]) refuse('DOCKER_PLAN_INSTALL_GUEST_CHANGED');
    const final = await this.#fixed(row, home, task.containerId, config, current);
    terminal.parse(final.State);
    if (!isDeepStrictEqual(final.State, after.State) || !isDeepStrictEqual(await this.#home(row), home))
      refuse('DOCKER_PLAN_INSTALL_ORIGINAL_CHANGED');
    current();
    return Object.freeze({ initial: Object.freeze(initial), live: Object.freeze(live) });
  }
}
Object.freeze(DockerPlanInstaller.prototype);
