/** Real contained installer observation. Loaded task DATA is deny-only until
 * fixed image/config, terminal helper ACK and fresh guest reads all agree. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  DockerEmployeePlanReplacementWorkRecord,
  DockerEmployeeContinuationRecord,
} from './docker-employee-continuation-data.js';
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
  /** Only the owning PlanMoves actor may supply this private payload. The
   * native role rechecks the material digest before any generation write. */
  async provision(
    input: DockerEmployeePlanReplacementWorkRecord,
    payload: string,
    contextSource: string | undefined,
    current: () => void
  ): Promise<DockerPlanInitialReceipt> {
    let row = DockerEmployeePlanReplacementWorkRecord.parse(input);
    current();
    if (!row.destination || Buffer.byteLength(payload) > 1024 * 1024 || !payload.length) refuse();
    const home = await this.#home(row);
    current();
    this.#correlateHome(row, home);
    const action = {
      projectionDigest: row.planReplacement.account.projectionDigest,
      payloadDigest: createHash('sha256').update(payload).digest('hex'),
      attempt: row.request.operationId,
      ...(contextSource ? { contextSource } : {}),
    };
    const config = await identityHelperConfiguration(this.#command, row, home, this.#box, action);
    current();
    const base = {
      role: 'identity-helper' as const,
      name:
        'reverie-boxed-identity-' + dockerContinuationDigest([this.#box, 'identity-helper', row.request.operationId]),
      imageId: row.workerImage.imageId,
      configurationDigest: dockerContinuationDigest(config),
    };
    const read = () => {
      const t = this.#journal.read(row, 'identity-helper');
      if (
        t &&
        (t.name !== base.name || t.imageId !== base.imageId || t.configurationDigest !== base.configurationDigest)
      )
        refuse('DOCKER_PLAN_INSTALL_TASK_CHANGED');
      return t;
    };
    let task = read();
    const fresh = !task;
    if (!task) {
      row = DockerEmployeePlanReplacementWorkRecord.parse(
        await this.#journal.publish(row, undefined, { ...base, phase: 'create-issued' }, current)
      );
      current();
      task = read();
    }
    if (!task) refuse();
    if (task.phase === 'create-issued') {
      const found = (
        await this.#command.run([
          'container',
          'ls',
          '--all',
          '--no-trunc',
          '--filter',
          'label=reverie.box.identity.operation=' + row.request.operationId,
          '--filter',
          'label=reverie.box.identity.box=' + this.#box,
          '--format',
          '{{.ID}}',
        ])
      ).trim();
      current();
      if (!found && !fresh) refuse('DOCKER_PLAN_INSTALL_CREATE_UNCONFIRMED');
      const id = found ? cid.parse(found) : await this.#command.create(base.name, config, current);
      current();
      await this.#fixed(row, home, id, config, current);
      row = DockerEmployeePlanReplacementWorkRecord.parse(
        await this.#journal.publish(row, task, { ...base, phase: 'created', containerId: id }, current)
      );
      current();
      task = read();
    }
    if (!task || !('containerId' in task)) refuse();
    if (task.phase === 'completed')
      return this.#initialAck(row, home, task.containerId, config, task.resultDigest, current);
    // Issued/unknown START can only be inspected and settled from its own
    // successful terminal ACK, never transmitted again.
    if (task.phase === 'start-issued') {
      const initial = await this.#initialAck(row, home, task.containerId, config, undefined, current);
      row = DockerEmployeePlanReplacementWorkRecord.parse(
        await this.#journal.publish(
          row,
          task,
          {
            ...base,
            phase: 'completed',
            containerId: task.containerId,
            resultDigest: dockerContinuationDigest(initial),
          },
          current
        )
      );
      current();
      return initial;
    }
    if (task.phase !== 'created') refuse('DOCKER_PLAN_INSTALL_HELD');
    const before = await this.#fixed(row, home, task.containerId, config, current);
    z.object({
      Running: z.literal(false),
      Status: z.literal('created'),
      Pid: z.literal(0),
      Restarting: z.literal(false),
      Dead: z.literal(false),
    }).parse(before.State);
    if (!isDeepStrictEqual(await this.#home(row), home)) refuse('DOCKER_PLAN_INSTALL_HOME_CHANGED');
    current();
    row = DockerEmployeePlanReplacementWorkRecord.parse(
      await this.#journal.publish(row, task, { ...base, phase: 'start-issued', containerId: task.containerId }, current)
    );
    current();
    await this.#command.run(['container', 'start', '--interactive', task.containerId], payload);
    current();
    const initial = await this.#initialAck(row, home, task.containerId, config, undefined, current);
    const issued = read();
    if (!issued || issued.phase !== 'start-issued' || issued.containerId !== task.containerId) refuse();
    await this.#journal.publish(
      row,
      issued,
      { ...base, phase: 'completed', containerId: task.containerId, resultDigest: dockerContinuationDigest(initial) },
      current
    );
    current();
    return initial;
  }
  async #initialAck(
    row: Row,
    home: DockerCredentialHome,
    id: string,
    config: Record<string, unknown>,
    resultDigest: string | undefined,
    current: () => void
  ): Promise<DockerPlanInitialReceipt> {
    const before = await this.#fixed(row, home, id, config, current);
    terminal.parse(before.State);
    const text = await this.#command.run(['logs', id]);
    current();
    if (Buffer.byteLength(text) > 8192) refuse();
    const initial = DockerPlanInitialReceipt.parse(parseBoxedConfigurationJson(text));
    this.#correlate(row, home, initial);
    if (resultDigest !== undefined && resultDigest !== dockerContinuationDigest(initial))
      refuse('DOCKER_PLAN_INSTALL_ACK_CHANGED');
    const guest = await this.#command.run([
      'exec',
      row.destination!.containerId,
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
      row.destination!.containerId,
      '--read-mode',
      'initial',
      '--home-dev',
      home.dev,
      '--home-ino',
      home.ino,
    ]);
    current();
    if (Buffer.byteLength(guest) > 8192) refuse();
    if (!isDeepStrictEqual(DockerPlanInitialReceipt.parse(parseBoxedConfigurationJson(guest)), initial))
      refuse('DOCKER_PLAN_INSTALL_GUEST_CHANGED');
    const after = await this.#fixed(row, home, id, config, current);
    terminal.parse(after.State);
    if (!isDeepStrictEqual(before.State, after.State) || !isDeepStrictEqual(await this.#home(row), home))
      refuse('DOCKER_PLAN_INSTALL_ORIGINAL_CHANGED');
    current();
    return Object.freeze(initial);
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
    current: () => void,
    canonicalAuthDigest?: string
  ): Promise<Readonly<{ initial: DockerPlanInitialReceipt; live: DockerPlanLiveReceipt }>> {
    if (canonicalAuthDigest !== undefined && !hash.safeParse(canonicalAuthDigest).success)
      refuse('DOCKER_PLAN_ACCOUNT_AUTH_UNCONFIRMED');
    return this.#checked(input, current, async (row, check) => {
      const observed = await this.#observe(row, check);
      check();
      if (
        canonicalAuthDigest !== undefined &&
        (observed.initial.installedAuthDigest !== canonicalAuthDigest ||
          observed.live.observedAuthDigest !== canonicalAuthDigest)
      )
        refuse('DOCKER_PLAN_ACCOUNT_AUTH_CHANGED');
      return observed;
    });
  }
  /** Historical installer DATA only. The prior provider may be stopped, so
   * this deliberately earns no fresh guest/account/provider observation. */
  async original(
    input: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<Readonly<DockerPlanInitialReceipt>> {
    return this.#checked(input, current, async (row, check) =>
      Object.freeze((await this.#historical(row, check)).initial)
    );
  }
  /** Existing completed install in an inert WorkRecord. No payload, helper
   * CREATE or START is used to recover a closed-source-reader crash gap. */
  async initialWork(
    input: DockerEmployeePlanReplacementWorkRecord,
    current: () => void
  ): Promise<Readonly<DockerPlanInitialReceipt>> {
    return this.#checked(
      input,
      current,
      async (row, check) => {
        if (row.phase !== 'identity-ready') refuse();
        const historical = await this.#historical(row, check);
        check();
        const initial = await this.#initialAck(
          row,
          historical.home,
          historical.helperId,
          historical.config,
          dockerContinuationDigest(historical.initial),
          check
        );
        check();
        return Object.freeze(initial);
      },
      false
    );
  }
  async #checked<T>(
    input: DockerEmployeeContinuationRecord,
    current: () => void,
    read: (row: Row, check: () => void) => Promise<T>,
    published = true
  ): Promise<T> {
    current();
    let row: Row;
    try {
      const parsed = published
        ? DockerEmployeeContinuationRecord.parse(input)
        : DockerEmployeePlanReplacementWorkRecord.parse(input);
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
      return await read(row, check);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) refuse();
      throw error;
    }
  }
  async #historical(row: Row, current: () => void) {
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
    return { initial, home, helperId: task.containerId, config, state: after.State };
  }
  async #observe(
    row: Row,
    current: () => void
  ): Promise<Readonly<{ initial: DockerPlanInitialReceipt; live: DockerPlanLiveReceipt }>> {
    const { initial, home, helperId, config, state } = await this.#historical(row, current);
    current();
    const body = await this.#command.run([
      'exec',
      row.destination!.containerId,
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
      row.destination!.containerId,
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
    const final = await this.#fixed(row, home, helperId, config, current);
    terminal.parse(final.State);
    if (!isDeepStrictEqual(final.State, state) || !isDeepStrictEqual(await this.#home(row), home))
      refuse('DOCKER_PLAN_INSTALL_ORIGINAL_CHANGED');
    current();
    return Object.freeze({ initial: Object.freeze(initial), live: Object.freeze(live) });
  }
}
Object.freeze(DockerPlanInstaller.prototype);
