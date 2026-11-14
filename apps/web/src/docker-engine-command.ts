/** Packaged controlplane-only Docker port. No HTTP-supplied endpoint or generic
 * command route. JSON creation avoids secret values in process argv.
 */
import { execFile } from 'node:child_process';
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
  run(args: readonly string[], input?: string): Promise<string>;
  create(name: string, configuration: Readonly<Record<string, unknown>>, requireCurrent: () => void): Promise<string>;
}
export class PackagedDockerEngineCommand implements DockerEngineCommand {
  constructor(private readonly endpoint = 'unix:///run/reverie-engine/docker.sock') {
    if (endpoint !== 'unix:///run/reverie-engine/docker.sock') throw Error('Fixed packaged Docker endpoint required');
  }
  run(args: readonly string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        '/bin/docker',
        ['--host', this.endpoint, ...args],
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        }
      );
      if (input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(input);
      }
    });
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
