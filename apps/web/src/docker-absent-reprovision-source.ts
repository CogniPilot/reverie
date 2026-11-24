/** Pure definition of one inert replacement source laptop. The backend derives
 * the private HOME/Nix binds from its own retired record. The owner-approved
 * template supplies only the shared-drive layout. No Engine access here. */
import { posix } from 'node:path';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerEmployeeInspect } from './docker-employee-engine-data.js';
import { ephemeralProjection } from './docker-ephemeral-data.js';
import {
  DockerLaptopTemplate,
  DockerReprovisionAccount,
  REPROVISION_ACCOUNT_ROOT,
} from './docker-absent-reprovision-data.js';
import { dockerPlanGeneration } from './docker-plan-install-data.js';
import { subscriptionBinding, type SubscriptionProvider } from './subscription-profiles.js';
export const REPROVISION_OPERATION_LABEL = 'reverie.reprovision.operation';
export const REPROVISION_PURPOSE_LABEL = 'reverie.reprovision.purpose';
const WORKER_INIT = '/opt/reverie/perf/bin/reverie-worker-init';
const SECRET_ENV = /^REVERIE_(USERNAME|PASSWORD|HOOK_SECRET|SERVICE_TOKEN|RECOVERY_[A-Z_]+)=/;
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
export function reprovisionSourceName(boxId: string, operationId: string): string {
  return 'reverie-boxed-source-' + dockerContinuationDigest([boxId, 'reprovision-source', operationId]);
}
/** Same ASCII label rule as the legacy native launcher (employee_hostname). */
export function reprovisionHostname(name: string, employeeId: string): string {
  let label = '';
  for (const char of name.toLowerCase()) {
    if (/^[a-z0-9]$/.test(char)) label += char;
    else if (label && !label.endsWith('-')) label += '-';
  }
  label = label
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
  return (label || 'employee') + '-' + employeeId.slice(0, 8);
}
export interface ReprovisionStorage {
  readonly home: string;
  readonly nix: string;
  readonly scratch: string;
  readonly tmp: string;
}
function within(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/');
}
/** `<stateRoot>/employees/<employeeId>/home`, the shared `<stateRoot>/nix` and the ephemeral layout
 * `<scratchRoot>/employees/<employeeId>{,/tmp}` with a `laptops` scratch root. */
export function reprovisionStorage(
  row: DockerEmployeeContinuationRecord,
  unchecked: DockerLaptopTemplate
): ReprovisionStorage {
  const template = DockerLaptopTemplate.parse(unchecked),
    home = row.original.home;
  if (
    home.type !== 'bind' ||
    posix.normalize(home.source) !== home.source ||
    !home.source.endsWith('/' + row.employeeId + '/home')
  )
    refuse('DOCKER_REPROVISION_PRIVATE_HOME_UNSUPPORTED');
  const employeeRoot = posix.dirname(home.source);
  if (posix.basename(template.scratchRoot) !== 'laptops') refuse('DOCKER_REPROVISION_SCRATCH_LAYOUT_UNSUPPORTED');
  const scratch = posix.join(template.scratchRoot, 'employees', row.employeeId);
  // One Nix store is shared by every laptop: `<stateRoot>/nix`, beside the
  // `employees` directory. Nothing private lives in it, laptops do not collect
  // garbage in it, and it counts against no employee's disk budget.
  const employeesRoot = posix.dirname(employeeRoot);
  if (posix.basename(employeesRoot) !== 'employees') refuse('DOCKER_REPROVISION_PRIVATE_HOME_UNSUPPORTED');
  const nix = posix.join(posix.dirname(employeesRoot), 'nix');
  const storage = { home: home.source, nix, scratch, tmp: scratch + '/tmp' };
  const ephemeralRoot = posix.dirname(template.scratchRoot);
  if (
    within(nix, ephemeralRoot) ||
    within(ephemeralRoot, nix) ||
    template.mounts.some((mount) => within(mount.source, nix) || within(nix, mount.source))
  )
    refuse('DOCKER_REPROVISION_TEMPLATE_STORAGE_OVERLAP');
  for (const mount of template.mounts)
    if (
      within(mount.source, employeeRoot) ||
      within(employeeRoot, mount.source) ||
      within(mount.source, ephemeralRoot) ||
      within(ephemeralRoot, mount.source)
    )
      refuse('DOCKER_REPROVISION_TEMPLATE_STORAGE_OVERLAP');
  if (within(employeeRoot, ephemeralRoot) || within(ephemeralRoot, employeeRoot))
    refuse('DOCKER_REPROVISION_TEMPLATE_STORAGE_OVERLAP');
  return storage;
}
function bind(source: string, target: string, readOnly = false): Record<string, unknown> {
  return {
    Type: 'bind',
    Source: source,
    Target: target,
    ...(readOnly ? { ReadOnly: true } : {}),
    BindOptions: { Propagation: 'rprivate' },
  };
}
function attachments(target: string): Record<string, unknown> {
  return { Type: 'tmpfs', Target: target, ReadOnly: true, TmpfsOptions: { SizeBytes: 1048576, Mode: 0o555 } };
}
function temporaryEnvironment(): string[] {
  const root = '/tmp/reverie';
  return [
    'TMPDIR=/tmp',
    'TMP=/tmp',
    'TEMP=/tmp',
    `XDG_CACHE_HOME=${root}/cache`,
    `PIP_CACHE_DIR=${root}/cache/pip`,
    `UV_CACHE_DIR=${root}/cache/uv`,
    `npm_config_cache=${root}/cache/npm`,
    `CCACHE_DIR=${root}/cache/ccache`,
    `GOCACHE=${root}/cache/go-build`,
    `GOMODCACHE=${root}/cache/go-mod`,
    `XDG_DOWNLOAD_DIR=${root}/downloads`,
  ];
}
export interface ReprovisionSourceInput {
  readonly row: DockerEmployeeContinuationRecord;
  /** The session the source is made for: the employee's current one. `row` is the first record every later source
   * derives from, and a plan move replaces the session after it was written, so the two differ for any employee who
   * has changed plan. A source labelled with the record's session is refused by the proof that follows its creation
   * (`boxedOriginal` reads the label against the current session), which left such a rebuild held for good with the
   * old laptop already discarded. Absent only on a caller that has no session of its own: the record's. */
  readonly sessionId?: string;
  readonly template: DockerLaptopTemplate;
  readonly operationId: string;
  readonly deployment: string;
  readonly employeeName: string;
  readonly imageId: string;
  /** Exactly the image's own PATH entry. */
  readonly imagePath: string;
  readonly network: string;
  readonly apiUrl: string;
  /** Derived by `reprovisionAccount`; absent on entries that predate routing. */
  readonly account?: DockerReprovisionAccount;
}
/** The employee's owner-selected plan and the mode its saved session launches. */
export interface ReprovisionProfile {
  readonly id: string;
  readonly provider: SubscriptionProvider;
  readonly mode: string;
}
/** Default host folder of one seat, inside the employee's private home. The
 * workflow makes this one itself; an owner-named `accountSource` is not made. */
export function reprovisionSeatSource(home: string, profileId: string): string {
  return posix.join(home, '.reverie', 'seat-auth', profileId);
}
/** Provider account routing of the source, derived by the backend only.
 * (a) A retired plan replacement keeps its in-home account generation as one
 * Env entry. (b) A saved launch override that selects the employee's own
 * subscription seat gets that seat as one read-write bind; the launch itself
 * supplies the variable. (c) Without any override of that variable, the
 * employee's subscription profile is the owner's choice: when its provider
 * binds natively to the session mode, the same seat is bound and the source
 * carries the variable itself. (d) Otherwise nothing. */
export function reprovisionAccount(
  basis: DockerEmployeeContinuationRecord,
  profile: ReprovisionProfile | undefined,
  overrides: Readonly<Record<string, string>> | undefined,
  unchecked: DockerLaptopTemplate
): DockerReprovisionAccount {
  const template = DockerLaptopTemplate.parse(unchecked);
  const done = (account: DockerReprovisionAccount) => {
    if (template.accountSource !== undefined && account.kind !== 'seat-mount')
      refuse('DOCKER_REPROVISION_ACCOUNT_SOURCE_UNUSED');
    return DockerReprovisionAccount.parse(account);
  };
  if (basis.version === 3) {
    const selected = basis.planReplacement.account;
    return done({
      kind: 'generation-env',
      key: selected.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: dockerPlanGeneration({
        operationId: basis.request.operationId,
        projectionDigest: selected.projectionDigest,
        provider: selected.provider,
        containerId: basis.original.containerId,
      }).configDir,
    });
  }
  const seats = (['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const).flatMap((key) => {
    const path = overrides?.[key];
    return typeof path === 'string' && path.startsWith(REPROVISION_ACCOUNT_ROOT) ? [{ key, path }] : [];
  });
  // An explicit override of the profile's own variable that names no seat
  // (an alternate directory inside the home) stays the launch's choice.
  const derivedKey =
    profile && subscriptionBinding(profile.mode, profile.provider) === 'native'
      ? profile.provider === 'anthropic'
        ? ('CLAUDE_CONFIG_DIR' as const)
        : ('CODEX_HOME' as const)
      : undefined;
  const derived = !seats.length && derivedKey !== undefined && typeof overrides?.[derivedKey] !== 'string';
  if (!seats.length && !derived) return done({ kind: 'none' });
  const seat = derived ? { key: derivedKey!, path: REPROVISION_ACCOUNT_ROOT + profile!.id } : seats[0]!,
    id = seat.path.slice(REPROVISION_ACCOUNT_ROOT.length);
  if (seats.length > 1 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || id !== profile?.id)
    refuse('DOCKER_REPROVISION_ACCOUNT_PROFILE_MISMATCH');
  const storage = reprovisionStorage(basis, template),
    source = template.accountSource ?? reprovisionSeatSource(storage.home, id);
  if (posix.basename(source) !== id) refuse('DOCKER_REPROVISION_ACCOUNT_SOURCE_MISMATCH');
  const ephemeralRoot = posix.dirname(template.scratchRoot);
  if (
    within(source, ephemeralRoot) ||
    within(ephemeralRoot, source) ||
    within(storage.home, source) ||
    within(storage.nix, source) ||
    within(source, storage.nix) ||
    template.mounts.some((mount) => !mount.readOnly && (within(source, mount.source) || within(mount.source, source)))
  )
    refuse('DOCKER_REPROVISION_TEMPLATE_STORAGE_OVERLAP');
  return done({ kind: 'seat-mount', key: seat.key, path: seat.path, source, ...(derived ? { env: true } : {}) });
}
/** Never started by this workflow: inert init, no command, no secret, no
 * Engine socket, no device request. The destination adds its own GPU profile. */
export function reprovisionSourceConfiguration(input: ReprovisionSourceInput): Record<string, unknown> {
  const template = DockerLaptopTemplate.parse(input.template),
    storage = reprovisionStorage(input.row, template);
  if (!/^PATH=[^\r\n\0]{1,8192}$/.test(input.imagePath)) refuse('DOCKER_REPROVISION_SOURCE_IMAGE_PATH_UNKNOWN');
  const mounts = [
    bind(storage.home, '/home/agent'),
    bind(storage.nix, '/nix'),
    bind(storage.tmp, '/tmp'),
    bind(storage.scratch, '/scratch'),
    ...template.mounts.map((mount) => bind(mount.source, mount.destination, mount.readOnly)),
  ];
  const account = DockerReprovisionAccount.parse(input.account ?? { kind: 'none' });
  // The single writable path under the accounts root; a template mount cannot name one.
  if (account.kind === 'seat-mount') mounts.push(bind(account.source, account.path));
  const workspace = template.mounts.find((mount) => mount.destination === '/reverie_workspace');
  if (template.workspaceAlias && workspace) mounts.push(bind(workspace.source, '/workspace', workspace.readOnly));
  if (workspace) mounts.push(attachments('/reverie_workspace/attachments'));
  if (template.workspaceAlias && workspace) mounts.push(attachments('/workspace/attachments'));
  const environment = [
    input.imagePath,
    'HOME=/home/agent',
    'REVERIE_WORKER=1',
    'REVERIE_INSTALL_CLIS=none',
    ...temporaryEnvironment(),
    'REVERIE_API_URL=' + input.apiUrl,
    ...(account.kind === 'generation-env' || (account.kind === 'seat-mount' && account.env)
      ? [account.key + '=' + account.path]
      : []),
  ];
  if (environment.some((value) => SECRET_ENV.test(value))) refuse('DOCKER_REPROVISION_SECRET_ENV_DENIED');
  return {
    Image: input.imageId,
    User: template.user,
    Entrypoint: [WORKER_INIT],
    Cmd: [],
    Env: environment,
    Hostname: reprovisionHostname(input.employeeName, input.row.employeeId),
    Labels: {
      'reverie.worker': input.deployment,
      'reverie.employee': input.row.employeeId,
      'reverie.session': input.sessionId ?? input.row.request.sessionId,
      'reverie.storage': 'employee:' + input.row.employeeId,
      [REPROVISION_PURPOSE_LABEL]: 'absent-laptop-source-v1',
      [REPROVISION_OPERATION_LABEL]: input.operationId,
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      Init: false,
      AutoRemove: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: 'no' },
      NetworkMode: input.network,
      Tmpfs: { '/run': 'rw,nosuid,nodev,size=16777216' },
      Mounts: mounts,
    },
  };
}
/** The planned binds must select the ephemeral layout the restoration expects. */
export function requireReprovisionEphemeralLayout(input: ReprovisionSourceInput): void {
  const configuration = reprovisionSourceConfiguration(input);
  const mounts = (configuration.HostConfig as { Mounts: Array<Record<string, unknown>> }).Mounts;
  const synthetic = DockerEmployeeInspect.parse({
    Id: '0'.repeat(64),
    Image: input.imageId,
    State: { Running: false, Paused: false, Restarting: false, Dead: false },
    Config: { User: input.template.user, Entrypoint: [WORKER_INIT], Env: [], Labels: {} },
    Mounts: mounts.map((mount) => ({
      Type: mount.Type,
      Source: mount.Type === 'bind' ? mount.Source : '',
      Destination: mount.Target,
      RW: mount.ReadOnly !== true,
    })),
    HostConfig: {},
  });
  const projection = ephemeralProjection(
    synthetic,
    input.row.employeeId,
    input.sessionId ?? input.row.request.sessionId
  );
  if (!projection || projection.layout !== 'employees' || projection.identity !== input.row.employeeId)
    refuse('DOCKER_REPROVISION_SCRATCH_LAYOUT_UNSUPPORTED');
}
/** The Engine merges image defaults into Env. Everything this workflow chose
 * must be present exactly; nothing the continuation later refuses may appear. */
export function requireReprovisionSource(
  raw: DockerEmployeeInspect,
  name: string,
  configuration: Record<string, unknown>
): void {
  const host = configuration.HostConfig as Record<string, unknown>,
    labels = configuration.Labels as Record<string, string>,
    environment = configuration.Env as string[],
    wanted = host.Mounts as Array<Record<string, unknown>>;
  const state = raw.State as { Status?: unknown; Pid?: unknown };
  const binds = wanted.filter((mount) => mount.Type === 'bind');
  if (
    (raw as { Name?: unknown }).Name !== '/' + name ||
    raw.Image !== configuration.Image ||
    raw.State.Running ||
    state.Status !== 'created' ||
    state.Pid !== 0 ||
    raw.Config.User !== configuration.User ||
    JSON.stringify(raw.Config.Entrypoint) !== JSON.stringify(configuration.Entrypoint) ||
    (raw.Config.Cmd?.length ?? 0) !== 0 ||
    Object.entries(labels).some(([key, value]) => raw.Config.Labels?.[key] !== value) ||
    environment.some((value) => !raw.Config.Env.includes(value)) ||
    raw.Config.Env.some((value) => SECRET_ENV.test(value)) ||
    raw.Config.Env.filter((value) => value.startsWith('PATH=')).length !== 1 ||
    raw.Config.Env.filter((value) => value.startsWith('HOME=')).length !== 1 ||
    raw.HostConfig.Privileged !== false ||
    raw.HostConfig.ReadonlyRootfs !== true ||
    raw.HostConfig.NetworkMode !== host.NetworkMode ||
    JSON.stringify(raw.HostConfig.CapDrop) !== JSON.stringify(host.CapDrop) ||
    JSON.stringify(raw.HostConfig.SecurityOpt) !== JSON.stringify(host.SecurityOpt) ||
    (raw.HostConfig.DeviceRequests ?? null) !== null ||
    JSON.stringify(raw.HostConfig.Mounts) !== JSON.stringify(host.Mounts) ||
    raw.Mounts.filter((mount) => mount.Type !== 'tmpfs').length !== binds.length ||
    binds.some(
      (expected) =>
        !raw.Mounts.some(
          (mount) =>
            mount.Type === 'bind' &&
            mount.Source === expected.Source &&
            mount.Destination === expected.Target &&
            mount.RW === (expected.ReadOnly !== true)
        )
    )
  )
    refuse('DOCKER_REPROVISION_SOURCE_CHANGED');
}
