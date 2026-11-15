/** Shared fixed contained identity-helper shape and inspection. Configuration
 * DATA is not an effect grant; callers retain their own one-attempt journal. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { DockerCredentialHome } from './docker-employee-credential-installer.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import { dockerPlanGeneration } from './docker-plan-install-data.js';
const cid = z.string().regex(/^[a-f0-9]{64}$/),
  decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export interface DockerPlanHelperAction {
  readonly projectionDigest: string;
  readonly payloadDigest: string;
  readonly attempt: string;
  readonly contextSource?: string;
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
export async function identityHelperConfiguration(
  command: DockerEngineCommand,
  row: DockerEmployeeContinuationRecord,
  home: DockerCredentialHome,
  boxId: string,
  plan?: DockerPlanHelperAction
): Promise<Record<string, unknown>> {
  const image = z
    .array(
      z.object({
        Id: z.literal(row.workerImage.imageId),
        Config: z.object({
          Env: z.array(z.string().max(16384)).max(256).nullable(),
          Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
      })
    )
    .length(1)
    .parse(JSON.parse(await command.run(['image', 'inspect', row.workerImage.imageId])))[0]!;
  if (image.Config.Volumes && Object.keys(image.Config.Volumes).length)
    refuse('DOCKER_IDENTITY_IMAGE_IMPLICIT_STORAGE_UNSUPPORTED');
  const inherited = image.Config.Env ?? [],
    keys = inherited.map((value) => value.split('=')[0]);
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) refuse('DOCKER_IDENTITY_IMAGE_ENV_UNKNOWN');
  if (plan) {
    if (
      row.version !== 3 ||
      !row.destination ||
      plan.attempt !== row.request.operationId ||
      plan.projectionDigest !== row.planReplacement.account.projectionDigest ||
      !/^[a-f0-9]{64}$/.test(plan.payloadDigest) ||
      (plan.contextSource !== undefined &&
        (!plan.contextSource.startsWith('/') ||
          plan.contextSource.length > 4096 ||
          /[\0\r\n]/.test(plan.contextSource) ||
          plan.contextSource.split('/').includes('..')))
    )
      refuse('DOCKER_PLAN_INSTALL_SCOPE_CHANGED');
  } else if (row.version === 3) refuse('DOCKER_PLAN_INSTALL_PROTOCOL_REQUIRED');
  const fixed = [
    'HOME=/home/agent',
    'REVERIE_SESSION_ID=' + row.request.sessionId,
    'REVERIE_WORKER_IDENTITY_FILE=' +
      (plan
        ? dockerPlanGeneration({
            operationId: row.request.operationId,
            containerId: row.destination!.containerId,
            projectionDigest: plan.projectionDigest,
            provider: row.version === 3 ? row.planReplacement.account.provider : 'anthropic',
          }).identityFile
        : '/home/agent/.reverie/docker-worker-identity'),
  ];
  const environment = [
    ...inherited.map((value) => fixed.find((item) => item.split('=')[0] === value.split('=')[0]) ?? value),
    ...fixed.filter((value) => !keys.includes(value.split('=')[0])),
  ];
  decimal.parse(home.dev);
  decimal.parse(home.ino);
  return {
    Image: row.workerImage.imageId,
    User: home.user,
    Entrypoint: ['/opt/reverie-worker-client/bin/reverie'],
    ...(plan ? { WorkingDir: '/', Healthcheck: { Test: ['NONE'] } } : {}),
    Cmd: plan
      ? [
          'worker-client',
          'plan-install',
          '--expected-digest',
          row.workerImage.clientManifestDigest,
          '--projection-digest',
          plan.projectionDigest,
          '--payload-digest',
          plan.payloadDigest,
          '--attempt',
          plan.attempt,
          '--home-dev',
          home.dev,
          '--home-ino',
          home.ino,
        ]
      : [
          'worker-client',
          'credential-install',
          '--expected-digest',
          row.workerImage.clientManifestDigest,
          '--home-dev',
          home.dev,
          '--home-ino',
          home.ino,
        ],
    Env: environment,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Labels: {
      'reverie.box.identity.operation': row.request.operationId,
      'reverie.box.identity.box': boxId,
      'reverie.box.identity.employee': row.employeeId,
    },
    HostConfig: {
      ...(plan ? { AutoRemove: false, PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '' } : {}),
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      PidsLimit: 32,
      Mounts: [
        ...(plan?.contextSource
          ? [
              {
                Type: 'bind',
                Source: plan.contextSource,
                Target: '/run/reverie-plan-context',
                ReadOnly: true,
                BindOptions: { Propagation: 'rprivate', NonRecursive: true },
              },
            ]
          : []),
        {
          Type: 'bind',
          Source: home.source,
          Target: '/home/agent',
          ReadOnly: false,
          BindOptions: { Propagation: 'rprivate' },
        },
      ],
    },
  };
}
export async function inspectIdentityHelper(
  command: DockerEngineCommand,
  id: string,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  cid.parse(id);
  const raw = z
    .array(z.record(z.string(), z.unknown()))
    .length(1)
    .parse(JSON.parse(await command.run(['container', 'inspect', id])))[0]!;
  if (raw.Id !== id || raw.Image !== config.Image) refuse('DOCKER_IDENTITY_HELPER_CHANGED');
  const actual = z.record(z.string(), z.unknown()).parse(raw.Config),
    host = z.record(z.string(), z.unknown()).parse(raw.HostConfig),
    wanted = config.HostConfig as Record<string, unknown>;
  for (const key of ['User', 'Entrypoint', 'Cmd', 'Env', 'OpenStdin', 'StdinOnce', 'Tty'])
    if (!isDeepStrictEqual(actual[key], config[key])) refuse('DOCKER_IDENTITY_HELPER_CHANGED');
  const labels = z.record(z.string(), z.string()).parse(actual.Labels);
  for (const [key, value] of Object.entries(config.Labels as Record<string, string>))
    if (labels[key] !== value) refuse('DOCKER_IDENTITY_HELPER_CHANGED');
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
    if (!isDeepStrictEqual(host[key], wanted[key])) refuse('DOCKER_IDENTITY_HELPER_SECURITY_CHANGED');
  for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'VolumesFrom'])
    if (host[key] !== null && host[key] !== undefined && !isDeepStrictEqual(host[key], []))
      refuse('DOCKER_IDENTITY_HELPER_SECURITY_CHANGED');
  if (
    host.PidMode === 'host' ||
    host.IpcMode === 'host' ||
    host.AutoRemove === true ||
    (!isDeepStrictEqual(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 }) &&
      !isDeepStrictEqual(host.RestartPolicy, { Name: 'no' }))
  )
    refuse('DOCKER_IDENTITY_HELPER_SECURITY_CHANGED');
  const wantedMounts = wanted.Mounts as Array<{ Source: string; Target: string; ReadOnly: boolean }>;
  const mounts = z
    .array(z.object({ Type: z.literal('bind'), Source: z.string(), Destination: z.string(), RW: z.boolean() }))
    .length(wantedMounts.length)
    .parse(raw.Mounts);
  if (
    new Set(mounts.map((m) => m.Destination)).size !== mounts.length ||
    wantedMounts.some(
      (w) => !mounts.some((m) => w.Source === m.Source && w.Target === m.Destination && m.RW === !w.ReadOnly)
    )
  )
    refuse('DOCKER_IDENTITY_HELPER_HOME_CHANGED');
  return raw;
}
