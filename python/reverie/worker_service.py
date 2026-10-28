"""Owner-only installation/control of the existing isolated-laptop broker unit.

No website process, employee wake, host OS rebuild or engine socket grant is
created here. Positive operations require an existing private admission policy.
"""
import argparse
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

from .worker import load_config

UNIT = 'reverie-worker-broker.service'
STORE_ROOT = Path('/nix/store')


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
        self.gcroot.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.gcroot.parent.stat()
        if self.gcroot.parent.resolve() != self.gcroot.parent or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Private durable service root directory required')
        if self.gcroot.exists() or self.gcroot.is_symlink():
            if not self.gcroot.is_symlink() or self.gcroot.resolve() != root:
                raise ValueError('Existing service generation root differs; owner review required')
        else:
            result = self.run(['nix-store', '--add-root', str(self.gcroot), '--indirect', '--realise', str(root)])
            if result.returncode or not self.gcroot.is_symlink() or self.gcroot.resolve() != root:
                raise RuntimeError('Durable service GC root publication is unconfirmed')

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
            def __init__(self): self.config = config
            def run_engine(self, args, optional=False, *, deadline=None):
                if not args or args[0] not in ('ps', 'inspect'):
                    raise ValueError('Installation probe is metadata-only')
                result = (service.run(['docker', *args]) if deadline is None else
                          service.run(['docker', *args], deadline=deadline))
                if result.returncode:
                    raise ValueError('Resource custody inventory unavailable')
                return result
        return InstallProbe()

    def install(self):
        config = self.positive_preflight(installing=True)
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
            if not self.unit.is_symlink() or self.unit.resolve() != self.target_unit():
                raise ValueError('Refusing to remove an unrecognized service generation')
            self.manager('disable', '--now', UNIT)
            self.unit.unlink(); self.manager('daemon-reload')
            if self.gcroot.is_symlink() and self.gcroot.resolve() == self.store_root(self.target_unit()):
                self.gcroot.unlink()
            # Private config, environment, laptop homes/stores and intent remain.
        else: raise ValueError('Unknown fixed service operation')
        return {'action': action, 'success': True, 'unit': UNIT}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path)
    parser.add_argument('action', choices=('check', 'check-backend', 'install', 'start', 'stop', 'status', 'logs', 'uninstall',
                                                 'prepare-gpu-upgrade', 'apply-gpu-upgrade'))
    parser.add_argument('--lines', type=int, default=100)
    parser.add_argument('--operation', type=Path, help='Fresh private GPU-only generation migration directory')
    parser.add_argument('--selection', type=Path, help='Closed owner-private GPU upgrade selection')
    parser.add_argument('--plan-sha256', help='Exact prepared GPU-only plan digest')
    args = parser.parse_args(argv)
    os.umask(0o077)
    service = WorkerService(args.config)
    try:
        if args.action in ('prepare-gpu-upgrade', 'apply-gpu-upgrade'):
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
        elif args.action == 'install': result = service.install()
        elif args.action == 'logs':
            if not 1 <= args.lines <= 1000: raise ValueError('Log lines must be 1..1000')
            result = service.run(['journalctl', '--user', '--unit', UNIT, '--lines', str(args.lines), '--no-pager'])
            if result.returncode: raise RuntimeError('Broker journal unavailable')
            print(result.stdout, end=''); return 0
        else: result = service.action(args.action)
        print(json.dumps(result)); return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print('Worker service operation refused; verify private policy, local engine capabilities and reviewed installation.', file=sys.stderr)
        return 1


if __name__ == '__main__': raise SystemExit(main())
