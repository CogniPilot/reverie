"""One-attempt owner-host relocation of one physically unchanged shared directory.

Prepare while the old directory exists and the selected new leaf is absent.
With the fleet and broker still stopped, rename it and create an exact old ->
new compatibility symlink. Apply changes only the mount's source spelling and
the existing reservation binding. It never starts, stops, copies or deletes a
laptop, directory, lease, journal or service. Uncertain effects retain the normal
reservation pending fence; neither apply nor prepare can replay that attempt.
"""
from contextlib import contextmanager, ExitStack
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time

from . import worker_resource_reservations as R
from .worker import validate_config
from .worker_host_job import require_idle, NAME as HOST_JOB
from .worker_service_upgrade import need, private, stamp, digest, encoded, exclusive, directory_lock

KIND = 'owner-equivalent-directory-mount-relocation-v1'


class _Transition:
    def __init__(self, gate, pending, raw):
        self.gate, self.pending, self.raw = gate, pending, raw
        st = os.fstat(gate._local.fd); self.lock = [st.st_dev, st.st_ino]
        self.pending_stamp = stamp(pending)


def owns_pending(gate):
    """Only this live host transaction may finish its normal admission guard."""
    record = getattr(gate._local, 'mount_relocation', None)
    if type(record) is not _Transition or record.gate is not gate:
        return False
    st = os.fstat(gate._local.fd)
    return ([st.st_dev, st.st_ino] == record.lock and stamp(record.pending) == record.pending_stamp
            and private(record.pending) == record.raw)


def _path(value):
    need(type(value) is str and value.startswith('/') and str(Path(value)) == value
         and not value.startswith('//') and '..' not in Path(value).parts
         and not any(ord(c) < 32 or ord(c) == 127 or c == ',' for c in value),
         'MOUNT_RELOCATION_CANONICAL_PATH')
    return Path(value)


def _identity(st):
    return [st.st_dev, st.st_ino, st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)]


@contextmanager
def anchored(path, *, private_leaf=False):
    """No symlink traversal; retain the final directory descriptor for writes."""
    path = _path(str(path)); fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        chain = []
        for part in ('', *path.parts[1:]):
            if part:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd); fd = child
            st = os.fstat(fd)
            sticky = st.st_uid == 0 and bool(st.st_mode & stat.S_ISVTX)
            need(stat.S_ISDIR(st.st_mode) and st.st_uid in (0, os.getuid())
                 and (not st.st_mode & 0o022 or sticky), 'MOUNT_RELOCATION_UNSAFE_ANCESTOR')
            chain.append(_identity(st))
        st = os.fstat(fd)
        need(st.st_uid == os.getuid() and not st.st_mode & (0o077 if private_leaf else 0o022),
             'MOUNT_RELOCATION_OWNER_DIRECTORY')
        yield fd, chain
    finally:
        os.close(fd)


def anchor(path, **kwargs):
    with anchored(path, **kwargs) as (_, chain):
        return chain


@contextmanager
def _lock_file(path):
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()
             and stat.S_IMODE(st.st_mode) == 0o600 and st.st_nlink == 1,
             'MOUNT_RELOCATION_PRIVATE_LOCK')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        need(stamp(path)[:5] == [st.st_dev, st.st_ino, st.st_uid, 0o600, 1],
             'MOUNT_RELOCATION_LOCK_REBOUND')
        yield fd
    finally:
        os.close(fd)


@contextmanager
def leases(config):
    """Hold the existing host barrier and every existing storage/lease lock.

    No registry or lock is created here. Kernel locks establish liveness, not
    stale descriptive PID records. Malformed/unknown reservations refuse.
    """
    from .cleanup import lease as L
    selected = os.environ.get('REVERIE_LEASE_DIR')
    need(selected is not None, 'MOUNT_RELOCATION_EXPLICIT_LEASE_DIRECTORY')
    base = _path(selected); before = anchor(base, private_leaf=True)
    with ExitStack() as held:
        held.enter_context(_lock_file(base / 'barrier.lock'))
        names = sorted(os.listdir(base)); need(len(names) <= 8192, 'MOUNT_RELOCATION_LEASE_BOUND')
        keys = set()
        for name in names:
            if name == 'barrier.lock': continue
            need(re.fullmatch(r'[0-9]+-[0-9]+\.(?:lock|path\.json|reserve\.json|[0-9]+\.json)', name),
                 'MOUNT_RELOCATION_UNKNOWN_LEASE_METADATA')
            key = name.split('.', 1)[0]; keys.add(key)
            if name.endswith('.lock'): held.enter_context(_lock_file(base / name))
            else: private(base / name, maximum=65536)
        for key in keys:
            need((base / (key + '.lock')).is_file(), 'MOUNT_RELOCATION_MISSING_LEASE_LOCK')
            need(L._reservation_state(base, key) == L.FREE, 'MOUNT_RELOCATION_LIVE_OR_UNKNOWN_RESERVATION')
        storage = Path(config['stateRoot']) / 'storage-locks'
        storage_anchor = anchor(storage, private_leaf=True)
        entries = sorted(os.listdir(storage)); need(len(entries) <= 1024, 'MOUNT_RELOCATION_STORAGE_LOCK_BOUND')
        for name in entries:
            need(name.endswith('.lock'), 'MOUNT_RELOCATION_STORAGE_MIGRATION_PENDING')
            held.enter_context(_lock_file(storage / name))
        need(anchor(base, private_leaf=True) == before and sorted(os.listdir(base)) == names
             and anchor(storage, private_leaf=True) == storage_anchor and sorted(os.listdir(storage)) == entries,
             'MOUNT_RELOCATION_LEASE_REGISTRY_CHANGED')
        yield {'directory': str(base), 'identity': before, 'storageIdentity': storage_anchor,
               'names': names, 'storageNames': entries}
        need(anchor(base, private_leaf=True) == before and sorted(os.listdir(base)) == names
             and anchor(storage, private_leaf=True) == storage_anchor and sorted(os.listdir(storage)) == entries,
             'MOUNT_RELOCATION_LEASE_REGISTRY_CHANGED')


class MountRelocation:
    def __init__(self, service, operation):
        from .worker_service import WorkerService
        need(type(service) is WorkerService and os.geteuid() != 0, 'MOUNT_RELOCATION_OWNER_HOST_ONLY')
        self.service = service; self.operation = _path(str(operation))
        anchor(self.operation, private_leaf=True)
        self.deadline = time.monotonic() + 60

    def _engine(self):
        # Reuse the installed maintenance observer, including local socket,
        # daemon/kernel/cgroup identity and bounded calls. No transport upgrade
        # instance or generation effect is constructed.
        from types import SimpleNamespace
        from .worker_service_transport_upgrade import TransportUpgrade
        def run(args):
            result = self.service.run(args, deadline=self.deadline)
            need(result.returncode == 0, 'MOUNT_RELOCATION_ENGINE_UNAVAILABLE')
            return result
        return TransportUpgrade.engine(SimpleNamespace(tools=SimpleNamespace(run=run)))

    @contextmanager
    def _actors(self, gate):
        root = gate.root / 'host-resume'
        with ExitStack() as held:
            plans = {}
            if os.path.lexists(root):
                anchor(root, private_leaf=True)
                for p in root.iterdir():
                    if p.name == 'ACTIVE.json': continue
                    R.journal.canonical_uuid(p.name); anchor(p, private_leaf=True)
                    held.enter_context(_lock_file(p / 'operation.lock'))
                    raw = private(p / 'PLAN.json'); plan = json.loads(raw)
                    need(plan.get('operationId') == p.name and type(plan.get('expiresAt')) is int
                         and plan['expiresAt'] <= time.time(), 'MOUNT_RELOCATION_UNEXPIRED_HOST_ACTOR')
                    plans[p.name] = digest(raw)
                active = root / 'ACTIVE.json'
                if os.path.lexists(active):
                    value = json.loads(private(active))
                    need(set(value) == {'purpose', 'operationId', 'planDigest'}
                         and plans.get(value['operationId']) == value['planDigest'],
                         'MOUNT_RELOCATION_UNKNOWN_HOST_ACTOR')
            yield

    def _inactive(self, config):
        from .worker_service import UNIT, environment_selection
        s = self.service
        anchor(s.config_path.parent, private_leaf=True); anchor(s.environment.parent, private_leaf=True)
        need(private(s.environment) == environment_selection(s.config_path).encode(), 'MOUNT_RELOCATION_REGISTERED_CONFIG')
        fields = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'Job',
                  'FragmentPath', 'DropInPaths', 'NeedDaemonReload')
        r = s.run(['systemctl', '--user', 'show', UNIT, '--no-pager', '--property=' + ','.join(fields)])
        need(r.returncode == 0 and type(r.stdout) is str and len(r.stdout) <= 65536,
             'MOUNT_RELOCATION_MANAGER_UNAVAILABLE')
        rows = [line.partition('=') for line in r.stdout.splitlines()]
        need(all(sep and key in fields for key, sep, _ in rows) and len(rows) == len(fields),
             'MOUNT_RELOCATION_MANAGER_ENCODING')
        v = {k: value for k, _, value in rows}
        need(set(v) == set(fields) and v['Id'] == UNIT and v['LoadState'] == 'loaded'
             and v['ActiveState'] == 'inactive' and v['SubState'] == 'dead'
             and v['MainPID'] == v['ControlPID'] == '0' and v['Job'] in ('', '0')
             and v['DropInPaths'] == '' and v['NeedDaemonReload'] == 'no'
             and s.unit.is_symlink() and s.unit.lstat().st_uid == os.getuid()
             and v['FragmentPath'] in (str(s.unit), str(s.unit.resolve(strict=True))),
             'MOUNT_RELOCATION_BROKER_MUST_BE_INACTIVE')
        need(not os.path.lexists(config['socket']), 'MOUNT_RELOCATION_BROKER_SOCKET_PRESENT')

    def _cold(self, gate):
        self._inactive(gate.broker.config)
        require_idle(gate)
        need(not os.path.lexists(gate.root / 'operations' / HOST_JOB), 'MOUNT_RELOCATION_HOST_JOB_RECONCILIATION')
        # Existing opaque host-resume attempts are retained byte-for-byte. They
        # are not resource start permits and are never interpreted/replayed here.
        need(not gate._document()['operations'], 'MOUNT_RELOCATION_RETAINED_RESOURCE_OPERATION')
        rows = gate._guard()
        config = gate.broker.config
        for row in rows:
            labels = row.get('Config', {}).get('Labels') or {}
            if row.get('State', {}).get('Running') is True:
                protected = [Path(config[k]) for k in ('stateRoot', 'scratchRoot')]
                protected.extend(Path(m['source']).resolve(strict=True) for m in config['mounts'])
                for mount in row.get('Mounts', []):
                    if mount.get('Type') == 'bind':
                        source = Path(mount['Source']).resolve(strict=True)
                        need(not any(R._overlap(source, p) for p in protected), 'MOUNT_RELOCATION_FOREIGN_LIVE_WRITER')
            if labels.get('reverie.worker') == config['deployment'] or row.get('Name') == '/' + config['serverContainer']:
                need(row.get('State') == {'Running': False, 'Pid': 0}, 'MOUNT_RELOCATION_LIVE_CONTAINER')
                state = gate.native.stopped_state(row, deadline=self.deadline)
                need(state['Status'] in ('exited', 'created') and
                     all(state[k] is False for k in ('Running', 'Paused', 'Restarting', 'Dead')),
                     'MOUNT_RELOCATION_UNKNOWN_STOPPED_CONTAINER')
        need(time.monotonic() < self.deadline, 'MOUNT_RELOCATION_DEADLINE')
        return rows

    def _history(self, gate):
        result = {}; total = 0
        for root, dirs, files in os.walk(gate.root, followlinks=False):
            need(len(result) + len(dirs) + len(files) <= 4096, 'MOUNT_RELOCATION_HISTORY_BOUND')
            anchor(Path(root), private_leaf=True)
            need(not any((Path(root) / d).is_symlink() for d in dirs), 'MOUNT_RELOCATION_HISTORY_ALIAS')
            for name in files:
                p = Path(root) / name; raw = private(p)
                total += len(raw); need(total <= 32 * 1024 * 1024, 'MOUNT_RELOCATION_HISTORY_BOUND')
                result[str(p.relative_to(gate.root))] = {'stamp': stamp(p), 'sha256': digest(raw)}
        return result

    def _gate(self, config):
        engine = self._engine(); owner = self
        class Probe:
            def __init__(self):
                self.config = config; self.config_file = owner.service.config_path
            def run_engine(self, args, optional=False, *, deadline=None):
                need(args and args[0] in ('ps', 'inspect'), 'MOUNT_RELOCATION_METADATA_ONLY')
                result = owner.service.run(['docker', '--host', engine['endpoint'], *args],
                                           deadline=min(owner.deadline, deadline or owner.deadline))
                need(result.returncode == 0, 'MOUNT_RELOCATION_ENGINE_UNAVAILABLE')
                return result
        gate = R.ReservationGate(Probe()); gate.relocation_engine = engine
        need(not any(R._overlap(self.operation, Path(config[k])) for k in
                     ('stateRoot', 'scratchRoot', 'companyRoot', 'apiSocketRoot'))
             and not R._overlap(self.operation, gate.root), 'MOUNT_RELOCATION_OPERATION_LOCATION')
        gate.native.custody(self.operation, R.marker(config), deadline=self.deadline)
        return gate

    def _fresh(self):
        need(not any(os.path.lexists(self.operation / n) for n in ('ATTEMPT.json', 'DONE.json')),
             'MOUNT_RELOCATION_ATTEMPT_ALREADY_CONSUMED')

    def prepare(self, selection):
        value = json.loads(private(Path(selection), maximum=65536))
        need(type(value) is dict and set(value) == {'oldSource', 'newSource'}, 'MOUNT_RELOCATION_CLOSED_SELECTION')
        old, new = (_path(value[k]) for k in ('oldSource', 'newSource'))
        need(not R._overlap(old, new), 'MOUNT_RELOCATION_OVERLAPPING_PATHS')
        with directory_lock(self.operation):
            self._fresh(); need(not os.path.lexists(self.operation / 'PLAN.json'), 'MOUNT_RELOCATION_PLAN_ALREADY_EXISTS')
            config_raw = private(self.service.config_path); config = validate_config(json.loads(config_raw))
            need(config['uid'] == os.getuid() and config['gid'] == os.getgid(), 'MOUNT_RELOCATION_OWNER_IDENTITY')
            matches = [i for i, m in enumerate(config['mounts']) if m['source'] == str(old)]
            need(len(matches) == 1 and not any(m['source'] == str(new) for m in config['mounts']),
                 'MOUNT_RELOCATION_EXACT_SINGLE_SOURCE')
            old_identity = anchor(old)[-1]
            parents = {str(p): anchor(p) for p in (old.parent, new.parent, self.service.config_path.parent,
                                                  R.marker(config).parent, self.service.environment.parent)}
            need(not os.path.lexists(new), 'MOUNT_RELOCATION_DESTINATION_MUST_BE_ABSENT')
            gate = self._gate(config)
            with gate.admission(deadline=self.deadline), leases(config) as lease_state, self._actors(gate):
                native = self._cold(gate); history = self._history(gate)
                plan = {'kind': KIND, 'selection': value, 'mountIndex': matches[0],
                        'sourceIdentity': old_identity, 'parents': parents,
                        'operationIdentity': anchor(self.operation, private_leaf=True),
                        'configPath': str(self.service.config_path), 'configStamp': stamp(self.service.config_path),
                        'configSHA256': digest(config_raw), 'config': config,
                        'bindingStamp': stamp(R.marker(config)), 'binding': gate.binding,
                        'bindingSHA256': digest(private(R.marker(config))),
                        'history': history, 'native': native, 'leases': lease_state, 'engine': gate.relocation_engine,
                        'environmentStamp': stamp(self.service.environment),
                        'environmentSHA256': digest(private(self.service.environment))}
                after = copy.deepcopy(config); after['mounts'][matches[0]]['source'] = str(new)
                binding = copy.deepcopy(gate.binding); binding['configurationDigest'] = R.domain_digest(after)
                plan.update(newConfigSHA256=digest(encoded(after)), newBindingSHA256=digest(encoded(binding)))
                need(private(self.service.config_path) == config_raw and self._history(gate) == history
                     and self._cold(gate) == native and anchor(old)[-1] == old_identity
                     and all(anchor(Path(p)) == a for p, a in parents.items()) and not os.path.lexists(new),
                     'MOUNT_RELOCATION_PREPARE_CAS_CHANGED')
                exclusive(self.operation / 'PLAN.json', encoded(plan))
        return {'state': 'PREPARED', 'effects': False, 'planSHA256': digest(encoded(plan)),
                'sourceIdentity': old_identity, 'compatibilitySymlinkRequired': True}

    def apply(self, expected):
        need(type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected), 'MOUNT_RELOCATION_PLAN_DIGEST')
        with directory_lock(self.operation):
            self._fresh(); raw = private(self.operation / 'PLAN.json'); need(digest(raw) == expected, 'MOUNT_RELOCATION_PLAN_CHANGED')
            p = json.loads(raw); need(p['kind'] == KIND and p['configPath'] == str(self.service.config_path)
                                     and anchor(self.operation, private_leaf=True) == p['operationIdentity'], 'MOUNT_RELOCATION_PLAN_SCOPE')
            old, new = (_path(p['selection'][k]) for k in ('oldSource', 'newSource'))
            def paths():
                need(all(anchor(Path(path)) == a for path, a in p['parents'].items()), 'MOUNT_RELOCATION_PARENT_CHANGED')
                need(anchor(new)[-1] == p['sourceIdentity'], 'MOUNT_RELOCATION_DIRECTORY_REPLACED')
                with anchored(old.parent) as (fd, _):
                    st = os.stat(old.name, dir_fd=fd, follow_symlinks=False)
                    need(stat.S_ISLNK(st.st_mode) and st.st_uid == os.getuid() and
                         os.readlink(old.name, dir_fd=fd) == str(new), 'MOUNT_RELOCATION_EXACT_COMPATIBILITY_LINK')
            paths()
            config = p['config']; after = copy.deepcopy(config)
            need(config['mounts'][p['mountIndex']]['source'] == str(old), 'MOUNT_RELOCATION_PLAN_SOURCE')
            after['mounts'][p['mountIndex']]['source'] = str(new); validate_config(after)
            new_binding = copy.deepcopy(p['binding']); new_binding['configurationDigest'] = R.domain_digest(after)
            need(digest(encoded(after)) == p['newConfigSHA256'] and digest(encoded(new_binding)) == p['newBindingSHA256'],
                 'MOUNT_RELOCATION_PLAN_OUTPUT_CHANGED')
            gate = self._gate(config)
            def cas():
                paths()
                need(stamp(self.service.config_path) == p['configStamp'] and digest(private(self.service.config_path)) == p['configSHA256']
                     and stamp(R.marker(config)) == p['bindingStamp'] and digest(private(R.marker(config))) == p['bindingSHA256']
                     and stamp(self.service.environment) == p['environmentStamp']
                     and digest(private(self.service.environment)) == p['environmentSHA256']
                     and gate.binding == p['binding'] and self._history(gate) == p['history'], 'MOUNT_RELOCATION_CAS_CHANGED')
            with gate.admission(deadline=self.deadline), leases(config) as lease_state, self._actors(gate):
                cas(); need(lease_state == p['leases'] and gate.relocation_engine == p['engine']
                            and self._cold(gate) == p['native'], 'MOUNT_RELOCATION_COLD_STATE_CHANGED')
                receipt = {'kind': KIND, 'planSHA256': expected, 'operation': str(self.operation),
                           'oldConfigSHA256': p['configSHA256'], 'newConfigSHA256': p['newConfigSHA256'],
                           'oldBindingSHA256': p['bindingSHA256'], 'newBindingSHA256': p['newBindingSHA256'],
                           'sourceIdentity': p['sourceIdentity']}
                exclusive(self.operation / 'ATTEMPT.json', encoded(receipt))
                cas(); need(self._cold(gate) == p['native'], 'MOUNT_RELOCATION_COLD_STATE_CHANGED')
                pending = R.pending(config)
                exclusive(pending, encoded(receipt))
                gate._local.mount_relocation = _Transition(gate, pending, encoded(receipt))
                pending_stamp = stamp(pending)
                # From here every failure retains the canonical startup fence.
                # Replacement files are adjacent to each destination so the
                # operation receipt may reside on a different durable device.
                for target, output, original in ((self.service.config_path, encoded(after), p['configStamp']),
                                                  (R.marker(config), encoded(new_binding), p['bindingStamp'])):
                    candidate = target.with_name('.' + target.name + '.mount-' + expected + '.new')
                    with anchored(target.parent, private_leaf=True) as (fd, parent_identity):
                        exclusive(candidate, output)
                        paths(); self._inactive(config)
                        need(stamp(target) == original and anchor(target.parent, private_leaf=True) == parent_identity,
                             'MOUNT_RELOCATION_REPLACE_CAS_CHANGED')
                        need(self._history(gate) == p['history'] and gate.native.inventory(self.deadline) == p['native']
                             and self._engine() == p['engine'], 'MOUNT_RELOCATION_NATIVE_OR_HISTORY_CHANGED')
                        os.replace(candidate.name, target.name, src_dir_fd=fd, dst_dir_fd=fd); os.fsync(fd)
                need(digest(private(self.service.config_path)) == p['newConfigSHA256'] and
                     digest(private(R.marker(config))) == p['newBindingSHA256'] and self._history(gate) == p['history'],
                     'MOUNT_RELOCATION_COMMIT_UNCONFIRMED')
                paths(); self._inactive(after)
                gate.broker.config = after; gate.binding = new_binding
            # All admission/native and lease finalizers finish while the normal
            # startup fence is still present. No callback/lease cleanup remains
            # after its removal. A crash at any earlier point stays fenced.
            need(stamp(pending) == pending_stamp and private(pending) == encoded(receipt) and self._history(gate) == p['history']
                 and digest(private(self.service.config_path)) == p['newConfigSHA256']
                 and digest(private(R.marker(config))) == p['newBindingSHA256'], 'MOUNT_RELOCATION_PENDING_CHANGED')
            paths(); self._inactive(after)
            exclusive(self.operation / 'DONE.json', encoded({**receipt, 'state': 'COMMITTED'}))
            with anchored(pending.parent, private_leaf=True) as (fd, _):
                need(stamp(pending) == pending_stamp and private(pending) == encoded(receipt), 'MOUNT_RELOCATION_PENDING_CHANGED')
                os.unlink(pending.name, dir_fd=fd); os.fsync(fd)
        return {'state': 'COMMITTED', 'workerEffects': False, 'planSHA256': expected,
                'sourceIdentity': p['sourceIdentity'], 'journalsUnchanged': True}
