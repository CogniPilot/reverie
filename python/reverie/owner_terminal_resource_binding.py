"""Read-only H compatibility with canonical R configuration commits.

No writer, effect handle, credit or new authority store. The initial private H
policy keeps the exact non-resource domain and the actual R custody binding.
Subsequent resource bytes must be reachable through the existing protected
journal, profile draft, preparation ACK and exact configuration CAS history.
"""
from contextlib import contextmanager
import copy
import json
import os
from pathlib import Path
import subprocess
import time

from . import laptop_resource_operations as J
from . import worker_resource_reservations as R
from .employee_resource_profiles import ProfileStore, profile as validate_profile
from .worker_resources import (RESOURCE_FIELDS, validate_resource_reload,
                               project_resource_policy)

SCHEMA = 'reverie-h-resource-binding-v1'
ALLOWED = RESOURCE_FIELDS | {'sessionResources', 'employeeResources'}


def domain(config):
    # Deliberately stricter than R.domain_digest: image, browser policy, GPU,
    # actor/capability paths and every other grant remain H authority inputs.
    return J.fingerprint({k: v for k, v in config.items() if k not in ALLOWED})


class _HostBroker:
    """Fixed read-only bridge to the already pinned local engine HTTP client."""
    def __init__(self, config, path, engine):
        self.config, self.config_file, self.engine = config, path, engine

    def run_engine(self, args, optional=False, *, deadline=None):
        R.need(not optional and deadline is not None and time.monotonic() < deadline,
               'H_RESOURCE_NATIVE_DEADLINE')
        if args == ['ps', '-aq', '--no-trunc']:
            rows = self.engine.get('/containers/json?all=1')
            R.need(type(rows) is list and len(rows) <= R.MAX_CONTAINERS,
                   'H_RESOURCE_NATIVE_INVENTORY')
            ids = [row['Id'] for row in rows]
            R.need(len(ids) == len(set(ids)) and all(type(i) is str and len(i) == 64 and
                   all(c in '0123456789abcdef' for c in i) for i in ids), 'H_RESOURCE_NATIVE_INVENTORY')
            raw = '\n'.join(ids)
        else:
            R.need(args[:3] == ['inspect', '--format', R.ENGINE_FORMAT] and 1 <= len(args[3:]) <= 32,
                   'H_RESOURCE_METADATA_ONLY')
            selected = []
            for cid in args[3:]:
                R.need(time.monotonic() < deadline and type(cid) is str and len(cid) == 64 and
                       all(c in '0123456789abcdef' for c in cid), 'H_RESOURCE_NATIVE_DEADLINE')
                item = self.engine.get('/containers/' + cid + '/json')
                R.need(item.get('Id') == cid, 'H_RESOURCE_NATIVE_INVENTORY')
                selected.append({
                    'Id': cid, 'Name': item['Name'], 'Image': item['Image'],
                    'Config': {'Labels': item['Config']['Labels']},
                    'State': {k: item['State'][k] for k in ('Running', 'Pid')},
                    'Mounts': item['Mounts'],
                    'HostConfig': {k: item['HostConfig'][k] for k in
                                   ('Memory', 'MemorySwap', 'PidsLimit', 'NanoCpus')}})
            raw = '\n'.join(json.dumps(row, allow_nan=False) for row in selected)
        R.need(len(raw.encode()) <= R.MAX_NATIVE_BYTES and time.monotonic() < deadline,
               'H_RESOURCE_NATIVE_DEADLINE')
        return subprocess.CompletedProcess(args, 0, raw, '')


def _gate(config, path, engine):
    return R.ReservationGate(_HostBroker(copy.deepcopy(config), path, engine))


def capture(config, path, engine):
    """Explicit installer selection under the existing admission, no creation."""
    if R.option(config) is None:
        R.need(not R.configured(config), 'RESERVATION_POLICY_REMOVED')
        return None
    gate = _gate(config, path, engine)
    with gate.admission():
        gate.active_operations(_document(gate))  # includes orphan/pending consistency
        _profiles(gate)
        result = {'schema': SCHEMA, 'configuration': copy.deepcopy(config),
                  'reservationBinding': copy.deepcopy(gate.binding)}
    return result


def _prepared_edges(gate, document):
    """Read accepted durable records; these facts confer no effect capability."""
    uid = gate.broker.config['uid']; directory = gate.root/'operations'
    total = 0
    def read(path):
        nonlocal total
        size = path.lstat().st_size
        R.need(0 <= size <= J.MAX_BYTES, 'H_RESOURCE_HISTORY_BOUND')
        total += size
        R.need(total <= 8*R.MIB, 'H_RESOURCE_HISTORY_BOUND')
        return R._file(path, uid)
    drafts = {}
    for count, path in enumerate(directory.iterdir(), 1):
        R.need(count <= 4096, 'H_RESOURCE_HISTORY_BOUND')
        if path.name.startswith('draft-') and path.name.endswith('.json'):
            value = read(path)
            R.need(len(drafts) < 256, 'H_RESOURCE_HISTORY_BOUND')
            drafts[J.fingerprint(value)] = value
    edges = []
    for op in document['operations'].values():
        attempt_path = directory/('config-attempt-'+op['id']+'.json')
        if not os.path.lexists(attempt_path):
            continue
        # Unknown config publications cannot be converted into H availability.
        R.need(op['state'] in ('PREPARED', 'STARTING', 'STARTED', 'VERIFYING',
                               'VERIFY_RECORDED', 'COMPLETED'), 'H_RESOURCE_CONFIG_UNCONFIRMED')
        attempt = read(attempt_path)
        J.exact(attempt, ('schema', 'operationId', 'beforeDigest', 'afterDigest'))
        R.need(attempt['schema'] == 'reverie-resource-config-attempt-v1' and
               attempt['operationId'] == op['id'], 'H_RESOURCE_CONFIG_HISTORY')
        before = read(directory/('config-before-'+op['id']+'.json'))
        R.need(J.fingerprint(before) == attempt['beforeDigest'], 'H_RESOURCE_CONFIG_HISTORY')
        prepared = read(directory/('prepared-'+op['id']+'.json'))
        J.exact(prepared, ('schema', 'operationId', 'reservationId', 'profileVersion', 'profileDigest',
                          'beforeConfigDigest', 'afterConfigDigest', 'sourceBindingDigest', 'state'))
        draft = drafts.get(op['request']['preview_digest'])
        R.need(type(draft) is dict and draft.get('schema') == 'reverie-resource-private-draft-v1' and
               draft.get('scope') == gate.scope and draft.get('operationId') == op['id'] and
               draft.get('reservationId') == op['reservation_id'] and
               draft.get('targetSid') == op['reserved_sid'], 'H_RESOURCE_PROFILE_HISTORY')
        profile = draft['profile']; validate_profile(profile, op['request']['employee_id'])
        binding = profile['binding']
        R.need(str(profile['version']) == op['request']['profile_version'] and
               binding['current_sid'] == op['observation']['current_sid'] and
               binding['target_sid'] == op['reserved_sid'] and
               profile['resources']['memoryMiB']*J.MIB == J.memory(op['request']['requested_memory_bytes']),
               'H_RESOURCE_PROFILE_HISTORY')
        R.need(prepared == {'schema': 'reverie-resource-native-preparation-v1',
            'operationId': op['id'], 'reservationId': op['reservation_id'],
            'profileVersion': profile['version'], 'profileDigest': J.fingerprint(profile),
            'beforeConfigDigest': attempt['beforeDigest'], 'afterConfigDigest': attempt['afterDigest'],
            'sourceBindingDigest': op['observation']['source_binding_digest'],
            'state': 'PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED'}, 'H_RESOURCE_CONFIG_HISTORY')
        if op['state'] == 'PREPARED':
            R.need(op['last_receipt_digest'] == J.fingerprint(prepared), 'H_RESOURCE_CONFIG_UNCONFIRMED')
        projected = copy.deepcopy(before)
        resources = project_resource_policy(before, profile['resources'])
        projected.setdefault('employeeResources', {})[op['request']['employee_id']] = copy.deepcopy(resources)
        projected.setdefault('sessionResources', {})[op['reserved_sid']] = copy.deepcopy(resources)
        candidate = R.compatibility_candidate(before, projected, binding['current_sid'], binding['target_sid'])
        R.need(J.fingerprint(candidate) == attempt['afterDigest'], 'H_RESOURCE_CONFIG_HISTORY')
        edges.append((attempt['beforeDigest'], attempt['afterDigest'], before, candidate))
    return edges


def _document(gate):
    # The accepted preparation reader holds/checks the real operations flock
    # and existing directory identity. Outer admission supplies both native
    # brackets; avoid running another native census inside each payload read.
    from .worker_resource_preparation import _document as read_document
    value = read_document(gate)[0]
    R.need(all(op['scope'] == gate.scope and op['request']['pool_id'] == gate.option['poolId']
               for op in value['operations'].values()), 'H_RESOURCE_SCOPE_CHANGED')
    return value


def _profiles(gate):
    # Existing atomic-file reader/closed schema, no new decoder or write API.
    # The global admission and outer full leaf/ancestry stamp bracket cover the
    # observation; no O_RDWR profile lock or payload permission is required.
    store = ProfileStore(gate.root/'profiles')
    try:
        value = store._load()
        store._root()
        return value
    finally: store.close()


def _validate(gate, binding, current):
    J.exact(binding, ('schema', 'configuration', 'reservationBinding'))
    R.need(binding['schema'] == SCHEMA and gate.binding == binding['reservationBinding'],
           'H_RESOURCE_CONTROL_CHANGED')
    baseline = binding['configuration']
    R.need(domain(current) == domain(baseline), 'H_WORKER_AUTHORITY_CHANGED')
    validate_resource_reload(baseline, current)
    document = _document(gate)
    gate.active_operations(document)  # accepted completion/orphan reader, never credit
    edges = _prepared_edges(gate, document)
    wanted = J.fingerprint(current); reached = {J.fingerprint(baseline)}
    for _ in range(len(edges)+1):
        added = {after for before, after, _b, _a in edges if before in reached}
        if added <= reached: break
        reached |= added
    R.need(wanted in reached, 'H_RESOURCE_CONFIG_NOT_CANONICAL')
    return document, _profiles(gate)


def _stamps(gate):
    # Stat-only terminal bracket: no decoder, native producer or FD finalizer
    # follows it. Directory stamps detect newly inserted/removed history leaves.
    paths = [R.marker(gate.broker.config), gate.root, gate.root/'profiles',
             gate.root/'operations', gate.root/'admission.lock']
    for directory in (gate.root/'profiles', gate.root/'operations'):
        entries = list(directory.iterdir())
        R.need(len(entries) <= 4096, 'H_RESOURCE_HISTORY_BOUND')
        paths.extend(entries)
    paths.extend({parent for path in paths for parent in path.parents})
    result = {}
    for path in paths:
        info = path.lstat()
        result[str(path)] = (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                            info.st_gid, info.st_nlink, info.st_size,
                            info.st_mtime_ns, info.st_ctime_ns)
    return result


@contextmanager
def observation(binding, current, path, engine):
    """Hold the canonical cross-process admission through all H native I/O."""
    gate = _gate(current, path, engine)
    with gate.admission():
        stamps = _stamps(gate)
        document = _validate(gate, binding, current)
        yield
        R.need(_validate(gate, binding, current) == document, 'H_RESOURCE_JOURNAL_CHANGED')
    R.need(_stamps(gate) == stamps, 'H_RESOURCE_METADATA_CHANGED')
    # Native admission-exit custody/finalizers precede the caller's final private
    # config/parent/stat brackets. No handle, lock or reservation is retained.


def locking_paths(config):
    """Exact existing lock leaves needed by canonical readers in an H sandbox.

    R directories and all payload files remain read-only. Neither leaf is
    created here; missing/rebound identities refuse. The service merely needs
    O_RDWR for accepted flock users, not write access to any journal directory.
    """
    selected = R.option(config)
    if selected is None:
        R.need(not R.configured(config), 'RESERVATION_POLICY_REMOVED')
        return []
    binding = R._file(R.marker(config), config['uid'])
    R.need(binding.get('state') == 'READY' and binding.get('option') == selected and
           binding.get('configurationDigest') == R.domain_digest(config), 'H_RESOURCE_CONTROL_CHANGED')
    root = Path(selected['directory'])
    paths = [(root/'admission.lock', binding['admissionLock']),
             (root/'operations/operations.lock', binding['locks']['operations'])]
    import stat
    for path, expected in paths:
        parent, identity = R._directory(path.parent, config['uid'])
        fd = None
        try:
            expected_parent = binding['directories']['.' if path.parent == root else 'operations']
            R.need(identity == expected_parent, 'H_RESOURCE_LOCK_CHANGED')
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
            info = os.fstat(fd)
            R.need(stat.S_ISREG(info.st_mode) and info.st_uid == config['uid'] and
                   stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and
                   [info.st_dev, info.st_ino] == expected and
                   (path.lstat().st_dev, path.lstat().st_ino) == (info.st_dev, info.st_ino),
                   'H_RESOURCE_LOCK_CHANGED')
        finally:
            try:
                if fd is not None: os.close(fd)
            finally: os.close(parent)
        named = path.parent.lstat()
        R.need([named.st_dev, named.st_ino] == identity and stat.S_ISDIR(named.st_mode), 'H_RESOURCE_LOCK_CHANGED')
    return [path for path, _expected in paths]


def require_disjoint_roots(config, roots):
    """Keep H purpose directories outside R authority in both directions.

    Only the two separately validated lock *files* may become writable. This
    check runs before constructors/guards/unit generation can approve a broad H
    ReadWritePaths root. Existing mount backing coordinates cover bind aliases
    and nested aliases, without any filesystem walk or host mutation.
    """
    if not R.configured(config):
        return
    # Constructor-only use of the actual canonical binding validator. No engine
    # port is installed or invoked, no directory/lock/file is created here.
    gate = R.ReservationGate(_HostBroker(config, None, None))
    selected = list(roots)
    R.need(1 <= len(selected) <= 8, 'H_RESOURCE_PURPOSE_ROOT_BOUND')
    paths = [gate.root, *(Path(path) for path in selected)]
    identities = {}
    import stat
    for path in paths:
        fd, identity = R._directory(path, config['uid'])
        try:
            info = os.fstat(fd)
            if path == gate.root:
                R.need(identity == gate.binding['directories']['.'], 'H_RESOURCE_CONTROL_CHANGED')
            identities[path] = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
        finally: os.close(fd)
    ancestry = {}
    for parent in {parent for path in paths for parent in path.parents}:
        info = parent.lstat()
        ancestry[parent] = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
    table = R.read_mount_table()
    from .worker_cold_tmp import refuse_host_mount_aliases
    for path in paths[1:]:
        R.need(not R._overlap(path, gate.root) and
               identities[path][:2] != identities[gate.root][:2], 'H_RESOURCE_PURPOSE_ROOT_OVERLAP')
        # Both directions matter: a nested R alias under a broad H directory,
        # or a nested H alias under broad R custody, is also a shared purpose.
        refuse_host_mount_aliases(gate.root, path, table)
        refuse_host_mount_aliases(path, gate.root, table)
    R.need(R.read_mount_table() == table, 'H_RESOURCE_PURPOSE_MOUNTS_CHANGED')
    marker = R.marker(config)
    info = marker.lstat()
    marker_stamp = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
                    info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    R.need(R._file(marker, config['uid']) == gate.binding and not os.path.lexists(R.pending(config)),
           'H_RESOURCE_CONTROL_CHANGED')
    # All native reads and descriptor cleanup finish before these static
    # ancestry/root/marker brackets. A late rename or parent symlink refuses.
    for path, expected in identities.items():
        info = path.lstat()
        R.need(stat.S_ISDIR(info.st_mode) and
               (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid) == expected,
               'H_RESOURCE_PURPOSE_ROOT_CHANGED')
        for parent in path.parents:
            info = parent.lstat()
            R.need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, config['uid']) and
                   (not info.st_mode & 0o022 or info.st_uid == 0 and info.st_mode & stat.S_ISVTX) and
                   (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid) == ancestry[parent],
                   'H_RESOURCE_PURPOSE_ANCESTRY_CHANGED')
    info = marker.lstat()
    R.need((info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns) == marker_stamp, 'H_RESOURCE_CONTROL_CHANGED')
