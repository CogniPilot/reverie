/** Packaged controlplane-only Docker port. No HTTP-supplied endpoint or generic
 * command route. JSON creation avoids secret values in process argv.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request, type ClientRequest } from 'node:http';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
/** A completed rejection describes that response only. It grants no retry,
 * adoption or replacement authority; the continuation retains its issued fence. */
function createFailure(status?: number): DockerEmployeeContinuationError {
  const code =
    status === 400
      ? 'DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED'
      : status === 404
        ? 'DOCKER_CONTINUATION_CREATE_DEPENDENCY_MISSING'
        : status === 409
          ? 'DOCKER_CONTINUATION_CREATE_NAME_CONFLICT'
          : 'DOCKER_CONTINUATION_CREATE_UNCONFIRMED';
  return new DockerEmployeeContinuationError(code);
}
export interface DockerEngineCommand {
  run(args: readonly string[], input?: string, timeoutMs?: number): Promise<string>;
  create(name: string, configuration: Readonly<Record<string, unknown>>, requireCurrent: () => void): Promise<string>;
  /** Removes one never-started reprovision source, never by force. The owning
   * workflow separately proves its labels, journal entry and that it is unused. */
  removeCreatedSource?(name: string, containerId: string, requireCurrent: () => void): Promise<void>;
  /** Imports the worker image's registered closure into one private Nix store. */
  prepareWorkerStore?(
    name: string,
    spec: Readonly<{ imageId: string; user: string; nixSource: string }>,
    requireCurrent: () => void
  ): Promise<void>;
  /** Removes one recorded laptop container that hosts only its own init. */
  removeIdleLaptop?(containerId: string, requireCurrent: () => void): Promise<void>;
}
const probeOrigin = Symbol('complete native read-only resource ESRCH');
function probeArgs(args: readonly string[]): boolean {
  return (
    args.length >= 10 &&
    args.length <= 512 &&
    args[0] === 'exec' &&
    /^[a-f0-9]{64}$/.test(args[1] ?? '') &&
    args[2] === '/bin/reverie-docker-resources' &&
    ['probe-pool', 'probe-worker'].includes(args[3] ?? '') &&
    args.every((value) => typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value))
  );
}
function probeDigest(args: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}
class ResourceProbeReadRace extends Error {
  readonly #args: string;
  constructor(origin: symbol, args: readonly string[]) {
    super('DOCKER_RESOURCE_PROBE_PROCESS_EXITED');
    if (origin !== probeOrigin) throw Error('Actual resource read required');
    this.#args = probeDigest(args);
    Object.freeze(this);
  }
  matches(args: readonly string[]): boolean {
    return this.#args === probeDigest(args);
  }
}
Object.freeze(ResourceProbeReadRace.prototype);
export function dockerResourceProbeReadRace(error: unknown, args: readonly string[]): boolean {
  if (!(error instanceof ResourceProbeReadRace) || !probeArgs(args)) return false;
  try {
    return ResourceProbeReadRace.prototype.matches.call(error, args);
  } catch {
    return false;
  }
}
export class PackagedDockerEngineCommand implements DockerEngineCommand {
  constructor(private readonly endpoint = 'unix:///run/reverie-engine/docker.sock') {
    if (endpoint !== 'unix:///run/reverie-engine/docker.sock') throw Error('Fixed packaged Docker endpoint required');
  }
  run(originalArgs: readonly string[], input?: string, timeoutMs = 30000): Promise<string> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      return Promise.reject(Error('Invalid bounded Docker command deadline'));
    const args = Object.freeze([...originalArgs]);
    return new Promise((resolve, reject) => {
      const child = execFile(
        '/bin/docker',
        ['--host', this.endpoint, ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
        (error, stdout, stderr) => {
          if (
            error &&
            error.code === 1 &&
            error.killed === false &&
            error.signal === null &&
            input === undefined &&
            stdout === '' &&
            (stderr === 'BOXED_RESOURCE_IO: No such process (os error 3); effectIssued=false\n' ||
              stderr === 'BOXED_RESOURCE_IO: No such file or directory (os error 2); effectIssued=false\n' ||
              stderr === 'BOXED_RESOURCE_PID_EXITED; effectIssued=false\n') &&
            probeArgs(args)
          )
            reject(new ResourceProbeReadRace(probeOrigin, args));
          else if (error) reject(error);
          else resolve(stdout);
        }
      );
      if (input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(input);
      }
    });
  }
  async removeCreatedSource(name: string, containerId: string, requireCurrent: () => void): Promise<void> {
    if (!/^reverie-boxed-source-[a-f0-9]{64}$/.test(name) || !/^[a-f0-9]{64}$/.test(containerId))
      throw Error('Fixed reprovision source required');
    requireCurrent();
    const rows = JSON.parse(await this.run(['container', 'inspect', containerId])) as unknown;
    const row = Array.isArray(rows) && rows.length === 1 ? (rows[0] as Record<string, unknown> | null) : null;
    const state = row?.State as Record<string, unknown> | undefined;
    // Only the exact named container, and only before its first START.
    if (
      row?.Id !== containerId ||
      row.Name !== '/' + name ||
      state?.Status !== 'created' ||
      state.Running !== false ||
      state.Pid !== 0
    )
      throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_SOURCE_NOT_REMOVABLE');
    requireCurrent();
    await this.run(['container', 'rm', containerId]);
  }
  /** The broker's ordinary image preparation: the worker image's own fixed
   * helper additively imports that image's registered closure into one
   * employee's private Nix store. Networkless, read-only root, no capabilities,
   * and only that store is writable. A prior helper under the same name is
   * settled by observation, never rerun over an unknown outcome. */
  async prepareWorkerStore(
    name: string,
    spec: Readonly<{ imageId: string; user: string; nixSource: string }>,
    requireCurrent: () => void
  ): Promise<void> {
    if (
      !/^reverie-boxed-nix-prepare-[a-f0-9]{32}$/.test(name) ||
      !/^sha256:[a-f0-9]{64}$/.test(spec.imageId) ||
      !/^[0-9]{1,9}:[0-9]{1,9}$/.test(spec.user) ||
      !spec.nixSource.startsWith('/') ||
      /[\0\r\n,]/.test(spec.nixSource) ||
      spec.nixSource.split('/').includes('..')
    )
      throw Error('Fixed worker store preparation required');
    const unconfirmed = (): never => {
      throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_STORE_PREPARATION_UNCONFIRMED');
    };
    const state = async (id: string) => {
      const rows = JSON.parse(await this.run(['container', 'inspect', id])) as unknown;
      const row = Array.isArray(rows) && rows.length === 1 ? (rows[0] as Record<string, unknown> | null) : null;
      const value = row?.State as Record<string, unknown> | undefined;
      const labels = (row?.Config as { Labels?: Record<string, string> } | undefined)?.Labels;
      if (row?.Id !== id || row.Name !== '/' + name || row.Image !== spec.imageId || !value) return unconfirmed();
      if (labels?.['org.reverie.purpose'] !== 'boxed-nix-prepare-v1') return unconfirmed();
      return value;
    };
    requireCurrent();
    const listed = (
      await this.run([
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        'name=^/' + name + '$',
        '--format',
        '{{.ID}}',
      ])
    )
      .split('\n')
      .filter((line) => line !== '');
    if (listed.length > 1 || listed.some((id) => !/^[a-f0-9]{64}$/.test(id))) unconfirmed();
    let id = listed[0];
    if (!id) {
      requireCurrent();
      id = await this.create(
        name,
        {
          Image: spec.imageId,
          User: spec.user,
          Entrypoint: ['/bin/reverie-nix-store-prepare'],
          Cmd: [],
          Env: ['HOME=/tmp/nix-bootstrap-home', 'TMPDIR=/tmp'],
          Labels: { 'org.reverie.purpose': 'boxed-nix-prepare-v1' },
          NetworkDisabled: true,
          HostConfig: {
            Init: true,
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            NetworkMode: 'none',
            Memory: 512 * 1024 * 1024,
            MemorySwap: 512 * 1024 * 1024,
            PidsLimit: 128,
            NanoCpus: 1_000_000_000,
            Tmpfs: {
              '/tmp': 'rw,nosuid,nodev,size=268435456,mode=1777',
              '/nix/store/.links': 'rw,nosuid,nodev,size=1048576,mode=1777',
            },
            Mounts: [{ Type: 'bind', Source: spec.nixSource, Target: '/target/nix' }],
          },
        },
        requireCurrent
      );
    }
    let value = await state(id);
    if (value.Status === 'created') {
      requireCurrent();
      await this.run(['container', 'start', id]);
      value = await state(id);
    }
    // The helper carries the original five-minute budget itself.
    const end = Date.now() + 330_000;
    while (value.Running === true || value.Status === 'running') {
      if (Date.now() >= end) unconfirmed();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      value = await state(id);
    }
    if (value.Status !== 'exited' || value.ExitCode !== 0 || value.OOMKilled === true) unconfirmed();
    await this.run(['container', 'rm', id]);
  }
  /** Removes one recorded laptop container that hosts no process beyond its
   * own init, never by force. The owning workflow separately proves that the
   * container is the employee's recorded one and that no provider ever ran. */
  async removeIdleLaptop(containerId: string, requireCurrent: () => void): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw Error('Fixed laptop container required');
    const notRemovable = (): never => {
      throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_LAPTOP_NOT_REMOVABLE');
    };
    const inspect = async () => {
      const rows = JSON.parse(await this.run(['container', 'inspect', containerId])) as unknown;
      const row = Array.isArray(rows) && rows.length === 1 ? (rows[0] as Record<string, unknown> | null) : null;
      const state = row?.State as Record<string, unknown> | undefined;
      if (row?.Id !== containerId || !state || !/^\/reverie-boxed-(?:source-)?[a-f0-9]{64}$/.test(String(row.Name)))
        return notRemovable();
      return state;
    };
    requireCurrent();
    let state = await inspect();
    if (state.Paused === true || state.Restarting === true) notRemovable();
    if (state.Running === true) {
      const rows = (await this.run(['container', 'top', containerId, '-eo', 'pid']))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      // A header and the container's own init; anything else is a live tenant.
      if (rows.length !== 2 || rows[0] !== 'PID' || rows[1] !== String(state.Pid)) notRemovable();
      requireCurrent();
      await this.run(['container', 'stop', '--time', '20', containerId]);
      state = await inspect();
    }
    if (state.Running !== false || !['exited', 'created'].includes(String(state.Status))) notRemovable();
    requireCurrent();
    await this.run(['container', 'rm', containerId]);
  }
  create(name: string, configuration: Readonly<Record<string, unknown>>, requireCurrent: () => void): Promise<string> {
    if (!/^reverie-boxed-(?:(?:storage|anchor|pool|leaf)-)?[a-z0-9-]{1,100}$/.test(name))
      throw Error('Fixed boxed destination name required');
    const body = Buffer.from(JSON.stringify(configuration));
    if (body.length > 1024 * 1024) throw Error('Boxed Docker configuration exceeds bound');
    requireCurrent();
    return new Promise((resolve, reject) => {
      let call: ClientRequest | undefined,
        settled = false,
        responseSeen = false;
      const deadline = setTimeout(() => unknown(), 30000);
      const rejectOnce = (error: unknown, destroy = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(error);
        if (destroy) call?.destroy();
      };
      // Transport errors and incomplete responses never retain their raw text.
      const unknown = () => rejectOnce(createFailure(), true);
      try {
        call = request(
          {
            socketPath: '/run/reverie-engine/docker.sock',
            method: 'POST',
            path: '/v1.45/containers/create?name=' + encodeURIComponent(name),
            headers: { 'content-type': 'application/json', 'content-length': body.length },
          },
          (response) => {
            responseSeen = true;
            const chunks: Buffer[] = [];
            let size = 0,
              ended = false;
            response.on('data', (chunk: Buffer) => {
              if (settled) return;
              if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 65536) {
                unknown();
                return;
              }
              chunks.push(chunk);
            });
            response.on('error', unknown);
            response.once('aborted', unknown);
            response.once('close', () => {
              if (!ended) unknown();
            });
            response.once('end', () => {
              ended = true;
              if (settled) return;
              if (response.complete !== true) {
                unknown();
                return;
              }
              if (response.statusCode !== 201) {
                rejectOnce(createFailure(response.statusCode));
                return;
              }
              let id: unknown;
              try {
                const bytes = Buffer.concat(chunks),
                  text = bytes.toString('utf8');
                if (!Buffer.from(text).equals(bytes)) throw Error('Invalid encoding');
                const value = JSON.parse(text) as { Id?: unknown } | null;
                id = value && !Array.isArray(value) ? value.Id : undefined;
                if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid identifier');
              } catch {
                unknown();
                return;
              }
              try {
                requireCurrent();
              } catch (cause) {
                rejectOnce(cause);
                return;
              }
              settled = true;
              clearTimeout(deadline);
              resolve(id as string);
            });
          }
        );
        call.on('error', unknown);
        call.once('close', () => {
          if (!responseSeen) unknown();
        });
        call.setTimeout(30000, unknown);
      } catch {
        unknown();
        return;
      }
      try {
        requireCurrent();
      } catch (cause) {
        rejectOnce(cause, true);
        return;
      }
      try {
        call.end(body);
      } catch {
        unknown();
      }
    });
  }
}
