"""Fixed owner-local image-pin maintenance; never starts or stops a worker.

Startup uses the bounded current-image reader independently of a maintenance
operation. A gate constructed before a completed image switch must not recover
or create using its old in-memory image after the durable fence disappears.
"""
from contextlib import contextmanager
import copy
import fcntl
import os
from pathlib import Path
import re
import stat
import time

from .worker_service_upgrade import private, stamp, exclusive, sync, encoded, digest, directory_lock
from . import worker_resource_reservations as R
from .worker_resource_reservations import need

PURPOSE = 'reverie-worker-image-switch-v1'
FACTORY_FILES = frozenset({'flake.nix', 'nix/image.nix', 'nix/human-terminal-toolkit.nix',
    'nix/worker-idmap.nix', 'nix/worker-idmap.py', 'nix/worker-base-tools.nix',
    'python/reverie/human_terminal_static.c', 'python/reverie/worker_image_provenance.py',
    'python/reverie/website_image_provenance.py', 'python/reverie/__init__.py',
    'nix/worker-image-provenance.nix'})
MANAGER_FIELDS = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'Job',
                  'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'ExecStartPre', 'ExecStart')


def _loaded_program(raw, expected):
    """Decode one systemd show record; loaded path/argv must match the unit.

    Timestamps and execution status are bounded history, not startup authority.
    Multiple commands, duplicate/unknown fields and alternate argv refuse.
    """
    need(type(raw) is str and len(raw) <= 16384 and raw.startswith('{ ') and raw.endswith(' }'),
         'WORKER_IMAGE_LOADED_PROGRAM_ENCODING')
    fields = {}
    for field in raw[2:-2].split(' ; '):
        key, separator, value = field.partition('=')
        need(separator and key not in fields, 'WORKER_IMAGE_LOADED_PROGRAM_ENCODING')
        fields[key] = value
    need(set(fields) == {'path', 'argv[]', 'ignore_errors', 'start_time', 'stop_time', 'pid', 'code', 'status'},
         'WORKER_IMAGE_LOADED_PROGRAM_ENCODING')
    argv = expected + ' --config ${REVERIE_WORKER_CONFIG}'
    need(fields['path'] == expected and fields['argv[]'] == argv and fields['ignore_errors'] == 'no',
         'WORKER_IMAGE_LOADED_PROGRAM_MISMATCH')
    for name in ('start_time', 'stop_time'):
        value = fields[name]
        need(2 <= len(value) <= 256 and value.startswith('[') and value.endswith(']') and
             not any(c in value for c in '\r\n\x00;{}'), 'WORKER_IMAGE_LOADED_PROGRAM_ENCODING')
    need(re.fullmatch('[0-9]{1,10}', fields['pid']) and int(fields['pid']) < 2147483648 and
         re.fullmatch('[A-Za-z0-9_().+-]{1,32}', fields['code']) and
         re.fullmatch('[0-9]{1,10}(?:/[A-Za-z0-9_-]{1,32})?', fields['status']),
         'WORKER_IMAGE_LOADED_PROGRAM_ENCODING')
    return {'path': expected, 'argv': [expected, '--config', '${REVERIE_WORKER_CONFIG}']}


def _signature(st):
    return [st.st_dev, st.st_ino, st.st_uid, stat.S_IMODE(st.st_mode),
            st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def _publish_fence(gate, value):
    """Return the actual writer FD identity, never adopt a later named file."""
    path = R.pending(gate.broker.config)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)
    try:
        raw = encoded(value)
        while raw:
            count = os.write(descriptor, raw)
            need(count > 0, 'WORKER_IMAGE_PENDING_WRITE')
            raw = raw[count:]
        os.fsync(descriptor)
        info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
             stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
             'WORKER_IMAGE_PENDING_CUSTODY')
        identity = _signature(info)
    finally:
        os.close(descriptor)
    sync(path.parent)
    need(stamp(path) == identity, 'WORKER_IMAGE_PENDING_CHANGED')
    return identity


class _Transition:
    def __init__(self, gate, fence, rows):
        self.gate, self.fence, self.rows = gate, fence, rows
        self.pid = os.getpid()


def owns_pending(gate):
    record = getattr(gate._local, 'image_switch', None)
    return (type(record) is _Transition and record.gate is gate and
            record.pid == os.getpid() and
            getattr(gate._local, 'depth', 0) == 1 and
            stamp(R.pending(gate.broker.config)) == record.fence)


def check_transition_rows(gate, rows):
    record = getattr(gate._local, 'image_switch', None)
    need(owns_pending(gate) and rows == record.rows,
         'WORKER_IMAGE_NATIVE_CHANGED')


def capture_current_image(broker):
    path = getattr(broker, 'config_file', None)
    if path is None:
        return None  # Existing embedded/test adapters do not claim a file binding.
    path = Path(path)
    before = stamp(path)
    from .worker_image import strict_json
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
             info.st_nlink == 1 and not info.st_mode & 0o077 and info.st_size <= 1 << 20,
             'WORKER_IMAGE_CONFIGURATION_CUSTODY')
        need(_signature(info) == before, 'WORKER_IMAGE_CONFIGURATION_CHANGED')
        raw = bytearray()
        while len(raw) <= 1 << 20:
            part = os.read(descriptor, min(65536, (1 << 20) + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        need(len(raw) == info.st_size <= 1 << 20 and _signature(os.fstat(descriptor)) == before,
             'WORKER_IMAGE_CONFIGURATION_CHANGED')
        value = strict_json(raw)
    finally:
        os.close(descriptor)
    need(type(value) is dict and value.get('image') == broker.config['image'],
         'WORKER_IMAGE_CONFIGURATION_STALE')
    need(stamp(path) == before, 'WORKER_IMAGE_CONFIGURATION_CHANGED')
    return path, before


def image_still_current(captured):
    if captured is not None:
        path, expected = captured
        need(stamp(path) == expected, 'WORKER_IMAGE_CONFIGURATION_CHANGED')


class WorkerImageSwitch:
    """Preview without a hold; fresh apply fences one image-only publication.

    No native provider or executable is supplied by input. The registered
    WorkerService contributes only fixed, bounded metadata client calls.
    """
    def __init__(self, service, operation):
        from .worker_service import WorkerService
        need(type(service) is WorkerService and os.getuid() == os.geteuid() > 0,
             'WORKER_IMAGE_ORDINARY_OWNER')
        need(isinstance(service.config_path, Path) and service.config_path.is_absolute() and
             service.config_path.resolve(strict=True) == service.config_path,
             'WORKER_IMAGE_CANONICAL_CONFIG_REQUIRED')
        self.service, self.operation = service, Path(operation)
        fd, self.operation_identity = R._directory(self.operation, os.getuid())
        os.close(fd)
        self.deadline = time.monotonic() + 120

    def _time(self, plan=None):
        need(time.monotonic() < self.deadline, 'WORKER_IMAGE_DEADLINE')
        if plan is not None:
            need(type(plan.get('expiresAt')) is int and time.time() < plan['expiresAt'],
                 'WORKER_IMAGE_PLAN_EXPIRED')

    def _run(self, args):
        self._time()
        result = self.service.run(args, deadline=self.deadline)
        self._time()
        return result

    def _selection(self, path):
        from .worker_image import strict_json, IMAGE
        value = strict_json(private(Path(path), maximum=65536))
        need(type(value) is dict and set(value) == {'oldImage', 'newImage', 'deploymentPath', 'profile'},
             'WORKER_IMAGE_SELECTION')
        need(all(type(value[k]) is str and IMAGE.fullmatch(value[k]) for k in ('oldImage', 'newImage'))
             and value['oldImage'] != value['newImage'], 'WORKER_IMAGE_EXACT_DISTINCT_IDS')
        pair = value['profile']
        need(type(pair) is dict and set(pair) == {'path', 'sha256'} and
             type(pair['path']) is str and type(pair['sha256']) is str and
             re.fullmatch('[a-f0-9]{64}', pair['sha256']), 'WORKER_IMAGE_PROFILE_PAIR')
        need(type(value['deploymentPath']) is str, 'WORKER_IMAGE_DEPLOYMENT_PATH')
        deployment = Path(value['deploymentPath'])
        need(deployment.is_absolute() and
             deployment.resolve(strict=True) == deployment and deployment.name == 'deployment.json',
             'WORKER_IMAGE_DEPLOYMENT_PATH')
        return value

    @contextmanager
    def _maintenance(self, selection):
        from .worker_image import strict_json
        from .resource_actor_bootstrap import _parents, _parents_current
        deployment = Path(selection['deploymentPath'])
        raw = private(deployment); signature = stamp(deployment)
        value = strict_json(raw)
        lock = deployment.parent / 'runtime/update-state/update.lock'
        override = os.environ.get('REVERIE_UPDATE_STATE_DIR')
        need(override is None or str(Path(override)) == str(lock.parent),
             'WORKER_IMAGE_MAINTENANCE_OVERRIDE')
        fd, _ = R._directory(lock.parent, os.getuid()); os.close(fd)
        parents = _parents([deployment, lock])
        named = lock.lstat(); named_identity = [named.st_dev, named.st_ino]
        descriptor = os.open(lock, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        def current():
            info = os.fstat(descriptor); named = lock.lstat()
            need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and
                 info.st_uid == os.getuid() and info.st_nlink == 1 and
                 [info.st_dev, info.st_ino] == named_identity == [named.st_dev, named.st_ino],
                 'WORKER_IMAGE_MAINTENANCE_LOCK_CHANGED')
            _parents_current(parents)
            need(stamp(deployment) == signature, 'WORKER_IMAGE_DEPLOYMENT_CHANGED')
        try:
            current(); fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB); current()
            yield {'path': str(deployment), 'sha256': digest(raw), 'value': value,
                   'signature': signature, 'lock': str(lock),
                   'lockIdentity': [os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino],
                   'parents': parents}
            current(); self._time()
        finally:
            os.close(descriptor)

    def _context(self, selection, maintenance):
        from .worker import load_config
        config = load_config(self.service.config_path)
        need(config['uid'] == os.getuid() and config['gid'] == os.getgid(), 'WORKER_IMAGE_ORDINARY_OWNER')
        need(R.option(config) is not None, 'WORKER_IMAGE_EXISTING_R_REQUIRED')
        deployment = maintenance['value']
        from .worker_deployment import company_file
        from .resource_actor_bootstrap import _parents, _parents_current
        selected = company_file(config, deployment, 'WORKER_IMAGE_DEPLOYMENT_BINDING')
        company_parents = _parents([selected])
        need(all(name not in maintenance['parents'] or maintenance['parents'][name] == identity
                 for name, identity in company_parents.items()), 'WORKER_IMAGE_DEPLOYMENT_BINDING')
        maintenance['parents'].update(company_parents)
        _parents_current(maintenance['parents'])
        need('resourceActorConfig' not in config and not os.path.lexists(
             self.service.home / '.config/systemd/user/reverie-owner-terminal.service'),
             'WORKER_IMAGE_INSTALLED_CONSUMER_REQUIRES_MAINTENANCE')
        probe = self.service.resource_probe(config)
        gate = R.ReservationGate(probe)
        need(not self.service.config_path.is_relative_to(gate.root), 'WORKER_IMAGE_CONFIG_IN_R_ROOT')
        need(not any(R._overlap(self.operation, Path(config[k])) for k in
                     ('stateRoot', 'scratchRoot', 'companyRoot', 'apiSocketRoot')) and
             not R._overlap(self.operation, gate.root), 'WORKER_IMAGE_OPERATION_LOCATION')
        gate.native.custody(self.operation, R.marker(config), deadline=self.deadline)
        gate.native.custody(Path(maintenance['lock']).parent, Path(maintenance['path']), deadline=self.deadline)
        return gate

    def _registration(self):
        from .worker_service_upgrade import unit_record
        from .worker_service import environment_selection
        service = self.service
        need(service.unit.is_symlink() and service.gcroot.is_symlink() and
             service.unit.lstat().st_uid == service.gcroot.lstat().st_uid == os.getuid(),
             'WORKER_IMAGE_REGISTERED_SERVICE_REQUIRED')
        links = {str(p): stamp(p) for p in (service.unit, service.gcroot)}
        installed = service.unit.resolve(strict=True)
        need(installed == service.target_unit(), 'WORKER_IMAGE_MATCHING_GENERATION_REQUIRED')
        links[str(service.environment)] = stamp(service.environment)
        selected = unit_record(service, installed)
        need(service.gcroot.resolve(strict=True) == Path(selected['root']) and
             private(service.environment) == environment_selection(service.config_path).encode(),
             'WORKER_IMAGE_REGISTERED_CONFIG_CHANGED')
        manager = self._loaded_manager(selected)
        need(all(stamp(Path(p)) == identity for p, identity in links.items()),
             'WORKER_IMAGE_REGISTERED_CONFIG_CHANGED')
        return {'unit': selected, 'links': links, 'manager': manager}

    def _loaded_manager(self, selected):
        from .worker_service import UNIT
        result = self._run(['systemctl', '--user', 'show', UNIT, '--all', '--no-pager',
                            '--property=' + ','.join(MANAGER_FIELDS)])
        need(result.returncode == 0 and type(result.stdout) is str and len(result.stdout.encode()) <= 65536,
             'WORKER_IMAGE_LOADED_MANAGER_ENCODING')
        fields = {}
        for line in result.stdout.splitlines():
            name, separator, value = line.partition('=')
            need(separator and name in MANAGER_FIELDS and name not in fields,
                 'WORKER_IMAGE_LOADED_MANAGER_ENCODING')
            fields[name] = value
        need(set(fields) == set(MANAGER_FIELDS), 'WORKER_IMAGE_LOADED_MANAGER_ENCODING')
        need(fields['Id'] == UNIT and fields['LoadState'] == 'loaded' and
             fields['ActiveState'] == 'inactive' and fields['SubState'] == 'dead' and
             fields['MainPID'] == fields['ControlPID'] == '0' and fields['Job'] in ('', '0') and
             fields['DropInPaths'] == '' and fields['NeedDaemonReload'] == 'no' and
             fields['FragmentPath'] in (str(self.service.unit), selected['path']),
             'WORKER_IMAGE_LOADED_MANAGER_MISMATCH')
        programs = {name: _loaded_program(fields.pop(name), selected['entries'][name]['path'])
                    for name in ('ExecStartPre', 'ExecStart')}
        return {'properties': fields, 'programs': programs}

    def _idle(self, gate):
        from .worker_host_job import require_idle
        require_idle(gate)
        need(not gate.active_operations(gate._document()), 'WORKER_IMAGE_RETAINED_WORK')
        need(not os.path.lexists(gate.broker.config['socket']), 'WORKER_IMAGE_BROKER_SOCKET_PRESENT')

    def _stores(self, gate):
        names = [gate.root, gate.root / 'profiles', gate.root / 'operations',
                 R.marker(gate.broker.config), gate.root / 'admission.lock',
                 gate.root / 'profiles/profiles.lock', gate.root / 'profiles/profiles.json',
                 gate.root / 'operations/operations.lock', gate.root / 'operations/operations.json']
        return {str(p): stamp(p) if os.path.lexists(p) else None for p in names}

    def _snapshot(self, gate, selection, maintenance):
        from .worker_image import WorkerImageUpdate
        self._idle(gate)
        registration = self._registration()
        profile = self._profile(selection, gate.broker.config)
        core = WorkerImageUpdate(self.service.config_path, home=self.service.home, run=self._run)
        plan = core.plan(selection['oldImage'], selection['newImage'])
        rows = gate._guard()
        stores = self._stores(gate)
        need(self._registration() == registration, 'WORKER_IMAGE_REGISTERED_CONFIG_CHANGED')
        self._idle(gate)
        self._time()
        return {'kind': PURPOSE, 'selection': selection, 'maintenance': maintenance,
                'registration': registration, 'profile': profile, 'core': plan,
                'rows': rows, 'stores': stores, 'operationIdentity': self.operation_identity}

    def _profile(self, selection, config):
        from .website_image_provenance import immutable, decode, verify_image_spec
        from .owner_terminal_toolkit import immutable_manifest
        from .worker_image import WorkerImageUpdate
        import hashlib
        pair = selection['profile']
        path = immutable(pair['path'], 4 << 20); raw = path.read_bytes()
        identity = stamp(path)
        need(digest(raw) == pair['sha256'], 'WORKER_IMAGE_PROVENANCE_CHANGED')
        value = decode(raw)
        need(type(value) is dict and set(value) == {'version', 'purpose', 'archiveConfigSHA256',
             'imageSpec', 'archive', 'factory', 'source', 'toolkit'} and
             type(value['version']) is int and value['version'] == 1 and
             value['purpose'] == 'worker-image-provenance-v1', 'WORKER_IMAGE_FIXED_PROVENANCE_REQUIRED')
        factory = value['factory']
        need(type(factory) is dict and set(factory) == {'name', 'system', 'uid', 'gid',
             'subuidStart', 'subgidStart', 'subidCount', 'browser'} and
             factory['name'] == 'lib.workerDockerImage' and
             factory['system'] == {'x86_64': 'x86_64-linux', 'aarch64': 'aarch64-linux'}.get(os.uname().machine) and
             type(factory['browser']) is bool and
             all(type(factory[k]) is int and factory[k] > 0 for k in
                 ('uid', 'gid', 'subuidStart', 'subgidStart', 'subidCount')) and
             factory['uid'] < 2147483648 and factory['gid'] < 2147483648 and
             factory['subidCount'] >= 65536 and
             factory['subuidStart'] + factory['subidCount'] < 4294967295 and
             factory['subgidStart'] + factory['subidCount'] < 4294967295 and
             not factory['subuidStart'] <= factory['uid'] < factory['subuidStart'] + factory['subidCount'] and
             not factory['subgidStart'] <= factory['gid'] < factory['subgidStart'] + factory['subidCount'] and
             factory['uid'] == config['uid'] and factory['gid'] == config['gid'],
             'WORKER_IMAGE_FACTORY_IDENTITY')
        spec = value['imageSpec']
        need(type(spec) is dict and set(spec) == {'Config', 'RootFS', 'Architecture', 'Os', 'Created'} and
             type(spec['Config']) is dict and type(spec['RootFS']) is dict and
             spec['Architecture'] == {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(os.uname().machine) and
             spec['Os'] == 'linux' and
             type(value['archiveConfigSHA256']) is str and
             re.fullmatch('[a-f0-9]{64}', value['archiveConfigSHA256']), 'WORKER_IMAGE_SPEC_SCHEMA')
        image_config = spec['Config']; labels = image_config.get('Labels') or {}
        need(type(labels) is dict, 'WORKER_IMAGE_FACTORY_LABELS')
        wanted = {'reverie.worker.nix-store': '1', 'org.reverie.worker.rootless-docker': '1',
                  'org.reverie.worker.rootless-docker.mount-layout': '1',
                  'org.reverie.worker.uid': str(factory['uid']), 'org.reverie.worker.gid': str(factory['gid']),
                  'org.reverie.worker.subuid-start': str(factory['subuidStart']),
                  'org.reverie.worker.subgid-start': str(factory['subgidStart']),
                  'org.reverie.worker.subid-count': str(factory['subidCount'])}
        need(image_config.get('User') == str(config['uid']) + ':' + str(config['gid']) and
             image_config.get('Entrypoint') == ['/bin/sleep'] and image_config.get('Cmd') == ['infinity'] and
             image_config.get('WorkingDir') == '/reverie_workspace' and
             all(labels.get(k) == v for k, v in wanted.items()) and
             (labels.get('org.reverie.worker.browser') == '1' if factory['browser'] else
              'org.reverie.worker.browser' not in labels),
             'WORKER_IMAGE_FACTORY_LABELS')
        archive = value['archive']
        need(type(archive) is dict and set(archive) == {'path', 'sha256', 'bytes'} and
             type(archive['path']) is str and archive['path'].startswith('/nix/store/') and
             type(archive['sha256']) is str and re.fullmatch('[a-f0-9]{64}', archive['sha256']) and
             type(archive['bytes']) is int and 0 < archive['bytes'] <= 16 << 30,
             'WORKER_IMAGE_ARCHIVE_BINDING')
        # The fixed producer checks archive bytes. Runtime compares full native
        # Config+RootFS; it does not rehash a multi-GB archive on every fence.
        source = value['source']
        need(type(source) is dict and set(source) == {'path', 'factoryFiles'} and
             type(source['path']) is str and Path(source['path']).is_relative_to('/nix/store') and
             Path(source['path']).resolve(strict=True) == Path(source['path']) and
             type(source['factoryFiles']) is dict and set(source['factoryFiles']) == FACTORY_FILES,
             'WORKER_IMAGE_SOURCE_BINDING')
        leaves = {}; total = 0
        for name, pin in source['factoryFiles'].items():
            need(type(name) is str, 'WORKER_IMAGE_SOURCE_BINDING')
            relative = Path(name)
            need(not relative.is_absolute() and '..' not in relative.parts and
                 str(relative) == name and type(pin) is dict and set(pin) == {'sha256', 'bytes'},
                 'WORKER_IMAGE_SOURCE_BINDING')
            file = immutable(Path(source['path']) / relative, 1 << 20, allow_empty=True)
            data = file.read_bytes(); total += len(data)
            need(total <= 32 << 20 and type(pin['bytes']) is int and pin['bytes'] == len(data) and
                 pin['sha256'] == hashlib.sha256(data).hexdigest(), 'WORKER_IMAGE_SOURCE_CHANGED')
            leaves[str(file)] = stamp(file)
        toolkit = value['toolkit']
        need(type(toolkit) is dict and set(toolkit) == {'manifest', 'version', 'static', 'files'},
             'WORKER_IMAGE_TOOLKIT_BINDING')
        manifest = toolkit['manifest']
        need(type(manifest) is dict and set(manifest) == {'path', 'sha256', 'bytes'} and
             type(manifest['path']) is str and type(manifest['sha256']) is str and
             re.fullmatch('[a-f0-9]{64}', manifest['sha256']) and
             type(manifest['bytes']) is int and 0 < manifest['bytes'] <= 8192,
             'WORKER_IMAGE_TOOLKIT_BINDING')
        file = immutable(manifest['path'], 8192)
        data = file.read_bytes()
        need(len(data) == manifest['bytes'] and digest(data) == manifest['sha256'] and
             immutable_manifest(file) == {k: toolkit[k] for k in ('version', 'static', 'files')},
             'WORKER_IMAGE_TOOLKIT_CHANGED')
        leaves[str(file)] = stamp(file)
        core = WorkerImageUpdate(self.service.config_path, home=self.service.home, run=self._run)
        args, engine, endpoint = core._engine()
        actual = decode(core._call([*args, 'image', 'inspect', '--format', '{{json .}}', selection['newImage']],
                                  'loaded-image-unavailable'))
        need(verify_image_spec(value, actual) == selection['newImage'], 'WORKER_IMAGE_LOADED_PROFILE_MISMATCH')
        old = decode(core._call([*args, 'image', 'inspect', '--format', '{{json .}}', selection['oldImage']],
                               'loaded-image-unavailable'))
        need(type(old) is dict, 'WORKER_IMAGE_EXISTING_PROFILE_UNQUALIFIED')
        previous = old.get('Config')
        need(old.get('Id') == selection['oldImage'] and type(previous) is dict and
             previous.get('User') == image_config['User'] and type(previous.get('Labels')) is dict and
             all(previous['Labels'].get(k) == v for k, v in wanted.items()) and
             (previous['Labels'].get('org.reverie.worker.browser') == '1' if factory['browser'] else
              'org.reverie.worker.browser' not in previous['Labels']),
             'WORKER_IMAGE_EXISTING_PROFILE_UNQUALIFIED')
        from .resource_actor_bootstrap import _leaves
        _leaves(leaves); need(stamp(path) == identity, 'WORKER_IMAGE_PROVENANCE_CHANGED')
        return {'manifestSHA256': pair['sha256'], 'actualImageId': actual['Id'], 'engineId': engine,
                'engineEndpointDigest': endpoint, 'factory': factory,
                'toolkitManifestSHA256': manifest['sha256']}

    def prepare(self, selection_path):
        with directory_lock(self.operation):
            need({p.name for p in self.operation.iterdir()} == {'operation.lock'},
                 'WORKER_IMAGE_OPERATION_USED')
            selected = self._selection(selection_path)
            with self._maintenance(selected) as maintenance:
                gate = self._context(selected, maintenance)
                with gate.admission(deadline=self.deadline):
                    plan = self._snapshot(gate, selected, maintenance)
                    plan['expiresAt'] = int(time.time()) + 300
                    exclusive(self.operation / 'PLAN.json', encoded(plan))
        # A preview never publishes pending, changes config, or leaves a hold.
        return {'planSHA256': digest(private(self.operation / 'PLAN.json', maximum=8 << 20)),
                'imageChanged': False, 'maintenanceHeld': False, 'started': False}

    def apply(self, expected):
        from .worker_image import WorkerImageUpdate, strict_json
        record = None; gate = None; attempted = False
        try:
            with directory_lock(self.operation):
                need(type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected),
                     'WORKER_IMAGE_PLAN_DIGEST')
                need(not os.path.lexists(self.operation / 'ATTEMPT.json'), 'WORKER_IMAGE_ATTEMPT_USED')
                raw = private(self.operation / 'PLAN.json', maximum=8 << 20)
                need(digest(raw) == expected, 'WORKER_IMAGE_PLAN_DIGEST')
                plan = strict_json(raw)
                need(type(plan) is dict and set(plan) == {'kind', 'selection', 'maintenance',
                     'registration', 'profile', 'core', 'rows', 'stores', 'operationIdentity', 'expiresAt'} and
                     plan.get('kind') == PURPOSE, 'WORKER_IMAGE_PLAN_SCHEMA')
                self._time(plan)
                # Parse the exact original selection through the closed reader.
                selection_path = self.operation / 'SELECTION.checked.json'
                exclusive(selection_path, encoded(plan['selection']))
                selection = self._selection(selection_path)
                with self._maintenance(selection) as maintenance:
                    gate = self._context(selection, maintenance)
                    with gate.admission(deadline=self.deadline):
                        fresh = self._snapshot(gate, selection, maintenance)
                        need(fresh == {k: v for k, v in plan.items() if k != 'expiresAt'},
                             'WORKER_IMAGE_PLAN_CHANGED')
                        exclusive(self.operation / 'ATTEMPT.json', encoded({'purpose': PURPOSE,
                                  'planSHA256': expected}))
                        attempted = True
                        fence = {'schema': PURPOSE, 'operation': str(self.operation),
                                 'planSHA256': expected, 'beforeConfigSHA256': plan['core']['configSha256']}
                        fence_identity = _publish_fence(gate, fence)
                        record = _Transition(gate, fence_identity, copy.deepcopy(plan['rows']))
                        gate._local.image_switch = record
                        self._verify(gate, plan, expected, record, plan['core']['configSha256'])
                        core = WorkerImageUpdate(self.service.config_path, home=self.service.home, run=self._run)
                        result = core.apply(selection['oldImage'], selection['newImage'],
                                            expect_config_sha256=plan['core']['configSha256'],
                                            expect_plan_digest=plan['core']['planDigest'])
                        actual = private(self.service.config_path)
                        need(result['state'] == 'committed' and
                             result['afterSha256'] == 'sha256:' + digest(actual), 'WORKER_IMAGE_READBACK')
                        candidate = strict_json(actual)
                        need(candidate == {**gate.broker.config, 'image': selection['newImage']},
                             'WORKER_IMAGE_NONIMAGE_CHANGE')
                        gate.broker.config = candidate
                        final_config = stamp(self.service.config_path)
                        self._verify(gate, plan, expected, record, result['afterSha256'])
            # Both held lock scopes and all fallible FD finalizers have settled.
            # The durable fence still blocks cold service/broker admission.
            self._verify(gate, plan, expected, record, result['afterSha256'], held=False)
            exclusive(self.operation / 'RESULT.json', encoded({'state': 'IMAGE_PIN_COMMITTED',
                      'planSHA256': expected, 'receipt': result, 'started': False,
                      'acceptanceRequiresPendingAbsent': True}))
            # RESULT publication can block/fail. Reobserve before terminal leaves;
            # neither a receipt nor its filename can release the fence.
            self._verify(gate, plan, expected, record, result['afterSha256'], held=False)
            from .resource_actor_bootstrap import _parents_current, _leaves
            _parents_current(plan['maintenance']['parents'])
            _leaves(plan['stores'])
            need(stamp(self.service.config_path) == final_config and
                 stamp(R.pending(gate.broker.config)) == record.fence,
                 'WORKER_IMAGE_FINAL_FILES_CHANGED')
            self._time(plan)
            os.unlink(R.pending(gate.broker.config))  # Last operation; no automatic retry/restore.
            return {'state': 'IMAGE_PIN_COMMITTED', 'newImage': selection['newImage'],
                    'started': False, 'fleetRecreated': False, 'toolkitNativeQualified': False}
        except BaseException:
            if attempted:
                raise RuntimeError('WORKER_IMAGE_RECONCILIATION_REQUIRED') from None
            raise
        finally:
            if gate is not None:
                gate._local.image_switch = None

    def _verify(self, gate, plan, expected, record, config_sha, *, held=True):
        from .worker_image import WorkerImageUpdate
        from .resource_actor_bootstrap import _parents_current, _leaves
        config_raw = private(self.service.config_path)
        config_stamp = stamp(self.service.config_path)
        need('sha256:' + digest(config_raw) == config_sha, 'WORKER_IMAGE_CONFIGURATION_CHANGED')
        plan_raw = private(self.operation / 'PLAN.json', maximum=8 << 20)
        plan_stamp = stamp(self.operation / 'PLAN.json')
        need(digest(plan_raw) == expected, 'WORKER_IMAGE_FINAL_FILES_CHANGED')
        captured = capture_current_image(gate.broker)
        core = WorkerImageUpdate(self.service.config_path, home=self.service.home, run=self._run)
        core._inactive()
        need(self._registration() == plan['registration'], 'WORKER_IMAGE_REGISTERED_CONFIG_CHANGED')
        need(self._profile(plan['selection'], gate.broker.config) == plan['profile'],
             'WORKER_IMAGE_PROFILE_CHANGED')
        # Fixed image/manager/profile producers finish before final inventory.
        if held:
            self._idle(gate)
            need(gate._guard() == plan['rows'], 'WORKER_IMAGE_NATIVE_CHANGED')
        else:
            rows = gate.native.custody(gate.root, R.marker(gate.broker.config), deadline=self.deadline)
            need(rows == plan['rows'], 'WORKER_IMAGE_NATIVE_CHANGED')
        _parents_current(plan['maintenance']['parents']); _leaves(plan['stores'])
        need(stamp(R.pending(gate.broker.config)) == record.fence and
             stamp(self.operation / 'PLAN.json') == plan_stamp and
             stamp(self.service.config_path) == config_stamp,
             'WORKER_IMAGE_FINAL_FILES_CHANGED')
        image_still_current(captured)
        self._time(plan)
