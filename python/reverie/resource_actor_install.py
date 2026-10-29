"""Explicit inactive installation of resource-actor facts, never owner approval.

Only the owner-local service installer calls prepare(). Runtime loading opens
existing private facts and immutable package inputs; it never provisions them.
The current owner/purpose protocol and journal remain independent authorities.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import time

from . import worker_resource_reservations as R
from .goal_private import private_entry
from .owner_terminal_channel import digest, read_proc
from .website_peer_facts import Engine, WebsiteFacts, ProtectedPeer, host_config, mounts, socket_identity
from .website_image_provenance import immutable, verify_image_spec, startup_program

PURPOSE = 'resource-replacement-v1'
FIELDS = {'version', 'purpose', 'configurationDigest', 'engine', 'website', 'imageProvenance', 'client'}


def exact(value, fields):
    R.need(type(value) is dict and set(value) == set(fields), 'RESOURCE_INSTALL_CLOSED_SCHEMA')


def document(raw):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            R.need(key not in out, 'RESOURCE_INSTALL_DUPLICATE_FIELD'); out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('RESOURCE_INSTALL_NONFINITE')))


def artifact(pair):
    exact(pair, ('path', 'sha256'))
    R.need(type(pair['sha256']) is str and len(pair['sha256']) == 64
           and all(c in '0123456789abcdef' for c in pair['sha256']), 'RESOURCE_INSTALL_ARTIFACT_DIGEST')
    path = immutable(pair['path'], 65536); raw = path.read_bytes()
    R.need(hashlib.sha256(raw).hexdigest() == pair['sha256'], 'RESOURCE_INSTALL_ARTIFACT_CHANGED')
    value = document(raw)
    exact(value, ('version', 'purpose', 'archiveConfigSHA256', 'imageSpec', 'console', 'node', 'clientManifest', 'codeFiles', 'startupManifest'))
    R.need(type(value['version']) is int and value['version'] == 1
           and value['purpose'] == 'website-image-provenance-v1', 'RESOURCE_INSTALL_ARTIFACT_PURPOSE')
    exact(value['node'], ('executable', 'argvPrefix'))
    prefix = value['node']['argvPrefix']
    R.need(type(prefix) is list and 2 <= len(prefix) <= 32 and all(type(s) is str for s in prefix), 'RESOURCE_INSTALL_FIXED_NODE')
    if value['startupManifest'] is None:
        R.need(len(prefix) == 2 and prefix[1] == value['console'] + '/lib/reverie/dist/index.js', 'RESOURCE_INSTALL_FIXED_NODE')
    else:
        exact(value['startupManifest'], ('path', 'sha256'))
        startup, actual = startup_program(value['startupManifest']['path'], value['console'], value['node']['executable'])
        R.need(actual == value['startupManifest'] and prefix == startup['argvPrefix']
               and all(value['codeFiles'].get(name) == selected for name, selected in startup['codeFiles'].items()),
               'RESOURCE_INSTALL_STARTUP_GRAPH_CHANGED')
    return value


def _client(pair):
    # Lazy import avoids a cycle with the runtime bootstrap wrapper. This is the
    # accepted immutable manifest consumer, not a second interpreter selector.
    from .worker_resource_actor import _client_program
    return _client_program(pair)


def _native_site(gate, container_id, image_id, init_pid):
    rows = gate.native.inventory()
    sites = [row for row in rows if row.get('Name') == '/' + gate.broker.config['serverContainer']]
    R.need(len(sites) == 1 and sites[0]['Id'] == container_id and sites[0]['Image'] == image_id
           and sites[0]['State'] == {'Running': True, 'Pid': init_pid}, 'RESOURCE_INSTALL_CURRENT_SITE')


def _node_argv(initial, prefix):
    """Select only the fixed entry in this init's actual kernel namespaces."""
    choices = []; deadline = time.monotonic() + 5
    with os.scandir('/proc') as entries:
        for count, entry in enumerate(entries, 1):
            R.need(count <= 65536 and time.monotonic() < deadline, 'RESOURCE_INSTALL_PROCESS_SCAN_BOUND')
            if not entry.name.isdecimal(): continue
            base = Path('/proc') / entry.name
            try:
                namespaces = tuple((base/'ns'/n).stat().st_ino for n in ('mnt', 'pid', 'user'))
                if namespaces != initial['namespaces']: continue
                before = read_proc(int(entry.name))
                with (base/'cmdline').open('rb') as stream: raw = stream.read(65537)
                R.need(0 < len(raw) <= 65536 and raw.endswith(b'\0'), 'RESOURCE_INSTALL_ARGV_BOUND')
                argv = [v.decode('utf-8') for v in raw[:-1].split(b'\0')]
                if argv[:len(prefix)] != prefix: continue
                R.need(read_proc(int(entry.name)) == before and hashlib.sha256(raw).hexdigest() == before['argv'],
                       'RESOURCE_INSTALL_NODE_CHANGED')
                choices.append((before['pid'], argv))
            except (OSError, UnicodeError, ValueError):
                continue
    R.need(len(choices) == 1, 'RESOURCE_INSTALL_UNIQUE_FIXED_NODE_REQUIRED')
    return choices[0]


def _no_pending(gate):
    R.need(not os.path.lexists(gate.root/'resource-actor.installing.json'),
           'RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION')


class _BoundFacts:
    """Read-only facts validation, also used while explicit installation is fenced.

    The runtime only constructs InstalledFacts below. This private validator is
    never an owner capability or a resource-operation/peer-admission object.
    """
    def __init__(self, broker, gate):
        R.need(type(gate) is R.ReservationGate and gate.broker is broker, 'RESOURCE_INSTALL_REAL_GATE')
        self.broker, self.gate = broker, gate
        self.path = Path(broker.config['resourceActorConfig'])
        R.need(self.path == gate.root/'resource-actor.json', 'RESOURCE_INSTALL_FIXED_PATH')
        self.signature, self.raw = private_entry(str(self.path), limit=65536)
        self.value = value = document(self.raw); exact(value, FIELDS)
        R.need(type(value['version']) is int and value['version'] == 2 and value['purpose'] == PURPOSE
               and value['configurationDigest'] == R.domain_digest(broker.config), 'RESOURCE_INSTALL_DOMAIN')
        self.provenance = artifact(value['imageProvenance'])
        exact(value['engine'], ('socket', 'identity', 'id'))
        self.engine = Engine(value['engine']['socket'], value['engine']['identity'], value['engine']['id'])
        self.client = _client(value['client'])
        self._programs(value['website'])
        self.facts = WebsiteFacts(self.engine, value['website']); self.facts.bind_once()
        self.website = ProtectedPeer(self.facts)
        self.guard()

    def _programs(self, website):
        exact(website, WebsiteFacts.KEYS)
        p = self.provenance; prefix = p['node']['argvPrefix']
        R.need(self.value['client'] == p['clientManifest'] and website['codeFiles'] == p['codeFiles']
               and website['node']['executable'] == p['node']['executable']
               and website['node']['argv'][:len(prefix)] == prefix
               and website['bootstrap'] == {'executable': self.client.executable, 'argv': list(self.client.argv)}
               and website['uid'] == self.broker.config['uid'] == os.getuid()
               and website['gid'] == self.broker.config['gid'] == os.getgid(), 'RESOURCE_INSTALL_PROGRAM_BINDING')

    def guard(self):
        self.gate.native.custody(self.gate.root, R.marker(self.broker.config))
        signature, raw = private_entry(str(self.path), limit=65536)
        R.need(signature == self.signature and raw == self.raw
               and self.value['configurationDigest'] == R.domain_digest(self.broker.config), 'RESOURCE_INSTALL_CHANGED')
        R.need(artifact(self.value['imageProvenance']) == self.provenance
               and _client(self.value['client']) == self.client, 'RESOURCE_INSTALL_PROGRAM_CHANGED')
        binding = self.facts.binding; self.facts.inspect()
        _native_site(self.gate, binding['containerId'], binding['imageId'], binding['initPid'])
        actual = self.engine.get('/images/'+binding['imageId']+'/json')
        R.need(verify_image_spec(self.provenance, actual) == binding['imageId'], 'RESOURCE_INSTALL_IMAGE_CHANGED')
        self.facts.inspect(); self.engine.guard()


class InstalledFacts(_BoundFacts):
    """Existing-only runtime entry: any retained installing entry is a fence."""
    def __init__(self, broker, gate):
        _no_pending(gate)
        super().__init__(broker, gate)

    def guard(self):
        _no_pending(self.gate)
        super().guard()
        _no_pending(self.gate)


def _write_once(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        while raw:
            size = os.write(fd, raw); R.need(size > 0, 'RESOURCE_INSTALL_SHORT_WRITE'); raw = raw[size:]
        os.fsync(fd)
    finally: os.close(fd)


def _sync_root(root):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try: os.fsync(fd)
    finally: os.close(fd)


def _terminal_publication(path, expected, marker, installing):
    """Bracket both final readers and their descriptor cleanup with stat only.

    This observes changes under the cooperating admission protocol; it does not
    make arbitrary later owner writes atomic across separate private files.
    """
    def stamp(selected):
        info=selected.lstat()
        R.need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and
               info.st_nlink==1 and not info.st_mode&0o077,
               'RESOURCE_INSTALL_TERMINAL_ENTRY_CHANGED')
        return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,
                info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
    if installing is None:
        R.need(not os.path.lexists(marker),'RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION')
    paths=(path,)if installing is None else(path,marker)
    before={p:stamp(p)for p in paths}
    parents={parent for p in paths for parent in p.parents}
    R.need(len(parents)<=256,'RESOURCE_INSTALL_TERMINAL_ANCESTRY_BOUND')
    def directory_stamp(selected):
        info=selected.lstat();sticky=info.st_uid==0 and bool(info.st_mode&stat.S_ISVTX)
        R.need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0,os.getuid()) and
               (not info.st_mode&0o022 or sticky),'RESOURCE_INSTALL_TERMINAL_ANCESTRY_CHANGED')
        return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)
    ancestry={p:directory_stamp(p)for p in parents}
    R.need(private_entry(str(path),limit=65536)==expected,'RESOURCE_INSTALL_PUBLISHED_RECORD_CHANGED')
    if installing is None:
        R.need(not os.path.lexists(marker),'RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION')
    else:
        R.need(private_entry(str(marker),limit=65536)==installing,'RESOURCE_INSTALL_PENDING_CHANGED')
    # All file readers and close-time finalizers have now finished. No new
    # descriptor, native producer or lock is opened after this final bracket.
    for p,signature in before.items():
        R.need(stamp(p)==signature,'RESOURCE_INSTALL_TERMINAL_ENTRY_CHANGED')
    for p,signature in ancestry.items():
        R.need(directory_stamp(p)==signature,'RESOURCE_INSTALL_TERMINAL_ANCESTRY_CHANGED')


def prepare(broker, provenance_path, engine_socket, expected_engine_id, *, transport=None):
    """Owner-local inactive preparation; no broker, image or provider launch."""
    def transport_guard():
        if transport is None:
            R.need(not os.path.lexists(broker.config['socket']), 'RESOURCE_INSTALL_BROKER_SOCKET_MUST_BE_ABSENT')
        else:
            from .resource_actor_refresh import RegisteredTransport
            R.need(type(transport) is RegisteredTransport and transport.config == broker.config,
                   'RESOURCE_INSTALL_REGISTERED_TRANSPORT_REQUIRED')
            transport.guard()
    transport_guard()
    gate = R.ReservationGate(broker)
    path = Path(broker.config.get('resourceActorConfig', ''))
    R.need(path == gate.root/'resource-actor.json', 'RESOURCE_INSTALL_FIXED_PATH')
    marker=path.with_name('resource-actor.installing.json')
    _no_pending(gate)
    file = immutable(provenance_path, 65536)
    pair = {'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
    provenance = artifact(pair); client = _client(provenance['clientManifest'])
    identity = socket_identity(engine_socket)
    first = Engine(engine_socket, identity, 'initial-observation').get('/info')
    R.need(type(expected_engine_id) is str and first.get('ID') == expected_engine_id,
           'RESOURCE_INSTALL_BROKER_ENGINE_CHANGED')
    engine = Engine(engine_socket, identity, first['ID']); engine.guard()
    with gate.admission():
        _no_pending(gate)
        R.need(not gate.active_operations(gate._document()), 'RESOURCE_INSTALL_ACTIVE_OPERATION')
        rows = gate.native.inventory()
        sites = [row for row in rows if row.get('Name') == '/'+broker.config['serverContainer']]
        R.need(len(sites) == 1, 'RESOURCE_INSTALL_CURRENT_SITE')
        item = engine.get('/containers/'+sites[0]['Id']+'/json')
        R.need(item['State']['Running'] is True and item['State']['Pid'] > 1, 'RESOURCE_INSTALL_SITE_NOT_RUNNING')
        initial = read_proc(item['State']['Pid'])
        node_pid, argv = _node_argv(initial, provenance['node']['argvPrefix'])
        selection = {'containerId': item['Id'], 'imageId': item['Image'], 'configDigest': digest(item['Config']),
                     'hostConfigDigest': digest(host_config(item['HostConfig'])), 'mountsDigest': digest(mounts(item['Mounts'])),
                     'initPid': initial['pid'], 'initStart': initial['start'], 'uid': broker.config['uid'], 'gid': broker.config['gid'],
                     'bootstrap': {'executable': client.executable, 'argv': list(client.argv)},
                     'node': {'executable': provenance['node']['executable'], 'argv': argv}, 'codeFiles': provenance['codeFiles']}
        facts = WebsiteFacts(engine, selection); facts.bind_once(); peer = ProtectedPeer(facts)
        peer.assert_process((node_pid, selection['uid'], selection['gid']), 'node')
        R.need(verify_image_spec(provenance, engine.get('/images/'+selection['imageId']+'/json')) == selection['imageId'],
               'RESOURCE_INSTALL_IMAGE_CHANGED')
        value = {'version': 2, 'purpose': PURPOSE, 'configurationDigest': R.domain_digest(broker.config),
                 'engine': {'socket': engine_socket, 'identity': list(identity), 'id': engine.engine_id},
                 'website': selection, 'imageProvenance': pair, 'client': provenance['clientManifest']}
        raw = (json.dumps(value, sort_keys=True, separators=(',', ':'))+'\n').encode()
        R.need(len(raw) <= 65536, 'RESOURCE_INSTALL_RECORD_BOUND')
        old = private_entry(str(path), limit=65536) if os.path.lexists(path) else None
        unchanged=old is not None and old[1]==raw
        installing=None
        if not unchanged:
            if old is not None:
                previous = path.with_name('resource-actor.previous.'+hashlib.sha256(old[1]).hexdigest()+'.json')
                if os.path.lexists(previous):
                    R.need(private_entry(str(previous), limit=65536)[1] == old[1], 'RESOURCE_INSTALL_HISTORY_CHANGED')
                else: _write_once(previous, old[1])
            stage = path.with_name('resource-actor.next.json')
            _write_once(marker, raw)
            _write_once(stage, raw)
            _sync_root(gate.root)  # The fence must precede current-record publication.
            installing = private_entry(str(marker), limit=65536)
            gate.native.custody(gate.root, R.marker(broker.config)); facts.qualify_code()
            R.need(not gate.active_operations(gate._document()), 'RESOURCE_INSTALL_ACTIVE_OPERATION')
            R.need((private_entry(str(path), limit=65536) if os.path.lexists(path) else None) == old,
                   'RESOURCE_INSTALL_CURRENT_RECORD_CHANGED')
            transport_guard()
            os.replace(stage, path)
            _sync_root(gate.root)
        # All postchecks run while runtime loading remains fenced. This private
        # read-only validator is never returned to the runtime or caller.
        checked = _BoundFacts(broker, gate)
        R.need(checked.raw == raw, 'RESOURCE_INSTALL_PUBLISHED_RECORD_CHANGED')
        checked.guard()
        R.need(not gate.active_operations(gate._document()), 'RESOURCE_INSTALL_ACTIVE_OPERATION')
        transport_guard()
        if not unchanged:
            R.need(private_entry(str(marker), limit=65536) == installing,
                   'RESOURCE_INSTALL_PENDING_CHANGED')
            _sync_root(gate.root)
    # Admission exit performs its own native guard and descriptor finalizers.
    # Leave the fence until those and every durability check have succeeded.
    # Unlink is the last fallible operation: after a crash, resurrection of the
    # already durable fence conservatively requires inspection rather than use.
    transport_guard()
    if transport is not None: transport.finalize()
    _terminal_publication(path,(checked.signature,raw),marker,installing)
    if not unchanged:os.unlink(marker)
    return {'prepared': True, 'changed': not unchanged, 'started': False}
