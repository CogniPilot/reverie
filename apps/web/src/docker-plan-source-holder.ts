import { createHash } from 'node:crypto';
/** Private read-only source holder. All native effect intents share PlanMoves.
 * Raw paths/JSON cannot authorize reads; the installed reader, held account FD,
 * exact original source and current actor jointly constrain every operation. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { DockerEmployeeContinuationError, dockerContinuationDigest as digest } from './docker-employee-continuation.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import type { DockerCredentialHome } from './docker-employee-credential-installer.js';
import { inspectIdentityHelper } from './docker-identity-helper.js';
import { DockerPlanSourceReader, DockerPlanSourceProof, DOCKER_PLAN_INIT_PROGRAM } from './docker-plan-source.js';
import { DockerPlanAccountSnapshot } from './docker-plan-account.js';
import type { PlanAccount } from './plan-accounts.js';
import { DockerPlanInitialReceipt } from './docker-plan-install-data.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerPlanMoveJournalState } from './docker-plan-move-data.js';
import type { PlanMoveRecord } from './plan-move.js';
import type { PlanMoveDockerJournal } from './plan-move-docker.js';
import { DOCKER_OWNER_STOP_NATIVE_ENV } from './docker-owner-stop-native.js';
import { DOCKER_PLAN_SOURCE_HOLD_PROGRAM, DOCKER_PLAN_SOURCE_READ_PROGRAM } from './docker-plan-source-native.js';
import { dockerPlanContextForProvider, type DockerPlanSourceContext } from './docker-plan-source-data.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const native = '/opt/reverie-worker-client/bin/node';
const initSchema = z.object({ startTicks: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
type V3 = Extract<DockerEmployeeContinuationRecord, { version: 3 }>;
export type DockerPlanSourceCandidate = Readonly<{ snapshot: DockerPlanAccountSnapshot; account: PlanAccount }>;
export type DockerPlanSourceContextSelection =
  | Readonly<{ kind: 'legacy' | 'account'; provider: 'anthropic' | 'openai'; nativeId: string }>
  | Readonly<{ kind: 'generation'; row: V3; initial: DockerPlanInitialReceipt; nativeId: string }>;
type Scope = {
  home: DockerCredentialHome;
  config: Record<string, unknown>;
  externalSource?: string;
  candidate?: DockerPlanSourceCandidate;
};
function refuse(code = 'DOCKER_PLAN_SOURCE_HOLDER_UNCONFIRMED'): never {
  throw new DockerEmployeeContinuationError(code);
}
function path(value: unknown): string {
  const p = z.string().min(1).max(4096).parse(value);
  if (
    !p.startsWith('/') ||
    posix.normalize(p) !== p ||
    [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    refuse();
  return p;
}
function terminal(raw: Record<string, unknown>): Record<string, unknown> {
  const state = z.record(z.string(), z.unknown()).parse(raw.State);
  if (
    state.Running !== false ||
    state.Pid !== 0 ||
    state.Status !== 'exited' ||
    state.Paused !== false ||
    state.Restarting !== false ||
    state.Dead !== false
  )
    refuse();
  return state;
}
export class DockerPlanSourceHolder {
  readonly #run: DockerEngineCommand['run'];
  readonly #create: DockerEngineCommand['create'];
  readonly #command: DockerEngineCommand;
  readonly #box: string;
  readonly #source: DockerPlanSourceReader;
  readonly #home: (row: DockerEmployeeContinuationRecord, current: () => void) => Promise<DockerCredentialHome>;
  readonly #scopes = new Map<string, Scope>();
  readonly #flights = new Set<string>();
  constructor(
    command: DockerEngineCommand,
    boxId: string,
    source: DockerPlanSourceReader,
    home: (row: DockerEmployeeContinuationRecord, current: () => void) => Promise<DockerCredentialHome>
  ) {
    hash.parse(boxId);
    this.#box = boxId;
    this.#source = source;
    this.#home = home;
    this.#run = command.run.bind(command);
    this.#create = command.create.bind(command);
    this.#command = Object.freeze({ run: this.#run, create: this.#create });
    Object.freeze(this);
  }
  #state(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): DockerPlanMoveJournalState {
    journal.current();
    const state = DockerPlanMoveJournalState.parse(journal.read());
    if (
      record.id !== journal.moveId ||
      record.id !== state.seed.moveId ||
      state.epoch !== journal.epoch ||
      record.employeeId !== state.seed.source.record.employeeId ||
      record.owner !== state.seed.source.record.owner ||
      state.sourceStop?.phase !== 'closed'
    )
      refuse();
    return state;
  }
  async #native(args: readonly string[], current: () => void): Promise<string> {
    current();
    try {
      const text = await this.#run(args);
      current();
      return text;
    } catch {
      current();
      refuse();
    }
  }
  async #capture(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<DockerCredentialHome> {
    const state = this.#state(record, journal),
      current = () => journal.current(),
      seed = state.seed;
    if (state.sourceStop?.phase !== 'closed') refuse();
    const proof = await DockerPlanSourceReader.prototype.capture.call(
      this.#source,
      seed.source.record,
      seed.source.binding,
      current,
      true
    );
    current();
    const seen = DockerPlanSourceProof.prototype.observation.call(proof, seed.source.record, seed.source.binding);
    if (seen.kind !== 'stopped' || seen.terminalStateDigest !== state.sourceStop!.terminalStateDigest)
      refuse('DOCKER_PLAN_SOURCE_CHANGED');
    const home = await this.#home(seed.source.record, current);
    current();
    if (
      home.source !== seed.source.record.destination!.home.source ||
      !/^([1-9][0-9]*):([0-9]+)$/.test(home.user) ||
      !decimal.safeParse(home.dev).success ||
      !decimal.safeParse(home.ino).success
    )
      refuse('DOCKER_PLAN_SOURCE_HOME_CHANGED');
    return Object.freeze({ ...home });
  }
  async #image(
    state: DockerPlanMoveJournalState,
    current: () => void
  ): Promise<{ env: string[]; labels: Record<string, string> }> {
    const image = z
      .array(
        z.object({
          Id: z.literal(state.seed.target.workerImage.imageId),
          Config: z.object({
            Env: z.array(z.string().max(16384)).max(512).nullable(),
            Labels: z.record(z.string(), z.string()).nullable().optional(),
            Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
          }),
        })
      )
      .length(1)
      .parse(JSON.parse(await this.#native(['image', 'inspect', state.seed.target.workerImage.imageId], current)))[0]!;
    if (image.Config.Volumes && Object.keys(image.Config.Volumes).length) refuse();
    const env = image.Config.Env ?? [],
      keys = env.map((v) => v.slice(0, v.indexOf('=')));
    if (
      keys.some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) ||
      new Set(keys).size !== keys.length ||
      image.Config.Labels?.['org.reverie.worker-client.manifest'] !== state.seed.target.workerImage.clientManifestDigest
    )
      refuse();
    // Explicitly clear EVERY inherited key as well as all known pre-JS loaders.
    // The image ID remains separately pinned; no old provider account env survives.
    const fixed = [
      ...DOCKER_OWNER_STOP_NATIVE_ENV,
      'NODE_V8_COVERAGE=',
      'NODE_COMPILE_CACHE=',
      'NODE_EXTRA_CA_CERTS=',
      'NODE_REPL_EXTERNAL_MODULE=',
      'LD_DEBUG=',
      'LD_DEBUG_OUTPUT=',
      'LD_PROFILE=',
      'LD_TRACE_LOADED_OBJECTS=',
      'MALLOC_TRACE=',
    ];
    const values = new Map(env.map((v) => [v.slice(0, v.indexOf('=')), v.slice(0, v.indexOf('=')) + '=']));
    for (const entry of fixed) values.set(entry.slice(0, entry.indexOf('=')), entry);
    return { env: [...values.values()], labels: { ...image.Config.Labels } };
  }
  async #external(
    state: DockerPlanMoveJournalState,
    candidate: DockerPlanSourceCandidate,
    current: () => void
  ): Promise<string> {
    DockerPlanAccountSnapshot.prototype.selected.call(candidate.snapshot, candidate.account);
    const root = DockerPlanAccountSnapshot.prototype.rootIdentity.call(candidate.snapshot);
    if (root.uid !== Number((await this.#home(state.seed.source.record, current)).user.split(':')[0])) refuse();
    const raw = z
      .array(
        z.object({
          Id: z.literal(state.seed.source.binding.containerId),
          Config: z.object({ Env: z.array(z.string()).nullable() }),
          Mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string() })).max(64),
        })
      )
      .length(1)
      .parse(
        JSON.parse(await this.#native(['container', 'inspect', state.seed.source.binding.containerId], current))
      )[0]!;
    const key = candidate.account.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const selected = (raw.Config.Env ?? []).filter((e) => e.startsWith(key + '='));
    if (selected.length !== 1) refuse('DOCKER_PLAN_SOURCE_ACCOUNT_UNCONFIRMED');
    const target = path(selected[0]!.slice(key.length + 1));
    const mounts = raw.Mounts.filter(
      (m) =>
        m.Type === 'bind' &&
        m.Destination !== '/' &&
        (target === m.Destination || target.startsWith(m.Destination + '/'))
    ).sort((a, b) => b.Destination.length - a.Destination.length);
    const mount = mounts[0];
    if (!mount || (mounts[1] && mounts[1].Destination === mount.Destination)) refuse();
    const source = path(path(mount.Source) + target.slice(mount.Destination.length));
    DockerPlanAccountSnapshot.prototype.require.call(candidate.snapshot);
    current();
    return source;
  }
  async #configuration(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    candidate?: DockerPlanSourceCandidate
  ): Promise<Scope> {
    const state = this.#state(record, journal),
      current = () => journal.current(),
      home = await this.#capture(record, journal);
    const image = await this.#image(state, current),
      externalSource = candidate ? await this.#external(state, candidate, current) : undefined;
    const labels = {
      ...image.labels,
      'reverie.box.plan-source.box': this.#box,
      'reverie.box.plan-source.move': record.id,
      'reverie.box.plan-source.employee': record.employeeId,
      'reverie.box.plan-source.container': state.seed.source.binding.containerId,
    };
    const mount = (source: string, target: string) => ({
      Type: 'bind',
      Source: source,
      Target: target,
      ReadOnly: true,
      BindOptions: { Propagation: 'rprivate', NonRecursive: true },
    });
    const config = {
      Image: state.seed.target.workerImage.imageId,
      User: home.user,
      Entrypoint: [native],
      Cmd: ['--no-global-search-paths', '--no-addons', '--input-type=commonjs', '-e', DOCKER_PLAN_SOURCE_HOLD_PROGRAM],
      WorkingDir: '/',
      Env: image.env,
      Healthcheck: { Test: ['NONE'] },
      Labels: labels,
      OpenStdin: false,
      StdinOnce: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        PidMode: '',
        IpcMode: 'private',
        UTSMode: '',
        UsernsMode: '',
        AutoRemove: false,
        RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'none', Config: {} },
        Memory: 256 * 1024 * 1024,
        MemorySwap: 256 * 1024 * 1024,
        PidsLimit: 32,
        Mounts: [
          mount(home.source, '/home/agent'),
          ...(externalSource ? [mount(externalSource, '/source-account')] : []),
        ],
      },
    };
    current();
    return { home, config, ...(externalSource ? { externalSource, candidate } : {}) };
  }
  async #fixed(id: string, scope: Scope, current: () => void): Promise<Record<string, unknown>> {
    current();
    const raw = await inspectIdentityHelper(this.#command, id, scope.config);
    current();
    const config = z.record(z.string(), z.unknown()).parse(raw.Config),
      host = z.record(z.string(), z.unknown()).parse(raw.HostConfig),
      expected = scope.config.HostConfig as Record<string, unknown>;
    for (const key of ['WorkingDir', 'Healthcheck', 'Labels', 'AttachStdin', 'AttachStdout', 'AttachStderr'])
      if (!isDeepStrictEqual(config[key], scope.config[key])) refuse();
    for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'AutoRemove', 'LogConfig'])
      if (!isDeepStrictEqual(host[key], expected[key])) refuse();
    const mounts = z.array(z.record(z.string(), z.unknown())).parse(host.Mounts);
    if (!isDeepStrictEqual(mounts, expected.Mounts) || (config.Volumes && Object.keys(config.Volumes as object).length))
      refuse();
    return raw;
  }
  async #init(id: string, current: () => void): Promise<string> {
    const result = await this.#native(
      [
        'exec',
        id,
        native,
        '--no-global-search-paths',
        '--no-addons',
        '--input-type=commonjs',
        '-e',
        DOCKER_PLAN_INIT_PROGRAM,
      ],
      current
    );
    if (Buffer.byteLength(result) > 4096) refuse();
    return initSchema.parse(JSON.parse(result)).startTicks;
  }
  async #running(id: string, scope: Scope, current: () => void): Promise<{ pid: number; startTicks: string }> {
    const first = await this.#fixed(id, scope, current),
      a = z.record(z.string(), z.unknown()).parse(first.State);
    if (
      a.Running !== true ||
      a.Status !== 'running' ||
      !Number.isSafeInteger(a.Pid) ||
      Number(a.Pid) <= 0 ||
      a.Paused !== false ||
      a.Restarting !== false ||
      a.Dead !== false
    )
      refuse();
    const ticks = await this.#init(id, current),
      last = await this.#fixed(id, scope, current),
      b = last.State;
    if (!isDeepStrictEqual(a, b) || ticks !== (await this.#init(id, current))) refuse();
    return { pid: Number(a.Pid), startTicks: ticks };
  }
  async #publish(journal: PlanMoveDockerJournal, reader: unknown, previous: unknown): Promise<void> {
    const before = journal.read();
    if (!isDeepStrictEqual(before.sourceReader, previous)) refuse('DOCKER_PLAN_SOURCE_CURSOR_CHANGED');
    const next = DockerPlanMoveJournalState.parse({ ...before, sourceReader: reader });
    await journal.publish(before, next);
    journal.current();
  }
  #flight<T>(record: Readonly<PlanMoveRecord>, work: () => Promise<T>): Promise<T> {
    if (this.#flights.has(record.id))
      return Promise.reject(new DockerEmployeeContinuationError('DOCKER_PLAN_SOURCE_HOLDER_BUSY'));
    this.#flights.add(record.id);
    return work()
      .catch((error) => {
        if (error instanceof DockerEmployeeContinuationError) throw error;
        return refuse();
      })
      .finally(() => {
        this.#flights.delete(record.id);
      });
  }
  open(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    candidate?: DockerPlanSourceCandidate
  ): Promise<void> {
    const captured = Object.freeze(structuredClone(record));
    const selected = candidate
      ? Object.freeze({ snapshot: candidate.snapshot, account: structuredClone(candidate.account) })
      : undefined;
    return this.#flight(captured, () => this.#open(captured, journal, selected));
  }
  context(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    selector: DockerPlanSourceContextSelection
  ): Promise<Readonly<{ context: DockerPlanSourceContext; contextSource?: string }>> {
    const captured = Object.freeze(structuredClone(record)),
      selected = structuredClone(selector);
    return this.#flight(captured, () => this.#context(captured, journal, selected));
  }
  auth(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    selection: Readonly<{ row: V3; initial: DockerPlanInitialReceipt }>
  ): Promise<Readonly<{ auth: string; installedAuthDigest: string; observedAuthDigest: string }>> {
    const captured = Object.freeze(structuredClone(record)),
      selected = structuredClone(selection);
    return this.#flight(captured, () => this.#auth(captured, journal, selected));
  }
  close(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void> {
    const captured = Object.freeze(structuredClone(record));
    return this.#flight(captured, () => this.#close(captured, journal));
  }
  async #open(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    candidate?: DockerPlanSourceCandidate
  ): Promise<void> {
    const scope = await this.#configuration(record, journal, candidate),
      current = () => journal.current();
    const seed = journal.read().seed,
      name = 'reverie-boxed-' + digest([this.#box, 'plan-source-reader', record.id, digest(seed)]);
    let cursor = journal.read().sourceReader;
    if (!cursor) {
      const intent = {
        version: 1,
        purpose: 'docker-plan-source-reader-v1',
        name,
        imageId: seed.target.workerImage.imageId,
        configurationDigest: digest(scope.config),
        phase: 'create-issued',
      };
      await this.#publish(journal, intent, undefined);
      const id = hash.parse(await this.#create(name, scope.config, current));
      current();
      await this.#publish(journal, { ...intent, phase: 'created', containerId: id }, intent);
      cursor = journal.read().sourceReader;
    } else if (
      cursor.name !== name ||
      cursor.imageId !== seed.target.workerImage.imageId ||
      cursor.configurationDigest !== digest(scope.config)
    )
      refuse();
    if (!cursor) refuse();
    if (cursor.phase === 'create-issued') {
      // Unknown CREATE is observed by the original exact name, never sent again.
      const ids = z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(1)
        .parse(
          (
            await this.#native(
              ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'name=^/' + name + '$'],
              current
            )
          )
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        );
      if (ids.length !== 1) refuse();
      await this.#fixed(ids[0]!, scope, current);
      await this.#publish(journal, { ...cursor, phase: 'created', containerId: ids[0] }, cursor);
      cursor = journal.read().sourceReader!;
    }
    if (cursor.phase === 'closed' || cursor.phase === 'close-issued') {
      this.#scopes.set(record.id, scope);
      await this.#close(record, journal);
      return;
    }
    if (cursor.phase === 'created') {
      const raw = await this.#fixed(cursor.containerId, scope, current),
        state = z.record(z.string(), z.unknown()).parse(raw.State);
      if (state.Running !== true) {
        if (
          state.Status !== 'created' ||
          state.Pid !== 0 ||
          state.Paused !== false ||
          state.Restarting !== false ||
          state.Dead !== false
        )
          refuse();
        await this.#publish(journal, { ...cursor, phase: 'start-issued' }, cursor);
        cursor = journal.read().sourceReader!;
        await this.#native(['container', 'start', cursor.containerId!], current);
      }
    }
    if (!('containerId' in cursor) || !cursor.containerId) refuse();
    const init = await this.#running(cursor.containerId, scope, current);
    if (cursor.phase === 'running' && !isDeepStrictEqual(init, cursor.init)) refuse();
    if (cursor.phase !== 'running') await this.#publish(journal, { ...cursor, phase: 'running', init }, cursor);
    this.#scopes.set(record.id, scope);
    const value = await this.#read(record, journal, 'home', seed.target.provider, 'legacy', '', '', '', '', '', '', '');
    const home = z
      .object({
        version: z.literal(1),
        purpose: z.literal('reverie-plan-source-home-v1'),
        homeDev: z.literal(scope.home.dev),
        homeIno: z.literal(scope.home.ino),
        uid: z.literal(Number(scope.home.user.split(':')[0])),
        gid: z.literal(Number(scope.home.user.split(':')[1])),
      })
      .strict();
    home.parse(value);
    if (candidate) DockerPlanAccountSnapshot.prototype.require.call(candidate.snapshot);
  }
  async #active(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal
  ): Promise<{ scope: Scope; id: string }> {
    const state = this.#state(record, journal),
      cursor = state.sourceReader,
      scope = this.#scopes.get(record.id);
    if (!scope || cursor?.phase !== 'running' || digest(scope.config) !== cursor.configurationDigest) refuse();
    const home = await this.#capture(record, journal);
    if (!isDeepStrictEqual(home, scope.home)) refuse();
    const init = await this.#running(cursor.containerId, scope, () => journal.current());
    if (!isDeepStrictEqual(init, cursor.init)) refuse();
    if (scope.candidate) DockerPlanAccountSnapshot.prototype.require.call(scope.candidate.snapshot);
    return { scope, id: cursor.containerId };
  }
  async #read(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    mode: string,
    provider: string,
    kind: string,
    operation: string,
    projection: string,
    accountId: string,
    nativeId: string,
    accountDev: string,
    accountIno: string,
    historical: string
  ): Promise<unknown> {
    const { scope, id } = await this.#active(record, journal),
      args = [
        mode,
        scope.home.dev,
        scope.home.ino,
        provider,
        kind,
        operation,
        projection,
        accountId,
        nativeId,
        accountDev,
        accountIno,
        historical,
      ];
    const text = await this.#native(
      [
        'exec',
        id,
        native,
        '--no-global-search-paths',
        '--no-addons',
        '--input-type=commonjs',
        '-e',
        DOCKER_PLAN_SOURCE_READ_PROGRAM,
        '--',
        ...args,
      ],
      () => journal.current()
    );
    if (Buffer.byteLength(text) > 512 * 1024) refuse();
    await this.#active(record, journal);
    try {
      return JSON.parse(text);
    } catch {
      return refuse();
    }
  }
  #generation(row: V3, initial: DockerPlanInitialReceipt): void {
    const receipt = DockerPlanInitialReceipt.parse(initial),
      task = row.tasks?.find((t) => t.role === 'identity-helper');
    if (
      !task ||
      task.phase !== 'completed' ||
      task.imageId !== row.workerImage.imageId ||
      task.resultDigest !== digest(receipt)
    )
      refuse();
    if (
      !row.destination ||
      receipt.operationId !== row.request.operationId ||
      receipt.sessionId !== row.request.sessionId ||
      receipt.containerId !== row.destination.containerId ||
      receipt.projectionDigest !== row.planReplacement.account.projectionDigest ||
      receipt.accountId !== row.planReplacement.account.id ||
      receipt.provider !== row.planReplacement.account.provider ||
      receipt.contextInputDigest !== row.planReplacement.account.contextDigest
    )
      refuse();
  }
  async #context(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    selector: DockerPlanSourceContextSelection
  ): Promise<Readonly<{ context: DockerPlanSourceContext; contextSource?: string }>> {
    const scope = this.#scopes.get(record.id);
    if (!scope) refuse();
    let provider: 'anthropic' | 'openai',
      operation = '',
      projection = '',
      accountId = '',
      historical = '',
      configDev = '',
      configIno = '';
    if (selector.kind === 'generation') {
      if (digest(selector.row) !== digest(journal.read().seed.source.record)) refuse();
      this.#generation(selector.row, selector.initial);
      provider = selector.row.planReplacement.account.provider;
      operation = selector.row.request.operationId;
      projection = selector.row.planReplacement.account.projectionDigest;
      accountId = selector.row.planReplacement.account.id;
      historical = selector.initial.contextDigest;
      configDev = selector.initial.configDev;
      configIno = selector.initial.configIno;
    } else provider = selector.provider;
    if (selector.kind === 'account' && (!scope.candidate || scope.candidate.account.provider !== provider)) refuse();
    const root =
      selector.kind === 'account'
        ? DockerPlanAccountSnapshot.prototype.rootIdentity.call(scope.candidate!.snapshot)
        : undefined;
    const result = z
      .object({
        version: z.literal(1),
        purpose: z.literal('reverie-plan-source-context-v1'),
        provider: z.literal(provider),
        context: z.unknown(),
      })
      .strict()
      .parse(
        await this.#read(
          record,
          journal,
          'context',
          provider,
          selector.kind,
          operation,
          projection,
          accountId,
          selector.nativeId,
          root?.dev ?? configDev,
          root?.ino ?? configIno,
          historical
        )
      );
    const context = dockerPlanContextForProvider(result.context, provider);
    if (context.conversation?.nativeId !== selector.nativeId) refuse();
    if (
      selector.kind === 'account' &&
      (context.source.kind !== 'intake' || context.source.dev !== root!.dev || context.source.ino !== root!.ino)
    )
      refuse();
    return Object.freeze({ context, ...(selector.kind === 'account' ? { contextSource: scope.externalSource! } : {}) });
  }
  async #auth(
    record: Readonly<PlanMoveRecord>,
    journal: PlanMoveDockerJournal,
    selection: Readonly<{ row: V3; initial: DockerPlanInitialReceipt }>
  ): Promise<Readonly<{ auth: string; installedAuthDigest: string; observedAuthDigest: string }>> {
    const seed = journal.read().seed,
      source = seed.target.accountSource,
      row = selection.row,
      scope = this.#scopes.get(record.id);
    if (
      !scope ||
      row.employeeId !== record.employeeId ||
      row.owner !== record.owner ||
      row.destination?.home.source !== scope.home.source
    )
      refuse();
    if (
      source.kind !== 'retained-generation' ||
      row.planReplacement.moveId !== source.moveId ||
      row.request.operationId !== source.operationId ||
      row.destination?.containerId !== source.containerId ||
      row.planReplacement.account.projectionDigest !== source.projectionDigest ||
      row.planReplacement.account.id !== seed.target.accountId ||
      row.planReplacement.account.provider !== seed.target.provider
    )
      refuse();
    this.#generation(row, selection.initial);
    if (selection.initial.homeDev !== scope.home.dev || selection.initial.homeIno !== scope.home.ino) refuse();
    const result = z
      .object({
        version: z.literal(1),
        purpose: z.literal('reverie-plan-source-auth-v1'),
        operationId: z.literal(source.operationId),
        projectionDigest: z.literal(source.projectionDigest),
        accountId: z.literal(seed.target.accountId),
        provider: z.literal(seed.target.provider),
        installedAuthDigest: hash,
        observedAuthDigest: hash,
        auth: z
          .string()
          .min(2)
          .max(128 * 1024),
      })
      .strict()
      .parse(
        await this.#read(
          record,
          journal,
          'auth',
          seed.target.provider,
          'generation',
          source.operationId,
          source.projectionDigest,
          seed.target.accountId,
          '',
          selection.initial.configDev,
          selection.initial.configIno,
          selection.initial.contextDigest
        )
      );
    if (
      result.installedAuthDigest !== selection.initial.installedAuthDigest ||
      digestText(result.auth) !== result.observedAuthDigest
    )
      refuse();
    return Object.freeze({
      auth: result.auth,
      installedAuthDigest: result.installedAuthDigest,
      observedAuthDigest: result.observedAuthDigest,
    });
  }
  async #close(record: Readonly<PlanMoveRecord>, journal: PlanMoveDockerJournal): Promise<void> {
    const state = this.#state(record, journal),
      cursor = state.sourceReader,
      scope = this.#scopes.get(record.id);
    if (
      !cursor ||
      !scope ||
      cursor.configurationDigest !== digest(scope.config) ||
      !('containerId' in cursor) ||
      !cursor.containerId
    )
      refuse();
    const current = () => journal.current();
    if (cursor.phase === 'closed') {
      const a = terminal(await this.#fixed(cursor.containerId, scope, current)),
        b = terminal(await this.#fixed(cursor.containerId, scope, current));
      if (!isDeepStrictEqual(a, b) || digest(b) !== cursor.terminalStateDigest) refuse();
      return;
    }
    if (cursor.phase !== 'running' && cursor.phase !== 'close-issued') refuse();
    if (cursor.phase === 'running') {
      await this.#active(record, journal);
      await this.#publish(journal, { ...cursor, phase: 'close-issued' }, cursor);
      await this.#native(['container', 'stop', '--time', '2', cursor.containerId], current);
    }
    const a = terminal(await this.#fixed(cursor.containerId, scope, current)),
      b = terminal(await this.#fixed(cursor.containerId, scope, current));
    if (!isDeepStrictEqual(a, b)) refuse();
    await this.#publish(
      journal,
      { ...journal.read().sourceReader, phase: 'closed', terminalStateDigest: digest(b) },
      journal.read().sourceReader
    );
  }
}
function digestText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

Object.freeze(DockerPlanSourceHolder.prototype);
