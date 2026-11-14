/** Packaged controlplane-only Docker port. No HTTP-supplied endpoint or generic
 * command route. JSON creation avoids secret values in process argv.
 */
import { execFile } from 'node:child_process';
import { request } from 'node:http';
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
      const call = request(
        {
          socketPath: '/run/reverie-engine/docker.sock',
          method: 'POST',
          path: '/v1.45/containers/create?name=' + encodeURIComponent(name),
          headers: { 'content-type': 'application/json', 'content-length': body.length },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65536) {
              call.destroy(Error('Docker create reply exceeds bound'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            if (response.statusCode !== 201) {
              reject(Error('Docker destination creation unconfirmed'));
              return;
            }
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Id?: unknown };
              if (typeof value.Id !== 'string' || !/^([a-f0-9]{64})$/.test(value.Id))
                throw Error('Docker create reply invalid');
              resolve(value.Id);
            } catch (cause) {
              reject(cause);
            }
          });
        }
      );
      call.setTimeout(30000, () => call.destroy(Error('Docker create reply deadline')));
      call.once('error', reject);
      try {
        requireCurrent();
        call.end(body);
      } catch (cause) {
        call.destroy();
        reject(cause);
      }
    });
  }
}
