"""Private native reservation observation and a refusal-only launch barrier.

This first slice does not authenticate browser approvals or implement resource
prepare/start/verify, profile publication, settlement, credit or an HTTP API.
Only the fixed host broker composes these objects. A claim is never a launch
permission. Provisioning is an explicit inactive-service installation operation.
"""
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import threading
import time

from . import laptop_resource_operations as journal
from .employee_resource_profiles import ProfileStore
from .worker_resources import RESOURCE_FIELDS, effective_config, policy_digest, validate_resource_reload
from .worker_storage import read_metadata, storage_paths, storage_start_allowed
from .worker_cold_tmp import read_mount_table, _mount_location

MIB = 1048576
PROC = Path('/proc')
CGROUP = Path('/sys/fs/cgroup')
BINDING = 'resource-reservation-control.json'
MAX_CONTAINERS = 2048
MAX_NATIVE_BYTES = 8 * MIB
# Deliberately omit Env, command/arguments, logs and credential-bearing config.
ENGINE_FORMAT = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
    '"Config":{"Labels":{{json .Config.Labels}}},'
    '"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}}},'
    '"Mounts":{{json .Mounts}},"HostConfig":{'
    '"Memory":{{json .HostConfig.Memory}},"MemorySwap":{{json .HostConfig.MemorySwap}},'
    '"PidsLimit":{{json .HostConfig.PidsLimit}},"NanoCpus":{{json .HostConfig.NanoCpus}}}}')


class Refused(ValueError):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def option(config):
    value = config.get('resourceReservations')
    if value is None:
        need('resourceReservations' not in config, 'RESERVATION_OPTION_SCHEMA')
        return None
    need(type(value) is dict and set(value) == {
        'directory', 'companyId', 'poolId', 'ownerScopeDigest', 'hostReserveMiB'},
        'RESERVATION_OPTION_SCHEMA')
    for key in ('companyId', 'poolId'):
        journal.canonical_uuid(value[key])
    journal.digest(value['ownerScopeDigest'])
    need(type(value['directory']) is str, 'RESERVATION_CONTROL_PATH')
    path = Path(value['directory'])
    need(path.is_absolute() and path.anchor == '/'
         and str(path) == value['directory'] and '..' not in path.parts
         and not any(ord(c) < 32 for c in str(path)), 'RESERVATION_CONTROL_PATH')
    need(type(value['hostReserveMiB']) is int and 1 <= value['hostReserveMiB'] <= 1048576,
         'RESERVATION_HOST_RESERVE')
    return copy.deepcopy(value)


def marker(config):
    return Path(config['stateRoot']) / BINDING


def pending(config):
    return marker(config).with_suffix('.pending')


def configured(config):
    if option(config) is not None:
        return True
    # Existing transport/shutdown composition may supply only its own fields.
    # Actual production load_config still requires stateRoot; absence of this
    # optional feature must not impose a new constructor contract on that path.
    return 'stateRoot' in config and (os.path.lexists(marker(config)) or os.path.lexists(pending(config)))


def domain_digest(config):
    # Match the existing reload boundary; a restart cannot silently rebind the
    # same control journal to another company file, storage or mount domain.
    ignored = RESOURCE_FIELDS | {'sessionResources', 'employeeResources', 'image'}
    return journal.fingerprint({k: v for k, v in config.items() if k not in ignored})


def _directory(path, uid):
    """Anchor every component, allowing only root-owned sticky public ancestors."""
    path = Path(path)
    need(path.is_absolute() and path.anchor == '/' and '..' not in path.parts,
         'RESERVATION_CONTROL_PATH')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=fd)
            os.close(fd)
            fd = child
            st = os.fstat(fd)
            sticky = st.st_uid == 0 and bool(st.st_mode & stat.S_ISVTX)
            need(st.st_uid in (0, uid) and (not st.st_mode & 0o022 or sticky),
                 'RESERVATION_CONTROL_ANCESTOR')
        st = os.fstat(fd)
        need(st.st_uid == uid and stat.S_IMODE(st.st_mode) == 0o700,
             'RESERVATION_CONTROL_DIRECTORY')
        return fd, [st.st_dev, st.st_ino]
    except BaseException:
        os.close(fd)
        raise


def _file(path, uid):
    value = read_metadata(str(path), uid, limit=journal.MAX_BYTES)
    st = path.lstat()
    need(stat.S_IMODE(st.st_mode) == 0o600, 'RESERVATION_PRIVATE_FILE')
    return value


def _write_exclusive(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        data = journal.encode(value)
        while data:
            n = os.write(fd, data)
            need(n > 0, 'RESERVATION_SHORT_WRITE')
            data = data[n:]
        os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def _read(path, maximum=65536):
    with path.open('rb') as stream:
        raw = stream.read(maximum + 1)
    need(len(raw) <= maximum, 'RESERVATION_NATIVE_BOUND')
    return raw.decode('ascii')


def _pid(pid):
    need(type(pid) is int and pid > 0, 'RESERVATION_NATIVE_PID')
    fields = _read(PROC / str(pid) / 'stat').rsplit(')', 1)[1].split()
    return fields[19]


def _identity(path):
    fd = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        need(stat.S_ISDIR(st.st_mode), 'RESERVATION_NATIVE_STORAGE_DIRECTORY')
        return [st.st_dev, st.st_ino, st.st_uid, st.st_gid]
    finally:
        os.close(fd)


def _coordinates(path, table):
    # The install-time marker may not yet exist. Its private existing parent is
    # anchored separately; compare the precise future leaf, not its broad parent.
    existing = path
    while not os.path.lexists(existing):
        existing = existing.parent
    device, root = _mount_location(existing, table)
    return device, root / path.relative_to(existing)


def _overlap(a, b):
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


class NativeObserver:
    """Fixed read-only broker engine/kernel producer, never a wire callback."""
    def __init__(self, broker):
        self.broker = broker

    def host_root(self):
        """Qualify a full hierarchy; a namespaced/mounted subroot is not max."""
        mounts = [r for r in read_mount_table() if r['point'] == CGROUP]
        need(len(mounts) == 1 and mounts[0]['root'] == Path('/'), 'RESERVATION_HOST_HIERARCHY_REQUIRED')
        types = []
        for row in _read(PROC / 'self/mountinfo', MIB).splitlines():
            fields = row.split()
            if fields and fields[0] == str(mounts[0]['id']):
                types.append(fields[fields.index('-') + 1])
        need(types == ['cgroup2'] and not os.path.lexists(CGROUP / 'memory.current') and
             not os.path.lexists(CGROUP / 'pids.current'), 'RESERVATION_HOST_HIERARCHY_REQUIRED')
        need({'memory', 'pids'} <= set(_read(CGROUP / 'cgroup.controllers').split()),
             'RESERVATION_HOST_CONTROLLERS_REQUIRED')
        groups = _read(PROC / 'self/cgroup').splitlines()
        need(len(groups) == 1 and groups[0].startswith('0::/'), 'RESERVATION_HOST_HIERARCHY_REQUIRED')
        relative = Path(groups[0][4:])
        need(str(relative) != '.' and not relative.is_absolute() and '..' not in relative.parts,
             'RESERVATION_HOST_HIERARCHY_REQUIRED')
        for name in ('memory.current', 'pids.current'):
            raw = _read(CGROUP / relative / name, 128).strip()
            need(raw.isascii() and raw.isdecimal(), 'RESERVATION_HOST_OBSERVER_COUNTERS_REQUIRED')
        facts = {}
        for line in _read(PROC / 'meminfo').splitlines():
            key, _, rest = line.partition(':')
            if key in ('MemTotal', 'MemAvailable'):
                fields = rest.split()
                need(key not in facts and len(fields) == 2 and fields[1] == 'kB' and
                     fields[0].isascii() and fields[0].isdecimal() and len(fields[0]) <= 16,
                     'RESERVATION_HOST_ACCOUNTING')
                facts[key] = int(fields[0]) * 1024
        need(set(facts) == {'MemTotal', 'MemAvailable'} and
             0 < facts['MemAvailable'] <= facts['MemTotal'], 'RESERVATION_HOST_ACCOUNTING')
        need(_read(PROC / 'self/cgroup').splitlines() == groups, 'RESERVATION_NATIVE_CGROUP')
        return facts

    def inventory(self, deadline=None):
        deadline = time.monotonic() + 30 if deadline is None else deadline
        need(time.monotonic() < deadline, 'RESERVATION_OBSERVATION_DEADLINE')
        result = self.broker.run_engine(['ps', '-aq', '--no-trunc'])
        need(len(result.stdout) <= MAX_NATIVE_BYTES, 'RESERVATION_ENGINE_BOUND')
        ids = result.stdout.splitlines()
        need(len(ids) <= MAX_CONTAINERS and len(ids) == len(set(ids)) and
             all(len(i) == 64 and all(c in '0123456789abcdef' for c in i) for i in ids),
             'RESERVATION_COMPLETE_INVENTORY')
        rows = []
        for offset in range(0, len(ids), 32):
            need(time.monotonic() < deadline, 'RESERVATION_OBSERVATION_DEADLINE')
            raw = self.broker.run_engine(['inspect', '--format', ENGINE_FORMAT, *ids[offset:offset + 32]]).stdout
            need(len(raw) <= MAX_NATIVE_BYTES, 'RESERVATION_ENGINE_BOUND')
            batch = [json.loads(line) for line in raw.splitlines()]
            need(type(batch) is list and len(batch) == len(ids[offset:offset + 32]),
                 'RESERVATION_COMPLETE_INVENTORY')
            rows.extend(batch)
        need(all(type(row) is dict for row in rows) and
             sorted(row.get('Id', '') for row in rows) == sorted(ids),
             'RESERVATION_COMPLETE_INVENTORY')
        need(time.monotonic() < deadline, 'RESERVATION_OBSERVATION_DEADLINE')
        return rows

    def custody(self, root, binding):
        deadline = time.monotonic() + 30
        config = self.broker.config
        table = read_mount_table()
        rows = self.inventory(deadline)
        sources = [Path(m['source']) for m in config['mounts']]
        for row in rows:
            mounts = row.get('Mounts')
            need(type(mounts) is list, 'RESERVATION_MOUNT_INVENTORY')
            for mount in mounts:
                need(type(mount) is dict, 'RESERVATION_MOUNT_INVENTORY')
                source = mount.get('Source')
                if mount.get('Type') == 'tmpfs' and source in ('', None):
                    continue
                need(type(source) is str and source.startswith('/'), 'RESERVATION_MOUNT_INVENTORY')
                sources.append(Path(source))
        for source in sources:
            need(time.monotonic() < deadline, 'RESERVATION_OBSERVATION_DEADLINE')
            real = source.resolve(strict=True)
            need(source.is_absolute() and '..' not in source.parts, 'RESERVATION_MOUNT_INVENTORY')
            for target in (root, binding, binding.with_suffix('.pending')):
                need(not _overlap(target, source) and not _overlap(target, real),
                     'RESERVATION_CONTROL_EXPOSED')
                td, tr = _coordinates(target, table)
                sd, sr = _coordinates(real, table)
                need(td != sd or not _overlap(tr, sr), 'RESERVATION_CONTROL_ALIAS')
                for mount in table:
                    if mount['point'].is_relative_to(real) and mount['device'] == td:
                        need(mount['root'] is not None and not _overlap(tr, mount['root']),
                             'RESERVATION_NESTED_CONTROL_ALIAS')
        need(read_mount_table() == table, 'RESERVATION_MOUNT_TABLE_CHANGED')
        # Current engine mount exposures must also remain complete across the scan.
        again = self.inventory(deadline)
        shape = lambda rs: sorted((r['Id'], journal.fingerprint(r['Mounts'])) for r in rs)
        need(shape(again) == shape(rows), 'RESERVATION_MOUNT_INVENTORY_CHANGED')
        return rows

    def limits(self, row):
        state, host = row['State'], row['HostConfig']
        need(type(state['Running']) is bool and state['Running'] is True,
             'RESERVATION_SOURCE_NOT_RUNNING')
        memory, swap, tasks, cpu = host['Memory'], host['MemorySwap'], host['PidsLimit'], host['NanoCpus']
        need(type(memory) is int and memory >= 512 * MIB and memory % MIB == 0
             and type(swap) is int and swap == memory and type(tasks) is int and tasks > 0
             and type(cpu) is int and cpu >= 0,
             'RESERVATION_NATIVE_FINITE_LIMITS')
        pid = state['Pid']; start = _pid(pid)
        need(type(row.get('Image')) is str and row['Image'].startswith('sha256:') and
             len(row['Image']) == 71 and all(c in '0123456789abcdef' for c in row['Image'][7:]),
             'RESERVATION_NATIVE_IMAGE')
        group = _read(PROC / str(pid) / 'cgroup').splitlines()
        need(len(group) == 1 and group[0].startswith('0::/'), 'RESERVATION_NATIVE_CGROUP')
        relative = Path(group[0][4:])
        need(not relative.is_absolute() and '..' not in relative.parts, 'RESERVATION_NATIVE_CGROUP')
        leaf = CGROUP / relative
        current = leaf; memory_limits = []; task_limits = []
        while True:
            for name, limits in [('memory.max', memory_limits), ('pids.max', task_limits)]:
                # The true v2 root may expose no controller limit files. Only
                # this exact root lacks a parent; missing intermediate facts fail.
                if current == CGROUP and not os.path.lexists(current / name):
                    continue
                raw = _read(current / name, 128).strip()
                need(raw == 'max' or raw.isascii() and raw.isdecimal() and int(raw) > 0,
                     'RESERVATION_NATIVE_CGROUP_LIMIT')
                if raw != 'max':
                    limits.append(int(raw))
            if current == CGROUP:
                break
            current = current.parent
        need(_read(leaf / 'memory.max', 128).strip() == str(memory) and
             _read(leaf / 'memory.swap.max', 128).strip() == '0' and
             _read(leaf / 'pids.max', 128).strip() == str(tasks) and
             min(memory_limits) == memory and min(task_limits) == tasks,
             'RESERVATION_EFFECTIVE_LIMIT_CONFLICT')
        need(_pid(pid) == start and _read(PROC / str(pid) / 'cgroup').splitlines() == group,
             'RESERVATION_NATIVE_PID_CHANGED')
        return memory, {'containerId': row['Id'], 'pid': pid, 'start': start,
                        'cgroup': str(relative), 'memory': memory, 'tasks': tasks,
                        'nanoCpus': cpu, 'image': row['Image']}

    def capacity(self, rows, selected):
        deadline = time.monotonic() + 30
        host = self.host_root()
        config = self.broker.config
        sites = [r for r in rows if r.get('Name') == '/' + config['serverContainer']]
        need(len(sites) == 1, 'RESERVATION_WEBSITE_BINDING')
        site_memory, site = self.limits(sites[0])
        commitments = []
        for row in rows:
            need(time.monotonic() < deadline, 'RESERVATION_OBSERVATION_DEADLINE')
            labels = row.get('Config', {}).get('Labels') or {}
            need(type(labels) is dict and type(row.get('State', {}).get('Running')) is bool,
                 'RESERVATION_NATIVE_STATE')
            worker = any(k in labels for k in ('reverie.worker', 'reverie.nix-prepare'))
            if worker:
                need(type(row['State'].get('Pid')) is int and
                     (row['State']['Pid'] > 0 if row['State']['Running'] else row['State']['Pid'] == 0),
                     'RESERVATION_NATIVE_STATE')
            if row['State']['Running'] and worker:
                _, binding = self.limits(row)
                commitments.append(binding)
        total = sum(row['memory'] for row in commitments)
        budget = config['poolMemoryMiB'] * MIB
        need(budget + site_memory + selected['hostReserveMiB'] * MIB <= host['MemTotal'] and
             host['MemAvailable'] >= selected['hostReserveMiB'] * MIB,
             'RESERVATION_HOST_BUDGET')
        need(total <= budget, 'RESERVATION_CAPACITY_EXHAUSTED')
        need(time.monotonic() < deadline, 'RESERVATION_OBSERVATION_DEADLINE')
        return total, budget, site, commitments

    def storage(self, row, paths):
        """Exact inspected bind plus kernel-visible physical directory identity."""
        pid = row['State']['Pid']; start = _pid(pid); result = {}
        for destination, source in [('/home/agent', paths.home), ('/nix', paths.nix), ('/scratch', paths.scratch)]:
            mounts = [m for m in row['Mounts'] if m.get('Destination') == destination]
            need(len(mounts) == 1 and mounts[0].get('Type') == 'bind' and mounts[0].get('RW') is True
                 and mounts[0].get('Source') == str(source), 'RESERVATION_NATIVE_STORAGE_BINDING')
            before = _identity(source)
            need(before[2] == self.broker.config['uid'] and
                 _identity(PROC / str(pid) / 'root' / destination.lstrip('/')) == before and
                 _identity(source) == before, 'RESERVATION_NATIVE_STORAGE_IDENTITY')
            result[destination] = before
        need(_pid(pid) == start, 'RESERVATION_NATIVE_PID_CHANGED')
        return result


class ReservationGate:
    """No start permit exists in this version: every reserved SID stays fenced."""
    def __init__(self, broker):
        self.broker = broker
        self.option = option(broker.config)
        need(self.option is not None, 'RESERVATION_POLICY_REMOVED')
        self.root = Path(self.option['directory'])
        self.native = NativeObserver(broker)
        self._mutex = threading.RLock()
        self._local = threading.local()
        self.scope = {'company_id': self.option['companyId'],
                      'owner_scope_digest': self.option['ownerScopeDigest']}
        need(not os.path.lexists(pending(broker.config)), 'RESERVATION_INSTALL_REQUIRES_RECONCILIATION')
        self.binding = _file(marker(broker.config), broker.config['uid'])
        need(type(self.binding) is dict and set(self.binding) == {
            'schema', 'state', 'option', 'directories', 'admissionLock', 'stateDirectory', 'locks', 'configurationDigest'}, 'RESERVATION_BINDING_SCHEMA')
        need(self.binding['schema'] == 'reverie-resource-control-v1' and
             self.binding['state'] == 'READY' and self.binding['option'] == self.option,
             'RESERVATION_CONTROL_NOT_READY')
        need(self.binding['configurationDigest'] == domain_digest(broker.config), 'RESERVATION_DOMAIN_CHANGED')
        need(type(self.binding['directories']) is dict and
             set(self.binding['directories']) == {'.', 'profiles', 'operations'} and
             all(type(v) is list and len(v) == 2 and all(type(n) is int and n >= 0 for n in v)
                 for v in [*self.binding['directories'].values(), self.binding['admissionLock'], self.binding['stateDirectory']]),
             'RESERVATION_BINDING_SCHEMA')
        need(type(self.binding['locks']) is dict and set(self.binding['locks']) == {'profiles', 'operations'} and
             all(type(v) is list and len(v) == 2 and all(type(n) is int and n >= 0 for n in v)
                 for v in self.binding['locks'].values()), 'RESERVATION_BINDING_SCHEMA')

    def _guard(self, selected=None):
        deadline = time.monotonic() + 30
        need(getattr(self._local, 'depth', 0) > 0, 'RESERVATION_ADMISSION_LOCK_REQUIRED')
        need(option(self.broker.config) == self.option and
             (selected is None or selected == self.scope), 'RESERVATION_SCOPE_CHANGED')
        need(domain_digest(self.broker.config) == self.binding['configurationDigest'], 'RESERVATION_DOMAIN_CHANGED')
        need(not os.path.lexists(pending(self.broker.config)), 'RESERVATION_INSTALL_REQUIRES_RECONCILIATION')
        need(_file(marker(self.broker.config), self.broker.config['uid']) == self.binding,
             'RESERVATION_BINDING_CHANGED')
        statefd, state_identity = _directory(Path(self.broker.config['stateRoot']), self.broker.config['uid'])
        try:
            need(state_identity == self.binding['stateDirectory'], 'RESERVATION_STATE_DIRECTORY_REBOUND')
        finally:
            os.close(statefd)
        for name, expected in self.binding['directories'].items():
            fd, identity = _directory(self.root if name == '.' else self.root / name,
                                      self.broker.config['uid'])
            try:
                need(identity == expected, 'RESERVATION_DIRECTORY_REBOUND')
            finally:
                os.close(fd)
        # Snapshot cannot recreate a deleted canonical profile lock at runtime.
        for p in [self.root / 'profiles/profiles.lock', self.root / 'operations/operations.lock']:
            st = p.lstat()
            need(stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600
                 and st.st_uid == self.broker.config['uid'] and st.st_nlink == 1 and
                 [st.st_dev, st.st_ino] == self.binding['locks'][p.parent.name],
                 'RESERVATION_PRIVATE_LOCK')
        for p in [self.root / 'operations/operations.json', self.root / 'profiles/profiles.json']:
            if p.parent.name == 'profiles' and not os.path.lexists(p):
                continue  # Explicit provisioning starts with no selected profile.
            st = p.lstat()
            need(stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600 and
                 st.st_uid == self.broker.config['uid'] and st.st_nlink == 1,
                 'RESERVATION_PRIVATE_FILE')
        named = (self.root / 'admission.lock').lstat()
        held = os.fstat(self._local.fd)
        need([held.st_dev, held.st_ino] == self.binding['admissionLock'] ==
             [named.st_dev, named.st_ino] and stat.S_IMODE(held.st_mode) == 0o600
             and held.st_uid == self.broker.config['uid'] and held.st_nlink == 1,
             'RESERVATION_ADMISSION_LOCK_REBOUND')
        rows = self.native.custody(self.root, marker(self.broker.config))
        need(time.monotonic() < deadline, 'RESERVATION_OBSERVATION_DEADLINE')
        return rows

    @contextmanager
    def admission(self, sid=None):
        # Global flock -> broker mutex -> journal flock is the only lock order.
        # No interactive viewer retains this lock after canonical launch settles.
        with self._mutex:
            need(not getattr(self._local, 'depth', 0), 'RESERVATION_REENTRANT_ADMISSION')
            fd = os.open(self.root / 'admission.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._local.fd, self._local.depth = fd, 1
                self._guard()
                if sid is not None:
                    self.check_launch(sid)
                yield
                self._guard()
            finally:
                self._local.depth = 0
                os.close(fd)

    def _store(self):
        return journal.OperationStore(self.root / 'operations', scope_guard=self._scope_guard,
                                      capacity_observer=self.observe)

    def _scope_guard(self, selected):
        self._guard(selected)

    def _document(self):
        store = self._store()
        try:
            # Fixed integration with the accepted reader/lock, not a second JSON
            # decoder or a mirror fence that can lag the durable claim.
            return store._locked(self.scope, lambda value, _context, _lock: copy.deepcopy(value))
        finally:
            store.close()

    def check_launch(self, sid):
        journal.canonical_uuid(sid)
        need(not any(op['reserved_sid'] == sid for op in self._document()['operations'].values()),
             'RESOURCE_RESERVATION_REQUIRES_PROTECTED_RECONCILIATION')

    def inspect(self, key):
        with self.admission():
            store = self._store()
            try:
                return store.lookup(self.scope, key)
            finally:
                store.close()

    def check_creation(self, sid, resources):
        self.check_launch(sid)
        need(resources['budgetMode'] == 'admission' and
             resources['poolMemoryMiB'] == self.broker.config['poolMemoryMiB'],
             'RESERVATION_ADMISSION_POLICY_REQUIRED')
        rows = self._guard()
        total, budget, _, _ = self.native.capacity(rows, self.option)
        document = self._document()
        for op in document['operations'].values():
            # Delta arithmetic assumes the old ceiling is still committed. A
            # stopped/moved/unknown source is not automatic capacity credit.
            current = self.observe(op['scope'], op['request']['pool_id'], op['request']['employee_id'])
            need(current['source_binding_digest'] == op['observation']['source_binding_digest'] and
                 current['current_memory_bytes'] == op['observation']['current_memory_bytes'],
                 'RESERVATION_RECONCILIATION_REQUIRED')
        retained = sum(journal.wide(op['delta_bytes']) for op in document['operations'].values())
        need(total + retained + resources['memoryMiB'] * MIB <= budget,
             'RESERVATION_CAPACITY_EXHAUSTED')
        need(self.native.inventory() == rows, 'RESERVATION_NATIVE_INVENTORY_CHANGED')

    def check_reload(self, updated):
        need(not self._document()['operations'] or updated == self.broker.config,
             'RESOURCE_RESERVATION_REQUIRES_PROTECTED_RECONCILIATION')

    def cold_inspect(self):
        with self.admission():
            return self.check_recovery()

    def check_recovery(self):
        document = self._document()
        # Current native custody/bindings are observed anew; never resurrect
        # an opaque journal handle or turn an ACK into verified completion.
        observations = []
        for op in document['operations'].values():
            try:
                value = self.observe(op['scope'], op['request']['pool_id'], op['request']['employee_id'])
                state = 'matches' if value == op['observation'] else 'changed'
            except (OSError, ValueError, RuntimeError):
                # Missing old-native evidence is an unresolved operation, not
                # permission to credit/wake/replay, nor a reason to strand an
                # unrelated existing phone. Custody/journal remain mandatory.
                state = 'unavailable'
            self._guard()
            observations.append({'operationId': op['id'], 'nativeObservation': state})
        need(self._document() == document, 'RESERVATION_JOURNAL_CHANGED_DURING_RECOVERY')
        return {'recoveryRequired': bool(document['operations']), 'retryAllowed': False,
                'reservationRetained': True, 'fencedSids': sorted(
                    op['reserved_sid'] for op in document['operations'].values()), 'observations': observations}

    def observe(self, selected, pool_id, eid):
        need(selected == self.scope and pool_id == self.option['poolId'], 'RESERVATION_SCOPE_CHANGED')
        rows = self._guard(selected)
        config = self.broker.config
        paths = storage_paths(config, next((row['sessionId'] for row in
            read_metadata(config['companyFile'], config['uid'])['employees'] if row.get('id') == eid), ''))
        need(paths.kind == 'employee' and paths.identity == eid and storage_start_allowed(config, paths),
             'RESERVATION_CURRENT_EMPLOYEE_REQUIRED')
        company = read_metadata(config['companyFile'], config['uid'])
        employees = [r for r in company['employees'] if r.get('id') == eid and r.get('sessionId') == paths.session]
        need(len(employees) == 1, 'RESERVATION_CURRENT_EMPLOYEE_REQUIRED')
        employee = employees[0]
        owner_digest = journal.fingerprint({'company_id': self.scope['company_id'], 'owner': employee.get('owner')})
        need(owner_digest == self.scope['owner_scope_digest'], 'RESERVATION_OWNER_SCOPE')
        generation = employee.get('sessionGeneration')
        need(type(generation) is int and 0 < generation <= journal.MAX_VERSION, 'RESERVATION_GENERATION')
        profiles = ProfileStore(self.root / 'profiles')
        try:
            profile = profiles.snapshot()['profiles'].get(eid)
        finally:
            profiles.close()
        need(profile is not None, 'RESERVATION_PROFILE_MISSING')
        need(profile['binding']['current_sid'] == paths.session and
             profile['binding']['current_generation'] == generation and
             profile['resources']['budgetMode'] == 'admission', 'RESERVATION_PROFILE_BINDING')
        current = effective_config(config, paths.session)
        need(all(profile['resources'][k] == current[k] for k in RESOURCE_FIELDS if k != 'memoryMiB'),
             'RESERVATION_RAM_ONLY_PROFILE')
        total, budget, site, commitments = self.native.capacity(rows, self.option)
        target = []; target_row = None
        for row in rows:
            labels = row.get('Config', {}).get('Labels') or {}
            need(type(row.get('State', {}).get('Running')) is bool, 'RESERVATION_NATIVE_STATE')
            if not row['State']['Running'] or not any(k in labels for k in ('reverie.worker', 'reverie.nix-prepare')):
                continue
            _, binding = self.native.limits(row)
            if (labels.get('reverie.worker') == config['deployment'] and
                    labels.get('reverie.session') == paths.session):
                need(labels.get('reverie.employee') == eid and
                     row.get('Name') == '/' + config['deployment'] + '-agent-' + paths.session and
                     labels.get('reverie.worker-policy') == policy_digest(config, paths.session),
                     'RESERVATION_SOURCE_POLICY')
                target.append(binding)
                target_row = row
        need(len(target) == 1, 'RESERVATION_SOURCE_BINDING')
        need(target[0]['memory'] == current['memoryMiB'] * MIB and
             target[0]['tasks'] == current['pidsLimit'] and
             target[0]['nanoCpus'] == int(current['cpus'] * 1000000000),
             'RESERVATION_SOURCE_POLICY')
        storage = self.native.storage(target_row, paths)
        binding = journal.fingerprint({'employee': employee, 'native': target[0], 'storage': storage,
            'profile': profile})
        epoch = journal.fingerprint({'pool': pool_id, 'budget': budget, 'site': site,
            'reserve': self.option['hostReserveMiB'], 'commitments': sorted(commitments, key=lambda r: r['containerId'])})
        need(self.native.inventory() == rows, 'RESERVATION_NATIVE_INVENTORY_CHANGED')
        self._guard(selected)
        latest_company = read_metadata(config['companyFile'], config['uid'])
        latest = [r for r in latest_company['employees'] if r.get('id') == eid]
        need(latest == [employee] and storage_paths(config, paths.session) == paths and
             storage_start_allowed(config, paths), 'RESERVATION_EMPLOYEE_CHANGED_DURING_OBSERVATION')
        profiles = ProfileStore(self.root / 'profiles')
        try:
            need(profiles.snapshot()['profiles'].get(eid) == profile,
                 'RESERVATION_PROFILE_CHANGED_DURING_OBSERVATION')
        finally:
            profiles.close()
        # The final metadata refresh must not replace/create a canonical lock.
        for name in ('profiles', 'operations'):
            st = (self.root / name / (name + '.lock')).lstat()
            need([st.st_dev, st.st_ino] == self.binding['locks'][name], 'RESERVATION_PRIVATE_LOCK')
        return {'pool_id': pool_id, 'pool_revision_digest': epoch, 'budget_bytes': str(budget),
                'committed_bytes': str(total), 'employee_id': eid, 'current_sid': paths.session,
                'generation': str(generation), 'source_binding_digest': binding,
                'profile_version': str(profile['version']), 'current_memory_bytes': str(target[0]['memory'])}

    def reserve(self, key, request):
        """Private host claim only; not an approval endpoint and never a permit."""
        with self.admission():
            observed = self.observe(self.scope, request['pool_id'], request['employee_id'])
            profiles = ProfileStore(self.root / 'profiles')
            try:
                profile = profiles.snapshot()['profiles'][request['employee_id']]
            finally:
                profiles.close()
            need(request['requested_memory_bytes'] == str(profile['resources']['memoryMiB'] * MIB),
                 'RESERVATION_REQUEST_PROFILE')
            need(request['observation_digest'] == journal.fingerprint(observed), 'STALE_CAPACITY_SNAPSHOT')
            store = self._store()
            try:
                view, _local_handle = store.claim(self.scope, key, request)
                # No effect API exists here. Closing intentionally discards the
                # process-local handle; only a refusal/recovery view is exposed.
                return view
            finally:
                store.close()


def compatibility_candidate(before, projected, old_sid, target_sid):
    """Pure OLD policy freeze; a caller must separately supply a staged profile.

    The journal-minted SID versus ProfileStore target-binding/version seam is
    deliberately unresolved here. This helper does not rebind a profile.
    """
    journal.canonical_uuid(old_sid); journal.canonical_uuid(target_sid)
    need(old_sid != target_sid, 'RESERVATION_DISTINCT_TARGET')
    validate_resource_reload(before, projected)
    need(all(before[k] == projected[k] for k in RESOURCE_FIELDS), 'RESERVATION_GLOBAL_POLICY_CHANGED')
    identity = storage_paths(before, old_sid)
    need(identity.kind == 'employee', 'RESERVATION_CURRENT_EMPLOYEE_REQUIRED')
    for key in set(before.get('employeeResources', {})) | set(projected.get('employeeResources', {})):
        if key != identity.identity:
            need(before.get('employeeResources', {}).get(key) == projected.get('employeeResources', {}).get(key),
                 'RESERVATION_PEER_POLICY_CHANGED')
    for key in set(before.get('sessionResources', {})) | set(projected.get('sessionResources', {})):
        if key not in (old_sid, target_sid):
            need(before.get('sessionResources', {}).get(key) == projected.get('sessionResources', {}).get(key),
                 'RESERVATION_PEER_POLICY_CHANGED')
    result = copy.deepcopy(projected)
    old = effective_config(before, old_sid)
    result.setdefault('sessionResources', {})[old_sid] = {k: old[k] for k in RESOURCE_FIELDS}
    validate_resource_reload(before, result)
    need(policy_digest(before, old_sid) == policy_digest(result, old_sid), 'RESERVATION_OLD_POLICY_CHANGED')
    for sid in before.get('sessionResources', {}):
        if sid not in (old_sid, target_sid):
            need(effective_config(before, sid) == effective_config(result, sid), 'RESERVATION_PEER_POLICY_CHANGED')
    return result


def provision(broker):
    """Explicit inactive-service installation only; never called by lookup/J."""
    config = broker.config; selected = option(config)
    need(selected is not None, 'RESERVATION_OPTION_REQUIRED')
    root = Path(selected['directory']); uid = config['uid']
    fd, identity = _directory(root, uid)
    os.close(fd)
    statefd, state_identity = _directory(Path(config['stateRoot']), uid)
    os.close(statefd)
    NativeObserver(broker).custody(root, marker(config))
    need(not any(root.iterdir()) and not os.path.lexists(marker(config)) and
         not os.path.lexists(pending(config)), 'RESERVATION_ALREADY_PROVISIONED_OR_UNCERTAIN')
    intent = {'schema': 'reverie-resource-provision-intent-v1', 'option': selected,
              'directory': identity}
    _write_exclusive(pending(config), intent)
    pending_identity = pending(config).lstat()
    _write_exclusive(marker(config), {'schema': 'reverie-resource-control-v1', 'state': 'PROVISIONING',
                                    'option': selected, 'directories': {'.': identity}, 'admissionLock': []})
    # Every later failure leaves the durable startup fence; never retry init.
    directories = {'.': identity}
    for name in ('profiles', 'operations'):
        (root / name).mkdir(mode=0o700)
        child, directories[name] = _directory(root / name, uid)
        os.close(child)
    _write_exclusive(root / 'admission.lock', {})
    lock = (root / 'admission.lock').lstat()
    profiles = ProfileStore(root / 'profiles')
    try:
        profiles.snapshot()
    finally:
        profiles.close()
    profilefd = os.open(root / 'profiles', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(profilefd)
    finally:
        os.close(profilefd)
    scope = {'company_id': selected['companyId'], 'owner_scope_digest': selected['ownerScopeDigest']}
    store = journal.OperationStore(root / 'operations', scope_guard=lambda s: need(s == scope, 'RESERVATION_SCOPE_CHANGED'))
    try:
        store.initialize(scope)
    finally:
        store.close()
    NativeObserver(broker).custody(root, marker(config))
    for name, expected in directories.items():
        verifyfd, actual = _directory(root if name == '.' else root / name, uid)
        try:
            need(actual == expected, 'RESERVATION_DIRECTORY_REBOUND')
        finally:
            os.close(verifyfd)
    locks = {}
    for name in ('profiles', 'operations'):
        st = (root / name / (name + '.lock')).lstat()
        locks[name] = [st.st_dev, st.st_ino]
    ready = {'schema': 'reverie-resource-control-v1', 'state': 'READY', 'option': selected,
             'directories': directories, 'admissionLock': [lock.st_dev, lock.st_ino],
             'stateDirectory': state_identity, 'locks': locks, 'configurationDigest': domain_digest(config)}
    _write_exclusive(root / 'installation-ready.json', ready)
    os.replace(root / 'installation-ready.json', marker(config))
    parent = os.open(marker(config).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    NativeObserver(broker).custody(root, marker(config))
    need(_file(marker(config), uid) == ready, 'RESERVATION_BINDING_CHANGED')
    for target, expected in [(root if name == '.' else root / name, expected)
                             for name, expected in directories.items()] + [(Path(config['stateRoot']), state_identity)]:
        verifyfd, actual = _directory(target, uid)
        try:
            need(actual == expected, 'RESERVATION_DIRECTORY_REBOUND')
        finally:
            os.close(verifyfd)
    final_lock = (root / 'admission.lock').lstat()
    need([final_lock.st_dev, final_lock.st_ino] == ready['admissionLock'] and
         stat.S_ISREG(final_lock.st_mode) and stat.S_IMODE(final_lock.st_mode) == 0o600 and
         final_lock.st_uid == uid and final_lock.st_nlink == 1, 'RESERVATION_ADMISSION_LOCK_REBOUND')
    need(_file(pending(config), uid) == intent and
         (pending(config).lstat().st_dev, pending(config).lstat().st_ino) ==
         (pending_identity.st_dev, pending_identity.st_ino), 'RESERVATION_INSTALL_INTENT_CHANGED')
    # Durable business completion and every fallible cleanup precede release.
    # No post-unlink fsync/finalizer: a crash-resurrected fence refuses safely.
    os.unlink(pending(config))
    return {'provisioned': True, 'actorAvailable': False, 'configurationOnly': True, 'engineEffects': 0}
