/** Purpose-specific idempotent metadata attempts. No worker CREATE/START/provider replay. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { DockerEmployeeInspect } from './docker-employee-engine-data.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { DOCKER_OWNER_STOP_NATIVE_ENV } from './docker-owner-stop-native.js';
import { EphemeralDirectoryOwner } from './docker-ephemeral-directory.js';
import {
  EphemeralAck,
  EphemeralDirectory,
  EphemeralRequest,
  ephemeralContinuationProjection,
  ephemeralDirectorySessionId,
  type EphemeralAttempt,
  type EphemeralJournal,
  type EphemeralRestoration,
} from './docker-ephemeral-data.js';
import { EPHEMERAL_NODE, EPHEMERAL_PREPARE_PROGRAM, EPHEMERAL_DESTINATION_PROGRAM } from './docker-ephemeral-native.js';
const cid = z.string().regex(/^[a-f0-9]{64}$/);
const destination = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ephemeral-destination-v1'),
    scratch: EphemeralDirectory,
    tmp: EphemeralDirectory,
  })
  .strict();
function fail(code = 'DOCKER_EPHEMERAL_PREPARATION_REQUIRED'): never {
  throw new DockerEmployeeContinuationError(code);
}
export class DockerEphemeralRestoration {
  readonly #owners = new Map<string, EphemeralDirectoryOwner>();
  constructor(
    private readonly command: DockerEngineCommand,
    private readonly journal: EphemeralJournal,
    private readonly boxId: string,
    private readonly nativeImageId: string,
    private readonly source: (row: DockerEmployeeContinuationRecord) => Promise<DockerEmployeeInspect>,
    private readonly target: (row: DockerEmployeeContinuationRecord) => Promise<DockerEmployeeInspect | null>,
    private readonly forbidden: (
      row: DockerEmployeeContinuationRecord
    ) => Promise<readonly { dev: string; ino: string }[]>
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(nativeImageId)) throw Error('Protected native image required');
  }
  #configuration(row: DockerEmployeeContinuationRecord, attempt: EphemeralAttempt): Record<string, unknown> {
    if (attempt.imageId !== this.nativeImageId || row.workerImage.imageId !== this.nativeImageId)
      fail('DOCKER_EPHEMERAL_IMAGE_CHANGED');
    const root = attempt.request.root;
    return {
      Image: attempt.imageId,
      WorkingDir: '/',
      Healthcheck: { Test: ['NONE'] },
      User: root.uid + ':' + root.gid,
      Entrypoint: [EPHEMERAL_NODE],
      Cmd: ['--input-type=commonjs', '--eval', EPHEMERAL_PREPARE_PROGRAM],
      Env: DOCKER_OWNER_STOP_NATIVE_ENV,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Labels: {
        'reverie.box.ephemeral.box': this.boxId,
        'reverie.box.ephemeral.operation': row.request.operationId,
        'reverie.box.ephemeral.ordinal': String(attempt.ordinal),
      },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        RestartPolicy: { Name: 'no' },
        Memory: 64 * 1024 * 1024,
        MemorySwap: 64 * 1024 * 1024,
        PidsLimit: 16,
        Mounts: [
          {
            Type: 'bind',
            Source: attempt.rootSource,
            Target: '/restore-root',
            ReadOnly: false,
            BindOptions: { Propagation: 'rprivate', NonRecursive: true },
          },
        ],
      },
    };
  }
  async #inspect(row: DockerEmployeeContinuationRecord, id: string, attempt: EphemeralAttempt) {
    cid.parse(id);
    const expected = this.#configuration(row, attempt);
    if (dockerContinuationDigest(expected) !== attempt.configurationDigest) fail('DOCKER_EPHEMERAL_INTENT_CHANGED');
    const raw = z
      .array(z.record(z.string(), z.unknown()))
      .length(1)
      .parse(JSON.parse(await this.command.run(['container', 'inspect', id])))[0]!;
    const config = z.record(z.string(), z.unknown()).parse(raw.Config),
      host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
    if (raw.Id !== id || raw.Name !== '/' + attempt.name || raw.Image !== attempt.imageId)
      fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    const image = z
      .array(
        z.object({
          Id: z.string(),
          Config: z.object({
            Env: z.array(z.string()).nullable(),
            Labels: z.record(z.string(), z.string()).nullable(),
          }),
        })
      )
      .length(1)
      .parse(JSON.parse(await this.command.run(['image', 'inspect', attempt.imageId])))[0]!;
    if (image.Id !== attempt.imageId) fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    const environment = (values: unknown) => {
      const selected = z.array(z.string()).parse(values),
        result: Record<string, string> = {};
      for (const value of selected) {
        const index = value.indexOf('=');
        if (index < 1 || Object.hasOwn(result, value.slice(0, index))) fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
        result[value.slice(0, index)] = value.slice(index + 1);
      }
      return result;
    };
    const desiredEnv = { ...environment(image.Config.Env ?? []), ...environment(expected.Env) };
    if (
      !isDeepStrictEqual(environment(config.Env), desiredEnv) ||
      !isDeepStrictEqual(config.Labels, {
        ...(image.Config.Labels ?? {}),
        ...(expected.Labels as Record<string, string>),
      })
    )
      fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    for (const key of [
      'User',
      'Entrypoint',
      'Cmd',
      'OpenStdin',
      'StdinOnce',
      'AttachStdin',
      'AttachStdout',
      'AttachStderr',
      'Tty',
    ])
      if (!isDeepStrictEqual(config[key], expected[key])) fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    if (
      config.WorkingDir !== '/' ||
      !isDeepStrictEqual((config.Healthcheck as { Test?: unknown } | undefined)?.Test, ['NONE'])
    )
      fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    const desired = expected.HostConfig as Record<string, unknown>;
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
      if (!isDeepStrictEqual(host[key], desired[key])) fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    // Docker omits false ReadOnly in HostConfig reflection. The actual mount
    // below must independently report RW:true; no opaque missing mount grants it.
    const reflected = z
      .array(
        z
          .object({
            Type: z.literal('bind'),
            Source: z.literal(attempt.rootSource),
            Target: z.literal('/restore-root'),
            ReadOnly: z.literal(false).default(false),
            BindOptions: z
              .object({
                Propagation: z.literal('rprivate'),
                NonRecursive: z.literal(true),
                CreateMountpoint: z.literal(false).optional(),
              })
              .strict(),
          })
          .strict()
      )
      .length(1)
      .safeParse(host.Mounts);
    if (!reflected.success) fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    const normalized = reflected.data.map((m) => {
      const { CreateMountpoint: _create, ...binding } = m.BindOptions;
      return { ...m, BindOptions: binding };
    });
    if (!isDeepStrictEqual(normalized, desired.Mounts)) fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    if (
      !isDeepStrictEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 }) &&
      !isDeepStrictEqual(host.RestartPolicy, { Name: 'no' })
    )
      fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'VolumesFrom', 'Binds', 'Links'])
      if (host[key] !== undefined && host[key] !== null && !isDeepStrictEqual(host[key], []))
        fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    for (const key of ['PidMode', 'IpcMode', 'CgroupnsMode', 'UTSMode'])
      if (host[key] === 'host') fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    if (host.AutoRemove === true) fail('DOCKER_EPHEMERAL_HELPER_CHANGED');
    const mounts = z
      .array(
        z.object({
          Type: z.literal('bind'),
          Source: z.literal(attempt.rootSource),
          Destination: z.literal('/restore-root'),
          RW: z.literal(true),
        })
      )
      .length(1)
      .parse(raw.Mounts);
    if (mounts.length !== 1) fail();
    return z
      .object({
        Running: z.boolean(),
        Paused: z.boolean(),
        Status: z.string(),
        ExitCode: z.number().int(),
        Dead: z.boolean(),
        OOMKilled: z.boolean(),
        Restarting: z.boolean(),
      })
      .parse(raw.State);
  }
  async #census(
    row: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<Map<string, { Running: boolean; Status: string; Paused: boolean; Dead: boolean; Restarting: boolean }>> {
    const before = this.journal.readEphemeral(row),
      states = new Map<
        string,
        { Running: boolean; Status: string; Paused: boolean; Dead: boolean; Restarting: boolean }
      >();
    const output = await this.command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'label=reverie.box.ephemeral.box=' + this.boxId,
      '--filter',
      'label=reverie.box.ephemeral.operation=' + row.request.operationId,
      '--format',
      '{{.ID}}',
    ]);
    current();
    if (output.length > 4096) fail('DOCKER_EPHEMERAL_CENSUS_UNCONFIRMED');
    const ids = output.trim()
      ? output
          .trim()
          .split('\n')
          .map((id) => cid.parse(id))
      : [];
    if (ids.length > 32 || new Set(ids).size !== ids.length) fail('DOCKER_EPHEMERAL_CENSUS_UNCONFIRMED');
    const after = structuredClone(before);
    for (const id of ids) {
      const raw = z
        .array(z.object({ Id: cid, Name: z.string() }))
        .length(1)
        .parse(JSON.parse(await this.command.run(['container', 'inspect', id])))[0]!;
      current();
      const attempt = after?.attempts.find((value) => '/' + value.name === raw.Name);
      if (
        !attempt ||
        raw.Id !== id ||
        ('containerId' in attempt && attempt.containerId !== undefined && attempt.containerId !== id)
      )
        fail('DOCKER_EPHEMERAL_CENSUS_UNCONFIRMED');
      states.set(id, await this.#inspect(row, id, attempt));
      current();
      if (attempt.phase === 'create-issued') attempt.containerId = id;
    }
    for (const attempt of before?.attempts ?? []) {
      if ('containerId' in attempt && attempt.containerId !== undefined && !ids.includes(attempt.containerId))
        fail('DOCKER_EPHEMERAL_CENSUS_UNCONFIRMED');
    }
    if (after && !isDeepStrictEqual(before, after)) await this.journal.publishEphemeral(row, before, after, current);
    return states;
  }
  async #readDestination(row: DockerEmployeeContinuationRecord, owner: EphemeralDirectoryOwner): Promise<void> {
    const raw = await this.target(row);
    owner.assertCurrent();
    if (!raw?.State.Running) fail();
    if (raw.Config.User !== owner.root.uid + ':' + owner.root.gid) fail('DOCKER_EPHEMERAL_USER_CHANGED');
    const env = DOCKER_OWNER_STOP_NATIVE_ENV.flatMap((value) => ['--env', value]);
    const seen = destination.parse(
      JSON.parse(
        await this.command.run([
          'exec',
          ...env,
          '--user',
          raw.Config.User,
          raw.Id,
          EPHEMERAL_NODE,
          '--input-type=commonjs',
          '--eval',
          EPHEMERAL_DESTINATION_PROGRAM,
        ])
      )
    );
    owner.assertCurrent();
    const leaves = owner.leaves();
    if (!isDeepStrictEqual(seen.scratch, leaves.scratch) || !isDeepStrictEqual(seen.tmp, leaves.tmp))
      fail('DOCKER_EPHEMERAL_DESTINATION_CHANGED');
    const after = await this.target(row);
    owner.assertCurrent();
    if (!after?.State.Running || after.Id !== raw.Id) fail('DOCKER_EPHEMERAL_DESTINATION_CHANGED');
  }
  async observe(row: DockerEmployeeContinuationRecord): Promise<'ready' | 'unissued'> {
    const source = await this.source(row),
      projection = ephemeralContinuationProjection(source, row);
    if (!projection) return 'ready';
    this.#readImage(row);
    const previous = this.#owners.get(row.request.operationId);
    if (previous) {
      previous.assertCurrent();
      return 'ready';
    }
    // A running destination can prove the projection freshly after control restart.
    const raw = await this.target(row);
    if (!raw?.State.Running) return 'unissued';
    if (this.#owners.size >= 64) fail('DOCKER_EPHEMERAL_OWNER_LIMIT');
    const owner = new EphemeralDirectoryOwner();
    try {
      const forbidden = await this.forbidden(row);
      owner.assertCurrent();
      owner.captureLeaves(projection, forbidden);
      await this.#readDestination(row, owner);
      await this.source(row);
      owner.assertCurrent();
      this.#owners.set(row.request.operationId, owner);
      return 'ready';
    } catch (cause) {
      try {
        owner.close();
      } catch (close) {
        throw new AggregateError([cause, close]);
      }
      throw cause;
    }
  }
  async prepare(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const source = await this.source(row);
    current();
    const projection = ephemeralContinuationProjection(source, row);
    if (!projection) return;
    if (row.workerImage.imageId !== this.nativeImageId) fail('DOCKER_EPHEMERAL_IMAGE_CHANGED');
    const previous = this.#owners.get(row.request.operationId);
    if (previous) {
      previous.assertCurrent();
      current();
      return;
    }
    if (this.#owners.size >= 64) fail('DOCKER_EPHEMERAL_OWNER_LIMIT');
    const owner = new EphemeralDirectoryOwner();
    const valid = () => {
      current();
      owner.assertCurrent();
    };
    try {
      if (source.Config.User !== owner.root.uid + ':' + owner.root.gid) fail('DOCKER_EPHEMERAL_USER_CHANGED');
      const forbidden = await this.forbidden(row);
      valid();
      owner.inspectExistingPrefix(projection, forbidden);
      const states = await this.#census(row, valid);
      const before = this.journal.readEphemeral(row),
        ordinal = (before?.attempts.length ?? 0) + 1;
      if (ordinal > 32) {
        await this.#continue(row, owner, projection, forbidden, valid, states);
        this.#owners.set(row.request.operationId, owner);
        return;
      }
      const request = EphemeralRequest.parse({
        version: 1,
        purpose: 'reverie-ephemeral-directory-restore-v1',
        operationId: row.request.operationId,
        employeeId: row.employeeId,
        sessionId: ephemeralDirectorySessionId(row),
        sessionGeneration: row.request.sessionGeneration,
        invocation: ordinal,
        layout: projection.layout,
        root: owner.root,
        forbidden,
      });
      let attempt: EphemeralAttempt = {
        ordinal,
        name: 'reverie-boxed-ephemeral-' + dockerContinuationDigest([this.boxId, row.request.operationId, ordinal]),
        imageId: row.workerImage.imageId,
        configurationDigest: '0'.repeat(64),
        rootSource: projection.rootSource,
        request,
        phase: 'create-issued',
      };
      const config = this.#configuration(row, attempt);
      attempt = { ...attempt, configurationDigest: dockerContinuationDigest(config) };
      let cursor: EphemeralRestoration = {
        version: 1,
        purpose: 'reverie-ephemeral-restoration-v1',
        attempts: [...(before?.attempts ?? []), attempt],
      };
      await this.journal.publishEphemeral(row, before, cursor, valid);
      valid();
      const publish = async (next: EphemeralAttempt) => {
        const after = { ...cursor, attempts: [...cursor.attempts.slice(0, -1), next] };
        await this.journal.publishEphemeral(row, cursor, after, valid);
        cursor = after;
        attempt = next;
      };
      const id = await this.command.create(attempt.name, config, valid);
      valid();
      await this.#inspect(row, id, attempt);
      valid();
      await publish({ ...attempt, phase: 'created', containerId: id });
      valid();
      await publish({ ...attempt, phase: 'start-issued', containerId: id });
      valid();
      // This START is issued once for this new metadata attempt only. Unknown => fresh attempt next request.
      await this.command.run(['container', 'start', '--attach', '--interactive', id], JSON.stringify(request) + '\n');
      valid();
      if ((await this.command.run(['container', 'wait', id])).trim() !== '0')
        fail('DOCKER_EPHEMERAL_HELPER_UNCONFIRMED');
      valid();
      const state = await this.#inspect(row, id, attempt);
      valid();
      if (
        state.Running ||
        state.Paused ||
        state.Status !== 'exited' ||
        state.ExitCode !== 0 ||
        state.Dead ||
        state.OOMKilled ||
        state.Restarting
      )
        fail('DOCKER_EPHEMERAL_HELPER_UNCONFIRMED');
      const output = await this.command.run(['logs', '--tail', '1', id]);
      valid();
      if (Buffer.byteLength(output) > 8192) fail();
      const ack = EphemeralAck.parse(JSON.parse(output));
      const leaves = owner.captureLeaves(projection, forbidden);
      valid();
      const { forbidden: _forbidden, ...correlation } = request;
      if (!isDeepStrictEqual(ack, { ...correlation, purpose: 'reverie-ephemeral-directories-ready-v1', ...leaves }))
        fail('DOCKER_EPHEMERAL_ACK_CHANGED');
      await this.source(row);
      valid();
      await publish({ ...attempt, phase: 'completed', containerId: id, ack });
      valid();
      this.#owners.set(row.request.operationId, owner);
    } catch (cause) {
      try {
        owner.close();
      } catch (close) {
        throw new AggregateError([cause, close]);
      }
      throw cause;
    }
  }
  async #continue(
    row: DockerEmployeeContinuationRecord,
    owner: EphemeralDirectoryOwner,
    projection: import('./docker-ephemeral-data.js').EphemeralProjection,
    forbidden: readonly { dev: string; ino: string }[],
    current: () => void,
    states: Map<string, { Running: boolean; Status: string; Paused: boolean; Dead: boolean; Restarting: boolean }>
  ): Promise<void> {
    let cursor = this.journal.readEphemeral(row)!;
    const invocation = (cursor.continuation?.invocation ?? 32) + 1;
    if (!Number.isSafeInteger(invocation)) fail('DOCKER_EPHEMERAL_INVOCATION_LIMIT');
    const fresh = EphemeralRequest.parse({
      version: 1,
      purpose: 'reverie-ephemeral-directory-restore-v1',
      operationId: row.request.operationId,
      employeeId: row.employeeId,
      sessionId: ephemeralDirectorySessionId(row),
      sessionGeneration: row.request.sessionGeneration,
      invocation,
      layout: projection.layout,
      root: owner.root,
      forbidden,
    });
    const sameScope = (attempt: EphemeralAttempt) =>
      attempt.imageId === row.workerImage.imageId &&
      attempt.rootSource === projection.rootSource &&
      isDeepStrictEqual({ ...attempt.request, invocation }, fresh);
    const usable = (attempt: EphemeralAttempt) => {
      if (!sameScope(attempt)) return false;
      if (!attempt.containerId) return attempt.phase === 'create-issued';
      const state = states.get(attempt.containerId);
      return (
        state &&
        !state.Running &&
        !state.Paused &&
        !state.Dead &&
        !state.Restarting &&
        ['created', 'exited'].includes(state.Status)
      );
    };
    const base = cursor.continuation
      ? cursor.attempts[cursor.continuation.attemptOrdinal - 1]
      : [...cursor.attempts].reverse().find(usable);
    if (!base || !usable(base)) fail('DOCKER_EPHEMERAL_CONTINUATION_UNCONFIRMED');
    const publish = async (continuation: import('./docker-ephemeral-data.js').EphemeralContinuation, id?: string) => {
      const next = {
        ...cursor,
        attempts: cursor.attempts.map((attempt) =>
          id && attempt.ordinal === base.ordinal && attempt.phase === 'create-issued' && !attempt.containerId
            ? { ...attempt, containerId: id }
            : attempt
        ),
        continuation,
      };
      await this.journal.publishEphemeral(row, cursor, next, current);
      cursor = next;
    };
    let id = base.containerId;
    if (!id) {
      await publish({ attemptOrdinal: base.ordinal, invocation, phase: 'create-issued' });
      current();
      try {
        id = await this.command.create(base.name, this.#configuration(row, base), current);
      } catch (cause) {
        // Exact deterministic name is the CREATE uniqueness fence, including a late original CREATE.
        await this.#census(row, current);
        cursor = this.journal.readEphemeral(row)!;
        id = cursor.attempts[base.ordinal - 1]!.containerId;
        if (!id) throw cause;
      }
      current();
      await this.#inspect(row, id, base);
      current();
      await publish({ attemptOrdinal: base.ordinal, invocation, phase: 'created', containerId: id }, id);
    } else await publish({ attemptOrdinal: base.ordinal, invocation, phase: 'created', containerId: id });
    current();
    const before = await this.#inspect(row, id, base);
    current();
    if (
      before.Running ||
      before.Paused ||
      before.Dead ||
      before.Restarting ||
      !['created', 'exited'].includes(before.Status)
    )
      fail('DOCKER_EPHEMERAL_CONTINUATION_UNCONFIRMED');
    await publish({ attemptOrdinal: base.ordinal, invocation, phase: 'start-issued', containerId: id });
    current();
    // Immutable Cmd reads a NEW bounded stdin frame; this is only the idempotent mkdir role.
    await this.command.run(['container', 'start', '--attach', '--interactive', id], JSON.stringify(fresh) + '\n');
    current();
    if ((await this.command.run(['container', 'wait', id])).trim() !== '0') fail('DOCKER_EPHEMERAL_HELPER_UNCONFIRMED');
    current();
    const state = await this.#inspect(row, id, base);
    current();
    if (
      state.Running ||
      state.Paused ||
      state.Status !== 'exited' ||
      state.ExitCode !== 0 ||
      state.Dead ||
      state.OOMKilled ||
      state.Restarting
    )
      fail('DOCKER_EPHEMERAL_HELPER_UNCONFIRMED');
    const output = await this.command.run(['logs', '--tail', '1', id]);
    current();
    if (Buffer.byteLength(output) > 8192) fail('DOCKER_EPHEMERAL_ACK_CHANGED');
    const ack = EphemeralAck.parse(JSON.parse(output)),
      leaves = owner.captureLeaves(projection, forbidden);
    current();
    const { forbidden: _forbidden, ...correlation } = fresh;
    if (!isDeepStrictEqual(ack, { ...correlation, purpose: 'reverie-ephemeral-directories-ready-v1', ...leaves }))
      fail('DOCKER_EPHEMERAL_ACK_CHANGED');
    await this.source(row);
    current();
    await publish({ attemptOrdinal: base.ordinal, invocation, phase: 'completed', containerId: id, ack });
    current();
  }
  assertCurrent(row: DockerEmployeeContinuationRecord): void {
    const owner = this.#owners.get(row.request.operationId);
    if (owner) this.#readImage(row);
    owner?.assertCurrent();
  }
  async require(row: DockerEmployeeContinuationRecord): Promise<void> {
    const source = await this.source(row);
    if (!ephemeralContinuationProjection(source, row)) return;
    this.#readImage(row);
    const owner = this.#owners.get(row.request.operationId);
    if (!owner) fail();
    owner.assertCurrent();
  }
  async verifyDestination(row: DockerEmployeeContinuationRecord): Promise<void> {
    const source = await this.source(row);
    if (!ephemeralContinuationProjection(source, row)) return;
    this.#readImage(row);
    if (!this.#owners.has(row.request.operationId)) await this.observe(row);
    const owner = this.#owners.get(row.request.operationId);
    if (!owner) fail();
    await this.#readDestination(row, owner);
  }
  #readImage(row: DockerEmployeeContinuationRecord): void {
    // Existing published providers retain their frozen image after a control
    // upgrade. This read path never creates or starts a metadata helper.
    if (row.workerImage.imageId !== this.nativeImageId && !['provider-issued', 'ready'].includes(row.phase))
      fail('DOCKER_EPHEMERAL_IMAGE_CHANGED');
  }
  close(): void {
    const errors: unknown[] = [];
    for (const owner of this.#owners.values())
      try {
        owner.close();
      } catch (cause) {
        errors.push(cause);
      }
    if (errors.length) throw new AggregateError(errors, 'Ephemeral directory closure unconfirmed');
  }
}
