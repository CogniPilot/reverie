"""Owner-only installation/control of the existing isolated-laptop broker unit.

No website process, employee wake, host OS rebuild or engine socket grant is
created here. Positive operations require an existing private admission policy.
"""
import argparse
import hashlib
import errno
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

if __package__ in (None, ''):
    # The immutable host launcher uses isolated Python and this fixed entry.
    # Do not import a package from the caller's cwd or PYTHONPATH.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = 'reverie'

from .worker import load_config

UNIT = 'reverie-worker-broker.service'
STORE_ROOT = Path('/nix/store')
_MANAGER_STAGES = {'stop': 'MANAGER_STOP', 'disable': 'MANAGER_DISABLE', 'daemon-reload': 'MANAGER_RELOAD'}


class ManagerOperationError(RuntimeError):
    """Fixed operation metadata only; never retain command arguments/output."""
    def __init__(self, stage, returncode):
        super().__init__('Owner user-service manager operation failed')
        self.stage, self.returncode = stage, returncode


def run_command(args, *, deadline=None):
    timeout = 20
    if deadline is not None:
        if type(deadline) not in (int, float) or not math.isfinite(deadline):
            raise ValueError('Finite installation observation deadline required')
        timeout = min(timeout, deadline - time.monotonic())
        if timeout <= 0:
            raise RuntimeError('Installation observation deadline exhausted')
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout)


def environment_selection(path):
    value = str(path)
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError('Control characters are not supported in service configuration paths')
    # This double-quoted subset escapes quote/backslash and preserves UTF-8;
    # EnvironmentFile is not JSON and does not decode JSON's ASCII \u escapes.
    return 'REVERIE_WORKER_CONFIG=' + json.dumps(value, ensure_ascii=False) + '\n'


class WorkerService:
    def __init__(self, config=None, *, home=None, run=run_command):
        self.config_path = Path(config) if config is not None else None
        self.home = Path.home() if home is None else Path(home)
        self.run = run
        self.unit = self.home / '.config/systemd/user' / UNIT
        self.environment = self.home / '.config/reverie/worker-broker.env'
        self.gcroot = self.home / '.local/state/reverie/services/worker-broker/root'

    def manager(self, *args, required=True):
        result = self.run(['systemctl', '--user', *args])
        if required and result.returncode:
            if args and args[0] in _MANAGER_STAGES:
                raise ManagerOperationError(_MANAGER_STAGES[args[0]], result.returncode)
            raise RuntimeError('Owner user-service manager operation failed')
        return result

    def target_unit(self):
        path = Path(os.environ.get('REVERIE_WORKER_SERVICE_UNIT', ''))
        if not path.is_absolute() or not path.is_relative_to(STORE_ROOT) or path.resolve() != path:
            raise ValueError('Use the pinned Reverie worker-service flake launcher')
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
            raise ValueError('Immutable packaged worker unit required')
        return path

    def store_root(self, target):
        parts = target.relative_to(STORE_ROOT).parts
        if len(parts) != 5 or parts[1:] != ('share', 'systemd', 'user', UNIT):
            raise ValueError('Fixed packaged worker unit layout required')
        return STORE_ROOT / parts[0]

    def pin_unit(self, target):
        root = self.store_root(target)
        self.pin_store(root, self.gcroot)

    def pin_store(self, root, gcroot):
        gcroot.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = gcroot.parent.stat()
        if gcroot.parent.resolve() != gcroot.parent or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Private durable service root directory required')
        if gcroot.exists() or gcroot.is_symlink():
            if not gcroot.is_symlink() or gcroot.resolve() != root:
                raise ValueError('Existing service generation root differs; owner review required')
        else:
            result = self.run(['nix-store', '--add-root', str(gcroot), '--indirect', '--realise', str(root)])
            if result.returncode or not gcroot.is_symlink() or gcroot.resolve() != root:
                raise RuntimeError('Durable service GC root publication is unconfirmed')

    def pin_resource_actor(self, path):
        from .website_image_provenance import immutable
        path = immutable(path, 65536)
        parts = path.relative_to(STORE_ROOT).parts
        if len(parts) != 4 or parts[1:] != ('share', 'reverie', 'website-image.json'):
            raise ValueError('Fixed resource-actor provenance package layout required')
        identity = hashlib.sha256(path.read_bytes()).hexdigest()
        gcroot = self.gcroot.parent/'resource-actor'/identity/'root'
        self.pin_store(STORE_ROOT/parts[0], gcroot)

    def positive_preflight(self, *, check_manager=True, installing=False):
        if sys.platform != 'linux' or os.geteuid() == 0:
            raise ValueError('Isolated broker setup requires the ordinary owner on local Linux')
        path = self.config_path
        if path is None or not path.is_absolute() or path.resolve() != path or any(c in str(path) for c in '\r\n\0'):
            raise ValueError('Select an existing canonical private broker configuration')
        environment_selection(path)
        parent, info = path.parent.stat(), path.lstat()
        if parent.st_uid != os.getuid() or parent.st_mode & 0o077 or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Private owned broker configuration required')
        config = load_config(path)
        if config['uid'] != os.getuid() or config['gid'] != os.getgid():
            raise ValueError('Broker identity must be the ordinary installing owner')
        policies = [config, *config.get('sessionResources', {}).values(), *config.get('employeeResources', {}).values()]
        if any(p['budgetMode'] != 'admission' or p['memoryMiB'] < 512 for p in policies):
            raise ValueError('Portable broker installation requires bounded admission policies; pool setup is separate')
        state, scratch = Path(config['stateRoot']), Path(config['scratchRoot'])
        for directory in (state, scratch):
            if directory == scratch and not directory.exists() and not directory.is_symlink():
                parent = directory.parent
                while not parent.exists(): parent = parent.parent
                value = parent.stat()
                if directory.resolve() != directory or parent.resolve() != parent or value.st_uid != os.getuid() or value.st_mode & 0o022:
                    raise ValueError('Disposable root requires an owned canonical safe parent')
                continue
            value = directory.lstat()
            if directory.resolve() != directory or not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid() or value.st_mode & 0o077:
                raise ValueError('Existing canonical private storage roots required')
        if state.is_relative_to(scratch) or any(state.is_relative_to(Path(m['source']).resolve()) for m in config['mounts']):
            raise ValueError('Durable laptop state must be outside scratch and shared mounts')
        if check_manager: self.manager('is-active', 'default.target')
        endpoint = os.environ.get('DOCKER_HOST')
        context = os.environ.get('DOCKER_CONTEXT')
        if context or not endpoint:
            response = self.run(['docker', 'context', 'inspect', *([context] if context else []), '--format', '{{json .Endpoints.docker.Host}}'])
            if response.returncode: raise RuntimeError('Local engine context is unavailable')
            endpoint = json.loads(response.stdout)
        if not isinstance(endpoint, str) or not endpoint.startswith('unix:///'):
            raise ValueError('This backend requires a local Unix-socket engine, not Docker Desktop/remote transport')
        response = self.run(['docker', 'info', '--format', '{{json .}}'])
        if response.returncode: raise RuntimeError('Local container engine is unavailable')
        value = json.loads(response.stdout)
        if (value.get('OSType') != 'linux' or value.get('KernelVersion') != os.uname().release or
                'docker desktop' in str(value.get('OperatingSystem', '')).lower() or
                value.get('Name') == 'docker-desktop' or str(value.get('CgroupVersion')) != '2' or
                any(value.get(key) is not True for key in ('MemoryLimit', 'SwapLimit', 'PidsLimit'))):
            raise ValueError('Engine must support cgroup-v2 RAM, no-swap and PID ceilings; refusing unbounded fallback')
        if config.get('resourceActorConfig') is not None:
            from .website_peer_facts import socket_identity
            self.resource_engine = (endpoint[7:], socket_identity(endpoint[7:]), value.get('ID'))
        from .worker_capacity_policy import legacy_headroom_fits
        from .worker_resource_reservations import option, configured, marker, pending, NativeObserver, ReservationGate
        selected = option(config)
        if selected is None:
            if configured(config):
                # A removed explicit option must not become legacy acceptance.
                with ReservationGate(self.resource_probe(config)).admission():
                    pass
            if not legacy_headroom_fits(config['poolMemoryMiB'] * 1024 * 1024, value.get('MemTotal')):
                raise ValueError('Worker admission budget must retain website and host memory headroom')
        else:
            probe = self.resource_probe(config)
            if installing and not os.path.lexists(marker(config)) and not os.path.lexists(pending(config)):
                native = NativeObserver(probe)
                rows = native.custody(Path(selected['directory']), marker(config))
                self.native_headroom(native, selected, rows)
            else:
                gate = ReservationGate(probe)
                with gate.admission():
                    if installing:
                        # Installation capacity acceptance has no candidate or
                        # start authority. Unknown retained source facts refuse.
                        gate.check_headroom()
                    else:
                        # Cold START preserves intact unknown-source fences and
                        # existing transport recovery; no claim is credited or
                        # granted permission to create a replacement here.
                        self.native_headroom(gate.native, selected)
        return config

    @staticmethod
    def native_headroom(native, selected, rows=None):
        """Fixed observer only; no READY gate, candidate or effect is invented."""
        rows = native.inventory() if rows is None else rows
        before = native.capacity(rows, selected)
        if native.inventory() != rows:
            raise ValueError('Native capacity inventory changed during service preflight')
        # Qualify kernel/root/ancestor facts again after the engine observation.
        # MemAvailable is freshly tested by the observer, never frozen equal.
        if native.capacity(rows, selected) != before:
            raise ValueError('Native effective capacity changed during service preflight')
        if native.inventory() != rows:
            raise ValueError('Native capacity inventory changed during service preflight')

    def resource_probe(self, config):
        service = self
        class InstallProbe:
            """Fixed metadata-only adapter; no browser/worker resource authority."""
            def __init__(self):
                self.config = config
                self.config_file = service.config_path
            def run_engine(self, args, optional=False, *, deadline=None):
                if not args or args[0] not in ('ps', 'inspect'):
                    raise ValueError('Installation probe is metadata-only')
                result = (service.run(['docker', *args]) if deadline is None else
                          service.run(['docker', *args], deadline=deadline))
                if result.returncode:
                    raise ValueError('Resource custody inventory unavailable')
                return result
        return InstallProbe()

    def install(self, *, resource_actor_provenance=None, resource_actor_engine_socket=None):
        config = self.positive_preflight(installing=True)
        if (resource_actor_provenance is None) != (resource_actor_engine_socket is None):
            raise ValueError('Explicit resource actor preparation requires both immutable provenance and a local engine socket')
        if resource_actor_provenance is not None and config.get('resourceActorConfig') is None:
            raise ValueError('Resource actor preparation must be selected in the private broker configuration')
        if self.manager('is-active', UNIT, required=False).returncode == 0:
            raise ValueError('Broker is active; coordinate its transport maintenance before replacing the installed unit')
        target = self.target_unit()
        self.unit.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.environment.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        for directory in (self.unit.parent, self.environment.parent):
            if directory.resolve() != directory or directory.stat().st_uid != os.getuid():
                raise ValueError('Owned real service directories required')
        if self.environment.parent.stat().st_mode & 0o077:
            raise ValueError('Private broker environment directory required')
        if self.unit.exists() or self.unit.is_symlink():
            if not self.unit.is_symlink() or self.unit.resolve() != target:
                raise ValueError('Existing service differs; preserve it and explicitly review replacement')
        if self.environment.exists() or self.environment.is_symlink():
            info = self.environment.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise ValueError('Private owned broker environment file required')
            if self.environment.read_text() != environment_selection(self.config_path):
                raise ValueError('Existing broker configuration selection differs; owner review required')
        from .worker_resource_reservations import option, marker, pending, provision, ReservationGate
        if option(config) is not None:
            probe = self.resource_probe(config)
            if os.path.lexists(marker(config)) or os.path.lexists(pending(config)):
                with ReservationGate(probe).admission():
                    pass
            else:
                provision(probe)  # Explicit install only; never a runtime fallback.
        if config.get('resourceActorConfig') is not None:
            from .resource_actor_install import prepare, InstalledFacts
            probe = self.resource_probe(config)
            if resource_actor_provenance is not None:
                from .website_peer_facts import socket_identity
                endpoint, identity, engine_id = self.resource_engine
                if (Path(resource_actor_engine_socket).resolve(strict=True) != Path(endpoint).resolve(strict=True) or
                        socket_identity(str(resource_actor_engine_socket)) != identity):
                    raise ValueError('Resource actor socket differs from the actual broker engine endpoint')
                self.pin_resource_actor(resource_actor_provenance)
                prepare(probe, str(resource_actor_provenance), str(resource_actor_engine_socket), engine_id)
            else:
                if os.path.lexists(config['socket']):
                    raise ValueError('Resource actor installation requires inactive broker transport')
                installed = InstalledFacts(probe, ReservationGate(probe))  # Existing-only; never runtime provision.
                self.pin_resource_actor(installed.value['imageProvenance']['path'])
            if load_config(self.config_path) != config:
                raise ValueError('Private broker configuration changed during resource actor preparation')
        self.pin_unit(target)  # Keep unit, broker and checker closures after nix run/GC/reboot.
        if not self.environment.exists():
            fd = os.open(self.environment, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write(environment_selection(self.config_path))
                output.flush(); os.fsync(output.fileno())
        if not self.unit.is_symlink(): self.unit.symlink_to(target)
        for parent in (self.environment.parent, self.unit.parent, self.gcroot.parent):
            fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(fd)
            finally: os.close(fd)
        self.manager('daemon-reload')
        self.manager('enable', UNIT)  # No implicit start, website or provider wake.
        return {'installed': True, 'started': False, 'unit': UNIT}

    def refresh_resource_actor(self, *, resource_actor_provenance, resource_actor_engine_socket):
        """Explicit owner-local rebind; no service, allocation or employee restart."""
        config = self.positive_preflight()
        if (config.get('resourceActorConfig') is None or resource_actor_provenance is None or
                resource_actor_engine_socket is None):
            raise ValueError('Selected existing resource actor and matching package/socket required')
        from .resource_actor_install import prepare
        from .resource_actor_refresh import RegisteredTransport
        from .website_peer_facts import socket_identity
        endpoint, identity, engine_id = self.resource_engine
        if (Path(resource_actor_engine_socket).resolve(strict=True) != Path(endpoint).resolve(strict=True) or
                socket_identity(str(resource_actor_engine_socket)) != identity):
            raise ValueError('Resource actor socket differs from the actual broker engine endpoint')
        self.pin_resource_actor(resource_actor_provenance)
        transport = RegisteredTransport(self, config)
        try:
            return prepare(self.resource_probe(config), str(resource_actor_provenance),
                           str(resource_actor_engine_socket), engine_id, transport=transport)
        finally:
            transport.close()  # Already finalized before publication release on success.

    def action(self, action):
        if sys.platform != 'linux' or os.geteuid() == 0:
            raise ValueError('Use the ordinary owner Linux user-service manager')
        if action == 'start':
            self.positive_preflight()
            if not self.unit.is_symlink() or self.unit.resolve() != self.target_unit():
                raise ValueError('This reviewed worker-service generation is not installed')
            selected = self.environment.lstat()
            if (not stat.S_ISREG(selected.st_mode) or selected.st_uid != os.getuid() or
                    selected.st_nlink != 1 or selected.st_mode & 0o077 or
                    self.environment.read_text() != environment_selection(self.config_path)):
                raise ValueError('Start configuration differs from the installed private selection')
            self.manager('start', UNIT)
        elif action == 'stop':
            self.manager('stop', UNIT)
        elif action == 'status':
            result = self.manager('is-active', UNIT, required=False)
            return {'installed': self.unit.exists(), 'active': result.returncode == 0, 'unit': UNIT}
        elif action == 'uninstall':
            target = self.target_unit()
            if not self.unit.is_symlink() or self.unit.resolve() != target:
                raise ValueError('Refusing to remove an unrecognized service generation')
            parent = self.unit.parent.stat()
            if self.unit.parent.resolve() != self.unit.parent:
                raise ValueError('Canonical service directory required')
            # Stop while this external unit link still names the recognized
            # generation. disable --now can remove/reload it before stopping.
            self.manager('stop', UNIT)
            current = self.unit.parent.stat()
            if (self.unit.parent.resolve() != self.unit.parent or
                    (parent.st_dev, parent.st_ino) != (current.st_dev, current.st_ino)):
                raise ValueError('Service directory changed while stopping')
            if not self.unit.is_symlink() or self.unit.resolve() != target:
                raise ValueError('Service generation changed while stopping')
            self.manager('disable', UNIT)
            current = self.unit.parent.stat()
            if (self.unit.parent.resolve() != self.unit.parent or
                    (parent.st_dev, parent.st_ino) != (current.st_dev, current.st_ino)):
                raise ValueError('Service directory changed while disabling')
            # systemctl disable may already remove this externally linked unit.
            if os.path.lexists(self.unit):
                if not self.unit.is_symlink() or self.unit.resolve() != target:
                    raise ValueError('Service generation changed while disabling')
                self.unit.unlink()
            self.manager('daemon-reload')
            if self.gcroot.is_symlink() and self.gcroot.resolve() == self.store_root(target):
                self.gcroot.unlink()
            # Private config, environment, laptop homes/stores and intent remain.
        else: raise ValueError('Unknown fixed service operation')
        return {'action': action, 'success': True, 'unit': UNIT}


# Exact fixed guard text only. Never print arbitrary exception strings,
# filenames, commands, environment, private JSON or subprocess output.
_DIAGNOSTIC_REASONS = frozenset({
    'WORKER_IMAGE_LOADED_MANAGER_ENCODING',
    'WORKER_IMAGE_LOADED_MANAGER_MISMATCH',
    'WORKER_IMAGE_LOADED_PROGRAM_ENCODING',
    'WORKER_IMAGE_LOADED_PROGRAM_MISMATCH',
    'WORKER_IMAGE_MATCHING_GENERATION_REQUIRED',
    'WORKER_IMAGE_ARCHIVE_BINDING',
    'WORKER_IMAGE_ATTEMPT_USED',
    'WORKER_IMAGE_BROKER_SOCKET_PRESENT',
    'WORKER_IMAGE_CANONICAL_CONFIG_REQUIRED',
    'WORKER_IMAGE_CONFIGURATION_CHANGED',
    'WORKER_IMAGE_CONFIGURATION_CUSTODY',
    'WORKER_IMAGE_CONFIGURATION_STALE',
    'WORKER_IMAGE_CONFIG_IN_R_ROOT',
    'WORKER_IMAGE_DEADLINE',
    'WORKER_IMAGE_DEPLOYMENT_BINDING',
    'WORKER_IMAGE_DEPLOYMENT_CHANGED',
    'WORKER_IMAGE_DEPLOYMENT_PATH',
    'WORKER_IMAGE_EXACT_DISTINCT_IDS',
    'WORKER_IMAGE_EXISTING_PROFILE_UNQUALIFIED',
    'WORKER_IMAGE_EXISTING_R_REQUIRED',
    'WORKER_IMAGE_FACTORY_IDENTITY',
    'WORKER_IMAGE_FACTORY_LABELS',
    'WORKER_IMAGE_FINAL_FILES_CHANGED',
    'WORKER_IMAGE_FIXED_PROVENANCE_REQUIRED',
    'WORKER_IMAGE_INSTALLED_CONSUMER_REQUIRES_MAINTENANCE',
    'WORKER_IMAGE_LOADED_PROFILE_MISMATCH',
    'WORKER_IMAGE_MAINTENANCE_LOCK_CHANGED',
    'WORKER_IMAGE_MAINTENANCE_OVERRIDE',
    'WORKER_IMAGE_NATIVE_CHANGED',
    'WORKER_IMAGE_NONIMAGE_CHANGE',
    'WORKER_IMAGE_OPERATION_LOCATION',
    'WORKER_IMAGE_OPERATION_USED',
    'WORKER_IMAGE_ORDINARY_OWNER',
    'WORKER_IMAGE_PENDING_CHANGED',
    'WORKER_IMAGE_PENDING_CUSTODY',
    'WORKER_IMAGE_PENDING_WRITE',
    'WORKER_IMAGE_PLAN_CHANGED',
    'WORKER_IMAGE_PLAN_DIGEST',
    'WORKER_IMAGE_PLAN_EXPIRED',
    'WORKER_IMAGE_PLAN_SCHEMA',
    'WORKER_IMAGE_PROFILE_CHANGED',
    'WORKER_IMAGE_PROFILE_PAIR',
    'WORKER_IMAGE_PROVENANCE_CHANGED',
    'WORKER_IMAGE_READBACK',
    'WORKER_IMAGE_RECONCILIATION_REQUIRED',
    'WORKER_IMAGE_REGISTERED_CONFIG_CHANGED',
    'WORKER_IMAGE_REGISTERED_SERVICE_REQUIRED',
    'WORKER_IMAGE_RETAINED_WORK',
    'WORKER_IMAGE_SELECTION',
    'WORKER_IMAGE_SOURCE_BINDING',
    'WORKER_IMAGE_SOURCE_CHANGED',
    'WORKER_IMAGE_SPEC_SCHEMA',
    'WORKER_IMAGE_TOOLKIT_BINDING',
    'WORKER_IMAGE_TOOLKIT_CHANGED',
    'Use the pinned Reverie worker-service flake launcher',
    'Immutable packaged worker unit required',
    'Select an existing canonical private broker configuration',
    'Private owned broker configuration required',
    'Existing canonical private storage roots required',
    'Broker identity must be the ordinary installing owner',
    'Existing service differs; preserve it and explicitly review replacement',
    'Existing broker configuration selection differs; owner review required',
    'Existing service generation root differs; owner review required',
    'Select the private one-attempt operation directory',
    'Select the closed private GPU upgrade input',
    'Canonical private operation directory required',
    'Private singly linked owner file required',
    'Private file changed during read',
    'Installed generation links required',
    'Installed unit, environment and GC root disagree',
    'Foreign or changed unit template',
    'Actual manager unit differs from selected immutable generation',
    'Broker stop not confirmed inactive',
    'Closed GPU upgrade selection required',
    'Reviewed CDI digest required',
    'Bounded existing provider PID set required',
    'Existing or uncertain reservation domain requires its own reconciliation',
    'Current owner vacation intent refuses GPU maintenance',
    'Legacy SID authority conflicts with selected employee GPU',
    'Selected provider must already have handed off and laptop must be stopped',
    'Fresh empty reservation control root required',
    'Selected laptop would exceed current pool',
    'Selected replacement exceeds worker population bound',
    'Provider PID is not in an observed running container',
    'Native inventory changed after capacity/provider reads',
    'Fresh operation directory required',
    'One-attempt upgrade already consumed',
    'Exact prepared plan digest required',
    'Upgrade plan expired',
    'Prepared generation changed',
    'Candidate or employee binding changed',
    'Native readiness changed; prepare a fresh plan',
    'Upgrade command refused or outcome unknown',
    'Generation GC root publication unknown',
    'Previous broker process is still alive',
    'Peer/provider continuity changed during broker stop',
    'Config CAS precondition changed',
    'Configuration identity changed',
    'Employee intent changed before CAS',
    'Configuration or current employee changed after commit intent',
    'Configuration/employee metadata changed at CAS boundary',
    'Generation link changed before CAS',
    'New generation readback changed',
    'New broker/office listener readiness deadline exhausted',
    'Recovered listener is not the selected new broker process',
    'OFF or vacation employee cannot qualify normal activation',
    'Normal activation has the wrong native identity or image',
    'Native GPU/device authority differs from exact selected CDI profile',
    'Original selected home/Nix/scratch identity changed',
    'Selected stopped laptop identity changed without observed activation',
    'Peer native continuity changed',
    'Provider continuity changed',
    'Original selected storage identities changed',
    'Employee intent or recipe changed',
    'Final metadata changed after finalizers',
    'RESERVATION_HOST_BUDGET',
    'RESERVATION_CAPACITY_EXHAUSTED',
    'RESERVATION_NATIVE_INVENTORY_CHANGED',
    'RESERVATION_CONTROL_EXPOSED',
    'RESERVATION_CONTROL_ALIAS',
    'RESERVATION_DOMAIN_CHANGED',
    'RESERVATION_INSTALL_REQUIRES_RECONCILIATION',
    'RESERVATION_CONTROL_NOT_READY',
    'RESERVATION_OBSERVATION_DEADLINE',
    'RESERVATION_NATIVE_PID_CHANGED',
    'RESERVATION_EFFECTIVE_LIMIT_CONFLICT',
})


_TRANSPORT_DIAGNOSTIC_STAGES = frozenset({
    'POSTSTART_BROKER', 'POSTSTART_LISTENERS', 'POSTSTART_ADMISSION',
    'POSTSTART_CONTINUITY', 'POSTSTART_BROKER_READBACK',
    'POSTSTART_RESULT_WRITE', 'POSTSTART_TERMINAL',
})


def _diagnostic(error):
    """A bounded category/allowlisted reason, never exception serialization."""
    reason = 'Unlisted exception details withheld.'
    if len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in _DIAGNOSTIC_REASONS:
        reason = error.args[0]
    if isinstance(error, (subprocess.TimeoutExpired, TimeoutError)):
        category = 'OBSERVATION_TIMEOUT'
        reason = 'A fixed observation/client deadline expired; existing attempt state is unchanged by diagnostics.'
    elif isinstance(error, OSError):
        category = {errno.ENOENT: 'PATH_UNAVAILABLE', errno.EACCES: 'PATH_PERMISSION',
                    errno.EPERM: 'PATH_PERMISSION', errno.EEXIST: 'EXCLUSIVE_PATH_EXISTS',
                    errno.ELOOP: 'PATH_ALIAS', errno.EXDEV: 'ATOMIC_FILESYSTEM_MISMATCH'}.get(error.errno, 'IO_UNCONFIRMED')
    elif isinstance(error, ValueError):
        category = 'GUARD_CHECK_FAILED'
    else:
        category = 'OPERATION_UNCONFIRMED'
    result = {'category': category, 'reason': reason}
    stage = getattr(error, '_reverie_transport_stage', None)
    if type(stage) is str and stage in _TRANSPORT_DIAGNOSTIC_STAGES:
        result['stage'] = stage
    if (type(error) is ManagerOperationError and type(error.stage) is str and
            error.stage in _MANAGER_STAGES.values() and type(error.returncode) is int and
            -128 <= error.returncode <= 255 and error.returncode != 0):
        result.update(reason='Owner user-service manager operation failed',
                      managerStage=error.stage, returncode=error.returncode)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--diagnostic', action='store_true',
                        help='On failure print a bounded redacted category and vetted guard reason; never authorizes replay')
    parser.add_argument('action', choices=('check', 'check-backend', 'install', 'refresh-resource-actor', 'start', 'stop', 'status', 'logs', 'uninstall',
                                                 'prepare-worker-image-switch', 'apply-worker-image-switch',
                                                 'prepare-resource-actor-enable', 'apply-resource-actor-enable',
                                                 'prepare-gpu-upgrade', 'apply-gpu-upgrade',
                                                 'prepare-transport-upgrade', 'apply-transport-upgrade'))
    parser.add_argument('--lines', type=int, default=100)
    parser.add_argument('--resource-actor-provenance', type=Path,
                        help='On explicit install or facts refresh, select immutable Nix website-image provenance')
    parser.add_argument('--resource-actor-engine-socket', type=Path,
                        help='Local Unix engine socket used by that optional preparation; no daemon is started')
    parser.add_argument('--operation', type=Path, help='Fresh private one-attempt migration directory')
    parser.add_argument('--selection', type=Path, help='Closed owner-private upgrade selection')
    parser.add_argument('--plan-sha256', help='Exact prepared fixed maintenance plan digest')
    args = parser.parse_args(argv)
    os.umask(0o077)
    service = WorkerService(args.config)
    try:
        if args.action not in ('install', 'refresh-resource-actor') and (args.resource_actor_provenance is not None or args.resource_actor_engine_socket is not None):
            raise ValueError('Optional resource actor preparation applies only to explicit install or facts refresh')
        if args.action in ('prepare-worker-image-switch', 'apply-worker-image-switch'):
            from .worker_image_switch import WorkerImageSwitch
            if args.operation is None:
                raise ValueError('Select a fresh private worker-image operation directory')
            migration = WorkerImageSwitch(service, args.operation)
            if args.action == 'prepare-worker-image-switch':
                if args.selection is None or args.plan_sha256 is not None:
                    raise ValueError('Select the closed immutable-profile worker-image input')
                result = migration.prepare(args.selection)
            else:
                if args.selection is not None:
                    raise ValueError('Apply uses only its exact prepared worker-image plan')
                result = migration.apply(args.plan_sha256)
        elif args.action in ('prepare-resource-actor-enable', 'apply-resource-actor-enable'):
            from .resource_actor_bootstrap import Bootstrap
            if args.operation is None:
                raise ValueError('Select a fresh private actor-enable operation directory')
            migration = Bootstrap(service, args.operation)
            if args.action == 'prepare-resource-actor-enable':
                if args.selection is None:
                    raise ValueError('Select the private provider PID roster')
                result = migration.prepare(args.selection)
            else:
                result = migration.apply(args.plan_sha256)
        elif args.action in ('prepare-transport-upgrade', 'apply-transport-upgrade'):
            from .worker_service_transport_upgrade import TransportUpgrade
            if args.operation is None:
                raise ValueError('Select the private one-attempt operation directory')
            migration = TransportUpgrade(service, args.operation)
            if args.action == 'prepare-transport-upgrade':
                if args.selection is None:
                    raise ValueError('Select the closed private transport provider input')
                result = migration.prepare(args.selection)
            else:
                result = migration.apply(args.plan_sha256)
        elif args.action in ('prepare-gpu-upgrade', 'apply-gpu-upgrade'):
            from .worker_service_upgrade import GPUUpgrade
            if args.operation is None:
                raise ValueError('Select the private one-attempt operation directory')
            migration = GPUUpgrade(service, args.operation)
            if args.action == 'prepare-gpu-upgrade':
                if args.selection is None:
                    raise ValueError('Select the closed private GPU upgrade input')
                result = migration.prepare(args.selection)
            else:
                result = migration.apply(args.plan_sha256)
        elif args.action in ('check', 'check-backend'):
            service.positive_preflight(check_manager=args.action == 'check')
            result = {'capabilities': 'PASS', 'installedAcceptance': False}
        elif args.action == 'install':
            if args.resource_actor_provenance is None and args.resource_actor_engine_socket is None:
                result = service.install()
            else:
                result = service.install(resource_actor_provenance=args.resource_actor_provenance,
                                         resource_actor_engine_socket=args.resource_actor_engine_socket)
        elif args.action == 'refresh-resource-actor':
            result = service.refresh_resource_actor(resource_actor_provenance=args.resource_actor_provenance,
                                                     resource_actor_engine_socket=args.resource_actor_engine_socket)
        elif args.action == 'logs':
            if not 1 <= args.lines <= 1000: raise ValueError('Log lines must be 1..1000')
            result = service.run(['journalctl', '--user', '--unit', UNIT, '--lines', str(args.lines), '--no-pager'])
            if result.returncode: raise RuntimeError('Broker journal unavailable')
            print(result.stdout, end=''); return 0
        else: result = service.action(args.action)
        print(json.dumps(result)); return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print('Worker service operation refused; verify private policy, local engine capabilities and reviewed installation.', file=sys.stderr)
        if args.diagnostic:
            print(json.dumps(_diagnostic(error), sort_keys=True, separators=(',', ':')), file=sys.stderr)
        else:
            print('For future calls, --diagnostic adds a bounded guard reason.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    # Maintenance modules require the exact canonical WorkerService owner type.
    from .worker_service import main as canonical_main
    raise SystemExit(canonical_main())
