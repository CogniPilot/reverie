/** Bounded actual Engine data and explicit new boxed projection. */
import { z } from 'zod';
import {
  dockerContinuationDigest,
  DockerEmployeeContinuationError,
  type DockerContinuationSubject,
} from './docker-employee-continuation.js';
import { DockerEmployeeOriginal } from './docker-employee-continuation-data.js';
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') && !/[\r\n\0]/.test(value) && !value.split('/').includes('..'));
const mount = z
  .object({
    Type: z.enum(['bind', 'volume', 'tmpfs']),
    Source: z.string().max(4096).default(''),
    Destination: path,
    RW: z.boolean(),
    Name: z.string().max(200).optional(),
    Mode: z.string().max(200).optional(),
    Propagation: z.string().max(100).optional(),
  })
  .passthrough();
export const DockerEmployeeInspect = z
  .object({
    Id: z.string().regex(/^[a-f0-9]{64}$/),
    Image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    State: z
      .object({ Running: z.boolean(), Paused: z.boolean(), Restarting: z.boolean(), Dead: z.boolean() })
      .passthrough(),
    Config: z
      .object({
        User: z.string().regex(/^[0-9]{1,10}(:[0-9]{1,10})?$/),
        Entrypoint: z.array(z.string()).max(4).nullable(),
        Cmd: z.array(z.string()).max(4).nullable(),
        Env: z.array(z.string().max(16384)).max(256),
        Labels: z.record(z.string(), z.string()).nullable(),
        WorkingDir: z.string().max(4096).optional(),
        Hostname: z.string().max(100).optional(),
      })
      .passthrough(),
    Mounts: z.array(mount).max(128),
    HostConfig: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export type DockerEmployeeInspect = z.infer<typeof DockerEmployeeInspect>;
export function dockerEngineRefuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
/** Native-only office/telemetry transport is deliberately absent in a new boxed placement. */
export function boxedStorageMounts(row: DockerEmployeeInspect) {
  return row.Mounts.filter(
    (m) =>
      m.Type !== 'tmpfs' &&
      m.Destination !== '/run/reverie-office' &&
      m.Destination !== '/host-published' &&
      m.Destination !== '/instances/default/console/statusline-exporter.sh'
  )
    .map((m) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      readWrite: m.RW,
      name: m.Name ?? null,
      mode: m.Mode ?? '',
      propagation: m.Propagation ?? '',
    }))
    .sort((a, b) => a.destination.localeCompare(b.destination));
}
export function boxedOriginal(
  row: DockerEmployeeInspect,
  subject: DockerContinuationSubject,
  deployment: string,
  boxed = false
): DockerEmployeeOriginal {
  const labels = row.Config.Labels,
    prefix = boxed ? 'reverie.boxed.' : 'reverie.';
  if (
    labels?.[prefix + 'employee'] !== subject.employeeId ||
    labels[prefix + 'session'] !== subject.sessionId ||
    labels[boxed ? 'reverie.boxed.instance' : 'reverie.worker'] !== deployment
  )
    dockerEngineRefuse('DOCKER_CONTINUATION_CONTAINER_BINDING_CHANGED');
  const homes = row.Mounts.filter((m) => m.Destination === '/home/agent');
  if (
    homes.length !== 1 ||
    homes[0]!.RW !== true ||
    !['bind', 'volume'].includes(homes[0]!.Type) ||
    row.Config.Env.filter((value) => value.startsWith('HOME=')).join('') !== 'HOME=/home/agent'
  )
    dockerEngineRefuse('DOCKER_CONTINUATION_PRIVATE_HOME_REQUIRED');
  if (
    row.HostConfig.Privileged !== false ||
    row.Mounts.some((m) => m.Destination === '/var/run/docker.sock' || m.Destination.startsWith('/run/reverie-engine'))
  )
    dockerEngineRefuse('DOCKER_CONTINUATION_WORKER_ENGINE_ACCESS_DENIED');
  // Engine inspect enumerates mounts from a map; order is not mount identity.
  // Keep every field and refuse ambiguous destinations before canonical hashing.
  const mounts = [...row.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination));
  if (new Set(mounts.map((mount) => mount.Destination)).size !== mounts.length)
    dockerEngineRefuse('DOCKER_CONTINUATION_DUPLICATE_MOUNT_DESTINATION');
  const original = {
    containerId: row.Id,
    imageId: row.Image,
    deployment,
    employeeId: subject.employeeId,
    sessionId: subject.sessionId,
    home: { type: homes[0]!.Type, source: homes[0]!.Source, destination: '/home/agent', readWrite: true },
    mountDigest: dockerContinuationDigest(mounts),
    storageDigest: dockerContinuationDigest(boxedStorageMounts(row)),
    configurationDigest: dockerContinuationDigest({ config: row.Config, host: row.HostConfig, mounts }),
  };
  return DockerEmployeeOriginal.parse(original);
}
export function boxedMountConfiguration(row: DockerEmployeeInspect): Record<string, unknown>[] {
  const retained = boxedStorageMounts(row).map((m) => {
    if (m.type === 'volume' && !m.name) dockerEngineRefuse('DOCKER_CONTINUATION_VOLUME_IDENTITY_UNKNOWN');
    const mount: Record<string, unknown> = {
      Type: m.type,
      Source: m.type === 'volume' ? m.name : m.source,
      Target: m.destination,
      ReadOnly: !m.readWrite,
    };
    if (m.type === 'bind' && m.propagation) mount.BindOptions = { Propagation: m.propagation };
    return mount;
  });
  // The read-only attachment overlays are security boundaries, not durable
  // storage. Preserve their exact bounded tmpfs configuration in the new box.
  const originalMounts = Array.isArray(row.HostConfig.Mounts) ? row.HostConfig.Mounts : [];
  const tmpfs = z
    .array(
      z
        .object({
          Type: z.literal('tmpfs'),
          Target: z.enum(['/workspace/attachments', '/reverie_workspace/attachments']),
          ReadOnly: z.literal(true),
          TmpfsOptions: z
            .object({ SizeBytes: z.number().int().positive().max(16777216), Mode: z.number().int().min(0).max(511) })
            .strict(),
        })
        .strict()
    )
    .max(2)
    .parse(
      originalMounts.filter((item) => item && typeof item === 'object' && (item as { Type?: unknown }).Type === 'tmpfs')
    );
  return [...retained, ...tmpfs];
}
