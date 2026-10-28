// Owner-local standard launcher plumbing. No browser/service command endpoint.
import fs from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fail = message => { throw new Error(message); };
const need = (value, message) => { if (!value) fail(message); };
const canonical = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => canonical(a) === canonical(b);
const sha = value => createHash('sha256').update(value).digest('hex');
function safeMetadata(value) {
  let count = 0;
  function visit(item, depth) {
    need(++count <= 100000 && depth <= 64, 'H metadata structure exceeds bound');
    if (typeof item === 'number') need(Number.isSafeInteger(item), 'H metadata has an imprecise numeric fact');
    if (item && typeof item === 'object') for (const nested of Object.values(item)) visit(nested, depth + 1);
  }
  visit(value, 0);
}
const H = value => value === 'terminal' || value === 'resource-terminal';
export const hasTerminal = H;
export function terminalEngineSocket(installation) {
  const value = JSON.parse(privateFile(installation)), path = value.engine?.socket;
  need(typeof path === 'string' && isAbsolute(path) && !/[\x00-\x1f]/.test(path), 'H initial engine socket is invalid');
  return path;
}
export function assertImageProfile(image, description) {
  safeMetadata(image);
  const pair = description.profile.imageProvenance, info = fs.lstatSync(pair.path);
  need(info.isFile() && info.uid === 0 && !(info.mode & 0o222) && info.size <= 65536, 'H immutable image provenance custody refused');
  const raw = fs.readFileSync(pair.path); need(sha(raw) === pair.sha256, 'H immutable image provenance changed');
  const expected = JSON.parse(raw).imageSpec;
  for (const key of ['Config', 'RootFS', 'Architecture', 'Os']) need(same(image[key], expected[key]), 'H selected image differs from fixed profile; use reviewed update');
  const instant = value => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
    need(match && Number.isFinite(Date.parse(match[1] + match[3])), 'H image creation time is unknown');
    return BigInt(Date.parse(match[1] + match[3])) * 1000000n + BigInt((match[2] || '').padEnd(9, '0'));
  };
  need(instant(image.Created) === instant(expected.Created), 'H image creation differs');
}
export function registeredTerminal() {
  try { fs.lstatSync(join(homedir(), '.config/systemd/user/reverie-owner-terminal.service')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function privateFile(path, limit = 131072) {
  need(typeof path === 'string' && isAbsolute(path) && fs.realpathSync(path) === path, 'H installation/evidence path must be physical and absolute');
  const before = fs.lstatSync(path, { bigint: true });
  need(before.isFile() && before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n && before.nlink === 1n && before.size <= BigInt(limit), 'H private file custody refused');
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw;
  try {
    const held = fs.fstatSync(descriptor, { bigint: true });
    need(held.dev === before.dev && held.ino === before.ino, 'H private file changed');
    raw = fs.readFileSync(descriptor); need(raw.length <= limit, 'H private file exceeds bound');
  } finally { fs.closeSync(descriptor); }
  const after = fs.lstatSync(path, { bigint: true });
  need(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs, 'H private file changed');
  return raw;
}
function run(program, args, fd) {
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  if (fd !== undefined) options.stdio = ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', fd];
  const result = spawnSync(program, args, options);
  need(!result.error && result.status === 0, 'H fixed tool failed: ' + (result.error?.message || result.stderr || program));
  return result.stdout;
}
function save(path, value) {
  const descriptor = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, canonical(value) + '\n'); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  const parent = fs.openSync(dirname(path), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function directory(path, existing = false) {
  if (!existing) {
    try { fs.mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  need(fs.realpathSync(path) === path, 'H operation directory must be physical');
  const info = fs.lstatSync(path);
  need(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700, 'H operation directory must be private');
}
function checkDescribedLock(description, fd, bound) {
  const path = description.lockPath, parent = fs.lstatSync(dirname(path), { bigint: true });
  need(fs.realpathSync(dirname(path)) === dirname(path) && parent.isDirectory() && parent.uid === BigInt(process.getuid()) &&
    (parent.mode & 0o777n) === 0o700n && String(parent.dev) === description.lockParentIdentity.device &&
    String(parent.ino) === description.lockParentIdentity.inode, 'H described maintenance parent changed');
  const named = fs.lstatSync(path, { bigint: true }), held = fs.fstatSync(fd, { bigint: true });
  need(named.isFile() && named.nlink === 1n && named.uid === BigInt(process.getuid()) && (named.mode & 0o777n) === 0o600n &&
    named.dev === held.dev && named.ino === held.ino && (description.lockIdentity === null ||
      description.lockIdentity && String(named.dev) === description.lockIdentity.device && String(named.ino) === description.lockIdentity.inode),
  'H described maintenance lock changed');
  const actual = { device: String(named.dev), inode: String(named.ino), parentDevice: String(parent.dev), parentInode: String(parent.ino) };
  need(bound === undefined || same(bound, actual), 'H bound maintenance OFD changed');
  return actual;
}

export class TerminalLifecycle {
  constructor({ repo, root, runtime, installation, oldRuntime = 'default', state }) {
    need(H(runtime) || H(oldRuntime) || registeredTerminal(), 'H lifecycle is not selected');
    const initialRaw = privateFile(installation), initial = JSON.parse(initialRaw);
    this.initialDigest = sha(initialRaw); this.engineSocket = initial.engine?.socket;
    this.installation = installation;
    this.repo = repo; this.runtime = runtime;
    const profile = H(runtime) ? runtime : H(oldRuntime) ? oldRuntime : 'terminal';
    const attribute = profile === 'terminal' ? 'ownerTerminalLifecycle' : 'resourceTerminalLifecycle';
    // Use the existing protected ledger BASE, not a website/project-mounted
    // runtime directory. H generation ledgers remain separate UUID children.
    need(typeof initial.ledgerBase === 'string' && isAbsolute(initial.ledgerBase), 'H protected ledger base is required');
    directory(initial.ledgerBase, true);
    const operations = join(initial.ledgerBase, 'standard-operations'); directory(operations);
    const packages = join(initial.ledgerBase, 'standard-packages'); directory(packages);
    this.operation = join(operations, randomUUID()); directory(this.operation);
    // A real --out-link is registered by Nix as a durable GC root. Never
    // overwrite/delete previous roots, including failed and rollback releases.
    const link = join(packages, this.operation.split('/').at(-1));
    const output = run('nix', ['build', repo + '#' + attribute, '--out-link', link, '--print-out-paths']).trim().split('\n').at(-1);
    need(isAbsolute(output) && fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(output), 'H lifecycle build did not produce its retained GC root');
    this.program = join(output, 'bin/reverie-owner-terminal-lifecycle');
    need(fs.statSync(this.program).isFile(), 'H lifecycle executable is missing');
    this.description = JSON.parse(run(this.program, ['--installation', installation, 'describe']));
    const d = this.description;
    need(d.version === 1 && d.purpose === 'reverie-owner-terminal-lifecycle-v1' && d.workerEffects === false &&
      d.lockPath === join(state, 'update.lock') && d.profile?.name === profile &&
      d.bootstrapMount?.Type === 'bind' && d.bootstrapMount.Target === '/run/reverie-owner-terminal' && d.bootstrapMount.ReadOnly === true &&
      isAbsolute(d.bootstrapMount.Source) && d.bootstrapMount.BindOptions?.CreateMountpoint === false,
    'H lifecycle describe does not match this fixed deployment');
    this.state = state;
    save(join(this.operation, 'DESCRIBE.json'), { packageRoot: output, gcRoot: link, descriptor: d });
    need(sha(privateFile(installation)) === this.initialDigest && this.initialDigest === d.installationSHA256,
      'H initial installation changed during describe');
  }
  acquire() {
    const d = this.description, parent = fs.lstatSync(dirname(d.lockPath), { bigint: true });
    need(parent.isDirectory() && String(parent.dev) === d.lockParentIdentity.device && String(parent.ino) === d.lockParentIdentity.inode &&
      parent.uid === BigInt(process.getuid()) && (parent.mode & 0o777n) === 0o700n, 'H maintenance parent changed');
    const fd = fs.openSync(d.lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      this.checkLock(fd);
      run('flock', ['--exclusive', '--timeout', '120', '9'], fd);
      this.checkLock(fd); this.fd = fd;
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  checkLock(fd) {
    this.boundLock = checkDescribedLock(this.description, fd, this.boundLock);
  }
  phase(phase, extra = [], fd = this.fd) {
    need(['settle', 'preflight-created', 'prepare-created', 'start-listener', 'await-ready'].includes(phase) && Number.isInteger(fd), 'H fixed phase or held descriptor missing');
    this.checkLock(fd); need(sha(privateFile(this.installation)) === this.initialDigest, 'H installation changed');
    save(join(this.operation, phase + '-ATTEMPT.json'), { phase, at: Date.now() });
    try {
      const result = JSON.parse(run(this.program, ['--installation', this.installation, '--lock-fd', '9', phase, ...extra], fd));
      this.checkLock(fd);
      save(join(this.operation, phase + '-RESULT.json'), result); return result;
    } catch (error) {
      save(join(this.operation, phase + '-UNKNOWN.json'), { phase, error: 'H_PHASE_UNCONFIRMED_NO_REPLAY', at: Date.now() }); throw error;
    }
  }
  prepare(container, image, intent) {
    save(join(this.operation, 'CREATED-READBACK.json'), container);
    save(join(this.operation, 'IMAGE-READBACK.json'), image);
    save(join(this.operation, 'GENERATED-INTENT.json'), intent);
    const spec = acceptedCreateSpec(container, image, intent);
    const path = join(this.operation, 'approved-created-spec.json'); save(path, spec);
    const specSHA256 = sha(privateFile(path, 8 << 20));
    const args = ['--container-id', container.Id, '--spec', path, '--spec-sha', specSHA256];
    const capacity = this.phase('preflight-created', args);
    need(same(Object.keys(capacity).sort(), ['containerId', 'specSHA256', 'state', 'version', 'workerEffects']) &&
      capacity.version === 1 && capacity.state === 'STOPPED_WEBSITE_CAPACITY_QUALIFIED' &&
      capacity.containerId === container.Id && capacity.specSHA256 === specSHA256 && capacity.workerEffects === false,
    'H stopped candidate has no native capacity qualification');
    return this.phase('prepare-created', args);
  }
  recordUnknown(action) {
    need(['start', 'restart', 'reuse'].includes(action), 'Unknown standard H operation');
    save(join(this.operation, 'STANDARD-UNKNOWN.json'), { action, state: 'UNKNOWN_RETAIN_DATA_NO_LEGACY_START_OR_ROLLBACK', at: Date.now() });
  }
  refreshResource() {
    if (this.runtime !== 'resource-terminal') return;
    need(sha(privateFile(this.installation)) === this.initialDigest, 'H installation changed');
    const initial = JSON.parse(privateFile(this.installation));
    const link = join(this.operation, 'resource-refresh-package');
    const output = run('nix', ['build', this.repo + '#resourceTerminalRefresh', '--out-link', link, '--print-out-paths']).trim().split('\n').at(-1);
    need(isAbsolute(output) && fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(output), 'Resource refresh has no retained package root');
    save(join(this.operation, 'resource-refresh-ATTEMPT.json'), { state: 'EXPLICIT_FACTS_REFRESH_ONLY', at: Date.now() });
    try {
      run(join(output, 'bin/reverie-resource-terminal-refresh'), ['--config', initial.workerConfig, '--resource-actor-engine-socket', initial.engine.socket], this.fd);
      save(join(this.operation, 'resource-refresh-RESULT.json'), { state: 'FACTS_REFRESHED_NO_ALLOCATION_OR_OWNER_GRANT' });
    } catch (error) {
      save(join(this.operation, 'resource-refresh-UNKNOWN.json'), { state: 'UNKNOWN_NO_BROKER_RESTART_OR_LEGACY_FALLBACK' }); throw error;
    }
  }
  close() { if (this.fd !== undefined) { const fd = this.fd; this.fd = undefined; fs.closeSync(fd); } }
}

export function checkSourceHost(container, port) {
  safeMetadata(container);
  const host = container.HostConfig;
  need(host && ['default', 'bridge'].includes(host.NetworkMode) && host.Init === true &&
    same(host.PortBindings, { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] }), 'H source networking/init differs from fixed launcher');
  supportedHostDefaults(host);
  need(Array.isArray(host.Mounts) && host.Mounts.every(defaultMountOptions), 'H source has unsupported mount construction');
}

function defaultMountOptions(mount) {
  if (!mount || typeof mount !== 'object' || Array.isArray(mount) || !['bind', 'volume'].includes(mount.Type) ||
      typeof mount.Source !== 'string' || typeof mount.Target !== 'string' || !isAbsolute(mount.Target) ||
      mount.ReadOnly !== undefined && typeof mount.ReadOnly !== 'boolean' ||
      Object.keys(mount).some(key => !['Type', 'Source', 'Target', 'ReadOnly', 'Consistency', 'BindOptions', 'VolumeOptions'].includes(key)) ||
      ![undefined, ''].includes(mount.Consistency)) return false;
  const bind = mount.BindOptions;
  if (bind !== undefined && bind !== null && (typeof bind !== 'object' || Array.isArray(bind) ||
      Object.keys(bind).some(key => !['Propagation', 'NonRecursive', 'CreateMountpoint', 'ReadOnlyNonRecursive', 'ReadOnlyForceRecursive'].includes(key)) ||
      !['rprivate', '', undefined].includes(bind.Propagation) || Object.entries(bind).some(([key, value]) => key !== 'Propagation' && value !== false))) return false;
  const volume = mount.VolumeOptions;
  return volume === undefined || volume === null || typeof volume === 'object' && !Array.isArray(volume) &&
    Object.keys(volume).every(key => ['NoCopy', 'Labels', 'Subpath', 'DriverConfig'].includes(key)) &&
    [undefined, false].includes(volume.NoCopy) && [undefined, ''].includes(volume.Subpath) &&
    [volume.Labels, volume.DriverConfig].every(value => value === undefined || value === null || typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
}

function supportedHostDefaults(host) {
  const explicit = new Set(['Memory', 'MemorySwap', 'PidsLimit', 'ReadonlyRootfs', 'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt', 'PidMode', 'IpcMode', 'Init', 'NetworkMode', 'PortBindings', 'Tmpfs', 'Mounts', 'Binds', 'LogConfig', 'RestartPolicy', 'MaskedPaths', 'ReadonlyPaths', 'ShmSize', 'Runtime', 'CgroupnsMode']);
  const defaultOnly = new Set(['AutoRemove', 'ContainerIDFile', 'VolumesFrom', 'ConsoleSize', 'UTSMode', 'Cgroup', 'CgroupParent', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'ExtraHosts', 'Links', 'Dns', 'DnsOptions', 'DnsSearch', 'GroupAdd', 'Sysctls', 'Ulimits', 'StorageOpt', 'VolumeDriver', 'OomKillDisable', 'OomScoreAdj', 'PublishAllPorts', 'CpuShares', 'NanoCpus', 'CpuPeriod', 'CpuQuota', 'CpuRealtimePeriod', 'CpuRealtimeRuntime', 'CpusetCpus', 'CpusetMems', 'CpuCount', 'CpuPercent', 'MemoryReservation', 'KernelMemory', 'KernelMemoryTCP', 'MemorySwappiness', 'BlkioWeight', 'BlkioWeightDevice', 'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps', 'IOMaximumIOps', 'IOMaximumBandwidth', 'Isolation', 'Annotations', 'MountLabel', 'SecurityLabelOpt']);
  const arrays = new Set(['VolumesFrom', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'ExtraHosts', 'Links', 'Dns', 'DnsOptions', 'DnsSearch', 'GroupAdd', 'Ulimits', 'BlkioWeightDevice', 'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps', 'SecurityLabelOpt']);
  const strings = new Set(['ContainerIDFile', 'UTSMode', 'Cgroup', 'CgroupParent', 'VolumeDriver', 'CpusetCpus', 'CpusetMems', 'Isolation', 'MountLabel']);
  const objects = new Set(['Sysctls', 'StorageOpt', 'Annotations']);
  const booleans = new Set(['AutoRemove', 'OomKillDisable', 'PublishAllPorts']);
  const noArray = value => value === undefined || value === null || Array.isArray(value) && value.length === 0;
  const noObject = value => value === undefined || value === null || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  function defaultValue(key, value) {
    if (value === undefined || value === null) return true;
    if (arrays.has(key)) return noArray(value);
    if (strings.has(key)) return value === '';
    if (objects.has(key)) return noObject(value);
    if (booleans.has(key)) return value === false;
    if (key === 'ConsoleSize') return same(value, [0, 0]);
    return typeof value === 'number' && value === 0;
  }
  for (const [key, value] of Object.entries(host)) need(explicit.has(key) || defaultOnly.has(key) && defaultValue(key, value), 'H unknown/nondefault host authority surface: ' + key);
  need(noArray(host.Binds) && ['runc', '', undefined].includes(host.Runtime) && ['private', '', undefined].includes(host.CgroupnsMode) &&
    (host.ShmSize === 67108864 || host.ShmSize === undefined) && host.LogConfig && ['json-file', 'local', 'journald'].includes(host.LogConfig.Type) && empty(host.LogConfig.Config) &&
    same(host.RestartPolicy, { Name: 'unless-stopped', MaximumRetryCount: 0 }), 'H host defaults differ');
  for (const key of ['MaskedPaths', 'ReadonlyPaths']) need(Array.isArray(host[key]) && host[key].every(path => typeof path === 'string' && path.startsWith('/') && path !== '/' && path !== '/nix' && !path.startsWith('/nix/')), 'H code visibility differs');
}

const empty = value => value === undefined || value === null || value === '' || value === false || value === 0 || Array.isArray(value) && !value.length || value && typeof value === 'object' && !Object.keys(value).length;
export function acceptedCreateSpec(container, image, intent) { return validateIntent(container, image, intent, true); }
export function checkRetainedIntent(container, image, intent) { validateIntent(container, image, intent, false); }
function validateIntent(container, image, intent, stopped) {
  safeMetadata(container); safeMetadata(image); safeMetadata(intent);
  need(container && image && intent && /^[a-f0-9]{64}$/.test(container.Id) && container.Image === image.Id &&
    (stopped ? container.State?.Running === false && container.State.Pid === 0 : typeof container.State?.Running === 'boolean') &&
    container.Name === '/' + intent.name, 'H created container identity/state differs');
  const cfg = container.Config, host = container.HostConfig;
  need(cfg && host && cfg.User === intent.user && cfg.WorkingDir === intent.workdir && same(cfg.Cmd, image.Config.Cmd) && same(cfg.Entrypoint, image.Config.Entrypoint), 'H fixed process differs');
  const environment = new Map();
  for (const value of [...(image.Config.Env || []), ...intent.environment]) {
    need(typeof value === 'string' && !value.includes('\0') && value.includes('='), 'H environment intent is malformed');
    environment.set(value.slice(0, value.indexOf('=')), value);
  }
  need(same(cfg.Env, [...environment.values()]) && same(cfg.Labels || {}, { ...(image.Config.Labels || {}), ...intent.labels }), 'H environment/labels differ from generated intent');
  need(Number.isSafeInteger(intent.memory) && intent.memory >= 512 * 1048576 && intent.swap === intent.memory &&
    Number.isSafeInteger(intent.pids) && intent.pids >= 64 && intent.pids <= 65536 &&
    host.Memory === intent.memory && host.MemorySwap === intent.swap && host.PidsLimit === intent.pids && host.ReadonlyRootfs === true &&
    host.Privileged === false && (host.CapAdd === null || same(host.CapAdd, [])) && same(host.CapDrop, ['ALL']) &&
    (same(host.SecurityOpt, ['no-new-privileges']) || same(host.SecurityOpt, ['no-new-privileges:true'])) &&
    host.PidMode === '' && host.IpcMode === 'private' && host.Init === true && ['default', 'bridge'].includes(host.NetworkMode), 'H resource/isolation intent differs');
  need(same(host.PortBindings, { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(intent.port) }] }), 'H port grants differ');
  const optionString = value => typeof value === 'string' ? value.split(',').sort().join(',') : null;
  need(host.Tmpfs && Object.keys(host.Tmpfs).length === 2 && Object.entries(intent.tmpfs).every(([path, options]) => optionString(host.Tmpfs[path]) === optionString(options)), 'H private tmpfs differs');
  const mounts = container.Mounts;
  need(Array.isArray(mounts) && mounts.length === intent.mounts.length + 2 && new Set(mounts.map(m => m.Destination)).size === mounts.length, 'H mount grants differ');
  for (const expected of intent.mounts) {
    const actual = mounts.filter(m => m.Destination === expected.destination);
    need(actual.length === 1 && actual[0].Type === expected.type && actual[0].RW === !expected.readonly &&
      (expected.type === 'volume' ? actual[0].Name === expected.source : actual[0].Source === expected.source), 'H mount grant differs');
  }
  for (const destination of ['/tmp', '/run']) need(mounts.some(m => m.Type === 'tmpfs' && m.Destination === destination && m.RW === true), 'H tmpfs grant differs');
  supportedHostDefaults(host);
  if (intent.hostFloors !== undefined) {
    need(intent.hostFloors && same(Object.keys(intent.hostFloors).sort(), ['MaskedPaths', 'ReadonlyPaths']), 'H inherited floors are malformed');
    for (const key of ['MaskedPaths', 'ReadonlyPaths']) need(same(host[key], intent.hostFloors[key]), 'H inherited path restrictions differ');
  }
  need(Array.isArray(host.Mounts) && host.Mounts.length === intent.mounts.length, 'H bind construction differs');
  for (const mount of host.Mounts) need((mount.ReadOnly === undefined || typeof mount.ReadOnly === 'boolean') &&
    intent.mounts.some(m => m.type === mount.Type && m.source === mount.Source && m.destination === mount.Target && m.readonly === (mount.ReadOnly ?? false)) &&
    defaultMountOptions(mount), 'H mount construction has unknown authority');
  const configKeys = new Set(['Hostname', 'Domainname', 'User', 'AttachStdin', 'AttachStdout', 'AttachStderr', 'ExposedPorts', 'Tty', 'OpenStdin', 'StdinOnce', 'Env', 'Cmd', 'Healthcheck', 'ArgsEscaped', 'Image', 'Volumes', 'WorkingDir', 'Entrypoint', 'OnBuild', 'Labels', 'StopSignal', 'StopTimeout', 'Shell', 'NetworkDisabled', 'MacAddress']);
  need(Object.keys(cfg).every(key => configKeys.has(key)) && cfg.Hostname === container.Id.slice(0, 12) && empty(cfg.Domainname) &&
    cfg.Tty === false && cfg.OpenStdin === false && cfg.StdinOnce === false && empty(cfg.AttachStdin) && empty(cfg.NetworkDisabled) && empty(cfg.MacAddress) &&
    ['AttachStdin', 'AttachStdout', 'AttachStderr'].every(key => cfg[key] === undefined || typeof cfg[key] === 'boolean'), 'H process defaults differ');
  for (const key of ['Healthcheck', 'Volumes', 'OnBuild', 'StopSignal', 'StopTimeout', 'Shell', 'ArgsEscaped']) need(same(cfg[key] ?? null, image.Config[key] ?? null), 'H immutable image process field differs: ' + key);
  const exposed = { ...(image.Config.ExposedPorts || {}), '3000/tcp': {} };
  need(same(cfg.ExposedPorts || {}, exposed), 'H exposed ports differ');
  // Only after independent generated-intent validation retain all readback
  // fields for WebsiteStage's second qualification and exact native binding.
  return { ...cfg, Image: image.Id, HostConfig: host };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [phase, ...args] = process.argv.slice(2);
    if (phase === 'describe') {
      need(args.length === 6, 'H describe requires repo/root/runtime/installation/old-runtime/state');
      const [repo, root, runtime, installation, oldRuntime, state] = args;
      const lifecycle = new TerminalLifecycle({ repo, root, runtime, installation, oldRuntime, state });
      console.log(JSON.stringify({ program: lifecycle.program, operation: lifecycle.operation, engineSocket: lifecycle.engineSocket, description: lifecycle.description }));
    } else if (phase === 'engine-socket') {
      need(args.length === 1, 'Fixed engine selection requires private installation');
      console.log(terminalEngineSocket(args[0]));
    } else if (phase === 'bind-lock' || phase === 'check-lock') {
      need(args.length === 3 && args[1] === '9', 'Fixed lock validation requires describe/FD9/binding');
      const descriptor = JSON.parse(privateFile(args[0])).descriptor;
      const bound = phase === 'check-lock' ? JSON.parse(privateFile(args[2])) : undefined;
      const actual = checkDescribedLock(descriptor, 9, bound);
      if (phase === 'bind-lock') save(args[2], actual);
    } else if (phase === 'refresh-resource') {
      need(args.length === 4, 'Fixed resource refresh requires repo/installation/operation/heldFD');
      const [repo, installation, operation, rawFd] = args;
      const value = Object.create(TerminalLifecycle.prototype);
      value.repo = repo; value.runtime = 'resource-terminal'; value.installation = installation; value.operation = operation;
      value.initialDigest = sha(privateFile(installation)); value.fd = Number(rawFd);
      need(Number.isInteger(value.fd) && value.fd === 9, 'Actual inherited FD9 required');
      value.refreshResource();
    } else if (phase === 'validate-created') {
      need(args.length === 4, 'H validation requires created/image/intent/output private paths');
      const [created, image, intent, output] = args;
      save(output, acceptedCreateSpec(JSON.parse(privateFile(created, 8 << 20)), JSON.parse(privateFile(image, 8 << 20)), JSON.parse(privateFile(intent, 8 << 20))));
      console.log(sha(privateFile(output, 8 << 20)));
    } else if (phase === 'check-source-host') {
      need(args.length === 2 && /^[0-9]+$/.test(args[1]), 'H source check requires private metadata and port');
      const value = JSON.parse(privateFile(args[0], 8 << 20));
      checkSourceHost(Array.isArray(value) ? value[0] : value, Number(args[1]));
    } else if (phase === 'check-image') {
      need(args.length === 2, 'H image check requires private image and describe records');
      assertImageProfile(JSON.parse(privateFile(args[0], 8 << 20)), JSON.parse(privateFile(args[1])).descriptor);
    } else fail('Unknown fixed H script operation');
  } catch (error) { console.error('owner-terminal lifecycle: ' + error.message); process.exitCode = 1; }
}
