/** Resolve Docker's context precedence once, then pin every call to a Unix endpoint. */
import { posix } from 'node:path';
export interface PinnedUnixDocker {
  args(args: readonly string[]): string[];
  readonly environment: NodeJS.ProcessEnv;
}
export function dockerContextArguments(environment: NodeJS.ProcessEnv): string[] | undefined {
  if (environment.REVERIE_OPERATOR_DOCKER_HOST) return undefined;
  if (environment.DOCKER_CONTEXT)
    return ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}', '--', environment.DOCKER_CONTEXT];
  return environment.DOCKER_HOST ? undefined : ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'];
}
export function pinnedUnixDocker(
  environment: NodeJS.ProcessEnv,
  context: (args: string[]) => string
): PinnedUnixDocker {
  let endpoint: unknown = environment.REVERIE_OPERATOR_DOCKER_HOST;
  if (!endpoint) {
    const query = dockerContextArguments(environment);
    endpoint = query ? JSON.parse(context(query)) : environment.DOCKER_HOST;
  }
  if (typeof endpoint !== 'string' || !/^unix:\/\/(\/[A-Za-z0-9_./-]+)$/.test(endpoint))
    throw new Error('A fixed local Unix Docker endpoint is required');
  const path = endpoint.slice('unix://'.length);
  if (posix.normalize(path) !== path || Buffer.byteLength(path) > 107)
    throw new Error('Canonical local Unix Docker endpoint required');
  const selected = endpoint;
  const env: NodeJS.ProcessEnv = { ...environment, DOCKER_HOST: selected, REVERIE_OPERATOR_DOCKER_HOST: selected };
  delete env.DOCKER_CONTEXT;
  return Object.freeze({
    args: (args: readonly string[]) => ['--host', selected, ...args],
    environment: Object.freeze(env),
  });
}
