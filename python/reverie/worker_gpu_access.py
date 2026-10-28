"""Fixed owner-local GPU queue and stopped-seat config transition.

Only Broker's owner-UID C socket dispatches this module. OfficeAPI never does.
Requests are intent, not launch permission. No stop/start/device workload exists
here. A failed config/binding publication leaves the existing R pending fence.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

from . import laptop_resource_operations as J
from . import worker_gpu as G
from . import worker_resource_reservations as R
from .worker_resources import policy_digest
from .worker_storage import read_metadata, storage_paths, storage_start_allowed

NAME = 'gpu-owner-requests.json'
UUID = re.compile(r'GPU-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\Z')
SCHEMA = 'reverie-owner-gpu-requests-v1'


def _stamp(path):
    s = Path(path).lstat()
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_nlink,
            s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def _private(path, uid):
    path = Path(path)
    before = _stamp(path)
    R.need(stat.S_ISREG(before[2]) and stat.S_IMODE(before[2]) == 0o600 and
           before[3] == uid and before[4] == 1, 'GPU_PRIVATE_FILE')
    # Accepted bounded no-follow private metadata reader, no payload disclosure.
    value = read_metadata(str(path), uid, limit=J.MAX_BYTES)
    R.need(_stamp(path) == before, 'GPU_PRIVATE_FILE_CHANGED')
    return value, before


def _parents(paths):
    result = {}
    for path in paths:
        for parent in Path(path).parents:
            st = parent.lstat()
            R.need(stat.S_ISDIR(st.st_mode), 'GPU_PARENT_CUSTODY')
            result[parent] = (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid)
    return result


def _parents_current(expected):
    for path, identity in expected.items():
        st = path.lstat()
        R.need((st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid) == identity,
               'GPU_PARENT_CUSTODY_CHANGED')


def _replace(path, value, expected):
    """Same-directory O_EXCL/fsync/CAS/rename; uncertain files are retained."""
    path = Path(path)
    temporary = path.with_name(path.name + '.gpu-' + str(uuid.uuid4()))
    R._write_exclusive(temporary, value)
    R.need((_stamp(path) if os.path.lexists(path) else None) == expected, 'GPU_FILE_CAS_CHANGED')
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _current(config, eid):
    J.canonical_uuid(eid)
    company = read_metadata(config['companyFile'], config['uid'])
    rows = company.get('employees') if type(company) is dict else None
    R.need(type(rows) is list and len(rows) <= 256, 'GPU_CURRENT_REGISTRY')
    matches = [r for r in rows if type(r) is dict and r.get('id') == eid]
    R.need(len(matches) == 1, 'GPU_CURRENT_EMPLOYEE')
    row = matches[0]
    actual = G.current_employee(config, row.get('sessionId'))
    R.need(actual is not None and actual['id'] == eid, 'GPU_CURRENT_EMPLOYEE')
    R.need(actual['sessionGeneration'] <= 9007199254740991, 'GPU_CURRENT_GENERATION')
    return actual


def _digest(config, current):
    return J.fingerprint({'current': current, 'domain': R.domain_digest(config),
                          'policy': policy_digest(config, current['sessionId'])})


def _requests(gate):
    path = gate.root / 'operations' / NAME
    if not os.path.lexists(path):
        return {'schema': SCHEMA, 'requests': {}}, None
    value, stamp = _private(path, gate.broker.config['uid'])
    R.need(type(value) is dict and set(value) == {'schema', 'requests'} and
           value['schema'] == SCHEMA and type(value['requests']) is dict and
           len(value['requests']) <= 256, 'GPU_REQUEST_STORE')
    for eid, row in value['requests'].items():
        J.canonical_uuid(eid)
        R.need(type(row) is dict and set(row) == {'revision', 'sessionId', 'sessionGeneration',
               'bindingDigest', 'deviceUuid'}, 'GPU_REQUEST_STORE')
        J.canonical_uuid(row['sessionId']); J.digest(row['bindingDigest'])
        R.need(type(row['revision']) is int and 1 <= row['revision'] <= 9007199254740991 and
               type(row['sessionGeneration']) is int and 1 <= row['sessionGeneration'] <= 9007199254740991 and
               (row['deviceUuid'] is None or type(row['deviceUuid']) is str and UUID.fullmatch(row['deviceUuid'])),
               'GPU_REQUEST_STORE')
    return value, stamp


def _catalogue():
    # Fixed kernel-driver metadata; no nvidia-smi, arbitrary commands or NVML.
    from .worker_gpu_preflight import GPU_ROOT, physical_device
    result = []
    with os.scandir(GPU_ROOT) as entries:
        for n, entry in enumerate(entries, 1):
            R.need(n <= 32 and entry.is_dir(follow_symlinks=False), 'GPU_HARDWARE_UNAVAILABLE')
            path = Path(entry.path) / 'information'
            with path.open('rb') as stream:
                raw = stream.read(16385)
            R.need(len(raw) <= 16384, 'GPU_HARDWARE_UNAVAILABLE')
            fields = dict(line.split(':', 1) for line in raw.decode().splitlines() if ':' in line)
            device = fields.get('GPU UUID', '').strip()
            canonical = 'GPU-' + device.removeprefix('GPU-').lower()
            R.need(UUID.fullmatch(canonical), 'GPU_HARDWARE_UNAVAILABLE')
            facts = physical_device('nvidia.com/gpu=' + canonical)
            result.append({'deviceUuid': canonical, 'model': ''.join(c if 32 <= ord(c) <= 126 else '?' for c in facts['model'])[:96]})
    R.need(len({r['deviceUuid'] for r in result}) == len(result), 'GPU_HARDWARE_AMBIGUOUS')
    return sorted(result, key=lambda r: r['deviceUuid'])


def _selected(rows, config, current):
    name = '/' + config['deployment'] + '-agent-' + current['sessionId']
    matches = [r for r in rows if r.get('Name') == name or
               r.get('Config', {}).get('Labels', {}).get('reverie.session') == current['sessionId']]
    R.need(len(matches) <= 1, 'GPU_NATIVE_AMBIGUOUS')
    if not matches:
        return None
    row = matches[0]; labels = row.get('Config', {}).get('Labels', {})
    R.need(row.get('Name') == name and labels.get('reverie.worker') == config['deployment'] and
           labels.get('reverie.session') == current['sessionId'] and
           labels.get('reverie.employee') == current['id'] and
           type(row.get('State', {}).get('Running')) is bool, 'GPU_NATIVE_BINDING')
    return row


def _applied(config, current):
    sid, eid = current['sessionId'], current['id']
    legacy, employees = G.validate_gpu_config(config)
    value = legacy.get(sid, employees.get(eid))
    return {'known': True, 'enabled': value is not None,
            'deviceUuid': ('GPU-' + value.split('GPU-', 1)[1].lower()) if value else None,
            'source': 'legacy-session' if sid in legacy else 'employee' if eid in employees else 'none'}


def _active(gate, current, row, applied):
    if row is None or row['State']['Running'] is False:
        return {'known': True, 'running': False, 'enabled': False, 'deviceUuid': None}
    unknown = {'known': False, 'running': True, 'enabled': None, 'deviceUuid': None}
    # Configuration is not evidence of a live device. Positive native proof
    # requires the current effective label, PID/start and physical character node.
    if not applied['enabled'] or row['Config']['Labels'].get('reverie.worker-policy') != policy_digest(gate.broker.config, current['sessionId']):
        return unknown
    from .worker_gpu_preflight import physical_device
    try:
        facts = physical_device('nvidia.com/gpu=' + applied['deviceUuid'])
        gate.native.limits(row)
        pid = row['State']['Pid']; birth = R._pid(pid)
        host = Path('/dev/nvidia' + facts['deviceMinor']).stat()
        guest = (Path('/proc') / str(pid) / 'root/dev' / ('nvidia' + facts['deviceMinor'])).stat()
        R.need(stat.S_ISCHR(host.st_mode) and stat.S_ISCHR(guest.st_mode) and
               host.st_rdev == guest.st_rdev and R._pid(pid) == birth, 'GPU_NATIVE_DEVICE_UNKNOWN')
    except (OSError, ValueError, KeyError):
        return unknown
    return {'known': True, 'running': True, 'enabled': True, 'deviceUuid': applied['deviceUuid']}


def _gate(broker):
    gate = broker.resource_reservations
    R.need(gate is not None and broker.config_file, 'GPU_OWNER_CONTROL_UNAVAILABLE')
    return gate


def status(broker, eid, *, deadline=None):
    deadline = time.monotonic() + 30 if deadline is None else deadline
    gate = _gate(broker)
    with gate.admission(deadline=deadline):
        config, config_stamp = _private(broker.config_file, broker.config['uid'])
        R.need(config == broker.config, 'GPU_CONFIG_CHANGED')
        current = _current(config, eid); digest = _digest(config, current)
        requests, request_stamp = _requests(gate); request = requests['requests'].get(eid)
        rows = gate._guard(); row = _selected(rows, config, current)
        applied = _applied(config, current)
        active = _active(gate, current, row, applied)
        try:
            choices = {'known': True, 'devices': _catalogue()}
        except (OSError, ValueError, UnicodeError):
            choices = {'known': False, 'devices': []}
        R.need(gate.native.inventory() == rows, 'GPU_NATIVE_CHANGED')
        R.need(_current(config, eid) == current and _digest(config, current) == digest and
               _private(broker.config_file, config['uid'])[1] == config_stamp and
               _requests(gate)[1] == request_stamp, 'GPU_STATUS_CHANGED')
        result = {'version': 1, 'employeeId': eid, 'current': {
            'sessionId': current['sessionId'], 'sessionGeneration': current['sessionGeneration'], 'bindingDigest': digest},
            'revision': request['revision'] if request else 0, 'choices': choices,
            'requested': None if request is None else {'enabled': request['deviceUuid'] is not None,
                'deviceUuid': request['deviceUuid'], 'revision': request['revision']},
            'applied': applied, 'active': active,
            'state': 'unchanged' if request is None else 'applied' if request['deviceUuid'] == applied['deviceUuid'] else 'pending'}
    return result


class _Transition:
    pass


def owns_pending(gate):
    """Only the currently executing private transition may finish admission."""
    record = getattr(gate._local, 'gpu_transition', None)
    return (type(record) is _Transition and record.gate is gate and
            _private(R.pending(gate.broker.config), gate.broker.config['uid']) == record.pending)


def check_transition_rows(gate, rows):
    record = getattr(gate._local, 'gpu_transition', None)
    R.need(type(record) is _Transition and record.gate is gate and rows == record.rows,
           'GPU_NATIVE_CHANGED')


def _installed_consumers(config):
    # These registered consumers pin raw worker config. Their supported
    # coordinated drain/refresh is separate; queue instead of invalidating them.
    roots = {Path.home() / '.config', Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))}
    return ('resourceActorConfig' in config or any(os.path.lexists(root / 'systemd/user/reverie-owner-terminal.service') for root in roots))


def _idle(gate):
    from .worker_host_job import require_idle, NAME as HOST_NAME
    require_idle(gate)
    R.need(not gate._document()['operations'], 'GPU_RESOURCE_OPERATION_REQUIRES_RECONCILIATION')
    # Historical host receipts bind the old configuration domain. They are
    # immutable; this version refuses their migration rather than rehashing them.
    R.need(not os.path.lexists(gate.root / 'operations' / HOST_NAME), 'GPU_HOST_HISTORY_REQUIRES_RECONCILIATION')


def _apply(gate, eid, expected_request, *, deadline):
    broker = gate.broker; record = None
    try:
        with gate.admission(deadline=deadline):
            before, config_stamp = _private(broker.config_file, broker.config['uid'])
            R.need(before == broker.config, 'GPU_CONFIG_CHANGED')
            current = _current(before, eid)
            requests, request_stamp = _requests(gate)
            request = requests['requests'].get(eid)
            R.need(request == expected_request, 'GPU_REQUEST_CHANGED')
            R.need(request['sessionId'] == current['sessionId'] and request['sessionGeneration'] == current['sessionGeneration'] and
                   request['bindingDigest'] == _digest(before, current), 'GPU_STALE_REQUEST')
            rows = gate._guard(); selected = _selected(rows, before, current)
            R.need(gate.native.custody(gate.root, Path(broker.config_file)) == rows, 'GPU_NATIVE_CHANGED')
            if selected is not None and selected['State']['Running']:
                return  # A queued request never changes a running seat's label.
            applied = _applied(before, current)
            if request['deviceUuid'] == applied['deviceUuid']:
                return
            if _installed_consumers(before):
                return
            _idle(gate); gate.check_headroom()
            after = copy.deepcopy(before)
            grants = after.setdefault('employeeGpuGrants', {})
            if request['deviceUuid'] is None:
                grants.pop(eid, None)
            else:
                R.need(request['deviceUuid'] in {d['deviceUuid'] for d in _catalogue()}, 'GPU_HARDWARE_UNAVAILABLE')
                from .worker_gpu_preflight import INFO_FORMAT, cdi_device, physical_device
                device = 'nvidia.com/gpu=' + request['deviceUuid']
                physical = physical_device(device)
                info = json.loads(broker.run_engine(['info', '--format', INFO_FORMAT]).stdout)
                R.need(info.get('OSType') == 'linux' and info.get('KernelVersion') == os.uname().release,
                       'GPU_SAME_KERNEL_ENGINE_REQUIRED')
                try:
                    cdi = cdi_device(info.get('CDISpecDirs'), device)
                except ImportError:
                    raise ValueError('GPU_CDI_PARSER_UNAVAILABLE') from None
                numeric = [p for p in cdi['deviceNodePaths'] if type(p) is str and re.fullmatch(r'/dev/nvidia[0-9]+', p)]
                R.need(numeric == ['/dev/nvidia' + physical['deviceMinor']], 'GPU_CDI_PHYSICAL_DEVICE_MISMATCH')
                grants[eid] = device
            # The old SID override remains authoritative and byte-identical.
            R.need(_applied(after, current)['deviceUuid'] == request['deviceUuid'], 'GPU_LEGACY_SESSION_OVERRIDE')
            from .worker import validate_config
            validate_config(after)
            company = read_metadata(before['companyFile'], before['uid'])
            for employee in company['employees']:
                sid = employee.get('sessionId')
                if sid and sid != current['sessionId']:
                    R.need(policy_digest(before, sid) == policy_digest(after, sid), 'GPU_PEER_POLICY_CHANGED')
            R.need({k:v for k,v in before.items() if k != 'employeeGpuGrants'} ==
                   {k:v for k,v in after.items() if k != 'employeeGpuGrants'}, 'GPU_UNRELATED_CONFIG_CHANGED')
            old_binding, binding_stamp = _private(R.marker(before), before['uid'])
            R.need(old_binding == gate.binding, 'GPU_CONTROL_BINDING_CHANGED')
            new_binding = copy.deepcopy(old_binding); new_binding['configurationDigest'] = R.domain_digest(after)
            # Accepted canonical stores remain byte/identity bound throughout.
            protected = [gate.root / 'operations/operations.json', gate.root / 'profiles/profiles.json']
            protected_stamps = {p: _stamp(p) if os.path.lexists(p) else None for p in protected}
            cdi_stamp = None
            if request['deviceUuid'] is not None:
                R.need(cdi_device(info.get('CDISpecDirs'), device) == cdi and physical_device(device) == physical and
                       json.loads(broker.run_engine(['info', '--format', INFO_FORMAT]).stdout) == info,
                       'GPU_CDI_OR_HARDWARE_CHANGED')
                cdi_stamp = (Path(cdi['path']), _stamp(cdi['path']))
            R.need(gate.native.inventory() == rows and gate._guard() == rows, 'GPU_NATIVE_CHANGED')
            R.need(_current(before, eid) == current and _private(broker.config_file, before['uid'])[1] == config_stamp and
                   _requests(gate)[1] == request_stamp, 'GPU_APPLY_CAS_CHANGED')
            intent = {'schema': 'reverie-owner-gpu-transition-v1', 'employeeId': eid,
                      'request': request, 'beforeDigest': J.fingerprint(before), 'afterDigest': J.fingerprint(after),
                      'beforeBinding': old_binding, 'afterBinding': new_binding}
            parents = _parents([Path(broker.config_file), R.marker(before), gate.root / 'operations' / NAME])
            R._write_exclusive(R.pending(before), intent)
            record = _Transition(); record.gate = gate; record.rows = copy.deepcopy(rows)
            record.pending = _private(R.pending(before), before['uid'])
            gate._local.gpu_transition = record
            # No native effects. A lost acknowledgement or failed fsync keeps
            # pending; cold construction and every other admission refuse.
            _replace(broker.config_file, after, config_stamp)
            _replace(R.marker(before), new_binding, binding_stamp)
            broker.config = after; gate.binding = new_binding
            R.need(gate._guard() == rows and gate.native.inventory() == rows, 'GPU_NATIVE_CHANGED')
            R.need(_current(after, eid) == current, 'GPU_CURRENT_CHANGED')
            terminal = {Path(broker.config_file): _stamp(broker.config_file), R.marker(after): _stamp(R.marker(after)),
                        gate.root / 'operations' / NAME: request_stamp, R.pending(after): record.pending[1],
                        **protected_stamps, **({cdi_stamp[0]: cdi_stamp[1]} if cdi_stamp else {})}
        # All admission/native producers and descriptor finalizers have ended.
        # The durable pending fence still rejects every competing admission.
        R.need(all((_stamp(p) if os.path.lexists(p) else None) == s for p,s in terminal.items()) and
               _current(after, eid) == current, 'GPU_TERMINAL_CAS_CHANGED')
        # Final bounded metadata after company resolver; no native producer or
        # fallible cleanup follows release. A crash-resurrected fence refuses.
        _parents_current(parents)
        R.need(all((_stamp(p) if os.path.lexists(p) else None) == s for p,s in terminal.items()), 'GPU_TERMINAL_CAS_CHANGED')
        # Pending ownership is the last file observation, after every ancestor
        # and other terminal leaf. Never unlink a replacement fence.
        R.need(_stamp(R.pending(after)) == record.pending[1], 'GPU_TERMINAL_CAS_CHANGED')
        R.need(time.monotonic() < deadline, 'GPU_APPLY_DEADLINE')
        os.unlink(R.pending(after))
    except BaseException:
        if record is not None:
            raise RuntimeError('GPU_APPLY_REQUIRES_RECONCILIATION') from None
        raise
    finally:
        gate._local.gpu_transition = None


def request(broker, command):
    R.need(type(command) is dict and set(command) in ({'action','employeeId','expected','enabled'},
           {'action','employeeId','expected','enabled','deviceUuid'}) and command['action'] == 'gpu-access-request', 'GPU_REQUEST_SCHEMA')
    expected = command['expected']
    R.need(type(expected) is dict and set(expected) == {'sessionId','sessionGeneration','bindingDigest','revision'}, 'GPU_REQUEST_CAS_SCHEMA')
    J.canonical_uuid(expected['sessionId']); J.digest(expected['bindingDigest'])
    R.need(type(expected['sessionGeneration']) is int and expected['sessionGeneration'] >= 1 and
           type(expected['revision']) is int and 0 <= expected['revision'] < 9007199254740991, 'GPU_REQUEST_CAS_SCHEMA')
    R.need(type(command['enabled']) is bool and (set(command) == {'action','employeeId','expected','enabled','deviceUuid'} and
           type(command['deviceUuid']) is str and UUID.fullmatch(command['deviceUuid']) if command['enabled'] else
           'deviceUuid' not in command), 'GPU_DEVICE_SELECTION')
    deadline = time.monotonic() + 30
    gate = _gate(broker); eid = command['employeeId']; device = command.get('deviceUuid')
    with gate.admission(deadline=deadline):
        config, config_stamp = _private(broker.config_file, broker.config['uid'])
        R.need(config == broker.config, 'GPU_CONFIG_CHANGED')
        current = _current(config, eid); document, request_stamp = _requests(gate)
        old = document['requests'].get(eid)
        R.need(expected == {'sessionId': current['sessionId'], 'sessionGeneration': current['sessionGeneration'],
               'bindingDigest': _digest(config, current), 'revision': old['revision'] if old else 0}, 'GPU_STALE_REQUEST')
        if device is not None:
            R.need(device in {d['deviceUuid'] for d in _catalogue()}, 'GPU_HARDWARE_UNAVAILABLE')
        sid = current['sessionId']
        if sid in config.get('gpuGrants', {}):
            R.need(_applied(config, current)['deviceUuid'] == device, 'GPU_LEGACY_SESSION_OVERRIDE')
        queued = {'revision': expected['revision'] + 1, 'sessionId': sid,
                  'sessionGeneration': current['sessionGeneration'], 'bindingDigest': expected['bindingDigest'], 'deviceUuid': device}
        document['requests'][eid] = queued
        R.need(len(document['requests']) <= 256, 'GPU_REQUEST_STORE_FULL')
        gate._guard()
        R.need(_current(config, eid) == current and _private(broker.config_file, config['uid'])[1] == config_stamp,
               'GPU_REQUEST_CAS_CHANGED')
        _replace(gate.root / 'operations' / NAME, document, request_stamp)
    _apply(gate, eid, queued, deadline=deadline)
    return status(broker, eid, deadline=deadline)


def cold_boundary(broker, sid):
    """Called by canonical J before admission/prepare; never starts a laptop."""
    gate = broker.resource_reservations
    if gate is None or not os.path.lexists(gate.root / 'operations' / NAME):
        return
    deadline = time.monotonic() + 30
    with gate.admission(deadline=deadline):
        document, _stamp_value = _requests(gate)
        current = G.current_employee(broker.config, sid)
        queued = document['requests'].get(current['id']) if current else None
        if current is not None and not storage_start_allowed(broker.config, storage_paths(broker.config, sid)):
            return
    if queued is not None:
        # Stale owner intent remains visible; no silent rebinding to a new SID.
        if (queued['sessionId'], queued['sessionGeneration']) == (sid, current['sessionGeneration']) and queued['bindingDigest'] == _digest(broker.config, current):
            _apply(gate, current['id'], queued, deadline=deadline)


def decode_control(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            R.need(key not in value, 'GPU_REQUEST_DUPLICATE_KEY')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('GPU_REQUEST_NONFINITE')))


def dispatch(broker, command):
    if type(command) is dict and command.get('action') == 'gpu-access-status':
        R.need(set(command) == {'action','employeeId'}, 'GPU_REQUEST_SCHEMA')
        return status(broker, command['employeeId'])
    return request(broker, command)
