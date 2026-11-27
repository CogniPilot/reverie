/** Shared immutable configuration and read-only inspection. These DATA checks
 * supply no launch, kernel-write or current-worker authority. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerContinuationTaskRole } from './docker-continuation-task.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
export type DockerResourceHelperConfiguration = Readonly<Record<string, unknown>>;
const cid = z.string().regex(/^[a-f0-9]{64}$/);
function refuse(code = 'DOCKER_RESOURCE_REVISION_CHANGED'): never {
  throw new DockerEmployeeContinuationError(code);
}
export function dockerResourceHelperConfiguration(
  boxId: string,
  role: DockerContinuationTaskRole,
  name: string,
  args: readonly string[],
  writable: { path: string; target: string } | undefined,
  imageId: string
): DockerResourceHelperConfiguration {
  const binds = ['/proc:/proc:ro', '/sys/fs/cgroup:/sys/fs/cgroup:ro'];
  if (writable) binds.push(`/sys/fs/cgroup${writable.path}:${writable.target}:rw`);
  return {
    Image: imageId,
    User: '0:0',
    Entrypoint: ['/bin/reverie-docker-resources'],
    Cmd: [...args],
    Env: [],
    WorkingDir: '/',
    Labels: {
      'org.reverie.purpose': 'boxed-resource-helper-v1',
      'reverie.box.resource.box': boxId,
      'reverie.box.resource.role': role,
      'reverie.box.resource.name': name,
      ...(args[0] === 'configure-memory-high' ? { 'org.reverie.resource.memory-high-only': 'v1' } : {}),
      ...(args[0] === 'restore-pool' ? { 'org.reverie.resource.pool-restore': 'v1' } : {}),
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      // Docker adds this exact label option for a host PID namespace. Keep
      // it explicit so the immutable configuration comparison stays exact.
      SecurityOpt: ['no-new-privileges:true', 'label=disable'],
      NetworkMode: 'none',
      PidMode: 'host',
      CgroupnsMode: 'host',
      Binds: binds,
      AutoRemove: false,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      Memory: 64 * 1024 ** 2,
      MemorySwap: 64 * 1024 ** 2,
      PidsLimit: 32,
      CgroupParent: role === 'anchor' ? `reverie-box-${boxId}.slice` : '',
    },
  };
}

export async function inspectDockerResourceContainer(
  command: Pick<DockerEngineCommand, 'run'>,
  id: string
): Promise<Record<string, unknown>> {
  cid.parse(id);
  const rows = z
    .array(z.record(z.string(), z.unknown()))
    .length(1)
    .parse(JSON.parse(await command.run(['container', 'inspect', id])));
  if (rows[0]!.Id !== id) refuse('DOCKER_RESOURCE_CONTAINER_CHANGED');
  return rows[0]!;
}

export function requireDockerResourceHelperConfiguration(
  raw: Record<string, unknown>,
  desired: DockerResourceHelperConfiguration
): void {
  const config = z.record(z.string(), z.unknown()).parse(raw.Config),
    host = z.record(z.string(), z.unknown()).parse(raw.HostConfig);
  const expected = desired.HostConfig as Record<string, unknown>;
  for (const key of ['Image']) if (raw[key] !== desired[key]) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
  for (const key of ['User', 'Entrypoint', 'Cmd', 'Labels', 'WorkingDir'])
    if (!isDeepStrictEqual(config[key], desired[key])) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
  if (config.Env !== null && !isDeepStrictEqual(config.Env, [])) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
  for (const key of [
    'Privileged',
    'ReadonlyRootfs',
    'CapDrop',
    'SecurityOpt',
    'NetworkMode',
    'PidMode',
    'CgroupnsMode',
    'Binds',
    'AutoRemove',
    'Memory',
    'MemorySwap',
    'PidsLimit',
    'RestartPolicy',
    'CgroupParent',
  ])
    if (!isDeepStrictEqual(host[key], expected[key])) refuse('DOCKER_RESOURCE_HELPER_CHANGED');
  for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'Mounts', 'VolumesFrom'])
    if (host[key] !== null && host[key] !== undefined && !isDeepStrictEqual(host[key], []))
      refuse('DOCKER_RESOURCE_HELPER_PRIVILEGES_CHANGED');
  const mounts = z
    .array(
      z.object({
        Type: z.literal('bind'),
        Source: z.string(),
        Destination: z.string(),
        RW: z.boolean(),
      })
    )
    .parse(raw.Mounts);
  const expectedMounts = (expected.Binds as string[]).map((value) => {
    const [Source, Destination, mode] = value.split(':');
    return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
  });
  const ordered = (values: typeof expectedMounts) =>
    [...values].sort((a, b) => a.Destination!.localeCompare(b.Destination!));
  if (!isDeepStrictEqual(ordered(mounts), ordered(expectedMounts))) refuse('DOCKER_RESOURCE_HELPER_MOUNTS_CHANGED');
}

export async function requireDockerMemoryHighHelperImage(
  command: Pick<DockerEngineCommand, 'run'>,
  selected: string,
  current: () => void
): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(selected)) refuse();
  current();
  const raw = z
    .array(
      z.object({
        Id: z.string(),
        Config: z.object({
          User: z.string(),
          Entrypoint: z.array(z.string()),
          Labels: z.record(z.string(), z.string()),
        }),
      })
    )
    .length(1)
    .parse(JSON.parse(await command.run(['image', 'inspect', selected])))[0]!;
  current();
  // This is an additional deny-only check on the operator-qualified immutable image pin.
  // Neither a request-provided label nor the old configure-high mode can substitute.
  if (
    raw.Id !== selected ||
    raw.Config.User !== '0:0' ||
    !isDeepStrictEqual(raw.Config.Entrypoint, ['/bin/reverie-docker-resources']) ||
    raw.Config.Labels['org.reverie.purpose'] !== 'boxed-resource-helper-v1' ||
    raw.Config.Labels['org.reverie.resource.memory-high-only'] !== 'v1'
  )
    refuse('DOCKER_RESOURCE_MEMORY_HIGH_WRITE_UNSUPPORTED');
}

/** Deny-only qualification of the separately operator-pinned image for new
 * `configure-high` leaf writers. A created container inherits its image's
 * labels, and the fixed leaf writer configuration carries the purpose label
 * alone, so an image built for another writer cannot be selected here. */
export async function requireDockerLeafWriterHelperImage(
  command: Pick<DockerEngineCommand, 'run'>,
  selected: string,
  current: () => void
): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(selected)) refuse();
  current();
  let inspected: unknown;
  try {
    inspected = JSON.parse(await command.run(['image', 'inspect', selected]));
  } catch {
    // The Engine's own text is not kept. An image that cannot be read is not selected.
    return refuse('DOCKER_RESOURCE_LEAF_WRITER_IMAGE_UNAVAILABLE');
  }
  current();
  const raw = z
    .array(
      z.object({
        Id: z.string(),
        Config: z.object({
          User: z.string(),
          Entrypoint: z.array(z.string()),
          Labels: z.record(z.string(), z.string()),
        }),
      })
    )
    .length(1)
    .safeParse(inspected);
  if (
    !raw.success ||
    raw.data[0]!.Id !== selected ||
    raw.data[0]!.Config.User !== '0:0' ||
    !isDeepStrictEqual(raw.data[0]!.Config.Entrypoint, ['/bin/reverie-docker-resources']) ||
    !isDeepStrictEqual(raw.data[0]!.Config.Labels, { 'org.reverie.purpose': 'boxed-resource-helper-v1' })
  )
    refuse('DOCKER_RESOURCE_LEAF_WRITER_IMAGE_UNAVAILABLE');
}

/** Deny-only qualification of the separately operator-pinned restore image. */
export async function requireDockerPoolRestoreHelperImage(
  command: Pick<DockerEngineCommand, 'run'>,
  selected: string,
  current: () => void
): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(selected)) refuse();
  current();
  const raw = z
    .array(
      z.object({
        Id: z.string(),
        Config: z.object({
          User: z.string(),
          Entrypoint: z.array(z.string()),
          Labels: z.record(z.string(), z.string()),
        }),
      })
    )
    .length(1)
    .parse(JSON.parse(await command.run(['image', 'inspect', selected])))[0]!;
  current();
  if (
    raw.Id !== selected ||
    raw.Config.User !== '0:0' ||
    !isDeepStrictEqual(raw.Config.Entrypoint, ['/bin/reverie-docker-resources']) ||
    raw.Config.Labels['org.reverie.purpose'] !== 'boxed-resource-helper-v1' ||
    raw.Config.Labels['org.reverie.resource.pool-restore'] !== 'v1'
  )
    refuse('DOCKER_RESOURCE_POOL_RESTORE_UNSUPPORTED');
}
