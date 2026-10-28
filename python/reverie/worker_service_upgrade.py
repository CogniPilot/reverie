"""Explicit one-attempt GPU-only broker generation migration, never a wake API.

The packaged WorkerService launcher fixes the new immutable unit/source. Owner
selection contains device/employee and initial capacity policy, never commands.
The selected provider must already have ended through its normal handoff path.
A failed/uncertain attempt is retained for operator reconciliation, never replayed
or automatically rolled back over a newly running broker or canonical journal.
"""
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import socket
import struct
import time
import sys

from . import worker_gpu as G, worker_gpu_preflight as P
from . import worker_resource_reservations as A
from .worker import load_config, validate_config
from .worker_resources import effective_config, policy_digest
from .worker_capacity_policy import pool_headroom_fits
from .worker_service import UNIT, environment_selection
from .worker_storage import read_metadata, storage_paths, validate_storage

MAX = 2 * 1024 * 1024
KINDS = ('unit', 'environment', 'gcroot', 'config')


def need(value, reason):
    if not value:
        raise ValueError(reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def stamp(path):
    st = path.lstat()
    return [st.st_dev, st.st_ino, st.st_uid, stat.S_IMODE(st.st_mode), st.st_nlink,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def private(path, *, maximum=MAX):
    before = stamp(path)
    need(before[2] == os.getuid() and before[3] == 0o600 and before[4] == 1,
         'Private singly linked owner file required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        need(stat.S_ISREG(os.fstat(fd).st_mode), 'Regular private file required')
        raw = bytearray()
        while len(raw) <= maximum:
            part = os.read(fd, min(65536, maximum + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        need(len(raw) <= maximum, 'Private metadata exceeds bound')
    finally:
        os.close(fd)
    need(stamp(path) == before, 'Private file changed during read')
    return bytes(raw)


def sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def exclusive(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        while raw:
            count = os.write(fd, raw)
            need(count > 0, 'Short durable write')
            raw = raw[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    sync(path.parent)


@contextmanager
def directory_lock(path):
    fd, identity = A._directory(path, os.getuid())
    os.close(fd)
    lock = path / 'operation.lock'
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        st = os.fstat(descriptor)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and
             stat.S_IMODE(st.st_mode) == 0o600 and st.st_nlink == 1,
             'Private operation lock required')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        again, current = A._directory(path, os.getuid())
        os.close(again)
        need(current == identity, 'Operation directory rebound')
        yield
    finally:
        os.close(descriptor)


def unit_record(service, path):
    """Recognize the exact generated broker template, never arbitrary Exec lines."""
    from .worker_service import STORE_ROOT
    path = Path(path)
    need(path.is_relative_to(STORE_ROOT) and path.resolve() == path and path.is_file(),
         'Immutable packaged unit required')
    root = service.store_root(path)
    raw = path.read_bytes()
    need(len(raw) <= 8192, 'Unit exceeds bound')
    text = raw.decode()
    found = {}
    patterns = {'ExecStartPre': 'reverie-worker-service-check', 'ExecStart': 'reverie-worker-broker'}
    normalized = text
    for key, binary in patterns.items():
        matches = re.findall(r'^' + key + r'=(/[^\s]+/bin/' + binary + r') --config \$\{REVERIE_WORKER_CONFIG\}$', text, re.M)
        need(len(matches) == 1, 'Unrecognized broker entrypoint')
        entry = Path(matches[0]); st = entry.stat()
        need(entry.resolve() == entry and entry.is_relative_to(STORE_ROOT) and
             stat.S_ISREG(st.st_mode) and st.st_uid in (0, os.getuid()) and
             not st.st_mode & 0o022 and st.st_mode & 0o111,
             'Immutable broker executable required')
        found[key] = {'path': str(entry), 'sha256': digest(entry.read_bytes())}
        normalized = normalized.replace(matches[0], '<' + key + '>')
    expected = '''[Unit]
Description=Reverie laptop broker and office watchdog
[Service]
EnvironmentFile=%h/.config/reverie/worker-broker.env
ExecStartPre=<ExecStartPre> --config ${REVERIE_WORKER_CONFIG}
ExecStart=<ExecStart> --config ${REVERIE_WORKER_CONFIG}
Restart=on-failure
RestartSec=3
TimeoutStopSec=35
KillMode=mixed
UMask=0077
NoNewPrivileges=true
MemoryMax=512M
TasksMax=512
[Install]
WantedBy=default.target
'''
    need(normalized == expected, 'Foreign or changed unit template')
    return {'path': str(path), 'root': str(root), 'sha256': digest(raw), 'entries': found}


class GPUUpgrade:
    """Fixed WorkerService composition; no executable/callback selected by input."""
    def __init__(self, service, operation):
        need(sys.platform == 'linux' and os.geteuid() != 0, 'Use the ordinary owner on local Linux')
        self.service = service
        self.operation = Path(operation)
        need(self.operation.is_absolute() and self.operation.resolve() == self.operation,
             'Canonical private operation directory required')
        self.deadline = time.monotonic() + 180

    def run(self, args):
        need(time.monotonic() < self.deadline, 'Upgrade deadline exhausted')
        result = self.service.run(args, deadline=self.deadline)
        need(result.returncode == 0 and time.monotonic() < self.deadline,
             'Upgrade command refused or outcome unknown')
        return result

    def manager(self, action):
        return self.run(['systemctl', '--user', action, UNIT])

    def generation(self):
        s = self.service
        need(s.config_path is not None and s.config_path.resolve() == s.config_path,
             'Existing private configuration selection required')
        for path in (s.environment.parent, s.gcroot.parent, s.config_path.parent):
            fd, _ = A._directory(path, os.getuid()); os.close(fd)
        # Unit names are public systemd metadata; the normal owned 0755 unit
        # directory is safe, while config/history/control directories stay 0700.
        need(s.unit.parent.resolve() == s.unit.parent, 'Canonical unit directory required')
        for path in (s.unit.parent, *s.unit.parent.parents):
            st = path.lstat()
            sticky = st.st_uid == 0 and bool(st.st_mode & stat.S_ISVTX)
            need(stat.S_ISDIR(st.st_mode) and st.st_uid in (0, os.getuid()) and
                 (not st.st_mode & 0o022 or sticky), 'Unsafe unit directory ancestor')
        need(s.unit.is_symlink() and s.gcroot.is_symlink(), 'Installed generation links required')
        need(all(path.lstat().st_uid == os.getuid() for path in (s.unit, s.gcroot)), 'Owner generation links required')
        need(self.operation.stat().st_dev == s.unit.parent.stat().st_dev ==
             s.gcroot.parent.stat().st_dev == s.config_path.parent.stat().st_dev,
             'Atomic same-filesystem generation migration required')
        old = unit_record(s, s.unit.resolve())
        need(os.readlink(s.gcroot) == old['root'] and
             private(s.environment) == environment_selection(s.config_path).encode(),
             'Installed unit, environment and GC root disagree')
        current = load_config(s.config_path)
        need(current['uid'] == os.getuid() and current['gid'] == os.getgid(), 'Owner broker identity required')
        return {'unit': old, 'newUnit': unit_record(s, s.target_unit()),
                'stamps': {key: stamp(path) for key, path in
                           zip(KINDS, (s.unit, s.environment, s.gcroot, s.config_path))},
                'configSHA256': digest(private(s.config_path)), 'environmentSHA256': digest(private(s.environment))}

    def manager_state(self, *, active):
        args = ['systemctl', '--user', 'show', UNIT,
                '--property=ActiveState,SubState,MainPID,FragmentPath,DropInPaths,NeedDaemonReload,ControlGroup']
        result = self.run(args)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        need(set(fields) == {'ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths',
             'NeedDaemonReload', 'ControlGroup'} and fields['DropInPaths'] == '' and
             fields['FragmentPath'] == str(self.service.unit) and fields['NeedDaemonReload'] == 'no',
             'Actual manager unit differs from selected immutable generation')
        if active:
            need(fields['ActiveState'] == 'active' and fields['SubState'] == 'running' and
                 fields['MainPID'].isascii() and fields['MainPID'].isdigit(), 'Running broker generation required')
            process = P._process(int(fields['MainPID']))
            return {'properties': fields, 'process': process}
        need(fields['ActiveState'] == 'inactive' and fields['SubState'] == 'dead' and
             fields['MainPID'] == '0', 'Broker stop not confirmed inactive')
        return {'properties': fields}

    def selection(self, path):
        value = json.loads(private(Path(path), maximum=65536))
        need(type(value) is dict and set(value) == {'employeeId', 'device', 'cdiSHA256',
             'resourceReservations', 'providerPIDs'}, 'Closed GPU upgrade selection required')
        need(type(value['cdiSHA256']) is str and P.SHA.fullmatch(value['cdiSHA256']), 'Reviewed CDI digest required')
        pids = value['providerPIDs']
        need(type(pids) is list and 1 <= len(pids) <= 64 and
             all(type(pid) is int and pid > 1 for pid in pids) and len(set(pids)) == len(pids), 'Bounded existing provider PID set required')
        return value

    def stable_binding(self, config, employee):
        current = P.binding(config, employee)
        company = read_metadata(config['companyFile'], config['uid'])
        rows = [row for row in company['employees'] if row.get('id') == employee]
        need(len(rows) == 1, 'Current employee is ambiguous')
        recipe = copy.deepcopy(rows[0].get('runtimeRecipe'))
        if type(recipe) is dict and 'runtimeThreads' in recipe:
            need(type(recipe['runtimeThreads']) is dict, 'Runtime thread metadata is malformed')
            recipe.pop('runtimeThreads')
        current['recipeDigest'] = digest(encoded(recipe))
        again = P.binding(config, employee)
        need({k: v for k, v in current.items() if k != 'recipeDigest'} ==
             {k: v for k, v in again.items() if k != 'recipeDigest'}, 'Current employee changed')
        return current

    def candidate(self, before, selection):
        need(not any(key in before for key in ('resourceReservations', 'employeeGpuGrants')),
             'Only first explicit capacity/GPU projection installation is supported')
        need(not A.configured(before), 'Existing or uncertain reservation domain requires its own reconciliation')
        after = copy.deepcopy(before)
        after['employeeGpuGrants'] = {selection['employeeId']: selection['device']}
        after['resourceReservations'] = selection['resourceReservations']
        validate_config(after)
        need(after['image'] == before['image'], 'GPU upgrade preserves the current image')
        company = read_metadata(before['companyFile'], before['uid'])
        rows = company.get('employees')
        need(type(rows) is list and len(rows) <= 256, 'Bounded employee registry required')
        binding = self.stable_binding(before, selection['employeeId'])
        need(not binding['onVacation'], 'Current owner vacation intent refuses GPU maintenance')
        sid = binding['sessionId']
        for row in rows:
            if type(row) is dict and row.get('sessionId') and row['sessionId'] != sid:
                need(policy_digest(before, row['sessionId']) == policy_digest(after, row['sessionId']),
                     'Unselected laptop policy changed')
        need((G.projected_gpu_grants(after, sid) or {}).get(sid) == selection['device'],
             'Legacy SID authority conflicts with selected employee GPU')
        return after, binding

    def native(self, before, after, selection):
        report = P.check(before, selection['employeeId'], selection['device'], spec_sha256=selection['cdiSHA256'])
        need(not report['currentLaptop']['running'],
             'Selected provider must already have handed off and laptop must be stopped')
        paths = storage_paths(before, report['employee']['sessionId'])
        need(paths.kind == 'employee' and paths.identity == selection['employeeId'], 'Selected canonical storage owner changed')
        validate_storage(before, paths)
        selected_storage = self.storage_identities(paths)
        native = A.NativeObserver(self.service.resource_probe(after))
        native._local.deadline = self.deadline
        selected = A.option(after)
        root = Path(selected['directory'])
        fd, _ = A._directory(root, after['uid']); os.close(fd)
        need(not any(root.iterdir()) and not os.path.lexists(A.marker(after)) and
             not os.path.lexists(A.pending(after)), 'Fresh empty reservation control root required')
        rows = native.custody(root, A.marker(after), deadline=self.deadline)
        # Backups/intent must be outside every configured AND actual mount too.
        native.custody(self.operation, self.operation / 'ATTEMPT.json', deadline=self.deadline)
        capacity = native.capacity(rows, selected)
        resources = effective_config(after, report['employee']['sessionId'])
        need(resources['budgetMode'] == 'admission' and pool_headroom_fits(
             budget_bytes=capacity[1], committed_bytes=capacity[0], retained_bytes=0,
             candidate_bytes=resources['memoryMiB'] * A.MIB), 'Selected laptop would exceed current pool')
        current_workers = [row for row in rows if row.get('State', {}).get('Running') is True and
                           row.get('Config', {}).get('Labels', {}).get('reverie.worker') == after['deployment']]
        need(len(current_workers) + 1 <= after['maxWorkers'], 'Selected replacement exceeds worker population bound')
        peers = []
        for row in rows:
            if row.get('State', {}).get('Running') is True:
                _, facts = native.limits(row)
                peers.append({**facts, 'process': P._process(row['State']['Pid'])})
        need(len(peers) <= after['maxWorkers'] + 128, 'Native population exceeds bounded upgrade inventory')
        providers = []
        for pid in selection['providerPIDs']:
            facts = P._process(pid)
            need(any(facts['namespaces'] == peer['process']['namespaces'] and
                     facts['rootIdentity'] == peer['process']['rootIdentity'] for peer in peers),
                 'Provider PID is not in an observed running container')
            exe = (Path('/proc') / str(pid) / 'exe').stat()
            providers.append({**facts, 'exeIdentity': [exe.st_dev, exe.st_ino]})
        need(native.inventory(deadline=self.deadline) == rows, 'Native inventory changed after capacity/provider reads')
        need(P.binding(before, selection['employeeId']) == report['employee'], 'Employee intent or identity changed')
        return {'gpu': report, 'capacity': list(capacity[:3]), 'peers': sorted(peers, key=lambda x: x['containerId']),
                'providers': sorted(providers, key=lambda x: x['pid']), 'inventory': rows, 'selectedStorage': selected_storage}

    @staticmethod
    def storage_identities(paths):
        return {name: A._identity(path) for name, path in
                [('/home/agent', paths.home), ('/nix', paths.nix), ('/scratch', paths.scratch)]}

    @staticmethod
    def device_nodes(pid, paths):
        need(type(paths) is list and 1 <= len(paths) <= 64 and len(set(paths)) == len(paths),
             'Reviewed CDI device-node list required')
        result = {}
        for value in paths:
            need(type(value) is str and value.startswith('/dev/') and '..' not in Path(value).parts,
                 'Reviewed CDI node must remain under /dev')
            host = Path(value).stat()
            guest = (Path('/proc') / str(pid) / 'root' / value.lstrip('/')).stat()
            need(stat.S_ISCHR(host.st_mode) and stat.S_ISCHR(guest.st_mode) and host.st_rdev == guest.st_rdev,
                 'Selected CDI character device is absent or has a different physical identity')
            result[value] = [os.major(host.st_rdev), os.minor(host.st_rdev)]
        return result

    def ready_socket(self, path, broker_pid):
        end = min(self.deadline, time.monotonic() + 10)
        while time.monotonic() < end:
            try:
                before = stamp(path)
                st = path.lstat()
                need(stat.S_ISSOCK(st.st_mode) and st.st_uid == os.getuid() and
                     stat.S_IMODE(st.st_mode) == 0o600, 'Private broker/office socket required')
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(max(.001, min(1, end - time.monotonic())))
                    client.connect(str(path))
                    pid, uid, _gid = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    need(pid == broker_pid and uid == os.getuid() and stamp(path) == before,
                         'Recovered listener is not the selected new broker process')
                return
            except (FileNotFoundError, ConnectionRefusedError, TimeoutError):
                time.sleep(min(.1, max(0, end - time.monotonic())))
        raise ValueError('New broker/office listener readiness deadline exhausted')

    def prepare(self, selection_path):
        with directory_lock(self.service.gcroot.parent), directory_lock(self.operation):
            need(not any(p.name != 'operation.lock' for p in self.operation.iterdir()), 'Fresh operation directory required')
            before = load_config(self.service.config_path)
            selection = self.selection(selection_path)
            generation = self.generation()
            after, binding = self.candidate(before, selection)
            need(generation['unit'] != generation['newUnit'], 'New immutable broker generation required')
            broker = self.manager_state(active=True)
            facts = self.native(before, after, selection)
            need(self.manager_state(active=True) == broker, 'Broker incarnation changed during preparation')
            need(self.generation() == generation, 'Generation changed during preparation')
            for name, raw in [('config-before.raw.json', private(self.service.config_path)),
                              ('environment-before.raw', private(self.service.environment)),
                              ('unit-before.raw', Path(generation['unit']['path']).read_bytes()),
                              ('candidate.json', encoded(after))]:
                exclusive(self.operation / name, raw)
            value = {'kind': 'GPU_ONLY_BROKER_UPGRADE_V1', 'createdAt': time.time(),
                     'expiresAt': time.time() + 600, 'generation': generation,
                     'selection': selection, 'binding': binding, 'native': facts, 'broker': broker,
                     'candidateSHA256': digest(encoded(after))}
            exclusive(self.operation / 'PLAN.json', encoded(value))
            return {'planSHA256': digest(encoded(value)), 'effects': False, 'selectedAlreadyStopped': True}

    def metadata_stamps(self, config, binding):
        # No descriptor finalizer or producer callback follows this leaf/parent
        # signature pass. Missing optional metadata is an observed absence.
        paths = [self.service.config_path, self.service.unit, self.service.environment,
                 self.service.gcroot, Path(config['companyFile']),
                 Path(config['companyFile']).with_name('plan-moves.json'),
                 Path(config['stateRoot']) / binding['sessionId'] / 'storage-owner.json',
                 self.operation / 'PLAN.json', self.operation / 'candidate.json']
        result = {}
        for path in paths:
            parent = path.parent
            while not os.path.lexists(parent):
                parent = parent.parent
            need(parent.resolve() == parent, 'Metadata ancestor became an alias')
            st = parent.stat()
            result[str(path)] = {'leaf': stamp(path) if os.path.lexists(path) else None,
                                 'parent': [str(parent), st.st_dev, st.st_ino]}
        return result

    def _replace_link(self, path, target, expected):
        need(stamp(path) == expected, 'Generation link changed before CAS')
        temporary = self.operation / ('next-' + path.name)
        os.symlink(target, temporary)
        need(stamp(path) == expected, 'Generation link changed during CAS preparation')
        # Same filesystem required for atomic rename, never copy/delete fallback.
        os.replace(temporary, path)
        sync(path.parent)

    def apply(self, plan_sha256):
        with directory_lock(self.service.gcroot.parent), directory_lock(self.operation):
            need(not os.path.lexists(self.operation / 'ATTEMPT.json'), 'One-attempt upgrade already consumed')
            raw = private(self.operation / 'PLAN.json')
            need(type(plan_sha256) is str and P.SHA.fullmatch(plan_sha256) and digest(raw) == plan_sha256,
                 'Exact prepared plan digest required')
            plan = json.loads(raw)
            need(plan.get('kind') == 'GPU_ONLY_BROKER_UPGRADE_V1' and time.time() < plan['expiresAt'], 'Upgrade plan expired')
            generation = self.generation()
            need(generation == plan['generation'], 'Prepared generation changed')
            before = load_config(self.service.config_path)
            after, binding = self.candidate(before, plan['selection'])
            need(binding == plan['binding'] and digest(encoded(after)) == plan['candidateSHA256'] and
                 private(self.operation / 'candidate.json') == encoded(after), 'Candidate or employee binding changed')
            need(self.native(before, after, plan['selection']) == plan['native'], 'Native readiness changed; prepare a fresh plan')
            need(self.generation() == generation, 'Prepared generation changed before attempt')
            need(self.manager_state(active=True) == plan['broker'] and time.time() < plan['expiresAt'],
                 'Broker incarnation changed or plan expired before attempt')
            exclusive(self.operation / 'ATTEMPT.json', encoded({'kind': 'GPU_BROKER_UPGRADE_ATTEMPT',
                'planSHA256': plan_sha256, 'at': time.time()}))
            # All later errors retain this marker and both generations. No retry,
            # journal deletion, automatic rollback, laptop stop or provider wake.
            for label, record in [('old-generation', generation['unit']), ('new-generation', generation['newUnit'])]:
                root = self.operation / label
                self.run(['nix-store', '--add-root', str(root), '--indirect', '--realise', record['root']])
                need(root.is_symlink() and root.resolve() == Path(record['root']), 'Generation GC root publication unknown')
            exclusive(self.operation / 'BROKER-STOP-INTENT.json', encoded({'broker': plan['broker']}))
            self.manager('stop')
            self.manager_state(active=False)
            previous = plan['broker']['process']
            try:
                alive = P._process(previous['pid'])
            except (FileNotFoundError, ProcessLookupError):
                alive = None
            need(alive != previous, 'Previous broker process is still alive')
            need(self.generation() == generation, 'Generation changed while stopping broker')
            need(self.native(before, after, plan['selection']) == plan['native'], 'Peer/provider continuity changed during broker stop')
            need(private(self.service.config_path) == private(self.operation / 'config-before.raw.json'), 'Config CAS precondition changed')
            need(stamp(self.service.config_path) == generation['stamps']['config'], 'Configuration identity changed')
            need(self.stable_binding(before, plan['selection']['employeeId']) == binding, 'Employee intent changed before CAS')
            exclusive(self.operation / 'CONFIG-COMMIT-INTENT.json', encoded({
                'beforeSHA256': generation['configSHA256'], 'afterSHA256': plan['candidateSHA256']}))
            terminal = self.metadata_stamps(before, binding)
            need(self.generation() == generation and
                 private(self.service.config_path) == private(self.operation / 'config-before.raw.json') and
                 private(self.operation / 'candidate.json') == encoded(after) and
                 self.stable_binding(before, plan['selection']['employeeId']) == binding,
                 'Configuration or current employee changed after commit intent')
            need(self.metadata_stamps(before, binding) == terminal,
                 'Configuration/employee metadata changed at CAS boundary')
            os.replace(self.operation / 'candidate.json', self.service.config_path)
            sync(self.service.config_path.parent)
            # Explicit first provisioning of the SAME canonical root, not H/actor
            # install. A failed initialization retains its own canonical fence.
            A.provision(self.service.resource_probe(after))
            self._replace_link(self.service.unit, generation['newUnit']['path'], generation['stamps']['unit'])
            self._replace_link(self.service.gcroot, generation['newUnit']['root'], generation['stamps']['gcroot'])
            self.run(['systemctl', '--user', 'daemon-reload'])
            exclusive(self.operation / 'BROKER-START-INTENT.json', encoded({'unit': generation['newUnit']}))
            self.manager('start')
            self.manager('is-active')
            new_broker = self.manager_state(active=True)
            need(new_broker['process'] != plan['broker']['process'], 'Old broker incarnation did not change')
            self.ready_socket(Path(after['socket']), new_broker['process']['pid'])
            for row in plan['native']['inventory']:
                labels = row.get('Config', {}).get('Labels', {})
                if row['State']['Running'] and labels.get('reverie.worker') == after['deployment']:
                    self.ready_socket(Path(after['apiSocketRoot']) / labels['reverie.session'] / 'office.sock',
                                      new_broker['process']['pid'])
            need(private(self.service.config_path) == encoded(after) and
                 self.service.unit.resolve() == Path(generation['newUnit']['path']) and
                 self.service.gcroot.resolve() == Path(generation['newUnit']['root']) and
                 private(self.service.environment) == private(self.operation / 'environment-before.raw'),
                 'New generation readback changed')
            # Reuse real gate admission/custody for startup readiness; do not
            # manufacture READY or any resource actor/capability permission.
            probe = self.service.resource_probe(after)
            gate = A.ReservationGate(probe)
            with gate.admission(deadline=self.deadline):
                gate.check_headroom()
                observer = gate.native
                rows = observer.inventory(deadline=self.deadline)
                matching = [row for row in rows if row.get('Config', {}).get('Labels', {}).get('reverie.session') == binding['sessionId']
                            and row.get('Config', {}).get('Labels', {}).get('reverie.worker') == after['deployment']]
                active = [row for row in matching if row.get('State', {}).get('Running') is True]
                need(len(active) <= 1, 'Selected native laptop is ambiguous')
                activation = None
                if active:
                    need(binding['desiredRunning'] and not binding['onVacation'],
                         'OFF or vacation employee cannot qualify normal activation')
                    # Observe normal owner-intended reconnection only. This
                    # helper issues no J/create/provider/wake request.
                    report = P.check(after, plan['selection']['employeeId'], plan['selection']['device'],
                                     spec_sha256=plan['selection']['cdiSHA256'])
                    laptop = report['currentLaptop']
                    need(laptop['running'] and not laptop['oomKilled'] and laptop['image'] == before['image'] and
                         laptop['id'] == active[0]['Id'] and laptop['id'] != plan['native']['gpu']['currentLaptop']['id'],
                         'Normal activation has the wrong native identity or image')
                    need(laptop['cdiDevices'] == [plan['selection']['device']] and
                         laptop['deviceRequests'] in (None, []) and
                         laptop['devices'] == plan['native']['gpu']['currentLaptop']['devices'],
                         'Native GPU/device authority differs from exact selected CDI profile')
                    paths = storage_paths(after, binding['sessionId'])
                    need(paths.kind == 'employee' and paths.identity == binding['id'], 'Activated storage owner changed')
                    physical_storage = observer.storage(active[0], paths)
                    need(physical_storage == plan['native']['selectedStorage'], 'Original selected home/Nix/scratch identity changed')
                    device_nodes = self.device_nodes(laptop['process']['pid'], report['cdi']['deviceNodePaths'])
                    activation = {'laptop': laptop, 'storage': physical_storage, 'deviceNodes': device_nodes,
                                  'physicalGPU': report['physicalGPU'], 'cdi': report['cdi']}
                else:
                    need(any(row['Id'] == plan['native']['gpu']['currentLaptop']['id'] and
                             row['State']['Running'] is False for row in matching),
                         'Selected stopped laptop identity changed without observed activation')
                peers = []
                for row in rows:
                    if row.get('State', {}).get('Running') is True and row not in active:
                        _, facts = observer.limits(row)
                        peers.append({**facts, 'process': P._process(row['State']['Pid'])})
                need(sorted(peers, key=lambda x: x['containerId']) == plan['native']['peers'], 'Peer native continuity changed')
                for previous in plan['native']['providers']:
                    now = P._process(previous['pid'])
                    exe = (Path('/proc') / str(previous['pid']) / 'exe').stat()
                    need({**now, 'exeIdentity': [exe.st_dev, exe.st_ino]} == previous, 'Provider continuity changed')
                need(self.storage_identities(storage_paths(after, binding['sessionId'])) == plan['native']['selectedStorage'],
                     'Original selected storage identities changed')
                need(self.stable_binding(after, plan['selection']['employeeId']) == binding, 'Employee intent or recipe changed')
            terminal = self.metadata_stamps(after, binding)
            result = {'kind': 'GPU_BROKER_UPGRADE_OBSERVED', 'planSHA256': plan_sha256,
                      'configSHA256': digest(encoded(after)), 'selectedNormalActivation': activation,
                      'peerContainersPreserved': True, 'selectedProviderBindingsPreserved': True,
                      'nativeSelectedCDIBindingVerified': activation is not None,
                      'GPUComputeOrRenderingVerified': False, 'noWakeCommand': True}
        # All finalizers precede publication. The consumed attempt always remains.
        need(private(self.service.config_path) == encoded(after) and
             self.stable_binding(after, plan['selection']['employeeId']) == binding and
             self.storage_identities(storage_paths(after, binding['sessionId'])) == plan['native']['selectedStorage'] and
             self.metadata_stamps(after, binding) == terminal, 'Final metadata changed after finalizers')
        exclusive(self.operation / 'DONE.json', encoded(result))
        return result
