"""Explicit first actor-key enablement of an existing pristine reservation domain.

No provision, service action, owner grant, image preparation or launch occurs.
A failed attempt retains the canonical pending fence and immutable evidence.
"""
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time

from . import worker_resource_reservations as R
from . import laptop_resource_operations as J
from . import employee_resource_profiles as E
from .worker import load_config, validate_config
from .worker_resources import policy_digest
from .worker_storage import read_metadata, storage_paths
from .worker_service_upgrade import GPUUpgrade, private, stamp, exclusive, sync, encoded, digest
from .worker_resource_preparation import _document

KIND = 'RESOURCE_ACTOR_FIRST_ENABLE_V1'


class _Transition:
    def __init__(self, gate, fence, rows):
        self.gate, self.fence, self.rows = gate, fence, rows


def owns_pending(gate):
    record = getattr(gate._local, 'actor_bootstrap', None)
    return (type(record) is _Transition and record.gate is gate and
            stamp(R.pending(gate.broker.config)) == record.fence and
            getattr(gate._local, 'depth', 0) == 1)


def check_transition_rows(gate, rows):
    record = getattr(gate._local, 'actor_bootstrap', None)
    R.need(type(record) is _Transition and record.gate is gate and rows == record.rows,
           'ACTOR_BOOTSTRAP_NATIVE_CHANGED')


def _read(path):
    raw = private(path)
    return json.loads(raw), raw, stamp(path)


def _parents(paths):
    result = {}
    for path in paths:
        for parent in Path(path).parents:
            st = parent.lstat()
            sticky = st.st_uid == 0 and bool(st.st_mode & stat.S_ISVTX)
            R.need(stat.S_ISDIR(st.st_mode) and st.st_uid in (0, os.getuid()) and
                   (not st.st_mode & 0o022 or sticky), 'ACTOR_BOOTSTRAP_PARENT')
            result[str(parent)] = [st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode]
    return result


def _parents_current(expected):
    for name, identity in expected.items():
        st = Path(name).lstat()
        R.need([st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode] == identity,
               'ACTOR_BOOTSTRAP_PARENT_CHANGED')


def _leaves(expected):
    for name, identity in expected.items():
        path = Path(name)
        R.need((stamp(path) if os.path.lexists(path) else None) == identity,
               'ACTOR_BOOTSTRAP_FILE_CHANGED')


def _pristine(gate):
    # Reject every retained artifact, including drafts, completion receipts and
    # emptied-but-revisioned stores. Never initialize, erase or migrate history.
    R.need({p.name for p in gate.root.iterdir()} == {'admission.lock', 'operations', 'profiles'},
           'ACTOR_BOOTSTRAP_HISTORY')
    for name, permitted in [('operations', {'operations.lock', 'operations.json'}),
                            ('profiles', {'profiles.lock', 'profiles.json'})]:
        actual = {p.name for p in (gate.root / name).iterdir()}
        required = permitted if name == 'operations' else {'profiles.lock'}
        R.need(required <= actual <= permitted, 'ACTOR_BOOTSTRAP_HISTORY')
    document, _ = _document(gate)
    R.need(document == {'schema': J.SCHEMA, 'revision': 0, 'operations': {}},
           'ACTOR_BOOTSTRAP_RETAINED_OPERATIONS')
    profiles = E.ProfileStore(gate.root / 'profiles')
    try:
        value = profiles.snapshot()
    finally:
        profiles.close()
    R.need(value == {'schema': 'reverie-employee-resource-profiles-v1', 'revision': 0, 'profiles': {}},
           'ACTOR_BOOTSTRAP_RETAINED_PROFILES')
    paths = [gate.root / 'admission.lock', gate.root / 'operations/operations.lock',
             gate.root / 'operations/operations.json', gate.root / 'profiles/profiles.lock',
             gate.root / 'profiles/profiles.json']
    return {str(p): stamp(p) if os.path.lexists(p) else None for p in paths}


def _history_stamp(info):
    return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def _history_inventory(gate):
    """Closed pristine namespaces, through held no-follow directory FDs.

    This never opens a store for writing or creates its locks. Directory and
    entry metadata include mutation times; missing versus empty stays distinct.
    Every descriptor finalizer precedes the final named-directory bracket.
    """
    result = {}
    specifications = [('.', {'admission.lock', 'operations', 'profiles'},
                       {'admission.lock', 'operations', 'profiles'}),
                      ('operations', {'operations.lock', 'operations.json'},
                       {'operations.lock', 'operations.json'}),
                      ('profiles', {'profiles.lock'}, {'profiles.lock', 'profiles.json'})]
    for name, required, allowed in specifications:
        path = gate.root if name == '.' else gate.root / name
        fd, _ = R._directory(path, gate.broker.config['uid'])
        try:
            before = _history_stamp(os.fstat(fd)); entries = {}
            with os.scandir(fd) as stream:
                for count, entry in enumerate(stream, 1):
                    R.need(count <= 4 and entry.name in allowed, 'ACTOR_BOOTSTRAP_HISTORY')
                    info = entry.stat(follow_symlinks=False)
                    directory = name == '.' and entry.name in ('operations', 'profiles')
                    R.need((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and
                           info.st_uid == gate.broker.config['uid'] and
                           stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600) and
                           (directory or info.st_nlink == 1), 'ACTOR_BOOTSTRAP_HISTORY_CUSTODY')
                    entries[entry.name] = _history_stamp(info)
            R.need(required <= set(entries) <= allowed and _history_stamp(os.fstat(fd)) == before and
                   _history_stamp(path.lstat()) == before, 'ACTOR_BOOTSTRAP_HISTORY_CHANGED')
            result[name] = {'directory': before, 'entries': entries}
        finally:
            os.close(fd)
    return result


def _history_scan(gate, expected):
    R.need(_history_inventory(gate) == expected, 'ACTOR_BOOTSTRAP_HISTORY_CHANGED')


def _history_named_current(gate, expected):
    # All scans, fstats, context and FD finalizers precede the last named facts.
    # A late insertion/removal during another scan changes its parent's stamp.
    for name, record in expected.items():
        path = gate.root if name == '.' else gate.root / name
        for entry, identity in record['entries'].items():
            R.need(_history_stamp((path / entry).lstat()) == identity,
                   'ACTOR_BOOTSTRAP_HISTORY_CHANGED')
    for name, record in expected.items():
        path = gate.root if name == '.' else gate.root / name
        R.need(_history_stamp(path.lstat()) == record['directory'],
               'ACTOR_BOOTSTRAP_HISTORY_CHANGED')


def _history_current(gate, expected):
    _history_scan(gate, expected)
    _history_named_current(gate, expected)


def _after(raw, before, root):
    R.need(type(before) is dict and 'resourceActorConfig' not in before,
           'ACTOR_BOOTSTRAP_ALREADY_SELECTED')
    after = copy.deepcopy(before)
    after['resourceActorConfig'] = str(root / 'resource-actor.json')
    R.need(validate_config(after) == after, 'ACTOR_BOOTSTRAP_CANDIDATE')
    # Preserve every original byte, inserting only the one new field.
    end = raw.rfind(b'}')
    R.need(end >= 0 and not raw[end + 1:].strip(), 'ACTOR_BOOTSTRAP_CONFIG_ENCODING')
    addition = b',"resourceActorConfig":' + json.dumps(after['resourceActorConfig']).encode()
    changed = raw[:end] + addition + raw[end:]
    R.need(json.loads(changed) == after, 'ACTOR_BOOTSTRAP_CONFIG_ENCODING')
    return after, changed


def _marker_after(raw, before, after):
    changed, count = re.subn(rb'("configurationDigest"\s*:\s*")' +
                            before['configurationDigest'].encode() + rb'(")',
                            lambda m: m[1] + after['configurationDigest'].encode() + m[2], raw)
    R.need(count == 1 and json.loads(changed) == after, 'ACTOR_BOOTSTRAP_MARKER_ENCODING')
    return changed


class Bootstrap:
    """Fixed WorkerService composition, not a caller-selected native executor."""
    def __init__(self, service, operation):
        from .worker_service import WorkerService
        R.need(type(service) is WorkerService, 'ACTOR_BOOTSTRAP_FIXED_SERVICE')
        self.tools = GPUUpgrade(service, operation)
        self.service, self.operation = service, self.tools.operation
        self.deadline = self.tools.deadline
        self.uid = os.getuid()
        fd, self.operation_identity = R._directory(self.operation, self.uid)
        os.close(fd)

    def _time(self):
        R.need(time.monotonic() < self.deadline, 'ACTOR_BOOTSTRAP_DEADLINE')

    def _expiry(self, plan):
        R.need(time.time() < plan['expiresAt'], 'ACTOR_BOOTSTRAP_PLAN_EXPIRED')
        self._time()

    def _registration(self):
        value = self.tools.generation()
        # Configuration changes intentionally; the registered unit/env/root do not.
        value.pop('configSHA256')
        value['stamps'].pop('config')
        return value

    def _sockets_absent(self, config):
        R.need(not os.path.lexists(config['socket']), 'ACTOR_BOOTSTRAP_SOCKET_PRESENT')
        root = Path(config['apiSocketRoot'])
        if os.path.lexists(root):
            fd, _ = R._directory(root, self.uid)
            try:
                with os.scandir(fd) as entries:
                    for count, entry in enumerate(entries, 1):
                        R.need(count <= 1024 and entry.is_dir(follow_symlinks=False),
                               'ACTOR_BOOTSTRAP_SOCKET_LAYOUT')
                        R.need(not os.path.lexists(root / entry.name / 'office.sock'),
                               'ACTOR_BOOTSTRAP_SOCKET_PRESENT')
            finally:
                os.close(fd)
        # Initial enablement refuses existing H consumers, including an inactive
        # unit. Their coordinated domain refresh is a different transaction.
        homes = {self.service.home / '.config',
                 Path(os.environ.get('XDG_CONFIG_HOME', str(self.service.home / '.config')))}
        R.need(not any(os.path.lexists(h / 'systemd/user/reverie-owner-terminal.service') for h in homes),
               'ACTOR_BOOTSTRAP_H_CONSUMER')

    def _inactive(self, config):
        value = self.tools.manager_state(active=False)
        self._sockets_absent(config)
        return value

    def _providers(self, pids):
        from .worker_gpu_preflight import _process
        result = []
        for pid in pids:
            self._time()
            facts = _process(pid)
            root = Path('/proc') / str(pid)
            with (root / 'cmdline').open('rb') as stream:
                raw = stream.read(16385)
            R.need(len(raw) <= 16384, 'ACTOR_BOOTSTRAP_PROCESS_BOUND')
            exe = (root / 'exe').stat()
            R.need(_process(pid) == facts, 'ACTOR_BOOTSTRAP_PROCESS_CHANGED')
            result.append({**facts, 'exeIdentity': [exe.st_dev, exe.st_ino], 'argvSHA256': digest(raw)})
        return result

    def _native(self, gate, selection):
        rows = gate._guard()
        gate.check_headroom()
        from .worker_gpu_preflight import _process
        storage, policies, kernels, roots, managed, current = {}, {}, {}, {}, {}, {}
        company = read_metadata(gate.broker.config['companyFile'], self.uid)
        R.need(type(company) is dict and type(company.get('employees')) is list and
               len(company['employees']) <= 256, 'ACTOR_BOOTSTRAP_REGISTRY')
        for employee in company['employees']:
            R.need(type(employee) is dict, 'ACTOR_BOOTSTRAP_REGISTRY')
            sid = employee.get('sessionId')
            if sid:
                J.canonical_uuid(sid)
                R.need(sid not in policies, 'ACTOR_BOOTSTRAP_DUPLICATE_SID')
                J.canonical_uuid(employee.get('id'))
                R.need(type(employee.get('sessionGeneration')) is int and employee['sessionGeneration'] >= 1,
                       'ACTOR_BOOTSTRAP_CURRENT_GENERATION')
                current[sid] = employee
                policies[sid] = policy_digest(gate.broker.config, sid)
        for row in rows:
            labels = row.get('Config', {}).get('Labels') or {}
            if row['State']['Running']:
                kernels[row['Id']] = gate.native.limits(row)
                if labels.get('reverie.worker') == gate.broker.config['deployment']:
                    sid = labels.get('reverie.session')
                    R.need(sid in current and labels.get('reverie.employee') == current[sid]['id'] and
                           row.get('Name') == '/' + gate.broker.config['deployment'] + '-agent-' + sid and
                           row.get('Image') == gate.broker.config['image'] and
                           labels.get('reverie.worker-policy') == policies[sid] and sid not in managed,
                           'ACTOR_BOOTSTRAP_UNBOUND_WORKER')
                    process = _process(row['State']['Pid'])
                    R.need(str(process['startTick']) == kernels[row['Id']][1]['start'],
                           'ACTOR_BOOTSTRAP_INIT_CHANGED')
                    managed[sid] = {'employeeId': current[sid]['id'],
                                    'generation': current[sid]['sessionGeneration'], 'process': process}
                    paths = storage_paths(gate.broker.config, sid)
                    storage[row['Id']] = gate.native.storage(row, paths)
                    for destination, source in [('/home/agent', paths.home), ('/nix', paths.nix), ('/scratch', paths.scratch)]:
                        roots[str(source)] = list(R._identity(source))
                        guest = R.PROC / str(row['State']['Pid']) / 'root' / destination.lstrip('/')
                        roots[str(guest)] = list(R._identity(guest))
        providers = self._providers(selection['providerPIDs'])
        for provider in providers:
            R.need(any(provider['namespaces'] == member['process']['namespaces'] and
                       provider['rootIdentity'] == member['process']['rootIdentity']
                       for member in managed.values()), 'ACTOR_BOOTSTRAP_PROVIDER_OUTSIDE_CURRENT_LAPTOPS')
        R.need(gate._guard() == rows, 'ACTOR_BOOTSTRAP_NATIVE_CHANGED')
        return json.loads(encoded({'rows': rows, 'storage': storage, 'policies': policies,
                'kernels': kernels, 'providers': providers, 'roots': roots, 'managed': managed}))

    def _context(self, selection):
        config = self.service.positive_preflight(installing=True)
        R.need(config['uid'] == self.uid == os.geteuid() and config['gid'] == os.getgid(),
               'ACTOR_BOOTSTRAP_OWNER')
        R.need('resourceActorConfig' not in config, 'ACTOR_BOOTSTRAP_ALREADY_SELECTED')
        probe = self.service.resource_probe(config); probe.config_file = self.service.config_path
        gate = R.ReservationGate(probe)
        R.need(not R._overlap(self.operation, gate.root) and
               not R._overlap(self.operation, Path(config['stateRoot'])) and
               not R._overlap(self.operation, Path(config['scratchRoot'])), 'ACTOR_BOOTSTRAP_OPERATION_LOCATION')
        gate.native.custody(self.operation, R.marker(config), deadline=self.deadline)
        return gate

    def _selection(self, path):
        value = json.loads(private(Path(path), maximum=65536))
        R.need(type(value) is dict and set(value) == {'providerPIDs'}, 'ACTOR_BOOTSTRAP_SELECTION')
        pids = value['providerPIDs']
        R.need(type(pids) is list and len(pids) <= 512 and
               all(type(p) is int and p > 1 for p in pids) and len(set(pids)) == len(pids),
               'ACTOR_BOOTSTRAP_SELECTION')
        return {'providerPIDs': sorted(pids)}

    def _snapshot(self, gate, selection):
        before, raw, config_stamp = _read(self.service.config_path)
        R.need(before == gate.broker.config, 'ACTOR_BOOTSTRAP_CONFIG_CHANGED')
        binding, marker_raw, marker_stamp = _read(R.marker(before))
        R.need(binding == gate.binding, 'ACTOR_BOOTSTRAP_MARKER_CHANGED')
        stores = _pristine(gate)
        history = _history_inventory(gate)
        company = Path(before['companyFile'])
        _, company_raw, company_stamp = _read(company)
        registration = self._registration(); inactive = self._inactive(before)
        native = self._native(gate, selection)
        gate.native.custody(self.operation, R.marker(before), deadline=self.deadline)
        after, changed = _after(raw, before, gate.root)
        new_binding = copy.deepcopy(binding); new_binding['configurationDigest'] = R.domain_digest(after)
        new_marker_raw = _marker_after(marker_raw, binding, new_binding)
        leaves = {**stores, str(self.service.config_path): config_stamp,
                  str(R.marker(before)): marker_stamp, str(company): company_stamp,
                  **{str(p): stamp(p) for p in (self.service.unit, self.service.environment, self.service.gcroot)}}
        parents = _parents([*leaves, self.operation / 'PLAN.json'])
        self._static_native(native, before)
        _history_current(gate, history)
        _parents_current(parents); _leaves(leaves)
        self._time()
        return {'kind': KIND, 'selection': selection, 'before': before, 'after': after,
                'beforeRaw': raw.decode(), 'afterRaw': changed.decode(),
                'beforeMarker': marker_raw.decode(), 'afterMarker': new_marker_raw.decode(),
                'leaves': leaves, 'parents': parents, 'registration': registration, 'inactive': inactive,
                'native': native, 'history': history, 'companySHA256': digest(company_raw), 'operationIdentity': self.operation_identity}

    def prepare(self, selection_path):
        from .worker_service_upgrade import directory_lock
        with directory_lock(self.operation):
            R.need({p.name for p in self.operation.iterdir()} == {'operation.lock'},
                   'ACTOR_BOOTSTRAP_OPERATION_USED')
            selection = self._selection(selection_path)
            gate = self._context(selection)
            with gate.admission(deadline=self.deadline):
                plan = self._snapshot(gate, selection)
                plan['expiresAt'] = int(time.time()) + 300
                exclusive(self.operation / 'PLAN.json', encoded(plan))
            # Preparation effects are confined to private evidence. Apply takes
            # a new complete snapshot; no stale prepare observation authorizes CAS.
            return {'planSHA256': digest(private(self.operation / 'PLAN.json')), 'enabled': False}

    def apply(self, expected):
        from .worker_service_upgrade import directory_lock
        record = None; gate = None
        try:
            with directory_lock(self.operation):
                R.need(not os.path.lexists(self.operation / 'ATTEMPT.json'), 'ACTOR_BOOTSTRAP_ATTEMPT_USED')
                raw = private(self.operation / 'PLAN.json')
                R.need(type(expected) is str and re.fullmatch('[0-9a-f]{64}', expected) and digest(raw) == expected,
                       'ACTOR_BOOTSTRAP_PLAN_DIGEST')
                plan = json.loads(raw)
                R.need(type(plan) is dict and plan.get('kind') == KIND and
                       type(plan.get('expiresAt')) is int and time.time() < plan['expiresAt'],
                       'ACTOR_BOOTSTRAP_PLAN_EXPIRED')
                gate = self._context(plan['selection'])
                with gate.admission(deadline=self.deadline):
                    fresh = self._snapshot(gate, plan['selection'])
                    R.need(fresh == {k: v for k, v in plan.items() if k != 'expiresAt'},
                           'ACTOR_BOOTSTRAP_PLAN_CHANGED')
                    # Immutable originals precede the durable attempt and fence.
                    for name, content in [('CONFIG.before', plan['beforeRaw']), ('CONFIG.after', plan['afterRaw']),
                                          ('MARKER.before', plan['beforeMarker']), ('MARKER.after', plan['afterMarker'])]:
                        exclusive(self.operation / name, content.encode())
                    self._expiry(plan)
                    exclusive(self.operation / 'ATTEMPT.json', encoded({'kind': KIND, 'planSHA256': expected}))
                    fence = {'schema': 'reverie-resource-actor-enable-pending-v1', 'planSHA256': expected,
                             'operation': str(self.operation), 'beforeDigest': R.domain_digest(plan['before']),
                             'afterDigest': R.domain_digest(plan['after'])}
                    exclusive(R.pending(plan['before']), encoded(fence))
                    record = _Transition(gate, stamp(R.pending(plan['before'])), copy.deepcopy(plan['native']['rows']))
                    gate._local.actor_bootstrap = record
                    # Complete all blocking fixed readers after intent/fsync and
                    # before final leaves/CAS. No external callback is accepted.
                    self._verify(gate, plan, plan['leaves'])
                    self._replace(self.service.config_path, plan['afterRaw'].encode(), plan['leaves'], plan, gate, record)
                    intermediate = {**plan['leaves'], str(self.service.config_path): stamp(self.service.config_path)}
                    self._replace(R.marker(plan['before']), plan['afterMarker'].encode(),
                                  intermediate, plan, gate, record)
                    gate.broker.config = plan['after']; gate.binding = json.loads(plan['afterMarker'])
                    terminal = {**plan['leaves'], str(self.service.config_path): stamp(self.service.config_path),
                                str(R.marker(plan['after'])): stamp(R.marker(plan['after']))}
                    self._verify(gate, plan, terminal)
            # Admission native checks and all FD finalizers must succeed
            # before recording/releasing. Failed/unknowns keep the fence.
            self._verify_terminal(gate, plan, terminal)
            exclusive(self.operation / 'RESULT.json', encoded({'state': 'ENABLED_REQUIRES_INSTALL',
                      'planSHA256': expected, 'afterConfigSHA256': digest(plan['afterRaw'].encode()),
                      'afterMarkerSHA256': digest(plan['afterMarker'].encode()),
                      'acceptanceRequiresPendingAbsent': True, 'started': False}))
            # Finish history scans and every FD finalizer before the final
            # process/root/global/static bracket. No producer follows it.
            _history_scan(gate, plan['history'])
            R.need(self._providers(plan['selection']['providerPIDs']) == plan['native']['providers'],
                   'ACTOR_BOOTSTRAP_PROCESS_CHANGED')
            self._static_native(plan['native'], gate.broker.config)
            _parents_current(plan['parents']); _leaves(terminal)
            _history_named_current(gate, plan['history'])
            R.need(stamp(R.pending(plan['after'])) == record.fence, 'ACTOR_BOOTSTRAP_PENDING_CHANGED')
            self._expiry(plan)
            os.unlink(R.pending(plan['after']))  # last operation; crash resurrection safely refuses
            return {'enabled': True, 'installationRequired': True, 'started': False}
        except BaseException:
            if record is not None:
                raise RuntimeError('ACTOR_BOOTSTRAP_RECONCILIATION_REQUIRED') from None
            raise
        finally:
            if gate is not None:
                gate._local.actor_bootstrap = None

    def _replace(self, path, raw, leaves, plan, gate, record):
        path = Path(path); temporary = path.with_name(path.name + '.actor-enable-next')
        exclusive(temporary, raw)
        self._static_native(plan['native'], gate.broker.config)
        _parents_current(plan['parents']); _leaves(leaves)
        R.need(stamp(R.pending(gate.broker.config)) == record.fence,
               'ACTOR_BOOTSTRAP_CAS_CHANGED')
        self._expiry(plan); os.replace(temporary, path); sync(path.parent)

    def _verify(self, gate, plan, leaves):
        R.need(self._registration() == plan['registration'] and self._inactive(gate.broker.config) == plan['inactive'],
               'ACTOR_BOOTSTRAP_SERVICE_CHANGED')
        R.need(_pristine(gate) == {p: s for p, s in leaves.items() if Path(p).is_relative_to(gate.root)},
               'ACTOR_BOOTSTRAP_STORES_CHANGED')
        R.need(self._native(gate, plan['selection']) == plan['native'], 'ACTOR_BOOTSTRAP_NATIVE_CHANGED')
        gate.native.custody(self.operation, R.marker(gate.broker.config), deadline=self.deadline)
        self._static_native(plan['native'], gate.broker.config)
        _parents_current(plan['parents']); _leaves(leaves)
        R.need(owns_pending(gate), 'ACTOR_BOOTSTRAP_PENDING_CHANGED'); self._expiry(plan)

    def _verify_terminal(self, gate, plan, leaves):
        # No gate calls outside admission. Native source observation remains
        # bounded and non-atomic against uncooperating host changes.
        R.need(self._registration() == plan['registration'] and self._inactive(gate.broker.config) == plan['inactive'],
               'ACTOR_BOOTSTRAP_SERVICE_CHANGED')
        R.need(gate.native.inventory(deadline=self.deadline) == plan['native']['rows'] and
               self._providers(plan['selection']['providerPIDs']) == plan['native']['providers'],
               'ACTOR_BOOTSTRAP_NATIVE_CHANGED')
        self._static_native(plan['native'], gate.broker.config)
        _parents_current(plan['parents']); _leaves(leaves); self._expiry(plan)

    def _static_native(self, expected, config):
        # Fixed physical path/namespace identities after the final blocking
        # producer, without another native observation loop.
        from .worker_gpu_preflight import _process
        for member in expected['managed'].values():
            R.need(_process(member['process']['pid']) == member['process'], 'ACTOR_BOOTSTRAP_INIT_CHANGED')
        for row in expected['rows']:
            if row['State']['Running']:
                actual = expected['kernels'][row['Id']][1]
                R.need(R._pid(row['State']['Pid']) == actual['start'], 'ACTOR_BOOTSTRAP_INIT_CHANGED')
        self._sockets_absent(config)
        for name, identity in expected['roots'].items():
            R.need(list(R._identity(Path(name))) == identity, 'ACTOR_BOOTSTRAP_STORAGE_CHANGED')
