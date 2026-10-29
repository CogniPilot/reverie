"""Fixed host producers for the owner terminal. No browser-provided authority.

The private installation document selects the engine, full website specification,
immutable programs and explicit employee entitlements. It is never a worker grant.
Every observation reopens it and the canonical worker metadata, rechecks physical
path exclusion and brackets engine observations. Filesystem I/O is bounded in work
and engine I/O in time; an uninterruptible kernel read is not a hard time bound.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import stat
import time
from urllib.parse import urlsplit

from .owner_terminal_channel import read_proc, need, digest
from .website_peer_facts import Engine, WebsiteFacts, ProtectedPeer, mounts, host_config
from .worker_storage import read_metadata, storage_paths
from .worker_resources import policy_digest
from .worker_cold_tmp import read_mount_table, refuse_host_mount_aliases
from .human_shell_capabilities import open_directory
from . import owner_terminal_toolkit as toolkit
from . import human_terminal_protocol as protocol


def stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def private_bytes(path):
    path = Path(path)
    parent = open_directory(path.parent)
    fd = None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
             and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 131072, 'PRIVATE_INSTALLATION_REQUIRED')
        raw = bytearray()
        while part := os.read(fd, 131073 - len(raw)):
            raw.extend(part); need(len(raw) <= 131072, 'INSTALLATION_BOUND')
        need(stamp(os.fstat(fd)) == stamp(info)
             and stamp(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == stamp(info), 'INSTALLATION_CHANGED')
        again = open_directory(path.parent)
        try:
            need((os.fstat(again).st_dev, os.fstat(again).st_ino) ==
                 (os.fstat(parent).st_dev, os.fstat(parent).st_ino), 'INSTALLATION_PARENT_REBOUND')
        finally:
            os.close(again)
        return bytes(raw), stamp(info)
    finally:
        if fd is not None: os.close(fd)
        os.close(parent)


def private_document(path, expected=None):
    raw, identity = private_bytes(path)
    if expected is not None:
        need(hashlib.sha256(raw).hexdigest() == expected, 'INSTALLATION_BYTES_CHANGED')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'DUPLICATE_INSTALLATION_KEY')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_INSTALLATION'))), identity


def exact(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'INSTALLATION_SCHEMA')


def physical(path):
    path = Path(path)
    need(path.is_absolute() and str(path) == str(path.resolve(strict=True)), 'PHYSICAL_PATH_REQUIRED')
    return path


def overlap(left, right):
    return left == right or left.is_relative_to(right) or right.is_relative_to(left)


def qualify_python(invocation, executable):
    """Bind a fixed immutable invocation to its actual kernel interpreter.

    Nix withPackages may use an ELF wrapper rather than a symlink. Its lexical
    argv0 remains distinct from the bare ELF; the accepted owned READY probe
    proves that pair without granting any service or migration authority.
    """
    executable = physical(executable)
    declared = Path(invocation)
    need(declared.is_absolute() and '..' not in declared.parts and
         str(declared.resolve(strict=True)).startswith('/nix/store/'), 'IMMUTABLE_H_PROGRAM_REQUIRED')
    for selected in (executable, declared.resolve(strict=True)):
        info = selected.stat()
        need(str(selected).startswith('/nix/store/') and stat.S_ISREG(info.st_mode) and
             info.st_uid == 0 and not info.st_mode & 0o222 and info.st_mode & 0o111,
             'IMMUTABLE_H_PROGRAM_REQUIRED')
        with selected.open('rb') as stream:
            need(stream.read(4) == b'\x7fELF', 'IMMUTABLE_H_PROGRAM_REQUIRED')
    if declared.resolve(strict=True) == executable:
        return
    from .worker_service_transport_upgrade import IsolatedInterpreterObserver
    observed = IsolatedInterpreterObserver(time.monotonic() + 5).observe(declared)
    info = executable.stat()
    need(observed['declared'] == str(declared) and observed['argv0'] == str(declared) and
         observed['executable'] == str(executable) and observed['exeIdentity'] == [info.st_dev, info.st_ino],
         'H_PYTHON_INTERPRETER_CHANGED')


def installation_contract(value, path):
    """Closed fixed installer inputs, never a wire-selected host command."""
    expected_entry = str(Path(__file__).resolve().parents[2] / 'scripts/reverie-owner-terminal-host')
    program = value['hostProgram']
    exact(program, ('executable', 'argv'))
    need(type(program['argv']) is list and len(program['argv']) == 6
         and program['argv'][1:] == ['-I', '-B', expected_entry, '--policy', str(path)], 'FIXED_H_ENTRY_REQUIRED')
    executable = physical(program['executable'])
    need(str(executable).startswith('/nix/store/'),
         'IMMUTABLE_H_PROGRAM_REQUIRED')
    for selected in (executable, Path(program['argv'][0]).resolve(strict=True), physical(expected_entry), physical(value['engineProgram'])):
        info = selected.stat()
        need(str(selected).startswith('/nix/store/') and stat.S_ISREG(info.st_mode) and info.st_uid == 0
             and not info.st_mode & 0o222, 'IMMUTABLE_HOST_PROGRAM_REQUIRED')
    qualify_python(program['argv'][0], executable)
    engine = physical(value['engineProgram'])
    with engine.open('rb') as stream:
        need(stream.read(4) == b'\x7fELF' and engine.stat().st_mode & 0o111, 'FIXED_ENGINE_ELF_REQUIRED')
    entitlements = value['entitlements']
    need(type(entitlements) is dict and 1 <= len(entitlements) <= 128, 'FIXED_ENTITLEMENT_BOUND')
    from .worker_storage import require_uuid
    for employee, selection in entitlements.items():
        require_uuid(employee)
        if value['version'] == 2:
            exact(selection, ('binding', 'ownerDigest'))
            need(selection['binding'] == 'current' and type(selection['ownerDigest']) is str and
                 len(selection['ownerDigest']) == 64 and all(c in '0123456789abcdef' for c in selection['ownerDigest']),
                 'FIXED_CURRENT_EID_ENTITLEMENT')
        else:
            exact(selection, ('sessionId', 'generation')); require_uuid(selection['sessionId'])
            need(type(selection['generation']) is int and selection['generation'] >= 0, 'FIXED_ENTITLEMENT_GENERATION')
    origin = value['externalOrigin']; need(type(origin) is str and len(origin) <= 2048, 'FIXED_EXTERNAL_ORIGIN')
    parsed = urlsplit(origin)
    need(parsed.scheme in ('http', 'https') and parsed.netloc and not parsed.username and not parsed.password
         and not parsed.path and not parsed.query and not parsed.fragment, 'FIXED_EXTERNAL_ORIGIN')
    peers = value['ingressPeers']
    need(type(peers) is list and 1 <= len(peers) <= 8, 'FIXED_INGRESS_BOUND')
    for peer in peers:
        exact(peer, ('address', 'localPort', 'encrypted'))
        need(type(peer['address']) is str and len(peer['address']) <= 64 and type(peer['localPort']) is int
             and 1 <= peer['localPort'] <= 65535 and type(peer['encrypted']) is bool, 'FIXED_INGRESS_PEER')
        ipaddress.ip_address(peer['address'])
    need(len({digest(peer) for peer in peers}) == len(peers), 'DUPLICATE_INGRESS_PEER')


def inventory(engine):
    rows = engine.get('/containers/json?all=1')
    need(type(rows) is list and len(rows) <= 256, 'ENGINE_INVENTORY_BOUND')
    result = []
    for row in rows:
        need(type(row) is dict and type(row.get('Mounts')) is list, 'LIVE_MOUNT_INVENTORY_REQUIRED')
        # Status contains human-readable elapsed time and is not incarnation
        # identity. Retain the complete mount dictionaries and stable native
        # identity/state fields used for custody; never retain private env.
        selected={key: row[key] for key in ('Id', 'ImageID', 'Names', 'Labels', 'State', 'Mounts')}
        need(all(type(mount) is dict for mount in selected['Mounts']), 'LIVE_MOUNT_RECORD_REQUIRED')
        # Docker's list endpoint does not promise mount order. Compare the full
        # records as a multiset; do not project away flags or remove duplicates.
        selected['Mounts']=sorted(selected['Mounts'],key=lambda mount:json.dumps(
            mount,sort_keys=True,separators=(',',':'),allow_nan=False))
        result.append(selected)
    need(len({row['Id'] for row in result}) == len(result), 'DUPLICATE_NATIVE_CONTAINER')
    return sorted(result, key=lambda row: row['Id'])


class Installation:
    """A fixed private policy, physically separate from every laptop grant."""
    def __init__(self, path, expected):
        self.path, self.expected = physical(path), expected
        self.value, self.identity = private_document(self.path, expected)
        v = self.value
        extra = ('resourceBinding',) if v.get('version') == 2 else ()
        exact(v, (*extra, 'version', 'workerConfig', 'workerConfigSHA256', 'engineSocket', 'engineSocketIdentity',
                  'engineId', 'website', 'controlRoot', 'bootstrapRoot', 'ledgerRoot', 'entitlements',
                  'hostProgram', 'engineProgram', 'externalOrigin', 'ingressPeers', 'toolkitManifest'))
        need(type(v['version']) is int and v['version'] in (1, 2), 'INSTALLATION_VERSION')
        installation_contract(v, self.path)
        self.engine = Engine(v['engineSocket'], v['engineSocketIdentity'], v['engineId'])
        self.facts = WebsiteFacts(self.engine, v['website'])
        self.config, self.config_identity = private_document(v['workerConfig'],
            v['workerConfigSHA256'] if v['version'] == 1 else None)
        if v['version'] == 2:
            from . import owner_terminal_resource_binding as resource
            resource.J.exact(v['resourceBinding'], ('schema', 'configuration', 'reservationBinding'))
            # Initial installer bytes remain explicit; a new raw config is not
            # accepted until the real canonical R history is qualified below.
            need(hashlib.sha256(resource.J.encode(v['resourceBinding']['configuration'])).hexdigest() ==
                 v['workerConfigSHA256'], 'H_RESOURCE_INITIAL_CONFIGURATION_CHANGED')
        need(self.config.get('uid') == os.getuid() and self.config.get('gid') == os.getgid()
             and os.getuid() > 0, 'ORDINARY_OWNER_WORKER_POLICY_REQUIRED')
        self.toolkit = toolkit.immutable_manifest(v['toolkitManifest'])
        self.toolkit_cache = {}
        self.roots = {name: physical(v[name]) for name in ('controlRoot', 'bootstrapRoot', 'ledgerRoot')}
        for name in ('controlRoot', 'ledgerRoot'):
            need(not any(self.roots[name].is_relative_to(Path(base)) for base in ('/tmp', '/var/tmp', '/run', '/dev')),
                 'DURABLE_PRIVATE_CONTROL_REQUIRED')
        need(not any(self.roots['bootstrapRoot'].is_relative_to(Path(base)) for base in ('/tmp', '/var/tmp')),
             'BOOTSTRAP_MUST_SURVIVE_PRIVATE_TMP_NAMESPACE')
        need(len(os.fsencode(self.roots['bootstrapRoot'] / 'bootstrap.sock')) < 108, 'BOOTSTRAP_SOCKET_PATH_BOUND')
        self.root_identities = {}
        need(all(not overlap(a, b) for i, a in enumerate(self.roots.values())
                 for j, b in enumerate(self.roots.values()) if i < j), 'CONTROL_ROOT_OVERLAP')
        for path in self.roots.values():
            info = path.stat()
            need(info.st_uid == os.getuid() and stat.S_ISDIR(info.st_mode)
                 and stat.S_IMODE(info.st_mode) == 0o700, 'PRIVATE_CONTROL_DIRECTORY')
            self.root_identities[path] = (info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode))
        need(self.path.parent == self.roots['controlRoot'], 'INSTALLATION_DIRECTORY')
        self.guard()
        self.runtime_website = None

    def bind_website_once(self):
        need(self.runtime_website is None, 'WEBSITE_BINDING_NO_REPLAY')
        self.guard()
        self.runtime_website = self.facts.bind_once()
        self.assert_website()
        return dict(self.runtime_website)

    def guard(self):
        for path, expected in self.root_identities.items():
            fd = open_directory(path)
            try:
                info = os.fstat(fd)
                need((info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)) == expected,
                     'CONTROL_DIRECTORY_REBOUND')
            finally:
                os.close(fd)
        value, identity = private_document(self.path, self.expected)
        need(value == self.value and identity == self.identity, 'INSTALLATION_REBOUND')
        if self.value.get('version', 1) == 1:
            config, config_identity = private_document(self.value['workerConfig'], self.value['workerConfigSHA256'])
            need(config == self.config and config_identity == self.config_identity, 'WORKER_POLICY_CHANGED')
            self._guard_native(config)
            return
        from . import owner_terminal_resource_binding as resource
        config, config_identity = private_document(self.value['workerConfig'])
        with resource.observation(self.value['resourceBinding'], config, self.value['workerConfig'], self.engine):
            self._guard_native(config)
        # All blocking native/store producers and admission finalizers precede
        # the final actual private file readbacks. Never hot-retarget a channel.
        value, identity = private_document(self.path, self.expected)
        need(value == self.value and identity == self.identity, 'INSTALLATION_REBOUND')
        again, final_identity = private_document(self.value['workerConfig'])
        need(again == config and final_identity == config_identity, 'WORKER_POLICY_CHANGED')
        for path, expected in self.root_identities.items():
            info = path.lstat()
            need((info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)) == expected
                 and stat.S_ISDIR(info.st_mode), 'CONTROL_DIRECTORY_REBOUND')
        need(stamp(self.path.lstat()) == self.identity and
             stamp(Path(self.value['workerConfig']).lstat()) == config_identity, 'INSTALLATION_REBOUND')
        self.config, self.config_identity = config, config_identity

    def _guard_native(self, config):
        from .owner_terminal_resource_binding import require_disjoint_roots
        require_disjoint_roots(config, self.roots.values())
        self.engine.guard()
        rows = inventory(self.engine)
        grants = [physical(config[name]) for name in ('stateRoot', 'companyRoot', 'scratchRoot', 'apiSocketRoot')]
        grants += [physical(row['source']) for row in config['mounts']]
        for row in rows:
            need(type(row) is dict and type(row.get('Mounts')) is list, 'LIVE_MOUNT_INVENTORY_REQUIRED')
            if row.get('Id') == self.value['website']['containerId']:
                continue
            if row.get('State') in ('created', 'exited', 'dead'):
                continue
            for mount in row['Mounts']:
                if mount.get('Type') == 'bind':
                    grants.append(physical(mount['Source']))
        # Detect same-device bind aliases through mountinfo's backing root,
        # not just path spellings. Unknown/missing backing metadata refuses.
        table = read_mount_table()
        for protected in [self.path, physical(self.value['workerConfig']), *self.roots.values()]:
            for granted in grants:
                need(not overlap(protected, granted), 'CONTROL_EXPOSED_TO_LAPTOP')
                refuse_host_mount_aliases(protected, granted, table)
        need(inventory(self.engine) == rows, 'LIVE_MOUNTS_CHANGED')
        self.engine.guard()
        require_disjoint_roots(config, self.roots.values())

    def assert_website(self):
        self.guard()
        need(self.runtime_website is not None, 'WEBSITE_BINDING_UNAVAILABLE')
        item = self.facts.inspect()
        bootstrap = [m for m in item['Mounts'] if m['Destination'] == '/run/reverie-owner-terminal']
        need(len(bootstrap) == 1 and bootstrap[0]['Type'] == 'bind' and bootstrap[0]['RW'] is False
             and physical(bootstrap[0]['Source']) == self.roots['bootstrapRoot'], 'BOOTSTRAP_MOUNT_REQUIRED')
        for mount in item['Mounts']:
            if mount.get('Type') == 'bind':
                need(not overlap(physical(mount['Source']), self.roots['ledgerRoot'])
                     and not overlap(physical(mount['Source']), self.roots['controlRoot'])
                     and not overlap(physical(mount['Source']), physical(self.value['workerConfig'])), 'PRIVATE_LEDGER_EXPOSED')
        self.guard()
        return item

    def observe(self, employee_id):
        self.assert_website()
        # Entitlement is explicit private owner installation policy. A role,
        # model, permission bit or title never manufactures it.
        entitled = self.value['entitlements'].get(employee_id)
        dynamic = self.value.get('version', 1) == 2
        need((dynamic and type(entitled) is dict and set(entitled) == {'binding', 'ownerDigest'} and
              entitled['binding'] == 'current') or
             (not dynamic and type(entitled) is dict and set(entitled) == {'sessionId', 'generation'}
              and type(entitled['generation']) is int), 'EXPLICIT_TERMINAL_ENTITLEMENT_REQUIRED')
        observed_config = self.config
        company = read_metadata(self.config['companyFile'], self.config['uid'])
        records = [row for row in company['employees'] if row.get('id') == employee_id]
        need(len(records) == 1, 'CURRENT_EMPLOYEE_REQUIRED')
        row = records[0]
        if dynamic:
            need(digest({'owner': row.get('owner')}) == entitled['ownerDigest'], 'CURRENT_EMPLOYEE_OWNER_CHANGED')
        from .worker_storage import require_uuid
        require_uuid(row.get('sessionId'))
        need(type(row.get('sessionGeneration')) is int and row['sessionGeneration'] >= 0
             and (dynamic or (row.get('sessionId') == entitled['sessionId'] and
                              row.get('sessionGeneration') == entitled['generation']))
             and row.get('desiredRunning') is True and row.get('onVacation') is False
             and row.get('bindingMigration') is None, 'CURRENT_INTENT_REQUIRED')
        paths = storage_paths(self.config, row['sessionId'])
        need(paths.kind == 'employee' and paths.identity == employee_id, 'CURRENT_STORAGE_BINDING_REQUIRED')
        rows = inventory(self.engine)
        selected = [c for c in rows if c.get('State') == 'running'
                    and '/' + self.config['deployment'] + '-agent-' + row['sessionId'] in c['Names']
                    and c.get('Labels', {}).get('reverie.worker') == self.config['deployment']
                    and c.get('Labels', {}).get('reverie.session') == row['sessionId']]
        need(len(selected) == 1, 'EXACT_LAPTOP_REQUIRED')
        item = self.engine.get('/containers/' + selected[0]['Id'] + '/json')
        labels = item['Config'].get('Labels', {})
        policy = policy_digest(self.config, row['sessionId'])
        need(item['Id'] == selected[0]['Id'] and item['Image'] == self.config['image']
             and item['State']['Running'] is True and item['State']['Pid'] > 1
             and labels.get('reverie.worker') == self.config['deployment']
             and labels.get('reverie.session') == row['sessionId']
             and item['Name'] == '/' + self.config['deployment'] + '-agent-' + row['sessionId']
             and labels.get('reverie.employee') == employee_id
             and labels.get('reverie.worker-policy') == policy, 'NATIVE_LAPTOP_POLICY_CHANGED')
        actual_mounts = mounts(item['Mounts'])
        for source, destination in ((paths.home, '/home/agent'), (paths.nix, '/nix')):
            bound = [m for m in actual_mounts if m['Destination'] == destination]
            need(len(bound) == 1 and bound[0].get('Type') == 'bind' and bound[0].get('RW') is True
                 and physical(bound[0]['Source']) == physical(source), 'NATIVE_EMPLOYEE_ROOTS_CHANGED')
        initial = read_proc(item['State']['Pid'])
        signature = target_signature(item)
        key = (item['Id'], signature, digest(initial))
        if key not in self.toolkit_cache:
            need(len(self.toolkit_cache) < 32, 'TOOLKIT_INCARNATION_CAPACITY')
            qualified = toolkit.qualify(item, self.toolkit, uid=self.config['uid'], gid=self.config['gid'])
            need(qualified == initial, 'TOOLKIT_LAPTOP_CHANGED')
            custody = toolkit.StorageRootCustody(initial, {'home': paths.home, 'nix': paths.nix})
            self.toolkit_cache[key] = dict(init=initial, signature=signature, storage=custody)
        self.toolkit_cache[key]['storage'].assert_current()
        result = dict(employeeId=employee_id, sessionId=row['sessionId'], sessionGeneration=row['sessionGeneration'],
                      containerId=item['Id'], imageId=item['Image'], policyDigest=policy, running=True,
                      onVacation=False, desiredRunning=True, humanTerminalEntitled=True)
        need(read_metadata(self.config['companyFile'], self.config['uid']) == company
             and inventory(self.engine) == rows, 'LAPTOP_OBSERVATION_CHANGED')
        need(target_signature(self.engine.get('/containers/'+item['Id']+'/json')) == signature
             and read_proc(initial['pid']) == initial, 'LAPTOP_FINAL_NATIVE_CHANGED')
        self.assert_website()
        need(self.config == observed_config and
             read_metadata(self.config['companyFile'], self.config['uid']) == company, 'LAPTOP_OBSERVATION_CHANGED')
        return result

    def human_binding(self, request):
        captured = self.target_binding(request['employeeId'])
        protocol.bind_current(request, captured['target'])
        return captured['binding']

    def target_binding(self, employee_id):
        target = self.observe(employee_id)
        item = self.engine.get('/containers/'+target['containerId']+'/json')
        initial = read_proc(item['State']['Pid'])
        key = (item['Id'], target_signature(item), digest(initial))
        need(key in self.toolkit_cache, 'QUALIFIED_H_IMAGE_REQUIRED')
        cached = self.toolkit_cache[key]
        cached['storage'].assert_current()
        binding = {'containerId': item['Id'], 'init': cached['init'],
                   'signature': cached['signature'], 'roots': cached['storage'].snapshot()}
        if self.value.get('version', 1) == 2:
            binding['currentEmployee'] = {k: target[k] for k in
                ('employeeId', 'sessionId', 'sessionGeneration')}
        return {'target': target, 'binding': binding}

    def assert_human_binding(self, binding):
        dynamic = self.value.get('version', 1) == 2
        if dynamic:
            self.guard()
            need(type(binding.get('currentEmployee')) is dict, 'H_CURRENT_BINDING_REQUIRED')
        key = (binding['containerId'], binding['signature'], digest(binding['init']))
        need(key in self.toolkit_cache, 'H_STORAGE_CUSTODY_UNAVAILABLE')
        custody = self.toolkit_cache[key]['storage']
        need(custody.snapshot() == binding['roots'], 'H_STORAGE_BINDING_CHANGED')
        custody.assert_current()
        item = self.engine.get('/containers/'+binding['containerId']+'/json')
        need(target_signature(item) == binding['signature'] and read_proc(binding['init']['pid']) == binding['init'],
             'H_NATIVE_INCARNATION_CHANGED')
        custody.assert_current()
        if dynamic:
            # Final native/root producers precede current employee metadata.
            # A still-running old CID never keeps a replaced SID capability alive.
            target = binding['currentEmployee']
            exact(target, ('employeeId', 'sessionId', 'sessionGeneration'))
            entitled = self.value['entitlements'].get(target['employeeId'])
            need(type(entitled) is dict and set(entitled) == {'binding', 'ownerDigest'} and
                 entitled['binding'] == 'current', 'EXPLICIT_TERMINAL_ENTITLEMENT_REQUIRED')
            rows = read_metadata(self.config['companyFile'], self.config['uid'])['employees']
            selected = [row for row in rows if row.get('id') == target['employeeId']]
            need(len(selected) == 1 and selected[0].get('sessionId') == target['sessionId'] and
                 selected[0].get('sessionGeneration') == target['sessionGeneration'] and
                 selected[0].get('desiredRunning') is True and selected[0].get('onVacation') is False and
                 selected[0].get('bindingMigration') is None and
                 digest({'owner': selected[0].get('owner')}) == entitled['ownerDigest'], 'H_CURRENT_BINDING_CHANGED')

    def close(self):
        for cached in self.toolkit_cache.values():
            cached['storage'].close()
        self.toolkit_cache.clear()

    def assert_guest_gone(self, binding, acknowledgement):
        self.assert_human_binding(binding)
        toolkit.guest_gone(binding, acknowledgement)
        self.assert_human_binding(binding)


def target_signature(item):
    return digest({'Id':item['Id'], 'Name':item['Name'], 'Image':item['Image'], 'Config':item['Config'],
                   'HostConfig':item['HostConfig'], 'Mounts':mounts(item['Mounts']),
                   'State':{'Running':item['State']['Running'], 'Pid':item['State']['Pid']}})


class ProtectedWebsitePeer(ProtectedPeer):
    """Neutral namespace facts plus this actor's separate private-root custody."""
    def __init__(self, installation):
        self.installation = installation
        super().__init__(installation.facts)

    def inspect(self):
        return self.installation.assert_website()
